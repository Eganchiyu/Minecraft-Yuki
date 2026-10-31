'use strict'
// sidecar/skills/snapshot.js —— 只为「看画面」摆好姿势：可选转个头，然后如实报当前视角。
//
// 真正的抓帧不在这一侧：planner 用 ffmpeg x11grab 抓虚拟屏，并且会把原图直接交给 L1。
// 这里只做身体能做的两件事——按 yaw/pitch 或某格坐标转头、等视角同步，然后报视角。
// 没给转向参数就是照现在的朝向拍，不替 L2 拿主意。
const Vec3 = require('vec3')
const { raceTimeout } = require('../util')

const SETTLE_MS = 400

async function snapshot (args, ctx) {
  const { link, signal } = ctx
  const bot = link.bot
  if (!bot || !bot.entity) return { ok: false, detail: { error: 'bot_not_ready' } }
  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }

  const reason = String(args.reason || '').slice(0, 60)
  const hasCoords = ['x', 'y', 'z'].every((k) => Number.isFinite(Number(args[k])))
  const hasYaw = Number.isFinite(Number(args.yaw))
  const hasPitch = Number.isFinite(Number(args.pitch))
  let turned = 'none'

  try {
    if (hasCoords) {
      await raceTimeout(bot.lookAt(new Vec3(Number(args.x), Number(args.y), Number(args.z)), true), 5000)
      turned = 'coords'
    } else if (hasYaw || hasPitch) {
      const deg = Math.PI / 180
      const yaw = hasYaw ? Number(args.yaw) * deg : bot.entity.yaw
      const pitch = hasPitch ? Number(args.pitch) * deg : bot.entity.pitch
      await raceTimeout(bot.look(yaw, pitch, true), 5000)
      turned = 'angles'
    }
    if (turned !== 'none') {
      // 视角变了之后要等一帧同步到观战客户端，否则抓到的还是旧画面
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    }
  } catch (err) {
    return { ok: false, detail: { error: 'look_failed', message: err.message, reason } }
  }

  if (signal.aborted) return { ok: false, detail: { error: 'cancelled' } }
  const view = typeof link.view === 'function' ? link.view() : null
  return { ok: true, detail: { reason, turned, view } }
}

module.exports = { name: 'snapshot', run: snapshot }
