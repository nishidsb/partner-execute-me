/**
 * 角色与人格系统：角色设定全部是 data/roles/<id>.json 独立配置，不写死在代码里。
 * 支持创建/修改/切换/移除、导入导出。角色模块可选——通用助手就是一个无人格角色。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataPath } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUILTIN_DIR = path.join(__dirname, 'builtin')

function sanitizeId (id) {
  const s = String(id || '').trim().replace(/[^\w.-]/g, '_')
  if (!s) throw new Error('角色 id 不能为空（仅允许字母/数字/下划线/点/横线）')
  return s
}

function roleFile (id) { return dataPath('roles', `${sanitizeId(id)}.json`) }

export const roles = {
  /** 首次启动：把内置角色 seed 到 data/roles（已存在则跳过，不覆盖用户改动） */
  seedBuiltin () {
    fs.mkdirSync(dataPath('roles'), { recursive: true })
    for (const f of fs.readdirSync(BUILTIN_DIR)) {
      if (!f.endsWith('.json')) continue
      const dest = dataPath('roles', f)
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(BUILTIN_DIR, f), dest)
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
    const clean = {
      id,
      name: String(def.name || id),
      persona: String(def.persona || ''),
      replyLang: String(def.replyLang || ''), // 回复语言守卫目标（如 zh/en/ja，空=不校验）
      worldInfo: Array.isArray(def.worldInfo) ? def.worldInfo : [],
      params: def.params && typeof def.params === 'object' ? def.params : {},
      tools: Array.isArray(def.tools) ? def.tools : null, // null=允许全部
      builtin: !!def.builtin
    }
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
