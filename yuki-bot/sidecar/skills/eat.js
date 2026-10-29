'use strict'
// sidecar/skills/eat.js —— 吃食物回饥饿值，硬校验看 food 是否真的涨了。
const { raceTimeout } = require('../util')

/** 背包里最好的一份食物；preferred 指定时只找它。 */
function pickFood (link, preferred) {
  const bot = link.bot
  const foods = link.mcData.foodsByName
  const items = bot.inventory.items().filter((item) => Boolean(foods[item.name]))
  if (preferred) {
    return items.find((item) => item.name === preferred) || null
  }
  return items.sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0] || null
}

/** 被守护逻辑复用的最小吃动作：能吃到就吃，返回事实，不抛异常。 */
async function eatSomething (link, preferred) {
  const bot = link.bot
  if (!bot || typeof bot.food !== 'number') return { ok: false, detail: { error: 'no_food_state' } }
  if (bot.food >= 20) return { ok: false, detail: { error: 'not_hungry', food: bot.food } }

  const item = pickFood(link, preferred)
  if (!item) return { ok: false, detail: { error: preferred ? 'food_not_found' : 'no_food_item', food: bot.food, want: preferred } }

  const foodBefore = bot.food
  const satBefore = bot.foodSaturation
  try {
    await bot.equip(item, 'hand')
    await raceTimeout(bot.consume(), 10000)
  } catch (err) {
    return { ok: false, detail: { error: 'consume_failed', message: err.message, item: item.name } }
  }
  const gained = bot.food - foodBefore
  const satGained = (bot.foodSaturation || 0) - (satBefore || 0)
  return {
    ok: gained > 0 || satGained > 0,
    detail: { item: item.name, food_before: foodBefore, food_after: bot.food, gained }
  }
}

async function eat (args, ctx) {
  const preferred = args.food ? String(args.food).trim() : ''
  if (preferred && !ctx.link.mcData.foodsByName[preferred]) {
    return { ok: false, detail: { error: 'not_food', item: preferred } }
  }
  return eatSomething(ctx.link, preferred || null)
}

module.exports = { name: 'eat', run: eat, eatSomething, pickFood }
