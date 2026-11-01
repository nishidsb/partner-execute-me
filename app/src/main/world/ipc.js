/**
 * S10 World 扩展：主进程 Electron 壳（IPC + 面板窗口 + 示例播种）。
 * 业务全在 ./index.js（纯 Node，可测）；本文件只接线。
 */
const { ipcMain, dialog, BrowserWindow, net } = require('electron')
const fs = require('fs')
const path = require('path')
const { createWorldManager, defaultUnzip } = require('./index')
const { log } = require('../logger')

let mgr = null
/** panel 窗口 webContents.id → 扩展 id（面板 invoke 时找回归属） */
const panels = new Map()

function closePanelsOf (id) {
  for (const [wcid, wid] of [...panels.entries()]) {
    if (wid !== id) continue
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents && x.webContents.id === wcid)
    try { if (w && !w.isDestroyed()) w.close() } catch { }
    panels.delete(wcid)
  }
}

function openPanelWin (id, htmlPath, title) {
  // 一个扩展同时只开一个面板：已开着就聚焦
  for (const [wcid, wid] of panels) {
    if (wid !== id) continue
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents && x.webContents.id === wcid)
    if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.focus(); return { ok: true, focused: true } }
    panels.delete(wcid)
  }
  const win = new BrowserWindow({
    width: 440, height: 340,
    title: `${title || '扩展面板'} · ${id}`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../../preload/world-panel.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false
    }
  })
  panels.set(win.webContents.id, id)
  win.on('closed', () => { for (const [wcid, wid] of panels) if (wid === id && (!win.webContents || win.webContents.id === wcid)) panels.delete(wcid) })
  win.loadFile(htmlPath).catch((e) => log(`[world] ${id} 面板加载失败：${e.message}`))
  return { ok: true }
}

/** 首次启动播种示例扩展（worlds 目录还没有任何扩展时） */
function seedSample (dataRoot) {
  try {
    const root = mgr.root
    const hasAny = fs.readdirSync(root).some((n) => !n.startsWith('.') && fs.existsSync(path.join(root, n, 'manifest.json')))
    if (hasAny) return
    const src = path.join(__dirname, '../../../resources/worlds/sample-clock')
    if (!fs.existsSync(path.join(src, 'manifest.json'))) return
    const dest = path.join(root, 'sample-clock')
    fs.mkdirSync(dest, { recursive: true })
    copyTree(src, dest)
    log('[world] 已播种示例扩展 sample-clock（默认停用，去设置页开启）')
  } catch (e) { log('[world] 播种示例失败：' + e.message) }
}

function copyTree (src, dest) {
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name)
    const d = path.join(dest, name)
    if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d) }
    else fs.writeFileSync(d, fs.readFileSync(s))
  }
}

function init ({ dataRoot }) {
  mgr = createWorldManager({
    dataRoot,
    // 工具表在 core ESM 里，经 assistant 壳转发（assistant 没就绪时这几个会 throw，由 loadOne 记为 failed）
    registerTool: (def) => require('../assistant').registerTool(def),
    unregisterTool: (name) => require('../assistant').unregisterTool(name),
    log,
    unzip: defaultUnzip,
    download: async (url, dest) => {
      const res = await net.fetch(url)
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 64 * 1024 * 1024) throw new Error('包体超过 64MB 上限')
      fs.writeFileSync(dest, buf)
    },
    openPanel: openPanelWin
  })

  // S10：扩展提示词 → 会话（session.js 的 worldPrompts 桥）
  try { require('../assistant').setWorldPrompts(() => mgr.promptSnippets()) } catch (e) { log('[world] 提示词桥接失败：' + e.message) }

  seedSample(dataRoot)
  const r = mgr.loadAll()
  const loaded = Object.entries(r).filter(([, v]) => v.ok).length
  log(`[world] 扩展装载完成：${loaded}/${Object.keys(r).length} 个可用`)

  ipcMain.handle('world:list', () => mgr.list())
  ipcMain.handle('world:set-enabled', (_e, { id, enabled }) => {
    const r = mgr.setEnabled(String(id || ''), !!enabled)
    if (!r.ok || !enabled) closePanelsOf(String(id || ''))
    return r
  })
  ipcMain.handle('world:uninstall', (_e, { id }) => {
    const wid = String(id || '')
    closePanelsOf(wid)
    try { return mgr.uninstall(wid) } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('world:install-zip', async () => {
    const r = await dialog.showOpenDialog({ title: '安装扩展（.zip）', filters: [{ name: 'World 扩展', extensions: ['zip'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
    try { return await mgr.installZip(r.filePaths[0]) } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('world:install-url', async (_e, { url }) => {
    try { return await mgr.installUrl(String(url || '')) } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('world:market', async (_e, { url }) => {
    try { return await mgr.market(String(url || '')) } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('world:config', (_e, { id, patch }) => {
    try { return { ok: true, config: mgr.setConfig(String(id || ''), patch) } } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('world:open-panel', (_e, { id }) => mgr.openPanel(String(id || '')))
  // 面板 → 主进程：e.sender 找归属扩展（不信任渲染层自报 id）
  ipcMain.handle('world:invoke', (e, fn, args) => {
    const id = panels.get(e.sender.id)
    if (!id) return { ok: false, error: '不在已注册的扩展面板里' }
    return mgr.invoke(id, fn, args)
  })

  return mgr
}

module.exports = { init, get mgr () { return mgr } }
