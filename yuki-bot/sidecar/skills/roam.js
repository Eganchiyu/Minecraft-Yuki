'use strict'
// sidecar/skills/roam.js —— 在附近随便走走：不用坐标，随机挑几个落点走过去。
// 硬校验：至少真的挪动过一段距离（位置是权威），不是原地假装走。
const { clampInt } = require('../util')

const MIN_TRAVEL = 3 // 格：走过这么远才算「逛到了」

async function roam (args, ctx) {
  const { link, signal } = ctx
  const radius = clampInt(args.radius, 4, 48, 16)
  const stops = clampInt(args.stops, 1, 6, 3)
  const budgetMs = ctx.timeoutMs || 60000
  const started = Date.now()
  const walked = []
  let travel = 0
  let last = link.pos()

  for (let i = 0; i < stops; i++) {
    if (signal.aborted) return { ok: false, detail: { error: 'cancelled', travel: round(travel) } }
    const remain = budgetMs - (Date.now() - started)
    if (remain < 4000) break

    const from = link.pos()
    if (!from) return { ok: false, detail: { error: 'no_pos' } }
    const target = pickTarget(from, radius)
    if (!target) continue

    await link.gotoNear(target.x, target.y, target.z, 2)
    const result = await link.goalReached(Math.min(remain, 20000))
    const now = link.pos()
    if (last && now) travel += distance(last, now)
    last = now
    if (result.ok) walked.push({ ...target, reason: result.reason })
    else log(result.reason)
  }

  const ok = travel >= MIN_TRAVEL || walked.length > 0
  return {
    ok,
    detail: {
      stops,
      radius,
      walked: walked.length,
      travel: round(travel),
      visited: walked.slice(-3),
      error: ok ? undefined : 'not_moved'
    }
  }
}

function pickTarget (from, radius) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const angle = Math.random() * Math.PI * 2
    const dist = radius * (0.4 + Math.random() * 0.6)
    const target = {
      x: Math.round(from.x + Math.cos(angle) * dist),
      y: Math.round(from.y),
      z: Math.round(from.z + Math.sin(angle) * dist)
    }
    if (Math.abs(target.x - from.x) + Math.abs(target.z - from.z) >= 4) return target
  }
  return null
}

function distance (a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function round (n) { return Math.round(n * 10) / 10 }

function log (reason) {
  // 走不到就换下一个落点，不把整次 roam 判失败
  if (reason && reason !== 'goal_reached') {
    require('../log').warn('roam_stop', { reason })
  }
}

module.exports = { name: 'roam', run: roam }
