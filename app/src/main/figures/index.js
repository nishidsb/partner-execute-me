'use strict'
/**
 * 形象包 · 主进程接线（IPC + 独立装扮窗口）
 *
 * 与 core（pack.js）的分工：pack 只管文件与格式，这里管「跟谁交互」——
 * 文件对话框、拖进来的路径、当前角色卡、装扮窗口生命周期。
 *
 * 装扮结果存在角色卡里（characters.json → visual.figure），
 * 结构 { pack, axes:{axisId:optId}, palette, vars:{}, preset }，
 * 这样切角色 = 形象与装扮一起切，和多角色设定一致。
 */
const fs = require('node:fs')
const path = require('node:path')
const { ipcMain, dialog, BrowserWindow } = require('electron')
const pack = require('./pack')
const { log } = require('../logger')

let dressWin = null
let companionChar = null

function charModule () {
  if (!companionChar) companionChar = require('../companion/character')
  return companionChar
}

function activeChar () {
  try { return charModule().get() } catch { return null }
}

function saveCharacter (char) {
  const c = charModule()
  c.upsert(char)
  const nc = c.get(char.id)
  try { require('../companion/pet').refresh(nc) } catch { /* overlay 没起来也能存 */ }
  return nc
}

/** 当前角色的形象包配置（没有就是 null） */
function currentFigure () {
  const ch = activeChar()
  const v = (ch && ch.visual) || {}
  const f = v.figure
  if (!f || !f.pack) return null
  return f
}

/** 打包给渲染层的完整状态：包列表 + 当前装扮 + 解析后的图层 */
function state () {
  const list = pack.list()
  const cur = currentFigure()
  const v = (activeChar() && activeChar().visual) || {}
  let resolved = null
  if (cur && list.some((p) => p.id === cur.pack && !p.broken)) {
    resolved = pack.resolve(cur.pack, cur)
  }
  return {
    packs: list,
    mode: v.mode || 'still',
    figure: cur,
    resolved,
    hasMode: v.mode === 'figure'
  }
}

function applyDress (dress) {
  const ch = activeChar()
  if (!ch) return { ok: false, reason: '没有当前角色' }
  const d = dress && typeof dress === 'object' ? dress : {}
  const id = String(d.pack || '')
  const r = pack.resolve(id, d)
  if (!r) return { ok: false, reason: '形象包不可用（可能已被删除）' }
  ch.visual = ch.visual || {}
  ch.visual.mode = 'figure'
  ch.visual.figure = {
    pack: id,
    axes: r.dress.axes,
    palette: r.dress.palette,
    vars: (d.vars && typeof d.vars === 'object') ? d.vars : {},
    preset: r.dress.preset
  }
  const nc = saveCharacter(ch)
  log('[figure] 应用装扮 pack=' + id + ' axes=' + JSON.stringify(r.dress.axes) + ' palette=' + r.dress.palette)
  return { ok: true, char: nc, resolved: r }
}

/** 退出形象包，回到立绘（立绘文件还在，不用重选） */
function clearFigure () {
  const ch = activeChar()
  if (!ch) return { ok: false }
  ch.visual = ch.visual || {}
  ch.visual.mode = ch.visual.image ? 'still' : (ch.visual.spine && ch.visual.spine.skel ? 'spine' : 'still')
  ch.visual.figure = null
  const nc = saveCharacter(ch)
  log('[figure] 退出形象包 → mode=' + ch.visual.mode)
  return { ok: true, char: nc }
}

function openDress (parentKey) {
  if (dressWin && !dressWin.isDestroyed()) {
    dressWin.show()
    dressWin.focus()
    return dressWin
  }
  dressWin = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    frame: false,
    backgroundColor: '#0b0c11',
    show: false,
    title: '形象与装扮',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/dress.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  dressWin.loadFile(path.join(__dirname, '../../renderer/dress/index.html'))
  dressWin.once('ready-to-show', () => dressWin.show())
  dressWin.on('closed', () => { dressWin = null })
  return dressWin
}

function notify () {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try { w.webContents.send('figure:changed', state()) } catch {}
  }
}

function registerIpc () {
  ipcMain.handle('figure:state', () => state())

  ipcMain.handle('figure:list', () => pack.list())

  /** 选择 zip（或文件夹）导入 */
  ipcMain.handle('figure:import', async (e, kind) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const dirMode = kind === 'dir'
    const r = await dialog.showOpenDialog(win, dirMode
      ? { title: '选择形象包文件夹', properties: ['openDirectory'] }
      : { title: '选择形象包（.zip）', filters: [{ name: '形象包', extensions: ['zip'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
    const target = r.filePaths[0]
    const out = dirMode ? pack.importDir(target) : pack.importZip(target)
    if (out.ok) { log('[figure] 导入成功 ' + out.id + ' ← ' + target); notify() }
    else log('[figure] 导入失败 ' + (out.reason || '') + ' ← ' + target)
    return out
  })

  /** 拖进来 / 命令行给路径：目录或 zip 自动判断 */
  ipcMain.handle('figure:import-path', (_e, p) => {
    const abs = String(p || '')
    if (!abs || !fs.existsSync(abs)) return { ok: false, reason: '路径不存在' }
    let out
    try {
      out = fs.statSync(abs).isDirectory() ? pack.importDir(abs) : pack.importZip(abs)
    } catch (err) {
      return { ok: false, reason: err.message }
    }
    if (out.ok) { log('[figure] 导入成功 ' + out.id + ' ← ' + abs); notify() }
    else log('[figure] 导入失败 ' + (out.reason || '') + ' ← ' + abs)
    return out
  })

  ipcMain.handle('figure:remove', (_e, id) => {
    const cur = currentFigure()
    const ok = pack.remove(id)
    if (ok) {
      // 删掉的正是当前在用的包 → 退回立绘，别留一个空舞台
      if (cur && cur.pack === id) clearFigure()
      log('[figure] 删除形象包 ' + id)
      notify()
    }
    return ok
  })

  ipcMain.handle('figure:resolve', (_e, id, dress) => pack.resolve(id, dress))
  ipcMain.handle('figure:default-dress', (_e, id) => pack.defaultDress(id))

  /** 自定义配色：复制内置 → 改色 → 存成自己的（内置不会被改坏） */
  ipcMain.handle('figure:save-palette', (_e, packId, pal) => {
    const out = pack.saveCustomPalette(packId, pal)
    if (out) { log('[figure] 保存自定义配色 ' + packId + '/' + out.id); notify() }
    return out
  })

  /** 自定义方案：当前 axes + 配色 + 覆盖色一起存 */
  ipcMain.handle('figure:save-preset', (_e, packId, preset) => {
    const r = pack.resolve(packId, {})
    const axisIds = r ? r.axes.map((a) => a.id) : []
    const out = pack.saveCustomPreset(packId, preset, axisIds)
    if (out) { log('[figure] 保存自定义方案 ' + packId + '/' + out.id); notify() }
    return out
  })

  ipcMain.handle('figure:del-custom', (_e, packId, kind, cid) => {
    const ok = pack.delCustom(packId, kind, cid)
    if (ok) { log('[figure] 删除自定义 ' + kind + ' ' + packId + '/' + cid); notify() }
    return ok
  })

  ipcMain.handle('figure:apply', (_e, dress) => {
    const out = applyDress(dress)
    if (out.ok) notify()
    return out
  })

  ipcMain.handle('figure:clear', () => {
    const out = clearFigure()
    notify()
    return out
  })

  ipcMain.handle('figure:open-dress', () => { openDress(); return true })
  ipcMain.handle('figure:close-dress', () => {
    if (dressWin && !dressWin.isDestroyed()) dressWin.close()
    return true
  })
  ipcMain.handle('figure:min-dress', () => {
    if (dressWin && !dressWin.isDestroyed()) dressWin.minimize()
    return true
  })
}

/**
 * 首次启动种一个示例包：新装用户点「形象包」就能看到东西，
 * 不用先去别处找 zip。包本身是形状声明式生成的（仓库不放第三方美术资源），
 * 用户删掉后不会自动复活。
 */
function seed () {
  try {
    const dir = pack.base()
    const hasAny = fs.readdirSync(dir).some((n) => !n.startsWith('.'))
    if (hasAny) return
    const seedZip = path.join(__dirname, '../../../resources/figures/ryza-example.zip')
    if (!fs.existsSync(seedZip)) return
    const out = pack.importZip(seedZip)
    if (out.ok) log('[figure] 已安装示例形象包 ' + out.id)
    else log('[figure] 示例形象包安装失败: ' + (out.reason || ''))
  } catch (e) {
    log('[figure] 示例形象包异常: ' + (e && e.message))
  }
}

module.exports = { registerIpc, state, openDress, applyDress, clearFigure, currentFigure, seed }
