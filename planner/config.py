# planner/config.py —— 配置外置：读 configs/local.json，环境变量优先。
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load_local() -> dict:
    path = Path(os.environ.get("YUKI_MC_CONFIG", ROOT / "configs" / "local.json"))
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


_RAW = _load_local()
_LLM = _RAW.get("llm") or {}
_PLANNER = _RAW.get("planner") or {}
_SIDECAR = _RAW.get("sidecar") or {}
_BUDGET = _RAW.get("budget") or {}
_MC = _RAW.get("mc") or {}
_MEMORY = _RAW.get("memory") or {}


def _int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float(value, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


PLANNER_HOST = os.environ.get("PLANNER_HOST", _PLANNER.get("host", "127.0.0.1"))
PLANNER_PORT = _int(os.environ.get("PLANNER_PORT"), _PLANNER.get("port", 8791))
SIDECAR_URL = os.environ.get(
    "SIDECAR_URL", _PLANNER.get("sidecar_url", "http://127.0.0.1:8790")
).rstrip("/")

LLM_BASE_URL = os.environ.get("LLM_BASE_URL", _LLM.get("base_url", "https://api.deepseek.com/v1"))
LLM_API_KEY = os.environ.get("LLM_API_KEY", _LLM.get("api_key", ""))
LLM_MODEL = os.environ.get("LLM_MODEL", _LLM.get("model", "deepseek-flash"))
LLM_TIMEOUT_S = float(os.environ.get("LLM_TIMEOUT_S", _LLM.get("timeout_s", 45)))
# 冻结决策：所有层 disable_thinking=true（deepseek 端点无该参数，保留开关位以便换供应商）
DISABLE_THINKING = bool(_LLM.get("disable_thinking", True))

# 世界身份：记忆/对话/状态全部按世界分区，注入的回忆天然只来自当前世界。
# 取值优先级：MC_WORLD 环境变量 > configs.local.json 的 mc.world > host:port。
# 换了世界（或换了 LAN 端口）就换一个目录，旧世界的记忆不会被串进来。
MC_HOST = str(os.environ.get("MC_HOST") or _MC.get("host", "127.0.0.1"))
MC_PORT = _int(os.environ.get("MC_PORT"), _MC.get("port", 25565))


def _world_key(raw: str) -> str:
    """世界名当目录名用：只留字母数字和 . _ -，其余压成 _。"""
    cleaned = "".join(ch if (ch.isalnum() or ch in "._-") else "_" for ch in str(raw or "").strip())
    return cleaned.strip("._") or "default"


WORLD = _world_key(os.environ.get("MC_WORLD") or _MC.get("world") or f"{MC_HOST}_{MC_PORT}")
CHAT_ID = f"mc:{WORLD}"
SCENE = "mc"
HISTORY_KEEP = 6            # 轮内层：最近 6 条（3 轮）
STATUS_FRESH_S = 3.0        # 状态超过 3 秒标"可能过期"

# P3 心智（mind.py）：她自己过日子用的节拍与额度。
_AUTONOMY = _RAW.get("autonomy") or {}
AUTONOMY = {
    "enabled": bool(_AUTONOMY.get("enabled", True)),
    "tick_s": _float(_AUTONOMY.get("tick_s"), 2.0),                  # 循环心跳，不是每拍都调模型
    "idle_gap_s": _float(_AUTONOMY.get("idle_gap_s"), 45.0),        # 闲着时多久自己想一想
    # 进程刚起来时先安静这么久再自主行动（专注验收/省 token 用；0 = 老行为）
    "idle_first_gap_s": _float(_AUTONOMY.get("idle_first_gap_s"), 0.0),
    "max_idle_gap_s": _float(_AUTONOMY.get("max_idle_gap_s"), 120.0),
    "max_calls_per_10min": _int(_AUTONOMY.get("max_calls_per_10min"), 80),
    "max_tokens": _int(_AUTONOMY.get("max_tokens"), 260),
    "rest_default_min": _int(_AUTONOMY.get("rest_default_min"), 10),
    "event_aggregate_s": _float(_AUTONOMY.get("event_aggregate_s"), 30.0),
    # 忙时别把事件丢掉：最多留这么久，超时降级为「只记不唤醒」
    "event_ttl_s": _float(_AUTONOMY.get("event_ttl_s"), 180.0),
    "urgent_severity": _int(_AUTONOMY.get("urgent_severity"), 7),
    "summary_after": _int(_AUTONOMY.get("summary_after"), 12),       # 超过就压成一条日记，保持上下文干净
    "max_say_chars": _int(_AUTONOMY.get("max_say_chars"), 120),      # 公屏一句话的上限
    "proactive_say_min_gap_s": _float(_AUTONOMY.get("proactive_say_min_gap_s"), 120.0),
    # 日总量硬上限：到顶就只回话、不再自己找事（聊天不受影响）
    "daily_self_calls": _int(_AUTONOMY.get("daily_self_calls"), 800),
    # 身体明明闲着却一直以为自己在干活，超过这么多秒就复位
    "stuck_after_s": _float(_AUTONOMY.get("stuck_after_s"), 20.0),
}
# P4.3 注意力 + P4.4 capsule → L1：wake 真的会叫醒她（wake_enabled=false 退回 Shadow）
_ATT = _RAW.get("attention") or {}
ATTENTION = {
    "enabled": bool(_ATT.get("enabled", True)),
    # P4.4：decision=wake 是否真的叫醒 L1。关掉就是 P4.3 的 Shadow 行为
    "wake_enabled": bool(_ATT.get("wake_enabled", True)),
    # 经历唤醒用低优先级：外部委托/聊天随时能接管（PRD P4.4）
    "capsule_priority": _int(_ATT.get("capsule_priority"), 2),
    "batch_s": _float(_ATT.get("batch_s"), 60.0),                  # 打分按批，允许积压
    "floor": _float(_ATT.get("floor"), 0.55),                       # A(c) 下限
    "top_k": _int(_ATT.get("top_k"), 1),                            # 每批最多放行几条 wake
    "wake_gap_s": _float(_ATT.get("wake_gap_s"), _AUTONOMY.get("proactive_say_min_gap_s", 120.0)),
    "short_half_life_s": _float(_ATT.get("short_half_life_s"), 1800.0),   # 短期情景：30 分钟后减半
    "max_fact_age_s": _float(_ATT.get("max_fact_age_s"), 12 * 3600.0),   # 太旧的事实不再打分
    "max_batch": _int(_ATT.get("max_batch"), 200),
    "recall_n": _int(_ATT.get("recall_n"), 5),
    "weights": {
        "novelty": _float((_ATT.get("weights") or {}).get("novelty"), 0.35),
        "importance": _float((_ATT.get("weights") or {}).get("importance"), 0.35),
        "interest": _float((_ATT.get("weights") or {}).get("interest"), 0.20),
        "memory": _float((_ATT.get("weights") or {}).get("memory"), 0.10),
        "interruption": _float((_ATT.get("weights") or {}).get("interruption"), 0.35),
    },
    # Snapshot 要等 P4.0 截图跟随肉眼验过才开；关着时只写 decision
    "snapshot_enabled": bool(_ATT.get("snapshot_enabled", False)),
}
_TRACE = _RAW.get("trace") or {}
# 请求/补全留痕：调 prompt 时看「上传了什么、模型回了什么」。默认开，按大小滚动。
TRACE_ENABLED = bool(_TRACE.get("enabled", True))
TRACE_PATH = Path(_TRACE.get("path") or (ROOT / "planner" / "state" / "trace.jsonl"))
TRACE_MAX_BYTES = _int(_TRACE.get("max_bytes"), 12 * 1024 * 1024)

BASE_STATE_DIR = Path(_AUTONOMY.get("state_dir") or (ROOT / "planner" / "state"))
# 每个世界一个目录：memory.jsonl（日记/事件）、history.json（对话）、mind.json（状态）、chroma/（向量索引）
STATE_DIR = BASE_STATE_DIR / "worlds" / WORLD
MEMORY_PATH = STATE_DIR / "memory.jsonl"
HISTORY_PATH = STATE_DIR / "history.json"
MIND_STATE_PATH = STATE_DIR / "mind.json"
VECTOR_PATH = STATE_DIR / "chroma"
# P4.3：侧车写事实行、planner 写 decision，两个文件并排、按 candidate_id join
ATTENTION_FACTS_PATH = STATE_DIR / "experiences.jsonl"
DECISIONS_PATH = STATE_DIR / "decisions.jsonl"
# P4.4：胶囊与她的反应（speak/act/ignore），同样按 candidate_id join 回事实行
CAPSULES_PATH = STATE_DIR / "capsules.jsonl"

# P5.1 截图调度：默认关；开了也受最小间隔/配额/同一事件一张/稳定窗口约束
_SHOT = _RAW.get("snapshot") or {}
SNAPSHOT = {
    "enabled": bool(_SHOT.get("enabled", False)),
    "min_gap_s": _float(_SHOT.get("min_gap_s"), 90.0),
    "per_hour": _int(_SHOT.get("per_hour"), 6),
    "max_per_event": _int(_SHOT.get("max_per_event"), 1),
    # 建造类候选要等世界安静这么久再拍，别拍半成品
    "stable_window_s": _float(_SHOT.get("stable_window_s"), 6.0),
    # 忙/睡时默认延迟（不是丢弃），等空了再拍
    "defer_when_busy": bool(_SHOT.get("defer_when_busy", True)),
    # P4.0 验过的虚拟屏：Xvfb :98 + 观战客户端，不碰机主的 :0.0
    "display": str(_SHOT.get("display") or os.environ.get("MC_DISPLAY") or ":98"),
    "size": str(_SHOT.get("size") or os.environ.get("MC_CAPTURE_SIZE") or "1280x720"),
    "offset": str(_SHOT.get("offset") or "+0,0"),
    # 缩到 960 宽再送视觉：再大只会烧 token
    "scale_width": _int(_SHOT.get("scale_width"), 960),
    "dir": Path(_SHOT.get("dir") or (STATE_DIR / "snapshots")),
    "keep": _int(_SHOT.get("keep"), 60),
    "timeout_s": _float(_SHOT.get("timeout_s"), 12.0),
    # P5.3：拍之前让 bot 转向目标（观战相机跟着她的 yaw/pitch，P4.0 已验）
    "look_before": bool(_SHOT.get("look_before", True)),
    # 画面可用性检查：黑屏/单一大色块（相机陷进方块）就当没拍到
    "sanity": bool(_SHOT.get("sanity", True)),
    "min_brightness": _float(_SHOT.get("min_brightness"), 25.0),
    "max_dominant_share": _float(_SHOT.get("max_dominant_share"), 0.55),
}
# P5.2 视觉通道：复用 llm 的 OpenAI 兼容端点（deepseek-flash 支持 image_url）
_VIS = _RAW.get("vision") or {}
VISION = {
    "enabled": bool(_VIS.get("enabled", True)),
    "model": str(_VIS.get("model") or _LLM.get("vision_model") or _LLM.get("model", "deepseek-flash")),
    "max_tokens": _int(_VIS.get("max_tokens"), 200),
    "timeout_s": _float(_VIS.get("timeout_s"), 60.0),
}
# 世界知识表：哪个箱子有什么、在哪（由 L3 每次开容器上报，按坐标覆盖）
# 目前先关掉：places_enabled=false 时不记录也不注入，代码留着随时开
_NOTES = _RAW.get("notes") or {}
NOTES_ENABLED = bool(_NOTES.get("places_enabled", False))
NOTES_PATH = STATE_DIR / "places.json"

# 记忆（照搬 Yuki 的日记召回：向量宽进 + 关键词打捞 + 时间衰减重排）
MEMORY = {
    "enabled": bool(_MEMORY.get("enabled", True)),
    # 关掉只用关键词召回（零依赖、启动快），排查 embedding 问题时用
    "vector": bool(_MEMORY.get("vector", True)),
    "embed_model": Path(
        str(_MEMORY.get("embed_model") or (ROOT.parent / "Yuki" / "models" / "text2vec-base-chinese"))
    ),
    "inject": _int(_MEMORY.get("inject"), 3),              # 每轮注入几条回忆
    "pool": _int(_MEMORY.get("pool"), 24),                 # 语义池宽进多少条
    "keep": _int(_MEMORY.get("keep"), 600),                # memory.jsonl 上限
    "history_max": _int(_MEMORY.get("history_max"), 400),  # history.json 上限（条消息）
    "half_life_days": _float(_MEMORY.get("half_life_days"), 60.0),
    "recency_floor": _float(_MEMORY.get("recency_floor"), 0.55),
}

# P2 单任务预算：一条委托从听见到最终汇报的总开销上限。
# LLMClient 每次真实调用记账，超了立即降级成一句人话，不再继续烧。
# 「看一眼」：L1 主动要画面（look 工具）与 L2 的 snapshot 技能共用。
# 机主定调：不设频率上限，只靠她自己决定；给 L1 的是原图（多模态），不是文字摘要。
_LOOK = _RAW.get("look") or {}
LOOK = {
    "enabled": bool(_LOOK.get("enabled", True)),
    # 原图直接进 L1 的消息（成本更高，但看得见细节）
    "show_image": bool(_LOOK.get("show_image", True)),
    # 原图太大就拒绝送给 L1（避免一次调用把上下文撑爆）
    "max_image_bytes": _int(_LOOK.get("max_image_bytes"), 4 * 1024 * 1024),
}

BUDGET = {
    "max_calls": _int(_BUDGET.get("max_calls"), 10),
    "max_tokens": _int(_BUDGET.get("max_tokens"), 12000),
    "max_wall_s": _float(_BUDGET.get("max_wall_s"), 300.0),
    # retry 上限（默认 2）：L2 自动重规划轮数，用尽后交给 L1 做一次决断
    "max_retries": _int(_BUDGET.get("max_retries"), 2),
}

if not LLM_API_KEY:
    raise SystemExit("缺少 LLM API key：在 configs/local.json 的 llm.api_key 或环境变量 LLM_API_KEY 中配置")
