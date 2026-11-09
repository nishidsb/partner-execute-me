#!/usr/bin/env node
'use strict'
/**
 * 隐私清洗（0.47.0 起常驻）——镜像同步的固定一步。
 *
 * 教训（11-08 入库）：每次从私库整文件拷贝，旧清洗必回退。所以清洗不再手工散做，
 * 清单集中在这里，一次跑全仓；新同步若带回真实原话，重跑本脚本即可。
 *
 * 用法：node scripts/scrub-privacy.cjs          # 全仓清洗（改前自动备份 .bak-scrub 只留最近一次）
 *       node scripts/scrub-privacy.cjs --check  # 只检查不写盘（有残留则 exit 1）
 *
 * 替换原则：改写后的句子必须保住测试要验证的语言学结构（睡词/主语/邀请词/数字位），
 * 同时抹掉可识别的真实生活细节（真实数字、真实措辞、真实安排）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CHECK_ONLY = process.argv.includes('--check')

/** [原始片段, 替换片段, 说明] —— 顺序敏感：长的先换 */
const PAIRS = [
  // ── 主人真实对话原句（测试输入改写：保住语言学结构）──
  ['睡了刚好6小时，应该还好吧', '睡了几个小时，应该还好吧', '作息细节：真实睡眠时长'],
  ['莱莎要是困了就先睡吧，有你定的闹钟就够了', '要是莱莎困了就先睡吧，有闹钟就够了', '真实安排原句'],
  ['莱莎要是困了就先睡吧', '要是莱莎困了就先睡吧', '真实安排原句'],
  ['我暂时可以好好休息了莱莎，来一起看视频吧', '我这边可以好好休息了，来一起看视频吧', '真实约定原句'],
  ['休息了莱莎，来一起看视频吧', '可以好好休息了，来一起看视频吧', '真实约定原句（时间线缩写）'],
  ['休息了休息了，一起来玩游戏吧', '休息了休息了，一起玩游戏吧', '真实对话原句'],
  ['我去眯一会，等下回来一起聊天', '我去眯一会，等下一起再聊', '真实对话原句'],
  ['一起看完这集我就休息了', '这集看完我就休息了', '真实对话原句'],
  ['我先睡了，你们一起玩吧', '我先睡了，你们一起玩', '真实对话原句'],
  ['我11点就睡醒了', '我早上就睡醒了', '作息细节：真实钟点'],
  ['熬夜熬到两点，先睡了，晚安', '熬到很晚，先睡了，晚安', '作息细节：真实钟点'],
  ['昨晚只睡了5个小时', '昨晚没睡够', '作息细节：真实时长'],
  ['最近失眠，烦死', '最近有点失眠', '情绪表达'],
  ['（つく）', '（かな）', '真实语音合成痕迹'],
  ['つく分', 'かな分', '真实语音合成痕迹'],
  ['寂しくなったら、QQ のほうに行くから', '寂しくなったら QQ に行くね', '私人约定原句'],
  ['寂寞了就来 qq 找我吧，我给你设置了特别关注', '寂寞了就来 qq 找我', '私人约定原句'],
  ['11 点半说完就睡了', '说完就睡了', '作息细节：真实钟点'],
  ['感觉你好寂寞啊', '感觉你好像很闲', '私人情绪对话原句'],
  ['是不是不该在你出门的时候打开你', '是不是不该在你不在的时候打开你', '私人情绪对话原句'],
  ['好像有些莫名其妙，我没有说这些话呢', '好像有些奇怪，我没有说过这些话', '主人真实消息原句（0.49.2）'],
  ['我没有说这些话呢', '我没有说过这些话', '主人真实消息原句·短式（0.49.2）'],
  ['不是我说的什么的吧', '不是我说的那句话吧', '主人真实语音转写（0.49.2）'],
  // ── 本机身份 ──
  ['359524452', '10001', '主人真实 QQ 号（测试配置）'],
  ['2738649075', '10002', '机器人真实 QQ 号'],
  ['cialloooo.tailde19b1.ts.net', 'example.tailnet.ts.net', '本机 tailscale 域名']
]

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build'])
const EXT = /\.(js|mjs|cjs|json|md|py|html|css|txt|yaml|yml)$/i

function* walk (dir) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { yield* walk(p); continue }
    if (EXT.test(e.name) && p !== __filename) yield p
  }
}

let files = 0
let hits = 0
for (const file of walk(ROOT)) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { continue }
  let out = text
  let changed = false
  for (const [from, to] of PAIRS) {
    if (out.includes(from)) {
      out = out.split(from).join(to)
      changed = true
      hits++
      console.log((CHECK_ONLY ? '[残留] ' : '[清洗] ') + path.relative(ROOT, file) + ' ← ' + from.slice(0, 24))
    }
  }
  if (changed && !CHECK_ONLY) {
    // 同名 .bak-scrub 只留最近一次，避免备份滚雪球
    try { fs.writeFileSync(file + '.bak-scrub', text, 'utf8') } catch { }
    fs.writeFileSync(file, out, 'utf8')
  }
  if (changed) files++
}

console.log((CHECK_ONLY ? '检查完成：' : '清洗完成：') + files + ' 个文件、' + hits + ' 处')
process.exit(CHECK_ONLY && files > 0 ? 1 : 0)
