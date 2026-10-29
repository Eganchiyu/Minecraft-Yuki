'use strict'
// sidecar/skills/craft.js —— 合成：自动补中间产物（木板/木棍/工作台），需要 3×3 时自己放工作台。
// 只用 mineflayer 自带 bot.craft + 自己的一小段递归解析，不引第三方合成库。
const Vec3 = require('vec3')
const { clampInt, raceTimeout } = require('../util')
const { placeBlock, waitForBlock } = require('./place')

const MAX_DEPTH = 6
const MAX_STEPS = 16

async function craft (args, ctx) {
  const { link, signal } = ctx
  const bot = link.bot
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  const itemName = String(args.item || '').trim()
  if (!itemName) return { ok: false, detail: { error: 'missing_item' } }
  const itemDef = link.mcData.itemsByName[itemName]
  if (!itemDef) return { ok: false, detail: { error: 'unknown_item', item: itemName } }

  const desired = clampInt(args.count, 1, 64, 1)
  const before = link.inventoryCounts()
  const gained = () => (link.inventoryCounts()[itemDef.id] || 0) - (before[itemDef.id] || 0)

  // 语义：本次「新增」desired 个；规划时把已有同名物品从账上清零，只算要新做的部分
  const planInv = inventoryMap(link)
  planInv.set(itemDef.id, 0)
  let plan = solve(bot, planInv, itemDef.id, desired, 0, new Set())
  if (!plan) {
    return {
      ok: false,
      detail: { error: 'missing_material', item: itemName, requested: desired, missing: describeMissing(bot, link, itemDef.id, desired) }
    }
  }

  // 需要 3×3：先找/做/放工作台，然后按新背包重算计划（避免用到已被消耗的材料）
  let table = null
  let tableStatus = 'not_needed'
  if (plan.steps.some((step) => step.requiresTable)) {
    const ensured = await ensureTable(link, signal)
    tableStatus = ensured.how
    if (!ensured.block) {
      return { ok: false, detail: { error: 'need_workbench', item: itemName, table: ensured.how, message: ensured.message } }
    }
    table = ensured.block
    const replanInv = inventoryMap(link)
    replanInv.set(itemDef.id, 0)
    plan = solve(bot, replanInv, itemDef.id, desired, 0, new Set())
    if (!plan) {
      return { ok: false, detail: { error: 'missing_material', item: itemName, requested: desired, table: tableStatus, missing: describeMissing(bot, link, itemDef.id, desired) } }
    }
  }

  const done = []
  try {
    for (const step of plan.steps) {
      if (signal.aborted) return { ok: false, detail: { error: 'cancelled', aborted: true, crafted: gained(), steps: done } }
      // mineflayer 的 bot.craft(recipe, n) 在 26.1 上多次连做只生效一次（实测 2 次只出 1 份产物），
      // 因此这里一次只做一次合成，循环补齐。
      for (let k = 0; k < step.applications; k++) {
        if (signal.aborted) return { ok: false, detail: { error: 'cancelled', aborted: true, crafted: gained(), steps: done } }
        await raceTimeout(bot.craft(step.recipe, 1, step.requiresTable ? table : null), 30000, () => link.hardStop())
        await new Promise((r) => setTimeout(r, 80))
      }
      done.push({ result: link.mcData.items[step.recipe.result.id].name, applications: step.applications, table: Boolean(step.requiresTable) })
    }
  } catch (err) {
    return {
      ok: false,
      detail: { error: 'craft_failed', item: itemName, message: err.message, crafted: gained(), steps: done, table: tableStatus }
    }
  }

  const crafted = gained()
  return {
    ok: crafted >= desired,
    detail: {
      item: itemName,
      requested: desired,
      crafted,
      table: tableStatus,
      steps: done,
      error: crafted >= desired ? undefined : 'not_enough_crafted'
    }
  }
}

// ---------------- 递归解析 ----------------

function inventoryMap (link) {
  const map = new Map()
  for (const item of link.bot.inventory.items()) {
    map.set(item.type, (map.get(item.type) || 0) + item.count)
  }
  return map
}

/**
 * 从现有背包出发，递归解析出「先做什么、后做什么」。
 * inv 会被就地扣减（每个候选配方用副本回溯）。返回 {steps} 或 null。
 */
function solve (bot, inv, itemId, qty, depth, visiting) {
  const have = inv.get(itemId) || 0
  if (have >= qty) {
    inv.set(itemId, have - qty)
    return { steps: [] }
  }
  if (depth > MAX_DEPTH || visiting.has(itemId)) return null

  const needQty = qty - have
  inv.set(itemId, 0)

  // 注意：recipesAll 的第三个参数只做真值判断，传 null 会过滤掉所有 3×3 配方
  const recipes = bot.recipesAll(itemId, null, true)
  const ordered = [...recipes].sort((a, b) => Number(Boolean(a.requiresTable)) - Number(Boolean(b.requiresTable)))
  for (const recipe of ordered) {
    const per = recipe.result.count || 1
    const applications = Math.ceil(needQty / per)
    const trial = new Map(inv)
    const steps = []
    let ok = true
    for (const delta of recipe.delta) {
      if (delta.count >= 0) continue
      const sub = solve(bot, trial, delta.id, -delta.count * applications, depth + 1, new Set([...visiting, itemId]))
      if (!sub) { ok = false; break }
      steps.push(...sub.steps)
    }
    if (!ok || steps.length + 1 > MAX_STEPS) continue
    steps.push({ recipe, applications, requiresTable: Boolean(recipe.requiresTable) })
    for (const [id, count] of trial) inv.set(id, count)
    inv.set(itemId, (inv.get(itemId) || 0) + per * applications - needQty)
    return { steps }
  }
  return null
}

/** 失败时说清楚缺什么（给 L1 的事实），不猜。 */
function describeMissing (bot, link, itemId, qty) {
  const inv = inventoryMap(link)
  const missing = []
  const walk = (id, need, depth) => {
    if (depth > MAX_DEPTH) return
    const have = inv.get(id) || 0
    if (have >= need) { inv.set(id, have - need); return }
    const rest = need - have
    inv.set(id, 0)
    const recipes = bot.recipesAll(id, null, true)
    if (!recipes.length) { missing.push({ item: nameOf(link, id), need: rest }); return }
    const recipe = recipes[0]
    const per = recipe.result.count || 1
    const applications = Math.ceil(rest / per)
    for (const delta of recipe.delta) {
      if (delta.count < 0) walk(delta.id, -delta.count * applications, depth + 1)
    }
  }
  walk(itemId, qty, 0)
  return missing
}

function nameOf (link, id) {
  const item = link.mcData.items[id]
  return item ? item.name : `#${id}`
}

// ---------------- 工作台 ----------------

async function ensureTable (link, signal) {
  const bot = link.bot
  const tableId = link.mcData.blocksByName.crafting_table.id
  const found = bot.findBlock({ matching: tableId, maxDistance: 6 })
  if (found) return { block: found, how: 'found' }

  const tableItemId = link.mcData.itemsByName.crafting_table.id
  const have = link.inventoryCounts()[tableItemId] || 0
  if (!have) {
    const plan = solve(bot, inventoryMap(link), tableItemId, 1, 0, new Set())
    if (!plan || !plan.steps.length) {
      return { block: null, how: 'no_table_material', message: '没有工作台，也没有做工作台的材料' }
    }
    for (const step of plan.steps) {
      if (signal && signal.aborted) return { block: null, how: 'cancelled', message: 'cancelled' }
      for (let k = 0; k < step.applications; k++) {
        try {
          await raceTimeout(bot.craft(step.recipe, 1, null), 20000, () => link.hardStop())
        } catch (err) {
          return { block: null, how: 'table_craft_failed', message: err.message }
        }
      }
    }
  }

  const placed = await placeBlock(link, 'crafting_table', null, signal)
  if (!placed.ok) return { block: null, how: 'table_place_failed', message: JSON.stringify(placed.detail) }

  const pos = new Vec3(placed.detail.at.x, placed.detail.at.y, placed.detail.at.z)
  await waitForBlock(link, pos, 'crafting_table', 1000)
  const block = bot.blockAt(pos)
  if (!block || block.name !== 'crafting_table') return { block: null, how: 'table_missing_after_place' }
  return { block, how: 'placed' }
}

module.exports = { name: 'craft', run: craft, solve, inventoryMap }
