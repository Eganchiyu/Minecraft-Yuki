# planner/vision.py —— P5.2 Vision Adapter：一张截图 → 一句人话 + 标签 + 置信度。
#
# 走的是「现有视觉通道」：同一个 OpenAI 兼容端点（deepseek-flash 支持 image_url），
# 不新起模型、不做本地推理（无 GPU，决策 #4）。图片以 base64 data URL 内联，
# 只在这一次调用里出现：视觉摘要会跟着经历进账本，但**不自动进长期对话上下文**（PRD P5.2）。
import base64
import json
import logging
from pathlib import Path

log = logging.getLogger("vision")

VISION_SYSTEM = """你在看一张 Minecraft 的截图（可能是旁观视角）。
只用一两句中文说清画面里**看得见**的东西：有没有建筑/造型、什么生物、几个人、什么地形。
不确定就说不确定，别猜剧情、别夸。输出 JSON 对象：
{"summary":"<=40字的中文描述","tags":["building|animal|player|terrain|item|unknown"],"confidence":0.0-1.0}"""

TAG_SET = {"building", "animal", "player", "terrain", "item", "unknown"}


def _clamp(value, low: float = 0.0, high: float = 1.0) -> float:
    try:
        return max(low, min(high, float(value)))
    except (TypeError, ValueError):
        return low


def parse_vision_json(text: str) -> dict:
    """从模型输出里取第一个 JSON 对象；取不到就抛 ValueError。"""
    raw = str(text or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        raw = raw[raw.find("{"):] if "{" in raw else raw
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no_json_object")
    return json.loads(raw[start : end + 1])


def normalize_vision(payload: dict) -> dict:
    """模型输出 → 固定形状。标签只留白名单里的，摘要截断到 60 字。"""
    summary = " ".join(str(payload.get("summary") or "").split())[:60]
    raw_tags = payload.get("tags") if isinstance(payload.get("tags"), list) else []
    tags = [str(tag) for tag in raw_tags if str(tag) in TAG_SET][:4]
    return {
        "summary": summary,
        "tags": tags or ["unknown"],
        "confidence": round(_clamp(payload.get("confidence"), 0.0, 1.0), 3),
    }


class VisionAdapter:
    def __init__(self, llm, opts: dict | None = None) -> None:
        self.llm = llm
        self.opts = dict(opts or {})
        self.stats = {"asked": 0, "ok": 0, "failed": 0, "disabled": 0}

    def enabled(self) -> bool:
        return bool(self.opts.get("enabled", True))

    @staticmethod
    def _data_url(path: Path) -> str:
        raw = Path(path).read_bytes()
        return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")

    async def describe(self, image_path, capsule_hint: str = "") -> dict:
        """返回 {ok, summary, tags, confidence} 或 {ok:False, error}；任何失败都不抛。"""
        if not self.enabled():
            self.stats["disabled"] += 1
            return {"ok": False, "error": "disabled"}
        path = Path(str(image_path or ""))
        if not path.exists():
            return {"ok": False, "error": "image_missing"}
        self.stats["asked"] += 1
        hint = " ".join(str(capsule_hint or "").split())[:120]
        user_content = [
            {"type": "text", "text": f"这条经历的结构化事实是：{hint or '（无）'}。请看图描述。"},
            {"type": "image_url", "image_url": {"url": self._data_url(path)}},
        ]
        try:
            raw = await self.llm.chat(
                [
                    {"role": "system", "content": VISION_SYSTEM},
                    {"role": "user", "content": user_content},
                ],
                purpose="p5_vision",
                response_format={"type": "json_object"},
                max_tokens=int(self.opts.get("max_tokens") or 200),
                temperature=0.3,
                retries=0,
            )
            parsed = normalize_vision(parse_vision_json(raw.get("content") or ""))
            if not parsed["summary"]:
                raise ValueError("empty_summary")
            self.stats["ok"] += 1
            log.info("vision_ok tags=%s confidence=%s", parsed["tags"], parsed["confidence"])
            return {"ok": True, **parsed}
        except Exception as exc:  # 视觉不可用不阻塞其它链路
            self.stats["failed"] += 1
            log.warning("vision_failed error=%s", exc)
            return {"ok": False, "error": str(exc)[:160]}

    def snapshot(self) -> dict:
        return {"enabled": self.enabled(), "model": self.opts.get("model"), "stats": dict(self.stats)}
