'use strict'
// sidecar/util.js —— 小工具：超时竞速、参数收敛。
class StepTimeout extends Error {
  constructor (ms) {
    super(`step timeout after ${ms}ms`)
    this.name = 'StepTimeout'
  }
}

/** 给不可控的第三方异步任务套一层超时，超时就 resolve 成失败。 */
function raceTimeout (promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      if (typeof onTimeout === 'function') {
        try { onTimeout() } catch (_) { /* noop */ }
      }
      reject(new StepTimeout(ms))
    }, ms)
    promise.then(
      (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value) },
      (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err) }
    )
  })
}

function clampInt (value, min, max, fallback) {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = { raceTimeout, StepTimeout, clampInt, sleep }
