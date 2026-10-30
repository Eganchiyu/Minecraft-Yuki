'use strict'
// sidecar/guardian.js —— 脊髓反射：一直跑的状态机，不经 L2，也不等 L1。
//
// 和「技能」的分工：技能是 L2 派的活，会占用身体、有开始和结束；反射是**身体自己的事**——
// 脚下是岩浆、被怪贴脸、血快没了，这些不能等模型想清楚。所以反射一旦进来就抢占当前任务
// （`runner.cancel`），做完把状态转移报上去，L1 才知道刚才发生了什么。
//
// 四个状态：
//   idle   没事，等
//   defend 打最近的敌对生物（走 mineflayer-pvp：追击、走位、举盾）
//   flee   跑开（岩浆、虚空、血少、打不过）
//   recover 吃回来
//
// 判据（改这里就是改她的性格）：
//   苦力怕 → 永远不打，跑（会炸）
//   敌对超过 MAX_TARGETS 只 → 跑
//   血 ≤ FLEE_HEALTH → 跑
//   血 < DEFEND_MIN_HEALTH 或手上没有武器 → 跑
//   其余 → 打
const log = require('./log')
const { sleep } = require('./util')
const { fallInfo, shouldMlg, mlgRescue, WATER_BUCKET } = require('./mlg')

const TICK_MS = 250
const COOLDOWN_MS = 5000
const FLEE_HEALTH = 6 // 到这里一定跑（和原先的 LOW_HEALTH 一致）
const DEFEND_MIN_HEALTH = 10 // 低于这个不打
const LOW_FOOD = 6
const FLEE_FOOD = 18 // 回血要吃到这个数（原版饥饿值≥18才会自然回血）
const LAVA_NAMES = new Set(['lava', 'flowing_lava'])
const SCAN_RADIUS = 10
const MAX_TARGETS = 2
const FIGHT_TIMEOUT_MS = 45000
const EPISODE_HOLD_MS = 6000
const NEVER_MELEE = new Set(['creeper'])

const STATE = { IDLE: 'idle', DEFEND: 'defend', FLEE: 'flee', RECOVER: 'recover', MLG: 'mlg' }

// 摔下来的时候先看这个，比什么都急
const MLG_TRIGGER_DISTANCE = 3.5
const NO_BUCKET_WARN_MS = 15000

class Guardian {
  constructor ({ link, runner, emit, eat }) {
    this.link = link
    this.runner = runner
    this.emit = emit || (() => {})
    this.eat = eat // 复用餐技能的吃逻辑，避免两套实现

    this.timer = null
    this.state = STATE.IDLE
    this.target = null
    this.enteredAt = 0
    this.reason = ''
    this.holdUntil = 0

    this.cooldown = {}
    this.lastHurtAt = 0
    this.lastAttacker = null
    this.deathAt = 0
    this.busy = false
    this.last = null
    this.count = 0
    this.episodes = { defend: 0, flee: 0, recover: 0 }
    this.kills = 0
  }

  start () {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.error('reflex_tick_failed', { error: err.message }))
    }, TICK_MS)
    this.tick().catch(() => {})

    const bot = this.link.bot
    if (bot) {
      bot.on('entityHurt', (entity, source) => {
        if (!bot.entity || entity !== bot.entity) return
        this.lastHurtAt = Date.now()
        this.lastAttacker = source && source.username ? source.username : (source && source.name) || null
      })
      bot.on('death', () => {
        this.deathAt = Date.now()
        // 死了先回 idle，等复活后重新判断
        this.state = STATE.IDLE
        this.target = null
      })
      // 只认「目标真的死了」，别用 stoppedAttacking——我们主动收手时它也会发
      bot.on('entityDead', (entity) => {
        if (this.target && entity && entity.id === this.target.id) this.kills += 1
      })
    }
    log.info('reflex_start')
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  status () {
    return {
      state: this.state,
      target: this.target ? this.target.name : null,
      reason: this.reason,
      since: this.enteredAt,
      last: this.last,
      count: this.count,
      episodes: this.episodes,
      kills: this.kills
    }
  }

  _cooling (kind) {
    return Date.now() < (this.cooldown[kind] || 0)
  }

  /** 状态转移：唯一出口。每次转移都上报一次，L1 靠它知道身体自己干了什么。 */
  _enter (next, reason, detail = {}) {
    if (this.state === next) return false
    const from = this.state
    this.state = next
    this.reason = reason
    this.enteredAt = Date.now()
    this.count += 1
    this.last = { from, to: next, reason, at: this.enteredAt, detail }
    if (this.episodes[next] !== undefined) this.episodes[next] += 1

    // 只有「跑」值得当场叫醒她；开打和收工用知会档，别每次打架都打断她说话
    const severity = (next === STATE.FLEE || next === STATE.MLG) ? 8 : next === STATE.DEFEND ? 5 : 3
    log.info('reflex_transition', { from, to: next, reason, detail })
    this.emit({ type: 'reflex', from, to: next, reason, detail, severity, kills: this.kills })
    return true
  }

  async tick () {
    const link = this.link
    if (!link.ready || !link.bot || !link.bot.entity) return
    if (this.busy) return

    const bot = link.bot
    const now = Date.now()

    // ---- 坠落：比岩浆还急，先算这一帧掉多快 ----
    if (this.state !== STATE.MLG && !this.busy) {
      const fall = fallInfo(bot)
      const hasBucket = countOf(bot, WATER_BUCKET) > 0
      const call = shouldMlg({ falling: fall.falling, dist: fall.dist, hasBucket, triggerDistance: MLG_TRIGGER_DISTANCE })
      if (call.fire) {
        return this._episode(STATE.MLG, 'falling', {
          dist: Math.round(fall.dist * 100) / 100, vy: Math.round(fall.vy * 100) / 100
        }, () => this.mlg(fall))
      }
      // 会摔死但没有水桶：说一次就够，别每 250ms 喊一遍
      if (fall.falling && fall.dist !== null && fall.dist <= MLG_TRIGGER_DISTANCE && !hasBucket &&
          now - (this.lastNoBucketAt || 0) > NO_BUCKET_WARN_MS) {
        this.lastNoBucketAt = now
        log.warn('reflex_fall_no_bucket', { dist: Math.round(fall.dist), vy: Math.round(fall.vy) })
      }
    }

    // ---- 致命：无论什么状态都要先处理 ----
    const blocks = link.blocksAroundFeet()
    if (LAVA_NAMES.has(blocks.feet) || LAVA_NAMES.has(blocks.head)) {
      return this._episode(STATE.FLEE, 'lava', { blocks }, () => this.escape())
    }
    if (bot.entity.position.y < -50) {
      return this._episode(STATE.FLEE, 'void', { pos: link.pos() }, () => this.escape())
    }
    if (now - this.deathAt < 3000 && !this._cooling('death')) {
      this.cooldown.death = now + COOLDOWN_MS
      return this._episode(STATE.FLEE, 'death', { pos: link.pos() }, async () => {})
    }

    // ---- 血太少：中断任何事，回血 ----
    if (typeof bot.health === 'number' && bot.health <= FLEE_HEALTH && !this._cooling('low_health')) {
      this.cooldown.low_health = now + COOLDOWN_MS
      await this._leaveDefend('low_health')
      const threat = nearestHostile(bot, link.mcData, SCAN_RADIUS)
      return this._episode(STATE.FLEE, 'low_health', { health: bot.health, attacker: this.lastAttacker },
        () => this.survive(threat))
    }

    // ---- 战斗状态：每刻看一眼要不要继续 ----
    if (this.state === STATE.DEFEND) return this._tickDefend()

    // ---- 没事的时候才看周围有没有怪 ----
    if (this.state === STATE.IDLE) {
      const threats = hostilesNear(bot, link.mcData, SCAN_RADIUS)
      // 正在执行 L2 派的 attack 时不抢：那一步本来就在打，抢了只会把任务白废掉。
      // 血少/岩浆那种致命判断在上面，不受这条限制。
      if (threats.length && !this._inCombat()) {
        const hurt = now - this.lastHurtAt < 2000
        return this._decide(threats, hurt ? 'hurt' : 'threat_nearby')
      }
      if (typeof bot.food === 'number' && bot.food <= LOW_FOOD && !this._cooling('hunger')) {
        this.cooldown.hunger = now + COOLDOWN_MS
        return this._episode(STATE.RECOVER, 'hunger', { food: bot.food }, () => this.feed())
      }
    }
  }

  /** 当前 L2 派的那一步是不是 attack：是的话反射别抢。 */
  _inCombat () {
    const current = this.runner.current
    if (!current || !Array.isArray(current.steps)) return false
    const step = current.steps[current.stepIndex]
    return Boolean(step && step.skill === 'attack')
  }

  /** 一次性的反射动作（岩浆/虚空/濒死/饥饿）：抢占任务 → 做 → 回 idle。 */
  async _episode (state, reason, detail, action) {
    this.busy = true
    this._enter(state, reason, detail)
    this._hold()
    const preempted = this.runner.cancel(undefined, `reflex:${reason}`)
    if (preempted && preempted.cancelled) {
      log.warn('reflex_preempted', { reason, intention_id: preempted.intention_id })
      this.emit({ type: 'reflex_preempt', reason, intention_id: preempted.intention_id, severity: 7 })
    }
    try {
      await action()
    } catch (err) {
      log.error('reflex_action_failed', { reason, error: err.message })
    } finally {
      this.busy = false
      this._enter(STATE.IDLE, `${reason}_done`)
      this._release()
    }
  }

  // ================= 打 =================
  _decide (threats, reason) {
    const bot = this.link.bot
    const health = typeof bot.health === 'number' ? bot.health : 20
    const hasWeapon = this._equipWeapon() || Boolean(bot.heldItem && /_(sword|axe)$/.test(bot.heldItem.name))
    const call = chooseReaction({ threats, health, hasWeapon })
    log.info('reflex_choose', { ...call, threats: threats.length, health, hasWeapon })

    if (call.action === 'defend') {
      return this._startDefend(threats[0], reason, { threats: threats.length, health })
    }
    return this._episode(STATE.FLEE, `flee_${call.why}`, {
      threats: threats.map((t) => t.name), health, hasWeapon
    }, () => this.survive(threats[0]))
  }

  async _startDefend (target, reason, detail) {
    this.busy = true
    const preempted = this.runner.cancel(undefined, 'reflex:defend')
    if (preempted && preempted.cancelled) {
      this.emit({ type: 'reflex_preempt', reason: 'defend', intention_id: preempted.intention_id, severity: 7 })
    }
    this.target = target
    this._episodeStartKills = this.kills
    this._enter(STATE.DEFEND, reason, { ...detail, target: target.name })
    this._hold(FIGHT_TIMEOUT_MS)

    const bot = this.link.bot
    try {
      if (bot.pvp) await bot.pvp.attack(target)
      else await this._fallbackAttack(target)
    } catch (err) {
      log.warn('reflex_attack_failed', { error: err.message })
      this.busy = false
      return this._leaveDefend('attack_failed')
    }
    this.busy = false
  }

  async _tickDefend () {
    const bot = this.link.bot
    const now = Date.now()
    const target = this.target

    // 打太久或者目标没了
    const gone = !target || target.isValid === false || (target.position === undefined)
    if (gone) {
      return this._leaveDefend('target_gone')
    }
    const dist = bot.entity.position.distanceTo(target.position)
    if (now - this.enteredAt > FIGHT_TIMEOUT_MS || dist > 32) {
      return this._leaveDefend(dist > 32 ? 'target_escaped' : 'timeout')
    }
    // 血掉下来了：不打了，跑
    if (typeof bot.health === 'number' && bot.health <= FLEE_HEALTH) {
      return this._leaveDefend('low_health')
    }
    // 打的过程中又来了苦力怕：立刻跑
    const creeper = hostilesNear(bot, this.link.mcData, 6).find((t) => NEVER_MELEE.has(t.name))
    if (creeper) {
      return this._leaveDefend('creeper_in_fight')
    }
    // 打的时候顺手吃一口（原版饥饿值≥18 才回血）
    if (!this.busy && typeof bot.food === 'number' && bot.food <= FLEE_FOOD && !this._cooling('eat_in_fight')) {
      this.cooldown.eat_in_fight = now + 8000
      this.busy = true
      try { await this.feed() } finally { this.busy = false }
    }
  }

  /** 结束战斗：停 pvp、清目标、按情况转 recover 或 idle。 */
  async _leaveDefend (reason) {
    const bot = this.link.bot
    const killed = this.kills - (this._episodeStartKills || 0)
    this.target = null
    if (bot && bot.pvp) {
      try { await bot.pvp.stop() } catch (_) { /* noop */ }
    }

    // 收手时统一报一次「这一轮打成什么样」，L1 靠它说"刚把僵尸打跑了"；
    // 不管是打完了、被跑掉了、还是不得不撤，都要报。
    this.emit({
      type: 'reflex_over',
      reason,
      killed,
      health: bot && typeof bot.health === 'number' ? bot.health : null,
      severity: 4
    })

    if (reason === 'low_health' || reason === 'creeper_in_fight') {
      // 打不下去：接着走逃跑那一套（它自己会吃完再退开）
      const threat = nearestHostile(bot, this.link.mcData, SCAN_RADIUS)
      return this._episode(STATE.FLEE, `flee_${reason}`, { health: bot.health }, () => this.survive(threat))
    }
    // 打完/跑完都吃一口，再回 idle
    this.busy = true
    this._enter(STATE.RECOVER, `recover_${reason}`)
    try {
      if (typeof bot.food === 'number' && bot.food < FLEE_FOOD) await this.feed()
    } finally {
      this.busy = false
      this._enter(STATE.IDLE, `${reason}_done`)
      this._release()
    }
  }

  /** pvp 插件不在时的兜底：追着打（简单版，不如插件灵活）。 */
  async _fallbackAttack (target) {
    const bot = this.link.bot
    while (this.state === STATE.DEFEND && target && target.isValid !== false) {
      if (bot.entity.position.distanceTo(target.position) > 2.5) {
        try { await bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals).GoalFollow(target, 1)) } catch (_) { /* noop */ }
      } else {
        bot.attack(target)
        await sleep(600)
      }
    }
  }

  /** 手上要有一把近战武器；没有就从背包换一把上来。返回有没有。 */
  _equipWeapon () {
    const bot = this.link.bot
    if (!bot) return false
    const isWeapon = (item) => Boolean(item && /_(sword|axe)$/.test(item.name))
    if (isWeapon(bot.heldItem)) return true
    const weapon = bot.inventory.items().find(isWeapon)
    if (!weapon) return false
    bot.equip(weapon, 'hand').catch(() => {})
    return true
  }

  // ================= 摔 =================
  /** 落地自救：放水 → 落进去 → 把桶收回来。 */
  async mlg (fall) {
    const bot = this.link.bot
    if (!bot) return
    this.link.hardStop() // 先松开键盘，别在坠落时还按着前进
    const result = await mlgRescue(bot, fall)
    log.info('reflex_mlg', result.detail)
    this.emit({ type: 'reflex_mlg', ...result.detail, severity: result.ok ? 4 : 7 })
    this.link.hardStop()
  }

  // ================= 跑 / 吃 =================
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
      log.info('reflex_escape', { to: spot, reached: result.ok, reason: result.reason })
    } else {
      bot.setControlState('jump', true)
      await sleep(2000)
      bot.clearControlStates()
      log.warn('reflex_escape_no_spot')
    }
    this.link.hardStop()
  }

  /** 濒死/打不过：先吃一口，再从威胁身边退开。 */
  async survive (threat) {
    await this.feed()
    const bot = this.link.bot
    if (!bot || !bot.entity) return
    const source = threat || nearestHostile(bot, this.link.mcData, SCAN_RADIUS)
    if (!source) return
    const me = bot.entity.position
    const away = me.plus(me.minus(source.position).normalize().scaled(8))
    const spot = findSafeSpot(bot, away.floored(), 6) || away.floored()
    await this.link.gotoNear(spot.x, spot.y, spot.z, 1)
    await this.link.goalReached(4000)
    this.link.hardStop()
  }

  async feed () {
    if (typeof this.eat !== 'function') return
    const result = await this.eat(this.link)
    log.info('reflex_feed', result)
  }

  // ---- 占位：战斗期间不让 L2 派新活，但也不无限期占着 ----
  _hold (ms = EPISODE_HOLD_MS) {
    const hold = Math.max(EPISODE_HOLD_MS, Math.min(ms, FIGHT_TIMEOUT_MS))
    this.holdUntil = Date.now() + hold
    this.runner.hold(hold)
  }

  _release () {
    this.holdUntil = 0
    this.runner.releaseHold()
  }
}

/**
 * 打还是跑——这条判据就是她的脾气，改这里就是改性格。
 * 不传对象、不看世界，纯算术，好测。
 */
function chooseReaction ({ threats, health, hasWeapon }) {
  const list = threats || []
  if (!list.length) return { action: 'idle' }
  const names = list.map((t) => (t && t.name) || '')
  if (names.some((n) => NEVER_MELEE.has(n))) return { action: 'flee', why: 'creeper' }
  if (list.length > MAX_TARGETS) return { action: 'flee', why: 'too_many' }
  if (health <= FLEE_HEALTH) return { action: 'flee', why: 'low_health' }
  // 空手也能打，但只在满血且只有一个的时候；否则成群或带伤就是送
  if (!hasWeapon && (health < 16 || list.length > 1)) return { action: 'flee', why: 'no_weapon' }
  if (health < DEFEND_MIN_HEALTH) return { action: 'flee', why: 'weak' }
  return { action: 'defend' }
}

function countOf (bot, name) {
  if (!bot || !bot.inventory) return 0
  return bot.inventory.items().filter((it) => it.name === name).reduce((sum, it) => sum + it.count, 0)
}

function isHostile (entity, mcData, self) {
  if (!entity || entity === self || !entity.position) return false
  const def = mcData.entitiesByName[entity.name]
  return Boolean(def && def.category === 'Hostile mobs')
}

function hostilesNear (bot, mcData, maxDistance) {
  if (!bot || !bot.entity) return []
  const out = []
  for (const entity of Object.values(bot.entities)) {
    if (!isHostile(entity, mcData, bot.entity)) continue
    if (bot.entity.position.distanceTo(entity.position) <= maxDistance) out.push(entity)
  }
  out.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  return out
}

function nearestHostile (bot, mcData, maxDistance) {
  return hostilesNear(bot, mcData, maxDistance)[0] || null
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

module.exports = { Guardian, STATE, chooseReaction, findSafeSpot, nearestHostile, hostilesNear, isHostile, MLG_TRIGGER_DISTANCE }
