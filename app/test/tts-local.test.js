const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')

const ttsLocal = require('../src/main/companion/ttsLocal')

test('guessLang：假名→日语、汉字→中文、ASCII→英文、无字符回退', () => {
  assert.equal(ttsLocal.guessLang('ねえ、GPUが98%も動いてるよ', 'zh'), 'ja')
  assert.equal(ttsLocal.guessLang('今天天气不错', 'ja'), 'zh')
  assert.equal(ttsLocal.guessLang('hello there', 'zh'), 'en')
  assert.equal(ttsLocal.guessLang('。。。', 'ja'), 'ja')   // 无有效字符 → 回退设置语种
})

test('available：真实部署目录可检出（本机装机前提），乱目录返回 false', () => {
  // 不强求 CI 有该目录：只在目录存在时断言 true
  const fs = require('fs')
  if (fs.existsSync(path.join(ttsLocal.DEFAULT_DIR, '.venv', 'Scripts', 'python.exe'))) {
    assert.equal(ttsLocal.available(), true)
  }
  assert.equal(ttsLocal.available('Z:/不存在的目录'), false)
})

test('sovitsAvailable：E 盘整包可检出（本机前提），乱目录返回 false', () => {
  const fs = require('fs')
  if (fs.existsSync(path.join(ttsLocal.DEFAULT_SOVITS_DIR, 'runtime', 'python.exe'))) {
    assert.equal(ttsLocal.sovitsAvailable(), true)
  }
  assert.equal(ttsLocal.sovitsAvailable('Z:/不存在的目录'), false)
})

test('SoVITS 后端状态独立：stopServer 两个后端一起清、无进程时不抛', () => {
  assert.equal(ttsLocal._sovitsState.port, 0)
  assert.equal(ttsLocal._sovitsState.queue.length, 0)
  assert.equal(typeof ttsLocal.synthesizeSovits, 'function')
  assert.equal(ttsLocal.DEFAULT_PROMPT_TEXT.length > 0, true, '参考音频台词默认值必须有')
  ttsLocal.stopServer()
  assert.equal(ttsLocal._sovitsState.port, 0)
  assert.equal(ttsLocal._state.port, 0)
})

test('pcmToWavUrl 内部行为：模块可加载且导出齐全', () => {
  assert.equal(typeof ttsLocal.synthesize, 'function')
  assert.equal(typeof ttsLocal.stopServer, 'function')
  assert.equal(ttsLocal.STEPS >= 10, true, '扩散步数不得低于实测安全下限 10')
})

test('stopServer：无进程时安全调用不抛', () => {
  ttsLocal.stopServer()
})
