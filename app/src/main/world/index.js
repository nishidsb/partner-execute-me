/**
 * S10 World 扩展体系：第三方包能装、能提供工具 / 面板 / 配置 / 提示词注入。
 *
 * 契约（对齐规格书 7.1-7.3，参考仓没有可抄的原型，ZIP 白名单校验借鉴 AgentAtelierR 皮肤包）：
 *
 *  包结构（<data>/worlds/<id>/）：
 *    manifest.json  必需。{ id, name, version, author?, description?, os?, tags?,
 *                          prompts?, panel?, config?:[{key,type,default,label}] }
 *    main.js        可选（CommonJS）。module.exports = {
 *                     tools?: [{ name, description, parameters, risk, exec(args) }],
 *                     api?:   { fn(args) },        // 面板 invoke 通道
 *                     onEnable?(ctx), onDisable?() // ctx = { config, dataDir, log }
 *                   }
 *    panel.html     可选（panel:true 时设置页可打开）
 *
 *  安装状态机（<data>/worlds/state.json）：
 *    loaded（可用）/ failed（加载失败或连续出错被熔断）/ disabled（手动停用）/
 *    pending-restart（装好但还没装载成功，一般热装载成功后会变 loaded）
 *    防死循环：装载前写 boot-marker.json，装载完成删除；启动时发现 marker =
 *    上次装载期间崩了 → 本次所有启用中的扩展 failCount++，累计 3 次自动停用。
 *
 *  安全边界：
 *    - 安装 = 执行任意代码，设置页必须明示警告（7.2 口径）。
 *    - ZIP 白名单：拒绝绝对路径 / .. / 符号链接；扩展名白名单；≤64MB / ≤128 文件。
 *    - 工具名强制 w_<id>_ 前缀，不与内置工具冲突；连续 5 次抛错自动停用。
 *    - 提示词片段每条 ≤2000 字符、最多 4 个（session.js 侧再兜一层）。
 *  本文件保持纯 Node（测试不拉 Electron）；窗口 / 对话框由壳层注入。
 */
const fs = require('fs')
const path = require('path')

const MANIFEST = 'manifest.json'
const MAX_ZIP_BYTES = 64 * 1024 * 1024
const MAX_FILES = 128
const ALLOWED_EXT = new Set(['.json', '.js', '.html', '.css', '.txt', '.md', '.png', '.jpg', '.jpeg', '.svg', '.webp'])
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,47}$/

const readJson = (file, dft) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return dft } }
const writeJson = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8') }

/** 校验 manifest：合法返回清洗后的对象，不合法抛 Error（信息给设置页看） */
function validateManifest (raw, dirName, platform) {
  if (!raw || typeof raw !== 'object') throw new Error('manifest.json 不是对象')
  const id = String(raw.id || '').trim()
  if (!ID_RE.test(id)) throw new Error(`manifest.id 不合法（${id || '空'}）：仅允许字母/数字/下划线/横线，2-48 位`)
  if (dirName && id !== dirName) throw new Error(`manifest.id(${id}) 与目录名(${dirName})不一致`)
  const name = String(raw.name || '').trim()
  if (!name || name.length > 40) throw new Error('manifest.name 必填且 ≤40 字')
  const m = {
    id, name,
    version: String(raw.version || '0.0.0').slice(0, 20),
    author: String(raw.author || '').slice(0, 40),
    description: String(raw.description || '').slice(0, 300),
    os: Array.isArray(raw.os) ? raw.os.map(String) : null,
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).slice(0, 20)).slice(0, 8) : [],
    prompts: String(raw.prompts || '').slice(0, 2000),
    panel: !!raw.panel,
    config: [],
    permissions: Array.isArray(raw.permissions) ? raw.permissions.map((p) => String(p).slice(0, 40)).slice(0, 10) : []
  }
  if (m.os && !m.os.includes(platform)) throw new Error(`该扩展声明只支持 ${m.os.join('/')}，本机是 ${platform}`)
  if (Array.isArray(raw.config)) {
    for (const c of raw.config.slice(0, 12)) {
      if (!c || !c.key) continue
      const type = ['string', 'number', 'boolean'].includes(c.type) ? c.type : 'string'
      m.config.push({ key: String(c.key).slice(0, 40), type, default: c.default, label: String(c.label || c.key).slice(0, 60) })
    }
  }
  return m
}

/** 递归收集目录文件（相对路径 + 字节数 + 是否符号链接） */
function walkDir (root, base = root, out = []) {
  for (const name of fs.readdirSync(base)) {
    const p = path.join(base, name)
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) { out.push({ rel: path.relative(root, p), bytes: 0, symlink: true }); continue }
    if (st.isDirectory()) walkDir(root, p, out)
    else out.push({ rel: path.relative(root, p), bytes: st.size, symlink: false })
  }
  return out
}

/** 解压后的世界目录体检：白名单扩展名 / 无符号链接 / 大小与文件数上限 */
function auditWorldDir (dir) {
  const files = walkDir(dir)
  if (!files.length) throw new Error('包里一个文件都没有')
  if (files.length > MAX_FILES) throw new Error(`文件数超过上限（${files.length} > ${MAX_FILES}）`)
  let total = 0
  for (const f of files) {
    if (f.symlink) throw new Error(`包里有符号链接（${f.rel}），拒绝安装`)
    if (path.isAbsolute(f.rel) || f.rel.split(path.sep).includes('..')) throw new Error(`包里有越界路径（${f.rel}）`)
    const ext = path.extname(f.rel).toLowerCase()
    if (ext && !ALLOWED_EXT.has(ext)) throw new Error(`不允许的文件类型：${f.rel}`)
    total += f.bytes
  }
  if (total > MAX_ZIP_BYTES) throw new Error(`包体超过上限（${Math.round(total / 1048576)}MB > 64MB）`)
  return { files: files.length, bytes: total }
}

function createWorldManager ({ dataRoot, platform = process.platform, registerTool, unregisterTool, log = () => { }, unzip, download, openPanel: openPanelFn }) {
  const root = path.join(dataRoot, 'worlds')
  const stateFile = path.join(root, 'state.json')
  const markerFile = path.join(root, 'boot-marker.json')
  fs.mkdirSync(root, { recursive: true })

  /** 运行时句柄：id → { manifest, mod, toolNames[], failRun } */
  const live = new Map()
  let state = readJson(stateFile, { worlds: {} })
  const saveState = () => writeJson(stateFile, state)
  const entryOf = (id) => (state.worlds[id] = state.worlds[id] || { status: 'disabled', enabled: false, failCount: 0, lastError: '' })
  const cfgFile = (id) => path.join(root, `config.${id}.json`)

  const getConfig = (id) => {
    const m = live.get(id)?.manifest || readJson(path.join(root, id, MANIFEST), null)
    const saved = readJson(cfgFile(id), {})
    const out = {}
    for (const c of (m && m.config) || []) {
      const v = saved[c.key] !== undefined ? saved[c.key] : c.default
      out[c.key] = c.type === 'number' ? Number(v) || 0 : c.type === 'boolean' ? !!v : String(v ?? '')
    }
    return out
  }

  const setConfig = (id, patch) => {
    const cur = readJson(cfgFile(id), {})
    const p = patch && typeof patch === 'object' ? patch : {}
    for (const k of Object.keys(p).slice(0, 20)) cur[k] = p[k]
    writeJson(cfgFile(id), cur)
    // 运行中的扩展：把新配置透传给 onEnable 的 ctx（扩展开着才感知得到，简单直接）
    const l = live.get(id)
    if (l && typeof l.mod.onEnable === 'function') {
      try { l.mod.onEnable({ config: getConfig(id), dataDir: path.join(root, id), log: (m) => log(`[world:${id}] ${m}`) }) } catch { /* 扩展自己兜不住就让它带着旧配置活 */ }
    }
    return getConfig(id)
  }

  /** 注销某扩展的全部工具 */
  const dropTools = (id) => {
    const l = live.get(id)
    if (!l) return
    for (const n of l.toolNames) { try { unregisterTool(n) } catch { } }
    l.toolNames = []
  }

  /** 工具执行包装：连续 5 次抛错 → 熔断停用（7.3 口径：坏扩展不能一直炸对话） */
  const wrapExec = (id, fn) => async (args) => {
    const l = live.get(id)
    try {
      const r = await fn(args || {})
      if (l) l.failRun = 0
      return r
    } catch (e) {
      if (l) {
        l.failRun = (l.failRun || 0) + 1
        if (l.failRun >= 5) {
          log(`[world] ${id} 的工具连续失败 ${l.failRun} 次，自动停用`)
          const en = entryOf(id)
          en.status = 'failed'; en.enabled = false; en.failCount = Number(en.failCount || 0) + 1
          en.lastError = `工具连续失败 ${l.failRun} 次：${String(e && e.message ? e.message : e).slice(0, 200)}`
          saveState()
          dropTools(id)
          live.delete(id)
        }
      }
      throw e
    }
  }

  /** 装载单个扩展（目录必须已就位）：校验 → require → 注册工具 → onEnable */
  const loadOne = (id, { fromEnable = false } = {}) => {
    const dir = path.join(root, id)
    const en = entryOf(id)
    try {
      const raw = readJson(path.join(dir, MANIFEST), null)
      const manifest = validateManifest(raw, id, platform)
      if (!fs.existsSync(path.join(dir, 'main.js'))) {
        // 纯提示词/面板扩展（没有代码）也允许：prompts 生效即可
        live.set(id, { manifest, mod: {}, toolNames: [], failRun: 0 })
        en.status = 'loaded'; en.enabled = true; en.lastError = ''
        if (!fromEnable) en.failCount = 0
        saveState()
        return { ok: true, manifest }
      }
      // 每次装载清掉 require 缓存（重装/升级后拿到新代码）
      try { delete require.cache[require.resolve(path.join(dir, 'main.js'))] } catch { }
      const mod = require(path.join(dir, 'main.js'))
      const l = { manifest, mod, toolNames: [], failRun: 0 }
      live.set(id, l)
      for (const t of (Array.isArray(mod.tools) ? mod.tools : []).slice(0, 20)) {
        if (!t || !t.name || typeof t.exec !== 'function') continue
        const full = `w_${id}_${String(t.name).replace(/[^a-zA-Z0-9_-]/g, '_')}`
        registerTool({
          name: full,
          description: String(t.description || '').slice(0, 500) || `${manifest.name} 的工具 ${t.name}`,
          parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
          risk: ['low', 'medium', 'high'].includes(t.risk) ? t.risk : 'medium',
          exec: wrapExec(id, t.exec)
        })
        l.toolNames.push(full)
      }
      if (typeof mod.onEnable === 'function') {
        mod.onEnable({ config: getConfig(id), dataDir: dir, log: (m) => log(`[world:${id}] ${m}`) })
      }
      en.status = 'loaded'; en.enabled = true; en.lastError = ''
      if (!fromEnable) en.failCount = 0
      saveState()
      log(`[world] 已装载 ${id} v${manifest.version}（工具 ${l.toolNames.length} 个）`)
      return { ok: true, manifest }
    } catch (e) {
      dropTools(id)
      live.delete(id)
      en.status = 'failed'; en.enabled = false
      en.lastError = String(e && e.message ? e.message : e).slice(0, 300)
      en.failCount = Number(en.failCount || 0) + 1
      saveState()
      log(`[world] 装载 ${id} 失败：${en.lastError}`)
      return { ok: false, error: en.lastError }
    }
  }

  const unloadOne = (id) => {
    const l = live.get(id)
    if (!l) return
    try { if (typeof l.mod.onDisable === 'function') l.mod.onDisable() } catch { }
    dropTools(id)
    live.delete(id)
  }

  /** 启动装载全部（含防死循环 marker） */
  const loadAll = () => {
    const marker = readJson(markerFile, null)
    if (marker && Array.isArray(marker.worlds)) {
      // 上次装载期间没活到删 marker = 装载阶段崩了 → 这次给启用中的扩展记一笔
      for (const id of marker.worlds) {
        const en = state.worlds[id]
        if (!en || !en.enabled) continue
        en.failCount = Number(en.failCount || 0) + 1
        if (en.failCount >= 3) {
          en.enabled = false
          en.status = 'failed'
          en.lastError = '连续 3 次启动期间崩溃，已自动停用（防死循环）'
          log(`[world] ${id} 触发防死循环熔断，已停用`)
        } else {
          en.lastError = `启动装载阶段崩溃 ${en.failCount}/3`
        }
      }
      saveState()
      try { fs.rmSync(markerFile, { force: true }) } catch { }
    }
    const ids = fs.readdirSync(root).filter((n) => fs.existsSync(path.join(root, n, MANIFEST)))
    const enabled = ids.filter((id) => entryOf(id).enabled)
    writeJson(markerFile, { ts: Date.now(), worlds: enabled })
    const results = {}
    for (const id of ids) {
      const en = entryOf(id)
      results[id] = en.enabled ? loadOne(id) : { ok: false, skipped: true, status: en.status }
    }
    try { fs.rmSync(markerFile, { force: true }) } catch { }
    return results
  }

  /** 已启用扩展的提示词片段（session 桥每次现取） */
  const promptSnippets = () => {
    const out = []
    for (const [id, l] of live) {
      if (entryOf(id).enabled && l.manifest.prompts) out.push({ id, text: l.manifest.prompts })
    }
    return out
  }

  /* ---------------- 安装 / 卸载 / 开关 ---------------- */

  /** 从 ZIP 安装（zipPath 必须已在本机）。成功后热装载；任何失败都返回 {ok:false,error}（不抛） */
  const installZip = async (zipPath) => {
    const staging = path.join(root, `.staging-${Date.now()}`)
    fs.mkdirSync(staging, { recursive: true })
    try {
      await unzip(zipPath, staging)
      // zip 可能带一层顶层目录：找到 manifest.json 的真实位置
      let base = staging
      if (!fs.existsSync(path.join(base, MANIFEST))) {
        const subs = fs.readdirSync(staging).filter((n) => fs.statSync(path.join(staging, n)).isDirectory())
        const hit = subs.find((n) => fs.existsSync(path.join(staging, n, MANIFEST)))
        if (!hit) throw new Error('包里没有 manifest.json（要在压缩包根目录或唯一一级子目录里）')
        base = path.join(staging, hit)
      }
      const raw = readJson(path.join(base, MANIFEST), null)
      const manifest = validateManifest(raw, null, platform) // 先校验内容，id 定目录名
      auditWorldDir(base)
      const dest = path.join(root, manifest.id)
      // 卸掉旧的（如有）：先停再删
      if (live.has(manifest.id)) unloadOne(manifest.id)
      fs.rmSync(dest, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.renameSync(base, dest)
      const en = entryOf(manifest.id)
      en.status = 'pending-restart'; en.enabled = true; en.lastError = ''
      saveState()
      const r = loadOne(manifest.id) // 热装载：成功即 loaded，失败落 failed
      log(`[world] 安装 ${manifest.id} v${manifest.version} → ${r.ok ? '已装载' : '装载失败：' + r.error}`)
      return { ok: true, id: manifest.id, manifest, load: r }
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) }
    } finally {
      try { fs.rmSync(staging, { recursive: true, force: true }) } catch { }
    }
  }

  const installUrl = async (url) => {
    if (!download) throw new Error('下载能力没注入')
    const tmp = path.join(root, `.dl-${Date.now()}.zip`)
    try {
      await download(String(url), tmp)
      return await installZip(tmp)
    } finally {
      try { fs.rmSync(tmp, { force: true }) } catch { }
    }
  }

  const uninstall = (id) => {
    unloadOne(id)
    fs.rmSync(path.join(root, id), { recursive: true, force: true })
    fs.rmSync(cfgFile(id), { force: true })
    delete state.worlds[id]
    saveState()
    log(`[world] 已卸载 ${id}`)
    return { ok: true }
  }

  const setEnabled = (id, enabled) => {
    const en = entryOf(id)
    if (!fs.existsSync(path.join(root, id, MANIFEST))) return { ok: false, error: '扩展目录不存在' }
    if (enabled) {
      const r = loadOne(id, { fromEnable: true })
      return r.ok ? { ok: true, status: 'loaded' } : { ok: false, error: r.error }
    }
    unloadOne(id)
    en.status = 'disabled'; en.enabled = false
    saveState()
    return { ok: true, status: 'disabled' }
  }

  /* ---------------- 面板 / api invoke ---------------- */

  const invoke = async (id, fn, args) => {
    const l = live.get(id)
    if (!l) return { ok: false, error: `扩展 ${id} 没在运行` }
    const f = l.mod.api && l.mod.api[String(fn || '')]
    if (typeof f !== 'function') return { ok: false, error: `扩展没有提供 api.${fn}` }
    try { return { ok: true, result: await f(args || {}) } } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
  }

  const openPanel = (id) => {
    const l = live.get(id)
    if (!l || !l.manifest.panel) return { ok: false, error: '该扩展没有面板' }
    const html = path.join(root, id, 'panel.html')
    if (!fs.existsSync(html)) return { ok: false, error: 'panel.html 不存在' }
    if (typeof openPanelFn !== 'function') return { ok: false, error: '面板窗口没注入' }
    return openPanelFn(id, html, l.manifest.name)
  }

  /* ---------------- 市场与列表 ---------------- */

  /** 拉市场索引：{ worlds:[{id,name,version,author,description,tags,os,rating,reviews,download}] }；
   *  评分/评论数只是展示字段（没有后端），OS 按本机过滤。 */
  const market = async (url) => {
    if (!download) throw new Error('下载能力没注入')
    let text = ''
    if (url.startsWith('file://')) {
      text = fs.readFileSync(require('url').fileURLToPath(url), 'utf8')
    } else {
      const tmp = path.join(root, `.mkt-${Date.now()}.json`)
      try { await download(String(url), tmp); text = fs.readFileSync(tmp, 'utf8') } finally { try { fs.rmSync(tmp, { force: true }) } catch { } }
    }
    const j = JSON.parse(text)
    const arr = Array.isArray(j.worlds) ? j.worlds : Array.isArray(j) ? j : []
    return {
      ok: true,
      worlds: arr.slice(0, 100).map((w) => ({
        id: String(w.id || '').slice(0, 48), name: String(w.name || w.id || '').slice(0, 40),
        version: String(w.version || '').slice(0, 20), author: String(w.author || '').slice(0, 40),
        description: String(w.description || '').slice(0, 300),
        tags: Array.isArray(w.tags) ? w.tags.slice(0, 8) : [],
        os: Array.isArray(w.os) ? w.os : null,
        rating: Number(w.rating) || 0, reviews: Number(w.reviews) || 0,
        download: String(w.download || ''),
        compatible: !Array.isArray(w.os) || w.os.includes(platform)
      })).filter((w) => w.id && w.download)
    }
  }

  /** 设置页列表：磁盘上的全部扩展 + 状态 + 配置 */
  const list = () => {
    const ids = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => !n.startsWith('.') && fs.existsSync(path.join(root, n, MANIFEST))) : []
    return {
      ok: true,
      worlds: ids.map((id) => {
        const m = validateManifest(readJson(path.join(root, id, MANIFEST), null), null, platform)
        const en = state.worlds[id] || { status: 'disabled', enabled: false, failCount: 0, lastError: '' }
        const l = live.get(id)
        return {
          ...m,
          status: en.enabled ? 'loaded' : en.status,
          enabled: !!en.enabled,
          failCount: Number(en.failCount || 0),
          lastError: en.lastError || '',
          toolNames: l ? l.toolNames.slice() : [],
          config: getConfig(id),
          configSchema: m.config
        }
      })
    }
  }

  return {
    root, loadAll, list, promptSnippets, installZip, installUrl, uninstall, setEnabled,
    setConfig, getConfig, invoke, openPanel, market,
    _internal: { validateManifest, auditWorldDir, entryOf, stateFile }
  }
}

/** 默认解压器：extract-zip（装进 package.json 的正式依赖） */
function defaultUnzip (zipPath, dest) {
  // 惰性 require：测试环境没装也能跑（自己注入 unzip）
  const extract = require('extract-zip')
  return extract(zipPath, { dir: dest })
}

module.exports = { createWorldManager, validateManifest, auditWorldDir, defaultUnzip, ID_RE, ALLOWED_EXT, MAX_ZIP_BYTES, MAX_FILES }
