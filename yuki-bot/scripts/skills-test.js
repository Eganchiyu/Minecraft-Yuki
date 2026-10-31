'use strict'
// yuki-bot/scripts/skills-test.js —— 不连服务器的纯单测：新技能的配方/燃料表、意图校验、结果摘要。
// 用法：node yuki-bot/scripts/skills-test.js
process.env.YUKI_MC_CONFIG = process.env.YUKI_MC_CONFIG || '/dev/null'

const path = require('path')
const SIDECAR = path.resolve(__dirname, '..', 'sidecar')

const { smeltProduct, fuelSeconds, RECIPES } = require(path.join(SIDECAR, 'skills', 'smelt'))
const { SKILL_NAMES, getSkill } = require(path.join(SIDECAR, 'skills'))
const { validateIntention, summarize } = require(path.join(SIDECAR, 'tasks'))

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS ${name}`) } else { failed += 1; console.log(`FAIL ${name} | ${detail}`) }
}

// ---------- 1. 烧炼表 ----------
const SMELT_CASES = [
  ['raw_iron', 'iron_ingot'],
  ['iron_ore', 'iron_ingot'],
  ['deepslate_iron_ore', 'iron_ingot'],
  ['raw_gold', 'gold_ingot'],
  ['raw_copper', 'copper_ingot'],
  ['sand', 'glass'],
  ['cobblestone', 'stone'],
  ['beef', 'cooked_beef'],
  ['oak_log', 'charcoal'],
  ['stripped_oak_log', 'charcoal']
]
for (const [input, want] of SMELT_CASES) {
  check(`烧炼表 ${input} → ${want}`, smeltProduct(input) === want, String(smeltProduct(input)))
}
for (const bad of ['diamond', 'iron_ingot', 'stone_pickaxe', '']) {
  check(`烧炼表拒绝 ${bad || '空'}`, smeltProduct(bad) === null, String(smeltProduct(bad)))
}

// ---------- 2. 燃料表 ----------
const FUEL_CASES = [['coal', 80], ['charcoal', 80], ['coal_block', 800], ['oak_planks', 15], ['oak_log', 15], ['stick', 5]]
for (const [name, secs] of FUEL_CASES) {
  check(`燃料 ${name} = ${secs}s`, fuelSeconds(name) === secs, String(fuelSeconds(name)))
}
for (const bad of ['diamond', 'dirt', 'iron_ingot']) {
  check(`非燃料 ${bad}`, fuelSeconds(bad) === 0, String(fuelSeconds(bad)))
}

// ---------- 3. 配方表里没有明显重复/自环 ----------
const dup = Object.keys(RECIPES).filter((k) => RECIPES[k] === k)
check('烧炼表没有自环', dup.length === 0, dup.join(','))

// ---------- 4. 技能注册 ----------
for (const name of ['smelt', 'sleep', 'use', 'snapshot']) {
  check(`注册了 ${name}`, SKILL_NAMES.includes(name) && typeof getSkill(name).run === 'function')
}
check('技能总数为 16', SKILL_NAMES.length === 16, String(SKILL_NAMES.length))

// ---------- 5. 意图校验接受新技能 ----------
const good = [
  { skill: 'smelt', args: { input: 'raw_iron', count: 3 } },
  { skill: 'sleep', args: {} },
  { skill: 'use', args: { block: 'oak_door' } },
  { skill: 'snapshot', args: { reason: '看看山下' } }
]
for (const step of good) {
  check(`意图校验接受 ${step.skill}`, validateIntention({ steps: [step] }).ok)
}
check('意图校验拒绝未知技能', !validateIntention({ steps: [{ skill: 'teleport', args: {} }] }).ok)

// ---------- 6. 结果摘要（给 L1 的那句话） ----------
const SUMMARIES = [
  [{ skill: 'smelt', ok: true, detail: { smelted: 3, product: 'iron_ingot' } }, '烧出了 3 个铁锭'],
  [{ skill: 'smelt', ok: false, detail: { error: 'no_fuel', product: 'iron_ingot' } }, '没有能烧的燃料'],
  [{ skill: 'smelt', ok: false, detail: { error: 'not_smeltable', input: 'diamond' } }, '钻石烧不出东西来'],
  [{ skill: 'sleep', ok: true, detail: {} }, '躺下睡着了'],
  [{ skill: 'sleep', ok: false, detail: { error: 'no_bed' } }, '附近没有床'],
  [{ skill: 'use', ok: true, detail: { block: 'oak_door' } }, '按了橡木门']
]
for (const [result, want] of SUMMARIES) {
  const got = summarize([result], [{ skill: result.skill, args: {} }])
  check(`摘要 ${result.skill}`, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}

// ---------- 7. smelt 的早退路径（不需要服务器） ----------
const smelt = getSkill('smelt').run
const mcDataStub = { itemsByName: { raw_iron: { id: 1 }, diamond: { id: 2 } }, blocksByName: { furnace: { id: 3 } } }

function fakeCtx (items, opts = {}) {
  return {
    link: {
      mcData: mcDataStub,
      bot: {
        entity: opts.noEntity ? null : { position: { distanceTo: () => 1 } },
        inventory: { items: () => items },
        findBlock: () => null
      }
    },
    signal: { aborted: Boolean(opts.aborted) },
    timeoutMs: 120000
  }
}

async function smeltPaths () {
  let r = await smelt({ input: 'raw_iron', count: 3 }, fakeCtx([], { noEntity: true }))
  check('smelt 未就绪', r.ok === false && r.detail.error === 'bot_not_ready', JSON.stringify(r.detail))

  r = await smelt({ input: 'raw_iron', count: 1 }, fakeCtx([], { aborted: true }))
  check('smelt 已取消', r.ok === false && r.detail.error === 'cancelled', JSON.stringify(r.detail))

  r = await smelt({}, fakeCtx([]))
  check('smelt 缺 input', r.ok === false && r.detail.error === 'missing_input', JSON.stringify(r.detail))

  r = await smelt({ input: 'unobtanium' }, fakeCtx([]))
  check('smelt 未知物品', r.ok === false && r.detail.error === 'unknown_item', JSON.stringify(r.detail))

  r = await smelt({ input: 'diamond' }, fakeCtx([{ name: 'diamond', count: 1, type: 2 }]))
  check('smelt 不可烧', r.ok === false && r.detail.error === 'not_smeltable', JSON.stringify(r.detail))

  r = await smelt({ input: 'raw_iron' }, fakeCtx([]))
  check('smelt 身上没有原料', r.ok === false && r.detail.error === 'item_not_in_inventory', JSON.stringify(r.detail))

  r = await smelt({ input: 'raw_iron' }, fakeCtx([{ name: 'raw_iron', count: 4, type: 1 }]))
  check('smelt 没熔炉', r.ok === false && r.detail.error === 'no_furnace', JSON.stringify(r.detail))
}

smeltPaths().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})
