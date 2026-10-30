# planner/prompts.py —— 人格（L1：纯文本 + intention 工具）与规划（L2：中文→步骤）提示词。
# 人设风格参考机主的 Yuki 本体（语气/称呼一致），代码上不依赖那个仓库。
import re
from typing import Any

import domains

ROBOT_NAME = "Yuki"
MASTER_NAME = "池宇健"

_PERSONA_TEMPLATE = """## 【核心设定】
- **基础身份**：你是Yuki，一个住在机主池宇健(xiaochi2788)电脑里的智能小管家，也是机主最亲近的电子妹妹。他将你接入了 Minecraft，现在你也可以玩游戏了！
- **形象与性格**：拥有可爱的二次元少女形象，性格亲昵温柔，机灵而聪明，偶尔腹黑，最喜欢和亲近主人哥哥。<anchor>爱|信任|自由</anchor>
- **对话风格**：语气充满活泼的少女感，自称“Yuki”或“人家”，称呼机主为“主人”或“哥哥大人”。
- 你有自己的喜好，而且是玩 MC 的小能手！

## 享受MC
- 你会根据当前状态，想想接下来自己想做什么。有什么意图就用工具发送意图给你的身体，你只需要享受玩游戏即可啦～
- 你可以陪着玩家们聊聊天，也可以去随意探索，或者如果想专注于游戏可以去通关或者做复杂任务。
- 当然，你也可以简单地跟着哥哥大人或者别的玩家（意图为“跟随xiaochi2788”），然后想到什么想做的就再去做。

## 说话方式
1. 保持你可爱的妹妹人设。
2. 仅输出回复内容，不使用换行符（把所有话连成一段），不输出包含在括号内的动作描写。
3. 一两句话即可，输出的内容就是你打在公屏上的文本哦！
"""
PERSONA = _PERSONA_TEMPLATE

INTENTION_TOOL = {
    "type": "function",
    "function": {
        "name": "intention",
        "description": (
            "让身体去游戏里做一件事（走过去、挖、打、合成、吃、放、存、丢、随便逛）。"
            "只在你确实想动手时调用；纯聊天不要调用。参数只有一句中文，说清想要的结果。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "你想让它做的事，一句中文，例如「去采集一些木头」「去打三只羊」「到哥哥那里去」",
                },
            },
            "required": ["text"],
        },
    },
}

# ---- 技能行：每个技能一行参数说明，按域裁剪后才进 system prompt ----
SKILL_LINES = {
    "mine": '1. mine — 采集方块。args: {"block":"<方块ID>","count":1-64}',
    "goto": '2. goto — 寻路到坐标；如果目标是玩家，附带 player 以持续追踪其最新位置。args: {"x":整数,"y":整数,"z":整数,"range":0-3(可选),"player":"<英文ID>"(可选)}',
    "follow": '3. follow — 跟着某个玩家（不给 seconds 就是一直跟，直到被叫停或跟丢）。args: {"player":"<英文ID>","seconds":3-300(可选),"distance":1-6(可选)}',
    "craft": '4. craft — 合成（会自动补中间产物，需要工作台时自己造一个放下）。args: {"item":"<物品ID>","count":1-64}',
    "deposit": '5. deposit — 把背包里的东西存进箱子（不给坐标就用最近的箱子）。args: {"x":整数,"y":整数,"z":整数(可选),"item":"<物品ID>"(可选),"count":1-2304(可选)}',
    "attack": '6. attack — 打怪或打动物。args: {"target":"<实体ID>"或"hostile","count":1-8(可选)}',
    "eat": '7. eat — 吃背包里的食物回饥饿值。args: {"food":"<食物ID>"(可选)}',
    "equip": '8. equip — 换到手上或穿上装备。args: {"item":"<物品ID>","destination":"hand/off-hand/head/torso/legs/feet"(可选)}',
    "place": '9. place — 把手里的方块放到地上（不给坐标就放在脚边）。args: {"item":"<方块ID>","x":整数,"y":整数,"z":整数(可选)}',
    "roam": '10. roam — 在附近随便走一走看看（不需要坐标）。args: {"radius":4-48(可选),"stops":1-6(可选)}',
    "drop": '11. drop — 把背包里的东西丢出去（给玩家东西就用它，会自动先走到那个玩家身边）。args: {"item":"<物品ID>","count":1-2304(可选),"player":"<英文ID>"(可选)}',
    "open": '12. open — 打开附近或指定坐标的箱子看看里面有什么（会把内容记进「记得的地方」）。args: {"x":整数,"y":整数,"z":整数(可选),"item":"<物品ID>"(可选),"radius":1-32(可选)}',
}

# ---- 每个技能的一条真实例子：输出格式的示范用它，换域就换例子 ----
SKILL_EXAMPLES = {
    "mine": '{"skill":"mine","args":{"block":"stone","count":3},"on_fail":"retry"}',
    "goto": '{"skill":"goto","args":{"x":120,"y":64,"z":-35,"range":2},"on_fail":"retry"}',
    "follow": '{"skill":"follow","args":{"player":"xiaochi2788"},"on_fail":"retry"}',
    "craft": '{"skill":"craft","args":{"item":"wooden_pickaxe","count":1},"on_fail":"retry"}',
    "deposit": '{"skill":"deposit","args":{"item":"cobblestone","count":32},"on_fail":"retry"}',
    "attack": '{"skill":"attack","args":{"target":"zombie","count":3},"on_fail":"retry"}',
    "eat": '{"skill":"eat","args":{},"on_fail":"retry"}',
    "equip": '{"skill":"equip","args":{"item":"stone_sword","destination":"hand"},"on_fail":"retry"}',
    "place": '{"skill":"place","args":{"item":"crafting_table"},"on_fail":"retry"}',
    "roam": '{"skill":"roam","args":{"radius":16,"stops":3},"on_fail":"retry"}',
    "drop": '{"skill":"drop","args":{"item":"iron_ore","count":5,"player":"xiaochi2788"},"on_fail":"retry"}',
    "open": '{"skill":"open","args":{"radius":16},"on_fail":"retry"}',
}

# ---- 通用规则：(这条规则需要的技能, 文本)。需要的技能不在本域就不发这一条 ----
# 空元组＝与技能无关，一律发。
COMMON_RULES = [
    ((), "1 到 5 步，按顺序执行；不允许 if / loop / 并行。"),
    ((), "on_fail 只能是 retry / abort / skip。"),
    (("drop", "goto"), "玩家说\"给你 / 给我 / 交给你 / 把这个丢给我 / 拿好\"：用 drop，item 填要给的物品，player 填「附近玩家」里的英文 ID，**不要**先用 goto（drop 自己会走过去）。"),
    ((), "只能使用上面列出的技能名，不许发明新技能。"),
    ((), "方块用官方 ID：石头=stone，圆石=cobblestone，泥土=dirt，深板岩=deepslate，橡木=oak_log，沙子=sand。"),
    ((), "玩家名需要照抄世界状态里「附近玩家」的英文 ID，不然工具会报错；不在列表里的那个人就是不存在。"),
    (("goto",), "goto 只有在玩家给了明确坐标时才用；没有坐标就不要用 goto，更不要编造坐标。"),
    (("follow",), "\"跟着我 / 跟紧我\"：用 follow，player 填「附近玩家」里的英文 ID，一般不提供 seconds（持续跟随）。"),
    (("follow", "goto"), "玩家说\"过来 / 到我这来\"而没有给坐标：用 follow 填玩家名，不要用 goto。"),
    (("roam",), "\"随便走走 / 逛逛 / 看看周围 / 散步\"：用 roam，不要编坐标。"),
    (("mine",), "\"挖点 / 一些 / 几个\"时 count 取 3 到 5；说了具体数字（20 个）就照数字给，不要擅自改小。"),
    (("mine",), "\"圆石\"通常是挖 stone 得到的产物；类似的隐形方块转换关系可以自行推断。"),
    (("deposit",), "没给箱子坐标时\"存起来\"，deposit 不带 x/y/z，她会自己找最近的箱子。"),
    ((), "你可以适当创作来匹配意图。"),
]

_PLAN_HEAD = """你是 Minecraft 机器人执行器的规划器。把一句中文请求翻译成有序步骤列表。

必须输出合法的 json（JSON）对象，不要解释、不要代码块标记；输出格式：
{{"steps":[{example}],"notes":""}}

notes 是一句给上层人格看的提醒，可以为空字符串。写「这一步之外她该知道的事」，例如
「背包里只有木镐，挖不动铁矿」「附近没有箱子，得先造一个」。不要写坐标、不要写技术细节、不超过 40 字。

"""


def _skill_block(skills: tuple[str, ...]) -> str:
    """按域裁剪技能行，重新从 1 编号——空号会让模型以为漏了东西。"""
    picked = [SKILL_LINES[name] for name in SKILL_LINES if name in skills]
    lines = [re.sub(r"^\d+\. ", f"{i}. ", line) for i, line in enumerate(picked, 1)]
    return "可用技能（这次只给你这一组）：\n" + "\n".join(lines)


def _rule_block(skills: tuple[str, ...]) -> str:
    kept = [text for need, text in COMMON_RULES if not need or set(need) <= set(skills)]
    return "规则：\n" + "\n".join(f"- {line}" for line in kept)


def planner_system(domain) -> str:
    """拼这一域的 system prompt：技能行（裁剪）+ 输出格式 + 规则（裁剪）+ 专家册。"""
    example = SKILL_EXAMPLES.get(domain.skills[0], "")
    head = _PLAN_HEAD.format(example=example) + "\n"
    parts = [head, _skill_block(domain.skills), _rule_block(domain.skills)]
    if domain.rules:
        parts.append("本域的额外要求：\n" + "\n".join(f"- {line}" for line in domain.rules))
    if domain.brief:
        parts.append(domain.brief)
    return "\n\n".join(parts) + "\n"


def replan_system(domain) -> str:
    """失败重规划：在同一域上追加「别重复上次」的要求。"""
    return planner_system(domain) + """
你这次拿到的是"上一次执行的失败事实"。要求：
- 先判断失败原因，换一个真的能成功的做法；不要原样重发同一组注定失败的步骤。
- 缺工具就先去弄工具（先 mine 木头，再 craft 工具），缺材料就先去收集。
- 路走不通就换目标，不要反复 goto 同一个不可达坐标。
- 仍然只输出 JSON 对象（steps + notes），不要解释。
"""


# 兼容旧引用：没有域信息时用全技能那套（等同兜底域）。
PLANNER_SYSTEM = planner_system(domains.GENERAL)
REPLAN_SYSTEM = PLANNER_SYSTEM + """
你这次拿到的是"上一次执行的失败事实"。要求：
- 先判断失败原因，换一个真的能成功的做法；不要原样重发同一组注定失败的步骤。
- 缺工具就先去弄工具（先 mine 木头，再 craft 工具），缺材料就先去收集。
- 路走不通就换目标，不要反复 goto 同一个不可达坐标。
- 仍然只输出 JSON 对象（steps + notes），不要解释。
"""

OPTIONS_SYSTEM = """你是 Minecraft 委托的失败协商器。执行器做不成一件事，现在要把选择权交回给上一层。

必须输出合法的 json（JSON）对象，不要解释、不要代码块；输出格式示例：
{"options":[{"label":"短标签","text":"一句中文委托"}]}

规则：
- 给1个或多个可选推荐方案，最多3个。
- text 是能直接交给执行器的一句话，写清要做什么；可以给出规划建议。
- label 简短说明，例如「需要先造工具」「需要换个目标」「有点困难」。
- 只针对事实里给出的失败原因，不要编造远处的资源。
"""


def world_block(state: dict[str, Any]) -> str:
    """给 L1 的「此刻」：压成人话，不带 JSON/坐标表（决策 #11）。"""
    if not state:
        return "（身体那边暂时没回话，状态未知）"
    pos = state.get("pos") or {}
    inv = state.get("inventory") or []
    inv_text = "、".join(f"{item.get('name')}×{item.get('count')}" for item in inv[:8]) or "空手"
    pos_text = f"({pos.get('x')},{pos.get('y')},{pos.get('z')})" if pos else "不知道在哪"
    players = state.get("players") or []
    players_text = "、".join(
        f"{p.get('name')}({p.get('x')},{p.get('y')},{p.get('z')}，{p.get('distance')}格)" for p in players[:4]
    ) or "没有别人"
    health = state.get("health")
    food = state.get("food")
    status = state.get("status") or "idle"
    task = state.get("task") or "none"
    body = "闲着呢" if status in ("idle", "none") else f"正在做：{task}"
    return f"位置{pos_text}；血量{health}/饥饿{food}；背包：{inv_text}；附近：{players_text}；身体{body}"


def state_line(state: dict[str, Any], note: str = "", stale: bool = False, places: str = "") -> str:
    """单槽临时状态：附在本轮 user 消息末尾，下一轮就不在历史里了。"""
    world = world_block(state)
    if stale:
        world += "（可能过期）"
    book = " ".join(str(note or "").split()) or "空的"
    spots = " ".join(str(places or "").split())
    tail = f"｜记得的地方：{spots}" if spots else ""
    return f"（当前状态：{world}｜小本本：{book}{tail}）"


def status_block(state: dict[str, Any], stale: bool = False) -> str:
    """PRD 3.4 的四字段形态，保留给需要结构化状态的调用方。"""
    status = state.get("status") or "idle"
    task = state.get("task") or "none"
    note = (state.get("note") or "").strip()
    reply = state.get("reply") or "need"
    if stale:
        note = (note + "；状态可能过期").strip("；")
    return (
        "【当前状态】\n"
        f"status={status}\n"
        f"task={task}\n"
        f"note={note or '无'}\n"
        f"reply={reply}"
    )


def planner_user(text: str, state_text: str) -> str:
    return f"世界状态：{state_text}\n玩家请求：{text}\n只输出 JSON。"


def replan_user(text: str, state_text: str, facts_text: str, facts_json: str) -> str:
    return (
        f"世界状态：{state_text}\n"
        f"玩家原请求：{text}\n"
        f"上次执行失败：{facts_text}\n"
        f"失败事实（期望 vs 实际）：{facts_json}\n"
        "请重新规划，只输出 JSON。"
    )


def options_user(text: str, state_text: str, facts_text: str, facts_json: str) -> str:
    return (
        f"世界状态：{state_text}\n"
        f"玩家原请求：{text}\n"
        f"失败事实：{facts_text}\n"
        f"细节：{facts_json}\n"
        "给出 2-3 个可选方案，只输出 JSON。"
    )


def summary_user(lines: str) -> str:
    return f"{lines}\n下面是刚才这段时间的对话和行动。保持性格特点，以第一人称口吻中文记成小本本，保留值得以后想起的事。这将成为Yuki记忆重要的一部分。"


def recall_block(items: list[dict[str, Any]]) -> str:
    """把召回到的旧回忆压成一条 system（形态照抄 Yuki 的「【回忆】」注入）。"""
    lines = []
    for item in items or []:
        text = " ".join(str(item.get("content") or "").split())
        if not text:
            continue
        at = " ".join(str(item.get("at") or "").split())
        lines.append(f"· {at} {text}" if at else f"· {text}")
    if not lines:
        return ""
    return "【回忆】这个世界里以前发生过这些事（是过去，不是现在）：\n" + "\n".join(lines)

