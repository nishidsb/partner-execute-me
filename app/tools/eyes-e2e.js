#!/usr/bin/env node
/* 0.45.66 眼睛端到端实测：截当前真实屏幕 → 走修复后的提示词链路 → 看她怎么回答。
 *
 * 为什么要这个脚本：0.45.64 之后我一直用「日志里有附图」当证据，用户直接说「你的
 * 测试是假测试」。这个不假：它跑的是真实的 desktopCapturer + 真实的 system 提示段 +
 * 真实的模型，输出就是她此刻会说的话。看不见就是看不见，编/装都能一眼看出来。
 *
 * 跑法（必须用 electron，不能用 node）：
 *   env -u ELECTRON_RUN_AS_NODE npx electron tools/test-eyes-e2e.js
 * 想自己指定问题：加 --ask "我屏幕上是什么"
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

const origLoad = Module._load
Module._load = function (req) {
  if (/(^|\/)logger$/.test(String(req))) return { log: () => {} }
  return origLoad.apply(this, arguments)
}

const { app, desktopCapturer, screen } = require('electron')

const ASK = (() => {
  const i = process.argv.indexOf('--ask')
  return i >= 0 ? process.argv[i + 1] : '我屏幕上现在是什么？说具体点——看得见什么内容、什么文字，别只报程序名。'
})()

function loadCfg () {
  const p = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'ryza-assistant-app', 'config.json')
  const g = (JSON.parse(fs.readFileSync(p, 'utf8')).global || {}).companion || {}
  return { baseUrl: g.apiBaseUrl || 'https://api.deepseek.com/v1', apiKey: g.apiKey || '', model: g.apiModel || 'deepseek-flash' }
}

async function grab () {
  const primary = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1600, height: Math.round(1600 * primary.size.height / Math.max(1, primary.size.width)) }
  })
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0]
  const jpg = src.thumbnail.toJPEG(85)
  return { b64: jpg.toString('base64'), bytes: jpg.length }
}

app.whenReady().then(async () => {
  const c = loadCfg()
  const llm = require(path.join(__dirname, '..', 'src', 'main', 'companion', 'llm.js'))
  const shot = await grab()
  console.log('截图: ' + Math.round(shot.bytes / 1024) + 'KB（' + Math.round(shot.b64.length / 1024) + 'KB base64）')
  const out = path.join(os.tmpdir(), 'eyes-e2e-shot.jpg')
  fs.writeFileSync(out, Buffer.from(shot.b64, 'base64'))
  console.log('存了一份方便对照: ' + out)

  // 复刻 systemPrompt 里和「眼睛」相关的两段（0.45.66 版），其余段落与本测试无关
  const system = [
    '你是莱莎，主人电脑上的桌面伴侣。说话自然、简短，像真的在他旁边。',
    '【你的眼睛·重要】你能真的看到主人的屏幕：这一轮你会收到一张【此刻】的截图（多模态输入）。\n' +
    '硬规则：\n' +
    '1. 问到屏幕内容，一律以这张截图为准。\n' +
    '2. 「知道开了什么程序」（窗口标题）只是标签不是画面。\n' +
    '3. 屏幕内容是此时此刻的，历史对话和记忆里的旧画面都会过期，冲突时以这张图为准。\n' +
    '4. 描述画面像真的在眼前看到一样自然，别提「工具」「截图」这些字眼。\n' +
    '5. 看不清的细节就说看不清，别拿记忆补。\n' +
    '6. 如果你以前说过「我看不到画面」，那是当时接口的毛病，现在能看见了，别沿用旧说法。'
  ].join('\n\n')

  const t0 = Date.now()
  const res = await llm.chatStream({
    baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model,
    temperature: 0.8,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: '（你抬头看了一眼屏幕，这是【此刻】的画面。只有这张图里出现的东西才算真的。）' }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: ASK },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + shot.b64 } }
        ]
      }
    ],
    onDelta: () => {}
  })
  console.log('\n耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')
  console.log('问: ' + ASK)
  console.log('\n她的回答:\n' + String(res.content || '(空)'))
  app.quit()
}).catch((e) => { console.error('失败: ' + (e && e.message)); app.quit() })
