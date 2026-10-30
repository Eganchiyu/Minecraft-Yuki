'use strict'
// sidecar/mlg.js —— 落地自救：掉得够快就在落点铺一摊水，落进去之后把水收回来。
//
// 桶是一次性消耗品：放完不收，第二次摔就没得救了。所以「放」和「收」必须在同一段里做完。
//
// 两个纯函数先算清楚，再动手：
//   fallInfo()  现在掉多快、离地还剩几格、会落在哪一格
//   shouldMlg() 该不该动手（只看数字，不看世界，好测）
//
// 落地探测打五条射线：她的碰撞箱宽 0.6，单看正中那一列会从格缝里漏下去。
const Vec3 = require('vec3')
const { sleep } = require('./util')

const WATER_BUCKET = 'water_bucket'
const BUCKET = 'bucket'
const WATER_NAMES = new Set(['water', 'flowing_water'])
const PROBE_DEPTH = 40 // 往下最多探这么深

// 站在哪格算「脚下」：碰撞箱半宽 0.3，取中心 + 四角
const PROBES = [
  [0, 0], [0.29, 0.29], [0.29, -0.29], [-0.29, 0.29], [-0.29, -0.29]
]

function isSolid (block) {
  return Boolean(block && block.boundingBox === 'block')
}

/**
 * 现在掉多快、离地多远、会落在哪。
 * 返回 { falling, vy, dist, landing, water }：landing 是落地那一格方块，water 是水该放的位置。
 */
function fallInfo (bot, maxDepth = PROBE_DEPTH) {
  const out = { falling: false, vy: 0, dist: null, landing: null, water: null }
  if (!bot || !bot.entity) return out
  const p = bot.entity.position
  const vy = bot.entity.velocity ? bot.entity.velocity.y : 0
  out.vy = vy
  out.falling = !bot.entity.onGround && vy < -0.75

  for (const [dx, dz] of PROBES) {
    const x = Math.floor(p.x + dx)
    const z = Math.floor(p.z + dz)
    const from = Math.floor(p.y + 0.001)
    for (let y = from; y > from - maxDepth; y--) {
      const block = bot.blockAt(new Vec3(x, y, z))
      if (!block) break // 区块没加载，别瞎猜
      if (WATER_NAMES.has(block.name)) return out // 脚下已经是水了，不用救
      if (!isSolid(block)) continue
      const top = y + 1 // 落点：这个方块的顶面
      const dist = p.y - top
      if (dist < 0) break
      if (out.dist === null || dist < out.dist) {
        out.dist = dist
        out.landing = block
        out.water = new Vec3(x, top, z) // 水放在落点正上方那一格
      }
      break
    }
  }
  return out
}

/**
 * 该不该放水——纯算术。数字来自 fallInfo 与背包，不碰世界，好测。
 * 触发太早水会流走，太晚来不及；3.5 格大约剩 0.6 秒，够发一个包。
 */
function shouldMlg ({ falling, dist, hasBucket, triggerDistance = 3.5 }) {
  if (!falling) return { fire: false, why: 'not_falling' }
  if (dist === null || dist === undefined) return { fire: false, why: 'no_landing' }
  if (dist <= 0) return { fire: false, why: 'landed' }
  if (dist > triggerDistance) return { fire: false, why: 'too_high' }
  if (!hasBucket) return { fire: false, why: 'no_bucket' }
  return { fire: true, why: 'fire' }
}

function countItem (bot, name) {
  return bot.inventory.items().filter((it) => it.name === name).reduce((sum, it) => sum + it.count, 0)
}

/** 放水：瞄着落点正上方那格，把水桶按下去。不 await 放置完成——掉下来等不了 5 秒的确认。 */
async function placeWater (bot, landing, water) {
  const item = bot.inventory.items().find((it) => it.name === WATER_BUCKET)
  if (!item) return false
  await bot.equip(item, 'hand')

  const before = bot.blockAt(water)
  const beforeName = before ? before.name : null
  // 从落点方块朝上看：水放在它的顶面。不等 placeBlock 的 5 秒确认，掉下来等不起
  bot.placeBlock(landing, new Vec3(0, 1, 0)).catch(() => {})

  const deadline = Date.now() + 800
  while (Date.now() < deadline) {
    const b = bot.blockAt(water)
    if (b && (WATER_NAMES.has(b.name) || b.name !== beforeName)) return true
    await sleep(50)
  }
  return false
}

/** 收水：落进自己的水之后，拿空桶对着那格按一下右键。 */
async function reclaimWater (bot, water) {
  const empty = bot.inventory.items().find((it) => it.name === BUCKET)
  if (!empty) return { ok: false, why: 'no_empty_bucket' }
  await bot.equip(empty, 'hand')
  try {
    await bot.activateBlock(bot.blockAt(water) || { position: water })
  } catch (_) {
    return { ok: false, why: 'activate_failed' }
  }
  const deadline = Date.now() + 1200
  while (Date.now() < deadline) {
    if (countItem(bot, WATER_BUCKET) > 0) return { ok: true }
    await sleep(50)
  }
  return { ok: false, why: 'not_picked_up' }
}

/**
 * 一次完整的落地自救。返回给状态机记账用的事实。
 * 注意：从「决定放水」到「落进水里」之间不能有任何 await 阻塞住主循环以外的东西，
 * 所以这里所有等待都有上限。
 */
async function mlgRescue (bot, info) {
  const detail = { vy: round(info.vy), dist: round(info.dist), placed: false, landed: false, reclaimed: false }
  if (!info.landing || !info.water) return { ok: false, detail: { ...detail, error: 'no_landing' } }

  try {
    detail.placed = await placeWater(bot, info.landing, info.water)
  } catch (err) {
    return { ok: false, detail: { ...detail, error: 'place_failed', message: err.message } }
  }

  // 等落地（最多 3 秒：3.5 格自由落体约 0.6 秒，留足余量）
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (bot.entity && bot.entity.onGround) break
    await sleep(50)
  }
  detail.landed = Boolean(bot.entity && bot.entity.onGround)
  detail.health = bot.health

  // 落进水里就把桶收回来
  if (detail.landed) {
    const feet = bot.entity.position
    const at = bot.blockAt(new Vec3(Math.floor(feet.x), Math.floor(feet.y), Math.floor(feet.z)))
    if (at && WATER_NAMES.has(at.name)) {
      const got = await reclaimWater(bot, new Vec3(at.position.x, at.position.y, at.position.z))
      detail.reclaimed = got.ok
      if (!got.ok) detail.reclaim_why = got.why
    }
  }

  return {
    ok: Boolean(detail.placed && detail.landed),
    detail: { ...detail, error: detail.landed ? (detail.placed ? undefined : 'water_not_placed') : 'never_landed' }
  }
}

function round (n) {
  return typeof n === 'number' ? Math.round(n * 100) / 100 : n
}

module.exports = { fallInfo, shouldMlg, mlgRescue, placeWater, reclaimWater, PROBES, WATER_BUCKET }
