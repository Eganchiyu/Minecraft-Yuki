'use strict'
// sidecar/skills/follow.js —— 持续跟随（不给 seconds 就一直跟到被叫停/跟丢），硬校验看实际距离。
const { goals } = require('mineflayer-pathfinder')
const { clampInt, sleep } = require('../util')

async function follow (args, ctx) {
  const { link, signal } = ctx
  const playerName = String(args.player || '').trim()
  if (!playerName) return { ok: false, detail: { error: 'missing_player' } }
  // 不给 seconds = 开放跟随：一直跟着，直到被取消/抢占/跟丢；1 小时只是兜底，防止意外常驻
  const openEnded = args.seconds === undefined || args.seconds === null
  const seconds = openEnded ? 3600 : clampInt(args.seconds, 3, 300, 15)
  const distance = clampInt(args.distance, 1, 6, 3)

  const target = link.bot.players ? link.bot.players[playerName] : null
  if (!target || !target.entity) return { ok: false, detail: { error: 'player_not_visible', player: playerName } }

  const deadline = Date.now() + seconds * 1000
  let lostFrames = 0
  let maxDistance = 0
  let lastDistance = 0
  let lost = false

  while (Date.now() < deadline && !signal.aborted) {
    const entity = link.bot.players[playerName] && link.bot.players[playerName].entity
    if (!entity) {
      lostFrames += 1
      if (lostFrames > 10) { lost = true; break }
      await sleep(500)
      continue
    }
    lostFrames = 0
    lastDistance = link.bot.entity.position.distanceTo(entity.position)
    maxDistance = Math.max(maxDistance, lastDistance)
    if (lastDistance > distance) {
      link.bot.pathfinder.setGoal(new goals.GoalFollow(entity, distance), true)
    } else if (link.bot.pathfinder.goal) {
      link.bot.pathfinder.setGoal(null)
    }
    await sleep(500)
  }

  link.bot.pathfinder.setGoal(null)
  const ok = !lost && !signal.aborted
  return {
    ok,
    detail: {
      player: playerName,
      seconds: openEnded ? null : seconds,
      open_ended: openEnded,
      distance: round(lastDistance),
      max_distance: round(maxDistance),
      error: signal.aborted ? 'cancelled' : (lost ? 'target_lost' : undefined),
      aborted: signal.aborted
    }
  }
}

function round (n) { return Math.round(n * 100) / 100 }

module.exports = { name: 'follow', run: follow }
