'use strict'
// sidecar/skills/place.js —— 放一个手持方块（工作台等），硬校验看世界里真的出现了这个方块。
const Vec3 = require('vec3')
const { raceTimeout, sleep } = require('../util')

async function place (args, ctx) {
  const { link, signal } = ctx
  const itemName = String(args.item || '').trim()
  if (!itemName) return { ok: false, detail: { error: 'missing_item' } }
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  let target = null
  if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
    const x = Number(args.x); const y = Number(args.y); const z = Number(args.z)
    if (![x, y, z].every(Number.isFinite)) return { ok: false, detail: { error: 'invalid_coords' } }
    target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  }
  const result = await placeBlock(link, itemName, target, signal)
  return result
}

/**
 * 把背包里的方块放到 target（缺省 = bot 脚边找一个空位）。
 * 返回 {ok, detail:{item, at, placed}}。
 */
async function placeBlock (link, itemName, target, signal) {
  const bot = link.bot
  const mcData = link.mcData
  const blockDef = mcData.blocksByName[itemName]
  if (!blockDef) return { ok: false, detail: { error: 'not_a_block', item: itemName } }
  const item = bot.inventory.items().find((it) => it.name === itemName)
  if (!item) return { ok: false, detail: { error: 'item_not_in_inventory', item: itemName } }

  const spots = target ? [target] : findPlaceSpots(link)
  if (!spots.length) return { ok: false, detail: { error: 'no_place_spot', item: itemName } }

  let lastError = null
  for (const spot of spots) {
    const current = bot.blockAt(spot)
    if (current && current.boundingBox !== 'empty') {
      if (current.name === itemName) return { ok: true, detail: { item: itemName, at: vec(spot), placed: false, note: 'already_there' } }
      lastError = { error: 'spot_occupied', at: vec(spot), block: current.name }
      continue
    }

    const ref = findReference(link, spot)
    if (!ref) { lastError = { error: 'no_support_block', at: vec(spot) }; continue }

    try {
      await bot.equip(item, 'hand')
      await raceTimeout(bot.placeBlock(ref.block, ref.face), 5000)
    } catch (err) {
      // mineflayer 会因「没等到 blockUpdate」直接抛错，但服务端可能已经放了；先看世界状态再判失败
      if (await waitForBlock(link, spot, itemName, 1500)) {
        return { ok: true, detail: { item: itemName, at: vec(spot), placed: true, note: 'placed_after_timeout' } }
      }
      lastError = { error: 'place_failed', at: vec(spot), message: err.message }
      continue
    }

    if (await waitForBlock(link, spot, itemName, 2000)) {
      if (signal && signal.aborted) return { ok: false, detail: { error: 'cancelled', aborted: true } }
      return { ok: true, detail: { item: itemName, at: vec(spot), placed: true } }
    }
    lastError = { error: 'block_not_appeared', at: vec(spot) }
  }

  if (signal && signal.aborted) return { ok: false, detail: { error: 'cancelled', aborted: true } }
  return { ok: false, detail: { item: itemName, ...lastError } }
}

/** 脚边找「空位 + 下方是实心」的候选位置（前后左右 1 格，按顺序尝试）。 */
function findPlaceSpots (link) {
  const bot = link.bot
  const p = bot.entity.position.floored()
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const spots = []
  for (const [dx, dz] of offsets) {
    const feet = p.offset(dx, 0, dz)
    const below = bot.blockAt(feet.offset(0, -1, 0))
    const at = bot.blockAt(feet)
    const above = bot.blockAt(feet.offset(0, 1, 0))
    if (!below || !at || !above) continue
    if (below.boundingBox !== 'block') continue
    if (at.boundingBox !== 'empty' || above.boundingBox !== 'empty') continue
    spots.push(feet)
  }
  return spots
}

function findPlaceSpot (link) {
  return findPlaceSpots(link)[0] || null
}

/** 找能贴面放置的实心邻居，返回 {block, face}（face 从参考方块指向目标）。 */
function findReference (link, spot) {
  const bot = link.bot
  const faces = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
  for (const [dx, dy, dz] of faces) {
    const pos = spot.offset(dx, dy, dz)
    const block = bot.blockAt(pos)
    if (!block) continue
    if (block.boundingBox !== 'block') continue
    // 从参考方块看向目标的方向
    return { block, face: new Vec3(-dx, -dy, -dz) }
  }
  return null
}

async function waitForBlock (link, pos, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const block = link.bot.blockAt(pos)
    if (block && block.name === name) return true
    await sleep(100)
  }
  return false
}

function vec (p) { return { x: p.x, y: p.y, z: p.z } }

module.exports = { name: 'place', run: place, placeBlock, findPlaceSpot, findPlaceSpots, waitForBlock }
