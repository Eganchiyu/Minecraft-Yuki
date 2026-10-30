'use strict'
// sidecar/skills/use.js —— 右键：对着一格方块或一个生物按一下右键（开门、按钮、拉杆、床、工作台、村民……）。
//
// 和其它技能一样不替 L2 拿主意：只做「对这一格按右键」这一件事，按下去之后世界怎么变如实报。
// 打开的是窗口（工作台、村民、附魔台）就立刻关掉——我们还没有操作窗口的能力，留着会把后面的技能卡住。
const Vec3 = require('vec3')
const { raceTimeout, clampInt } = require('../util')

const WINDOW_GRACE_MS = 300

function findTargetBlock (link, args, name) {
  const bot = link.bot
  if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
    const block = bot.blockAt(new Vec3(Math.round(Number(args.x)), Math.round(Number(args.y)), Math.round(Number(args.z))))
    if (!block) return { error: 'block_not_loaded' }
    if (name && block.name !== name) return { error: 'block_mismatch', found: block.name }
    return { block }
  }
  if (!name) return { error: 'missing_target' }
  const def = link.mcData.blocksByName[name]
  if (!def) return { error: 'unknown_block', block: name }
  const block = bot.findBlock({ matching: def.id, maxDistance: clampInt(args.radius, 1, 32, 8) })
  return block ? { block } : { error: 'no_such_block', block: name }
}

function findTargetEntity (link, name) {
  const bot = link.bot
  const matches = Object.values(bot.entities).filter((e) => {
    if (!e || e === bot.entity || !e.position) return false
    if (!name) return false
    if (e.name === name || e.username === name) return true
    if (e.displayName === name) return true
    if (e.type === 'mob' && e.kind === name) return true
    return false
  })
  if (!matches.length) return { error: 'entity_not_found', target: name }
  matches.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  return { entity: matches[0] }
}

async function use (args, ctx) {
  const { link, signal } = ctx
  const bot = link.bot
  if (!bot || !bot.entity) return { ok: false, detail: { error: 'bot_not_ready' } }
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  const entityName = args.entity ? String(args.entity).trim() : ''
  const blockName = args.block ? String(args.block).trim() : ''

  // ---- 对生物按右键 ----
  if (!blockName) {
    const found = findTargetEntity(link, entityName)
    if (found.error) return { ok: false, detail: { error: found.error, target: entityName } }
    const target = found.entity
    const dist = bot.entity.position.distanceTo(target.position)
    if (dist > 3.5) {
      await link.gotoNear(target.position.x, target.position.y, target.position.z, 2)
      const reached = await link.goalReached(12000)
      if (!reached.ok) return { ok: false, detail: { error: 'cannot_reach_entity', distance: Math.round(dist), reason: reached.reason } }
    }
    try {
      await raceTimeout(bot.activateEntity(target), 5000)
    } catch (err) {
      return { ok: false, detail: { error: 'use_failed', message: err.message, entity: entityName || target.name } }
    }
    return { ok: true, detail: closeWindowIfAny(bot, { entity: entityName || target.name }) }
  }

  // ---- 对方块按右键 ----
  const found = findTargetBlock(link, args, blockName)
  if (found.error) return { ok: false, detail: { error: found.error, block: blockName, found: found.found } }
  const block = found.block

  const dist = bot.entity.position.distanceTo(block.position)
  if (dist > 3.5) {
    await link.gotoNear(block.position.x, block.position.y, block.position.z, 2)
    const reached = await link.goalReached(12000)
    if (!reached.ok) return { ok: false, detail: { error: 'cannot_reach_block', distance: Math.round(dist), reason: reached.reason } }
  }
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  // 按下去之前记一下这一格的状态，好判「有没有真的发生什么」
  const before = { name: block.name, lit: block.getProperties ? block.getProperties().lit : undefined }

  try {
    await raceTimeout(bot.activateBlock(block, new Vec3(0.5, 0.5, 0.5)), 5000)
  } catch (err) {
    return { ok: false, detail: { error: 'use_failed', message: err.message, block: before.name } }
  }

  await new Promise((resolve) => setTimeout(resolve, WINDOW_GRACE_MS))
  const after = bot.blockAt(block.position)
  const detail = closeWindowIfAny(bot, { block: before.name })
  detail.changed = Boolean(after && after.name !== before.name) || Boolean(after && after.getProperties && after.getProperties().lit !== before.lit)
  detail.at = { x: block.position.x, y: block.position.y, z: block.position.z }
  // 门/按钮/拉杆这类「按了就变」的方块：没变就是没按上
  const toggles = /(_door|_trapdoor|_button|_fence_gate|lever)/
  if (toggles.test(before.name) && !detail.changed) {
    return { ok: false, detail: { ...detail, error: 'nothing_changed' } }
  }
  return { ok: true, detail }
}

/** 开了窗口就关上并说明是什么窗口——我们还没有操作窗口的能力，留着会卡住后面的技能。 */
function closeWindowIfAny (bot, detail) {
  const win = bot.currentWindow
  if (!win) return detail
  const kind = String(win.type || '').replace(/^minecraft:/, '')
  try { win.close() } catch (_) { /* noop */ }
  return { ...detail, opened: kind, note: 'opened_window_closed' }
}

module.exports = { name: 'use', run: use }
