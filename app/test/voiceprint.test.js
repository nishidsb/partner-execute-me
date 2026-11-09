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

/** 0.48.8：测试音频要有振幅（全零会被静音修剪剪空）且够长（MIN_SEC 提到 1.2、注册闸 1.5） */
function voicePcm (sec) {
  const n = Math.round(16000 * sec)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin(i / 10) * 0.5
  return out
}

test('0.48.8 静音修剪：头尾静音剪掉、峰值自适应阈值、全零不炸', () => {
  const full = new Float32Array(32000) // 2 秒
  for (let i = 4000; i < 28000; i++) full[i] = Math.sin(i / 10) * 0.5 // 中间 1.5s 有声
  const tr = vp.trimSilence(full, 16000)
  assert.equal(tr.samples.length, 24000, '头尾各剪 0.25s')
  assert.ok(Math.abs(tr.sec - 1.5) < 0.01, '有效语音时长正确')
  // 全零：峰值 0 → 阈值 0 → s 走到头 → 空数组不炸
  const z = vp.trimSilence(new Float32Array(16000), 16000)
  assert.equal(z.samples.length, 0)
})

test('0.48.0 诚实降级：没模板/没引擎/太短都如实说，绝不猜', async () => {
  vp.resetForTest()
  vp.configure({ templatePath: path.join(tmpDir(), 'template.json'), modelPath: 'x' })
  // 没引擎
  let r = vp.verifyPcm(voicePcm(2), 16000, 'mic')
  assert.equal(r.ok, false)
  assert.match(r.reason, /引擎没就绪/)
  // 有引擎但音频太短
  vp._setExtractor(fakeExtractor(() => new Array(8).fill(0.1)))
  r = vp.verifyPcm(voicePcm(0.5), 16000, 'mic') // 0.5 秒
  assert.equal(r.ok, false)
  assert.match(r.reason, /太短/)
  // 有引擎、够长、但全是静音（修剪后空）→ 如实说有效语音太短
  r = vp.verifyPcm(new Float32Array(32000), 16000, 'mic') // 2 秒全零
  assert.equal(r.ok, false)
  assert.match(r.reason, /有效语音太短/)
  // 有引擎有音频但没模板、非注册模式 → 诚实说没注册
  r = vp.verifyPcm(voicePcm(2), 16000, 'mic')
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
  const pcm = voicePcm(2) // 2 秒有声
  // 注册两段 A 的声音
  const r1 = vp.verifyPcm(pcm, 16000, 'mic')
  current = E_A2
  const r2 = vp.verifyPcm(pcm, 16000, 'mic')
  assert.equal(r1.enrolled, true)
  assert.equal(r2.samples, 2)
  // 0.48.8 自洽闸：与模板差异太大的样本拒收（E_B 与 E_A 余弦=0）
  current = E_B
  const r3 = vp.verifyPcm(pcm, 16000, 'mic')
  assert.equal(r3.ok, false)
  assert.match(r3.reason, /差异太大/)
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
  assert.ok(src.includes('async function transcribe (base64, mime, pcmB64, via)'), 'transcribe 收 PCM + via 第四参（0.48.5 口来源）')
  assert.ok(src.includes('voiceprint.verifyPcm(f32, voiceprint.TARGET_SR'), 'PCM 转 Float32 后验声纹')
  assert.ok(src.includes("voice: () => { try { return voiceprint.block()"), 'chatter deps 注入 voice')
  assert.ok(src.includes("key: 'voice', priority: 50"), '回复 sections 注入 voice 段')
  assert.ok(src.includes('voiceprintEnroll: false'), '注册满 3 段自动收闸')
  const chat = fs2.readFileSync(path.join(__dirname, '../src/main/companion/chatter.js'), 'utf8')
  assert.ok(chat.includes('const voice = deps.voice || (() => \'\')'), 'chatter 接收 voice dep')
  assert.ok(chat.includes('voiceLine ? [{ role: \'system\''), 'decide 注入声纹判定段')
  const pet = fs2.readFileSync(path.join(__dirname, '../src/renderer/overlay/pet.js'), 'utf8')
  assert.ok(pet.includes("petTranscribe(b64, 'audio/webm', pcmB64, 'pet')"), '渲染层 PCM 伴随 webm 上送（via=pet）')
  assert.ok(pet.includes('function vpAttach ()'), 'ScriptProcessor 连续采集挂载')
  const pre = fs2.readFileSync(path.join(__dirname, '../src/preload/overlay.js'), 'utf8')
  assert.ok(pre.includes('(b64, mime, pcmB64, via)'), 'preload 透传 PCM + via 参数')
  // 0.48.1 面板按键说话同款接线（15:32 主人走面板说话零声纹日志的缺口）
  const panel = fs2.readFileSync(path.join(__dirname, '../src/renderer/companion/app.js'), 'utf8')
  assert.ok(panel.includes("transcribe(b64, 'audio/webm', pcmB64, 'panel')"), '面板 transcribe 也带 PCM（via=panel）')
  assert.ok(panel.includes('createScriptProcessor'), '面板也有 ScriptProcessor 采集')
  assert.ok(panel.includes('✓ 他的声音'), '面板展示声纹判定（诚实显示）')
  // 0.48.2 主进程链透传：handle 收第三参、队列 job 带 pcm、pump 喂 transcribe
  // （0.48.1 真机实锤：preload 传了、transcribe 也收，但 handle/队列两层都丢参，声纹零日志）
  const main = fs2.readFileSync(path.join(__dirname, '../src/main/companion/index.js'), 'utf8')
  assert.ok(main.includes("async (_e, base64, mime, pcmB64, via)"), 'handle 透传 PCM + via')
  assert.ok(main.includes('transcribeQueued(base64, mime, pcmB64, via)'), 'handle → 队列带 PCM + via')
  assert.ok(main.includes('transcribe(job.base64, job.mime, job.pcm, job.via)'), 'pump → transcribe 带 PCM + via')
  assert.ok(main.includes('pcm: pcmB64, via,'), '队列 job 存 via（0.48.5 中间层丢参教训锁死）')
  assert.ok(main.includes("判定：' + r.speaker"), '判定成功也留痕（0.48.4 真机零日志教训）')
  assert.ok(main.includes('这句没带 PCM'), 'PCM 缺失提示（静默跳过=无法诊断）')
  // 0.48.5 口来源区分：桌宠 pet / 面板 panel，日志可分诊
  assert.ok(pet.includes("pcmB64, 'pet')"), '桌宠口 via=pet')
  assert.ok(panel.includes("pcmB64, 'panel')"), '面板口 via=panel')
})

test('0.48.0 隐私红线：模板只存嵌入向量，不存任何音频字节', () => {
  vp.resetForTest()
  const dir = tmpDir()
  vp.configure({ templatePath: path.join(dir, 'template.json'), modelPath: 'x', enroll: true })
  vp._setExtractor(fakeExtractor(() => new Array(8).fill(0.5)))
  vp.verifyPcm(voicePcm(2), 16000, 'mic')
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

test('0.48.11 质心参考项：sim 取「单段 max」与「质心」的较高者（0.66 maybe 实锤的修正）', () => {
  vp.resetForTest()
  const dir = tmpDir()
  vp.configure({ templatePath: path.join(dir, 'template.json'), modelPath: 'x', enroll: true })
  const E_A = [1, 0, 0, 0, 0, 0, 0, 0]
  const E_A2 = [0.9, 0.1, 0, 0, 0, 0, 0, 0]
  let current = E_A
  vp._setExtractor(fakeExtractor(() => current))
  const pcm = voicePcm(2) // 2 秒有声（全零会被静音闸拒）
  vp.verifyPcm(pcm, 16000, 'mic')
  current = E_A2
  vp.verifyPcm(pcm, 16000, 'mic')
  // 重开验证模式（enroll 自动收闸）
  vp.configure({ templatePath: path.join(dir, 'template.json'), modelPath: 'x' })
  // 现在喂「两段的平均」：对单段最高 0.9987，对质心=1.0——只有质心参与才能 >0.999
  current = [0.95, 0.05, 0, 0, 0, 0, 0, 0]
  const v = vp.verifyPcm(pcm, 16000, 'mic')
  assert.equal(v.ok, true)
  assert.ok(v.sim > 0.999, '质心参考项应把 sim 抬到 1.0（只对单段最高只有 0.9987），实际 ' + v.sim)
  // centroidOf 单元：两向量的归一化前平均
  const c = vp.centroidOf([[2, 0], [0, 2]])
  assert.deepEqual(c, [1, 1])
})

test('0.49.1 查询侧门槛 0.7s：0.9 秒短句不再被扔（注册侧 1.2 闸不动）', () => {
  vp.resetForTest()
  vp.configure({ templatePath: path.join(tmpDir(), 'template.json'), modelPath: 'x' })
  vp._setExtractor(fakeExtractor(() => new Array(8).fill(0.1)))
  // 查询：0.9 秒（真机 20:40 实锤被 1.2 拦掉刷屏的形状）→ 过门槛，走到「没模板」
  const r = vp.verifyPcm(voicePcm(0.9), 16000, 'mic')
  assert.equal(r.ok, false)
  assert.ok(!/太短/.test(r.reason), '0.9s 查询不该再报太短，实际：' + r.reason)
  assert.match(r.reason, /没.*注册|模板/)
  // 注册：同样 0.9 秒仍被模板质量闸拦（注册样本必须 ≥1.5s 有效语音）
  vp.configure({ enroll: true })
  const r2 = vp.verifyPcm(voicePcm(0.9), 16000, 'mic')
  assert.equal(r2.ok, false)
  assert.ok(/太短|注册/.test(r2.reason), '注册闸保持 1.2/1.5，实际：' + r2.reason)
})
