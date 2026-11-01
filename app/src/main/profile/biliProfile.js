/**
 * 电脑画像 · B站（**只读**）
 *
 * 用已扫码登录的凭证拉两样东西：我的收藏夹里有什么、最近看了什么。
 * 复用 bili/client.js 的 WBI 与 Cookie 逻辑，不新开一套请求栈。
 * 没登录就老实返回未登录，绝不偷偷去爬。
 */
const path = require('node:path')

function loadClient () {
  return require('../bili/client')
}

/**
 * @returns {{ok:boolean, loggedIn:boolean, hint?:string, folders:Array, favorites:Array, history:Array}}
 */
async function collect ({ dataRoot, maxFolders = 4, perFolder = 20, historySize = 30 } = {}) {
  const client = loadClient()
  const home = path.join(dataRoot || '', 'bili-duty')
  let cred = null
  try { cred = client.loadCredential(home) } catch { }
  if (!cred) {
    return { ok: false, loggedIn: false, hint: 'B站还没登录（设置 → B站 里扫码），跳过', folders: [], favorites: [], history: [] }
  }

  const folders = []
  const favorites = []
  let history = []

  /* ---- 收藏夹 ---- */
  try {
    const r = await client.favFolders(cred)
    if (r.ok) {
      /* 只取条目最多的几个夹（默认收藏夹往往是全部收藏的入口） */
      const picked = r.list.slice().sort((a, b) => b.count - a.count).slice(0, maxFolders)
      for (const f of picked) {
        folders.push({ id: f.id, title: f.title, count: f.count })
        try {
          const fl = await client.favList({ fid: f.id, pn: 1, ps: perFolder }, cred)
          if (fl.ok) {
            for (const m of fl.list) {
              favorites.push({ folder: f.title, title: m.title, up: m.up, at: m.favTime })
            }
          }
        } catch { }
      }
    } else if (r.error) {
      return { ok: false, loggedIn: false, hint: r.error, folders: [], favorites: [], history: [] }
    }
  } catch { }

  /* ---- 观看历史 ---- */
  try {
    const h = await client.watchHistory({ pn: 1, ps: historySize }, cred)
    if (h.ok) history = h.list
  } catch { }

  return {
    ok: favorites.length > 0 || history.length > 0,
    loggedIn: true,
    folders,
    favorites,
    history
  }
}

module.exports = { collect }
