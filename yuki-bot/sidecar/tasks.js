'use strict'
// sidecar/tasks.js —— 顺序执行步骤 + 抢占/排队 + 取消 + 守护逻辑暂停。所有状态变更都发事件。
const crypto = require('crypto')
const config = require('./config')
const log = require('./log')
const { getSkill, SKILL_NAMES } = require('./skills')

class TaskRunner {
  constructor ({ link, emit, onFinish }) {
    this.link = link
    this.emit = emit || (() => {})
    this.onFinish = onFinish || (async () => {})
    this.current = null
    this.queue = []
    this.status = 'idle'
    this.taskBrief = null
    this.note = ''
    this.reply = 'no_reply'
    this._abort = null
    // 守护逻辑运行期间冻结队列，避免保命动作被排队的任务立刻覆盖
    this.holdUntil = 0
    this._holdTimer = null
  }

  // ---------- 对外：接收意图 ----------
  submit (payload) {
    const check = validateIntention(payload)
    if (!check.ok) return { accepted: false, status: 400, error: check.error }

    const intention = {
      intention_id: payload.intention_id || crypto.randomUUID(),
      priority: check.priority,
      origin: payload.origin || 'user',
      steps: check.steps,
      summary_text: payload.summary_text || '',
      created_at: Date.now()
    }

    if (this.current) {
      if (intention.priority >= this.current.priority) {
        const preempted = this.current.intention_id
        this.cancel(preempted, 'preempted')
        // 等当前任务走完 finalize 再启动，避免两条 _run 同时改状态
        this.queue.unshift(intention)
        this.emit({ type: 'preempt', intention_id: preempted, by: intention.intention_id })
        return { accepted: true, intention_id: intention.intention_id, queued: true, preempting: true }
      }
      if (!this._enqueue(intention)) return { accepted: false, status: 429, error: 'queue_full' }
      return { accepted: true, intention_id: intention.intention_id, queued: true, depth: this.queue.length }
    }

    if (Date.now() < this.holdUntil) {
      if (!this._enqueue(intention)) return { accepted: false, status: 429, error: 'queue_full' }
      return { accepted: true, intention_id: intention.intention_id, queued: true, depth: this.queue.length, held: true }
    }

    this._start(intention)
    return { accepted: true, intention_id: intention.intention_id, queued: false }
  }

  _enqueue (intention) {
    if (this.queue.length >= config.limits.queueLimit) return false
    this.queue.push(intention)
    this.emit({ type: 'queued', intention_id: intention.intention_id, depth: this.queue.length })
    return true
  }

  /** 守护逻辑用：冻结队列一段时间（毫秒）。 */
  hold (ms) {
    this.holdUntil = Math.max(this.holdUntil, Date.now() + ms)
    log.info('runner_hold', { until: this.holdUntil, ms })
  }

  releaseHold () {
    this.holdUntil = 0
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null }
    this._drain()
  }

  cancel (intentionId, reason = 'cancelled') {
    if (this.current && (!intentionId || this.current.intention_id === intentionId)) {
      this.current.cancelReason = reason
      if (this._abort) this._abort.abort()
      this.link.hardStop()
      return { cancelled: true, intention_id: this.current.intention_id, reason }
    }
    const idx = this.queue.findIndex((item) => item.intention_id === intentionId)
    if (idx >= 0) {
      const [dropped] = this.queue.splice(idx, 1)
      this.emit({ type: 'task_done', intention_id: dropped.intention_id, status: 'aborted', reason: 'cancelled_in_queue' })
      return { cancelled: true, intention_id: dropped.intention_id, reason: 'cancelled_in_queue' }
    }
    return { cancelled: false, reason: 'not_found' }
  }

  snapshot () {
    return {
      status: this.current ? this.status : 'idle',
      task: this.current ? this.taskBrief : 'none',
      note: this.note,
      reply: this.reply,
      current: this.current
        ? { intention_id: this.current.intention_id, step: this.current.stepIndex, steps: this.current.steps.length, brief: this.taskBrief }
        : null,
      queue: this.queue.map((item) => item.intention_id),
      held: Date.now() < this.holdUntil
    }
  }

  // ---------- 内部：执行 ----------
  _start (intention) {
    this.current = { ...intention, stepIndex: -1, cancelReason: '' }
    this.queue = this.queue.filter((item) => item.intention_id !== intention.intention_id)
    this.status = 'working'
    this.taskBrief = briefOf(intention.steps)
    this.reply = 'no_reply'
    this._abort = new AbortController()
    log.info('task_start', { intention_id: intention.intention_id, priority: intention.priority, steps: intention.steps.length })
    this.emit({ type: 'task_start', intention_id: intention.intention_id, priority: intention.priority, steps: intention.steps })

    const running = this.current
    const signal = this._abort.signal
    this._run(running, signal)
      .catch((err) => {
        log.error('task_crashed', { intention_id: intention.intention_id, error: err.message })
        return { status: 'failed', summary: '执行时出了点问题', detail: { error: err.message } }
      })
      .then((result) => this._finalize(running, result))
  }

  async _run (intention, signal) {
    const results = []
    // P2 单任务时间预算：一条委托的总时长上限，超了就整条判失败，别让技能拖成无底洞。
    // 例外：开放跟随（follow 不给 seconds）本来就是持续动作，不套整条委托超时。
    const openFollow = intention.steps.some((step) => step.skill === 'follow' &&
      (step.args === undefined || step.args.seconds === undefined || step.args.seconds === null))
    const deadline = openFollow ? Infinity : Date.now() + config.limits.taskTimeoutMs
    for (let i = 0; i < intention.steps.length; i++) {
      if (signal.aborted) return { status: 'aborted', summary: '被叫停了', detail: { results } }
      if (Date.now() >= deadline) {
        return { status: 'failed', summary: '这件事太久了，先停下', detail: { results, error: 'task_timeout', failed_step: intention.steps[i].skill } }
      }
      const step = intention.steps[i]
      intention.stepIndex = i
      this.taskBrief = `${step.skill} ${i + 1}/${intention.steps.length}`
      this.reply = 'no_reply'
      const skill = getSkill(step.skill)
      const started = Date.now()
      const remainingMs = Math.max(1000, deadline - Date.now())
      this.emit({ type: 'step_start', intention_id: intention.intention_id, index: i, skill: step.skill, args: step.args })
      log.info('step_start', { intention_id: intention.intention_id, index: i, skill: step.skill, args: step.args })

      let outcome = null
      let attempt = 0
      while (attempt <= config.limits.retryPerStep) {
        outcome = await this._runStep(skill, step, intention, signal, remainingMs)
        if (outcome.ok || signal.aborted) break
        // 确定性失败（缺工具/没目标/没材料）重试没用，立刻把事实交回 L2，别浪费预算
        if (NON_RETRYABLE.has(outcome.detail && outcome.detail.error)) break
        attempt += 1
        if (attempt <= config.limits.retryPerStep) {
          this.emit({ type: 'step_retry', intention_id: intention.intention_id, index: i, attempt })
          log.warn('step_retry', { index: i, attempt, detail: outcome.detail })
        }
      }

      const elapsedMs = Date.now() - started
      log.info('step_done', { index: i, skill: step.skill, ok: outcome.ok, elapsed_ms: elapsedMs, detail: outcome.detail })
      this.emit({ type: 'step_done', intention_id: intention.intention_id, index: i, skill: step.skill, ok: outcome.ok, elapsed_ms: elapsedMs, detail: outcome.detail })
      results.push({ skill: step.skill, args: step.args, ok: outcome.ok, detail: outcome.detail })

      if (signal.aborted) return { status: 'aborted', summary: '被叫停了', detail: { results } }
      if (!outcome.ok) {
        if (step.on_fail === 'skip') continue
        return { status: 'failed', summary: summarize(results, intention.steps), detail: { results, failed_step: step.skill } }
      }
    }
    return { status: 'done', summary: summarize(results, intention.steps), detail: { results } }
  }

  async _runStep (skill, step, intention, signal, timeoutMs) {
    if (!skill) return { ok: false, detail: { error: 'unknown_skill', skill: step.skill } }
    const ctx = {
      link: this.link,
      signal,
      timeoutMs: Math.min(config.limits.stepTimeoutMs, timeoutMs || config.limits.stepTimeoutMs),
      progress: (done, total) => {
        this.taskBrief = `${step.skill} ${done}/${total}`
        this.emit({ type: 'progress', intention_id: intention.intention_id, skill: step.skill, done, total })
      }
    }
    const abortPromise = new Promise((resolve) => {
      if (signal.aborted) return resolve({ ok: false, detail: { error: 'cancelled' } })
      signal.addEventListener('abort', () => resolve({ ok: false, detail: { error: 'cancelled', aborted: true } }), { once: true })
    })
    try {
      const runPromise = skill.run(step.args || {}, ctx)
      return await Promise.race([runPromise, abortPromise])
    } catch (err) {
      return { ok: false, detail: { error: 'skill_threw', message: err.message, name: err.name } }
    }
  }

  async _finalize (intention, result) {
    const cancelled = intention.cancelReason
    const status = cancelled ? 'aborted' : result.status
    const summary = cancelled ? cancelSummary(cancelled) || result.summary : result.summary
    this.status = 'idle'
    this.taskBrief = null
    this.note = ''
    this.reply = 'need'
    this.current = null
    this._abort = null
    log.info('task_done', { intention_id: intention.intention_id, status, summary })
    this.emit({ type: 'task_done', intention_id: intention.intention_id, status, summary, reason: cancelled || undefined, detail: result.detail })

    // 先放行排队任务，再等回话回调（回调可能走网络，不能拖住下一条）
    this._drain()

    try {
      await this.onFinish({ intention, status, summary, detail: result.detail })
    } catch (err) {
      log.error('task_callback_failed', { intention_id: intention.intention_id, error: err.message })
    }
  }

  _drain () {
    if (this.current) return
    const wait = this.holdUntil - Date.now()
    if (wait > 0) {
      if (!this._holdTimer) {
        this._holdTimer = setTimeout(() => { this._holdTimer = null; this._drain() }, wait + 20)
      }
      return
    }
    const next = this.queue.shift()
    if (next) this._start(next)
  }
}

// 这些错误重试同一组参数必然同样失败，直接结束该步，交给 L2 重规划
const NON_RETRYABLE = new Set([
  'missing_tool', 'missing_material', 'need_workbench', 'no_target_block',
  'unknown_block', 'unknown_item', 'no_container', 'cannot_reach_container',
  'item_not_in_inventory', 'not_hungry', 'no_food_item', 'invalid_coords',
  'unknown_entity', 'no_target_in_range', 'no_place_spot', 'not_a_block',
  'missing_block', 'missing_item', 'missing_player', 'player_not_visible'
])

function cancelSummary (reason) {
  const map = {
    'guardian:lava': '脚下是岩浆，先逃命',
    'guardian:void': '掉进虚空了，先保命',
    'guardian:low_health': '血太少了，先撤',
    'guardian:hurt': '被打到了，先躲一下',
    'guardian:hunger': '饿了，先吃点东西',
    'guardian:death': '死掉了',
    preempted: '被新任务顶掉了'
  }
  return map[reason] || '被叫停了'
}

function validateIntention (payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid_body' }
  const steps = payload.steps
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, error: 'empty_steps' }
  if (steps.length > config.limits.maxSteps) return { ok: false, error: 'too_many_steps' }
  for (const [i, step] of steps.entries()) {
    if (!step || typeof step !== 'object') return { ok: false, error: `step_${i}_invalid` }
    if (!SKILL_NAMES.includes(step.skill)) return { ok: false, error: `step_${i}_unknown_skill` }
    if (step.args !== undefined && (typeof step.args !== 'object' || step.args === null)) {
      return { ok: false, error: `step_${i}_bad_args` }
    }
    if (step.on_fail !== undefined && !['retry', 'abort', 'skip'].includes(step.on_fail)) {
      return { ok: false, error: `step_${i}_bad_on_fail` }
    }
  }
  let priority = Number.parseInt(payload.priority, 10)
  if (Number.isNaN(priority)) priority = 5
  if (priority < 0 || priority > 8) return { ok: false, error: 'priority_out_of_range' }
  return { ok: true, steps, priority }
}

function briefOf (steps) {
  return steps.map((step) => step.skill).join('>')
}

/** 把执行结果压成一句事实（人话），交给 L1 重写成她的语气。 */
function summarize (results, steps) {
  const parts = []
  for (const [i, result] of results.entries()) {
    const step = steps[i] || {}
    const detail = result.detail || {}
    if (result.skill === 'mine' && result.ok) {
      parts.push(`挖到了 ${detail.mined} 块${blockLabel(detail.block)}`)
    } else if (result.skill === 'mine') {
      if (detail.error === 'missing_tool') parts.push(`没有能挖${blockLabel(step.args && step.args.block)}的工具`)
      else parts.push(`只挖到 ${detail.mined || 0} 块${blockLabel(step.args && step.args.block) || '东西'}，没凑够`)
    } else if (result.skill === 'goto' && result.ok) {
      parts.push('走到了目的地')
    } else if (result.skill === 'goto') {
      parts.push('没走到目的地')
    } else if (result.skill === 'follow' && result.ok) {
      parts.push('跟住了')
    } else if (result.skill === 'follow') {
      parts.push('跟丢了')
    } else if (result.skill === 'craft' && result.ok) {
      parts.push(`合成了 ${detail.crafted} 个${itemLabel(detail.item)}`)
    } else if (result.skill === 'craft') {
      parts.push(detail.error === 'need_workbench' ? `${itemLabel(detail.item)}要工作台才能做` : `没合成出${itemLabel(detail.item)}`)
    } else if (result.skill === 'open' && result.ok) {
      const box = detail.container || {}
      const items = (box.contents || []).slice(0, 4).map((it) => `${it.name}×${it.count}`).join('、')
      parts.push(`打开了${box.kind || '容器'}${detail.took ? `，取出 ${Object.entries(detail.took).map(([k, v]) => `${k}×${v}`).join('、')}` : ''}${items ? `，里面有：${items}` : '，里面是空的'}`)
    } else if (result.skill === 'open') {
      parts.push(detail.error === 'no_container' ? '附近找不到能打开的箱子' : '箱子没打开')
    } else if (result.skill === 'deposit' && result.ok) {
      parts.push(`往箱子里存了 ${detail.deposited} 个东西`)
    } else if (result.skill === 'deposit') {
      parts.push(detail.error === 'no_container' ? '没找到箱子' : '东西没存进去')
    } else if (result.skill === 'attack' && result.ok) {
      parts.push(`打掉了 ${detail.killed} 只${entityLabel(detail.last_target)}`)
    } else if (result.skill === 'attack') {
      parts.push(detail.error === 'no_target_in_range' ? '附近没找到能打的' : '没打过')
    } else if (result.skill === 'eat' && result.ok) {
      parts.push(`吃了${itemLabel(detail.item)}，饱了`)
    } else if (result.skill === 'eat') {
      parts.push(detail.error === 'food_not_found' || detail.error === 'no_food_item' ? '没吃的了' : '吃不下')
    } else if (result.skill === 'equip' && result.ok) {
      parts.push(`换上了${itemLabel(detail.item)}`)
    } else if (result.skill === 'equip') {
      parts.push(`没换成${itemLabel(step.args && step.args.item)}`)
    } else if (result.skill === 'place' && result.ok) {
      parts.push(`把${itemLabel(detail.item)}放好了`)
    } else if (result.skill === 'place') {
      parts.push(`没能放下${itemLabel(step.args && step.args.item)}`)
    } else if (result.skill === 'drop' && result.ok) {
      parts.push(detail.player ? `把 ${detail.dropped} 个${itemLabel(detail.item)}丢给了对方` : `丢掉了 ${detail.dropped} 个${itemLabel(detail.item)}`)
    } else if (result.skill === 'drop') {
      parts.push(detail.error === 'item_not_in_inventory' ? `身上没有${itemLabel(step.args && step.args.item)}` : `没丢出去${itemLabel(step.args && step.args.item)}`)
    } else if (result.skill === 'smelt' && result.ok) {
      parts.push(`烧出了 ${detail.smelted} 个${itemLabel(detail.product)}`)
    } else if (result.skill === 'smelt') {
      const why = {
        no_furnace: '没有熔炉，也没带在身上',
        no_fuel: '没有能烧的燃料',
        not_smeltable: `${itemLabel(detail.input)}烧不出东西来`,
        item_not_in_inventory: `身上没有${itemLabel(detail.input)}`,
        nothing_smelted: '一炉都没烧出来'
      }[detail.error]
      parts.push(why || `没烧出${itemLabel(detail.product)}`)
    } else if (result.skill === 'sleep' && result.ok) {
      parts.push('躺下睡着了')
    } else if (result.skill === 'sleep') {
      parts.push(detail.error === 'no_bed' ? '附近没有床' : detail.error === 'not_night' ? '天还亮着睡不着' : '没睡成')
    } else if (result.skill === 'use' && result.ok) {
      const what = detail.block ? blockLabel(detail.block) : entityLabel(step.args && step.args.entity)
      parts.push(detail.opened ? `按了${what}，弹出了${detail.opened}` : `按了${what}`)
    } else if (result.skill === 'use') {
      parts.push(detail.error === 'no_such_block' ? '附近没找到那个东西' : '没能按下去')
    } else if (result.skill === 'snapshot' && result.ok) {
      // 图是 planner 抓的，这一侧只负责「摆好姿势」；别在这里说“没成功”
      const view = detail.view || {}
      const where = detail.turned === 'coords' ? '看向那格方块'
        : detail.turned === 'angles' ? `转了 ${Math.round((view.yaw || 0) * 180 / Math.PI) || 0}°`
          : '照现在的方向'
      parts.push(`拍了张画面，${where}`)
    } else if (result.skill === 'snapshot') {
      parts.push(detail.error === 'look_failed' ? '转不过去那个方向' : '拍照的姿势没摆好')
    } else if (result.skill === 'roam' && result.ok) {
      parts.push(`在附近逛了逛，走了约 ${Math.round(detail.travel || 0)} 格`)
    } else if (result.skill === 'roam') {
      parts.push(detail.error === 'not_moved' ? '没能挪动地方' : '逛到一半走不动了')
    } else {
      parts.push(`${result.skill} 没成功`)
    }
  }
  return parts.join('；') || '什么都没做成'
}

const ITEM_LABELS_EXTRA = {
  iron_ingot: '铁锭',
  gold_ingot: '金锭',
  copper_ingot: '铜锭',
  raw_iron: '粗铁',
  raw_gold: '粗金',
  raw_copper: '粗铜',
  glass: '玻璃',
  charcoal: '木炭',
  cooked_beef: '熟牛肉',
  cooked_porkchop: '熟猪排',
  furnace: '熔炉',
  diamond: '钻石',
  coal: '煤炭',
  iron_ore: '铁矿石',
  oak_door: '橡木门',
  stick: '木棍',
  sand: '沙子'
}

const BLOCK_LABELS = {
  stone: '石头',
  cobblestone: '圆石',
  dirt: '土块',
  deepslate: '深板岩',
  oak_log: '橡木',
  oak_planks: '木板',
  bread: '面包',
  apple: '苹果',
  wooden_pickaxe: '木镐',
  stone_pickaxe: '石镐'
}

const ENTITY_LABELS = {
  zombie: '僵尸',
  skeleton: '骷髅',
  spider: '蜘蛛',
  creeper: '苦力怕'
}

function blockLabel (name) {
  return BLOCK_LABELS[name] || ITEM_LABELS_EXTRA[name] || name || '东西'
}

function itemLabel (name) {
  return BLOCK_LABELS[name] || ITEM_LABELS_EXTRA[name] || name || '东西'
}

function entityLabel (name) {
  return ENTITY_LABELS[name] || name || '怪'
}

module.exports = { TaskRunner, validateIntention, summarize, cancelSummary }
