'use strict'
// yuki-bot/scripts/observer-test.js —— P4.2 观察者/聚合器的纯逻辑单测，不连服务器、不调模型。
// 用法：node yuki-bot/scripts/observer-test.js
process.env.YUKI_MC_CONFIG = process.env.YUKI_MC_CONFIG || '/dev/null'
process.env.SIDECAR_LOG_LEVEL = process.env.SIDECAR_LOG_LEVEL || 'error'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

const {
  classifyEntity, isPlacement, constructionConfidence, groupPoints, clusterFacts,
  areaSignature, BlockClusterer, AreaTracker, SeenTable, mergeCandidate, WorldObserver
} = require(path.resolve(__dirname, '..', 'sidecar', 'observer'))

const mcData = require(path.resolve(__dirname, '..', 'node_modules', 'minecraft-data'))('26.1')

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS ${name}`) } else { failed += 1; console.log(`FAIL ${name} | ${detail}`) }
}
function eq (a, b) { return JSON.stringify(a) === JSON.stringify(b) }
const T0 = 1793369000000

// ---------- 1. 实体分类：只关心活的东西 ----------
{
  const sheep = classifyEntity({ name: 'sheep', type: 'animal' }, mcData)
  const zombie = classifyEntity({ name: 'zombie', type: 'hostile' }, mcData)
  check('entity: 羊算实体', sheep.ok && sheep.name === 'sheep' && sheep.type === 'animal', JSON.stringify(sheep))
  check('entity: 僵尸算实体', zombie.ok && zombie.type === 'hostile')
  check('entity: 掉落物不算', classifyEntity({ name: 'item', type: 'other' }, mcData).reason === 'type_other')
  check('entity: 箭不算', classifyEntity({ name: 'arrow', type: 'projectile' }, mcData).reason === 'type_projectile')
  check('entity: 玩家不算', classifyEntity({ name: 'xiaochi', type: 'player', username: 'xiaochi' }, mcData).reason === 'player')
  check('entity: 盔甲架不算', classifyEntity({ name: 'armor_stand', type: 'living' }, mcData).reason === 'type_living')
  check('entity: 无名不算', classifyEntity({ type: 'animal' }, mcData).reason === 'unnamed')
  check('entity: 已失效不算', classifyEntity({ name: 'sheep', type: 'animal', isValid: false }, mcData).reason === 'invalid')
  const fallback = classifyEntity({ name: 'cow' }, mcData)
  check('entity: 缺 type 时查注册表', fallback.ok && fallback.type === 'animal', JSON.stringify(fallback))
}

// ---------- 2. 方块变化只认「从空到实心」 ----------
{
  const air = { boundingBox: 'empty', position: { x: 1, y: 2, z: 3 } }
  const wool = { name: 'white_wool', boundingBox: 'block', position: { x: 1, y: 2, z: 3 } }
  const stone = { name: 'stone', boundingBox: 'block', position: { x: 1, y: 2, z: 3 } }
  check('block: 空气→羊毛算放置', isPlacement(air, wool) === true)
  check('block: 石头→羊毛是替换，不算', isPlacement(stone, wool) === false)
  check('block: 羊毛→空气是挖掉，不算', isPlacement(wool, air) === false)
  check('block: 无位置不算', isPlacement(air, { name: 'white_wool', boundingBox: 'block' }) === false)
}

// ---------- 3. 置信度：随规模涨、有上限 ----------
{
  const c3 = constructionConfidence(3, 1)
  const c8 = constructionConfidence(8, 2)
  const c18 = constructionConfidence(18, 3)
  check('confidence: 3 块约 0.53', c3 > 0.5 && c3 < 0.6, String(c3))
  check('confidence: 8 块更高', c8 > c3, `${c8} vs ${c3}`)
  check('confidence: 18 块封顶 0.95', c18 === 0.95, String(c18))
  check('confidence: 0 块不为负', constructionConfidence(0, 0) >= 0)
}

// ---------- 4. 聚类：空间邻近成簇 ----------
{
  const pts = [
    { x: 0, y: 64, z: 0, name: 'white_wool', at: T0 },
    { x: 0, y: 64, z: 1, name: 'white_wool', at: T0 },
    { x: 2, y: 64, z: 2, name: 'red_wool', at: T0 }, // 切比雪夫 2，连上
    { x: 30, y: 64, z: 30, name: 'stone', at: T0 } // 另一处
  ]
  const groups = groupPoints(pts, 2)
  check('group: 3+1 分成两簇', groups.length === 2, JSON.stringify(groups.map((g) => g.points.length)))
  check('group: 近的 3 块在一簇', groups.some((g) => g.points.length === 3))
}

// ---------- 5. BlockClusterer：静默窗口 / 最小块数 / 自己放的不算 ----------
{
  const cl = new BlockClusterer({ blockSilenceMs: 3000, blockMinCount: 3, blockJoin: 2 })
  const put = (x, y, z, t) => cl.push({ x, y, z, name: 'white_wool' }, t)
  put(0, 64, 0, T0); put(0, 64, 1, T0 + 200); put(1, 64, 1, T0 + 400)
  check('cluster: 静默没到不吐', cl.sweep(T0 + 1000).length === 0)
  const flushed = cl.sweep(T0 + 4000)
  check('cluster: 静默到了吐一簇', flushed.length === 1 && flushed[0].points.length === 3, JSON.stringify(flushed.length))
  check('cluster: 吐完就清空', cl.pending() === 0)

  const cl2 = new BlockClusterer({ blockSilenceMs: 3000, blockMinCount: 3 })
  cl2.push({ x: 5, y: 64, z: 5, name: 'white_wool' }, T0)
  cl2.push({ x: 5, y: 65, z: 5, name: 'white_wool' }, T0)
  check('cluster: 少于 3 块丢掉', cl2.sweep(T0 + 4000).length === 0)

  const cl3 = new BlockClusterer({ blockSilenceMs: 3000, blockMinCount: 3 })
  cl3.markSelfPlacement({ x: 0, y: 64, z: 0 }, T0)
  check('self: 自己放的被拦下', cl3.push({ x: 0, y: 64, z: 0, name: 'crafting_table' }, T0 + 100) === false)
  check('self: 窗口过了就照收', cl3.push({ x: 0, y: 64, z: 0, name: 'white_wool' }, T0 + 9000) === true)

  const cl4 = new BlockClusterer({ blockSilenceMs: 3000, blockMinCount: 1 })
  cl4.push({ x: 0, y: 64, z: 0, name: 'white_wool' }, T0)
  cl4.push({ x: 0, y: 64, z: 0, name: 'red_wool' }, T0 + 100)
  const one = cl4.sweep(T0 + 4000)
  check('cluster: 同一格不重复计数', one.length === 1 && one[0].points.length === 1 && one[0].points[0].name === 'red_wool')

  const cl5 = new BlockClusterer({ blockSilenceMs: 3000, blockMinCount: 1, blockMaxPoints: 3 })
  for (let i = 0; i < 6; i += 1) cl5.push({ x: i, y: 64, z: 0, name: 'white_wool' }, T0 + i)
  const capped = cl5.sweep(T0 + 5000)
  check('cluster: 内存护栏截断并标 truncated', capped.length === 1 && capped[0].points.length === 3 && capped[0].truncated === true,
    JSON.stringify(capped.map((c) => [c.points.length, c.truncated])))
}

// ---------- 6. 簇 → 候选事实：不断言语义、subject 稳定 ----------
{
  const pts = Array.from({ length: 6 }, (_, i) => ({ x: i, y: 64, z: 0, name: i === 0 ? 'red_wool' : 'white_wool', at: T0 + i }))
  const f1 = clusterFacts({ points: pts }, { areaCellSize: 8 })
  const f2 = clusterFacts({ points: pts.map((p) => ({ ...p, at: p.at + 500 })) }, { areaCellSize: 8 })
  check('facts: kind 是候选', f1.kind === 'construction_candidate')
  check('facts: pattern 只写 unknown', f1.detail.pattern === 'unknown')
  check('facts: 不给语义断言', !JSON.stringify(f1).includes('爱心') && !JSON.stringify(f1).includes('房子'))
  check('facts: 块数/种类数对', f1.detail.block_count === 6 && f1.detail.distinct_count === 2, JSON.stringify(f1.detail))
  check('facts: subject 同一处稳定', f1.subject === f2.subject, `${f1.subject} vs ${f2.subject}`)
  check('facts: salience 留给评分器', f1.salience === null)
  check('facts: block_names 最多 8 个', clusterFacts({
    points: Array.from({ length: 5 }, (_, i) => ({ x: 0, y: 0, z: i, name: `b${i}`, at: T0 }))
  }).detail.block_names.length <= 8)
}

// ---------- 7. 地点跟踪：停稳了才算「到了」 ----------
{
  const opts = { areaDwellMs: 4000, areaCellSize: 64, cooldownMs: 60000 }
  const at = new AreaTracker(opts)
  const sample = (x, z, biome) => ({ pos: { x, y: 64, z }, biome, dimension: 'overworld' })
  check('area: 第一次只登记', at.observe(sample(0, 0, 'plains'), T0) === null)
  check('area: 刚变过去不算到达', at.observe(sample(0, 0, 'beach'), T0 + 1000) === null)
  const arrived = at.observe(sample(0, 0, 'beach'), T0 + 6000)
  check('area: 停留够了才报', arrived && arrived.kind === 'landmark_arrival' && arrived.detail.biome === 'beach', JSON.stringify(arrived))
  check('area: 同一地点不重复报', at.observe(sample(0, 0, 'beach'), T0 + 20000) === null)
  // 回到原地是一次新的到达；同一地点短时间内重复到达由观察者层的 kind+subject 冷却压住
  at.observe(sample(0, 0, 'plains'), T0 + 21000)
  check('area: 换回别的地形会再报一次', at.observe(sample(0, 0, 'plains'), T0 + 26000) !== null)
  check('area: 签名含维度与网格', areaSignature(sample(70, 0, 'beach')) !== areaSignature(sample(0, 0, 'beach')))
}

// ---------- 8. 看过的东西表：重启后还认得 ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-seen-'))
  const file = path.join(dir, 'seen.json')
  const t = new SeenTable(file, { max: 3 })
  check('seen: 第一次是新', t.has('entity:sheep') === false)
  t.add('entity:sheep', T0)
  check('seen: 记下就认得', t.has('entity:sheep') === true)
  check('seen: 重复 add 返回 false', t.add('entity:sheep', T0 + 1) === false)
  const reloaded = new SeenTable(file, { max: 16 })
  check('seen: 重启后仍在', reloaded.has('entity:sheep') === true)
  for (let i = 0; i < 20; i += 1) reloaded.add(`k${i}`, T0 + 2 + i)
  check('seen: 超上限裁掉最旧的', reloaded.size() === 16 && reloaded.has('entity:sheep') === false, String(reloaded.size()))
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------- 9. 合并：同一处继续搭 ----------
{
  const prev = {
    id: 'x', kind: 'construction_candidate', subject: 'cluster:0:0', at: T0,
    confidence: 0.6,
    detail: { block_count: 4, distinct_count: 1, block_names: ['white_wool'], merges: 0 }
  }
  const next = {
    kind: 'construction_candidate', subject: 'cluster:0:0', at: T0 + 5000, location: { x: 1, y: 64, z: 1 },
    confidence: 0.8,
    detail: { block_count: 6, distinct_count: 2, block_names: ['red_wool'], last_at: T0 + 5000 }
  }
  const merged = mergeCandidate(prev, next, T0 + 5000)
  check('merge: 块数累加', merged.detail.block_count === 10, String(merged.detail.block_count))
  check('merge: 种类并集', eq(merged.detail.block_names, ['white_wool', 'red_wool']))
  check('merge: 计数 +1', merged.detail.merges === 1)
  check('merge: id 不变', merged.id === 'x')
  check('merge: 置信度按合并后的规模重算', merged.confidence === 0.95, String(merged.confidence))
}

// ---------- 10. 观察者端到端（假 bot，不连服务器） ----------
function fakeLink ({ biome = 'plains', pos = { x: 0, y: 64, z: 0 } } = {}) {
  const bot = new EventEmitter()
  const state = { pos, biome, dimension: 'overworld' }
  bot.entity = { position: state.pos }
  bot.inventory = { items: () => [] }
  bot.game = { dimension: 'overworld' }
  bot.world = {
    getBlock: ({ x, y, z }) => ({ position: { x, y, z }, biome: (mcData.biomesByName[state.biome] || {}).id })
  }
  const link = {
    bot,
    mcData,
    state,
    pos: () => ({ ...state.pos }),
    setPos (p) { state.pos = p; bot.entity.position = p },
    setBiome (b) { state.biome = b }
  }
  return link
}

function makeObserver (link, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-obs-'))
  const seen = new SeenTable(path.join(dir, 'seen.json'))
  const got = []
  const observer = new WorldObserver({
    link,
    seen,
    opts: { warmupMs: 0, blockSilenceMs: 3000, blockMinCount: 3, entityRange: 32, ...extra },
    onCandidate: (c, status) => got.push({ status, candidate: c }),
    now: () => extra.clock ? extra.clock.value : Date.now()
  })
  return { observer, seen, got, dir }
}

{
  const clock = { value: T0 }
  const link = fakeLink()
  const { observer, got, dir } = makeObserver(link, { warmupMs: 0, clock })
  observer.start()
  link.bot.emit('entitySpawn', { name: 'sheep', type: 'animal', position: { x: 2, y: 64, z: 0 } })
  check('obs: 第一次见羊报一条', got.length === 1 && got[0].candidate.kind === 'new_entity' && got[0].candidate.novelty === 1, JSON.stringify(got))
  link.bot.emit('entitySpawn', { name: 'sheep', type: 'animal', position: { x: 3, y: 64, z: 0 } })
  check('obs: 冷却内同一只羊不再报', got.length === 1 && observer.status().stats.suppressed === 1, JSON.stringify(observer.status().stats))
  link.bot.emit('entitySpawn', { name: 'cow', type: 'animal', position: { x: 3, y: 64, z: 0 } })
  check('obs: 换一种可以报', got.length === 2)
  link.bot.emit('entitySpawn', { name: 'cow', type: 'animal', position: { x: 300, y: 64, z: 0 } })
  check('obs: 太远的不报', got.length === 2)
  link.bot.emit('entitySpawn', { name: 'item', type: 'other', position: { x: 1, y: 64, z: 0 } })
  check('obs: 掉落物不报', got.length === 2)

  // 玩家在面前搭 18 块
  const wool = (x, z) => ({ boundingBox: 'empty' })
  for (let i = 0; i < 18; i += 1) {
    const x = i % 6; const z = Math.floor(i / 6)
    link.bot.emit('blockUpdate', wool(x, z), {
      name: i < 9 ? 'red_wool' : 'white_wool', boundingBox: 'block', position: { x, y: 64, z }
    })
  }
  observer.tick(T0 + 1000)
  check('obs: 没到静默窗口不吐', got.filter((g) => g.candidate.kind === 'construction_candidate').length === 0)
  observer.tick(T0 + 4000)
  const builds = got.filter((g) => g.candidate.kind === 'construction_candidate')
  check('obs: 18 块只产生一条候选', builds.length === 1, String(builds.length))
  check('obs: 候选记下 18 块', builds[0] && builds[0].candidate.detail.block_count === 18, JSON.stringify(builds[0] && builds[0].candidate.detail))
  check('obs: 候选不断言造型', builds[0] && builds[0].candidate.summary === '')

  // 同一处继续搭两批：合并而不是再报
  for (let i = 0; i < 4; i += 1) {
    link.bot.emit('blockUpdate', wool(0, 0), {
      name: 'pink_wool', boundingBox: 'block', position: { x: 3 + (i % 2), y: 65, z: 1 + Math.floor(i / 2) }
    })
  }
  observer.tick(T0 + 8000)
  const buildEvents = got.filter((g) => g.candidate.kind === 'construction_candidate')
  const lastBuild = buildEvents[buildEvents.length - 1]
  check('obs: 继续搭算合并不再报新的', buildEvents.length === 2 && lastBuild.status === 'merged', JSON.stringify(buildEvents.map((m) => m.status)))
  check('obs: 合并后块数累加', lastBuild && lastBuild.candidate.detail.block_count === 22, JSON.stringify(lastBuild && lastBuild.candidate.detail))
  check('obs: 合并后仍是同一条候选', lastBuild && lastBuild.candidate.id === buildEvents[0].candidate.id)

  // 任务里程碑
  observer.noteTaskDone({ status: 'done', summary: '挖了 20 块石头，已经放进箱子', steps: [{ skill: 'mine' }, { skill: 'deposit' }] })
  const milestones = got.filter((g) => g.candidate.kind === 'task_milestone')
  check('obs: 做完任务算一段经历', milestones.length === 1 && milestones[0].candidate.summary.includes('挖了'), JSON.stringify(milestones))
  observer.noteTaskDone({ status: 'failed', summary: '失败了', steps: [{ skill: 'mine' }] })
  check('obs: 失败不算里程碑', got.filter((g) => g.candidate.kind === 'task_milestone').length === 1)

  // 地点变化
  link.setBiome('beach')
  observer.tick(T0 + 10000)
  observer.tick(T0 + 16000)
  const arrivals = got.filter((g) => g.candidate.kind === 'landmark_arrival')
  check('obs: 到了海边报一条', arrivals.length === 1 && arrivals[0].candidate.detail.biome === 'beach', JSON.stringify(arrivals))

  // 自己放的方块不算
  const before = got.length
  const now = T0 + 20000
  observer.markSelfPlacement({ x: 10, y: 64, z: 10 })
  link.bot.emit('blockUpdate', wool(10, 10), { name: 'crafting_table', boundingBox: 'block', position: { x: 10, y: 64, z: 10 } })
  observer.tick(now + 4000)
  check('obs: 自己放的工作台不产生候选', got.length === before, JSON.stringify(got.slice(before)))

  observer.stop()
  link.bot.emit('entitySpawn', { name: 'bee', type: 'animal', position: { x: 1, y: 64, z: 1 } })
  check('obs: stop 之后不再监听', got.filter((g) => g.candidate.detail && g.candidate.detail.entity_name === 'bee').length === 0)
  fs.rmSync(dir, { recursive: true, force: true })
}

// 暖机窗口：登录瞬间批量刷实体不应刷屏
{
  const clock = { value: T0 }
  const link = fakeLink()
  const { observer, got, dir } = makeObserver(link, { warmupMs: 4000, clock })
  observer.start()
  for (const name of ['sheep', 'cow', 'pig', 'chicken', 'zombie']) {
    link.bot.emit('entitySpawn', { name, type: name === 'zombie' ? 'hostile' : 'animal', position: { x: 1, y: 64, z: 1 } })
  }
  check('warmup: 登录瞬间不报', got.length === 0, String(got.length))
  clock.value = T0 + 5000
  link.bot.emit('entitySpawn', { name: 'sheep', type: 'animal', position: { x: 1, y: 64, z: 1 } })
  check('warmup: 之后照常报', got.length === 1)
  observer.stop()
  fs.rmSync(dir, { recursive: true, force: true })
}

// 回调炸了不能影响后续
{
  const link = fakeLink()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-obs-'))
  const seen = new SeenTable(path.join(dir, 'seen.json'))
  let calls = 0
  const observer = new WorldObserver({
    link,
    seen,
    opts: { warmupMs: 0 },
    now: () => T0,
    onCandidate: () => { calls += 1; throw new Error('boom') }
  })
  observer.start()
  link.bot.emit('entitySpawn', { name: 'sheep', type: 'animal', position: { x: 1, y: 64, z: 1 } })
  link.bot.emit('entitySpawn', { name: 'cow', type: 'animal', position: { x: 1, y: 64, z: 1 } })
  check('robust: 回调抛错后仍继续工作', calls === 2, String(calls))
  observer.stop()
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
