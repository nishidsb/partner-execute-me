'use strict'
// 帽子合并诊断：加载 VRM 后列出 ryza_cap 节点状态 + 拍全景
//   npx electron tools/cap-probe.js <model.vrm> [out.png]
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const plain = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const MODEL = path.resolve(plain[0] || '')
const OUT = path.resolve(plain[1] || path.join(__dirname, '..', 'captures', 'cap-probe.png'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[cap-probe] 超时'); app.exit(1) }, 60000)
  const win = new BrowserWindow({
    width: 560, height: 900, show: false, frame: false, backgroundColor: '#1d2030',
    webPreferences: { webSecurity: false, offscreen: false }
  })
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 1) console.log('[page]', msg.slice(0, 300)) })
  const page = path.join(__dirname, 'preview', 'vrm-shot.html')
  await win.loadFile(page, { query: { model: pathToFileURL(MODEL).toString() } })
  for (let i = 0; i < 40; i++) {
    await wait(500)
    const st = await win.webContents.executeJavaScript('JSON.stringify(window.__probe || {})')
    const probe = JSON.parse(st)
    if (probe.error) { console.error('[cap-probe] 渲染失败:', probe.error); break }
    if (probe.ready) { console.log('[cap-probe] 就绪:', probe.kind); break }
  }
  await wait(1200)
  const diag = await win.webContents.executeJavaScript(`(() => {
    const st = window.__stage
    if (!st || !st.vrm) return JSON.stringify({ err: 'no-vrm' })
    const info = []
    st.vrm.scene.traverse((o) => {
      if (o.isMesh || (o.name && /cap/i.test(o.name))) {
        let wp = null
        try { const v = new (o.position.constructor)(); o.getWorldPosition(v); wp = v.toArray().map(x => +x.toFixed(3)) } catch {}
        const item = { name: o.name || '(mesh)', type: o.type, visible: o.visible, parent: o.parent && o.parent.name, wp, mat: o.material ? o.material.type : null, frustumCulled: o.frustumCulled }
        if (o.isMesh && /cap/i.test(o.name || '')) {
          const geo = o.geometry
          geo.computeBoundingBox()
          item.posCount = geo.attributes.position ? geo.attributes.position.count : -1
          item.idxCount = geo.index ? geo.index.count : -1
          item.bboxMin = geo.boundingBox ? geo.boundingBox.min.toArray().map(x => +x.toFixed(3)) : null
          item.bboxMax = geo.boundingBox ? geo.boundingBox.max.toArray().map(x => +x.toFixed(3)) : null
          item.p0 = geo.attributes.position ? Array.from(geo.attributes.position.array.slice(0, 6)).map(x => +x.toFixed(4)) : null
          item.i0 = geo.index ? Array.from(geo.index.array.slice(0, 9)) : null
          // 实测世界矩阵：父链（head 节点）的世界矩阵
          let p = o.parent
          const mm = new (o.matrix.constructor)()
          p.updateWorldMatrix(true, false)
          p.matrixWorld.toArray ? item.headWorld = p.matrixWorld.elements.map(x => +x.toFixed(5)) : null
          item.headName = p.name
          // 帽子几何的包围盒中心变换到世界
          const c = geo.boundingBox.getCenter(new (o.position.constructor)())
          const cw = c.applyMatrix4(o.matrixWorld)
          item.capCenterWorld = cw.toArray().map(x => +x.toFixed(3))
        }
        info.push(item)
      }
    })
    return JSON.stringify(info)
  })()`)
  console.log('[cap-probe] cap 相关节点:', diag)
  const img = await win.webContents.capturePage()
  fs.writeFileSync(OUT, img.toPNG())
  console.log('[cap-probe] 已保存', OUT)
  app.exit(0)
})
