'use strict'
// sidecar/config.js —— 配置外置：读 configs/local.json，环境变量优先。
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')

function readLocal () {
  const file = process.env.YUKI_MC_CONFIG || path.join(ROOT, 'configs', 'local.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return {}
  }
}

const raw = readLocal()
const pick = (v, d) => (v === undefined || v === null || v === '' ? d : v)
const int = (v, d) => {
  const n = parseInt(pick(v, d), 10)
  return Number.isNaN(n) ? d : n
}

const mc = raw.mc || {}
const sidecar = raw.sidecar || {}
const planner = raw.planner || {}

module.exports = {
  root: ROOT,
  mc: {
    host: pick(process.env.MC_HOST, mc.host || '127.0.0.1'),
    port: int(process.env.MC_PORT, mc.port || 25565),
    username: pick(process.env.MC_USER, mc.username || 'Yuki'),
    version: pick(process.env.MC_VERSION, mc.version || '26.1')
  },
  sidecar: {
    host: pick(process.env.SIDECAR_HOST, sidecar.host || '127.0.0.1'),
    port: int(process.env.SIDECAR_PORT, sidecar.port || 8790)
  },
  plannerUrl: pick(process.env.PLANNER_URL, planner.url || 'http://127.0.0.1:8791').replace(/\/+$/, ''),
  // 世界分区：与 planner 的 STATE_DIR 同一口径（MC_WORLD > mc.world > host_port）
  world: pick(process.env.MC_WORLD, mc.world || `${pick(process.env.MC_HOST, mc.host || '127.0.0.1')}_${int(process.env.MC_PORT, mc.port || 25565)}`),
  // 公屏转发过滤：留空 = 全部消息都进她的上下文（P3 定稿：像 chatbot 一样听所有聊天）
  chatKeyword: (process.env.SIDECAR_CHAT_KEYWORD !== undefined
    ? process.env.SIDECAR_CHAT_KEYWORD
    : (sidecar.chat_keyword !== undefined ? sidecar.chat_keyword : 'yuki')).toLowerCase(),
  limits: {
    stepTimeoutMs: int(process.env.SIDECAR_STEP_TIMEOUT_MS, 120000),
    taskTimeoutMs: int(process.env.SIDECAR_TASK_TIMEOUT_MS, 300000),
    // P2 预算：单步重试上限默认 2（PRD P2「retry 默认 2」）
    retryPerStep: int(process.env.SIDECAR_RETRY_PER_STEP, 2),
    queueLimit: 3,
    maxSteps: 5,
    chatReplyTimeoutMs: int(process.env.SIDECAR_CHAT_TIMEOUT_MS, 60000)
  },
  // P4.1 经历账本：只记「发生过什么」，给 L1 的永远是压缩后的人话
  experience: {
    enabled: (process.env.SIDECAR_EXPERIENCE !== '0'),
    maxEntries: int(process.env.SIDECAR_EXPERIENCE_MAX, 500),
    ttlDays: int(process.env.SIDECAR_EXPERIENCE_TTL_DAYS, 30),
    dedupeWindowMs: int(process.env.SIDECAR_EXPERIENCE_DEDUP_MS, 10 * 60 * 1000)
  }
}
