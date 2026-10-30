# planner/tests/p4_3_live.py —— P4.3 真机验收：侧车事实行 → planner 打分 → decisions.jsonl（Shadow）。
# 由 scripts/p4-3-run.sh 调用；也可以手动指路径：
#   Y4_FACTS=... Y4_DECISIONS=... Y4_PLANNER=http://127.0.0.1:8791 python planner/tests/p4_3_live.py
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

FACTS = Path(os.environ.get("Y4_FACTS", "")).expanduser()
DECISIONS = Path(os.environ.get("Y4_DECISIONS", "")).expanduser()
PLANNER = os.environ.get("Y4_PLANNER", "").rstrip("/")
WAIT_S = float(os.environ.get("Y4_WAIT_S", "90"))

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


def latest_facts(rows: list[dict]) -> dict[str, dict]:
    out = {}
    for row in rows:
        if row.get("id"):
            out[str(row["id"])] = row
    return out


def http_json(path: str) -> dict:
    with urllib.request.urlopen(f"{PLANNER}{path}", timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---------- 1. 侧车写了事实行 ----------
facts_rows = read_rows(FACTS)
facts = latest_facts(facts_rows)
check("事实行已落盘", len(facts_rows) >= 1, str(FACTS))
check("事实行有稳定 id/kind/subject", facts and all(
    row.get("id") and row.get("kind") and "subject" in row for row in facts.values()))
check("事实行还没打分（salience=null）", facts and all(
    row.get("salience") is None for row in facts.values()), [row.get("salience") for row in facts.values()])
check("事实行都带 features", facts and all(
    isinstance(row.get("features"), dict) for row in facts.values()))
check("事实行是观察者产的", facts and all(
    row.get("source") == "observer" for row in facts.values()))

# ---------- 2. 等 planner 把这批算完 ----------
deadline = time.time() + WAIT_S
decisions: dict[str, dict] = {}
while time.time() < deadline:
    decisions = {str(row.get("candidate_id")): row for row in read_rows(DECISIONS) if row.get("candidate_id")}
    if decisions and all(fid in decisions for fid in facts):
        break
    time.sleep(2)

missing = [fid for fid in facts if fid not in decisions]
check("每一条事实都有 decision", not missing, missing[:5])
check("decision 没有凭空多出的 candidate_id", set(decisions) <= set(facts), list(set(decisions) - set(facts))[:5])

keys = {"candidate_id", "at", "scores", "memory_matches", "decision", "shadow", "reason"}
decision_rows = list(decisions.values())
check("decision 行字段齐全", decision_rows and all(keys <= set(row) for row in decision_rows),
      [sorted(set(row) - keys) for row in decision_rows[:3]])
check("第一轮是 Shadow（不真唤醒、不真截图）", decision_rows and all(
    row.get("shadow") is True for row in decision_rows))
check("decision 三档之一", decision_rows and all(
    row.get("decision") in ("record", "wake", "snapshot") for row in decision_rows),
      [row.get("decision") for row in decision_rows])
score_keys = {"novelty", "short", "long", "interest", "importance", "visual_need", "attention"}
check("分数是数值证据", decision_rows and all(
    score_keys <= set(row.get("scores") or {}) for row in decision_rows),
      [sorted(score_keys - set(row.get("scores") or {})) for row in decision_rows[:3]])
check("A(c) 在 0~1 之间", decision_rows and all(
    0.0 <= float(row["scores"]["attention"]) <= 1.0 for row in decision_rows))
check("reason 写明为什么", decision_rows and all(
    "evidence:none" in str(row.get("reason")) for row in decision_rows),
      [row.get("reason") for row in decision_rows[:2]])

# ---------- 3. 打扰上限：wake 之间至少 120 秒 ----------
wakes = sorted(
    (int(row.get("at") or 0) for row in decision_rows if row.get("decision") in ("wake", "snapshot"))
)
gaps = [later - earlier for earlier, later in zip(wakes, wakes[1:])]
check("wake 全局间隔 ≥120 秒", all(gap >= 120000 for gap in gaps), gaps)
check("snapshot 在 P4.0 验证前不出现", all(
    row.get("decision") != "snapshot" for row in decision_rows))

# ---------- 4. 与 planner 的在线状态一致 ----------
if PLANNER:
    try:
        state = http_json("/state")
        att = state.get("attention") or {}
        check("/state 暴露 attention", att.get("shadow") is True, att)
        check("/state.attention 的 scored 与文件一致",
              int((att.get("stats") or {}).get("scored", -1)) == len(decision_rows),
              {"state": (att.get("stats") or {}).get("scored"), "file": len(decision_rows)})
        api = http_json("/decisions?n=200")
        check("/decisions 返回同一批", int(api.get("total", -1)) == len(decision_rows),
              {"api": api.get("total"), "file": len(decision_rows)})
    except Exception as exc:  # 网络/接口问题单独报，不混进文件检查
        check("/decisions 接口可读", False, str(exc))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
