'use strict'
// sidecar/experiences.js —— P4.1 经历账本：结构化、可去重、按世界分区落盘。
//
// 定位：这里是「发生过什么」的原始账本（JSONL，一行一条），不是人格对话。
// 进入 L1 的永远只有压缩后的一两句人话（ExperienceCapsule），原始字段留在这里。
//
// 设计取舍：
// - append-only + 定期重写：正常只 append 一行；条数超过上限时用 tmp+rename 整体重写，防止文件无限长。
// - 去重用 (kind, subject) + 时间窗：同一只羊在 10 分钟内只记一条，但换一只（不同 id）可以再记。
// - 读坏了就跳过坏行，绝不让脏文件把侧车带崩。
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DEFAULT_KIND = 'unknown'

function makeExperience (input = {}, now = Date.now()) {
  const kind = String(input.kind || DEFAULT_KIND)
  return {
    id: input.id || crypto.randomUUID(),
    at: Number(input.at || now),
    kind,
    // subject：去重主体（实体 id / 聚类格 / 里程碑名）。没有人话可读性要求。
    subject: String(input.subject || ''),
    // summary：给 L1 的短人话；原始细节放 detail，永不直接进 prompt。
    summary: String(input.summary || ''),
    // P4.3：事实行显式 salience=null，表示「还没打分」。打分结果写 decisions.jsonl。
    salience: input.salience === null
      ? null
      : (Number.isFinite(input.salience) ? Number(input.salience) : 0),
    visual: input.visual || 'none',
    detail: input.detail || {},
    // features：注意力要用的数值证据（seen.count / distance / block_count …）
    features: input.features || {},
    reaction: input.reaction || null,
    action: input.action || null,
    outcome: input.outcome || null,
    source: input.source || 'observer'
  }
}

/** 同 kind + 同 subject 在 windowMs 内视为同一次经历。 */
function dedupeKey (exp) {
  return `${exp.kind}\u0000${exp.subject || ''}`
}

function acceptExperience (items, exp, opts = {}) {
  const windowMs = Number(opts.dedupeWindowMs || 0)
  if (windowMs > 0 && exp.subject) {
    const key = dedupeKey(exp)
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const old = items[i]
      if (exp.at - old.at > windowMs) break
      if (dedupeKey(old) === key) return { added: false, reason: 'duplicate', id: old.id }
    }
  }
  return { added: true, item: exp }
}

/** 按 ttl 与条数上限裁剪，返回新数组（不改原数组）。 */
function pruneExperiences (items, opts = {}, now = Date.now()) {
  const maxEntries = Math.max(1, Number(opts.maxEntries || 500))
  const ttlMs = Number(opts.ttlDays || 0) * 24 * 3600 * 1000
  let out = items.filter((item) => item && typeof item === 'object')
  if (ttlMs > 0) out = out.filter((item) => now - Number(item.at || 0) <= ttlMs)
  out.sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
  return out.slice(-maxEntries)
}

function parseJsonl (text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const item = JSON.parse(trimmed)
      if (item && typeof item === 'object' && item.id && item.kind) out.push(item)
    } catch (_) { /* 坏行跳过 */ }
  }
  return out
}

function toJsonl (items) {
  return items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '')
}

class ExperienceStore {
  constructor (file, opts = {}) {
    this.file = path.resolve(file)
    this.maxEntries = Math.max(1, Number(opts.maxEntries || 500))
    this.ttlDays = Number(opts.ttlDays || 0)
    this.dedupeWindowMs = Number(opts.dedupeWindowMs || 0)
    this.items = []
    this.loaded = false
  }

  load () {
    try {
      this.items = pruneExperiences(parseJsonl(fs.readFileSync(this.file, 'utf8')), this, Date.now())
    } catch (err) {
      if (err.code !== 'ENOENT') this.items = []
      else this.items = []
    }
    this.loaded = true
    return this.items
  }

  _ensure () {
    if (!this.loaded) this.load()
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
  }

  /** 返回 {added, item, reason}；重复或超限不写盘。 */
  add (input, now = Date.now()) {
    this._ensure()
    const exp = makeExperience({ ...input, at: input.at || now }, now)
    const decision = acceptExperience(this.items, exp, { dedupeWindowMs: this.dedupeWindowMs })
    if (!decision.added) return { added: false, reason: decision.reason, id: decision.id }
    this.items.push(exp)
    if (this.items.length > this.maxEntries) {
      this.items = pruneExperiences(this.items, this, now)
      this._rewrite()
    } else {
      fs.appendFileSync(this.file, JSON.stringify(exp) + '\n')
    }
    return { added: true, item: exp }
  }

  /**
   * P4.3 事实行：观察者候选原样落盘，salience=null、visual='none'。
   * 不走 (kind, subject) 去重：候选 id 就是稳定 id，同一处继续搭会以同一 id 再 append
   * 一行更新后的规模，读侧取「同 id 最后一行」。这样账本保持 append-only，不回头改历史。
   */
  addFact (candidate, now = Date.now()) {
    this._ensure()
    const exp = makeExperience({
      id: candidate.id,
      at: candidate.at || now,
      kind: candidate.kind,
      subject: candidate.subject,
      summary: candidate.summary,
      salience: null,
      visual: 'none',
      detail: {
        ...(candidate.detail || {}),
        location: candidate.location || null,
        confidence: candidate.confidence
      },
      features: candidate.features || {},
      source: 'observer'
    }, now)
    this.items.push(exp)
    if (this.items.length > this.maxEntries) {
      this.items = pruneExperiences(this.items, this, now)
      this._rewrite()
    } else {
      fs.appendFileSync(this.file, JSON.stringify(exp) + '\n')
    }
    return { added: true, item: exp }
  }

  _rewrite () {
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, toJsonl(this.items))
    fs.renameSync(tmp, this.file)
  }

  recent (n = 20) {
    this._ensure()
    return this.items.slice(-Math.max(1, n))
  }

  /** 找出最近的同类经历（给「重复惩罚」和「同一事件最多一张截图」用）。 */
  lastOfKind (kind) {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].kind === kind) return this.items[i]
    }
    return null
  }

  update (id, patch) {
    this._ensure()
    const item = this.items.find((it) => it.id === id)
    if (!item) return null
    Object.assign(item, patch)
    this._rewrite()
    return item
  }
}

module.exports = {
  makeExperience,
  dedupeKey,
  acceptExperience,
  pruneExperiences,
  parseJsonl,
  toJsonl,
  ExperienceStore
}
