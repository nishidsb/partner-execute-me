'use strict'
/**
 * 0.49.0 · 「她真的在旁边听」（主人 11-09 20:14 拍板）
 *
 * 主人原话的三条批评，三条都有锁：
 *   1. 「只要有声音就回应这也不对」 → 两层判定：
 *      层 1 本地 isFiller（纯应声不进对话）+ 层 2 <listen> 协议（模型自己判断接不接）
 *   2. 「气泡太多，应该只显示角色说话的气泡」 → 系统气泡全退场：
 *      「听到了正在识别」/声纹判定/「没听清」/错误气泡全删，错误走 reportError + 状态气泡
 *   3. 「不像在旁边听人说话」 → 注视锁（说话期间视线保持）+ 轻应声 softAck
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('isFiller：纯应声拦下，有实义的话放行', () => {
  const sf = require('../src/renderer/shared/speech-filter')
  // 拦：叠字应声、固定应声词
  for (const s of ['嗯嗯', '哦哦', '哈哈哈', '哈哈哈哈', '呃呃', '嘻嘻', '诶嘿', '哦豁', '嗯呐']) {
    assert.equal(sf.isFiller(s), true, '应被视为纯应声：' + s)
  }
  // 放：实义应答、正常句子、超长不算
  for (const s of ['谢谢', '好的', '不对', '帮我看看这个', '今天天气怎么样', '哎呀我的杯子呢']) {
    assert.equal(sf.isFiller(s), false, '不应被视为纯应声：' + s)
  }
  assert.equal(sf.isFiller(''), false)
})

test('pet.js：系统气泡全部退场，说话气泡只留她说的话', () => {
  const pet = read('src/renderer/overlay/pet.js')
  // 这些系统气泡文案不许再出现
  for (const bad of ['听到了，正在识别', '没听清，再说一遍？', '✓ 他的声音', '⚠ 不是他的声音', '声纹注册完成（3 段样本）', '⚠ 语音识别失败', '⚠ 语音识别异常']) {
    assert.ok(!pet.includes(bad), '系统气泡应已删除：' + bad)
  }
  // 等待期不再显示「…」占位（typed send 路径与 delta reset 路径）
  assert.ok(!pet.includes("bubbleShow('…')"), '等待期不显示 … 占位')
  // 失败/没听清改走 reportError 留痕
  assert.ok(pet.includes("reportError('voice'"), '失败要 reportError 留痕')
  // 麦克风点击反馈与菜单反馈走状态气泡，不再占说话气泡
  assert.ok(pet.includes("statusSet('work', micDesired ? '在听' : '不听')"), '麦克风点击反馈走状态气泡')
})

test('pet.js：两层判定 + 轻应声 + 注视锁齐装', () => {
  const pet = read('src/renderer/overlay/pet.js')
  // 层 1：纯应声不进对话，走 softAck
  assert.ok(pet.includes('isFiller'), '层 1 isFiller 调用')
  assert.ok(pet.includes('function softAck'), '轻应声 softAck')
  assert.ok(pet.includes('bubbleHoldVoice'), '轻应声要出声+气泡对齐')
  // 层 2：语音消息带 voice 标记发给主进程
  assert.ok(pet.includes('petChatSend(verdict.text || r.text, true)'), '语音消息带 voice 标记')
  // <listen> 协议：delta 流式与 done 都要静默
  assert.ok(pet.includes("asstBuf.trim() === '<listen>'"), 'delta 流式接住 <listen>')
  assert.ok(pet.includes('if (silent) return'), 'done 静默跳过显示与朗读')
  // 注视锁：VAD 说话期间视线保持
  assert.ok(pet.includes('cursorMoveAt = performance.now()'), '注视锁')
})

test('assistant 链：<listen> 协议与 silent 广播 + 静默轮跳过记账', () => {
  const idx = read('src/main/assistant/index.js')
  assert.ok(idx.includes('async function handleSend (_e, text, images, voice)'), 'handleSend 收 voice 参数')
  assert.ok(idx.includes('isVoice'), 'isVoice 判定')
  assert.ok(idx.includes('<listen>'), '语音场景注入 <listen> 协议')
  assert.ok(idx.includes('const silentReply'), 'silentReply 判定')
  assert.ok(idx.includes('silent: silentReply'), 'done 广播带 silent 标记')
  // 静默轮不记账（风格池/回复镜子里不该有 <listen>）
  assert.ok(idx.includes('if (!silentReply) {'), '静默轮跳过记账')
})

test('preload：petChatSend 透传 voice 标记', () => {
  const pre = read('src/preload/overlay.js')
  assert.ok(pre.includes("petChatSend: (text, voice) => ipcRenderer.invoke('assistant:send', text, null, voice)"), 'voice 参数透传')
})
