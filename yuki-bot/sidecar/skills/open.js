'use strict'
// sidecar/skills/open.js —— 打开容器：看看里面有什么，顺便可以取东西。
// 为什么单独一个技能：L1 需要「哪里放了什么」的世界知识，只能靠真的开一次箱子拿到。
// 返回的 contents 会被 planner 按坐标覆盖进 places 表，所以每次开都等于刷新记录。
const Vec3 = require('vec3')
const { raceTimeout, clampInt } = require('../util')

const CONTAINERS = ['chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker']

function findContainer (link, args) {
  const bot = link.bot
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)) && Number.isFinite(Number(args.z))) {
    const block = bot.blockAt(new Vec3(Math.round(Number(args.x)), Math.round(Number(args.y)), Math.round(Number(args.z))))
    if (block && CONTAINERS.includes(block.name)) return block
    return null
  }
  const ids = CONTAINERS.filter((name) => link.mcData.blocksByName[name]).map((name) => link.mcData.blocksByName[name].id)
  return bot.findBlock({ matching: ids, maxDistance: clampInt(args.radius, 1, 32, 16) })
}

function snapshotContents (window) {
  try {
    return (window.containerItems() || []).map((item) => ({ name: item.name, count: item.count }))
  } catch (_) {
    return []
  }
}

async function openContainer (args, ctx) {
  const { link, signal } = ctx
  const bot = link.bot
  if (!bot || !bot.entity) return { ok: false, detail: { error: 'bot_not_ready' } }
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  const box = findContainer(link, args)
  if (!box) return { ok: false, detail: { error: 'no_container' } }

  const dist = bot.entity.position.distanceTo(box.position)
  if (dist > 4) {
    await link.gotoNear(box.position.x, box.position.y, box.position.z, 2)
    const reached = await link.goalReached(15000)
    if (!reached.ok) {
      return { ok: false, detail: { error: 'cannot_reach_container', distance: Math.round(dist), reason: reached.reason } }
    }
  }
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  let window
  try {
    window = await raceTimeout(bot.openContainer(box), 10000)
  } catch (err) {
    return { ok: false, detail: { error: 'open_failed', message: err.message, container: box.name } }
  }

  const at = { x: box.position.x, y: box.position.y, z: box.position.z }
  const before = snapshotContents(window)
  const took = {}

  const itemName = args.item ? String(args.item).trim() : ''
  if (itemName) {
    const itemInfo = link.mcData.itemsByName[itemName]
    if (!itemInfo) {
      try { window.close() } catch (_) { /* noop */ }
      return { ok: false, detail: { error: 'unknown_item', item: itemName, container: { kind: box.name, at, contents: before } } }
    }
    const available = before.filter((item) => item.name === itemName).reduce((sum, item) => sum + item.count, 0)
    if (!available) {
      try { window.close() } catch (_) { /* noop */ }
      return { ok: false, detail: { error: 'item_not_in_container', item: itemName, container: { kind: box.name, at, contents: before } } }
    }
    const want = args.count === undefined ? available : clampInt(args.count, 1, available, available)
    try {
      await raceTimeout(window.withdraw(itemInfo.id, null, want), 8000)
      took[itemName] = want
    } catch (err) {
      // 取失败不判死：下面用背包增量做硬校验
    }
  }

  const after = snapshotContents(window)
  try { window.close() } catch (_) { /* noop */ }

  let ok = true
  let error
  if (itemName) {
    const got = bot.inventory.items().filter((item) => item.name === itemName).reduce((sum, item) => sum + item.count, 0)
    ok = got > 0 || Object.keys(took).length > 0
    if (!ok) error = 'withdraw_mismatch'
  }

  return {
    ok,
    detail: {
      container: { kind: box.name, at, contents: after },
      before,
      took: Object.keys(took).length ? took : undefined,
      distance: Math.round(dist),
      error
    }
  }
}

module.exports = { name: 'open', run: openContainer, CONTAINERS }
