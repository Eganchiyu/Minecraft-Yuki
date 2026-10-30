'use strict'
// sidecar/skills/sleep.js —— 睡一觉把夜晚跳过去。硬校验看 bot.isSleeping 是不是真的躺下了。
const { raceTimeout } = require('../util')

const BED_SUFFIX = '_bed'

async function sleep (args, ctx) {
  const { link, signal } = ctx
  const bot = link.bot
  if (!bot || !bot.entity) return { ok: false, detail: { error: 'bot_not_ready' } }
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  if (bot.isSleeping) return { ok: true, detail: { already: true, note: 'already_sleeping' } }

  // 白天睡不了：原版会直接拒绝，先如实说清楚，不要让 L2 白等
  const day = bot.time && bot.time.isDay
  if (day) return { ok: false, detail: { error: 'not_night', time: bot.time ? bot.time.timeOfDay : null } }

  // 找附近的床；args.x/y/z 给了就在那
  let bed = null
  if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
    const Vec3 = require('vec3')
    const block = bot.blockAt(new Vec3(Math.round(Number(args.x)), Math.round(Number(args.y)), Math.round(Number(args.z))))
    if (block && block.name.endsWith(BED_SUFFIX)) bed = block
  } else {
    const ids = Object.values(link.mcData.blocksByName)
      .filter((def) => def.name.endsWith(BED_SUFFIX))
      .map((def) => def.id)
    bed = bot.findBlock({ matching: ids, maxDistance: 16 })
  }
  if (!bed) return { ok: false, detail: { error: 'no_bed', hint: '需要一张床（craft 做不了床，得有人放）' } }

  const dist = bot.entity.position.distanceTo(bed.position)
  if (dist > 3) {
    await link.gotoNear(bed.position.x, bed.position.y, bed.position.z, 2)
    const reached = await link.goalReached(15000)
    if (!reached.ok) return { ok: false, detail: { error: 'cannot_reach_bed', distance: Math.round(dist), reason: reached.reason } }
  }
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  try {
    await raceTimeout(bot.sleep(bed), 10000)
  } catch (err) {
    return { ok: false, detail: { error: 'sleep_failed', message: err.message, bed: bed.name } }
  }

  return { ok: Boolean(bot.isSleeping), detail: { bed: bed.name, sleeping: Boolean(bot.isSleeping), error: bot.isSleeping ? undefined : 'not_sleeping' } }
}

module.exports = { name: 'sleep', run: sleep }
