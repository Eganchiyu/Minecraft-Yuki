# Yuki × Minecraft — 住在方块世界里的 AI 虚拟玩家

[![Python Version](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![Node.js Version](https://img.shields.io/badge/node-22.23+-green.svg)](https://nodejs.org/)
[![Mineflayer](https://img.shields.io/badge/mineflayer-4.39.0-orange.svg)](https://github.com/PrismarineJS/mineflayer)
[![DeepSeek](https://img.shields.io/badge/LLM-DeepSeek--Flash-green.svg)](https://www.deepseek.com/)

> **"哥哥大人，这个全都是方块的世界好神奇！Yuki 会努力学着挖矿的，不会再掉进岩浆里啦！"**

本项目是将个人智能助手「Yuki」接入 Minecraft（我的世界）的独立 Embodied AI（具身智能）适配层。有别于为了刷 Benchmark 或速通而设计的无感情 Agent 框架，本项目的核心目的是**让 Yuki 作为一个有血有肉的玩家在 MC 世界里生活**。她听得懂自然语言，会自主寻路挖矿，遇到怪会逃跑，也会在无聊时自己到处乱逛，并且能在干活的同时陪你聊天。

---

## 核心特性

### 🧠 三层解耦系统 (分层 Agent 架构)
系统将“大脑”与“小脑/脊髓”彻底分离，保证人格不降智、动作不卡顿：
- **L1 灵魂层 (Python `planner/`)**：负责 Yuki 的情绪、记忆、自主意识和日常聊天。只有当她决定“要动手”时，才会调用唯一的 `intention` 工具。
- **L2 规划器 (Python `planner/`)**：无状态的翻译官兼领域专家，将“去挖20个圆石”转化为机器可执行的 JSON 步骤。先由 `domains.py` 按关键词分流（采集/合成/交互/移动/战斗），只把该域的技能表与该域的 MC 常识交给它——功能越加越多，L2 的上下文不跟着涨。收尾时它还能留一句 `notes` 提醒 L1（事实归 L2，措辞归 L1）。配备单任务预算（Tokens/重试次数限制），防止死循环烧钱。
- **L3 侧车执行器 (Node.js `yuki-bot/`)**：基于 Mineflayer 的常驻状态机，负责所有毫秒级的 tick 响应、硬校验（方块增量、坐标到达）与底层运动闭环。

### 🤝 失败协商机制 (Negotiation)
L2 并不是“全知全能”的。当执行器（L3）遇到无法解决的物理障碍（如缺工具、找不到方块、路不通），它会向 L2 返回**结构化事实**。L2 自动重规划两次后若仍失败，会向 L1 提供 2-3 个人类可读的可选方案，由 Yuki 自己决定是“先去造一把木镐”还是“算啦，换个事做”。

### 🛡️ 脊髓反射 (Reflex) — 不经 L2，也不等 L1
一直跑的状态机（`sidecar/guardian.js`），模型无权干涉：

| 状态 | 什么时候 | 做什么 |
|---|---|---|
| `idle` | 没事 | 每 250ms 扫周围 10 格的敌对生物 |
| `defend` | 有怪且打得过 | 走 mineflayer-pvp 追击、走位、举盾 |
| `flee` | 苦力怕 / 寡不敌众 / 血 ≤6 / 手无寸铁且带伤、岩浆、虚空 | 吃一口再退开，岩浆里往安全点跑 |
| `recover` | 收手之后 | 吃到饥饿值 ≥18（原版回血线） |
| `mlg` | 掉得够快、离地 ≤3.5 格、身上有水桶 | 瞄落点放水 → 落进去 → 拿空桶把水收回来 |

**自动抢占**：一旦进入 `defend`/`flee`/`mlg`，立刻打断当前 LLM 规划的长期任务并占住身体；状态转移会上报 L1，当前状态同时进 `/state`，**L2 规划时也看得见**（"身体正跟怪打"）。

### 📖 独立世界记忆 (Memory & History)
- **世界隔离**：每切换一个存档或服务器，Yuki 都会拥有一个独立的数据分区（`state/worlds/<world>/`），记忆绝不串味。
- **双池召回引擎**：采用 ChromaDB 向量语义检索 + jieba 关键词覆盖率打捞，辅以指数时间衰减，确保她能记住“昨天你让她造的家在哪”。

### ✨ 自适应注意力与体验闭环 (Adaptive Attention)
- **不是无情打工机**：空闲时会触发好奇心循环（Novelty），随机漫游（Roam）、观察新方块或仅仅是发呆。
- **世界观察者 (Observer)**：L3 会自动聚合高频变化（如连续的方块放置、新群系到达）生成候选事实行。
- **记忆辅助注意力 (Attention Engine)**：L1 不会因为每一处改变都大惊小怪。系统结合她的短期账本、长期记忆和当前状态，算出一个注意力分数。只有分数达标且没在忙的时候，才会唤醒她，让她选择是惊讶、走过去看、还是仅仅把这件事记在心里。

---

## 功能玩法大赏

### 1. 随叫随到的小帮手
在公屏打字 `yuki 去挖点石头`。Yuki 会用自己的语气回应一句，然后在后台生成指令去挖石头。
她目前掌握 15 项生存技能，包括：
- `mine`: 采集指定方块（自动判断需要什么工具）。
- `craft`: 递归合成（会自动补齐中间木板木棍，甚至自己放一个工作台）。
- `follow`: “跟着我”，持续追踪，直到你让她停下。
- `goto`: 寻路到特定坐标，自动避障搭桥。
- `deposit` & `open`: 智能寻找附近的箱子并存取物品。
- `smelt`: 用熔炉烧东西（粗铁→铁锭、生肉→熟肉），没有熔炉会自己放一个。
- `sleep` / `use`: 睡一觉跳过夜晚；对门、按钮、拉杆、工作台按右键。
- `roam` / `drop`: 随机在附近闲逛；把东西走到你身边丢给你。

### 2. 边干活边聊天
因为 L1 和 L3 是跨进程解耦的，Yuki 在耗时 3 分钟的下矿过程中，你依然可以随时在公屏问她“你在干嘛呀？”，她能秒回真实进度（如“还差八块石头呢”），并且**完全不中断正在执行的挖矿动作**。

### 3. 造工具与自我修正
如果 Yuki 空手，你让她去挖石头。她不会傻傻地去用手敲，而是会：
1. L3 硬校验发现：缺少对应 `harvestTools`。
2. L2 重规划：发现背包连木头都没有，决定告诉 Yuki “做不到”。
3. Yuki 会对你说：“哥哥，人家没有能挖石头的工具，要不我先去砍点木头造个木镐吧？”

---

## 系统流程

```text
玩家 (公屏聊天) ──┬─→ [L1 Yuki：人格层 + 记忆 + 自然语言] (Python, 按需唤醒)
                 │            │ send_intention()           ▲ 异步汇报/经历胶囊
                 │            ▼                            │
                 └─→ [L2 规划器：中文 → 有序步骤 JSON]  (Python, 自动重试修复)
                              │ JSON Steps                 ▲ 结构化失败事实
                              ▼                            │
                    [L3 侧车：状态机 + 体验聚合 + 技能库] (Node.js, 常驻阻塞)
                              │                            │ 
                              ▼ (Mineflayer API)           │ (Events & State)
                         Minecraft Server (26.1.2) ────────┘

```

---

## 项目结构

```
Yuki-Minecraft/
├── configs/                 # 配置中心 (local.json 包含凭证信息，.gitignore)
├── planner/                 # L1/L2 大脑服务 (Python 3.11)
│   ├── app.py               #   HTTP 服务入口
│   ├── l1.py                #   人格层与失败链条管理
│   ├── mind.py              #   心智主循环（空闲唤醒、日常对话、调用派活工具）
│   ├── schema.py            #   L2 步骤的严格校验器
│   ├── domains.py           #   L2 分域：路由关键词、域内技能表、专家册
│   ├── attention.py         #   记忆辅助注意力引擎 (Shadow)
│   ├── capsule.py           #   经历胶囊生成器 (事实 -> 人话选项)
│   ├── memory.py            #   双池向量召回引擎
│   ├── budget.py            #   单任务预算控制
│   └── state/worlds/<wd>/   #   世界分区数据 (记忆, 历史, 经历, 决策)
│
├── yuki-bot/                # L3 执行器服务 (Node.js 22)
│   ├── sidecar/             #   状态机侧车源码
│   │   ├── index.js         #     HTTP/SSE 事件推送端点
│   │   ├── tasks.js         #     队列、抢占、任务硬终止控制
│   │   ├── guardian.js      #     脊髓反射：四态保命逻辑
│   │   ├── mlg.js           #     落地自救：探落点、放水、收桶
│   │   ├── observer.js      #     世界观察者：实体与方块变化聚类
│   │   ├── experiences.js   #     经历账本存储
│   │   └── skills/          #     矿、走、跟、造、存、打、吃、烧、睡等 15 项技能
│   └── scripts/             #   端到端自动化验收脚本
│
├── docs/
│   └── 技能开发指南.md      #   加一个技能的流程、验证与避坑指南
├── server/                  # 供本地调试用的 MC 服务端目录 (需自备 server.jar)
└── scripts/                 # 一键启停、验证脚本集合

```

---

## 快速开始

### 1. 环境准备

由于本项目直接与 Minecraft 底层协议交互，且涉及双端进程，对环境要求较为严格：

* **Node.js**: ≥ 22.23 (受 Mineflayer 4.39.0 限制)
* **Python**: ≥ 3.11
* **Java**: Java 25 (运行 26.1 版本的 MC 服务端必须)
* **Minecraft**: 游戏与客户端协议必须为 **26.1 (Protocol 775)**。*(注：26.2/Protocol 776 暂不支持)*

### 2. 配置凭据

复制配置文件模板并填入你的大模型 API 密钥：

```bash
cp configs/local.example.json configs/local.json
# 编辑 configs/local.json 填入你的 llm.api_key，默认使用 DeepSeek Flash 接口

```

### 3. 一键起服体验

我们提供了一套集成脚本，能够同时拉起：MC 服务端、Python 规划器、Node.js 执行器侧车。

```bash
# 安装 Python 依赖
cd planner && pip install -r requirements.txt
# 安装 Node 依赖
cd ../yuki-bot && npm install

# 启动常驻世界（自动把 pid 写入临时目录以便关闭）
cd ..
bash scripts/world-up.sh

```

启动成功后，你可以用离线版的 `26.1.2-Fabric` 客户端连接 `127.0.0.1:25565` 进服。在公屏打字包含 `yuki`，她就会理你了。

收工时请**务必优雅停服**（防止存档损坏）：

```bash
bash scripts/world-down.sh

```

---

## 技术栈与设计约束

| 类别 | 选型 | 备注 |
| --- | --- | --- |
| **MC 底层控制** | Mineflayer (Node) | 放弃 Fabric Mod 注入开发。利用无头客户端直接读写协议栈。 |
| **基础小脑控制** | Prismarine 生态 | 复用现成的 pathfinder (A*寻路), collectblock 等插件。 |
| **通信机制** | HTTP + Server-Sent Events | Python 与 Node.js 之间通过短连接派发任务，SSE 推送实时游戏事件（受击、天黑）。 |
| **模型推理** | 云端 API 驱动 | **本机无 GPU 负担**。状态切片经过高度压缩（JSON+结构化文本），实测每轮对话 Token 消耗极低，且配置了 `disable_thinking=true` 以加速响应。 |
| **代码红线** | 原始数据隔离 | MC 每秒海量的 tick 事件、方块全量更新、原始坐标等数据，**坚决不允许进入 L1 大脑**，必须在侧车收敛为简短的中文状态注入或经历胶囊。 |

---

## 致谢

* [PrismarineJS / Mineflayer](https://github.com/PrismarineJS/mineflayer): 提供了难以置信且强大的 Node.js 协议层实现。
* 本项目最初灵感来源于与主系统 `YukiV6` 的接入构想（见 `LLM接入MC方案.md`）。

---

*最后更新：2026/10/31 · P4.1–P4.3（世界观察者与自适应注意力机制）已落地*

---