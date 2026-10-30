# planner/tests/p4_4_live.py —— P4.4 真机验收：三种经历各完成一次「发现 → 反应/忽略 → 落账」。
#
# 由 scripts/p4-4-run.sh 调用；也可以手动指路径：
#   P44_STATE=planner/state/worlds/p4-4-test P44_PLANNER=http://127.0.0.1:8791 \
#   P44_SIDECAR=http://127.0.0.1:8790 python planner/tests/p4_4_live.py
import json
import os
import re
import sys
import threading
import time
import urllib.request
from pathlib import Path

STATE = Path(os.environ.get("P44_STATE", "")).expanduser()
PLANNER = os.environ.get("P44_PLANNER", "").rstrip("/")
SIDECAR = os.environ.get("P44_SIDECAR", "").rstrip("/")
SIDECAR_LOG = Path(os.environ.get("P44_SIDECAR_LOG", "/tmp/p4-4/sidecar.log"))

WANT_KINDS = ("new_entity", "construction_candidate", "task_milestone")
CAPSULE_KEYS = {"candidate_id", "kind", "text", "hint", "options", "action", "remembered", "at_ms"}

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


def read_rows(path: Path) -> list[dict]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def latest(rows: list[dict], key: str) -> dict[str, dict]:
    out = {}
    for row in rows:
        cid = str(row.get(key) or "")
        if cid:
            out[cid] = row
    return out


def http_json(url: str, payload: dict | None = None, timeout: float = 30.0) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        text = resp.read().decode("utf-8")
    return json.loads(text) if text else {}


# ---------- 1. 文件：事实 → 决策 → 胶囊 ----------
facts = latest(read_rows(STATE / "experiences.jsonl"), "id")
decisions = latest(read_rows(STATE / "decisions.jsonl"), "candidate_id")
capsules = latest(read_rows(STATE / "capsules.jsonl"), "candidate_id")

check("事实行已落盘", len(facts) >= 3, len(facts))
check("每条事实都有 decision", facts and all(fid in decisions for fid in facts),
      [fid for fid in facts if fid not in decisions][:5])
check("确实产生了真唤醒（shadow=false）", any(
    row.get("decision") in ("wake", "snapshot") and row.get("shadow") is False for row in decisions.values()),
      [row.get("decision") for row in decisions.values()])
check("胶囊落在事实之上", capsules and set(capsules) <= set(facts), list(set(capsules) - set(facts))[:5])
check("胶囊字段齐全", capsules and all(CAPSULE_KEYS <= set(row) for row in capsules.values()),
      [sorted(CAPSULE_KEYS - set(row)) for row in capsules.values()[:3]])

kinds = {row.get("kind") for row in capsules.values()}
missing = [kind for kind in WANT_KINDS if kind not in kinds]
check("初遇实体 / 建造候选 / 任务里程碑各叫醒过一次", not missing, missing)

raw_leak = re.compile(r"mob:|cluster:|task:|minecraft:|[a-z_]+:[a-z_]+")
for row in capsules.values():
    text = str(row.get("text") or "")
    if not text:
        check("胶囊有人话", False, row)
        break
    if raw_leak.search(text):
        check("胶囊不泄漏原始字段", False, text)
        break
else:
    check("胶囊有人话且不泄漏原始字段（无 mob:/cluster:/坐标）",
          all(str(row.get("text") or "").strip() for row in capsules.values()))

check("胶囊带有限选项与不管", all(
    isinstance(row.get("options"), list) and any(o.get("key") == "ignore" for o in row["options"])
    for row in capsules.values()), [row.get("options") for row in capsules.values()[:2]])
check("胶囊记下她的反应（说/动手/不理）", all(
    row.get("action") in ("express", "act", "ignore") for row in capsules.values()),
      [row.get("action") for row in capsules.values()])
check("经历都进了记忆（remembered）", all(row.get("remembered") for row in capsules.values()))

wake_times = sorted(int(row.get("at_ms") or 0) for row in capsules.values())
gaps = [later - earlier for earlier, later in zip(wake_times, wake_times[1:])]
check("经历唤醒之间 ≥120 秒", all(gap >= 120000 for gap in gaps), gaps)
check("胶囊没有重复候选", len(capsules) == len({row["candidate_id"] for row in capsules.values()}))

# ---------- 2. planner 状态 ----------
if PLANNER:
    try:
        state = http_json(f"{PLANNER}/state", timeout=10)
        att = state.get("attention") or {}
        check("/state 显示真的开了唤醒", att.get("wake_enabled") is True and att.get("shadow") is False, att)
        check("/state 记录经历次数", int((state.get("metrics") or {}).get("experience", 0)) >= len(capsules),
              (state.get("metrics") or {}).get("experience"))
        check("/state 带截图/视觉观测（P5 预留）",
              isinstance(state.get("snapshot"), dict) and isinstance(state.get("vision"), dict))
        api = http_json(f"{PLANNER}/decisions?n=200", timeout=10)
        check("/decisions 可读", int(api.get("total", 0)) >= len(decisions), api.get("total"))
    except Exception as exc:
        check("/state 可读", False, str(exc))

# ---------- 3. 侧车账本回写 ----------
if SIDECAR:
    try:
        items = http_json(f"{SIDECAR}/experiences?n=100", timeout=10).get("items") or []
        ledger = {str(item.get("id")): item for item in items}
        matched = [cid for cid in capsules if cid in ledger]
        check("胶囊对应的经历都在侧车账本里", len(matched) == len(capsules),
              {"capsules": len(capsules), "matched": len(matched)})
        check("她的反应写回了账本", matched and all(
            ledger[cid].get("action") == capsules[cid].get("action") for cid in matched),
              [(ledger[cid].get("action"), capsules[cid].get("action")) for cid in matched[:3]])
        check("账本里带 reaction 或明确的 ignore", matched and all(
            ledger[cid].get("reaction") is not None or ledger[cid].get("action") == "ignore" for cid in matched),
              [ledger[cid].get("reaction") for cid in matched[:3]])
    except Exception as exc:
        check("侧车账本可读", False, str(exc))

# ---------- 4. 经历派生的行动是低优先级 ----------
act_capsules = [row for row in capsules.values() if row.get("intention_id")]
if act_capsules and SIDECAR_LOG.exists():
    log_rows = read_rows(SIDECAR_LOG)
    starts = {str(row.get("intention_id")): row for row in log_rows if row.get("evt") == "task_start"}
    derived = [starts.get(str(row["intention_id"])) for row in act_capsules]
    check("经历派生的行动按低优先级下发（外部指令能接管）",
          all(row and int(row.get("priority", 99)) == 2 for row in derived),
          [row and row.get("priority") for row in derived])
else:
    print("SKIP 这一轮她自己没动手（ignore/说话都算合格反应），跳过优先级核对")


# ---------- 5. 抢占：外部指令立刻接管低优先级行动 ----------
def collect_sse(events: list[dict], stop: threading.Event) -> None:
    try:
        req = urllib.request.Request(f"{SIDECAR}/events", headers={"Accept": "text/event-stream"})
        with urllib.request.urlopen(req, timeout=25) as resp:
            for raw in resp:
                if stop.is_set():
                    return
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data: "):
                    continue
                try:
                    events.append(json.loads(line[6:]))
                except json.JSONDecodeError:
                    continue
    except Exception:
        return


def takeover_check() -> None:
    if not SIDECAR:
        return
    events: list[dict] = []
    stop = threading.Event()
    thread = threading.Thread(target=collect_sse, args=(events, stop), daemon=True)
    thread.start()
    time.sleep(1.5)
    low = http_json(f"{SIDECAR}/intention", {
        "priority": 2, "origin": "debug",
        "steps": [{"skill": "roam", "args": {"radius": 24, "stops": 6}, "on_fail": "abort"}],
    }, timeout=10)
    time.sleep(1.5)
    high = http_json(f"{SIDECAR}/intention", {
        "priority": 8, "origin": "debug",
        "steps": [{"skill": "goto", "args": {"x": 400, "y": 70, "z": 400, "range": 2}, "on_fail": "abort"}],
    }, timeout=10)
    deadline = time.time() + 15
    preempt = None
    while time.time() < deadline:
        preempt = next((e for e in events if e.get("type") == "preempt"
                        and e.get("by") == high.get("intention_id")), None)
        if preempt:
            break
        time.sleep(0.3)
    stop.set()
    check("低优先级行动被高优先级指令立刻抢占", bool(preempt), {"low": low, "high": high, "events": len(events)})
    if high.get("intention_id"):
        try:
            http_json(f"{SIDECAR}/cancel", {"intention_id": high["intention_id"], "reason": "test_cleanup"}, timeout=10)
        except Exception:
            pass


takeover_check()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
