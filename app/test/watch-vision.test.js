'use strict'
/** 0.46.38 watch 链路的本地视觉切换：图→本机描述→云端只收文字；失败回退原图不哑 */
const test = require('node:test')
const assert = require('node:assert')
const { localizeImages, findImagePart, QUESTION } = require('../src/main/companion/watchVision')

const IMG = 'data:image/jpeg;base64,ZmFrZQ=='
const noop = () => { }
/** watch 一轮的标准消息形状（system + 带图 user） */
function watchMessages () {
  return [
    { role: 'system', content: '人设提示词' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '看一眼主人的屏幕，判断要不要搭话。' },
        { type: 'image_url', image_url: { url: IMG } }
      ]
    }
  ]
}

test('0.46.38 watchVision: 本地视觉正常时图被换成文字描述', async () => {
  const seen = []
  const r = await localizeImages(watchMessages(), {
    describe: async (url, q) => { seen.push([url, q]); return { ok: true, text: '游戏画面，血条满' } }
  }, noop)
  assert.equal(r.mode, 'localized')
  const userPart = r.messages[1].content[1]
  assert.equal(userPart.type, 'text', 'image_url 被替换')
  assert.match(userPart.text, /游戏画面，血条满/)
  assert.equal(seen[0][0], IMG, '原始 dataURL 喂给本地视觉')
  assert.ok(seen[0][1].includes('HUD'), '描述指令要求覆盖游戏 HUD 等关键信息')
  // 其他消息原样
  assert.equal(r.messages[0].content, '人设提示词')
})

test('0.46.38 watchVision: 本地视觉没接上时回退原图——绝不哑', async () => {
  const msgs = watchMessages()
  const r = await localizeImages(msgs, { describe: async () => ({ ok: false, reason: 'Ollama 未运行' }) }, noop)
  assert.equal(r.mode, 'fallback-image')
  assert.match(r.reason, /Ollama/)
  assert.equal(r.messages[1].content[1].type, 'image_url', '原图保留')
  assert.deepEqual(r.messages, msgs, '消息原样（云端视觉兜底）')
})

test('0.46.38 watchVision: 没图时不打扰（直接透传）', async () => {
  const r = await localizeImages([{ role: 'user', content: '纯文字' }], { describe: async () => { throw new Error('不该被调') } }, noop)
  assert.equal(r.mode, 'no-image')
})

test('0.46.38 watchVision: vision 抛异常也走回退，不上抛', async () => {
  const r = await localizeImages(watchMessages(), { describe: async () => { throw new Error('boom') } }, noop)
  assert.equal(r.mode, 'fallback-image')
  assert.equal(r.messages[1].content[1].type, 'image_url')
})

test('0.46.38 watchVision: findImagePart 取最后一条带图 user', () => {
  const msgs = watchMessages()
  msgs.push({ role: 'assistant', content: '好' })
  msgs.push({ role: 'user', content: [{ type: 'text', text: '再看一眼' }] })
  assert.equal(findImagePart(msgs), null, '最后一条 user 没图就不找旧的（watch 每轮新图）')
  assert.equal(QUESTION.length > 20, true)
})
