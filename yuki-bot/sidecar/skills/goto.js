'use strict'
// sidecar/skills/goto.js —— 寻路到坐标，硬校验看是否真的到了（位置是权威，事件只用来提前结束）。
const { arrived } = require('../validate')
const { clampInt } = require('../util')

async function goto (args, ctx) {
  const { link, signal } = ctx
  const x = Number(args.x)
  const y = Number(args.y)
  const z = Number(args.z)
  if (![x, y, z].every(Number.isFinite)) {
    return { ok: false, detail: { error: 'invalid_coords', args } }
  }
  const range = clampInt(args.range, 0, 3, 1)
  const timeoutMs = ctx.timeoutMs || 60000

  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }
  await link.gotoNear(x, y, z, range)
  const result = await link.goalReached(timeoutMs)
  const check = arrived(link, x, y, z, range)
  return {
    ok: check.ok,
    detail: {
      target: { x, y, z },
      range,
      path: result.reason,
      ...check.detail,
      error: check.ok ? undefined : 'not_arrived'
    }
  }
}

module.exports = { name: 'goto', run: goto }
