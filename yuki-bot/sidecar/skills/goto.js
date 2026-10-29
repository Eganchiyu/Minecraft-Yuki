'use strict'
// sidecar/skills/goto.js —— 寻路到坐标，硬校验看是否真的到了（位置是权威，事件只用来提前结束）。
const { arrived } = require('../validate')
const { clampInt } = require('../util')

async function goto (args, ctx) {
  const { link, signal } = ctx
  const x = Number(args.x)
  const y = Number(args.y)
  const z = Number(args.z)
  if (![x, y, z].every(Number.isFinite)) {
    return { ok: false, detail: { error: 'invalid_coords', args } }
  }
  const range = clampInt(args.range, 0, 3, 1)
  const timeoutMs = ctx.timeoutMs || 60000
  const playerName = args.player ? String(args.player).trim() : ''

  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }
  let target = { x, y, z }
  if (playerName) {
    target = playerPosition(link, playerName)
    if (!target) return { ok: false, detail: { error: 'player_not_visible', player: playerName } }
  }

  const deadline = Date.now() + timeoutMs
  let goalKey = ''
  let result
  let check
  do {
    if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }
    if (playerName) {
      const current = playerPosition(link, playerName)
      if (!current) return { ok: false, detail: { error: 'target_lost', player: playerName } }
      target = current
    }

    const key = positionKey(target)
    if (key !== goalKey) {
      await link.gotoNear(target.x, target.y, target.z, range)
      goalKey = key
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      result = { ok: false, reason: 'timeout' }
      break
    }
    result = await link.goalReached(remaining, {
      watch: () => {
        if (signal.aborted) return 'cancelled'
        if (!playerName) return null
        const current = playerPosition(link, playerName)
        if (!current) return 'target_lost'
        target = current
        const currentKey = positionKey(current)
        if (currentKey !== goalKey) {
          link.gotoNear(current.x, current.y, current.z, range)
          goalKey = currentKey
        }
        return null
      }
    })

    if (result.reason === 'target_lost' || result.reason === 'cancelled') break
    if (result.reason !== 'goal_reached') {
      if (playerName) {
        const current = playerPosition(link, playerName)
        if (!current) {
          result = { ok: false, reason: 'target_lost' }
          break
        }
        target = current
        // A path for the previous position can fail just as the target moves.
        if (positionKey(current) !== goalKey) continue
      }
      break
    }

    if (playerName) {
      const current = playerPosition(link, playerName)
      if (!current) {
        result = { ok: false, reason: 'target_lost' }
        break
      }
      target = current
    }
    check = arrived(link, target.x, target.y, target.z, range)
  } while (!check.ok)

  check = check || arrived(link, target.x, target.y, target.z, range)
  const ok = check.ok && result.reason !== 'target_lost' && result.reason !== 'cancelled'
  return {
    ok,
    detail: {
      target: { ...target },
      player: playerName || undefined,
      range,
      path: result.reason,
      ...check.detail,
      error: ok ? undefined : result.reason === 'target_lost' ? 'target_lost' : result.reason === 'cancelled' ? 'cancelled' : 'not_arrived'
    }
  }
}

function playerPosition (link, playerName) {
  const entity = link.bot.players && link.bot.players[playerName] && link.bot.players[playerName].entity
  if (!entity || !entity.position) return null
  const { x, y, z } = entity.position
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null
}

function positionKey (position) {
  return [position.x, position.y, position.z].map(Math.round).join(',')
}

module.exports = { name: 'goto', run: goto }
