/* 回归：凡是要加载 VRM/GLB 的渲染页，CSP 必须放行 blob: 的 fetch。
 *
 * 背景（0.27.0 实测）：three 的 GLTFLoader 在 Chromium 里用 ImageBitmapLoader，
 * 贴图是从 GLB 里解出来的 bufferView 造 blob: URL 再 fetch 的。
 * overlay/index.html 的 CSP 只有 `default-src 'self' aura: data:`，
 * 没有 connect-src → 回退到 default-src → fetch(blob:) 被拦
 * → 贴图全丢、材质只剩白 baseColor，桌宠就是纯白剪影（设置页预览却是彩色）。
 * 这条测试守着这个坑。 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', 'src', 'renderer')

function pagesUsingVrm () {
  const out = []
  for (const dir of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const f = path.join(ROOT, dir.name, 'index.html')
    if (!fs.existsSync(f)) continue
    const html = fs.readFileSync(f, 'utf8')
    if (/vrm-stage\.js/.test(html)) out.push([dir.name, html])
  }
  return out
}

function cspOf (html) {
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)
  return m ? m[1] : ''
}

function dirValue (csp, name) {
  const m = csp.match(new RegExp('(?:^|;)\\s*' + name + '\\s+([^;]+)'))
  return m ? m[1].trim() : null
}

test('至少能扫到加载 VRM 的页面（防止路径变了测试空跑）', () => {
  const pages = pagesUsingVrm()
  assert.ok(pages.length >= 2, '找到的页面：' + pages.map((p) => p[0]).join(','))
  assert.ok(pages.some((p) => p[0] === 'overlay'))
  assert.ok(pages.some((p) => p[0] === 'companion'))
})

for (const [name, html] of pagesUsingVrm()) {
  test(`${name} 的 CSP 放行 blob: 连接（否则 VRM 贴图全丢＝白膜）`, () => {
    const csp = cspOf(html)
    assert.ok(csp, name + ' 没有 CSP meta')
    const connect = dirValue(csp, 'connect-src')
    const fallback = dirValue(csp, 'default-src') || ''
    const effective = connect !== null ? connect : fallback
    assert.ok(
      /\bblob:/.test(effective),
      `${name} 的 ${connect !== null ? 'connect-src' : 'default-src(回退为 connect-src)'} 缺 blob: → ` +
      'GLTFLoader 用 fetch(blob:) 取贴图会被拦，模型变白膜。当前值：' + effective
    )
  })
}
