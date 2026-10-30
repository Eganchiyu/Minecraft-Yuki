'use strict'
// yuki-bot/scripts/reflex-test.js —— 反射状态机的纯逻辑单测，不连服务器。
// 用法：node yuki-bot/scripts/reflex-test.js
process.env.YUKI_MC_CONFIG = process.env.YUKI_MC_CONFIG || '/dev/null'
process.env.SIDECAR_LOG_LEVEL = process.env.SIDECAR_LOG_LEVEL || 'error'

const path = require('path')
const SIDECAR = path.resolve(__dirname, '..', 'sidecar')

const { Guardian, chooseReaction, hostilesNear, isHostile, STATE } = require(path.join(SIDECAR, 'guardian'))

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS ${name}`) } else { failed += 1; console.log(`FAIL ${name} | ${detail}`) }
}

const mob = (name) => ({ name })

// ---------- 1. 打还是跑 ----------
const CASES = [
  ['单只僵尸带剑 → 打', { threats: [mob('zombie')], health: 20, hasWeapon: true }, 'defend', null],
  ['单只僵尸空手满血 → 打', { threats: [mob('zombie')], health: 20, hasWeapon: false }, 'defend', null],
  ['单只僵尸空手带伤 → 跑', { threats: [mob('zombie')], health: 14, hasWeapon: false }, 'flee', 'no_weapon'],
  ['两只空手 → 跑', { threats: [mob('zombie'), mob('skeleton')], health: 20, hasWeapon: false }, 'flee', 'no_weapon'],
  ['两只带剑 → 打', { threats: [mob('zombie'), mob('skeleton')], health: 20, hasWeapon: true }, 'defend', null],
  ['三只 → 跑（寡不敌众）', { threats: [mob('a'), mob('b'), mob('c')], health: 20, hasWeapon: true }, 'flee', 'too_many'],
  ['有苦力怕 → 永远跑', { threats: [mob('creeper')], health: 20, hasWeapon: true }, 'flee', 'creeper'],
  ['苦力怕混在怪堆里 → 跑', { threats: [mob('zombie'), mob('creeper')], health: 20, hasWeapon: true }, 'flee', 'creeper'],
  ['血 6 → 跑', { threats: [mob('zombie')], health: 6, hasWeapon: true }, 'flee', 'low_health'],
  ['血 8 带剑 → 跑（太虚）', { threats: [mob('zombie')], health: 8, hasWeapon: true }, 'flee', 'weak'],
  ['血 12 带剑 → 打', { threats: [mob('zombie')], health: 12, hasWeapon: true }, 'defend', null],
  ['没威胁 → idle', { threats: [], health: 20, hasWeapon: false }, 'idle', null]
]
for (const [name, input, action, why] of CASES) {
  const got = chooseReaction(input)
  check(name, got.action === action && (why === null || got.why === why), JSON.stringify(got))
}

// ---------- 2. 敌对识别 ----------
const mcData = {
  entitiesByName: {
    zombie: { category: 'Hostile mobs' },
    skeleton: { category: 'Hostile mobs' },
    creeper: { category: 'Hostile mobs' },
    cow: { category: 'Passive mobs' },
    item: { category: 'Passive mobs' }
  }
}
check('僵尸算敌对', isHostile({ name: 'zombie', position: {} }, mcData, {}))
check('牛不算敌对', !isHostile({ name: 'cow', position: {} }, mcData, {}))
const me = { name: 'zombie', position: {} }
check('自己不算敌对', !isHostile(me, mcData, me))

const near = (x) => ({ name: 'zombie', position: { distanceTo: () => x } })
const fakeBot = {
  entity: { position: { distanceTo: (p) => p.distanceTo() } },
  entities: { 1: near(3), 2: near(9), 3: near(20), 4: { name: 'cow', position: { distanceTo: () => 2 } } }
}
const found = hostilesNear(fakeBot, mcData, 10)
check('只收 10 格内的敌对', found.length === 2, String(found.length))
check('按距离由近到远', found[0] === fakeBot.entities[1] && found[1] === fakeBot.entities[2])

// ---------- 3. 状态机骨架 ----------
function makeGuardian (opts = {}) {
  const events = []
  const calls = { cancel: 0, hold: 0, release: 0 }
  const bot = {
    entity: { position: { distanceTo: () => 1, y: 64, floored: () => ({ offset: () => ({}) }) } },
    health: opts.health === undefined ? 20 : opts.health,
    food: 20,
    heldItem: null,
    inventory: { items: () => opts.items || [] },
    entities: {},
    pvp: { attack: async () => {}, stop: async () => {} },
    on: () => {}
  }
  const link = {
    ready: true,
    bot,
    mcData,
    pos: () => ({ x: 0, y: 64, z: 0 }),
    blocksAroundFeet: () => ({ feet: 'stone', head: 'air' }),
    gotoNear: async () => {},
    goalReached: async () => ({ ok: true }),
    hardStop: () => {}
  }
  const runner = {
    current: null,
    cancel: () => { calls.cancel += 1; return { cancelled: false } },
    hold: () => { calls.hold += 1 },
    releaseHold: () => { calls.release += 1 }
  }
  const g = new Guardian({ link, runner, emit: (e) => events.push(e), eat: async () => ({ ok: true }) })
  return { g, events, calls, bot }
}

async function stateMachine () {
  const { g, events, calls, bot } = makeGuardian()

  check('初始状态 idle', g.status().state === STATE.IDLE)

  bot.health = 20
  const target = { name: 'zombie', position: { distanceTo: () => 2 } }
  await g._startDefend(target, 'threat_nearby', { threats: 1 })
  check('开打 → defend', g.status().state === STATE.DEFEND)
  check('开打时抢占任务', calls.cancel === 1)
  check('开打时占住身体', calls.hold >= 1)
  const tr = events.find((e) => e.type === 'reflex')
  check('转移事件带 from/to/reason', tr && tr.from === 'idle' && tr.to === 'defend' && tr.reason === 'threat_nearby', JSON.stringify(tr))

  // 打不过了：血掉到 6 → 应当收手（先确认它确实还在 defend，别让「目标丢了」冒充）
  check('开打之后仍是 defend', g.status().state === STATE.DEFEND, g.status().state)
  bot.health = 6
  g.busy = false
  await g._tickDefend()
  check('血掉下来 → 离开 defend', g.status().state !== STATE.DEFEND, g.status().state)
  check('收手原因记为 low_health', events.some((e) => e.type === 'reflex_over' && e.reason === 'low_health'),
    JSON.stringify(events.filter((e) => e.type === 'reflex_over')))
  check('收手时释放身体', calls.release >= 1)

  // 目标消失
  const { g: g2, events: ev2 } = makeGuardian()
  g2.state = STATE.DEFEND
  g2.target = null
  g2.busy = false
  await g2._tickDefend()
  check('目标没了 → 收手', g2.status().state !== STATE.DEFEND)
  check('收手会上报 result', ev2.some((e) => e.type === 'reflex_over'))

  // 冷却
  const { g: g3 } = makeGuardian()
  g3.cooldown.hunger = Date.now() + 5000
  check('冷却期内不重复触发', g3._cooling('hunger'))
}

stateMachine().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})
