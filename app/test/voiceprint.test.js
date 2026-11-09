'use strict'
/** 0.48.0 声纹识别回归：纯函数判定 + 模板存取 + 诚实降级 + 接线锁死。
 *  引擎本体（sherpa-onnx-node + ERes2Net）不进测试——全部用假引擎注入。 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const vp = require('../src/main/companion/voiceprint')

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vp-test-'))
}

function fakeExtractor (embOf) {
  // 只需要 createStream/acceptWaveform/inputFinished/compute 这条链
  return {
    dim: 8,
    createStream () {
      let w = null
      return {
        acceptWaveform ({ samples }) { w = samples },
        inputFinished () { },
        _w: () => w
      }
    },
    compute (st, noExternalBuffer) {
      // 0.48.4 锁死：Electron ≥21 下 compute 必须第二参 false（V8 内存笼拒绝 external buffer）
      if (noExternalBuffer !== false) throw new Error('External buffers are not allowed')
      return embOf(st._w())
    }
  }
}

test('0.48.0 余弦相似度与判定阈值', () => {
  const a = [1, 0, 0, 2]
  const b = [2, 0, 0, 4]
  const c = [0, 1, 0, 0]
  assert.ok(Math.abs(vp.cosine(a, b) - 1) < 1e-9, '同向=1')
  assert.ok(Math.abs(vp.cosine(a, c)) < 1e-9, '正交=0')
  vp.configure({ same: 0.72, maybe: 0.55 })
  assert.equal(vp.judge(0.9), 'owner')
  assert.equal(vp.judge(0.72), 'owner')
  assert.equal(vp.judge(0.6), 'maybe')
  assert.equal(vp.judge(0.3), 'other')
  assert.equal(vp.judge(NaN), 'other')
})

test('0.48.0 重采样：长度按比例、数值单调（线性插值）', () => {
  const src = new Float32Array(48000) // 1 秒 @48k
  for (let i = 0; i < src.length; i++) src[i] = Math.sin(i / 100)
  const out = vp.resampleLinear(src, 48000, 16000)
  assert.equal(out.length, 16000)
  assert.ok(Math.abs(out[100] - Math.sin(100 * 3 / 100)) < 0.1, '位置对得上（粗校）')
  const same = vp.resampleLinear(src, 16000, 16000)
  assert.equal(same.length, 48000, '同采样率原样返回')
})

test('0.48.0 诚实降级：没模板/没引擎/太短都如实说，绝不猜', async () => {
  vp.resetForTest()
  vp.configure({ templatePath: path.join(tmpDir(), 'template.json'), modelPath: 'x' })
  // 没引擎
  let r = vp.verifyPcm(new Float32Array(16000), 16000, 'mic')
  assert.equal(r.ok, false)
  assert.match(r.reason, /引擎没就绪/)
  // 有引擎但音频太短
  vp._setExtractor(fakeExtractor(() => new Array(8).fill(0.1)))
  r = vp.verifyPcm(new Float32Array(8000), 16000, 'mic') // 0.5 秒
  assert.equal(r.ok, false)
  assert.match(r.reason, /太短/)
  // 有引擎有音频但没模板、非注册模式 → 诚实说没注册
  r = vp.verifyPcm(new Float32Array(16000), 16000, 'mic')
  assert.equal(r.ok, false)
  assert.match(r.reason, /还没注册声纹模板/)
})

test('0.48.0 注册→验证全链：模板落盘可重载，owner/maybe/other 判定正确', () => {
  vp.resetForTest()
  const dir = tmpDir()
  vp.configure({ templatePath: path.join(dir, 'template.json'), modelPath: 'x', enroll: true })
  const E_A = [1, 0, 0, 0, 0, 0, 0, 0]
  const E_A2 = [0.9, 0.1, 0, 0, 0, 0, 0, 0]
  const E_B = [0, 1, 0, 0, 0, 0, 0, 0]
  let current = E_A
  vp._setExtractor(fakeExtractor(() => current))
  const pcm = new Float32Array(16000)
  // 注册两段 A 的声音
  const r1 = vp.verifyPcm(pcm, 16000, 'mic')
  current = E_A2
  const r2 = vp.verifyPcm(pcm, 16000, 'mic')
  assert.equal(r1.enrolled, true)
  assert.equal(r2.samples, 2)
  // 模板已落盘且可重载
  assert.ok(fs.existsSync(path.join(dir, 'template.json')))
  vp.resetForTest()
  vp.configure({ templatePath: path.join(dir, 'template.json'), modelPath: 'x' })
  assert.equal(vp.status().enrolled, true, '重启后模板还在（loadTemplate）')
  vp._setExtractor(fakeExtractor(() => current)) // resetForTest 连假引擎一起清了，重新注入
  // A 的声音 → owner
  current = E_A2
  let v = vp.verifyPcm(pcm, 16000, 'mic')
  assert.equal(v.ok, true)
  assert.equal(v.speaker, 'owner')
  assert.ok(v.sim > 0.72)
  // 不像的 → other
  current = E_B
  v = vp.verifyPcm(pcm, 16000, 'mic')
  assert.equal(v.speaker, 'other')
  // block()：3 分钟内的判定可以注入
  assert.ok(vp.block().includes('不是他'), '刚验完 → 有注入行')
})

test('0.48.0 接线锁死：transcribe 带 PCM 验声纹、chatter/reply 两处注入、注册满 3 段收闸', () => {
  const fs2 = require('node:fs')
  const src = fs2.readFileSync(path.join(__dirname, '../src/main/companion/index.js'), 'utf8')
  assert.ok(src.includes('async function transcribe (base64, mime, pcmB64)'), 'transcribe 收第三个参数 PCM')
  assert.ok(src.includes('voiceprint.verifyPcm(f32, voiceprint.TARGET_SR'), 'PCM 转 Float32 后验声纹')
  assert.ok(src.includes("voice: () => { try { return voiceprint.block()"), 'chatter deps 注入 voice')
  assert.ok(src.includes("key: 'voice', priority: 50"), '回复 sections 注入 voice 段')
  assert.ok(src.includes('voiceprintEnroll: false'), '注册满 3 段自动收闸')
  const chat = fs2.readFileSync(path.join(__dirname, '../src/main/companion/chatter.js'), 'utf8')
  assert.ok(chat.includes('const voice = deps.voice || (() => \'\')'), 'chatter 接收 voice dep')
  assert.ok(chat.includes('voiceLine ? [{ role: \'system\''), 'decide 注入声纹判定段')
  const pet = fs2.readFileSync(path.join(__dirname, '../src/renderer/overlay/pet.js'), 'utf8')
  assert.ok(pet.includes('petTranscribe(b64, \'audio/webm\', pcmB64)'), '渲染层 PCM 伴随 webm 上送')
  assert.ok(pet.includes('function vpAttach ()'), 'ScriptProcessor 连续采集挂载')
  const pre = fs2.readFileSync(path.join(__dirname, '../src/preload/overlay.js'), 'utf8')
  assert.ok(pre.includes('(b64, mime, pcmB64)'), 'preload 透传 PCM 参数')
  // 0.48.1 面板按键说话同款接线（15:32 主人走面板说话零声纹日志的缺口）
  const panel = fs2.readFileSync(path.join(__dirname, '../src/renderer/companion/app.js'), 'utf8')
  assert.ok(panel.includes("transcribe(b64, 'audio/webm', pcmB64)"), '面板 transcribe 也带 PCM')
  assert.ok(panel.includes('createScriptProcessor'), '面板也有 ScriptProcessor 采集')
  assert.ok(panel.includes('✓ 他的声音'), '面板展示声纹判定（诚实显示）')
  // 0.48.2 主进程链透传：handle 收第三参、队列 job 带 pcm、pump 喂 transcribe
  // （0.48.1 真机实锤：preload 传了、transcribe 也收，但 handle/队列两层都丢参，声纹零日志）
  const main = fs2.readFileSync(path.join(__dirname, '../src/main/companion/index.js'), 'utf8')
  assert.ok(main.includes("async (_e, base64, mime, pcmB64)"), 'handle 透传 PCM 第三参')
  assert.ok(main.includes('transcribeQueued(base64, mime, pcmB64)'), 'handle → 队列带 PCM')
  assert.ok(main.includes('transcribe(job.base64, job.mime, job.pcm)'), 'pump → transcribe 带 PCM')
})

test('0.48.0 隐私红线：模板只存嵌入向量，不存任何音频字节', () => {
  vp.resetForTest()
  const dir = tmpDir()
  vp.configure({ templatePath: path.join(dir, 'template.json'), modelPath: 'x', enroll: true })
  vp._setExtractor(fakeExtractor(() => new Array(8).fill(0.5)))
  vp.verifyPcm(new Float32Array(16000), 16000, 'mic')
  const raw = fs.readFileSync(path.join(dir, 'template.json'), 'utf8')
  const j = JSON.parse(raw)
  assert.ok(j.embs && j.embs.length === 1 && j.dim === 8, '只有嵌入')
  assert.ok(!raw.includes('pcm') && !raw.includes('webm') && !raw.includes('audio'), '模板里没有任何音频痕迹')
  // 撤回
  vp.deleteTemplate()
  assert.equal(vp.status().enrolled, false, 'deleteTemplate 一键撤回')
})

test('0.48.3 pcmFromB64：base64 解码不许产出空数组（15:57 真机「跳过：没有音频」的根因）', () => {
  // 1 秒 16k 正弦 → Int16 → b64 → 解码回来必须满长度、幅值正确
  const n = 16000
  const src = new Float32Array(n)
  for (let i = 0; i < n; i++) src[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / 16000)
  const i16 = new Int16Array(n)
  for (let i = 0; i < n; i++) i16[i] = src[i] < 0 ? src[i] * 0x8000 : src[i] * 0x7fff
  const b64 = Buffer.from(new Uint8Array(i16.buffer)).toString('base64')
  const out = vp.pcmFromB64(b64)
  assert.equal(out.length, n, '解码长度必须等于样本数（不是 0，也不是字节数）')
  assert.ok(Math.abs(out[100]) > 0.1, '幅值还原正确（-1~1）')
  assert.equal(vp.pcmFromB64('').length, 0, '空输入 → 空（调用方诚实降级）')
  assert.equal(vp.pcmFromB64('QQ==').length, 0, '单字节不足 2 字节 → 空（凑不出一个 Int16，诚实降级）')
  assert.equal(vp.pcmFromB64('QQID').length, 1, '3 字节 → 1 样本（向下取整不炸）')
  // 主进程不许再用 Int16Array.from(...buffer) 的坏写法
  const main = fs.readFileSync(path.join(__dirname, '../src/main/companion/index.js'), 'utf8')
  assert.ok(!main.includes('Int16Array.from(Buffer.from'), '坏解码写法已清除')
  assert.ok(main.includes('voiceprint.pcmFromB64(pcmB64)'), 'transcribe 用单测固化的解码函数')
})
