# planner/capsule.py —— P4.4 Experience Capsule：把一条事实行压成一两句人话 + 有限选项。
#
# 分工（决策 #11/#38）：原始坐标、实体 id、方块名清单都留在侧车账本里；
# 进 L1 的只有这里产出的 capsule。capsule 不替她下结论（不写「这是爱心」「这很可爱」），
# 只把「看到了什么 + 可以怎么办」摆出来，价值判断留给 L1。
#
# 选项是封闭集合（PRD P4.4「有限选项与不行动选项」）：
#   express 说一句 / observe 看看 / approach 靠近 / remember 记住 / ignore 不管
# 其中 express/observe/approach 走既有的 say + intention（→ L2 → L3），
# remember 由经历账本自动承担（每段被注意到的经历都会写进记忆），
# ignore 就是不说话也不派活——不需要新工具，也不新增第二套人格循环。
import json
import re
from pathlib import Path

# 选项代号 →（中文标签, 说明）。顺序就是给 L1 看的顺序。
OPTIONS = {
    "express": ("说一句", "随口跟哥哥提一句，或者自言自语"),
    "observe": ("看看", "留在原地瞧一会"),
    "approach": ("靠近", "走过去/凑近一点"),
    "remember": ("记住", "把这件事留在心里"),
    "ignore": ("不管", "当作没看见，什么都不做"),
}
KIND_OPTIONS = {
    "new_entity": ("express", "approach", "observe", "ignore"),
    "construction_candidate": ("observe", "approach", "express", "ignore"),
    "landmark_arrival": ("observe", "express", "approach", "ignore"),
    "task_milestone": ("express", "remember", "ignore"),
}

ENTITY_ZH = {
    "sheep": "羊", "cow": "牛", "pig": "猪", "chicken": "鸡", "rabbit": "兔子",
    "horse": "马", "donkey": "驴", "wolf": "狼", "cat": "猫", "ocelot": "豹猫",
    "fox": "狐狸", "bee": "蜜蜂", "bat": "蝙蝠", "parrot": "鹦鹉", "turtle": "海龟",
    "dolphin": "海豚", "squid": "鱿鱼", "salmon": "鲑鱼", "cod": "鳕鱼",
    "zombie": "僵尸", "skeleton": "骷髅", "creeper": "苦力怕", "spider": "蜘蛛",
    "enderman": "末影人", "slime": "史莱姆", "witch": "女巫", "drowned": "溺尸",
    "husk": "尸壳", "stray": "流浪者", "phantom": "幻翼", "pillager": "掠夺者",
    "villager": "村民", "wandering_trader": "流浪商人", "iron_golem": "铁傀儡",
    "allay": "悦灵", "axolotl": "美西螈", "goat": "山羊", "camel": "骆驼",
}
CATEGORY_ZH = {
    "animal": "动物", "hostile": "怪物", "passive": "温顺的小家伙",
    "water_creature": "水里的小家伙", "ambient": "飞过去的小东西", "mob": "生物",
}
BLOCK_ZH = {
    "stone": "石头", "cobblestone": "圆石", "dirt": "泥土", "grass_block": "草方块",
    "oak_planks": "橡木板", "spruce_planks": "云杉木板", "birch_planks": "桦木板",
    "oak_log": "橡木原木", "spruce_log": "云杉原木", "birch_log": "桦木原木",
    "sand": "沙子", "sandstone": "砂岩", "gravel": "沙砾", "glass": "玻璃",
    "bricks": "砖块", "stone_bricks": "石砖", "deepslate": "深板岩",
    "white_wool": "白羊毛", "red_wool": "红羊毛", "pink_wool": "粉红羊毛",
    "red_concrete": "红色混凝土", "white_concrete": "白色混凝土",
    "torch": "火把", "crafting_table": "工作台", "furnace": "熔炉", "chest": "箱子",
}
BIOME_ZH = {
    "plains": "平原", "sunflower_plains": "向日葵平原", "forest": "森林",
    "birch_forest": "桦木森林", "dark_forest": "黑森林", "taiga": "针叶林",
    "desert": "沙漠", "savanna": "热带草原", "jungle": "丛林", "swamp": "沼泽",
    "river": "河边", "beach": "沙滩", "ocean": "海边", "snowy_plains": "雪原",
    "snowy_taiga": "雪地针叶林", "mountains": "山地", "stony_peaks": "石头山顶",
    "meadow": "草甸", "grove": "雪林", "cherry_grove": "樱花林", "cave": "洞穴",
    "the_void": "虚空", "mushroom_fields": "蘑菇岛", "badlands": "恶地",
}
SKILL_ZH = {
    "mine": "采集", "goto": "赶路", "follow": "跟随", "craft": "合成",
    "deposit": "存东西", "attack": "打怪", "eat": "吃东西", "equip": "换装备",
    "place": "放方块", "roam": "随便逛逛", "drop": "丢东西", "open": "翻箱子",
    "smelt": "烧东西", "sleep": "睡觉", "use": "按一下",
}


def _zh(table: dict[str, str], raw, default: str = "") -> str:
    """查表；查不到就把 minecraft: 前缀去掉原样返回（宁可见到英文，也不编造名字）。"""
    key = str(raw or "").strip()
    if not key:
        return default
    key = key.split(":")[-1]
    return table.get(key) or default or key.replace("_", " ")


def _num(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _distance_text(detail: dict) -> str:
    distance = _num(detail.get("distance"), 0.0)
    if distance <= 0:
        return ""
    return f"，离你 {distance:.0f} 格" if distance >= 3 else "，就在你旁边"


def capsule_text(fact: dict) -> str:
    """一条事实 → 一两句人话。不写语义断言，只写事实和「可以怎么办」的余地。"""
    detail = fact.get("detail") if isinstance(fact.get("detail"), dict) else {}
    kind = str(fact.get("kind") or "")
    if kind == "new_entity":
        name = _zh(ENTITY_ZH, detail.get("entity_name"), "")
        if not name:
            name = _zh(CATEGORY_ZH, detail.get("category"), "一个生物")
        category = _zh(CATEGORY_ZH, detail.get("category"), "")
        tail = f"（{category}）" if category and category != name else ""
        return f"旁边出现了一只{name}{tail}{_distance_text(detail)}。"
    if kind == "construction_candidate":
        count = int(_num(detail.get("block_count"), 0))
        names = detail.get("block_names") or []
        blocks = "、".join(_zh(BLOCK_ZH, n) for n in names[:3] if n)
        block_text = f"（{blocks}）" if blocks else ""
        size = f"{count} 块" if count else "一些"
        return f"附近有人用{size}方块{block_text}搭了点什么，看不出是什么造型{_distance_text(detail)}。"
    if kind == "landmark_arrival":
        biome = _zh(BIOME_ZH, detail.get("biome"), "一个陌生地方")
        return f"你走到了一片{biome}，和刚才待的地方不一样。"
    if kind == "task_milestone":
        summary = str(fact.get("summary") or "").strip()
        steps = detail.get("steps") or []
        names = "、".join(SKILL_ZH.get(str(s), str(s)) for s in steps[:3])
        if summary:
            return f"你刚自己做完了「{summary}」。"
        if names:
            return f"你刚自己把「{names}」这件事做完了。"
        return "你刚自己做完了一件事。"
    summary = str(fact.get("summary") or "").strip()
    return summary or "身边有了点变化。"


def capsule_hint(fact: dict) -> str:
    """把「有限选项」压成一句自然的话，不列菜单式清单。"""
    kind = str(fact.get("kind") or "")
    if kind == "new_entity":
        return "想跟它说句话、走过去看看、凑近一点，还是当没看见，都随你。"
    if kind == "construction_candidate":
        return "想凑近瞧瞧、说一句，还是先不管，都随你。"
    if kind == "landmark_arrival":
        return "想四处看看、说一句，还是继续走，都随你。"
    if kind == "task_milestone":
        return "想跟哥哥提一句、自己记着，还是先不说，都随你。"
    return "想管就管，不想管就不管。"


def capsule_options(fact: dict) -> list[dict]:
    """封闭选项集：给观测与验收用，不直接塞进 prompt 当菜单。"""
    keys = KIND_OPTIONS.get(str(fact.get("kind") or ""), tuple(OPTIONS))
    return [{"key": key, "label": OPTIONS[key][0]} for key in keys]


def build_capsule(fact: dict, decision: dict | None = None, visual: str = "") -> dict:
    """事实行 + decision → 一条可注入 L1 的 capsule。

    visual：P5 截图后的视觉摘要（没有就是空串，capsule 保持纯结构化）。
    """
    text = capsule_text(fact)
    hint = capsule_hint(fact)
    visual = str(visual or "").strip()
    if visual:
        text = f"{text}（你瞄了一眼：{visual}）"
    return {
        "candidate_id": str(fact.get("id") or ""),
        "kind": str(fact.get("kind") or ""),
        "subject": str(fact.get("subject") or ""),
        "text": text,
        "hint": hint,
        "options": capsule_options(fact),
        "visual": visual,
        "decision": (decision or {}).get("decision"),
        "attention": ((decision or {}).get("scores") or {}).get("attention"),
        "at": int(_num((decision or {}).get("at"), 0)),
    }


def capsule_prompt(capsule: dict) -> str:
    """拼成注入 L1 的那条 user 消息。"""
    return f"（你注意到）{capsule.get('text', '')}{capsule.get('hint', '')}"


def classify_action(say: str, intention: str) -> str:
    """她这一轮实际做了什么：动手 / 只是说 / 什么都没做。

    「记住」不靠模型表态：被注意到的事实与她的话一起写进经历账本和记忆，
    所以只要没派活没说话，就是 ignore；说过话就自然算记住了。
    """
    if str(intention or "").strip():
        return "act"
    if str(say or "").strip():
        return "express"
    return "ignore"


class CapsuleLog:
    """P4.4 胶囊流水：一条 capsule 一行，含她这一轮的反应。

    append-only：唤醒时先写一行（reaction 待填），任务回调回来后再写一行同 id 的
    更新（outcome），读侧按 candidate_id 取最后一行。这样状态机崩了也不丢「她注意到了什么」。
    """

    def __init__(self, path) -> None:
        self.path = Path(path)

    def append(self, row: dict) -> dict:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            pass
        return row

    def rows(self) -> list[dict]:
        try:
            text = self.path.read_text(encoding="utf-8")
        except OSError:
            return []
        out = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                out.append(row)
        return out

    def latest(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for row in self.rows():
            cid = str(row.get("candidate_id") or "")
            if cid:
                out[cid] = row
        return out


def capsule_say_ok(text: str) -> bool:
    """capsule 只接受人话：拦掉把括号旁白、JSON、坐标当回复的情况。"""
    cleaned = str(text or "").strip()
    if not cleaned:
        return False
    if re.search(r"[{}]", cleaned) or "latitude" in cleaned.lower():
        return False
    return True
