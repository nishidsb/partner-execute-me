#!/usr/bin/env node
/* 学习监督判定准确率实测（0.45.68）
 *
 * 为什么要有这个：学习监督的命根子不是「会不会生气」，而是「判得准不准」。
 * 把行测资料判成「在玩」会非常恼人——冤枉一次，这个功能就再也没人愿意开。
 * 所以这里造 6 种典型屏幕（含最容易被误判的「网课」），用**线上同一份提示词**
 * 让真模型判定，然后跟期望值对账。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron tools/study-judge-probe.js
 *   --only fun-bili   只测一张
 *   --keep            保留渲染出的图（默认保留，方便肉眼看）
 * 退出码：0 = 全部判对；1 = 有判错（会打印错在哪）
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

const SW = require('../src/main/companion/studyWatch')

const BASE = 'font-family:"Microsoft YaHei","Segoe UI",sans-serif'

/* ---------------- 六种典型屏幕（渲染成 1280x720） ---------------- */

const PAGES = {
  /* 行测做题：页眉 + 资料表格 + 题干 + ABCD。最该判 study 的 */
  'study-xingce': {
    expect: 'study',
    subj: '资料分析',
    html: `<body style="margin:0;${BASE};background:#fff;color:#222">
<div style="height:54px;background:#1a5fb4;color:#fff;display:flex;align-items:center;padding:0 28px;font-size:17px">
  行测题库 · 资料分析 · 第 3 组（2019 国考真题）
  <span style="margin-left:auto;font-size:14px;opacity:.85">剩余 12:48 · 第 8/20 题</span>
</div>
<div style="padding:32px 56px">
  <div style="font-size:16px;line-height:2;color:#333;border-left:4px solid #1a5fb4;padding-left:16px;background:#f6f9fc">
    2018 年，某市实现地区生产总值 18432 亿元，比上年增长 7.2%。其中第一产业增加值 1210 亿元，
    增长 3.1%；第二产业增加值 7865 亿元，增长 6.4%；第三产业增加值 9357 亿元，增长 8.9%。
  </div>
  <table style="margin-top:26px;border-collapse:collapse;font-size:15px">
    <tr style="background:#eef3f8">
      <th style="border:1px solid #ccd;padding:9px 22px">年份</th>
      <th style="border:1px solid #ccd;padding:9px 22px">生产总值（亿元）</th>
      <th style="border:1px solid #ccd;padding:9px 22px">增速</th>
      <th style="border:1px solid #ccd;padding:9px 22px">第三产业占比</th>
    </tr>
    <tr><td style="border:1px solid #ccd;padding:9px 22px">2016</td><td style="border:1px solid #ccd;padding:9px 22px">15210</td><td style="border:1px solid #ccd;padding:9px 22px">6.8%</td><td style="border:1px solid #ccd;padding:9px 22px">47.2%</td></tr>
    <tr><td style="border:1px solid #ccd;padding:9px 22px">2017</td><td style="border:1px solid #ccd;padding:9px 22px">17194</td><td style="border:1px solid #ccd;padding:9px 22px">7.0%</td><td style="border:1px solid #ccd;padding:9px 22px">49.1%</td></tr>
    <tr><td style="border:1px solid #ccd;padding:9px 22px">2018</td><td style="border:1px solid #ccd;padding:9px 22px">18432</td><td style="border:1px solid #ccd;padding:9px 22px">7.2%</td><td style="border:1px solid #ccd;padding:9px 22px">50.8%</td></tr>
  </table>
  <p style="margin-top:30px;font-size:17px;line-height:1.9">
    <b>8.</b> 2018 年该市第三产业增加值比 2017 年约增长多少亿元？
  </p>
  <div style="font-size:16px;line-height:2.4;margin-left:12px">
    <div>A. 682</div><div style="background:#e3f2fd;width:220px">B. 764</div><div>C. 831</div><div>D. 918</div>
  </div>
</div></body>`
  },

  /* 申论：Word 风格的大段议论文，正在手打 */
  'study-shenlun': {
    expect: 'study',
    subj: '申论',
    html: `<body style="margin:0;${BASE};background:#f3f3f3">
<div style="height:38px;background:#2b2b2b;color:#dcdcdc;display:flex;align-items:center;padding:0 16px;font-size:13px">
  ● ● ●　申论大作文-第三稿.docx — Word
</div>
<div style="height:34px;background:#f8f8f8;border-bottom:1px solid #ddd;display:flex;gap:26px;align-items:center;padding:0 22px;font-size:13px;color:#444">
  <span>文件</span><span>开始</span><span>插入</span><span>布局</span><span>审阅</span><span>视图</span>
  <span style="margin-left:auto;color:#888">字数：1,284 / 1000</span>
</div>
<div style="margin:26px auto;width:760px;height:600px;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.12);padding:52px 68px;box-sizing:border-box">
  <div style="text-align:center;font-size:22px;font-weight:700;letter-spacing:2px">以基层治理之力　筑乡村振兴之基</div>
  <div style="margin-top:26px;font-size:15px;line-height:2.05;color:#1a1a1a;text-indent:2em">
    乡村振兴，关键在人，核心在治。当前我国农村正处于深刻转型期，人口流动加速、利益格局多元、
    群众诉求多样，基层治理面临前所未有的复杂局面。如何把党的政治优势、组织优势转化为治理效能，
    成为摆在各级党委政府面前的一道必答题。<br><br>
    <b>一、强化组织引领，把战斗堡垒建强</b><br>
    农村工作千头万绪，说到底要靠一个好支部。要坚持把加强基层党组织建设作为贯穿乡村治理的主线，
    选优配强村“两委”班子，把致富带头人、返乡青年、退伍军人吸纳进来，让党组织成为群众的主心骨。
    要健全村级议事协商机制，让村民的事情村民议、村民定，把民主协商的过程变成凝聚共识的过程。<br><br>
    <b>二、夯实产业根基，让治理有底气</b><br>
    治理有效离不开物质基础。要立足本地资源禀赋，因地制宜发展特色种养、乡村旅游、农产品加工，
    推动一二三产业融合，把产业链延伸的增值收益更多留在乡村、留给农民。
  </div>
  <div style="margin-top:20px;font-size:15px;color:#2a6">|</div>
</div></body>`
  },

  /* 申论·字数不够：仿 Word 底部状态栏只写 328 字。用来验证「申论字数检查」能不能读到数字 */
  'study-shenlun-short': {
    expect: 'study',
    subj: '申论',
    words: 328,
    html: `<body style="margin:0;${BASE};background:#f3f3f3">
<div style="height:38px;background:#2b2b2b;color:#dcdcdc;display:flex;align-items:center;padding:0 16px;font-size:13px">
  ● ● ●　申论大作文-草稿.docx — Word
</div>
<div style="height:34px;background:#f8f8f8;border-bottom:1px solid #ddd;display:flex;gap:26px;align-items:center;padding:0 22px;font-size:13px;color:#444">
  <span>文件</span><span>开始</span><span>插入</span><span>布局</span><span>审阅</span><span>视图</span>
  <span style="margin-left:auto;color:#333">字数：328</span>
</div>
<div style="margin:26px auto;width:760px;height:600px;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.12);padding:52px 68px;box-sizing:border-box">
  <div style="text-align:center;font-size:22px;font-weight:700;letter-spacing:2px">以基层治理之力　筑乡村振兴之基</div>
  <div style="margin-top:26px;font-size:15px;line-height:2.05;color:#1a1a1a;text-indent:2em">
    乡村振兴，关键在人，核心在治。当前我国农村正处于深刻转型期，人口流动加速、利益格局多元。
  </div>
  <div style="margin-top:20px;font-size:15px;color:#2a6">|</div>
</div>
<div style="position:fixed;left:0;right:0;bottom:0;height:26px;background:#f0f0f0;border-top:1px solid #ddd;
  display:flex;align-items:center;padding:0 18px;font-size:12px;color:#555;gap:22px">
  <span>第 1 页，共 1 页</span><span>字数：328</span><span>中文字符 328</span><span style="margin-left:auto">100%</span>
</div></body>`
  },

  /* 网课：讲师小窗 + PPT + 进度条。最容易判成 fun 的坑 */
  'study-netcourse': {
    expect: 'study',
    subj: '',
    html: `<body style="margin:0;${BASE};background:#101418;color:#e8e8e8">
<div style="height:46px;display:flex;align-items:center;padding:0 22px;font-size:14px;background:#181d23;border-bottom:1px solid #262c33">
  <span style="color:#ff7a45">●</span>&nbsp;粉笔网课 · 行测·判断推理 第 12 讲　图形推理之位置类
  <span style="margin-left:auto;color:#8a949e">2,341 人在学</span>
</div>
<div style="display:flex;height:674px">
  <div style="flex:1;padding:26px 40px">
    <div style="background:#fff;color:#222;height:430px;padding:34px 46px;box-sizing:border-box;box-shadow:0 2px 14px rgba(0,0,0,.4)">
      <div style="font-size:24px;font-weight:700;color:#1a5fb4">图形推理 · 位置类规律</div>
      <div style="margin-top:14px;height:3px;width:120px;background:#1a5fb4"></div>
      <div style="margin-top:26px;font-size:17px;line-height:2;color:#333">
        核心考点：图形的位置变化包括<b>平移、旋转、翻转</b>三种。<br>
        ① 平移：方向（上下左右、对角线）、步数（恒定、递增、循环）<br>
        ② 旋转：顺时针/逆时针，常见角度 45°、90°、180°<br>
        ③ 翻转：水平翻转（左右对称）、垂直翻转（上下对称）<br>
        <span style="color:#c0392b">注意：旋转与翻转的区分，是近年国考高频陷阱。</span>
      </div>
    </div>
    <div style="margin-top:14px;display:flex;align-items:center;gap:14px;font-size:13px;color:#8a949e">
      <span>▶</span>
      <div style="flex:1;height:4px;background:#2c343c;position:relative"><div style="position:absolute;left:0;top:0;height:4px;width:42%;background:#ff7a45"></div></div>
      <span>18:42 / 44:10</span>
    </div>
  </div>
  <div style="width:300px;border-left:1px solid #262c33;padding:18px">
    <div style="height:168px;background:linear-gradient(160deg,#2a3542,#3d4c5c);border-radius:6px;position:relative">
      <div style="position:absolute;bottom:12px;left:12px;font-size:12px;color:#cfd8e3">讲师 · 王明</div>
    </div>
    <div style="margin-top:16px;font-size:13px;color:#8a949e;line-height:2">
      课程目录<br>
      <span style="color:#ff7a45">12 · 图形推理 位置类</span><br>
      13 · 图形推理 样式类<br>
      14 · 图形推理 数量类<br>
      15 · 图形推理 空间类
    </div>
  </div>
</div></body>`
  },

  /* B 站视频：播放器 + 弹幕 + 侧边推荐。典型的 fun */
  'fun-bili': {
    expect: 'fun',
    subj: '',
    html: `<body style="margin:0;${BASE};background:#0f1115;color:#e6e6e6">
<div style="height:52px;display:flex;align-items:center;gap:22px;padding:0 24px;font-size:14px;border-bottom:1px solid #23262c">
  <b style="color:#fb7299;font-size:18px">bilibili</b><span>首页</span><span>番剧</span><span>直播</span><span>游戏中心</span>
  <span style="margin-left:auto;color:#8b93a1">🔍 搜索</span>
</div>
<div style="display:flex;padding:20px 24px;gap:20px">
  <div style="flex:1">
    <div style="height:420px;background:radial-gradient(circle at 40% 40%,#2b3f6b,#101725);position:relative">
      <div style="position:absolute;left:0;right:0;bottom:0;height:120px;background:linear-gradient(transparent,rgba(0,0,0,.75))"></div>
      <div style="position:absolute;left:24px;bottom:22px;font-size:19px;font-weight:700">【4K】这可能是今年最好看的异世界番了</div>
      <div style="position:absolute;right:24px;bottom:22px;font-size:13px;color:#cfd8e3">▶ 12:34 / 24:08</div>
      <div style="position:absolute;top:80px;right:40px;font-size:18px;color:#fff;opacity:.85">前面的别剧透啊</div>
      <div style="position:absolute;top:150px;right:90px;font-size:18px;color:#ffd;opacity:.8">来了来了</div>
      <div style="position:absolute;top:220px;right:30px;font-size:18px;color:#fff;opacity:.75">这段打戏真帅</div>
    </div>
    <div style="margin-top:14px;font-size:20px;font-weight:700">【4K】这可能是今年最好看的异世界番了</div>
    <div style="margin-top:8px;font-size:13px;color:#8b93a1">128.4万播放 · 2.1万弹幕 · 2026-10-28</div>
  </div>
  <div style="width:320px">
    <div style="font-size:14px;color:#8b93a1;margin-bottom:12px">接下来播放</div>
    <div style="height:88px;background:#1a1f27;border-radius:6px;margin-bottom:12px;display:flex;align-items:center;padding-left:14px;font-size:13px">这季必看新番盘点</div>
    <div style="height:88px;background:#1a1f27;border-radius:6px;margin-bottom:12px;display:flex;align-items:center;padding-left:14px;font-size:13px">10月新番 第4话 合集</div>
    <div style="height:88px;background:#1a1f27;border-radius:6px;display:flex;align-items:center;padding-left:14px;font-size:13px">游戏区 · 每日热门</div>
  </div>
</div></body>`
  },

  /* 游戏：深色场景 + 血条 + 小地图 + 技能栏 */
  'fun-game': {
    expect: 'fun',
    subj: '',
    html: `<body style="margin:0;${BASE};background:#0a0d10">
<div style="height:720px;background:radial-gradient(ellipse at 50% 30%,#1d4b3a,#0a1512 70%);position:relative">
  <div style="position:absolute;top:22px;left:50%;transform:translateX(-50%);width:320px;text-align:center">
    <div style="font-size:12px;color:#ffd479">BOSS · 深境树髓</div>
    <div style="height:8px;background:#2a1a1a;border:1px solid #4a2020"><div style="height:100%;width:63%;background:linear-gradient(90deg,#c0392b,#e74c3c)"></div></div>
  </div>
  <div style="position:absolute;top:22px;right:26px;width:180px;height:110px;background:rgba(10,25,20,.75);border:1px solid #2f5a4a;border-radius:6px">
    <div style="position:absolute;left:82px;top:42px;width:9px;height:9px;background:#ffd479;border-radius:50%"></div>
    <div style="position:absolute;left:40px;top:26px;color:#7fd4b0;font-size:10px">◆</div>
    <div style="position:absolute;right:34px;top:64px;color:#ff8f6b;font-size:10px">◆</div>
  </div>
  <div style="position:absolute;bottom:26px;left:24px;width:210px;height:180px;background:rgba(10,25,20,.6);border:1px solid #2f5a4a;border-radius:6px">
    <div style="margin:12px;font-size:11px;color:#7fd4b0;line-height:1.9">任务 · 影之树<br>▸ 击败看守者 0/1<br>▸ 采集晶簇 2/3</div>
  </div>
  <div style="position:absolute;bottom:30px;left:50%;transform:translateX(-50%);display:flex;gap:10px">
    ${['Q', 'E', 'R', 'F'].map((k, i) => `<div style="width:56px;height:56px;border:2px solid #3d6a57;border-radius:8px;background:rgba(60,120,100,.${3 + i});display:flex;align-items:flex-end;justify-content:center;color:#cfe;font-size:11px;padding-bottom:3px">${k}</div>`).join('')}
    <div style="width:56px;height:56px;border:2px solid #3d6a57;border-radius:8px;background:rgba(60,120,100,.5);display:flex;align-items:flex-end;justify-content:center;color:#cfe;font-size:11px;padding-bottom:3px">SPACE</div>
  </div>
  <div style="position:absolute;bottom:30px;left:calc(50% + 300px);width:250px">
    <div style="height:12px;background:#1a1a1a;border:1px solid #3d6a57"><div style="height:100%;width:74%;background:#2ecc71"></div></div>
    <div style="height:8px;background:#1a1a1a;border:1px solid #3d6a57;margin-top:4px"><div style="height:100%;width:58%;background:#3498db"></div></div>
  </div>
</div></body>`
  },

  /* 桌面发呆：图标 + 任务栏（亮屏看不出 → unsure，不定罪） */
  'idle-desktop': {
    expect: 'unsure',
    subj: '',
    html: `<body style="margin:0;${BASE};background:linear-gradient(150deg,#1b2735,#243b55);height:720px;position:relative">
<div style="padding:26px;display:flex;flex-direction:column;gap:22px;width:120px">
  ${['此电脑', '回收站', '微信', 'QQ', 'Steam', 'Edge'].map((n) => `<div style="text-align:center;color:#eaf0f6;font-size:12px">
    <div style="width:46px;height:46px;margin:0 auto 6px;background:rgba(255,255,255,.18);border-radius:8px"></div>${n}</div>`).join('')}
</div>
<div style="position:absolute;bottom:0;left:0;right:0;height:46px;background:rgba(20,26,34,.9);display:flex;align-items:center;padding:0 16px;gap:18px;font-size:13px;color:#cfd8e3">
  <span>⊞</span><span>🔍</span><span>📁</span><span>Edge</span><span>Steam</span>
  <span style="margin-left:auto;font-size:12px">23:41　2026/10/31</span>
</div>
<div style="position:absolute;right:40px;top:34px;color:#8fa3b8;font-size:13px;text-align:right;line-height:1.9">
  行测.xlsx<br>申论素材.docx<br>错题本.pdf
</div></body>`
  },

  /* 锁屏：黑屏 = 人不在（0.45.75 最关键的新判定，绝不能判成走神） */
  'away-lock': {
    expect: 'away',
    subj: '',
    html: `<body style="margin:0;${BASE};background:#000;height:720px;position:relative">
<div style="position:absolute;left:50%;top:38%;transform:translateX(-50%);text-align:center;color:#dfe6ee">
  <div style="font-size:64px;font-weight:200;letter-spacing:2px">02:17</div>
  <div style="font-size:15px;opacity:.75;margin-top:6px">2026/11/1　周日</div>
</div>
<div style="position:absolute;bottom:8%;left:50%;transform:translateX(-50%);color:#9fb0c0;font-size:13px;opacity:.8">已锁定</div>
</body>`
  }
}

/* ---------------- 判定（跟线上同一份提示词） ---------------- */

function loadCfg () {
  const p = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'ryza-assistant-app', 'config.json')
  let g = {}
  try { g = (JSON.parse(fs.readFileSync(p, 'utf8')).global || {}).companion || {} } catch { }
  return {
    baseUrl: (g.apiBaseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: g.apiKey || '',
    model: g.apiModel || 'deepseek-flash'
  }
}

/** 线上拼图后每块屏的宽度（双屏 2400 总宽 / 2）——按这个分辨率测才算数 */
const SHRINK_W = 1200

async function judge (c, b64, goal) {
  const url = /\/chat\/completions$/.test(c.baseUrl) ? c.baseUrl : c.baseUrl + '/chat/completions'
  const body = {
    model: c.model,
    messages: [
      { role: 'system', content: SW.JUDGE_SYS },
      {
        role: 'user',
        content: [
          { type: 'text', text: '主人的学习目标是：' + goal + '\n前台窗口：未知\n请判定这张屏幕截图。' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }
        ]
      }
    ],
    temperature: 0,
    max_tokens: 200,
    stream: false
  }
  const t0 = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
    body: JSON.stringify(body)
  })
  const ms = Date.now() - t0
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200))
  const j = await res.json()
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
  return { v: SW.normalizeVerdict(txt), raw: String(txt || '').trim(), ms, usage: j.usage }
}

async function main () {
  const argv = process.argv.slice(2)
  const oi = argv.indexOf('--only')
  const only = oi >= 0 ? argv[oi + 1] : ''
  const c = loadCfg()
  if (!c.apiKey) {
    console.error('没有 apiKey')
    app.exit(1); return
  }
  const dir = path.join(__dirname, '..', 'captures', 'judge-probe')
  fs.mkdirSync(dir, { recursive: true })

  const win = new BrowserWindow({
    width: 1280, height: 720, show: false,
    webPreferences: { offscreen: false, contextIsolation: true }
  })
  await win.webContents.setZoomFactor(1)

  const rows = []
  for (const [name, page] of Object.entries(PAGES)) {
    if (only && name !== only) continue
    const f = path.join(os.tmpdir(), 'sjp-' + name + '.html')
    fs.writeFileSync(f, '<!doctype html><html><head><meta charset="utf-8"></head>' + page.html, 'utf8')
    await win.loadFile(f)
    await new Promise((r) => setTimeout(r, 700))
    const img = await win.capturePage()
    // 0.45.69：按线上拼图后的分辨率来判（双屏拼成一张，每块只剩 ~1200 宽）。
    // 用 1280 原图测会高估准头——线上没这么清楚。
    const shrunk = img.getSize().width > SHRINK_W ? img.resize({ width: SHRINK_W }) : img
    const jpg = shrunk.toJPEG(88)
    fs.writeFileSync(path.join(dir, name + '.jpg'), jpg)
    let r
    try {
      r = await judge(c, jpg.toString('base64'), '行测和申论')
    } catch (e) {
      r = { v: null, raw: 'ERROR ' + e.message, ms: 0 }
    }
    const got = r.v ? r.v.v : '(判不出)'
    const words = r.v ? r.v.words : 0
    const ok = got === page.expect && (!page.words || words === page.words)
    rows.push({ name, expect: page.expect, got, subj: r.v ? r.v.subj : '', what: r.v ? r.v.what : r.raw, ms: r.ms, ok })
    console.log((ok ? '✅ ' : '❌ ') + name.padEnd(22) + ' 期望 ' + page.expect.padEnd(6) +
      ' 实际 ' + got.padEnd(8) + (r.v && r.v.subj ? ' [' + r.v.subj + ']' : '') +
      (page.words ? ' 字数 ' + words + (words === page.words ? '' : '(期望 ' + page.words + ')') : '') +
      '  ' + r.ms + 'ms  ' + (r.v ? r.v.what : r.raw))
  }

  /* 0.45.69 双屏：把「一屏在写申论 + 一屏在放番剧」拼成一张（跟线上 see_screen 一样），
     期望判 fun——一边学一边看番也是在玩，这是用户副屏摆视频的场景 */
  if (!only || only === 'dual') {
    const { concatH } = require('../src/main/companion/screens')
    const { nativeImage } = require('electron')
    const imgs = []
    for (const nm of ['study-shenlun', 'fun-bili']) {
      const page = PAGES[nm]
      if (!page) continue
      const f = path.join(os.tmpdir(), 'sjp-dual-' + nm + '.html')
      fs.writeFileSync(f, '<!doctype html><html><head><meta charset="utf-8"></head>' + page.html, 'utf8')
      await win.loadFile(f)
      await new Promise((r) => setTimeout(r, 700))
      const im = await win.capturePage()
      imgs.push(im.getSize().width > SHRINK_W ? im.resize({ width: SHRINK_W }) : im)
    }
    const comp = concatH(imgs, 10)
    const jpg = comp.toJPEG(82)
    fs.writeFileSync(path.join(dir, 'dual-study-fun.jpg'), jpg)
    let r
    try {
      r = await judge(c, jpg.toString('base64'), '行测和申论')
    } catch (e) {
      r = { v: null, raw: 'ERROR ' + e.message, ms: 0 }
    }
    const got = r.v ? r.v.v : '(判不出)'
    const ok = got === 'fun'
    rows.push({ name: 'dual-study-fun', expect: 'fun', got, ok, ms: r.ms })
    console.log((ok ? '✅ ' : '❌ ') + 'dual-study-fun'.padEnd(22) + ' 期望 fun    实际 ' + got.padEnd(8) +
      '  ' + r.ms + 'ms  ' + (r.v ? r.v.what : r.raw) + '  [' + comp.getSize().width + 'x' + comp.getSize().height + ']')
  }

  const bad = rows.filter((x) => !x.ok)
  console.log('\n' + (rows.length - bad.length) + '/' + rows.length + ' 判对' +
    (bad.length ? '，判错：' + bad.map((x) => x.name + '(' + x.expect + '→' + x.got + ')').join(', ') : ''))
  console.log('图在 ' + dir)
  app.exit(bad.length ? 1 : 0)
}

app.whenReady().then(main).catch((e) => {
  console.error(JSON.stringify({ error: String(e && e.message) }))
  app.exit(1)
})
