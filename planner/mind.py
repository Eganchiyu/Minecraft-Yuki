# planner/mind.py —— L1 心智：纯文本聊天 + 一个 intention 工具。
#
# 设计（机主定稿）：
#   · 模型只输出文本 —— 正常聊天直接发到公屏，就像 ChatBot。
#   · 想动手就调 intention 工具，参数只有一句中文愿望；Python 把它交给 L2「许愿器」，
#     L2 翻译成步骤、L3 用 MineFlayer 执行。她在这期间照旧聊天。
#   · L2 的结果以普通消息注入上下文（「（身体）完成了：挖到 3 块圆石」），她据此再决定。
#   · 状态（坐标/血量/背包/附近/身体在做什么）与「小本本」（正在做什么/刚做过什么）
#     只作为一行附在本轮 user 消息后面，单槽临时，不进历史。
import asyncio
import json
import logging
import re
import time
from pathlib import Path

import config
import prompts
from budget import BudgetExceeded
from facts import extract_facts, facts_text, options_to_text
from l1 import Chain, Planner, SidecarClient, state_text
from llm import LLMClient, LLMError
from memory import MemoryStore
from notes import NoteStore
from schema import SchemaError, UnsupportedCapability

_logger = logging.getLogger("mind")


class _Log:
    """结构化一行日志：log.info("event", k=v)，和侧车的写法对齐。"""

    @staticmethod
    def _emit(level: int, event: str, **fields) -> None:
        tail = " ".join(f"{key}={value}" for key, value in fields.items())
        _logger.log(level, f"{event} {tail}".strip())

    def info(self, event: str, **fields) -> None:
        self._emit(logging.INFO, event, **fields)

    def warning(self, event: str, **fields) -> None:
        self._emit(logging.WARNING, event, **fields)

    def error(self, event: str, **fields) -> None:
        self._emit(logging.ERROR, event, **fields)


log = _Log()

DEFAULT_STATE = {
    "mode": "play",           # play / rest
    "rest_until": 0.0,
    "current": None,          # {"intention_id","text","priority","origin","at"}
    "note": "",               # 小本本：正在做 / 刚做过什么
    "next_tick_at": 0.0,
    "idle_rounds": 0,
    "last_say_at": 0.0,
}


def sanitize_say(text: str) -> str:
    """公屏只容得下一句话：去标记、压空白、截断，拦掉 JSON/代码味。"""
    if not text:
        return ""
    cleaned = str(text).strip()
    cleaned = re.sub(r"</?layout>.*?</layout>", "", cleaned, flags=re.DOTALL)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return ""
    lowered = cleaned.lower()
    banned = ('{"', '"steps"', "traceback", "error:", "intention_", "send_intention", "python")
    if any(token in lowered for token in banned):
        return ""
    if re.search(r"-?\d+\.\d+\s+-?\d+\.\d+\s+-?\d+\.\d+", cleaned):
        return ""
    limit = int(config.AUTONOMY["max_say_chars"])
    return cleaned[:limit]


class Mind:
    def __init__(self, llm: LLMClient, sidecar: SidecarClient, planner: Planner) -> None:
        self.llm = llm
        self.sidecar = sidecar
        self.planner = planner
        self.memory = MemoryStore(config.MEMORY_PATH)
        self.notes = NoteStore(config.NOTES_PATH)
        self.history: list[dict] = []
        self.chains: dict[str, Chain] = {}
        self.chain_log: list[dict] = []
        self.last_state: dict = {}
        self.last_budget: dict = {}
        self.state: dict = self._load_state()
        self.metrics = {"turns": 0, "intentions": 0, "chats": 0, "ticks": 0, "say": 0}
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._call_times: list[float] = []
        self._event_buffer: list[tuple[float, str]] = []
        self._last_event_at: dict[str, float] = {}
        self._daily = {"date": time.strftime("%Y-%m-%d"), "self_calls": 0}
        self._idle_since = 0.0

    # ================= 生命周期 =================
    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop())
            log.info("mind_start", mode=self.state.get("mode"), note=self.state.get("note"))

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except BaseException:
                pass
            self._task = None
        self._save_state()

    # ================= 对外入口 =================
    async def chat(self, player: str, text: str) -> dict:
        """公屏说话：纯聊天一轮，想动手就在这一轮里调 intention。"""
        async with self._lock:
            self.metrics["chats"] += 1
            command = self._parse_command(text)
            if command:
                return await self._run_command(command)
            if self.state.get("mode") == "rest":
                self._wake("master_talk")
            return await self._turn(f"{player} 在公屏说：{text}", origin="master", priority=6, kind="chat")

    async def callback(self, payload: dict) -> dict:
        """L3 回调：做不成的先让 L2 自修，最终结果作为一条普通消息注入她的上下文。"""
        async with self._lock:
            intention_id = str(payload.get("intention_id") or "")
            status = str(payload.get("status") or "done")
            summary = str(payload.get("summary") or "")
            detail = payload.get("detail") if isinstance(payload.get("detail"), dict) else {}
            chain = self.chains.get(intention_id)
            current = self.state.get("current") or {}
            text = current.get("text") or (chain.text if chain else "")

            if status == "failed" and chain is not None and not chain.budget.exhausted:
                escalated = await self._escalate(chain, intention_id, summary, detail)
                if escalated is not None:
                    return escalated

            if config.NOTES_ENABLED:
                try:
                    written = self.notes.record_from_detail(detail)
                except Exception as exc:
                    written = 0
                    log.warning("notes_write_failed", error=str(exc))
                if written:
                    log.info("places_updated", count=written, total=self.notes.count())
            self.state["current"] = None
            self._set_note(self._result_note(status, summary, text))
            event = self._result_event(status, summary, text)
            origin = (chain.origin if chain else "self_play") or "self_play"
            priority = int(current.get("priority") or 5)
            result = await self._turn(event, origin=origin, priority=priority, kind="after_task")
            self._log_chain(chain, intention_id, status, summary)
            self._release_chain(chain)
            return result

    async def dispatch_direct(self, text: str, priority: int = 5) -> dict:
        """调试/验收通道：跳过措辞直接下发（仍走完整 Chain）。"""
        async with self._lock:
            state, _ = await self.sidecar.state()
            if state:
                self.last_state = state
            return await self._dispatch(text, priority, origin="debug")

    async def on_event(self, kind: str, severity: int, detail: dict) -> dict:
        """侧车推来的世界事件：severity≥7 立刻叫醒她，其余 30 秒聚合一次。"""
        now = time.time()
        if now - self._last_event_at.get(kind, 0) < 5:
            return {"ok": True, "deduped": True}
        self._last_event_at[kind] = now
        text = self._event_text(kind, detail)
        if not text:
            return {"ok": False, "error": "empty_event"}
        self.memory.add("event", text)
        if severity >= config.AUTONOMY["urgent_severity"]:
            self._wake(f"event:{kind}")
            async with self._lock:
                return await self._turn(f"（身体报警）{text}", origin="self_play", priority=4, kind="event")
        self._event_buffer.append((time.time(), text))
        return {"ok": True, "buffered": len(self._event_buffer)}

    async def rest(self, minutes: int, reason: str = "command") -> dict:
        async with self._lock:
            return await self._run_command({"kind": "rest", "minutes": minutes})

    def snapshot(self) -> dict:
        return {
            "mode": self.state.get("mode"),
            "rest_until": self.state.get("rest_until"),
            "current": self.state.get("current"),
            "note": self.state.get("note"),
            "next_tick_at": self.state.get("next_tick_at"),
            "history_len": len(self.history),
            "memory": self.memory.count(),
            "daily": dict(self._daily),
            "places": self.notes.count(),
            "metrics": dict(self.metrics),
            "chains": len(self.chains),
            "last_budget": self.last_budget,
            "recent": self.chain_log[-5:],
        }

    def stats(self) -> dict:
        return {"plan": self.planner.metrics.snapshot(), **self.snapshot()}

    # ================= 一轮对话 =================
    async def _turn(self, user_text: str, origin: str, priority: int, kind: str, allow_tools: bool = True) -> dict:
        """一次模型调用 = 一句回话，或一个 intention，或两者都有。"""
        state, stale = await self.sidecar.state()
        if state:
            self.last_state = state
        current_state = state or self.last_state
        places = ""
        if config.NOTES_ENABLED:
            try:
                places = self.notes.line((current_state or {}).get("pos"))
            except Exception:
                places = ""
        status_line = prompts.state_line(current_state, self.state.get("note"), stale, places)

        messages = [
            {"role": "system", "content": prompts.PERSONA},
            *self.history[-config.HISTORY_KEEP * 2:],
            {"role": "user", "content": f"{user_text}\n{status_line}"},
        ]
        self.metrics["turns"] += 1
        self._roll_daily()
        if kind in {"idle", "event", "after_task"}:
            self._call_times.append(time.time())
            self._daily["self_calls"] += 1
        try:
            raw = await self.llm.chat(
                messages,
                purpose=f"l1_{kind}",
                tools=[prompts.INTENTION_TOOL] if allow_tools else None,
                max_tokens=config.AUTONOMY["max_tokens"],
                temperature=0.85,
            )
        except LLMError as exc:
            log.error("turn_failed", kind=kind, error=str(exc))
            return {"say": "", "intention_id": None, "error": str(exc)}

        say = sanitize_say(raw.get("content") or "")
        intention_id = None
        intention_text = ""
        dispatch_error = ""
        for call in raw.get("tool_calls") or []:
            function = call.get("function") or {}
            if function.get("name") != "intention":
                continue
            try:
                args = json.loads(function.get("arguments") or "{}")
            except json.JSONDecodeError:
                continue
            intention_text = " ".join(str(args.get("text") or "").split()).strip()[:120]
            if not intention_text:
                continue
            dispatched = await self._dispatch(intention_text, priority, origin)
            if dispatched.get("ok"):
                intention_id = dispatched["intention_id"]
                break
            dispatch_error = str(dispatched.get("error") or "")
            if dispatched.get("unsupported"):
                dispatch_error = f"unsupported: {dispatched['unsupported']}"
            log.warning("intention_failed", text=intention_text, error=dispatch_error)

        # 主动说话限额：自己找事时的碎嘴别刷屏
        if kind in {"idle", "event"} and say:
            gap = int(config.AUTONOMY["proactive_say_min_gap_s"])
            if time.time() - float(self.state.get("last_say_at") or 0) < gap:
                log.info("say_suppressed", reason="cooldown", say=say[:30])
                say = ""
        if say:
            self.state["last_say_at"] = time.time()
            self.metrics["say"] += 1

        self._remember(user_text, say)
        self._save_state()
        try:
            await self._maybe_summarize()
        except Exception as exc:
            log.warning("summarize_failed", error=str(exc))
        log.info("turn", kind=kind, say=say[:40], intention=intention_text[:40])
        result = {"say": say, "intention_id": intention_id, "intention": intention_text, "action": kind}

        # 派活失败（尤其是「功能还没做」）必须让她知道，否则她会以为世界不配合
        if dispatch_error and intention_text and allow_tools:
            notice = self._dispatch_failure_message(intention_text, dispatch_error)
            if notice:
                self._set_note(notice)
                self._save_state()
                follow = await self._turn(notice, origin=origin, priority=priority, kind="after_task", allow_tools=False)
                result["say_after"] = follow.get("say", "")
                result["notice"] = notice
        return result

    # ================= 派活（L2 + L3） =================
    async def _dispatch(self, text: str, priority: int, origin: str, chain: Chain | None = None) -> dict:
        chain = chain or Chain(text, priority, origin)
        try:
            steps = await self.planner.plan(text, state_text(self.last_state), budget=chain.budget)
        except UnsupportedCapability as exc:
            return {"ok": False, "unsupported": exc.reason, "error": f"unsupported: {exc.reason}"}
        except (SchemaError, ValueError) as exc:
            return {"ok": False, "error": f"plan_rejected: {exc}"}
        except BudgetExceeded as exc:
            return {"ok": False, "error": f"budget_exceeded: {exc}"}
        except LLMError as exc:
            return {"ok": False, "error": f"llm: {exc}"}
        submitted = await self._submit_steps(chain, steps, text, priority, origin)
        if submitted.get("ok"):
            self.metrics["intentions"] += 1
            self.state["current"] = {
                "intention_id": submitted["intention_id"],
                "text": text,
                "priority": priority,
                "origin": origin,
                "at": time.time(),
            }
            self.state["next_tick_at"] = 0
            self.state["idle_rounds"] = 0
            self._idle_since = 0.0
            self._set_note(f"正在做「{text}」")
        return submitted

    async def _submit_steps(self, chain: Chain, steps: list[dict], text: str, priority: int, origin: str) -> dict:
        intention_id = f"intent-{int(time.time() * 1000) % 100000000}-{len(self.chains)}"
        try:
            await self.sidecar.submit_intention(
                {
                    "intention_id": intention_id,
                    "priority": priority,
                    "origin": origin,
                    "steps": steps,
                    "summary_text": text,
                }
            )
        except Exception as exc:
            return {"ok": False, "error": f"sidecar_unreachable: {exc}"}
        chain.intention_ids.append(intention_id)
        self.chains[intention_id] = chain
        self._prune_chains()
        self.last_budget = chain.budget.snapshot()
        return {"ok": True, "intention_id": intention_id, "steps": steps}

    async def _escalate(self, chain: Chain, intention_id: str, summary: str, detail: dict) -> dict | None:
        """失败升级（决策 #22）：L2 带事实先自修，用尽后把事实 + 方案当消息交回她。"""
        facts = extract_facts(detail, summary)
        state, _ = await self.sidecar.state()
        if state:
            self.last_state = state

        while chain.budget.take_retry():
            chain.replans += 1
            try:
                steps = await self.planner.plan(
                    chain.text, state_text(self.last_state), budget=chain.budget, last_failure=facts
                )
            except (SchemaError, ValueError, LLMError, BudgetExceeded):
                break
            submitted = await self._submit_steps(chain, steps, chain.text, chain.priority, "self_repair")
            if submitted.get("ok"):
                self.state["current"] = {
                    "intention_id": submitted["intention_id"],
                    "text": chain.text,
                    "priority": chain.priority,
                    "origin": chain.origin,
                    "at": time.time(),
                }
                self.last_budget = chain.budget.snapshot()
                return {
                    "say": "",
                    "escalation": "replan",
                    "replans": chain.replans,
                    "fact": facts.get("code"),
                    "intention_id": submitted["intention_id"],
                }
            break

        if not chain.negotiated and not chain.budget.exhausted:
            chain.negotiated = True
            self.state["current"] = None
            options = await self.planner.options(chain.text, facts, state_text(self.last_state), budget=chain.budget)
            message = (
                f"（身体）「{chain.text}」没做成：{facts_text(facts)}。"
                f"它说可以这样：{options_to_text(options)}。要换个办法就来，不想做就算啦。"
            )
            self._set_note(f"「{chain.text}」没做成")
            self.last_budget = chain.budget.snapshot()
            result = await self._turn(
                message, origin=chain.origin or "self_play", priority=chain.priority, kind="after_task"
            )
            result.update({"escalation": "negotiate", "fact": facts.get("code"), "options": options})
            if not result.get("intention_id"):
                self._release_chain(chain)
            return result
        return None

    # ================= 时间与状态 =================
    async def _loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(config.AUTONOMY["tick_s"])
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.error("mind_loop_error", error=str(exc))

    async def _tick(self) -> None:
        now = time.time()
        if self.state.get("mode") == "rest":
            if now < float(self.state.get("rest_until") or 0):
                return
            self._wake("rest_over")
            log.info("rest_over")
            return
        if not config.AUTONOMY["enabled"]:
            return
        state, _ = await self.sidecar.state()
        if state:
            self.last_state = state
        await self._flush_events(now)
        if self.state.get("current"):
            self._check_stuck(state, now)
            return
        if now < float(self.state.get("next_tick_at") or 0):
            return
        if not self._daily_ok():
            return
        if not self._rate_ok():
            self.state["next_tick_at"] = now + 30
            return
        if self._lock.locked():
            return
        async with self._lock:
            if self.state.get("current") or time.time() < float(self.state.get("next_tick_at") or 0):
                return
            if self.state.get("mode") == "rest":
                return
            self.metrics["ticks"] += 1
            event = "（周围静下来了，没人跟你说话，身体也闲着。想做点什么就做，想说什么也可以说；不想动就待着。）"
            result = await self._turn(event, origin="self_play", priority=4, kind="idle")
            if not result.get("intention_id"):
                self._schedule_idle()
            log.info("tick_done", say=result.get("say", "")[:40], intention=result.get("intention", "")[:40])

    async def _flush_events(self, now: float) -> None:
        if not self._event_buffer:
            return
        window = max(5, int(config.AUTONOMY["event_aggregate_s"]))
        due = [item for item in self._event_buffer if now - item[0] >= window]
        if not due:
            return
        self._event_buffer = [item for item in self._event_buffer if now - item[0] < window]
        if self._lock.locked() or self.state.get("current"):
            return
        text = "；".join(item[1] for item in due)[:300]
        async with self._lock:
            await self._turn(f"（刚才陆续发生）{text}", origin="self_play", priority=4, kind="event")

    def _parse_command(self, text: str) -> dict | None:
        raw = str(text or "").strip()
        low = raw.lower()
        match = re.fullmatch(r"(?:rest|sleep|休息|睡(?:觉)?)\s*(\d{1,3})?", low)
        if match:
            minutes = int(match.group(1)) if match.group(1) else config.AUTONOMY["rest_default_min"]
            return {"kind": "rest", "minutes": minutes}
        if re.fullmatch(r"(?:play|wake|醒来|起来|别睡了)", low):
            return {"kind": "wake"}
        if re.fullmatch(r"(?:stop|停下|别动了|别做了)", low):
            return {"kind": "stop"}
        return None

    async def _run_command(self, command: dict) -> dict:
        kind = command["kind"]
        if kind == "rest":
            minutes = max(1, min(180, int(command["minutes"])))
            self._enter_rest(minutes)
            say = f"那人家先躺一会儿，{minutes} 分钟后起来。"
            self._remember("（主人让你休息）", say)
            return {"say": say, "action": "rest"}
        if kind == "wake":
            self._wake("command")
            say = "唔…人家醒了，在呢。"
            self._remember("（主人叫你起来）", say)
            return {"say": say, "action": "wake"}
        if kind == "stop":
            current = self.state.get("current") or {}
            if current.get("intention_id"):
                try:
                    await self.sidecar.cancel(current["intention_id"])
                except Exception as exc:
                    log.warning("cancel_failed", error=str(exc))
            self.state["current"] = None
            self.state["next_tick_at"] = 0
            self._set_note("")
            self._save_state()
            say = "好好，不做了。"
            self._remember("（主人让你停下）", say)
            return {"say": say, "action": "stop"}
        return {"say": "", "action": "none"}

    # ================= 休息 =================
    def _enter_rest(self, minutes: int) -> None:
        self.state["mode"] = "rest"
        self.state["rest_until"] = time.time() + max(1, minutes) * 60
        self.state["next_tick_at"] = 0
        self._save_state()
        log.info("rest_enter", minutes=minutes)

    def _wake(self, reason: str) -> None:
        self.state["mode"] = "play"
        self.state["rest_until"] = 0
        self.state["next_tick_at"] = 0
        self._save_state()
        log.info("wake", reason=reason)

    def _schedule_idle(self) -> None:
        gap = float(config.AUTONOMY["idle_gap_s"]) * (1.0 + min(3.0, self.state.get("idle_rounds", 0) * 0.5))
        gap = min(gap, float(config.AUTONOMY["max_idle_gap_s"]))
        self.state["next_tick_at"] = time.time() + gap
        self.state["idle_rounds"] = int(self.state.get("idle_rounds", 0)) + 1

    def _dispatch_failure_message(self, intention_text: str, error: str) -> str:
        """把 L2/L3 的失败翻成她听得懂的人话；功能缺失要明说是「主人还没做」。"""
        if error.startswith("unsupported:"):
            feature = error.split(":", 1)[1].strip() or "这个功能"
            return (
                f"（身体）你想「{intention_text}」，可是「{feature}」这个功能主人还没做出来，"
                f"以后做好了再来吧～"
            )
        skill = ""
        if "不在白名单" in error:
            match = re.search(r"不在白名单:\s*'?([A-Za-z_]+)'?", error)
            skill = match.group(1) if match else ""
        if skill:
            return (
                f"（身体）你说要「{intention_text}」，可是这件事人家还不会做——"
                f"主人还没把「{skill}」这个功能做出来，等以后做好了再来吧。"
            )
        if error.startswith("sidecar_unreachable"):
            return f"（身体）你许愿「{intention_text}」，但身体现在没连上，等一会儿再试。"
        if error.startswith("budget_exceeded"):
            return f"（身体）「{intention_text}」这件事太费神了，今天先不折腾了。"
        if error.startswith("plan_rejected") or error.startswith("llm:"):
            return f"（身体）「{intention_text}」这件事人家想不出该怎么做，先换个目标吧。"
        return f"（身体）「{intention_text}」没派成，原因是：{error}"

    def _check_stuck(self, state: dict, now: float) -> None:
        """回调丢了/侧车重启过，我们会以为她一直在干活。身体空闲超过阈値就复位。"""
        body_idle = isinstance(state, dict) and state.get("status") in ("idle", "none") and not state.get("current")
        if not body_idle:
            self._idle_since = 0.0
            return
        if not self._idle_since:
            self._idle_since = now
            return
        if now - self._idle_since < float(config.AUTONOMY["stuck_after_s"]):
            return
        current = self.state.get("current") or {}
        log.warning("stuck_reset", intention=current.get("text", "")[:40])
        self.state["current"] = None
        self._idle_since = 0.0
        self._set_note(f"「{current.get('text', '上一件')}」没有回音，先当作结束了")
        self._save_state()
        self._schedule_idle()

    def _roll_daily(self) -> None:
        today = time.strftime("%Y-%m-%d")
        if self._daily.get("date") != today:
            log.info("daily_roll", date=today, last_self_calls=self._daily.get("self_calls"))
            self._daily = {"date": today, "self_calls": 0}

    def _daily_ok(self) -> bool:
        self._roll_daily()
        limit = int(config.AUTONOMY["daily_self_calls"])
        if self._daily["self_calls"] >= limit:
            if not self.state.get("daily_capped_logged"):
                log.warning("daily_cap_reached", limit=limit)
                self.state["daily_capped_logged"] = True
                self._set_note("今天的自主额度用完了，先安静待着")
            self.state["next_tick_at"] = time.time() + 1800
            return False
        self.state.pop("daily_capped_logged", None)
        return True

    # ================= 小本本 / 观测 =================
    def _set_note(self, text: str) -> None:
        self.state["note"] = " ".join(str(text or "").split())[:80]

    def _result_note(self, status: str, summary: str, text: str) -> str:
        name = f"「{text}」" if text else "刚那件事"
        if status == "done":
            return f"刚做完{name}：{summary}" if summary else f"刚做完{name}"
        if status == "aborted":
            return f"{name}被打断了"
        return f"{name}没做成：{summary}"

    def _result_event(self, status: str, summary: str, text: str) -> str:
        mapping = {"done": "完成了", "failed": "没做成", "aborted": "被打断了"}
        name = f"「{text}」" if text else "刚那件事"
        body = f"（身体）{name}{mapping.get(status, status)}"
        if summary:
            body += f"：{summary}"
        return body + "。"

    def _event_text(self, kind: str, detail: dict) -> str:
        names = {
            "hurt": "你被打了",
            "low_health": "你血不多了",
            "lava": "你脚边是岩浆",
            "void": "你快掉进虚空了",
            "hungry": "你饿得不行",
        }
        label = names.get(kind, kind or "出了点事")
        extra = ""
        if isinstance(detail, dict):
            if detail.get("health") is not None:
                extra = f"，血量{detail.get('health')}"
            if detail.get("food") is not None:
                extra += f"，饥饿{detail.get('food')}"
        return f"{label}{extra}"

    def _rate_ok(self) -> bool:
        cutoff = time.time() - 600
        self._call_times = [t for t in self._call_times if t >= cutoff]
        return len(self._call_times) < int(config.AUTONOMY["max_calls_per_10min"])

    def _remember(self, user_text: str, say: str) -> None:
        """历史只存「人说的话」和她真正说出的话；状态行与占位语都不进历史。
        没说话就不写 assistant 消息——否则模型会模仿「（没说话）」这类占位文字。"""
        clean_user = re.sub(r"\s*（系统附注·.*?）\s*$", "", user_text, flags=re.DOTALL).strip()
        self.history.append({"role": "user", "content": clean_user})
        if say:
            self.history.append({"role": "assistant", "content": say})
        if len(self.history) > config.HISTORY_KEEP * 2:
            del self.history[: len(self.history) - config.HISTORY_KEEP * 2]

    async def _maybe_summarize(self) -> None:
        if len(self.history) < int(config.AUTONOMY["summary_after"]):
            return
        lines = "\n".join(f"{item['role']}：{item['content']}" for item in self.history[-12:])
        try:
            raw = await self.llm.chat(
                [
                    {"role": "system", "content": prompts.PERSONA},
                    {"role": "user", "content": prompts.summary_user(lines)},
                ],
                purpose="l1_summary",
                max_tokens=120,
                temperature=0.5,
            )
        except (LLMError, BudgetExceeded):
            return
        diary = sanitize_say(raw.get("content") or "")
        if diary:
            self.memory.add("diary", diary)
        self.history = self.history[-config.HISTORY_KEEP:]

    def _release_chain(self, chain: Chain | None) -> None:
        if chain is None:
            return
        for intention_id in chain.intention_ids:
            self.chains.pop(intention_id, None)

    def _prune_chains(self) -> None:
        if len(self.chains) <= 60:
            return
        for key in list(self.chains)[: len(self.chains) - 60]:
            self.chains.pop(key, None)

    def _log_chain(self, chain: Chain | None, intention_id: str, status: str, summary: str) -> None:
        if chain is None:
            return
        self.chain_log.append(
            {
                "intention_id": intention_id,
                "status": status,
                "summary": summary[:120],
                "replans": chain.replans,
                "negotiated": chain.negotiated,
                "budget": chain.budget.snapshot(),
            }
        )
        del self.chain_log[:-50]

    # ================= 持久化 =================
    def _load_state(self) -> dict:
        state = dict(DEFAULT_STATE)
        path = Path(config.MIND_STATE_PATH)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                state.update({k: v for k, v in data.items() if k in DEFAULT_STATE})
        except (OSError, json.JSONDecodeError):
            pass
        # 重启后身体早已空闲，旧的 current 不可信
        state["current"] = None
        state["next_tick_at"] = 0
        if state.get("mode") == "rest" and float(state.get("rest_until") or 0) < time.time():
            state["mode"] = "play"
            state["rest_until"] = 0
        return state

    def _save_state(self) -> None:
        path = Path(config.MIND_STATE_PATH)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as exc:
            log.warning("state_save_failed", error=str(exc))
