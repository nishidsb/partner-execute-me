/**
 * 0.18.0 第二批 · 全局说话键 / 打字键
 * 只验接线与默认值（真按热键得在真机上）；顺带保证四个快捷键默认互不撞车。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

const ACC = /^(?:(?:Control|Alt|Shift|Super)\+)+(?:[A-Z0-9]|F\d{1,2}|Space|Return|Up|Down|Left|Right|Plus|Tab|Escape)$/

test('默认快捷键：说话键 / 打字键存在、格式合法、四个键互不重复', () => {
  const store = read('main/store.js')
  for (const k of ['hotkeyToggle', 'hotkeySettings', 'hotkeyTalk', 'hotkeyType']) {
    assert.match(store, new RegExp(k + ": '"), '缺少默认值：' + k)
  }
  const vals = {}
  for (const k of ['hotkeyToggle', 'hotkeySettings', 'hotkeyTalk', 'hotkeyType']) {
    const m = store.match(new RegExp(k + ": '([^']+)'"))
    vals[k] = m[1]
    assert.match(m[1], ACC, k + ' 不是合法 Accelerator：' + m[1])
  }
  const uniq = new Set(Object.values(vals))
  assert.equal(uniq.size, 4, '四个快捷键不能重复：' + JSON.stringify(vals))
})

test('主进程：注册两个热键 + 广播命令 + 被藏起来时先放出来', () => {
  const m = read('main/main.js')
  assert.match(m, /g\.hotkeyType/, '要注册打字键')
  assert.match(m, /g\.hotkeyTalk/, '要注册说话键')
  assert.match(m, /kind: 'open-input'/, '打字键要发 open-input')
  assert.match(m, /kind: 'mic-toggle'/, '说话键要发 mic-toggle')
  assert.match(m, /function bcastOverlay/, '要有覆盖层广播')
  assert.match(m, /function showOverlaysIfHidden/, '藏起来时要先放出来')
  assert.match(m, /'hotkeyTalk' in patch/, '改快捷键后要重新注册')
})

test('渲染层：桌宠收到命令后弹出输入条 / 切换麦克风', () => {
  const pet = read('renderer/overlay/pet.js')
  assert.match(pet, /case 'open-input'/, '要处理打字键')
  assert.match(pet, /case 'mic-toggle'/, '要处理说话键')
  assert.match(pet, /petChatInput/, '打字键要聚焦输入框')
  assert.match(pet, /petMic'\)/, '说话键要复用麦克风按钮')
})

test('角色设置：两个新快捷键有输入框与保存按钮（0.22.0 补丁⑥迁入）', () => {
  const html = read('renderer/companion/index.html')
  const js = read('renderer/companion/app.js')
  assert.match(html, /id="cpHkTalk"/)
  assert.match(html, /id="cpHkType"/)
  assert.match(html, /id="cpHkToggle"/)
  assert.match(js, /cpHkTalk/, 'app.js 要接线说话键')
  assert.match(js, /cpHkType/, 'app.js 要接线打字键')
  assert.match(js, /hotkeyTalk/, '保存要走 settings:patch-global')
  // AuraDesk 残留设置窗口已删，不允许再回来
  assert.equal(fs.existsSync(path.join(SRC, 'renderer', 'settings')), false, 'renderer/settings 目录应已删除')
  assert.equal(fs.existsSync(path.join(SRC, 'preload', 'settings.js')), false, 'preload/settings.js 应已删除')
})
