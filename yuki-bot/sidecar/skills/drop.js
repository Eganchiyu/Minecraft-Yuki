'use strict'
// sidecar/skills/drop.js —— 把手里的东西丢出去（丢给地上，或先走到某个玩家身边再丢）。
// 硬校验：背包里这件东西真的变少了，不是「以为丢了」。
const { clampInt } = require('../util')

function countItem (bot, name) {
  return bot.inventory.items()
    .filter((item) => item.name === name)
    .reduce((sum, item) => sum + item.count, 0)
}

function findPlayer (bot, name) {
  const target = bot.players[name]
  if (!target || !target.entity) return null
  return target
}

async function drop (args, ctx) {
  const { link, signal } = ctx
  const bot = link.bot
  if (!bot || !bot.entity) return { ok: false, detail: { error: 'bot_not_ready' } }
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  const itemName = String(args.item || '').trim()
  if (!itemName) return { ok: false, detail: { error: 'missing_item' } }
  let itemType = null
  if (link.mcData.itemsByName[itemName]) itemType = link.mcData.itemsByName[itemName]
  const stack = bot.inventory.items().find((item) => item.name === itemName)
  if (!stack) return { ok: false, detail: { error: 'item_not_in_inventory', item: itemName } }

  const before = countItem(bot, itemName)
  const want = args.count === undefined ? before : clampInt(args.count, 1, before, before)
  const playerName = args.player ? String(args.player).trim() : ''

  // 要交给某个人：先走到他旁边（3 格内），否则东西丢在地上他可能捡不到
  let distance = null
  if (playerName) {
    const player = findPlayer(bot, playerName)
    if (!player) return { ok: false, detail: { error: 'player_not_visible', player: playerName } }
    const pos = player.entity.position
    distance = bot.entity.position.distanceTo(pos)
    if (distance > 3) {
      await link.gotoNear(pos.x, pos.y, pos.z, 1)
      const reached = await link.goalReached(Math.min(ctx.timeoutMs || 20000, 20000))
      if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }
      distance = bot.entity.position.distanceTo(player.entity.position)
      if (!reached.ok && distance > 4) {
        return { ok: false, detail: { error: 'not_arrived', player: playerName, distance: round(distance) } }
      }
    }
  }

  try {
    await bot.toss(itemType ? itemType.id : stack.type, null, want)
  } catch (err) {
    return { ok: false, detail: { error: 'toss_failed', message: err.message, item: itemName } }
  }

  // 服务端物品更新可能晚一拍
  let after = countItem(bot, itemName)
  for (let i = 0; i < 10 && after >= before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    after = countItem(bot, itemName)
  }
  const dropped = before - after
  return {
    ok: dropped > 0,
    detail: {
      item: itemName,
      dropped,
      remaining: after,
      player: playerName || undefined,
      distance: distance === null ? undefined : round(distance),
      error: dropped > 0 ? undefined : 'drop_mismatch'
    }
  }
}

function round (n) { return Math.round(n * 10) / 10 }

module.exports = { name: 'drop', run: drop }
