'use strict'
// scripts/p1-test.js —— P1 验收：纯脚本驱动，不调任何模型。
// 用法：
//   node scripts/p1-test.js [--sidecar=http://127.0.0.1:8790] [--fifo=/tmp/p1/server.in]
// fifo 存在时用服务端控制台预置场景（方块/箱子/怪/伤害/岩浆）；没有 fifo 时跳过这些场景。
const fs = require('fs')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const SIDECAR = argOf('sidecar', 'http://127.0.0.1:8790').replace(/\/+$/, '')
const FIFO = argOf('fifo', process.env.P1_FIFO || '')

const results = []
const events = []
const waiters = []
let fifoFd = null
let seq = 0

function check (name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + JSON.stringify(detail) : ''}`)
}

function sleep (ms) { return new Promise((r) => setTimeout(r, ms)) }

function consoleCmd (line) {
  if (!FIFO) return false
  if (fifoFd === null) fifoFd = fs.openSync(FIFO, 'w')
  fs.writeSync(fifoFd, line + '\n')
  console.log(`  [console] ${line}`)
  return true
}

function onEvent (event) {
  events.push(event)
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

function waitFor (predicate, timeoutMs, label) {
  const existing = events.find(predicate)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve) => {
    const waiter = { predicate, resolve }
    waiter.timer = setTimeout(() => {
      const i = waiters.indexOf(waiter)
      if (i >= 0) waiters.splice(i, 1)
      resolve(null)
    }, timeoutMs)
    waiters.push(waiter)
    if (label) console.log(`  … 等待 ${label} (${timeoutMs}ms)`)
  })
}

/** 只认调用之后新产生的事件，避免匹配到同类型的旧事件。 */
function waitNew (predicate, timeoutMs, label) {
  const start = events.length
  return waitFor((e) => events.indexOf(e) >= start && predicate(e), timeoutMs, label)
}

async function getJson (path) {
  const res = await fetch(`${SIDECAR}${path}`)
  return res.json()
}

async function post (path, body) {
  const res = await fetch(`${SIDECAR}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  let json = {}
  try { json = await res.json() } catch (_) { /* noop */ }
  return { status: res.status, body: json }
}

async function state () { return getJson('/state') }

async function submit (steps, opts = {}) {
  const intentionId = opts.intention_id || `p1-${++seq}`
  const res = await post('/intention', {
    intention_id: intentionId,
    priority: opts.priority === undefined ? 5 : opts.priority,
    steps,
    origin: 'test'
  })
  return { ...res, intention_id: intentionId }
}

/** 提交一条意图并等它终态。 */
async function runIntention (steps, opts = {}) {
  const sub = await submit(steps, opts)
  if (!sub.body.accepted) return { sub, done: null }
  const done = await waitFor(
    (e) => e.type === 'task_done' && e.intention_id === sub.intention_id,
    opts.timeout || 90000,
    `任务 ${sub.intention_id} 终态`
  )
  return { sub, done }
}

async function waitHealth (min, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await state()
    if (s.health >= min) return s
    await sleep(300)
  }
  return state()
}

async function waitFoodAtMost (max, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let s = await state()
  while (Date.now() < deadline) {
    s = await state()
    if (typeof s.food === 'number' && s.food <= max) return s
    await sleep(250)
  }
  return s
}

function stepDetail (done, index) {
  return (done && done.detail && done.detail.results && done.detail.results[index] && done.detail.results[index].detail) || {}
}

// ---------------- 场景 ----------------
async function scenarioGotoRepeat (origin) {
  console.log('\n## 场景：空地 · 连续 10 次 goto')
  const offsets = [[3, 0], [-3, 0], [0, 3], [0, -3], [3, 3], [-3, -3], [3, -3], [-3, 3], [4, 0], [0, 4]]
  let ok = 0
  for (const [dx, dz] of offsets) {
    const { done } = await runIntention([{ skill: 'goto', args: { x: origin.x + dx, y: origin.y, z: origin.z + dz, range: 1 }, on_fail: 'abort' }], { timeout: 40000 })
    if (done && done.status === 'done') ok += 1
    else console.log(`   goto(${origin.x + dx},${origin.z + dz}) -> ${done ? done.status : 'no_done'}`)
  }
  check('① 连续 10 次 goto 成功率 ≥ 8/10', ok >= 8, { success: ok, total: 10 })
}

async function scenarioQueue (origin) {
  console.log('\n## 场景：队列语义（同级抢占 / 低优先级排队上限 / priority 9 拒收）')

  // 同级抢占：长任务进行中被同优先级任务顶掉
  const before = events.length
  const long = await submit([{ skill: 'goto', args: { x: origin.x + 24, y: origin.y, z: origin.z + 24, range: 1 } }], { priority: 5 })
  const started = await waitFor((e) => e.type === 'task_start' && e.intention_id === long.intention_id, 10000, '长任务开始')
  await sleep(600)
  const short = await submit([{ skill: 'goto', args: { x: origin.x + 2, y: origin.y, z: origin.z + 1, range: 1 } }], { priority: 5 })
  const preemptEvent = await waitFor((e) => e.type === 'preempt' && e.intention_id === long.intention_id, 5000, 'preempt 事件')
  const longDone = await waitFor((e) => e.type === 'task_done' && e.intention_id === long.intention_id, 15000, '旧任务终态')
  const shortDone = await waitFor((e) => e.type === 'task_done' && e.intention_id === short.intention_id, 60000, '新任务终态')
  check('② 同级抢占：旧任务 aborted、新任务完成',
    Boolean(started && preemptEvent) && longDone && longDone.status === 'aborted' && shortDone && shortDone.status === 'done',
    {
      preempt_event: Boolean(preemptEvent),
      old: longDone && longDone.status,
      new_task: shortDone && shortDone.status
    })
  void before

  // 低优先级排队上限 3
  const blocker = await submit([{ skill: 'goto', args: { x: origin.x + 20, y: origin.y, z: origin.z - 20, range: 1 } }], { priority: 6 })
  await waitFor((e) => e.type === 'task_start' && e.intention_id === blocker.intention_id, 10000, '占位任务开始')
  await sleep(300)
  const queued = []
  for (let i = 0; i < 3; i++) {
    queued.push(await submit([{ skill: 'goto', args: { x: origin.x + i, y: origin.y, z: origin.z - 2, range: 1 } }], { priority: 1 }))
  }
  const overflow = await submit([{ skill: 'goto', args: { x: origin.x + 1, y: origin.y, z: origin.z - 3, range: 1 } }], { priority: 1 })
  check('③ 低优先级排队上限 3（第 4 个 429 queue_full）',
    queued.every((q) => q.body.accepted && q.body.queued) && overflow.status === 429 && overflow.body.error === 'queue_full',
    { queued: queued.map((q) => q.body.queued), overflow: { status: overflow.status, error: overflow.body.error }, depth: queued.map((q) => q.body.depth) })

  // 取消占位任务，队列应清空
  await post('/cancel', { intention_id: blocker.intention_id, reason: 'test_cleanup' })
  for (const q of queued) {
    await waitFor((e) => e.type === 'task_done' && e.intention_id === q.intention_id, 30000, '排队任务跑完')
  }
  await sleep(300)

  // priority 9 直投必须被拒（守护逻辑只允许内部硬编码）
  const nine = await submit([{ skill: 'goto', args: { x: origin.x, y: origin.y, z: origin.z, range: 1 } }], { priority: 9 })
  check('④ priority=9 直投被拒（400 priority_out_of_range）',
    nine.status === 400 && nine.body.error === 'priority_out_of_range', { status: nine.status, error: nine.body.error })
}

async function scenarioCancel (origin) {
  console.log('\n## 场景：取消兜底复位')
  const sub = await submit([{ skill: 'goto', args: { x: origin.x + 26, y: origin.y, z: origin.z + 2, range: 1 } }], { priority: 4 })
  await waitFor((e) => e.type === 'task_start' && e.intention_id === sub.intention_id, 10000, '长任务开始')
  await sleep(800)
  const t0 = Date.now()
  await post('/cancel', { intention_id: sub.intention_id })
  let idle = null
  while (Date.now() - t0 < 1500) {
    const s = await state()
    if (s.status === 'idle' && !s.pathing) { idle = s; break }
    await sleep(100)
  }
  const aborted = await waitFor((e) => e.type === 'task_done' && e.intention_id === sub.intention_id && e.status === 'aborted', 5000, '取消终态')
  check('⑤ 取消后 1 秒内停住并回 idle', Boolean(idle) && Boolean(aborted), {
    latency_ms: idle ? Date.now() - t0 : null,
    state: idle && { status: idle.status, pathing: idle.pathing }
  })

  // 复位后还能继续干活（证明 goal/控制状态没卡死）
  const again = await runIntention([{ skill: 'goto', args: { x: origin.x, y: origin.y, z: origin.z, range: 1 } }], { timeout: 40000 })
  check('⑤ 取消后仍能正常执行下一条任务', Boolean(again.done && again.done.status === 'done'), { status: again.done && again.done.status })
}

async function scenarioForest (origin) {
  if (!FIFO) { console.log('\n## 场景：树林 —— 跳过（没有 fifo）'); return }
  console.log('\n## 场景：树林 · mine + craft')
  const bx = origin.x - 4
  const bz = origin.z + 3
  consoleCmd(`/fill ${bx} ${origin.y} ${bz} ${bx + 1} ${origin.y + 2} ${bz + 1} minecraft:oak_log`)
  await sleep(800)

  const { done } = await runIntention([
    { skill: 'mine', args: { block: 'oak_log', count: 3 }, on_fail: 'abort' },
    { skill: 'craft', args: { item: 'oak_planks', count: 8 }, on_fail: 'abort' },
    { skill: 'craft', args: { item: 'wooden_pickaxe', count: 1 }, on_fail: 'abort' }
  ], { timeout: 180000 })
  const mineDetail = stepDetail(done, 0)
  const craftDetail = stepDetail(done, 1)
  const pickDetail = stepDetail(done, 2)
  check('⑥ 树林：mine oak_log ≥3', Boolean(done && done.status === 'done') && mineDetail.mined >= 3, { mined: mineDetail.mined, blocks: done && done.status })
  check('⑦ craft 2×2 木板 ≥8（硬校验背包增量）', craftDetail.crafted >= 8, { crafted: craftDetail.crafted, item: craftDetail.item, error: craftDetail.error })
  check('⑧ 只用木板造出木镐（自动补木棍 + 工作台 3×3）',
    pickDetail.crafted >= 1 && Boolean(done && done.status === 'done'),
    { crafted: pickDetail.crafted, table: pickDetail.table, steps: pickDetail.steps, error: pickDetail.error })

  // place 技能单测：先做一张工作台，再放到脚边，硬校验方块真的出现了
  const placeRes = await runIntention([
    { skill: 'craft', args: { item: 'crafting_table', count: 1 }, on_fail: 'abort' },
    { skill: 'place', args: { item: 'crafting_table' }, on_fail: 'abort' }
  ], { timeout: 60000 })
  const placeDetail = stepDetail(placeRes.done, 1)
  check('⑧b place 放下工作台（方块出现硬校验）',
    Boolean(placeRes.done && placeRes.done.status === 'done') && placeDetail.placed === true,
    { placed: placeDetail.placed, at: placeDetail.at, error: placeDetail.error })
}

async function scenarioMine (origin) {
  if (!FIFO) { console.log('\n## 场景：矿洞 —— 跳过（没有 fifo）'); return }
  console.log('\n## 场景：矿洞 · mine stone')
  const bx = origin.x + 4
  const bz = origin.z - 3
  consoleCmd(`/fill ${bx} ${origin.y} ${bz} ${bx + 2} ${origin.y + 2} ${bz + 1} minecraft:stone`)
  await sleep(800)
  const { done } = await runIntention([{ skill: 'mine', args: { block: 'stone', count: 5 }, on_fail: 'abort' }], { timeout: 120000 })
  const d = stepDetail(done, 0)
  check('⑨ 矿洞：用自己造的镐 mine stone 5（查 drops 得 cobblestone）', Boolean(done && done.status === 'done') && d.mined >= 5, { mined: d.mined, item: d.item, requested: d.requested })
}

async function scenarioEquip (origin) {
  if (!FIFO) { console.log('\n## 场景：装备 —— 跳过（没有 fifo）'); return }
  console.log('\n## 场景：equip')
  consoleCmd('/give Yuki minecraft:diamond_sword 1')
  await sleep(600)
  const { done } = await runIntention([{ skill: 'equip', args: { item: 'diamond_sword' }, on_fail: 'abort' }], { timeout: 20000 })
  const d = stepDetail(done, 0)
  check('⑩ equip 拿在手上（硬校验槽位）', Boolean(done && done.status === 'done') && d.actual === 'diamond_sword', { actual: d.actual, error: d.error })
}

async function scenarioEat (origin) {
  if (!FIFO) { console.log('\n## 场景：进食 —— 跳过（没有 fifo）'); return }
  console.log('\n## 场景：eat')
  consoleCmd('/give Yuki minecraft:bread 3')
  // 饥饿效果 AMP 20 大约 2 秒掉 1 点饥饿，盯到 16 立刻清掉，别掉进守护阈值(6)
  consoleCmd('/effect give Yuki minecraft:hunger 30 20')
  const s = await waitFoodAtMost(16, 30000)
  consoleCmd('/effect clear Yuki minecraft:hunger')
  await sleep(500)
  console.log(`  food=${s.food} health=${s.health}`)
  const { done } = await runIntention([{ skill: 'eat', args: { food: 'bread' }, on_fail: 'abort' }], { timeout: 20000 })
  const d = stepDetail(done, 0)
  check('⑪ eat 后饥饿值真的上升', Boolean(done && done.status === 'done') && d.food_after > d.food_before, {
    before: d.food_before, after: d.food_after, item: d.item, error: d.error
  })
}

async function scenarioAttack (origin) {
  if (!FIFO) { console.log('\n## 场景：战斗 —— 跳过（没有 fifo）'); return }
  console.log('\n## 场景：attack')
  consoleCmd('/effect clear Yuki')
  consoleCmd('/effect give Yuki minecraft:instant_health 1 20')
  await waitHealth(18)
  const zx = origin.x + 9
  const zz = origin.z + 1
  consoleCmd(`/summon minecraft:zombie ${zx} ${origin.y} ${zz}`)
  await sleep(1200)
  const { done } = await runIntention([{ skill: 'attack', args: { target: 'zombie', count: 1 }, on_fail: 'abort' }], { timeout: 90000 })
  const d = stepDetail(done, 0)
  check('⑫ attack 打死僵尸（实体消失硬校验）', Boolean(done && done.status === 'done') && d.killed >= 1, {
    killed: d.killed, status: done && done.status, error: d.error
  })
  consoleCmd('/kill @e[type=minecraft:zombie]')
  await sleep(500)
}

async function scenarioDepositChain (origin) {
  if (!FIFO) { console.log('\n## 场景：存取链路 —— 跳过（没有 fifo）'); return }
  console.log('\n## 场景：mine → goto 家 → deposit')
  consoleCmd('/effect give Yuki minecraft:instant_health 1 20')
  await waitHealth(18)
  const bx = origin.x + 2
  const bz = origin.z - 3
  const cx = origin.x - 4
  const cz = origin.z - 4
  consoleCmd(`/fill ${bx} ${origin.y} ${bz} ${bx + 1} ${origin.y + 2} ${bz + 1} minecraft:stone`)
  consoleCmd(`/setblock ${cx} ${origin.y} ${cz} minecraft:chest`)
  await sleep(800)
  const before = await state()
  const cobble = (before.inventory || []).find((i) => i.name === 'cobblestone')
  const beforeCobble = cobble ? cobble.count : 0

  const { done } = await runIntention([
    { skill: 'mine', args: { block: 'stone', count: 5 }, on_fail: 'abort' },
    { skill: 'goto', args: { x: cx, y: origin.y, z: cz, range: 2 }, on_fail: 'abort' },
    { skill: 'deposit', args: { x: cx, y: origin.y, z: cz }, on_fail: 'abort' }
  ], { timeout: 180000 })
  const dep = stepDetail(done, 2)
  const after = await state()
  const afterCobble = (after.inventory || []).find((i) => i.name === 'cobblestone')
  check('⑬ 全链路 mine → goto 家 → deposit 完成', Boolean(done && done.status === 'done'), { status: done && done.status, summary: done && done.summary })
  check('⑬ deposit 硬校验：箱子收到东西、背包的圆石减少',
    dep.deposited > 0 && (afterCobble ? afterCobble.count : 0) < beforeCobble,
    { deposited: dep.deposited, container: dep.container, cobble_before: beforeCobble, cobble_after: afterCobble ? afterCobble.count : 0 })
}

async function scenarioGuardianHurt (origin) {
  if (!FIFO) { console.log('\n## 场景：守护逻辑 —— 跳过（没有 fifo）'); return }
  console.log('\n## 场景：守护逻辑 · 受击抢占（priority 9）')
  consoleCmd('/effect clear Yuki')
  consoleCmd('/effect give Yuki minecraft:instant_health 1 20')
  await waitHealth(18)
  // 先让食物回到高位，避免饥饿守护误触发
  consoleCmd('/effect give Yuki minecraft:saturation 10 10')
  await sleep(400)

  const sub = await submit([{ skill: 'goto', args: { x: origin.x + 30, y: origin.y, z: origin.z + 3, range: 1 } }], { priority: 5 })
  await waitFor((e) => e.type === 'task_start' && e.intention_id === sub.intention_id, 10000, '长任务开始')
  await sleep(1200)
  consoleCmd('/damage Yuki 8')
  const emergency = await waitNew((e) => e.type === 'emergency', 8000, 'emergency 事件')
  const aborted = await waitFor((e) => e.type === 'task_done' && e.intention_id === sub.intention_id, 15000, '被抢占任务终态')
  check('⑭ 受击触发守护抢占（emergency + 任务 aborted）',
    Boolean(emergency) && emergency.kind === 'hurt' && aborted && aborted.status === 'aborted' && String(aborted.reason || '').startsWith('guardian:'),
    { kind: emergency && emergency.kind, status: aborted && aborted.status, reason: aborted && aborted.reason })

  // 等守护动作收尾
  await sleep(4000)
  consoleCmd('/effect give Yuki minecraft:instant_health 1 20')

  // 低血阈值
  const sub2 = await submit([{ skill: 'goto', args: { x: origin.x - 30, y: origin.y, z: origin.z + 3, range: 1 } }], { priority: 5 })
  await waitFor((e) => e.type === 'task_start' && e.intention_id === sub2.intention_id, 10000, '长任务开始')
  await sleep(1200)
  consoleCmd('/damage Yuki 16')
  const emergency2 = await waitNew((e) => e.type === 'emergency' && e.kind === 'low_health', 8000, 'low_health 事件')
  const aborted2 = await waitFor((e) => e.type === 'task_done' && e.intention_id === sub2.intention_id, 15000, '被抢占任务终态')
  check('⑮ 低血阈值触发守护（low_health + aborted）',
    Boolean(emergency2) && aborted2 && aborted2.status === 'aborted',
    { kind: emergency2 && emergency2.kind, status: aborted2 && aborted2.status })
  await sleep(4000)
  consoleCmd('/effect clear Yuki')
  consoleCmd('/effect give Yuki minecraft:instant_health 1 20')
}

async function scenarioGuardianLava (origin) {
  if (!FIFO) { console.log('\n## 场景：岩浆 —— 跳过（没有 fifo）'); return }
  console.log('\n## 场景：守护逻辑 · 脚下岩浆')
  const s = await state()
  const p = s.pos
  consoleCmd(`/setblock ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)} minecraft:lava`)
  const emergency = await waitNew((e) => e.type === 'emergency' && e.kind === 'lava', 8000, 'lava 事件')
  await sleep(6000)
  const after = await state()
  const blocks = after.pos
  let inLava = true
  if (blocks) {
    // 用 Tester 视角不可靠，直接看状态：活着且位置变了/血量 > 0 即视为逃出
    inLava = Math.floor(blocks.x) === Math.floor(p.x) && Math.floor(blocks.z) === Math.floor(p.z)
  }
  check('⑯ 脚下岩浆触发守护并逃生', Boolean(emergency) && after.health > 0 && !inLava, {
    kind: emergency && emergency.kind, health: after.health, from: p, to: blocks
  })
  consoleCmd(`/setblock ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)} minecraft:air`)
  consoleCmd('/effect give Yuki minecraft:instant_health 1 20')
}

// ---------------- 主流程 ----------------
async function main () {
  console.log(`== P1 验收 == sidecar=${SIDECAR} fifo=${FIFO || '(none)'}`)
  await subscribe()
  const s0 = await state()
  check('L3 侧车 bot 在线', s0.bot === 'ready', { pos: s0.pos, hp: s0.health, food: s0.food })
  if (!s0.pos) { console.log('bot 没有位置信息，退出'); process.exit(2) }
  let origin = { x: Math.round(s0.pos.x), y: Math.round(s0.pos.y), z: Math.round(s0.pos.z) }

  if (FIFO) {
    consoleCmd('/gamerule spawn_monsters false')
    consoleCmd('/time set day')
    consoleCmd('/clear Yuki')
    consoleCmd('/weather clear')
    // 搭一块 13×13 平台并在上面清空，保证「空地」场景与传送不再受出生点地形影响
    const base = { x: origin.x, y: origin.y + 2, z: origin.z }
    consoleCmd(`/fill ${base.x - 7} ${base.y} ${base.z - 7} ${base.x + 7} ${base.y} ${base.z + 7} minecraft:stone`)
    consoleCmd(`/fill ${base.x - 7} ${base.y + 1} ${base.z - 7} ${base.x + 7} ${base.y + 5} ${base.z + 7} minecraft:air`)
    consoleCmd(`/tp Yuki ${base.x + 0.5} ${base.y + 1.2} ${base.z + 0.5}`)
    await sleep(2000)
    const s1 = await state()
    if (s1.pos) origin = { x: Math.round(base.x), y: Math.round(base.y + 1), z: Math.round(base.z) }
    console.log(`  测试平台: ${JSON.stringify(origin)}`)
  }

  await scenarioGotoRepeat(origin)
  await scenarioQueue(origin)
  await scenarioCancel(origin)
  await scenarioForest(origin)
  await scenarioMine(origin)
  await scenarioEquip(origin)
  await scenarioEat(origin)
  await scenarioAttack(origin)
  await scenarioDepositChain(origin)
  await scenarioGuardianHurt(origin)
  await scenarioGuardianLava(origin)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n== 汇总: ${results.length - failed.length}/${results.length} 通过 ==`)
  if (failed.length) console.log('失败项:\n  - ' + failed.map((r) => r.name).join('\n  - '))
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('测试脚本异常:', err.stack || err.message)
  process.exit(2)
})
