# planner/notes.py —— 结构化的「世界知识」小本本：哪里的箱子有什么、家在哪。
#
# 为什么单独存：这类事实是永久且可覆盖的，跟日记（memory.jsonl）不是一回事。
# 谁写：L3 侧车每次开容器都会上报快照，这里按坐标 upsert —— 再开一次就覆盖，
#       天然解决「上次这里有末影珍珠，现在没了」这种失效问题。
# 谁读：L1 每轮状态行里注入最近几个容器，让她知道自己把东西放哪了。
import json
import time
from pathlib import Path

MAX_PLACES = 80


class NoteStore:
    def __init__(self, path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._places: dict[str, dict] = self._load()

    # ---------- 读写 ----------
    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            places = data.get("places") if isinstance(data, dict) else None
            return dict(places) if isinstance(places, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _save(self) -> None:
        try:
            payload = {"places": self._places}
            self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError:
            pass

    # ---------- 写入 ----------
    def upsert_place(self, at: dict, kind: str, contents: list[dict], action: str = "") -> dict | None:
        """按坐标覆盖一条容器记录；contents 是 [{name,count}]，空数组表示箱子是空的。"""
        if not isinstance(at, dict):
            return None
        try:
            x, y, z = int(at["x"]), int(at["y"]), int(at["z"])
        except (KeyError, TypeError, ValueError):
            return None
        key = f"{x},{y},{z}"
        items = []
        for item in contents or []:
            name = str((item or {}).get("name") or "").strip()
            try:
                count = int((item or {}).get("count") or 0)
            except (TypeError, ValueError):
                count = 0
            if name and count > 0:
                items.append({"name": name, "count": count})
        items.sort(key=lambda entry: (-entry["count"], entry["name"]))
        entry = {
            "x": x,
            "y": y,
            "z": z,
            "kind": str(kind or "container"),
            "contents": items,
            "action": str(action or ""),
            "at": int(time.time()),
            "seen": time.strftime("%m-%d %H:%M"),
        }
        self._places[key] = entry
        if len(self._places) > MAX_PLACES:
            # 只保留最近见过的
            ordered = sorted(self._places.items(), key=lambda kv: kv[1].get("at", 0))
            for old_key, _ in ordered[: len(self._places) - MAX_PLACES]:
                self._places.pop(old_key, None)
        self._save()
        return entry

    def record_from_detail(self, detail: dict) -> int:
        """从 L3 回调的 detail.results[] 里挑出容器快照，写进表里。返回写了几条。"""
        if not isinstance(detail, dict):
            return 0
        rows = detail.get("results") if isinstance(detail.get("results"), list) else []
        written = 0
        for row in rows:
            if not isinstance(row, dict):
                continue
            box = row.get("container")
            if not isinstance(box, dict):
                continue
            entry = self.upsert_place(
                at=box.get("at") or {},
                kind=box.get("kind") or box.get("name") or "container",
                contents=box.get("contents") or [],
                action=str(row.get("skill") or ""),
            )
            if entry:
                written += 1
        return written

    # ---------- 读取 ----------
    def nearby(self, pos: dict | None, limit: int = 2, max_distance: float = 96.0) -> list[dict]:
        entries = list(self._places.values())
        if not entries:
            return []
        if not isinstance(pos, dict) or "x" not in pos:
            entries.sort(key=lambda entry: entry.get("at", 0), reverse=True)
            return entries[:limit]

        def distance(entry: dict) -> float:
            try:
                dx = float(entry.get("x", 0)) - float(pos.get("x", 0))
                dy = float(entry.get("y", 0)) - float(pos.get("y", 0))
                dz = float(entry.get("z", 0)) - float(pos.get("z", 0))
                return (dx * dx + dy * dy + dz * dz) ** 0.5
            except (TypeError, ValueError):
                return 1e9

        within = [entry for entry in entries if distance(entry) <= max_distance]
        within.sort(key=distance)
        return within[:limit]

    def line(self, pos: dict | None, limit: int = 2) -> str:
        """压成一行给状态行用；没有记录就返回空串。"""
        entries = self.nearby(pos, limit=limit)
        if not entries:
            return ""
        parts = []
        for entry in entries:
            where = f"{_kind_label(entry.get('kind'))}({entry.get('x')},{entry.get('y')},{entry.get('z')})"
            parts.append(f"{where}：{_contents_label(entry.get('contents'))}｜{entry.get('seen', '')}")
        return "；".join(parts)

    def count(self) -> int:
        return len(self._places)


def _kind_label(kind: str) -> str:
    return {
        "chest": "箱子",
        "trapped_chest": "陷阱箱",
        "barrel": "木桶",
        "furnace": "熔炉",
        "container": "容器",
    }.get(str(kind or ""), str(kind or "容器"))


def _contents_label(contents: list[dict]) -> str:
    if not contents:
        return "空的"
    shown = [f"{item.get('name')}×{item.get('count')}" for item in contents[:6]]
    if len(contents) > 6:
        shown.append(f"等 {len(contents)} 种")
    return "、".join(shown)
