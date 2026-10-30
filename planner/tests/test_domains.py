# planner/tests/test_domains.py —— L2 分域：路由、域内白名单、notes 回流、域 prompt 裁剪。
# 用法：/home/asumi/miniconda3/envs/yuki/bin/python planner/tests/test_domains.py
import asyncio
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import domains  # noqa: E402
import prompts  # noqa: E402
from l1 import Plan, Planner  # noqa: E402

passed = 0
failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} | {detail}")


# ---------- 1. 路由：关键词命中与兜底 ----------
CASES = [
    ("去挖点石头", "gather"),
    ("帮我砍点木头", "gather"),
    ("挖20个铁矿", "gather"),
    ("给我做个木镐", "craft"),
    ("造个工作台", "craft"),
    ("把背包里的东西存进箱子", "interact"),
    ("这个铁锭给你", "interact"),        # 「给你」→ 递东西，不该走去合成
    ("过来我这边", "travel"),
    ("跟着我别乱跑", "travel"),
    ("去打三只僵尸", "combat"),
    ("随便逛逛", "travel"),
    ("打开箱子看看", "interact"),
    ("今天天气不错", "general"),
    ("", "general"),
]
for text, want in CASES:
    got = domains.route(text)
    check(f"路由「{text or '空'}」→ {want}", got.name == want, f"got {got.name}")


# ---------- 2. 域内白名单：域外技能必须被拒 ----------
from schema import SchemaError, validate_plan  # noqa: E402

gather = domains.DOMAINS["gather"]
allowed = frozenset(gather.skills)
ok = True
try:
    validate_plan({"steps": [{"skill": "attack", "args": {"target": "hostile"}}]}, allowed)
    ok = False
except SchemaError:
    pass
check("域内白名单：采集域拒收 attack", ok)

ok = True
try:
    validate_plan({"steps": [{"skill": "mine", "args": {"block": "stone", "count": 2}}]}, allowed)
except SchemaError:
    ok = False
check("域内白名单：采集域放行 mine", ok)


# ---------- 3. 每个域的技能都在全集里 ----------
missing = []
for d in list(domains.DOMAINS.values()) + [domains.GENERAL]:
    bad = [s for s in d.skills if s not in prompts.SKILL_LINES]
    if bad:
        missing.append((d.name, bad))
check("每个域的技能都有参数说明行", not missing, str(missing))

dup = {d.name: len(d.skills) != len(set(d.skills)) for d in domains.DOMAINS.values()}
check("域内技能无重复", not any(dup.values()), str(dup))

unreached = [n for n, d in domains.DOMAINS.items() if not d.keywords]
check("每个具名域都有路由关键词", not unreached, str(unreached))

# 加技能最容易漏的地方：schema 白名单、说明行、例子、域归属、执行器注册，五处对不上
from schema import SKILLS  # noqa: E402

check("每个技能都有说明行", not (SKILLS - set(prompts.SKILL_LINES)), str(SKILLS - set(prompts.SKILL_LINES)))
check("每个技能都有例子", not (SKILLS - set(prompts.SKILL_EXAMPLES)), str(SKILLS - set(prompts.SKILL_EXAMPLES)))
domained = set()
for _d in list(domains.DOMAINS.values()) + [domains.GENERAL]:
    domained |= set(_d.skills)
check("每个技能至少属于一个域", not (SKILLS - domained), str(SKILLS - domained))

try:
    import subprocess

    out = subprocess.run(
        ["node", "-e", "console.log(require('./yuki-bot/sidecar/skills').SKILL_NAMES.join(','))"],
        cwd=str(Path(__file__).resolve().parents[2]), capture_output=True, text=True, timeout=20,
    )
    sidecar = set(filter(None, out.stdout.strip().split(",")))
    check("planner 白名单与执行器注册一致", sidecar == set(SKILLS), f"仅 planner: {set(SKILLS) - sidecar}；仅执行器: {sidecar - set(SKILLS)}")
except Exception as exc:  # node 不在也不该拦住别的用例
    check("planner 白名单与执行器注册一致", False, f"检查失败: {exc}")


# ---------- 4. 域 prompt 裁剪：域外技能不出现在 prompt 里 ----------
def skills_mentioned(text):
    # 用词边界：「Minecraft」里含 mine/craft，子串匹配会假报
    return {name for name in prompts.SKILL_LINES if re.search(rf"\b{name}\b", text)}


for name, d in domains.DOMAINS.items():
    text = prompts.planner_system(d)
    leaked = skills_mentioned(text) - set(d.skills)
    check(f"「{name}」prompt 不含域外技能名", not leaked, str(leaked))
    check(f"「{name}」prompt 含本域专家册", not d.brief or d.brief.splitlines()[0] in text)

combat_prompt = prompts.planner_system(domains.DOMAINS["combat"])
check("战斗域 prompt 带战斗常识", "苦力怕" in combat_prompt)
check("采集域 prompt 不带战斗常识", "苦力怕" not in prompts.planner_system(gather))


# ---------- 5. notes：随计划回流，且不混进 steps ----------
class FakeLLM:
    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []

    async def chat(self, messages, **kwargs):
        self.requests.append({**kwargs, "messages": messages})
        budget = kwargs.get("budget")
        if budget is not None:
            budget.charge_usage(10, 5)
        return {"content": self.replies.pop(0), "tool_calls": []}


async def plan_paths():
    reply = ('{"steps":[{"skill":"mine","args":{"block":"iron_ore","count":3}}],'
             '"notes":"背包里只有木镐，挖不动铁矿"}')
    p = Planner(FakeLLM([reply]))
    plan = await p.plan("挖点铁矿", "未知")
    check("notes 被解析出来", plan.notes == "背包里只有木镐，挖不动铁矿", plan.notes)
    check("plan 仍是个步骤列表", isinstance(plan, Plan) and len(plan) == 1 and plan[0]["skill"] == "mine")
    check("notes 不在步骤里", "notes" not in plan[0])
    check("路由结果记在 plan 上", plan.domain == "gather", plan.domain)
    system = p.llm.requests[0]["messages"][0]["content"]
    check("用的是采集域的 prompt", "矿石分布" in system)
    check("采集域 prompt 里没有 attack", not skills_mentioned(system) - set(gather.skills))

    # 重规划沿用同一域：不该被链上的域名带偏
    p2 = Planner(FakeLLM([reply]))
    plan2 = await p2.plan("挖点铁矿", "未知", domain_name="gather")
    check("按 domain_name 复用域", plan2.domain == "gather")

    # 域外技能 → 修复一次仍不合规 → 拒收（不能把域外步骤送进执行器）
    bad = '{"steps":[{"skill":"attack","args":{"target":"hostile"}}]}'
    p3 = Planner(FakeLLM([bad, bad]))
    try:
        await p3.plan("挖点石头", "未知")
        rejected = False
    except SchemaError:
        rejected = True
    check("域外技能被拒收而不是下发", rejected and p3.metrics.rejected == 1)

    # 没有 notes 字段时不报错
    p4 = Planner(FakeLLM(['{"steps":[{"skill":"mine","args":{"block":"stone","count":1}}]}']))
    plan4 = await p4.plan("挖石头", "未知")
    check("缺 notes 字段不报错", plan4.notes == "")


asyncio.run(plan_paths())

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
