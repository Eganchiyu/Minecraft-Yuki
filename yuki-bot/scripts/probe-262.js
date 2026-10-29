'use strict'
// scripts/probe-262.js —— 26.2（协议 776）连通性探针。
// 用途：上游还没给 26.2 协议数据时，验证「拿 26.1 数据充 26.2」能不能真的登录、走路、挖方块。
// 用法：node scripts/probe-262.js [host] [port]
const mineflayer = require('mineflayer')

const HOST = process.argv[2] || '127.0.0.1'
const PORT = Number(process.argv[3] || 25568)
const VERSION = process.env.PROBE_VERSION || '26.2'

function log (event, extra) {
  const t = new Date().toISOString().slice(11, 19)
  console.log(`${t} ${event}${extra ? ' ' + JSON.stringify(extra) : ''}`)
}

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: process.env.PROBE_USER || 'YukiProbe',
  version: VERSION,
  auth: 'offline'
})

let digDone = false
const timer = setTimeout(() => {
  log('timeout', { spawned: bot.entity != null, digDone })
  process.exit(bot.entity ? 2 : 1)
}, 60000)

bot.on('error', (err) => log('error', { message: err.message }))
bot.on('kicked', (reason) => log('kicked', { reason: typeof reason === 'string' ? reason : JSON.stringify(reason) }))
bot.on('end', (reason) => log('end', { reason: String(reason) }))
bot.on('messagestr', (msg) => log('server_message', { msg: msg.slice(0, 120) }))

bot.once('spawn', async () => {
  log('spawn', { version: bot.version, entityId: bot.entity.id, pos: round(bot.entity.position) })
  try {
    const mcData = require('minecraft-data')(bot.version)
    log('mcData', { protocol: mcData.version.version, blocks: Object.keys(mcData.blocksByName).length, items: Object.keys(mcData.itemsByName).length })

    // 1) 读脚下的方块（方块状态解码）
    const feet = bot.blockAt(bot.entity.position.offset(0, -1, 0))
    log('block_below', { name: feet ? feet.name : null, id: feet ? feet.stateId : null })

    // 2) 走路（实体/物理/移动包）
    bot.setControlState('forward', true)
    await wait(1200)
    bot.setControlState('forward', false)
    log('moved', { pos: round(bot.entity.position) })

    // 3) 挖一格（方块告警/挖掘包/掉落物）
    const target = bot.blockAt(bot.entity.position.offset(1, -1, 0))
    if (target && target.name !== 'air' && target.diggable !== false) {
      await bot.dig(target)
      digDone = true
      log('dig_ok', { block: target.name })
    } else {
      log('dig_skipped', { name: target && target.name })
    }

    // 4) 背包（窗口包 / inventory 序列化）
    log('inventory', { items: bot.inventory.items().map((i) => `${i.name}x${i.count}`).slice(0, 8) })
    log('health', { health: bot.health, food: bot.food })
    log('result', { ok: true, digDone })
    clearTimeout(timer)
    bot.quit()
    setTimeout(() => process.exit(0), 500)
  } catch (err) {
    log('probe_failed', { message: err.message, stack: (err.stack || '').split('\n')[1] })
    clearTimeout(timer)
    bot.quit()
    setTimeout(() => process.exit(3), 500)
  }
})

function wait (ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function round (p) { return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 } }
