# planner/tests/test_attention.py —— P4.3 注意力纯单测：证据打分、窗口排序、120 秒闸门、decision 落盘。
# 用法：/home/asumi/miniconda3/envs/yuki/bin/python planner/tests/test_attention.py
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import attention  # noqa: E402
from memory import MemoryStore  # noqa: E402

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
OPTS = {
    "enabled": True,
    "batch_s": 60.0,
    "floor": 0.55,
    "top_k": 1,
    "wake_gap_s": 120.0,
    "short_half_life_s": 1800.0,
    "max_fact_age_s": 3600.0,
    "max_batch": 50,
    "recall_n": 3,
    "weights": {
        "novelty": 0.35, "importance": 0.35, "interest": 0.20,
        "memory": 0.10, "interruption": 0.35,
    },
    "snapshot_enabled": False,
}


def fact(kind="new_entity", fid="c1", subject="mob:sheep", detail=None, features=None, at=None):
    return {
        "id": fid,
        "kind": kind,
        "subject": subject,
        "at": int((at if at is not None else T0) * 1000),
        "summary": "",
        "detail": detail or {},
        "features": features or {},
        "salience": None,
    }


# ---------- 1. 候选 → query 事实词 ----------
check("text: 新实体把名字放进去", "sheep" in attention.candidate_text(
    fact(detail={"entity_name": "sheep", "category": "animal"})))
check("text: 建造写块数与方块名，不断言造型", (
    "白羊毛" in attention.candidate_text(fact(
        kind="construction_candidate",
        detail={"block_names": ["白羊毛", "红花"], "block_count": 18, "pattern": "unknown"}))
    and "18" in attention.candidate_text(fact(
        kind="construction_candidate",
        detail={"block_names": ["白羊毛"], "block_count": 18}))
))
check("text: 地点带生物群系", "beach" in attention.candidate_text(
    fact(kind="landmark_arrival", detail={"biome": "beach"})))
milestone = fact(kind="task_milestone", detail={"steps": ["mine"]})
milestone["summary"] = "挖到 3 块圆石"
check("text: 任务摘要进 query", "挖到 3 块圆石" in attention.candidate_text(milestone))

# ---------- 2. 短期新颖度：次数只做温和惩罚 ----------
check("short: 没见过 = 1", attention.short_term_novelty({}, T0) == 1.0)
seen_once = {"seen": {"count": 1, "last_at": int(T0 * 1000)}}
seen_ten = {"seen": {"count": 10, "last_at": int(T0 * 1000)}}
seen_old = {"seen": {"count": 1, "last_at": int((T0 - 3600) * 1000)}}
s1 = attention.short_term_novelty(seen_once, T0)
s10 = attention.short_term_novelty(seen_ten, T0)
s_old = attention.short_term_novelty(seen_old, T0)
check("short: 刚见过 < 1", 0.0 < s1 < 1.0, s1)
check("short: 见得多更低，但不会归零", 0 < s10 < s1, (s10, s1))
check("short: 很久以前见过会更陌生", s_old > s1, (s_old, s1))

# ---------- 3. 长期新颖度：记忆越像越不新鲜 ----------
check("long: 没记忆 = 1", attention.long_term_novelty([]) == 1.0)
check("long: 很像会压低", attention.long_term_novelty([{"relevance": 1.0}]) == 0.4)
check("long: 只取最高相关", attention.long_term_novelty(
    [{"relevance": 0.2}, {"relevance": 0.9}]) < attention.long_term_novelty([{"relevance": 0.5}]))
check("novelty: 短期权重更高", abs(attention.novelty_score(1.0, 0.0) - 0.65) < 1e-9)

# ---------- 4. 兴趣后验：没有证据就不假装知道 ----------
check("interest: 无证据给先验下界（低于均值 0.5）",
      0.15 < attention.interest_posterior(0, 0) < 0.25, attention.interest_posterior(0, 0))
check("interest: 正证据抬高", attention.interest_posterior(3, 0) > 0.6,
      attention.interest_posterior(3, 0))
check("interest: 负证据压低", attention.interest_posterior(0, 3) < 0.4,
      attention.interest_posterior(0, 3))
check("interest: 下界永远低于均值", all(
    attention.interest_posterior(p, n) < (p + 1) / (p + n + 2)
    for p, n in ((0, 0), (1, 0), (0, 1), (5, 2), (20, 3))))

# ---------- 5. 重要性排序 ----------
animal = attention.importance_score(fact(detail={"category": "animal", "distance": 20}))
hostile = attention.importance_score(fact(detail={"category": "hostile", "distance": 20}))
close = attention.importance_score(fact(detail={"category": "animal", "distance": 3}))
build = attention.importance_score(fact(kind="construction_candidate", detail={"block_count": 18}))
task = attention.importance_score(fact(kind="task_milestone", detail={"steps": ["mine"]}))
landmark = attention.importance_score(fact(kind="landmark_arrival", detail={"biome": "beach"}))
check("importance: 敌对 > 普通", hostile > animal, (hostile, animal))
check("importance: 近处更重", close > animal, (close, animal))
check("importance: 任务 > 建造 > 初遇 > 地点", task > build > animal > landmark,
      (task, build, animal, landmark))
check("importance: 块数越多越重", build > attention.importance_score(
    fact(kind="construction_candidate", detail={"block_count": 3})))
check("importance: 分数在 0~1", all(0 <= v <= 1 for v in (animal, hostile, build, task, landmark)))

# ---------- 6. 视觉需求 ----------
check("visual: 造型未知的建造 = 1", attention.visual_need(
    fact(kind="construction_candidate", detail={"pattern": "unknown"})) == 1.0)
check("visual: 其他 = 0", attention.visual_need(fact()) == 0.0)

# ---------- 7. 打断代价 ----------
idle = attention.interruption_cost({"busy": False, "mode": "play"}, T0, OPTS["weights"])
busy = attention.interruption_cost({"busy": True, "mode": "play"}, T0, OPTS["weights"])
rest = attention.interruption_cost({"busy": False, "mode": "rest"}, T0, OPTS["weights"])
talk = attention.interruption_cost({"busy": False, "last_say_at": T0 - 5}, T0, OPTS["weights"])
check("cost: 忙 > 闲", busy > idle, (busy, idle))
check("cost: 睡着比闲贵", rest > idle, (rest, idle))
check("cost: 刚说过话也贵一点", talk > idle, (talk, idle))
check("cost: 有上限（不能把分数扣成负数）", busy <= 0.5)

# ---------- 8. 一条候选的完整打分 ----------
scored = attention.score_candidate(
    fact(detail={"entity_name": "sheep", "category": "animal", "distance": 5}),
    [{"id": "m1", "relevance": 0.4, "score": 0.3}],
    {"busy": False, "mode": "play"}, T0, OPTS)
check("score: 各维度齐全", set(scored) >= {
    "novelty", "short", "long", "interest", "importance", "visual_need",
    "interruption", "memory_support", "attention"})
check("score: attention 在 0~1", 0.0 <= scored["attention"] <= 1.0, scored)
check("score: 纯函数可复现", eq(scored, attention.score_candidate(
    fact(detail={"entity_name": "sheep", "category": "animal", "distance": 5}),
    [{"id": "m1", "relevance": 0.4, "score": 0.3}],
    {"busy": False, "mode": "play"}, T0, OPTS)))
first_sheep = attention.score_candidate(
    fact(detail={"entity_name": "sheep", "category": "animal", "distance": 5}), [], {}, T0, OPTS)
hundredth = attention.score_candidate(
    fact(detail={"entity_name": "sheep", "category": "animal", "distance": 5}),
    [{"id": "m", "relevance": 0.9, "score": 0.8}],
    {"busy": True}, T0, OPTS)
check("score: 第一只羊比第一百只高", first_sheep["attention"] > hundredth["attention"],
      (first_sheep["attention"], hundredth["attention"]))


# ---------- 9. 窗口内排序 + 闸门 ----------
def item(cid, value, visual=0.0, kind="new_entity"):
    return {"candidate_id": cid, "kind": kind, "subject": "x", "scores": {
        "attention": value, "visual_need": visual}}


rows = attention.select_batch(
    [item("a", 0.90), item("b", 0.70), item("c", 0.30)], T0, OPTS, last_wake_at=0.0)
decisions = {row["candidate_id"]: row["decision"] for row in rows}
check("select: 只有 top-1 唤醒", decisions == {"a": "wake", "b": "record", "c": "record"}, decisions)
check("select: 低于 floor 的标记原因", next(
    row for row in rows if row["candidate_id"] == "c")["reason"].startswith("below_floor"))
check("select: 被挤掉的标记 outranked", next(
    row for row in rows if row["candidate_id"] == "b")["reason"].startswith("outranked"))
check("select: 按 A 降序", [row["candidate_id"] for row in rows] == ["a", "b", "c"])

gated = attention.select_batch([item("a", 0.9), item("b", 0.7)], T0, OPTS, last_wake_at=T0 - 119)
check("gate: 120 秒内不放行", all(row["decision"] == "record" for row in gated), gated)
check("gate: 原因写明闸门", gated[0]["reason"].startswith("wake_gate_120s"))
opened = attention.select_batch([item("a", 0.9)], T0, OPTS, last_wake_at=T0 - 120)
check("gate: 满 120 秒放行", opened[0]["decision"] == "wake")
two = attention.select_batch([item("a", 0.9), item("b", 0.8)], T0, dict(OPTS, top_k=2), 0.0)
check("top_k=2: 放行两条", [row["decision"] for row in two] == ["wake", "wake"])
extra = attention.select_batch([item("a", 0.9), item("b", 0.8)], T0, dict(OPTS, top_k=1), 0.0)
check("top_k=1: 第二条只记录", extra[1]["decision"] == "record")

shot = attention.select_batch(
    [item("a", 0.9, visual=1.0)], T0, dict(OPTS, snapshot_enabled=True), 0.0)
check("snapshot: 开关打开且有视觉问题才选", shot[0]["decision"] == "snapshot", shot)
off = attention.select_batch([item("a", 0.9, visual=1.0)], T0, OPTS, 0.0)
check("snapshot: P4.0 没验之前绝不选", off[0]["decision"] == "wake", off)


# ---------- 10. MemoryStore.recall_scored：只给数字 ----------
tmp_root = Path(tempfile.mkdtemp(prefix="yuki-att-"))
store = MemoryStore(tmp_root / "memory.jsonl", vector=False, keep=50, pool=10, inject=3)
store.add("diary", "在海边看到一只羊，羊毛是白的")
store.add("event", "你掉血了，血量 8")
store.add("diary", "主人教我怎么数石头")
hits = store.recall_scored("海边 羊", n=2, now=time.time())
check("recall_scored: 命中相关的那条", hits and "海边" in store._by_id(hits[0]["id"])["text"], hits)
check("recall_scored: 字段是数值证据", hits and set(hits[0]) == {
    "id", "kind", "ts", "relevance", "keyword_hit", "score"}, hits)
check("recall_scored: 不返回注入用的 content/debug", all(
    "content" not in hit and "debug" not in hit for hit in hits))
check("recall_scored: 批量与单条一致", eq(
    store.recall_scored_many(["石头"], n=2, now=T0)[0],
    store.recall_scored("石头", n=2, now=T0)))
check("recall_scored: 空查询不炸", store.recall_scored("", n=2) == [])


class FakeModel:
    def __init__(self):
        self.calls = []

    def encode(self, texts):
        self.calls.append(list(texts))
        return [[float(len(t)), 1.0] for t in texts]


from memory import _VectorIndex  # noqa: E402

index = _VectorIndex.__new__(_VectorIndex)
index._model = FakeModel()
vectors = index.encode_batch(["猫", "长句子"])
check("encode_batch: 一次编码整批", len(index._model.calls) == 1 and index._model.calls[0] == ["猫", "长句子"])
check("encode_batch: 顺序与输入对齐", eq(vectors, [[1.0, 1.0], [3.0, 1.0]]))


class FakeMemory:
    """按 query 关键字给固定记忆证据，用来单独验证引擎接线。"""

    def __init__(self):
        self.queries = []

    def recall_scored_many(self, queries, n=5, now=None):
        self.queries.extend(queries)
        return [[{"id": "m-sheep", "kind": "diary", "ts": 1, "relevance": 0.5,
                  "keyword_hit": 0.3, "score": 0.4}] for _ in queries]


# ---------- 11. 引擎：事实行去重、已决策跳过、批量间隔、落盘 ----------
import asyncio  # noqa: E402

facts_path = tmp_root / "experiences.jsonl"
decisions_path = tmp_root / "decisions.jsonl"
facts_path.write_text("\n".join([
    json.dumps(fact(fid="a", detail={"entity_name": "sheep", "category": "animal", "distance": 4})),
    json.dumps(fact(fid="a", kind="construction_candidate", subject="cluster:0:0",
                    detail={"block_names": ["白羊毛"], "block_count": 18, "pattern": "unknown"})),
    json.dumps(fact(fid="b", detail={"entity_name": "cow", "category": "animal", "distance": 20})),
    "{坏行",
]) + "\n", encoding="utf-8")
decisions_path.write_text(json.dumps({
    "candidate_id": "b", "at": int((T0 - 500) * 1000), "decision": "record",
}) + "\n", encoding="utf-8")


async def engine_suite():
    fake_memory = FakeMemory()
    engine = attention.AttentionEngine(fake_memory, facts_path, decisions_path,
                                       dict(OPTS, batch_s=0.0), now=lambda: T0)
    pending = engine.pending(T0)
    check("engine: 同 id 取最后一行", [f["id"] for f in pending] == ["a"], [f["id"] for f in pending])
    check("engine: 已决策的跳过", "b" not in [f["id"] for f in pending])
    check("engine: 坏行跳过", len(pending) == 1)

    result = await engine.tick({"busy": False, "mode": "play"}, T0)
    check("engine: 一批算出 decision", result.get("scored") == 1, result)
    row = engine._read_rows(decisions_path)[-1]
    check("engine: decision 带 candidate_id/at/scores", {
        "candidate_id", "at", "scores", "memory_matches", "decision", "shadow", "reason"} <= set(row))
    check("engine: Shadow 恒为 true", row["shadow"] is True)
    check("engine: 记下记忆证据 id", row["memory_matches"] == ["m-sheep"], row["memory_matches"])
    check("engine: 建造候选带视觉需求", row["scores"]["visual_need"] == 1.0, row["scores"])
    check("engine: 决策后不再重复打分", engine.pending(T0) == [])
    check("engine: 已存行没被改写（append-only）", len(engine._read_rows(decisions_path)) == 2)

    # 批量间隔：默认 60 秒内不再算
    slow = attention.AttentionEngine(fake_memory, facts_path, decisions_path,
                                     dict(OPTS, batch_s=60.0), now=lambda: T0)
    facts_path.write_text(json.dumps(fact(fid="d", detail={"entity_name": "pig", "category": "animal"})) + "\n",
                          encoding="utf-8")
    first = await slow.tick({}, T0)
    again = await slow.tick({}, T0 + 30)
    check("batch: 第一次算", first.get("scored") == 1, first)
    check("batch: 60 秒内跳过", again.get("skipped") == "batch_wait", again)

    # 闸门持久化：decision 文件里的 wake 时间参与下一批
    gate_path = tmp_root / "decisions-gate.jsonl"
    gate_path.write_text(json.dumps({
        "candidate_id": "old", "at": int((T0 - 30) * 1000), "decision": "wake",
    }) + "\n", encoding="utf-8")
    gate_facts = tmp_root / "facts-gate.jsonl"
    gate_facts.write_text(json.dumps(fact(fid="n1", detail={
        "entity_name": "sheep", "category": "animal", "distance": 2})) + "\n", encoding="utf-8")
    gate_engine = attention.AttentionEngine(fake_memory, gate_facts, gate_path,
                                            dict(OPTS, batch_s=0.0, floor=0.0), now=lambda: T0)
    gate_result = await gate_engine.tick({}, T0)
    check("gate: 30 秒前的 wake 挡住新 wake", gate_result["wake"] == [], gate_result)

    # 过期事实不再打分
    old_facts = tmp_root / "facts-old.jsonl"
    old_facts.write_text(json.dumps(fact(fid="z", at=T0 - 7200)) + "\n", encoding="utf-8")
    old_engine = attention.AttentionEngine(fake_memory, old_facts, tmp_root / "d-old.jsonl",
                                           dict(OPTS, max_fact_age_s=3600, batch_s=0.0), now=lambda: T0)
    check("engine: 太旧的事实不打分", old_engine.pending(T0) == [])

    # 开关：关掉就什么都不写
    ctx_off = attention.AttentionEngine(fake_memory, gate_facts, tmp_root / "d-off.jsonl",
                                        dict(OPTS, enabled=False), now=lambda: T0)
    off_result = await ctx_off.tick({}, T0)
    check("engine: 关闭时不工作", off_result.get("ok") is False and not (tmp_root / "d-off.jsonl").exists())

    snap = engine.snapshot()
    check("snapshot: 暴露 shadow/floor/统计", snap["shadow"] is True and snap["floor"] == 0.55
          and snap["stats"]["scored"] >= 1, snap)


asyncio.run(engine_suite())

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
