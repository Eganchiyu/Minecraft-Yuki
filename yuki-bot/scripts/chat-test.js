// 验证聊天指令闭环：第二个 bot 扮演玩家，喊 "yuki come" / "yuki stop"
const mineflayer = require('mineflayer')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const opts = { host: '127.0.0.1', port: 25565, version: '26.1', auth: 'offline' }

;(async () => {
  const tester = mineflayer.createBot({ ...opts, username: 'Tester' })
  await new Promise((r) => tester.once('spawn', r))
  await sleep(1500)
  console.log('[tester] spawn @', tester.entity.position.toString())
  const yuki = () => Object.values(tester.entities).find((e) => e.username === 'Yuki')
  console.log('[tester] yuki visible:', !!yuki())
  tester.chat('yuki come')
  await sleep(6000)
  const d = yuki() ? yuki().position.distanceTo(tester.entity.position) : NaN
  console.log('[tester] distance after come:', d.toFixed(2))
  tester.chat('yuki pos')
  await sleep(1500)
  tester.chat('yuki stop')
  await sleep(1500)
  console.log('[tester] RESULT:', d < 4 ? 'PASS' : 'FAIL')
  tester.quit()
  process.exit(d < 4 ? 0 : 1)
})()
