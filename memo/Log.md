
## 2026-10-28 MVP：mineflayer 接入 26.1.2 闭环跑通
- 结论：mineflayer 开源(MIT)，可用；协议支持最高 26.1(775)，正好匹配本地 26.1.2 客户端；26.2(776) 不支持。
- 环境：Node 22.23.3 / Java 25(`/usr/lib/jvm/java-25-openjdk-amd64`) 就绪。
- 已搭：`server/`（官方 26.1.2 server.jar，离线服，端口 25565，eula=true）；`yuki-bot/`（mineflayer 4.39.0 + pathfinder，`scripts/yuki.js`）。
- 验证：selftest 寻路 PASS(1.6s)；真人 `xiaochi2788` 进服，`yuki status/come/follow/stop` 全部响应，位移从 (15.5,69,6.5) 到 (-13.5,66,-10.5)。
- 修正：先前误判"寻路卡住"——那组坐标取自中途 status 快照，实际游戏内已到玩家 2 格内，`come` 正常。
- 待办：L2 路由层、Fabric 旁拍截图、mineflayer 技能库封装。

## 2026-10-28 插件 26.1 兼容性实测（隔离测试服 :25566, creative, op）
- 实测通过：pathfinder / collectblock(挖掉 oak_log) / pvp(NoAI 僵尸 2.5s 击杀) / tool(自动换稿斧) / armor-manager(自动穿头盔胸甲) / auto-eat(loadPlugin(require('mineflayer-auto-eat').loader)) / statemachine(纯库，无 plugin，无 start/stop，构造即生效)
- API 坑：prismarine-item 需工厂调用 `require('prismarine-item')(bot.version)`；pvp 必须先用 pathfinder 并 setMovements，否则崩；auto-eat v5 是 enableAuto/disableAuto/setOpts，没有 enable/disable；tool.equipForBlock 返回 null 但实际已装备（要看 heldItem）
- 未通过：prismarine-viewer 需 canvas 原生模块（缺 cairo，要 sudo 装系统库）→ headless 截图路线暂阻塞
- 26.1 协议：无 protocol error
- 硬件约束：无 NVIDIA GPU，内存 7G 已占用高 → L2 无法本地小模型常驻，改走云端 API（disable_thinking=true），实时运动闭环交给 Node 侧车本地代码
- 文件：yuki-bot/scripts/compat-test.js 可复跑；测试服 server-test/ 常驻 :25566

## 2026-10-28 架构决策（手稿评审后定稿）
- 三层：L1 Yuki 主层(人格 prompt + 单工具 send_intention) -> L2 规划器/状态机推进 -> L3 mineflayer 技能库
- L1 与 L2 异步：L1 发 /send-intention 即返回继续聊天；L3 完成回调 -> 注入消息给 L1 -> 自然语言汇报
- 表达力已收窄：L2 只输出有序步骤列表 + on_fail(retry|abort)，不允许自由 if/loop/DAG
- 抢占：L1 在意图中显式声明 priority，L2 比较后决定抢占/排队（同级暂定抢占，待确认）
- inspect 分层：代码硬校验优先（背包增量/是否到达），失败才回灌 L2 重规划
- 状态机放 Node 侧车（每 tick 读 bot 状态），Python 只提供无状态 /plan 端点
- 突变探测不用 Fabric：mineflayer 是服务端视角全知，实体/方块更新/伤害源全可拿；只有语义无法解析时才截屏喂 VLM
- 求生底线：硬编码守护逻辑 priority=9（受击/低血/岩浆/饥饿），可打断一切；L1 可声明范围 0-8
- MVP 技能库：mine / craft / goto / follow / attack / eat / equip / deposit（smelt 后期补，mineflayer 无现成熔炉插件，需自己写 GUI 交互）
- L1 感知档位：第二档 = 任务回调 + 关键事件播报（受击/天黑/玩家靠近/新建筑），不做定时截屏；截屏触发留开关
- 默认假设（未反对即采用）：MC 与 QQ 共享记忆，条目打 scene:mc 标签；L1 离线时 L3 跑完缓存回调

## 2026-10-28 PRD v0.1 成稿
- 文件：`/home/asumi/Minecraft/PRD.md`（按阶段组织：P0 已完成 / P1 侧车+状态机+技能库 / P2 L2 规划器 / P3 L1 接入+闲置 / P4 事件与视觉 / P5 稳定性）
- L1 闲置机制写入 P3 验收：无事件零 API 调用；`yuki rest <分钟>` 调试休息；低 severity 事件 30s 聚合
- 最大不确定项标记为 P1 的 GUI 交互（craft/deposit）

## 2026-10-28 PRD v0.2：本体感 / 自主性
- 用户要求：Yuki 是"在游戏里生活"而不是"干活"，可自发出行、好奇、惊叹
- 新增 §3.6 上下文三层预算（常驻 ≤400tok / 轮内 / 按需 RAG），禁止 MC 原始事件流进 L1
- 新增 §3.7 自主性：好奇探测器(novelty 打分) + 自主唤醒(处境描述而非任务) + 心愿单(≤3 条, 注入 top1) + 游玩意图 origin=self_play/curiosity(低优先级可抢占, 失败不报错只记经历) + mood 连续 + 无边界漫游/出发锚点
- 新增 §3.8 开发期开关：yuki stop / play on|off / rest <分钟>
- 阶段重排：P4=自主性与心愿(3-5d)，P5=事件与视觉，P6=稳定性；调试期默认 play off，P4 通过后常驻开启
- 长期记忆复用现有 rag.save_diary + YukiMemoryStore，MC 用独立 chat_id(mc:world)，打 scene:mc

## 2026-10-28 多 session 交接基础设施
- 决策：先做 M0 竖切片（全链路最小循环），再按需长周期充实 P1-P6；预计会有 30-40 个 session
- 新建 `HANDOFF.md`：三十秒上手命令 / 环境硬约束 / 当前状态 / M0 六步待办 / 14 条已冻结决策 / 10 条已踩坑 / 文件地图 / session 工作约定
- PRD 增加 M0 章节，里程碑表加一行
- 文档职责划分：PRD=产品定义，HANDOFF=进度与交接，memo/Log=流水账

## 2026-10-28 项目公约 + 交接简报
- 新增 `docs/项目公约.md`：工作原则 / 技术红线(8条) / 文档纪律 / 代码纪律(7条) / 验收纪律 / session 协作协议 / 长期节奏
- `HANDOFF.md` 顶部新增「给新 session 的上下文简报」：Yuki 是什么(已有能力清单)、技术栈表(Mineflayer 4.39 + 插件生态 + minecraft-data)、Mineflayer 必知常识(无渲染/无寻路/异步长任务/版本上限)、阅读顺序
- 文档职责表加入公约

## 2026-10-28 收工与停机规范化
- 已停：bot 进程、主服 :25565、实验场 :25566（SIGTERM 优雅退出，level.dat 已更新，内存 6G→3G used）
- HANDOFF §0 增加「停机（收工必做）」三步命令与警告；§7 收工清单加第 4 步
- 新增坑 11：pkill -f 会匹配到自身 shell 导致自杀，必须 pgrep 取 PID 再 kill
- 新增坑 12：停服用 SIGTERM（exit 143 正常，Java 会保存世界），kill -9 会丢存档

## 2026-10-28 M0 竖切片落地（全链路跑通，10/10 验收通过）

- 决策变更（机主确认）：**M0 不接 Yuki 本体**，本 Bot 与 Yuki 的关联只是 prompt 语气一致；`/plan` 放 Python 侧；公屏聊天通道本轮一并做。已补进 HANDOFF 第 4 节 #15–#18。
- 新增 `yuki-bot/sidecar/`（L3，:8790）：`bot.js`（mineflayer 连接/快照/hardStop）、`tasks.js`（顺序执行 + 抢占 + 排队上限 3 + 取消 + 结果摘要）、`skills/{mine,goto,follow}.js`（统一 `async(args,ctx)=>{ok,detail}`）、`validate.js`（背包增量按 `block.drops` 取物品 id、到达判定）、`index.js`（HTTP + SSE + 公屏转发 + 回调）。
- 新增 `planner/`（Python 3.11 + aiohttp，:8791）：`app.py` 暴露 `/chat /plan /callback /cancel /stats /health`；`l1.py` 人格层（tool calling 下发意图、回调汇报、单槽临时状态注入）；`schema.py` 白名单 + 范围校验（8 类非法输入单测全部拒收）；`llm.py` 带超时/重试/调用计数。
- 新增 `configs/{local.example.json,local.json}`（后者含 API key，权限 600，不入库）、`scripts/m0-run.sh`（一键验收：起服→预置镐子与石头→起服务→跑脚本→全停）、`yuki-bot/scripts/m0-test.js`（模拟玩家喊话 + SSE 断言 + 预算统计）。
- 实测结果（`bash scripts/m0-run.sh`）：①公屏喊话 3.3s 回人话且任务下发成功 ②硬校验挖到 5 块石头（L2 要 4 块） ③完成后主动汇报无 JSON/坐标 ④挖矿途中插话 1.1s 回应、任务继续 ⑤单任务 LLM 调用 4 次（听+规划+应声+汇报），token≈2800/312。
- 补充验证：`POST /cancel` 1 秒内 goal 清空、状态回 idle、bot 停住；`POST /plan` 直连返回合法步骤，空文本 400；sidecar 非法意图（未知技能/空步骤/on_fail/优先级越界/步数超限）全部拒收。
- 新坑记入 HANDOFF 第 5 节 #13–#17：stone 掉 cobblestone 必须查 drops 表；生存服空手挖石头不掉落需控制台 /give；collectBlock 可能挂住要套超时；后台起服务端要保留 stdin；验收脚本断言取错层级会误报。
- 当前状态：所有进程已停，端口 25565/25566/8790/8791 全空，内存回到 3G 占用。下一步 P1（守护逻辑 priority 9 + 技能补齐 + 固定场景回归）。

## 2026-10-28 P1 落地：守护逻辑 + 8 技能 + 队列/取消 + 三场景回归（19/19）

- 新增 `yuki-bot/sidecar/guardian.js`：priority 9 硬编码。触发条件 受击 / 低血(≤6) / 脚下岩浆 / 虚空(y<-50) / 饥饿(≤6)；流程=冻结队列(`runner.hold`) → 抢占当前任务(`aborted` + reason `guardian:*` 上报) → 保命动作（找安全点逃生 / 从敌对怪身边退开 / 自动进食）→ 释放队列。SSE 新增 `emergency` 事件，`/state` 带 `guardian` 状态。
- 新增技能 `craft`(仅 2×2)、`deposit`(可选坐标/最近容器，chest/trapped_chest/barrel)、`attack`(pvp，目标消失硬校验)、`eat`(manual consume，food 值硬校验)、`equip`(槽位名硬校验)；`skills/index.js` 白名单扩到 8 个。
- `tasks.js` 修抢占：旧实现 `_finalize` 读 `this.current`，抢占后会把新任务状态清掉 → 改为持有自己的 intention 引用；同级抢占改为 `queue.unshift` 后由 `_finalize → _drain()` 启动；`_finalize` 先放行队列再等回话回调（回话走网络，不能拖住下一条）。
- `bot.js`：加载 pvp 插件；`hardStop` 增加 pvp.forceStop / 关容器 / 停挖 / 停用物品；`gotoNear` 改静态 goal（dynamic 不发 `goal_reached`）；`goalReached` 增加 `path_stop` 监听 + 10 秒不动看门狗；`blocksAroundFeet()` 给守护逻辑用。
- planner：`schema.py` 白名单扩到 8 技能并加参数校验（deposit 坐标必须同时给、equip 目的地枚举、attack count 1-8 等），`prompts.py` 技能清单同步；PRD 3.2 接口表改成实测口径。
- 新增 `scripts/p1-run.sh`（起主服带控制台 FIFO → 起侧车 → 跑验收 → 全停）与 `yuki-bot/scripts/p1-test.js`（纯脚本驱动，不调模型；服务端控制台预置方块/箱子/僵尸/伤害/岩浆）。
- 实测（`bash scripts/p1-run.sh`）：19/19 通过。① 空地 goto 10/10 ② 同级抢占（旧 aborted、新 done）③ 排队上限 3，第 4 个 429 ④ priority 9 直投 400 ⑤ 取消 2–28ms 回 idle 且后续任务正常 ⑥ 树林 mine oak_log 3 ⑦ craft 2×2 木板 8 ⑧ 3×3 配方 `need_workbench` ⑨ mine stone 5 ⑩ equip 剑 ⑪ eat bread（food 16→20）⑫ attack 僵尸击杀 ⑬ mine→goto 家→deposit 全链路 185 件入箱、圆石 117→0 ⑭ 受击守护 ⑮ 低血守护 ⑯ 脚下岩浆逃生（health 20）。
- 回归：M0 `bash scripts/m0-run.sh` 10/10 通过（LLM 调用 4 次/单任务，未受新技能影响）；`compat-test.js` 仍 10/15（5 项为既有 API 差异：tool.equipForBlock 返回 null、auto-eat 无 enable()、statemachine 无 stop()、实验场虚空地形下 pvp/summon 场景失效；该脚本不加载 sidecar，与本次改动无关）。
- 新坑（已补 HANDOFF §5 #18–#23）：pathfinder dynamic goal 不发 goal_reached；pathfinder 自己停只发 path_stop 且 A* 可能原地 partial；`bot.blockAt` 必须传 Vec3；26.1 gamerule 改 snake_case（spawn_monsters / keep_inventory）；抢占不能在 submit 里直接 _start；守护抢占必须冻结队列。
- 当前状态：所有进程已停，25565/25566/8790/8791 全空。下一步 P2（L2 规划器接 8 技能 + 失败升级路径 + 预算）。

## 2026-10-28 晚：自造工具链（挖木→造木镐→挖石）

- 需求：机主问「收到挖石头时能不能先去挖木头造镐子」。调研结论先给：mineflayer 自带 `bot.craft(recipe, n, craftingTable)` 在 26.1 **能用工作台做 3×3**（实测造出 wooden_pickaxe）；社区库 `mineflayer-crafting-util@0.5.0` 能做递归规划但不管放工作台。机主选了「只用自带 API + 自己写小解析」。
- 新增 `sidecar/skills/place.js`：放方块，脚边四个候选点轮询 + 服务端方块更新迟到也认（`placed_after_timeout`）。
- `craft.js` 重写：递归解析配方（木板→木棍→工作台→目标），需要 3×3 时自动合成并放下工作台；语义＝本次**新增** N 个；一次只调一次 `bot.craft` 补齐次数。
- `mine.js`：挖带 `harvestTools` 的方块前先换对应工具，没有就快速失败 `missing_tool`。
- 修了 3 个实际 bug（已补 HANDOFF 坑 24–26）：`recipesAll(...,null)` 滤掉 3×3 配方；`bot.craft(recipe, n>1)` 在 26.1 只生效一次；空手挖石头让 collectBlock 空转、sidecar 30 秒内 OOM（2GB）。
- 测试：`p1-test.js` 增加 ⑧ 造木镐、⑧b place 单测；开局 `/clear` 保证是真造；加 15×15 固定测试平台消除出生点地形随机性；补了战斗/存取前的回血。
- 状态：单链路实测通过（原木→木板→木棍→工作台→木镐→挖石头，自动放台成功）；`scripts/p1-run.sh` 全量最近一次 14/20，失败全部由「树林造镐」环节的 place 失败连锁（放方块时机/场地），尚未全绿；下一轮由机主继续验证。
- 设计决策（机主定调，HANDOFF #22）：L2 只负责人话→机器步骤，不越权做价值判断；失败时把结构化事实 + 2–3 个方案交回 L1，由 L1 重新规划，最多一轮。

## 2026-10-28 深夜 P2 落地：L2 规划器 + 失败协商 + 单任务预算（并开常驻世界给机主造访）

- 机主确认最初手稿的方向：L1 与 L2 是密切合作关系，做不了就直接把事实/方案交回交流。本轮实现与手稿一致。
- 新增 `planner/budget.py`：单任务预算（calls 10 / tokens 12000 / 300s / retries 2）；`LLMClient` 每次真实调用记账，超限抛 `BudgetExceeded`，L1 降级成人话。
- 新增 `planner/facts.py`：把 L3 回调压成「失败码 + 期望 vs 实际 + 已完成步骤」，附失败码人话标签与代码兜底方案。
- `planner/l1.py` 重构：`Chain` 记录一条委托的预算/重规划次数/协商状态；失败 → L2 带事实重规划（retry=2）→ 用尽后 L2 出 2–3 个方案、L1 用 `send_intention` 决断（最多一轮）→ 最终人话汇报。`/stats` 暴露 invalid 率、最近链、预算快照。
- `schema.py`：新增 `validate_options`（2–3 项）；步骤出现 if/loop 等额外字段直接拒收。
- `prompts.py`：新增 `REPLAN_SYSTEM` / `OPTIONS_SYSTEM` / `replan_user` / `options_user` / `negotiation_user`；规则补「圆石默认挖 stone」。
- `llm.py`：按 `disable_thinking` 真正发送 `thinking:{type:disabled}`（实测 completion 110→31 token，content 直接是 JSON）。
- 侧车：`config.js` retry 默认 2；`tasks.js` 整条委托时间上限 + 确定性错误（缺工具/没目标/缺材料…）不重试；`index.js` 回传 failed_step/missing/needs 等事实；修 `bot.js` 的 `/state.queue|current` 字段名不匹配。
- 新增 `POST /dispatch`（planner）：跳过人格措辞直接下发，仍走完整 Chain，供验收稳定复现升级路径。
- 新增测试：`planner/tests/test_p2.py`（28/28）、`yuki-bot/scripts/p2-test.js`（支持 `--only=diamond`）、`scripts/p2-run.sh`、`scripts/world-up.sh` / `world-down.sh`。
- 实测：10 次「挖 20 圆石」7/10（3 次是机主在服里打她，守护正确抢占 aborted）；10/10 规划合法且都是 `mine stone ×20`，平均 0.95s。远古残骸（主世界不可得）：2 轮重规划 + 1 轮协商，18.8s 回 idle，人话收尾，预算 6 调用 / 5134 token。真实规划 24 次 0 非法 JSON。
- 机主当时在服里实测：公屏英文聊天她能用中文接话（"hey there" → 回话并顺手把之前没派的委托补上），打她会触发守护逃跑——符合设计但会打断固定场景，记入坑 30。
- 当前状态：常驻世界已起（`world-up.sh`，主服 :25565 + planner :8791 + sidecar :8790，PID 在 `/tmp/yuki-world/`），机主可随时进服造访；P2 完成，下一步 P3（接 Yuki 本体 + 闲置机制）。

## 2026-10-28 深夜补丁：「come here」过不来

- 现象（机主实测）：公屏说 come here，Yuki 不动/秒失败，日志 `player_not_visible`。
- 根因：`/state` 没有玩家坐标，L2 把中文称呼当玩家名，规划出 `follow player:"小池2788"`；真实 ID 是 `xiaochi2788`。另外 `extract_facts` 读的是嵌套 `detail`，而侧车回调是扁平结构，导致失败码全变 `unknown`。
- 修复：`sidecar/bot.js` 新增 `playersNearby()` 并进 `/state.players`；`L1.state_text` 带附近玩家（ID+坐标+距离）；prompt 规定「过来→goto 该玩家坐标，跟着我→follow 真实 ID」，禁止中文音译；`facts.py` 兼容扁平回调并补 `player_not_visible` 人话；`/callback` 的 escalation 响应不再误判 502。
- 实测：同样走公屏链路（xiaochi2788 发 come here），L2 出 `goto(-18,65,9,range2)`，4.4s 到达，距玩家 1.58 格，`done`。单测补 2 条（扁平事实），30/30。
- 坑：重启 planner 旧进程没退干净 → `address already in use`，且日志被截断后旧进程继续写，看起来像新代码没生效；已记 HANDOFF 坑 32。

## 2026-10-28 收尾：跟随持久化 + 交接 P3（让 Yuki 有自己的脑子）

- 机主实测「跟随跟了一会儿就结束」：根因是 follow 的 seconds 默认 15 秒。机主定调：跟随应当一直跟，L2 保持占用，L1 随时改派，任务结束释放工作记忆。
- 改：follow 不给 seconds = 持续跟随（1h 兜底）；`tasks.js` 对开放跟随豁免整条委托超时；prompt 规定「跟着我」不给 seconds、持续动作 priority 3–4；L1 在任务终态（含汇报失败/预算超限/未派新活）释放 Chain，`chains` 归零。
- 实测（`p2-test.js --only=follow`）：L2 出 `follow{"player":"Tester"}` 无 seconds；20 秒后仍在跟；新委托即时抢占（旧 `aborted/preempted`，新任务同毫秒开始并完成）；终态后 chains=0。最后一条断言曾因测试自身事件竞态误报，已修测试（坑 35），修完那轮未再完整重跑。
- 交接：HANDOFF §2/§3 更新，P3 方向按机主定调写为「接上她自己的脑子，不做车万女仆」：接 Yuki 本体 ToolSpec、MC 场景 prompt、回调注入 session_pipeline、闲置/rest、记忆打标、状态注入，并为 P4 自主性留心愿单接口。
- 当前：常驻世界仍在跑（机主在服里），P2 关闭，进入 P3。

## 2026-10-28 晚 P3 落地：L1 改成「纯文本 + intention 工具」，箱子表实验，26.2 试过不上

- 机主定调：**不接 Yuki 本体**（决策 #15 保持），在 planner/ 自建 L1，参考其写法而已。
- L1 重写（`planner/mind.py`）：模型只输出文本（像 chatbot），想动手就调唯一工具 `intention(text)`；不再有 JSON 决策协议、没有 action/plan/steps 字段。L2 结果以普通消息注入（「（身体）「挖木头」完成了：…」），失败先 L2 自修 2 轮，用尽后把事实+方案当消息交回她。
- 状态单槽注入（`prompts.state_line`）：时间（白天/傍晚/夜里+剩余分钟）、位置、血量、饥饿、背包、附近玩家、身体在做什么、小本本（Python 维护的「正在做/刚做过」）。只在当轮 user 消息末尾，不进历史。
- `INSTRUCTION`（第二条 system）已删，只留机主自己写的人格 prompt；占位语不再写进历史（发现模型会模仿「（我让它去做：…）」）。
- 新增技能：`roam`（随机逛）、`drop`（递东西，可指定玩家）、`open`（开容器读内容/取物）；技能总数 12。
- L2 能力边界：新增 `{"unsupported":"熔炉烧炼"}` 出口，不再拿别的技能糊弄；Python 翻成「主人还没做这个功能」告诉她（`say_after` 发第二条）。
- 箱子表（`planner/notes.py` + `notes.places_enabled`）：开容器按坐标 upsert，注入最近 2 个。**本轮实测通过后按机主要求关掉**，代码留着。
- 限额与稳定性：自主 80 次/10 分钟、日 800 次；空闲节拍 45–120 秒；看门狗 20 秒复位「假忙碌」（回调丢失时她会永久不动）。
- 新增留痕：`planner/state/trace.jsonl` 记完整请求/补全/usage，`GET /trace?n=&purpose=`。
- 修 bug：公屏 chat_keyword 为空时 `!keyword||…return` 导致**所有消息被丢**；`/state.task` 一直 undefined（`runtime.taskBrief` vs `task`，她干活时以为闲着）；`/event` 用 `ok` 判状态码导致侧车 400 重推；血量浮点直塞 prompt；`place` 工作台失败靠协商绕。
- 26.2：试了「拿 26.1 数据充 26.2」的 hack（`scripts/patch-262.sh` + `yuki-bot/scripts/probe-262.js` + 本地 `server-262/` 26.2 服）。结果：**能登录、能走路，但 login/success 包解析错位、区块读不到 → 看不到方块**，技能全废。机主决定**保留 26.1**，已把 node_modules 里的 5 处补丁全部回滚，`mcData('26.2')=null`、26.1 协议 775 正常。
- 当前：主服 :25565 + sidecar :8790 + planner :8791 在跑，她在游戏里自己玩（22:30 还在山洞口数石头）。

## 2026-10-28 23:0x 修 planner 启动即挂（prompts.py 三处）

- 机主改了 `planner/prompts.py` 的人格文本后 `app.py` 起不来。三个连着的错：
  1. `_PERSONA_TEMPLATE` 的三引号没闭合，吞到下面 `INSTRUCTION = """` 才结束，中文落成裸代码 → `SyntaxError: invalid character '，'`。已在「说话方式」末尾补 `"""`。
  2. `mind.py` 用的是 `prompts.PERSONA`，而文件里只有 `_PERSONA_TEMPLATE` → `AttributeError`。新加 `PERSONA = _PERSONA_TEMPLATE`。
  3. `mind.py:226` 传 4 个参数给 `state_line`，签名只有 3 个（`places` 箱子表那参数在改文本时丢了）→ 每轮 `mind_loop_error`。签名补回 `places: str = ""`，非空时以「｜记得的地方：…」附在状态行末尾（`config.NOTES_ENABLED` 仍控制是否喂值）。
- 机主指正 `INSTRUCTION`（第二条 system）不需要了，已删变量及其注释；`grep INSTRUCTION` 全仓无残留引用。
- 验证：`py_compile` 全通过；`app.py` 起服监听 8791 正常，自主 tick 正常调模型；`planner/tests/test_p2.py` 30/30。
- 当前状态：planner 可正常起；世界仍是停的（25565/8790/8791 全空），机主打算用 HMCL 单人世界「对局域网开放」+ `MC_PORT=<端口>` 让她进，待机主自己开世界。

## 2026-10-30 凌晨 记忆模块改造：世界分区 + 对话持久化 + Yuki 同款召回

- 机主授意：照搬 `/home/asumi/Yuki` 的日记+RAG+召回，接进本项目的记忆模块；记忆按世界区分，注入只来自当前世界；关掉程序不能丢记忆。
- 三个选择（机主定）：① 混合召回（向量 + 关键词双池，照搬 Yuki）② world 手写在 `mc.world`，缺省回退 `host_port` ③ 本轮只做「世界分区 + 对话持久化 + 召回注入」，不做 supersedes/metadata 演化链。
- 新增 `planner/history.py`：`HistoryStore`（tmp + `os.replace` 原子替换、上限 `memory.history_max`=400 条、脏文件降级空历史）。
- 重写 `planner/memory.py`：JSONL 仍是唯一真相，`chroma` 索引只是可重建加速层（`warmup()` 对齐、缺依赖退化纯关键词）；召回 = 向量池宽进(24) + jieba 关键词覆盖率打捞 + 关键词加成 + 时间衰减（半衰期 60 天、下限 0.55）；同日同文去重。
- `planner/config.py`：`WORLD` / `STATE_DIR=state/worlds/<world>/`（memory/history/mind/places/chroma 全分区）、`MEMORY` 段（enabled/vector/embed_model/inject/pool/keep/history_max/half_life_days/recency_floor）；`CHAT_ID=mc:<world>`。
- `planner/mind.py`：启动 `_warm_memory()`（线程里建索引，别卡事件循环）；每轮 `prompts.recall_block()` 压成一条 `【回忆】` system 插在人格之后；`_remember()` 落盘；`_maybe_summarize()` 改「自上次总结后满 12 轮」触发且不再截断历史；`/stats` 加 `world`/`memory_vector`/`recall`，`/health` 加 `world`。
- 迁移：老 `planner/state/{memory.jsonl,mind.json,places.json}`（234 条日记）已移入 `state/worlds/world/`；`configs/local.json` 与 example 补 `mc.world="world"`。
- 验收：新增 `planner/tests/test_memory.py` 43 项全过（含真向量索引建库/自愈、世界隔离、重启接话、回忆注入不污染历史）；`test_p2.py` 30 过 1 挂（「13 类非法计划拦截」，改动前后一致，是既有问题）。
- 实测（planner 单独起，无 MC 服）：`memory_ready world=world vector=True entries=234`；问「还记得我们之前砍木头吗」→ 召回 3 条砍木头日记，她答「当然记得啦！人家砍了好多木头…」；重启后 `history=5` 接上，再问「刚才你说了什么呀」答得上。
- 已知代价：embedding 栈让 planner RSS 约 1.0 GB、启动多 6–8 秒；内存紧就把 `memory.vector` 设 false。

## 2026-10-30 调研：`/home/asumi/minecraft-numen`（言出法随）可借鉴什么

只读调研，未改代码。仓库 146k 行 Java（main）+ 4.9 万行测试 + 8 个平台/插件模块，不能整体搬。

**翻转的一个前提**：言出法随的身体是**服务端假玩家**（`ServerPlayer` + `FakeConnection` + 原版 `placeNewPlayer`，同 Carpet `/player`），不是"客户端注入"。
客户端模组只是可选前端（面板/语音/皮肤）。意味着：要用它那套，**得在服务器上装 mod**；公共服进不去。且 ADR body 0003/0007 记着——他们为了补"客户端那一半"
（代答传送握手、发 `handleXxx` 包开附魔台/切石机/铁砧/告示牌/书/交易），自己写了 6474 行 `numen-api/.../api/entity`。这部分 mineflayer 白送。

**26.2 现状（查过）**：本地 minecraft-data 3.117.0 与上游 master 的 `dataPaths.pc` 都止于 `26.1`；mineflayer 4.39.0 / minecraft-protocol 1.68.0 同。
26.2 不是配置问题，是上游没数据，只能等或自己维护协议 fork。

**值得抄的（按性价比）**
1. 三级披露文本技能（Claude Code 式，纯 Python 可照搬）：`SkillRegistry`/`SkillTool`/`SkillInjection` —— 系统提示里 `<available_skills>` 只放 name+description，
   模型调 `skill(name)` 才注入正文 `<skill_content name="…">`，附属文件用 `file` 工具按页取。仓库里真有一份 `skills/numen/building_design/SKILL.md`（297 行）。
   对应我们"skills 匮乏"，且不碰身体。
2. 五条生存链 `task/chain/`（1003 行，纯逻辑，可译成 JS）：MLG 落地水（5 条射线探落点、放水、20 刻内收桶）、Breath、Flee、MobDefense、Unstuck。
   我们 `guardian.js` 只有逃跑/后退/进食，坠落与水下一片空白。
3. 错误枚举 `ErrorKind`（13 种：`out_of_reach`/`no_path`/`no_material`/`needs_consent`…）+ hint 写成"能照抄的下一步"。我们 `facts.py` 是自由文本，L2 不好稳定分支。
4. 82 个 Lua 函数对照我们 12 个，缺口里**成本低且 mineflayer 原生支持**的：`gui.*` 通用窗口（`clickWindow`）、附魔/铁砧/切石机/织布机/交易（`openEnchantmentTable`/`openAnvil`/`openVillager`+`trade`）、熔炉 `smelt`（`openFurnace`）、书与告示牌（`writeBook`/`updateSign`）、`sleep`、弓与盾、`time.wait`。
5. 统一 "where" 参数类型（Pos|Block|Entity|Cluster|column|height）替代我们每个技能各写 x/y/z —— 可改 `schema.py`。

**不抄**：Lua 沙箱组合（与我们 `schema.py` 明文"表达式能力一律拒收"相冲，先不动）、自研 2.9 万字 ADR 的 pathing、`shape.*` WorldEdit（2511 行 Lua + 大量 Java）、ui/mcp/ai 模块、权限层（判"这方块是谁的"要有服务端视角，我们做不到）。

**待机主定**：① 目标是"进 26.2"还是"能力更强"；② 若走 Fabric 身体，能否接受服务器必修 mod；③ 先做文本 skills / 生存链 / GUI+熔炉技能 哪一项。

## 2026-10-30 L2 分域 + 领域专家 + notes 回流（机主定：L1 当小傻子，L2 当专家）

机主拍板：**不给 L1 加 skills**，L1 只管人格与意图；把 L2 抬到专家水准，并让它适时反馈 L1。走 A 路线（域路由），先用同一个模型。

**改动（全部在 planner/，未碰 yuki-bot/）**
- 新增 `planner/domains.py`：5 个具名域（gather/craft/interact/travel/combat）+ 兜底 `general`。每域 = 路由关键词 + 技能白名单 + 专家册（markdown）+ 额外规则。
  路由是纯子串匹配、不过模型、零成本；一个都没命中就退 general（全 12 技能、无专家册），**最坏情况与加域之前完全一致**。
- `schema.py`：`SKILLS` 改 frozenset；`validate_plan(payload, allowed=SKILLS)` 按域校验。域外技能 → SchemaError → 走原有一次修复 → 再不行拒收，**不会把域外步骤送进执行器**。
- `prompts.py`：拆成 `SKILL_LINES`（12 行参数说明）、`SKILL_EXAMPLES`（每个技能一条真实例子，域 prompt 的 few-shot 用本域第一个技能）、`COMMON_RULES`（每条标注依赖哪些技能，域内不含该技能就不发这条）、`planner_system(domain)` / `replan_system(domain)`。技能行按域重新从 1 编号。`PLANNER_SYSTEM`/`REPLAN_SYSTEM` 保留为 general 版，旧引用不炸。
- `l1.py`：`plan()` 先路由（或沿用 `domain_name`），返回 `Plan(list)` —— list 子类，`len()/索引/直接下发` 全兼容，`notes`/`domain` 只是挂在上面的属性，不会随 steps 进执行器。`Chain` 加 `domain`（重规划沿用，避免两段计划跨域打架）与 `notes`。
- `mind.py`：`_dispatch`/`_escalate` 收 Plan、记 domain/notes；`_result_event` 在结果句尾附「（规划时提到：…）」，事实归 L2、措辞归 L1。
- `app.py`：`/plan` 额外返回 `domain` 与 `notes`（steps 结构不变，验收脚本不受影响）。
- 专家册只写稳定机制（工具等级、配方链、怪物行为、容器格数），矿石分布标了「1.18+，版本大改要复核」；并写明**我们没有的能力**（熔炼/附魔/精确取槽），避免 L2 规划走不通的链。

**验证**
- 新增 `planner/tests/test_domains.py` 40 项全过：路由 13 例、域内白名单、每域技能都有说明行、域 prompt 不含域外技能（用词边界判，`Minecraft` 里含 mine/craft 会假报）、notes 解析且不混进 steps、阶段名复用、域外技能被拒。
- `test_p2.py` 30 过 1 挂（既有「超过 5 步」，测试写 5 而 `MAX_STEPS=15`，与本次无关）；`test_memory.py` 43/43。
- 真模型（deepseek-flash）6 例实测：`invalid_rate=0`，路由 6/6 正确。典型输出：`去挖点铁矿` → `mine iron_ore ×4` + notes「只有木镐，挖铁矿不掉落，得先有石镐；且没有熔炼能力」——专家册确实在起作用。
- HTTP 端到端（临时 8871 端口）：`/plan` 三例返回 `domain`/`notes` 正确，已停服、端口释放。

**当前状态**：planner 可正常起（`domains.py` 是新依赖，与 `prompts.py` 互相无环）。世界仍停着（25565/8790/8791 空）。
**待办（未做，等机主定）**：五条生存链（MLG 落地水/水下憋气/脱困）、GUI+熔炉技能、`ErrorKind` 式失败码枚举。其中熔炉是采集域「铁链断掉」的根因，优先于其它技能。

## 2026-10-30 加 3 个技能：smelt / sleep / use（熔炉通了）

机主："现在连熔炉都用不了诶"。加 `smelt`、`sleep`、`use`，技能从 12 → 15。

**加一个技能要碰 5 处**（这次没重构，加了自检测试兜住）：
`sidecar/skills/<名>.js` → `sidecar/skills/index.js` 注册 → `planner/schema.py` 白名单 + `_normalize_step` 分支 → `planner/prompts.py` 的 `SKILL_LINES`+`SKILL_EXAMPLES` → `planner/domains.py` 域归属 → `sidecar/tasks.js` 的 `summarize`（给 L1 的那句人话）。

**smelt.js**
- minecraft-data 26.1 的 `recipes.json` 只有合成、**没有烧炼配方**（`mcData.furnaces` 为 false），所以烧炼表与燃料表写死在技能里，只收稳定项。
- 燃料按秒算（煤 80s、煤块 800s、木板/原木 15s、木棍 5s），按「够用前提下挑烧得久的」选。
- 只认普通 `furnace`：高炉烧不了食物、烟熏炉烧不了矿，混用会白等。
- 没熔炉时用 `place` 现放一个；`putInput`→等（input 空或超时）→`takeOutput`；硬校验看成品在背包里真的多了。
- 一次最多 8 个：一炉 10 秒，再多顶到单步超时（`stepTimeoutMs`=120s）。

**sleep.js**：白天直接拒（`not_night`），附近找床，`bot.sleep`，校验 `bot.isSleeping`。
**use.js**：对方块 `activateBlock`、对生物 `activateEntity`；开出来的窗口立刻关掉并报告类型（我们还没有操作窗口的能力，留着会卡住后续技能）；门/按钮/拉杆按了没变化判失败。

**域调整**：gather 加上 smelt/craft/equip（挖矿→烧锭→做镐是一条链，得能一条规划走完，否则 L2 会写出域外的 craft 被拒）；interact 加 use；travel 加 sleep。专家册里原来写的「我们没有熔炼能力」全部改掉了。

**验证**
- `node yuki-bot/scripts/skills-test.js` 45/45：烧炼表/燃料表/无自环、三技能注册、意图校验、摘要人话、以及 `smelt` 七条早退路径（未就绪/取消/缺参/未知/不可烧/没原料/没熔炉）用假 bot 跑真代码。
- `planner/tests/test_domains.py` 44/44，新增四项防漏检查：每个技能都有说明行、都有例子、至少属于一个域、**planner 白名单与执行器注册一致**（直接读 node 的 `SKILL_NAMES`，防两边漂移）。
- `test_p2.py` 30 过 1 挂（既有）、`test_memory.py` 43/43。
- 真模型 4 例：`把这几个粗铁烧成铁锭`→`smelt raw_iron×6`；`挖点铁矿然后烧成铁锭做把铁镐`→`mine→smelt→craft` 完整链；`天黑了去睡一觉`→`sleep`；`把门打开`→`use oak_door`。`invalid_rate=0`。

**未做**：熔炉的真实端到端验收（要起服）。`smelt` 的 putInput/takeOutput 时序只在单测与源码层面验过，没在真服务端跑过一炉。

## 2026-10-30 写 `docs/技能开发指南.md`：加技能的固定流程 + 待添加盘点

机主要求：以后加技能（比如上船）知道怎么做，并盘点还值得加什么。

**文档内容**：技能契约（`{name, run(args,ctx)}` → `{ok, detail}`）／必改的 6 处及「漏了会怎样」／`ctx` 与 `link` 可用面／三条硬纪律／归域标准／参数校验／单测怎么写／完整例子（上船）／起服真验／待添加盘点。
README 项目结构里加了指向。

**写文档时挖出来的一条坑（已写进纪律 3）**：`bot.mount`/`dismount`/`attack`/`activateBlock`/`swingArm` 都是**同步返回、不返回 Promise**，只是发了个包。
`await raceTimeout(bot.mount(e), 5000)` 会当场炸（`bot.mount(e)` 是 `undefined`）。正确写法是发完自己轮询状态。
`openFurnace`/`sleep`/`fish`/`collectBlock.collect` 才是真 Promise。（更正：我先前误记 `activateBlock` 也是这种，查源码后确认 `inventory.js:195` 是 `async function activateBlock`，
`activateEntity` 同为 async，`use.js` 没有问题。只有 `mount`/`dismount`/`attack`/`swingArm` 是同步发包。）

**上船例子已验**：从文档里抽出代码块 `node --check` 通过，`isVehicle` 对 oak_boat/pale_oak_boat/minecart/horse 为真、sheep 为假；
假 ctx 跑了 `bot_not_ready`/`no_vehicle`/`not_riding` 三条路径，行为正确。载具名从 mcData 正则推，不写死（每个版本都加新木种的船）。

**盘点结论（写进文档附录）**
- A 档（核心现成，20–60 行）：`mount` 上船/矿车/马、`fish` 钓鱼、`enchant` 附魔、`anvil` 改名合并、`trade` 村民交易、告示牌/书、`collect` 捡掉落物。
- B 档（要自己 clickWindow）：切石机/织布机/信标/酿造台/合成器 —— 先做 A 档里有封装的那三个，别一上来写通用 GUI。
- C 档（组合型，先别做）：种植收割、繁殖、盾牌、拉弓、鞘翅。
- 不建议：命令方块（要 op、风险高）、酿造。

**待办**
1. `mount` 技能本体（文档里只有例子，验过语法与早退路径，没接到项目里）。
2. 文档附录 A 档的其余项：`fish` / `enchant` / `anvil` / `trade` / `collect`。

## 2026-10-30 脊髓反射：guardian 从「触发器列表」重写成四态状态机（会打怪了）

机主：受攻击/周围有怪时第一反应总是逃跑不好，应该能自己防御；这部分连 L2 都不参与，一直跑、状态转移再告知上层。

**重写 `sidecar/guardian.js`**（文件名与 `Guardian` 导出不变，`index.js` 只加事件转发）
- 四态：`idle` / `defend` / `flee` / `recover`。唯一转移出口 `_enter()`，每次转移上报 `{type:'reflex', from, to, reason, severity}`。
- `idle` 每 250ms 扫 10 格内 `category==='Hostile mobs'`，有怪就 `_decide`。
- `defend` 走 **mineflayer-pvp**（追击/走位/举盾），每刻检查：目标没了、跑出 32 格、缠斗超 45s、血 ≤6、来了苦力怕 → 收手。
- `flee` 沿用原 `survive`/`escape`（吃一口 + 退开；岩浆找安全点或原地跳）。
- `recover` 吃到饥饿值 ≥18（原版回血线，不是吃饱 20）。
- 判据抽成纯函数 `chooseReaction({threats, health, hasWeapon})`，好测、好调：苦力怕永远跑 / >2 只跑 / 血≤6 跑 / 空手且(血<16 或 多只) 跑 / 血<10 跑 / 其余打。
- 打或跑都要抢占：`runner.cancel` + `runner.hold`；收手 `releaseHold`。**正在执行 L2 派的 `attack` 时不抢**（`_inCombat()`），否则任务白废。
- 收手统一上报 `reflex_over`（reason / killed / health），击杀数用 `entityDead` 记，不用 `stoppedAttacking`（我们主动收手时它也会发，会虚计）。

**上报路径**：`reflex`(只在 defend/flee) + `reflex_over` → `POST /event` → `mind.on_event`。
severity：flee=8（会叫醒）、defend=5、recover/idle=3（知会档，不打断）。`mind._event_text` 加了 `reflex_defend/reflex_flee/reflex_over` 的中文标签与「打掉几只/为什么收手」的补语。

**L2 也看得见**：`/state` 加 `reflex` 与 `reflex_reason`；`l1.state_text()` 与 `prompts.world_block()` 都会输出「身体：正跟怪打」，
反射压过任务时不再显示"正在做：mine"，免得 L2 派一条走很远的活当场被打断。

**验证**
- 新增 `node yuki-bot/scripts/reflex-test.js` 29/29：`chooseReaction` 12 例、敌对识别与 10 格筛选与按距离排序、
  状态机骨架（开打抢占/占身、`reflex` 事件带 from/to/reason、血掉下来收手且 reason=low_health、目标没了收手并报 `reflex_over`、冷却）。
- `skills-test.js` 45/45 未回归；`test_domains.py` 44/44、`test_memory.py` 43/43、`test_p2.py` 30 过 1 挂（既有）。
- 没起服，pvp 实战（走位、举盾、苦力怕炸）未验。

**种植/收割、繁殖**：能做但没做。繁殖简单（拿小麦/胡萝卜 `activateEntity` 两只）；种植是组合型（锄地→播种→等成熟→收→补种），
且"等成熟"是长循环，不符合"一个技能一个动作"，得当成 task 而不是 skill。放在反射稳定之后再说。

## 2026-10-30 Yuki 换肤（客户端方案 A）

- 结论：bot 走 `auth:'offline'`、服务端 `online-mode=false`，没有 Mojang 签发的 textures 属性，换肤只能在**看的人客户端**做。
- 装 `CustomSkinLoader_Universal-15.1.jar`（Modrinth，元数据含 26.1.2 fabric）到 `.minecraft/versions/26.1.2-Fabric/mods/`。这个 jar 是 bootstrap，首次启动会把内置的 `CustomSkinLoader-Common.jar` remap 后注入，不需要额外下载。
- 皮肤文件放 `CustomSkinLoader/LocalSkin/skins/Yuki-chan.png`（**不是 `Yuki`**，`configs/local.json` 里 mc.username 是 `Yuki-chan`）。CSL 的 `LocalSkin` 是内置默认 profile（priority 710），默认 loadlist 就带，不用手写 `CustomSkinLoader.json`。
- 皮肤校验：64×64、RGBA，臂区 14px + 右侧 2px 透明 padding，是 **slim/Alex** 模型；CSL 自动判定模型能对上。
- 待验：启动客户端看 Yuki 是否变成该皮肤（本地皮肤只对自己可见，其他玩家仍看到默认皮肤）。

## 2026-10-30 落地自救 MLG：新状态 `mlg`，放水→落进去→把桶收回来

机主问"跌落好做吗"，做了。新增 `sidecar/mlg.js` + `guardian.js` 里第五个状态 `mlg`。

**为什么能做得比较有把握**：`block_place` 对水桶是通用的（`generic_place.js` 直接发原包，不看物品类型），
`activateBlock` 能对水方块按右键把水舀回空桶。两者都在核心，不用插件。

**`mlg.js` 三个纯函数**（能脱离服务器测）
- `fallInfo(bot)`：`velocity.y < -0.75` 且 `!onGround` 才算坠落（普通起跳落地时 vy≈-0.5，不会误判）；
  五条射线（中心 + 碰撞箱四角 ±0.29）往下探，**取最近的那层**——只看正中会从格缝漏下去。
  返回落点方块与「水该放的那一格」（落点顶面）。脚下已经是水就直接不救。
- `shouldMlg()`：纯算术判该不该动手。**离地 ≤3.5 格才放**——太早水会流走，太晚来不及；约剩 0.6 秒，够发一个包。
- `mlgRescue()`：放水 → 等落地（≤3s）→ 落进自己的水就用空桶收回来。

**两个关键取舍**
1. **放水不 await `placeBlock` 的完成确认**（它要等 5 秒的 blockUpdate），只 await `lookAt` 与发包，再轮询 800ms 看那格变没变。
2. **放和收必须在同一段做完**：桶是一次性消耗品，放完不收，第二次摔就没得救。

**上报**：新增 `reflex_mlg` 事件 → `/event`，`mind._event_text` 有对应中文（含"离地 N 格""桶也收回来了/桶留在地上了"）。
`/state` 的 `reflex` 值可为 `mlg`，`l1.state_text` 与 `prompts.world_block` 都加了标签「正在落地自救」。
没有水桶但有危险时只 log 一次（15s 去重），不刷屏。

**验证**：`node yuki-bot/scripts/mlg-test.js` 18/18 —— shouldMlg 七条判据、正常下落算距离、
**站在格缝上取四周最近那层而不是正中那个洞**、脚下是水不触发、站在地上/普通起跳不误判、没落点时直接放弃、状态机能进 mlg。
回归：`reflex-test.js` 29/29、`skills-test.js` 45/45、`test_domains.py` 44/44。

**没验的**：真实坠落下的落地判定与收桶（要起服，从高处跳一次）。时序参数（3.5 格触发、800ms 等水、3s 等落地）是按物理估算的，
真机可能要微调——`MLG_TRIGGER_DISTANCE` 在 `guardian.js` 顶部，`placeWater` 的 800ms 在 `mlg.js`。
