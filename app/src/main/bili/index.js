/**
 * 刷 B 站（S8-M1）：主进程 IPC 壳。
 * 职责只有接线：bili:* 命名空间 → duty runner / client；业务全在 duty.js / client.js。
 */
const { ipcMain } = require('electron')
const path = require('path')
const { shell } = require('electron')
const client = require('./client')
const duty = require('./duty')
const { log } = require('../logger')

let runner = null
let getProviderFn = null

/**
 * @param {object} opts
 * @param {string} opts.dataRoot  应用数据目录（app.getPath('userData')）
 * @param {Function} opts.getProvider  () => provider（core 的 createProvider 结果，跟聊天同一套厂商配置）
 */
function init ({ dataRoot, getProvider }) {
  getProviderFn = getProvider
  const home = path.join(dataRoot, 'bili-duty')
  runner = duty.createDuty({ home, getProvider: () => getProviderFn(), log })
  const H = () => runner.status().home

  ipcMain.handle('bili:status', () => runner.status())

  ipcMain.handle('bili:config-get', () => ({ ok: true, config: runner.loadCfg() }))

  ipcMain.handle('bili:config-patch', (_e, patch) => {
    try {
      const cfg = runner.saveCfg(patch || {})
      log('[bili] 设置已更新：' + JSON.stringify(cfg))
      return { ok: true, config: cfg }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('bili:run', async () => {
    const r = await runner.runOnce('manual')
    return { ok: r.started !== false, ...r }
  })

  ipcMain.handle('bili:login-start', async () => {
    try {
      const { key, url } = await client.loginStart()
      // 二维码在主进程画成 GIF dataURL（渲染层 CSP 只放行 data: 图片，不需要额外库文件）
      let qr = null
      try {
        const qrcode = require('qrcode-generator')
        const qrObj = qrcode(0, 'M')
        qrObj.addData(url)
        qrObj.make()
        qr = qrObj.createDataURL(6, 2)
      } catch (e) { log('[bili] 画二维码失败：' + e.message) }
      return { ok: true, key, url, qr }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('bili:login-poll', async (_e, key) => {
    try {
      const r = await client.loginPoll(String(key || ''))
      if (r.state === 'ok') {
        const file = client.saveCredential(H(), r.credential)
        log('[bili] 登录成功，凭证已写入 ' + file)
        return { ok: true, state: 'ok', file }
      }
      return { ok: r.state !== 'unknown', state: r.state, code: r.code, message: r.message }
    } catch (e) { return { ok: false, state: 'unknown', error: e.message } }
  })

  ipcMain.handle('bili:whoami', async () => client.whoami(client.loadCredential(H())))

  ipcMain.handle('bili:report', (_e, day) => runner.readReport(day))

  ipcMain.handle('bili:verify', async () => runner.runVerify('manual'))

  // S9-M3：本地转写环境（建环境异步起跑立刻返回；状态看 site-packages 目录）
  ipcMain.handle('bili:asr-setup', () => runner.asrSetup())
  ipcMain.handle('bili:asr-status', () => runner.asrStatus())

  // S9-M4：自动收藏（收藏夹下拉 + 手动补收藏今天的）
  ipcMain.handle('bili:fav-folders', async () => {
    try { return await runner.favFolders() } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('bili:fav-today', async () => {
    try { return await runner.favToday('manual') } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('bili:open-dir', (_e, what) => {
    const dir = String(what || 'out') === 'home' ? H() : path.join(H(), 'out')
    shell.openPath(dir)
    return { ok: true }
  })

  log('[bili] 刷B站模块已挂载：' + path.join(dataRoot, 'bili-duty'))
  return runner
}

module.exports = { init }
