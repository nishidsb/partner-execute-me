'use strict'
/**
 * watch 链路的本地视觉切换（0.46.38）
 *
 * 用户诉求的完整落地：盯屏陪伴（0.18.0 起）一直用云端视觉看屏——每 3 分钟一张图、
 * 1~2 分钱/张、截图出本机（打游戏时她的眼睛一直在把游戏画面上传云端）。
 * 现在有了本机 Ollama 视觉（0.46.37 vision.js + qwen3-vl:4b），「看」切到本地：
 * 图先在本机转成文字描述，云端模型只收文字做「要不要开口 + 说什么」的判断。
 * 省钱、不出本机、还能看懂本地模型级别的细节。
 *
 * 降级链（绝不哑）：本地视觉未启用/失败 → 原图照发（deepseek-flash 自 2026-10 有视觉）；
 * 没有图（不该发生，shoot 失败在 watch.js 已拦）→ 原样透传。
 */

/** 给本地视觉的「看什么」指令：客观、全、不替她抒情——抒情是云端模型按人设干的活 */
const QUESTION =
  '客观详细描述这张屏幕截图（可能是多块显示器拼成的一张图）：' +
  '有哪些窗口/应用、正在显示什么内容、画面里的关键文字（游戏HUD、网页标题、视频画面、聊天窗口）、' +
  '正在发生什么。只描述，不要评价。'

/** 只看最后一条 user 消息里的 image_url（watch 每轮只带一张图、且只该换最新这张——
 *  从历史里翻旧图替换会把「她看到的」张冠李戴） */
function findImagePart (messages) {
  const list = messages || []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (!m || m.role !== 'user') continue
    if (!Array.isArray(m.content)) return null   // 最新 user 是纯文本 → 本轮没图
    const pi = m.content.findIndex((p) => p && p.type === 'image_url' && p.image_url && p.image_url.url)
    if (pi >= 0) return { mi: i, pi, url: String(m.content[pi].image_url.url) }
    return null
  }
  return null
}

/**
 * 把 messages 里的图换成本地视觉的文字描述。
 * @returns {Promise<{messages, mode:'no-image'|'fallback-image'|'localized', reason?}>}
 */
async function localizeImages (messages, vision, log) {
  const found = findImagePart(messages)
  if (!found) return { messages, mode: 'no-image' }
  let v
  try {
    v = await vision.describe(found.url, QUESTION)
  } catch (err) {
    v = { ok: false, reason: (err && err.message) || 'vision 调用异常' }
  }
  if (!v.ok) {
    try { log('[watch] 本地视觉没接上，这一眼回退原图给云端：' + v.reason) } catch { }
    return { messages, mode: 'fallback-image', reason: v.reason }
  }
  const out = messages.map((m, i) => {
    if (i !== found.mi) return m
    return {
      ...m,
      content: m.content.map((p, j) =>
        j === found.pi
          ? { type: 'text', text: '（她刚用本地视觉看了一眼，画面是——）\n' + v.text }
          : p
      )
    }
  })
  return { messages: out, mode: 'localized' }
}

module.exports = { localizeImages, findImagePart, QUESTION }
