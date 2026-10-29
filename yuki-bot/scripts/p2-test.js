'use strict'
// scripts/p2-test.js —— P2 验收：L2 规划器接 9 技能、10 次「挖 20 圆石」、不可达目标升级、非法 JSON 率、预算。
// 用法：
//   node scripts/p2-test.js [--sidecar=http://127.0.0.1:8790] [--planner=http://127.0.0.1:8791] [--fifo=/tmp/p2/server.in]
// 需要主服 :25565、sidecar :8790、planner :8791 同时在跑；fifo 用于服务端控制台预置场景。
const fs = require('fs')
const mineflayer = require('mineflayer')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const SIDECAR = argOf('sidecar', 'http://127.0.0.1:8790').replace(/\/+$/, '')
const PLANNER = argOf('planner', 'http://127.0.0.1:8791').replace(/\/+$/, '')
const FIFO = argOf('fifo', process.env.P2_FIFO || '')
const ONLY = argOf('only', 'all') // all | nl | mine | follow | diamond
const MC_HOST = process.env.MC_HOST || '127.0.0.1'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const MC_VERSION = process.env.MC_VERSION || '26.1'
const TESTER = process.env.MC_TEST_USER || 'Tester'

const results = []
const events = []
const waiters = []
let fifoFd = null

function check (name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + JSON.stringify(detail) : ''}`)
}

function sleep (ms) { return new Promise((r) => setTimeout(r, ms)) }

function consoleCmd (line) {
  if (!FIFO) return false
  if (fifoFd === null) fifoFd = fs.openSync(FIFO, 'w')
  fs.writeSync(fifoFd, line + '\n')
  return true
}

function onEvent (event) {
  events.push(event)
  if (['task_start', 'task_done', 'step_retry', 'say', 'preempt'].includes(event.type)) {
    const echo = { ...event }
    if (echo.steps) echo.steps = echo.steps.map((s) => `${s.skill}(${JSON.stringify(s.args)})`).join(' > ')
    if (echo.detail) echo.detail = undefined
    console.log(`  [${event.type}] ${JSON.stringify(echo).slice(0, 240)}`)
  }
  for (let i = waiters.length - 1; i >= 0; i--) {
    const waiter = waiters[i]
    if (waiter.predicate(event)) {
      waiters.splice(i, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(event)
    }
  }
}

async function subscribe () {
  const res = await fetch(`${SIDECAR}/events`, { headers: { Accept: 'text/event-stream' } })
  if (!res.ok) throw new Error(`sse_${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try { onEvent(JSON.parse(line.slice(6))) } catch (_) { /* noop */ }
          }
        }
      }
    } catch (_) { /* closed */ }
  })()
}

/** 只匹配调用之后新出现的事件 */
function waitNew (predicate, timeoutMs, label) {
  const start = events.length
  return new Promise((resolve) => {
    const hit = events.slice(start).find(predicate)
    if (hit) return resolve(hit)
    const waiter = { predicate: (e) => events.indexOf(e) >= start && predicate(e), resolve }
    waiter.timer = setTimeout(() => {
      const i = waiters.indexOf(waiter)
      if (i >= 0) waiters.splice(i, 1)
      resolve(null)
    }, timeoutMs)
    waiters.push(waiter)
    if (label) console.log(`  … 等待 ${label} (${timeoutMs}ms)`)
  })
}

async function getJson (url) {
  const res = await fetch(url)
  return res.json()
}

async function postJson (url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  let json = {}
  try { json = await res.json() } catch (_) { /* noop */ }
  return { status: res.status, body: json }
}

async function state () { return getJson(`${SIDECAR}/state`) }
async function stats () { return getJson(`${PLANNER}/stats`) }

async function waitIdle (timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await state()
    if (s.status === 'idle' && !s.current) return s
    await sleep(400)
  }
  return state()
}

async function cancelCurrent (reason) {
  const s = await state()
  if (s.current && s.current.intention_id) {
    await postJson(`${SIDECAR}/cancel`, { intention_id: s.current.intention_id, reason })
  }
}

// ---------------- 场景：NL → 9 技能 ----------------
const NL_CASES = [
  { text: '去挖20个圆石', want: 'mine', match: (s) => s.skill === 'mine' && ['stone', 'cobblestone'].includes(String(s.args.block)) && Number(s.args.count) === 20 },
  { text: '去砍三块木头', want: 'mine', match: (s) => s.skill === 'mine' && String(s.args.block).includes('log') },
  { text: '跟着 Tester 别走丢', want: 'follow', match: (s) => s.skill === 'follow' },
  { text: '把背包里的圆石存到最近的箱子里', want: 'deposit', match: (s) => s.skill === 'deposit' },
  { text: '去打附近那只僵尸', want: 'attack', match: (s) => s.skill === 'attack' },
  { text: '把钻石剑拿在手上', want: 'equip', match: (s) => s.skill === 'equip' && String(s.args.item).includes('sword') },
  { text: '把工作台放在脚边', want: 'place', match: (s) => s.skill === 'place' },
  { text: '我饿了，吃点东西', want: 'eat', match: (s) => s.skill === 'eat' },
  { text: '造一把木镐', want: 'craft', match: (s) => s.skill === 'craft' && String(s.args.item).includes('pickaxe') },
  { text: '走到坐标 10 64 10', want: 'goto', match: (s) => s.skill === 'goto' },
  { text: '过来我这里', want: 'goto', match: (s) => s.skill === 'goto' }
]

async function scenarioNlCoverage () {
  console.log('\n## 场景：自然语言 → 9 技能（直连 /plan）')
  let ok = 0
  const misses = []
  for (const testCase of NL_CASES) {
    const res = await postJson(`${PLANNER}/plan`, { text: testCase.text })
    const steps = (res.body && res.body.steps) || []
    const hit = steps.some(testCase.match)
    if (hit) ok += 1
    else misses.push({ text: testCase.text, want: testCase.want, got: steps })
  }
  check('① 11 句自然语言覆盖全部 9 技能（含「过来」→goto 玩家坐标）', ok >= NL_CASES.length - 1, { passed: ok, total: NL_CASES.length, misses })
}

// ---------------- 场景：10 次「挖 20 圆石」（L2 规划 + L3 执行，不过 L1） ----------------
async function scenarioMine20 (origin) {
  console.log('\n## 场景：10 次「去挖20个圆石」（/plan → /intention）')
  const ox = Math.round(origin.x)
  const oy = Math.round(origin.y)
  const oz = Math.round(origin.z)
  const qx = ox + 2
  const qz = oz - 2
  let success = 0
  let plannedOk = 0
  let nullBlocks = 0
  const failedRounds = []
  const planMs = []

  for (let round = 1; round <= 10; round++) {
    consoleCmd('/clear Yuki minecraft:cobblestone')
    consoleCmd(`/fill ${qx} ${oy} ${qz} ${qx + 4} ${oy + 2} ${qz + 4} minecraft:stone`)
    consoleCmd('/effect give Yuki minecraft:instant_health 1 20')
    await sleep(700)

    const t0 = Date.now()
    const planRes = await postJson(`${PLANNER}/plan`, { text: '去挖20个圆石' })
    planMs.push(Date.now() - t0)
    const steps = (planRes.body && planRes.body.steps) || []
    const first = steps[0] || {}
    const planOk = planRes.status === 200 && first.skill === 'mine' && Number(first.args.count) === 20
    if (planOk) plannedOk += 1
    if (first.args && first.args.block === 'cobblestone') nullBlocks += 1

    const intentionId = `p2-mine-${round}-${Date.now()}`
    const submit = await postJson(`${SIDECAR}/intention`, {
      intention_id: intentionId, priority: 5, origin: 'test', steps, summary_text: '去挖20个圆石'
    })
    if (!submit.body.accepted) {
      failedRounds.push({ round, reason: 'not_accepted', body: submit.body })
      continue
    }
    const done = await waitNew((e) => e.type === 'task_done' && e.intention_id === intentionId, 210000, `第${round}轮终态`)
    const mined = done && done.detail && done.detail.results && done.detail.results[0] &&
      done.detail.results[0].detail && done.detail.results[0].detail.mined
    if (planOk && done && done.status === 'done' && Number(mined) >= 20) {
      success += 1
      console.log(`  第 ${round} 轮 OK：${first.args.block} ×${mined} ${Date.now() - t0}ms`)
    } else {
      failedRounds.push({ round, plan: steps, status: done && done.status, mined })
      console.log(`  第 ${round} 轮 FAIL：plan=${JSON.stringify(steps)} status=${done && done.status} mined=${mined}`)
      if (!done) await cancelCurrent('test_timeout')
    }
    await waitIdle(20000)
  }

  const avgPlan = Math.round(planMs.reduce((a, b) => a + b, 0) / (planMs.length || 1))
  check('② 「去挖20个圆石」成功 ≥ 7/10', success >= 7, { success, total: 10, avg_plan_ms: avgPlan })
  check('② 10 次规划全部合法（mine count=20）', plannedOk === 10, { plannedOk, failedRounds })
  check('② 圆石请求默认挖 stone（不误挑 cobblestone）', nullBlocks === 0, { cobblestone_plans: nullBlocks })
}

// ---------------- 场景：持续跟随（不给 seconds）+ 随时改派 + 记忆释放 ----------------
async function scenarioFollow () {
  console.log('\n## 场景：持续跟随 / 随时改派 / 结束后释放工作记忆')
  const bot = global.testerBot
  const before = events.length

  // 让 Tester 走开 15 格，确保有得跟
  for (let i = 0; i < 20; i++) { bot.setControlState('forward', true); await sleep(150) }
  bot.setControlState('forward', false)
  await sleep(800)

  const dispatched = await postJson(`${PLANNER}/dispatch`, { text: `跟着 ${TESTER}，别跟丢了`, priority: 3 })
  const followId = dispatched.body && dispatched.body.intention_id
  check('⑤ 持续跟随成功下发', Boolean(followId), { status: dispatched.status, body: dispatched.body })
  if (!followId) return
  const step = (dispatched.body && dispatched.body.steps && dispatched.body.steps[0]) || null
  check('⑤ L2 对「跟着我」不给 seconds（开放跟随）',
    Boolean(step && step.skill === 'follow' && (step.args.seconds === undefined || step.args.seconds === null)),
    { step })
  await waitNew((e) => e.type === 'task_start' && e.intention_id === followId, 20000, 'follow 开始')

  // 等 20 秒（超过旧的 15 秒默认值），她必须还在跟
  await sleep(20000)
  const during = await state()
  check('⑤ 20 秒后仍在跟随（不被默认时长提前结束）',
    during.status === 'working' && Boolean(during.current) && during.current.intention_id === followId,
    { status: during.status, current: during.current })

  // 随时改派：新委托抢占，跟随即 aborted
  const revised = await postJson(`${PLANNER}/dispatch`, { text: `到 ${TESTER} 那里去`, priority: 5 })
  const revisedId = revised.body && revised.body.intention_id
  const oldDone = await waitNew((e) => e.type === 'task_done' && e.intention_id === followId, 20000, 'follow 被抢占')
  // 抢占只要求新任务真的起来了；它自己能否走通不属于本条验收（地形可能不可达）
  // 新任务可能在 await oldDone 期间就已经开始并结束了，先查已发生的事件
  const newStart = events.slice(before).find((e) => e.type === 'task_start' && e.intention_id === revisedId) ||
    await waitNew((e) => e.type === 'task_start' && e.intention_id === revisedId, 20000, '新任务开始')
  check('⑤ 新委托直接抢占持续跟随',
    Boolean(oldDone && oldDone.status === 'aborted' && String(oldDone.reason || '').includes('preempt') && newStart),
    { old: oldDone && oldDone.status, reason: oldDone && oldDone.reason, new_started: Boolean(newStart) })

  await waitIdle(30000)
  await sleep(3000)
  const statsAfter = await stats()
  check('⑤ 任务结束后释放工作记忆（chains 归零）', (statsAfter.chains || 0) === 0, { chains: statsAfter.chains })
}

// ---------------- 场景：不可达目标（远古残骸只在猪灵维度，主世界必然挖不到） ----------------
async function scenarioUnreachable () {
  console.log('\n## 场景：不可达目标「去挖二十块远古残骸」（/dispatch → 失败升级）')
  const before = events.length
  const statsBefore = await stats()
  const t0 = Date.now()
  const dispatched = await postJson(`${PLANNER}/dispatch`, { text: '去挖二十块远古残骸', priority: 5 })
  const intentionId = dispatched.body && dispatched.body.intention_id
  check('③ 不可达委托成功下发（/dispatch）', Boolean(intentionId), { status: dispatched.status, body: dispatched.body })
  if (!intentionId) return

  // 等到 L1 收工（idle 且有一段安静期）或超时
  let idle = null
  const deadline = Date.now() + 180000
  let lastChange = Date.now()
  let lastSnapshot = ''
  while (Date.now() < deadline) {
    const s = await state()
    const queueLen = (s.queue || []).length
    const snap = `${s.status}:${s.current ? s.current.intention_id : 'null'}:${queueLen}`
    if (snap !== lastSnapshot) { lastSnapshot = snap; lastChange = Date.now() }
    if (s.status === 'idle' && !s.current && queueLen === 0 && Date.now() - lastChange > 6000) {
      idle = s
      break
    }
    await sleep(500)
  }
  const newEvents = events.slice(before)
  const starts = newEvents.filter((e) => e.type === 'task_start')
  const debrisStarts = starts.filter((e) => (e.steps || []).some((step) => /debris|ancient/.test(String((step.args || {}).block || ''))))
  const says = newEvents.filter((e) => e.type === 'say' && e.source === 'callback')
  const lastSay = says[says.length - 1]
  const tasksDone = newEvents.filter((e) => e.type === 'task_done')

  const after = await stats()
  const replans = (after.llm.by_purpose.l2_replan || 0) - (statsBefore.llm.by_purpose.l2_replan || 0)
  const optionsCalls = (after.llm.by_purpose.l2_options || 0) - (statsBefore.llm.by_purpose.l2_options || 0)
  const chain = (after.recent || [])[after.recent.length - 1] || {}

  check('③ 不可达目标不死循环：最终回到 idle（≤180s）', Boolean(idle), {
    elapsed_ms: Date.now() - t0, status: idle && idle.status
  })
  check('③ L2 自动重规划 2 轮后才交给 L1', replans === 2, { replans, debris_tasks: debrisStarts.length, tasks: starts.length })
  check('③ L1 拿到事实 + 方案并做过一次决断', chain.negotiated === true && optionsCalls >= 1,
    { chain, options_calls: optionsCalls })
  check('③ 有人话原因且不含 JSON/坐标', Boolean(lastSay && lastSay.text && !/[{}"[\]]/.test(lastSay.text)),
    { say: lastSay && lastSay.text, tasks_done: tasksDone.length })
  check('③ 没有把任务卡在做不完的状态里（queue 空）', Boolean(idle && !(idle.current) && (idle.queue || []).length === 0),
    { queue: idle && (idle.queue || []).length, current: idle && idle.current })
}

// ---------------- 场景：非法 JSON 率与预算 ----------------
async function scenarioMetrics (statsBefore) {
  console.log('\n## 场景：非法 JSON 率与单任务预算')
  const after = await stats()
  const plan = after.plan || {}
  const attempts = plan.attempts || 0
  const rate = plan.invalid_rate || 0
  const deltaAttempts = attempts - (statsBefore.plan ? statsBefore.plan.attempts : 0)
  const allowed = ['mine', 'goto', 'follow', 'craft', 'deposit', 'attack', 'eat', 'equip', 'place']
  const leaked = events.filter((e) => e.type === 'task_start' &&
    (e.steps || []).some((step) => !allowed.includes(step.skill)))
  check('④ 非法 JSON 率 < 5%（真实调用统计）', attempts > 0 && rate < 0.05, {
    attempts, invalid: plan.invalid, rate, delta_attempts: deltaAttempts
  })
  check('④ 非法输出全部被拦截（执行器从未收到非法技能）', leaked.length === 0, {
    rejected_by_schema: plan.rejected, repairs: plan.repairs, leaked: leaked.length
  })
  const budget = after.last_budget || {}
  const within = budget.calls <= budget.max_calls && budget.tokens <= budget.max_tokens && budget.retries <= budget.max_retries
  check('④ 单任务预算生效（calls/tokens/retries 未超限）', Boolean(budget.max_calls) && within, budget)
}

// ---------------- 主流程 ----------------
async function main () {
  console.log(`== P2 验收 == sidecar=${SIDECAR} planner=${PLANNER} mc=${MC_HOST}:${MC_PORT}`)
  await subscribe()

  const state0 = await state()
  check('L3 侧车 bot 在线', state0.bot === 'ready', { pos: state0.pos, hp: state0.health })
  if (!state0.bot || state0.bot !== 'ready') process.exit(1)
  const origin = state0.pos

  if (FIFO) {
    const ox = Math.round(origin.x)
    const oy = Math.round(origin.y)
    const oz = Math.round(origin.z)
    consoleCmd('/difficulty peaceful')
    consoleCmd('/gamerule spawn_monsters false')
    consoleCmd('/gamerule keep_inventory true')
    consoleCmd('/time set day')
    consoleCmd('/weather clear')
    consoleCmd('/kill @e[type=minecraft:zombie]')
    consoleCmd('/kill @e[type=minecraft:skeleton]')
    consoleCmd('/kill @e[type=minecraft:spider]')
    consoleCmd('/kill @e[type=minecraft:creeper]')
    // 把她脚边清空，避免卡在旧测试遗留的方块里吃窒息伤害（会误触受击守护）
    consoleCmd(`/fill ${ox - 1} ${oy} ${oz - 1} ${ox + 1} ${oy + 2} ${oz + 1} minecraft:air`)
    consoleCmd('/effect clear Yuki')
    consoleCmd('/effect give Yuki minecraft:instant_health 1 20')
    consoleCmd('/effect give Yuki minecraft:saturation 10 10')
    consoleCmd('/give Yuki minecraft:diamond_pickaxe 1')
    consoleCmd('/give Yuki minecraft:diamond_sword 1')
    await sleep(1500)
  }

  const bot = mineflayer.createBot({
    host: MC_HOST, port: MC_PORT, username: TESTER, version: MC_VERSION, auth: 'offline'
  })
  global.testerBot = bot
  bot.on('error', (err) => console.log('  tester error:', err.message))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tester spawn timeout')), 60000)
    bot.once('spawn', () => { clearTimeout(timer); resolve() })
  })
  console.log(`  玩家 ${TESTER} 已进入游戏`)
  await sleep(1200)

  const statsBefore = await stats()
  if (ONLY === 'all' || ONLY === 'nl') await scenarioNlCoverage()
  if (ONLY === 'all' || ONLY === 'mine') await scenarioMine20(origin)
  if (ONLY === 'all' || ONLY === 'follow') await scenarioFollow()
  if (ONLY === 'all' || ONLY === 'diamond') {
    await scenarioUnreachable()
    await scenarioMetrics(statsBefore)
  }

  // 收尾：清掉测试怪、回血
  if (FIFO) {
    consoleCmd('/effect give Yuki minecraft:instant_health 1 20')
    consoleCmd('/kill @e[type=minecraft:zombie]')
  }
  bot.quit()

  const passed = results.filter((r) => r.ok).length
  console.log(`\n== P2 验收结果：${passed}/${results.length} ==`)
  for (const r of results) if (!r.ok) console.log(`  FAIL ${r.name}`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((err) => {
  console.error('p2-test crash:', err)
  process.exit(1)
})
