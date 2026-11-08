/**
 * 0.46.77 三修静态接线测试：
 *  - 连发根治：语音播完回传链（petBridge seq/waitVoiceDone → preload petVoiceDone →
 *    pet.js voiceSettle 回传）+ chatter 独白/soliEmitter 自语等真播完
 *  - 乱码守卫修复并铺全链：0.46.76 的 detangleCloseLine 读 cfg.baseUrl/cfg.model，
 *    而宿主 cfgGet() 给的是 apiBaseUrl/apiModel → chatOnce 每次抛错被 catch 吞掉，
 *    守卫在真机上一次都没真正重写过（静默失败）。修字段兼容 + 铺到回复/闹钟/冷落三链
 *  - 镜子文案补「追问限一次」
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const APP = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8')

test('0.46.77 petBridge：say 带 seq + 播完回传监听 + waitVoiceDone 导出', () => {
  const src = read('src/main/petBridge.js')
  assert.ok(/kind: 'say', seq, text/.test(src), 'pet:cmd say 载荷必须带自增 seq')
  assert.ok(/const seq = \+\+saySeq/.test(src), 'saySeq 自增')
  assert.ok(/pet:voice-done/.test(src), '主进程监听 pet:voice-done')
  assert.ok(/function waitVoiceDone/.test(src), 'waitVoiceDone 定义')
  assert.ok(/waitVoiceDone, isQuiet/.test(src), 'waitVoiceDone 必须 exports')
  assert.ok(/ipcMain\.on\('pet:voice-done'/.test(src), 'ipcMain 注册播完回传')
  assert.ok(/if \(ei && ei\.ipcMain\)/.test(src), '0.47.0 环境闸：纯 node（单测）下不注册，模块可安全 require')
})

test('0.46.77 preload + pet.js：渲染层把 voiceSettle 回传主进程', () => {
  const pre = read('src/preload/overlay.js')
  assert.ok(/petVoiceDone: \(payload\) => ipcRenderer\.send\('pet:voice-done'/.test(pre), 'preload 上行通道')
  const pet = read('src/renderer/overlay/pet.js')
  assert.ok(/petVoiceDone\(\{ seq: voiceSettleSeq \}\)/.test(pet), 'settleVoice 回传 seq')
  assert.ok(/voiceSettleSeq = curSaySeq/.test(pet), '语音启动时记下属于哪句 say')
  assert.ok(/curSaySeq = Number\(cmd\.seq\) \|\| 0/.test(pet), 'say case 收 cmd.seq')
})

test('0.46.77 chatter：多句循环等真播完（deps.waitVoiceDone）', () => {
  const src = read('src/main/companion/chatter.js')
  assert.ok(/const waitVoiceDone = deps\.waitVoiceDone \|\|/.test(src), 'waitVoiceDone 从 deps 注入')
  assert.ok(/await waitVoiceDone\(rr\.seq, estMs \+ 6000\)/.test(src), '信号等播完')
  assert.ok(/if \(!done\) await new Promise/.test(src), '信号没来退回估时等待')
  const host = read('src/main/companion/index.js')
  assert.ok(host.includes("waitVoiceDone: (seq, ms) => { try { return require('../petBridge').waitVoiceDone(seq, ms)"), '宿主两处接线（chatter/autonomy）')
  assert.ok((host.match(/waitVoiceDone: \(seq, ms\)/g) || []).length >= 2, 'chatter 与 autonomy deps 都要有')
})

test('0.46.77 自语多句连发守：soliEmitter 句间等待 + onSoliloquy 回传 rr', () => {
  const src = read('src/main/companion/autonomy.js')
  assert.ok(/typeof opt\.waitVoiceDone === 'function'/.test(src), 'soliEmitter 等真播完')
  assert.ok(/rr && rr\.speech && rr\.seq/.test(src), '只在朗读开着时等信号')
  const host = read('src/main/companion/index.js')
  assert.ok(/return await sayNarration\(t, \{ speech: narrationVoiceOn\(\) \}\)/.test(host), 'onSoliloquy 回传 rr（含 speech/seq）')
})

test('0.46.77 乱码守卫字段修复：apiBaseUrl 兼容 + 假名注音信号 + 失败留痕', () => {
  const src = read('src/main/companion/autonomy.js')
  assert.ok(/cfg\.baseUrl \|\| cfg\.apiBaseUrl/.test(src), '字段兼容（0.46.76 静默失败根因）')
  assert.ok(/cfg\.model \|\| cfg\.apiModel/.test(src), 'model 字段同样兼容')
  assert.ok(/KANA_RUBY_RE/.test(src), '假名注音括注信号（16:33「九十（かな）分」）')
  assert.ok(/乱码重写失败（保留原文）/.test(src), '失败必须留痕（老坑 4）')
  assert.ok(/detangleCloseLine, garbledJa,/.test(src), 'exports 供回复/闹钟链共用')
})

test('0.46.77 乱码守卫铺全链：回复/闹钟/冷落三处都过守卫', () => {
  const assistant = read('src/main/assistant/index.js')
  assert.ok(/lang\.reply === 'ja' && r\.content/.test(assistant), 'assistant 回复链挂守卫')
  assert.ok(assistant.includes("require('../companion/autonomy').detangleCloseLine"), '走同一个守卫函数')
  const host = read('src/main/companion/index.js')
  const guardCalls = (host.match(/detangleCloseLine\(/g) || []).length
  assert.ok(guardCalls >= 2, '闹钟链 + 冷落链都挂守卫（实得 ' + guardCalls + '）')
  assert.ok(host.includes("require('./autonomy').detangleCloseLine(line, cfg(), log)"), 'alarmLine 过守卫')
})

test('0.46.77 镜子文案补「追问限一次」', () => {
  const host = read('src/main/companion/index.js')
  const n = (host.match(/最多追问一次/g) || []).length
  assert.ok(n >= 2, '两条链的镜子文案都要有（实得 ' + n + '）')
})
