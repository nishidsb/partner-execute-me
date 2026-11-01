/**
 * 电脑画像 · 推断层（**只读 + 纯本地计算**）
 *
 * 为什么要有这一层：raw.json 里全是「bilibili×558、原神、Edge 4.2 小时」这种清单。
 * 清单只说明「他做过什么」，不说明「他是个什么样的人」。她需要的是后者——
 * 所以这里把清单翻译成可用的判断：兴趣主题、作息节律、新冒出来的兴趣、
 * 行为风格（求知型/决策型/围观型）、以及与健康记录交叉出来的矛盾点。
 *
 * 两条原则：
 *   1. 每个判断都必须挂**具体证据**（看得到出处，她才不会瞎编）
 *   2. 判断都带不确定语气（「像是在…」「可能」），她可以拿去问主人验证，
 *      而不是当成事实背出来
 *
 * 纯函数，不联网、不写文件。宿主拿到结果后写 insight.md 并进提示词。
 */

/** 兴趣主题词表：hosts 是专属域名（命中一次即算），words 是标题/收藏名里的关键词 */
const THEMES = [
  {
    key: 'game',
    label: '游戏',
    hosts: ['steamcommunity.com', 'steampowered.com', 'epicgames.com', 'nexusmods.com', 'biligame.com',
      'ys.mihoyo.com', 'mihoyo.com', 'hoyolab.com', 'nga.cn', 'ngabbs.com', 'gamersky.com', '3dmgame.com',
      'ign.com', 'gamekee.com', 'bbs.nga.cn'],
    words: ['原神', '崩坏', '星穹铁道', '绝区零', '黑神话', '艾尔登', '只狼', '塞尔达', '怪物猎人', '炉石',
      '英雄联盟', 'lol', 'cs2', 'csgo', 'apex', '我的世界', '泰拉瑞亚', '帕鲁', '幻兽', '游戏攻略', '通关',
      '开荒', '抽卡', '深渊', '周本', '副本', '存档', '联机', 'steam', '主机', '手柄', '帧数']
  },
  {
    key: 'anime',
    label: '动画 / 番剧',
    hosts: ['bangumi.tv', 'bgm.tv', 'acfun.cn', 'mikanani.me', 'dmhy.org'],
    words: ['番剧', '第1话', '第2话', '第3话', '动画', '新番', '剧场版', '声优', 'mad', '手书', 'mmd',
      'vtuber', '虚拟主播', '追番', '完结', 'pv', '二创', '同人', '剪辑']
  },
  {
    key: 'tech',
    label: '技术 / 编程',
    hosts: ['github.com', 'gitlab.com', 'stackoverflow.com', 'stackexchange.com', 'npmjs.com', 'pypi.org',
      'developer.mozilla.org', 'csdn.net', 'cnblogs.com', 'segmentfault.com', 'juejin.cn', 'gitee.com',
      'huggingface.co', 'crates.io', 'electronjs.org', 'nodejs.org'],
    words: ['github', 'python', 'javascript', 'typescript', 'node.js', 'electron', 'vue', 'react', 'rust',
      'golang', '编译', '报错', '源码', '部署', '服务器', 'docker', 'git', '算法', '接口文档', 'sdk',
      '正则', '重构', '单元测试']
  },
  {
    key: 'ai',
    label: 'AI / 大模型',
    hosts: ['openai.com', 'chatgpt.com', 'claude.ai', 'anthropic.com', 'gemini.google.com', 'perplexity.ai',
      'civitai.com', 'openart.ai', 'modelscope.cn', 'ollama.com'],
    words: ['大模型', '微调', '提示词', 'prompt', 'stable diffusion', 'comfyui', 'lora', 'llm', 'gpt',
      'claude', 'deepseek', '智能体', 'agent', '向量数据库', '文生图', '文生视频']
  },
  {
    key: 'study',
    label: '学习 / 考试',
    hosts: ['icourse163.org', 'xuetangx.com', 'chaoxing.com', 'zhihuishu.com', 'coursera.org', 'cnki.net',
      'wanfangdata.com.cn', 'docin.com', 'wenku.baidu.com'],
    words: ['考研', '四六级', '期末', '复习', '课程', '课件', '论文', '文献', '答辩', '考试', '习题',
      '讲义', '作业', '期末复习', '保研', '雅思', '托福', '选课', '绩点', '成绩查询', '开题']
  },
  {
    key: 'craft',
    label: '创作 / 设计',
    hosts: ['figma.com', 'behance.net', 'artstation.com', 'dribbble.com', 'pixiv.net', 'huaban.com',
      'zcool.com.cn', 'blender.org', 'adobe.com'],
    words: ['设计', '插画', '建模', '渲染', '剪辑', '调色', 'photoshop', 'blender', '3d', '手办', '谷子',
      '排版', '配色', '字体', '原画', '分镜', '素材包', '笔刷']
  },
  {
    key: 'hardware',
    label: '硬件 / 装机',
    hosts: ['chiphell.com', 'expreview.com', 'tomshardware.com', 'nvidia.com', 'amd.com', 'intel.com',
      'asus.com.cn', 'msi.cn'],
    words: ['显卡', 'cpu', '主板', '散热', '固态', '内存', '装机', '跑分', '超频', '电源', '机箱',
      '外设', '键盘', '鼠标', '显示器', '刷新率']
  },
  {
    key: 'shop',
    label: '购物 / 比价',
    hosts: ['taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com', 'amazon.com', 'smzdm.com', 'xiaohongshu.com'],
    words: ['优惠', '券', '包邮', '旗舰店', '性价比', '下单', '购物车', '开箱', '晒单', '618', '双十一',
      '值得买', '测评', '好物']
  },
  {
    key: 'news',
    label: '新闻 / 时事',
    hosts: ['weibo.com', 'toutiao.com', 'thepaper.cn', '36kr.com', 'huxiu.com', 'news.qq.com',
      'zaobao.com', 'ifeng.com', 'caixin.com'],
    words: ['新闻', '通报', '回应', '发布会', '政策', '突发', '热搜', '官宣', '道歉', '起诉', '股价']
  },
  {
    key: 'music',
    label: '音乐',
    hosts: ['music.163.com', 'y.qq.com', 'music.apple.com', 'spotify.com', 'kuwo.cn', 'kugou.com'],
    words: ['音乐', '歌单', '专辑', '演唱会', '翻唱', '作词', '作曲', '纯音乐', 'bgm', '钢琴', '现场版']
  },
  {
    key: 'video',
    label: '视频 / 直播',
    hosts: ['bilibili.com', 'douyin.com', 'youtube.com', 'twitch.tv', 'huya.com', 'douyu.com'],
    words: ['视频', '直播', 'up主', '投稿', '合集', '解说', '实况', 'vlog', '弹幕', '切片', '名场面']
  },
  {
    key: 'med',
    label: '健康 / 医疗',
    hosts: ['dxy.com', 'haodf.com', 'msdmanuals.cn', 'chunyuyisheng.com', 'guahao.com'],
    words: ['症状', '血压', '心率', '失眠', '医生', '体检', '药', '医保', '挂号', '熬夜', '焦虑',
      '睡眠', '胃', '头疼', '颈椎', '过敏']
  },
  {
    key: 'finance',
    label: '财经 / 投资',
    hosts: ['xueqiu.com', 'eastmoney.com', '10jqka.com.cn', 'sse.com.cn', 'szse.cn', 'binance.com'],
    words: ['股票', '基金', 'etf', '大盘', '估值', '财报', '利率', '汇率', '比特币', '加密', '美股',
      'a股', '港股', '仓位', '定投']
  },
  {
    key: 'fitness',
    label: '健身 / 运动',
    hosts: ['keep.com', 'strava.com', 'nike.com', 'garmin.com'],
    words: ['健身', '增肌', '减脂', '跑步', '配速', '深蹲', '拉伸', '蛋白粉', '训练计划', '体脂', '卡路里']
  },
  {
    key: 'book',
    label: '读书 / 小说 / 漫画',
    hosts: ['weread.qq.com', 'douban.com', 'goodreads.com', 'qidian.com', 'jjwxc.net', 'manhuagui.com'],
    words: ['小说', '轻小说', '漫画', '连载', '读书', '书评', '阅读', '完结', '文库', '设定集']
  },
  {
    key: 'auto',
    label: '汽车',
    hosts: ['autohome.com.cn', 'dongchedi.com', 'yiche.com'],
    words: ['车型', '试驾', '落地价', '油耗', '提车', '驾照', '电动车', '轮胎', '保养']
  },
  {
    key: 'food',
    label: '美食',
    hosts: ['xiachufang.com', 'meishichina.com', 'dianping.com', 'meituan.com', 'ele.me'],
    words: ['食谱', '菜谱', '做法', '探店', '好吃', '外卖', '烘焙', '咖啡', '火锅']
  },
  {
    key: 'travel',
    label: '旅行',
    hosts: ['ctrip.com', 'qunar.com', 'mafengwo.cn', 'booking.com', 'trip.com'],
    words: ['旅游', '攻略', '机票', '酒店', '签证', '自驾', '民宿', '景点']
  },
  {
    key: 'photo',
    label: '摄影',
    hosts: ['xitek.com', 'dpreview.com', '500px.com'],
    words: ['摄影', '镜头', '光圈', '构图', '后期', '相机', '胶片']
  }
]

/** 扩展名 → 主题（文件层面能看出他在做什么） */
const EXT_THEME = {
  '.blend': 'craft', '.psd': 'craft', '.ai': 'craft', '.aep': 'craft', '.prproj': 'craft', '.sketch': 'craft',
  '.fig': 'craft', '.c4d': 'craft', '.max': 'craft', '.ma': 'craft', '.mb': 'craft', '.flp': 'craft',
  '.py': 'tech', '.js': 'tech', '.ts': 'tech', '.java': 'tech', '.c': 'tech', '.cpp': 'tech', '.cs': 'tech',
  '.go': 'tech', '.rs': 'tech', '.json': 'tech', '.sql': 'tech', '.sh': 'tech', '.ps1': 'tech',
  '.ipynb': 'ai', '.ckpt': 'ai', '.safetensors': 'ai', '.gguf': 'ai',
  '.pdf': 'study', '.docx': 'study', '.pptx': 'study', '.epub': 'book', '.mobi': 'book', '.cbz': 'book',
  '.xlsx': 'finance', '.csv': 'finance'
}

/** 应用名 → 主题（usage 的 byApp） */
const APP_THEME = [
  { re: /code|idea|pycharm|webstorm|sublime|neovim|vim|devenv|android studio|hbuilder|xcode/i, key: 'tech' },
  { re: /blender|photoshop|premiere|after effects|illustrator|figma|davinci|csp|clip studio|sai|aseprite/i, key: 'craft' },
  { re: /steam|epic|battle\.net|uplay|origin|game|原神|崩坏|星穹|绝区|genshin|honkai|zzz/i, key: 'game' },
  { re: /bilibili|哔哩哔哩|potplayer|vlc|mpv|iqiyi|腾讯视频|netflix/i, key: 'video' },
  { re: /网易云|qq音乐|spotify|foobar|cloudmusic/i, key: 'music' },
  { re: /obsidian|notion|typora|word|excel|powerpoint|wps|onenote/i, key: 'study' },
  { re: /wechat|微信|qq|telegram|discord|钉钉|飞书/i, key: 'social' }
]

const SOCIAL_LABEL = '社交 / 聊天'
const DAY = 86400000

function norm (s) { return String(s == null ? '' : s).toLowerCase() }

function hostHit (host, list) {
  const h = norm(host)
  if (!h) return false
  for (const d of list) {
    if (h === d || h.endsWith('.' + d)) return true
  }
  return false
}

function wordHit (text, words) {
  const t = norm(text)
  if (!t) return []
  const out = []
  for (const w of words) {
    if (t.includes(w)) out.push(w)
  }
  return out
}

/* ---------------------------------------------------------------- 主题 */

/**
 * 从各路数据里抽信号，累计成主题分。
 * 权重：专属域名 +3 / 应用名 +4 / 游戏名 +5 / 标题关键词 +1（每词每主题最多 6 分）
 * 这样「一堆 bilibili 首页」不会把动画刷成第一主题，而「收藏夹里 20 个番剧」会。
 */
function themesOf (raw) {
  const score = new Map()
  const ev = new Map()
  const add = (key, n, evidence) => {
    if (!key) return
    score.set(key, (score.get(key) || 0) + n)
    if (!evidence) return
    const list = ev.get(key) || []
    if (list.length < 4 && !list.includes(evidence)) list.push(evidence)
    ev.set(key, list)
  }
  const byKey = new Map(THEMES.map((t) => [t.key, t]))

  const b = raw.browser
  if (b && b.domains) {
    for (const d of b.domains) {
      for (const t of THEMES) {
        if (hostHit(d.host, t.hosts)) add(t.key, 3, d.host)
      }
    }
  }
  if (b && b.recent) {
    const seenTitle = new Map()
    for (const r of b.recent) {
      const title = String(r.title || '')
      for (const t of THEMES) {
        const hits = wordHit(title, t.words)
        if (!hits.length) continue
        const cur = seenTitle.get(t.key) || 0
        if (cur >= 6) continue // 同一主题别被大量同质标题刷爆
        const w = Math.min(hits.length, 2)
        seenTitle.set(t.key, cur + w)
        add(t.key, w, hits[0] + '：' + title.slice(0, 30))
      }
    }
  }
  /* 搜索词信息量最大：「原神 深渊 阵容」「python 报错」直接暴露意图 */
  if (b && b.searches) {
    for (const s of b.searches.slice(0, 120)) {
      for (const t of THEMES) {
        const hits = wordHit(s.q, t.words)
        if (hits.length) add(t.key, 2, '搜索「' + String(s.q).slice(0, 24) + '」')
      }
    }
  }
  /* 书签 = 长期兴趣（比最近浏览更能代表「一直喜欢」） */
  if (b && b.bookmarks) {
    for (const bm of b.bookmarks.slice(0, 80)) {
      const name = String(bm.name || '')
      let hit = false
      for (const t of THEMES) {
        if (wordHit(name, t.words).length) { add(t.key, 2, '书签「' + name.slice(0, 22) + '」'); hit = true }
      }
      if (!hit) {
        for (const t of THEMES) {
          if (hostHit(bm.host, t.hosts)) { add(t.key, 2, '书签来自 ' + bm.host); break }
        }
      }
    }
  }
  /* B站：收藏夹名 + 收藏标题 + 观看历史 */
  const bi = raw.bili
  if (bi && bi.loggedIn) {
    for (const f of bi.folders || []) {
      for (const t of THEMES) {
        if (wordHit(f.title, t.words).length) add(t.key, 3, '收藏夹「' + f.title + '」')
      }
    }
    for (const f of (bi.favorites || []).slice(0, 60)) {
      for (const t of THEMES) {
        if (wordHit(f.title, t.words).length) add(t.key, 1, '收藏：' + String(f.title).slice(0, 28))
      }
    }
    for (const h of (bi.history || []).slice(0, 60)) {
      for (const t of THEMES) {
        if (wordHit(h.title, t.words).length) add(t.key, 1, '在看：' + String(h.title).slice(0, 28))
      }
    }
  }
  /* 游戏库：装了就是长期兴趣 */
  const g = raw.games
  if (g && g.ok) {
    for (const x of [...(g.steam || []), ...(g.epic || []), ...(g.games || [])].slice(0, 120)) {
      const name = String(x.name || '')
      if (!name) continue
      if (x.source === 'steam' || x.source === 'epic') add('game', 2, '库里有 ' + name.slice(0, 20))
      for (const t of THEMES) {
        if (t.key === 'game') continue
        if (wordHit(name, t.words).length) add(t.key, 2, name.slice(0, 20))
      }
    }
  }
  /* 应用时长：最能说明「一天在干嘛」 */
  const u = raw.usage
  if (u && u.byApp) {
    for (const a of u.byApp.slice(0, 25)) {
      for (const m of APP_THEME) {
        if (m.re.test(a.app)) {
          add(m.key, 4, a.app + ' ' + a.minutes + ' 分钟')
          break
        }
      }
    }
  }
  /* 文件类型：在做什么作品/项目 */
  const f = raw.files
  if (f && f.byExt) {
    for (const x of f.byExt) {
      const k = EXT_THEME[norm(x.ext)]
      if (k) add(k, Math.min(4, Math.round(Number(x.count) / 20) || 1), x.ext + '×' + x.count)
    }
  }

  const out = []
  for (const [key, sc] of score) {
    const meta = byKey.get(key)
    const label = meta ? meta.label : (key === 'social' ? SOCIAL_LABEL : key)
    if (sc < 3) continue
    out.push({ key, label, score: sc, ev: ev.get(key) || [] })
  }
  out.sort((a, b2) => b2.score - a.score)
  return out.slice(0, 7)
}

/* ---------------------------------------------------------------- 作息 */

const p2 = (n) => (n < 10 ? '0' + n : '' + n)

/** 每天最晚一条记录的钟点（0-24 浮点） */
function lateHourByDay (recent) {
  const m = new Map()
  for (const r of recent || []) {
    if (!r.at) continue
    const d = new Date(r.at)
    const key = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
    const h = d.getHours() + d.getMinutes() / 60
    /* 凌晨 0-5 点算「前一晚的延续」，日期归到前一天，否则凌晨活跃会被算成早起 */
    const adj = h < 5 ? h + 24 : h
    if (!m.has(key) || m.get(key) < adj) m.set(key, adj)
  }
  return [...m.values()]
}

function median (arr) {
  if (!arr || !arr.length) return 0
  const s = arr.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function rhythmOf (raw) {
  const b = raw.browser
  const hourly = (b && Array.isArray(b.hourly)) ? b.hourly : new Array(24).fill(0)
  const total = hourly.reduce((a, c) => a + c, 0)
  const res = { peak: '', deepNightShare: 0, lateShare: 0, morningShare: 0, avgLast: 0, type: '', note: '' }

  /* 设备运行时间比浏览记录更硬：关机时间不会因为「只开了浏览器没记历史」而丢。
     先把它挂上，下面判定时可以据此升级作息结论。 */
  const se = raw.sessions
  if (se && se.ok) {
    if (se.source === 'eventlog') {
      res.avgUpHours = Number(se.avgUpHours) || 0
      res.lateShutdowns = Number(se.lateShutdowns) || 0
      const boots = (se.sessions || []).filter((s) => s.on).map((s) => new Date(s.on).getHours())
      res.avgBootHour = boots.length ? Math.round(median(boots) * 10) / 10 : 0
      /* 关机时刻中位数：凌晨关机要加上 24 才排得对（否则 1 点会比 23 点「早」） */
      const offs = (se.sessions || []).filter((s) => s.off)
        .map((s) => new Date(s.off).getHours())
        .map((h) => (h < 6 ? h + 24 : h))
      res.avgOffHour = offs.length ? Math.round(median(offs) * 10) / 10 : 0
    }
    res.uptimeHours = Number(se.uptimeHours) || 0
  }

  if (!total) {
    /* 没有浏览记录也别白跑：只凭关机时间也能说个大概 */
    if (res.lateShutdowns >= 2) {
      res.type = '晚睡型'
      res.note = '多次凌晨 1–6 点才关机'
    }
    return res
  }

  let best = { i: 0, sum: -1 }
  for (let i = 0; i < 24; i++) {
    const s = hourly[i] + hourly[(i + 1) % 24] + hourly[(i + 2) % 24]
    if (s > best.sum) best = { i, sum: s }
  }
  res.peak = p2(best.i) + ':00–' + p2((best.i + 3) % 24) + ':00'
  const sum = (from, to) => {
    let n = 0
    for (let i = from; i < to; i++) n += hourly[i]
    return n
  }
  res.deepNightShare = Math.round((sum(0, 5) / total) * 100) / 100
  res.lateShare = Math.round(((sum(22, 24) + sum(0, 3)) / total) * 100) / 100
  res.morningShare = Math.round((sum(5, 9) / total) * 100) / 100

  const lastHours = lateHourByDay(b && b.recent)
  res.avgLast = Math.round(median(lastHours) * 10) / 10

  /* 判定要分级：凌晨真在线 vs 只是过了午夜才睡，是两种人 */
  if (res.deepNightShare >= 0.06) {
    res.type = '夜猫子'
    res.note = '凌晨 0–5 点还在上网的次数不少，这对他不算例外'
  } else if (res.avgLast >= 24.5) {
    res.type = '晚睡型'
    res.note = '常常过了午夜才离开电脑，但凌晨之后基本就停了'
  } else if (res.lateShare >= 0.22) {
    res.type = '偏晚睡'
    res.note = '晚上十点后才是活跃高峰'
  } else if (res.morningShare >= 0.2) {
    res.type = '早起型'
    res.note = '早上的活跃度明显高于深夜'
  } else {
    res.type = '常规作息'
    res.note = ''
  }
  /* 关机记录和浏览记录打架时，信关机：多次凌晨才关机的人，不叫「常规作息」 */
  if (res.lateShutdowns >= 2 && res.type !== '夜猫子') {
    if (res.type !== '晚睡型') {
      res.type = '晚睡型'
      res.note = '关机时间多次落在凌晨 1–6 点' + (res.avgLast ? '，和上网的最晚时间对得上' : '')
    }
  }
  return res
}

/* ------------------------------------------------------------ 新兴趣 */

/** 登录跳转/CDN 这类「不是兴趣，是路过的门」的域名，不算新兴趣 */
const NOISE_HOSTS = [
  'accounts.google.com', 'accounts.youtube.com', 'login.live.com', 'login.microsoftonline.com',
  'appleid.apple.com', 'auth.openai.com', 'auth0.com', 'okta.com', 't.co', 'go.microsoft.com',
  'ocsp.', 'gstatic.com', 'googleapis.com', 'cloudflare.com', 'doubleclick.net', 'googlesyndication.com'
]

function isNoiseHost (host) {
  const h = norm(host)
  if (!h) return true
  return NOISE_HOSTS.some((n) => h === n || h.endsWith('.' + n) || h.startsWith(n))
}

/**
 * 近 7 天 vs 前 7 天。
 *
 * 这里有两个坑：
 *   1. 登录跳转域名会被当成「新兴趣」（已用 NOISE_HOSTS 挡掉）
 *   2. 如果历史库实际只有最近几天的数据，那「前 7 天」天然是空的，所有站点都会被判成新的。
 *      所以额外算一个 sparse 标志：近 7 天占了全部访问的大头时，只能说「最近主要在哪」，
 *      不能说「新冒出来」——那是数据不足，不是兴趣变了。
 */
function freshnessOf (raw) {
  const b = raw.browser
  if (!b) return { list: [], sparse: false }
  const out = []
  const seen = new Set()
  let near = 0
  let all = 0
  for (const d of (b.domains || [])) {
    near += Number(d.h7) || 0
    all += Number(d.hits) || 0
  }
  const sparse = all > 0 && near / all > 0.75

  for (const d of (b.domains || [])) {
    if (isNoiseHost(d.host)) continue
    /* 已经在 domains 里统计过的站，不能再让 recent（只有最近几百条）重算一次——
       否则「前 7 天最近 300 条里没有它」会被误读成「以前没去过」 */
    seen.add(d.host)
    const n = Number(d.h7) || 0
    const before = Number(d.h7p) || 0
    if (n < 8) continue
    if (before > 0) {
      if (n >= before * 2.5) out.push({ host: d.host, now: n, before })
    } else if (!sparse) {
      out.push({ host: d.host, now: n, before: 0 })
    }
  }
  /* 再拿 recent 补长尾（domains 只留了 top60，小众新站会漏） */
  if (!sparse && Array.isArray(b.recent) && b.recent.length) {
    const now = Date.now()
    const cur = new Map()
    const prev = new Map()
    for (const r of b.recent) {
      if (!r.at || !r.host || seen.has(r.host) || isNoiseHost(r.host)) continue
      const age = now - r.at
      const m = age <= 7 * DAY ? cur : (age <= 14 * DAY ? prev : null)
      if (!m) continue
      m.set(r.host, (m.get(r.host) || 0) + 1)
    }
    for (const [host, n] of cur) {
      const before = prev.get(host) || 0
      if (n >= 3 && before === 0) out.push({ host, now: n, before })
    }
  }
  out.sort((a, b2) => b2.now - a.now)
  /* 同根域名合并（bilibili.com 和 t.bilibili.com 是同一个站，别占两个名额） */
  const merged = []
  for (const f of out) {
    const hit = merged.find((m) => m.host.endsWith('.' + f.host) || f.host.endsWith('.' + m.host))
    if (hit) {
      hit.now += f.now
      hit.before += f.before
      if (f.host.length < hit.host.length) hit.host = f.host
      continue
    }
    merged.push({ host: f.host, now: f.now, before: f.before })
  }
  return { list: merged.slice(0, 5), sparse }
}

/* ------------------------------------------------------------ 行为风格 */

const STYLE_RULES = [
  { key: 'learn', label: '求知型', re: /怎么|如何|教程|为什么|原理|入门|学习|实现|解决|报错|配置|区别/ },
  { key: 'decide', label: '决策型', re: /推荐|哪个好|怎么选|对比|评测|值不值|性价比|值得买|选哪个|排行/ },
  { key: 'curious', label: '好奇型', re: /是什么|意思|梗|背景|故事|历史|百科|原因/ },
  { key: 'resource', label: '找资源型', re: /下载|资源|破解|在线|免费|无水印|合集|网盘|安装包/ }
]

function styleOf (raw) {
  const b = raw.browser
  const qs = (b && b.searches) ? b.searches.map((x) => String(x.q || '')) : []
  /* 没有搜索词就退回标题（噪音大，只取前 120 条） */
  const pool = qs.length ? qs : ((b && b.recent) ? b.recent.slice(0, 120).map((r) => String(r.title || '')) : [])
  if (!pool.length) return null
  const cnt = {}
  let hit = 0
  for (const q of pool) {
    for (const r of STYLE_RULES) {
      if (r.re.test(q)) { cnt[r.key] = (cnt[r.key] || 0) + 1; hit += 1; break }
    }
  }
  if (!hit || hit < 5) return null
  const out = STYLE_RULES.map((r) => ({ key: r.key, label: r.label, n: cnt[r.key] || 0 }))
    .filter((x) => x.n > 0).sort((a, b2) => b2.n - a.n)
  return { total: pool.length, hit, top: out.slice(0, 2), fromSearch: qs.length > 0 }
}

/* ------------------------------------------------------ 与健康记录交叉 */

/** "01:20" → 80 分；解析不了返回 null */
function hhmmToMin (hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** 他说几点睡 vs 电脑几点还亮着 —— 「完整的人」最需要这种交叉 */
function crossOf (rhythm, health) {
  const out = []
  if (!health || !health.ok) return out
  const s = health.sleep || {}
  if (s.avgBed && rhythm && rhythm.avgLast) {
    const bed = hhmmToMin(s.avgBed)
    if (bed != null) {
      const bedAdj = bed < 300 ? bed + 1440 : bed
      const lastAdj = Math.round(rhythm.avgLast * 60)
      const gap = lastAdj - bedAdj
      if (gap >= 60) {
        out.push({
          kind: 'late-vs-sleep',
          text: '他自己记的平均入睡是 ' + s.avgBed + '，但电脑上最晚的一条记录中位数在 ' +
            p2(Math.floor((rhythm.avgLast % 24))) + ':' + p2(Math.round((rhythm.avgLast % 1) * 60)) +
            ' —— 说的和做的差了大约 ' + Math.round(gap / 60) + ' 小时'
        })
      }
    }
  }
  if (s.avgHours && s.avgHours < 6.5 && rhythm && rhythm.deepNightShare >= 0.08) {
    out.push({ kind: 'short-sleep', text: '平均只睡 ' + s.avgHours + ' 小时，而且凌晨还在用电脑，长期这样会垮' })
  }
  /* 关机时间比浏览记录更硬：他说 1 点睡，可电脑 3 点才关——这是真的「说和做不一样」 */
  if (s.avgBed && rhythm && rhythm.avgOffHour) {
    const bed = hhmmToMin(s.avgBed)
    if (bed != null) {
      const bedAdj = bed < 300 ? bed + 1440 : bed
      const offAdj = Math.round(rhythm.avgOffHour * 60)
      const gap = offAdj - bedAdj
      if (gap >= 45) {
        out.push({
          kind: 'bed-vs-shutdown',
          text: '他记的入睡时间中位数是 ' + s.avgBed + '，但电脑关机时间中位数在 ' +
            p2(Math.floor(rhythm.avgOffHour) % 24) + ':' + p2(Math.round((rhythm.avgOffHour % 1) * 60)) +
            '，晚了约 ' + Math.round(gap / 60) + ' 小时——可能是躺下又起来，也可能是记录偏早'
        })
      }
    }
  }
  const bp = health.bp || {}
  if (bp.highCount && rhythm && rhythm.deepNightShare >= 0.08) {
    out.push({ kind: 'bp-night', text: '血压有偏高的记录，同时是夜猫子作息，两件事可能互相加重' })
  }
  const mood = health.mood || {}
  if (mood.lowCount && rhythm && rhythm.lateShare >= 0.25) {
    out.push({ kind: 'mood-night', text: '有几天心情很低，那阵子也是晚睡居多' })
  }
  return out
}

/* ---------------------------------------------------------- 自然语言 */

function narrativeOf ({ themes, rhythm, fresh, sparse, style, cross, raw }) {
  const L = []
  const u = raw.usage
  const t0 = themes[0]
  const t1 = themes[1]

  if (t0) {
    let s = '花时间最多的是' + t0.label
    if (t1) s += '，其次是' + t1.label
    if (t0.ev && t0.ev.length) s += '（' + t0.ev.slice(0, 2).join('；') + '）'
    L.push(s + '。')
  }
  if (u && u.ok && u.totalHours > 0) {
    let s = '这些天电脑前台累计 ' + u.totalHours + ' 小时（' + u.sampledDays + ' 天）'
    if (u.byApp && u.byApp[0]) s += '，光是「' + u.byApp[0].app + '」就占 ' + u.byApp[0].minutes + ' 分钟'
    const perDay = u.sampledDays ? Math.round((u.totalHours / u.sampledDays) * 10) / 10 : 0
    if (perDay >= 7) s += '；平均每天 ' + perDay + ' 小时，待在电脑前的时间相当长'
    L.push(s + '。')
  }
  if (rhythm && rhythm.type) {
    let s = '作息上是' + rhythm.type
    if (rhythm.peak) s += '，窗口集中在 ' + rhythm.peak
    if (rhythm.note) s += '，' + rhythm.note
    if (rhythm.avgLast > 24) {
      const hh = Math.floor(rhythm.avgLast % 24)
      const mm = Math.round((rhythm.avgLast % 1) * 60)
      s += '；最晚一次常常拖到 ' + p2(hh) + ':' + p2(mm) + ' 左右'
    }
    L.push(s + '。')
  }
  /* 设备运行时间：比「几点还在上网」更能说明他把这台电脑当什么用 */
  if (rhythm && rhythm.avgUpHours) {
    let s = '这台电脑平均每次开机开着 ' + rhythm.avgUpHours + ' 小时'
    if (rhythm.avgBootHour) s += '，通常 ' + p2(Math.floor(rhythm.avgBootHour)) + ' 点前后开机'
    if (rhythm.lateShutdowns) s += '，近两周有 ' + rhythm.lateShutdowns + ' 次是凌晨才关机'
    L.push(s + '。')
  }
  const st = raw.steam
  if (st && st.ok && Array.isArray(st.games) && st.games.length) {
    /* 只有 App <id> 的（已卸载、认不出名字）不写进叙述，写了也没信息 */
    const top = st.games.slice(0, 4).filter((g) => !/^App \d+$/.test(g.name)).slice(0, 3)
    if (top.length) {
      L.push('Steam 里真正花时间的是' + top.map((g) => g.name + '（' + g.hours + ' 小时）').join('、') +
        '；装了就玩和不装是两回事。')
    }
  }
  const op = raw.opened
  if (op && op.ok && Array.isArray(op.recent)) {
    const v = op.recent.filter((x) => x.kind === 'video').slice(0, 2).map((x) => x.name)
    const d = op.recent.filter((x) => x.kind === 'doc').slice(0, 2).map((x) => x.name)
    const bits = []
    if (v.length) bits.push('影片「' + v.join('」「') + '」')
    if (d.length) bits.push('文档「' + d.join('」「') + '」')
    if (bits.length) L.push('最近亲手打开过的有：' + bits.join('、') + '。')
  }
  if (fresh && fresh.length) {    const items = fresh.slice(0, 4).map((f) => f.host + (f.before ? '（' + f.before + ' 次涨到 ' + f.now + ' 次）' : ''))
    if (sparse) {
      /* 数据只有最近几天时，说「新兴趣」是假的，只能说「最近主要在这儿」 */
      L.push('最近一周的精力主要在这些地方：' + items.join('、') + '。')
    } else {
      L.push('最近一周才多起来的：' + items.join('、') + '。这可能是他现在在琢磨的事。')
    }
  }
  /* 他主动搜的问题，比任何统计都更接近「他眼下在想什么」 */
  const qs = ((raw.browser && raw.browser.searches) || [])
    .map((s) => String((s && s.q) || '').trim())
    .filter((q) => q.length >= 6 && /怎么|如何|有没有|能不能|为什么|是什么|哪个|要不要|值得|区别/.test(q))
    .slice(0, 3)
  if (qs.length) {
    L.push('他最近自己在查：' + qs.map((q) => '「' + q + '」').join('、') + '——这些多半是他眼下真在琢磨的事。')
  }
  if (style && style.top.length) {
    const names = style.top.map((x) => x.label).join('、')
    L.push((style.fromSearch ? '搜索的习惯偏' : '看的标题偏') + names + '，' +
      (style.top[0].key === 'learn' ? '遇到问题会先自己查清楚' :
        style.top[0].key === 'decide' ? '买东西/做选择之前会认真比' :
          style.top[0].key === 'curious' ? '喜欢把来龙去脉搞明白' : '习惯直接找现成的资源') + '。')
  }
  if (cross && cross.length) L.push('（这里有个矛盾，值得问问：' + cross[0].text + '）')
  return L.join('')
}

/* ------------------------------------------------------------ 总入口 */

/**
 * @param {object} raw   profile 的 raw.json 内容
 * @param {object} [opts] { health: health.stats() 的结果 }
 * @returns {{ok:boolean, at:number, themes:Array, rhythm:object, fresh:Array, style:object|null,
 *            cross:Array, narrative:string}}
 */
function build (raw, { health } = {}) {
  const empty = { ok: false, at: Date.now(), themes: [], rhythm: {}, fresh: [], style: null, cross: [], narrative: '' }
  if (!raw || typeof raw !== 'object') return empty
  const themes = themesOf(raw)
  const rhythm = rhythmOf(raw)
  const freshRes = freshnessOf(raw)
  const fresh = freshRes.list
  const style = styleOf(raw)
  const cross = crossOf(rhythm, health)
  const narrative = narrativeOf({ themes, rhythm, fresh, sparse: freshRes.sparse, style, cross, raw })
  return {
    ok: themes.length > 0 || !!narrative,
    at: Date.now(),
    themes,
    rhythm,
    fresh,
    sparse: freshRes.sparse,
    style,
    cross,
    narrative
  }
}

/** 给模型看的 md（也落盘成 insight.md，主人能在设置页看到她的判断） */
function mdOf (ins) {
  if (!ins || !ins.ok) return ''
  const L = []
  L.push('# 她眼中的你（自动推断，可能不准）')
  L.push('')
  L.push('> 全是从本机只读痕迹推出来的判断，不是事实记录。看到不对的地方，直接说「不对」，她就改。')
  L.push('')
  if (ins.narrative) {
    L.push('## 她的判断')
    L.push(ins.narrative)
    L.push('')
  }
  if (ins.themes.length) {
    L.push('## 兴趣主题（按分量排）')
    for (const t of ins.themes) {
      L.push('- **' + t.label + '**（' + t.score + ' 分）' + (t.ev.length ? '：' + t.ev.join('；') : ''))
    }
    L.push('')
  }
  const r = ins.rhythm || {}
  if (r.type) {
    L.push('## 作息')
    const bits = [r.type]
    if (r.peak) bits.push('活跃窗口 ' + r.peak)
    if (r.deepNightShare) bits.push('凌晨 0–5 点占 ' + Math.round(r.deepNightShare * 100) + '%')
    if (r.avgLast) bits.push('最晚记录中位数 ' + (function () {
      const hh = Math.floor(r.avgLast % 24)
      const mm = Math.round((r.avgLast % 1) * 60)
      return p2(hh) + ':' + p2(mm)
    })())
    L.push(bits.join(' · '))
    /* 关机时间是硬证据：他到底几点停手，比「最后一条浏览记录」准 */
    const hard = []
    if (r.avgUpHours) hard.push('平均每次开机 ' + r.avgUpHours + ' 小时')
    if (r.avgBootHour) hard.push('通常 ' + p2(Math.floor(r.avgBootHour)) + ' 点前后开机')
    if (r.lateShutdowns) hard.push('近两周凌晨关机 ' + r.lateShutdowns + ' 次')
    if (hard.length) L.push('设备运行：' + hard.join(' · '))
    L.push('')
  }
  if (ins.fresh && ins.fresh.length) {
    L.push(ins.sparse ? '## 最近一周主要在哪儿' : '## 最近新冒出来的（近 7 天 vs 前 7 天）')
    for (const f of ins.fresh) L.push('- ' + f.host + '：' + f.now + ' 次' + (f.before ? '（之前 ' + f.before + ' 次）' : ''))
    if (ins.sparse) L.push('> 历史数据只够覆盖最近几天，所以这里不判断「是不是新兴趣」。')
    L.push('')
  }
  if (ins.style && ins.style.top.length) {
    L.push('## 行为风格')
    L.push(ins.style.top.map((x) => x.label + ' ' + x.n + ' 次').join(' · ') + '（样本 ' + ins.style.total + ' 条' + (ins.style.fromSearch ? '，来自搜索词' : '，来自页面标题') + '）')
    L.push('')
  }
  if (ins.cross && ins.cross.length) {
    L.push('## 值得留意的矛盾')
    for (const c of ins.cross) L.push('- ' + c.text)
  }
  return L.join('\n').trim()
}

module.exports = { build, mdOf, themesOf, rhythmOf, freshnessOf, styleOf, lateHourByDay }
