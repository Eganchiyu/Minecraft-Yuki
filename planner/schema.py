# planner/schema.py —— L2 输出的硬校验。非法即拒收，绝不把脏 JSON 送进执行器。
from typing import Any

MAX_STEPS = 5
ON_FAIL = {"retry", "abort", "skip"}
SKILLS = {"mine", "goto", "follow", "craft", "deposit", "attack", "eat", "equip", "place", "roam", "drop", "open"}
EQUIP_SLOTS = {"hand", "off-hand", "head", "torso", "legs", "feet"}
MAX_OPTIONS = 3
MIN_OPTIONS = 2


class SchemaError(ValueError):
    pass


class UnsupportedCapability(SchemaError):
    """L2 明确表示「这个功能还没做」，而不是规划失败。"""

    def __init__(self, reason: str) -> None:
        self.reason = str(reason or "").strip()[:60] or "这个功能"
        super().__init__(f"unsupported: {self.reason}")


def _num(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise SchemaError(f"{field} 不能是布尔")
    if isinstance(value, (int, float)):
        return int(round(value))
    if isinstance(value, str):
        try:
            return int(round(float(value.strip())))
        except ValueError:
            raise SchemaError(f"{field} 不是数字: {value!r}")
    raise SchemaError(f"{field} 类型错误")


def _int_range(value: Any, field: str, low: int, high: int) -> int:
    n = _num(value, field)
    if n < low or n > high:
        raise SchemaError(f"{field} 超出范围 {low}..{high}: {n}")
    return n


def _str(value: Any, field: str, max_len: int = 40) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SchemaError(f"{field} 必须是非空字符串")
    return value.strip()[:max_len]


def _normalize_step(step: Any, index: int) -> dict:
    if not isinstance(step, dict):
        raise SchemaError(f"steps[{index}] 不是对象")
    # 表达式能力一律拒收：出现 if/loop/when 这类字段说明它想写控制流
    extra = set(step) - {"skill", "args", "on_fail"}
    if extra:
        raise SchemaError(f"steps[{index}] 含不允许的字段: {sorted(extra)}")
    skill = step.get("skill")
    if skill not in SKILLS:
        raise SchemaError(f"steps[{index}].skill 不在白名单: {skill!r}")
    args = step.get("args") or {}
    if not isinstance(args, dict):
        raise SchemaError(f"steps[{index}].args 不是对象")

    if skill == "mine":
        clean = {
            "block": _str(args.get("block"), f"steps[{index}].args.block"),
            "count": _int_range(args.get("count", 1), f"steps[{index}].args.count", 1, 64),
        }
    elif skill == "goto":
        clean = {
            "x": _int_range(args.get("x"), f"steps[{index}].args.x", -30000000, 30000000),
            "y": _int_range(args.get("y"), f"steps[{index}].args.y", -2000, 2000),
            "z": _int_range(args.get("z"), f"steps[{index}].args.z", -30000000, 30000000),
        }
        if args.get("range") is not None:
            clean["range"] = _int_range(args.get("range"), f"steps[{index}].args.range", 0, 3)
        if args.get("player") is not None:
            clean["player"] = _str(args.get("player"), f"steps[{index}].args.player", 16)
    elif skill == "follow":
        clean = {
            "player": _str(args.get("player"), f"steps[{index}].args.player", 16),
        }
        if args.get("seconds") is not None:
            clean["seconds"] = _int_range(args.get("seconds"), f"steps[{index}].args.seconds", 3, 300)
        if args.get("distance") is not None:
            clean["distance"] = _int_range(args.get("distance"), f"steps[{index}].args.distance", 1, 6)
    elif skill == "craft":
        clean = {
            "item": _str(args.get("item"), f"steps[{index}].args.item"),
            "count": _int_range(args.get("count", 1), f"steps[{index}].args.count", 1, 64),
        }
    elif skill == "deposit":
        clean = {}
        coords = [args.get(k) for k in ("x", "y", "z")]
        if any(v is not None for v in coords):
            if any(v is None for v in coords):
                raise SchemaError(f"steps[{index}].args 的 x/y/z 必须同时给出")
            clean["x"] = _int_range(args.get("x"), f"steps[{index}].args.x", -30000000, 30000000)
            clean["y"] = _int_range(args.get("y"), f"steps[{index}].args.y", -2000, 2000)
            clean["z"] = _int_range(args.get("z"), f"steps[{index}].args.z", -30000000, 30000000)
        if args.get("item") is not None:
            clean["item"] = _str(args.get("item"), f"steps[{index}].args.item")
        if args.get("count") is not None:
            clean["count"] = _int_range(args.get("count"), f"steps[{index}].args.count", 1, 2304)
    elif skill == "attack":
        clean = {"target": _str(args.get("target") or "hostile", f"steps[{index}].args.target", 32)}
        if args.get("count") is not None:
            clean["count"] = _int_range(args.get("count"), f"steps[{index}].args.count", 1, 8)
    elif skill == "eat":
        clean = {}
        if args.get("food") is not None:
            clean["food"] = _str(args.get("food"), f"steps[{index}].args.food")
    elif skill == "equip":
        clean = {"item": _str(args.get("item"), f"steps[{index}].args.item")}
        dest = args.get("destination")
        if dest is not None:
            if dest not in EQUIP_SLOTS:
                raise SchemaError(f"steps[{index}].args.destination 非法: {dest!r}")
            clean["destination"] = dest
    elif skill == "place":
        clean = {"item": _str(args.get("item"), f"steps[{index}].args.item")}
        coords = [args.get(k) for k in ("x", "y", "z")]
        if any(v is not None for v in coords):
            if any(v is None for v in coords):
                raise SchemaError(f"steps[{index}].args 的 x/y/z 必须同时给出")
            clean["x"] = _int_range(args.get("x"), f"steps[{index}].args.x", -30000000, 30000000)
            clean["y"] = _int_range(args.get("y"), f"steps[{index}].args.y", -2000, 2000)
            clean["z"] = _int_range(args.get("z"), f"steps[{index}].args.z", -30000000, 30000000)
    elif skill == "drop":
        clean = {"item": _str(args.get("item"), f"steps[{index}].args.item")}
        if args.get("count") is not None:
            clean["count"] = _int_range(args.get("count"), f"steps[{index}].args.count", 1, 2304)
        if args.get("player") is not None:
            clean["player"] = _str(args.get("player"), f"steps[{index}].args.player", 16)
    elif skill == "open":
        clean = {}
        coords = [args.get(k) for k in ("x", "y", "z")]
        if any(v is not None for v in coords):
            if any(v is None for v in coords):
                raise SchemaError(f"steps[{index}].args 的 x/y/z 必须同时给出")
            clean["x"] = _int_range(args.get("x"), f"steps[{index}].args.x", -30000000, 30000000)
            clean["y"] = _int_range(args.get("y"), f"steps[{index}].args.y", -2000, 2000)
            clean["z"] = _int_range(args.get("z"), f"steps[{index}].args.z", -30000000, 30000000)
        if args.get("radius") is not None:
            clean["radius"] = _int_range(args.get("radius"), f"steps[{index}].args.radius", 1, 32)
        if args.get("item") is not None:
            clean["item"] = _str(args.get("item"), f"steps[{index}].args.item")
        if args.get("count") is not None:
            clean["count"] = _int_range(args.get("count"), f"steps[{index}].args.count", 1, 2304)
    elif skill == "roam":
        clean = {}
        if args.get("radius") is not None:
            clean["radius"] = _int_range(args.get("radius"), f"steps[{index}].args.radius", 4, 48)
        if args.get("stops") is not None:
            clean["stops"] = _int_range(args.get("stops"), f"steps[{index}].args.stops", 1, 6)
    else:  # pragma: no cover - 前面已拦截
        raise SchemaError(f"未知技能 {skill!r}")

    on_fail = step.get("on_fail", "abort")
    if on_fail not in ON_FAIL:
        raise SchemaError(f"steps[{index}].on_fail 非法: {on_fail!r}")
    return {"skill": skill, "args": clean, "on_fail": on_fail}


def validate_plan(payload: Any) -> list[dict]:
    """把 L2 输出收敛成干净的步骤列表；任何不合规都抛 SchemaError。"""
    if not isinstance(payload, dict):
        raise SchemaError("顶层必须是对象")
    # 能力边界：L2 可以直接说「这个还没做」，不要去用别的技能拼凑
    if "unsupported" in payload and "steps" not in payload:
        raise UnsupportedCapability(str(payload.get("unsupported") or "这个功能"))
    steps = payload.get("steps")
    if not isinstance(steps, list) or not steps:
        raise SchemaError("steps 必须是非空数组")
    if len(steps) > MAX_STEPS:
        raise SchemaError(f"steps 超过 {MAX_STEPS} 步")
    return [_normalize_step(step, i) for i, step in enumerate(steps)]


def validate_options(payload: Any) -> list[dict]:
    """L2 失败协商输出：2–3 个可选方案，每个方案是一句可直接派活的委托句。"""
    if not isinstance(payload, dict):
        raise SchemaError("顶层必须是对象")
    options = payload.get("options")
    if not isinstance(options, list) or not MIN_OPTIONS <= len(options) <= MAX_OPTIONS:
        raise SchemaError(f"options 必须是 {MIN_OPTIONS}-{MAX_OPTIONS} 项的数组")
    clean = []
    for i, option in enumerate(options):
        if not isinstance(option, dict):
            raise SchemaError(f"options[{i}] 不是对象")
        clean.append(
            {
                "label": _str(option.get("label"), f"options[{i}].label", 12),
                "text": _str(option.get("text"), f"options[{i}].text", 60),
            }
        )
    return clean


def steps_to_text(steps: list[dict]) -> str:
    """步骤压成一行人话，喂给 L1 做进度感知（不含坐标细节堆砌）。"""
    return " > ".join(f"{s['skill']}({','.join(f'{k}={v}' for k, v in s['args'].items())})" for s in steps)
