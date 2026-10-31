'use strict'
// sidecar/skills/index.js —— 技能白名单。P1+：mine / goto / follow / craft / deposit / attack / eat / equip / place；P3 加 roam / drop / open；
// 分域之后加 smelt（熔炉）/ sleep（睡觉）/ use（右键交互）/ snapshot（转头，画面由 planner 抓）。加技能要同时改 planner/schema.py 的白名单与 _normalize_step，
// 否则 L2 写得出、执行器收得到、planner 先拦下来——两边对不上是这里最常见的漏。
const mine = require('./mine')
const goto = require('./goto')
const follow = require('./follow')
const craft = require('./craft')
const deposit = require('./deposit')
const attack = require('./attack')
const eat = require('./eat')
const equip = require('./equip')
const place = require('./place')
const roam = require('./roam')
const drop = require('./drop')
const open = require('./open')
const smelt = require('./smelt')
const sleepSkill = require('./sleep')
const use = require('./use')
const snapshot = require('./snapshot')

const SKILLS = {
  mine, goto, follow, craft, deposit, attack, eat, equip, place, roam, drop, open,
  smelt, sleep: sleepSkill, use, snapshot
}
const SKILL_NAMES = Object.keys(SKILLS)

function getSkill (name) {
  return SKILLS[name] || null
}

module.exports = { SKILLS, SKILL_NAMES, getSkill }
