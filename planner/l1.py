# planner/l1.py —— L1 人格层（工具调用 + 回调汇报 + 失败协商）与 L2 规划器（无状态）。
# P2：失败先由 L2 带「期望 vs 实际」重规划（上限 retry=2），用尽后把事实 + 2-3 个方案交给 L1 决断（一轮）。
import asyncio
import json
import re
import time
import uuid

import aiohttp

import config
import domains
import prompts
from budget import BudgetExceeded, TaskBudget
from facts import fallback_options, facts_text, extract_facts, options_to_text
from llm import LLMClient, LLMError
from schema import SchemaError, validate_options, validate_plan


class SidecarClient:
    """L3 侧车的最小客户端；状态取不到时由调用方标注过期。"""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5, connect=2))
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def state(self) -> tuple[dict, bool]:
        """返回 (状态, 是否过期)。3 秒内取不到就算过期，不静默沿用旧值。"""
        started = time.monotonic()
        try:
            session = await self._get_session()
            async with session.get(f"{self.base_url}/state") as resp:
                if resp.status != 200:
                    return {}, True
                data = await resp.json()
            stale = (time.monotonic() - started) > config.STATUS_FRESH_S
            return data, stale
        except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError):
            return {}, True

    async def post(self, path: str, payload: dict, timeout: float = 8.0) -> dict:
        session = await self._get_session()
        async with session.post(
            f"{self.base_url}{path}", json=payload, timeout=aiohttp.ClientTimeout(total=timeout)
        ) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise RuntimeError(f"sidecar_{resp.status}: {text[:200]}")
            return json.loads(text) if text else {}

    async def submit_intention(self, payload: dict) -> dict:
        return await self.post("/intention", payload)

    async def cancel(self, intention_id: str) -> dict:
        return await self.post("/cancel", {"intention_id": intention_id, "reason": "l1_cancel"})

    async def update_experience(self, exp_id: str, patch: dict) -> dict:
        """P4.4：把 L1 的反应写回经历账本（reaction/action/outcome/visual）。"""
        return await self.post("/experiences/reaction", {"id": exp_id, **patch})

    async def look(self, position: dict) -> dict:
        """P5.3：让身体转向某个坐标（截不到就失败，调用方自己降级）。"""
        return await self.post("/look", position)


class Plan(list):
    """L2 的产出：steps（就是 list 本身，老代码照旧用）+ notes（给 L1 的一句提醒）。

    做成 list 子类是为了不打断已有的 len()/索引/直接下发步骤的调用点；notes 只是挂在上面的属性，
    不会跟着 steps 一起送进执行器。
    """

    def __init__(self, steps: list[dict], notes: str = "", domain: str = "") -> None:
        super().__init__(steps)
        self.notes = str(notes or "").strip()[:80]
        self.domain = domain


class PlanMetrics:
    """观测用：非法 JSON 比例、修复次数、重规划次数（P2 验收要看）。"""

    def __init__(self) -> None:
        self.attempts = 0
        self.invalid = 0
        self.repairs = 0
        self.rejected = 0
        self.options_attempts = 0
        self.options_failed = 0

    def snapshot(self) -> dict:
        rate = round(self.invalid / self.attempts, 4) if self.attempts else 0.0
        return {
            "attempts": self.attempts,
            "invalid": self.invalid,
            "invalid_rate": rate,
            "repairs": self.repairs,
            "rejected": self.rejected,
            "options_attempts": self.options_attempts,
            "options_failed": self.options_failed,
        }


class Planner:
    """L2：无状态「中文 -> 步骤列表」，带一次自动修复重试、schema 校验与失败协商方案。"""

    def __init__(self, llm: LLMClient) -> None:
        self.llm = llm
        self.metrics = PlanMetrics()

    async def plan(
        self,
        text: str,
        state_text: str,
        budget: TaskBudget | None = None,
        last_failure: dict | None = None,
        domain_name: str = "",
    ) -> Plan:
        domain = domains.by_name(domain_name) if domain_name else domains.route(text)
        if last_failure:
            messages = [
                {"role": "system", "content": prompts.replan_system(domain)},
                {
                    "role": "user",
                    "content": prompts.replan_user(
                        text, state_text, facts_text(last_failure), json.dumps(last_failure, ensure_ascii=False)
                    ),
                },
            ]
            purpose = "l2_replan"
        else:
            messages = [
                {"role": "system", "content": prompts.planner_system(domain)},
                {"role": "user", "content": prompts.planner_user(text, state_text)},
            ]
            purpose = "l2_plan"

        self.metrics.attempts += 1
        raw = await self.llm.chat(
            messages, purpose=purpose, response_format={"type": "json_object"},
            max_tokens=300, temperature=0.2, budget=budget
        )
        content = raw.get("content") or ""
        allowed = frozenset(domain.skills)
        try:
            payload = parse_json_object(content)
            return Plan(validate_plan(payload, allowed), payload.get("notes") or "", domain.name)
        except (SchemaError, ValueError) as exc:
            # 一次自动修复：把 schema 错误回灌，仍不合规就拒收
            self.metrics.invalid += 1
            self.metrics.repairs += 1
            repair = messages + [
                {"role": "assistant", "content": content},
                {"role": "user", "content": f"上面的输出不合法：{exc}。只重新输出符合要求的 JSON 对象。"},
            ]
            raw2 = await self.llm.chat(
                repair, purpose="l2_plan_repair", response_format={"type": "json_object"},
                max_tokens=300, temperature=0.1, budget=budget
            )
            try:
                payload2 = parse_json_object(raw2.get("content") or "")
                return Plan(validate_plan(payload2, allowed), payload2.get("notes") or "", domain.name)
            except (SchemaError, ValueError):
                self.metrics.rejected += 1
                raise

    async def options(
        self, text: str, facts: dict, state_text: str, budget: TaskBudget | None = None
    ) -> list[dict]:
        """失败协商：让 L2 给 2-3 个方案；L2 自身失败时用代码兜底方案，保证 L1 永远有得选。"""
        self.metrics.options_attempts += 1
        messages = [
            {"role": "system", "content": prompts.OPTIONS_SYSTEM},
            {
                "role": "user",
                "content": prompts.options_user(
                    text, state_text, facts_text(facts), json.dumps(facts, ensure_ascii=False)
                ),
            },
        ]
        try:
            raw = await self.llm.chat(
                messages, purpose="l2_options", response_format={"type": "json_object"},
                max_tokens=220, temperature=0.4, budget=budget
            )
            return validate_options(parse_json_object(raw.get("content") or ""))
        except (SchemaError, ValueError, LLMError, BudgetExceeded):
            self.metrics.options_failed += 1
            return fallback_options(facts)


def parse_json_object(text: str) -> dict:
    """从模型输出里取出第一个 JSON 对象；取不到就抛 ValueError。"""
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?|```$", "", cleaned, flags=re.MULTILINE).strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no_json_object")
    return json.loads(cleaned[start : end + 1])


class Chain:
    """一条委托的全生命周期：原请求 + 预算 + 重规划/协商计数。"""

    def __init__(self, text: str, priority: int, origin: str) -> None:
        self.text = text
        self.priority = priority
        self.origin = origin
        self.budget = TaskBudget(**config.BUDGET)
        self.replans = 0
        self.negotiated = False
        self.intention_ids: list[str] = []
        self.domain = ""      # 第一次规划定下的域，重规划沿用它，避免两段计划跨域打架
        self.notes = ""       # L2 留下的提醒，任务收尾时随结果一起交给 L1


def state_text(state: dict) -> str:
    """世界状态压成一行给 L2（坐标/背包/玩家都用真实值）。"""
    if not state:
        return "未知"
    pos = state.get("pos") or {}
    inv = state.get("inventory") or []
    inv_text = "、".join(f"{item.get('name')}×{item.get('count')}" for item in inv[:8]) or "空手"
    pos_text = f"({pos.get('x')},{pos.get('y')},{pos.get('z')})" if pos else "未知"
    players = state.get("players") or []
    players_text = "、".join(
        f"{p.get('name')}({p.get('x')},{p.get('y')},{p.get('z')},距离{p.get('distance')})"
        for p in players[:5]
    ) or "无"
    body = (
        f"位置{pos_text}；血量{state.get('health')}/饥饿{state.get('food')}；"
        f"背包：{inv_text}；附近玩家：{players_text}"
    )
    # 反射状态：身体自己在打架/逃跑时，规划要走远的活会当场被打断——先告诉她
    reflex = state.get("reflex")
    if reflex and reflex != "idle":
        label = {"defend": "正在和怪打", "flee": "正在撤", "recover": "在吃东西回血",
                 "mlg": "正在落地自救"}.get(reflex, reflex)
        body += f"；身体状态：{label}（这是身体自己的反应，不是任务）"
    return body


def sanitize_say(text: str) -> str:
    """她嘴里不能出现 JSON、坐标串、堆栈、工具名。"""
    if not text:
        return ""
    cleaned = str(text).strip()
    cleaned = re.sub(r"</?layout>.*?</layout>", "", cleaned, flags=re.DOTALL)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return ""
    lowered = cleaned.lower()
    banned = ('{"', '"steps"', "traceback", "error:", "skill", "json", "intention_", "python")
    if any(token in lowered for token in banned):
        return ""
    # 坐标样的三元组也拦掉
    if re.search(r"-?\d+\.\d+\s+-?\d+\.\d+\s+-?\d+\.\d+", cleaned):
        return ""
    if len(cleaned) > 160:
        cleaned = cleaned[:160]
    return cleaned
