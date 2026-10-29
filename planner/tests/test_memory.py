# planner/tests/test_memory.py —— 记忆模块纯单测：世界分区、双池召回、衰减、去重、对话持久化。
# 用法：/home/asumi/miniconda3/envs/yuki/bin/python planner/tests/test_memory.py
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import prompts  # noqa: E402
from history import HistoryStore  # noqa: E402
from memory import MemoryStore  # noqa: E402

passed = 0
failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} | {detail}")


class FakeIndex:
    """假向量索引：固定相似度，用来验证双池融合与覆盖率保底分。"""

    def __init__(self, hits):
        self.ok = True
        self.hits = hits

    def sync(self, entries):
        return True

    def add(self, entries):
        return None

    def query(self, text, n):
        return dict(self.hits)


def new_store(tmp, name="m", **kwargs):
    params = {"vector": False, "keep": 100, "pool": 10, "inject": 3}
    params.update(kwargs)
    return MemoryStore(Path(tmp) / name / "memory.jsonl", **params)


tmp_root = Path(tempfile.mkdtemp(prefix="yuki-mem-"))

# ---------- 1. 基本写入 / 计数 / 上限 ----------
store = new_store(tmp_root)
store.add("diary", "我在山洞口数石头，数到十七就忘了")
store.add("event", "你掉血了喵，血量 8")
check("写入后可读", store.count() == 2)
check("recent 按时间序", store.recent(2)[-1]["text"].startswith("你掉血了"))
check("空正文不写", store.add("diary", "   ") is None)

small = new_store(tmp_root, name="small", keep=50)
for i in range(60):
    small.add("diary", f"第{i}件小事")
check("超出上限截断", small.count() == 50, small.count())
check("上限截断留最新的", small.recent(1)[0]["text"] == "第59件小事")

# ---------- 2. 同一天同文去重 ----------
dup = new_store(tmp_root, name="dup")
first = dup.add("diary", "哥哥让我去挖木头")
second = dup.add("diary", "哥哥让我去挖木头")
check("同日同文去重", first is not None and second is None and dup.count() == 1)
check("不同正文照样写", dup.add("diary", "哥哥让我去打羊") is not None)

# ---------- 3. 关键词召回：话题对得上 ----------
kw = new_store(tmp_root, name="kw")
kw.add("diary", "哥哥让我去挖木头，我在橡树林砍了二十根原木")
kw.add("diary", "山脚下有一群羊，我打了三只，掉了羊毛和羊肉")
kw.add("diary", "我不小心掉进岩浆，血掉到 3，好不容易爬出来")
top = kw.recall("去挖点木头回来盖房子")
check("关键词召回命中木头", "木头" in top[0]["content"], top[0]["content"])
check("召回条数受 inject 约束", len(top) <= 3)
check("召回按时间升序返回", [item["ts"] for item in top] == sorted(item["ts"] for item in top))

# ---------- 4. 没有锚点词时给最近的事兜底 ----------
none_hit = kw.recall("zzzz")
check("无命中走最近兜底", len(none_hit) == 3 and "木头" in none_hit[-1]["content"], [i["content"][:8] for i in none_hit])

# ---------- 5. 时间衰减：有下限、老条目更低 ----------
now = time.time()
fresh = {"ts": now}
old = {"ts": now - 400 * 86400}
check("新条目衰减≈1", abs(kw._recency_decay(fresh, now=now) - 1.0) < 1e-6)
check("老条目不低于下限", kw._recency_decay(old, now=now) >= kw.recency_floor - 1e-9)
check("老条目衰减更狠", kw._recency_decay(old, now=now) < kw._recency_decay(fresh, now=now))

# ---------- 6. 双池融合：向量池命中 + 关键词池打捞 ----------
dual = new_store(tmp_root, name="dual")
a = dual.add("diary", "我在河边搭了个小木屋")
b = dual.add("diary", "我在矿洞里挖了煤")
c = dual.add("diary", "哥哥说要一起去看日落")
dual.vector_enabled = True
dual._index = FakeIndex({a["id"]: 0.95})          # 语义池只给最像的那条
merged = dual.recall("小木屋的屋顶要怎么盖")
ids = [item["content"] for item in merged]
check("向量池条目入选", "小木屋" in ids[0], ids)
check("关键词池能捞回来", any("木屋" in text for text in ids))
check("debug 带来源标记", any("语义池" in item["debug"] for item in merged))

# 向量池空、只剩关键词池时也要有分（覆盖率当保底）
dual._index = FakeIndex({})
fallback = dual.recall("矿洞里的煤")
check("无向量命中仍可关键词召回", fallback[0]["content"].startswith("我在矿洞里"), fallback[0]["debug"])

# ---------- 7. 世界分区：两个库互不串味 ----------
w1 = new_store(tmp_root, name="world-a")
w2 = new_store(tmp_root, name="world-b")
w1.add("diary", "在这个世界我养了一条狗")
w2.add("diary", "这个世界只有沙漠和仙人掌")
check("世界 A 只召回 A", all("狗" in item["content"] for item in w1.recall("狗")))
check("世界 B 看不到 A", all("狗" not in item["content"] for item in w2.recall("狗")))
check("两个世界索引文件分开", (Path(tmp_root) / "world-a").is_dir() and (Path(tmp_root) / "world-b").is_dir())

# ---------- 8. 对话持久化 ----------
hist_path = Path(tmp_root) / "world-a" / "history.json"
hist = HistoryStore(hist_path, max_entries=12)
check("没有文件时是空历史", hist.load() == [])
messages = [
    {"role": "user", "content": f"第{i}句"} if i % 2 == 0 else {"role": "assistant", "content": f"回第{i}句"}
    for i in range(20)
]
hist.save(messages)
loaded = hist.load()
check("落盘后可读回", len(loaded) == 12 and loaded[-1]["content"] == "回第19句", loaded[-1:])
check("超上限只留最近", loaded[0]["content"] == "第8句", loaded[0])

hist_path.write_text("{这不是 json", encoding="utf-8")
check("坏文件降级为空", hist.load() == [])

hist_path.write_text('[{"role":"system","content":"x"},{"role":"user","content":""},{"role":"user","content":"在吗"}]', encoding="utf-8")
check("脏条目被过滤", hist.load() == [{"role": "user", "content": "在吗"}])
check("tmp 文件不残留", not Path(f"{hist_path}.tmp").exists())

# ---------- 9. 回忆注入格式 ----------
block = prompts.recall_block(
    [{"at": "10-28 22:40", "content": "我在山洞口数石头"}, {"at": "", "content": "哥哥说晚安"}, {"content": "  "}]
)
check("注入带【回忆】前缀", block.startswith("【回忆】"), block[:20])
check("注入带时间前缀", "· 10-28 22:40 我在山洞口数石头" in block, block)
check("空内容丢弃", block.count("·") == 2, block)
check("空列表返回空串", prompts.recall_block([]) == "")

# ---------- 10. 真向量索引（缺依赖则跳过） ----------
try:
    import chromadb  # noqa: F401
    from sentence_transformers import SentenceTransformer  # noqa: F401

    model_path = Path("/home/asumi/Yuki/models/text2vec-base-chinese")
    if not model_path.exists():
        print("SKIP 真向量索引（模型路径不存在）")
    else:
        real = MemoryStore(
            Path(tmp_root) / "vec" / "memory.jsonl",
            vector_path=Path(tmp_root) / "vec" / "chroma",
            embed_model=model_path,
            inject=2,
            pool=12,
        )
        real.add("diary", "哥哥让我去挖木头，我在橡树林砍了二十根原木")
        real.add("diary", "我不小心掉进岩浆，血掉到 3")
        real.add("diary", "羊群在山脚下吃草")
        ready = real.warmup()
        check("向量索引可建立", ready, real.notes)
        hits = real.recall("去树林里砍树")
        check("语义召回命中木头", "原木" in hits[0]["content"], [i["content"][:12] for i in hits])
        # 新条目写进索引后，立刻查得到
        real.add("diary", "我在沙漠里找仙人掌")
        again = real.recall("仙人掌在哪")
        check("新增条目即时可召回", any("仙人掌" in item["content"] for item in again))
        # 重建（模拟索引被删）
        import shutil

        shutil.rmtree(Path(tmp_root) / "vec" / "chroma", ignore_errors=True)
        real2 = MemoryStore(
            Path(tmp_root) / "vec" / "memory.jsonl",
            vector_path=Path(tmp_root) / "vec" / "chroma",
            embed_model=model_path,
            inject=2,
        )
        check("索引丢失能自愈", real2.warmup() and any("仙人掌" in item["content"] for item in real2.recall("仙人掌")))
except ImportError as exc:
    print(f"SKIP 真向量索引（{exc}）")

# ---------- 11. 一轮对话：回忆注入 + 历史落盘 + 重启接得上 ----------
import asyncio  # noqa: E402

import config  # noqa: E402
from mind import Mind  # noqa: E402

mind_root = Path(tmp_root) / "mind"
config.MEMORY_PATH = mind_root / "memory.jsonl"
config.HISTORY_PATH = mind_root / "history.json"
config.MIND_STATE_PATH = mind_root / "mind.json"
config.NOTES_PATH = mind_root / "places.json"
config.VECTOR_PATH = mind_root / "chroma"
config.MEMORY = {**config.MEMORY, "vector": False, "inject": 2}


class FakeLLM:
    def __init__(self):
        self.calls = []

    async def chat(self, messages, **kwargs):
        self.calls.append(messages)
        return {"content": "嗯嗯，人家记得的", "tool_calls": []}


class FakeSidecar:
    async def state(self):
        return {}, True


def seeded_mind():
    mind = Mind(FakeLLM(), FakeSidecar(), None)
    mind.memory.add("diary", "哥哥让我去挖木头，我在橡树林砍了二十根原木")
    mind.memory.add("diary", "羊群在山脚下吃草，我打了三只")
    return mind


async def scenario():
    mind = seeded_mind()
    result = await mind.chat("xiaochi2788", "还记得我们砍木头吗")
    sent = mind.llm.calls[-1]
    joined = "\n".join(str(message.get("content")) for message in sent)
    check("回忆注入到 prompt", "【回忆】" in joined and "原木" in joined, joined[:120])
    check("回忆不进历史", all("【回忆】" not in str(item.get("content")) for item in mind.history))
    check("状态行仍在当轮 user 末尾", "（当前状态" in str(sent[-1]["content"]))
    check("本轮有回话", bool(result.get("say")), result)

    # 重启：新 Mind 应该接着上次的对话
    reborn = Mind(FakeLLM(), FakeSidecar(), None)
    check("重启后历史还在", len(reborn.history) == len(mind.history) >= 2, len(reborn.history))
    check("重启后历史内容一致", reborn.history[-2:] == mind.history[-2:], reborn.history[-2:])
    check("重启后记忆还在", reborn.memory.count() == 2)
    await reborn.chat("xiaochi2788", "继续")
    check("重启后能继续写历史", len(reborn.history) > len(mind.history))
    return mind


asyncio.run(scenario())

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
