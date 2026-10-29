'use strict'
// sidecar/bot.js —— mineflayer 连接与只读状态快照。
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const config = require('./config')
const log = require('./log')

class BotLink {
  constructor () {
    this.bot = null
    this.mcData = null
    this.movements = null
    this.ready = false
    this.deathCount = 0
    this.lastDeathAt = 0
    this.onChat = null
  }

  async connect () {
    const bot = mineflayer.createBot({
      host: config.mc.host,
      port: config.mc.port,
      username: config.mc.username,
      version: config.mc.version,
      auth: 'offline'
    })
    this.bot = bot
    bot.loadPlugin(pathfinder)
    bot.loadPlugin(require('mineflayer-collectblock').plugin)
    bot.loadPlugin(require('mineflayer-tool').plugin)
    // pvp 必须在 pathfinder 之后加载（坑 3），加载后靠 setMovements 生效
    bot.loadPlugin(require('mineflayer-pvp').plugin)

    bot.on('kicked', (reason) => log.warn('bot_kicked', { reason: safe(reason) }))
    bot.on('error', (err) => log.error('bot_error', { message: err.message }))
    bot.on('end', (reason) => { this.ready = false; log.warn('bot_end', { reason: String(reason) }) })
    bot.on('death', () => {
      this.deathCount += 1
      this.lastDeathAt = Date.now()
      log.warn('bot_death', { pos: fmtPos(bot.entity && bot.entity.position), deaths: this.deathCount })
    })
    bot.on('chat', (username, message) => {
      if (!this.onChat) return
      if (username === bot.username) return
      this.onChat(username, message)
    })

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('spawn timeout')), 60000)
      bot.once('spawn', () => { clearTimeout(timer); resolve() })
      bot.once('error', (err) => { clearTimeout(timer); reject(err) })
    })

    this.mcData = require('minecraft-data')(bot.version)
    this.movements = new Movements(bot, this.mcData)
    this.movements.canDig = true
    this.movements.dontMineUnderFallingBlock = false
    this.movements.dontCreateFlow = false
    bot.pathfinder.setMovements(this.movements)
    this.ready = true
    log.info('bot_spawned', {
      username: bot.username,
      version: bot.version,
      pos: fmtPos(bot.entity.position)
    })
    return bot
  }

  /** 背包 {itemId: count}，只读。 */
  inventoryCounts () {
    const counts = {}
    if (!this.bot || !this.bot.inventory) return counts
    for (const item of this.bot.inventory.items()) {
      counts[item.type] = (counts[item.type] || 0) + item.count
    }
    return counts
  }

  inventorySummary () {
    if (!this.bot || !this.bot.inventory) return []
    const byName = {}
    for (const item of this.bot.inventory.items()) {
      byName[item.name] = (byName[item.name] || 0) + item.count
    }
    return Object.entries(byName).map(([name, count]) => ({ name, count }))
  }

  /** 附近玩家的真实游戏 ID + 坐标（L2 规划「过来/跟着我」要用，别让它猜名字）。 */
  playersNearby (maxDistance = 64) {
    const bot = this.bot
    if (!bot || !bot.entity || !bot.players) return []
    const out = []
    for (const player of Object.values(bot.players)) {
      if (!player || !player.entity || player.username === bot.username) continue
      const p = player.entity.position
      const d = bot.entity.position.distanceTo(p)
      if (d > maxDistance) continue
      out.push({
        name: player.username,
        x: Math.round(p.x),
        y: Math.round(p.y),
        z: Math.round(p.z),
        distance: round(d)
      })
    }
    return out.sort((a, b) => a.distance - b.distance).slice(0, 5)
  }

  pos () {
    const p = this.bot && this.bot.entity && this.bot.entity.position
    return p ? { x: round(p.x), y: round(p.y), z: round(p.z) } : null
  }

  /** 技能执行期的即时状态，由任务执行器写入。 */
  snapshot (runtime) {
    const bot = this.bot
    return {
      bot: this.ready ? 'ready' : 'offline',
      status: runtime.status,
      task: runtime.task || 'none',
      note: runtime.note,
      reply: runtime.reply,
      pos: this.pos(),
      time_of_day: bot && bot.time ? bot.time.timeOfDay : null,
      day: bot && bot.time ? bot.time.day : null,
      health: bot ? bot.health : null,
      food: bot ? bot.food : null,
      pathing: Boolean(bot && bot.pathfinder && bot.pathfinder.goal),
      inventory: this.inventorySummary(),
      players: this.playersNearby(),
      queue: runtime.queue || [],
      current: runtime.current || null,
      deaths: this.deathCount,
      updatedAt: Date.now()
    }
  }

  /** 硬停：清 goal、停采集、停攻击、关容器、复位控制状态。1 秒内必须生效。 */
  hardStop () {
    const bot = this.bot
    if (!bot) return
    try { bot.pathfinder.setGoal(null) } catch (_) { /* noop */ }
    try { bot.pathfinder.stop() } catch (_) { /* noop */ }
    if (bot.collectBlock) {
      try { bot.collectBlock.cancelTask() } catch (_) { /* noop */ }
    }
    if (bot.pvp) {
      try { bot.pvp.forceStop() } catch (_) { /* noop */ }
    }
    if (bot.currentWindow) {
      try { bot.closeWindow(bot.currentWindow) } catch (_) { /* noop */ }
    }
    try { bot.stopDigging() } catch (_) { /* noop */ }
    try { bot.deactivateItem() } catch (_) { /* noop */ }
    try { bot.clearControlStates() } catch (_) { /* noop */ }
  }

  /** 脚下的方块名（脚、头、下方），读不到返回 null。 */
  blocksAroundFeet () {
    const bot = this.bot
    if (!bot || !bot.entity) return {}
    const p = bot.entity.position.floored()
    const at = (dy) => {
      const b = bot.blockAt(p.offset(0, dy, 0))
      return b ? b.name : null
    }
    return { feet: at(0), head: at(1), below: at(-1) }
  }

  say (text) {
    if (!this.bot || !this.ready) return false
    const line = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    if (!line) return false
    this.bot.chat(line)
    return true
  }

  /** 静态定点寻路。注意不能传 dynamic=true：pathfinder 在动态 goal 下不发 goal_reached（坑 18）。 */
  async gotoNear (x, y, z, range) {
    const bot = this.bot
    const goal = new goals.GoalNear(Math.round(x), Math.round(y), Math.round(z), Math.max(0, range || 0))
    bot.pathfinder.setGoal(goal)
  }

  goalReached (timeoutMs, { stallMs = 10000, minMove = 0.4 } = {}) {
    const bot = this.bot
    return new Promise((resolve) => {
      let done = false
      let lastPos = bot.entity ? bot.entity.position.clone() : null
      let lastMoveAt = Date.now()
      const finish = (ok, reason) => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearInterval(watchdog)
        bot.removeListener('goal_reached', onReach)
        bot.removeListener('path_update', onUpdate)
        bot.removeListener('goal_updated', onGoalUpdated)
        bot.removeListener('path_stop', onPathStop)
        resolve({ ok, reason })
      }
      const onReach = () => finish(true, 'goal_reached')
      // 被别的东西改掉 goal（守护逻辑 / 新任务）也算结束，别让技能挂到超时
      const onGoalUpdated = (goal) => { if (!goal) finish(false, 'goal_cleared') }
      // pathfinder 自己 stop() 只发 path_stop，不发 goal_updated（坑 19）
      const onPathStop = () => finish(false, 'path_stopped')
      const onUpdate = (r) => {
        if (r.status === 'noPath') finish(false, 'no_path')
        else if (r.status === 'timeout') finish(false, 'path_timeout')
      }
      // 卡住不动（A* 反复 partial 但从没走过去）也要能失败退出
      const watchdog = setInterval(() => {
        if (!bot.entity) return
        const p = bot.entity.position
        if (!lastPos || p.distanceTo(lastPos) >= minMove) {
          lastPos = p.clone()
          lastMoveAt = Date.now()
        } else if (Date.now() - lastMoveAt >= stallMs) {
          finish(false, 'stalled')
        }
      }, 500)
      const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs)
      bot.on('goal_reached', onReach)
      bot.on('goal_updated', onGoalUpdated)
      bot.on('path_stop', onPathStop)
      bot.on('path_update', onUpdate)
    })
  }
}

function round (n) { return Math.round(n * 10) / 10 }

function fmtPos (p) { return p ? `${round(p.x)} ${round(p.y)} ${round(p.z)}` : 'null' }

function safe (value) {
  try { return JSON.parse(JSON.stringify(value)) } catch (_) { return String(value) }
}

module.exports = { BotLink, fmtPos }
