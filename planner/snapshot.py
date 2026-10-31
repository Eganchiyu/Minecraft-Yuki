# planner/snapshot.py —— P5.1 Snapshot Scheduler：只有值得看、且此刻能看的时候才截一张。
#
# 默认关闭（config.SNAPSHOT.enabled=false）。开了也受四道闸门：
#   1. 最小间隔 min_gap_s（不让截图变成连续录制）
#   2. 每小时配额 per_hour
#   3. 同一事件最多 max_per_event 张
#   4. 建造类候选要等 stable_window_s 静默（别拍半成品）；忙/睡时默认延迟
#
# 截图走 `ffmpeg x11grab` 抓整屏（决策 #3/#4）：无 GPU、不装原生渲染依赖。
# 抓拍在子进程里跑，绝不阻塞 tick、任务与守护；失败就返回 no image，由调用方降级为无图经历。
import asyncio
import subprocess
import time
from pathlib import Path

import logging

log = logging.getLogger("snapshot")


def _safe_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class SnapshotScheduler:
    def __init__(self, opts: dict, sidecar=None, now=time.time, grabber=None) -> None:
        self.opts = dict(opts or {})
        self.sidecar = sidecar
        self.now = now
        self._grabber = grabber or self._ffmpeg_grab
        self._taken_at: list[float] = []
        self._per_event: dict[str, int] = {}
        self.stats = {"asked": 0, "taken": 0, "skipped": 0, "failed": 0, "looked": 0, "demand": 0}

    # ---------- 闸门 ----------
    def allowed(self, fact: dict, context: dict | None = None, now: float | None = None) -> tuple[bool, str]:
        now = now if now is not None else self.now()
        context = context or {}
        if not self.opts.get("enabled", False):
            return False, "disabled"
        if context.get("busy") and self.opts.get("defer_when_busy", True):
            return False, "busy"
        if str(context.get("mode") or "play") == "rest":
            return False, "rest"
        gap = _safe_float(self.opts.get("min_gap_s"), 90.0)
        last = max(self._taken_at, default=0.0)
        if last and now - last < gap:
            return False, f"min_gap_{int(gap)}s"
        hour = [at for at in self._taken_at if now - at <= 3600]
        self._taken_at = hour
        if len(hour) >= max(1, int(self.opts.get("per_hour") or 6)):
            return False, "hour_quota"
        cid = str(fact.get("id") or "")
        limit = max(1, int(self.opts.get("max_per_event") or 1))
        if cid and self._per_event.get(cid, 0) >= limit:
            return False, "event_quota"
        detail = fact.get("detail") if isinstance(fact.get("detail"), dict) else {}
        stable = _safe_float(self.opts.get("stable_window_s"), 6.0)
        last_change = _safe_float(detail.get("last_at"), 0.0) / 1000.0
        if stable > 0 and last_change and now - last_change < stable:
            return False, "not_stable_yet"
        return True, "ok"

    # ---------- 抓拍 ----------
    def _target_path(self, fact: dict, now: float) -> Path:
        base = Path(self.opts.get("dir") or ".")
        base.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now))
        cid = str(fact.get("id") or "x").replace("/", "_")[:8]
        kind = str(fact.get("kind") or "shot").replace("/", "_")
        return base / f"{stamp}-{kind}-{cid}.png"

    def _ffmpeg_grab(self, path: Path) -> tuple[bool, str]:
        """抓一帧：整屏 -> 缩到 scale_width 宽，够视觉认东西就行。"""
        display = str(self.opts.get("display") or ":0.0")
        size = str(self.opts.get("size") or "1920x1080")
        offset = str(self.opts.get("offset") or "+0,0")
        width = int(self.opts.get("scale_width") or 960)
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "x11grab", "-video_size", size, "-i", f"{display}{offset}",
            "-frames:v", "1", "-vf", f"scale={width}:-1", str(path),
        ]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, timeout=_safe_float(self.opts.get("timeout_s"), 12.0)
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return False, f"{type(exc).__name__}: {exc}"
        if proc.returncode != 0:
            return False, (proc.stderr or b"").decode("utf-8", "replace").strip()[:200] or "ffmpeg_failed"
        if not path.exists() or path.stat().st_size == 0:
            return False, "empty_image"
        return True, ""

    def _usable(self, path: Path) -> tuple[bool, str]:
        """画面能不能用：黑屏、单一大色块（相机陷进方块/她的模型）都算拍废了。

        视觉模型最怕这种帧：它会认真地描述「一片黑色」，把经历污染成幻觉。
        """
        if not self.opts.get("sanity", True):
            return True, ""
        try:
            from PIL import Image, ImageStat
        except ImportError:
            return True, ""
        try:
            with Image.open(path) as image:
                rgb = image.convert("RGB")
                gray = rgb.convert("L")
                brightness = ImageStat.Stat(gray).mean[0]
                counts = rgb.getcolors(maxcolors=1 << 20) or []
                total = rgb.width * rgb.height
        except OSError as exc:
            return False, f"unreadable: {exc}"
        dominant = max((count for count, _ in counts), default=0) / max(1, total)
        if brightness < _safe_float(self.opts.get("min_brightness"), 25.0):
            return False, f"too_dark:{brightness:.0f}"
        if dominant > _safe_float(self.opts.get("max_dominant_share"), 0.55):
            return False, f"single_color:{dominant:.2f}"
        return True, ""

    def _prune(self) -> None:
        keep = max(1, int(self.opts.get("keep") or 60))
        base = Path(self.opts.get("dir") or ".")
        try:
            files = sorted(base.glob("*.png"), key=lambda p: p.stat().st_mtime)
        except OSError:
            return
        for old in files[:-keep]:
            try:
                old.unlink()
            except OSError:
                pass

    async def take(self, fact: dict, context: dict | None = None, now: float | None = None) -> dict:
        """申请一张截图：能拍就异步拍，拍不到也不抛异常。"""
        now = now if now is not None else self.now()
        self.stats["asked"] += 1
        ok, reason = self.allowed(fact, context, now)
        if not ok:
            self.stats["skipped"] += 1
            log.info("snapshot_skip id=%s reason=%s", fact.get("id"), reason)
            return {"ok": False, "skipped": reason}

        if self.opts.get("look_before") and self.sidecar is not None:
            location = fact.get("detail", {}).get("location") if isinstance(fact.get("detail"), dict) else None
            location = location or fact.get("location")
            if isinstance(location, dict) and location:
                try:
                    await self.sidecar.look(location)
                    self.stats["looked"] += 1
                except Exception as exc:  # 转向失败不影响截图
                    log.warning("snapshot_look_failed error=%s", exc)

        path = self._target_path(fact, now)
        taken, error = await asyncio.to_thread(self._grabber, path)
        if not taken:
            self.stats["failed"] += 1
            log.warning("snapshot_failed id=%s error=%s", fact.get("id"), error)
            return {"ok": False, "error": error}
        usable, why = await asyncio.to_thread(self._usable, path)
        if not usable:
            self.stats["failed"] += 1
            log.info("snapshot_unusable id=%s reason=%s", fact.get("id"), why)
            try:
                path.unlink()
            except OSError:
                pass
            return {"ok": False, "error": why}

        self.stats["taken"] += 1
        self._taken_at.append(now)
        cid = str(fact.get("id") or "")
        if cid:
            self._per_event[cid] = self._per_event.get(cid, 0) + 1
        await asyncio.to_thread(self._prune)
        log.info("snapshot_taken id=%s path=%s", fact.get("id"), path)
        return {"ok": True, "path": str(path), "name": path.name, "at": now, "visual": f"snapshot:{path.name}"}

    async def capture(self, kind: str = "look", hint: str = "", look_at: dict | None = None) -> dict:
        """按需抓一张：**不查事件闸门**（min_gap / per_hour / event_quota 都不看）。

        L1 主动「看一眼」与 L2 的 snapshot 技能都走这里——机主要求不看频率上限，由她自己决定。
        仍然保留画面可用性检查：黑屏/单色不是限流，是防止视觉模型把一片黑描述成幻觉。
        """
        if not self.opts.get("enabled", False):
            # enabled 只管「自动调度」，按需抓图不看它；但要保证 dir 等参数在
            self.opts = {**self.opts}
        now = self.now()
        if self.opts.get("look_before") and look_at and self.sidecar is not None:
            try:
                await self.sidecar.look(look_at)
                self.stats["looked"] += 1
            except Exception as exc:  # 转向失败不影响截图
                log.warning("look_before_failed error=%s", exc)
        fact = {"id": f"look-{int(now)}", "kind": kind, "detail": {"hint": hint[:120]}}
        path = self._target_path(fact, now)
        taken, error = await asyncio.to_thread(self._grabber, path)
        if not taken:
            self.stats["failed"] += 1
            log.warning("look_failed error=%s", error)
            return {"ok": False, "error": error}
        usable, why = await asyncio.to_thread(self._usable, path)
        if not usable:
            self.stats["failed"] += 1
            log.info("look_unusable reason=%s", why)
            try:
                path.unlink()
            except OSError:
                pass
            return {"ok": False, "error": why}
        self._taken_at.append(now)
        self.stats["taken"] += 1
        self.stats["demand"] = self.stats.get("demand", 0) + 1
        await asyncio.to_thread(self._prune)
        log.info("look_taken path=%s hint=%s", path, hint[:40])
        return {"ok": True, "path": str(path), "name": path.name, "at": now}

    def snapshot(self) -> dict:
        return {
            "enabled": bool(self.opts.get("enabled", False)),
            "min_gap_s": self.opts.get("min_gap_s"),
            "per_hour": self.opts.get("per_hour"),
            "max_per_event": self.opts.get("max_per_event"),
            "stable_window_s": self.opts.get("stable_window_s"),
            "look_before": bool(self.opts.get("look_before", False)),
            "dir": str(self.opts.get("dir") or ""),
            "taken": len(self._taken_at),
            "stats": dict(self.stats),
        }
