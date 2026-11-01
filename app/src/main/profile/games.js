/**
 * 电脑画像 · 游戏与应用库（**只读**）
 *
 * 直接复用 gameLib 的扫描结果（Steam 注册表 + libraryfolders.vdf + appmanifest、
 * Epic manifest、开始菜单快捷方式），不重新实现一遍。这里只做归类与摘要。
 */
function loadGameLib () {
  return require('../gameLib')
}

/** 一眼能看出是「玩的东西」而不是「办公工具」 */
function isGameEntry (e) {
  if (!e) return false
  if (e.source === 'steam' || e.source === 'epic') return true
  const n = String(e.name || '')
  return /(游戏|Game|Launcher|Steam|Epic|Ubisoft|EA |Origin|Battle\.net|GOG|Riot|Minecraft|Terraria|Stardew|异星|原神|崩坏|绝区零|鸣潮|幻兽|帕鲁|泰拉|星露谷)/i.test(n)
}

/**
 * @returns {{ok:boolean, steam:Array, epic:Array, games:Array, apps:Array, at:number}}
 */
function collect ({ force = false } = {}) {
  const gl = loadGameLib()
  let data = { steam: [], epic: [], startmenu: [] }
  try { data = gl.discover(force) || data } catch { }

  const steam = (data.steam || []).map((g) => ({ name: g.name, id: g.appid }))
  const epic = (data.epic || []).map((g) => ({ name: g.name }))
  const all = [...(data.steam || []), ...(data.epic || []), ...(data.startmenu || [])]

  const seen = new Set()
  const games = []
  const apps = []
  for (const e of all) {
    const name = String(e.name || '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (isGameEntry(e)) games.push({ name, source: e.source || 'startmenu' })
    else apps.push({ name })
  }

  return {
    ok: all.length > 0,
    steam,
    epic,
    games: games.slice(0, 200),
    apps: apps.slice(0, 300),
    at: Date.now()
  }
}

module.exports = { collect, isGameEntry }
