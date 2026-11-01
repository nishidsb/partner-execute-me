'use strict'
/**
 * 回应模式（0.19.0，对齐参考项目 response_mode / 互动回应设置）
 *
 *   active  积极：碰到哪、被扔出去，都当场反应（旧版本行为，默认）
 *   quiet   安静：只演动作不出声，互动先记着，等主人下次开口时一起回应
 *   custom  自定义：勾选的那几类才当场反应，其余记着
 *
 * 为什么分「当场」和「记着」两种：当场反应要花一次 TTS 合成 + 一次上下文注入，
 * 安静模式下攒到下次说话一起给，既省资源也不会一直打断主人。
 */

/** 身体部位 → 互动类别（渲染层 pet.js 有同一张表，test/reaction.test.js 会断言两边一致） */
const PART_CATEGORY = {
  head: 'pet',
  body: 'poke',
  weast: 'poke',
  breast: 'poke',
  arm_l: 'poke',
  arm_r: 'poke',
  grab: 'drop',
  drop: 'drop',
  throw: 'throw',
  crash: 'throw'
}

const CATEGORIES = ['pet', 'poke', 'throw', 'drop']
const DEFAULT_TYPES = CATEGORIES.slice()
const MODES = ['active', 'quiet', 'custom']

function categoryOf (part) {
  return PART_CATEGORY[part] || 'poke'
}

/**
 * @param {string} mode  active/quiet/custom
 * @param {string[]} types custom 模式下勾选的类别
 * @param {string} part  身体部位
 * @returns {'now'|'later'|'ignore'} now=当场反应并注入；later=只记着，下次说话一起给；ignore=完全不记
 */
function decide (mode, types, part) {
  const m = MODES.includes(mode) ? mode : 'active'
  if (m === 'active') return 'now'
  if (m === 'quiet') return 'later'
  const list = Array.isArray(types) && types.length ? types : DEFAULT_TYPES
  return list.includes(categoryOf(part)) ? 'now' : 'later'
}

/** 规范化设置值（老配置没有这两个键时给默认） */
function normalize (mode, types) {
  const m = MODES.includes(mode) ? mode : 'active'
  const t = Array.isArray(types) ? types.filter((x) => CATEGORIES.includes(x)) : DEFAULT_TYPES.slice()
  return { mode: m, types: t.length ? t : DEFAULT_TYPES.slice() }
}

module.exports = { PART_CATEGORY, CATEGORIES, DEFAULT_TYPES, MODES, categoryOf, decide, normalize }
