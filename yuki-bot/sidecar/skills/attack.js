'use strict'
// sidecar/skills/attack.js —— 打怪，硬校验看目标实体是否真的从世界里消失了。
const { clampInt } = require('../util')

function resolveTarget (link, targetName, maxDistance) {
  const bot = link.bot
  if (targetName && targetName !== 'hostile') {
    return bot.nearestEntity((entity) => {
      if (entity === bot.entity) return false
      if (entity.name !== targetName) return false
      return bot.entity.position.distanceTo(entity.position) <= maxDistance
    })
  }
  return bot.nearestEntity((entity) => {
    if (entity === bot.entity) return false
    const def = link.mcData.entitiesByName[entity.name]
    if (!def || def.category !== 'Hostile mobs') return false
    return bot.entity.position.distanceTo(entity.position) <= maxDistance
  })
}

async function attack (args, ctx) {
  const { link, signal } = ctx
  const bot = link.bot
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  const targetName = String(args.target || 'hostile').trim()
  const want = clampInt(args.count, 1, 8, 1)
  if (targetName !== 'hostile' && !link.mcData.entitiesByName[targetName]) {
    return { ok: false, detail: { error: 'unknown_entity', target: targetName } }
  }

  const deadline = Date.now() + Math.min(ctx.timeoutMs || 60000, 120000)
  let killed = 0
  let lastTarget = null
  let lastError = ''

  while (killed < want && !signal.aborted && Date.now() < deadline) {
    const entity = resolveTarget(link, targetName, 24)
    if (!entity) { lastError = 'no_target_in_range'; break }
    lastTarget = entity.name
    let result
    try {
      await bot.pvp.attack(entity)
      result = await waitUntilGone(bot, entity, Math.min(25000, Math.max(3000, deadline - Date.now())), signal)
    } catch (err) {
      lastError = `attack_failed:${err.message}`
      result = 'error'
    } finally {
      try { bot.pvp.forceStop() } catch (_) { /* noop */ }
    }
    if (result === 'gone') killed += 1
    else if (result === 'cancelled') break
    else { lastError = result === 'timeout' ? 'target_not_killed' : lastError; break }
  }

  const ok = killed >= want
  return {
    ok,
    detail: {
      target: targetName,
      requested: want,
      killed,
      last_target: lastTarget,
      error: ok ? undefined : (lastError || 'not_killed'),
      aborted: signal.aborted
    }
  }
}

/** 目标被服务端移除（死亡/消失）即算成功；注意 pvp 只负责追击与挥击。 */
function waitUntilGone (bot, entity, timeoutMs, signal) {
  return new Promise((resolve) => {
    let done = false
    const finish = (why) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(poll)
      signal.removeEventListener('abort', onAbort)
      resolve(why)
    }
    const onAbort = () => finish('cancelled')
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    const poll = setInterval(() => {
      if (!bot.entities[entity.id]) finish('gone')
    }, 250)
    signal.addEventListener('abort', onAbort, { once: true })
    if (!bot.entities[entity.id]) finish('gone')
  })
}

module.exports = { name: 'attack', run: attack }
