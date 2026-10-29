# planner/history.py —— 对话持久化：进程重启后接着上次的话说。
#
# 照搬 Yuki 的 core/history_manager.py 的形态（全量落盘 + tmp + os.replace 原子替换，
# 读坏了就当空历史，绝不让脏文件把进程带崩），但不做多会话字典——这里一个世界一个文件。
#
# 谁写：mind 每轮 `_remember()` 之后 save()。
# 谁读：mind 启动时 load()，注入 prompt 时仍只取最近 HISTORY_KEEP*2 条（窗口在 mind 里）。
import json
from pathlib import Path


class HistoryStore:
    def __init__(self, path, max_entries: int = 400) -> None:
        self.path = Path(path)
        self.max_entries = max(10, int(max_entries))
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def load(self) -> list[dict]:
        """读历史；任何异常都降级成空列表（宁可没记忆，不能起不来）。"""
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        if not isinstance(data, list):
            return []
        out = []
        for item in data:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = item.get("content")
            if role not in {"user", "assistant"} or not isinstance(content, str) or not content:
                continue
            message = {"role": role, "content": content}
            if isinstance(item.get("time"), str):
                message["time"] = item["time"]
            out.append(message)
        return out[-self.max_entries:]

    def save(self, messages: list[dict]) -> None:
        """原子替换；写失败只影响下次启动的连续性，不影响当前对话。"""
        payload = [
            message
            for message in messages[-self.max_entries:]
            if isinstance(message, dict) and message.get("role") in {"user", "assistant"} and message.get("content")
        ]
        tmp = Path(f"{self.path}.tmp")
        try:
            tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            try:
                tmp.unlink()
            except OSError:
                pass
