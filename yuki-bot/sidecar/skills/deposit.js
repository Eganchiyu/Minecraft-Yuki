'use strict'
// sidecar/skills/deposit.js —— 把背包里的东西存进箱子/木桶，硬校验看背包是不是真的少了。
const Vec3 = require('vec3')
const { raceTimeout, clampInt } = require('../util')

const CONTAINERS = ['chest', 'trapped_chest', 'barrel']

function findContainer (link, args) {
  const bot = link.bot
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)) && Number.isFinite(Number(args.z))) {
    const block = bot.blockAt(new Vec3(Math.round(Number(args.x)), Math.round(Number(args.y)), Math.round(Number(args.z))))
    if (block && CONTAINERS.includes(block.name)) return block
    return null
  }
  const ids = CONTAINERS.map((name) => link.mcData.blocksByName[name].id)
  return bot.findBlock({ matching: ids, maxDistance: clampInt(args.radius, 1, 32, 16) })
}

async function deposit (args, ctx) {
  const { link, signal } = ctx
  const bot = link.bot
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  const box = findContainer(link, args)
  if (!box) return { ok: false, detail: { error: 'no_container' } }

  const filterName = args.item ? String(args.item).trim() : ''
  if (filterName && !link.mcData.itemsByName[filterName]) {
    return { ok: false, detail: { error: 'unknown_item', item: filterName } }
  }
  const limit = args.count === undefined ? Infinity : clampInt(args.count, 1, 2304, 2304)

  const items = bot.inventory.items().filter((item) => !filterName || item.name === filterName)
  const target = items.reduce((sum, item) => sum + item.count, 0)
  if (!target) return { ok: true, detail: { container: box.name, deposited: 0, note: 'nothing_to_deposit' } }

  const dist = bot.entity.position.distanceTo(box.position)
  if (dist > 4) {
    await link.gotoNear(box.position.x, box.position.y, box.position.z, 2)
    const reached = await link.goalReached(15000)
    if (!reached.ok) return { ok: false, detail: { error: 'cannot_reach_container', distance: Math.round(dist), reason: reached.reason } }
  }

  let window
  try {
    window = await raceTimeout(bot.openContainer(box), 10000)
  } catch (err) {
    return { ok: false, detail: { error: 'open_failed', message: err.message, container: box.name } }
  }

  let deposited = 0
  const moved = {}
  try {
    let budget = limit
    for (const item of bot.inventory.items().filter((it) => !filterName || it.name === filterName)) {
      if (budget <= 0) break
      const amount = Math.min(item.count, budget)
      try {
        await raceTimeout(window.deposit(item.type, null, amount), 8000)
        deposited += amount
        budget -= amount
        moved[item.name] = (moved[item.name] || 0) + amount
      } catch (err) {
        // 单件失败不中断，最后用背包实际变化做硬校验
        moved[item.name] = moved[item.name] || 0
      }
    }
  } finally {
    try {
      // 关之前读一次内容：planner 会按坐标覆盖「这个箱子现在有什么」
      var contentsSnapshot = (window.containerItems() || []).map((item) => ({ name: item.name, count: item.count }))
    } catch (_) {
      contentsSnapshot = []
    }
    try { window.close() } catch (_) { /* noop */ }
  }

  const after = bot.inventory.items()
    .filter((item) => !filterName || item.name === filterName)
    .reduce((sum, item) => sum + item.count, 0)
  const actualMoved = target - after
  return {
    ok: actualMoved >= Math.min(limit, target),
    detail: {
      container: {
        kind: box.name,
        at: { x: box.position.x, y: box.position.y, z: box.position.z },
        contents: typeof contentsSnapshot === 'undefined' ? [] : contentsSnapshot
      },
      box: box.name,
      at: { x: box.position.x, y: box.position.y, z: box.position.z },
      requested: Math.min(limit, target),
      deposited: actualMoved,
      items: moved,
      error: actualMoved >= Math.min(limit, target) ? undefined : 'deposit_mismatch'
    }
  }
}

module.exports = { name: 'deposit', run: deposit, CONTAINERS }
