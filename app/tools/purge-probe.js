#!/usr/bin/env node
/* 清掉「测试注入」留下的一切痕迹（0.45.71）
 *
 * 背景（2026-11-01 主人质问「你自己给他发这个？而且记忆错乱了吧」）：
 * 我用远端 /api/say 注了一句「盯着我刷行测，今天要学到一点」做端到端验证，
 * 但 /api/say 是同一条聊天管线——这句被当成**主人亲口说的**存进了：
 *   - assistant/history/<role>.json      （role:user，他"说过"的话）
 *   - 工作区 self/events/*.jsonl         （自我层事件流：主人开口）
 *   - 工作区 style-samples.jsonl         （她的语气样本：拿假台词学语气）
 *   - 长时记忆（recent 摘要 / facts）    （于是她"记得"两人约好学到一点）
 * 结果她抱着一个没发生过的约定过了一整夜，早上还拿它当事实复盘。
 *
 * 这个脚本只做一件事：按文本定位，把该轮到下一条真人消息之前的整段对话、
 * 以及所有派生出来的记录删干净。**只能删测试注入的内容**，别拿它删真对话。
 *
 * 用法：
 *   node tools/purge-probe.js --text "盯着我刷行测"           # 预演，只报告
 *   node tools/purge-probe.js --text "盯着我刷行测" --apply   # 真删（自动备份 .bak-purge-<ts>）
 *   node tools/purge-probe.js --text "..." --role workspaceid --dataDir "C:\\...\\ryza-assistant-app"
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function argOf (name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return (v && !v.startsWith('--')) ? v : true
}
const TEXT = String(argOf('text', '') || '')
const APPLY = !!argOf('apply', false)
const ROLE = String(argOf('role', '') || '')
const DATA = String(argOf('dataDir', '') || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ryza-assistant-app'))

if (!TEXT) {
  console.error('缺少 --text。用法见文件头。')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const report = []
function backup (file) {
  const b = file + '.bak-purge-' + stamp
  fs.copyFileSync(file, b)
  return b
}
function writeJson (file, obj) {
  const b = APPLY ? backup(file) : ''
  if (APPLY) fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
  return b
}
function writeLines (file, lines) {
  const b = APPLY ? backup(file) : ''
  if (APPLY) fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
  return b
}

function roles () {
  if (ROLE) return [ROLE]
  const dir = path.join(DATA, 'assistant', 'history')
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !/\.bak/.test(f)).map((f) => f.replace(/\.json$/, '')) }
  catch { return [] }
}

/* ---------- 1. 对话历史：删掉「假用户消息 + 它的整轮回答」 ---------- */
function purgeHistory (roleId) {
  const file = path.join(DATA, 'assistant', 'history', roleId + '.json')
  if (!fs.existsSync(file)) return
  let arr
  try { arr = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { report.push('历史读取失败 ' + file + '：' + e.message); return }
  if (!Array.isArray(arr)) return
  const idx = arr.findIndex((m) => m && m.role === 'user' && String(m.content || '').includes(TEXT))
  if (idx < 0) { report.push('历史里没有这条（' + roleId + '）'); return }
  // 只删「这一轮」：从 idx 起，遇到下一条 user / 主动发言（via=proactive 等）/ 间隔超过 5 分钟就停。
  // 不能一路删到下一条 user——半夜的主动台词也是 assistant 角色，会被一起吃掉。
  let end = idx + 1
  const t0 = Number(arr[idx].at) || Date.now()
  while (end < arr.length) {
    const m = arr[end] || {}
    if (m.role === 'user') break
    if (m.via) break                                   // 主动台词属于别的来由
    if (Number(m.at || 0) - t0 > 5 * 60 * 1000) break   // 时间断了，不是同一轮
    end++
  }
  const cut = arr.slice(idx, end)
  report.push('历史 ' + roleId + '：删 ' + cut.length + ' 条（' + cut.map((m) => m.role).join('/') + '），' +
    new Date(cut[0].at).toLocaleString('zh-CN') + ' → ' + new Date((arr[end - 1] || {}).at || Date.now()).toLocaleString('zh-CN'))
  const rest = arr.slice(0, idx).concat(arr.slice(end))
  const b = writeJson(file, rest)
  if (APPLY) report.push('  备份 ' + path.basename(b))
}

/* ---------- 2. 记忆账本：facts 里带这句的全删；recent 只报告 ---------- */
function purgeMemory (roleId) {
  const file = path.join(DATA, 'assistant', 'memory', roleId + '.json')
  if (!fs.existsSync(file)) return
  let m
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { report.push('记忆读取失败：' + e.message); return }
  const before = (m.facts || []).length
  m.facts = (m.facts || []).filter((f) => !String(f.text || '').includes(TEXT))
  const killedFacts = before - m.facts.length
  const recentHit = (m.recent || []).filter((r) => String(r.text || '').includes(TEXT))
  if (killedFacts) {
    const b = writeJson(file, m)
    report.push('记忆 facts：删 ' + killedFacts + ' 条' + (APPLY ? '（备份 ' + path.basename(b) + '）' : ''))
  }
  if (recentHit.length) {
    report.push('记忆 recent：' + recentHit.length + ' 条摘要里混着这句，需要人工改措辞（脚本不动摘要，免得把真事一起删了）')
    for (const r of recentHit) report.push('  · ' + new Date(r.at).toLocaleString('zh-CN') + ' ' + String(r.text).slice(0, 60) + '…')
  }
}

/* ---------- 3. 工作区：自我层事件流 + 语气样本 ---------- */
function workDirs (roleId) {
  const out = []
  const ws = path.join(DATA, 'assistant', 'workspaces', roleId)
  if (fs.existsSync(ws)) out.push(ws)
  return out
}
function purgeWorkspace (roleId) {
  for (const ws of workDirs(roleId)) {
    // 3a 事件流
    const evDir = path.join(ws, 'self', 'events')
    if (fs.existsSync(evDir)) {
      for (const f of fs.readdirSync(evDir).filter((x) => x.endsWith('.jsonl'))) {
        const file = path.join(evDir, f)
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        const keep = lines.filter((l) => !l.includes(TEXT))
        if (keep.length !== lines.length) {
          const b = writeLines(file, keep)
          report.push('事件流 ' + f + '：删 ' + (lines.length - keep.length) + ' 行' + (APPLY ? '（备份 ' + path.basename(b) + '）' : ''))
        }
      }
    }
    // 3b 语气样本
    const st = path.join(ws, 'style-samples.jsonl')
    if (fs.existsSync(st)) {
      const lines = fs.readFileSync(st, 'utf8').split('\n').filter(Boolean)
      const keep = lines.filter((l) => !l.includes(TEXT))
      if (keep.length !== lines.length) {
        const b = writeLines(st, keep)
        report.push('语气样本：删 ' + (lines.length - keep.length) + ' 行' + (APPLY ? '（备份 ' + path.basename(b) + '）' : ''))
      }
    }
  }
}

const ids = roles()
report.push((APPLY ? '【真删】' : '【预演，不改文件】') + ' 数据目录 ' + DATA + '，角色 ' + (ids.join(', ') || '未找到'))
for (const id of ids) {
  purgeHistory(id)
  purgeMemory(id)
  purgeWorkspace(id)
}
console.log(report.join('\n'))
if (!APPLY) console.log('\n加 --apply 才真的写盘（会自动备份）。')
