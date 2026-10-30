'use strict'
// scripts/p4-test.js —— P4.2 观察者/聚合器的真机验收：起服 + 侧车，走真实 Minecraft 事件。
// 用法：node scripts/p4-test.js [--sidecar=http://127.0.0.1:8790] [--fifo=/tmp/p4/server.in]
// 场景：初遇实体 / 连续放一组方块只产生一个候选 / 自己放的不算 / 任务里程碑。
// 需要控制台 FIFO 造场景；没有 fifo 只做只读检查。
const fs = require('fs')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const SIDECAR = argOf('sidecar', 'http://127.0.0.1:8790').replace(/\/+$/, '')
const FIFO = argOf('fifo', process.env.P4_FIFO || '')

let passed = 0
let failed = 0
const events = []
let fifoFd = null

function check (name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS ${name}`) } else { failed += 1; console.log(`FAIL ${name}${detail ? ' | ' + JSON.stringify(detail) : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function consoleCmd (line) {
  if (!FIFO) return false
  if (fifoFd === null) fifoFd = fs.openSync(FIFO, 'w')
  fs.writeSync(fifoFd, line + '\n')
  console.log(`  [console] ${line}`)
  return true
}

async function getJson (path) {
  const res = await fetch(`${SIDECAR}${path}`)
  const text = await res.text()
  if (!res.ok) throw new Error(`http_${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}
async function postJson (path, body) {
  const res = await fetch(`${SIDECAR}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {} }
}

async function waitFor (fn, timeoutMs, label) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(300)
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
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() || ''
        for (const chunk of chunks) {
          const line = chunk.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          try { events.push(JSON.parse(line.slice(6))) } catch (_) { /* noop */ }
        }
      }
    } catch (_) { /* 连接结束 */ }
  })()
}

const candidates = async (n = 50) => (await getJson(`/candidates?n=${n}`)).items
const byKind = (items, kind) => items.filter((c) => c.kind === kind)

async function main () {
  await subscribe()
  const state = await getJson('/state')
  check('侧车可达且 bot 在线', state.bot === 'ready', { bot: state.bot })
  check('/state 带观察者状态', Boolean(state.observer && state.observer.stats), state.observer)
  const p = state.pos || { x: 0, y: 64, z: 0 }
  const ox = Math.round(p.x); const oy = Math.round(p.y); const oz = Math.round(p.z)
  console.log(`  她的位置：${ox} ${oy} ${oz}`)

  // 暖机窗口过了再看
  await sleep(5000)

  if (!FIFO) {
    check('没有 fifo，跳过造场景', true)
    return
  }

  // ---------- 场景 1：初遇实体 ----------
  console.log('\n## 场景：初遇实体')
  const sheepBefore = byKind(await candidates(), 'new_entity').filter((c) => c.detail.entity_name === 'sheep').length
  consoleCmd(`/summon minecraft:sheep ${ox + 2} ${oy + 2} ${oz + 2}`)
  const sheep = await waitFor(async () => byKind(await candidates(), 'new_entity').find((c) => c.detail.entity_name === 'sheep'), 8000)
  check('身边出现羊 → 一条 new_entity 候选', Boolean(sheep), sheep)
  check('候选带 novelty 事实（不替你判价值）', sheep && [0, 1].includes(sheep.novelty), sheep && sheep.novelty)
  check('候选没有打分（分数留给 P4.3）', sheep && sheep.salience === null, sheep && sheep.salience)
  if (sheep) {
    consoleCmd(`/summon minecraft:sheep ${ox + 3} ${oy + 2} ${oz + 2}`)
    await sleep(2000)
    const sheepAfter = byKind(await candidates(), 'new_entity').filter((c) => c.detail.entity_name === 'sheep').length
    check('再刷一只羊不重复报（冷却抑制）', sheepAfter === sheepBefore + 1, { before: sheepBefore, after: sheepAfter })
  }

  // ---------- 场景 2：玩家连续放一组方块 ----------
  console.log('\n## 场景：连续放 18 块方块')
  const buildBefore = byKind(await candidates(), 'construction_candidate').length
  let placed = 0
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 3; dx += 1) {
      for (let dz = 0; dz < 3; dz += 1) {
        // keep：只在空气处放，避免改掉她周围原有的地形
        consoleCmd(`/setblock ${ox - 4 + dx} ${oy + 6 + dy} ${oz - 1 + dz} minecraft:${dy ? 'red_wool' : 'white_wool'} keep`)
        placed += 1
      }
    }
  }
  check('造场景：往空气里放了 18 块', placed === 18)
  await sleep(1500)
  const midBuild = byKind(await candidates(), 'construction_candidate').length
  check('静默窗口内还不报（不是每放一块叫一次）', midBuild === buildBefore, { before: buildBefore, mid: midBuild })
  const build = await waitFor(async () => {
    const items = byKind(await candidates(), 'construction_candidate')
    return items.length > buildBefore ? items[items.length - 1] : null
  }, 15000)
  check('静默之后产生一条建造候选', Boolean(build), build && build.detail)
  check('候选块数接近 18（keep 会跳过已占用的格子）', build && build.detail.block_count >= 12 && build.detail.block_count <= 18, build && build.detail.block_count)
  check('候选不给语义断言（pattern=unknown）', build && build.detail.pattern === 'unknown', build && build.detail.pattern)
  check('候选 summary 为空（人话由后面压缩）', build && build.summary === '')
  await sleep(3000)
  const buildAfter = byKind(await candidates(), 'construction_candidate').length
  check('同一组方块只产生一条候选', buildAfter === buildBefore + 1, { before: buildBefore, after: buildAfter })

  // ---------- 场景 3：她自己放的不算世界变化 ----------
  console.log('\n## 场景：她自己放工作台不算「世界的变化」')
  consoleCmd(`/give ${state.username} minecraft:crafting_table 1`)
  await sleep(1000)
  const selfBefore = byKind(await candidates(), 'construction_candidate').length
  const submit = await postJson('/intention', {
    priority: 5,
    origin: 'debug',
    steps: [{ skill: 'place', args: { item: 'crafting_table' }, on_fail: 'abort' }]
  })
  check('place 意图被接收', submit.status === 202, submit.body)
  const done = await waitFor(async () => events.find((e) => e.type === 'task_done' && (e.status === 'done' || e.status === 'failed')), 30000)
  check('place 执行完成', done && done.status === 'done', done && { status: done.status, summary: done.summary })
  await sleep(5000)
  const selfAfter = byKind(await candidates(), 'construction_candidate').length
  check('自己放下的方块没有变成建造候选', selfAfter === selfBefore, { before: selfBefore, after: selfAfter })
  const milestone = byKind(await candidates(), 'task_milestone').find((c) => (c.detail.steps || []).includes('place'))
  check('做完一件事 → 一条 task_milestone 经历', Boolean(milestone), milestone && milestone.detail)
  check('里程碑带着人话摘要', milestone && milestone.summary.length > 0, milestone && milestone.summary)

  // ---------- 收尾：把我造的方块清掉 ----------
  console.log('\n## 收尾')
  consoleCmd(`/fill ${ox - 4} ${oy + 6} ${oz - 1} ${ox - 2} ${oy + 7} ${oz + 1} minecraft:air`)
  const tableAt = done && done.detail && done.detail.results && done.detail.results[0] && done.detail.results[0].at
  if (tableAt) consoleCmd(`/setblock ${tableAt.x} ${tableAt.y} ${tableAt.z} minecraft:air`)
  consoleCmd('/kill @e[type=minecraft:sheep]')
  await sleep(1000)
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  })
  .catch((err) => {
    console.error('p4-test crashed:', err.message)
    process.exit(1)
  })
