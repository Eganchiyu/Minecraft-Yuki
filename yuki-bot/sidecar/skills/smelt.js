'use strict'
// sidecar/skills/smelt.js —— 用熔炉烧东西：找/放熔炉、铺燃料、放原料、等、取成品，硬校验看成品真的进了背包。
//
// 为什么自己维护一张表：minecraft-data 26.1 的 recipes.json 里只有合成配方，没有烧炼配方，
// 所以「什么能烧、烧成什么、什么能当燃料」只能写在这里。这张表只收版本里稳定的项，不追求全。

const Vec3 = require('vec3')
const { raceTimeout, clampInt, sleep } = require('../util')
const { placeBlock } = require('./place')

const SMELT_SECONDS = 10 // 原版一炉 200 刻
const MAX_PER_CALL = 8 // 一次最多烧 8 个：一炉 10 秒，再多就顶到单步超时
const FURNACE = 'furnace' // 只认普通熔炉：高炉烧不了食物、烟熏炉烧不了矿，混用会烧不出来白等

// 原料 → 成品
const RECIPES = {
  raw_iron: 'iron_ingot',
  iron_ore: 'iron_ingot',
  deepslate_iron_ore: 'iron_ingot',
  raw_gold: 'gold_ingot',
  gold_ore: 'gold_ingot',
  deepslate_gold_ore: 'gold_ingot',
  raw_copper: 'copper_ingot',
  copper_ore: 'copper_ingot',
  deepslate_copper_ore: 'copper_ingot',
  ancient_debris: 'netherite_scrap',
  sand: 'glass',
  red_sand: 'glass',
  cobblestone: 'stone',
  stone: 'smooth_stone',
  clay_ball: 'brick',
  clay: 'terracotta',
  netherrack: 'nether_brick',
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp',
  cactus: 'green_dye',
  wet_sponge: 'sponge'
}

// 燃料 → 一个燃料能烧几秒
const FUELS = {
  coal: 80,
  charcoal: 80,
  coal_block: 800,
  blaze_rod: 120,
  dried_kelp_block: 200,
  lava_bucket: 1000,
  stick: 5,
  crafting_table: 15,
  chest: 15,
  bookshelf: 15,
  ladder: 15,
  wooden_pickaxe: 15,
  wooden_axe: 15,
  wooden_shovel: 15,
  wooden_sword: 15
}

function fuelSeconds (name) {
  if (FUELS[name] !== undefined) return FUELS[name]
  // 各种木板/原木/木头（含去皮）：统一 15 秒
  if (/(_planks|_log|_wood)$/.test(name)) return 15
  return 0
}

function smeltProduct (name) {
  if (RECIPES[name]) return RECIPES[name]
  // 原木/木头烧成木炭
  if (/(_log|_wood)$/.test(name)) return 'charcoal'
  return null
}

function countOf (bot, name) {
  return bot.inventory.items().filter((it) => it.name === name).reduce((sum, it) => sum + it.count, 0)
}

function findFurnace (link, args) {
  const bot = link.bot
  if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
    const block = bot.blockAt(new Vec3(Math.round(Number(args.x)), Math.round(Number(args.y)), Math.round(Number(args.z))))
    return block && block.name === FURNACE ? block : null
  }
  const def = link.mcData.blocksByName[FURNACE]
  if (!def) return null
  return bot.findBlock({ matching: def.id, maxDistance: clampInt(args.radius, 1, 32, 16) })
}

/** 挑一份最合适的燃料：够用前提下挑烧得久的，省着用煤块。 */
function pickFuel (bot, needSeconds) {
  const items = bot.inventory.items()
    .map((it) => ({ item: it, seconds: fuelSeconds(it.name) }))
    .filter((f) => f.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
  if (!items.length) return null
  const best = items[0]
  const need = Math.ceil(needSeconds / best.seconds)
  return { item: best.item, seconds: best.seconds, count: Math.max(1, Math.min(need, best.item.count)) }
}

function slotName (slot) {
  return slot && slot.name ? slot.name : null
}

async function smelt (args, ctx) {
  const { link, signal } = ctx
  const bot = link.bot
  if (!bot || !bot.entity) return { ok: false, detail: { error: 'bot_not_ready' } }
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  const inputName = String(args.input || args.item || '').trim()
  if (!inputName) return { ok: false, detail: { error: 'missing_input' } }
  if (!link.mcData.itemsByName[inputName]) return { ok: false, detail: { error: 'unknown_item', item: inputName } }

  const product = smeltProduct(inputName)
  if (!product) return { ok: false, detail: { error: 'not_smeltable', item: inputName } }

  const have = countOf(bot, inputName)
  if (!have) return { ok: false, detail: { error: 'item_not_in_inventory', item: inputName, product } }

  let want = clampInt(args.count, 1, MAX_PER_CALL, 1)
  want = Math.min(want, have)

  // ---- 找熔炉；没有就现放一个 ----
  let block = findFurnace(link, args)
  let placed = null
  if (!block) {
    if (!countOf(bot, FURNACE)) return { ok: false, detail: { error: 'no_furnace', item: inputName, product } }
    const put = await placeBlock(link, FURNACE, null, signal)
    if (!put.ok) return { ok: false, detail: { error: 'furnace_place_failed', product, cause: put.detail } }
    placed = put.detail.at
    block = bot.blockAt(new Vec3(placed.x, placed.y, placed.z))
    if (!block || block.name !== FURNACE) return { ok: false, detail: { error: 'furnace_not_appeared', at: placed } }
  }

  // ---- 走到够得着 ----
  const dist = bot.entity.position.distanceTo(block.position)
  if (dist > 3.5) {
    await link.gotoNear(block.position.x, block.position.y, block.position.z, 2)
    const reached = await link.goalReached(15000)
    if (!reached.ok) return { ok: false, detail: { error: 'cannot_reach_furnace', distance: Math.round(dist), reason: reached.reason } }
  }
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  const at = { x: block.position.x, y: block.position.y, z: block.position.z }
  const before = countOf(bot, product)
  const beforeInput = countOf(bot, inputName)

  let furnace
  try {
    furnace = await raceTimeout(bot.openFurnace(block), 10000)
  } catch (err) {
    return { ok: false, detail: { error: 'open_failed', message: err.message, at, placed } }
  }

  const finish = (detail) => {
    try { furnace.close() } catch (_) { /* noop */ }
    return detail
  }

  try {
    // ---- 燃料 ----
    const needSeconds = want * SMELT_SECONDS
    let fuelNote = null
    if (!furnace.fuelItem()) {
      const fuel = pickFuel(bot, needSeconds)
      if (!fuel) return finish({ ok: false, detail: { error: 'no_fuel', product, input: inputName, at } })
      try {
        await raceTimeout(furnace.putFuel(fuel.item.type, null, fuel.count), 8000)
        fuelNote = `${fuel.item.name}×${fuel.count}`
      } catch (err) {
        return finish({ ok: false, detail: { error: 'fuel_put_failed', message: err.message, fuel: fuel.item.name } })
      }
    } else {
      fuelNote = `已有的${slotName(furnace.fuelItem())}`
    }

    // ---- 原料 ----
    try {
      await raceTimeout(furnace.putInput(bot.inventory.items().find((it) => it.name === inputName).type, null, want), 8000)
    } catch (err) {
      return finish({ ok: false, detail: { error: 'input_put_failed', message: err.message, input: inputName } })
    }

    // ---- 等：炉子里原料烧完（input 空）或到点 ----
    const budgetMs = Math.max(15000, (want * SMELT_SECONDS + 15) * 1000)
    const deadline = Date.now() + Math.min(budgetMs, (ctx.timeoutMs || 120000) - 8000)
    let stalled = 0
    let lastOutput = -1
    while (Date.now() < deadline) {
      if (signal.aborted) return finish({ ok: false, detail: { error: 'cancelled', smelted: countOf(bot, product) - before } })
      const input = furnace.inputItem()
      const output = furnace.outputItem()
      const outputCount = output ? output.count : 0
      if (!input && outputCount === 0) break
      if (outputCount === lastOutput) stalled += 1; else { stalled = 0; lastOutput = outputCount }
      // 炉子空转 10 秒还没变化：燃料不够或配方不对，别干等
      if (stalled >= 20) break
      await sleep(500)
    }

    // ---- 取成品 ----
    let guard = 0
    while (furnace.outputItem() && guard < 10) {
      guard += 1
      try {
        await raceTimeout(furnace.takeOutput(), 6000)
      } catch (_) { break }
    }

    const after = countOf(bot, product)
    const smelted = after - before
    const notes = []
    if (smelted < want) notes.push(`只烧出 ${smelted}/${want}`)
    if (!furnace.fuelItem() && smelted < want) notes.push('燃料可能不够')
    return finish({
      ok: smelted > 0,
      detail: {
        input: inputName,
        product,
        smelted,
        want,
        fuel: fuelNote,
        at,
        placed,
        input_left: countOf(bot, inputName),
        input_before: beforeInput,
        note: notes.length ? notes.join('；') : undefined,
        error: smelted > 0 ? undefined : 'nothing_smelted'
      }
    })
  } catch (err) {
    try { furnace.close() } catch (_) { /* noop */ }
    return { ok: false, detail: { error: 'smelt_failed', message: err.message, input: inputName, product } }
  }
}

module.exports = { name: 'smelt', run: smelt, smeltProduct, fuelSeconds, RECIPES, FUELS, MAX_PER_CALL }
