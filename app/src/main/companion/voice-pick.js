'use strict'
/**
 * TTS 音色解析（0.18.0 M2 修正，主人 2026-10-25 指出「语音 TTS 跟着角色卡走，不是共用的」）
 *  - 角色卡 voice.apiVoice **优先**；全局 ttsVoice 只给没配音色的卡兜底（旧实现顺序反了=全局覆盖卡）
 *  - Fish：卡上若写的是 UUID 形态音色 id，合成时映射为 fishVoiceId（Fish 不认 openai 语音名，反之全局 fishVoiceId 继续生效）
 *  - 端点/Key/模式等基础设施仍走全局配置（卡上只有音色，没有密钥）
 * 纯函数、零依赖，companion/index.js 三处 TTS 调用统一走这里；单测 test/voice-pick.test.js。
 */

/** Fish 音色 ID：标准 UUID（带横线）或 32 位十六进制（Fish 控制台/API 常见的无横线形态） */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const HEX32_RE = /^[0-9a-fA-F]{32}$/
const isFishVoiceId = (s) => UUID_RE.test(s) || HEX32_RE.test(s)

/** @param c 全局 companion 配置；@param char 角色卡（可为 null）→ { voice, voiceId } */
function cardVoiceParams (c, char) {
  const cfg = c || {}
  const cardVoice = (char && char.voice && char.voice.apiVoice) || ''
  return {
    voice: cardVoice || cfg.ttsVoice || 'alloy',
    // 卡上写的是 Fish 音色 ID（带/不带横线都认）→ 该卡用自己的 Fish 声线；
    // 否则（openai 音色名如 nova，或留空）→ 全局 fishVoiceId 兜底
    voiceId: (cfg.ttsProvider === 'fish' && isFishVoiceId(cardVoice)) ? cardVoice : cfg.fishVoiceId
  }
}

module.exports = { cardVoiceParams, UUID_RE, HEX32_RE, isFishVoiceId }
