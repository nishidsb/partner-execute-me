'use strict'
/**
 * 卡片 ↔ 运行中窗口的匹配（纯函数，不碰磁盘、不依赖 electron）
 *
 * 拆出来的原因：这块逻辑曾经只在真机上才能观察，Steam 卡片（只有 steam:// 协议、
 * 没有 exe）永远匹配不到正在跑的游戏 →「明明在运行，悬停却没有小窗口」。
 * 现在可以用 tools/check-match.js 拿真实库数据直接跑断言。
 *
 * 三级匹配，逐级兜底，且一个窗口只归一张卡：
 *   1) exe 精确路径 / 同目录同名 exe / 进程名（pp 拿不到时）
 *   2) 窗口标题（Steam/Epic 卡片没有 exe，只能靠它；浏览器标题不参与，避免误判）
 *   3) 只有进程没有窗口（托盘驻留 / 后台）→ 仍算运行中，标记 tray
 *      但必须满足「exe 名本库唯一 + 非通用名 + 非系统目录」，否则宁可不报：
 *      unitycrashhandler64.exe 这种共享崩溃处理器会让所有 Unity 游戏一起「运行中」
 */

/** 名字归一化：去空格/标点/大小写差异，中文保留 */
function normName (s) {
  return String(s || '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, '')
}

/** 浏览器不参与标题匹配：在浏览器里搜过游戏名，标题就带游戏名，会误判成游戏在跑 */
const BROWSER_PN = /^(msedge|chrome|firefox|brave|opera|vivaldi|360se|360chrome|qqbrowser|sogouexplorer|iexplore|thorium)$/

/** 这些系统窗口不属于任何卡片，日志里不报「没匹配」 */
// ryza assistant = 本程序自身（移植时原名 auradesk 保留，两个都挡）
const SYS_PN = /^(explorer|program manager|textinputhost|searchhost|searchapp|shellexperiencehost|startmenuexperiencehost|applicationframehost|systemsettings|lockapp|dwm|csrss|winlogon|runtimebroker|auradesk|ryza assistant)$/

const pathBase = (p) => String(p || '').replace(/^.*[\\/]/, '').toLowerCase()

/** 上一个目录名：同名 exe 靠它区分（E:\miHoYo Launcher\launcher.exe 与
 *  E:\Hypergryph Launcher\Launcher.exe 只同名不同家，绝不能互相认领） */
const dirBase = (p) => {
  const parts = String(p || '').split(/[\\/]/)
  return String(parts.length > 1 ? parts[parts.length - 2] : '').toLowerCase()
}

/** 系统目录里的程序：只有裸进程名时不足以指认卡片（cmd.exe / 记事本随手就有） */
const isSystemPath = (p) => /^[a-z]:[\\/]windows[\\/]/i.test(String(p || ''))

/** 通用可执行名：这类名字随时可能是别的软件在跑，不能靠进程名认卡片 */
const GENERIC_EXE = /^(launcher|launch|game|app|application|client|start|starter|main|run|runtime|helper|service|server|update|updater|install|installer|setup|bootstrap|play|player|engine|editor|unitycrashhandler\d*|crashhandler\d*|werfault|bugreport|conhost|cmd|powershell|pwsh|wscript|cscript|rundll32|regsvr32|svchost|dllhost|node|python\d*|electron)$/

/** exe 命中打分：精确路径 > 同名文件 > 进程名，前台 > 后台 > 最小化
 *  管理员权限运行的程序 Get-Process 拿不到 Path（pp 为 null），必须用 pn 兜底
 *  同名不同目录（两份 launcher.exe）不给分：那是另一家的程序，认了就会「没运行也显示运行中」 */
function matchScore (w, cands) {
  const ppl = w.pp ? String(w.pp).toLowerCase() : ''
  const pn = String(w.pn || '').toLowerCase()
  let best = 0
  for (const c of cands) {
    const cc = String(c || '').toLowerCase()
    let s = 0
    if (ppl && cc === ppl) s = 4
    else if (ppl && pathBase(cc) === pathBase(ppl) && dirBase(cc) === dirBase(ppl)) s = 2
    else if (pn && !ppl && pathBase(cc).replace(/\.exe$/i, '') === pn) s = 2
    if (s > best) best = s
  }
  if (!best) return 0
  if (w.fg) best += 2
  if (!w.min) best += 1
  return best
}

/** 标题匹配：游戏窗口标题基本就是名字（「崩坏：星穹铁道」「Hades」）。
 *  宁缺勿滥，只认「等于 / 以卡名开头 / 以卡名结尾」，避免把别的窗口抢过来 */
function titleScore (w, name) {
  if (!w || BROWSER_PN.test(String(w.pn || '').toLowerCase())) return 0
  const n = normName(name)
  if (n.length < 3) return 0
  const t = normName(w.t)
  if (!t) return 0
  if (t === n) return 9
  if (t.startsWith(n) && t.length - n.length <= 30) return 7
  if (t.endsWith(n) && t.length - n.length <= 30) return 6
  const pn = normName(w.pn)
  if (pn.length >= 4 && n.startsWith(pn)) return 4
  return 0
}

/**
 * @param {Array<{id:string,name:string,cands:string[]}>} list 卡片（cands = exe 候选，小写全路径）
 * @param {Array<{h:number,t?:string,pn?:string,pp?:string,min?:boolean,fg?:boolean}>} windows
 * @param {string[]} procs 运行中的进程名（小写、无 .exe）
 * @returns {{map:Object, orphans:Array}} map: cardId -> {h,min,fg} | {h:null,tray:true}
 */
function matchApps (list, windows, procs) {
  const map = {}
  const claimed = new Set()
  const wins = Array.isArray(windows) ? windows : []
  const procList = Array.isArray(procs) ? procs : []
  const procSet = new Set(procList.map(normName))

  // 1) exe 匹配（分数高的先认领窗口，避免两张同名卡抢同一个窗口）
  const picks = []
  for (const e of list) {
    if (!e.cands || !e.cands.length) continue
    let bw = null
    let bs = 0
    for (const w of wins) {
      const n = Math.trunc(Number(w.h))
      if (claimed.has(n)) continue
      const s = matchScore(w, e.cands)
      if (s > bs) { bs = s; bw = w }
    }
    if (bw) picks.push({ e, w: bw, s: bs })
  }
  picks.sort((a, b) => b.s - a.s)
  for (const p of picks) {
    const n = Math.trunc(Number(p.w.h))
    if (claimed.has(n)) continue
    claimed.add(n)
    map[p.e.id] = { h: p.w.h, min: !!p.w.min, fg: !!p.w.fg }
  }

  // 2) 标题兜底：Steam/Epic 卡片没有 exe（或游戏换了启动器），靠窗口标题认
  for (const e of list) {
    if (map[e.id]) continue
    let bw = null
    let bs = 0
    for (const w of wins) {
      if (claimed.has(Math.trunc(Number(w.h)))) continue
      const s = titleScore(w, e.name)
      if (s > bs) { bs = s; bw = w }
    }
    if (bw) {
      claimed.add(Math.trunc(Number(bw.h)))
      map[e.id] = { h: bw.h, min: !!bw.min, fg: !!bw.fg }
    }
  }

  // 3) 没有窗口但进程在跑：托盘驻留 / 无窗口程序也算运行中。
  //    这一层只有「进程名」，没有任何窗口信息，是最容易误报的地方，所以宁缺勿滥：
  //      a) 该 exe 名必须在本库里唯一 —— 多个 Unity 游戏共用 unitycrashhandler64.exe，
  //         只要有一个在跑，全部 Unity 卡都会被判成运行中（用户实际遇到的就是这个）
  //      b) 通用名（launcher.exe / game.exe / update.exe）不作数
  //      c) 系统目录的程序（cmd.exe 之类）不参与裸名匹配：它常驻/被脚本随手拉起
  const baseOwners = new Map() // exe 名 → 用到它的卡片集合（同一张卡里重复出现不算共享）
  for (const e of list) {
    for (const c of e.cands || []) {
      const b = pathBase(c).replace(/\.exe$/i, '')
      if (!b) continue
      if (!baseOwners.has(b)) baseOwners.set(b, new Set())
      baseOwners.get(b).add(e.id)
    }
  }
  const trayNames = (e) => {
    const out = []
    for (const c of e.cands || []) {
      if (isSystemPath(c)) continue
      const b = pathBase(c).replace(/\.exe$/i, '')
      if (!b || GENERIC_EXE.test(b)) continue
      const owners = baseOwners.get(b)
      if (owners && owners.size > 1) continue // 多张卡共用这个 exe 名，分不出是谁
      if (!out.includes(b)) out.push(b)
    }
    return out
  }
  for (const e of list) {
    if (map[e.id]) continue
    if (trayNames(e).some((n) => procList.includes(n))) { map[e.id] = { h: null, tray: true }; continue }
    const nName = normName(e.name)
    if (nName.length >= 4 && !GENERIC_EXE.test(nName) && procSet.has(nName)) map[e.id] = { h: null, tray: true }
  }

  // 有窗口却没人认领 = 匹配盲区，日志里点名，省得下次靠猜
  const orphans = wins
    .filter((w) => !claimed.has(Math.trunc(Number(w.h))) && w.pn && !SYS_PN.test(String(w.pn).toLowerCase()))
    .slice(0, 8)
    .map((w) => (w.pn || '?') + ' | ' + String(w.t || '').slice(0, 40))

  return { map, orphans }
}

module.exports = { normName, matchScore, titleScore, matchApps, BROWSER_PN, SYS_PN, GENERIC_EXE, isSystemPath }
