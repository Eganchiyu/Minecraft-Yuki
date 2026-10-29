'use strict'
// scripts/m0-test.js —— M0 验收脚本：模拟玩家在公屏喊话，断言全链路。
// 用法: node scripts/m0-test.js [--sidecar=http://127.0.0.1:8790] [--planner=http://127.0.0.1:8791]
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}
const SIDECAR = argOf('sidecar', 'http://127.0.0.1:8790').replace(/\/+$/, '')
const PLANNER = argOf('planner', 'http://127.0.0.1:8791').replace(/\/+$/, '')
const MC_HOST = process.env.MC_HOST || '127.0.0.1'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const MC_VERSION = process.env.MC_VERSION || '26.1'
const TESTER = process.env.MC_TEST_USER || 'Tester'

const results = []
const said = []
const events = []
const waiters = []

function check (name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + JSON.stringify(detail) : ''}`)
}

function sleep (ms) { return new Promise((r) => setTimeout(r, ms)) }

function onEvent (event) {
  events.push(event)
  if (event.type === 'say') {
    said.push(event)
    console.log(`  [say/${event.source}] ${event.text}`)
  } else if (['task_start', 'task_done', 'step_done', 'chat_in'].includes(event.type)) {
    console.log(`  [${event.type}] ${JSON.stringify(event).slice(0, 220)}`)
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

// 订阅 sidecar 的 SSE 事件流
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
    } catch (_) { /* stream closed */ }
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
    console.log(`  … 等待 ${label} (${timeoutMs}ms)`)
  })
}

async function getJson (url) {
  const res = await fetch(url)
  return res.json()
}

async function main () {
  console.log(`== M0 验收 == sidecar=${SIDECAR} planner=${PLANNER} mc=${MC_HOST}:${MC_PORT}`)
  await subscribe()

  const state0 = await getJson(`${SIDECAR}/state`)
  check('L3 侧车 bot 在线', state0.bot === 'ready', { pos: state0.pos, hp: state0.health })
  const stats0 = await getJson(`${PLANNER}/stats`)

  const bot = mineflayer.createBot({
    host: MC_HOST, port: MC_PORT, username: TESTER, version: MC_VERSION, auth: 'offline'
  })
  bot.on('error', (err) => console.log('  tester error:', err.message))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tester spawn timeout')), 60000)
    bot.once('spawn', () => { clearTimeout(timer); resolve() })
  })
  console.log(`  玩家 ${TESTER} 已进入游戏 @ ${bot.entity.position}`)
  await sleep(1500)

  // 0) 环境预置校验：/fill 这类无返回命令必须用世界状态二次确认
  if (state0.pos && bot.registry) {
    const stoneId = bot.registry.blocksByName.stone.id
    const found = bot.findBlocks({
      point: new Vec3(Math.round(state0.pos.x), Math.round(state0.pos.y), Math.round(state0.pos.z)),
      matching: stoneId, maxDistance: 24, count: 64
    })
    check('环境预置：Yuki 附近有 ≥3 块石头', found.length >= 3, { nearby_stone: found.length })
  }

  // 1) 公屏喊话：她要用自己的语气回一句，且任务下发成功
  const t0 = Date.now()
  bot.chat('yuki 去挖点石头')
  const firstSay = await waitFor((e) => e.type === 'say' && e.source === 'chat', 30000, '她的第一句回话')
  check('① 公屏喊话后她回话（非空、无 JSON）', Boolean(firstSay && !/[{}"]/.test(firstSay.text)), {
    say: firstSay && firstSay.text, latency_ms: firstSay ? Date.now() - t0 : null
  })
  const taskStart = await waitFor((e) => e.type === 'task_start', 15000, '任务开始')
  check('① 任务成功下发到 L3', Boolean(taskStart), { steps: taskStart && taskStart.steps })
  // 下发这一轮的成本（听 + 规划 + 回话）先记下来，插话与汇报单独算
  const statsDispatch = await getJson(`${PLANNER}/stats`)

  // 2) 挖矿途中插话，验证不阻塞
  await sleep(5000)
  const tChat = Date.now()
  bot.chat('yuki 你在干嘛呀')
  const midSay = await waitFor(
    (e) => e.type === 'say' && e.source === 'chat' && e !== firstSay,
    20000, '挖矿途中的回话'
  )
  const doneBeforeMid = events.some((e) => e.type === 'task_done' && e.at <= (midSay ? midSay.at : Date.now()))
  check('④ 挖矿途中仍能回话（任务未结束）', Boolean(midSay) && !doneBeforeMid, {
    say: midSay && midSay.text, latency_ms: midSay ? Date.now() - tChat : null
  })

  // 3) 等任务收尾：硬校验结果 + 主动汇报
  const taskDone = await waitFor((e) => e.type === 'task_done', 240000, '任务终态')
  const firstResult = taskDone && taskDone.detail && taskDone.detail.results && taskDone.detail.results[0]
  const firstDetail = (firstResult && firstResult.detail) || {}
  check('② 任务拿到终态且状态 done', Boolean(taskDone) && taskDone.status === 'done', {
    status: taskDone && taskDone.status, summary: taskDone && taskDone.summary
  })
  check('② 背包增量 ≥ 3 石头（硬校验）', Boolean(firstResult) && Number(firstDetail.mined) >= 3, {
    mined: firstDetail.mined, requested: firstDetail.requested, block: firstDetail.block,
    item: firstDetail.item
  })

  const reportSay = await waitFor((e) => e.type === 'say' && e.source === 'callback', 45000, '主动汇报')
  check('③ 完成后主动汇报（自然语言、无 JSON/坐标）',
    Boolean(reportSay) && !/[{}"]/.test(reportSay.text) && !/\d+\.\d+\s+\d+\.\d+/.test(reportSay.text),
    { say: reportSay && reportSay.text })

  // 4) 预算：单次任务 LLM 调用 ≤ 4
  const stats1 = await getJson(`${PLANNER}/stats`)
  const deltaOf = (from, to) => {
    const out = {}
    for (const [key, value] of Object.entries(to.llm.by_purpose || {})) {
      out[key] = value - ((from.llm.by_purpose || {})[key] || 0)
    }
    return out
  }
  const dispatchDelta = deltaOf(stats0, statsDispatch)   // 听 -> 规划 -> 应一声
  const tailDelta = deltaOf(statsDispatch, stats1)       // 插话一次 + 汇报一次
  const taskCalls = Object.values(dispatchDelta).reduce((a, b) => a + b, 0) + (tailDelta.l1_report || 0)
  const interjectionCalls = (tailDelta.l1_chat || 0)
  check('⑤ 单次任务 LLM 调用 ≤ 4', taskCalls <= 4, { dispatch: dispatchDelta, report: tailDelta.l1_report || 0, task_calls: taskCalls, interjection_calls: interjectionCalls })

  // 5) 收尾：状态回空闲
  const state1 = await getJson(`${SIDECAR}/state`)
  check('任务结束后回到空闲态', state1.status === 'idle', { status: state1.status })

  bot.quit()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n== 汇总: ${results.length - failed.length}/${results.length} 通过 ==`)
  if (said.length) console.log('她说过的所有话：\n  - ' + said.map((s) => s.text).join('\n  - '))
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('测试脚本异常:', err.message)
  process.exit(2)
})
