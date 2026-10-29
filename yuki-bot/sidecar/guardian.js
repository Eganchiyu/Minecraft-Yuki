'use strict'
// sidecar/guardian.js —— 守护逻辑（priority 9，硬编码，不经模型）。
// 触发即抢占当前任务（aborted 上报），并做一次保命动作；同一类事件有冷却，避免刷屏。
const log = require('./log')
const { sleep } = require('./util')

const TICK_MS = 250
const COOLDOWN_MS = 5000
const LOW_HEALTH = 6
const LOW_FOOD = 6
const LAVA_NAMES = new Set(['lava', 'flowing_lava'])
const HOLD_MS = 6000

class Guardian {
  constructor ({ link, runner, emit, eat }) {
    this.link = link
    this.runner = runner
    this.emit = emit || (() => {})
    this.eat = eat // 复用餐技能的吃逻辑，避免两套实现
    this.timer = null
    this.cooldown = {}
    this.lastHurtAt = 0
    this.lastAttacker = null
    this.deathAt = 0
    this.recovering = false
    this.last = null
    this.count = 0
  }

  start () {
    if (this.timer) return
    this.timer = setInterval(() => { this.tick().catch((err) => log.error('guardian_tick_failed', { error: err.message })) }, TICK_MS)
    this.tick().catch(() => {})
    const bot = this.link.bot
    if (bot) {
      bot.on('entityHurt', (entity, source) => {
        if (!bot.entity || entity !== bot.entity) return
        this.lastHurtAt = Date.now()
        this.lastAttacker = source && source.username ? source.username : (source && source.name) || null
      })
      bot.on('death', () => { this.deathAt = Date.now() })
    }
    log.info('guardian_start')
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  status () {
    return { last: this.last, count: this.count, recovering: this.recovering }
  }

  async tick () {
    const link = this.link
    if (!link.ready || !link.bot || !link.bot.entity) return
    if (this.recovering) return
    if (this._cooling('any')) return

    const bot = link.bot
    const now = Date.now()

    if (now - this.deathAt < 3000 && !this._cooling('death')) {
      return this.trigger('death', 10, { pos: link.pos() }, async () => {})
    }

    const blocks = link.blocksAroundFeet()
    if (LAVA_NAMES.has(blocks.feet) || LAVA_NAMES.has(blocks.head)) {
      return this.trigger('lava', 9, { blocks }, () => this.escape())
    }
    if (bot.entity.position.y < -50) {
      return this.trigger('void', 9, { pos: link.pos() }, () => this.escape())
    }
    if (typeof bot.health === 'number' && bot.health <= LOW_HEALTH) {
      return this.trigger('low_health', 9, { health: bot.health }, () => this.survive())
    }
    // 正在主动打怪时不因受击抢占（否则 attack 技能永远打不完）；低血/岩浆仍会触发
    if (now - this.lastHurtAt < 1500 && !this._inCombat()) {
      return this.trigger('hurt', 9, { attacker: this.lastAttacker, health: bot.health }, () => this.survive())
    }
    if (typeof bot.food === 'number' && bot.food <= LOW_FOOD) {
      return this.trigger('hunger', 8, { food: bot.food }, () => this.feed())
    }
  }

  _inCombat () {
    const current = this.runner.current
    if (!current) return false
    const step = current.steps[current.stepIndex]
    return Boolean(step && step.skill === 'attack')
  }

  _cooling (kind) {
    const until = this.cooldown[kind] || 0
    return Date.now() < until
  }

  /** 抢占 + 保命动作 + 上报。 */
  async trigger (kind, severity, detail, action) {
    this.cooldown[kind] = Date.now() + COOLDOWN_MS
    this.cooldown.any = Date.now() + 1000
    this.recovering = true
    this.count += 1
    this.last = { kind, severity, at: Date.now(), detail }
    this.runner.hold(HOLD_MS)

    const preempted = this.runner.cancel(undefined, `guardian:${kind}`)
    log.warn('guardian_trigger', { kind, severity, detail, preempted })
    this.emit({ type: 'emergency', kind, severity, detail, preempted: preempted.cancelled ? preempted.intention_id : null })

    try {
      await action()
    } catch (err) {
      log.error('guardian_action_failed', { kind, error: err.message })
    } finally {
      this.runner.releaseHold()
      this.recovering = false
    }
  }

  /** 岩浆/虚空：找最近的落脚点跑过去；找不到就原地跳（岩浆里跳能上浮）。 */
  async escape () {
    const bot = this.link.bot
    if (!bot || !bot.entity) return
    this.link.hardStop()
    const from = bot.entity.position.floored()
    const spot = findSafeSpot(bot, from, 10)
    if (spot) {
      await this.link.gotoNear(spot.x, spot.y, spot.z, 0)
      const result = await this.link.goalReached(5000)
      log.info('guardian_escape', { to: spot, reached: result.ok, reason: result.reason })
    } else {
      bot.setControlState('jump', true)
      await sleep(2000)
      bot.clearControlStates()
      log.warn('guardian_escape_no_spot')
    }
    this.link.hardStop()
  }

  /** 濒死/受击：先吃一口，再从最近的敌对生物身边退开。 */
  async survive () {
    await this.feed()
    const bot = this.link.bot
    const threat = nearestHostile(bot, this.link.mcData, 10)
    if (!threat) return
    const me = bot.entity.position
    const away = me.plus(me.minus(threat.position).normalize().scaled(8))
    const spot = findSafeSpot(bot, away.floored(), 6) || away.floored()
    await this.link.gotoNear(spot.x, spot.y, spot.z, 1)
    await this.link.goalReached(4000)
    this.link.hardStop()
  }

  async feed () {
    if (typeof this.eat !== 'function') return
    const result = await this.eat(this.link)
    log.info('guardian_feed', result)
  }
}

function nearestHostile (bot, mcData, maxDistance) {
  if (!bot) return null
  return bot.nearestEntity((entity) => {
    if (entity === bot.entity) return false
    const def = mcData.entitiesByName[entity.name]
    if (!def || def.category !== 'Hostile mobs') return false
    return bot.entity.position.distanceTo(entity.position) <= maxDistance
  })
}

/** 找一个「脚下实心、身上两格空、附近没有岩浆」的位置。 */
function findSafeSpot (bot, from, radius) {
  for (let r = 1; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        const base = from.offset(dx, 0, dz)
        for (let dy = -2; dy <= 2; dy++) {
          const feet = base.offset(0, dy, 0)
          const below = bot.blockAt(feet.offset(0, -1, 0))
          const f = bot.blockAt(feet)
          const h = bot.blockAt(feet.offset(0, 1, 0))
          if (!below || !f || !h) continue
          if (below.boundingBox !== 'block') continue
          if (f.boundingBox !== 'empty' || h.boundingBox !== 'empty') continue
          if (LAVA_NAMES.has(below.name) || LAVA_NAMES.has(f.name)) continue
          return { x: feet.x, y: feet.y, z: feet.z }
        }
      }
    }
  }
  return null
}

module.exports = { Guardian, findSafeSpot, nearestHostile }
