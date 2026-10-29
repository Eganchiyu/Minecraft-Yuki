'use strict'
// sidecar/skills/index.js —— 技能白名单。P1+：mine / goto / follow / craft / deposit / attack / eat / equip / place；P3 加 roam / drop / open。
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

const SKILLS = { mine, goto, follow, craft, deposit, attack, eat, equip, place, roam, drop, open }
const SKILL_NAMES = Object.keys(SKILLS)

function getSkill (name) {
  return SKILLS[name] || null
}

module.exports = { SKILLS, SKILL_NAMES, getSkill }
