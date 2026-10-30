# planner/attention.py —— P4.3 记忆辅助的自适应注意力（Memory-Guided Adaptive Attention）。
#
# 这里回答的问题不是「这条候选够不够分数线」，而是「结合她的记忆、兴趣和此刻状态，
# 这件事值不值得让她注意」。三档决策分开：
#   record   全收（只记账，不打扰）
#   wake     值得打扰：A(c) ≥ floor 且本批 top-k 且过了全局 120 秒闸门
#   snapshot 需要看一眼才知道：V(c) 高 + 有视觉问题（P4.0 没验之前恒不选）
#
# P4.3 先以 Shadow 验过一轮；P4.4 起 decision=wake 会真的叫醒 L1（config.ATTENTION.wake_enabled）。
# Snapshot 仍要等 P4.0 截图链路验过才开。兴趣模型只读不写（决策 #55）：证据先留在 reason 里。
import asyncio
import json
import logging
import math
import time
from pathlib import Path

import config

log = logging.getLogger("attention")

KIND_IMPORTANCE = {
    "task_milestone": 0.85,
    "construction_candidate": 0.55,
    "new_entity": 0.45,
    "landmark_arrival": 0.40,
}
HOSTILE_CATEGORIES = {"hostile", "monster"}
WAKE_KINDS = ("wake", "snapshot")


def _clamp(value, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, float(value)))


def _safe_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# ================= 纯函数：候选 → 证据 =================
def candidate_text(fact: dict) -> str:
    """把事实行拼成一段可召回的中文 query；不写语义断言，只堆事实词。"""
    detail = fact.get("detail") if isinstance(fact.get("detail"), dict) else {}
    kind = str(fact.get("kind") or "")
    parts: list[str] = []
    if kind == "new_entity":
        parts.append(f"附近出现了{detail.get('entity_name') or '一个生物'}")
        if detail.get("category"):
            parts.append(str(detail["category"]))
    elif kind == "construction_candidate":
        names = detail.get("block_names") or []
        parts.append("附近有人用方块搭了东西")
        if names:
            parts.append("方块：" + "、".join(str(n) for n in names[:6]))
        if detail.get("block_count"):
            parts.append(f"一共{int(detail['block_count'])}块")
    elif kind == "landmark_arrival":
        parts.append(f"到了一个叫{detail.get('biome') or '陌生'}的地方")
    elif kind == "task_milestone":
        parts.append(str(fact.get("summary") or "做完了一件事"))
        steps = detail.get("steps") or []
        if steps:
            parts.append("步骤：" + "、".join(str(s) for s in steps[:6]))
    if not parts:
        parts.append(str(fact.get("summary") or kind or "发生了什么"))
    return "，".join(parts)[:200]


def short_term_novelty(features: dict, now: float, half_life_s: float = 1800.0) -> float:
    """短期情景新颖度：刚见过就低一点，但次数只做温和惩罚——见过不等于不感兴趣。"""
    seen = (features or {}).get("seen") if isinstance(features, dict) else {}
    seen = seen if isinstance(seen, dict) else {}
    count = int(_safe_float(seen.get("count"), 0))
    last_at = _safe_float(seen.get("last_at"), 0.0) / 1000.0     # 侧车写的是毫秒
    if count <= 0 or last_at <= 0:
        return 1.0
    # 越久没见越陌生；次数只做温和惩罚（见过一百次也不是 0）
    forgotten = 1.0 - 0.5 ** (max(0.0, now - last_at) / max(1.0, half_life_s))
    repetition = 1.0 / (1.0 + math.log1p(count))
    return _clamp(0.5 * forgotten + 0.5 * repetition)


def long_term_novelty(memory_hits: list[dict]) -> float:
    """长期熟悉度：记忆里越像，越不新鲜；没有证据就按全新算。"""
    top = max((_safe_float(hit.get("relevance")) for hit in memory_hits or []), default=0.0)
    return _clamp(1.0 - 0.6 * top)


def novelty_score(short: float, long: float) -> float:
    return _clamp(0.65 * short + 0.35 * long)


def interest_posterior(pos: int = 0, neg: int = 0, sigmas: float = 1.0) -> float:
    """兴趣后验**下界**（Beta(1,1) 先验，mean − 1σ）。

    用下界而不是均值：样本少的新类别不该被老类别永久压住（决策 #47）。
    第一轮还没有回写证据，所以每条都拿同一个先验下界——不假装知道她喜欢什么。
    """
    pos = max(0, int(pos))
    neg = max(0, int(neg))
    alpha = pos + 1.0
    beta = neg + 1.0
    mean = alpha / (alpha + beta)
    variance = alpha * beta / ((alpha + beta) ** 2 * (alpha + beta + 1.0))
    return _clamp(mean - max(0.0, float(sigmas)) * math.sqrt(variance))


def importance_score(fact: dict) -> float:
    """这件事本身有多重：任务完成 > 有人搭东西 > 初遇生物 > 换了个地方。"""
    detail = fact.get("detail") if isinstance(fact.get("detail"), dict) else {}
    kind = str(fact.get("kind") or "")
    base = KIND_IMPORTANCE.get(kind, 0.35)
    if kind == "new_entity":
        if str(detail.get("category") or "") in HOSTILE_CATEGORIES:
            base += 0.12
        distance = _safe_float(detail.get("distance"), 99.0)
        if distance <= 8:
            base += 0.05
    elif kind == "construction_candidate":
        base += min(0.25, _safe_float(detail.get("block_count"), 0) / 60.0)
    elif kind == "task_milestone":
        base += 0.05
    confidence = _safe_float(fact.get("confidence"), 0.5)
    return _clamp(base + 0.10 * _clamp(confidence))


def visual_need(fact: dict) -> float:
    """第一轮只认「明确的视觉问题」：没人知道那堆方块是什么造型。"""
    detail = fact.get("detail") if isinstance(fact.get("detail"), dict) else {}
    if str(fact.get("kind") or "") == "construction_candidate" and detail.get("pattern") == "unknown":
        return 1.0
    return 0.0


def interruption_cost(context: dict, now: float, weights: dict) -> float:
    """此刻打断她的代价：在干活/在睡/刚说过话，都更贵。"""
    context = context or {}
    raw = 0.0
    if context.get("busy"):
        raw = max(raw, 1.0)
    if str(context.get("mode") or "play") == "rest":
        raw = max(raw, 0.7)
    last_say = _safe_float(context.get("last_say_at"), 0.0)
    if last_say > 0 and now - last_say < 60:
        raw = max(raw, 0.4)
    return _clamp(raw * _safe_float(weights.get("interruption"), 0.35), 0.0, 0.5)


def attention_value(parts: dict, weights: dict) -> float:
    base = (
        _safe_float(weights.get("novelty"), 0.0) * _safe_float(parts.get("novelty"), 0.0)
        + _safe_float(weights.get("importance"), 0.0) * _safe_float(parts.get("importance"), 0.0)
        + _safe_float(weights.get("interest"), 0.0) * _safe_float(parts.get("interest"), 0.0)
        + _safe_float(weights.get("memory"), 0.0) * _safe_float(parts.get("memory_support"), 0.0)
    )
    return _clamp(base - _safe_float(parts.get("interruption"), 0.0))


def score_candidate(
    fact: dict,
    memory_hits: list[dict],
    context: dict,
    now: float,
    opts: dict,
) -> dict:
    """一条候选的全部数值证据。纯函数：同样的输入永远同样的分数。"""
    features = fact.get("features") if isinstance(fact.get("features"), dict) else {}
    short = short_term_novelty(features, now, _safe_float(opts.get("short_half_life_s"), 1800.0))
    long = long_term_novelty(memory_hits)
    novelty = novelty_score(short, long)
    interest = interest_posterior(0, 0)          # 第一轮只读：还没有回写的证据
    importance = importance_score(fact)
    memory_support = max((_safe_float(hit.get("score")) for hit in memory_hits or []), default=0.0)
    visual = visual_need(fact)
    weights = opts.get("weights") or {}
    interruption = interruption_cost(context, now, weights)
    parts = {
        "novelty": novelty,
        "short": short,
        "long": long,
        "interest": interest,
        "importance": importance,
        "memory_support": memory_support,
        "visual_need": visual,
        "interruption": interruption,
    }
    parts["attention"] = attention_value(parts, weights)
    return parts


def select_batch(
    scored: list[dict],
    now: float,
    opts: dict,
    last_wake_at: float = 0.0,
) -> list[dict]:
    """窗口内排序：A 最高的 top-k 才 wake，其余一律 record（不丢、不补发）。"""
    floor = _safe_float(opts.get("floor"), 0.55)
    top_k = max(1, int(opts.get("top_k") or 1))
    gap = _safe_float(opts.get("wake_gap_s"), 120.0)
    snapshot_ok = bool(opts.get("snapshot_enabled", False))
    gate_open = now - _safe_float(last_wake_at, 0.0) >= gap

    ordered = sorted(scored, key=lambda item: item["scores"]["attention"], reverse=True)
    wakes_left = top_k if gate_open else 0
    out: list[dict] = []
    for item in ordered:
        scores = item["scores"]
        value = scores["attention"]
        eligible = value >= floor
        decision = "record"
        reason = "below_floor" if not eligible else "outranked"
        if eligible and wakes_left > 0:
            if snapshot_ok and scores.get("visual_need", 0.0) >= 0.6:
                decision = "snapshot"
                reason = "attention+visual_gap"
            else:
                decision = "wake"
                reason = "top_k"
            wakes_left -= 1
        elif eligible and not gate_open:
            reason = "wake_gate_120s"
        item = dict(item)
        item["decision"] = decision
        item["reason"] = (
            f"{reason};fact={item.get('kind')};"
            f"A={value:.2f};floor={floor:.2f};evidence:none(shadow)"
        )
        out.append(item)
    return out


# ================= 引擎：读事实行 → 打分 → 写 decision =================
class AttentionEngine:
    def __init__(
        self,
        memory,
        facts_path,
        decisions_path,
        opts: dict | None = None,
        now=time.time,
    ) -> None:
        self.memory = memory
        self.facts_path = Path(facts_path)
        self.decisions_path = Path(decisions_path)
        self.opts = dict(opts or config.ATTENTION)
        self.now = now
        self._last_batch_at = 0.0
        self.stats = {
            "batches": 0, "facts": 0, "scored": 0,
            "record": 0, "wake": 0, "snapshot": 0, "errors": 0,
        }

    # ---------- 读侧 ----------
    @staticmethod
    def _read_rows(path: Path) -> list[dict]:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return []
        rows: list[dict] = []
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

    def facts(self, now: float | None = None) -> dict[str, dict]:
        """同 id 取最后一行（同一处继续搭会以同一 id 追加更新后的规模）。"""
        now = now if now is not None else self.now()
        max_age = _safe_float(self.opts.get("max_fact_age_s"), 12 * 3600.0) * 1000.0
        latest: dict[str, dict] = {}
        for row in self._read_rows(self.facts_path):
            fact_id = str(row.get("id") or "")
            if not fact_id:
                continue
            at_ms = _safe_float(row.get("at"), 0.0)
            if max_age > 0 and at_ms > 0 and now * 1000.0 - at_ms > max_age:
                continue
            latest[fact_id] = row
        return latest

    def decided(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for row in self._read_rows(self.decisions_path):
            cid = str(row.get("candidate_id") or "")
            if cid:
                out[cid] = row
        return out

    def last_wake_at(self) -> float:
        last = 0.0
        for row in self._read_rows(self.decisions_path):
            if str(row.get("decision") or "") in WAKE_KINDS:
                last = max(last, _safe_float(row.get("at"), 0.0) / 1000.0)
        return last

    def pending(self, now: float | None = None) -> list[dict]:
        decided = self.decided()
        items = [fact for fact_id, fact in self.facts(now).items() if fact_id not in decided]
        limit = max(1, int(self.opts.get("max_batch") or 200))
        return items[-limit:]

    # ---------- 打分 ----------
    def _score_sync(self, facts: list[dict], context: dict, now: float) -> list[dict]:
        queries = [candidate_text(fact) for fact in facts]
        hits: list[list[dict]] = []
        if self.memory is not None and facts:
            try:
                hits = self.memory.recall_scored_many(
                    queries, n=int(self.opts.get("recall_n") or 5), now=now
                )
            except Exception as exc:
                log.warning("attention_recall_failed error=%s", exc)
                hits = []
        while len(hits) < len(facts):
            hits.append([])

        scored: list[dict] = []
        for fact, memory_hits in zip(facts, hits):
            scores = score_candidate(fact, memory_hits, context, now, self.opts)
            scored.append(
                {
                    "candidate_id": fact["id"],
                    "fact_id": fact["id"],
                    "kind": fact.get("kind"),
                    "subject": fact.get("subject"),
                    "at": int(now * 1000),
                    "scores": {
                        key: round(value, 4)
                        for key, value in scores.items()
                    },
                    "memory_matches": [str(hit.get("id")) for hit in memory_hits[:5]],
                }
            )
        return scored

    def _append(self, rows: list[dict]) -> None:
        if not rows:
            return
        self.decisions_path.parent.mkdir(parents=True, exist_ok=True)
        with self.decisions_path.open("a", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    async def tick(self, context: dict | None = None, now: float | None = None) -> dict:
        """每 batch_s 跑一批；积压允许存在，算完一次写一批 decision。"""
        now = now if now is not None else self.now()
        if not self.opts.get("enabled", True):
            return {"ok": False, "reason": "disabled"}
        batch_s = _safe_float(self.opts.get("batch_s"), 60.0)
        if self._last_batch_at and now - self._last_batch_at < batch_s:
            return {"ok": True, "skipped": "batch_wait", "pending": len(self.pending(now))}

        facts = self.pending(now)
        if not facts:
            self._last_batch_at = now
            return {"ok": True, "scored": 0, "pending": 0}

        try:
            scored = await asyncio.to_thread(self._score_sync, facts, context or {}, now)
        except Exception as exc:
            self.stats["errors"] += 1
            log.warning("attention_score_failed error=%s", exc)
            return {"ok": False, "error": str(exc)}

        decisions = select_batch(scored, now, self.opts, self.last_wake_at())
        shadow = not bool(self.opts.get("wake_enabled", True))
        for row in decisions:
            self.stats[row["decision"]] += 1
            row["shadow"] = shadow
        self._append(decisions)

        self.stats["batches"] += 1
        self.stats["facts"] += len(facts)
        self.stats["scored"] += len(decisions)
        self._last_batch_at = now
        wakes = [row for row in decisions if row["decision"] in WAKE_KINDS]
        log.info(
            "attention_batch facts=%d decisions=%d wake=%d pending=%d",
            len(facts), len(decisions), len(wakes), len(self.pending(now)),
        )
        return {
            "ok": True,
            "facts": len(facts),
            "scored": len(decisions),
            "wake": [row["candidate_id"] for row in wakes],
            "decisions": decisions,
        }

    def downgrade(self, row: dict, reason: str, now: float | None = None) -> dict:
        """本该 wake，但此刻不能打扰（在干活/在睡/闸门没开）：补一条 record 覆盖它。

        decisions 是 append-only，读侧按 candidate_id 取最后一行，所以补记一行就等于降级；
        候选不会留在 pending 里反复触发，也不会被静默吞掉。
        """
        now = now if now is not None else self.now()
        patched = {
            **row,
            "at": int(now * 1000),
            "decision": "record",
            "reason": f"{reason};was={row.get('decision')};{str(row.get('reason') or '')}",
        }
        self.stats["record"] += 1
        if row.get("decision") in self.stats:
            self.stats[row["decision"]] = max(0, self.stats[row["decision"]] - 1)
        self._append([patched])
        log.info("attention_downgrade id=%s reason=%s", row.get("candidate_id"), reason)
        return patched

    def snapshot(self) -> dict:
        return {
            "enabled": bool(self.opts.get("enabled", True)),
            "wake_enabled": bool(self.opts.get("wake_enabled", True)),
            "shadow": not bool(self.opts.get("wake_enabled", True)),
            "floor": self.opts.get("floor"),
            "top_k": self.opts.get("top_k"),
            "wake_gap_s": self.opts.get("wake_gap_s"),
            "batch_s": self.opts.get("batch_s"),
            "snapshot_enabled": bool(self.opts.get("snapshot_enabled", False)),
            "last_batch_at": self._last_batch_at,
            "last_wake_at": self.last_wake_at(),
            "pending": len(self.pending()),
            "stats": dict(self.stats),
            "facts_path": str(self.facts_path),
            "decisions_path": str(self.decisions_path),
        }
