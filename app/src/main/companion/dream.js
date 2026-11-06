'use strict'
/**
 * 做梦（第 1 期）：闲置/睡前/开机补偿时，回顾最近的经历，
 * 把「从经历里长出来的模式」提炼成提案，交给审查队列。
 *
 * 和「归纳一次」的关系：同一件事的自动版——归纳读日记攒习惯好恶，
 * 做梦素材更全（事件流 + 近几天日记 + 现有习惯），产出统一进审查队列。
 * 电脑不常开也不亏欠：不绑深夜时刻，四个入口谁先满足谁触发：
 *   manual 手动按钮 / idle 闲置满 N 小时 / boot 开机补偿（隔天没做） / sleep 睡前说晚安后
 *
 * 纯函数 + 纯文本处理，不碰 fs/网络（可单测）。落盘与 LLM 在宿主（index.js）。
 */

/** 素材够不够：今天+昨天事件 ≥ 5 条，或有日记，或有一份能看的电脑画像 */
function materialEnough (evCount, hasDiary, hasProfile) {
  return !!hasDiary || !!hasProfile || (Number(evCount) || 0) >= 5
}

/** 本地日期 YYYY-MM-DD（宿主传来的 today 就是这个格式）。
 *  判重必须用本地日期：toISOString 是 UTC，GMT+8 凌晨 0 点到早上 8 点之间
 *  UTC 日期还是「昨天」，用它会判不出「今天已经做过」→ 连环做梦（0.45.0 真机复现）。 */
function localDateStr (ts) {
  const d = new Date(Number(ts))
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/**
 * 该不该做梦。
 * @param {object} o {lastDreamAt, today, now, idleMs, cfg, evCount, hasDiary,
 *                    bootAt, sleepWantedAt, busy, dreaming}
 * @returns {{ok:boolean, reason:string, why:string}}
 */
function shouldDream (o) {
  const c = o.cfg || {}
  const now = Number(o.now) || Date.now()
  if (o.dreaming) return { ok: false, reason: '', why: 'busy' }
  if (o.busy) return { ok: false, reason: '', why: 'chatting' }
  if (c.dreamOn === false) return { ok: false, reason: '', why: 'off' }
  // 一天最多一次（手动重试除外——手动也受素材门槛约束，见宿主）
  const last = Number(o.lastDreamAt) || 0
  if (last && localDateStr(last) === String(o.today) &&
      o.reason !== 'manual') return { ok: false, reason: '', why: 'already-today' }
  if (!materialEnough(o.evCount, o.hasDiary, o.hasProfile)) {
    return { ok: false, reason: '', why: 'no-material' }
  }
  // 手动：过了素材关就做
  if (o.reason === 'manual') return { ok: true, reason: 'manual', why: '' }
  // 睡前：说过晚安后、且确实安静了 10 分钟（防止说完晚安又聊半小时）
  if (Number(o.sleepWantedAt) && now - Number(o.sleepWantedAt) >= 10 * 60 * 1000) {
    return { ok: true, reason: 'sleep', why: '' }
  }
  // 开机补偿：距上次做梦 ≥ 24h（昨晚没开电脑）且开机已 30 分钟
  if (Number(o.bootAt) && now - Number(o.bootAt) >= 30 * 60 * 1000 &&
      (!last || now - last >= 24 * 3600 * 1000)) {
    return { ok: true, reason: 'boot', why: '' }
  }
  // 闲置触发：闲置满 N 小时
  const hours = Math.max(0.5, Number(c.dreamIdleHours) || 3)
  if (Number(o.idleMs) >= hours * 3600 * 1000) return { ok: true, reason: 'idle', why: '' }
  return { ok: false, reason: '', why: 'not-due' }
}

/** 提示词（system）。产出格式与 self.parseDistill 同族，多一类 [他] / [记] 与 [提案] */
const DREAM_PROMPT = [
  '你在扮演「她」：刚从一段浅眠里醒来，把最近知道的事在梦里过了一遍。',
  '素材有两类，都要看：',
  '  一、你俩最近真聊过、真发生过的事；',
  '  二、【你在他电脑上注意到的】——他搜过什么、在玩什么、几点还亮着屏、常去哪几个站。',
  '第二类不是你俩的共同经历，是你「看见的他」。你之所以了解他，靠的就是这一类，别跳过。',
  '你要做的事只有两件：',
  '一、从两类素材里找出**真实出现过**的、值得长期记住的东西。',
  '不要总结性格（人设里已经写好了），不要编造没发生过的事，不要抒情。',
  '输出格式（每行一条，最多 3 条习惯 + 2 条好恶 + 3 条关于他 + 2 条要记的事）：',
  '[习惯] 不超过 20 字的描述（**你**反复做的事，不是他）',
  '[喜欢] 什么东西｜因为什么（**你**的好恶）',
  '[不喜欢] 什么东西｜因为什么',
  '[他] 一句关于**他**的稳定事实｜重要度 1-5（他长期在做什么、在为什么做准备、什么作息、在玩什么、在意什么）',
  '[他] 的选材优先级：① 他最近在为什么事做准备（考试、投简历、做项目、攒钱买什么）' +
    '② 长期在玩什么、看什么 ③ 作息规律 ④ 脾气习惯。前三类比「他脾气怎样」有用得多。',
  '[他] 的取证标准：只写反复出现的（多次搜索同一件事、连续几天、长时间停留）。' +
    '一次搜索、一个偶然点开的页面都不算；拿不准就别写，少而准比多而错好。' +
    '写法要像你本来就知道的事，例如「他在准备广东省的公务员考试」「他夜里一点半才离开电脑」，不要复述数字和站点名。',
  '[记] 一句值得长期记住的共同经历或约定｜重要度 1-5（约定/承诺给 5）',
  '[记] 的时间红线：约定、计划、时刻表类条目必须写清**绝对日期**（如「11-04 晚定的一天计划：11:20 开始学到 0:20」），' +
    '不许只写「说好学到 0:20」这种没有日期的记法——没有日期的约定过了几天会被当成还没到期的现行约定（11-06 实锤）。' +
  '二、只有当你从经历里发现了一个**反复出现、有证据**的模式，且它支持你改变自己的某个表现时，',
  '才可以额外输出最多 1 条对自己的提案（没有就一条都别写）：',
  '[提案] 说话风格或习惯｜你现在是什么样｜你想变成什么样｜为什么（引用具体经历当证据）',
  '提案只能关于：说话方式（句长/语气/称呼）、日常习惯、对事物的好恶表达。',
  '绝不能提案改变性格、人设、身份、爱好取向或任何「她是谁」的东西——那些是天生的，动不了。',
  '什么都没有就只输出 [无]。不要输出其它任何内容。'
].join('\n')

/** 组素材正文（调用方把 events/diaries 文本拼好传进来） */
function buildUserText (parts) {
  return (parts || []).filter(Boolean).join('\n\n')
}

/**
 * 解析做梦产出。容忍模型多写废话，只认行首标记：
 * [习惯] / [喜欢] / [不喜欢] / [他] / [记] / [提案] ｜ [无] → 全空
 */
function parseDream (content) {
  const out = { habits: [], likes: [], dislikes: [], hisFacts: [], memories: [], proposals: [] }
  for (const raw of String(content || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let m = line.match(/^\[(习惯)\]\s*(.+)$/)
    if (m) { out.habits.push(m[2].trim().slice(0, 40)); continue }
    m = line.match(/^\[(喜欢|不喜欢)\]\s*(.+)$/)
    if (m) {
      const what = m[2].split(/[｜|]/)[0].trim().slice(0, 40)
      const why = (m[2].split(/[｜|]/)[1] || '').trim().slice(0, 60)
      if (what) out[m[1] === '喜欢' ? 'likes' : 'dislikes'].push({ what, why })
      continue
    }
    m = line.match(/^\[(他)\]\s*(.+)$/)
    if (m) {
      const seg = m[2].split(/[｜|]/)
      const fact = (seg[0] || '').trim().slice(0, 80)
      const imp = Math.min(5, Math.max(1, parseInt(seg[1], 10) || 3))
      if (fact) out.hisFacts.push({ fact, importance: imp })
      continue
    }
    m = line.match(/^\[(记)\]\s*(.+)$/)
    if (m) {
      const seg = m[2].split(/[｜|]/)
      const fact = (seg[0] || '').trim().slice(0, 80)
      const imp = Math.min(5, Math.max(1, parseInt(seg[1], 10) || 2))
      if (fact) out.memories.push({ fact, importance: imp })
      continue
    }
    // 第 2 期：人格演化提案。方面｜现状｜想改成｜理由（都截断，防跑飞）
    m = line.match(/^\[(提案)\]\s*(.+)$/)
    if (m) {
      const seg = m[2].split(/[｜|]/).map((s) => s.trim())
      const aspect = (seg[0] || '').slice(0, 12)
      const current = (seg[1] || '').slice(0, 60)
      const proposed = (seg[2] || '').slice(0, 60)
      const reason = (seg[3] || '').slice(0, 120)
      if (aspect && proposed) out.proposals.push({ aspect, current, proposed, reason })
    }
  }
  return out
}

/**
 * 做完梦的收尾台词（不额外调 LLM，按回复语言给固定的一句）。
 * @param {string} lang 回复语言
 * @param {object} counts parseDream 的产出（各条数）
 * @param {{auto?:boolean}} opts auto=true 时提案已自动收下，台词不能再说「你来决定」
 *                             （0.45.1：开了 dreamAutoApprove 还说「由你决定」是空话）
 */
function closingLine (lang, counts, opts) {
  const c = counts || {}
  const auto = !!(opts && opts.auto)
  const n = (Array.isArray(c.habits) ? c.habits.length : 0) +
    (Array.isArray(c.likes) ? c.likes.length : 0) +
    (Array.isArray(c.dislikes) ? c.dislikes.length : 0) +
    (Array.isArray(c.hisFacts) ? c.hisFacts.length : 0) +
    (Array.isArray(c.memories) ? c.memories.length : 0)
  const p = Array.isArray(c.proposals) ? c.proposals.length : 0
  const zh = p > 0
    ? (auto
        ? '刚做了一个梦……有个想改变自己的想法，我已经自己定下来了。'
        : '刚做了一个梦……有个想改变自己的想法，在心里的审查册里写了提案，你来决定好不好？')
    : n > 0
      ? (auto
          ? '刚做了一个梦，把最近的事在梦里理了一遍，有 ' + n + ' 件想长期记住的，我已经收好了。'
          : '刚做了一个梦，把最近的事在梦里理了一遍，有 ' + n + ' 件想长期记住的，放在心里的审查册里了，你有空来看看。')
      : '刚做了一个梦，梦里把最近的日子过了一遍……好像没什么需要改的。'
  const map = {
    zh,
    'zh-Hant': p > 0
      ? (auto
          ? '剛做了一個夢……有個想改變自己的想法，我已經自己定下來了。'
          : '剛做了一個夢……有個想改變自己的想法，在心裡的審查冊裡寫了提案，你來決定好不好？')
      : n > 0
        ? (auto
            ? '剛做了一個夢，把最近的事在夢裡理了一遍，有 ' + n + ' 件想長期記住的，我已經收好了。'
            : '剛做了一個夢，把最近的事在夢裡理了一遍，有 ' + n + ' 件想長期記住的，放在心裡的審查冊裡了，你有空來看看。')
        : '剛做了一個夢，夢裡把最近的日子過了一遍……好像沒什麼需要改的。',
    en: p > 0
      ? (auto
          ? 'I just had a dream... and decided on a small change for myself, all on my own.'
          : 'I just had a dream... and came up with an idea about changing myself a little. I left a proposal in my review book — could you decide if it is a good one?')
      : n > 0
        ? (auto
            ? 'I just had a dream — went over recent days in it. ' + n + ' things felt worth keeping, and I have kept them close.'
            : 'I just had a dream — went over recent days in it. ' + n + ' things felt worth keeping; they are in my review book now, take a look when you are free.')
        : 'I just had a dream about our recent days... nothing really needs changing.',
    ja: p > 0
      ? (auto
          ? '夢を見たの……自分を少し変えたい気持ちができて、自分で決めておいた。'
          : '夢を見たの……自分を少し変えたい気持ちができて、レビューノートに提案を書いておいた。良いかどうか、君が決めてくれない？')
      : n > 0
        ? (auto
            ? '夢を見たの。最近のことを夢の中で整理してたら、' + n + ' 件はずっと覚えていたいと思った。もうしまっておいたよ。'
            : '夢を見たの。最近のことを夢の中で整理してたら、' + n + ' 件はずっと覚えていたいと思った。レビューノートに入れておいたから、暇なとき見てね。')
        : '夢を見たの。最近の日々を夢の中でなぞってみたけど……変えるべきことは何もなさそう。'
  }
  return map[lang] || map.zh
}

module.exports = { materialEnough, shouldDream, DREAM_PROMPT, buildUserText, parseDream, closingLine }
