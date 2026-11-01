/**
 * 本地语音识别（faster-whisper）兼容层测试
 *
 * 真实踩过的坑：PyAV 19 移除了 av.open(metadata_errors=...) 参数，而
 * faster-whisper 1.2.x 还在传 → TypeError: open() got an unexpected keyword
 * argument 'metadata_errors'。表现是「语音识别失败」，但模型其实早就加载好了，
 * 卡在解码这一步，仅凭气泡完全看不出原因。
 *
 * 这里做静态断言：补丁必须存在、必须在导入 WhisperModel 之前套上、必须真的
 * 把不认识的参数吃掉。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.resolve(__dirname, '../resources/bili/asr.py'), 'utf8')

test('asr.py 带 PyAV 兼容层：吃掉 metadata_errors', () => {
  assert.match(SRC, /def _patch_av\s*\(/, '要有 _patch_av 补丁函数')
  assert.match(SRC, /kw\.pop\(\s*["']metadata_errors["']\s*,\s*None\s*\)/, '要把 metadata_errors 参数丢掉')
  assert.match(SRC, /av\.open\s*=\s*open_compat/, '要替换 av.open')
})

test('补丁必须在导入 WhisperModel 之前执行', () => {
  const patchAt = SRC.indexOf('_patch_av()')
  const importAt = SRC.indexOf('from faster_whisper import WhisperModel')
  assert.ok(patchAt > -1, 'main() 里要调用 _patch_av()')
  assert.ok(importAt > -1, '要 import WhisperModel')
  assert.ok(patchAt < importAt, '_patch_av() 必须在 faster_whisper 导入前调用')
})

test('补丁可重复执行（重复调用不叠加包装）', () => {
  assert.match(SRC, /_ryza_av_compat/, '要用标记位防重复包装')
})

test('转写失败要有可读错误且只输出一行 JSON', () => {
  // 主进程靠「最后一行 JSON」判定成败，多打一行就可能被误判
  assert.match(SRC, /json\.dumps\(\{"ok": False, "error": str\(e\)\}/, '异常要转成 ok:false 的 JSON')
})

test('语言参数要传到 whisper（中文短句曾被评为英语）', () => {
  assert.match(SRC, /sys\.argv\[3\]/, 'asr.py 要接受第三个参数 = 语言')
  assert.match(SRC, /kw\["language"\] = lang/, '指定语言时要传给 transcribe')
  assert.match(SRC, /initial_prompt/, '要给同语言的开场提示，短句才不容易串语言')

  const call = fs.readFileSync(path.resolve(__dirname, '../src/main/bili/transcribe.js'), 'utf8')
  assert.match(call, /language = 'auto'/, 'transcribeAudioFile 要接受 language')
  assert.match(call, /\[script, filePath, String\(model\), String\(language \|\| 'auto'\)\]/, '命令行要把语言作为第三参数传下去')
})

test('常驻转写服务：模型只加载一次（提速）', () => {
  const servePath = path.resolve(__dirname, '../resources/bili/asr_serve.py')
  assert.ok(fs.existsSync(servePath), 'asr_serve.py 要存在')
  const serve = fs.readFileSync(servePath, 'utf8')
  assert.match(serve, /"ready": True/, '加载完要握手 ready')
  assert.match(serve, /for line in sys\.stdin/, '要按行读请求（常驻）')
  assert.match(serve, /_patch_av\(\)/, '常驻服务同样要 PyAV 兼容补丁')

  const client = fs.readFileSync(path.resolve(__dirname, '../src/main/bili/asr-service.js'), 'utf8')
  assert.match(client, /ensureProc/, '要复用进程而不是每次新起')
  assert.match(client, /IDLE_MS/, '空闲要能自动退出，别长期占内存')
  assert.match(client, /w\.resolve\(\{ ok: false/, '服务关闭时排队的请求要立刻失败，不能挂到超时')
})

/* ---------------- 0.18.0：只认中英日 + 提速参数 ---------------- */

test('识别语言只认中/英/日（主人 2026-10-26 拍板）', () => {
  const serve = fs.readFileSync(path.resolve(__dirname, '../resources/bili/asr_serve.py'), 'utf8')
  assert.match(serve, /ALLOWED_LANGS = \("zh", "en", "ja"\)/, '常量必须是这三种')
  assert.match(serve, /if lang not in ALLOWED_LANGS and det not in ALLOWED_LANGS/, '自动检测判到别的语种要重来')
  assert.match(SRC, /ALLOWED_LANGS/, '一次性脚本同样限制三种语言')
})

test('提速参数：多线程 + 剪尾静音 + 不预测时间戳 + 不带上文', () => {
  const serve = fs.readFileSync(path.resolve(__dirname, '../resources/bili/asr_serve.py'), 'utf8')
  for (const [pat, why] of [
    [/cpu_threads=cpu_threads\(\)/, '要把线程数交给 cpu_threads()（实测 8 线程最快）'],
    [/min_silence_duration_ms=300/, 'VAD 尾巴静音要快剪'],
    [/without_timestamps[\'"]?\s*:\s*True/, '不预测时间戳，少一批解码'],
    [/condition_on_previous_text[\'"]?\s*:\s*False/, '单句识别不需要上文（也防复读）'],
    [/beam_size[\'"]?\s*:\s*1/, '短句用贪心解码']
  ]) {
    assert.match(serve, pat, why)
  }
  assert.match(serve, /return max\(2, min\(8, n - 2\)\)/, '核多的机器上限 8 线程，别把整机吃满')
})

test('模型下载走普通 HTTP（Xet 协议在镜像上 401）', () => {
  const client = fs.readFileSync(path.resolve(__dirname, '../src/main/bili/asr-service.js'), 'utf8')
  assert.match(client, /HF_HUB_DISABLE_XET: '1'/, '常驻服务要关掉 Xet')
  const tr = fs.readFileSync(path.resolve(__dirname, '../src/main/bili/transcribe.js'), 'utf8')
  assert.match(tr, /HF_HUB_DISABLE_XET: '1'/, '一次性脚本路径也要关掉 Xet')
})

test('麦克风断句：静音 900ms 就收尾（原来 1400ms，体感「卡两秒」）', () => {
  const pet = fs.readFileSync(path.resolve(__dirname, '../src/renderer/overlay/pet.js'), 'utf8')
  assert.match(pet, /now - silenceSince > 900/, 'VAD 静音阈值要降到 900ms')
  assert.doesNotMatch(pet, /now - silenceSince > 1400/, '旧的 1400ms 不能再留着')
})
