# HANDOFF · Yuki × Minecraft 交接文档

> 这是跨 session 的唯一事实入口。**每次开工先读本文第 0–4 节，收工必须更新第 2、3 节并在 `memo/Log.md` 追加一条。**

## 文档职责（避免多处改不同步）

| 文件 | 是什么 | 谁改 |
|---|---|---|
| `docs/项目公约.md` | 协作规则、技术红线、代码/文档/验收纪律 | 规则变化时 |
| `PRD.md` | 产品定义：架构、接口契约、阶段与验收 | 需求变化时才改 |
| `HANDOFF.md`（本文） | 当前进度、下一步、环境命令、已踩坑、冻结决策 | 每次 session 必改第 2、3 节 |
| `memo/Log.md` | 时间线流水账（append-only，只加不改） | 每次 session 追加 |
| `LLM接入MC方案.md` | 早期与 Gemini 讨论的原始方案（历史参考，非当前设计） | 不再维护 |

---

## -1. 给新 session 的上下文简报（先读这一节，够开工了）

**项目**：把人格 Agent「Yuki」接进 Minecraft，让她以玩家身份生活、听得懂人话、有自己的喜好。长周期迭代，预计跨几十个 session。

**Yuki 是什么**：机主自己写的个人助手 / "电子妹妹"，Python 项目在 `/home/asumi/Yuki`（独立 git 仓库）。已具备：人格 prompt 体系（`core/prompts.py`）、OpenAI 兼容 LLM 调用、原生 tool calling（`core/toolchain.py` 的 `ToolSpec` / `FunctionRegistry`）、模式系统（`core/modes.py`，已有"浏览器交互模式"先例）、Chroma 记忆与日记（`rag.save_diary()` / `YukiMemoryStore`）、会话流水线（`core/session_pipeline.py`）。**它不是通用 Agent 框架，别重造它已有的东西。**

**技术栈**

| 层 | 用什么 |
|---|---|
| MC 客户端（bot） | **Mineflayer 4.39.0**（Node，无头，纯协议实现，**不是 Mod、没有图形渲染**）+ 官方插件生态：pathfinder（A\* 寻路）、collectblock（采集）、pvp（战斗）、tool（选工具）、armor-manager（穿装备）、auto-eat（进食）、statemachine（行为库） |
| 协议/数据 | minecraft-protocol + minecraft-data（决定版本上限：26.1 = 775） |
| 编排层 | Node 侧车（状态机 + 技能库 + 保命逻辑），Python 侧只做无状态 `/plan` |
| 模型 | Yuki 现有 OpenAI 兼容 API（`deepseek-flash`），`disable_thinking=true` |
| MC 服务端 | 官方 26.1.2 server.jar，Java 25 |
| 截图 | 原版客户端 spectator 观战 + `ffmpeg x11grab`（无 Mod） |

**必须知道的 Mineflayer 常识**

- bot 是**服务端视角的全知假玩家**：实体、方块更新、聊天、伤害源全拿得到，但**看不到画面**（无渲染管线）。所以"视觉"要另外截屏。
- 没有内置寻路，"走到某处"= `mineflayer-pathfinder` 的 `bot.pathfinder.setGoal(new goals.GoalNear/GoalBlock/...)`。
- 动作是异步长任务（挖矿可能几十秒），中断靠覆盖 goal / 主动 cancel，不是靠返回值。
- 版本支持靠 `minecraft-data`：当前上限 26.1，26.2 直接连不上。
- 具体 API 陷阱见第 5 节（`prismarine-item` 工厂、pvp 先 `setMovements`、auto-eat 用 `enableAuto` 等）。

**阅读顺序**：本节 → 第 0 节命令 → 第 2 节状态 → 第 3 节下一步。需要改需求时再读 `PRD.md`；动手前读 `docs/项目公约.md` 的红线。

---

## 0. 三十秒上手

```bash
# 主服（你的存档世界，玩家连这个）
cd /home/asumi/Minecraft/server && /usr/lib/jvm/java-25-openjdk-amd64/bin/java -Xms1G -Xmx2G -jar server.jar nogui

# 实验场（creative + op，插件/技能测试用，端口 25566）
cd /home/asumi/Minecraft/server-test && /usr/lib/jvm/java-25-openjdk-amd64/bin/java -Xms1G -Xmx1536M -jar server.jar nogui

# L1/L2 服务（人格回复 + 中文→步骤，:8791；先起它，sidecar 会回调）
cd /home/asumi/Minecraft/planner && /home/asumi/miniconda3/envs/yuki/bin/python app.py

# L3 侧车（bot 连 :25565，暴露 :8790：/intention /cancel /state /events /say）
cd /home/asumi/Minecraft/yuki-bot && node sidecar/index.js

# M0 一键验收（起服 -> 预置镐子与石头 -> 跑验收 -> 全部停掉）
cd /home/asumi/Minecraft && bash scripts/m0-run.sh

# P1 一键验收（起服 -> 侧车 -> 三套固定场景 + 队列/守护/存取链，不调模型）
cd /home/asumi/Minecraft && bash scripts/p1-run.sh

# P2 一键验收（起服 -> planner + 侧车 -> 单测 + 10 次挖矿 + 不可达升级 + 预算）
cd /home/asumi/Minecraft && bash scripts/p2-run.sh

# 常驻世界（给机主进服造访用；含主服 + planner + 侧车）
cd /home/asumi/Minecraft && bash scripts/world-up.sh
cd /home/asumi/Minecraft && bash scripts/world-down.sh

# 已有常驻世界时，只跑 P2 的失败升级场景（不需要 FIFO，不重启服务器）
cd /home/asumi/Minecraft/yuki-bot && node scripts/p2-test.js --only=diamond

# 旧的单体最小闭环（仅登录/寻路/聊天指令，不含 L2）
cd /home/asumi/Minecraft/yuki-bot && node scripts/yuki.js

# 插件兼容性回归（需要 :25566 在跑）
cd /home/asumi/Minecraft/yuki-bot && node scripts/compat-test.js

# 抓一帧屏幕（客户端必须在 :0.0 上可见）
ffmpeg -loglevel error -f x11grab -video_size 1920x1080 -i :0.0 -frames:v 1 -y /tmp/shot.png
```

**停机（收工必做，机器只有 7GB 内存）**

```bash
# 1) 先看谁在跑，拿到 PID（不要盲杀）
pgrep -af 'jar server.jar'      # 两个服务端
pgrep -af 'node sidecar/index'  # L3 侧车
pgrep -af 'planner/app.py'      # L1/L2 服务
pgrep -af 'node scripts/yuki'   # 旧单体 bot

# 2) 按 PID 优雅停服（SIGTERM 会保存世界后退出，exit code 143 属正常）
kill -TERM <server_pid> <test_server_pid>
kill -TERM <sidecar_pid> <planner_pid>

# 3) 确认端口已释放、内存已回收
ss -lntp | grep -E '25565|25566|8790|8791' || echo "ports free"
free -g | head -2

# 一键验收脚本（scripts/m0-run.sh）自带 trap 收尾，正常跑完自己会停干净
```

> ⚠️ 不要用 `pkill -f 'scripts/yuki.js'` 这种模糊模式：它会**匹配到你自己所在的 shell**（命令行里含同样字符串）并把自己杀掉。本项目已踩过一次。

**常驻进程**：主服 :25565、实验场 :25566、L3 侧车 `sidecar/index.js`（:8790）、L1/L2 `planner/app.py`（:8791）。`scripts/world-up.sh` 会起主服 + 两个服务并把 PID 放 `/tmp/yuki-world/`，`world-down.sh` 优雅全停；调试期默认收工即停，只有机主明确要进服造访时才常驻。

玩家侧：客户端版本固定 **26.1.2-Fabric**，地址 `127.0.0.1:25565`，离线模式，用户名任意。

---

## 1. 环境事实（硬约束，不要试图绕过）

| 项 | 值 |
|---|---|
| Node / npm | 22.23.3 / 10.9.9（mineflayer 要求 ≥22） |
| Java | 17 + **25**（26.x 服务端必须 25：`/usr/lib/jvm/java-25-openjdk-amd64`） |
| 协议 | 26.1 = 775，mineflayer/minecraft-data 支持上限；**26.2 = 776 不支持** |
| GPU | **无 NVIDIA**，内存 7GB 且占用高 → 任何本地小模型方案不可行 |
| 显示 | X11 `:0.0`，有 `ffmpeg` / `xwd`，无 grim/maim/scrot/xdotool |
| Python | **`/home/asumi/miniconda3/envs/yuki/bin/python`**（3.11 + aiohttp 3.14；系统 python3 没有 aiohttp/yaml） |
| 模型 | OpenAI 兼容 API（`deepseek-flash`，实测 tool calling 可用），`disable_thinking: true`；凭据在 `configs/local.json`（gitignore，不入库） |
| 端口 | 主服 25565 / 实验场 25566 / L3 侧车 8790 / L1+L2 8791 |

---

## 2. 当前状态（2026-10-30 收工，P4 前）

**一句话**：P0–P3 全通，15 项技能 + L2 分域专家 + 四态反射机（含 MLG）已落地；世界当前**全停**（25565/25566/8790/8791 空）。下一步是 PRD v0.3 的 **P4 体验闭环**，从 P4.0（观战截图链路验证）开始。

**已完成（按时间）**

- P0 / M0 / P1 / P2：见 `memo/Log.md`。最新数字：P1 19/19、P2 挖矿 7/10（3 次为守护抢占）、真实规划 0 非法 JSON
- P3：本仓库独立 L1（人格 prompt + 唯一 `intention` 工具）、任务回调、单槽状态注入、`rest`、低优先级事件 30s 聚合、idle tick、`/home/asumi/Yuki` 不接（决策 #15 保持）
- 记忆：世界分区 `planner/state/worlds/<world>/`（history / memory.jsonl / chroma），向量 + jieba 双池召回，43/43 单测
- L2 分域：`domains.py` 5 域 + 兜底 general，域内技能白名单 + 专家册 + `notes` 回流 L1；44/44 单测
- 技能 15 个：mine goto follow craft deposit attack eat equip place roam drop open smelt sleep use（加技能流程见 `docs/技能开发指南.md`）
- `guardian.js` 四态机 idle/defend/flee/recover + `mlg` 自救；`reflex-test.js` 29/29、`mlg-test.js` 18/18
- 客户端换肤：CustomSkinLoader 本地皮肤 `Yuki-chan.png`（只对机主客户端可见），**尚未肉眼验收**

**未验 / 已知欠账**

- `smelt` 未在真服务端跑过一炉（putInput/takeOutput 时序只在单测与源码层验过）
- `mlg` 真实坠落未验（触发 3.5 格、等水 800ms、等落地 3s 均为估算）
- pvp 实战（走位、举盾、苦力怕）未验
- `test_p2.py` 30 过 1 挂（既有「超过 5 步」用例与 `MAX_STEPS=15` 不符，与功能无关）
- 常驻世界默认停；要起用 `bash scripts/world-up.sh`

---

## 3. 下一步：P4 体验闭环（PRD v0.3）

机主定调：**不接持续视觉**。先把「结构化世界 → 注意力筛选 → 压缩经历 → L1 自主反应/忽略 → 经历记忆」跑通，截图只是 P5 的可选传感器。

按顺序做，每步独立可演示：

1. [ ] **P4.0 截图链路人工验证**：起服 + sidecar + spectator 客户端，让 Yuki 移动/转头，确认 `ffmpeg x11grab` 抓到的画面是否跟随；结论写回 PRD/HANDOFF。不同步则截图限定人工触发，不阻塞 P4
2. [ ] **P4.1 经历数据结构与落盘**：`Experience` / `ExperienceCapsule`、去重键、世界分区、过期与截断；纯函数单测（序列化/去重/重启恢复）
3. [ ] **P4.2 World Observer + Event Grouper**：先做 `new_entity`（初遇实体）、`block_change_cluster`（短静默窗口 + 空间相邻的人工方块变化）、`landmark_arrival`、`task_milestone`；不做建筑语义断言
4. [ ] **P4.3 Salience Scorer + Attention Scheduler**：配置化权重（novelty / surprise / interest / social / progress / repeat penalty / interruption cost / confidence）；记录阈值、唤醒阈值、截图阈值三者分开；任务或反射期间只记录
5. [ ] **P4.4 Capsule → L1**：压成一两句人话 + 有限选项（含 ignore/no_action），复用现有事件唤醒路径；行动仍走 intention → L2 → L3；经历写入记忆
6. [ ] **P5（后续）**：Snapshot Scheduler（开关/间隔/配额/稳定窗口）、Vision Adapter、主动观察、爱心端到端验收
7. [ ] **P6（后续）**：按真实使用反馈决定兴趣权重、心愿、mood、锚点；回归与长跑

**P4 总验收**：初遇实体、建造候选、任务里程碑各完成一次「发现 → L1 反应或忽略 → 经历落盘」；外部指令能立即接管低优先级体验行动；任务与守护无明显延迟。

**顺带可做（非 P4 阻塞项）**：`mount` 技能本体、`fish`/`collect`、`smelt` 真服验收。

## 4. 已冻结决策（不要在新 session 里重新讨论）

| # | 决策 | 理由 |
|---|---|---|
| 1 | 版本钉死 26.1（775），不用 26.2 | mineflayer 不支持 776 |
| 2 | 不开发 Fabric Mod，不碰 Java | 机主内存不足；原版 spectator 观战 + 系统截屏已够用 |
| 3 | 截图走 `ffmpeg x11grab`，不用 prismarine-viewer | viewer 渲染上限 1.21.4 |
| 4 | L2 走云端 API，不做本地小模型 | 无 GPU，内存紧张 |
| 5 | 状态机与技能库放 Node 侧车，Python 只提供无状态 `/plan` | 每 tick 要读 bot 状态，跨进程会慢且脆 |
| 6 | L2 只输出**有序步骤列表**，禁止 if/loop/DAG | 解释器可控，LLM 不会生成死锁 |
| 7 | 优先级 9 = 硬编码守护逻辑，L1 只能声明 0–8 | 保命不能被模型覆盖 |
| 8 | inspect 用代码硬校验，失败才回灌模型 | 每步都问模型会拖慢且瞎判 |
| 9 | 抢占：高优先级抢占；同级抢占；低优先级排队（上限 3） | 人设优先，"叫她就来" |
| 10 | L1 状态注入为**单槽、临时、用完即删** | 防上下文膨胀 |
| 11 | MC 原始事件/坐标/背包表**不进 L1**，必须压成人话 | 否则人格被数据淹掉 |
| 12 | 记忆与 QQ 共享，条目打 `scene:mc`，独立 `chat_id=mc:world` | 同一主人，不同场景 |
| 13 | 第一版砍 `smelt`；`craft`/`deposit` 若 GUI 交互受阻可降级 | mineflayer 无现成熔炉插件 |
| 14 | 调试期默认 `play off`，P4 验收后才常驻自主循环 | 省 token、便于复现 |
| 15 | M0 起**不接 Yuki 本体**：人设 prompt 在本仓库独立维护，只参考其语气；未来是否打通另议 | 机主明确要求：本 Bot 与 Yuki 的关联仅是 prompt 一致 |
| 16 | `/plan` 放 Python `planner/` 服务，Node 侧车只执行 | 与 #5 一致；Node 侧不再重复实现规划 |
| 17 | 公屏通道：侧车 `POST planner /chat` 收话、`POST /say` 回话；L1 与身体分离在两个进程 | 身体每 tick 级响应不放 Python，人格调用不阻塞动作 |
| 18 | 测试跑主服 :25565（新世界，机主授权可随便用），不在实验场做挖矿验收 | 实验场是 creative，挖方块不掉落，硬校验无法验证 |
| 19 | `deposit` 用可选 `x/y/z`（缺省自动找 16 格内最近容器），不引入 `container:"nearest_chest"` 这类伪枚举 | 少一层翻译，L2 契约直接对应技能参数（见 PRD 3.2 表） |
| 20 | ~~P1 的 `craft` 只做 2×2，3×3 明确返回 `need_workbench`~~ **已被 #23 取代**（2026-10-28 晚：3×3 已支持，自动放工作台） | 当时是想先不阻塞 P2；实测 bot.craft 支持工作台后直接升级 |
| 21 | 守护逻辑在 `attack` 步骤执行期间只对低血/岩浆抢占，不因"受击"抢占 | 否则打怪时每挨一下就打断自己，attack 技能永远打不完 |
| 22 | **L1 与 L2 是协商关系，不是"L2 什么都会"**：L2 只负责人话→机器步骤，做不了时要把**结构化事实 + 可选方案**交回 L1，由 L1 决定改主意（先造工具 / 换个目标 / 放弃），再下发新意图；L2 不替 L1 做价值判断 | 机主定调：L2 全能不是最优解；L1 是人话、L2 是翻译，两者多轮互动 |
| 23 | `craft` 升级为**自动补中间产物 + 需要 3×3 时自己造/放工作台**；新增 `place` 技能 | 实测 bot.craft 在 26.1 支持工作台，自造木镐链路已跑通（挖木→木板→棍→台→镐→挖石） |
| 24 | 玩家说「圆石」时 L2 默认 `mine stone`（挖石头掉圆石）；只有明确说「现成的圆石方块」才用 `cobblestone` | 实测挖 `cobblestone` 直接 `no_target_block`，白烧一次规划 + 一次重规划 |
| 25 | 新增 `POST /dispatch`（调试/验收通道），跳过人格措辞直接下发，但**仍走完整 Chain（预算 + 失败升级）** | 人格层是否愿意派活会影响验收稳定性；链路本身要能被确定性复现 |
| 26 | 确定性错误（缺工具/没目标/缺材料/没容器等）**不重试**，立刻把事实交回 L2 | 同一组参数必然同样失败，重试纯烧预算和时间（`sidecar/tasks.js` NON_RETRYABLE） |
| 27 | `/state` 必须带**附近玩家真实 ID + 坐标**；「过来」= `goto` 玩家坐标，「跟着我」= `follow` 真实 ID，L2 禁止用中文称呼猜名字 | 实测 L2 曾把「come here」翻成 `follow 小池2788`，中文昵称不是游戏 ID，直接 `player_not_visible` |
| 28 | **L2 是中枢，掌握的世界事实可以比 L1 多**：位置、血量、饥饿、背包、附近玩家 ID/坐标都进 L2 的 state；L1 仍只拿 PRD 3.4 的四字段状态。L1 是「玩家大脑」，不是数据库 | 机主确认：中枢多知道点正常，人格层保持干净 |
| 29 | `follow` 不给 `seconds` = **持续跟随**（直到被取消/抢占/跟丢，1h 兜底）；跟随时 L2 保持占用，L1 可随时改派；任务终态释放该委托的工作记忆 | 机主定调：跟随就该一直跟，L2 阻塞没关系，L1 随时能改任务；结束后不该留着上一条的上下文 |
| 30 | **世界 = 记忆的作用域**：记忆/对话/状态按世界分区落 `planner/state/worlds/<world>/`，注入的回忆天然只来自当前世界；world 取值优先级 `MC_WORLD` > `mc.world` > `host_port` | 机主要求：换世界就换记忆，回忆不能串味；LAN 端口会变，所以世界名能手写 |
| 31 | 召回照搬 Yuki 的 `memory/rag.py`：**向量池宽进 + jieba 关键词覆盖率打捞 + 时间衰减重排**，融合后取 top-3 压成一条 `【回忆】` system 注入；JSONL 是唯一真相，向量索引可重建，缺依赖自动退化为纯关键词 | 机主指定照搬她那套效果好的算法；JSONL 能 grep 能手工修，索引坏了不丢数据 |
| 32 | 对话历史**全量落盘**（`history.json`，tmp + `os.replace` 原子替换，上限 400 条），prompt 仍只喂最近 3 轮；日记触发改成「自上次总结后满 12 轮」 | 机主要求关闭程序不清记忆；窗口仍受控，防止上下文膨胀 |
| 33 | **P4 重定义为「体验闭环」**：先做结构化世界的注意力筛选与经历，不接持续视觉；截图是可选的 P5 感知接口 | 机主愿景是让 Yuki 享受游玩、注意到有趣的事；持续截图既贵又不符合「主动感知」 |
| 34 | 体验编排层（Observer / Grouper / Scorer / Scheduler）**放 L3 侧车内部**，不新增进程 | tick 级事件在 Node 本地，跨进程会慢且脆；与决策 #5 一致 |
| 35 | **记录 / 唤醒 / 截图是三个不同门槛**；低分事件只落盘，不叫醒 L1，更不截图 | 否则变成「每个变化都播报」的刷屏机，还会烧 token |
| 36 | 编排层只提供候选与评分，**L1 保留最终意愿**（含 ignore / no_action）；行动仍走 intention → L2 → L3 | 编排层不能替她做价值判断，也不能变成自动派任务器 |
| 37 | 先报候选、不靠方块 ID 断言语义（不写「这是爱心/房子」）；语义交给视觉或 L1 | 结构检测便宜可靠，语义判断容易假积极 |

---

## 4.5 记忆与上下文持久化（2026-10-30 落地）

```
planner/state/worlds/<world>/          # 一个世界一个目录，world 来自 mc.world / MC_WORLD
├── memory.jsonl   # 日记 + 事件（唯一真相，可 grep 可手改）
├── history.json   # 对话历史（重启接着上次说）
├── mind.json      # mode / note / rest_until 等状态
├── places.json    # 箱子表（notes.places_enabled 控制，默认关）
└── chroma/        # 向量索引（可删，warmup 自动重建）
```

- **写入**：`mind._remember()` 每轮落 `history.json`；`_maybe_summarize()` 自上次总结后满 `autonomy.summary_after`(12)
  轮就让她把最近 12 条压成一条日记写进 `memory.jsonl`；世界事件也写（`kind=event`）。
  同一天同一句话只留一条（简易去重）。
- **召回**：每轮 `memory.recall(query)` → 向量池（top 24）+ 关键词池（jieba 词权覆盖率当保底分）
  → 关键词加成 + 时间衰减（半衰期 60 天、下限 0.55）→ 取 `memory.inject`(3) 条 → `prompts.recall_block()`
  压成一条 system 插在人格之后。自己待着（idle）时拿上一句人话当锚点，不拿「周围静下来了」去检索。
- **代价**：embedding 走 `sentence-transformers`（模型 `/home/asumi/Yuki/models/text2vec-base-chinese`，
  与 Yuki 共用），planner 进程 RSS 约 1.0 GB，启动多约 6–8 秒（`/health` 会晚一点起来，`world-up.sh` 的 90 秒等待足够）。
  内存紧张就设 `memory.vector=false`，退化为纯关键词召回，召回质量下降但零依赖。
- **验收**：`planner/tests/test_memory.py` 43 项（含真向量索引、重启接话、世界隔离）；
  线上看 `GET /stats` 的 `world` / `memory` / `memory_vector` / `recall`，`GET /health` 带 `world`。

---

## 5. 已踩的坑（照着躲，别重踩）

1. **`bot.chat('/setblock ...')` 没 op 时静默无效**，不报错、不抛异常，只能靠世界状态验证。op 需要 `ops.json` 里写**离线 UUID**：
   `md5("OfflinePlayer:" + name)`，再按 v3 规则改位（本仓库用的 `Yuki` = `eb2c5b56-d905-3a60-995f-b740bd53c675`）
2. **`prismarine-item` 必须工厂调用**：`require('prismarine-item')(bot.version)`；`new Item(...)` 会报 "Item is not a constructor"
3. **`mineflayer-pvp` 必须先加载 pathfinder 并 `setMovements`**，否则 `Cannot read properties of undefined (reading 'setMovements')`
4. **`mineflayer-auto-eat` v5**：加载用 `require('mineflayer-auto-eat').loader`；API 是 `enableAuto/disableAuto/setOpts`，**没有** `enable()`
5. **`mineflayer-statemachine` 1.7** 已不提供 mineflayer plugin，也没有 `start/stop`，纯库、构造即生效、靠 `update()` 驱动
6. **`tool.equipForBlock()` 可能返回 null 但装备已生效**，判定要看 `bot.heldItem`
7. **`collectblock` 的失败常常是目标方块根本不在那**（自己的测试脚本写错坐标），先验证 `bot.blockAt(pos)` 再动手
8. **26.1 客户端要 Java 25**，用系统默认的 17 起不来
9. **`canvas` 装了也用不上**——headless 渲染路线已废弃，别为它花时间
10. **无头环境跑 pvp 测试要先 `/kill @e`**，否则 `nearestEntity` 会抓到几十格外没清理干净的旧实体
11. **`pkill -f 'scripts/yuki.js'` 会自杀**：`-f` 匹配整条命令行，而执行它的 shell 命令行里就含这个字符串。要停进程就用 `pgrep -af` 拿 PID 再 `kill`。同理，写脚本时不要用会匹配到自身的模式。
12. **停服要用 `SIGTERM` 不要 `-9`**：Java 服务端收到 SIGTERM 会保存世界再退出（exit 143 是正常的），`kill -9` 会丢存档。
13. **26.1 里 `stone` 掉落的是 `cobblestone`（item id 35）**，硬校验必须查 `mcData.blocksByName[name].drops` 拿物品 id，不能按方块名猜物品名，否则永远判定失败。
14. **生存服 bot 空手挖石头不掉落**（MC 规则：石头需要镐）。验收脚本通过服务端控制台发 `/give Yuki minecraft:wooden_pickaxe 1`（控制台自带 op 权限，不需要给 bot 加 op）。
15. **`collectBlock.collect()` 可能长时间挂住不返回**：必须 `Promise.race` 套超时 + 超时后 `pathfinder.setGoal(null)`/`collectBlock.cancelTask()` 复位，否则任务永远不结束。
16. **后台起 Java 服务端要保留 stdin**：`java ... < $FIFO &` + `exec 3> $FIFO` 才能在脚本里继续发控制台命令；直接 `< /dev/null` 就发不进去了。
17. **验收脚本自己的断言也可能写错**：`task_done.detail.results[i].detail.mined` 是两层嵌套，取错层会报"硬校验失败"其实是脚本 bug —— 失败时先看 SSE 原始事件再改实现。
18. **`pathfinder.setGoal(goal, true)`（dynamic）永不发 `goal_reached`**：定点 goto 必须传 static，否则技能永远等不到事件。P1 一开始就是这么挂死的。
19. **pathfinder 自己 `stop()` 只发 `path_stop`，不发 `goal_updated(null)`**；A* 还可能连续回 `partial` 原地不动。`goalReached()` 必须同时监听 `path_stop` + 加"10 秒没挪动就判 stalled"的看门狗，并以实际位置（`arrived()`）为权威判定。
20. **`bot.blockAt(plainObject)` 会崩**：报 `pos.floored is not a function`，必须 `new Vec3(x,y,z)`。deposit 找容器时踩过。
21. **26.1 的 gamerule 已改 snake_case**：`spawn_monsters` / `keep_inventory` 有效，`doMobSpawning` / `doDaylightCycle` 报 Incorrect argument 且不生效（`/time set day` 仍可用）。所以 `p1-run.sh` 用新名字。
22. **同级抢占不能 `submit` 里直接 `_start` 新任务**：旧任务 `_finalize` 会清掉 `this.current` 把新任务状态弄乱。正确做法是把新任务 `queue.unshift()`，由 `_finalize → _drain()` 启动；`_finalize` 必须持有自己的 intention 引用，不能读 `this.current`。
23. **守护抢占后要冻结队列**（`runner.hold()`）：否则 `_finalize` 立刻启动排队任务，把逃生/进食动作覆盖掉。
24. **`bot.recipesAll(id, null, null)` 会把所有 3×3 配方过滤掉**：第三个参数只做真值判断（`!requiresTable || craftingTable`）。递归规划必须传真值，否则永远只看到 2×2。
25. **`bot.craft(recipe, n)` 在 26.1 上 n>1 只生效一次**（实测 2 次只出 1 份产物），要循环调用 `bot.craft(recipe, 1, ...)`。
26. **空手挖石头会让 sidecar 内存飙到 2GB 崩掉**（实测 30 秒内 OOM）：collectBlock 反复尝试 + 掉落判定不了。挖任何带 `harvestTools` 的方块前必须先 `equip` 对应工具，没有就快速失败 `missing_tool`。
27. **`bot.placeBlock` 会因为没等到 `blockUpdate` 直接抛 "Server refused..."**，但方块可能已经放上了：失败后先用 `blockAt` 复查，或换下一个候选点（脚边四个方向轮询）。
28. **`/state.queue` 一直是 undefined**：`bot.js::snapshot()` 读的是 `runtime.queueBrief/currentBrief`，而 `tasks.js::snapshot()` 给的是 `queue/current`。验收脚本读 `s.queue.length` 直接崩。P2 已修正为 `queue: runtime.queue || []`、`current: runtime.current || null`。
29. **服务端控制台 `/fill` 不接受小数坐标**：`Invalid integer '9.5'` 静默失败（只在 server.log 里一行）。测试脚本必须 `Math.round(bot.pos)` 后再拼命令，否则你以为铺了石头，其实一块没有。
30. **机主在服里打 bot 会让验收任务 `aborted`**（`guardian:hurt`，设计如此）：P2 挖矿 10 次里 3 次是这么挂的，不是执行器失败。跑固定场景前先确认没人在场，或把这类 aborted 单独计数、不混进成功率。
31. **`deepseek-flash` 端点默认会回 `reasoning_content`**：不传 `thinking:{type:"disabled"}` 时 completion 是 110 token、content 里可能只有半句；传了以后 31 token 且 content 直接是 JSON。`planner/llm.py` 已按 `disable_thinking` 开关无条件发送。
32. **重启 planner 时旧进程没退干净会 `address already in use`**，而且 `nohup ... > planner.log` 会截断日志、旧进程继续往后写，看起来像"新进程在跑旧逻辑"。重启顺序：`ss -lntp | grep 8791` 拿真实 PID → SIGTERM → 轮询端口释放 → 再起；不要用 `pgrep -f 'planner/app.py'` 找它（命令是 `python app.py`，cwd 是 planner，匹配不到）。
33. **L2 会把人格层的中文称呼当玩家名**：Yuki 叫机主「小池」，L2 就规划出 `follow player:"小池2788"`，而游戏 ID 是 `xiaochi2788`。修法是把 `/state.players`（真实 ID + 坐标）喂给 L2，并在 prompt 里禁止音译/中文称呼。
34. **bash `( cd x && cmd ) & echo $!` 拿到的可能不是真正的监听进程**（重定向/管道会多一层 subshell），用 pid 文件停服务时会出现"杀了旧 PID、新进程又 bind 失败"。可靠做法：启动后从 `ss -lntp` 按端口取真实 PID 写 pid 文件（`world-up.sh` 已这么做）。
35. **验收脚本会漏掉"已经发生过"的 `task_start`**：`waitNew()` 注册监听晚于事件触发时永远等不到。判断抢占这类瞬时事件时，先用 `events.slice(before).find(...)` 查历史，再退化为等待。
---

## 6. 文件地图

```
/home/asumi/Minecraft/
├── PRD.md                 # 产品定义（source of truth）
├── HANDOFF.md             # 本文
├── LLM接入MC方案.md        # 早期 Gemini 讨论（历史）
├── memo/Log.md            # 开发流水账
├── configs/
│   ├── local.example.json # 配置模板（host/port/user/version/llm）
│   └── local.json         # 真实配置含 API key，gitignore，不入库
├── scripts/
│   ├── m0-run.sh          # M0 一键验收：起服 -> 预置环境 -> 起服务 -> 跑脚本 -> 全停
│   ├── p1-run.sh          # P1 一键验收：起服（带控制台 FIFO）-> 侧车 -> p1-test.js -> 全停
│   ├── p2-run.sh          # P2 一键验收：单测 + 起服/planner/侧车 -> p2-test.js -> 全停
│   ├── world-up.sh        # 常驻世界：主服 + planner + 侧车（PID 在 /tmp/yuki-world/）
│   └── world-down.sh      # 优雅停掉常驻世界
├── planner/               # L1 人格 + L2 规划（Python 3.11 + aiohttp，:8791）
│   ├── app.py             # /chat /plan /callback /cancel /stats /health
│   ├── l1.py              # 人格层 + L2 Planner + Chain（预算/重规划/协商）、/dispatch 通道
│   ├── facts.py           # L3 失败回调 -> 结构化事实（期望 vs 实际）+ 兜底方案
│   ├── budget.py          # 单任务预算（calls/tokens/时间/retry）
│   ├── llm.py             # OpenAI 兼容客户端（超时/重试/记账/disable_thinking）
│   ├── prompts.py         # 人设 + 规划 + 重规划 + 方案 prompt、status_block
│   ├── schema.py          # 步骤与方案硬校验（白名单 + 参数范围）
│   ├── mind.py            # L1 心智：聊天 + intention 工具 + 自主节拍 + 记忆注入
│   ├── memory.py          # 世界记忆：JSONL 真相 + 双池召回（向量 + 关键词）+ 时间衰减
│   ├── history.py         # 对话持久化（原子替换，重启接话）
│   ├── notes.py           # 箱子表（按坐标 upsert，默认关）
│   ├── tests/test_p2.py   # P2 单测（30 项）
│   ├── tests/test_memory.py # 记忆单测（43 项：分区/召回/衰减/重启）
│   ├── state/worlds/<world>/ # 每世界的记忆、对话、状态、向量索引（gitignore）
│   └── config.py          # 读 configs/local.json（含 mc.world / memory 段）
├── server/                # 主服 26.1.2，:25565，生存，离线（也是 M0 验收场地）
├── server-test/           # 实验场 26.1.2，:25566，creative + op
└── yuki-bot/              # Node 侧
    ├── package.json       # mineflayer 4.39.0 + 7 个插件 + canvas
    ├── sidecar/           # L3 状态机与技能库（:8790）
    │   ├── index.js       # HTTP + SSE + 公屏转发 + 回调
    │   ├── bot.js         # mineflayer 连接、状态快照、hardStop
    │   ├── tasks.js       # 顺序执行 / 抢占 / 排队 / 取消 / hold / 结果摘要
    │   ├── guardian.js    # 守护逻辑 priority 9：受击/低血/岩浆/虚空/饥饿
    │   ├── skills/        # mine / goto / follow / craft / deposit / attack / eat / equip / place
    │   ├── validate.js    # 背包增量、到达判定、方块掉落表
    │   └── config.js      # 配置（环境变量优先）
    └── scripts/
        ├── m0-test.js     # M0 验收脚本（模拟玩家喊话 + SSE 断言 + 预算统计）
        ├── p1-test.js     # P1 验收脚本（纯脚本驱动：场景/队列/守护/存取，SSE + 控制台 FIFO）
        ├── p2-test.js     # P2 验收脚本（NL→9 技能 / 10 次挖矿 / 不可达升级 / 预算；--only=diamond）
        ├── yuki.js        # 旧单体最小闭环（登录 / 寻路 / 聊天指令）
        ├── chat-test.js   # 双 bot 聊天指令测试
        └── compat-test.js # 插件 26.1 兼容性回归
```

Yuki 本体在 `/home/asumi/Yuki`（**独立 git 仓库**）。**M0 起不与之耦合**（见第 4 节 #15），只当人设语气的参考：

- `core/prompts.py` — 人设写法与称呼（本仓库 `planner/prompts.py` 独立维护了一份，改动时人工对一下语气即可）
- `core/toolchain.py` 的 tool calling 形态 — 只借鉴接口形状，没有代码依赖
- 如果将来要打通（QQ 与 MC 共享记忆/人格），接点在 `core/session_pipeline.py` + `rag.save_diary()`，届时再评估

---

## 7. Session 工作约定

**开工**
1. 读本文第 2、3 节 → 知道做到哪、下一步做什么
2. 读 `memo/Log.md` 最后 30 行 → 知道上次踩了什么
3. 检查常驻进程是否还活着（`ss -lntp | grep -E '25565|25566|8790|8791'`）

**收工**
1. 更新本文第 2 节（状态）、第 3 节（勾选/改下一步）
2. `memo/Log.md` 追加一条（做了什么、当前状态、遗留问题）
3. 新踩的坑补进第 5 节；新冻结的决策补进第 4 节
4. **停掉常驻进程**（见第 0 节停机步骤），确认 `ports free` 且内存已回收
5. 本目录暂不是 git 仓库，不用提交；Yuki 本体本阶段不改（见第 4 节 #15）
