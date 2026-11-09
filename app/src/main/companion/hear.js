'use strict'
/**
 * 听觉通道（0.46.54）——她终于有耳朵了。
 *
 * 用户想法（2026-11-05）：「让角色真正听到声音，不是语音转文字的那种，而是真正听到」。
 * 转写（whisper）解决的是「听懂字」，这里解决的是「听见声」：响度、频段构成、动静节奏——
 * 像生物的听觉那样先于语言地感知环境（他在放歌、屋里很吵、突然安静下来了）。
 *
 * 数据流：宠物悬浮窗常驻倾听那条麦克风流（micOn 的 analyser）渲染层就地提特征
 * （1 秒一条：响度 rms / 低中高频段占比 / 起伏次数），ipc 发到主进程这里聚合。
 * 隐私红线（0.48.0 修订）：本通道**不录音、不转写、音频数据不出渲染层不落盘不出网**——
 * 进主进程的只有每秒几十字节的特征数字。声纹通道（voiceprint.js，0.48.0，主人拍板的
 * 「认人」能力）是另一条独立通路：录音期间同源采 16k PCM 进主进程内存、只算嵌入
 * 算完即弃，同样不落盘不出网；模板只有 512 维向量、可撤回。两通道各自守各自的线。
 * 隐私基线与画像三条硬约束（只读/不出本机/可撤回）同构。
 *
 * 诚实原则（同类坑#4）：麦没开 / hearOn 关了 / 没有数据 → 如实 ok:false，
 * 绝不静默假装「听到了点什么」。
 *
 * 阈值标定说明：响度档位与「像什么」的映射是首版经验值（麦克风增益因设备而异），
 * 待真机日志迭代——映射表对着真机听感输出调，别拍脑袋改。
 */
const NOW_MS = 1000           // 采样节拍（渲染层 1s 一条）
const CUR_MS = 12 * 1000      // 「现在听起来」的观察窗
const STALE_MS = 15 * 1000    // 超过这么久没样本 = 耳朵没数据
const KEEP_MS = 3 * 60 * 1000 // 突变事件的保质期

let st = { on: false }
let buf = [] // { t, rms, low, mid, high, onsets }（low/mid/high 已是 0~1 均值）
let nowFn = () => Date.now()

function resetForTest () {
  st = { on: false }
  buf = []
  nowFn = () => Date.now()
}
function _setNow (fn) { nowFn = fn || (() => Date.now()) }

function configure (o) {
  if (!o) return
  if (o.on !== undefined) st.on = o.on === true
}

function status () {
  return { on: st.on, samples: buf.length, lastAt: buf.length ? buf[buf.length - 1].t : 0 }
}

/** 渲染层一条特征摘要进来。hearOn 关着时直接丢弃（渲染层也不该在开流）。 */
function ingest (f) {
  if (!st.on) return false
  if (!f || typeof f !== 'object') return false
  const t = Number(f.t)
  const rms = Number(f.rms)
  if (!Number.isFinite(t) || !Number.isFinite(rms) || rms < 0) return false
  const s = {
    t,
    rms: Math.min(1, rms),
    low: clamp01(Number(f.low)),
    mid: clamp01(Number(f.mid)),
    high: clamp01(Number(f.high)),
    on: Number(f.onsets) || 0,
    src: f.src === 'sys' ? 'sys' : 'mic' // mic=房间里的声音（空气声）；sys=电脑自己发出的（回环）
  }
  buf.push(s)
  const cutoff = nowFn() - 120 * 1000 // 留 2 分钟：够突变对比，也控制内存
  if (buf.length > 240 || (buf.length && buf[0].t < cutoff)) {
    buf = buf.filter((x) => x.t >= cutoff).slice(-240)
  }
  return true
}
function clamp01 (v) { return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0 }

function median (arr) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
function avg (arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0 }

const LEVELS = [
  { max: 0.012, key: 'quiet', text: '几乎听不见什么（很安静）' },
  { max: 0.04, key: 'soft', text: '很轻的背景声' },
  { max: 0.12, key: 'ambient', text: '有些声响' },
  { max: 0.3, key: 'noisy', text: '挺吵的' },
  { max: Infinity, key: 'loud', text: '很吵' }
]

/**
 * 听感描述。ok:true 时 text 是一句给 LLM 看的中文；
 * ok:false 时 reason 说明耳朵为什么没数据（诚实降级）。
 */
function describe () {
  if (!st.on) return { ok: false, reason: '听觉通道没启用（hearOn 已关）' }
  if (!buf.length) return { ok: false, reason: '耳朵里还没有数据（麦克风没开，或刚启动还没听满一秒）' }
  const now = nowFn()
  if (now - buf[buf.length - 1].t > STALE_MS) {
    return { ok: false, reason: '耳朵里最近没有声音进来（麦克风可能被关了或被占用了）' }
  }
  const win = buf.filter((x) => x.t >= now - CUR_MS)
  const cur = win.length ? win : buf.slice(-8)
  const med = median(cur.map((x) => x.rms))
  const level = LEVELS.find((l) => med < l.max) || LEVELS[LEVELS.length - 1]

  const tags = []
  const low = avg(cur.map((x) => x.low))
  const mid = avg(cur.map((x) => x.mid))
  const high = avg(cur.map((x) => x.high))
  const sum = low + mid + high + 1e-6
  const lowShare = low / sum
  const midShare = mid / sum
  const highShare = high / sum
  const onRate = avg(cur.map((x) => x.on)) // 次/秒

  if (level.key !== 'quiet') {
    if (lowShare > 0.48 && onRate >= 0.5) tags.push('低频重、有起伏（像在放音乐或视频的声音）')
    else if (lowShare > 0.5) tags.push('低频持续的嗡鸣（像空调、风扇或机器的声音）')
    if (midShare > 0.42 && lowShare < 0.45) tags.push('中频为主（像有人在说话或在看有对话的内容）')
    if (highShare > 0.42 && highShare > lowShare) tags.push('高频碎响（像键盘、鼠标或小物件的动静）')
    if (onRate >= 2.5) tags.push('动静断断续续、节奏密（正有人在动手做事的样子）')
    if (!tags.length) tags.push('说不上是什么的持续环境声')
  }

  // 突变：两段不重叠的窗（刚才 12 秒 vs 它前面那 10 秒），避免跨界中位数失真
  const events = []
  const prevWin = buf.filter((x) => x.t >= now - CUR_MS - 10 * 1000 && x.t < now - CUR_MS)
  if (prevWin.length >= 4) {
    const prevMed = median(prevWin.map((x) => x.rms))
    if (prevMed > 0.012 && med > prevMed * 2.5 && med - prevMed > 0.03) events.push('刚才突然吵起来了')
    else if (prevMed > 0.04 && med < prevMed / 3) events.push('刚才那边突然安静下来了')
  }

  const parts = ['响度：' + level.text]
  if (tags.length) parts.push('听起来' + tags.join('；'))
  if (events.length) parts.push(events.join('；'))
  // 来源标注：sys=回环（戴耳机放歌/没麦时她唯一的耳朵），明说这是电脑自己在响
  if (buf.length && buf[buf.length - 1].src === 'sys') {
    parts.push('（这是这台电脑自己发出的声音——他戴着耳机或者没开麦时，你只能听到这一路）')
  }
  const text = parts.join('。') + '。'
  return { ok: true, level: level.key, tags, events, text, at: now }
}

/** 上下文注入块（像 moodBlock）：安静且无事 → 空串（不浪费预算，也不装模作样）。 */
function block () {
  const d = describe()
  if (!d.ok) return ''
  if (d.level === 'quiet' && !(d.events && d.events.length)) return ''
  return d.text
}

module.exports = { configure, ingest, describe, block, status, resetForTest, _setNow, LEVELS }
