# planner/memory.py —— 世界记忆：日记/事件落 JSONL（唯一真相），向量索引是可重建的加速层。
#
# 召回算法照搬 Yuki 的 modules/memory/rag.py：
#   · 双池召回——向量池「宽进」（语义近的都捞回来），关键词池「打捞」（jieba 词权覆盖率当保底分，
#     避免只命中「今天」这类虚词的老日记挤掉真正相关的回忆）
#   · 重排——关键词命中按词权加成、时间按指数半衰期衰减（有下限，老回忆不会掉光）
#   · 严出——融合后按分排序，只取 top-n 注入上下文
# 没照搬的：跨群聊加成（这里一个世界一个库，注入天然只来自当前世界）。
#
# 为什么不照搬「chroma 当唯一存储」：JSONL 能 grep、能手工修、坏了不丢数据。
# 索引落后（换了 embedding 模型、库被删）时 warmup 自动补齐；缺依赖就退化纯关键词召回。
import json
import threading
import time
import zlib
from pathlib import Path

# 关键词池里只命中这些词的日记不该抢占召回名额（沿用 Yuki 的停用词，补几条 MC 场景的）
KEYWORD_STOPWORDS = {
    "今天", "今年", "现在", "刚才", "最近", "以后", "以前", "时候", "时间",
    "什么", "怎么", "为什么", "多少", "哪里", "这个", "那个", "这样", "那样",
    "一下", "一点", "有点", "一些", "一个", "一起", "一样", "一直", "一定",
    "要不", "不要", "不用", "不会", "不能", "不是", "是不是", "要不要", "可以", "可能",
    "应该", "需要", "还是", "就是", "但是", "然后", "所以", "因为", "如果", "虽然",
    "已经", "自己", "大家", "我们", "你们", "他们", "她们", "人家",
    "知道", "觉得", "感觉", "看到", "听到", "东西", "事情", "问题", "样子",
    # MC 场景：人人都会说的词不该决定召回
    "主人", "哥哥", "yuki", "这里", "那里", "那边", "这边", "一会儿",
}

# 重排参数：加成都是「相对语义分」的比例提升，避免任何单一维度绝对压制
KEYWORD_RELATIVE_BOOST = 0.50
KEYWORD_RELATIVE_BOOST_CAP = 0.30
KIND_BOOST = {"diary": 0.05}


def _safe_float(value, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class MemoryStore:
    def __init__(
        self,
        path,
        vector_path=None,
        embed_model=None,
        vector: bool = True,
        keep: int = 600,
        pool: int = 24,
        inject: int = 3,
        half_life_days: float = 60.0,
        recency_floor: float = 0.55,
    ) -> None:
        self.path = Path(path)
        self.vector_path = Path(vector_path) if vector_path else None
        self.embed_model = str(embed_model or "")
        self.vector_enabled = bool(vector) and self.vector_path is not None and bool(self.embed_model)
        self.keep = max(50, int(keep))
        self.pool = max(6, int(pool))
        self.inject = max(1, int(inject))
        self.half_life_days = max(1.0, float(half_life_days))
        self.recency_floor = min(1.0, max(0.0, float(recency_floor)))
        self.notes: list[str] = []          # 降级/异常只记几条，别每轮刷日志

        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._entries: list[dict] = self._load()
        self._trim_file()

        self._index = None                  # _VectorIndex 或 None（未就绪/不可用）
        self._index_lock = threading.Lock()

    # ================= 索引（可失败降级） =================
    def warmup(self) -> bool:
        """建/补齐向量索引。返回是否可用；不可用就一直是纯关键词召回。"""
        if not self.vector_enabled:
            return False
        index = self._ensure_index()
        if index is None:
            return False
        return index.sync(self._entries)

    def _ensure_index(self):
        if not self.vector_enabled:
            return None
        with self._index_lock:
            if self._index is not None:
                return self._index if self._index.ok else None
            index = _VectorIndex(self.vector_path, self.embed_model)
            try:
                index.open()
            except Exception as exc:  # 缺依赖 / 模型路径不对 / 磁盘问题
                self._note(f"向量索引不可用（{type(exc).__name__}: {exc}），退化纯关键词召回")
                self.vector_enabled = False
                return None
            self._index = index
            return index

    def _note(self, message: str) -> None:
        self.notes.append(message)
        del self.notes[:-8]

    # ================= JSONL 读写 =================
    def _load(self) -> list[dict]:
        if not self.path.exists():
            return []
        out: list[dict] = []
        try:
            for line in self.path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict) and item.get("text"):
                    out.append(item)
        except OSError:
            return []
        return out[-self.keep:]

    def _trim_file(self) -> None:
        """超过上限就重写文件，避免无限膨胀。"""
        try:
            if not self.path.exists():
                return
            if len(self.path.read_text(encoding="utf-8").splitlines()) <= self.keep:
                return
        except OSError:
            return
        self._write_all()

    def _write_all(self) -> None:
        lines = [json.dumps(item, ensure_ascii=False) for item in self._entries]
        tmp = self.path.with_suffix(".jsonl.tmp")
        try:
            tmp.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            pass

    def add(self, kind: str, text: str, **extra) -> dict | None:
        text = " ".join(str(text or "").split()).strip()[:400]
        if not text:
            return None
        now = int(time.time())
        # 近似去重：同一天同一句话只留一条（Yuki 的 24h 去重）
        day = time.strftime("%Y-%m-%d", time.localtime(now))
        for old in reversed(self._entries[-40:]):
            if old.get("text") != text:
                continue
            if time.strftime("%Y-%m-%d", time.localtime(int(old.get("ts") or 0))) == day:
                return None
            break
        entry = {
            "id": self._entry_id(now, text),
            "ts": now,
            "at": time.strftime("%m-%d %H:%M", time.localtime(now)),
            "kind": str(kind or "diary")[:16],
            "text": text,
        }
        for key, value in extra.items():
            if isinstance(value, (str, int, float, bool)) and value not in (None, ""):
                entry[key] = value
        self._entries.append(entry)
        if len(self._entries) > self.keep:
            del self._entries[: len(self._entries) - self.keep]
        try:
            with self.path.open("a", encoding="utf-8") as fp:
                fp.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            pass
        if self._index is not None and self._index.ok:
            try:
                self._index.add([entry])
            except Exception as exc:
                self._note(f"索引写入失败（{exc}），下次 warmup 补齐")
        return entry

    @staticmethod
    def _entry_id(ts: int, text: str) -> str:
        return f"{int(ts)}-{zlib.crc32(str(text).encode('utf-8')) & 0xFFFFFFFF:08x}"

    # ================= 检索 =================
    def recent(self, n: int = 5) -> list[dict]:
        return self._entries[-max(1, n):]

    def recall(self, query: str, n: int | None = None, now: float | None = None) -> list[dict]:
        """双池召回 + 重排，返回可直接注入的条目（含 score/debug，方便 /trace 排查）。"""
        n = max(1, int(n or self.inject))
        if not self._entries:
            return []
        query = str(query or "").strip()
        if not query:
            return self._format(self.recent(n))

        keywords = self._keywords(query)
        kw_sum = sum(weight for _, weight in keywords)
        now = now if now is not None else time.time()

        candidates: dict[str, dict] = {}
        # --- 语义池：宽进 ---
        vector_hits = self._vector_pool(query, max(self.pool, n * 6))
        max_v = max(vector_hits.values(), default=0.0)
        for entry_id, relevance in vector_hits.items():
            entry = self._by_id(entry_id)
            if entry is None:  # 索引里有、JSONL 里没了（被 trim 掉）
                continue
            candidates[entry_id] = {"entry": entry, "base": relevance, "source": "语义池"}

        # --- 关键词池：打捞（在 JSONL 上筛，等价 Yuki 的 $contains） ---
        if keywords:
            for entry in self._entries:
                entry_id = self._id_of(entry)
                if entry_id in candidates:
                    continue
                coverage = _keyword_coverage(str(entry.get("text", "")), keywords, kw_sum)
                if coverage <= 0:
                    continue
                # 没有语义基准时给个中性分，靠词权覆盖率拉开差距
                base = (max_v or 0.6) * coverage
                candidates[entry_id] = {
                    "entry": entry, "base": base, "source": f"关键词(覆盖率{coverage:.2f})",
                }

        # --- 重排 ---
        scored = []
        for item in candidates.values():
            text = str(item["entry"].get("text", ""))
            matched = [word for word, _ in keywords if word in text]
            hit_weight = sum(weight for word, weight in keywords if word in text)
            relevance = min(1.0, max(0.0, _safe_float(item["base"], 0.0)))
            keyword_boost = min(hit_weight * KEYWORD_RELATIVE_BOOST, KEYWORD_RELATIVE_BOOST_CAP) * relevance
            kind_boost = KIND_BOOST.get(str(item["entry"].get("kind") or ""), 0.0) * relevance
            decay = self._recency_decay(item["entry"], now=now)
            score = (relevance + keyword_boost + kind_boost) * decay
            scored.append(
                {
                    "content": text,
                    "kind": item["entry"].get("kind") or "diary",
                    "at": item["entry"].get("at") or "",
                    "ts": int(item["entry"].get("ts") or 0),
                    "score": score,
                    "debug": (
                        f"{item['source']} 语义:{relevance:.2f} + 关键词(+{keyword_boost:.2f})"
                        f" × 衰减:{decay:.2f} = {score:.2f} 匹配:{matched}"
                    ),
                }
            )

        scored.sort(key=lambda item: (item["score"], item["ts"]), reverse=True)
        picked = scored[:n]

        # 两个池都没捞到东西时，至少让她知道最近发生过什么（连续性比精确度重要一点）
        if len(picked) < n:
            seen = {item["content"] for item in picked}
            for entry in reversed(self._entries):
                if len(picked) >= n:
                    break
                text = str(entry.get("text", ""))
                if not text or text in seen:
                    continue
                seen.add(text)
                picked.append(
                    {
                        "content": text,
                        "kind": entry.get("kind") or "diary",
                        "at": entry.get("at") or "",
                        "ts": int(entry.get("ts") or 0),
                        "score": 0.0,
                        "debug": "兜底:最近",
                    }
                )
        picked.sort(key=lambda item: item["ts"])
        return picked

    def _format(self, entries: list[dict]) -> list[dict]:
        return [
            {
                "content": str(entry.get("text", "")),
                "kind": entry.get("kind") or "diary",
                "at": entry.get("at") or "",
                "ts": int(entry.get("ts") or 0),
                "score": 0.0,
                "debug": "最近",
            }
            for entry in entries
        ]

    def _id_of(self, entry: dict) -> str:
        entry_id = str(entry.get("id") or "").strip()
        return entry_id or self._entry_id(int(entry.get("ts") or 0), str(entry.get("text") or ""))

    def _by_id(self, entry_id: str) -> dict | None:
        for entry in reversed(self._entries):
            if self._id_of(entry) == entry_id:
                return entry
        return None

    def _vector_pool(self, query: str, n: int) -> dict[str, float]:
        index = self._ensure_index()
        if index is None or not index.ok:
            return {}
        try:
            return index.query(query, n)
        except Exception as exc:
            self._note(f"语义检索失败（{exc}），本轮走关键词")
            return {}

    def _recency_decay(self, entry: dict, now: float | None = None) -> float:
        ts = _safe_float(entry.get("ts"), 0.0)
        if ts <= 0:
            return 1.0
        now = now if now is not None else time.time()
        age_days = max(0.0, (now - ts) / 86400.0)
        decay = self.recency_floor + (1.0 - self.recency_floor) * 0.5 ** (age_days / self.half_life_days)
        return max(self.recency_floor, min(1.0, decay))

    # ================= 关键词 =================
    @staticmethod
    def _keywords(query: str) -> list[tuple[str, float]]:
        """jieba 词权；jieba 不在就用二元组兜底（不能因为缺包就召不回）。"""
        text = str(query or "").strip()
        if not text:
            return []
        try:
            import jieba.analyse

            raw = jieba.analyse.extract_tags(text, topK=6, withWeight=True)
        except Exception:
            return [(gram, 1.0) for gram in sorted(_bigrams(text))[:8]]
        keywords = [
            (word, float(weight))
            for word, weight in raw
            if len(word) > 1 and word.lower() not in KEYWORD_STOPWORDS
        ]
        return keywords or [(gram, 1.0) for gram in sorted(_bigrams(text))[:8]]

    def count(self) -> int:
        return len(self._entries)


def _keyword_coverage(text: str, keywords: list[tuple[str, float]], keyword_weight_sum: float) -> float:
    """命中词权 / 全部锚点词权，取值 0~1。"""
    if not keywords or keyword_weight_sum <= 0:
        return 0.0
    hit = sum(weight for word, weight in keywords if word in text)
    return max(0.0, min(1.0, hit / keyword_weight_sum))


def _bigrams(text: str) -> set[str]:
    clean = "".join(ch for ch in str(text) if ch.isalnum())
    return {clean[i: i + 2] for i in range(len(clean) - 1)}


class _VectorIndex:
    """chroma 持久化索引；embedding 用 sentence-transformers，全部懒加载（torch import 要好几秒）。"""

    def __init__(self, path, model_path: str) -> None:
        self.path = Path(path)
        self.model_path = str(model_path)
        self.ok = False
        self._model = None
        self._collection = None
        self._lock = threading.Lock()

    def open(self) -> None:
        import chromadb
        from sentence_transformers import SentenceTransformer

        self.path.mkdir(parents=True, exist_ok=True)
        self._model = SentenceTransformer(self.model_path)
        client = chromadb.PersistentClient(path=str(self.path))
        self._collection = client.get_or_create_collection(
            name="memories", metadata={"hnsw:space": "cosine"}
        )
        self.ok = True

    def add(self, entries: list[dict]) -> None:
        rows = [entry for entry in entries if entry.get("text")]
        if not rows:
            return
        vectors = self._encode([str(entry["text"]) for entry in rows])
        with self._lock:
            self._collection.add(
                ids=[self._id(entry) for entry in rows],
                documents=[str(entry["text"]) for entry in rows],
                embeddings=vectors,
                metadatas=[
                    {"kind": str(entry.get("kind") or "diary"), "ts": int(entry.get("ts") or 0)}
                    for entry in rows
                ],
            )

    def sync(self, entries: list[dict]) -> bool:
        """把索引对齐到 JSONL：缺的补、多的删。重启/换模型后靠这个自愈。"""
        try:
            with self._lock:
                existing = set(self._collection.get(include=[])["ids"])
            wanted: dict[str, dict] = {}
            for entry in entries:
                if entry.get("text"):
                    wanted[self._id(entry)] = entry
            to_add = [entry for entry_id, entry in wanted.items() if entry_id not in existing]
            to_delete = [entry_id for entry_id in existing if entry_id not in wanted]
            if to_delete:
                with self._lock:
                    self._collection.delete(ids=to_delete)
            if to_add:
                self.add(to_add)
            return True
        except Exception:
            return False

    def query(self, text: str, n: int) -> dict[str, float]:
        vector = self._encode([text])[0]
        with self._lock:
            result = self._collection.query(
                query_embeddings=[vector], n_results=max(1, int(n)), include=["distances"]
            )
        ids = (result.get("ids") or [[]])[0]
        distances = (result.get("distances") or [[]])[0]
        return {entry_id: max(0.0, 1.0 - float(distance)) for entry_id, distance in zip(ids, distances)}

    def _encode(self, texts: list[str]) -> list[list[float]]:
        vectors = self._model.encode(texts)
        return [list(map(float, vector)) for vector in vectors]

    @staticmethod
    def _id(entry: dict) -> str:
        entry_id = str(entry.get("id") or "").strip()
        return entry_id or MemoryStore._entry_id(int(entry.get("ts") or 0), str(entry.get("text") or ""))


def format_notes(entries: list[dict]) -> str:
    if not entries:
        return "（还没什么可回忆的）"
    lines = [f"· {item.get('at', '')} {item.get('text', '')}" for item in entries if item.get("text")]
    return "\n".join(lines) if lines else "（还没什么可回忆的）"
