'use strict'
// sidecar/skills/equip.js —— 换工具/穿装备，硬校验看目标槽位里到底是什么。
const DESTINATIONS = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']

function slotItemName (bot, destination) {
  if (destination === 'hand') return bot.heldItem ? bot.heldItem.name : null
  if (destination === 'off-hand') {
    const off = bot.inventory.slots[45]
    return off ? off.name : null
  }
  const slot = bot.getEquipmentDestSlot(destination)
  const item = slot === undefined || slot === null ? null : bot.inventory.slots[slot]
  return item ? item.name : null
}

async function equip (args, ctx) {
  const { link, signal } = ctx
  const bot = link.bot
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  const itemName = String(args.item || '').trim()
  if (!itemName) return { ok: false, detail: { error: 'missing_item' } }
  if (!link.mcData.itemsByName[itemName]) return { ok: false, detail: { error: 'unknown_item', item: itemName } }

  const destination = DESTINATIONS.includes(args.destination) ? args.destination : 'hand'
  const item = bot.inventory.items().find((it) => it.name === itemName)
  if (!item) return { ok: false, detail: { error: 'item_not_in_inventory', item: itemName } }

  try {
    await bot.equip(item, destination)
  } catch (err) {
    return { ok: false, detail: { error: 'equip_failed', message: err.message, item: itemName, destination } }
  }

  const actual = slotItemName(bot, destination)
  return {
    ok: actual === itemName,
    detail: { item: itemName, destination, actual, error: actual === itemName ? undefined : 'slot_mismatch' }
  }
}

module.exports = { name: 'equip', run: equip, DESTINATIONS }
