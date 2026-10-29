'use strict'
// sidecar/validate.js —— 硬校验：不调模型，只比背包增量和实际距离。

function diffCounts (before, after) {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)])
  const out = {}
  for (const id of ids) {
    const d = (after[id] || 0) - (before[id] || 0)
    if (d !== 0) out[id] = d
  }
  return out
}

function sumGain (delta, itemIds) {
  let total = 0
  for (const id of itemIds) total += Math.max(0, delta[id] || 0)
  return total
}

/** 方块可能掉落的物品 id 列表（26.1 里 stone 掉 cobblestone，必须查数据而不是猜）。 */
function blockDropIds (mcData, blockName) {
  const def = mcData.blocksByName[blockName]
  if (!def || !Array.isArray(def.drops)) return []
  return def.drops
}

function droppedNames (mcData, itemIds) {
  return itemIds
    .map((id) => (mcData.items[id] ? mcData.items[id].name : `#${id}`))
}

/** 到达判定：xz 平面内距离 ≤ range，垂直差 ≤ 2 格。 */
function arrived (link, x, y, z, range = 1) {
  const p = link.pos()
  if (!p) return { ok: false, detail: { error: 'no_position' } }
  const dx = p.x - x
  const dz = p.z - z
  const dy = Math.abs(p.y - y)
  const distance = Math.hypot(dx, dz)
  return {
    ok: distance <= range + 1 && dy <= 2,
    detail: { distance: round(distance), dy: round(dy), range, pos: p, target: { x, y, z } }
  }
}

function round (n) { return Math.round(n * 100) / 100 }

module.exports = { diffCounts, sumGain, blockDropIds, droppedNames, arrived }
