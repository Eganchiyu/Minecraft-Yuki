'use strict'
// sidecar/log.js —— 结构化日志：一行一个 JSON，方便 grep / 断言。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const MIN = LEVELS[process.env.SIDECAR_LOG_LEVEL || 'info'] || LEVELS.info

function emit (level, evt, fields) {
  if (LEVELS[level] < MIN) return
  const line = { t: new Date().toISOString(), lv: level, evt, ...(fields || {}) }
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout
  out.write(JSON.stringify(line) + '\n')
}

module.exports = {
  debug: (evt, fields) => emit('debug', evt, fields),
  info: (evt, fields) => emit('info', evt, fields),
  warn: (evt, fields) => emit('warn', evt, fields),
  error: (evt, fields) => emit('error', evt, fields)
}
