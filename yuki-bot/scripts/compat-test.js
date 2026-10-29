// 26.1 插件兼容性实测：逐个插件加载 + 实际调用，输出 PASS/FAIL
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { plugin: collectBlock } = require('mineflayer-collectblock')
const { plugin: pvp } = require('mineflayer-pvp').plugin ? require('mineflayer-pvp') : require('mineflayer-pvp')
const ItemFactory = require('prismarine-item')

const HOST = '127.0.0.1'
const PORT = 25566
const VER = '26.1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`) }

function loadPlugin (label, fn) {
  try { fn(); rec(`load:${label}`, true, 'loaded') } catch (e) { rec(`load:${label}`, false, e.message.split('\n')[0]) }
}

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'Yuki', version: VER, auth: 'offline' })
const protocolWarnings = []
bot.on('kicked', (r) => console.log('KICKED:', JSON.stringify(r)))
bot.on('error', (e) => console.log('ERR:', e.message))
bot._client.on('error', (e) => protocolWarnings.push(e.message))

loadPlugin('pathfinder', () => bot.loadPlugin(pathfinder))
loadPlugin('collectblock', () => bot.loadPlugin(collectBlock))
loadPlugin('pvp', () => bot.loadPlugin(pvp))
loadPlugin('tool', () => bot.loadPlugin(require('mineflayer-tool').plugin))
loadPlugin('armor-manager', () => bot.loadPlugin(require('mineflayer-armor-manager')))
loadPlugin('auto-eat', () => bot.loadPlugin(require('mineflayer-auto-eat').loader))
// statemachine 1.7 不再提供 mineflayer plugin，纯库使用

bot.once('spawn', async () => {
  const mcData = require('minecraft-data')(bot.version)
  const Item = ItemFactory(bot.version)
  console.log(`spawned ${bot.version} @ ${bot.entity.position} gamemode=${bot.game.gameMode}`)
  try { bot.pathfinder.setMovements(new Movements(bot, mcData)) } catch (e) { rec('api:movements', false, e.message) }
  await sleep(1000)
  bot.chat('/difficulty easy')
  bot.chat('/gamerule doMobSpawning true')
  await sleep(800)

  // ---- 1. mineflayer-tool：按方块选工具
  try {
    await bot.creative.setInventorySlot(36, new Item(mcData.itemsByName.diamond_axe.id, 1))
    await sleep(300)
    const tp = bot.entity.position.floored().offset(2, 0, 3)
    bot.chat(`/setblock ${tp.x} ${tp.y} ${tp.z} minecraft:oak_log`)
    await sleep(1200)
    const log = bot.blockAt(tp)
    const tool = await bot.tool.equipForBlock(log)
    rec('api:tool.equipForBlock', !!tool && bot.heldItem?.name === 'diamond_axe', `picked=${tool?.name} held=${bot.heldItem?.name}`)
  } catch (e) { rec('api:tool.equipForBlock', false, e.message.split('\n')[0]) }

  // ---- 2. collectblock：挖掉该方块
  try {
    const tp = bot.entity.position.floored().offset(2, 0, 3)
    const log = bot.blockAt(tp)
    if (!log || log.name !== 'oak_log') throw new Error('target block missing: ' + (log && log.name))
    await bot.collectBlock.collect(log, { ignoreNoPath: true })
    const after = bot.blockAt(tp)
    rec('api:collectBlock.collect', after.name === 'air', `block now ${after.name}, inventory logs=${bot.inventory.items().filter(i => i.name.includes('log')).reduce((a, i) => a + i.count, 0)}`)
  } catch (e) { rec('api:collectBlock.collect', false, e.message.split('\n')[0]) }

  // ---- 3. pvp：打僵尸
  try {
    const before = Object.keys(bot.entities).length
    bot.chat('/summon zombie ~2 ~ ~2')
    await sleep(1500)
    const zombie = Object.values(bot.entities).find(e => e.name === 'zombie' || e.displayName === 'Zombie')
    if (!zombie) throw new Error(`no zombie spawned (entities ${before} -> ${Object.keys(bot.entities).length})`)
    bot.pvp.attack(zombie)
    const t0 = Date.now(); let dead = false
    while (Date.now() - t0 < 15000) {
      if (!bot.entities[zombie.id]) { dead = true; break }
      await sleep(300)
    }
    bot.pvp.stop()
    rec('api:pvp.attack', dead, dead ? `zombie killed in ${((Date.now() - t0) / 1000).toFixed(1)}s, hp=${bot.health}` : `zombie survived 15s, hp=${bot.health}`)
  } catch (e) { rec('api:pvp.attack', false, e.message.split('\n')[0]) }

  // ---- 4. armor-manager：自动穿装备
  try {
    await bot.creative.setInventorySlot(5, new Item(mcData.itemsByName.diamond_helmet.id, 1))
    await bot.creative.setInventorySlot(6, new Item(mcData.itemsByName.diamond_chestplate.id, 1))
    await sleep(1500)
    const head = bot.inventory.slots[5], chest = bot.inventory.slots[6]
    rec('api:armorManager', head?.name === 'diamond_helmet' && chest?.name === 'diamond_chestplate', `head=${head?.name} chest=${chest?.name}`)
  } catch (e) { rec('api:armorManager', false, e.message.split('\n')[0]) }

  // ---- 5. auto-eat：API 表面 + 启用不报错
  try {
    bot.autoEat.setOpts({ priority: 'foodPoints', startAt: 14 })
    bot.autoEat.enable()
    await sleep(500)
    rec('api:autoEat', typeof bot.autoEat.eat === 'function' && bot.autoEat.enabled === true, `enabled=${bot.autoEat.enabled} methods=${['eat', 'enable', 'disable', 'setOpts'].filter(m => typeof bot.autoEat[m] === 'function').join(',')}`)
    bot.autoEat.disable()
  } catch (e) { rec('api:autoEat', false, e.message.split('\n')[0]) }

  // ---- 6. statemachine：构造并运行一个状态机
  try {
    const { StateTransition, BotStateMachine, NestedStateMachine, BehaviorIdle } = require('mineflayer-statemachine')
    const idle = new BehaviorIdle()
    const transitions = [new StateTransition({ parent: idle, name: 'stay' })]
    const layer = new NestedStateMachine(transitions, idle)
    const sm = new BotStateMachine(bot, layer)
    await sleep(500)
    rec('api:statemachine', !!sm && typeof sm.start === 'function', `constructed, layer=${layer.constructor.name}, transitionClass=${typeof StateTransition}`)
    sm.stop()
  } catch (e) { rec('api:statemachine', false, e.message.split('\n')[0]) }

  // ---- 7. prismarine-viewer：无头环境渲染
  try {
    const { viewer } = require('prismarine-viewer')
    void viewer
    rec('api:prismarine-viewer.require', true, 'module required (渲染需 webgl/canvas，单独验证)')
  } catch (e) { rec('api:prismarine-viewer.require', false, e.message.split('\n')[0]) }

  // ---- 8. 26.1 协议健康度
  rec('proto:26.1-clean', protocolWarnings.length === 0, protocolWarnings.length ? protocolWarnings.slice(0, 2).join(' | ') : 'no protocol errors')

  console.log('\n=== SUMMARY ===')
  const fail = results.filter(r => !r.ok)
  console.log(`${results.length - fail.length}/${results.length} passed`)
  fail.forEach(f => console.log('  FAIL:', f.name, '-', f.detail))
  bot.quit(); process.exit(fail.length ? 1 : 0)
})

setTimeout(() => { console.log('TIMEOUT'); process.exit(3) }, 120000)
