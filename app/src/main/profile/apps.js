/**
 * 电脑画像 · 已装程序清单（**只读**）
 *
 * 数据来源：注册表 Uninstall 三个根（64 位 / 32 位 / 当前用户）的 DisplayName。
 * 只读名字，不读序列号/安装路径/卸载信息。
 *
 * 为什么值得采：装了 Blender、Unity、剪映、MATLAB 还是只有一个 VS Code，
 * 决定了「他是在做设计、做游戏、剪视频还是写代码」——这是兴趣最硬的证据之一。
 */
const { execFileSync } = require('node:child_process')

const ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
]

/** 这些不是「他装的东西」，是系统补丁和运行库：数量大、信息量为零，折叠掉只留计数 */
const NOISE = /(^(Update for|Security Update|Hotfix for|Hotfix |KB\d{6,})|Microsoft Visual C\+\+|Microsoft \.NET|Microsoft ASP\.NET|Microsoft Edge( |$)|Microsoft Update|Windows (SDK|Software Development|Driver|Assessment)|Microsoft Visual Studio Installer|Microsoft Windows Desktop Runtime|Microsoft Windows Application Compatibility)/i

/** 解析 `reg query … /s /v DisplayName` 的输出（每两行一组：键路径 + 值行） */
function parseRegQuery (text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s+DisplayName\s+REG_\w+\s+(.+)$/)
    if (!m) continue
    const name = m[1].trim()
    if (!name) continue
    out.push(name)
  }
  return out
}

function queryRoot (root) {
  try {
    return execFileSync('reg', ['query', root, '/s', '/v', 'DisplayName'], {
      encoding: 'utf8', windowsHide: true, timeout: 12000, maxBuffer: 8 * 1024 * 1024
    })
  } catch { return '' }
}

/**
 * @returns {{ok:boolean, apps:Array<{name:string}>, noiseCount:number, total:number}}
 */
function collect ({ limit = 150 } = {}) {
  const names = []
  for (const root of ROOTS) {
    const t = queryRoot(root)
    if (t) names.push(...parseRegQuery(t))
  }

  const seen = new Set()
  const apps = []
  let noiseCount = 0
  for (const raw of names) {
    const name = raw.replace(/\s+/g, ' ').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (NOISE.test(name)) { noiseCount++; continue }
    apps.push({ name })
  }
  apps.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  return {
    ok: apps.length > 0,
    apps: apps.slice(0, limit),
    noiseCount,
    total: seen.size
  }
}

module.exports = { collect, parseRegQuery, NOISE, ROOTS }
