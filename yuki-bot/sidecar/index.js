'use strict'
// sidecar/index.js —— L3 常驻侧车：HTTP 接口 + 任务状态机 + bot 连接。
const http = require('http')
const path = require('path')
const config = require('./config')
const log = require('./log')
const { BotLink } = require('./bot')
const { TaskRunner } = require('./tasks')
const { Guardian } = require('./guardian')
const { eatSomething } = require('./skills/eat')
const { ExperienceStore } = require('./experiences')

const link = new BotLink()
// P4.1：经历账本与 planner 的记忆同世界分区（Node 采集、Python 只收压缩后的 capsule）
const experiences = new ExperienceStore(
  path.join(config.root, 'planner', 'state', 'worlds', config.world, 'experiences.jsonl'),
  config.experience
)
const sseClients = new Set()
const startedAt = Date.now()

function emit (event) {
  const payload = { ...event, at: Date.now() }
  const line = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try { res.write(line) } catch (_) { sseClients.delete(res) }
  }
  if (event.type === 'task_done' || event.type === 'step_done') {
    log.info('event', { type: event.type, intention_id: event.intention_id, status: event.status, ok: event.ok })
  }
  // 反射的状态转移也报上去：L1 靠它知道「刚才被打了、我自己打跑了」，
  // 这些事不经过 L2，但得有人记得。
  // 只把「开打 / 撤退 / 收手」报上去；recover→idle 这种内部流转不打扰她
  if (event.type === 'reflex' && (event.to === 'defend' || event.to === 'flee')) {
    postJson(`${config.plannerUrl}/event`, {
      kind: `reflex_${event.to}`,
      severity: event.severity,
      detail: { from: event.from, reason: event.reason, ...(event.detail || {}) }
    }, 7000).catch((err) => log.warn('reflex_forward_failed', { error: err.message }))
  }
  if (event.type === 'reflex_mlg') {
    postJson(`${config.plannerUrl}/event`, {
      kind: 'reflex_mlg',
      severity: event.severity,
      detail: { dist: event.dist, placed: event.placed, landed: event.landed, reclaimed: event.reclaimed, error: event.error }
    }, 7000).catch((err) => log.warn('reflex_forward_failed', { error: err.message }))
  }
  if (event.type === 'reflex_over') {
    postJson(`${config.plannerUrl}/event`, {
      kind: 'reflex_over',
      severity: event.severity,
      detail: { reason: event.reason, killed: event.killed, health: event.health }
    }, 7000).catch((err) => log.warn('reflex_forward_failed', { error: err.message }))
  }
  // P3：守护事件推给 L1 心智，休息时也得能被叫醒（severity≥7）
  if (event.type === 'emergency') {
    postJson(`${config.plannerUrl}/event`, {
      kind: event.kind,
      severity: event.severity,
      detail: event.detail
    }, 5000).catch((err) => log.warn('event_forward_failed', { kind: event.kind, error: err.message }))
  }
}

const runner = new TaskRunner({
  link,
  emit,
  onFinish: async ({ intention, status, summary, detail }) => {
    const res = await postJson(`${config.plannerUrl}/callback`, {
      intention_id: intention.intention_id,
      status,
      summary,
      detail: compactDetail(detail),
      origin: intention.origin
    })
    if (res && res.say) {
      link.say(res.say)
      emit({ type: 'say', text: res.say, source: 'callback' })
    }
    // 功能没做之类的补充说明（她的第二句）
    if (res && res.say_after) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      link.say(res.say_after)
      emit({ type: 'say', text: res.say_after, source: 'callback_notice' })
    }
  }
})

const guardian = new Guardian({ link, runner, emit, eat: eatSomething })

// ---------- 玩家公屏 -> L1 ----------
link.onChat = async (username, message) => {
  const keyword = config.chatKeyword
  // keyword 为空 = 不过滤，公屏所有消息都进她的上下文
  if (keyword && !message.toLowerCase().includes(keyword)) return
  log.info('chat_in', { player: username, text: message.slice(0, 80) })
  const text = message.replace(new RegExp(keyword, 'ig'), '').trim() || message.trim()
  emit({ type: 'chat_in', player: username, text })
  const started = Date.now()
  try {
    const res = await postJson(`${config.plannerUrl}/chat`, { player: username, text, at: Date.now() }, config.limits.chatReplyTimeoutMs)
    if (res && res.say) {
      link.say(res.say)
      emit({ type: 'say', text: res.say, source: 'chat', latency_ms: Date.now() - started })
    }
    if (res && res.say_after) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      link.say(res.say_after)
      emit({ type: 'say', text: res.say_after, source: 'chat_notice' })
    }
  } catch (err) {
    log.error('chat_forward_failed', { player: username, error: err.message, latency_ms: Date.now() - started })
  }
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, bot: link.ready ? 'ready' : 'offline', uptime_s: Math.round((Date.now() - startedAt) / 1000) })
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      const reflex = guardian.status()
      return sendJson(res, 200, {
        ...link.snapshot(runner.snapshot()),
        // L2 也要看见：正在打架时别规划一条要走很远的活
        reflex: reflex.state,
        reflex_reason: reflex.reason,
        guardian: reflex,
        planner: config.plannerUrl
      })
    }
    if (req.method === 'GET' && url.pathname === '/experiences') {
      const n = Math.max(1, Math.min(100, parseInt(url.searchParams.get('n') || '20', 10) || 20))
      return sendJson(res, 200, { world: config.world, total: experiences.recent(1e9).length, items: experiences.recent(n) })
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      return openSse(req, res)
    }
    if (req.method === 'POST' && url.pathname === '/intention') {
      const body = await readJson(req)
      const result = runner.submit(body)
      return sendJson(res, result.status || (result.accepted ? 202 : 400), result)
    }
    if (req.method === 'POST' && url.pathname === '/cancel') {
      const body = await readJson(req)
      const result = runner.cancel(body.intention_id, body.reason || 'player_cancel')
      emit({ type: 'cancel', intention_id: body.intention_id, result })
      return sendJson(res, 200, result)
    }
    if (req.method === 'POST' && url.pathname === '/say') {
      const body = await readJson(req)
      const ok = link.say(body.text)
      emit({ type: 'say', text: body.text, source: body.source || 'http' })
      return sendJson(res, ok ? 200 : 503, { ok })
    }
    return sendJson(res, 404, { error: 'not_found', path: url.pathname })
  } catch (err) {
    log.error('http_error', { path: url.pathname, error: err.message })
    return sendJson(res, 500, { error: 'internal', message: err.message })
  }
})

function sendJson (res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function readJson (req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (err) { reject(new Error('invalid_json')) }
    })
    req.on('error', reject)
  })
}

function openSse (req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`)
  sseClients.add(res)
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n') } catch (_) { /* noop */ }
  }, 15000)
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res) })
}

async function postJson (url, body, timeoutMs = 60000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`http_${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}

function compactDetail (detail) {
  // 只回传 L2/L1 需要的事实，不把整包原始数据塞进她上下文
  if (!detail || !Array.isArray(detail.results)) return {}
  return {
    failed_step: detail.failed_step,
    error: detail.error,
    results: detail.results.map((item) => ({
      skill: item.skill,
      ok: item.ok,
      args: item.args,
      mined: item.detail && item.detail.mined,
      block: item.detail && item.detail.block,
      requested: item.detail && item.detail.requested,
      distance: item.detail && item.detail.distance,
      crafted: item.detail && item.detail.crafted,
      container: item.detail && item.detail.container,
      took: item.detail && item.detail.took,
      deposited: item.detail && item.detail.deposited,
      killed: item.detail && item.detail.killed,
      item: item.detail && item.detail.item,
      food_before: item.detail && item.detail.food_before,
      food_after: item.detail && item.detail.food_after,
      missing: item.detail && item.detail.missing,
      needs: item.detail && item.detail.needs,
      attempts: item.detail && item.detail.attempts,
      path: item.detail && item.detail.path,
      at: item.detail && item.detail.at,
      error: item.detail && item.detail.error
    }))
  }
}

// ---------- 启动 ----------
async function main () {
  server.listen(config.sidecar.port, config.sidecar.host, () => {
    log.info('sidecar_listen', { url: `http://${config.sidecar.host}:${config.sidecar.port}`, planner: config.plannerUrl })
  })
  try {
    await link.connect()
    guardian.start()
    emit({ type: 'bot_ready', pos: link.pos() })
  } catch (err) {
    log.error('bot_connect_failed', { error: err.message })
    // 不退出：HTTP 仍可用于排障
  }
}

function shutdown (signal) {
  log.info('shutdown', { signal })
  try { guardian.stop() } catch (_) { /* noop */ }
  try { link.hardStop() } catch (_) { /* noop */ }
  for (const res of sseClients) { try { res.end() } catch (_) { /* noop */ } }
  if (link.bot) { try { link.bot.quit() } catch (_) { /* noop */ } }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

main()
