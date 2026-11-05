'use strict'
/**
 * 自言自语链路的语言要求（0.46.18，用户 11-03：自言自语的 TTS 是中文，设置的是说日语）
 *
 * 主聊天链路的【语言要求·最高优先级】在 index.js buildSystem 里注入，但「两条链路是
 * 两份独立代码」——自言自语有三条自己的生成路径，全都不经过那份拼装：
 *   1. chatter.js decide()   嘀咕 / 连续独白（LLM 生成）
 *   2. autonomy.js  两场自主活动的 sys（LLM 生成的汇报与「（自语）」行）
 *   3. autonomy.js  runBrowse 出门/发现的两句硬编码嘀咕（不经过 LLM）
 * 0.46.18 前这三处一句语言要求都没有 → 模型默认中文嘀咕、硬编码本来就是中文，
 * TTS 忠实地把中文念了出来。这里给三条路径提供同一份语言口径。
 */

const LANG_NAMES = { zh: '中文', en: '英文', ja: '日文' }

/**
 * 自言自语（LLM 生成类）的语言要求块。
 * replyLang 为空 / 'auto' 时返回 ''：独白没有用户发言可跟，保持旧行为（跟人设走）。
 */
function monologueLangBlock (replyLang) {
  const rl = String(replyLang || '').trim()
  if (!rl || rl === 'auto') return ''
  const name = LANG_NAMES[rl] || '中文'
  return [
    '【语言要求·最高优先级】你接下来输出的自言自语（嘀咕、独白、活动汇报）会被合成语音朗读出来，必须【只】用' + name + '说。',
    '硬性规则：',
    '1. 每一句都必须是' + name + '，禁止出现任何其它语言的完整句子（禁止一半中文一半' + name + '混写）。',
    '2. 唯一例外：专有名词（产品名、网站名、命令、代码、符号）可以保留原文。',
    '3. 文本会被直接拿去合成语音，任何混入的其它语言都会被读得很怪，输出前务必检查。'
  ].join('\n')
}

/**
 * runBrowse 出门/发现两句硬编码嘀咕的本地化（不经过 LLM，模板必须自带语言）。
 * 只支持与 index.js 语言映射一致的 zh / en / ja，其余回落中文。
 */
function browseMurmurs (replyLang) {
  const rl = String(replyLang || '').trim()
  if (rl === 'ja') {
    return {
      going: (t) => '「' + t + '」ちょっと見てくるね〜',
      found: (t) => '「' + t + '」…ちょっと気になる'
    }
  }
  if (rl === 'en') {
    return {
      going: (t) => 'Off to peek at "' + t + '"~',
      found: (t) => '"' + t + '"… that\'s interesting.'
    }
  }
  return {
    going: (t) => '去康康「' + t + '」～',
    found: (t) => '「' + t + '」…有点意思'
  }
}

module.exports = { monologueLangBlock, browseMurmurs, LANG_NAMES }
