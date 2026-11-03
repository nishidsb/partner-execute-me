/* ---------------------------------------------------------- 活动浏览窗口 */
/* 0.46.16 她自己的浏览窗口（自主活动/地盘活动专用）：
 * 以前 openUrl = shell.openExternal → 页面开在主人默认浏览器里，开完程序就失去句柄：
 * 活动结束时既关不掉（外部关单个标签页要浏览器自动化，不可靠）也不敢关
 * （taskkill 整个浏览器会连主人自己的页面一起杀）。真机表现就是「她看完走了，
 * 网页留一排」。现在开在程序自建的 BrowserWindow 里：活动一结束整窗销毁，
 * 桌面恢复原状；主人手动关掉窗口也不影响任何逻辑。
 * 硬边界：只认 http(s)（工具层还有 B站/知乎/维基白名单）；加载失败不抛错（锦上添花的功能）。 */

let win = null

function open (u) {
  const url = String(u || '').trim()
  if (!/^https?:\/\//i.test(url)) return false
  let BrowserWindow = null
  try { ({ BrowserWindow } = require('electron')) } catch { return false }
  if (!BrowserWindow) return false
  try {
    if (win && !win.isDestroyed()) {
      try { win.loadURL(url) } catch { }
      if (win.isMinimized()) { try { win.restore() } catch { } }
      try { win.show() } catch { }
      return true
    }
    win = new BrowserWindow({
      width: 980,
      height: 680,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    win.setMenuBarVisibility(false)
    // 站内跳转（B站点视频/知乎点回答）留在同一个窗口，不往外弹新标签
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//i.test(String(target))) { try { win.loadURL(target) } catch { } }
      return { action: 'deny' }
    })
    // 别让页面拿默认 Electron UA 被站点的 bot 墙拦住
    try {
      win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
    } catch { }
    win.on('closed', () => { win = null })
    win.loadURL(url)
    win.show()
    return true
  } catch {
    return false
  }
}

/* 活动收尾：整窗销毁 → 桌面恢复原状。没有任何窗口时是无害 no-op。 */
function close () {
  if (win && !win.isDestroyed()) { try { win.close() } catch { } }
  win = null
}

function isOpen () { return !!(win && !win.isDestroyed()) }

module.exports = { open, close, isOpen }
