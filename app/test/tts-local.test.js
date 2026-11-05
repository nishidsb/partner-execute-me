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

// ── 0.46.39 IndexTTS 长句分片 ──

test('0.46.39 splitForIndexTts：短句原样一片、长句全部 ≤50 且内容一字不丢', () => {
  assert.deepEqual(ttsLocal.splitForIndexTts('今天天气不错。'), ['今天天气不错。'])
  assert.deepEqual(ttsLocal.splitForIndexTts(''), [])
  assert.deepEqual(ttsLocal.splitForIndexTts('   '), [])
  // 499 字（11-02 真机阵亡的长度）
  const long = '这句话是用来测试的。'.repeat(49).slice(0, 499)
  const chunks = ttsLocal.splitForIndexTts(long)
  assert.ok(chunks.length >= 10, '499 字应拆成多片: ' + chunks.length)
  for (const c of chunks) assert.ok(c.length <= ttsLocal.INDEX_TTS_CHUNK_MAX, '每片 ≤50: ' + c.length)
  assert.equal(chunks.join(''), long, '内容一字不丢')
})

test('0.46.39 splitForIndexTts：优先句末标点断句，无标点才硬切', () => {
  const s = '第一句话在这里。第二句话也在这里。第三句更长一些但还没到上限呢。第四句收尾。'
  const chunks = ttsLocal.splitForIndexTts(s, 16)
  assert.ok(chunks.every((c) => /[。！？…]|.$/.test(c)), '每片要么以句号收、要么是硬切尾')
  assert.equal(chunks.join(''), s)
  // 无任何标点：按 maxLen 硬切
  const hard = 'あ'.repeat(120)
  const hc = ttsLocal.splitForIndexTts(hard, 50)
  assert.equal(hc.length, 3)
  assert.ok(hc.every((c) => c.length <= 50))
})

test('0.46.39 长句合成走分片：逐片调用、PCM 按序拼接、单次请求 ≤8 片', async () => {
  const calls = []
  ttsLocal._setEnsureServer(async () => 9891)
  ttsLocal._setPostTts(async (port, text) => {
    calls.push(text)
    // 每片 5 秒音频的假 PCM（640 字节/秒·16bit·32k，须 ≥2000 过空结果线）
    return Buffer.alloc(3200, (calls.length % 251) + 1)
  })
  const long = '第一句。'.repeat(30).slice(0, 120)   // 120 字 → 3 片左右
  const r = await ttsLocal.synthesize(long, 'zh', () => ({}))
  assert.equal(r.ok, true)
  assert.ok(calls.length >= 2 && calls.length <= ttsLocal.INDEX_TTS_CHUNK_LIMIT, '分了片: ' + calls.length)
  assert.equal(calls.join(''), long, '逐片内容合起来 = 原文')
  // wav 里 data 块 = 各片 PCM 之和
  const fs = require('fs')
  const { fileURLToPath } = require('node:url')
  const wav = fs.readFileSync(fileURLToPath(r.url))
  assert.equal(wav.readUInt32LE(40), 3200 * calls.length, 'data 块长 = 片数 × 每片 PCM')
  ttsLocal._setPostTts(null)
  ttsLocal._setEnsureServer(null)
})

test('0.46.39 超长截断：600 字只合成前 8 片，绝不无限排队', async () => {
  const calls = []
  ttsLocal._setEnsureServer(async () => 9891)
  ttsLocal._setPostTts(async (port, text) => {
    calls.push(text)
    return Buffer.alloc(3200, 7)
  })
  const veryLong = '念不完的一句话呢。'.repeat(70)   // 630 字
  const r = await ttsLocal.synthesize(veryLong, 'zh', () => ({}))
  assert.equal(r.ok, true)
  assert.equal(calls.length, ttsLocal.INDEX_TTS_CHUNK_LIMIT, '恰好 8 片封顶')
  ttsLocal._setPostTts(null)
  ttsLocal._setEnsureServer(null)
})

test('0.46.39 分片中途失败：报哪一片，不留半截结果', async () => {
  let n = 0
  ttsLocal._setEnsureServer(async () => 9891)
  ttsLocal._setPostTts(async () => {
    n++
    if (n === 2) throw new Error('第 2 片炸了')
    return Buffer.alloc(3200, 5)
  })
  const long = '这一句要分好几片。'.repeat(12)
  await assert.rejects(
    () => ttsLocal.synthesize(long, 'zh', () => ({})),
    /第 2 片/,
    '失败信息要指明第几片'
  )
  ttsLocal._setPostTts(null)
  ttsLocal._setEnsureServer(null)
})
