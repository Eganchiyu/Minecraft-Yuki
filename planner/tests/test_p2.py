# planner/tests/test_p2.py —— P2 纯单测：schema 拦截率 100%、预算、事实提取、JSON 解析、重规划记账。
# 用法：/home/asumi/miniconda3/envs/yuki/bin/python planner/tests/test_p2.py
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from budget import BudgetExceeded, TaskBudget  # noqa: E402
from facts import extract_facts, fallback_options, label_of  # noqa: E402
from l1 import Planner, parse_json_object  # noqa: E402
from schema import SchemaError, validate_options, validate_plan  # noqa: E402

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


# ---------- 1. schema 硬拦截：8 类历史非法输入 + 5 类新增 ----------
BAD = {
    "顶层不是对象": [],
    "steps 为空": {"steps": []},
    "超过 5 步": {"steps": [{"skill": "mine", "args": {"block": "stone", "count": 1}}] * 6},
    "未知技能": {"steps": [{"skill": "smelt", "args": {"item": "iron_ore"}}]},
    "非法 on_fail": {"steps": [{"skill": "mine", "args": {"block": "stone", "count": 1}, "on_fail": "explode"}]},
    "count 越界": {"steps": [{"skill": "mine", "args": {"block": "stone", "count": 999}}]},
    "count 是布尔": {"steps": [{"skill": "mine", "args": {"block": "stone", "count": True}}]},
    "坐标缺失": {"steps": [{"skill": "goto", "args": {"x": 1, "y": 2}}]},
    "deposit 坐标不完整": {"steps": [{"skill": "deposit", "args": {"x": 1, "y": 2}}]},
    "equip 槽位非法": {"steps": [{"skill": "equip", "args": {"item": "bread", "destination": "pocket"}}]},
    "args 不是对象": {"steps": [{"skill": "mine", "args": "stone"}]},
    "步骤不是对象": {"steps": ["mine stone"]},
    "含 if/loop 字段": {"steps": [{"skill": "mine", "args": {"block": "stone", "count": 1}, "if": "hungry"}]},
}
rejected = 0
for name, payload in BAD.items():
    try:
        validate_plan(payload)
    except SchemaError:
        rejected += 1
    except Exception as exc:  # 非 SchemaError 也是拒收，但要记录
        rejected += 1
        print(f"  note: {name} -> {type(exc).__name__}: {exc}")
check("① 13 类非法计划全部被 schema 拦截", rejected == len(BAD), f"{rejected}/{len(BAD)}")

GOOD = {
    "mine 20": {"steps": [{"skill": "mine", "args": {"block": "cobblestone", "count": 20}, "on_fail": "abort"}]},
    "craft": {"steps": [{"skill": "craft", "args": {"item": "wooden_pickaxe", "count": 1}}]},
    "goto 玩家": {"steps": [{"skill": "goto", "args": {"x": 1, "y": 2, "z": 3, "player": "xiaochi2788"}}]},
    "deposit 不带给坐标": {"steps": [{"skill": "deposit", "args": {}}]},
    "place 脚边": {"steps": [{"skill": "place", "args": {"item": "crafting_table"}}]},
    "eat 无参": {"steps": [{"skill": "eat", "args": {}}]},
}
for name, payload in GOOD.items():
    try:
        validate_plan(payload)
        ok = True
    except SchemaError as exc:
        ok = False
        print(f"  {name}: {exc}")
    check(f"① 合法计划放行：{name}", ok)

# ---------- 2. 失败协商方案校验 ----------
check(
    "② 2-3 个方案合法",
    len(validate_options({"options": [
        {"label": "先造工具", "text": "去砍点木头造一把木镐"},
        {"label": "算了", "text": "换个能做的事"},
    ]})) == 2,
)
for name, payload in {
    "只有 1 个": {"options": [{"label": "a", "text": "b"}]},
    "4 个": {"options": [{"label": "a", "text": "b"}] * 4},
    "label 空": {"options": [{"label": "", "text": "b"}, {"label": "c", "text": "d"}]},
    "不是数组": {"options": "a"},
}.items():
    try:
        validate_options(payload)
        ok = False
    except SchemaError:
        ok = True
    check(f"② 非法方案被拦截：{name}", ok)

# ---------- 3. 预算 ----------
b = TaskBudget(max_calls=2, max_tokens=1000, max_wall_s=60, max_retries=2)
b.check()
b.charge_usage(10, 10)
b.check()
b.charge_usage(10, 10)
try:
    b.check()
    ok = False
except BudgetExceeded:
    ok = True
check("③ 调用次数超限抛 BudgetExceeded", ok and b.exhausted)

b2 = TaskBudget(max_calls=10, max_tokens=20, max_wall_s=60, max_retries=2)
b2.charge_usage(15, 10)
check("③ token 超限判耗尽", b2.exhausted)

b3 = TaskBudget(max_calls=10, max_tokens=1000, max_wall_s=60, max_retries=2)
check("③ retry 名额默认 2 次", b3.take_retry() and b3.take_retry() and not b3.take_retry())

# ---------- 4. 事实提取 ----------
detail = {
    "failed_step": "mine",
    "results": [
        {"skill": "mine", "ok": False, "args": {"block": "diamond_ore", "count": 3},
         "detail": {"error": "no_target_block", "mined": 0, "requested": 3}},
    ],
}
facts = extract_facts(detail, "只挖到 0 块钻石矿")
check("④ 事实取第一个失败步骤 + 期望 vs 实际",
      facts["failed_skill"] == "mine" and facts["code"] == "no_target_block"
      and facts["expected"]["block"] == "diamond_ore" and facts["actual"]["mined"] == 0,
      json.dumps(facts, ensure_ascii=False))
check("④ 失败码有人话标签", label_of("missing_tool") == "没有能挖这个东西的工具")
check("④ 兜底方案 2 个且可执行", len(fallback_options(facts)) == 2
      and all(item.get("text") for item in fallback_options(facts)))
check("④ 非字典 detail 不崩", extract_facts(None, "")["code"] == "unknown")

# 侧车回调用扁平结构（error 直接在结果项上），必须也能认出来
flat = {
    "failed_step": "follow",
    "results": [{"skill": "follow", "ok": False, "args": {"player": "小池2788"}, "error": "player_not_visible"}],
}
flat_facts = extract_facts(flat, "跟丢了")
check("④ 扁平回调也能取出失败码与期望", flat_facts["code"] == "player_not_visible"
      and flat_facts["expected"]["player"] == "小池2788", json.dumps(flat_facts, ensure_ascii=False))
check("④ 找不到玩家的失败有人话标签", "英文 ID" in label_of("player_not_visible"))

# ---------- 5. JSON 解析 ----------
cases = {
    "裸 JSON": ('{"steps":[{"skill":"mine","args":{"block":"stone","count":1}}]}', True),
    "代码块": ('```json\n{"steps":[]}\n```', True),
    "前后有废话": ('好的：{"steps":[]} 完事', True),
    "没有 JSON": ("我做不到", False),
    "半个 JSON": ('{"steps":[', False),
}
for name, (text, ok_expected) in cases.items():
    try:
        parsed = parse_json_object(text)
        ok = isinstance(parsed, dict)
    except (ValueError, json.JSONDecodeError):
        ok = False
    check(f"⑤ 解析：{name}", ok == ok_expected, text[:40])


# ---------- 6. 假 LLM：修复重试与非法率记账 ----------
class FakeLLM:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0
        self.requests = []

    async def chat(self, messages, *, purpose, budget=None, **kwargs):
        self.calls += 1
        self.requests.append({"purpose": purpose, **kwargs})
        if budget is not None:
            budget.check()
            budget.charge_usage(10, 5)
        return {"content": self.replies.pop(0), "tool_calls": []}


import asyncio  # noqa: E402


async def planner_paths():
    # 第一次坏、修复成功
    p1 = Planner(FakeLLM(["不是 JSON", '{"steps":[{"skill":"mine","args":{"block":"stone","count":2}}]}']))
    steps = await p1.plan("挖石头", "未知")
    check("⑥ 坏输出 → 一次修复成功并启用 JSON mode",
          len(steps) == 1 and p1.metrics.repairs == 1 and p1.metrics.invalid == 1
          and all(call["response_format"] == {"type": "json_object"} for call in p1.llm.requests))

    # 两次都坏 → 拒收
    p2 = Planner(FakeLLM(["坏", "还坏"]))
    try:
        await p2.plan("挖石头", "未知")
        ok = False
    except (SchemaError, ValueError):
        ok = True
    check("⑥ 两次都坏 → 拒收且计入 rejected", ok and p2.metrics.rejected == 1)

    # 合法输出不修复，且非法率为 0
    p3 = Planner(FakeLLM(['{"steps":[{"skill":"mine","args":{"block":"stone","count":2}}]}']))
    await p3.plan("挖石头", "未知")
    check("⑥ 合法输出不走修复，非法率 0", p3.metrics.repairs == 0 and p3.metrics.snapshot()["invalid_rate"] == 0.0)

    # 重规划带 last_failure 也能出步骤
    p4 = Planner(FakeLLM(['{"steps":[{"skill":"mine","args":{"block":"oak_log","count":3}}]}']))
    steps = await p4.plan("挖石头", "未知", last_failure=facts)
    check("⑥ 重规划路径可用并启用 JSON mode",
          steps[0]["skill"] == "mine" and p4.metrics.attempts == 1
          and p4.llm.requests[0]["response_format"] == {"type": "json_object"})

    # L2 出方案失败 → 代码兜底
    p5 = Planner(FakeLLM(["坏的方案"]))
    options = await p5.options("挖钻石", facts, "未知")
    check("⑥ L2 方案失败 → 代码兜底 2 个方案并启用 JSON mode",
          len(options) == 2 and p5.metrics.options_failed == 1
          and p5.llm.requests[0]["response_format"] == {"type": "json_object"})


asyncio.run(planner_paths())

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
