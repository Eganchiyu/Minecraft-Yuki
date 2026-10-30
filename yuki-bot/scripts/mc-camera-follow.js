'use strict'
// scripts/mc-camera-follow.js —— 让虚拟屏里的观战客户端「长在 Yuki 的眼睛上」。
//
// 为什么是 /tp 而不是 /spectate：/spectate 必须由旁观者客户端自己执行，而虚拟屏里没人敲键盘。
// 服务端控制台可以把 YukiCam（spectator）每 200ms 传送到 Yuki 的位置与朝向，
// 相机就在她眼睛的位置、朝她看的方向——不依赖任何 mod，也不碰机主桌面。
//
// 用法: node scripts/mc-camera-follow.js --fifo=/tmp/p4-0/server.in [--user=YukiCam]
//                                       [--sidecar=http://127.0.0.1:8790] [--interval=200]
const fs = require('fs')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const FIFO = argOf('fifo', process.env.P4_FIFO || '')
const USER = argOf('user', 'YukiCam')
const SIDECAR = argOf('sidecar', 'http://127.0.0.1:8790').replace(/\/+$/, '')
const INTERVAL = Math.max(100, Number(argOf('interval', '200')) || 200)
// 相机要离她的模型一点点：同一坐标会把镜头塞进她的头里（只能看到皮肤内壁）
const OFFSET = Number(argOf('offset', '0.6')) || 0

let fd = null
let last = ''
let sent = 0
let stopped = false

function send (line) {
  if (!FIFO) return false
  if (fd === null) fd = fs.openSync(FIFO, 'w')
  fs.writeSync(fd, line + '\n')
  sent += 1
  return true
}

async function tick () {
  if (stopped) return
  try {
    const res = await fetch(`${SIDECAR}/state`)
    if (res.ok) {
      const state = await res.json()
      const p = state.pos
      const v = state.view
      if (p && v && state.bot === 'ready') {
        // yaw 0 = 南(+z)；朝向向量 = (-sin yaw, 0, cos yaw)
        const rad = (v.yaw * Math.PI) / 180
        const x = Math.round((p.x - Math.sin(rad) * OFFSET) * 100) / 100
        const z = Math.round((p.z + Math.cos(rad) * OFFSET) * 100) / 100
        const cmd = `/tp ${USER} ${x} ${p.y} ${z} ${v.yaw} ${v.pitch}`
        if (cmd !== last) {
          last = cmd
          send(cmd)
        }
      }
    }
  } catch (_) { /* 侧车没起：下一轮再试 */ }
  setTimeout(tick, INTERVAL)
}

process.on('SIGINT', () => { stopped = true; process.exit(0) })
process.on('SIGTERM', () => { stopped = true; process.exit(0) })

if (!FIFO) {
  console.error('需要 --fifo=<服务端控制台管道>')
  process.exit(2)
}
console.log(`[camera] 跟随 ${USER} -> ${SIDECAR}，每 ${INTERVAL}ms 一次，前移 ${OFFSET} 格`)
tick()

setInterval(() => {
  if (sent) console.log(`[camera] 已发送 ${sent} 条 /tp`)
  sent = 0
}, 30000).unref()
