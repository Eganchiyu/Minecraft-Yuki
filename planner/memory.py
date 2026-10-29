# planner/memory.py —— L1 的「小本本」：做了什么、发生过什么，落成 JSONL，按需要取用。
# 参考 Yuki 的日记形态（rag.save_diary），但独立实现：不依赖那个仓库，也不做向量检索。
# 上下文策略：只留最近几轮在 prompt 里，更早的压成一条日记写进来，靠 recall 按需翻出来。
import json
import time
from pathlib import Path


class MemoryStore:
    def __init__(self, path, keep: int = 600) -> None:
        self.path = Path(path)
        self.keep = max(50, int(keep))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._entries: list[dict] = self._load()
        self._trim_file()

    # ---------- 读写 ----------
    def _load(self) -> list[dict]:
        if not self.path.exists():
            return []
        out = []
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
            if self.path.exists() and len(self.path.read_text(encoding="utf-8").splitlines()) <= self.keep:
                return
        except OSError:
            return
        lines = [json.dumps(item, ensure_ascii=False) for item in self._entries]
        try:
            self.path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
        except OSError:
            pass

    def add(self, kind: str, text: str) -> dict | None:
        text = " ".join(str(text or "").split()).strip()[:400]
        if not text:
            return None
        entry = {"ts": int(time.time()), "at": time.strftime("%m-%d %H:%M"), "kind": kind, "text": text}
        self._entries.append(entry)
        if len(self._entries) > self.keep:
            del self._entries[: len(self._entries) - self.keep]
        try:
            with self.path.open("a", encoding="utf-8") as fp:
                fp.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            pass
        return entry

    # ---------- 检索 ----------
    def recent(self, n: int = 5) -> list[dict]:
        return self._entries[-max(1, n):]

    def recall(self, query: str, n: int = 4) -> list[dict]:
        """简单的字面召回：按二元组重合度打分，取最近 + 最相关，去重后按时间排。"""
        query = str(query or "").strip()
        picked: list[dict] = []
        seen: set[int] = set()
        if not query:
            return self.recent(n)
        grams = _bigrams(query)
        scored = []
        for index, entry in enumerate(self._entries):
            text = entry.get("text", "")
            if not text:
                continue
            score = len(grams & _bigrams(text))
            if score:
                scored.append((score, index))
        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        for _, index in scored[: max(0, n - 2)]:
            if index not in seen:
                seen.add(index)
                picked.append(self._entries[index])
        for index in range(len(self._entries) - 1, -1, -1):
            if len(picked) >= n:
                break
            if index not in seen:
                seen.add(index)
                picked.append(self._entries[index])
        picked.sort(key=lambda entry: entry.get("ts", 0))
        return picked[-n:]

    def count(self) -> int:
        return len(self._entries)


def _bigrams(text: str) -> set[str]:
    clean = "".join(ch for ch in str(text) if ch.isalnum())
    return {clean[i : i + 2] for i in range(len(clean) - 1)}


def format_notes(entries: list[dict]) -> str:
    if not entries:
        return "（还没什么可回忆的）"
    lines = [f"· {item.get('at', '')} {item.get('text', '')}" for item in entries if item.get("text")]
    return "\n".join(lines) if lines else "（还没什么可回忆的）"
