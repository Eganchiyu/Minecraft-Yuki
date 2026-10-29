# planner/facts.py —— 把 L3 回调里的硬校验失败压成「期望 vs 实际」事实（决策 #22）。
# L2 拿它重规划；仍然不行时，同样的结构交给 L1 做决断。原始事件流不进这里。
from typing import Any

# 失败码 -> 一句人话 + 该码通常意味着什么
CODE_LABELS = {
    "missing_tool": "没有能挖这个东西的工具",
    "missing_material": "材料不够",
    "need_workbench": "需要工作台",
    "no_target_block": "周围找不到要挖的方块",
    "unknown_block": "不认识这个方块名",
    "unknown_item": "不认识这个物品名",
    "not_arrived": "走不到那个地方",
    "no_container": "附近没有箱子",
    "cannot_reach_container": "过不去箱子那边",
    "item_not_in_inventory": "背包里没有这个东西",
    "no_target_in_range": "附近没有能打的怪",
    "target_lost": "跟丢了",
    "player_not_visible": "看不到这个玩家（名字要用游戏里的英文 ID）",
    "not_hungry": "现在不饿",
    "no_food_item": "背包里没有吃的",
    "task_timeout": "这件事太久了，先停下",
    "cancelled": "被叫停了",
    "not_enough": "没凑够数量",
    "not_killed": "没打过",
    "not_enough_crafted": "没合成够",
    "deposit_mismatch": "东西没真的进箱子",
    "no_place_spot": "脚边没有能放下的位置",
    "place_failed": "方块没放下去",
}

# 给 L1 的兜底方案（L2 出选项失败时用），text 是能直接派给执行的委托句
FALLBACK_OPTIONS = {
    "missing_tool": [
        {"label": "先造工具", "text": "去砍点木头，造一把木镐，再来挖"},
        {"label": "换个目标", "text": "换一个现在空手也能挖的目标"},
    ],
    "missing_material": [
        {"label": "先攒材料", "text": "去收集缺的材料，回来再合成"},
        {"label": "换个简单的", "text": "换个需要的材料更少的东西来合成"},
    ],
    "need_workbench": [
        {"label": "造工作台", "text": "先造一个工作台放好，再做这个东西"},
        {"label": "换目标", "text": "换一个不需要工作台就能做的东西"},
    ],
    "no_target_block": [
        {"label": "走远点找", "text": "去远一点的地方找找这个方块"},
        {"label": "换目标", "text": "改挖附近现成的东西"},
    ],
    "not_arrived": [
        {"label": "再试一次", "text": "再走一次那个地方"},
        {"label": "放弃", "text": "不去那个地方了，就近找点事做"},
    ],
    "player_not_visible": [
        {"label": "先问位置", "text": "问一下他在哪，让他站着别动"},
        {"label": "先做别的", "text": "算了，先做点别的"},
    ],
    "no_container": [
        {"label": "换地方找箱子", "text": "去找附近别的箱子存东西"},
        {"label": "先不存", "text": "先不存了，把东西带在身上"},
    ],
}
FALLBACK_DEFAULT = [
    {"label": "再试一次", "text": "再试一次刚才那件事"},
    {"label": "换个事做", "text": "算了，换个能做到的事"},
]


def extract_facts(detail: Any, summary: str = "") -> dict:
    """从 L3 回调 detail 里取第一个失败步骤，返回紧凑事实。"""
    if not isinstance(detail, dict):
        detail = {}
    results = detail.get("results") if isinstance(detail.get("results"), list) else []
    failed = next((item for item in results if isinstance(item, dict) and not item.get("ok")), None)
    if failed is None:
        return {
            "failed_skill": str(detail.get("failed_step") or ""),
            "code": "unknown",
            "label": "没做成",
            "expected": {},
            "actual": {},
            "done_before": [],
            "summary": clamp(summary, 80),
        }

    # sidecar 回调里是扁平结构（error 在结果项上），事件流里是嵌套 detail，两种都认
    inner = failed.get("detail") if isinstance(failed.get("detail"), dict) else failed
    code = str(inner.get("error") or failed.get("error") or "unknown")
    expected = {k: v for k, v in (failed.get("args") or {}).items() if v not in (None, "")}
    actual_keys = (
        "mined", "crafted", "deposited", "killed", "missing", "needs",
        "distance", "food_before", "food_after", "attempts", "path", "at",
    )
    actual = {k: inner[k] for k in actual_keys if inner.get(k) is not None}
    done_before = [
        {"skill": item.get("skill"), "ok": item.get("ok")}
        for item in results
        if isinstance(item, dict) and item is not failed
    ]
    return {
        "failed_skill": str(failed.get("skill") or ""),
        "code": code,
        "label": label_of(code),
        "expected": expected,
        "actual": actual,
        "done_before": done_before,
        "summary": clamp(summary, 80),
    }


def label_of(code: str) -> str:
    return CODE_LABELS.get(code, "没做成")


def fallback_options(facts: dict) -> list[dict]:
    code = str((facts or {}).get("code") or "")
    options = FALLBACK_OPTIONS.get(code) or FALLBACK_DEFAULT
    return [dict(item) for item in options]


def facts_text(facts: dict) -> str:
    """压成一行给人话层看，避免堆 JSON。"""
    if not facts:
        return "没有细节"
    expected = facts.get("expected") or {}
    actual = facts.get("actual") or {}
    exp = "、".join(f"{k}={v}" for k, v in expected.items()) or "无"
    act = "、".join(f"{k}={v}" for k, v in actual.items() if not isinstance(v, (dict, list))) or "无"
    return f"{facts.get('failed_skill') or '任务'}失败（{facts.get('label')}）；期望：{exp}；实际：{act}"


def clamp(text: Any, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text[:limit]


def options_to_text(options: list[dict]) -> str:
    return "\n".join(f"{i + 1}. {item.get('label')}：{item.get('text')}" for i, item in enumerate(options))
