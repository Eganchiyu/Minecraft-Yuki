// Yuki bot 最小闭环：登录 -> 状态上报 -> 寻路/跟随（L3 运动皮层）
// 用法: node scripts/yuki.js [--selftest]
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const USER = process.env.MC_USER || 'Yuki'
const VERSION = process.env.MC_VERSION || '26.1'
const SELFTEST = process.argv.includes('--selftest')

const log = (...a) => console.log(`[yuki ${new Date().toISOString().slice(11, 19)}]`, ...a)
const fmt = (p) => p ? `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` : 'null'

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USER, version: VERSION, auth: 'offline' })
bot.loadPlugin(pathfinder)

let followTarget = null
let followTimer = null

bot.once('spawn', () => {
  const mcData = require('minecraft-data')(bot.version)
  bot.pathfinder.setMovements(new Movements(bot, mcData))
  log(`spawned as ${bot.username} @ ${fmt(bot.entity.position)} (${bot.version})`)
  bot.chat('Yuki online.')
  if (SELFTEST) runSelftest()
})

bot.on('kicked', (r) => log('kicked:', JSON.stringify(r)))
bot.on('error', (e) => log('error:', e.message))
bot.on('end', (r) => { log('disconnected:', r); process.exit(0) })
bot.on('death', () => log('died @', fmt(bot.entity.position)))
bot.on('health', () => { if (bot.health < 8) log(`health low: ${bot.health}`) })

// 聊天指令路由（后续 L2 路由层就接在这里）
bot.on('chat', async (username, message) => {
  if (username === bot.username) return
  const m = message.trim().toLowerCase()
  if (!m.startsWith('yuki')) return
  const [, cmd, ...args] = m.split(/\s+/)
  log(`<- ${username}: ${message}`)
  try {
    switch (cmd) {
      case 'come': {
        const target = bot.players[username]?.entity
        if (!target) return bot.chat(`can't see you, ${username}`)
        bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2))
        return bot.chat('coming~')
      }
      case 'goto': {
        const [x, y, z] = args.map(Number)
        if ([x, y, z].some(Number.isNaN)) return bot.chat('usage: yuki goto x y z')
        bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z))
        return bot.chat(`heading to ${x} ${y} ${z}`)
      }
      case 'follow': {
        const name = args[0] || username
        if (!bot.players[name]) return bot.chat(`no player ${name}`)
        followTarget = name
        clearInterval(followTimer)
        followTimer = setInterval(() => {
          const e = bot.players[followTarget]?.entity
          if (!e) return
          const d = bot.entity.position.distanceTo(e.position)
          if (d > 3) bot.pathfinder.setGoal(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2))
        }, 500)
        return bot.chat(`following ${name}`)
      }
      case 'stop':
        clearInterval(followTimer); followTarget = null
        bot.pathfinder.setGoal(null); bot.clearControlStates()
        return bot.chat('stopped.')
      case 'pos':
        return bot.chat(`I'm at ${fmt(bot.entity.position)}`)
      case 'status':
        return bot.chat(JSON.stringify({
          pos: fmt(bot.entity.position), hp: bot.health, food: bot.food,
          players: Object.keys(bot.players).filter((n) => n !== bot.username),
          time: bot.time.timeOfDay, pathing: !!bot.pathfinder.goal
        }))
      case 'drop':
        return bot.chat('dropping everything, bye~') || setTimeout(() => bot.quit(), 300)
      default:
        return bot.chat(`unknown cmd: ${cmd}`)
    }
  } catch (e) { log('cmd error:', e.message) }
})

// 自检：报位置 -> 走到偏移坐标 -> 校验到达
function runSelftest () {
  const start = bot.entity.position.clone()
  log('SELFTEST start', fmt(start))
  const tx = Math.round(start.x) + 4, tz = Math.round(start.z) + 4
  bot.pathfinder.setGoal(new goals.GoalBlock(tx, Math.round(start.y), tz))
  const t0 = Date.now()
  const iv = setInterval(async () => {
    const p = bot.entity.position
    if (Math.hypot(p.x - tx, p.z - tz) < 1.6) {
      clearInterval(iv)
      log(`SELFTEST OK: reached ${fmt(p)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      log('SELFTEST survival check: hp', bot.health, 'food', bot.food, 'entities', Object.keys(bot.entities).length)
      bot.chat('selftest ok')
      setTimeout(() => { bot.quit(); process.exit(0) }, 1000)
    } else if (Date.now() - t0 > 45000) {
      clearInterval(iv)
      log('SELFTEST FAIL: timeout, at', fmt(bot.entity.position), 'goal', tx, tz, 'err', bot.pathfinder.bestHarvestTool ? '' : '')
      process.exit(2)
    }
  }, 250)
}
