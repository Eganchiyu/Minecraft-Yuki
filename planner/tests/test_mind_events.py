# planner/tests/test_mind_events.py —— P4.3 决策 #49/#50：忙时不丢事件、超时降级、idle 与唤醒共用闸门。
# 用法：/home/asumi/miniconda3/envs/yuki/bin/python planner/tests/test_mind_events.py
import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="yuki-mind-events-"))
CONFIG = TMP / "local.json"
CONFIG.write_text(
    json.dumps(
        {
            "llm": {"api_key": "test-key", "model": "test"},
            "autonomy": {
                "enabled": True,
                "state_dir": str(TMP / "state"),
                "idle_gap_s": 45,
                "max_idle_gap_s": 120,
                "event_aggregate_s": 30,
                "event_ttl_s": 180,
                "proactive_say_min_gap_s": 120,
                "max_calls_per_10min": 0,
            },
            "memory": {"vector": False},
            "attention": {"batch_s": 0, "enabled": True},
        }
    ),
    encoding="utf-8",
)
os.environ["YUKI_MC_CONFIG"] = str(CONFIG)
os.environ["MC_WORLD"] = "events-test"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config  # noqa: E402
import mind as mind_mod  # noqa: E402

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


class DummyLLM:
    pass


class DummySidecar:
    async def state(self):
        return {"pos": {"x": 0, "y": 64, "z": 0}, "health": 20}, False


class DummyPlanner:
    metrics = None


def new_mind():
    m = mind_mod.Mind(DummyLLM(), DummySidecar(), DummyPlanner())
    m._save_state = lambda: None       # 状态落盘不是本测试的对象
    return m


async def main():
    m = new_mind()
    calls = []

    async def fake_turn(user_text, origin, priority, kind, allow_tools=True):
        calls.append({"text": user_text, "kind": kind, "at": time.time()})
        return {"say": "嗯"}

    m._turn = fake_turn
    now = time.time()

    # 1. 聚合窗口没到：先攒着
    m._event_buffer = [(now - 10, "一只羊")]
    await m._flush_events(now)
    check("事件: 窗口没到不唤醒", calls == [] and len(m._event_buffer) == 1)

    # 2. 忙着：due 的事件不丢，留在缓冲里等空闲（决策 #49）
    m._event_buffer = [(now - 40, "有羊"), (now - 35, "有牛")]
    m.state["current"] = {"intention_id": "x"}
    await m._flush_events(now)
    check("事件: 忙时不摘缓冲", len(m._event_buffer) == 2, m._event_buffer)
    check("事件: 忙时不唤醒", calls == [])

    # 3. 空闲了：补发一条（合并成一句话）
    m.state["current"] = None
    await m._flush_events(now)
    check("事件: 空闲后补发一条", len(calls) == 1 and "有羊" in calls[0]["text"] and "有牛" in calls[0]["text"], calls)
    check("事件: 补发后缓冲清空", m._event_buffer == [])
    check("事件: 补发算一次唤醒", abs(m._last_wake_at - now) < 2, m._last_wake_at)

    # 4. 超时降级：只记进记忆，不再唤醒
    calls.clear()
    m._event_buffer = [(now - 1000, "很久以前的事件")]
    await m._flush_events(now)
    check("事件: 超 TTL 不唤醒", calls == [])
    check("事件: 超 TTL 降级进记忆", m.memory.recent(1)[0]["text"] == "很久以前的事件",
          m.memory.recent(1))
    check("事件: 超 TTL 从缓冲移除", m._event_buffer == [])

    # 5. idle 与唤醒共用 120 秒闸门（决策 #50）
    m._last_wake_at = now - 10
    m.state["idle_rounds"] = 0
    m._schedule_idle()
    gap_to_wake = m.state["next_tick_at"] - m._last_wake_at
    check("闸门: idle tick 后移到唤醒后 120 秒", abs(gap_to_wake - 120) < 2, gap_to_wake)
    check("闸门: 10 秒后仍不算打开", m._wake_gate_open(now) is False)
    check("闸门: 满 120 秒才打开", m._wake_gate_open(m._last_wake_at + 120) is True)

    # 6. 注意力上下文：忙/睡/刚说话都能表达
    m.state["current"] = None
    m.state["mode"] = "play"
    m.state["last_say_at"] = now - 5
    ctx = m._attention_context({"pos": {"x": 1, "y": 2, "z": 3}})
    check("上下文: 带位置与说话时间", ctx["pos"]["x"] == 1 and ctx["last_say_at"] == now - 5)
    check("上下文: 不在忙", ctx["busy"] is False)
    m.state["current"] = {"intention_id": "y"}
    check("上下文: 忙时 busy=True", m._attention_context({})["busy"] is True)

    # 7. 注意力 Engine 真的被 _tick 调起来（不调模型、不唤醒）
    facts = config.ATTENTION_FACTS_PATH
    facts.parent.mkdir(parents=True, exist_ok=True)
    facts.write_text(json.dumps({
        "id": "f1", "at": int(now * 1000), "kind": "new_entity", "subject": "mob:sheep",
        "summary": "", "salience": None, "features": {"seen": {"count": 0, "last_at": 0}},
        "detail": {"entity_name": "sheep", "category": "animal", "distance": 3},
    }) + "\n", encoding="utf-8")
    calls.clear()
    m.state["next_tick_at"] = 0
    await m._tick()
    decisions = config.DECISIONS_PATH.read_text(encoding="utf-8") if config.DECISIONS_PATH.exists() else ""
    check("接线: _tick 会跑注意力并写 decision", '"candidate_id": "f1"' in decisions, decisions)
    check("接线: Shadow 下不因为 decision 调模型", calls == [], calls)

    await m.stop()


asyncio.run(main())

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
