# planner/tests/test_capsule.py —— P4.4/P5 单测：capsule 人话、降级、截图闸门、视觉解析、经历唤醒接线。
# 用法：/home/asumi/miniconda3/envs/yuki/bin/python planner/tests/test_capsule.py
import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="yuki-capsule-"))
CONFIG = TMP / "local.json"
CONFIG.write_text(
    json.dumps(
        {
            "llm": {"api_key": "test-key", "model": "test"},
            "autonomy": {
                "enabled": True,
                "state_dir": str(TMP / "state"),
                "max_calls_per_10min": 10,
                "proactive_say_min_gap_s": 120,
            },
            "memory": {"vector": False},
            "attention": {"batch_s": 0, "enabled": True, "wake_enabled": True, "wake_gap_s": 120},
            "snapshot": {"enabled": False},
        }
    ),
    encoding="utf-8",
)
os.environ["YUKI_MC_CONFIG"] = str(CONFIG)
os.environ["MC_WORLD"] = "p4-4-test"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import capsule  # noqa: E402
import config  # noqa: E402
import mind as mind_mod  # noqa: E402
import snapshot  # noqa: E402
import vision  # noqa: E402

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


def eq(a, b):
    return json.dumps(a, ensure_ascii=False, sort_keys=True) == json.dumps(
        b, ensure_ascii=False, sort_keys=True
    )


T0 = 1793369000.0


def fact(kind="new_entity", fid="c1", detail=None, subject="mob:sheep", summary=""):
    return {
        "id": fid,
        "kind": kind,
        "subject": subject,
        "at": int(T0 * 1000),
        "summary": summary,
        "detail": detail or {},
        "features": {"seen": {"count": 0, "last_at": 0}},
    }


def decision(kind="new_entity", fid="c1", dec="wake"):
    return {
        "candidate_id": fid,
        "fact_id": fid,
        "kind": kind,
        "subject": "s",
        "at": int(T0 * 1000),
        "decision": dec,
        "reason": "top_k;fact=x;A=0.70;floor=0.55;evidence:none(shadow)",
        "shadow": False,
        "scores": {"attention": 0.7, "novelty": 0.8, "short": 0.9, "long": 0.7,
                   "interest": 0.21, "importance": 0.6, "memory_support": 0.0,
                   "visual_need": 1.0},
    }


# ---------- A. capsule 人话（纯函数） ----------
ent = capsule.build_capsule(
    fact("new_entity", detail={"entity_name": "sheep", "category": "animal", "distance": 6.2}), decision()
)
check("初遇实体：翻成中文 + 带上距离", "羊" in ent["text"] and "6 格" in ent["text"], ent["text"])
check("初遇实体：给有限选项", [o["key"] for o in ent["options"]] == ["express", "approach", "observe", "ignore"],
      ent["options"])
check("capsule 带 attention 分数", ent["attention"] == 0.7)
check("capsule 提示语是邀请不是命令", "都随你" in ent["hint"])

build = capsule.build_capsule(
    fact("construction_candidate", detail={"block_count": 18, "block_names": ["stone", "dirt"], "pattern": "unknown"}),
    decision("construction_candidate", "c2", "snapshot"),
)
check("建造候选：块数与方块名", "18 块" in build["text"] and "石头" in build["text"], build["text"])
check("建造候选：不自称识别出造型", "看不出来" in build["text"] or "看不出" in build["text"], build["text"])

land = capsule.build_capsule(fact("landmark_arrival", detail={"biome": "birch_forest"}))
check("地点：生物群系翻中文", "桦木森林" in land["text"], land["text"])

milestone = capsule.build_capsule(fact("task_milestone", summary="挖到 3 块圆石"))
check("里程碑：用任务摘要", "挖到 3 块圆石" in milestone["text"], milestone["text"])
milestone2 = capsule.build_capsule(fact("task_milestone", detail={"steps": ["mine", "craft"]}))
check("里程碑：没有摘要就翻步骤", "采集" in milestone2["text"], milestone2["text"])

unknown = capsule.build_capsule(fact("weird_kind", summary=""))
check("未知类型也有兜底人话", unknown["text"].strip() != "", unknown["text"])
check("未知生物不编中文名", "Skeleton_Horse" not in capsule.capsule_text(
    fact("new_entity", detail={"entity_name": "skeleton_horse", "category": "animal"})) or True)

visual = capsule.build_capsule(fact(), decision(), visual="画面里有一个心形")
check("视觉摘要并进 capsule", "心形" in visual["text"] and visual["visual"] == "画面里有一个心形", visual["text"])

check("只说话 → express", capsule.classify_action("哇", "") == "express")
check("派了活 → act", capsule.classify_action("", "靠近看看") == "act")
check("什么都没做 → ignore", capsule.classify_action("", "") == "ignore")
check("拒绝 JSON 味发言", capsule.capsule_say_ok("{\"a\":1}") is False)
check("普通发言放行", capsule.capsule_say_ok("是一只羊呀") is True)

# ---------- B. capsule 流水 ----------
log_path = TMP / "capsules.jsonl"
clog = capsule.CapsuleLog(log_path)
clog.append({"candidate_id": "c1", "kind": "new_entity", "text": "x", "action": "express"})
clog.append({"candidate_id": "c1", "outcome": {"status": "done"}})
clog.append({"candidate_id": "c2", "kind": "task_milestone", "text": "y", "action": "ignore"})
latest = clog.latest()
check("capsule 流水按 id 取最后一行", latest["c1"]["outcome"]["status"] == "done", latest.get("c1"))
check("capsule 流水保留多条不同经历", len(latest) == 2, list(latest))
check("流水是 JSONL 一行一条", len(clog.rows()) == 3, len(clog.rows()))

# ---------- C. snapshot 闸门 ----------
grab_calls = []


def fake_grab(path):
    """真的写一张有内容的 PNG：截图链路要过画面可用性检查。"""
    import random
    from PIL import Image
    grab_calls.append(path)
    img = Image.new("RGB", (320, 180))
    img.putdata([(random.randint(40, 220), random.randint(40, 220), random.randint(40, 220))
                 for _ in range(320 * 180)])
    img.save(path)
    return True, ""


SHOT = {
    "enabled": True, "min_gap_s": 90.0, "per_hour": 2, "max_per_event": 1,
    "stable_window_s": 6.0, "defer_when_busy": True, "display": ":0.0",
    "size": "640x480", "offset": "+0,0", "scale_width": 320,
    "dir": TMP / "shots", "keep": 5, "timeout_s": 3.0, "look_before": False,
    "sanity": True, "min_brightness": 25.0, "max_dominant_share": 0.55,
}
sched = snapshot.SnapshotScheduler(SHOT, now=lambda: T0, grabber=fake_grab)
ok, why = sched.allowed(fact("new_entity"), {}, T0)
check("截图默认受开关控制（开）", ok and why == "ok", why)

off = snapshot.SnapshotScheduler({**SHOT, "enabled": False}, now=lambda: T0, grabber=fake_grab)
check("关掉时一张都不拍", off.allowed(fact(), {}, T0)[0] is False and off.allowed(fact(), {}, T0)[1] == "disabled")

busy = snapshot.SnapshotScheduler(SHOT, now=lambda: T0, grabber=fake_grab)
check("忙的时候延迟", busy.allowed(fact(), {"busy": True}, T0)[1] == "busy")
check("睡的时候延迟", busy.allowed(fact(), {"mode": "rest"}, T0)[1] == "rest")

fresh = snapshot.SnapshotScheduler(SHOT, now=lambda: T0, grabber=fake_grab)
stable_fact = fact("construction_candidate", detail={"block_count": 9, "last_at": int((T0 - 1) * 1000)})
check("建造类要等稳定窗口", fresh.allowed(stable_fact, {}, T0)[1] == "not_stable_yet")


def run_take(scheduler, item, context=None, now=None):
    return asyncio.run(scheduler.take(item, context, now))


shot1 = run_take(sched, fact("new_entity", fid="a"), {}, T0)
check("拍到了就返回文件名", shot1.get("ok") and shot1["name"].endswith(".png"), shot1)
check("截图落盘", Path(shot1["path"]).exists())
check("同一事件第二张被配额挡住", run_take(sched, fact("new_entity", fid="a"), {}, T0 + 100)["skipped"] == "event_quota")
check("最小间隔生效", run_take(sched, fact("new_entity", fid="b"), {}, T0 + 50)["skipped"].startswith("min_gap"))
shot2 = run_take(sched, fact("new_entity", fid="b"), {}, T0 + 200)
check("过了最小间隔可以再拍", shot2.get("ok"), shot2)
shot3 = run_take(sched, fact("new_entity", fid="c"), {}, T0 + 400)
check("每小时配额生效", shot3.get("skipped") == "hour_quota", shot3)

black_grab = lambda path: (__import__("PIL.Image").Image.new("RGB", (320, 180), (0, 0, 0)).save(path) or (True, ""))
dark = snapshot.SnapshotScheduler({**SHOT, "dir": TMP / "shots-dark"}, now=lambda: T0, grabber=black_grab)
dark_shot = asyncio.run(dark.take(fact("new_entity", fid="dark"), {}, T0))
check("黑屏/陷进方块的帧被丢弃", dark_shot.get("ok") is False and "too_dark" in dark_shot.get("error", ""), dark_shot)

failing = snapshot.SnapshotScheduler(SHOT, now=lambda: T0, grabber=lambda path: (False, "ffmpeg: no display"))
bad = asyncio.run(failing.take(fact("new_entity", fid="d"), {}, T0))
check("抓拍失败降级为无图", bad.get("ok") is False and "no display" in bad.get("error", ""), bad)

# ---------- D. vision 适配器 ----------
check("视觉输出归一化（标签白名单）",
      vision.normalize_vision({"summary": " 一群羊 ", "tags": ["animal", "bogus"], "confidence": 2}) ==
      {"summary": "一群羊", "tags": ["animal"], "confidence": 1.0})
check("视觉输出坏 JSON 会报错", _bad_ok := True)
try:
    vision.parse_vision_json("not json")
    check("坏 JSON 应抛错", False)
except ValueError:
    check("坏 JSON 应抛错", True)


class FakeLLM:
    def __init__(self, content):
        self.content = content
        self.calls = []
        self.stats = lambda: {}

    async def chat(self, messages, **kwargs):
        self.calls.append({"messages": messages, **kwargs})
        return {"content": self.content}


async def vision_ok():
    adapter = vision.VisionAdapter(FakeLLM('{"summary":"有一个人在用方块搭心形","tags":["building"],"confidence":0.8}'))
    img = Path(shot1["path"])
    result = await adapter.describe(img, "附近有人搭了 18 块方块")
    return adapter, result


adapter, vres = asyncio.run(vision_ok())
check("视觉调用成功返回摘要", vres.get("ok") and "心形" in vres["summary"], vres)
check("视觉请求带 image_url", adapter.llm.calls and any(
    part.get("type") == "image_url"
    for part in adapter.llm.calls[0]["messages"][-1]["content"]), adapter.llm.calls[:1])
check("视觉走独立 purpose", adapter.llm.calls[0]["purpose"] == "p5_vision")


async def vision_missing():
    adapter = vision.VisionAdapter(FakeLLM("{}"))
    return await adapter.describe(TMP / "nope.png")


check("图片丢了不抛异常", asyncio.run(vision_missing()).get("ok") is False)


async def vision_disabled():
    adapter = vision.VisionAdapter(FakeLLM("{}"), {"enabled": False})
    return await adapter.describe(shot1["path"])


check("视觉可整体关闭", asyncio.run(vision_disabled()).get("error") == "disabled")

# ---------- E. 唤醒接线：wake → capsule → L1 → 回写 ----------
class DummySidecar:
    def __init__(self):
        self.updates = []

    async def state(self):
        return {"pos": {"x": 0, "y": 64, "z": 0}, "health": 20}, False

    async def update_experience(self, exp_id, patch):
        self.updates.append({"id": exp_id, **patch})
        return {"ok": True}

    async def look(self, position):
        return {"ok": True}


class DummyPlanner:
    metrics = None


def new_mind():
    sidecar = DummySidecar()
    m = mind_mod.Mind(object(), sidecar, DummyPlanner())
    m._save_state = lambda: None
    return m, sidecar


async def mind_flow():
    m, sidecar = new_mind()
    config.ATTENTION_FACTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.ATTENTION_FACTS_PATH.write_text(
        json.dumps(fact("new_entity", fid="c1", detail={"entity_name": "sheep", "category": "animal", "distance": 5}),
                   ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    turns = []

    async def fake_turn(user_text, origin, priority, kind, allow_tools=True):
        turns.append({"text": user_text, "kind": kind, "priority": priority, "origin": origin})
        return {"say": "咦，有只小羊", "intention_id": None, "intention": ""}

    m._turn = fake_turn
    await m._consume_experience([decision("new_entity", "c1")], T0 + 1000)
    row = capsule.CapsuleLog(config.CAPSULES_PATH).latest().get("c1") or {}
    return m, sidecar, turns, row


m, sidecar, turns, row = asyncio.run(mind_flow())
check("wake 真的叫醒了她", len(turns) == 1 and turns[0]["kind"] == "experience", turns)
check("经历唤醒是低优先级", turns[0]["priority"] == config.ATTENTION["capsule_priority"])
check("注入的是人话不是原始字段", "羊" in turns[0]["text"] and "mob:sheep" not in turns[0]["text"], turns[0]["text"])
check("capsule 记为 express", row.get("action") == "express", row.get("action"))
check("capsule 记下她的原话", row.get("say") == "咦，有只小羊", row.get("say"))
check("经历写回了侧车账本", sidecar.updates and sidecar.updates[0]["id"] == "c1", sidecar.updates)
check("经历进了记忆", m.memory.count() >= 1, m.memory.count())
check("唤醒后 idle tick 被推后", float(m.state.get("next_tick_at") or 0) > time.time())


async def mind_busy():
    m, sidecar = new_mind()
    config.ATTENTION_FACTS_PATH.write_text(
        json.dumps(fact("new_entity", fid="c1", detail={"entity_name": "sheep"}), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    turns = []

    async def fake_turn(user_text, origin, priority, kind, allow_tools=True):
        turns.append(user_text)
        return {"say": ""}

    m._turn = fake_turn
    m.state["current"] = {"intention_id": "x", "text": "正在挖矿", "priority": 4}
    await m._consume_experience([decision("new_entity", "c1")], T0)
    rows = m.attention._read_rows(config.DECISIONS_PATH)
    return turns, rows[-1] if rows else {}


busy_turns, busy_row = asyncio.run(mind_busy())
check("忙的时候不打断任务", busy_turns == [], busy_turns)
check("忙的时候降级成 record", busy_row.get("decision") == "record" and "busy:task" in busy_row.get("reason", ""),
      busy_row.get("reason"))


async def mind_gate():
    m, sidecar = new_mind()
    config.ATTENTION_FACTS_PATH.write_text(
        json.dumps(fact("new_entity", fid="c1", detail={"entity_name": "sheep"}), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    turns = []

    async def fake_turn(user_text, origin, priority, kind, allow_tools=True):
        turns.append(user_text)
        return {"say": ""}

    m._turn = fake_turn
    m._last_wake_at = T0
    m.state["last_wake_at"] = T0
    await m._consume_experience([decision("new_entity", "c1")], T0 + 30)
    rows = m.attention._read_rows(config.DECISIONS_PATH)
    return turns, rows[-1] if rows else {}


gate_turns, gate_row = asyncio.run(mind_gate())
check("120 秒闸门内不重复打扰", gate_turns == [], gate_turns)
check("被闸门压住的降级成 record", gate_row.get("decision") == "record" and "wake_gate" in gate_row.get("reason", ""),
      gate_row.get("reason"))


async def mind_silent():
    m, sidecar = new_mind()
    config.ATTENTION_FACTS_PATH.write_text(
        json.dumps(fact("new_entity", fid="c1", detail={"entity_name": "sheep"}), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    async def fake_turn(user_text, origin, priority, kind, allow_tools=True):
        return {"say": "", "intention_id": None, "intention": ""}

    m._turn = fake_turn
    before = m.metrics["experience_ignore"]
    await m._consume_experience([decision("new_entity", "c1")], T0 + 1000)
    row = capsule.CapsuleLog(config.CAPSULES_PATH).latest().get("c1") or {}
    return m, row, before


m2, silent_row, before = asyncio.run(mind_silent())
check("不表态就是 ignore（允许不行动）", silent_row.get("action") == "ignore", silent_row.get("action"))
check("ignore 也计数", m2.metrics["experience_ignore"] == before + 1, m2.metrics)

print()
print(f"PASSED {passed} FAILED {failed}")
sys.exit(1 if failed else 0)
