'use strict'
;(function () {
/* 伙伴 · overlay 内嵌渲染
 * 独立透明 BrowserWindow 在本机被 Chromium 挂起合成器（画面冻结在第 1 帧，
 * 所有开关均无效），而桌面层 overlay 窗口合成正常——所以角色直接渲染在这里。
 * 逻辑与 companion/pet 窗口版本一致：立绘 / Spine（多运行时版本锁定）/ VRM。
 */
const $ = (id) => document.getElementById(id)
const basename = (p) => String(p || '').replace(/\\/g, '/').split('/').pop()
/* 诊断日志开关：心跳/位图 dump 都要读画布像素（getImageData 是真菊花），
 * 每 2 秒两次在高分屏上会把 GPU 读回拖慢整机光标。默认关，排障时在控制台
 * 执行 `window.__ryzaTrace = 1` 再重载即可打开。 */
const TRACE = () => !!window.__ryzaTrace

let vrmRuntime = null
let spineRuntime = null
let spineRafStarted = false
let currentSig = ''

// ---- 伙伴增强状态 ----
let petScale = 0 // 0 = 尚未从设置读取
let onTapHook = null // spine 加载后注入：轻点角色触发触摸反应
let cursorScreen = null // 主进程广播的全局光标（屏幕坐标）
let cursorMoveAt = 0 // 最近一次光标移动时间（视线跟踪的保持/释放）
let positionChat = () => {} // v0.3.1 修复：由 setupChat 赋值，setupDrag 等外部作用域引用不再 ReferenceError
let positionBubble = () => {} // 同理：位置更新回调里要跟着角色重贴气泡
let positionAsk = () => {} // S3：提问气泡同样要跟着角色走

/* 合成器活性探针：rAF 只在合成器调度 BeginFrame 时触发。
 * 若 rAF 计数不涨而 setInterval 正常 → 合成器被挂起（画面冻结的真凶） */
let rafCount = 0
;(function probeRaf () { rafCount++; requestAnimationFrame(probeRaf) })()
function liveness () {
  return ' rAF=' + rafCount + ' vis=' + document.visibilityState
}

/* 忙/闲判定（Coopanion RESTING_FPS 同款）：走动/拖拽/说话/悬停=忙，其余=闲。
 * 忙时满帧，闲时渲染循环降到低帧率——待机呼吸在 15fps 下肉眼无差，GPU 直接省一半。
 * 给 spine 循环与 vrmStage 共用，所以放在模块级。 */
/* 部位 → motion_touch 反应动作词表（桌面直接点她和手机远程摸共用；
 * 原在 showSpine 内，0.24.0 手机触摸要广播触发，提到模块级） */
const TOUCH_REACTIONS = {
  head: ['motion_touch_A_001_active', 'motion_touch_A_002_active'],
  body: ['motion_touch_A_004_active'],
  breast: ['motion_touch_A_003_active'],
  arm_l: ['motion_touch_A_005_active'],
  arm_r: ['motion_touch_A_006_active'],
  weast: ['motion_touch_A_007_active']
}
/** 播部位触摸反应动作（摸完接回 idle）。spineAnimCtx 由 showSpine 在骨架就绪后赋值 */
function playTouchMotion (part) {
  // 形象包（无骨骼素材）：走程序化姿态，摸哪儿就动哪儿
  if (figureLoop && typeof figureLoop.play === 'function') {
    const word = part === 'head' ? 'blush' : (part === 'arm_l' || part === 'arm_r' ? 'wave' : part === 'weast' ? 'jump' : 'shy')
    if (figureLoop.play(word)) return
  }
  const ctx = spineAnimCtx
  if (!ctx || !ctx.state || !ctx.anims || !ctx.idle) return
  const cands = TOUCH_REACTIONS[part] || []
  let animName = cands.find((n) => ctx.anims.some((x) => x.name === n))
  if (!animName) {
    const any = ctx.anims.find((x) => /motion_touch/i.test(x.name))
    animName = any && any.name
  }
  if (!animName) return
  try {
    ctx.state.setAnimation(0, animName, false)
    ctx.state.addAnimation(0, ctx.idle.name, true, 0)
  } catch (e) { console.warn('[pet-ov] 触摸动作播放失败:', e && e.message) }
}
function petBusy () {
  if (window.__petDragging || window.__petDragActive) return true
  const stage = document.getElementById('petStage')
  if (stage && stage.classList.contains('is-walking')) return true
  const bubble = document.getElementById('petBubble')
  if (bubble && !bubble.hidden) return true
  const chat = document.getElementById('petChat')
  if (chat && !chat.hidden) return true
  const ask = document.getElementById('petAsk')
  if (ask && !ask.hidden) return true
  return false
}

/* ---- 语音播放：全局单实例（新语音开始时打断上一条，杜绝重叠回声） ---- */
let nowPlaying = null
let voiceSettle = null // 当前播放的「结束回调」：onended/onerror/被 stopVoice 打断时都触发一次
let curSaySeq = 0      // 0.46.77 当前这句 say 的序号——播完时随 pet:voice-done 回传主进程
let voiceSettleSeq = 0 // 0.46.77 voiceSettle 对应那句的 seq（被打断时回传的仍是正在结束的那句）
function settleVoice () {
  if (!voiceSettle) return
  const fn = voiceSettle
  voiceSettle = null
  try { fn() } catch {}
  // 0.46.77 播完回传：多句独白/自语等这句真播完再接下一句（主进程 waitVoiceDone）
  try { if (window.aura.petVoiceDone) window.aura.petVoiceDone({ seq: voiceSettleSeq }) } catch {}
}
/** 说话口型：3D 角色在语音播放期间张嘴（VRM expressionManager 的 aa 预设）。
 *  普通 GLB / 立绘没这个能力，内部会自己跳过。
 *  0.46.61：Spine 也有口型了——模型自带 facial_mouth_XXX_active 70 个嘴形动画
 *  （参考项目 AgentAtelierR 同款能力），语音播放期间在 6 号轨（最高轨）循环换嘴形。 */
function setTalking (on) {
  if (vrmRuntime && vrmRuntime.setTalk) { try { vrmRuntime.setTalk(on) } catch {} }
  // 0.41.0：形象包也有口型了（包里画了 part:'mouth' 的层才看得见）
  if (figureLoop && figureLoop.setTalk) { try { figureLoop.setTalk(on) } catch {} }
  spineTalk(on)
}

/* ---- Spine 说话口型（0.46.63 照抄参考项目 AgentAtelierR 同款机制）----
   参考 lib/src/character_lipsync.dart + chat_screen._sampleSpeechEnvelope：
   1) 主进程合成 wav 时提取 20ms 帧振幅包络（audio_envelope.dart 同款算法，随 IPC 带回）
   2) 把一个「scrub 嘴型动画」（facial_mouth_XXX_scrub_XX，内含完整开合周期）放上
      专用轨 6 并冻结（timeScale=0），按音频能量拖播放头：time = duration × 开合度（≤48%）
   3) 无包络（mp3/系统语音）：参考项目同款正弦兜底（5.2Hz、28% 相位闭嘴）
   0.46.61/62 的「轮换/节奏引擎」降级为无 scrub 动画骨架的兜底。 */
let spineTalkTimer = null
let spineTalkActive = false
let spineTalkGestureTimer = null
let spineTalkEnv = null          // 当前语音的振幅包络 { frameMs, values, rawRms }
let spineTalkDynamics = null     // 口型动态状态（attack/release/闭嘴保持）
let spineTalkAudio = null        // 正在播的 <audio>（取 currentTime 定位包络）
let spineTalkStartMs = 0         // 无 audio 时的时间基准
const SPINE_MOUTH_TRACK = 6
/* 说话时的自动小动作（用户 11-06：参考项目说话时会自然做动作）。保守版：
   只挑「轻声/倾听/轻快」类轻量手势（权威词表解析，站/坐骨架自适应），~9-15s
   随机一档、35% 概率才动——说话时手上有小动作，不是抽风。 */
const TALK_GESTURE_WORDS = ['轻声回应', '安静回应', '轻快回应', '轻幅问候']
function spineTalkGestureTick () {
  if (Math.random() > 0.35) return
  const w = TALK_GESTURE_WORDS[Math.floor(Math.random() * TALK_GESTURE_WORDS.length)]
  const hit = resolveSpineWord(w)
  if (hit && hit.combo && hit.combo.length) playSpineAction(hit.combo)
}
/* 包络采样 + 口型动态（character_lipsync.dart 逐行移植，默认参数） */
const LIP = { dipThreshold: 0.1, ratio: 0.1, minHoldMs: 50, refWindowMs: 500, rmsCeiling: 1, floorDb: -40, ceilingDb: -3, attackMs: 20, releaseMs: 60 }
function lipSample (posMs) {
  const env = spineTalkEnv
  if (!env || !env.values || !env.values.length) return 0
  const frame = env.frameMs || 20
  const exact = posMs / frame
  const lower = Math.max(0, Math.min(env.values.length - 1, Math.floor(exact)))
  const upper = Math.min(env.values.length - 1, lower + 1)
  const energy = env.values[lower] + (env.values[upper] - env.values[lower]) * (exact - Math.floor(exact))
  if (!spineTalkDynamics) return energy
  const d = spineTalkDynamics
  if (d.prev != null && posMs < d.prev) { d.prev = null; d.openness = 0; d.closedUntil = 0 } // 倒带 → 重置
  d.prev = posMs
  // 参考窗（500ms）内峰值：能量下探 = 音节间隙 → 闭嘴
  const startIdx = Math.max(0, lower - Math.ceil(LIP.refWindowMs / frame))
  let reference = 0
  for (let i = startIdx; i <= lower; i++) reference = Math.max(reference, env.values[i])
  const inAudio = posMs < frame * env.values.length
  const closed = !inAudio || energy < LIP.dipThreshold || (reference > LIP.dipThreshold && energy < reference * LIP.ratio)
  if (closed) d.closedUntil = Math.max(d.closedUntil, posMs + LIP.minHoldMs)
  let target = 0
  if (!closed && posMs >= d.closedUntil && env.rawRms && env.rawRms.length === env.values.length) {
    const rms = Math.min(LIP.rmsCeiling, Math.max(0.000001, env.rawRms[lower]))
    const db = 20 * Math.log(rms / LIP.rmsCeiling) / Math.LN10
    target = Math.max(0, Math.min(1, (db - LIP.floorDb) / (LIP.ceilingDb - LIP.floorDb)))
  }
  const deltaMs = d.lastPos == null ? frame : Math.min(100000, Math.max(0, posMs - d.lastPos))
  d.lastPos = posMs
  const resp = target > d.openness ? LIP.attackMs : Math.max(LIP.releaseMs, closed ? 60 : 0)
  d.openness += (target - d.openness) * (1 - Math.exp(-deltaMs / Math.max(1, resp)))
  if (target === 0 && d.openness < 0.005) d.openness = 0
  return Math.max(0, Math.min(1, d.openness))
}
function spineTalk (on) {
  const ctx = spineAnimCtx
  if (!ctx || !ctx.state) { spineTalkStop(); return }
  if (on) {
    if (spineTalkActive) return
    // 首选：scrub 嘴型动画（参考项目 lipSyncScrubClip 同款，002 是他们各表情的默认）
    const scrub = (ctx.anims || []).find((a) => a.name === 'facial_mouth_002_scrub_01')
      || (ctx.anims || []).find((a) => /facial_mouth_\d+_scrub_\d+$/i.test(a.name))
    if (scrub) {
      let entry = null
      try {
        entry = ctx.state.setAnimation(SPINE_MOUTH_TRACK, scrub.name, false)
        entry.timeScale = 0            // 冻结：播放头由音频能量拖动（scrub）
        entry.mixBlend = 2             // MixBlend.replace：盖住下层嘴部姿态
        entry.alpha = 0.56             // preset.lipSyncAlpha 默认
      } catch { entry = null }
      if (entry) {
        spineTalkActive = true
        spineTalkStartMs = performance.now()
        spineTalkDynamics = { prev: null, lastPos: null, openness: 0, closedUntil: 0 }
        const dur = scrub.duration || 0
        const tick = () => {
          if (!spineTalkActive) return
          const cc = spineAnimCtx
          if (!cc || !cc.state) { spineTalkStop(); return }
          // 能量：有包络按播放位置采样；没有走参考项目正弦兜底
          let mouthOpen
          if (spineTalkEnv) {
            const posMs = spineTalkAudio && spineTalkAudio.currentTime
              ? spineTalkAudio.currentTime * 1000
              : (performance.now() - spineTalkStartMs)
            const energy = lipSample(posMs)
            mouthOpen = energy < 0.08 ? 0 : Math.min(0.48, Math.pow((energy - 0.08) / 0.92, 0.78) * 0.48)
          } else {
            const seconds = spineTalkAudio && spineTalkAudio.currentTime
              ? spineTalkAudio.currentTime
              : (performance.now() - spineTalkStartMs) / 1000
            const phase = (seconds * 5.2) % 1
            const shut = phase < 0.28
            const pulse = shut ? 0 : Math.abs(Math.sin((phase - 0.28) / 0.72 * Math.PI))
            mouthOpen = (shut ? 0 : 0.24 + pulse * 0.46) * 0.48
          }
          try { entry.time = dur * mouthOpen } catch { }
        }
        tick()
        spineTalkTimer = setInterval(tick, 33)   // ~30fps 拖播放头
        if (!spineTalkGestureTimer) {
          spineTalkGestureTimer = setInterval(spineTalkGestureTick, 9000 + Math.floor(Math.random() * 6000))
        }
        return
      }
    }
    // 兜底：骨架没有 scrub 动画 → 0.46.62 节奏引擎（2 嘴形交替开合+词间停顿）
    const mouths = (ctx.anims || []).filter((a) => /^facial_mouth_\d+_active$/i.test(a.name))
    if (!mouths.length) return
    const va = mouths[0].name
    const vb = mouths[mouths.length >> 1].name
    spineTalkActive = true
    const burst = () => {
      if (!spineTalkActive) return
      const c = spineAnimCtx
      if (!c || !c.state) { spineTalkStop(); return }
      let i = 0
      const n = 2 + Math.floor(Math.random() * 3)
      const syllable = () => {
        if (!spineTalkActive) return
        const cc = spineAnimCtx
        if (!cc || !cc.state) { spineTalkStop(); return }
        if (i >= n) {
          try { cc.state.setEmptyAnimation(SPINE_MOUTH_TRACK, 0.08) } catch { }
          spineTalkTimer = setTimeout(burst, 200 + Math.floor(Math.random() * 260))
          return
        }
        try { cc.state.setAnimation(SPINE_MOUTH_TRACK, i % 2 ? vb : va, false) } catch { }
        i++
        spineTalkTimer = setTimeout(syllable, 180 + Math.floor(Math.random() * 70))
      }
      syllable()
    }
    burst()
    if (!spineTalkGestureTimer) {
      spineTalkGestureTimer = setInterval(spineTalkGestureTick, 9000 + Math.floor(Math.random() * 6000))
    }
  } else {
    spineTalkStop()
  }
}
function spineTalkStop () {
  if (spineTalkGestureTimer) { clearInterval(spineTalkGestureTimer); spineTalkGestureTimer = null }
  spineTalkActive = false
  spineTalkEnv = null
  spineTalkAudio = null
  spineTalkDynamics = null
  if (spineTalkTimer) { clearInterval(spineTalkTimer); spineTalkTimer = null }
  const ctx = spineAnimCtx
  if (ctx && ctx.state) { try { ctx.state.setEmptyAnimation(SPINE_MOUTH_TRACK, 0.12) } catch { } }
}
/** 播放一段语音；返回 Promise，在播放结束/失败/被打断时 resolve（气泡靠它跟语音对齐） */
function playVoice (url, speed, vol, env) {
  return new Promise((resolve) => {
    try {
      if (nowPlaying) { nowPlaying.pause(); nowPlaying = null }
      settleVoice() // 上一段被打断 → 它的等待者立即收尾
      const a = new Audio(url)
      if (speed && speed !== 1) a.playbackRate = speed
      // 0.46.11 嘀咕音量：自言自语用低音量播（缺省 1 = 正常说话）
      const v = Number(vol)
      if (Number.isFinite(v)) a.volume = Math.min(1, Math.max(0.05, v))
      nowPlaying = a
      // 0.46.63 口型：包络随 IPC 带回；scrub 播放头按 audio.currentTime 定位
      spineTalkEnv = env && env.values && env.values.length ? env : null
      spineTalkAudio = a
      let done = false
      const finish = () => {
        if (done) return
        done = true
        if (nowPlaying === a) nowPlaying = null
        setTalking(false)
        resolve()
      }
      voiceSettle = finish
      voiceSettleSeq = curSaySeq   // 0.46.77 记下这段语音属于哪句 say（被打断/播完都回传它）
      a.onended = finish
      a.onerror = finish
      setTalking(true)
      a.play().catch(finish)
    } catch { resolve() }
  })
}
/** 立刻停止当前语音（发送新消息/新的语音反馈时用） */
function stopVoice () {
  try {
    if (nowPlaying) { nowPlaying.pause(); nowPlaying = null }
    settleVoice()
    if (window.speechSynthesis) speechSynthesis.cancel()
  } catch {}
}
/* ---- 触摸反应语音（对齐参考项目 tap_voice：不同部位不同反应语，随机变体）。
   短语语言跟「AI 回复语言」设置走（pet:config 广播 / petSpeak 返回的 lang），与朗读音色解耦 ---- */
const TOUCH_VOICE = {
  zh: {
    head: ['唔…不要揉头啦，头发会乱掉的', '嗯？摸头的话……就饶你这一次', '呜…头要被摸开了啦'],
    arm_l: ['咦，拉我的左手做什么呀', '手手不能随便牵哦'],
    arm_r: ['右手要用来拿东西的，别抓着不放啦', '咦？右臂怎么了吗'],
    body: ['别戳了啦，好痒的', '有什么话就好好说嘛'],
    breast: ['请、请自重！那里不可以！', '再碰那里真的要生气了哦'],
    weast: ['腰、腰不可以随便碰！', '戳腰是想让我跳起来吗'],
    /* S2：拖拽/抛掷语义（对齐参考项目 grab/drop/throw/crash） */
    grab: ['呀，突然被拎起来了…', '唔…要抱我去哪儿呀'],
    drop: ['放、放我下来啦', '嗯…这里还行，就这么待着吧'],
    throw: ['哇啊——别扔我！', '要、要飞出去了——！'],
    crash: ['呜…撞到了啦', '头好晕…下次轻一点嘛']
  },
  ja: {
    head: ['ん…頭を撫でないで〜髪が乱れちゃう', 'えっ？頭なら…まあ今回だけ許してあげる', 'うぅ…頭がぐしゃぐしゃになっちゃう'],
    arm_l: ['わっ、急に左手引っ張らないでよ', '手は勝手に繋いじゃダメだよ？'],
    arm_r: ['右手は物を持つのに使うの！離して〜', 'え、右腕がどうかした？'],
    body: ['つつかないで〜くすぐったいってば', '何か話があるなら、ちゃんと言ってよね'],
    breast: ['ちょっ、ダメ！そこは触っちゃダメ！', '本当に怒るからね！'],
    weast: ['お、お腹は駄目〜！くすぐったい！', 'つつくと飛び上がっちゃうでしょ！'],
    grab: ['わっ、急に持ち上げないで〜！', 'え、どこに連れて行くの…？'],
    drop: ['お、おろしてよ〜', 'うん…ここならいいかな'],
    throw: ['わああっ、投げないでー！', '飛、飛んでいっちゃうー！'],
    crash: ['うぅ…ぶつかっちゃった', '頭がくらくらする…次は優しくしてね']
  },
  en: {
    head: ['Hey, stop ruffling my hair!', 'Hmm? Okay, just this once...', 'Ah, you are messing up my hair!'],
    arm_l: ['Why are you pulling my arm?', 'You cannot just grab my hand, okay?'],
    arm_r: ['I need this hand for things! Let go~', 'Is something wrong with my arm?'],
    body: ['Stop poking me, that tickles!', 'If you have something to say, just say it.'],
    breast: ['P-please! That is not okay!', 'Touch there again and I will be mad!'],
    weast: ['N-not the waist! That tickles!', 'Poke me there and I will jump, I swear!'],
    grab: ['Whoa, warn me before you pick me up!', 'H-hey, where are we going?'],
    drop: ['P-put me down already~', 'Hmm, this spot is fine I guess'],
    throw: ['Waaah, do not throw me!', 'I-I am flying——!'],
    crash: ['Oof… I hit something', 'My head is spinning… be gentler next time']
  }
}
let touchLang = 'zh'
/* 0.19.0 回应模式：安静模式只演动作、不出反应语；自定义模式只对勾选的类别出声。
   部位→类别映射必须与主进程 src/main/companion/reaction.js 一致（test/reaction.test.js 会断言）。 */
const TAP_CATEGORY = {
  head: 'pet', body: 'poke', weast: 'poke', breast: 'poke', arm_l: 'poke', arm_r: 'poke',
  grab: 'drop', drop: 'drop', throw: 'throw', crash: 'throw'
}
let reactionMode = 'active'
let reactionTypes = null
function reactNow (part) {
  if (reactionMode === 'active') return true
  const cat = TAP_CATEGORY[part] || 'poke'
  if (reactionMode === 'custom') {
    const list = Array.isArray(reactionTypes) && reactionTypes.length ? reactionTypes : ['pet', 'poke', 'throw', 'drop']
    return list.includes(cat)
  }
  return false // quiet：当场不出声，主进程会记着等下次开口
}
function speakTouch (part) {
  if (!petHosted) return // 触摸反应语只由角色所在屏播报（否则两块屏各合成一次 = 双声道）
  if (!reactNow(part)) return // 回应模式：安静/未勾选的类别，只演动作不出声
  if (isQuiet()) return // pet_quiet 期间不出声（触摸反馈只有动作）
  const set = TOUCH_VOICE[touchLang] || TOUCH_VOICE.zh
  const lines = set[part]
  if (!lines || !window.aura || !window.aura.petSpeak) return
  const text = lines[Math.floor(Math.random() * lines.length)]
  window.aura.petSpeak(text).then((r) => {
    // 主进程把当前回复语言带回，触摸短语语种保持同步
    if (r && r.lang && TOUCH_VOICE[r.lang]) touchLang = r.lang
    if (r && r.ok && r.url) return playVoice(r.url, r.speed, undefined, r.env)
    // 未配置 API TTS → 系统 voice 念一遍（保持有反馈，语种跟当前语言）
    if (r && r.fallback && window.speechSynthesis) {
      try {
        speechSynthesis.cancel()
        const u = new SpeechSynthesisUtterance(text)
        u.lang = { zh: 'zh-CN', ja: 'ja-JP', en: 'en-US' }[touchLang] || 'zh-CN'
        // 音色：主进程带回的 voiceName（角色卡优先）精确匹配；匹配不到再按语言挑
        const voices = speechSynthesis.getVoices()
        const byName = r.voiceName && voices.find((x) => x.name === r.voiceName)
        const picked = byName || voices.find((x) => x.lang && String(x.lang).toLowerCase().replace('_', '-').startsWith(u.lang.slice(0, 2)))
        if (picked) u.voice = picked
        speechSynthesis.speak(u)
      } catch {}
    }
  }).catch(() => {})
}

/* ---------- 状态气泡（对齐参考项目 status.ts / pet-status.ts）
 * 14 种 kind 由工具名映射而来，三段时序：think 延迟 0.6s 出现 / 每条最少显示 1.2s / 0.2s 淡出。
 * 少任何一段都会「一闪而过」或「快速切换闪烁」。 */
const STATUS_KINDS = {
  think: { ico: '💭', text: '在想…' },
  read: { ico: '📖', text: '在读' },
  browse: { ico: '🗂', text: '在翻' },
  search: { ico: '🔍', text: '在找' },
  write: { ico: '✍', text: '在写' },
  delete: { ico: '🗑', text: '在删' },
  save: { ico: '💾', text: '在存' },
  look: { ico: '👀', text: '在看屏幕' },
  click: { ico: '🖱', text: '在操作' },
  scroll: { ico: '🖲', text: '在滚动' },
  type: { ico: '⌨', text: '在输入' },
  wait: { ico: '⏳', text: '稍等' },
  alarm: { ico: '⏰', text: '提醒' },
  work: { ico: '⚙', text: '在忙' },
  // S3：伙伴六工具的状态（让模型的动作在状态气泡上看得见）
  say: { ico: '💬', text: '在说' },
  ask: { ico: '❓', text: '在问' },
  act: { ico: '✨', text: '表演中' },
  walk: { ico: '🚶', text: '走过去' },
  quiet: { ico: '🤫', text: '安静中' }
}
/* 工具名 → kind（未识别一律 work，与参考项目默认一致） */
const TOOL_KIND = {
  see_screen: 'look', open_url: 'browse', exec_command: 'work',
  calc: 'think', get_time: 'wait', system_info: 'look',
  remember: 'write', forget: 'delete', recall_memory: 'search',
  read_file: 'read', write_file: 'write', list_files: 'browse', grep_files: 'search',
  launch_program: 'work', list_running: 'browse', set_volume: 'work', show_desktop: 'work',
  // S3
  pet_say: 'say', pet_ask: 'ask', pet_act: 'act', pet_move_to: 'walk',
  pet_set: 'work', pet_quiet: 'quiet'
}
const STATUS_DELAY_MS = 600
const STATUS_MIN_MS = 1200
const STATUS_FADE_MS = 200
let statusState = { kind: '', detail: '', shownAt: 0, delayT: 0, fadeT: 0, hideT: 0, visible: false, repoT: 0 }

function statusPos () {
  const el = $('petStatus')
  const stage = $('petStage')
  if (!el || !stage || el.hidden) return
  const r = stage.getBoundingClientRect()
  const w = el.offsetWidth || 120
  let x = r.left + r.width * 0.72
  x = Math.max(8, Math.min(window.innerWidth - w - 8, x))
  let y = r.top + Math.max(8, r.height * 0.12)
  el.style.left = Math.round(x) + 'px'
  el.style.top = Math.round(y) + 'px'
}
function statusPaint (kind, detail) {
  const el = $('petStatus')
  const ico = $('petStatusIco')
  const txt = $('petStatusText')
  const meta = STATUS_KINDS[kind] || STATUS_KINDS.work
  if (!el || !ico || !txt) return
  clearTimeout(statusState.fadeT)
  clearTimeout(statusState.hideT)
  el.classList.remove('fading')
  el.hidden = false
  ico.textContent = meta.ico
  txt.textContent = meta.text + (detail ? ' ' + String(detail).slice(0, 14) : '')
  statusState.visible = true
  statusState.shownAt = performance.now()
  requestAnimationFrame(statusPos)
  if (!statusState.repoT) {
    // 拖拽/换屏时舞台在动，轻量跟随（仅可见时跑）
    statusState.repoT = setInterval(() => { if (statusState.visible) statusPos() }, 250)
  }
}
function statusSet (kind, detail) {
  const el = $('petStatus')
  if (!el) return
  if (!petStatusBubble) return // 设置里关掉了状态气泡
  if (!petHosted) return // 状态气泡同样只画在角色所在的那块屏
  const k = STATUS_KINDS[kind] ? kind : 'work'
  const d = detail ? String(detail) : ''
  clearTimeout(statusState.delayT)
  // 已经显示就不偏移计时，只换文案（避免同类状态反复闪）
  if (statusState.visible && statusState.kind === k) {
    if (d && d !== statusState.detail) { statusState.detail = d; statusPaint(k, d) }
    return
  }
  statusState.kind = k
  statusState.detail = d
  if (!statusState.visible && k === 'think') {
    statusState.delayT = setTimeout(() => statusPaint(k, d), STATUS_DELAY_MS)
  } else {
    statusPaint(k, d)
  }
}
function statusClear () {
  clearTimeout(statusState.delayT)
  statusState.kind = ''
  statusState.detail = ''
  if (!statusState.visible) return
  const wait = Math.max(0, STATUS_MIN_MS - (performance.now() - statusState.shownAt))
  statusState.fadeT = setTimeout(() => {
    const el = $('petStatus')
    if (!el) return
    el.classList.add('fading')
    statusState.fadeT = setTimeout(() => {
      el.hidden = true
      el.classList.remove('fading')
      statusState.visible = false
    }, STATUS_FADE_MS)
  }, wait)
}
/* ---------- AI 回复朗读（对齐参考项目「会说话的伙伴」核心体验）
 * 助手核心的回复此前只有文字气泡、没有声音；这里把正文清洗后走 TTS，失败回退系统语音。 */
let readReply = true // 设置项「朗读 AI 回复」，默认开（用户澄清气泡音≠朗读，保持原默认）
function cleanForSpeech (text) {
  // 0.45.98 先剥「（QQ）」前缀与结尾的括号译文（那是字幕，不该念出来）
  const raw = (window.replyText && window.replyText.plainText) ? window.replyText.plainText(String(text || '')) : String(text || '')
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/【[^】]*】/g, ' ') // 【动作/神态】只演不念（主人 2026-10-31）
    .replace(/[*_#~>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
/** 朗读代次（0.46.48）：新一轮朗读意图出现时——
 *  ① 立刻打断正在播的旧语音（聊天都到后面了别再念前面的）；
 *  ② 旧轮次的合成结果回来直接丢弃不播（防旧结果反杀新朗读）。 */
let readSeq = 0
/** 朗读一段回复；返回 Promise，在「真的念完」时 resolve（气泡靠它决定何时淡出）
 *  0.46.11 opts.vol：嘀咕音量（0.05~1，自言自语专用；缺省 = 正常音量） */
async function speakReplyText (content, opts) {
  if (!petHosted) return false // 非宿主屏不朗读（多屏时会和宿主屏叠成双声道）
  if (isQuiet()) return false // pet_quiet 期间不出声（气泡照常显示，只是不念）
  const my = ++readSeq
  try { stopVoice() } catch { } // 被打断的旧语音立即停（主人 22:47：中断了就不用读了）
  const vol = opts ? opts.vol : undefined
  const text = cleanForSpeech(content)
  if (!text || !window.aura || !window.aura.speakReply) return false
  let r = null
  try { r = await window.aura.speakReply(text) } catch {}
  if (my !== readSeq) return false // 合成期间来了新朗读 → 这份作废
  if (r && r.ok && r.url) { await playVoice(r.url, r.speed, vol, r.env); return true }
  /* 0.46.56 系统语音兜底只在「用户主动选了系统语音模式」（r.fallback）时用。
     旧代码无条件念——真机实锤（11-06 投诉「fish 正常，系统 TTS 也在说，
     还比 fish 快，说的全是台词」）：两块屏的窗口都会跑到这里，合成竞速输掉的
     那块收到 stale（fish 正在另一块屏正常播），照样把全文用 Windows 嗓抢念
     一遍——它不用等合成所以总是更快。stale/失败一律闭嘴。 */
  if (r && !r.stale && r.fallback && window.speechSynthesis) {
    return await new Promise((resolve) => {
      try {
        if (my !== readSeq) return resolve(false) // 合成/等待期间来了新朗读 → 作废
        speechSynthesis.cancel()
        const u = new SpeechSynthesisUtterance(text.slice(0, 600))
        u.lang = { zh: 'zh-CN', ja: 'ja-JP', en: 'en-US' }[touchLang] || 'zh-CN'
        const vFall = Number(vol)
        if (Number.isFinite(vFall)) u.volume = Math.min(1, Math.max(0.05, vFall))
        // 音色：主进程带回的 voiceName（角色卡优先）精确匹配；匹配不到再按语言挑
        const voices = speechSynthesis.getVoices()
        const byName = r && r.voiceName && voices.find((x) => x.name === r.voiceName)
        const picked = byName || voices.find((x) => x.lang && String(x.lang).toLowerCase().replace('_', '-').startsWith(u.lang.slice(0, 2)))
        if (picked) u.voice = picked
        let done = false
        const finish = () => { if (done) return; done = true; setTalking(false); resolve(true) }
        u.onend = finish
        u.onerror = finish
        // 兜底：个别 Windows 语音不触发 onend，按字数估时（约 5 字/秒）+8s 强制收尾，避免气泡永久挂着
        setTimeout(finish, Math.min(180000, 8000 + text.length * 220))
        setTalking(true)
        speechSynthesis.speak(u)
      } catch { resolve(false) }
    })
  }
  return false
}

function gazeInfluence () {
  const elapsed = performance.now() - cursorMoveAt
  if (!cursorMoveAt) return 0
  if (elapsed <= 1500) return 1
  const p = (elapsed - 1500) / 700
  if (p >= 1) return 0
  const r = 1 - p
  return r * r * (3 - 2 * r)
}

/* ---------------- S3：气泡外观（模型 via pet_set / 设置页） ----------------
 * 两路输入：petSettings() 返回的是 companion 配置（petBubbleScale…），
 * pet:config 广播用的是短名（bubbleScale…），这里统一吃。 */
let petSound = true
/* 0.45.39 MMD 路线：动作词 → VRMA 文件映射（词=文件名主干或 config.petVrmaActs 手动配）。
 * main 启动时扫 %APPDATA%/motions/*.vrma 生成默认映射随 pet:config 广播。 */
let vrmaActMap = {}
/* 0.18.0 第一批：音效 / 说话声 / 状态气泡 / 输入气泡 / 帧率 / 暂停 */
const FX_KINDS = ['move', 'touch', 'face', 'alarm', 'ui', 'snore']
/* 0.45.38 默认只留交互类音效（触摸/摸头/闹钟）——move（自动溜达开步嘟）/ui/snore
   是无交互自动触发的（用户拍板：气泡音=那声自动短嘟，默认关闭），要的话设置页勾回来 */
let petSoundKinds = ['touch', 'face', 'alarm']
let petSpeechOn = false
let petSpeechPitch = 'mid'
let petSpeechRate = 'mid'
let petStatusBubble = true
let petInputBubble = true
let petPaused = false
let petFps = 30
let fxCtx = null
let lastFxAt = 0

/** 合成音效（零素材）：按类别给不同波形/频率/时长，全部走一个 AudioContext */
function fx (kind) {
  if (!petSound || petPaused) return
  if (!petSoundKinds.includes(kind)) return
  const now = performance.now()
  if (now - lastFxAt < 40) return // 防连环触发糊成一片
  lastFxAt = now
  try {
    if (!fxCtx) fxCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (fxCtx.state === 'suspended') fxCtx.resume().catch(() => {})
    const t0 = fxCtx.currentTime
    const spec = {
      move: { f: 300, d: 0.05, type: 'sine', g: 0.05 },
      touch: { f: 520, d: 0.08, type: 'sine', g: 0.09 },
      face: { f: 780, d: 0.06, type: 'triangle', g: 0.05 },
      alarm: { f: 880, d: 0.14, type: 'square', g: 0.07, repeat: 3 },
      ui: { f: 620, d: 0.04, type: 'square', g: 0.04 },
      snore: { f: 150, d: 0.5, type: 'triangle', g: 0.05 }
    }[kind]
    if (!spec) return
    const count = spec.repeat || 1
    for (let i = 0; i < count; i++) {
      const t = t0 + i * (spec.d + 0.06)
      const osc = fxCtx.createOscillator()
      const gain = fxCtx.createGain()
      osc.type = spec.type
      osc.frequency.setValueAtTime(spec.f, t)
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(spec.g, t + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + spec.d)
      osc.connect(gain).connect(fxCtx.destination)
      osc.start(t)
      osc.stop(t + spec.d + 0.02)
    }
  } catch { }
}

/** 说话声：气泡每多出几个字就「哔」一声（音高/语速按设置，带一点随机起伏） */
let blipAt = 0
function speechBlips (n) {
  if (!petSpeechOn || !petSound || petPaused) return
  if (nowPlaying) return // TTS 正在念 → 不加噪
  const pitchBase = { low: 260, mid: 360, high: 480 }[petSpeechPitch] || 360
  const gap = { low: 110, mid: 78, high: 55 }[petSpeechRate] || 78
  try {
    if (!fxCtx) fxCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (fxCtx.state === 'suspended') fxCtx.resume().catch(() => {})
    const now = performance.now()
    const count = Math.min(6, Math.max(0, n))
    for (let i = 0; i < count; i++) {
      const at = Math.max(now, blipAt) + gap
      if (at - now > 700) break
      blipAt = at
      const f = pitchBase * (0.92 + Math.random() * 0.18)
      const t = fxCtx.currentTime + (at - now) / 1000
      const osc = fxCtx.createOscillator()
      const gain = fxCtx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(f, t)
      osc.frequency.linearRampToValueAtTime(f * 0.9, t + 0.05)
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.045, t + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
      osc.connect(gain).connect(fxCtx.destination)
      osc.start(t)
      osc.stop(t + 0.08)
    }
  } catch { }
}

function applyPetLook (c) {
  if (!c) return
  const bubble = c.petBubbleScale != null ? c.petBubbleScale : c.bubbleScale
  const font = c.petFontScale != null ? c.petFontScale : c.fontScale
  const theme = c.petTheme || c.theme
  const sound = c.petSound != null ? c.petSound : c.sound
  if (bubble != null) document.documentElement.style.setProperty('--pet-bubble-scale', String(bubble))
  if (font != null) document.documentElement.style.setProperty('--pet-font-scale', String(font))
  if (theme) document.body.dataset.petTheme = String(theme)
  if (sound != null) petSound = !!sound
  // 0.18.0 第一批
  if (Array.isArray(c.petSoundKinds)) petSoundKinds = c.petSoundKinds.filter((k) => FX_KINDS.includes(k))
  if (c.petVrmaActs && typeof c.petVrmaActs === 'object') {
    vrmaActMap = c.petVrmaActs
    petDiagOnce('vrma-map', 'petVrmaActs 收到: ' + Object.keys(c.petVrmaActs).length + ' 项 walk=' + (c.petVrmaActs.walk ? '有' : '无'))
  } else if ('petVrmaActs' in c) {
    petDiagOnce('vrma-empty', 'petVrmaActs 为空/未生成（motions 目录扫描失败？）')
  }
  // 0.45.44：config 晚于模型就绪时，这里补挂走路 VRMA（wireWalkMotion 自身幂等）
  wireWalkMotion()
  // 0.45.52：待机池 VRMA 预载（同款幂等策略）
  wireIdleVrmas()
  if (c.petSpeechOn != null) petSpeechOn = !!c.petSpeechOn
  if (c.petSpeechPitch) petSpeechPitch = c.petSpeechPitch
  if (c.petSpeechRate) petSpeechRate = c.petSpeechRate
  if (c.petStatusBubble != null) {
    petStatusBubble = !!c.petStatusBubble
    if (!petStatusBubble) statusClear()
  }
  if (c.petInputBubble != null && !c.petInputBubble) {
    petInputBubble = false
    const p = $('petChat')
    if (p && !p.hidden) p.hidden = true
  } else if (c.petInputBubble != null) petInputBubble = true
  if (c.petFps != null) petFps = Number(c.petFps) || 30
  if (c.petPaused != null) {
    petPaused = !!c.petPaused
    document.body.classList.toggle('pet-paused', petPaused)
    const pb = $('petMenuPause')
    if (pb) pb.textContent = petPaused ? '▶ 继续' : '⏸ 暂停'
  }
  if (c.quiet != null) quietUntil = c.quiet ? Date.now() + 24 * 3600 * 1000 : 0
}

/* ---------------- S3：动作/表情播放（模型用 pet_act 与 pet_say 的标记驱动） ----------------
 * 只有 Spine 角色有动作词表；立绘/VRM 没有骨骼动画，用一档轻微的抖动反馈（仍算「已执行」）。
 * 表情走轨道 1（不打断身体动作），身体动作走轨道 0 并自动接回 idle。 */
let spineAnimCtx = null // { state, anims, idle, faceTimer, skelBase }
let quietUntil = 0 // pet_quiet：安静截止时间（主进程到点会再广播解除）

function isQuiet () { return Date.now() < quietUntil }

/* ---- 0.45.90 Spine 动作全量接入（AgentAtelierR 素材 + 权威中文词典） ----
 * 坐卡/命令坐下时整个骨架切到坐姿版（0001_01，867 条动画，含拍手/比耶/耳语/伸懒腰等），
 * 站姿骨架（0001_99，164 条）做日常待机。词→动画组映射来自 spine-words.js（资源 Label 译注）。 */
let spineSkelMode = 'stand' // 'stand' | 'sit'
/** 0.45.91 当前姿势真正该用的骨架。不同皮肤不换（坐下换衣服=用户报的「自动换成其他皮肤」） */
function spineSkelFor (v, mode) {
  const mod = window.SPINE_SKIN
  if (mod && typeof mod.pickSkel === 'function') {
    return mod.pickSkel({ mode: mode || spineSkelMode, spine: (v && v.spine) || {} })
  }
  // 兜底：没有共享模块时按老逻辑（同皮肤判定缺席，宁可沿用站姿也不换装）
  return { skel: v && v.spine && v.spine.skel, atlas: v && v.spine && v.spine.atlas, png: v && v.spine && v.spine.png, switched: false, reason: 'no-module' }
}
/* 骨架切换串行化：sit→stand→sit 连发时原来几个 dispose/showVisual 会互相插队，
 * 最后一个跑完的未必是最后请求的那个（皮肤就停在了错的姿势上）。 */
let skelSwitchChain = Promise.resolve()
function applySpineSkelMode (mode) {
  skelSwitchChain = skelSwitchChain.then(() => doApplySpineSkelMode(mode)).catch((e) => {
    console.warn('[pet-ov] 骨架切换失败', mode, e && e.message)
  })
  return skelSwitchChain
}
async function doApplySpineSkelMode (mode) {
  if (!spineAnimCtx) return // 没跑 spine（立绘/VRM）时忽略
  if (spineSkelMode === mode) return
  try {
    const st = await window.aura.petState()
    const v = st && st.char && st.char.visual
    if (!(v && v.spine)) return
    const cur = spineSkelFor(v, spineSkelMode)
    const next = spineSkelFor(v, mode)
    spineSkelMode = mode
    // 同一套皮肤（或没有坐姿骨架）：只记姿势，不重载骨架 → 不会换衣服
    if (String(cur.skel) === String(next.skel)) {
      console.warn('[pet-ov] spine 姿势 → ' + mode + '（沿用当前皮肤：' + next.reason + '）')
      return
    }
    disposeSpine()
    await showVisual(st.char)
    console.warn('[pet-ov] spine 骨架切换 →', mode, '(' + next.reason + ')')
  } catch (e) { console.warn('[pet-ov] 骨架切换失败', mode, e && e.message) }
}

function spineAnimByName (n) {
  return (spineAnimCtx && spineAnimCtx.anims || []).find((a) => a.name === n) || null
}

/** 播一条 spine 动作（自动分轨）：
 *  facial_* → 轨 5（表情，短时淡出）；motion_oneshot_* → 轨 0（全身一次性，接回 idle）；
 *  其余（motion_add、motion_touch、effect 等叠加层）→ 轨 1..3 叠在 idle 上，保持几秒后淡出。 */
function playSpineAction (names) {
  const ctx = spineAnimCtx
  if (!ctx || !ctx.state) return false
  try {
    if (!ctx.mixWired) { try { ctx.state.data.defaultMix = 0.2 } catch {} ; ctx.mixWired = true }
    const face = [], oneshot = [], body = []
    for (const n of names) {
      if (/^facial/i.test(n) || /blush|tear|sweat/i.test(n)) face.push(n)
      else if (/^motion_oneshot/i.test(n)) oneshot.push(n)
      else body.push(n)
    }
    if (face.length) {
      ctx.state.setAnimation(5, face[0], false)
      clearTimeout(ctx.faceTimer)
      const fa = spineAnimByName(face[0])
      const fd = Number(fa && fa.duration) || 1.2
      ctx.faceTimer = setTimeout(() => { try { ctx.state.setEmptyAnimation(5, 0.25) } catch {} }, Math.max(600, fd * 1000))
    }
    if (oneshot.length) {
      ctx.state.setAnimation(0, oneshot[0], false)
      if (ctx.idle) ctx.state.addAnimation(0, ctx.idle.name, true, 0)
    }
    // 0.46.15 轨道优先级修正：组合里数组首位才是主手势（如害羞 grp_fg_111 = 遮嘴 F_030 + 支撑 G_051），
    // Spine 高轨完全盖过共享骨骼的低轨——此前主手势在 1 号最低轨、G_051「右手放腿上」支撑在 2 号轨，
    // 共享骨骼被支撑动画压住，观感就成了「只是把手放腿上」（真机用户实测：害羞/托腮/叉腰/挥手全中招）。
    // 反转分配：主手势上最高轨（3），支撑手位落低轨。
    body.slice(0, 3).forEach((n, i) => {
      const tr = 3 - i
      ctx.state.setAnimation(tr, n, false)
      ctx.bodyTimers = ctx.bodyTimers || {}
      clearTimeout(ctx.bodyTimers[tr])
      const ba = spineAnimByName(n)
      const bd = Number(ba && ba.duration) || 1.2
      // 叠加层多为「摆姿」类：播完保持 4s 再淡出，叉腰/抱臂这类才有存在感
      ctx.bodyTimers[tr] = setTimeout(() => { try { ctx.state.setEmptyAnimation(tr, 0.35) } catch {} }, Math.max(1500, bd * 1000 + 4000))
    })
    try { window.aura.reportError && window.aura.reportError('pet-act', '播放: ' + names.join(' + ') + (face.length ? ' +表情' + face[0] : '')) } catch { }
    return true
  } catch (e) { console.warn('[pet-ov] spine 动作播放失败', names.join('/'), e && e.message); return false }
}

/** 词 → 动画组（spine-words.js 目录，站/坐骨架各试一次；只收当前骨架真有的动画） */
function resolveSpineWord (w) {
  const map = window.SPINE_WORD_MAP || {}
  const cat = window.SPINE_GROUP_CATALOG || {}
  const entry = map[w]
  if (!entry || !spineAnimCtx) return null
  const order = spineSkelMode === 'sit' ? ['sit', 'stand'] : ['stand', 'sit']
  for (const sk of order) {
    const gid = entry[sk]
    if (!gid || !cat[sk] || !cat[sk][gid]) continue
    const names = (cat[sk][gid].anims || []).filter((n) => spineAnimByName(n))
    if (!names.length) continue
    let dur = 0
    for (const n of names) { const a = spineAnimByName(n); if (a) dur = Math.max(dur, Number(a.duration) || 0) }
    return { name: names[0], combo: names, duration: dur }
  }
  return null
}

/* 语义词 → 动画名正则：兼容本机 motion_ 与 facial_ 前缀命名，以及参考项目那套词表 */
const ACTION_SEMANTICS = {
  wave: /motion_add_F_00[14]|wave|hello|挥手/i,
  happy: /motion_oneshot_D_00[12]|motion_add_E_001|happy|smile|开心/i,
  laugh: /motion_add_F_00[23]|laugh|笑/i,
  sad: /motion_oneshot_D_00[56]|sad|难过/i,
  cry: /facial_add_tear_on|tear|cry|哭/i,
  angry: /motion_oneshot_D_00[78]|angry|生气/i,
  shy: /motion_add_E_00[34]|shy|害羞/i,
  nod: /motion_add_G_00[12]|nod|点头/i,
  shake: /motion_add_G_00[34]|shake|摇头/i,
  think: /motion_oneshot_D_00[34]|think|思考/i,
  dance: /motion_add_H_00[12]|dance|跳舞/i,
  sleep: /motion_A_00[3-7]_idle|sleep|困/i,
  idle: /motion_[A-Z]_\d+_idle|idle|待机/i,
  blush: /facial_add_blush_on/i,
  sweat: /facial_add_sweat_on/i,
  /* 0.46.61 模型爱蹦的英文词补齐（11-06 19:04 实锤：excited/acknowledge 双双
     「未识别动作词」——LLM 不 always 按中文词表出牌，英文情绪词直接兜住） */
  excited: /motion_add_G_001|motion_add_E_00[12]|excited|兴奋/i,
  acknowledge: /motion_add_G_00[12]|acknowledge|认可|收到/i,
  surprised: /motion_oneshot_D_00[12]|surprised|惊讶/i,
  greet: /motion_add_F_00[14]|greet|welcome|问候/i,
  cheer: /motion_add_G_00[56]|cheer|鼓励|打气/i
}

function findAnim (word) {
  const ctx = spineAnimCtx
  if (!ctx) return null
  const w = String(word || '').trim()
  if (!w) return null
  // 0.45.90 目录词优先（挥手/拍手/叉腰…→ 权威词典映射的动画组）
  const viaMap = resolveSpineWord(w)
  if (viaMap) return viaMap
  const anims = ctx.anims || []
  const low = w.toLowerCase()
  const byName = anims.find((a) => a.name === w) ||
    anims.find((a) => a.name.toLowerCase() === low) ||
    anims.find((a) => a.name.toLowerCase().includes(low))
  if (byName) return byName
  const re = ACTION_SEMANTICS[low]
  return re ? (anims.find((a) => re.test(a.name)) || null) : null
}

/** 立绘 / VRM 的动作反馈：轻微一抖，让「做动作」至少看得见 */
function buzzAction () {
  const st = $('petStage')
  if (!st) return
  st.classList.remove('act-buzz')
  void st.offsetWidth // 强制回流，连点同一个词也能重播
  st.classList.add('act-buzz')
  clearTimeout(buzzAction.timer)
  buzzAction.timer = setTimeout(() => st.classList.remove('act-buzz'), 700)
}

/* 情绪词 → VRM 预设表情（three-vrm 统一名：happy / angry / sad / relaxed / surprised）。
 * 立绘靠抖动、Spine 靠骨骼动画，3D 用表情最自然；2 秒后自动回正。 */
const VRM_EMOTION = {
  happy: 'happy', laugh: 'happy', smile: 'happy', joy: 'happy', 开心: 'happy', 笑: 'happy',
  sad: 'sad', cry: 'sad', 难过: 'sad', 哭: 'sad',
  angry: 'angry', 生气: 'angry',
  shy: 'relaxed', blush: 'relaxed', sleep: 'relaxed', think: 'relaxed', 害羞: 'relaxed',
  surprise: 'surprised', surprised: 'surprised', 惊讶: 'surprised'
}
let vrmEmoTimer = null
function vrmEmotion (word) {
  if (!vrmRuntime || !vrmRuntime.expressions) return
  const name = VRM_EMOTION[String(word || '').trim().toLowerCase()]
  if (!name) return
  try { vrmRuntime.setExpression(name, 0.8) } catch { return }
  clearTimeout(vrmEmoTimer)
  vrmEmoTimer = setTimeout(() => {
    if (vrmRuntime && vrmRuntime.expressions) {
      try { vrmRuntime.setExpression(name, 0) } catch {}
    }
  }, 2000)
}

/* ---- VRM 触摸反应（0.31.0）：桌面轻点 3D 角色此前毫无反应——onTapHook 只有 Spine 会赋值。
   这里把 humanoid 骨骼投影到屏幕坐标做部位命中 → 播手势 + 表情；
   语音/音效/上报走既有通道：petTap → 主进程广播 pet:touch{kind:'tap'} → onPetTouch 播放 ---- */
const VRM_TAP_REACT = {
  head: { gesture: 'nod', emo: 'happy' },        // 摸头：开心点头
  breast: { gesture: 'coverFace', emo: 'shy' },  // 摸上身：捂脸害羞
  body: { gesture: 'lookDown', emo: 'surprise' },
  weast: { gesture: 'lookDown', emo: 'surprise' },
  arm_l: { gesture: 'lookAside', emo: 'shy' },
  arm_r: { gesture: 'lookAside', emo: 'shy' }
}
function vrmTapHit (cssX, cssY) {
  try {
    const rt = vrmRuntime
    if (!rt || !rt.alive || !rt.vrm || !rt.vrm.humanoid) return false
    const THREE = window.AuraLibs && window.AuraLibs.THREE
    const cam = rt.camera
    const el = rt.renderer && rt.renderer.domElement
    if (!THREE || !cam || !el) return false
    const rect = el.getBoundingClientRect()
    const x = cssX - rect.left
    const y = cssY - rect.top
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return false
    const h = rt.vrm.humanoid
    const anchor = (bone) => {
      let n = null
      try { n = h.getRawBoneNode(bone) } catch { n = null }
      if (!n || !n.getWorldPosition) return null
      try {
        n.updateWorldMatrix(true, false)
        const p = n.getWorldPosition(new THREE.Vector3()).project(cam)
        return { x: (p.x * 0.5 + 0.5) * rect.width, y: (-p.y * 0.5 + 0.5) * rect.height }
      } catch { return null }
    }
    const hips = anchor('hips')
    const head = anchor('head')
    if (!hips || !head) return false
    try { cam.updateMatrixWorld() } catch {}
    const hl = anchor('leftHand')
    const hr = anchor('rightHand')
    const torso = Math.abs(hips.y - head.y) || 200
    const dist = (a) => Math.hypot(a.x - x, a.y - y)
    let part = 'body'
    if (dist(head) < torso * 0.24 || y < head.y - torso * 0.1) part = 'head'
    else if (hl && dist(hl) < torso * 0.2) part = 'arm_l'
    else if (hr && dist(hr) < torso * 0.2) part = 'arm_r'
    else if (y < (hips.y + head.y) / 2) part = 'breast'
    else if (y > hips.y) part = 'weast'
    const react = VRM_TAP_REACT[part] || VRM_TAP_REACT.body
    vrmEmotion(react.emo)
    if (typeof rt.playGesture === 'function') {
      try { rt.playGesture(react.gesture) } catch {}
    }
    if (petHosted) { try { window.aura.petTap && window.aura.petTap(part) } catch {} }
    return true
  } catch { return false }
}

/* 动作词 → 程序化姿态（形象包没有骨骼素材，用姿态代替序列帧）。
 * 模型给的是中文/日文/英文都可能，所以按正则认，命不中就退回抖动。 */
const FIGURE_ACT_WORDS = [
  [/wave|挥手|手を振|打招呼|hello|hi\b|bye|拜拜|再见/i, 'wave'],
  [/nod|点头|うなず|頷/i, 'nod'],
  [/shake|摇头|首を振/i, 'shake'],
  [/jump|跳|蹦|ジャンプ/i, 'jump'],
  [/dance|跳舞|舞蹈|踊/i, 'dance'],
  [/sleep|困|睡|ねむ|眠|おやすみ/i, 'sleep'],
  [/cry|哭|泣|泪|涙/i, 'sad'],
  [/sad|难过|伤心|悲し|沮丧|失落/i, 'sad'],
  [/angry|生气|怒|不开心|むか/i, 'angry'],
  [/shy|害羞|脸红|照れ|不好意/i, 'shy'],
  [/blush|脸红/i, 'blush'],
  [/think|思考|想想|考え|沉思/i, 'think'],
  [/surprise|惊讶|吃惊|びっくり|惊/i, 'surprise'],
  [/sweat|汗|紧张|焦/i, 'sweat'],
  [/happy|smile|laugh|开心|高兴|笑|嬉し|楽/i, 'happy']
]
function figureActOf (word) {
  const w = String(word || '').trim()
  if (!w) return null
  for (const [re, act] of FIGURE_ACT_WORDS) if (re.test(w)) return act
  return null
}

/* 动作词 → 3D 程序化手势（0.30.0）。VRM 模型没有序列帧/Spine 骨骼动画，
   以前 pet_say 让角色「挥手」只会动表情 + 抖一下；现在接到 vrm-stage 的手势上。
   只在 st.rig 存在时生效（playGesture 内部判），普通 GLB / 立绘返回 false 继续走原流程。 */
const VRM_ACT_GESTURE = [
  // 顺序敏感：更具体的词放前面（比如「摇头」要先于「点头」判断不了没关系，两者词面不重叠）
  [/wave|挥手|手を振|打招呼|hello|\bhi\b|bye|拜拜|再见|欢迎|ようこそ/i, 'wave'],
  [/nod|点头|うなず|頷|嗯嗯|好的呢|了解|わかった/i, 'nod'],
  [/shake|摇头|首を振|不行|不好|不要|だめ|いや/i, 'shake'],
  [/clap|鼓掌|拍手|拍拍手|喝彩|ぱちぱち|拍拍/i, 'clap'],
  [/cheer|加油|欢呼|激动|やった|太好了|好耶|万岁|banzai|赞/i, 'cheer'],
  [/dance|跳舞|踊|jump|跳|蹦|happy|smile|laugh|开心|高兴|笑|嬉し|楽/i, 'bounce'],
  [/shy|害羞|脸红|照れ|blush|embarrass|捂脸|cry|哭|泣/i, 'coverFace'],
  [/think|思考|想想|考え|沉思|琢磨|让我想想/i, 'think'],
  [/cross|抱胸|抱臂|哼|ふん|不高兴|不满意|生气|怒/i, 'armsCross'],
  [/bow|鞠躬|お辞儀|谢谢|感谢|感謝|thanks|多谢/i, 'bow'],
  [/beckon|招手|过来|come here|おいで|这边/i, 'beckon'],
  [/hair|头发|髪|整了整/i, 'fixHair'],
  [/stretch|伸懒腰|のび|好累|疲れ|累/i, 'stretch'],
  [/sleep|困|睡|ねむ|眠|おやすみ|sad|难过|伤心|悲し|失落/i, 'lookDown'],
  [/look|看看|瞄|那边|哪里|見|視線/i, 'lookAside']
]
function vrmActGesture (word) {
  const w = String(word || '').trim()
  if (!w) return null
  for (const [re, id] of VRM_ACT_GESTURE) if (re.test(w)) return id
  return null
}

/* 动作词 → 官方 g1a 动画（0.32.0 全量烘入，按编号点播）。官方动画比程序化手势
   生动得多，匹配到就优先播；编号无语义名字，映射表靠 anim-sweep 连拍盘点填。
   直接传 gust_XXXXX 也行（playGesture 里已直通）。 */
const VRM_ACT_CLIPS = [
  // [ /正则/, 'gust_XXXXX' ] —— 官方动画比程序化手势优先；播失败自动落到下面的程序化手势
  [/banzai|万岁|萬歲|加油|欢呼|歡呼|やった|好耶/i, 'gust_00110'],   // 举拳过顶欢呼 4.5s
  [/睡觉|睡覺|躺平|躺下|累趴|睡吧|倒头就睡|ねむ/i, 'gust_01300'],   // 仰面躺倒 2.8s
  [/坐地上|坐地上休息|坐下来|坐下來|瘫坐|癱坐/i, 'gust_30231'],     // 就地瘫坐 3.0s
  [/说吧|听着|听着呢|聽著呢|你说|你說|嗯哼/i, 'gust_00900']         // 抱臂听人说话 2.1s
]

/* 0.41.0：动作词 → 语义池。
   369 个官方 clip 的编号没有名字，人工指认不可能全填；tools/anim-classify.js 读骨骼
   轨迹自动打了标签（躺/坐/蹲/跳/挥手/举手/迈步/转身），这里只声明「哪些词该演哪一类」，
   具体播哪一个由 anim-pool.js 从池子里挑（会避开刚播过的）。 */
const VRM_ACT_POOLS = [
  [/挥手|招手|打招呼|你好|您好|嗨|拜拜|再见|回頭見|回头见|bye/i, 'wave'],
  [/万岁|萬歲|欢呼|歡呼|加油|好耶|胜利|勝利|やった|太棒/i, 'armsUp'],
  [/躺|睡|趴|累|困|倒头|倒頭|ねむ/i, 'lie'],
  [/坐|歇|瘫|癱/i, 'sit'],
  [/蹲|抱膝/i, 'crouch'],
  [/跳|蹦|雀跃|雀躍/i, 'jump'],
  [/转圈|轉圈|转身|轉身|转个|轉個/i, 'turn']
]
const recentClips = []

/* 0.45.35 坐下 = 持续姿态不是一次性动画（主人 2026-10-31：坐下动作像摔倒，且坐下该一直坐着）。
 * 接程序化坐姿（与主进程 restOnCard/restInPlace 同一条 pet:pose 链路），一直坐着直到：
 * 走路开始 / 主进程 pose 广播 / 叫站起来 / 下一个需要站着的动作。 */
let actSit = false

/** 从语义池里挑一个官方 clip 播；播不上返回 false */
function playFromPool (name) {
  if (!vrmRuntime || typeof vrmRuntime.playClip !== 'function') return false
  const cat = window.AuraAnimCatalog
  const pool = window.AuraAnimPool
  if (!cat || !pool) return false
  const clip = pool.pick(name, { catalog: cat, avoid: recentClips })
  if (!clip || !vrmRuntime.playClip(clip)) return false
  recentClips.push(clip)
  if (recentClips.length > 6) recentClips.shift()
  return true
}

/** 0.46.9 语义动作（AgentAtelierR 自动调用规则 1:1）：
 * [action:think] 等标签 / [action:grp_fg_106] 直接组号 → 按当前骨架取计划动作组依次试播；
 * 全部选不中 → 回退 D 系一次性动画（motion_oneshot_D_*，轨0 接回 idle）。
 * 计划数据在 shared/spine-actions.js（1:1 抄自 character_performance.dart）。 */
function playSemanticAction (tag) {
  const t = String(tag || '').trim().toLowerCase()
  if (!spineAnimCtx) return false
  // 直接组号：只认当前骨架目录里存在的组
  if (/^grp_[a-z0-9_]+$/.test(t)) {
    const sk = spineSkelMode === 'sit' ? 'sit' : 'stand'
    const info = (window.SPINE_GROUP_CATALOG || {})[sk] && window.SPINE_GROUP_CATALOG[sk][t]
    const names = info && (info.anims || []).filter((n) => spineAnimByName(n))
    if (names && names.length) { console.warn('[pet-ov] 语义动作[组]', t, '→', names[0]); return playSpineAction(names) }
    return false
  }
  const mode = spineSkelMode === 'sit' ? 'sit' : 'stand'
  const plan = ((window.SPINE_ACTION_PLANS || {})[mode] || {})[t]
  if (!plan) return false
  for (const gid of plan.groups || []) {
    const info = (window.SPINE_GROUP_CATALOG || {})[mode] && window.SPINE_GROUP_CATALOG[mode][gid]
    const names = info && (info.anims || []).filter((n) => spineAnimByName(n))
    if (names && names.length) { console.warn('[pet-ov] 语义动作', t, '→', gid, names[0]); return playSpineAction(names) }
  }
  if (plan.oneShot && spineAnimByName(plan.oneShot)) {
    console.warn('[pet-ov] 语义动作', t, '→ 回退', plan.oneShot)
    return playSpineAction([plan.oneShot])
  }
  return false
}

/** 播一个动作词；返回是否真的播上了 */
function playActionWord (word) {
  const w0 = String(word || '').trim()
  // 0.46.9 语义标签词（pet_act 里传来的 'action:think' / 'action:grp_fg_106'）
  if (/^action:/i.test(w0)) return playSemanticAction(w0.slice(7))
  vrmEmotion(w0)
  const w = String(word || '').trim()
  // 0.45.35 坐/站词接持续姿态；坐着时来别的动作先站起来再演
  if (vrmRuntime && typeof vrmRuntime.setPose === 'function') {
    if (/^(起来|起來|站起来|站起來|站好|起身|别坐了|別坐了)$/.test(w)) {
      actSit = false
      vrmRuntime.setPose('stand')
      return true
    }
    if (/坐|瘫|癱|歇/.test(w) && !/躺|睡|趴/.test(w)) {
      actSit = true
      vrmRuntime.setPose('sit')
      return true
    }
    if (actSit) { actSit = false; vrmRuntime.setPose('stand') }
  }
  // 0.45.45：【走路】词 = 真的溜达一段。此前只原地播 walk.vrma，观感上「没触发」；
  // roamNow 起一段真走动（pet:walk 广播会把坐姿切回站），步态走 VRMA 通道
  if (/^(走路|走两步|散个?步|步行|walk(ing)?)$/i.test(w)) {
    try { window.aura.petRoamNow && window.aura.petRoamNow() } catch { }
    return true
  }
  // 0.45.39 MMD 路线：配置了 VRMA 映射的词优先播 VRMA（比内置 clip/程序化手势自然得多）。
  // 播放是异步的，这里先应答 true 让聊天链路继续（播放失败只打日志）。
  if (vrmRuntime && typeof vrmRuntime.playVRMA === 'function' && vrmaActMap[w]) {
    const p = String(vrmaActMap[w])
    assetUrl(p).then((u) => vrmRuntime.playVRMA(u))
      .catch((e) => console.warn('[pet-ov] VRMA 播放失败', w, e && e.message))
    return true
  }
  // 0.32.0：官方动画优先（有映射/直接编号时），比程序化手势可读
  if (vrmRuntime && typeof vrmRuntime.playClip === 'function') {
    if (/^gust_\d+$/.test(w) && vrmRuntime.playClip(w)) return true
    // 0.45.89 官方烘入 clip / 语义池整体停用（主人 11-01 逐词实测：挥手/打招呼/万岁/加油/
    // 蹲下/躺下/睡觉/坐地上 手臂全坏——外张/左右镜像问题烘在 clip 数据里，运行时修不动）。
    // 这些词改走下面的程序化手势（手写代码驱动，实测没问题）。gust_XXXXX 直通编号保留给诊断。
    // 要恢复官方 clip：把 OFFICIAL_CLIPS_ON 改回 true。
    const OFFICIAL_CLIPS_ON = false
    if (OFFICIAL_CLIPS_ON) {
      for (const [re, clip] of VRM_ACT_CLIPS) {
        if (re.test(w) && vrmRuntime.playClip(clip)) return true
      }
      // 0.41.0：没核对过硬编号的动作词，按语义池挑（369 个官方 clip 都能派上用场）
      for (const [re, poolName] of VRM_ACT_POOLS) {
        if (re.test(w) && playFromPool(poolName)) return true
      }
    }
  }
  // 0.45.90：spine 骨骼动画最优先——中文词表/动画名直接命中就播，不再落到下面的抖动兜底。
  // （此前 spine 判定排在 VRM 手势之后，VRM 移除后中文词一个都匹配不上 =「全是无效动作」。）
  if (spineAnimCtx) {
    const aSpine = findAnim(word)
    if (aSpine) {
      if (playSpineAction(aSpine.combo && aSpine.combo.length ? aSpine.combo : [aSpine.name])) return true
    }
  }
  // 3D 模型：动作词优先接到程序化手势（挥手/点头/轻跳……），比抖一下可读得多
  if (vrmRuntime && typeof vrmRuntime.playGesture === 'function') {
    const g = vrmActGesture(word)
    if (g && vrmRuntime.playGesture(g)) return true
  }
  // 形象包：先试程序化姿态（不需要骨骼素材），播上了就不用再抖
  if (figureLoop && typeof figureLoop.play === 'function') {
    const act = figureActOf(word)
    if (act && figureLoop.play(act)) return true
  }
  // 0.45.90 spine 上面已优先处理；到这里还没有可播的 → 轻抖反馈
  // 0.46.14 诊断留痕：以前这里静默 return false，动作测试面板点了没反应查不到原因
  try { window.aura.reportError && window.aura.reportError('pet-act', '未识别动作词: ' + w0) } catch { }
  buzzAction()
  return false
}

/** 顺序播放一串动作（间隔取动作自身时长，最多 2.2s） */
async function playActions (words) {
  const list = (Array.isArray(words) ? words : []).map((w) => String(w || '').trim()).filter(Boolean)
  const played = []
  for (const w of list) {
    const ok = playActionWord(w)
    played.push({ word: w, ok })
    const a = findAnim(w)
    const dur = a && Number(a.duration) ? Math.min(2.2, Math.max(0.5, a.duration)) : 0.8
    await new Promise((r) => setTimeout(r, dur * 1000))
  }
  return played
}

/* ---------------- 角色大小（设置可调） ---------------- */
async function applyScale (s, reload) {
  if (!isFinite(s) || s <= 0.1 || s > 4) return
  if (s === petScale) return
  petScale = s
  document.documentElement.style.setProperty('--pet-scale', String(s))
  // 舞台尺寸变了 → 相机锁定失效，重建渲染
  if (reload && spineRuntime) {
    try {
      const st = await window.aura.petState()
      if (st && st.visible && st.char) { disposeSpine(); showVisual(st.char) }
    } catch {}
  }
}

async function assetUrl (p) { return p ? window.aura.assetUrl(p) : '' }

function disposeSpine () {
  if (spineRuntime) { spineRuntime.render = false; spineRuntime = null }
  spineTalkStop()   // 0.46.61 口型定时器跟着骨架一起失效（旧 state 引用不能再摸）
  // 动作词表跟着渲染器一起失效（否则换角色后还往旧 AnimationState 上 setAnimation）
  if (spineAnimCtx) {
    clearTimeout(spineAnimCtx.faceTimer)
    spineAnimCtx = null
  }
}

/* WebGL 上下文丢失自愈：主屏全屏游戏（星穹铁道等）挤压显存会把 overlay 的 GL 上下文顶掉
 * （CONTEXT_LOST_WEBGL → 拿死上下文重建时「Couldn't create shader」），角色从此消失，
 * 用户眼里的「伙伴闪退」。30s 冷却防反复抖动；重建失败（GPU 进程还在恢复）按 8s 退避重试最多 3 次。 */
let lastSpineRebuild = 0
let rebuildTimer = null
function rebuildSpineFromState (reason) {
  const now = Date.now()
  if (now - lastSpineRebuild < 30000) { console.warn('[pet-ov] 重建跳过（冷却内）:', reason); return }
  lastSpineRebuild = now
  const attempt = async (n) => {
    clearTimeout(rebuildTimer)
    try {
      const st = await window.aura.petState()
      if (!st || !st.visible || !st.char) return
      disposeSpine()
      await showVisual(st.char)
      if (spineRuntime) { console.warn('[pet-ov] 角色渲染已自愈重建（' + reason + '）'); return }
    } catch (e) { console.warn('[pet-ov] 重建失败#' + n + ':', e && e.message) }
    if (n < 3) rebuildTimer = setTimeout(() => attempt(n + 1), 8000)
    else console.warn('[pet-ov] 重建三次均失败，等下一次触发')
  }
  attempt(1)
}
function disposeVrm () {
  if (vrmRuntime) { try { vrmRuntime.dispose() } catch {} vrmRuntime = null }
  currentSig = ''
  walkMotionWired = '' // 换模型 = 新 mixer，walk.vrma 要重新预载
}

/* 形象包（API 2）：canvas 声明式绘制，呼吸/摇摆/眨眼由 figure-render 负责；
 * 0.26.0 起走路与动作词也交给它（程序化姿态，不依赖骨骼素材） */
let figureLoop = null
// 换形象/重建循环时要知道「现在是不是在走」，否则走动途中换包会站着不动
const walkState = { on: false, dir: 1 }
function disposeFigure () {
  if (figureLoop) { try { figureLoop.stop() } catch {} figureLoop = null }
}

async function showFigure (v) {
  const f = v && v.figure
  if (!f || !f.pack) { $('petFallback').hidden = false; return }
  if (!window.AuraFigure) { $('petFallback').hidden = false; return }
  // 图层/配色/贴图地址都在主进程算好（变量名→具体色值），渲染层只管画
  const payload = await window.aura.figureResolve(f.pack, f)
  if (!payload) { $('petFallback').hidden = false; return }
  const canvas = $('petFigureCanvas')
  if (!figureLoop) {
    figureLoop = window.AuraFigure.startLoop(canvas, payload, { interval: 50 })
    // 走动途中换形象：新循环要把当前走动状态接上
    if (walkState.on && typeof figureLoop.setWalk === 'function') figureLoop.setWalk(true, walkState.dir)
  } else {
    await figureLoop.update(payload)
  }
}

/* ---------------- 形象总入口 ---------------- */
async function showVisual (char) {
  const v = (char && char.visual) || {}
  const mode = v.mode || 'still'
  const has = mode === 'figure'
    ? !!(v.figure && v.figure.pack)
    : mode === 'still' ? !!v.image : mode === 'spine' ? !!(v.spine && v.spine.atlas && v.spine.skel) : !!v.vrm
  if (!has) { $('petFallback').hidden = false; return }
  $('petFallback').hidden = true
  $('petStill').hidden = mode !== 'still'
  $('petSpineCanvas').hidden = mode !== 'spine'
  $('petVrmCanvas').hidden = mode !== 'vrm'
  $('petFigureCanvas').hidden = mode !== 'figure'
  if (mode !== 'spine') disposeSpine()
  if (mode !== 'vrm') disposeVrm()
  if (mode !== 'figure') disposeFigure()
  try {
    if (mode === 'still') {
      const url = await assetUrl(v.image)
      if (url) $('petStill').src = url
    } else if (mode === 'spine') {
      await showSpine(v)
    } else if (mode === 'vrm') {
      await showVrm(v)
    } else if (mode === 'figure') {
      await showFigure(v)
    }
  } catch (err) {
    console.error('[pet-ov]', err)
    $('petFallback').hidden = false
  }
}

/* 读骨架文件头部版本号，返回 "4.2" 主次版本 */
async function detectSpineVersion (skelUrl) {
  try {
    const res = await fetch(skelUrl)
    const buf = new Uint8Array(await res.arrayBuffer())
    let s = ''
    for (let i = 0; i < Math.min(buf.length, 160); i++) s += String.fromCharCode(buf[i])
    const m = s.match(/(\d+)\.(\d+)\.\d+/)
    return m ? m[1] + '.' + m[2] : null
  } catch { return null }
}

/* 消除逐三角形 clip 抗锯齿缝隙：三角形沿质心外扩 ~1.2 屏幕像素（u/v 不变） */
function patchSpineSeam (SPINE) {
  if (!SPINE || !SPINE.SkeletonRenderer || SPINE.SkeletonRenderer.prototype.__seamPatched) return
  SPINE.SkeletonRenderer.prototype.__seamPatched = true
  const orig = SPINE.SkeletonRenderer.prototype.drawTriangle
  SPINE.SkeletonRenderer.prototype.drawTriangle = function (img, x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2) {
    const s = this.__scale || 1
    const grow = 1.2 / (s || 1)
    const cx = (x0 + x1 + x2) / 3
    const cy = (y0 + y1 + y2) / 3
    const push = (px, py) => {
      const dx = px - cx
      const dy = py - cy
      const len = Math.hypot(dx, dy) || 1
      return [px + dx / len * grow, py + dy / len * grow]
    }
    ;[x0, y0] = push(x0, y0)
    ;[x1, y1] = push(x1, y1)
    ;[x2, y2] = push(x2, y2)
    orig.call(this, img, x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2)
  }
}

async function showSpine (v) {
  const libs = window.AuraLibs
  if (!libs || (!libs.SPINE && !libs.AuraSpine)) {
    // 开源版不含 Spine 运行时（再分发条款与开源协议不兼容）：优雅降级到兜底占位，不崩
    console.warn('[spine] 本构建不含 Spine 运行时（开源版默认移除）。持有授权可自行安装并 npm run libs 重建。')
    try { $('petFallback').hidden = false } catch {}
    return false
  }
  // 0.45.90 坐姿骨架：坐卡/命令坐下时切到 sitSkel，起身切回站姿。
  // 0.45.91 只允许「同一套皮肤」之间切（0001_99 ⇄ 0001_01）；主形象 0005_01 自带坐姿动作，
  // 不再为了坐下换成 0001_01 常服（用户报的「spine 有时候会自动换成其他皮肤」就是这个）。
  const pick = spineSkelFor(v, spineSkelMode)
  if (pick.skel && String(pick.skel) !== String(v.spine.skel)) {
    v = Object.assign({}, v, {
      spine: Object.assign({}, v.spine, { skel: pick.skel, atlas: pick.atlas, png: pick.png })
    })
  } else if (spineSkelMode === 'sit') {
    console.warn('[pet-ov] 坐下沿用当前皮肤（' + pick.reason + '），不换骨架')
  }
  const atlasUrl = await assetUrl(v.spine.atlas)
  const skelUrl = await assetUrl(v.spine.skel)
  console.warn('[pet-ov] showSpine mode=' + spineSkelMode + ' skel=' + String(v.spine.skel || '').replace(/.*[\\\\/]/, '') + ' url=' + (skelUrl ? 'ok' : '空'))
  const sig = atlasUrl + skelUrl
  if (spineRuntime && spineRuntime.sig === sig) return
  currentSig = sig
  disposeSpine()
  const ver = await detectSpineVersion(skelUrl)
  // 优先 WebGL 运行时（GPU 画 mesh，无逐三角形裁剪开销）；初始化失败降级 canvas
  let GL = libs.AuraSpineGL && ver && libs.AuraSpineGL[ver]
  let SPINE = GL || (libs.AuraSpine && ver && libs.AuraSpine[ver]) || libs.SPINE
  const canvas = $('petSpineCanvas')
  const scale = window.devicePixelRatio || 1
  canvas.width = canvas.clientWidth * scale
  canvas.height = canvas.clientHeight * scale
  /* 0.24.0 随身服务快帧通道：obs 不再用 capturePage 整窗回读（透明窗口实测约 500ms/帧
     → 手机端只有 2fps，卡顿根因），改为直接导出这张显示用 2D 画布——GL 路径每帧
     end() 后都 blit 到这里，内容常驻、随时可读，不需要 preserveDrawingBuffer。
     toBlob 异步编码不占渲染主线程；返回 null 时 obs 自动回退 capturePage。 */
  window.__ryzaObsFrame = function () {
    try {
      if (!canvas || !canvas.width || !canvas.height) return Promise.resolve(null)
      return new Promise((ok) => {
        try {
          canvas.toBlob((b) => {
            if (!b) return ok(null)
            const r = new FileReader()
            r.onload = () => ok(String(r.result))
            r.onerror = () => ok(null)
            r.readAsDataURL(b)
          }, 'image/png')
        } catch (e) { ok(null) }
      })
    } catch (e) { return Promise.resolve(null) }
  }
  /* 渲染循环诊断（obs 周期性取走打日志）：steps=runSpine 实跑次数（对墙上时间求导=真实帧率），
     hidden=页面是否被判隐藏（遮挡/宿主切换），w/h=画布当前物理尺寸 */
  window.__ryzaDiag = function () {
    return {
      steps: window.__ryzaSteps || 0,
      hidden: !!document.hidden,
      vis: document.visibilityState,
      w: canvas.width,
      h: canvas.height,
      ts: Date.now()
    }
  }
  let ctx = null
  let managedGl = null
  let glCanvas = null // GL 离屏画布：本机合成器对 WebGL canvas 的透明合成有薄纱 bug，GL 只画在这里
  let assetManager
  let useGL = false
  if (GL) {
    try {
      // GL 画在离屏 canvas，每帧 blit 到显示用 2D canvas（2D 的透明合成最可靠）。
      // 预乘管线 + 贴图上传预乘（PMA 混合配对）
      glCanvas = document.createElement('canvas')
      glCanvas.width = canvas.width
      glCanvas.height = canvas.height
      managedGl = new GL.ManagedWebGLRenderingContext(glCanvas, { alpha: true, premultipliedAlpha: true, antialias: false })
      managedGl.gl.pixelStorei(managedGl.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      // 上下文被全屏游戏挤掉（CONTEXT_LOST_WEBGL）时自愈：停旧渲染 + 拿当前角色整只重建
      glCanvas.addEventListener('webglcontextlost', (e) => {
        try { e.preventDefault() } catch { }
        console.warn('[pet-ov] WebGL 上下文丢失（多为主屏全屏游戏挤压显存）→ 自愈重建')
        if (spineRuntime) spineRuntime.render = false
        rebuildSpineFromState('webglcontextlost')
      })
      assetManager = new GL.AssetManager(managedGl, atlasUrl.replace(/[^/]*$/, ''))
      useGL = true
    } catch (e) {
      console.warn('[pet-ov] WebGL 初始化失败，降级 canvas:', e && e.message)
      GL = null
      glCanvas = null
      SPINE = (libs.AuraSpine && ver && libs.AuraSpine[ver]) || libs.SPINE
    }
  }
  if (!useGL) {
    patchSpineSeam(SPINE)
    ctx = canvas.getContext('2d', { willReadFrequently: false })
    assetManager = new SPINE.AssetManager(atlasUrl.replace(/[^/]*$/, ''))
  }
  console.warn('[pet-ov] 骨架版本', ver || '未知', '→ 运行时', useGL ? 'webgl ' + ver : (SPINE === libs.SPINE ? '4.3 canvas（兜底）' : ver + ' canvas'))
  // 贴图页预转 dataURL（绕开 Image+crossOrigin 对自定义协议的 CORS 拦截），失败走主进程兜底
  try {
    const atlasText = await (await fetch(atlasUrl)).text()
    const prefix = atlasUrl.replace(/[^/]*$/, '')
    const diskDir = String(v.spine.atlas || '').replace(/\\/g, '/').replace(/[^/]*$/, '')
    const pages = [...new Set([...atlasText.matchAll(/([^\s"']+?\.(?:png|jpe?g|webp))/gi)].map((m) => m[1]))]
    for (const name of pages) {
      try {
        const full = prefix + name
        let dataUrl = null
        for (let i = 0; i < 3 && !dataUrl; i++) {
          try {
            const blob = await (await fetch(full)).blob()
            dataUrl = await new Promise((ok, bad) => {
              const r = new FileReader()
              r.onload = () => ok(r.result)
              r.onerror = () => bad(new Error('readAsDataURL 失败'))
              r.readAsDataURL(blob)
            })
          } catch (e) {
            if (i === 2 && window.aura.assetData) {
              dataUrl = await window.aura.assetData(diskDir + name).catch(() => null)
            } else {
              await new Promise((ok) => setTimeout(ok, 200))
            }
          }
        }
        if (!dataUrl) throw new Error('预载三次均失败')
        assetManager.downloader.rawDataUris[full] = dataUrl
        assetManager.downloader.rawDataUris[name] = dataUrl
      } catch (e) { console.warn('[pet-ov] 预载贴图失败', name, e.message) }
    }
  } catch (e) { console.warn('[pet-ov] atlas 预读失败', e.message) }
  assetManager.loadTextureAtlas(basename(decodeURIComponent(atlasUrl)))
  const skelName = basename(decodeURIComponent(skelUrl))
  if (/\.json$/i.test(skelName)) assetManager.loadText(skelName)
  else assetManager.loadBinary(skelName)
  await new Promise((resolve, reject) => {
    const t0 = Date.now()
    const poll = () => {
      if (assetManager.isLoadingComplete()) {
        const errs = Object.values(assetManager.errors || {})
        if (errs.length) reject(new Error('Spine 资源加载失败: ' + String(errs[0]).slice(0, 200)))
        else resolve()
      } else if (Date.now() - t0 > 15000) reject(new Error('Spine 资源加载超时'))
      else setTimeout(poll, 80)
    }
    poll()
  })
  const atlas = assetManager.require(basename(decodeURIComponent(atlasUrl)))
  const skelData = assetManager.require(skelName)
  let skeletonData
  if (/\.json$/i.test(skelName)) {
    skeletonData = new SPINE.SkeletonJson(new SPINE.AtlasAttachmentLoader(atlas)).readSkeletonData(skelData)
  } else {
    skeletonData = new SPINE.SkeletonBinary(new SPINE.AtlasAttachmentLoader(atlas)).readSkeletonData(skelData)
  }
  const skeleton = new SPINE.Skeleton(skeletonData)
  const skins = skeletonData.skins || []
  if (skins.length) {
    const pick = skins.find((s) => /default|base|normal/i.test(s.name)) || skins[skins.length - 1]
    skeleton.setSkin(skins.length > 1 ? pick : skins[0])
    skeleton.setSlotsToSetupPose()
  }
  // 所有 4.x 的 AnimationState 构造参数都是 AnimationStateData（不是 SkeletonData）
  const state = new SPINE.AnimationState(new SPINE.AnimationStateData(skeletonData))
  const anims = skeletonData.animations
  // idle 选择：优先全身待机，眉毛/脸部/特效类幅度太小放最后兜底
  const idle = anims.find((a) => /^motion_[A-Z]_\d+_idle$/i.test(a.name))
    || anims.find((a) => /motion.*idle/i.test(a.name))
    || anims.find((a) => /stand|wait|待机/i.test(a.name))
    || anims.find((a) => /idle|待机/i.test(a.name) && !/facial|face|effect/i.test(a.name))
    || anims.find((a) => /idle|待机/i.test(a.name))
    || anims[0]
  console.warn('[pet-ov] 加载成功 → 播放', idle && idle.name)
  if (idle) state.setAnimation(0, idle.name, true)
  // S3：动作词表挂到模块级，供 pet_act / pet_say 标记使用
  spineAnimCtx = { state, anims, idle, faceTimer: null, skelBase: spineSkelMode }
  // WebGL 路径：GPU 画 mesh，30fps 足够流畅且几乎不占主线程
  if (useGL) {
    const sceneRenderer = new GL.SceneRenderer(glCanvas, managedGl)
    // 显示画布用 2D 上下文接收离屏 GL 的 blit
    const ctx2d = canvas.getContext('2d', { willReadFrequently: false })
    const gl = managedGl.gl
    const offset = new SPINE.Vector2()
    const size = new SPINE.Vector2()
    // 相机锁定：包围盒按 setup pose 只算一次。
    // 动画（呼吸等）会持续改变包围盒，跟着重算会让角色看起来忽大忽小。
    // 必须先算一次世界变换再取包围盒——加载期骨架从未 updateWorldTransform，
    // 直接 getBounds 得到的是垃圾值 → zoom 错乱 → 角色碎片铺满画布（0.3.29 色块根因）
    // Physics.none：只按当前局部姿势（= setup pose）刷世界变换，不跑物理
    // （4.2 枚举是 none/reset/update/pose，没有 4.3 的 setup）
    skeleton.updateWorldTransform(SPINE.Physics ? SPINE.Physics.none : undefined)
    skeleton.getBounds(offset, size, [])
    const bw = size.x || 1
    const bh = size.y || 1
    const cam = sceneRenderer.camera
    cam.position.set(offset.x + bw / 2, offset.y + bh / 2, 0)
    // 画布尺寸自愈：初始化时 stage 可能是 hidden（角色锚点在另一块屏 → 跨屏宿主
    // 还没切过来），clientWidth=0 → canvas/glCanvas 全是 0 尺寸 → 每帧 drawImage
    // 抛「width or height of 0」且画面永远空白（v0.4.4 右屏空白的根因）。
    // 每帧检测 clientWidth 变化并重设画布+相机；宿主切换、缩放变更都走这里恢复
    const dpr = window.devicePixelRatio || 1
    let lastGLSize = ''
    function sizeGL () {
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h }
      /* 跨屏「角色消失」的根因（0.3.0 补丁 4）：
       * ManagedWebGLRenderingContext 构造时会用「当时的 canvas 尺寸」复位 gl.viewport / scissor，
       * 而这块屏的舞台在启动时是 hidden（角色锚点在另一块屏）→ clientWidth=0 → canvas 被夹成 1x1，
       * 视口就被永久钉在左下角 1 个像素上。之后 canvas 尺寸自愈到正常值，但没人再设 viewport，
       * 于是全部三角形都被画进那 1 像素 → 读回来中心 alpha=0，画面完全透明。
       * 改 canvas.width 不会自动同步 viewport，这里必须每帧显式对齐（尺寸变了才动手，开销可忽略）。 */
      const sizeTag = w + 'x' + h
      if (sizeTag !== lastGLSize) {
        lastGLSize = sizeTag
        try {
          gl.viewport(0, 0, w, h)
          gl.scissor(0, 0, w, h) // 万一某处开了 SCISSOR_TEST，别被旧的 1x1 裁掉
        } catch (e) { console.warn('[pet-ov] 视口同步失败:', e.message) }
        if (w > 2 && h > 2) console.warn('[pet-ov] 画布重建 ' + sizeTag + ' → gl.viewport 已同步')
      }
      cam.setViewport(canvas.width, canvas.height)
      let z = Math.max(bw / canvas.width, bh / canvas.height) / 0.95
      if (!isFinite(z) || z <= 0) z = 1
      cam.zoom = z
    }
    sizeGL()
    /* ---- 视觉跟踪（参考 agentatelierR character_gaze.dart / chat_screen.dart） ----
     * 光标在骨架坐标里的方向，经指数平滑后平移 control_* 控制骨骼（IK 目标），
     * 在 state.apply 之后、updateWorldTransform 之前修改。*/
    const gnorm = (skeletonData.width || 1400) / 1400 // 参考项目的常量按其骨架宽度标定
    // 版本兼容：spine 4.3+ 才有 bone.pose（姿势对象），4.2 直接挂在 bone 上
    const POSE43 = !!(skeleton.bones && skeleton.bones.length && skeleton.bones[0].pose)
    const P = (b) => (POSE43 ? b.pose : b)
    const stage = document.getElementById('petStage')
    const aimHead = skeleton.findBone('control_aim_head')
    const aimBody = skeleton.findBone('control_aim_body')
    const rollHead = skeleton.findBone('control_roll_head')
    const rollNeck = skeleton.findBone('control_roll_neck')
    const rollBodyU = skeleton.findBone('control_roll_body_upper')
    const rollBodyL = skeleton.findBone('control_roll_body_lower')
    const aimEye = skeleton.findBone('control_aim_eye') || skeleton.findBone('control_eye') || skeleton.findBone('control_handle_eye')
    const eyes = ['eyeball_L', 'eyeball_R'].map((n) => skeleton.findBone(n)).filter(Boolean)
    for (const b of [aimHead, aimBody, rollHead, rollNeck, rollBodyU, rollBodyL, aimEye].concat(eyes)) {
      if (!b) continue
      b.__gx = P(b).x
      b.__gy = P(b).y
    }
    const gaze = { h: { x: 0, y: 0 }, b: { x: 0, y: 0 } }
    let gazeDbg = '-'
    // 薄纱取证：画布内容已证实干净而屏幕有薄纱 → 让程序自己枚举该区域的可见元素
    let veilScanned = false
    function scanVeil () {
      try {
        const r = stage.getBoundingClientRect()
        const probes = [[r.left + r.width / 2, r.top + 6], [r.left + 6, r.top + r.height / 2], [r.left + r.width / 2, r.top + r.height / 2]]
        const seen = new Set()
        const out = []
        for (const [x, y] of probes) {
          for (const el of document.elementsFromPoint(x, y)) {
            const cs = getComputedStyle(el)
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
            const key = (el.id || el.tagName + '.' + String(el.className).slice(0, 24)) +
              ' bg=' + cs.backgroundColor + ' op=' + cs.opacity +
              (cs.backdropFilter && cs.backdropFilter !== 'none' ? ' BACKDROP(' + cs.backdropFilter + ')' : '') +
              (el.id === 'petSpineCanvas' ? ' [显示画布]' : '')
            if (seen.has(key)) continue
            seen.add(key)
            out.push(key)
          }
        }
        console.warn('[pet-ov] 薄纱扫描:', out.join(' || ') || '(区域无可见元素)')
      } catch (e) { console.warn('[pet-ov] 薄纱扫描失败:', e.message) }
    }
    const _v = GL.Vector3 ? new GL.Vector3() : null
    function screenToSkeletonWorld (cssX, cssY) {
      if (!stage) return null
      const r = stage.getBoundingClientRect()
      if (!r.width || !r.height) return null
      // cssX/cssY 是窗口内坐标（触摸点击的 clientX/Y）；gaze 传全局光标前需先减 window.screenX/Y。
      // 正交相机：世界 delta = 屏幕 delta * zoom，骨架 y 向上需翻转屏幕 y。
      // 画布中心的世界坐标 = 相机位置（锁定时对准包围盒中心并绘制在画布中心）
      const zoom = (cam && cam.zoom) || 1
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const px = cam && cam.position ? cam.position.x : 0
      const py = cam && cam.position ? cam.position.y : 0
      if (_v) { _v.x = px + (cssX - cx) * zoom; _v.y = py - (cssY - cy) * zoom; _v.z = 0; return _v }
      return { x: px + (cssX - cx) * zoom, y: py - (cssY - cy) * zoom, z: 0 }
    }
    function resetGaze () {
      for (const b of [aimHead, aimBody, rollHead, rollNeck, rollBodyU, rollBodyL, aimEye].concat(eyes)) {
        if (!b) continue
        P(b).x = b.__gx
        P(b).y = b.__gy
      }
    }
    function stepGaze (dt) {
      const infl = gazeInfluence()
      if (infl <= 0) {
        if (gaze.h.x || gaze.h.y || gaze.b.x || gaze.b.y) { gaze.h.x = gaze.h.y = gaze.b.x = gaze.b.y = 0; resetGaze() }
        gazeDbg = 'infl=0'
        return
      }
      const face = skeleton.findBone('head')
      // cursorScreen 是全局屏幕坐标，先转窗口内坐标（多显示器可为负原点）
      const p = cursorScreen
        ? screenToSkeletonWorld(cursorScreen.x - (window.screenX || 0), cursorScreen.y - (window.screenY || 0))
        : null
      if (!face || !p) { gazeDbg = 'no-face-or-point'; return }
      const fx = P(face).worldX
      const fy = P(face).worldY
      // 参考 gazeControlOffset：方向保持，距离超过 maxDistance 后钳到 maxOffset=140
      const dx = p.x - fx
      const dy = p.y - fy
      const dist = Math.hypot(dx, dy) || 1
      const MAXD = 514.7 * gnorm
      const MAXOFF = 140 * gnorm
      const k = MAXOFF / Math.max(MAXD, dist)
      const off = { dx: dx * k, dy: dy * k }
      const c = Math.min(0.05, Math.max(0.001, dt))
      const kH = 1 - Math.exp(-c / 0.1)
      const kB = 1 - Math.exp(-c / 0.2)
      gaze.h.x += (off.dx - gaze.h.x) * kH
      gaze.h.y += (off.dy - gaze.h.y) * kH
      gaze.b.x += (off.dx - gaze.b.x) * kB
      gaze.b.y += (off.dy - gaze.b.y) * kB
      // 世界偏移 → 该骨骼父骨骼局部空间（参考 _applyEyeGaze 的 worldToLocal 差值法）。
      // 控制骨骼的父链可能带旋转/镜像/缩放，直接把世界方向加进局部坐标会看错方向；
      // 父骨骼缩放 <1 时局部位移会被放大 → 必须钳制（否则一动鼠标就扭成麻花）
      const toLocal = (bone, odx, ody, maxLocal) => {
        const parent = bone.parent
        if (!parent) return { x: odx, y: ody }
        const a = parent.worldToLocal({ x: fx, y: fy })
        const b = parent.worldToLocal({ x: fx + odx, y: fy + ody })
        let lx = b.x - a.x
        let ly = b.y - a.y
        const len = Math.hypot(lx, ly)
        if (maxLocal > 0 && len > maxLocal) { lx = lx / len * maxLocal; ly = ly / len * maxLocal }
        return { x: lx, y: ly }
      }
      gazeDbg = 'cursor=' + (cursorScreen ? Math.round(cursorScreen.x) + ',' + Math.round(cursorScreen.y) : '-') +
        ' win=' + Math.round(window.screenX || 0) + ',' + Math.round(window.screenY || 0) +
        ' zoom=' + ((cam && cam.zoom) || 0).toFixed(2) +
        ' head=' + Math.round(fx) + ',' + Math.round(fy) +
        ' off=' + Math.round(gaze.h.x) + ',' + Math.round(gaze.h.y) +
        ' infl=' + infl.toFixed(2)
      // 眼球：偏移量 * 0.2（参考 _applyEyeGaze）
      let eyesMoved = false
      for (const e of eyes) {
        if (!e.parent) continue
        const l = toLocal(e, gaze.h.x, gaze.h.y, 40)
        P(e).x = e.__gx + l.x * infl * 0.2
        P(e).y = e.__gy + l.y * infl * 0.2
        eyesMoved = true
      }
      if (!eyesMoved && aimEye) {
        const l = toLocal(aimEye, gaze.h.x, gaze.h.y, 140)
        P(aimEye).x = aimEye.__gx + l.x * infl
        P(aimEye).y = aimEye.__gy + l.y * infl
      }
      const s = infl
      let l
      if (aimHead) { l = toLocal(aimHead, gaze.h.x, gaze.h.y, 60); P(aimHead).x = aimHead.__gx + l.x * 0.34 * s; P(aimHead).y = aimHead.__gy + l.y * 0.24 * s }
      if (aimBody) { l = toLocal(aimBody, gaze.b.x, gaze.b.y, 90); P(aimBody).x = aimBody.__gx + l.x * 0.39 * s; P(aimBody).y = aimBody.__gy + l.y * 0.27 * s }
      if (rollHead) { l = toLocal(rollHead, gaze.h.x, gaze.h.y, 50); P(rollHead).x = rollHead.__gx + l.x * 0.29 * s }
      if (rollNeck) { l = toLocal(rollNeck, gaze.h.x, gaze.h.y, 30); P(rollNeck).x = rollNeck.__gx + l.x * 0.14 * s }
      if (rollBodyU) { l = toLocal(rollBodyU, gaze.b.x, gaze.b.y, 100); P(rollBodyU).x = rollBodyU.__gx + l.x * 0.57 * s }
      if (rollBodyL) { l = toLocal(rollBodyL, gaze.b.x, gaze.b.y, 45); P(rollBodyL).x = rollBodyL.__gx + l.x * 0.23 * s }
    }
    /* ---- 触摸反应（参考 tap_reaction.dart：BB_* 包围盒命中 → motion_touch 动作） ---- */
    const BB_PARTS = { BB_head: 'head', BB_body: 'body', BB_arm_L: 'arm_l', BB_arm_R: 'arm_r', BB_weast: 'weast', BB_breast: 'breast' }
    function polygonContains (verts, x, y) {
      if (!verts || verts.length < 6) return false
      let inside = false
      for (let i = 0, j = verts.length - 2; i < verts.length; j = i, i += 2) {
        const xi = verts[i], yi = verts[i + 1], xj = verts[j], yj = verts[j + 1]
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside
      }
      return inside
    }
    function polygonArea (verts) {
      let a = 0
      for (let i = 0, j = verts.length - 2; i < verts.length; j = i, i += 2) a += verts[j] * verts[i + 1] - verts[i] * verts[j + 1]
      return Math.abs(a) / 2
    }
    onTapHook = (cssX, cssY) => {
      try {
        const p = screenToSkeletonWorld(cssX, cssY)
        if (!p) return
        const hits = []
        for (const slot of skeleton.slots) {
          const part = BB_PARTS[slot.data && slot.data.name]
          if (!part) continue
          const att = (slot.getAttachment ? slot.getAttachment() : slot.appliedPose.attachment)
          if (!att || !(att instanceof SPINE.BoundingBoxAttachment)) continue
          const verts = new Array(att.worldVerticesLength)
          // 签名兼容：4.3+ 首参是 skeleton，4.2 首参直接是 slot
          if (POSE43) att.computeWorldVertices(skeleton, slot, 0, att.worldVerticesLength, verts, 0, 2)
          else att.computeWorldVertices(slot, 0, att.worldVerticesLength, verts, 0, 2)
          if (!polygonContains(verts, p.x, p.y)) continue
          hits.push({ part, area: polygonArea(verts) })
        }
        if (!hits.length) return
        hits.sort((a, b) => a.area - b.area)
        const cands = TOUCH_REACTIONS[hits[0].part] || []
        let animName = cands.find((n) => anims.some((x) => x.name === n))
        if (!animName) {
          const any = anims.find((x) => /motion_touch/i.test(x.name))
          animName = any && any.name
        }
        if (!animName) return
        state.setAnimation(0, animName, false)
        state.addAnimation(0, idle.name, true, 0)
        // 触摸语音反馈（对齐参考项目：不同部位对应反应语音）
        speakTouch(hits[0].part)
        // S4/3.5：把部位触摸也报给主进程（和拖拽类事件一起 2.5s 合并后注入上下文），
        // 只由宿主屏上报，否则两块屏各报一次会翻倍
        if (petHosted) { try { window.aura.petTap && window.aura.petTap(hits[0].part) } catch {} }
      } catch (e) { console.warn('[pet-ov] 触摸反应失败:', e.message) }
    }
    spineRuntime = {
      sig,
      render: true,
      resize: sizeGL, // 宿主切换/取消隐藏时立刻按真实尺寸对齐画布与 gl.viewport
      step (dt) {
        // 上下文死亡检测：lost 事件偶尔不来（GPU 进程崩了连事件都发不出），每帧兜底查一次
        if (gl.isContextLost && gl.isContextLost()) {
          if (spineRuntime) spineRuntime.render = false
          rebuildSpineFromState('step检测到上下文丢失')
          return
        }
        sizeGL() // 每帧自检：hidden 时初始化的 0 尺寸 / 宿主切换后显示 / 缩放变更都在这里恢复
        if (skeleton.update) skeleton.update(dt)
        state.update(dt)
        // 关键：必须把动画姿势应用到骨架，否则画的永远是 setup pose 静止图
        state.apply(skeleton)
        stepGaze(dt) // 视线跟踪：动画之后、世界变换之前修改控制骨骼
        skeleton.updateWorldTransform(SPINE.Physics ? SPINE.Physics.update : undefined)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        sceneRenderer.begin()
        sceneRenderer.drawSkeleton(skeleton, true) // 贴图已预乘，PMA 混合 (ONE, ONE_MINUS_SRC_ALPHA)
        sceneRenderer.end()
        // 离屏 GL → 显示 2D canvas 的 blit：必须在同一任务内紧跟 end()（无 preserveDrawingBuffer）
        ctx2d.clearRect(0, 0, canvas.width, canvas.height)
        ctx2d.drawImage(glCanvas, 0, 0)
        // 取证 dump：2D 画布随时可读，紧跟 blit 保证是本帧内容
        if (spineRuntime && spineRuntime.dump) {
          spineRuntime.dump = false
          try { window.aura.logImage('pet-canvas-' + Date.now() + '.png', canvas.toDataURL('image/png')) } catch {}
        }
      },
      // 诊断：trackTime 是否推进 + 角像素是否透明（区分「GL 缓冲不透明」vs「合成不吃 alpha」）
      heartbeat () {
        if (!veilScanned) { veilScanned = true; scanVeil() }
        const cur = state.getCurrent(0)
        let px = ''
        try {
          const buf = new Uint8Array(4)
          const pts = [[2, 2], [canvas.width - 3, 2], [2, canvas.height - 3], [canvas.width - 3, canvas.height - 3], [Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)]]
          const parts = []
          for (let i = 0; i < 5; i++) {
            const x = pts[i][0]
            const y = pts[i][1]
            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf)
            parts.push('a=' + buf[3] + (i === 4 ? ' rgb=' + buf[0] + ',' + buf[1] + ',' + buf[2] : ''))
          }
          px = ' 四角/中心:' + parts.join(' ')
        } catch (e) { px = ' 像素读取失败:' + e.message }
        return 'trackTime=' + (cur ? cur.trackTime.toFixed(2) : '-') +
          ' anim=' + (cur && cur.animation ? cur.animation.name : '-') +
          ' 画布=' + canvas.width + 'x' + canvas.height + px + liveness() +
          ' gaze[' + gazeDbg + ']'
      }
    }
  } else {
    // canvas 兜底路径（仅 4.0/4.1 皮肤）
    spineRuntime = {
      sig,
      render: true,
      step (dt) {
        // 画布尺寸自愈（同 GL 路径）：hidden 时初始化 → clientWidth=0 → 永远画不出东西
        {
          const w = Math.max(1, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)))
          const h = Math.max(1, Math.round(canvas.clientHeight * (window.devicePixelRatio || 1)))
          if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
        }
        state.update(dt)
        // 关键：必须把动画姿势应用到骨架，否则画的永远是 setup pose 静止图
        state.apply(skeleton)
        if (skeleton.update) skeleton.update(dt)
        skeleton.updateWorldTransform(SPINE.Physics ? SPINE.Physics.update : undefined)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        const offset = new SPINE.Vector2()
        const size = new SPINE.Vector2()
        skeleton.getBounds(offset, size, [])
        const s = Math.min(canvas.width / (size.x || 1), canvas.height / (size.y || 1)) * 0.95
        ctx.save()
        // spine 世界坐标 y 向上、canvas y 向下：必须翻转 y 并把 bounds 底边对到画布底
        ctx.translate((canvas.width - size.x * s) / 2 - offset.x * s, canvas.height - 6 + offset.y * s)
        ctx.scale(s, -s)
        const renderer = new SPINE.SkeletonRenderer(ctx)
        // 默认 drawImages 只画 Region 四边形、跳过 Mesh → 必须 triangleRendering
        renderer.triangleRendering = true
        renderer.__scale = s
        renderer.draw(skeleton)
        ctx.restore()
      },
      heartbeat () {
        const cur = state.getCurrent(0)
        return 'trackTime=' + (cur ? cur.trackTime.toFixed(2) : '-') + ' 画布=' + canvas.width + 'x' + canvas.height + liveness()
      }
    }
  }
  // 用 setInterval 驱动（rAF 已实测满帧率，但 40ms invalidate 兜底保留）。
  // dt 用真实间隔（0.3.26 前硬编码 1/60 而 interval 是 33ms，动画只有半速）
  if (!spineRafStarted) {
    spineRafStarted = true
    let errCount = 0
    let frames = 0
    let lastT = performance.now()
    // 忙/闲两档帧率（Coopanion RESTING_FPS 模式）：忙 = 设置里的帧率（默认 30），静止减半；
    // 窗口 hidden（非宿主屏的 overlay）时整帧跳过——看不见的模型不值得烧 GPU
    const busyMs = () => Math.max(7, Math.round(1000 / (Number(petFps) || 30)))
    const restMs = () => Math.max(16, Math.round(busyMs() * 2))
    let spineTimer = null
    // 首拍就按当前忙闲状态取间隔（之前这里残留了 SPINE_BUSY_MS 这个不存在的常量，
    // 一进渲染循环就 ReferenceError，整个角色画不出来）
    let spineMs = petBusy() ? busyMs() : restMs()
    const runSpine = () => {
      if (document.hidden) { lastT = performance.now(); return }
      window.__ryzaSteps = (window.__ryzaSteps || 0) + 1 // 渲染循环实测帧率探针（obs diag 用）
      if (spineRuntime && spineRuntime.render) {
        try {
          const now = performance.now()
          const dt = Math.min(0.1, (now - lastT) / 1000)
          lastT = now
          spineRuntime.step(dt)
          errCount = 0 // 本帧正常 → 连续异常计数清零
          // 心跳：只在诊断模式开（读画布像素 + 落盘很贵）
          if (TRACE() && ++frames % 60 === 0 && spineRuntime.heartbeat) {
            console.warn('[pet-ov] 心跳#' + frames, spineRuntime.heartbeat())
            // 取证：canvas 位图 dump（desktopCapturer 拍不到透明窗口，弃用 petSnapshot）
            if (frames === 60 || frames === 420) {
              try { if (spineRuntime) spineRuntime.dump = true } catch {}
            }
          }
        } catch (e) {
          if (++errCount <= 3) console.warn('[pet-ov] step 异常:', e.message)
          // 连续 5 帧异常（如「Couldn't create shader」）≈ 上下文已废但 lost 事件没来 → 自愈重建
          // （每 5 帧再触发一次没关系，rebuildSpineFromState 自带 30s 冷却）
          if (errCount % 5 === 0) rebuildSpineFromState('step连续异常: ' + (e && e.message))
        }
      }
      // 闲时降帧：本帧画完后改间隔，下一拍生效
      const want = petBusy() ? busyMs() : restMs()
      if (want !== spineMs) {
        spineMs = want
        clearInterval(spineTimer)
        spineTimer = setInterval(runSpine, want)
      }
    }
    spineTimer = setInterval(runSpine, spineMs)
  }
}

/* ---------------- 3D（VRM 0.x / 1.0 / 普通 GLB） ----------------
 * 具体渲染在 shared/vrm-stage.js：取景按包围盒、自带动画播放、眨眼、说话口型。
 * 伙伴这边额外要 preserveDrawingBuffer —— 热区用低分辨率 alpha 掩码收紧，
 * 没有它 drawImage(WebGL canvas) 在下一帧读到的是空画面 → 掩码失效退回矩形。 */
async function showVrm (v) {
  const url = await assetUrl(v.vrm)
  if (vrmRuntime && vrmRuntime.sig === url && vrmRuntime.alive) return
  disposeVrm()
  currentSig = url
  if (!window.AuraVrm) {
    console.error('[pet-ov] vrm-stage 未加载')
    $('petFallback').hidden = false
    return
  }
  const stage = window.AuraVrm.create({
    canvas: $('petVrmCanvas'),
    libs: window.AuraLibs,
    url,
    sig: url,
    // 0.18.0 第一批：跟随设置里的帧率（默认 30），静止时减半
    fps: Math.max(10, Number(petFps) || 30),
    restFps: Math.max(10, Math.round((Number(petFps) || 30) / 2)),
    isBusy: petBusy,
    preserveDrawingBuffer: true,
    // 0.33.0 自主动作上报：长待机小彩蛋是她自己做的，宿主屏转 pet:self-report
    // （每块屏都有 overlay，不按 petHosted 过滤会重复上报）
    onSelfAct: (kind) => {
      if (!petHosted) return
      try { window.aura.petSelfAct && window.aura.petSelfAct(kind) } catch { }
    },
    // 0.45.54 舞台诊断（站立窗口/待机动作名/手势）→ main.log 的 [renderer] pet-walk:
    // 只由宿主屏上报，避免两块屏各写一份
    onDiag: (msg) => { if (petHosted) petDiag(msg) }
  })
  vrmRuntime = stage
  try {
    await stage.ready
  } catch (err) {
    if (vrmRuntime === stage) disposeVrm()
    throw err
  }
  // 走动途中换模型：新舞台要把当前走动状态接上，否则会站着被平移
  if (walkState.on && typeof stage.setWalk === 'function') stage.setWalk(true, walkState.dir)
  // 0.45.44 走路接真 MMD 动作：motions/walk.vrma（动作词映射里的 walk 同一个文件）
  // 预载进走路通道；加载失败自动留在程序化摆腿，不影响别的
  wireWalkMotion()
  // 0.45.52 待机池 VRMA 预载（模型就绪路径）
  wireIdleVrmas()
}

/** 0.45.45 诊断：渲染层日志到不了 main.log，走路 VRMA 链路用 reportError 上报
 *  （主进程落到 [renderer] pet-walk: ... ，真机排查就有着落了） */
function petDiag (msg) {
  try { window.aura.reportError && window.aura.reportError('pet-walk', String(msg).slice(0, 300)) } catch { }
}
/** 同 petDiag 但按 key 节流（60s 内同一原因只报一次，防刷屏） */
const petDiagLast = {}
function petDiagOnce (key, msg) {
  const now = Date.now()
  if (petDiagLast[key] && now - petDiagLast[key] < 60000) return
  petDiagLast[key] = now
  petDiag('[' + key + '] ' + msg)
}

/** 0.45.52 待机池：motions/ 里的 VRMA 待机（待机* / idle* / 看手机 / 思考 / 张望）
 *  预载进 vrm-stage 轮换池，fidget 插播时随机挑一条播（真动捕质感的待机变化）。
 *  幂等：按文件名集合签名去重，模型/接口未就绪时不标记，下次再试。 */
let idleVrmasWired = ''
let idleVrmasFailed = false
function wireIdleVrmas () {
  try {
    if (!vrmRuntime) return
    if (typeof vrmRuntime.registerIdleVrma !== 'function') {
      petDiagOnce('no-idle-api', '待机池跳过：stage 上没有 registerIdleVrma API（vrm-stage 是旧版）')
      return
    }
    const names = Object.keys(vrmaActMap || {})
      .filter((k) => /^(待机|idle)/.test(k) || ['看手机', '思考', '张望', '张望B', '鼓掌'].indexOf(k) !== -1)
    const sig = names.slice().sort().join(',')
    // 0.45.53：有失败就允许重试（首波常撞上「模型未就绪」，0.45.52 靠第二个挂点
    // 才恢复纯属运气）。registerIdleVrma 按 URL 幂等，重试只补失败的，代价低。
    if (!names.length || (idleVrmasWired === sig && !idleVrmasFailed)) return
    idleVrmasWired = sig
    idleVrmasFailed = false
    petDiag('待机池预载(' + names.length + '): ' + names.join('/'))
    let loaded = 0
    for (const n of names) {
      assetUrl(vrmaActMap[n]).then((u) => {
        if (!u) { idleVrmasFailed = true; return }
        return vrmRuntime.registerIdleVrma(u).then((ok) => {
          if (!ok) { idleVrmasFailed = true; petDiag('待机池 ' + n + ' 预载失败（vrm-stage 端加载错误）') }
          else if (++loaded === names.length) petDiag('待机池就绪 ' + loaded + '/' + names.length)
          if (idleVrmasFailed) setTimeout(() => { try { wireIdleVrmas() } catch { } }, 5000)
        })
      }).catch((e) => { idleVrmasFailed = true; petDiag('待机池 ' + n + ' 预载失败: ' + (e && e.message)) })
    }
  } catch (e) { petDiag('wireIdleVrmas 异常: ' + (e && e.message)) }
}

/** 0.45.44 把 motions/walk.vrma 预载进 vrm-stage 的走路通道（幂等，config 与模型谁后就绪谁触发） */
let walkMotionWired = ''
function wireWalkMotion () {
  try {
    if (!vrmRuntime) {
      petDiagOnce('no-stage', '预载跳过：stage 未就绪（模型还没加载完）')
      return
    }
    if (typeof vrmRuntime.setWalkMotion !== 'function') {
      petDiagOnce('no-api', '预载跳过：stage 上没有 setWalkMotion API（vrm-stage 是旧版）')
      return
    }
    const f = vrmaActMap && vrmaActMap.walk
    if (!f) {
      petDiagOnce('no-map', '预载跳过：vrmaActMap.walk 缺失（词数 ' + Object.keys(vrmaActMap || {}).length + '）')
      return
    }
    if (walkMotionWired === f) return
    walkMotionWired = f
    petDiag('walk.vrma 预载开始')
    assetUrl(f).then((u) => {
      if (!u) { petDiag('walk.vrma assetUrl 为空（文件不存在？）: ' + f); walkMotionWired = ''; return }
      return vrmRuntime.setWalkMotion(u).then((ok) => {
        petDiag('walk.vrma 预载' + (ok ? '成功' : '失败（详见 vrm-stage 日志）'))
        if (!ok) walkMotionWired = ''
      })
    })
      .catch((e) => { petDiag('walk VRMA 预载失败: ' + (e && e.message)); walkMotionWired = '' })
  } catch (e) { petDiag('wireWalkMotion 异常: ' + (e && e.message)) }
}

/* ---------------- 悬停聊天（气泡回复）+ 语音捕捉 ---------------- */
function setupChat () {
  const stage = $('petStage')
  const panel = $('petChat')
  const bubble = $('petBubble')
  const input = $('petChatInput')
  const mic = $('petMic')
  const sendBtn = $('petSendBtn')
  if (!panel || !input || !stage) return
  let hideTimer = null
  let generating = false
  let bubbleTimer = null

  /* ---- 悬停面板只做一件事：输入。回复一律走角色头顶的气泡 ----
   * 之前这里塞了一份"缩小版聊天框"（历史记录列表），与完整聊天界面重复且互相打架；
   * 聊天记录统一在主窗口里看，桌面上只保留一句话的气泡。 */
  // 旧的 petChatOpen 按钮已改名 petManageBtn（下方 setupChat 里绑定），这里不再重复。
  // 面板定位：贴角色正下方（水平居中），超出屏幕则夹回；下方放不下翻到角色上方
  // 赋值到模块级 positionChat（v0.3.1）：setupDrag 拖动跟随也要调用
  positionChat = function positionChat () {
    if (panel.hidden) return
    const r = stage.getBoundingClientRect()
    const pw = panel.offsetWidth || 300
    const ph = panel.offsetHeight || 120
    let x = r.left + r.width / 2 - pw / 2
    x = Math.max(8, Math.min(window.innerWidth - pw - 8, x))
    let y = r.bottom + 8
    if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 8)
    panel.style.left = Math.round(x) + 'px'
    panel.style.top = Math.round(y) + 'px'
  }
  // 气泡定位：贴角色头顶（水平居中），强制夹屏；放不下时移到角色下方
  positionBubble = function positionBubble () {
    if (bubble.hidden) return
    const r = stage.getBoundingClientRect()
    const bw = bubble.offsetWidth || 260
    const bh = bubble.offsetHeight || 60
    let x = r.left + r.width / 2 - bw / 2
    x = Math.max(8, Math.min(window.innerWidth - bw - 8, x))
    let y = r.top - bh - 10
    if (y < 8) y = Math.min(window.innerHeight - bh - 8, r.bottom + 10)
    bubble.style.left = Math.round(x) + 'px'
    bubble.style.top = Math.round(y) + 'px'
  }
  // 气泡显示/更新（流式期间不淡出），完成后停留默认 8 秒淡出（有语音时由 bubbleHoldVoice 接管）
  const BUBBLE_KEEP = 8000
  let bubbleSeq = 0
  /* 走动礼让：气泡在显示 / 悬停面板打开时暂停自主走动（说明话说到一半不该走开） */
  let holdBubble = false
  let holdPanel = false
  let holdAsk = false // S3：提问气泡打开时同样暂停自主走动（人还没回答，不该走开）
  let holdSent = null
  let lastBubbleText = ''
  function syncRoamHold () {
    const on = holdBubble || holdPanel || holdAsk
    if (on === holdSent) return
    holdSent = on
    try { window.aura.petRoamHold(on) } catch {}
  }
  function bubbleShow (text) {
    if (!petHosted) return // 角色不在这块屏 → 不画气泡（气泡只跟角色走）
    bubbleSeq++ // 新一轮气泡 → 之前挂着等语音的定时逻辑作废
    clearTimeout(bubbleTimer)
    bubble.classList.remove('fading')
    bubble.hidden = false
    const nextText = String(text == null ? '' : text)
    // 0.18.0 第一批说话声：流式增量按「新增字数」打音节（替换整句时不补，避免刷屏）
    if (nextText.startsWith(lastBubbleText)) {
      const delta = nextText.length - lastBubbleText.length
      if (delta > 0) speechBlips(Math.min(delta, 3))
    }
    if (nextText.length < lastBubbleText.length || !nextText.startsWith(lastBubbleText)) {
      speechBlips(Math.min(2, nextText.length)) // 新一句：给两个起音
    }
    lastBubbleText = nextText
    bubble.textContent = nextText
    holdBubble = true
    syncRoamHold()
    // 长回复被 max-height 截断时，始终显示最新内容
    bubble.scrollTop = bubble.scrollHeight
    requestAnimationFrame(positionBubble)
  }
  function bubbleKeep (ms = BUBBLE_KEEP) {
    clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(() => {
      bubble.classList.add('fading')
      bubbleTimer = setTimeout(() => {
        bubble.hidden = true
        bubble.classList.remove('fading')
        holdBubble = false
        syncRoamHold()
      }, 400)
    }, ms)
  }
  /**
   * 气泡跟语音对齐：回复先显示，等 TTS 真正念完再淡出。
   * 旧行为是 done 之后固定 8s 淡出 → 长回复「话没说完气泡先没了」。
   */
  async function bubbleHoldVoice (content, opts) {
    const my = ++bubbleSeq
    clearTimeout(bubbleTimer)
    if (readReply && content) {
      try { await speakReplyText(content, opts) } catch {}
    }
    if (my !== bubbleSeq) return // 期间用户又发了新一轮 → 让新一轮接管气泡
    bubbleKeep(1800) // 语音结束（或没有语音）后留 1.8s 收尾
  }

  const show = () => {
    if (!petInputBubble) return // 设置里关掉悬停输入条
    clearTimeout(hideTimer)
    panel.hidden = false
    // 悬停/输入中 → 暂停自主走动
    holdPanel = true
    syncRoamHold()
    // 面板贴角色正下方，强制夹在屏内（角色拖到边缘时也不会跑出屏幕）
    requestAnimationFrame(positionChat)
    // v0.4.7 闪红修复：这里绝不能 petChatFocus(true)！后台进程自动 focus() 会被
    // Windows 拒绝 → 任务栏按钮闪橙红（每次悬停角色都触发 = 「一直弹红」）。
    // 改为用户点击输入框时再放开键盘焦点（用户手势触发的前台切换会被放行）
  }
  // 键盘焦点只随用户手势而来：点输入框才需要真正的系统焦点
  input.addEventListener('pointerdown', () => {
    try { window.aura.petChatFocus(true) } catch {}
  })
  const maybeHide = () => {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (document.activeElement !== input && !mic.classList.contains('on')) {
        panel.hidden = true
        holdPanel = false
        syncRoamHold()
        try { window.aura.petChatFocus(false) } catch {}
      }
    }, 1800)
  }
  stage.addEventListener('pointerenter', show)
  stage.addEventListener('pointerleave', maybeHide)
  panel.addEventListener('pointerenter', show)
  panel.addEventListener('pointerleave', maybeHide)
  // 0.45.29 光标离开热区（主进程 poll 翻回穿透）：穿透窗口收不到 pointerleave，
  // 输入条会永远挂着（用户报的「不悬停也一直存在」）——靠这条通知收起
  if (window.aura.onHotLost) window.aura.onHotLost(() => { maybeHide() })

  // ⚙ = 打开 Partner.execute(me); 主界面（完整聊天 + 角色/形象/语音都在同一个窗口里）
  const manageBtn = $('petManageBtn')
  if (manageBtn) manageBtn.addEventListener('click', () => { panel.hidden = true; holdPanel = false; syncRoamHold(); try { window.aura.openAssistant() } catch {} })

  const send = () => {
    const t = input.value.trim()
    if (!t || generating) return
    input.value = ''
    input.style.height = 'auto'
    generating = true
    // 发送新消息即打断正在播的语音（对齐参考 _cancelSpeechPlayback）
    stopVoice()
    // 回复只走角色头顶的气泡（桌面不放缩小版聊天框）
    bubbleShow('…')
    window.aura.petChatSend(t)
  }
  sendBtn.addEventListener('click', send)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
  input.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(72, this.scrollHeight) + 'px' })

  /* ---- 助手核心联动：对话统一由 assistant:* 回流到头顶气泡 ---- */
  if (window.aura.onAssistantDelta) {
    let asstSeq = null
    window.aura.onAssistantDelta(({ seq, text, reset }) => {
      if (reset || seq !== asstSeq) {
        asstSeq = seq
        statusSet('think')
        bubbleShow(String(text || '') || '…')
        return
      }
      bubbleShow((bubble.textContent === '…' ? '' : bubble.textContent) + text)
    })
    // 工具调用 → 状态气泡按 kind 显示（不再直接贴工具名）
    window.aura.onAssistantTool(({ name }) => {
      statusSet(TOOL_KIND[name] || 'work', name)
    })
    window.aura.onAssistantDone(({ content, display, external }) => {
      // 主动台词（看屏陪伴/时间观念/闹钟）已经由 pet_say 播过气泡与朗读，
      // 这里再渲染一遍就是同一句话念两次（双声道）——只让聊天窗记账
      if (external) return
      generating = false
      statusClear()
      // 台词（content，日语等）用于朗读；字幕（display，如中文）用于气泡显示
      const line = String(content || '')
      const txt = display || line || '（空回复）'
      bubbleShow(txt)
      // 会说话的伙伴：回复朗读 + 气泡跟着语音走（念完才淡出）
      // 0.46.56 朗读只由角色所在屏发起：两块屏都跑这段 = 合成双跑 + 竞速输家抢念系统嗓
      //（真机实锤：10:44/10:46/10:47/10:50 每条回复 fish key 连打两次，一次被 abort）
      if (petHosted) bubbleHoldVoice(line || txt)
    })
    window.aura.onAssistantError(({ message }) => {
      generating = false
      statusClear()
      const msg = '⚠ ' + String(message || '出错了').replace(/\s+/g, ' ').slice(0, 140)
      bubbleShow(msg)
      bubbleKeep()
    })
  }

  /* ---------------- S3：模型主动提问（pet_ask） ---------------- */
  const askEl = $('petAsk')
  const askQ = $('petAskQ')
  const askOpts = $('petAskOpts')
  const askOwn = $('petAskOwn')
  const askInput = $('petAskInput')
  const askOk = $('petAskOk')
  let askId = null

  positionAsk = function positionAsk () {
    if (!askEl || askEl.hidden) return
    const r = stage.getBoundingClientRect()
    const w = askEl.offsetWidth || 300
    const h = askEl.offsetHeight || 96
    let x = r.left + r.width / 2 - w / 2
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x))
    let y = r.top - h - 10
    if (y < 8) y = Math.min(window.innerHeight - h - 8, r.bottom + 10)
    askEl.style.left = Math.round(x) + 'px'
    askEl.style.top = Math.round(y) + 'px'
  }

  function askClose () {
    if (!askEl) return
    askEl.hidden = true
    askEl.classList.remove('fading')
    askId = null
    if (askInput) askInput.value = ''
    holdAsk = false
    syncRoamHold()
    try { window.aura.petChatFocus(false) } catch {}
  }

  /** 回答提问：回报给主进程（工具调用在那边等着），然后收起气泡 */
  function askReply (text) {
    const id = askId
    const answer = String(text || '').trim()
    if (!id || !answer) return
    askClose()
    try { window.aura.petAskAnswer({ id, answer }) } catch {}
  }

  function askShow (cmd) {
    if (!askEl) return
    askId = cmd.id
    askQ.textContent = cmd.question || ''
    askOpts.replaceChildren()
    for (const opt of (cmd.options || [])) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'petask-opt'
      b.textContent = String(opt)
      b.addEventListener('click', () => askReply(opt))
      askOpts.appendChild(b)
    }
    askOwn.hidden = cmd.allowOwnAnswer === false
    askInput.value = ''
    askEl.hidden = false
    askEl.classList.remove('fading')
    holdAsk = true
    syncRoamHold()
    statusSet('ask')
    // 提问期间不显示回复气泡，避免两层叠在一起
    clearTimeout(bubbleTimer)
    bubble.hidden = true
    holdBubble = false
    requestAnimationFrame(positionAsk)
  }

  if (askOk) askOk.addEventListener('click', () => askReply(askInput && askInput.value))
  if (askInput) {
    askInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); askReply(askInput.value) }
    })
    // 键盘焦点只随用户手势而来（后台 focus 会被 Windows 拒绝 → 任务栏闪红）
    askInput.addEventListener('pointerdown', () => { try { window.aura.petChatFocus(true) } catch {} })
  }

  /* ---------------- S3：模型控制伙伴（pet_say / pet_act / pet_quiet） ---------------- */
  if (window.aura.onPetCmd) {
    window.aura.onPetCmd(async (cmd) => {
      if (!cmd || !cmd.kind) return
      if (!petHosted) return // 只由角色所在的那块屏执行，否则两块屏各说一遍
      switch (cmd.kind) {
        case 'say': {
          curSaySeq = Number(cmd.seq) || 0   // 0.46.77 记序号：播完时回传，等播完用
          if (askId) askClose() // 新说话会顶掉还没回答的提问（与主进程一致）
          if (cmd.lead && cmd.lead.length) await playActions(cmd.lead)
          // dm=true：这句话已经由弹幕层显示（游戏模式），气泡就不再冒出来挡画面
          if (cmd.text && !cmd.dm) {
            bubbleShow(cmd.text)
            // 0.46.11 cmd.vol：自言自语的嘀咕音量（正常对话没有 vol = 正常音量）
            const volOpts = cmd.vol != null ? { vol: cmd.vol } : undefined
            if (cmd.speak === false) bubbleKeep(Math.max(2500, Math.min(9000, cmd.text.length * 200)))
            else bubbleHoldVoice(cmd.text, volOpts)
          }
          if (cmd.inline && cmd.inline.length) playActions(cmd.inline)
          break
        }
        case 'ask': askShow(cmd); break
        // 主动台词的字幕补丁：朗读已经在念原文，这里只把气泡文字换成译文
        case 'say-sub': {
          if (!cmd.text || bubble.hidden) break
          lastBubbleText = String(cmd.text)
          bubble.textContent = String(cmd.text)
          requestAnimationFrame(positionBubble)
          break
        }
        case 'ask-dismiss': if (!cmd.id || cmd.id === askId) askClose(); break
        case 'act': playActions(cmd.actions); break
        // 0.18.0 第二批：全局热键
        //   打字键 → 把悬停输入条叫出来并聚焦（用户按了热键，属于用户手势，允许抢焦点）
        //   说话键 → 等同点一下麦克风按钮（按一下开始听，再按一下结束；Electron 拿不到 keyup）
        case 'open-input': {
          const pnl = $('petChat')
          const inp = $('petChatInput')
          if (pnl && inp) {
            pnl.hidden = false
            holdPanel = true
            syncRoamHold()
            try { window.aura.petChatFocus(true) } catch {}
            requestAnimationFrame(positionChat)
            setTimeout(() => { try { inp.focus(); inp.select() } catch {} }, 40)
          }
          break
        }
        case 'mic-toggle': {
          const pnl = $('petChat')
          if (pnl) { pnl.hidden = false; requestAnimationFrame(positionChat) }
          const m = $('petMic')
          if (m) m.click()
          break
        }
        // 0.18.0 第二批 · 动作清单 / 预览：骨架里的动画名只有渲染层知道，回报给主进程
        case 'anim-list': {
          try {
            const st = await window.aura.petState()
            const charId = st && st.char ? st.char.id : ''
            // 0.45.90 附中文标签：反查动画目录（哪个组用到这条动画）
            const cat = window.SPINE_GROUP_CATALOG || {}
            const zhOf = (name) => {
              for (const sk of Object.keys(cat)) {
                for (const g of Object.values(cat[sk])) {
                  if (g.anims && g.anims.includes(name)) return g.zh
                }
              }
              return ''
            }
            const list = spineAnimCtx && spineAnimCtx.anims
              ? spineAnimCtx.anims.map((a) => ({ name: a.name, duration: Number(a.duration || 0), zh: zhOf(a.name) }))
              : []
            if (window.aura.petAnimReport) window.aura.petAnimReport({ charId, list })
          } catch (e) { console.warn('[pet] anim-list 失败', e && e.message) }
          break
        }
        case 'anim-play': {
          const name = String(cmd.name || '')
          if (!name || !spineAnimCtx || !spineAnimCtx.state) break
          // 0.45.90 统一走分轨播放器（叠加层不再硬塞轨道 0）
          if (!playSpineAction([name])) console.warn('[pet] anim-play 失败', name)
          break
        }
        case 'quiet':
          // 主进程到点会再发一次 on:false；这里只记「安静中」并立刻闭嘴
          quietUntil = cmd.on ? Date.now() + 24 * 3600 * 1000 : 0
          if (cmd.on) { stopVoice(); statusSet('quiet') } else statusClear()
          break
      }
    })
  }

  /* ---- S2 触摸语义：拎起 / 放下 / 甩出去 / 撞到屏边 → 各有一句反应（按类型节流） ---- */
  const touchAt = {}
  if (window.aura.onPetTouch) {
    window.aura.onPetTouch(({ kind, part }) => {
      if (!kind) return
      fx('touch')
      if (petPaused) return // 暂停时只留触感音，不触发台词/动作
      /* 0.24.0 手机远程点摸：桌面角色当场播反应动作（手机流里直接可见）；
         动作不锁 petHosted（角色画在哪块屏哪块屏要动），反应语仍只由宿主屏出声 */
      if (kind === 'tap' && part) {
        const lastTap = touchAt['tap:' + part] || 0
        if (Date.now() - lastTap < 2000) return
        touchAt['tap:' + part] = Date.now()
        playTouchMotion(part)
        if (petHosted) speakTouch(part)
        return
      }
      if (!petHosted) return // 拎起/放下/甩出/撞边都是全局广播，非宿主屏不许出声
      // 拖动很频繁：同一类反应 6 秒内只说一次，避免拎来拎去一路碎碎念
      const last = touchAt[kind] || 0
      if (Date.now() - last < 6000) return
      touchAt[kind] = Date.now()
      speakTouch(kind)
    })
  }
  /* ---- S2 走动：主进程按档位自己溜达 ----
   * 0.26.0：形象包交给渲染器做步态（腿交替/前倾/上下颠），舞台不再整体上下浮 */
  if (window.aura.onPetWalk) {
    window.aura.onPetWalk(({ on, dir, speed }) => {
      const s = $('petStage')
      if (s) s.classList.toggle('is-walking', !!on)
      walkState.on = !!on
      if (dir === 1 || dir === -1) walkState.dir = dir
      if (figureLoop && typeof figureLoop.setWalk === 'function') figureLoop.setWalk(!!on, dir, speed)
      // 3D 模型：有走路片段就交叉淡入，没有就用 humanoid 骨骼程序化摆腿（0.27.0）
      if (vrmRuntime && typeof vrmRuntime.setWalk === 'function') {
        if (on) { vrmRuntime.setPose('stand'); actSit = false } // 0.45.35 走路打断 pet_act 持续坐
        vrmRuntime.setWalk(!!on, dir, speed)
        // 0.45.45 诊断：每次起走记一笔步态来源（VRMA 接管了没有，一眼可查）
        if (on) {
          petDiag('起走 dir=' + dir + ' speed=' + (speed || '?') + ' vrma步态=' + (vrmRuntime.walkMotionReady ? '已就绪' : '未就绪(程序化兜底)'))
          // 0.45.47 起走 1.2s 后实测骨骼有没有真的转起来（离线模拟正常但真机帧=绑定点姿）
          setTimeout(() => {
            try {
              if (vrmRuntime && typeof vrmRuntime.walkDebug === 'function') {
                vrmRuntime.walkDebug().then((r) => petDiag('walk-debug ' + JSON.stringify(r))).catch(() => { })
              }
            } catch { }
          }, 1200)
        }
      }
      if (on) fx('move')
    })
  }
  /* 0.29.0 卡片联动：主进程让角色坐下（坐到 AuraDesk 的卡片上）/ 站起来 */
  if (window.aura.onPetPose) {
    window.aura.onPetPose(({ pose, style }) => {
      if (vrmRuntime && typeof vrmRuntime.setPose === 'function') vrmRuntime.setPose(pose, style)
      const wantSit = pose === 'sit'
      actSit = wantSit // 0.45.35 主进程的坐/站广播与 pet_act 持续坐共用一个状态
      // 0.45.90 spine：坐下=整个骨架切坐姿版（含拍手/比耶等富动作），起身切回
      applySpineSkelMode(wantSit ? 'sit' : 'stand')
    })
  }
  window.addEventListener('resize', () => { requestAnimationFrame(() => { positionChat(); positionBubble() }) })

  /* ---- 语音捕捉：开了就持续捕捉（VAD 断句 → 识别 → 直接发送） ----
   * 2.3 收音三模式：always=常驻倾听（原行为）/ toggle=点击开·再点关 / hold=按住说·松手识别
   * 2.4 打断：她正在说话（TTS 播放中）时你开口 → 立刻停她的语音与生成，听你说（半双工兜底） */
  let on = false
  let stream = null
  let analyser = null
  let audioCtx = null
  let vadTimer = null
  let recorder = null
  let chunks = []
  let speaking = false
  let silenceSince = 0
  // 0.48.0 声纹：录音期间同源攒 16k PCM（ScriptProcessor 连续采，与 webm 同一 speaking 括号）
  let vpProcessor = null
  let vpSink = null
  let vpPcm = []
  // 按住说话：press 的时刻（0=没按着）。按住期间不按静音自动发，松手才发一条
  let holdAt = 0
  const KEY = 'auraPetMicOn'
  const KEY_MODE = 'auraPetMicMode'
  let micMode = localStorage.getItem(KEY_MODE) || 'always'
  let interruptOn = false

  const blobToB64 = (blob) => new Promise((ok, bad) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result).split(',')[1] || '')
    r.onerror = () => bad(new Error('read 失败'))
    r.readAsDataURL(blob)
  })

  async function flushRecording () {
    const rec = recorder
    recorder = null
    speaking = false
    // 0.48.0 声纹：把这段录音同源的 16k PCM 带给主进程（只算嵌入，不落盘不出网）
    const pcmB64 = vpTakePcm()
    if (!rec || rec.state === 'inactive') return
    await new Promise((ok) => { rec.onstop = ok; rec.stop() })
    const blob = new Blob(chunks, { type: 'audio/webm' })
    chunks = []
    if (blob.size < 2000) return // 太短，视为噪声
    try {
      const b64 = await blobToB64(blob)
      // 录音刚结束就要给反馈：本地 whisper 冷启动要 2~4 秒，什么都不显示会被当成卡死
      bubbleShow('… 听到了，正在识别')
      bubbleKeep(20000)
      const r = await window.aura.petTranscribe(b64, 'audio/webm', pcmB64)
      if (r && r.ok && r.text) {
        // 0.38.0 识别结果过滤：常开麦会对着静音/空调声断句，出来的「嗯。」「그.」
        // 直接进对话就是她莫名其妙回一句。只拦明显不对的，不猜内容。
        const verdict = window.speechFilter ? window.speechFilter.looksLikeSpeech(r.text) : { ok: true, text: r.text }
        if (!verdict.ok) {
          bubbleShow('没听清，再说一遍？')
          bubbleKeep(3000)
          return
        }
        // 0.48.0 声纹结果：诚实显示「是谁在说」，主人一眼可见（不拦话——判错宁可漏不误）
        if (r.enrolled && r.samples >= 3) bubbleShow('✓ 声纹注册完成（3 段样本）')
        else if (r.enrolled) bubbleShow('✓ 声纹样本已收下（' + r.samples + '/3）')
        else if (r.speaker === 'owner') bubbleShow('✓ 他的声音（' + Number(r.sim).toFixed(2) + '）')
        else if (r.speaker === 'maybe') bubbleShow('? 像是他的声音（' + Number(r.sim).toFixed(2) + '）')
        else if (r.speaker === 'other') bubbleShow('⚠ 不是他的声音（' + Number(r.sim).toFixed(2) + '）')
        if (r.speaker) {
          bubbleKeep(1500)
          setTimeout(() => { try { bubbleShow('…'); bubbleKeep(20000) } catch { } }, 1500)
        }
        generating = true
        if (!r.speaker) bubbleShow('…')
        window.aura.petChatSend(verdict.text || r.text)
      } else if (r && r.ok) {
        // 识别通了但没文字：多半是太轻/太短/纯噪音，别静默吞掉
        bubbleShow('没听清，再说一遍？')
        bubbleKeep(4000)
      } else if (r && r.message && !/未知|empty/i.test(r.message)) {
        bubbleShow('⚠ 语音识别失败：' + r.message)
        bubbleKeep(8000)
      }
    } catch (e) { bubbleShow('⚠ 语音识别异常: ' + e.message); bubbleKeep(8000) }
  }

  function startVad () {
    const buf = new Uint8Array(analyser.fftSize)
    vadTimer = setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
      const rms = Math.sqrt(sum / buf.length)
      const now = Date.now()
      hearTick(rms)
      // 2.4 打断：她正在出声、你也开口 → 停她的语音 + 停生成（用户优先）
      if (rms > 0.045 && interruptOn) {
        const sheIsTalking = (typeof nowPlaying !== 'undefined' && nowPlaying) ||
          (window.speechSynthesis && window.speechSynthesis.speaking)
        if (sheIsTalking) {
          stopVoice()
          if (window.aura && window.aura.petChatStop) { try { window.aura.petChatStop() } catch { } }
        }
      }
      if (rms > 0.045) {
        if (!speaking) {
          speaking = true
          chunks = []
          try {
            recorder = new MediaRecorder(stream)
            recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
            recorder.start()
          } catch { recorder = null; speaking = false }
        }
        silenceSince = now
      } else if (speaking && now - silenceSince > 900 && micMode !== 'hold') {
        // 900ms 静音就收尾（原来 1400ms）：识别本身 ~1.3s，再加上 1.4s 的等待，
        // 用户会觉得「说完了还要愣两秒」。900ms 仍能容忍句中的自然停顿。
        flushRecording()
      } else if (micMode === 'hold' && holdAt && now - holdAt > 45000) {
        // 0.38.0 按住说话：一次按住=一条消息。之前这里 900ms 静音就发一条，
        // 按住说三句、中间喘口气 → 变成三条独立消息（参考项目 1.5.2 修过同一个坑）。
        // 按住超过 45 秒强收一次，避免一直按着把内存里的音频攒爆。
        holdAt = now
        flushRecording()
      }
    }, 120)
  }

  /* ---- 0.46.54 听觉：她自己的耳朵 ----
   * 她要的不是听懂字（那是 whisper 的活），是听见声：响度、频段构成、动静节奏。
   * 不录音、不转写：音频数据不出渲染层，每 8 拍（≈1s）只把一条特征摘要
   * （响度均值/低中高频段占比/起伏次数，几十字节数字）发给主进程 hear.js 聚合。
   * 两条流：语音捕捉开着 → 复用它的 analyser（一次采集两用）；语音麦没开 →
   * 听觉自己开一条轻量流（hearOn 开着才有耳朵；关着不开流、Windows 不亮麦指示灯）。 */
  let hearAcc = null
  function hearReset () { hearAcc = { n: 0, fN: 0, rms: 0, low: 0, mid: 0, high: 0, onsets: 0, prevRms: 0 } }
  function hearSampleFrom (an, ctx, rms) {
    if (!hearAcc) hearReset()
    const a = hearAcc
    a.rms += rms
    // 起伏（onset）：比上一拍明显变响——音乐节拍、敲键盘、东西掉地上的「事件感」
    if (a.prevRms > 0.02 && rms > a.prevRms * 1.7 && rms > 0.04) a.onsets++
    a.prevRms = rms
    // 频段每 4 拍算一次就够，省 CPU
    if (a.n % 4 === 0 && an && ctx) {
      try {
        const freq = new Uint8Array(an.frequencyBinCount)
        an.getByteFrequencyData(freq)
        const hz = ctx.sampleRate / an.fftSize
        let low = 0; let lowN = 0; let mid = 0; let midN = 0; let high = 0; let highN = 0
        for (let i = 0; i < freq.length; i++) {
          const f = i * hz
          const v = freq[i] / 255
          if (f < 300) { low += v; lowN++ } else if (f < 2000) { mid += v; midN++ } else if (f < 8000) { high += v; highN++ }
        }
        if (lowN) a.low += low / lowN
        if (midN) a.mid += mid / midN
        if (highN) a.high += high / highN
        a.fN++
      } catch { }
    }
    a.n++
    if (a.n >= 8 && window.aura && window.aura.hearSample) {
      const fN = a.fN || 1
      try {
        window.aura.hearSample({
          t: Date.now(), rms: a.rms / a.n,
          low: a.low / fN, mid: a.mid / fN, high: a.high / fN,
          onsets: a.onsets, src: hearSrcTag || 'mic'
        })
      } catch { }
      hearReset()
    }
  }
  // 语音麦的 VAD tick（120ms）路径
  function hearTick (rms) { if (analyser && audioCtx) hearSampleFrom(analyser, audioCtx, rms) }

  /* ---- 0.48.0 声纹 PCM 采集 ----
   * VAD 的 120ms 快照只有 fftSize≈21ms 的音频（缺 8 成），不能当声纹素材；
   * ScriptProcessor 是连续回调，采到的流和 MediaRecorder 同一 speaking 括号、天然对齐。
   * 16k Int16 base64 只算嵌入用：主进程内存瞬时算完即弃，不落盘不出网。
   * （hear 的红线「音频不出渲染层」指特征听感通道；声纹通道是主人 11-09 拍板的
   *   认人能力，音频不落盘不出网但进主进程内存——措辞已在导读更新。） */
  function vpAttach () {
    if (!audioCtx || !analyser || vpProcessor) return
    try {
      vpProcessor = audioCtx.createScriptProcessor(4096, 1, 1)
      vpProcessor.onaudioprocess = (e) => {
        if (speaking) vpPcm.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      analyser.connect(vpProcessor)
      vpSink = audioCtx.createGain()
      vpSink.gain.value = 0 // 不出声，只让回调跑起来
      vpProcessor.connect(vpSink)
      vpSink.connect(audioCtx.destination)
    } catch (e) {
      vpProcessor = null
      try { window.aura.reportError('voiceprint', 'PCM 采集挂载失败：' + (e.message || e.name), '') } catch { }
    }
  }
  function vpDetach () {
    if (vpProcessor) { try { vpProcessor.disconnect() } catch { } vpProcessor.onaudioprocess = null; vpProcessor = null }
    if (vpSink) { try { vpSink.disconnect() } catch { } vpSink = null }
    vpPcm = []
  }
  /** 攒到的原始 PCM → 16k Int16 base64（主进程再转 Float32 喂引擎） */
  function vpTakePcm () {
    if (!vpPcm.length || !audioCtx) { vpPcm = []; return '' }
    const sr = audioCtx.sampleRate
    let total = 0
    for (const c of vpPcm) total += c.length
    const raw = new Float32Array(total)
    let o = 0
    for (const c of vpPcm) { raw.set(c, o); o += c.length }
    vpPcm = []
    // 线性重采样到 16k
    const n = Math.max(1, Math.floor(raw.length * 16000 / sr))
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const p = i * (raw.length - 1) / Math.max(1, n - 1)
      const i0 = Math.floor(p)
      const i1 = Math.min(raw.length - 1, i0 + 1)
      out[i] = raw[i0] + (raw[i1] - raw[i0]) * (p - i0)
    }
    // Float32 → Int16
    const i16 = new Int16Array(n)
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, out[i]))
      i16[i] = v < 0 ? v * 0x8000 : v * 0x7fff
    }
    const bytes = new Uint8Array(i16.buffer)
    let s = ''
    const CH = 0x8000
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
    return btoa(s)
  }

  /* 听觉流管理：
   * auto（默认）= 先麦（她听房间——外放的歌、键盘、说话都走空气声），麦失败自动退到
   *   系统回环（她听电脑自己发出的声音——主人戴耳机放歌/本机没麦时这是唯一的耳朵）；
   * mic=只听麦；sys=只听回环（hearSource 配置，改后重启生效）。
   * 不录音、不转写；失败留痕 + 5 分钟退避，绝不静默装听。 */
  let hearStream = null
  let hearCtx = null
  let hearAn = null
  let hearTimer = null
  let hearFailAt = 0
  let hearSrcTag = ''
  async function hearOpenStream (get, srcTag) {
    try {
      hearStream = await get()
      hearCtx = new AudioContext()
      hearAn = hearCtx.createAnalyser()
      hearAn.fftSize = 1024
      hearCtx.createMediaStreamSource(hearStream).connect(hearAn)
      hearSrcTag = srcTag
      const hb = new Uint8Array(hearAn.fftSize)
      hearTimer = setInterval(() => {
        if (!hearAn || !hearCtx) return
        hearAn.getByteTimeDomainData(hb)
        let sum = 0
        for (let i = 0; i < hb.length; i++) { const v = (hb[i] - 128) / 128; sum += v * v }
        hearSampleFrom(hearAn, hearCtx, Math.sqrt(sum / hb.length))
      }, 1000)
      // 留痕：真机日志能看见耳朵何时竖起、竖的是哪只（失败也留痕）
      try {
        window.aura.reportError('hear', '听觉流已开（src=' + srcTag +
          (srcTag === 'sys' ? '，系统声兜底：她听的是电脑自己发出的声音' : '，麦克风：她听的是房间里的声音') +
          '；只提特征不录音）', '')
      } catch { }
      return true
    } catch (e) {
      hearFailAt = Date.now()
      hearStream = null
      try { window.aura.reportError('hear', '听觉流失败(src=' + srcTag + ')：' + (e.message || e.name) + '（5 分钟后重试）', '') } catch { }
      return false
    }
  }
  async function hearMicEnsure () {
    if (!petHosted || on || hearStream) return
    if (Date.now() - hearFailAt < 5 * 60 * 1000) return // 刚失败过（没麦/没权限）别疯狂敲
    let st = { on: false }
    try { st = (window.aura && window.aura.hearState) ? await window.aura.hearState() : { on: false } } catch { }
    if (!st || st.on !== true) return
    const src = st.source || 'auto'
    if (src !== 'sys') {
      // 先试麦克风（空气声）
      if (await hearOpenStream(() => navigator.mediaDevices.getUserMedia({ audio: true }), 'mic')) return
      if (src === 'mic') return // 明确只要麦：失败就如实闭耳，不偷偷换耳朵
    }
    // 系统回环：戴耳机放歌/没麦时听「电脑自己在响什么」。
    // 注意 video 轨别停——Windows 回环停掉视频轨可能连音频一起断，留着不渲染即可。
    await hearOpenStream(async () => {
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      if (!ds.getAudioTracks().length) { ds.getTracks().forEach((t) => t.stop()); throw new Error('系统没给音频轨') }
      return ds
    }, 'sys')
  }
  function hearMicStop () {
    if (hearTimer) { clearInterval(hearTimer); hearTimer = null }
    if (hearStream) hearStream.getTracks().forEach((t) => t.stop())
    hearStream = null
    if (hearCtx) { try { hearCtx.close() } catch {} }
    hearCtx = null
    hearAn = null
    hearSrcTag = ''
    hearAcc = null
  }

  async function micOn () {
    // 麦只能由角色所在屏持有：两块屏同时录 → 同一句话识别两次、发两遍、回两段
    if (!petHosted || on) return
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioCtx = new AudioContext()
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 1024
      audioCtx.createMediaStreamSource(stream).connect(analyser)
      vpAttach() // 0.48.0 声纹 PCM 采集挂上
      on = true
      mic.classList.add('on')
      show()
      startVad()
      hearReset()
      hearMicStop() // 语音麦接管：听觉复用它的 analyser，轻量流让位（避免双流）
    } catch (e) {
      bubbleShow('⚠ 麦克风不可用: ' + (e.message || e.name))
      bubbleKeep()
      on = false
    }
  }
  function micOff () {
    on = false
    mic.classList.remove('on')
    clearInterval(vadTimer)
    vadTimer = null
    hearMicEnsure() // 语音麦让位：听觉换回自己的轻量流（hearOn 开着才有）
    if (recorder && recorder.state === 'recording') { try { recorder.stop() } catch {} }
    recorder = null
    speaking = false
    vpDetach() // 0.48.0 声纹采集摘除
    if (stream) stream.getTracks().forEach((t) => t.stop())
    stream = null
    if (audioCtx) { try { audioCtx.close() } catch {} }
    audioCtx = null
  }
  /* 麦克风：用户意图（micDesired）与「当前是否真在录」（on）分开——
   * 角色被拖到别的屏时，旧屏关麦、新屏接管，但用户的开麦设置保持不变。
   * 2.3：toggle/hold 模式不自动开麦（开麦只由显式交互触发）。 */
  let micDesired = localStorage.getItem(KEY) === '1'
  function applyMic () {
    if (micMode !== 'always') { if (!micDesired && on) micOff(); return }
    if (micDesired && petHosted && !on) micOn()
    else if ((!micDesired || !petHosted) && on) micOff()
  }
  hostHooks.push(applyMic)
  mic.addEventListener('click', () => {
    if (micMode === 'toggle') {
      if (!on) { micDesired = true; micOn() }
      else { micDesired = false; flushRecording(); micOff() }
      return
    }
    micDesired = !on
    localStorage.setItem(KEY, micDesired ? '1' : '0')
    applyMic()
  })
  // hold：按住说，松手识别（press 期间 VAD 起作用，松手立刻收尾）
  mic.addEventListener('pointerdown', () => {
    if (micMode === 'hold' && !on && petHosted) { micDesired = true; holdAt = Date.now(); micOn() }
  })
  window.addEventListener('pointerup', () => {
    if (micMode === 'hold' && on) { micDesired = false; holdAt = 0; flushRecording(); micOff() }
  })
  // 上次开着 → 默认继续捕捉（等宿主确定后再开，避免非宿主屏抢麦；仅常驻模式）
  if (micDesired && micMode === 'always') setTimeout(applyMic, 1500)
  // 0.46.54 听觉轻量流：宿主定了就问主进程 hearOn，开着就竖耳朵（换屏时跟着走）
  hostHooks.push(() => { if (!petHosted) hearMicStop(); else setTimeout(hearMicEnsure, 800) })
  setTimeout(hearMicEnsure, 3000)
  // bubble/keep 必须一起交出去：菜单和悬浮条的提示要复用同一套气泡逻辑，
  // 以前那边直接调 bubbleShow()，那是 setupChat 的局部函数 → ReferenceError（点音效/暂停就炸）
  return { hide: () => { panel.hidden = true; holdPanel = false; syncRoamHold() }, show, bubble: bubbleShow, keep: bubbleKeep }
}
/* ---------------- 0.18.0 第一批：右键菜单（暂停/继续、打字、设置、主题、音效、装扮、隐藏） ---------------- */
function setupMenu (chat) {
  const menu = $('petMenu')
  const stage = $('petStage')
  if (!menu || !stage) return
  const syncPauseLabel = () => {
    const b = $('petMenuPause')
    if (b) b.textContent = petPaused ? '▶ 继续' : '⏸ 暂停'
  }
  const close = () => { menu.hidden = true }
  stage.addEventListener('contextmenu', (e) => {
    if (!petHosted) return
    e.preventDefault()
    e.stopPropagation()
    syncPauseLabel()
    menu.hidden = false
    const mw = menu.offsetWidth || 150
    const mh = menu.offsetHeight || 240
    let x = e.clientX + 2
    let y = e.clientY + 2
    x = Math.max(8, Math.min(window.innerWidth - mw - 8, x))
    if (y + mh > window.innerHeight - 8) y = Math.max(8, window.innerHeight - mh - 8)
    menu.style.left = Math.round(x) + 'px'
    menu.style.top = Math.round(y) + 'px'
    fx('ui')
  })
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('.petmenu-item')
    if (!btn) return
    const act = btn.dataset.pmact
    close()
    if (act === 'pause') {
      petPaused = !petPaused
      syncPauseLabel()
      try { window.aura.petSetPaused(petPaused) } catch { }
      chat?.bubble(petPaused ? '⏸ 先歇一会儿' : '▶ 我回来啦')
      chat?.keep(1800)
    } else if (act === 'chat') {
      if (petInputBubble) chat.show()
      else { try { window.aura.openAssistant() } catch { } }
    } else if (act === 'settings') {
      try { window.aura.openAssistant() } catch { }
    } else if (act === 'theme') {
      const next = document.body.dataset.petTheme === 'light' ? 'dark' : 'light'
      document.body.dataset.petTheme = next
      try { window.aura.petCfgPatch({ petTheme: next }) } catch { }
    } else if (act === 'sound') {
      try { window.aura.petCfgPatch({ petSound: !petSound }) } catch { }
      chat?.bubble(petSound ? '🔊 音效已关' : '🔊 音效已开')
      chat?.keep(1800)
    } else if (act === 'dress') {
      try {
        if (window.aura.figureOpenDress) window.aura.figureOpenDress()
      } catch { }
    } else if (act === 'hide') {
      try { window.aura.petHide() } catch { }
    }
  })
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) close() }, true)
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
  window.addEventListener('pet-menu-hide', close)
  hostHooks.push(() => close())
  syncPauseLabel()
}

/* ---------------- 5.5 悬停按钮（0.45.29 移除） ----------------
 * 主人的原话：「这个直接删了吧，没必要」。桌面留白比一排按钮重要，
 * 全部动作保留在右键菜单（petMenu）里。setupHover 整套机制随之拆除。 */

/* ---------------- 位置（v0.3.2 跨屏拖拽）----------------
 * 角色锚点（stage 底边中点）改用全局屏幕坐标（DIP），由主进程统一管理：
 * 拖动时渲染层流式上报 pet:drag-move → 主进程夹回虚拟桌面并广播 pet:pos
 * → 每个 overlay 把全局坐标换算成本窗 right/bottom；只有包含锚点的屏显示角色，
 * 拖过屏幕边界即无缝「搬家」。松手 pet:drag-end 落盘，重启后位置保留。 */
let petGlobal = null // 全局锚点 { x, y }（DIP）
let petHostHint = null // 0.46.45 主进程随 pet:pos 下发的宿主屏 bounds（锚点出屏时兜底接管用）
/* 本窗口是否真正"住着"角色。每块屏都是一个 overlay 窗口、都收到同一条 assistant:done，
 * 旧代码每个窗口都去合成并播放语音 → 双声道/两重回声，气泡也是两块屏各画一个。
 * 只有包含锚点的那块屏算宿主，显示 + 朗读都只由宿主执行。 */
let petHosted = false
let petDragWasActive = false // 上一帧是否在拖拽：用于松手时结算一次宿主资源（麦克风）
let lastPetPosAt = 0 // 最近一次收到 pet:pos 的时间（拖拽标记的看门狗）
const hostHooks = [] // 宿主切换回调：麦克风这类全局独占资源要跟着宿主走
let stageSize = { w: 300, h: 520 } // 最近一次实测的 stage 尺寸（hidden 时 offsetWidth=0，用缓存）

function applyPos (right, bottom) {
  document.documentElement.style.setProperty('--pet-right', right + 'px')
  document.documentElement.style.setProperty('--pet-bottom', bottom + 'px')
}

function measureStage () {
  const el = $('petStage')
  if (el && !el.hidden && el.offsetWidth > 0) stageSize = { w: el.offsetWidth, h: el.offsetHeight }
}

/** 全局坐标 → 本窗 right/bottom；锚点不在本屏时隐藏 stage（跨屏搬家）。
 * v0.4.2 主驱拖拽后渲染层不再持有指针捕获，隐藏随时安全。 */
function applyGlobalPos () {
  const el = $('petStage')
  if (!el || !petGlobal) return
  const wx = window.screenX, wy = window.screenY
  const inX = petGlobal.x >= wx - 2 && petGlobal.x <= wx + window.innerWidth + 2
  const inY = petGlobal.y >= wy - 2 && petGlobal.y <= wy + window.innerHeight + 2
  // 0.46.45 锚点纵向出屏（坐在贴屏底的卡片上，坐姿锚点=舞台底边会落到屏外，
  // 11-04 17:42/17:54 两次实锤整只消失）：原判定 inX&&inY 两屏都不接管 → 隐身。
  // 主进程随 pet:pos 下发最近屏提示 hostBounds；本窗就是提示屏时照常接管，
  // stage 超出窗口的部分自然裁剪（与跨屏拖拽的裁剪语义一致）。无提示保持原判定。
  const hostIsMe = !!petHostHint && Math.abs(petHostHint.x - wx) <= 2 && Math.abs(petHostHint.y - wy) <= 2
  const inside = petHostHint ? (hostIsMe || (inX && inY)) : (inX && inY)
  // 「住在角色」与「显示角色」是两件事：
  //  · petHosted（音频/麦克风/气泡的所有者）永远只有锚点所在那块屏
  //  · 显示则分两种：平时只让宿主画（省一份渲染）；拖拽期间两块屏都画
  // 拖拽期间绝不能切 hidden —— 跨屏瞬间旧窗口的 stage 被隐藏会让 Chromium
  // 取消指针捕获/派发 pointercancel，拖拽当场断在屏幕边界，表现就是
  // 「拖不到另一个屏幕」。让不包含锚点的那块屏继续按全局坐标摆放 stage，
  // 超出窗口的部分由窗口自然裁剪，视觉上正好是角色跨在边界上的一小半。
  const dragging = !!(window.__petDragging || window.__petDragActive)
  if (petHosted !== inside) {
    petHosted = inside
    if (!inside) stopVoice() // 旧屏立刻闭嘴（否则两路 TTS 叠成双声道）
    // 拖拽时角色会在边界来回进出宿主身份：麦克风这类独占资源此时不来回重启，
    // 等松手后的一次 applyGlobalPos 再统一落到最终宿主
    if (!dragging) for (const fn of hostHooks) { try { fn(petHosted) } catch {} }
  }
  if (petDragWasActive && !dragging) {
    // 松手：按最终宿主结算一次独占资源（麦克风开关、录音状态）
    for (const fn of hostHooks) { try { fn(petHosted) } catch {} }
  }
  petDragWasActive = dragging
  const needHide = dragging ? false : !inside
  if (el.hidden !== needHide) {
    el.hidden = needHide // 触发热区 MutationObserver 重算
    console.warn('[pet] 宿主' + (needHide ? '隐藏' : '显示') + ' pos=' +
      Math.round(petGlobal.x) + ',' + Math.round(petGlobal.y) +
      ' win=' + Math.round(wx) + ',' + Math.round(wy) + (dragging ? ' 拖拽中' : ''))
    if (!needHide) {
      // hidden 时 offsetWidth=0，stageSize 是旧缓存 → 显示后重测一次再落位，
      // 否则跨屏接管的那块屏会用错的宽高把角色摆偏半屏
      requestAnimationFrame(() => {
        measureStage()
        applyGlobalPos()
        // 这块屏可能是在「舞台隐藏」状态下初始化的（画布被夹成 1x1、gl.viewport 只有 1 像素）。
        // 显示的第一帧就按真实尺寸对齐一次，别等下一帧 step 才出画面 —— 否则跨屏拖动
        // 时角色会先"空"一帧，松手停在新屏时更是整块透明
        try { if (spineRuntime && spineRuntime.resize) spineRuntime.resize() } catch {}
      })
    }
  }
  if (needHide) {
    const bubble = $('petBubble'); if (bubble) bubble.hidden = true
    return
  }
  measureStage()
  // 0.45.50 亚像素落位：Math.round 在走路速度下每 33ms 顿 1~2px（视觉抖动），
  // 交给 .petstage 的 70ms linear 过渡插值平滑；拖拽时切 .dragging 关过渡保跟手
  const right = window.innerWidth - (petGlobal.x - wx) - stageSize.w / 2
  const bottom = window.innerHeight - (petGlobal.y - wy)
  try { el.classList.toggle('dragging', !!dragging) } catch { }
  applyPos(right, bottom)
}

/* 拖拽标记看门狗：万一主进程没收到 drag-start（IPC 异常/窗口重载），
   __petDragActive 会一直为真 → 两块屏长期各画一份角色。3 秒没有新位置就收尾。 */
setInterval(() => {
  if (window.__petDragActive && Date.now() - lastPetPosAt > 3000) {
    window.__petDragActive = false
    applyGlobalPos()
  }
}, 1000)

/** 旧版位置迁移：localStorage 的 right/bottom（相对某单屏）→ 全局坐标落盘（一次性） */
function migrateLegacyPos () {
  try {
    // 多屏时只让「主屏那块窗口」做迁移：否则每块屏都按自己的坐标给角色安家 → 两只角色 + 双声道
    if (Math.round(window.screenX) !== 0 || Math.round(window.screenY) !== 0) return
    const saved = JSON.parse(localStorage.getItem('auraPetPos') || 'null')
    localStorage.removeItem('auraPetPos')
    measureStage()
    let gx, gy
    if (saved && isFinite(saved.right) && isFinite(saved.bottom)) {
      gx = window.screenX + window.innerWidth - saved.right - stageSize.w / 2
      gy = window.screenY + window.innerHeight - saved.bottom
    } else {
      gx = window.screenX + window.innerWidth - 200
      gy = window.screenY + window.innerHeight - 90
    }
    petGlobal = { x: gx, y: gy }
    applyGlobalPos()
    if (window.aura.petDragMove) {
      window.aura.petDragMove(Math.round(gx), Math.round(gy))
      window.aura.petDragEnd()
    }
  } catch {}
}

function setupDrag () {
  const el = $('petStage')
  let down = null
  let cancelGuard = 0
  // v0.4.2 主驱拖拽：渲染层只负责「报开始/报结束」，位置跟随完全由主进程
  // 16ms 轮询系统光标驱动——渲染层指针捕获在穿透窗口跨屏场景下会断（实证），不再依赖
  el.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false }
    if (e.button !== 0 || !petGlobal) return
    // 捕获恢复：位置跟随虽已由主进程驱动，但捕获能保证松手事件回流到发起窗口
    // （跨屏后捕获即使断了，光标所在屏的窗口也会收到 up，由 finish 的双路径兜住）
    try { el.setPointerCapture(e.pointerId) } catch {}
    window.__petDragging = true
    clearTimeout(cancelGuard)
    // 拖拽一开始就让两块屏同时接管显示（主进程随后会广播 dragging=true）
    window.__petDragActive = true
    applyGlobalPos()
    try { window.aura.petDragStart({ x: petGlobal.x, y: petGlobal.y }) } catch {}
    e.preventDefault()
  })
  // moved 判定：轻点（触摸反应）与拖拽的区分仍由渲染层完成
  el.addEventListener('pointermove', (e) => {
    if (!down) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true
  })
  const finish = (e) => {
    // v0.4.7 粘滞修复：跨屏后发起窗口的捕获可能断掉，松手事件由「光标所在屏」
    // 的另一个 overlay 窗口收到——此时 down 为 null 但拖拽仍在进行
    // （__petDragActive 由主进程 pet:pos.dragging 广播驱动），必须照常结束拖拽！
    // 旧代码 if(!down) return 把这类松手全部丢弃 → 松手后角色一直粘着光标
    const otherScreen = !down && (window.__petDragging || window.__petDragActive)
    const wasTap = down && !down.moved && Date.now() - down.t < 500
    const wasDrag = down ? !!window.__petDragging : otherScreen
    const kind = e && e.type
    down = null
    if (wasTap) {
      window.__petDragging = false
      // 轻点：Spine 走 BB 包围盒命中（onTapHook）；VRM 走骨骼投影命中（vrmTapHit，0.31.0）
      if (onTapHook) { onTapHook(e.clientX, e.clientY); return }
      vrmTapHit(e.clientX, e.clientY)
      return
    }
    if (!wasDrag) { window.__petDragging = false; return }
    // pointercancel 不等于松手：跨屏时窗口层级/合成变化、stage 显隐都可能让浏览器
    // 取消指针，但手指/按键往往还按着。此时立即结束 = 拖到边界就被打断（用户报的
    // 「拖不到另一个屏幕」）。交给 pointerup 或主进程按键探针来收尾，这里只留兜底。
    if (kind === 'pointercancel') {
      clearTimeout(cancelGuard)
      cancelGuard = setTimeout(() => {
        if (!window.__petDragging && !window.__petDragActive) return
        window.__petDragging = false
        if (window.aura.petDragEnd) window.aura.petDragEnd('cancel-guard')
      }, 1200)
      return
    }
    clearTimeout(cancelGuard)
    window.__petDragging = false
    if (window.aura.petDragEnd) window.aura.petDragEnd('up') // 主进程停轮询+落盘
    // 热区重算：角色已在新位置，旧的命中矩形必须刷新，否则新位置抓不住角色
    window.dispatchEvent(new Event('resize'))
  }
  // window 级：拖拽期间两块桌面层都收鼠标，松手发生在哪块屏就由哪块屏上报
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
}

/* ---------------- 启动 & 刷新 ---------------- */
;(async () => {
  const chat = setupChat()
  setupDrag()  // 视觉跟踪光标（主进程 80ms 轮询广播）+ 角色大小配置
  window.aura.onCursor((p) => { cursorScreen = p; cursorMoveAt = performance.now() })
  window.aura.onPetConfig((c) => {
    if (c && c.scale != null) applyScale(c.scale, true)
    // 回复语言设置变化 → 触摸语音短语切语种
    if (c && c.replyLang) touchLang = c.replyLang
    // 0.19.0 回应模式实时生效
    if (c && c.reactionMode) reactionMode = c.reactionMode
    if (c && Array.isArray(c.reactionTypes)) reactionTypes = c.reactionTypes
    // 朗读 AI 回复开关实时生效
    if (c && c.readReply != null) readReply = !!c.readReply
    // S3：气泡尺寸 / 字号 / 主题 / 音效 / 安静状态
    applyPetLook(c)
  })
  // 0.45.45：boot 时 companion 的 IPC handler 可能还没注册完，一次 invoke 拒绝 +
  // catch{} 吞掉 = petVrmaActs 永远收不到 = walk.vrma 从未预载（走路永远程序化的
  // 真根因）。带重试拉配置，拿到含 petVrmaActs 的完整对象为止（最多 15 次 × 2s）
  let s = null
  for (let i = 0; i < 15; i++) {
    try {
      s = await window.aura.petSettings()
      if (s && ('petVrmaActs' in s)) break
      s = null
    } catch { petDiagOnce('settings-retry', 'petSettings 第 ' + (i + 1) + ' 次还没就绪，2s 后重试') }
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (s) {
    if (s.petScale != null) await applyScale(s.petScale, false)
    if (s.readReply != null) readReply = !!s.readReply
    if (s.replyLang) touchLang = s.replyLang
    if (s.reactionMode) reactionMode = s.reactionMode
    if (Array.isArray(s.reactionTypes)) reactionTypes = s.reactionTypes
    // S3：气泡尺寸/字号/主题/音效/安静状态（模型用 pet_set / pet_quiet 改的就是这些）
    applyPetLook(s)
  } else {
    petDiagOnce('settings-fail', 'petSettings 重试 15 次仍失败（companion IPC 一直没就绪？）')
  }
  setupMenu(chat) // 右键菜单（0.18.0 第一批）
  // 0.45.29 热区丢失 → 右键菜单立刻收起（菜单是 data-hot，光标走了就该关）
  if (window.aura.onHotLost) {
    window.aura.onHotLost(() => { const m = $('petMenu'); if (m) m.hidden = true })
  }
  // 0.29.0 卡片联动补完：坐/站由主进程广播（坐卡片/原地休息/起身）。
  // 此前广播没有渲染层接收者——坐上卡片也只是「站着贴在卡片上」，0.45.29 接上。
  if (window.aura.onPetPose) {
    window.aura.onPetPose(({ pose }) => {
      try {
        if (vrmRuntime && typeof vrmRuntime.setPose === 'function') {
          vrmRuntime.setPose(pose === 'sit' ? 'sit' : 'stand')
        }
        actSit = pose === 'sit' // 0.45.35 主进程坐/站广播与 pet_act 持续坐共用一个状态
      } catch { }
    })
  }
  // 0.18.0 第一批：闹钟到点（主进程广播）→ 状态气泡 + 响一声；台词气泡由 pet_say 接管
  if (window.aura.onPetAlarm) {
    window.aura.onPetAlarm((d) => {
      if (!petHosted) return
      fx('alarm')
      if (petStatusBubble) statusSet('alarm', d && d.label ? d.label : '')
      if (d && d.label) { chat?.bubble('⏰ ' + d.label + ' 到了'); chat?.keep(5000) }
    })
  }
  const st = await window.aura.petState()
  if (st && st.pos && isFinite(st.pos.x)) {
    petGlobal = { x: st.pos.x, y: st.pos.y }
    applyGlobalPos()
  } else {
    migrateLegacyPos() // 旧 localStorage 位置 → 全局坐标一次性迁移落盘
  }
  window.aura.onPetPos((p) => {
    if (!p || !isFinite(p.x)) return    lastPetPosAt = Date.now()
    // 拖拽中标记同步给两块屏：热区逻辑全局保持可交互（不因光标偏离热区切回穿透）
    window.__petDragActive = !!p.dragging
    if (!p.dragging) window.__petDragging = false
    petGlobal = { x: p.x, y: p.y }
    petHostHint = p.hostBounds || null
    applyGlobalPos()
    if (!$('petChat').hidden) requestAnimationFrame(positionChat)
    // 自主走动/抛掷期间角色一直在动，气泡必须跟着走，否则说话时人走开了
    if (!$('petBubble').hidden) requestAnimationFrame(positionBubble)
  })
  // 5.7 窗台提示：拖拽中主进程采样到角色悬在某个窗口顶边附近 → 本窗把那条边亮出来
  if (window.aura.onPetLedge) {
    window.aura.onPetLedge((d) => {
      const bar = $('petLedge')
      if (!bar) return
      if (!d || !d.on || !isFinite(d.y) || d.seated) { bar.hidden = true; return }
      const wx = window.screenX
      const wy = window.screenY
      bar.style.left = Math.round((isFinite(d.x) ? d.x : wx) - wx) + 'px'
      bar.style.top = Math.round(d.y - wy) + 'px'
      bar.style.width = Math.max(60, Math.round(d.w || 200)) + 'px'
      bar.hidden = false
    })
  }
  if (st && st.visible && st.char) await showVisual(st.char)
  window.aura.onPetState(async (s) => {
    if (!s || !s.visible) { disposeSpine(); disposeVrm(); currentSig = ''; if (chat) chat.hide(); return }
    if (s.pos && isFinite(s.pos.x) && (!petGlobal || s.pos.x !== petGlobal.x || s.pos.y !== petGlobal.y)) {
      petGlobal = { x: s.pos.x, y: s.pos.y }
      applyGlobalPos()
    }
    if (s.char) await showVisual(s.char)
  })
})().catch((err) => { console.error('[pet-ov boot]', err); $('petFallback').hidden = false })
})()
