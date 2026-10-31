# planner/tests/test_look.py —— 「看一眼」：按需抓帧、原图进 L1、L2 的 snapshot 技能补图。
# 用法：/home/asumi/miniconda3/envs/yuki/bin/python planner/tests/test_look.py
import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import domains  # noqa: E402
import look  # noqa: E402
import mind as mind_mod  # noqa: E402
import schema  # noqa: E402
import snapshot  # noqa: E402

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


TMP = Path(tempfile.mkdtemp(prefix="look-test-"))
OPTS = {
    "enabled": True, "dir": str(TMP), "scale_width": 960, "sanity": True,
    "min_brightness": 25.0, "max_dominant_share": 0.55, "keep": 5, "look_before": False,
}


# ---------- 1. 按需抓帧：不看事件闸门 ----------
def make_frame(path):
    """一张能被 PIL 打开、又不会被「单色判废」干掉的假帧。"""
    from PIL import Image
    image = Image.new("RGB", (32, 32))
    pixels = image.load()
    for x in range(32):
        for y in range(32):
            pixels[x, y] = ((x * 7) % 256, (y * 11) % 256, (x + y) % 256)
    image.save(path)
    return True, ""


async def capture_ok():
    sched = snapshot.SnapshotScheduler({**OPTS, "min_gap_s": 999, "per_hour": 1},
                                       grabber=make_frame, now=lambda: 1000.0)
    shot = await sched.capture("look", "看看前面")
    return shot, sched


shot, sched = asyncio.run(capture_ok())
check("抓帧成功", shot.get("ok") is True, shot)
check("绕过事件闸门（min_gap/per_hour 不拦）", Path(shot.get("path", "")).exists(), shot)
check("记 demand 计数", sched.stats.get("demand") == 1, sched.stats)


async def capture_fail():
    def grab(path):
        return False, "ffmpeg_failed"

    sched = snapshot.SnapshotScheduler({**OPTS, "dir": str(TMP)}, grabber=grab)
    return await sched.capture("look", "看看")


bad = asyncio.run(capture_fail())
check("抓不到如实返回失败", bad.get("ok") is False and bad.get("error") == "ffmpeg_failed", bad)


async def capture_black():
    from PIL import Image

    def grab(path):
        Image.new("RGB", (64, 64), (0, 0, 0)).save(path)
        return True, ""

    sched = snapshot.SnapshotScheduler({**OPTS, "dir": str(TMP)}, grabber=grab)
    return await sched.capture("look", "看看")


before = set(TMP.glob("*-look*.png"))
dark = asyncio.run(capture_black())
check("黑屏判废", dark.get("ok") is False and "too_dark" in str(dark.get("error")), dark)
check("废片不留在盘上", set(TMP.glob("*-look*.png")) == before, list(TMP.glob("*.png")))


# ---------- 2. 原图能不能塞进 L1 ----------
looker = look.Looker(snapshot.SnapshotScheduler({**OPTS}), {"enabled": True, "show_image": True})
good = TMP / "good.png"
good.write_bytes(b"x" * 100)
check("可用图片可附带", looker.attachable(good) == (True, ""), looker.attachable(good))
check("不存在的图不附带", looker.attachable(TMP / "nope.png")[0] is False)
check("关掉 show_image 就不附图", look.Looker(None, {"enabled": True, "show_image": False}).attachable(good)[0] is False)
check("超大图不附图",
      look.Looker(None, {"enabled": True, "show_image": True, "max_image_bytes": 10}).attachable(good)[0] is False)
check("data_url 前缀正确", look.data_url(good).startswith("data:image/png;base64,"))


# ---------- 3. L1 的 look 工具 → 原图进上下文 ----------
class FakeLLM:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    async def chat(self, messages, **kwargs):
        self.calls.append({"messages": messages, **kwargs})
        return self.replies.pop(0) if self.replies else {"content": ""}


class DummySidecar:
    async def state(self):
        return {"pos": {"x": 0, "y": 64, "z": 0}}, False


class DummyPlanner:
    metrics = None


def new_mind(llm):
    m = mind_mod.Mind(llm, DummySidecar(), DummyPlanner())
    m._save_state = lambda: None
    m._recall = lambda *a, **k: []
    m._remember = lambda *a, **k: None

    async def no_summary():
        return None

    m._maybe_summarize = no_summary
    return m


async def l1_look_flow():
    llm = FakeLLM([
        {"content": "", "tool_calls": [{"function": {"name": "look", "arguments": json.dumps({"reason": "看看前面"})}}]},
        {"content": "前面有条河喵"},
    ])
    m = new_mind(llm)

    async def fake_see(reason="", hint="", look_at=None):
        return {"ok": True, "path": str(good), "name": "good.png"}

    m.look.see = fake_see
    return await m._turn("（你想看一眼）", origin="chat", priority=3, kind="chat"), llm, m


result, llm, m = asyncio.run(l1_look_flow())
check("L1 调用 look 后会再说一句", result.get("say") == "前面有条河喵", result)
check("look 记一次统计", m.metrics.get("looks") == 1, m.metrics)
check("第二次调用带上了原图",
      any(isinstance(mess.get("content"), list) for mess in llm.calls[-1]["messages"]), llm.calls[-1]["messages"][-1])
check("工具列表里有 look 与 intention",
      {t["function"]["name"] for t in (llm.calls[0].get("tools") or [])} == {"intention", "look"},
      llm.calls[0].get("tools"))


async def l1_look_unavailable():
    llm = FakeLLM([
        {"content": "", "tool_calls": [{"function": {"name": "look",
                                                    "arguments": json.dumps({"reason": "看看前面"})}}]},
        {"content": "眼睛看不见，先不乱走"},
    ])
    m = new_mind(llm)

    async def fake_see(reason="", hint="", look_at=None):
        return {"ok": False, "error": "ffmpeg_failed"}

    m.look.see = fake_see
    return await m._turn("（你想看一眼）", origin="chat", priority=3, kind="chat"), llm


missing, missing_llm = asyncio.run(l1_look_unavailable())
check("拍不到时如实说看不见", missing.get("look", {}).get("ok") is False, missing)
check("拍不到时第二次调用不带图",
      all(not isinstance(mess.get("content"), list) for mess in missing_llm.calls[-1]["messages"]),
      missing_llm.calls[-1]["messages"][-1])


# ---------- 4. L2 的 snapshot 技能 → 收尾时补图 ----------
async def l2_snapshot_flow():
    m = new_mind(FakeLLM([{"content": "山上能看到海"}]))
    seen = []

    async def fake_see(reason="", hint="", look_at=None):
        seen.append({"reason": reason, "look_at": look_at})
        return {"ok": True, "path": str(good), "name": "good.png"}

    m.look.see = fake_see
    chain = mind_mod.Chain("去山上看看", 5, "chat")
    chain.steps = [{"skill": "snapshot", "args": {"reason": "看看山下", "x": 1, "y": 70, "z": 3}, "on_fail": "skip"}]
    m.chains["intent-1"] = chain

    turns = []
    real_turn = m._turn

    async def spy_turn(user_text, **kwargs):
        turns.append(kwargs)
        return await real_turn(user_text, **kwargs)

    m._turn = spy_turn
    await m.callback({"intention_id": "intent-1", "status": "done", "summary": "拍好了", "detail": {}})
    return seen, turns, m


seen, turns, m = asyncio.run(l2_snapshot_flow())
check("L2 的 snapshot 会真的抓一张", seen and seen[0]["reason"] == "看看山下", seen)
check("坐标被当成转向目标", seen and seen[0]["look_at"] == {"x": 1, "y": 70, "z": 3}, seen)
check("结果回 L1 时附了原图", turns and turns[0].get("image_path") == str(good), turns)


# ---------- 5. 域与 schema ----------
check("snapshot 在技能白名单里", "snapshot" in schema.SKILLS)
check("「看看周围」路由到 observe", domains.route("看看周围有什么").name == "observe")
check("「去山上看看」路由到 observe", domains.route("去山上看看").name == "observe")
check("observe 域能用 snapshot", "snapshot" in domains.route("看一眼山下").skills)
check("兜底域也有 snapshot", "snapshot" in domains.GENERAL.skills)
steps = schema.validate_plan({"steps": [{"skill": "snapshot", "args": {"yaw": -90, "pitch": -20}}]})
check("snapshot 参数校验通过", steps[0]["args"] == {"yaw": -90, "pitch": -20}, steps)
try:
    schema.validate_plan({"steps": [{"skill": "snapshot", "args": {"pitch": -120}}]})
    ok = False
except schema.SchemaError:
    ok = True
check("snapshot 的 pitch 超范围被拒", ok)
check("snapshot 在技能行里", "snapshot" in mind_mod.prompts.SKILL_LINES)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
