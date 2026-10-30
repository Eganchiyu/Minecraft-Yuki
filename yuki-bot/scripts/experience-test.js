'use strict'
// yuki-bot/scripts/experience-test.js —— P4.1 经历账本的纯逻辑单测，不连服务器、不调模型。
// 用法：node yuki-bot/scripts/experience-test.js
process.env.YUKI_MC_CONFIG = process.env.YUKI_MC_CONFIG || '/dev/null'
process.env.SIDECAR_LOG_LEVEL = process.env.SIDECAR_LOG_LEVEL || 'error'

const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  makeExperience, dedupeKey, acceptExperience, pruneExperiences,
  parseJsonl, toJsonl, ExperienceStore
} = require(path.resolve(__dirname, '..', 'sidecar', 'experiences'))

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS ${name}`) } else { failed += 1; console.log(`FAIL ${name} | ${detail}`) }
}
function eq (a, b) { return JSON.stringify(a) === JSON.stringify(b) }

const T0 = 1793369000000

// ---------- 1. 构造 ----------
{
  const e = makeExperience({ kind: 'new_entity', subject: 'mob:sheep', summary: '第一次见到羊', salience: 0.6 }, T0)
  check('make: 字段齐全且时间落定', e.kind === 'new_entity' && e.at === T0 && e.visual === 'none' && e.source === 'observer', JSON.stringify(e))
  check('make: id 唯一', makeExperience({}, T0).id !== makeExperience({}, T0).id)
  check('make: salience 非数字回 0', makeExperience({ salience: 'x' }, T0).salience === 0)
  check('make: 空 kind 有兜底', makeExperience({}, T0).kind === 'unknown')
}

// ---------- 2. 去重：同 kind + 同 subject 在窗口内只收一次 ----------
{
  const win = 10 * 60 * 1000
  const a = makeExperience({ kind: 'new_entity', subject: 'mob:sheep', at: T0 }, T0)
  const b = makeExperience({ kind: 'new_entity', subject: 'mob:sheep', at: T0 + 1000 }, T0 + 1000)
  const c = makeExperience({ kind: 'new_entity', subject: 'mob:cow', at: T0 + 1000 }, T0 + 1000)
  const d = makeExperience({ kind: 'new_entity', subject: 'mob:sheep', at: T0 + win + 1 }, T0 + win + 1)
  const items = [a]
  check('dedupe: 同一只羊 1 秒内被吞', acceptExperience(items, b, { dedupeWindowMs: win }).added === false)
  check('dedupe: 换一只羊可以记', acceptExperience(items, c, { dedupeWindowMs: win }).added === true)
  check('dedupe: 过了窗口可以再记', acceptExperience(items, d, { dedupeWindowMs: win }).added === true)
  check('dedupe: 没有 subject 不去重', acceptExperience(items, makeExperience({ kind: 'x', subject: '', at: T0 + 1 }, T0 + 1), { dedupeWindowMs: win }).added === true)
  check('dedupe: key 带 kind', dedupeKey({ kind: 'a', subject: 's' }) !== dedupeKey({ kind: 'b', subject: 's' }))
}

// ---------- 3. 裁剪：TTL + 条数 ----------
{
  const old = makeExperience({ kind: 'k', at: T0 - 40 * 24 * 3600 * 1000 }, T0)
  const fresh = makeExperience({ kind: 'k', at: T0 }, T0)
  const out = pruneExperiences([old, fresh], { ttlDays: 30, maxEntries: 10 }, T0)
  check('prune: 过期被删', out.length === 1 && out[0].id === fresh.id)
  const many = Array.from({ length: 8 }, (_, i) => makeExperience({ kind: 'k', at: T0 + i }, T0 + i))
  const capped = pruneExperiences(many, { maxEntries: 3 }, T0 + 100)
  check('prune: 只留最新 N 条且有序', capped.length === 3 && capped[2].at === T0 + 7, JSON.stringify(capped.map((x) => x.at)))
  check('prune: 不改原数组', many.length === 8)
  check('prune: 脏元素被过滤', pruneExperiences([null, 1, 'x', fresh], {}, T0).length === 1)
}

// ---------- 4. JSONL 读写：坏行跳过 ----------
{
  const good = makeExperience({ kind: 'new_entity', subject: 'mob:sheep', summary: 'hi' }, T0)
  const text = toJsonl([good]) + '{bad json\n\n' + toJsonl([makeExperience({ kind: 'task_milestone', at: T0 + 1 }, T0 + 1)])
  const back = parseJsonl(text)
  check('jsonl: 跳过坏行保留好行', back.length === 2 && back[0].id === good.id, JSON.stringify(back))
  check('jsonl: 空文本为空数组', eq(parseJsonl(''), []))
  check('jsonl: 缺 id 的行被丢', parseJsonl('{"kind":"x"}\n').length === 0)
}

// ---------- 5. Store：落盘 / 重启恢复 / 去重 / 上限重写 ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-exp-'))
  const file = path.join(dir, 'worlds', 'world', 'experiences.jsonl')
  const opts = { maxEntries: 3, ttlDays: 30, dedupeWindowMs: 60000 }
  const store = new ExperienceStore(file, opts)

  const r1 = store.add({ kind: 'new_entity', subject: 'mob:sheep', summary: '羊', salience: 0.5 }, T0)
  const r2 = store.add({ kind: 'new_entity', subject: 'mob:sheep', summary: '羊', salience: 0.5 }, T0 + 1000)
  check('store: 首条写入', r1.added === true && fs.existsSync(file))
  check('store: 重复不写盘且不留空行', r2.added === false && fs.readFileSync(file, 'utf8').trim().split('\n').length === 1)

  store.add({ kind: 'new_entity', subject: 'mob:cow', summary: '牛' }, T0 + 2000)
  store.add({ kind: 'task_milestone', subject: 'first_iron', summary: '第一块铁' }, T0 + 3000)
  store.add({ kind: 'task_milestone', subject: 'first_gold', summary: '第一块金' }, T0 + 4000)
  check('store: 超过上限后仍只留 maxEntries 条', store.recent(100).length === 3, JSON.stringify(store.recent(100).map((x) => x.subject)))
  check('store: 重写后文件行数与内存一致', fs.readFileSync(file, 'utf8').trim().split('\n').length === 3)

  const reloaded = new ExperienceStore(file, opts)
  reloaded.load()
  check('store: 重启后恢复', reloaded.recent(10).length === 3 && reloaded.recent(1)[0].subject === 'first_gold')
  check('store: lastOfKind 取最近的', reloaded.lastOfKind('new_entity').subject === 'mob:cow')

  const updated = reloaded.update(reloaded.recent(1)[0].id, { reaction: '好耶', action: 'goto' })
  const after = new ExperienceStore(file, opts)
  after.load()
  check('store: update 落盘并保留', updated.reaction === '好耶' && after.recent(1)[0].action === 'goto')

  // 坏文件降级
  fs.writeFileSync(file, 'garbage\n{"kind":"x"}\n')
  const broken = new ExperienceStore(file, opts)
  check('store: 坏文件降级为空', broken.load().length === 0)

  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
