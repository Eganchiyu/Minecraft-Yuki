"""planner/look.py —— 「看一眼」：抓一帧，把原图交给 L1。

和 P5 的自动截图（心情好的时候自己拍一张，只留一段文字摘要）不同，这是**按需**的眼睛：
L1 用 `look` 工具、或 L2 规划出 `snapshot` 技能时调用，抓到的图会作为图片消息进 L1 的上下文，
她自己看得见，不需要视觉模型替她转述。

抓帧与画面可用性检查全部复用 snapshot.SnapshotScheduler.capture()——
那里已经有 ffmpeg x11grab、黑屏/单色判废与保留上限，别在这里重写一份。
"""
import base64
import logging
from pathlib import Path

log = logging.getLogger("look")


def data_url(path) -> str:
    """图片 → data URL（OpenAI 兼容端点的 image_url 格式）。"""
    raw = Path(str(path)).read_bytes()
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


class Looker:
    def __init__(self, snapshots, opts: dict | None = None) -> None:
        self.snapshots = snapshots
        self.opts = dict(opts or {})
        self.stats = {"asked": 0, "ok": 0, "failed": 0, "skipped": 0}

    def enabled(self) -> bool:
        return bool(self.opts.get("enabled", True))

    def attachable(self, path) -> tuple[bool, str]:
        """这张图能不能直接塞进 L1 的上下文：开关、存在性、体积。"""
        if not self.opts.get("show_image", True):
            return False, "image_disabled"
        if not path:
            return False, "no_path"
        file = Path(str(path))
        if not file.exists():
            return False, "image_missing"
        limit = int(self.opts.get("max_image_bytes") or 4 * 1024 * 1024)
        if file.stat().st_size > limit:
            return False, f"image_too_big:{file.stat().st_size}"
        return True, ""

    async def see(self, reason: str = "", hint: str = "", look_at: dict | None = None) -> dict:
        """抓一张。不调视觉模型——原图直接给 L1，转述是她自己的事。"""
        if not self.enabled():
            self.stats["skipped"] += 1
            return {"ok": False, "error": "disabled"}
        self.stats["asked"] += 1
        shot = await self.snapshots.capture("look", hint or reason, look_at)
        if not shot.get("ok"):
            self.stats["failed"] += 1
            log.info("look_failed reason=%s error=%s", (reason or "")[:40], shot.get("error"))
            return shot
        self.stats["ok"] += 1
        log.info("look_ok path=%s reason=%s", shot.get("path"), (reason or "")[:40])
        return shot

    def snapshot(self) -> dict:
        return {
            "enabled": self.enabled(),
            "show_image": bool(self.opts.get("show_image", True)),
            "stats": dict(self.stats),
        }
