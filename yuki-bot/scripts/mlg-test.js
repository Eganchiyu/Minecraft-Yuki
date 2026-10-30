'use strict'
// yuki-bot/scripts/mlg-test.js —— 落地自救的纯逻辑单测，不连服务器。
// 用法：node yuki-bot/scripts/mlg-test.js
process.env.YUKI_MC_CONFIG = process.env.YUKI_MC_CONFIG || '/dev/null'
process.env.SIDECAR_LOG_LEVEL = process.env.SIDECAR_LOG_LEVEL || 'error'

const path = require('path')
const SIDECAR = path.resolve(__dirname, '..', 'sidecar')

const { fallInfo, shouldMlg, mlgRescue } = require(path.join(SIDECAR, 'mlg'))
const { Guardian, STATE } = require(path.join(SIDECAR, 'guardian'))

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS ${name}`) } else { failed += 1; console.log(`FAIL ${name} | ${detail}`) }
}

// ---------- 1. 该不该放水（纯算术） ----------
const MLG_CASES = [
  ['不掉了 → 不动', { falling: false, dist: 3, hasBucket: true }, false, 'not_falling'],
  ['还在很高的地方 → 再等等', { falling: true, dist: 9, hasBucket: true }, false, 'too_high'],
  ['刚好 3.5 格 → 放', { falling: true, dist: 3.5, hasBucket: true }, true, 'fire'],
  ['还剩 2 格 → 放', { falling: true, dist: 2, hasBucket: true }, true, 'fire'],
  ['没有落点（下面没加载）→ 不动', { falling: true, dist: null, hasBucket: true }, false, 'no_landing'],
  ['没有水桶 → 不动', { falling: true, dist: 2, hasBucket: false }, false, 'no_bucket'],
  ['已经贴地 → 不动', { falling: true, dist: 0, hasBucket: true }, false, 'landed']
]
for (const [name, input, fire, why] of MLG_CASES) {
  const got = shouldMlg(input)
  check(name, got.fire === fire && got.why === why, JSON.stringify(got))
}

// ---------- 2. 落地探测：五条射线、取最近的面 ----------
function fakeWorld (columns) {
  // columns: { 'x,z': { top: y } }，top 以下是实心
  return (pos) => {
    const key = `${pos.x},${pos.z}`
    const col = columns[key]
    if (!col) return { name: 'air', boundingBox: 'empty', position: pos }
    if (pos.y > col.top) return { name: 'air', boundingBox: 'empty', position: pos }
    if (pos.y === col.top) return { name: col.name || 'stone', boundingBox: 'block', position: pos }
    return { name: 'stone', boundingBox: 'block', position: pos }
  }
}

function makeBot ({ y = 80, onGround = false, vy = -2, blockAt }) {
  return {
    entity: { position: { x: 0.5, y, z: 0.5 }, velocity: { x: 0, y: vy, z: 0 }, onGround },
    blockAt,
    inventory: { items: () => [] },
    health: 20
  }
}

{
  const bot = makeBot({ y: 80, blockAt: fakeWorld({ '0,0': { top: 70 } }) })
  const info = fallInfo(bot)
  check('掉了 → falling', info.falling === true)
  // 脚在 y=80，落点是方块 y=70 的顶面 y=71 → 离地 9 格
  check('算出离地 9 格', info.dist === 9, String(info.dist))
  check('落点就是那一格方块', info.landing && info.landing.position.y === 70)
  check('水放在落点正上方', info.water && info.water.y === 71, JSON.stringify(info.water))
}

{
  // 站在四格交界处：正中是深洞、四周有地。五条射线要能找到四周那层，不能直接判成掉进洞
  const blockAt = fakeWorld({
    '1,1': { top: 60 }, '0,0': { top: 74 }, '1,0': { top: 74 }, '0,1': { top: 74 }, '-1,1': { top: 74 }
  })
  const bot = makeBot({ y: 80, blockAt })
  bot.entity.position.x = 1
  bot.entity.position.z = 1
  const info = fallInfo(bot)
  check('站在格缝上：取四周最近的那层（5 格），不是正中那个洞（19 格）', info.dist === 5, String(info.dist))
  check('落点是四角之一', info.landing && info.landing.position.y === 74, JSON.stringify(info.landing && info.landing.position))
}

{
  // 脚下已经是水：不用救
  const bot = makeBot({ y: 80, blockAt: () => ({ name: 'water', boundingBox: 'empty', position: { x: 0, y: 0, z: 0 } }) })
  check('脚下是水 → 不触发', fallInfo(bot).falling === true && fallInfo(bot).landing === null)
}

{
  // 站在地上：不该当成坠落
  const info = fallInfo(makeBot({ y: 70, onGround: true, vy: 0, blockAt: fakeWorld({ '0,0': { top: 70 } }) }))
  check('站在地上 → 不算坠落', info.falling === false)
}

{
  // 普通起跳（vy 只有 -0.5 左右）不该触发
  const info = fallInfo(makeBot({ y: 70, vy: -0.5, blockAt: fakeWorld({ '0,0': { top: 70 } }) }))
  check('普通起跳 → 不算坠落', info.falling === false)
}

// ---------- 3. 没有落点时 mlgRescue 直接放弃 ----------
async function rescuePaths () {
  const bot = makeBot({ y: 80, vy: -2, blockAt: fakeWorld({}) })
  const r = await mlgRescue(bot, { vy: -2, dist: null, landing: null, water: null })
  check('没有落点 → mlgRescue 放弃', r.ok === false && r.detail.error === 'no_landing', JSON.stringify(r.detail))

  // 触发路径：状态机在坠落且够近时会进 mlg
  const events = []
  const bot2 = makeBot({ y: 80, vy: -3, blockAt: fakeWorld({ '0,0': { top: 78 } }) })
  bot2.inventory.items = () => [{ name: 'water_bucket', count: 1 }]
  bot2.pvp = { attack: async () => {}, stop: async () => {} }
  bot2.on = () => {}
  const link = {
    ready: true,
    bot: bot2,
    mcData: { entitiesByName: {} },
    pos: () => ({ x: 0, y: 80, z: 0 }),
    blocksAroundFeet: () => ({ feet: 'air', head: 'air' }),
    gotoNear: async () => {},
    goalReached: async () => ({ ok: true }),
    hardStop: () => {}
  }
  const runner = { current: null, cancel: () => ({ cancelled: false }), hold: () => {}, releaseHold: () => {} }
  const g = new Guardian({ link, runner, emit: (e) => events.push(e), eat: async () => ({ ok: true }) })

  // 直接调一次 tick：应该进 mlg（真实放水会因为假 bot 没有 placeBlock 而失败，这里只看状态机选了哪条路）
  bot2.placeBlock = () => Promise.reject(new Error('stub'))
  bot2.activateBlock = async () => {}
  bot2.equip = async () => {}
  await g.tick()
  check('坠落够近 → 进入 mlg 状态', events.some((e) => e.type === 'reflex' && e.to === STATE.MLG),
    JSON.stringify(events.map((e) => e.to)))
}

rescuePaths().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})
