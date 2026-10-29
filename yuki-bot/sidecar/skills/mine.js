'use strict'
// sidecar/skills/mine.js —— 采集方块，硬校验看背包增量。
const log = require('../log')
const { diffCounts, sumGain, blockDropIds, droppedNames } = require('../validate')
const { raceTimeout, StepTimeout, clampInt, sleep } = require('../util')

async function mine (args, ctx) {
  const { link, signal } = ctx
  const mcData = link.mcData
  const blockName = String(args.block || '').trim()
  if (!blockName) return { ok: false, detail: { error: 'missing_block' } }

  const blockDef = mcData.blocksByName[blockName]
  if (!blockDef) return { ok: false, detail: { error: 'unknown_block', block: blockName } }

  const count = clampInt(args.count, 1, 64, 1)

  // 工具前置校验：石头这类方块没有对应镐子挖了也不掉落，直接给出可行动的失败事实，
  // 不能扔给 collectblock（空手挖石头会让它原地空转到 OOM，实测踩过）。
  const harvestTools = blockDef.harvestTools
  if (harvestTools) {
    const usable = (item) => Boolean(item && harvestTools[item.type])
    if (!usable(link.bot.heldItem)) {
      const tool = link.bot.inventory.items().find(usable)
      if (tool) {
        try { await link.bot.equip(tool, 'hand') } catch (_) { /* noop */ }
      }
    }
    if (!usable(link.bot.heldItem)) {
      return {
        ok: false,
        detail: {
          error: 'missing_tool',
          block: blockName,
          needs: droppedNames(mcData, Object.keys(harvestTools).map(Number)),
          count: 0,
          requested: count
        }
      }
    }
  }

  const itemIds = blockDropIds(mcData, blockName)
  const before = link.inventoryCounts()
  const gained = () => sumGain(diffCounts(before, link.inventoryCounts()), itemIds)
  const deadline = Date.now() + (ctx.timeoutMs || 90000)
  const failed = new Set()
  let mined = gained()
  let attempts = 0
  let lastError = ''

  const reportProgress = (done) => {
    if (typeof ctx.progress === 'function') ctx.progress(done, count)
  }
  reportProgress(mined)

  while (mined < count && !signal.aborted && Date.now() < deadline) {
    const candidates = link.bot
      .findBlocks({ matching: blockDef.id, maxDistance: 48, count: 24 })
      .filter((p) => !failed.has(key(p)))
      .sort((a, b) => link.bot.entity.position.distanceTo(a) - link.bot.entity.position.distanceTo(b))

    if (!candidates.length) { lastError = 'no_target_block'; break }

    const pos = candidates[0]
    const block = link.bot.blockAt(pos)
    if (!block || block.name !== blockName) { failed.add(key(pos)); continue }

    attempts += 1
    try {
      await raceTimeout(link.bot.collectBlock.collect(block), Math.min(45000, Math.max(5000, deadline - Date.now())))
    } catch (err) {
      failed.add(key(pos))
      lastError = err instanceof StepTimeout ? 'collect_timeout' : `collect_failed:${err.name || err.message}`
      log.debug('mine_collect_failed', { pos: { x: pos.x, y: pos.y, z: pos.z }, error: lastError })
      if (err instanceof StepTimeout) link.hardStop()
      await sleep(120)
      continue
    }

    mined = gained()
    reportProgress(mined)
    log.debug('mine_progress', { mined, count, attempts })
  }

  const ok = mined >= count
  if (signal.aborted) lastError = lastError || 'cancelled'
  return {
    ok,
    detail: {
      block: blockName,
      requested: count,
      mined,
      attempts,
      item: droppedNames(mcData, itemIds),
      error: ok ? undefined : (lastError || 'not_enough'),
      aborted: signal.aborted
    }
  }
}

function key (p) { return `${p.x},${p.y},${p.z}` }

module.exports = { name: 'mine', run: mine }
