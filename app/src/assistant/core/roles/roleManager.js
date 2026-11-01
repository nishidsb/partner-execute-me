/**
 * 角色与人格系统：角色设定全部是 data/roles/<id>.json 独立配置，不写死在代码里。
 * 支持创建/修改/切换/移除、导入导出。角色模块可选——通用助手就是一个无人格角色。
 *
 * S4：人设文件带 SHA-256（personaSha / builtinSha）。升级时只有「人设没被用户改过」
 * 才跟随新版内置内容；用户亲手改过的永远保留（对齐参考项目「升级不覆盖用户改的人设」）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataPath } from '../config.js'
import { logger } from '../logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUILTIN_DIR = path.join(__dirname, 'builtin')

function sha256 (text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex')
}

function sanitizeId (id) {
  const s = String(id || '').trim().replace(/[^\w.-]/g, '_')
  if (!s) throw new Error('角色 id 不能为空（仅允许字母/数字/下划线/点/横线）')
  return s
}

function roleFile (id) { return dataPath('roles', `${sanitizeId(id)}.json`) }

export const roles = {
  /**
   * 首次启动/每次升级：把内置角色同步到 data/roles。
   *  - 文件不存在 → 原样写入，并记下出厂人设哈希；
   *  - 存在且人设仍是上次内置内容 → 跟随新版内置（更新 persona 与哈希）；
   *  - 存在但人设被你改过 → 只补缺省字段，persona 一概不动。
   */
  seedBuiltin () {
    fs.mkdirSync(dataPath('roles'), { recursive: true })
    for (const f of fs.readdirSync(BUILTIN_DIR)) {
      if (!f.endsWith('.json')) continue
      let src
      try { src = JSON.parse(fs.readFileSync(path.join(BUILTIN_DIR, f), 'utf8')) } catch { continue }
      const dest = dataPath('roles', f)
      const builtinPersona = String(src.persona || '')
      const builtinSha = sha256(builtinPersona)

      if (!fs.existsSync(dest)) {
        fs.writeFileSync(dest, JSON.stringify({ ...src, builtinSha, personaSha: builtinSha }, null, 2))
        continue
      }

      let cur
      try { cur = JSON.parse(fs.readFileSync(dest, 'utf8')) } catch { continue }
      const curSha = sha256(cur.persona || '')
      // 老版本没有 builtinSha：内容与内置同 → 未改；不同则保守当成「你改过」（宁可不同步也不覆盖）
      const edited = cur.builtinSha ? curSha !== cur.builtinSha : curSha !== builtinSha
      if (edited) {
        const merged = { ...src, ...cur, builtinSha: cur.builtinSha || null, personaSha: curSha, builtinOverride: true }
        if (JSON.stringify(merged) !== JSON.stringify(cur)) fs.writeFileSync(dest, JSON.stringify(merged, null, 2))
        logger.info(`[roles] ${f} 的人设被用户改过，保留用户版本（不随升级覆盖）`)
        continue
      }
      fs.writeFileSync(dest, JSON.stringify({ ...src, builtinSha, personaSha: builtinSha, builtinOverride: false }, null, 2))
    }
  },
  list () {
    const dir = dataPath('roles')
    fs.mkdirSync(dir, { recursive: true })
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null }
    }).filter(Boolean)
  },
  get (id) {
    try { return JSON.parse(fs.readFileSync(roleFile(id), 'utf8')) } catch { return null }
  },
  /** 创建/覆盖角色。必填 id + persona（通用助手 persona 可为空串） */
  save (def) {
    const id = sanitizeId(def.id)
    const prev = roles.get(id) || {}
    const persona = String(def.persona || '')
    const clean = {
      id,
      name: String(def.name || id),
      persona,
      replyLang: String(def.replyLang || ''), // 回复语言守卫目标（如 zh/en/ja，空=不校验）
      worldInfo: Array.isArray(def.worldInfo) ? def.worldInfo : [],
      params: def.params && typeof def.params === 'object' ? def.params : {},
      tools: Array.isArray(def.tools) ? def.tools : null, // null=允许全部
      // 0.18.0 第二批：系统提示词编辑器（角色卡「人设」页）。只能界面改，聊天链路永远写不进来。
      systemPrompt: String(def.systemPrompt || '').slice(0, 20000),
      systemReplace: !!def.systemReplace,
      builtin: !!def.builtin,
      // S4：人设指纹。builtinSha 是「上次从内置写入时的样子」，personaSha 是当前样子。
      // 两者不等 = 你亲手改过 → 升级时不覆盖。
      builtinSha: prev.builtinSha || null,
      personaSha: sha256(persona)
    }
    if (prev.builtinSha && clean.personaSha !== prev.builtinSha) clean.builtinOverride = true
    fs.mkdirSync(dataPath('roles'), { recursive: true })
    fs.writeFileSync(roleFile(id), JSON.stringify(clean, null, 2))
    return clean
  },
  remove (id) {
    const def = roles.get(id)
    if (!def) return false
    if (def.builtin) throw new Error('内置角色不可删除（可修改内容或另建新角色）')
    fs.rmSync(roleFile(id))
    return true
  },
  export (id, destFile) {
    const def = roles.get(id)
    if (!def) throw new Error(`角色不存在: ${id}`)
    fs.mkdirSync(path.dirname(path.resolve(destFile)), { recursive: true })
    fs.copyFileSync(roleFile(id), path.resolve(destFile))
    return path.resolve(destFile)
  },
  import (srcFile, newId) {
    const def = JSON.parse(fs.readFileSync(srcFile, 'utf8'))
    if (newId) def.id = newId
    return roles.save(def)
  }
}
