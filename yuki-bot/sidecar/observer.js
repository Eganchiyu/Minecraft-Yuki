'use strict'
// sidecar/observer.js —— P4.2 世界观察（World Observer）+ 事件聚合（Event Grouper）。
//
// 定位：把 Mineflayer 的高频结构化变化，压成「值得考虑的一小批候选经历」。
//   entitySpawn   → new_entity（初遇实体）
//   blockUpdate   → 空间相邻、时间连续的人工方块变化聚成一个 construction_candidate
//   位置/生物群系 → landmark_arrival（到了一个不一样的地方）
//   task_done     → task_milestone（做完了一件事）
//
// 三条硬规矩：
// 1. 只报候选，不断言语义（决策 #37）：「这里有连续的人工方块变化」，不写「这是爱心」。
// 2. 这里不评分、不唤醒、不截图（那是 P4.3/P4.4）：候选只带事实（novelty/confidence/规模）。
// 3. 回调里只做同步的轻活，任何异常都吞掉——观察者绝不允许拖慢任务执行与守护逻辑。
//
// 原始事件（坐标、方块清单、实体 id）留在这里，进 L1 的永远只有之后压缩过的 capsule。
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('./config')
const log = require('./log')

// 26.1 里实体的 type 字段：只关心「活的东西」，道具/经验球/投掷物/盔甲架都不算经历
const ALLOWED_ENTITY_TYPES = new Set(['animal', 'hostile', 'passive', 'water_creature', 'ambient', 'mob'])
const MAX_HISTORY = 50

const DEFAULTS = {
  entityRange: 32, // 只看身边的
  warmupMs: 4000, // 登录/复活瞬间会批量刷实体，先安静一会
  blockRange: 32, // 方块变化的距离
  blockJoin: 2, // 切比雪夫距离 ≤2 的方块算同一处
  blockSilenceMs: 3000, // 静默多久算这一批搭完了
  blockMinCount: 3, // 少于 3 块不算「一处变化」
  blockMaxPoints: 400, // 内存护栏
  selfFenceMs: 2500, // Yuki 自己刚放下的方块，不当成「世界的变化」
  areaCellSize: 64, // 地点按 64 格分格
  areaDwellMs: 4000, // 到达一个新地方要停留多久才算「到了」
  cooldownMs: 3 * 60 * 1000, // 同 kind+subject 在这个窗口内不再报
  mergeWindowMs: 5 * 60 * 1000 // 同一处继续搭，合并进上一条候选而不是再报一次
}

const MERGEABLE = new Set(['construction_candidate'])

// ---------------- 纯函数：实体分类 ----------------

/** 这个实体值不值得当成一次「初遇」？只做结构性判断，不做价值判断。 */
function classifyEntity (entity, registry) {
  if (!entity || entity.isValid === false) return { ok: false, reason: 'invalid' }
  if (entity.username || entity.type === 'player') return { ok: false, reason: 'player' }
  const name = String(entity.name || '')
  if (!name) return { ok: false, reason: 'unnamed' }
  let type = String(entity.type || '')
  if (!type && registry && registry.entitiesByName && registry.entitiesByName[name]) {
    type = String(registry.entitiesByName[name].type || '')
  }
  if (!ALLOWED_ENTITY_TYPES.has(type)) return { ok: false, reason: `type_${type || 'unknown'}` }
  return { ok: true, name, type }
}

/** 新方块是实心的、旧方块不是（空的），才算一次「放了一块东西」。挖掉/替换不算。 */
function isPlacement (oldBlock, newBlock) {
  if (!newBlock || newBlock.boundingBox !== 'block') return false
  if (!newBlock.position || !Number.isFinite(newBlock.position.x)) return false
  if (oldBlock && oldBlock.boundingBox && oldBlock.boundingBox !== 'empty') return false
  return true
}

/** 一处变化的置信度：块数越多、种类越杂，越像人为的一处改变。上限 0.95，绝不给 1。 */
function constructionConfidence (count, distinct) {
  const raw = 0.35 + 0.06 * Number(count || 0) + 0.03 * Math.max(0, Number(distinct || 1) - 1)
  return Math.round(Math.min(0.95, Math.max(0, raw)) * 100) / 100
}

// ---------------- 纯函数：方块聚类 ----------------

function chebyshev (a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z))
}

/** 把点按切比雪夫距离连成簇（并查集）。返回 [{points:[...]}]。 */
function groupPoints (points, joinDistance) {
  const parent = points.map((_, i) => i)
  const find = (i) => {
    let root = i
    while (parent[root] !== root) root = parent[root]
    while (parent[i] !== root) { const next = parent[i]; parent[i] = root; i = next }
    return root
  }
  const union = (a, b) => {
    const ra = find(a); const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      if (chebyshev(points[i], points[j]) <= joinDistance) union(i, j)
    }
  }
  const buckets = new Map()
  for (let i = 0; i < points.length; i += 1) {
    const root = find(i)
    if (!buckets.has(root)) buckets.set(root, [])
    buckets.get(root).push(points[i])
  }
  return [...buckets.values()].map((items) => ({ points: items }))
}

/** 一簇点 → 给 L1 之外的账本用的候选事实（不含语义断言）。 */
function clusterFacts (cluster, opts = {}) {
  const points = cluster.points || []
  const names = [...new Set(points.map((p) => p.name).filter(Boolean))]
  const xs = points.map((p) => p.x); const ys = points.map((p) => p.y); const zs = points.map((p) => p.z)
  const min = { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) }
  const max = { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) }
  const grid = Math.max(1, Number(opts.areaCellSize || 8))
  const center = {
    x: Math.round((min.x + max.x) / 2),
    y: Math.round((min.y + max.y) / 2),
    z: Math.round((min.z + max.z) / 2)
  }
  const startedAt = Math.min(...points.map((p) => p.at || 0))
  const lastAt = Math.max(...points.map((p) => p.at || 0))
  return {
    kind: 'construction_candidate',
    // subject 按 8 格分格：同一处继续搭会落到同一个 subject，交给上层合并
    subject: `cluster:${Math.floor(center.x / grid)}:${Math.floor(center.z / grid)}`,
    location: center,
    summary: '',
    salience: null,
    confidence: constructionConfidence(points.length, names.length),
    detail: {
      block_count: points.length,
      distinct_count: names.length,
      block_names: names.slice(0, 8),
      span: { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 },
      // 明确只报候选：具体是什么，交给视觉或 L1
      pattern: 'unknown',
      reason: 'recent_clustered_block_changes',
      started_at: startedAt,
      last_at: lastAt,
      truncated: Boolean(cluster.truncated)
    }
  }
}

class BlockClusterer {
  constructor (opts = {}) {
    this.opts = { ...DEFAULTS, ...opts }
    this.points = []
    this.fences = []
    this.dropped = 0
  }

  /** Yuki 自己刚放的方块：登记一下，别把她的动作当成世界的变化。 */
  markSelfPlacement (pos, now = Date.now()) {
    if (!pos || !Number.isFinite(pos.x)) return
    this.fences.push({ x: pos.x, y: pos.y, z: pos.z, at: now })
    if (this.fences.length > 32) this.fences = this.fences.slice(-32)
  }

  _isSelf (point, now) {
    this.fences = this.fences.filter((f) => now - f.at <= this.opts.selfFenceMs)
    return this.fences.some((f) => chebyshev(f, point) <= 1)
  }

  /** 收一个方块变化；返回是否真的记下了。 */
  push (change, now = Date.now()) {
    if (!change || !Number.isFinite(change.x)) return false
    if (this._isSelf(change, now)) return false
    const idx = this.points.findIndex((p) => p.x === change.x && p.y === change.y && p.z === change.z)
    const point = { x: change.x, y: change.y, z: change.z, name: change.name, at: now }
    if (idx >= 0) this.points[idx] = point
    else this.points.push(point)
    if (this.points.length > this.opts.blockMaxPoints) {
      this.points.splice(0, this.points.length - this.opts.blockMaxPoints)
      this.dropped += 1
    }
    return true
  }

  pending () { return this.points.length }

  /** 静默窗口过了就吐出一批簇；不足最小块数的直接丢掉。 */
  sweep (now = Date.now()) {
    if (!this.points.length) return []
    const cutoff = now - this.opts.blockSilenceMs
    const ready = this.points.filter((p) => p.at <= cutoff)
    if (!ready.length) return []
    this.points = this.points.filter((p) => p.at > cutoff)
    const clusters = groupPoints(ready, this.opts.blockJoin)
      .filter((c) => c.points.length >= this.opts.blockMinCount)
    if (this.dropped) {
      for (const c of clusters) c.truncated = true
      this.dropped = 0
    }
    return clusters
  }
}

// ---------------- 纯函数：地点变化 ----------------

/** 地点签名：维度 + 生物群系 + 64 格网格。变了才可能是「到了一个新地方」。 */
function areaSignature (sample, opts = {}) {
  const cell = Math.max(1, Number(opts.areaCellSize || 64))
  const p = sample.pos || {}
  return [
    sample.dimension || '',
    sample.biome || '',
    Math.floor((p.x || 0) / cell),
    Math.floor((p.z || 0) / cell)
  ].join('|')
}

class AreaTracker {
  constructor (opts = {}) {
    this.opts = { ...DEFAULTS, ...opts }
    this.committed = null
    this.pending = null
  }

  reset () {
    this.committed = null
    this.pending = null
  }

  /** 每次 tick 喂一次当前位置；返回候选或 null。重复到达的去重交给上层的 kind+subject 冷却。 */
  observe (sample, now = Date.now()) {
    const sig = areaSignature(sample, this.opts)
    if (!this.committed) { this.committed = sig; return null }
    if (sig === this.committed) { this.pending = null; return null }
    if (!this.pending || this.pending.sig !== sig) { this.pending = { sig, since: now }; return null }
    if (now - this.pending.since < this.opts.areaDwellMs) return null
    this.committed = sig
    this.pending = null
    const p = sample.pos || {}
    const cell = Math.max(1, Number(this.opts.areaCellSize || 64))
    return {
      kind: 'landmark_arrival',
      subject: `area:${sample.biome || 'unknown'}:${Math.floor((p.x || 0) / cell)}:${Math.floor((p.z || 0) / cell)}`,
      location: { x: Math.round(p.x || 0), y: Math.round(p.y || 0), z: Math.round(p.z || 0) },
      summary: '',
      salience: null,
      confidence: 0.6,
      novelty: null,
      detail: {
        biome: sample.biome || 'unknown',
        dimension: sample.dimension || '',
        reason: 'environment_changed'
      }
    }
  }
}

// ---------------- 看过的东西表 ----------------

/** 见过的东西存盘：没有它，「初遇」每次重启都会重来一遍。 */
class SeenTable {
  constructor (file, opts = {}) {
    this.file = path.resolve(file)
    this.max = Math.max(16, Number(opts.max || 800))
    this.seen = new Map()
    this.loaded = false
  }

  load () {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const seen = raw && raw.seen && typeof raw.seen === 'object' ? raw.seen : {}
      for (const [key, at] of Object.entries(seen)) this.seen.set(key, Number(at) || 0)
    } catch (_) { /* 没文件/读坏了都从空表开始 */ }
    this.loaded = true
    return this
  }

  _ensure () { if (!this.loaded) this.load() }

  has (key) { this._ensure(); return this.seen.has(key) }

  add (key, now = Date.now()) {
    this._ensure()
    if (!key) return false
    const isNew = !this.seen.has(key)
    this.seen.set(key, now)
    if (this.seen.size > this.max) {
      const sorted = [...this.seen.entries()].sort((a, b) => a[1] - b[1])
      this.seen = new Map(sorted.slice(-this.max))
    }
    if (isNew) this.save()
    return isNew
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, seen: Object.fromEntries(this.seen) }))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      log.warn('seen_save_failed', { error: err.message })
    }
  }

  size () { this._ensure(); return this.seen.size }
}

// ---------------- 合并 ----------------

/** 同一处继续搭：把新的一批并进上一条候选，而不是再报一次。 */
function mergeCandidate (prev, next, now) {
  const a = prev.detail || {}
  const b = next.detail || {}
  const names = [...new Set([...(a.block_names || []), ...(b.block_names || [])])].slice(0, 8)
  const count = Number(a.block_count || 0) + Number(b.block_count || 0)
  return {
    ...prev,
    at: now,
    updated_at: now,
    location: next.location || prev.location,
    confidence: Math.max(Number(prev.confidence || 0), constructionConfidence(count, names.length)),
    detail: {
      ...a,
      ...b,
      block_count: count,
      distinct_count: Math.max(Number(a.distinct_count || 0), Number(b.distinct_count || 0)),
      block_names: names,
      last_at: b.last_at || now,
      merges: Number(a.merges || 0) + 1
    }
  }
}

// ---------------- WorldObserver ----------------

class WorldObserver {
  constructor ({ link, seen = null, onCandidate = null, now = Date.now, opts = null } = {}) {
    this.link = link
    this.seen = seen
    this.onCandidate = onCandidate
    this.now = now
    this.opts = { ...DEFAULTS, ...(opts || {}) }
    this.clusterer = new BlockClusterer(this.opts)
    this.area = new AreaTracker(this.opts)
    this.history = []
    this.lastByKey = new Map()
    this.timer = null
    this.warmupUntil = 0
    this.started = false
    this.stats = {
      candidates: 0, merged: 0, suppressed: 0, events: 0, block_changes: 0,
      entity_spawns: 0, ticks: 0, tick_errors: 0
    }
    this._listeners = null
  }

  start () {
    if (this.started) return this
    const bot = this.link && this.link.bot
    if (!bot) return this
    const now = this.now()
    this.warmupUntil = now + this.opts.warmupMs
    this.area.reset()
    const onEntity = (entity) => { this._safe(() => this._onEntity(entity)) }
    const onBlock = (oldBlock, newBlock) => { this._safe(() => this._onBlock(oldBlock, newBlock)) }
    const onSpawn = () => { this.warmupUntil = this.now() + this.opts.warmupMs; this.area.reset() }
    bot.on('entitySpawn', onEntity)
    bot.on('blockUpdate', onBlock)
    bot.on('spawn', onSpawn)
    this._listeners = { onEntity, onBlock, onSpawn }
    this.timer = setInterval(() => { this._safe(() => this.tick()) }, 1000)
    if (this.timer.unref) this.timer.unref()
    this.started = true
    return this
  }

  stop () {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    const bot = this.link && this.link.bot
    if (bot && this._listeners) {
      bot.removeListener('entitySpawn', this._listeners.onEntity)
      bot.removeListener('blockUpdate', this._listeners.onBlock)
      bot.removeListener('spawn', this._listeners.onSpawn)
    }
    this._listeners = null
    this.started = false
  }

  /** 观察者绝不能因为自己的 bug 影响任务与守护。 */
  _safe (fn) {
    try { fn() } catch (err) {
      this.stats.tick_errors += 1
      log.warn('observer_error', { error: err.message })
    }
  }

  _botPos () {
    const link = this.link
    try {
      if (link && typeof link.pos === 'function') return link.pos()
      const p = link && link.bot && link.bot.entity && link.bot.entity.position
      return p ? { x: p.x, y: p.y, z: p.z } : null
    } catch (_) { return null }
  }

  _entityPos (entity) {
    const p = entity && entity.position
    if (!p || !Number.isFinite(p.x)) return null
    return { x: p.x, y: p.y, z: p.z }
  }

  _onEntity (entity) {
    const now = this.now()
    this.stats.entity_spawns += 1
    if (now < this.warmupUntil) return
    const cls = classifyEntity(entity, this.link && this.link.mcData)
    if (!cls.ok) return
    const pos = this._entityPos(entity)
    const botPos = this._botPos()
    if (!pos || !botPos) return
    const distance = Math.sqrt((pos.x - botPos.x) ** 2 + (pos.y - botPos.y) ** 2 + (pos.z - botPos.z) ** 2)
    if (distance > this.opts.entityRange) return
    const seenKey = `entity:${cls.name}`
    const novelty = this.seen && this.seen.has(seenKey) ? 0 : 1
    if (novelty && this.seen) this.seen.add(seenKey, now)
    this._deliver({
      kind: 'new_entity',
      subject: `mob:${cls.name}`,
      location: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
      summary: '',
      salience: null,
      confidence: novelty ? 0.8 : 0.5,
      novelty,
      detail: {
        entity_name: cls.name,
        category: cls.type,
        distance: Math.round(distance * 10) / 10,
        reason: 'entity_spawn_nearby'
      }
    }, now)
  }

  _onBlock (oldBlock, newBlock) {
    this.stats.events += 1
    const now = this.now()
    if (!isPlacement(oldBlock, newBlock)) return
    const botPos = this._botPos()
    if (!botPos) return
    const p = newBlock.position
    const distance = Math.sqrt((p.x - botPos.x) ** 2 + (p.y - botPos.y) ** 2 + (p.z - botPos.z) ** 2)
    if (distance > this.opts.blockRange) return
    if (this.clusterer.push({ x: p.x, y: p.y, z: p.z, name: newBlock.name }, now)) {
      this.stats.block_changes += 1
    }
  }

  tick (now = this.now()) {
    this.stats.ticks += 1
    for (const cluster of this.clusterer.sweep(now)) {
      this._deliver(clusterFacts(cluster, this.opts), now)
    }
    const botPos = this._botPos()
    if (botPos) {
      const candidate = this.area.observe({
        pos: botPos,
        biome: this._biome(botPos),
        dimension: this._dimension()
      }, now)
      if (candidate) this._deliver(candidate, now)
    }
  }

  _dimension () {
    try { return String((this.link.bot.game && this.link.bot.game.dimension) || '') } catch (_) { return '' }
  }

  _biome (pos) {
    try {
      const bot = this.link.bot
      const world = bot && bot.world
      if (!world || typeof world.getBlock !== 'function') return 'unknown'
      const block = world.getBlock({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) })
      const id = block && block.biome
      if (!Number.isFinite(id)) return 'unknown'
      const def = this.link.mcData && this.link.mcData.biomes && this.link.mcData.biomes[id]
      return (def && def.name) || `biome_${id}`
    } catch (_) { return 'unknown' }
  }

  /** 任务做完了：算一段经历，但不额外唤醒（汇报归 P4.4 的对话路径）。 */
  noteTaskDone ({ status, summary, steps } = {}) {
    this._safe(() => {
      if (status !== 'done') return
      const names = (Array.isArray(steps) ? steps : []).map((s) => s && s.skill).filter(Boolean)
      if (!names.length) return
      const now = this.now()
      const pos = this._botPos() || { x: 0, y: 0, z: 0 }
      this._deliver({
        kind: 'task_milestone',
        subject: `task:${names.join('+')}`,
        location: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
        summary: String(summary || ''),
        salience: null,
        confidence: 0.9,
        detail: { steps: names, reason: 'task_finished' }
      }, now)
    })
  }

  /** 世界自己放了一块（例如她自己放的），登记为「自己的动作」。 */
  markSelfPlacement (pos) { this.clusterer.markSelfPlacement(pos, this.now()) }

  /** 候选去重 / 合并。返回 'new' | 'merged' | 'suppressed'。 */
  _deliver (candidate, now) {
    candidate.id = candidate.id || crypto.randomUUID()
    candidate.at = candidate.at || now
    candidate.source = 'observer'
    const key = `${candidate.kind}\u0000${candidate.subject}`
    const prev = this.lastByKey.get(key)
    if (prev && now - prev.at <= this.opts.mergeWindowMs && MERGEABLE.has(candidate.kind)) {
      const merged = mergeCandidate(prev, candidate, now)
      this.lastByKey.set(key, merged)
      this.stats.merged += 1
      this._record(merged, 'merged')
      return 'merged'
    }
    if (prev && now - prev.at <= this.opts.cooldownMs) {
      this.stats.suppressed += 1
      return 'suppressed'
    }
    this.lastByKey.set(key, candidate)
    if (this.lastByKey.size > 200) {
      const cutoff = now - this.opts.mergeWindowMs
      for (const [k, v] of this.lastByKey) if (v.at <= cutoff) this.lastByKey.delete(k)
    }
    this.stats.candidates += 1
    this._record(candidate, 'new')
    return 'new'
  }

  _record (candidate, status) {
    const idx = this.history.findIndex((c) => c.id === candidate.id)
    const snapshot = { ...candidate, delivered: status }
    if (idx >= 0) this.history[idx] = snapshot
    else {
      this.history.push(snapshot)
      if (this.history.length > MAX_HISTORY) this.history.shift()
    }
    if (!this.onCandidate) return
    try {
      this.onCandidate(snapshot, status)
    } catch (err) {
      log.warn('observer_callback_failed', { error: err.message })
    }
  }

  status () {
    return {
      started: this.started,
      warmup: this.now() < this.warmupUntil,
      pending_blocks: this.clusterer.pending(),
      seen: this.seen ? this.seen.size() : 0,
      area: this.area.committed,
      stats: { ...this.stats }
    }
  }

  recent (n = 20) {
    return this.history.slice(-Math.max(1, n))
  }
}

/** 按配置建一个 observer（index.js 用；测试里自己 new）。 */
function createObserver (deps) {
  const opts = config.experience && config.experience.observer ? config.experience.observer : {}
  const seen = deps.seen || new SeenTable(path.join(deps.stateDir, 'seen.json'))
  return new WorldObserver({ ...deps, seen, opts })
}

module.exports = {
  DEFAULTS,
  classifyEntity,
  isPlacement,
  constructionConfidence,
  groupPoints,
  clusterFacts,
  areaSignature,
  BlockClusterer,
  AreaTracker,
  SeenTable,
  mergeCandidate,
  WorldObserver,
  createObserver
}
