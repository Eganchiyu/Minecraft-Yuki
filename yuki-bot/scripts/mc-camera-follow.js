'use strict'
// scripts/mc-camera-follow.js —— 让虚拟屏里的观战客户端「长在 Yuki 的眼睛上」。
//
// 两种模式，选一个：
//   --mode=tp        自建服（能拿到服务端控制台管道）：每 200ms 一条 /tp，相机精确到她的眼睛，
//                    沿视线前移 0.6 格避免陷进她的模型。P4.0 已验。
//   --mode=spectate  别人的服（拿不到控制台，但 YukiCam 自己是 OP）：用 XTest 在虚拟屏客户端里
//                    敲 /spectate <目标>，原版旁观者跟随——一次执行持续生效，重连/重生/死亡才重敲。
//
// 为什么 spectate 模式不循环 /tp：那要每 200ms 敲键盘，等于把聊天框一直打开；而原版
// /spectate 本身就是「跟着这个玩家的相机走」，一次就够。
//
// 用法:
//   node scripts/mc-camera-follow.js --mode=tp --fifo=/tmp/yuki-world/server.in --user=YukiCam
//   node scripts/mc-camera-follow.js --mode=spectate --display=:98 --user=YukiCam \
//        --sidecar=http://127.0.0.1:8790 --client-log=/tmp/mc-client/client.log --ensure-spectator
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const flag = (name) => args.includes(`--${name}`)

const ROOT = path.resolve(__dirname, '..', '..')
const MODE = String(argOf('mode', 'tp')).toLowerCase()
const FIFO = argOf('fifo', process.env.P4_FIFO || '')
const USER = argOf('user', 'YukiCam')
const TARGET = argOf('target', '')
const SIDECAR = argOf('sidecar', 'http://127.0.0.1:8790').replace(/\/+$/, '')
const INTERVAL = Math.max(100, Number(argOf('interval', '200')) || 200)
// 相机要离她的模型一点点：同一坐标会把镜头塞进她的头里（只能看到皮肤内壁）
const OFFSET = Number(argOf('offset', '0.6')) || 0
// spectate 模式专用
const DISPLAY = argOf('display', process.env.MC_DISPLAY || ':98')
const CLIENT_LOG = argOf('client-log', '/tmp/mc-client/client.log')
const CHECK_S = Math.max(2, Number(argOf('check-s', '10')) || 10)
const PYTHON = argOf('python', process.env.YUKI_PYTHON || 'python3')
const KEYS = argOf('keys', path.join(ROOT, 'scripts', 'mc-keys.py'))
const REAPPLY_S = Number(argOf('reapply-s', '0')) || 0

if (MODE !== 'tp' && MODE !== 'spectate') {
  console.error(`[camera] 未知 --mode=${MODE}（tp | spectate）`)
  process.exit(2)
}

let stopped = false

async function fetchState () {
  const res = await fetch(`${SIDECAR}/state`)
  if (!res.ok) throw new Error(`state ${res.status}`)
  return res.json()
}

// ---------------------------------------------------------------- tp 模式
let fd = null
let last = ''
let sent = 0

function send (line) {
  if (!FIFO) return false
  if (fd === null) fd = fs.openSync(FIFO, 'w')
  fs.writeSync(fd, line + '\n')
  sent += 1
  return true
}

async function tickTp () {
  if (stopped) return
  try {
    const state = await fetchState()
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
  } catch (_) { /* 侧车没起：下一轮再试 */ }
  setTimeout(tickTp, INTERVAL)
}

// ---------------------------------------------------------- spectate 模式
// 客户端日志是英文结构 + 服务端消息（可能被本地化成中文），所以关键词两套都认。
// 判断「客户端在服里」：最后一次 Connecting to 之后没有 Connection lost / Disconnected。
// 不能用 "joined the game"：那条广播只发给别人，客户端自己的日志里没有。
const CONNECT_RE = /Connecting to /
const LOST_RE = /Connection lost|Disconnected|Internal Exception/
const FAIL_RE = /not a spectator|No player was found|Unknown or incomplete command|不是旁观者|不在线|没有找到|只有旁观者/

function logSize () {
  try { return fs.statSync(CLIENT_LOG).size } catch (_) { return 0 }
}

function readClientLog (from = 0, limit = 256 * 1024) {
  try {
    const size = logSize()
    const begin = Math.max(from, size - limit)
    if (size <= begin) return ''
    const buf = Buffer.alloc(size - begin)
    const fh = fs.openSync(CLIENT_LOG, 'r')
    fs.readSync(fh, buf, 0, buf.length, begin)
    fs.closeSync(fh)
    return buf.toString('utf8')
  } catch (_) {
    return ''
  }
}

function clientConnected () {
  const log = readClientLog(0)
  const at = log.lastIndexOf('Connecting to ')
  if (at < 0) return false
  return !LOST_RE.test(log.slice(at))
}

function pressCommand (text) {
  const argv = [KEYS, '--display', DISPLAY, '--focus', 't', '--text', text]
  const r = spawnSync(PYTHON, argv, { timeout: 20000, encoding: 'utf8' })
  if (r.error) return { ok: false, error: r.error.message }
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim().slice(0, 200) }
  return { ok: true }
}

let lastTarget = ''
let lastDeaths = null
let lastApplyAt = 0
let logPos = 0
let applied = false

function spectateNeeded (state) {
  const target = TARGET || state.username
  if (!target) return null
  if (!applied) return target
  if (target !== lastTarget) return target
  if (state.deaths !== undefined && state.deaths !== null && lastDeaths !== null && state.deaths !== lastDeaths) return target
  if (REAPPLY_S > 0 && Date.now() - lastApplyAt >= REAPPLY_S * 1000) return target
  const fresh = readClientLog(logPos)
  if (fresh && FAIL_RE.test(fresh)) return target
  return null
}

async function tickSpectate () {
  if (stopped) return
  const started = Date.now()
  try {
    // 客户端还没进服就先等：没进服的键盘敲不到聊天框
    if (!clientConnected()) throw new Error('client_not_joined')

    const state = await fetchState()
    if (state.bot !== 'ready') throw new Error('bot_offline')

    const target = spectateNeeded(state)
    if (target) {
      logPos = logSize()
      if (flag('ensure-spectator')) {
        const g = pressCommand('/gamemode spectator')
        if (!g.ok) console.error(`[camera] /gamemode spectator 没敲上：${g.error}`)
      }
      const r = pressCommand(`/spectate ${target}`)
      if (!r.ok) {
        console.error(`[camera] /spectate 没敲上：${r.error}`)
        applied = false
      } else {
        applied = true
        lastTarget = target
        lastDeaths = state.deaths ?? null
        lastApplyAt = Date.now()
        console.log(`[camera] 已让 ${USER} 旁观 ${target}`)
      }
    }
  } catch (err) {
    if (err.message !== 'client_not_joined' && err.message !== 'bot_offline') {
      console.error(`[camera] ${err.message}`)
    }
  }
  const wait = Math.max(1000, CHECK_S * 1000 - (Date.now() - started))
  setTimeout(tickSpectate, wait)
}

// ------------------------------------------------------------------ 启动
process.on('SIGINT', () => { stopped = true; process.exit(0) })
process.on('SIGTERM', () => { stopped = true; process.exit(0) })

if (MODE === 'tp') {
  if (!FIFO) {
    console.error('tp 模式需要 --fifo=<服务端控制台管道>')
    process.exit(2)
  }
  console.log(`[camera] 跟随 ${USER} -> ${SIDECAR}，每 ${INTERVAL}ms 一次，前移 ${OFFSET} 格`)
  tickTp()
  setInterval(() => {
    if (sent) console.log(`[camera] 已发送 ${sent} 条 /tp`)
    sent = 0
  }, 30000).unref()
} else {
  console.log(`[camera] spectate 模式：${USER}@${DISPLAY} 跟随 ${TARGET || '<sidecar username>'}，每 ${CHECK_S}s 自检`)
  tickSpectate()
}
