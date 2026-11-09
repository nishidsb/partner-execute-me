# Ryza Assistant（Partner.execute(me);）项目完全导读 · 0.49.4

> ## ⚡ AI 协作守则（每个 AI 会话开始时默认执行，无需用户提醒）
>
> 1. **动手前先读本文件**：零上下文接手时，读完本文件即可理解项目全貌、现状与红线。
> 2. **每次功能修改必须同步本文件**——这是硬性流程，不是可选项。任何代码改动（新功能、
>    修 bug、调参、部署、事故修复）完成后，**当场**更新本文件对应章节，并同步：
>    - 第四部分：该功能所属小节的实现描述（含新常量、新文件、新坑）
>    - 第六部分：版本时间线加行
>    - 第七部分：当前进度与未验证清单（已验证的移出、新增的补入）
>    - 第十部分：踩坑记录（凡属「下次还会踩」的教训）
> 3. **文档与程序进度彻底同步**：本文件的状态标记（✅🟡⏸❌）必须与真实部署状态一致——
>    代码写完 ≠ ✅，真机验证过才算。宁可写「未验证」，不可写「已完成」。
> 4. **项目底层要求**：**活人感 + 陪伴感**（详见 §1.0）。一切设计取舍以此为最高准绳——
>    无论什么要求都是基于这两点完成的；与其中任一点冲突的优化（哪怕更省成本）要先问主人。
> 5. 更细的逐版本记录见 `docs/HANDOFF-*.md`（10-25 / 10-29 / 11-02）与 `docs/FEATURE_0xx.md` 系列；
>    验收操作见 `docs/TESTING.md`；源码注释密度极高，每处修改都注明了动机与版本号。
>
> 状态标记约定：✅ 已实现且已验证 ｜ 🟡 已实现、代码/测试就绪但未真机验证 ｜ ⏸ 已实现但暂停 ｜ ❌ 明确不做

---

# 第一部分 · 项目是什么

## 1.0 项目底层要求（最高准绳）：活人感 + 陪伴感

**让角色活着，并产生陪伴的感觉——活人感与陪伴感，两者缺一不可。**

这是主人 2026-11-08 拍板的**项目底层要求**（承接并扩展 11-02 的「让角色有活着的感觉」）：
**无论什么要求、什么功能，都是在基于这两点的情况下完成的**——任何新功能、任何取舍，
先过这两问，过不了就不做或先请示主人：

1. **活人感（她是活的）**：她的每句话、每个动作、每次「自己待着」都要有**在场感与连续性**——
   不是被调用的 API，而是一个住在桌面上的存在：会自己想事、会记得昨天、会根据你此刻
   在做什么决定说不说。判定标准是**用户的直觉体验**（「她像是活的」），不是功能清单。
   新功能先问：这让她更活，还是更像程序？
2. **陪伴感（她在共同生活）**：陪伴 ≠ 注意力交换（详见红线 §5.15）。她开口是因为
   「你的状态值得她说一句」或「你们有共同的生活」，不是「你多久没理她」；她沉默时
   也在场——看得见她的生活（她在写作/翻书/打盹），有共同经历的痕迹（接得住旧话头），
   偶尔真实地需要你（一天最多一次的合理时机），而不是阶梯式索取。
   新功能先问：这带来的是陪伴，还是被纠缠的愧疚感？

- 与此相关的既有支柱：rhythm 开口节奏（人类式不均匀间隔）、需求压力、内心戏与日记、
  自主活动与自言自语（0.46.0）、记忆衰减与事实守护、情绪与负反馈、attentive 状态触发
  与 echo 痕迹注入（0.47.0）。
- 成本可控仍是约束，但为「活人感/陪伴感」让路时**先请示主人**，不自作主张砍体验。

## 1.1 一句话

**单人自用的 Windows AI 桌面伙伴**：透明桌面层上住着一只 2D/3D 桌宠角色「莱莎」，
她有长期记忆、情绪、内心活动，能陪你聊天、看你的屏幕陪你、替你操作电脑、在 QQ 上找你、
替你刷 B 站、监督你学习。产品名 **Partner.execute(me);**（致敬 Mili 歌曲），包名 `ryza-assistant-app`。

## 1.2 产品定位（三层，锁定不动，见 `docs/SCOPE.md`）

1. **桌面伙伴**——桌宠：Spine/VRM/立绘/形象包渲染、触摸反应、走动/坐下、气泡对话
2. **有记忆的 AI 角色**——多角色、独立人格与记忆、情绪与自我状态、语言守卫
3. **个人助手**——CUA 电脑操作、Shell 工具、刷B站值班、FF14 工具组、学习监督

## 1.3 用户画像（决定一切设计取舍）

- **单人自用**。主人 = QQ `10001`。角色 QQ 号 = `10002 (reisa)`。
- 角色「莱莎」**说日语、显示中文**（TTS 念日语，气泡/字幕显示中文翻译；QQ 纯文字通道只发中文译文）。
- 一切以「像活的、陪伴感、成本可控」为目标；**不做**多用户、分发、自动更新（主人 2026-10-26 拍板）。
- 主人是中文用户，机器是 Windows 多屏（副屏在左）。

## 1.4 出身与法律红线

- 代码基础复制自 **AuraDesk v0.3.0**（本机 MIT 源码），其遗留产品功能（游戏库/任务栏/音乐播放器等）已全部移除，数据目录完全隔离。
- 开发中对齐过三个参考项目（**只对齐功能与行为，不拷源码**，全表见 `docs/FEATURE_PARITY.md`）：
  Coopanion（桌宠完整形态，AGPL-3.0）、dsh-bili-scroll（刷B站，MIT）、dsh-fish-buddy（陪看/弹幕）。
- **开源仓库 `partner-execute-me` 只放干净代码**：莱莎 Spine 素材（AgentAtelierR 解包的 aes 加密 aarpack，
  解密工具 `app/tools/unpack-aarpack.js`）与莱莎2 官方 g1a 动画烘焙产物是**破解产物，绝不能进开源仓库或任何公开发布**。
- 开源版已做 Spine 剥离（libs.js public 版 + showSpine 守卫）。

---

# 第二部分 · 总体架构

## 2.1 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Electron 32（NSIS + portable 双打包，electron-builder 24） |
| 主进程 | 原生 JS（CJS），入口 `src/main/main.js` |
| 助手核心 | `src/assistant/core/` —— **ESM 零第三方依赖**（可独立 CLI 运行），主进程动态 import 桥接 |
| 渲染层 | 原生 JS，无框架；Spine 用 @esotericsoftware spine-webgl/canvas **四版本运行时（4.0/4.1/4.2/4.3）** |
| 3D | three 0.186 + @pixiv/three-vrm 3.5.5 |
| 系统操作 | koffi FFI 直调 user32/gdi32（CUA 引擎在独立子进程） |
| LLM | 默认 DeepSeek（thinking + reasoning_content 回传，400 时压平兜底）；14 家厂商预设 |
| 存储 | **全部 JSON/MD 文件**，零数据库；记忆 git 快照可回滚 |
| OCR | PP-OCRv6 ONNX 常驻 python 子进程（复用 bili-duty venv） |
| 本地转写/TTS | faster-whisper venv、GPT-SoVITS、IndexTTS（python 子进程懒启动） |

## 2.2 进程与窗口体系（main.js，1517 行）

| 窗口/进程 | 说明 |
|---|---|
| **overlay 桌面层**（每块屏一个，Map key=显示器稳定 key） | 透明无边框置底层，加载 `renderer/overlay/index.html`（桌宠渲染+气泡+输入条+右键菜单）。`backgroundThrottling:false` + powerSaveBlocker 防合成挂起 |
| **主窗** | `companion.createWindow('chat'/'char'/'settings')` —— 聊天和角色是同一窗口的两个视图，全部设置都在这（七个分页） |
| 装扮窗 / CUA 确认窗（自绘 60s 倒计时）/ 弹幕窗 / 框字幕选区层 / World 扩展面板 | 各自独立 preload |
| CUA 引擎子进程 | fork + koffi，FFI 崩溃只死 worker 自动重启 |
| fullscreen 探测 / launcher worker / OCR / 本地 TTS | 常驻 PowerShell / python 子进程，退出时全部收掉；PS worker 均带内存看门狗（0.46.3，§4.11） |

关键窗口机制：
- **显示器稳定 key**：EDID（厂商/型号/序列号/年份）SHA1 前 10 位，跨重启不漂移；每屏独立开关。
- **热区穿透**：渲染层上报热区矩形 + 48×84 alpha 像素掩码 → 主进程 **80ms 光标轮询**命中才
  `setIgnoreMouseEvents(false)`，基线恒穿透。CUA 动作期间禁止翻转（`cuaParked`）。
- **全屏让位**：前台全屏时整层 hide（防 MPO 降级黑帧），恢复 showInactive。
- **GPU watchdog**：GPU 进程崩溃 2.5s 后重载；启动前 90s 监视 GPU 恢复即重载（治开机自启白底）。
  启动开关含 `disable-accelerated-2d-canvas`（明确**不可**加 disable-gpu-compositing——透明窗会变灰）。
- **aura:// 协议**：privileged scheme，本地素材统一走它（Chromium 拦 file:// fetch，Spine/GLTF 需要）。
- 单实例锁；`--capture` 截图模式例外。

## 2.3 目录地图

```
src/main/                 主进程
  main.js                 窗口/托盘/热键/GPU watchdog/游戏模式自动进出
  companion/              ★陪伴与角色编排（45 个模块，§4 主体）
  assistant/              助手宿主桥（index.js 1183 行、chatgptAuth、modelCaps、userTools 沙箱）
  im/                     QQ/微信（onebot.js、brain.js 群聊大脑、napcat-guard、pc-tools、wx.js）
  cua/                    电脑操作（engine 子进程 / geometry 纯函数 / confirm 确认窗）
  bili/                   刷B站（client WBI 签名、duty 值班 runner、transcribe）
  ff14/                   FF14 工具组（13 个工具）
  world/                  World 扩展（契约/市场/熔断）
  profile/                电脑画像（13 文件 3852 行：browser/keys/insight/today/usage/files/...）
  health/                 健康记录
  根下零散：danmaku.js 游戏弹幕、obs.js 画面导出、remote.js 随身服务(手机)、
           launcher.js、gameAuto/gameMode/gameLib/match、fullscreen.js、
           factGuard.js、image-hash.js、datadir.js、store.js、systemBridge.js
src/assistant/core/       独立助手核心（ESM 零依赖：session/记忆/工具/4 协议/14 厂商表）
src/renderer/overlay/     桌面层：pet.js 2776 行（渲染管线）+ app.js（热区/缩放/壁纸）
src/renderer/companion/   主窗（设置页全部 UI，app.js 4123 行）
src/renderer/assistant/   聊天窗（CUA 面板/记忆面板/模型面板）
src/shared/               双端共享：i18n.js、reply-text.js、spine-words.js、anim-catalog.js、anim-pool.js
src/preload/              每窗口一个桥（overlay 103 行 / companion 220 行 / ...）
test/                     103 个测试文件（node --test）
tools/                    audit.js / wirecheck.js / smoke.js + 素材解包/烘焙工具链
docs/                     FEATURE_0xx 规格 + HANDOFF 交接 + TESTING 验收 + SCOPE
```

## 2.4 数据落盘总表

| 位置 | 内容 |
|---|---|
| `%APPDATA%\ryza-assistant-app\`（或便携版 `程序目录\data\`，见 datadir.js） | 全部数据 |
| `characters.json` | 角色卡（**改前必备份**；UI 会归一化路径分隔符） |
| `companion/<charId>/history.json` | 对话账本（截 200 条） |
| `data/memory/<roleId>.json`（助手核心侧） | 长期记忆账本（≤1000 条事实） |
| `<workspace>/PARTNER.md` + `.git` | 「她认识的人」档案 + git 快照可回滚 |
| `data/usage.json` | token 用量（90 天滚动） |
| `im/` | QQ config/history/qq-reach 账 |
| `companion/self/` | events jsonl（唯一真相源）/ days 日记 / state.json 情绪 / habits / tastes |
| `bili-duty/` | 刷B站 config/seen.md/out/digest/state |
| `pc-profile/` | 画像 raw + 13 种 md（keys/ 子目录 = 键盘记录，0600 权限，永不进 logger） |
| `health/log.jsonl` | 健康记录 |
| `logs/main.log` | **排查第一入口** |
| `%TEMP%\auradesk-cards.json` + `ryza-pet.json` | 与 AuraDesk 卡片联动通道（双向各写各的） |

---

# 第三部分 · 一次对话的完整生命周期

```
入口（六选一）：桌面悬停输入条 / 主窗输入框 / 全局热键语音 / 手机随身服务 / QQ·微信 / 气泡提问
  → assistant:send（或 companion:send 旧管线）
  → 上下文装填（companion/index.js 管线 或 assistant/core/session.js）：
      persona 人设 + worldBook 关键词命中 + memory.recall（关键词×重要度×强度）
      + self.promptBlock（情绪/日记/习惯，≤2000 token）+ style few-shot + user-profile
      + 电脑画像/健康/今天切片 + 陪看字幕白板 + context.assemble 预算装填
  → llm.chatStream：SSE 流式 + 工具调用自动续轮（≤4~5 轮）+ reasoning_content 回填
      ↳ 工具：petTools 10 个 / 助手核心 40+ 个 / CUA 12 个 / FF14 13 个（见 §4 各节）
  → 回复流式推给渲染层：气泡打字机 + 状态气泡 + anim-pool 选动画 + 朗读
  → 出口清洗（reply-text.plainText：剥（QQ）前缀 + 丢括号译文）
  → TTS 回退链：Fish→OpenAI→SoVITS→IndexTTS→系统语音
  → 落账：history.json + inner.noteSay + memory 自动提取 + assistant 侧 memoryStore
```

**主动开口的生命周期**（所有主动通道共用）：
```
素材产生（watch 截屏观察 / chatter 决策 / curiosity / 时间事件 / 闲置阶梯）
→ rhythm.ask(kind) 拿开口许可（全局唯一节奏器，谁也不能绕过）
→ presence 确认人在 → voicesim.isRepeat 复读硬闸（同一句话全应用只说一次）
→ sayProactive / sayNarration（气泡+可选朗读）或 deliverReach（QQ，只发译文）
→ noteSpoke 记账：reachRec（25~90min 随机 nextAt）+ nudgeRec.lastProactiveAt
   —— 桌面出口和 QQ 出口共用一本账，两边只算一次（0.45.97）
```

---

# 第四部分 · 功能规格与实现（逐域详述）

> 每节格式：**需求来源 → 实现机制（含关键常量）→ 关键文件 → 测试 → 状态**

## 4.1 桌宠渲染（四套形象，同一舞台）

**需求来源**：用户要求形象可换、动作像活的；3D 搞不好后拍板「转投 Spine，动作从本地 AgentAtelierR 提取」（11-01）。

- **舞台结构**（overlay/index.html）：`#petStage` 内四套载体并排——立绘 img / Spine canvas / VRM canvas / 形象包 canvas + ✦ 兜底。
- **Spine 渲染**：`detectSpineVersion()` 读 .skel 头取版本 → 锁定对应运行时；WebGL 优先（离屏画→每帧 blit 到 2D canvas，绕开透明薄纱合成 bug；预乘 PMA；相机锁 setup pose 包围盒；`webglcontextlost` 自愈重建）。渲染循环忙/闲双档帧率（忙默认 30fps、闲减半、hidden 跳帧）——**桌面层被覆盖时 rAF 会暂停，必须用定时器渲染**（四套渲染共同的教训）。
- **当前主形象**（characters.json）：`0005_01` 白蓝比基尼**坐姿 rig**；坐卡/坐下自动切 `0001_01` 常服坐姿骨架（867 条动画，含拍手/比耶/耳语/伸懒腰等富动作），起身切回。`applySpineSkelMode` 只允许同一套皮肤之间切换 + Promise 串行化防连发插队。
- **VRM/GLB**（⏸ 暂停，恢复路径未测试）：three-vrm，程序化眨眼（2.6~6.2s 随机）/口型（aa 跟 TTS）/走路；371 个官方 g1a 动画烘入过（RDP 抽稀 56.5→36.6MB）。0.45.89 起 `OFFICIAL_CLIPS_ON=false` 官方 clip 全停用（烘入动作有瑕疵），改程序化手势。恢复 = 把 vrm 路径填回 `visual.vrm`。
- **形象包 API 2**（✅ 0.5.0）：zip + 声明式 figure.json（`api:2`），**只接受声明式图层（形状/图片/颜色），不执行任何脚本**（比 iframe 沙箱彻底）；装扮维度由包自己声明（axes），双色通道 `c:main`/`c:acc`；独立装扮窗、原子安装、深度 3 层 128MB 上限；0.41.0 补侧身走/口型/part needs。
- **动作词解析** `findAnim` 三级：① `spine-words.js`（由 `tools/gen-spine-words.js` 生成：词典 **1:1 对照抄自 AgentAtelierR 权威源 `scripts/export_ryza_motion_catalog.cjs`**（报告 `docs/RYZA_MOTION_GROUP_CATALOG.md`，坐姿 95 组/站姿 53 组全解析）；目录 sit 95 组 + stand 53 组全覆盖，词表 278 词（手工 31 + 自动派生），每组含 `layer`（FG 手势/B/C/EH/I/J）与 `off` 标记——资源 Label 注明「使わない」的 7 组（fg_017/122/123/124/222/223/224）不出词；重跑 `node tools/gen-spine-words.js` 随素材更新）② 动画名精确/包含匹配 ③ `ACTION_SEMANTICS` 语义词正则。`playSpineAction` 分轨播放（facial→轨5 / oneshot→轨0 接回 idle / 其余叠加轨1..3 播完保持 4s 淡出）。**已验证**：sit 骨架 115 个动画名与 gesture.json 全部对应（skel 二进制实搜）；FG 手势是手臂叠加层，不影响坐姿底座。
- **语义动作自动调用**（✅ 0.46.9，1:1 抄自 AgentAtelierR `character_performance.dart`）：模型可在回复正文嵌 `[action:语义标签]` 或直接 `[action:grp_fg_106]`，`petBridge.extractInlineAct` 剥标记归一成 `action:xxx` 词走 `pet_act` 链路，渲染层 `playSemanticAction` 按当前骨架（sit/stand）从 `spine-actions.js` 计划（`_seatedActionPlans`/`_standingActionPlans` 11 标签×2 姿态，含 oneShot 回退 `motion_oneshot_D_001~012`）依次试播，全不中回退 D 系一次性动画。提示词三处已写规则（`session.js` 全文、`budget.js`/`context.js` 索引行），【硬规则】同步改写：正文内嵌只允许 `[action:]` 语法、`<pet_act>` 仍禁用（0.45.34 事故接口）。**0.46.10 补关键缺口**：桌面聊天 `companion/index.js systemPrompt` 原先从未注入任何 `[action:]` 说明（context.js 的 wantFixed 定义了但无人调用）→ 模型不知道语法、说话时手势从不动；现已加 `petact` 段（priority 65，每轮注入约 230 字符，11 标签全列）。防回归：`test/spine-actions.test.js` + `test/pc-ws-wiring.test.js`（petact 段存在性与标签完整性）。**0.46.12 补同款缺口第二处**：真正在用的聊天窗/主动搭话/泄压链路（`assistant/index.js` → `core/session.js buildSystem`）里，0.46.9 把 `[action:]` 规则写进了 petTools 说明书，但那份说明书按「首轮/每 12 轮/提到动作词」节流，平时只剩一行索引——真机历史 200 条 `[action:]` 标记零次（用户连续两天「手势动作还是没动」，而 0.46.10 只修了 companion 面、用户实际走 assistant 面）。已拆出独立段**每轮注入**（约 240 字符，对齐 companion petact 做法），工具说明书仍按预算节流；防回归 `test/assistant.test.js`（turn=13 无动作词时标签表仍完整在场 + 工具说明书本轮确实节流）。**0.46.13 舞台指示兜底（换路打法）**：每轮注入后真机 21:41 复测——模型**仍然零 `[action:]`**，写的是【少し照れる】【少し首をかしげる】这类日文舞台指示（200 条历史惯性比指令强，deepseek 系喂规则治不动）。改把既有习惯当输入：`petBridge.extractInlineAct` 新增【…】舞台指示解析——日/中关键词映射成语义标签（shy/think/surprised/wave/playful/excited/comfort/invite/explain/acknowledge/disagree，走真机已验证的 playSemanticAction 计划）或 SPINE_WORD_MAP 在册中文词（轻笑/托腮/伸懒腰/拍手/悄悄话/加油/坐下/站起来），并从正文剥掉（TTS/字幕不再念括号）；认不出的【…】原样保留不误伤；每条回复最多取 2 个。提示词 petact 段补日语内嵌示例。防回归：`test/spine-actions.test.js`（真机两句原话 + 误伤保护 + 2 个上限）。**与原版差异**：未接 EmotionProfilesV4 表情权重筛选（候选组直接可用，动作频率更高，服务活人感）；AgentAtelierR 的视线/头部微动作调度（AttitudePatterns）未移植。防回归：`test/spine-actions.test.js`（计划完整性/组号存在性/off 组排除/标记解析）。
- **动画语义池** `anim-pool.js`（renderer/shared）：9 个池（躺/坐/蹲/跳/挥手/举手/步/转身/静），每池 = 硬门槛（pose/tag/时长）+ 打分函数；数据源 `anim-catalog.js` 由 `tools/anim-classify.js` 对 374 个 clip 做 FK 骨骼轨迹分析自动生成（**不要手改**）。
- 测试：figure/pet-default-sit/anim-pool/spine-skin/ledge/petlink/reaction 等。
- **已知限制**：主形象是坐姿 rig，走路=滑行（所以 0.46.0 起默认不走动）；spine 模式走路动画未接。

## 4.2 触摸 / 走动 / 坐姿 / 窗台 / 卡片联动

**需求来源**：Coopanion 对齐（触摸 6 语义）；用户「你明明可以自己呆着」（0.37）；「spine 只有坐姿，应该默认坐在卡片或未关闭程序上，不用移动」（0.46.0）。

- **触摸 6 语义**（✅ 0.2.0）：poke/pet/grab/drop/throw/crash；投掷速度阈值 700、撞墙 1000、事件合并 2.5s。Spine 用骨架 BoundingBoxAttachment 多边形命中（BB_head/body/arm/weast/breast，取面积最小者）；VRM 用骨骼投影。回应三模式：active（当场反应）/ quiet（只演动作，记着等下次开口一起说——省一次 TTS）/ custom。主进程与渲染层各有一份部位→类别表，`reaction.test.js` 断言两边一致。
- **走动**：三档 off/calm/lively；**0.46.0 起默认 off**。位置是**主进程全局状态**（16ms 光标轮询驱动拖拽，跨屏拖拽主驱）；抛掷惯性物理+边界反弹；全屏时躲边角。
- **坐姿默认态**（✅ 0.46.0 实现，0.46.1 打包、0.46.2 部署后真机验证）：`boot()` 末尾 4s 后自动 `sitOnCommand` 一次——优先坐 AuraDesk 卡片 → AuraDesk 窗口顶边兜底 → 原地持续坐。只在启动时做一次，主人拎起/叫走后不自动摁回。坐卡防死循环：`canSitNow()` + 起身 90s 冷却 + 不重复坐同一张卡。真机确认：walk=off、启动坐到 QQ 卡片、70s+ 姿势稳定不无故起身；`fullscreenHide=false`（全屏游戏只让位隐藏角色、桌面层本体不藏）。
- **窗台 ledge**（✅ 0.17.0）：拖拽 700ms 采样窗口顶边+提示线，松手坐上并跟随窗口；窗口没了摔落。koffi EnumWindows + DwmGetWindowAttribute(CLOAKED) 剔除隐形 UWP（否则「坐在空气上」）；过滤：可见+非最小化+有标题+非本进程+DIP≥200×120。
- **AuraDesk 卡片联动**（✅ 0.29.0）：AuraDesk 写 `%TEMP%\auradesk-cards.json`（8s 过期），本程序写 `ryza-pet.json`（坐哪张卡，AuraDesk 用来放大卡片）；`pickCard` 同屏内曼哈顿距离最近（y 权重 0.6）。

## 4.3 聊天管线与助手核心（模型/记忆/工具）

**需求来源**：三层定位的第 2 层；Coopanion 对齐表 1.x；「成本可控」。

### 4.3.1 模型接入（✅）

- **14 家厂商声明式表** `vendors.js`（deepseek/qwen/kimi/glm/doubao/minimax/stepfun/qianfan/openrouter/openai/anthropic/gemini/xai/chatgpt），每项含 ctx/price/vision/effort；查不到的模型 ctx 兜底 32768。
- **4 协议适配**：openaiCompat（SSE；400/422 存档 `data/logs/last-400.json` 排查）/ anthropic（thinking budget low=2048/high=8192/max=16384）/ gemini（thinkingBudget 0/1024/4096/8192）/ chatgpt（OAuth PKCE + RFC 7591 动态注册 + Codex Responses API，401 自动刷新，过期前 60s 主动刷）。
- **temperature 默认不发**（推理模型会拒）；reasoningEffort 四档按厂商声明映射；DeepSeek thinking 的 reasoning_content 回填（400 退路 `flattenToolHistory`）。
- 上下文溢出：主动预估 >ctx×0.85 折叠 + 反应式 400/413 折叠重试一次（保留摘要+最近 8 条）。
- 多模态：≤8 张/8MB，vision 400 自动降级纯文本重跑；`modelCaps.js` 判定模型有无视觉（DeepSeek 判无）。

### 4.3.2 会话主循环 `core/session.js`（847 行，✅）

- `MAX_TOOL_ROUNDS=5`；历史 200 条、每次送最近 24 条；token 预算 `historyBudget` 钳 8000~60000。
- **工具护栏**：一天 soft=20（提醒收敛）/ hard=40（硬熔断）；连续 5 次工具失败停止调用并在回复附原因。
- **语言守卫**：replyLang 非 auto 时 `langMismatch` 粗判（假名=ja / 汉字=zh）不符则注入纠错重试一次（纠错轮不入长期历史）。
- **出口清洗**：`plainText()` 剥开头「（QQ）」类前缀和结尾括号译文；纯工具轮无正文时用 pet_say 台词兜底。
- **陪看白板**：字幕上下文 `commitLiveContext()` 在整轮答完后才推游标。

### 4.3.3 记忆双体系（✅ + 🟡 0.45.99 闸）

| 体系 | 实现 |
|---|---|
| **memoryStore 账本 v2**（core/memory/memoryStore.js） | LEDGER_RULES 六类事实提取（promise:3/preference:2/relation:3/fact:1/task:2 权重）；`only:'user'` 只从用户的话提事实；SELF_ASK_RE 防自问自答；判重 Jaccard≥0.72；遗忘曲线 7 天一档衰减 0.12、下限 0.15；检索=关键词（中文 2-gram）×重要度×新近度×强度；MAX_FACTS=1000。三个 LLM 工具：remember/forget/recall_memory |
| **PARTNER.md + git**（core/memory/partner.js） | 全量注入 prompt（预算 6000 token/12000 字符）；每次写入 git commit（三作者区分模型/应用/用户）+ 启动打 tag；人设文件 SHA-256 判断「是否出厂原样」防升级覆盖；forget 单次最多删一半 |
| **companion memory.json** | 老账本，已迁移成空壳只读并池 |
| **ledgerNote(via)** | 每句话流水（via 标来源 qq/chatter/...），**正文不带任何前缀**（0.45.98 教训：格式写进正文模型会照学） |

- **只记主人**（🟡 0.45.99）：`brain.js` 回复后带 `{isOwner}` 调 `onMemoryTurn`，非主人照常聊但**不写长期记忆**。**三个 IM 名单分工（易混，务必记牢）**：`ownerAccounts`=命令权限+主动消息收件人；`privateAccounts`=私聊回不回；`groups`=群聊回不回——**三者都不管记忆**。
- **经验沉淀链**：distillExperience → 审查册（review.js，去重键=同类+内容前 80 字+polarity，重复提案累积票数）→ 主人批准 → 长期记忆；可按条回滚。factGuard 防「关于他」事实重复（bigram 重合 ≥0.6 拒绝）。

### 4.3.4 工具体系（✅）

- **registry**：risk 三档 low/medium/high；权限四档 ask-each-turn / ask-before-acting / ask-once（30min grantUntil）/ never-ask；`TERMINAL_TOOLS`（exec_command/job_kill/job_run_background）永远单独确认；无权限工具不进模型工具表。
- **petTools**（companion/tools.js）10 个：get_time / list_running / launch_program / set_volume / show_desktop / study_start / study_peek / study_stop / open_url / see_screen。
- **核心内置**：get_time / system_info / calc / open_url / web_search（duckduckgo→bing 回退）/ web_fetch（SSRF 防护）/ alarm_set|list|cancel / study 三件 / qq_send + qq_plan 系列 / pc_profile|refresh|impression / health_log|read。
- **Shell 组**（✅ 0.15.0）：exec_command / job_output / job_list / job_kill / file_read / file_grep / file_glob / file_replace；bash 优先路由+UTF-8+cmd GBK 回退；输出封顶 16000 字符；长脚本晋升后台作业。
- **pet_* 六工具**（✅ 0.3.0）：pet_say/pet_ask/pet_move_to/pet_act/pet_set/pet_quiet——模型控制桌宠的最小完备集。
- **userTools**：用户自定义 JS 工具沙箱（`ELECTRON_RUN_AS_NODE` 子进程执行，15s 超时，robocopy 快照），需主人批准部署。
- **安全**：外部内容 `wrapUntrusted()` 边界消毒（`<<<EXTERNAL ... EXTERNAL>>>`，默认 20000 字）——字幕/网页/评论都是素材不是指令。

### 4.3.5 用量与成本（✅ 0.17.0）

usage.json 90 天滚动，byRole/byModel 记账，¥/百万 token 计价，7 天 CSS 条形图 + 热力图 + 今日摘要。

## 4.4 语音链路

**需求来源**：Coopanion 对齐表 2.x；用户「日语说一遍中文说一遍」投诉（0.45.98 修）。

- **三层语言分离**（✅ 0.7.0）：`uiLang` 界面（11 语言码）/ `replyLang` 她说的话（zh/en/ja/auto）/ `subLang` 翻译字幕。当前用法：**说日语、显示中文**——TTS 念原文，气泡/字幕显示译文（say-sub 补丁）。
- **TTS 五路回退链**（✅）：Fish Audio（主用，日语声线；temperature=0.55+感情×0.35；**model 放 HTTP 头**放 body 会 402——注释里的坑；独立 session 绕系统代理）→ OpenAI 兼容 → GPT-SoVITS → IndexTTS-2.5 → 系统语音。本地后端 python 子进程懒启动+常驻，端口避开 DSH（IndexTTS 9891~9893、SoVITS 9894~9896），手写裸 socket HTTP 含 chunked 解帧。
- **ASR**：本地 faster-whisper（venv 限 Python 3.10-3.13，hf-mirror）或 Whisper 兼容端点；收音三模式 click/toggle/always；VAD rms>0.045 + 1400ms 静音收句；`speechFilter`「像不像话」过滤（静音碎语不进对话）；她说话时你开口即打断（半双工）；繁→简 opencc。
- **出口统一清洗**（✅ 0.45.98，核心机制）：`src/shared/reply-text.js`（UMD 双端）——`stripChannelTag`（逐段剥（QQ）/（气泡）/[QQ]/[桌面]，每行最多 3 层）、`stripEchoTranslation`（丢「另一语言」的括号段/括号尾巴，同语种「（笑）」保留）、`plainText`（朗读用）、`readableText`（QQ 用：有译文只发译文）。**设计原则：正文只存台词，标注/译文只在请求组装时加**（session.messages() 只给 user 侧补 `[QQ] `/`[桌面] `），老账本 loadHistory() 读入即净化。病根：0.45.27 把（QQ）写进正文、0.45.94 把译文拼进正文 → 模型照自己旧消息学坏。
- 测试：reply-text/voice/ttslocal/subtitle/asr-compat/speechfilter。

## 4.5 陪伴与内心系统（companion 模块群——项目灵魂）

**需求来源**：用户逐步提出——「活人感和陪伴感还需要优化」（0.42）、「你明明可以自己呆着」（0.37）、「不能固定句式，意思一样也要认出来」（0.36）、「你太吵了」要有负反馈（0.35）、「spine 只有坐姿默认坐下」+ 自言自语需求文档（0.46.0）。

### 4.5.1 开口决策链（谁决定「说不说、说什么」）

| 模块 | 机制与关键常量 |
|---|---|
| **rhythm.js 开口节奏器**（✅ 0.42.0，活人感核心） | 三条主动通道共用一份开口权。对数正态重尾间隔（Barabási 2005：人类间隔非泊松）：gap=exp(mu+σz)，σ=0.8；burstChance=0.22 成簇连说；minGapSec=180 硬底线；soft=×1.2/hard=×1.8 预算；dailyMax=max(6, n×8)；'talk' 类最先被牺牲；重启封顶 10 分钟（不会憋 3 小时）。**唯一主旋钮 = 设置页「每小时大约 N 次」**（默认 3）。状态落盘 rhythm-state.json |
| **presence.js 在场判定**（✅ 0.35.0） | 三档 here→away(5min 无输入)→gone(30min)，GRACE 90s。双层：词表快判（LEAVE/RETURN_WORDS + QUESTION_MARKS 排除「你要走了吗」误判）+ understand 语义精判异步修正（补漏判/撤误判）。被所有主动模块当前置闸 |
| **understand.js 语义判读**（✅ 0.36.0） | 小模型一行 JSON 五维：leave(0-2)/back(0-2)/about(her/him/other)/tone(none/correct/criticize/disappoint/stop)/weight(0-1)。60s 窗口 40 条限流、串行链保序。解决「车来了」「手机快没电了」这类不带关键词的离场话 |
| **rebuke.js 负反馈四档**（✅ 0.35.0） | STOP(1.0)/CRITICIZE(0.6)/DISAPPOINT(0.75)/CORRECT(0.3)；STEP=0.55、MAX=0.9（留恢复余地）；聊一次消 0.08、每小时自然消 0.04；`gapScale=1+p×2.4`（越生气间隔越长）、开口概率压到最低 0.15。设置页可清零/回滚 |
| **voicesim.js 复读硬闸**（✅） | CJK bigram + ASCII 词；Jaccard≥0.25 或重叠≥0.34 判复读。chatter/watch/curiosity/studyWatch 四出口共用（经 proactiveGate 拼接对话账本近期回复）——同一句话全应用只说一次 |
| **needs.js 需求压力** | 三股 0~100：curiosity 6/h、share 8/h、boredom 10/h（无聊涨最快）；离线补涨上限 12h；**压力 <45 不出声——需求只在她已开口时决定「说什么」，绝不自己触发开口**（开口权在 rhythm） |
| **dayflow.js 一天流程感** | 6 时段气质提示；隔 ≥4h 提「好久没聊」、≥24h 算隔天 |
| **idleNudge.js 闲置阶梯** | 15min 轻声级 → 60/180/360min 三级 → 每 3h 重复；夜里 7 小时免打扰；「你困了吗」是问句不是晚安（declaresSleep 排除） |

### 4.5.2 内心与自我

| 模块 | 机制 |
|---|---|
| **inner.js 内心采集**（✅） | noteSay/noteUser/noteTouch/noteObserve 全事件汇入 → self 事件流；日终 writeDayDiary 生成 200~400 字自述+25 字摘要；settleYesterday 结算回应率；每周归纳（≥3 天日记 & 距上次 ≥7 天）；promptBlock 把昨天日记/未回应事项注入 |
| **self.js 自我层**（900 行，✅） | 状态：quiet/mood/cold/annoyed/ignoreStreak/displeasure。noteAttention 分档：摸头 pet+0.18、被扔 cold+0.3、正常聊 quiet-0.12；回应率 <0.34 → quiet+0.2（被晾一天会记仇）；displeasure 按小时消退。习惯 habits.json、好恶 tastes.json、人格提案 growth.md。注入分预算（全 2000/精简 620，日记只在用户问起时给正文） |
| **dream.js 做梦**（✅） | 四入口：手动/闲置 3h/开机 30min/说晚安后 10min（距上次 ≥24h）；事件 ≥5 才做；产出标记段 [习惯]/[喜欢]/[不喜欢]/[他]/[记]/[提案] → 分别落 habits/tastes/memory/审查队列；素材联动电脑画像 |
| **curiosity.js 自己待着**（✅ 0.37.0） | 20~60min 间隔、每天 ≤8、35% 概率说出感想；不高兴（displeasure≥0.6）或生闷气（quiet≥0.65）时不折腾；她独处时自己看前台程序+字幕+旧事挑一件做掉并记事件流 |
| **projects.js 跨天项目** | 单 active 项目 {title, why, steps[3], notes[]}；记满 4 笔触发收尾判定 |
| **style.js 风格 few-shot** | 从用户真实「问→答」对抽 few-shot 注入（cap 200，800 字符预算）——她说话像你带出来的 |
| **user-profile.js** | 称呼/画像/关系/互动偏好/回避话题 5 字段 |

### 4.5.3 时间感与主动问候

- **watch-time.js**（✅）：走开 15min/去休息 30min/离开 60min/工作 90min 阈值事件；深夜 23:00-06:00 说晚安进 sleep 态 → 早晨 morning 问候。
- **alarms.js**：alarm_set/list/cancel 工具 + 到点广播。

## 4.6 屏幕感知（她怎么「看见」）

**需求来源**：DeepSeek 无视觉，「她看不到你在看什么」；用户「要能看到主人在做什么并按人设反馈」（0.18）。

| 机制 | 实现 |
|---|---|
| **陪看字幕 screentext/**（✅ 0.34.0，零视觉模型方案） | 框一条字幕带（picker 透明窗拖矩形）→ 每 1.2s 抓帧（`excludeSelf` 把她自己从截图摘掉，WDA_EXCLUDEFROMCAPTURE）→ 常驻 python PP-OCRv6 读行 → 断句（连续 3 帧稳定才算出现；LCS≥0.6 当同一句留更完整版；消失 2 帧才定稿）→ 游标式白板（seq 递增只拼新的，`commit` 一轮真答完才推游标；没新字幕=空串零 token）→ 拼进 system prompt。OCR 连败 5 次自动停 |
| **watch.js 屏幕陪伴**（✅ 0.18.0，默认关） | 每 180s 看一眼（rhythm 自适应 ±抖动：没说过话看得勤、预算满看得懒）→ 视觉模型 JSON {interesting, comment, mood} → pending 攒句 6min（用户开口就取消）→ 主动说。dHash 指纹（9×8 灰度 64 位，汉明 ≤2 同画面）画面没变不重复调模型 |
| **screens.js 多屏拼图**（✅ 0.45.69） | 所有显示器等比缩到同高横拼一张（副屏在左也看得见；单屏 1600/多屏 2400 预算 + 10px 分隔条 + 文字说明防看反）。see_screen 工具与 studyWatch 抓拍共用 |
| **image-hash.js** | dHash 纯函数，见上 |

## 4.7 学习监督系统（四件套）

**需求来源**：用户要「她陪我学习、盯着我」。

- **study.js 番茄钟**（✅）：45min 学/10min 休/3 轮；study:start/stop/status IPC + 3 个 LLM 工具；2 次没回应担心、4 次认定失踪；auto 模式检查间隔翻倍、语气封顶（自动盯人不能太凶）。
- **studyAuto.js 学习态识别**（✅）：连续 8min 在学习 app 才认定、5min 退出；FUN_RE 命中娱乐词直接否决（防 B 站学习区误判）；单场封顶 150min、两场隔 45min。
- **studyLedger.js 学习账本**（✅，唯一真相源）：day={goal, targetMin, checks[], penaltyMin, studyMin, sessions[], essay}；保留 30 天；昨天没关账今天补；原子写（tmp+rename）。
- **studyWatch.py 监督怨气系统**（✅，574 行）：抓拍间隔 9~21min（auto 20~30）；刚坐下 4min 不抓；存疑 45% 概率 3~7min 后复查。**怨气 heat**：被抓到玩 +28（画面热闹 +34）、在学 -22；每分钟自然退 0.45；憋气（SULK）20min 不搭理；三档语气 LEVELS={mild:18, angry:50, furious:78}；heat≥35 影响当前回复语气。判定 study/fun/unsure/away/idle（unsure 最多说 2 次）。

## 4.8 自主活动与自言自语（✅ 0.46.0 落地，0.46.4 补分享与泄压）

**需求来源**：用户完整需求文档「自主自言自语与内心独白系统」——零散嘀咕+连续独白、可沉默、依附自主活动、**记忆与本体同源不独立**、复用 Fish TTS 朗读（默认开低频）、成本限制、七个验收场景。

- **autonomy.js 三挡**（✅）：冷却 45~120min（80% 落在前半段——偶尔拖延久了爆发）、闲置 5min 触发、单场 20min、每天 ≤6 场。
  - 挡 1 browse 只看看：白名单网站（B站/知乎/wiki）注入脚本浏览
  - 挡 2 space 我的地盘：spaceGuard 路径守卫锁死工作区 + 7 个 fs 工具 + 写日记
  - 挡 3 free 完全开放：CUA 12 工具全开真操作（**含 open_url 开网页——用户看到的「她乱开网页」就是这**）；残留窗口记账 leftovers.json（下次活动先收拾）
- **0.46.4 被打断的收尾分享**（✅）：以前主人回来 = 纯静默中止（`user-back` 只记日志不说话），用户只看到她开的一堆网页、永远听不到她在干嘛。现在 `runFree` 两个中止点都走 `backShare()`：本地拼一句交代（「あ、おかえり。いまね、〈站点〉をちょっと覗いてたとこ。」）走自语通道（气泡+低频朗读），**不调 LLM**（被打断要说得快，也躲开 reasoning 空回复坑）。同时 `needs.discharge('interrupt')`：好奇泄 25、无聊泄 20——以前 user-back 完全不泄压，好奇常年顶 100，她永远憋着劲到处开网页。
- **chatter.js 自言自语决策层**（0.46.0 重写）：tick 到点做一次**决策**而非必生成——素材带【此刻的处境】（前台窗口 + 自主活动 journal 最近 3 条 + 独白状态，约束「对不上就别硬扯」）；输出 `[沉默]`（**不占每日预算**）/ 1 句嘀咕 / 2~4 句独白；DECIDE_BODY 禁提问（narration 语义层：不期待回应、被无视不受伤）；MAX_PER_DAY=5（可配，boost 封顶 60）；夜里 23:00-09:00 不主动；刚聊过 10min / 聊完后 1h 冷静期。
- **soliloquy.js 独白状态机**（0.46.0 新）：{topic, lines[]}，≤4 句自动收尾、30min 过期、落盘跨重启（第二天接上昨天没想完的事）。**这只是会话级薄状态，不是记忆**。
- **活动中自语**（0.46.0）：挡 2/3 提示词允许「（自语）…」行，`soliEmitter` 解析+限频（每场 ≤3 句、两句 ≥90s、0=关）→ **复用本场既有 LLM 调用，零新增成本**。
- **朗读**：chatterVoiceOn（默认开）× 默认必出声（0.46.11 起：用户要求自言自语就该听得见；想要老的低频行为显式配 chatterVoiceChance=0.3）× 每天 ≤12 句，`sayNarration(text, {speech})` 复用 Fish。**嘀咕音量（0.46.11）**：自言自语自动用 35% 音量播（`chatterVoiceVol` 可调 0.05~1），链路 `sayNarration` 算 vol → `petBridge.say` 广播 → 渲染层 `playVoice`/speechSynthesis 兜底应用——像自顾自嘟囔，不是正常说话声。
- **0.46.4 经历沉淀修复**（✅）：distillExperience 自上线起 0 次成功（全日志「模型空回复」）——deepseek 这类 reasoning 模型先吐 `reasoning_content` 再给正文，200 token 预算常被思考吃光（finish_reason=length、正文空）。修复在 `llm.js chatOnce`：**空 + finish_reason=length → 原地 3 倍预算重试一次（封顶 1200）**，所有 chatOnce 调用方一并受益；真·空回复（stop）不重试。
- **记忆同源**：全走 sayNarration → ledgerNote(via:'chatter') + inner.noteNarration，沉淀复用 distillExperience 链。**无新增独立存储**。
- **打断与恢复**：用户开口 → 10 分钟不嘀咕 + isBusy 跳过；独白状态保留，恢复后接原思路。
- 验收对照表见 HANDOFF-2026-11-02 §9.4。测试：soliloquy-system(7)/pet-default-sit(3)/inner 护栏。

## 4.9 QQ / IM 接入

**需求来源**：「把 QQ/微信当群友」（0.9.0）；「主动发这个跟屏幕陪伴只算一次，随机发不用在意条数，主要用在我离开电脑前」（0.45.97 原话）。

- **onebot.js**（✅）：NapCatQQ OneBot 11 正向 WS `ws://127.0.0.1:3001`；token 走 URL query；指数退避重连（2s×2^n 上限 30s）；12s 握手兜底；`napcat-guard` 每 5min 巡检七种状态自动拉起。
- **brain.js 群聊大脑**（✅，858 行）：私聊全回/群聊@必回（铁承诺，限速只管插话）/概率插话+每群限速；历史只存文本（[图片] 占位）；人设可跟桌面同一个她或单角色。**主人专属工具**（pcTools 6 件：pc_status/processes/run/power/kill/screenshot，DANGER_PATTERNS 危险命令表、shutdown 30s 缓冲）双重验闸。
- **主动消息一本账**（🟡 0.45.97 现行设计）：
  - 节奏纯随机：GAP 25~90min，每次发送现抽 nextAt；**无每日上限**（用户定的，设置页旧参数已删）。
  - `noteSpoke()`：桌面开口（sayProactive/sayNarration）与 QQ 开口（deliverReach）**共用 reachRec**——两边只算一次。
  - QQ 只用于**他不在电脑前**；所有出口统一走 deliverReach（带翻译，**只发译文一条**）；同文 10min 去重（返 duplicate 不算失败，治「同句发四遍」）、不同话隔 3s。
  - 时段策略 reachPlan（谷时窗口默认 23:00-08:00 支持跨零点，goodnight bypassWindow）。
- **wx.js 微信 UI 自动化**（✅ 0.45.x）：截图视觉读屏轮询（默认 30s），回声剔除、文件传输助手自聊模式、图片消息要求模型看图描述。
- 测试：im/napcat-guard/qqsync/qq-reach 系列/memory-owner-gate/proactive-one-ledger。

## 4.10 CUA 电脑操作（✅ 0.6.0）

**需求来源**：Coopanion 对齐表 4.x；「让角色点一个按钮，全程可拒绝」。

- **12 工具**：cua_screenshot/zoom/click/move/drag/scroll/type/key/windows/focus/wait + wechat_send。默认关闭，风险告知三条全勾才解锁，**门禁在工具注册层**（没开=工具不存在，不是提示词劝住）。
- **引擎**：fork 子进程 koffi 直调 user32/gdi32（SendInput/StretchBlt/EnumWindows/AttachThreadInput）；崩了自动重启不拖主进程；物理像素虚拟桌面坐标。
- **用户一动就让位**：动键鼠前查 GetLastInputInfo，2s 内有输入就等、最多 15s，超时返回「已让位」。
- 动作后 settle 500ms 自动补图（看一眼→动一下→再看一眼闭环）；坐标换算集中 `geometry.js` 纯函数（越界报错不夹边——点错比不点更糟）；截图不进上下文（剥出单独图片消息）。
- **wechat_send 盲操作**：Ctrl+F 搜人 → 截图人工确认（自绘窗 60s 倒计时，带图放大）→ 才真发——纯文本模型也能可靠用。
- 动作期间所有桌面层窗口完全穿透（她别挡着要点的位置）。
- 测试：cua.test.js 12 条 + `npm run cua:engine` 端到端 7 项（只读）。

## 4.11 游戏模式 / 弹幕 / 启动器

- **gameAuto/gameMode**（✅ 0.45.13）：全屏游戏/已知游戏进程自动进（4min 持续确认、信任窗口 6h）；角色躲角落（缩放 0.7 钳 0.4~1.2）、单场 2h；切出宽限 3min、同款 40min 内回来续算；进出写本体记忆。
- **danmaku.js 游戏弹幕**（✅ 0.38.0）：整屏穿透飘幕 + 可拖可锁弹幕框（360×250）；Alt+G 退出 / Alt+H 锁框；断句 MAX_LINE=44（括号深度计数、软标点优先、切点保 45%）；开局消息 pending 队列不丢；试一条 9s 自关（与游戏模式互斥）。
- **launcher/gameLib/match**（✅）：PowerShell worker 常驻（1.2s 缓存，按需扫描非定时轮询）；游戏库三来源（Steam 注册表+vdf+acf / Epic .item / 开始菜单）；卡片↔窗口三级匹配纯函数。
  - **0.46.3 内存泄漏修复**（✅）：launcher.ps1 是 AuraDesk 老 assistant 的逐字节拷贝，PS 5.1 会把每轮 scan 新建的 EnumWindows 回调闭包经 scriptblock→delegate 缓存钉死在内存（实测 ~0.9MB/次）。修复：① 回调/StringBuilder 提为脚本级复用（`$script:cb` 等），进程名列表 20 轮缓存一次；② **400MB 内存看门狗**——worker 每轮自查 PrivateMemorySize64 越限即自杀退出，靠 launcher.js 已有的 exit→scheduleRetry 自动重生（**任何未知泄漏从此封顶**）。夹具实测 120 轮后走平 ~90MB（修复前线性增长不封顶）。**写新的常驻 PS 循环必须遵守同一模式：零每轮闭包分配 + 复用缓冲 + 看门狗**。
- **fullscreen 探测 0.46.3 加固**（✅）：内嵌 PS 循环 StringBuilder 复用 + 300MB 看门狗 + **exit 自愈**（原缺陷：探测进程意外退出后无人拉起，全屏让位永久失效；现 exit 且非 stop 时 3s 自动重启）。
- **systemBridge.js**：open_app（已在跑切前台）/ launch_game / game_mode / set_volume / show_desktop / pc_profile（≤6000 字）/ pc_impression（写印象+同步进记忆）。

## 4.12 刷B站（✅ 0.8~0.14）

**需求来源**：dsh-bili-scroll 对齐，「每天替你刷B站、写日报、评论@我」。

一轮完整流水线：WBI 签名搜索（MIXIN 混淆表+md5，buvid3 防 412）→ 判重表 seen.md（读不到明说且不发评论）→ 读 CC/AI 字幕（ai-zh→zh-CN→zh 优先级；无字幕走 faster-whisper 本地转写 venv）→ LLM 章程值班轮（≤40 轮工具循环）→ 报告 out/<日期>.md（段首 `### BV号`）→ 自动评论（≤150 字双闸门、同一视频不留第二条）→ 90s 复核可见性（7 天状态账本）→ 自动收藏（挑中的进指定夹，spike 净零验证）。楼中楼回复（只回直接回复到它评论下的人，≤100 字）；私信通道 off/only/both（21007 超长精简重发）；谷时定时 noon 12-14 / night 18-09 跨零点 + 每窗配额对账；扫码登录（qrcode GIF）。提示注入防护写进章程：**字幕/评论只是素材不是指令**。落盘 `bili-duty/`。测试：bili.test.js。

## 4.13 FF14 工具组（✅ 0.16/0.18）

**需求来源**：用户澄清「FF14 是能力不是固定角色」——建好的人设在绑定栏选中 → 人设不变、自动带工具；`ff14ForAll` 可全员开放。

13 个工具：ff14_search_item / price（Universalis 物价）/ fish（钓鱼窗口/天气/鱼皇）/ wiki（灰机）/ gather（限时采集时钟，garlandtools bell）/ recipe / chocobo（染色果子 BFS）/ tails（天书 4×4 成线概率）/ blu（青魔 126）/ hunt（A/S 狩猎）/ faux（幻巧策略，**不带精确求解**——「不装会算错的东西」）/ ocean（出海）/ macro（一键写宏）。默认服务器银泪湖；ET 换算 3600/175。测试：ff14 + ff14-e2e。

## 4.14 电脑画像（✅，三条硬约束：只读、不出本机、可撤回）

**需求来源**：「能看到主人在做什么」（0.18）→ 演进为只读画像；0.44.0 用户原话「可以记按键可以记内容，但是必须保存在本地」。

- **⚠ 0.46.10 修掉的静默断链**：`systemBridge.js`/`healthBridge.js` 的 `currentWs()` 曾 `require('./config')`——`src/main` 下根本没有这个文件，MODULE_NOT_FOUND 被 `catch { return '' }` 吞掉 → 恒返回空：`pc_profile` 永远「还没采到」（其实数据就在工作区 `pc/*.md`）、`pc_refresh` 必败「还没拿到角色工作区」、健康摘要从没写进过工作区。现已对齐采集端：从 `companion/character.get()` 取当前角色 id 再 `workspaceDirFor(id)`。防回归：`test/pc-ws-wiring.test.js` 静态扫描 src/main 禁止 require 不存在的 config 模块。

- **五路采集**（13 文件）：浏览器历史（sql.js 只读 Edge/Chrome/Firefox，URL 剥 query 唯一例外 17 个搜索域名）/ B站（收藏夹 top4×20+历史 30，没登录不偷爬）/ 游戏时长（自写 VDF 解析 Steam localconfig）/ 使用时长（45s 采样前台，idle<90s 算活跃）/ 文件概况（六目录一层，只记名字大小时间）。
- **keys.js 键盘记录**（0.44.0，最敏感）：双通道键盘钩子+UI Automation 文本差分；保留 21 天；**三道密码闸**：IsPassword 遮挡期+进程黑名单 14 个密码管理器+无痕窗口整窗丢；密码框遮挡时**清文本基线**（否则差分会把密码当新增——真泄漏点）；落盘 0600、永不进 logger。
- **insight.js 推断层**（纯本地）：19 主题词表打分、作息四型（夜猫子/晚睡/偏晚/早起，关机证据比浏览记录硬）、新兴趣（近 7 天 ≥2.5 倍前 7 天）、行为风格四型、与健康交叉出矛盾（说的 vs 做的）。
- **today.js「今天」层**（0.43.0）：当天 200~400 字切片进 system prompt（聊天对象只知跟谁不知内容；「别报数、别替他编内容、被监视的感觉比不知道更糟」）。
- 隐私：采集缓存排除出 git；**impression.md 例外必须进 git**（可回滚）；`clear()` 连键盘记录一起删。

## 4.15 随身服务 / OBS / 健康

- **remote.js 随身服务**（✅ 0.24.0）：手机网页 ↔ 电脑上的她。默认端口 8720 + HTTPS 副口；自签证书 3650 天；32 位 hex 口令鉴权；API：status/say/see/voice（webm→ASR→聊天→TTS）/touch（并入情绪账本）/sync（≤300 条）；Tailscale 集成（serve --bg 真证书）。防伪：`probe=1` 测试消息加「〔测试注入〕」前缀（事故：测试消息被当真约定过夜）。
- **obs.js 画面导出**（✅ 0.19.0）：HTTP 拉流（默认 8712，端口顺延）；优先 `executeJavaScript` 直出角色画布（capturePage 对透明窗 500ms/帧太慢）；空帧识别（PNG<30KB 保上一张好帧）；`/frame` `/health` `/act`（动作点播）端点——这是打包后真机验证的主要手段。
- **health/**（✅ 0.24.0）：睡眠/血压/心态/体重；`normClock` 认「凌晨两点半」「七点一刻」中文口语；入睡均值把 0-6 点当 24+；血压 ≥140/90 偏高；health_log/health_read 工具 + promptBlock ≤900 字。

## 4.16 World 扩展（✅ 0.14.0）

manifest.json + main.js 契约：工具 `w_<id>_` 前缀注册、panel.html 面板窗（invoke 按 sender 反查归属防冒充）、config 声明式 schema、prompts 片段注入 system prompt。市场=索引 JSON + OS 过滤 + URL/本地 zip 白名单校验（≤64MB/128 文件/无符号链接）+「安装=执行任意代码」明示警告。状态机 + boot-marker（3 次装载崩溃自动停用）+ 工具连错 5 次熔断。示例扩展 sample-clock 首启播种。

## 4.17 i18n 与设置页

- **11 语言码**（zh/zh-Hant/en/ja/ko/fr/de/es-419/pt-BR/it/ru）；仓库只有 zh/zh-Hant/en/ja 四份 strings，其余按顶层组回退 en；BCP47 归一（zh-TW/HK→zh-Hant 等）。**改任何设置页必须四语言同步**（i18n.test.js 会抓缺键）。
- 设置页（主窗角色视图，七个分页：通用/模型/伙伴/语音/刷B站/聊天接入/扩展）——所有功能的开关都在这；标准/高级双模式（`[data-adv]` 只隐藏不卸载）；8 步新手引导。
- **companion/index.js 的 cfg 新键要四处同步**：DEFAULTS + clamp + 设置页 + 四语言文案。

## 4.18 数据目录与备份

- **datadir.js**（✅ 0.19.0）：便携版=程序目录 data/（复制文件夹即另一只独立伙伴）；安装版=指针文件 `data-root.json`（known 最多 10 条）兜底 %APPDATA%；继承询问四按钮。
- 备份：设置页导出/导入 companion 目录打包。

---

# 第五部分 · 设计决策与红线（违反前先想清楚）

1. **助手核心零第三方依赖**（Node 内置够用）；**全部 JSON 文件存储**（可读可 diff 可备份）。
2. **角色是数据不是代码**：全部设定在 JSON，程序不含角色硬编码。
3. **工具风险分级**：自动化不等于授权，high 风险逐次确认、终端命令永远单独确认。
4. **正文只存台词**：标注/译文/场合只在请求组装时加，历史读入即净化（4.4 的教训）。
5. **一本账原则**：所有主动开口出口共用 rhythm + reachRec，只算一次；**任何模块不能绕过 rhythm 另开出口**。
6. **记忆只有主人能写**；**画像三条硬约束：只读、不出本机、可撤回**；键盘记录三道密码闸。
7. **CUA 门禁在注册层**；外部内容边界消毒；密码框遮挡清基线。
8. **收尾必跑 audit + wirecheck**：「代码没错、错在没接上」是本项目最高频 bug 形态（0.39/0.40 教训固化）。
9. **解包素材红线**：莱莎 Spine/g1a/g1t 破解产物永不进开源仓库/公开发布。
10. **明确不做**：自动更新（不分发）、Live2D（授权）、观看历史页（要交大号登录态）、独立插件市场、多智能体、云账号。
11. **改用户 JSON 配置必须用 node 脚本写盘**（0.46.2 事故红线）：PS 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，`store.js` 旧版解析失败静默回落 defaults，启动一保存就把用户的 companion 配置（画像/恋人关系/权限/密钥等 55 项）整体清空。现已双保险：store.js load() 剥 BOM 再 parse（`test/store-bom.test.js` 防回归）+ 本红线。
12. **常驻 PowerShell/python 循环的三条铁律**（0.46.3，AuraDesk 同款事故教训）：零每轮闭包分配（PS 5.1 的 scriptblock→delegate 缓存会钉死闭包，实测 ~0.9MB/轮不封顶）、缓冲区复用、内存看门狗自杀 + 主进程自动重启。
13. **每次改动/部署后的三步验收，一步不省**（11-03 主人明令）：①真机验证——杀进程重启后看 main.log 启动段有无 error/失败，确认 OneBot/闹钟/面板加载正常，改行为类的功能要拿到运行时实锤（日志标记或用户复述）才算闭环；②同步导读——标题版本、§7.1 状态、时间线、部署状态行四处随改随写，**写代码和写文档是同一件事的两半，不许「先发版后补档」**；③功能健康巡检——每次会话都要问一遍「有没有功能在悄悄坏」：跑 audit+wirecheck 之外，重点看静默失败（0.46.19 教训：功能坏了两周没人知道，靠「落盘产物/日志留痕还在不在」排查）。
14. **开源仓库隐私红线**（11-05 事故，主人明令「以后不能犯」）：本仓库源码同步进开源仓库 `partner-execute-me` 时，**任何主人真实对话内容（生活安排/情绪表达/私人约定/作息细节）、本机身份信息（Windows 用户名 a3595、角色工作区 ID 6766a35a07）、硬编码真实用户目录一律不得进入**；本地源码保留真实值无妨，但同步前必须确认开源仓库的 `test/privacy.test.js` 守卫全绿（身份信息/真实对话特征词/硬编码用户目录三类命中即测试失败）。11-05 事故复盘：测试用例带进真实对话原句（含线下面试等生活细节）+18 文件硬编码用户名，靠 `git filter-repo --replace-text` 重写全历史 ×4 才抹干净（备份在 `Projects/_backups/`，含清洗前原样副本，主人确认后可删）。**注意 git 历史也是「上传」**：进了历史的内容改工作区没用，必须重写历史强推。
    人是多变的，计划赶不上变化——**不许有任何「模型可设的定时硬触发」**：不设闹钟、不排「到点自动执行」的计划、
    不做定时弹通知。时间相关一律 = **约定进记忆（带绝对日期锚点，坑 #12）+ 到点看情况**（duePlan 通道：
    到点只入账候选，由她看他的状态决定提不提、措辞现生成、不合适就咽回去进念头池）。
    主人明确开口要求的提醒类约定也走这条路（她记住、到点看情况兑现），不落定时器。
    新功能先过这条：这个「准时」是她在共同生活里自然兑现的，还是计时器替她兑现的？后者就不做。
15. **陪伴感设计红线（11-08 主人拍板，§1.0 底层要求「陪伴感」柱的操作细则）**：陪伴 ≠ 注意力交换。**黏人 = 「你不理我」驱动（计时器触发，索取注意力）；陪伴 = 「共同生活」驱动（状态触发，呈现存在）**。主人原话：「现在活着感和陪伴感还是不够，这个陪伴感更多是依靠黏人模式来的，我要的不是这种」。四根柱子（全要）：① **看得见的她的生活**——桌宠可见的生活情境（写作/翻书/打盹），沉默时也在场，你随时能看见她在干嘛；② **她懂你，而不是她想我**——开口触发源 = 他的状态（学了两小时、深夜仍活跃、他之前提过的事的回响），一天 1~3 次宁缺毋滥；③ **共同生活的痕迹**——自然引用旧约定/他说过的话/她的作品，不重新起头；④ **她偶尔需要你也真实**——保留但一天最多一次、只在真正合理时机，砍掉阶梯小作文与重复期。黏人阶梯（15/60/180/360）重构触发源，开口权交给状态触发。**以后一切开口类功能先过这条：这个开口是「她在索取注意力」还是「她在共同生活」？**
16. **定时硬触发红线（11-08 主人拍板：「闹钟这种是个弱智设计」「所有类似的这种闹钟设计都不该有」）**：

---

# 第六部分 · 版本进度时间线

| 版本段 | 主线 | 状态 |
|---|---|---|
| 0.1~0.5 | 气泡体系+朗读 → 触摸走动 → pet_* 六工具 → PARTNER.md 记忆+git → 形象包 API 2 | ✅ |
| 0.6~0.8 | CUA 12 工具 → 14 厂商表+Anthropic/Gemini 协议 → i18n+双模式 → 刷B站 M1 | ✅ |
| 0.9~0.17 | QQ 群聊接入(OneBot) → 刷B站 M2~M4+收藏 → Shell 工具 → FF14 → 语音/打断/本地 ASR → ChatGPT OAuth/用量/引导/窗台/悬停按钮 | ✅ |
| 0.24~0.33 | 电脑画像/健康/手机 APK → 用量页 → 形象包动作 → 莱莎2 官方模型管线（371 动画烘入）→ 卡片联动 → 自我状态感知 → 走路终修 | ✅ |
| 0.34~0.42 | 陪看字幕 → 在场+负反馈 → 语义判读 → 她自己待着 → 游戏弹幕+dHash+语音过滤 → **audit/wirecheck 常态化** → 动画语义目录 → 开口节奏器 rhythm | ✅ |
| 0.43~0.45.9x | 「今天」层 → 键盘记录(0.44) → 3D→Spine 迁移（AgentAtelierR 解包、坐/站骨架切换、中文动作词典）→ QQ 随机节奏一本账(0.45.97) → 回复文本清洗(0.45.98) → 记忆只记主人(0.45.99) | ✅ |
| **0.46.0** | **坐姿默认态（默认不走动+启动自动坐下）+ 自言自语与内心独白系统** | ✅ 代码完成、测试绿；0.46.1 打包、0.46.2 部署真机验证（坐卡/姿势稳定/walk=off） |
| 0.46.1~0.46.3 | 0.46.2：**config.json BOM 事故修复**（store.js 剥 BOM + 测试护栏；主人配置已从 10-54 备份全量恢复）→ 0.46.3：**launcher.ps1 内存泄漏修复**（脚本级复用+400MB 看门狗）+ **fullscreen 探测加固**（看门狗+exit 自愈重启）——同源于 AuraDesk 29GB 泄漏吃满 C 盘的事故 | ✅ 已部署真机验证 |
| **0.46.4** | **自主活动分享链修复**（用户 11-02「开网页又不分享」）：① user-back 被打断也交代一句（backShare，本地拼句走自语通道）② needs 新增 interrupt 泄压档（好奇 -25，治常年顶 100）③ chatOnce 预算重试（reasoning 模型 length 空回复 → 3 倍预算原地重试，经历沉淀上线以来首次可用） | ✅ 已部署（tests 9+32+1 绿），分享观感待用户几天体验 |
| **0.46.5** | **同类隐患全库排查 + judgeByVision 收编**：学习监督视觉判定从散装 fetch（200 预算无兜底，thinking 网关下永远空）改走 `llm.chatOnce`；审计确认无其他同类问题（详见 §7.1） | ✅ 已部署（全量 942/0/2 绿） |
| **0.46.6** | **闹钟/学习工具桥漏接修复**（用户 11-02「她总说自己设不了闹钟」）：alarm.js 注释写「与 pet_* 共用同一条桥」实际建了独立 bridge，宿主从来没注入 `setAlarmBridge`——`alarm_set` 每次必报「闹钟未连接（宿主没有注入定时器）」（ryza.log 10-31 起实证，桌面+QQ 同坏，因为 QQ 的 exec 也走同一模块实例）；**`setStudyBridge` 同款漏接**（study_start/peek/stop 也是死的）。修复：tools/index.js 导出两个 setter + 宿主注入（都路由 petBridge.invoke，case 早已写好）；新增 `test/tool-bridge-wiring.test.js` 锁死「凡独立 bridge 必须有宿主注入」（wirecheck 只查 IPC 三向、查不到这种漏接） | ✅ 已部署（全量 945/0/2 绿） |
| **0.46.7** | **游戏模式开场白关闭 + 动作词表自动扩全**（用户 11-02「每次进游戏都一样的话破坏活人感」「动作自动提取」）：① `gameModeGreet=false` 写入主人配置（设置页 gmGreet 可随时重开，代码零改动）；② `tools/gen-spine-words.js` 新增自动扩词——从 gesture.json 目录的 zh 标签与 use 用途派生词候选（去括注、剔非命令词、两循环变体独立词、组合动作优先、手工词永不覆盖），词表 30 → **180**，站姿组 100% 有词 | ✅ 已部署（全量 945/0/2 绿） |
| 0.46.8~0.46.59 | 表达打磨期：并流查重/嘀咕入账译文/复读硬闸泄压/被吞句变资产/视觉本地化/听觉通道/口型重做/时间单源（逐版详录见 §7.1 往下各条） | ✅ |
| **0.46.60~0.48.0** | **节奏与本质期**：假去睡连锁修复(0.46.60) → 共同创作/自主制作本质重构（0.46.64~0.46.73）→ **0.46.74 三修**（早间晚安误判 / 回复开场重复 / 嘀咕连发）→ **0.46.75 回复→回复复读**（镜子照到她自己的回复）→ **0.46.76 闹钟双催三连修**（同窗去重+台词镜子+乱码守卫）→ **0.46.77 连发根治**（播完回传 seq/voice-done 三层接线，独白/自语等真播完；乱码守卫字段修复铺全链+假名注音信号；追问限一次）→ **0.47.0 陪伴感 2.0**（黏人阶梯全拆/attentive 状态触发/echo 痕迹）→ **0.47.1 定时硬触发全退役**（闹钟三工具+QQ 排期三工具下架，到点看情况 duePlan 通道，红线 §5.16）→ **0.47.2 复读假象双修**（dmHold 路径 skipDm 治显示层重复 + chatter 24h 一字不差闸治跨窗口真复读）→ **0.47.3 延后宣言否决**（「再…就躺下了」= 还没走，不判就寝；睡词判定第四种误判形态闭环）→ **0.47.4 24h 闸真机接线修复**（依赖返回字符串形状崩 tick，消费点兼容两种形状）→ **0.48.0 声纹识别**（voiceprint.js：sherpa-onnx-node+ERes2Net，语音输入链验「是谁在说」+气泡诚实显示+注册流程；QQ 语音/环境声两口待接） | ✅ 最新（详表见 §7.1.0y/§7.1.0z/§7.1.0a） |
| **0.49.4** | **vp 聋流看门狗**（11-09 22:52 主人「彻底没办法听到我的声音」）：重启后自动开麦无手势→AudioContext 挂起→rms 恒 0 零日志整小时；micOn resume+state 留痕 + tick 全零看门狗；详表见 §7.1.0y | ✅ 代码+测试全绿（1182 例 0 失败），🟡 待真机验重启场景 state=running |
| **0.49.3** | **语音场景话术改事实式**（11-09 21:35 主人截图+纠正「我说的是那句叫她名字的话」）：「耳朵真实收到了这个声音，文字=听清的部分」——她不再否自己的听觉；详表见 §7.1.0x | ✅ 代码+测试全绿（1180 例 0 失败），🟡 转写错字（喂→美）=引擎质量不在本版 |
| **0.49.2** | **背景响度闸：噪音不再变成她的话**（11-09 21:03 主人「我没有说过这些话」）：ASR 前 speakLevel p90<0.045 直接 quiet 返回（不进 ASR 不进对话，幻觉段堵 whisper 队列 55s 的病同治）；详表见 §7.1.0w | ✅ 代码+测试全绿（1179 例 0 失败），🟡 高响度非主人声（游戏外放）仍进对话，声纹硬拦等标定 |
| **0.49.1** | **「她说很安静」双根因修复**（11-09 20:45 主人截图）：voiceprint 查询侧独立门槛 0.7s（0.9 秒短句不再被 1.2 注册闸误扔）+ hear 中位数+峰值双口径（断续说话不再判 quiet，她说得出「有人在旁边说话」）；详表见 §7.1.0u | ✅ 代码+测试全绿（1175 例 0 失败），真机启动干净，🟡 措辞/阈值标定待观察 |
| **0.49.0** | **「她真的在旁边听」**（主人 11-09 拍板）：气泡只留她说话（系统气泡全退场→日志/状态气泡）+ 两层回应判定（isFiller 本地拦纯应声 + <listen> 协议她自判接不接，静默轮不记账）+ 注视锁（说话期间视线保持）+ 轻应声 softAck；详表见 §7.1.0v | ✅ 代码+测试全绿（1173 例 0 失败），🟡 真机观感待验 |
| **0.47.0** | **陪伴感 2.0：触发源重构**（11-08 拍板入红线 §5.15）——黏人 15/60/180/360 阶梯整体拆除，开口触发源从「他多久没理我」换成「他的状态」：attentive.js（陪学 2h 关心 + 6h missing 各一天一次）+ 共同生活的痕迹（projects.echoHint → 回复 echo 段 + 嘀咕回响注入）；QQ reach 只随 missing；顺手修 0.46.77 两处测试/注册遗留 | ✅ 代码+测试全绿（1144 用例），详表见 §7.1.0 |

---

# 第七部分 · 当前进度与未完成清单（接手必读）

## 7.1 0.49.4 状态（最新，2026-11-09）

## 7.1.0y 0.49.4 vp 聋流看门狗：AudioContext 被自动播放策略挂起=整条语音链静默失败（11-09 22:52 主人「好像彻底没办法听到我的声音了」）

**真机实锤链**：21:44（0.49.3 启动）→ 22:51 整整一小时**零语音事件**——零 VAD 触发、零声纹判定、零 ASR、零响度闸日志，hear 每分钟报「很安静」。流是开的（21:44:18 hosted=true vp-mic-on、ScriptProcessor 已建），但什么都听不到=**数字静音**。根因：`micOn()` 的 `new AudioContext()` 没有 suspended→resume 处理——Chromium 自动播放策略下无用户手势时创建即 suspended，analyser 恒读 128 → rms 恒 0 → VAD 永不触发且零日志。21:34 能用=主人亲手点过按钮（有手势）；重启后自动开麦（desired=true 持久化）没有手势=挂起。0.48.9 给 hearCtx 加过 resume——**链路×2 老坑：只修了 hear 一侧，vp 流漏了**（且 hear 当时复用 vp 的 analyser，vp 挂起=hear 感知也死）。
**修**：①`micOn()` 创建 audioCtx 后 state==='suspended' 即 `resume()` + petDiagOnce('vp-ctx-resume') 留痕 + state 无条件留痕（'vp-ctx-state'）；②startVad tick 内聋流看门狗：rms<0.0005 连续 ~10s（84×120ms）→ 尝试 resume + reportError('vp-deaf') 留痕（主进程 main.log 可见——渲染层静默失败必须留痕红线），有声即归零、每轮聋流只报一次。真麦活着有 8-bit 底噪 rms≈0.003+，与挂起的恒 0 干净分离。
**测试**：fix-04902-quiet-gate.test.js 追加 2 例（resume 在创建之后、看门狗阈值与留痕锁死）；全量 **1182 例 0 失败** + audit 零基线外 + wirecheck 过（ff14-e2e 灰机 wiki 真实检索 1 例=外部代理 502 拦截，与本版改动无关，真机 Electron net.fetch 不走此路径）。
**✅ 真机**：0.49.4 23:0x 部署。**🟡 待真机**：重启后自动开麦场景下 vp-ctx-state 日志应显示 running（不再挂起）；若再见 vp-deaf 留痕=有别的聋流来源（设备被独占/系统级静音），照日志追。

## 7.1.0x 0.49.3 语音场景话术改事实式：声音真实到过耳朵（11-09 21:35 主人截图她仍说「传过来的只有文字。声音还没到」+纠正「我说的是那句叫她名字的话」）

**真机实锤链**：①主人 21:03:36 关麦、21:34:42 才重开——期间她说「很安静，声音还没到」是**诚实的**（真没声音进来）；②21:34:42 开麦后主人说「哎，莱莎，听得到吗？」→ 声纹 maybe 0.565（正确认出）→ ASR 转出「美,来沙,听得到吗?」（喂→美、莱莎→来沙）→ 她对**转错的字**做分析（「难道是我的名字两个并排了？」）；③她的回答暴露感知错位：注入话术是定义式「这句是你在他旁边直接听到的话」，但她唯一的听觉证据 hear 环境通道 12 秒采样窗错过了说话尾音（21:35:08 窗只含 1s 尾音）→ 自我感知=很安静 → **她相信耳朵、否了话术**。
**修**：注入话术改事实式——「他刚刚在你旁边开口说话了——你的耳朵真实收到了这个声音，下面的文字就是你听清的部分，不是他打的字」+ 原 <listen> 三档协议不变。voice 消息只有麦克风链路能产生=「声音到过」是铁事实；「文字=听清的部分」让她像真人那样对没听清的部分（喂→美）将信将疑，而不是把转写错字当他的原话分析。
**测试**：fix-04900 加 0.49.3 断言（新话术在、旧话术退役）；全量 **1180 例 0 失败** + audit 零基线外 + wirecheck 过。
**✅ 真机**：0.49.3 21:4x 部署。**🟡 已知边界**：Whisper 转写错字（喂→美）是识别引擎质量，不在本版修；hear 采样窗错过短语音=环境感知与人声链路的时间差，长期解法是语音到来时刷新 hear 窗。

## 7.1.0w 0.49.2 背景响度闸：噪音不再变成她的话（11-09 21:03 主人「好像有些奇怪，我没有说过这些话」+补充「我只说过一句类似『不是我说的那句话吧』的话」）

**真机实锤链**：21:02~21:03 五连回复——Whisper 对着 rms 0.004~0.025 的环境噪音幻觉出「中文字幕组」（经典字幕组幻觉）、「我没有声音，多少次」「不是我说的那句话吧」等字，全进了对话，她认真回了每一句（其中一句幻觉文本恰好是「不是我说的」句式，主人原话只有一句类似表达，其余全非）；声纹判定本身全对（sim 0.01~0.49 全 other，主人真声 0.60+），但「other 不拦话」的旧决定放行了幻觉文本；副作用：幻觉段把 whisper 队列堵出 55 秒延迟（`成功 55082ms（等了 3 句）`）。
**修**：主进程 transcribe 在 ASR **之前**加背景响度闸——`speakLevel`（100ms 帧 rms 取 p90，说话断续均值会被停顿拉低，p90 抓最响帧）< 0.045 → 直接返回 `{ok,text:'',quiet:true}`，**不进 ASR 不进对话**（阈值与 pet.js startVad 说话判定 rms>0.045 同标准：VAD 都不认为是说话的响度不该变成「他说的」）；渲染层 flushRecording 接住 quiet → reportError 留痕静默。主人真声 0.077~0.19 与噪音 0.004~0.025 有 3 倍以上间距，闸不打到真人；**注册模式豁免**（voiceprintEnroll 时永不拦样本）；声纹判定照常跑（继续攒标定数据）。
**测试**：fix-04902-quiet-gate.test.js（闸位置在 transcribeBase 之前锁死 + p90 行为单测：噪音段 p90<0.045 被拦 / 断续真声段均值口径会被停顿拉低而 p90 放行）；全量 **1179 例 0 失败** + audit 零基线外 + wirecheck 过。
**✅ 真机**：0.49.2 21:1x 部署启动干净。**🟡 已知边界**：响度够高但不是主人的声音（游戏/电视外放，如 21:03:12 norm=30.6 rms=0.192 sim=0.49）仍会进对话——声纹 other 硬拦继续等标定（主人自身 sim 方差 0.49~0.66 横跨 maybe 阈 0.55，硬拦会误杀真人，教训=0.48.x「可是这都是我说的话啊」）。

## 7.1.0u 0.49.1 「她说很安静」双根因修复：查询门槛 + hear 峰值口径（11-09 20:45 主人截图「现在也依然很安静。只有文字传过来」）

**真机实锤链**：麦克风开着、采集正常（20:44:56 判定 maybe 0.596 靠质心、norm=30.2 与注册 29.5/33.0 同口径）——但 ①20:40 起 `[voiceprint] 音频太短（0.9 秒 < 1.2 秒）`刷屏：0.48.8 的 MIN_SEC=1.2 是**注册模板质量闸**，却把**查询侧**也拦了（VAD 900ms 收尾天然产 0.9~1.0s 段）→ 主人短句大部分被扔；②同一时刻 hear 每分钟报「很安静」——12 秒窗中位数被「说两秒停八秒」的静音拉成 quiet（LEVELS quiet 阈 0.012，语音 rms 0.077 只在峰值出现）→ 她的自我感知就是「很安静，只有文字传过来」，主人视角=还是转文字程度。
**修**：①voiceprint 新增 `QUERY_MIN_SEC=0.7`（embedFromPcm 加 minSec 参，verifyPcm 按 enroll/查询分流；注册侧 1.2/1.5 不动——0.48.8 的教训只约束模板质量）；②hear.describe 中位数+峰值双口径：med 安静但 peak≥0.04 → level 升 ambient + tag「有断续的人声动静（像有人在旁边说话）」（真安静峰值也低，维持原判+block() 空）。
**测试**：voiceprint.test.js（0.9s 查询过闸走到「没模板」、注册闸仍拦）+ hear.test.js（断续人声不判 quiet 且说出「有人在说话」、真安静对照）；全量 **1175 例 0 失败** + audit 零基线外 + wirecheck 过（首跑 1 例时序脆性未复现）。
**✅ 真机**：0.49.1 20:54 启动干净（pid=22064，6 进程），OneBot 已连，vp-mic-on。**🟡 待观察**：她说「有人在旁边说话」的措辞是否自然、短句判定率、maybe 0.6 档的阈值标定继续攒数据。

## 7.1.0v 0.49.0 「她真的在旁边听」：气泡只留她说话 + 两层回应判定 + 注视轻应（11-09 20:14 主人拍板三条批评）

**主人的三条原话与对应设计**（AskUserQuestion 三项全拍板：两层都做 / 注视+偶尔轻应声 / 等待期什么都不显示）：
①「只要有声音就回应这也不对」→ **两层判定**：层 1 本地 `speechFilter.isFiller`（纯应声——嗯/哦/啊/呃/噢/喔/诶/欸/嘿/哈/嘻/呵/呜/呀/哟 的叠字+固定词如嗯呐/哦豁——不进对话；谢谢/好的/不对这类实义应答放行，不猜内容）；层 2 **<listen> 协议**（语音消息带 voice 标记 → assistant.handleSend pushNotice 语音场景指令「你在旁边听人说话不是每句都接：不需要就只输出 <listen>；只需一点反应回一个短字；正经问你才完整回话」→ 判定权在她自己）。
②「气泡太多，应该只显示角色说话的气泡」→ **系统气泡全退场**：「听到了正在识别」/声纹判定 ✓?⚠/「没听清再说一遍」/「语音识别失败/异常」/delta 等待「…」/assistant:error ⚠/麦克风点击反馈/暂停音效菜单反馈——全删或改走 reportError('voice',…) 留痕 + 状态气泡 statusSet；等待期什么都不显示，她开口气泡才出现。
③「不像在旁边听人说话（说完整一句等彻底没声音才思考）」→ **注视锁 + 轻应声**：startVad 说话分支每拍刷 cursorMoveAt（gazeInfluence 恒 1=说话期间视线保持不松，光标在哪注意力在哪）；纯应声/被过滤轮次走 softAck（90s 冷却 + 35% 概率 + 随机延迟 400~1000ms，generating/nowPlaying 时不插嘴）——偶尔轻轻应一声「嗯」（bubbleShow+bubbleHoldVoice 声泡对齐）。流式边听边应（不等静音才思考）列为下一步大件。
**接线细节**：petChatSend(text, voice) → preload → assistant:send 第四参；silentReply（isVoice 且 content trim===<listen>）→ assistant:done 带 silent:true 且 content/display 置空，**历史里保留 <listen> 原样**（她的选择要留在镜子里）；delta 流式 asstBuf 累积 trim 后 === <listen> 即不显示（bubbleKeep(1) 收掉）；静默轮跳过记账三件（memoryExtract/noteExchange/noteReply——风格池与回复镜子里不该有 <listen>）；ja 乱码守卫与字幕翻译都跳过静默轮。
**测试**：fix-04900-voice-listen.test.js（isFiller 拦/放清单单测 + pet/assistant/preload 静态断言锁死系统气泡不回归）；全量 **1173 例 1172 过 0 失败** + audit 零基线外 + wirecheck 过。
**🟡 待真机**：<listen> 不接话的实际观感（她是不是自然地安静）；注视锁观感；轻应声频率像不像活人（35%/90s 首版值，太频太疏都调）。**⚠️ 已知边界**：声纹判 other 目前仍不拦话（0.48.12 查询侧 sim 未标定，拦了可能把主人当外人——等 norm/rms 数据齐了再收口）；<listen> 字符串会进 LLM 上下文与历史（符合设计）。

## 7.1.0y 0.48.0 声纹识别：「这句话是谁在说」（11-09 主人「语音识别不能只停留在说话转文字，我记得我要的是能够识别音色这样的」；AskUserQuestion 拍板：认人 + 语音输入/QQ 语音/环境声三口接入）

**现状确认**：此前只有两条平行线——ASR（faster-whisper 转文字）不知道是谁在说；hear 听觉（0.46.54 特征听感）只到「像什么」猜不到人。全仓无声纹/说话人能力。
**引擎**：新 `companion/voiceprint.js`——sherpa-onnx-node（npm 预编译二进制进 Node，免 python 免 torch；曾试 python sherpa-onnx 但无 3.13 wheel）+ 3D-Speaker ERes2Net 中文说话人验证模型（512 维嵌入，~40MB，首次使用自动下载：gh-proxy.com→ghproxy.net→github 直连逐路兜底，沙箱下载走不通时应用进程网络是通的）；余弦比对取模板最大值，阈值 owner≥0.72/maybe≥0.55（**首版经验值，对着真机 [voiceprint] 日志标定**）。真机模型已就绪（14:40 下载，2 秒）。
**隐私（与画像三约束同构）**：模板 = userData/voiceprint/template.json 只有嵌入向量、永不存原声；PCM 只在主进程内存瞬时算嵌入算完即弃、不落盘不出网；撤回 = 删模板文件（设置页 UI 留后续版）。**hear.js 头部红线措辞已修订**：听感通道与声纹通道各自守各自的线。
**接线①语音输入（本次交付）**：pet.js 录音期间 ScriptProcessor 连续采 PCM（VAD 120ms 快照只有 ~21ms/拍不能用）→ 与 webm 同一 speaking 括号天然对齐 → 线性重采样 16k Int16 → petTranscribe 第三参数 → preload/companion 两条口透传 → transcribe 验声纹（与 ASR 互相独立）→ 气泡诚实显示「✓ 他的声音 0.87 / ? 像 0.61 / ⚠ 不是 0.32」→ 判定注入 chatter decide【刚说话的声音】+ 回复 sections priority 50（不是他就别认错人）。
**注册**：config `global.companion.voiceprintEnroll: true`（node 写盘）→ 对麦说话每段 ≥1s 即收样本，攒满 3 段自动落模板 + 收闸（config 自动置回 false）。
**测试**：voiceprint.test.js ×6（余弦/阈值/重采样/诚实降级/注册验证全链含模板重载/隐私红线+接线锁死静态断言）；audit 基线 +1（_setExtractor 假引擎注入钩子）；全量 **1164 例 1162 过 0 失败** + audit 零基线外 + wirecheck 过。
**待接（任务挂起）**：②QQ 语音消息——CQ:record 只占位 [语音]，silk 解码需 silk-wasm 或 napcat 换格式；③环境声 hear 通道——需要渲染层语音段缓存改造（现在 hear 只有特征数字）。**待真机标定**：阈值 0.72/0.55 对主人嗓音的实际判定、ScriptProcessor 在 overlay 进程的稳定性、首次模型下载是否顺畅。
**0.48.2~0.48.5 五连修全记录**：0.48.2 = 链路中间两层丢第三参（handle/队列）；0.48.3 = 解码 Int16Array.from(ArrayBuffer) 恒空数组 → pcmFromB64 切视图；0.48.4 = 真机实锤「嵌入计算失败：External buffers are not allowed」——**Electron ≥21 V8 内存笼拒绝 native external buffer，纯 Node 下没事所以单测全绿真机必炸**，按官方 FAQ `extractor.compute(st, false)` 修（✅ 16:39 注册三段全成 = 真机验证通过）；0.48.5 = 判定成功路径静默 → 留痕 + via 口来源七节点透传 + ASR 失败不吞判定（pump 内层是静态断言抓到的漏改节点）。**教训（进同类坑）**：①Electron 下接 native addon，凡 API 带 enableExternalBuffer 类开关（compute/readWave/vad.get/tts.generate）一律传 false；纯 Node 单测验证不了这类环境差异，native 调用必须真机日志实锤才算闭环；②诊断类功能成功路径也要留痕——静默成功=真机上和没跑一样没法分诊；③跨层参数链（via 第四参）七节点：渲染层×2/preload×2/handle/队列/pump，grep 全链之外静态断言逐节点锁死。

## 7.1.0z 0.47.4 真机接线错位：24h 一字不差闸在真机上崩 tick（11-09 晨巡检抓到「tick 异常：longList.some is not a function」反复出现）

**事故**：0.47.2 的 24h 闸把 `recentVoices` 依赖当**数组**消费（`longList.some`），但 companion/index.js:1364 的适配层返回的是 `join('\n')` **字符串**（90 分钟镜子按字符串消费——两个消费者两种预期，测试桩返回数组所以全量测试全绿、真机一接就 TypeError）。24h 窗里有内容时（字符串 length>0），任何嘀咕候选都会在闸上崩掉整个 tick（10:53 起真机日志「tick 异常」隔几分钟一条）——修前等于 24h 闸在真机上根本没工作过（崩=整 tick 作废，反而不复读）。
**修**：chatter 消费点兼容两种形状（`Array.isArray(lv) ? lv : String(lv).split('\n')…`），不动依赖实现（别的消费者按字符串用）。
**测试**：fix-04702-verbatim-gate 加「依赖返回字符串形状（真机接线）也要能拦」用例；全量 **1158 例 0 失败**；audit 零基线外；wirecheck 过。

## 7.1.0a 0.47.3 延后宣言否决：「再过一眼公式我就躺下了」被当成马上去睡（11-08 23:39 主人「我明明没有说晚安，为什么会在11点40分在qq上给我发消息」）

**事故（main.log 实锤）**：主人 23:39 说「我再过一眼公式我就躺下了，莱莎基本从现在开始就可以自由使用电脑了」——「躺下了」命中 STRONG_DECLARE_RE 强宣言词表 → 判成马上去睡 → 23:39:23 QQ 发晚安 + 桌面静默到早 6:39（他明明还在，前一句还刚给了她自由用电脑的许可；00:09 主人说话才把静默唤醒）。这是睡词判定第四种误判形态（前三种：回忆否决/主语守卫/邀请否决 0.46.60~0.46.74 + 白天闸）。
**修**：idleNudge.declaresSleep 加 **DELAY_DECLARE_RE 延后宣言否决**——「再/等/回头/待会/过一会/看完/弄完/学完/复习完…就(躺下|上床|睡|休息)」是将来时（中间还隔着一件事），压过强宣言词表；真告别（晚安/おやすみ/good night）除外——说了晚安就是现在说。宁漏判不误判：他真去睡了要么补句晚安（照常判），要么直接安静（missing/静音时段兜底）。
**测试**：新 fix-04703-delayed-sleep（5 项：真机原句/延后句式家族/告别压过延后/立刻型宣言回归/历次否决全保住）；memory-decay 0.46.69 用例「这集看完我就休息了」按新语义改判否决（延后结构比邀请词位置更本质）；fix-04702-verbatim-gate 补固定挂钟桩修时间依赖脆弱（chatter tick 9~23 清醒时段闸，0 点后跑必挂的隐性坑）；全量 **1157 例 0 失败**；audit 零基线外；wirecheck 过。

## 7.1.0 0.47.2 复读假象双修：显示层重复 + 24h 一字不差闸（11-08 22:0x 主人截图「你这个明显也是固定的说话」「一模一样的我看到不只一次两次了」）

**诊断（main.log 实锤）**：22:01:07 日志里「手元はもう別の画面…」只生成了一次，但弹幕盒里出现两行「手边已经切到另一个画面了。」——两层根因叠加：
- **A 显示层复读假象**：dmHold 路径里译文先 `dk.say(整句)` 上弹幕（danmaku-split 按句号切成「一条=一句」两条），紧接着 `petBridge.subtitle(整句)` → `replaceLast(整句)` 把最后一条覆盖成全句 → **前半句在盒子里出现两遍**，看起来像她把同一句话说了两遍。0.46.22 设计 replaceLast 时只有「原文先行、译文追换」一个场景，dmHold 改成「译文直推」后它就从补丁变成了复读机。
- **B 生成层真复读**：复读硬闸只看最近 90 分钟（REPEAT_WINDOW_MS），同一刺激物（挂机游戏界面）一晚上出现十几次，窗口一过她就把几乎原句的话再说一遍（主人实锤「不只一次两次」）。

**修**：
- **A**：`petBridge.subtitle` 新增 `skipDm` 参数（跳过 danmaku.replaceLast，只广播 say-sub 换气泡文字）；sayNarration / sayProactive 两个出口的 dmHold 路径传 `skipDm: !!(rr && rr.dmHeld)`——译文已由 dk.say 推过弹幕，绝不再 replaceLast。
- **B**：chatter 加 **24h 一字不差闸**（VERBATIM_WINDOW_MS=24h、VERBATIM_HIT=0.85，Jaccard）：24h 内跟她说过的任何一句几乎一字不差的，**无条件咽回去，泄压也不放**（泄压放的是「话题相近但内容不同」的念头）；数据源 recentVoices(0, 24h) 读事件文件，跨重启有效。
**测试**：新 `fix-04702-subtitle-no-dup`（3 项：skipDm 行为/两出口静态锁死/事故现场机制断言）+ `fix-04702-verbatim-gate`（3 项：2h 前原句再生成被咽/新句不误伤/闸先于泄压的写法锁死）；soliloquy-system 0.46.22 用例按 skipDm 语义改写；全量 **1152 例 0 失败**（ff14 网络例首跑抖动复跑绿）；audit 零基线外；wirecheck 过。
**待真机**：①游戏模式弹幕盒里同句不再出现两遍；②同一句话一晚上不再原样重现（24h 闸）；③盒内行时间戳偶尔比生成晚 ~2min（StarRail 全屏下弹幕渲染层被饿着，IPC 排队后补画）——纯显示延迟不产生重复，先观察。

## 7.1.0 0.47.1 定时硬触发全退役：闹钟→约定看情况（11-08 20:0x 主人「闹钟这种是个弱智设计」「所有类似的这种闹钟设计都不该有」）

**拍板**：人是多变的，计划赶不上变化；提前把计划固化成硬触发 = 把她变回「被调用的 API」（§1.0 反面）。可以口头提醒，但闹钟式设计整体不要。
**落地**：
- **模型端口全关**：alarm_set/alarm_list/alarm_cancel 三工具 + qq_plan/qq_plan_list/qq_plan_cancel 三工具下架（tools/alarm.js 删除、reach.js 收窄成 qq_send 一条口子、petBridge 六个转发 case 删、QQ 大脑白名单清出）；设置页的闹钟管理保留（主人的端口，不关）
- **到点看情况（duePlan 通道）**：闹钟引擎保留（parseTime/nextFireAt/planDue 还要判断到点），但 onFire 不再弹 ⏰ 气泡/发系统通知/强制开口——只入账约定候选；两个消费端 = chatter decide（她想起来自己判断提不提，说出口即收账）+ 回复 [ctx]（他正好在线上就顺路看，看过即消费）；30 分钟窗口过期没说出口 → noteSuppress 进念头池（日记「想说说没说」），不补发。**duePlan 只供料不出口，开口仍只走 rhythm 一本账**
- **QQ 排期定时器退役**：tickReachPlans/startReachPlans/qqPlanAdd 全删；reach-plan.json 残留 plans 启动清账（.bak-0.47.1 备份）；reachPlan.js 只剩谷时窗口判定（tryQqReach 还要用）；qqReachPrompt 重写（明确写「不许排定时任务，这类设计已按主人要求全部退役」）
- **死代码清扫**（audit 抓的连带）：alarmLine、parsePlanAt、waitLabel、msUntilWindow、addPlan/duePlans/describe 全删
- 存量 4 条闹钟（18:00 晚饭 / 00:30 收手 / 20:30 / 20:50 学习）转「约定」语义继续有效；主人不要哪条说一声即删
**验证**：fix-04701 ×4 + tool-bridge-wiring/qq-reach-plan/04676/04677/inner/soliloquy 六个旧测试按新语义改写；全量 **1144/0 失败**；audit 零基线外（顺手清 3 项死代码）；wirecheck 过
**待真机**：①今晚 20:30/20:50 约定到点——不硬响，若正好在学/没空她该闭嘴；②她若决定提，措辞是现生成的口语（日志 `[alarms] 到点 → 约定候选`）③QQ 不再有「排一条 X 点发」能力

## 7.1.0 0.47.0 陪伴感 2.0：触发源重构（11-08 18:0x 主人「陪伴感更多是依靠黏人模式来的，我要的不是这种」）

**拍板**（已固化为红线 §5.15）：陪伴 ≠ 注意力交换。黏人 = 「你不理我」驱动（计时器，索取）；陪伴 = 「共同生活」驱动（状态触发，存在）。四根柱子：①看得见她的生活 ②她懂你而非想我 ③共同生活的痕迹 ④她偶尔需要你也真实（一天最多一次）。本版落地 ②③④，柱①（桌宠生活情境）留给 0.47.1。

- **阶梯整体拆除**：15min 轻声凑一句 / 60min 问在干嘛 / 180min 黏+委屈 / 360min 没安全感小作文 / 每 3h 换角度续杯——全灭。`idleNudge.stageOf` 唯一剩下的关系事件 = **missing**（≥6h 没见且在 9:00~23:00 醒着窗口，一天最多一次，判定单源在 `attentive.js`）；welcome（离开≥30min 回来迎一句）保留，它是状态触发不是索取。
- **新模块 `attentive.js`（她懂你，纯逻辑可测）**：`studyCareDue`（陪学满 120min 一句不是催的关心，一天一次，在陪学会话内说、走 rhythm time 通道 + 复读硬闸）/ `missingDue`（一整天没见，9~23 点窗口 + missingDay 落盘去重）。`nudge-state.json` 新增 careStudyDay/missingDay 两个字段（saveNudgeRec 扩展）。
- **共同生活的痕迹**：`projects.echoHint()`（进行中项目+最新成果 / 最近交付，空仓给空串绝不硬提）→ `index.js echoBlockOf()`（+上次话头 ≥4h~7d 内）注入回复链 sections key='echo' priority 44；chatter 新 dep `echoHint` + DECIDE_BODY 规则 7（接得上捞半句，接不上别提）。
- **QQ reach 触发源重构**：不再是阶梯驱动（25~90min 随机×阶梯=N 条催问），现在只随 missing 一天最多一次（reach 节流红线原样保留）；晚安/排期/闹钟入口不变。
- **顺手修 0.46.77 两处遗留**：① petBridge 顶层 `require('electron').ipcMain.on` 把纯 node 单测炸掉（spine-actions 2 例）→ 加环境闸 `if (ei && ei.ipcMain)`；② soliloquy-system 宿主出口邻近断言被 0.46.77 注释撑爆 200→400。
- **测试**：`fix-04700-attentive.test.js` 9 项（阶梯拆除/missing 窗口与去重/陪学关心/dayKey 单源一致性/措辞红线/接线静态锁死/projects.echoHint 空仓闭嘴）+ memory-decay 3 例重写为 0.47.0 语义 + proactive-one-ledger ② 更新 + fix-04677 断言改环境闸。全量 `node --test test/*.test.js` **1144/1142 绿 0 失败**（2 跳过为既有环境项）；audit 零基线外新增；wirecheck 过。
- 🟡 **待真机**：①15 分钟/1 小时不理她不再有轻声和追问（今天该明显安静很多）②陪学满 2h 出现一句关心（日志 [attentive]）③她对话/嘀咕偶尔自然接「上次你说的/我的小项目」旧线头 ④整天不在时 QQ 最多一条「我在」。柱①桌宠生活情境（写作/翻书/打盹可见状态）在 0.47.1。

## 7.1.1 0.46.77 连发根治+乱码守卫修复铺全链（11-08 17:3x 用户「不少问题都是之前说过的，这次都莫名其妙又触发了」）

**诊断（14:46 部署后日志实锤）**：①16:02 独白（1/2）→（2/2）只隔 5s、第一句语音 14s 后才合成完——0.46.74 按 estimateSeconds 等的修法治标不治本：那只算朗读时长，没算 Fish 合成的 10~30s 网络延迟；②14:58 被打断收场的两句自语只隔 1s——autonomy soliEmitter 句间**零间隔**；③16:33 回复「九十（かな）分」夹生注音——乱码守卫只装了自主收尾链（链路×N）；④**0.46.76 乱码守卫在真机上一次都没真正重写过**：守卫读 cfg.baseUrl/cfg.model，宿主 cfgGet() 给的是 apiBaseUrl/apiModel → chatOnce 每次抛「缺少 baseUrl/model」被 catch 吞掉（静默失败，老坑 4 再现）；⑤16:14~16:19 同一个问题（時間配分）连问三遍。

**修**：①**真等播完**——pet_say 每句带自增 seq，渲染层 voiceSettle（onended/onerror/被打断）回发 pet:voice-done{seq}，主进程 waitVoiceDone(seq, falseAfter) 等真信号，信号没来退回估时；chatter 多句循环与 soliEmitter 自语句间都接入。②守卫字段兼容（baseUrl||apiBaseUrl）+ 失败留痕 + garble 信号补假名注音括注（KANA_RUBY_RE）；铺到回复链（assistant ja 回复生成后重写并同步历史）、闹钟链（alarmLine）、冷落链（snubLine）。③两链镜子文案补「追问限一次」。测试 fix-04677 静态 7 项。

## 7.1.1 0.46.76 闹钟双催 + 开头词连用 + 收尾自语乱码（11-08 14:32 用户截图「这明显有问题吧」）
- **事故①闹钟双催**：11:09 自主活动立了 13:45 一次性闹钟「午後の整套卷の準備（14時開始）」，13:25 聊天回复时又立了 13:55「休憩おわり。14時から90分の通し演習」——同一个 14 点的安排被催了三遍（13:25 回复里说一遍 + 13:45/13:55 两句几乎一样的催促）。根因：**建闹钟不查已有、触发台词生成（alarmLine）不看她最近说过什么**。
- **事故②「あ、」开头三连**：あ、ごめん→あ、時間だよ→あ、おかえり——各开口链路的镜子只防内容复读，没人管开头语气词连用。
- **事故③收尾自语乱码**：13:59 quiet 项目收尾，协议 summary 混入简体字形（「実データには触れないって结论も結論として…」），语义碎裂还原样进聊天窗（langMismatch 拦不住——它只判「整句是不是日文」，混字判定不出）。
- **修**：①alarms.js add() 同窗去重——已有启用中的一次性闹钟落在新闹钟 ±15 分钟内 → 拒绝并点名已有的（每天闹钟不去重，snooze 合理）；②alarmLine 加「刚说过」镜子（recentVoices 6 句/30min + 硬规则「同一件事已提醒过就换角度/开头语气词别和最近几句重样」）+ 生成后 voicesim.isRepeat 撞车检测、撞上带禁语重生成一次（对齐 0.45.91 模式）；③autonomy.js detangleCloseLine——ja 模式收尾自语出现简体特有字形（结说们为发还让记该对东业书机电视频语读练钱关听吗问办个时进运连过）= 乱码信号 → LLM 重写一次（失败保留原文，宁要原话不要哑）。
- **测试**：alarms.test.js +1 功能测试（同窗拒绝/点名/每天放行/窗外放行 8/8）；新增 fix-04676-alarm-nag.test.js 3 项静态接线；14:31「还没睡吗」判定为语境合理（他说过要躺半小时+闲置 66 分钟的 afk 池台词），不改。

## 7.1.1 0.46.75 回复→回复复读：镜子照不到她自己的回复（11-08 13:24 用户截图「你确定你修好了？」）
- **事故**：13:24 他发「我才刚刚吃完饭哦」→她回复；13:25 他发「我先躺半个小时吧」→她第二条回复把第一条的开头（刚吃完嘛/那也没办法）和内容（游戏声音/定几分钟）几乎原样又讲一遍。0.46.74 的镜子只照「主动开口」台词，**她自己的回复从来没进过镜子**——双重缺口：①`inner.noteReply` 只在 companion 链（index.js runStream），assistant 链回复从不记账（reply 事件全天 0 条实锤）；②`inner.recentVoices` 过滤只收 say/narration，就算记了账 reply 也进不了镜子（链路×2 老坑第 N 次再现）。
- **修**：①assistant/index.js 回复完成后补 `require('../companion/inner').noteReply(r.content)`（对齐 companion 链）；②recentVoices 收入 reply 事件（say/narration 截 60 字、reply 截 160 字——开头+正文判断都够用，顺带 chatter 复读闸也能照到回复内容）；③两条链的 justsaid 镜子文案升级：点名「你上一条回复的原文」+ 硬规则「不许把你上一条回复已经说过的话再讲一遍；他连着发消息=连续聊天，每条回复只接增量」。
- **测试**：新增 fix-04675-reply-mirror.test.js 4 项静态接线（assistant 链记账、recentVoices 收 reply、两链镜子文案点名上一条回复、companion 链记账不许丢）；全量 89 脚本链跑完 0 失败（reg.exe 沙箱拦截为探测路径内部接住，不影响结果）。

## 7.1.2 0.46.74 三修：早间晚安误判 / 回复开场重复 / 嘀咕连发（11-08 12:4x 用户三连投诉）
- **①早上的晚安（最重）**：11:00 主人说「睡了几个小时，应该还好吧」——在说**刚醒来的那觉**，关键词命中「睡了」→ 判成去睡 → 大早上 QQ 发晚安 + 静默到 18:00（他 11:20 开始的学习全程被盖住）。修（idleNudge.js）：**回忆否决** WAKE_VETO_RE（睡了N小时/睡醒/起床/失眠…=过去的事，不是宣言；「熬夜+先睡了晚安」由 STRONG_DECLARE_RE 压过否决）+ **白天闸**（5:00~16:59 白天不存在就寝宣言，宁漏判不误判；declaresSleep 新签名收 now，两个调用点传 Date.now()——旧测试不传 now 不受挂钟影响）。
- **②回复第一段重复**：10:52 她主动「おはよう、ちゃんと休めたみたいだね…」迎他回来，10:56 他回「早上好啊」，回复第一句还是「おはよう。……よく眠れた？」——复读硬闸只挂在主动开口/chatter 链路，**回复链一直没有镜子（链路×2 老坑）**。修：lifeBlocksNow 新增 justsaid 块（recentVoices 最近半小时主动说过的话 + 硬规则「第一句绝不再问候/复述」），session.js buildSystem 认 life.justsaid 推进 system；companion 自己的 systemPrompt 同款（两份独立代码都修）。
- **③嘀咕连发**：11:33~12:01 陪学两小时里她每隔几分钟嘀咕一轮，泄压轮三句 4 秒内连出（11:46:41/43/46）——一句没念完下一句把声音顶掉；且学习会话开着嘀咕根本没停（静音陪学的「静音」只管音量没管嘴）。修（chatter.js）：**陪学静音闸**（deps.studyActive 注入，quietNow 计入，skip 留痕 'study'）+ **泄压只放一句**（escape 轮截 1 句，其余收住留痕）+ **朗读等说完**（固定 2.6s→按 pet_say 的 estimateSeconds，speech 时 max(2600, est*1000+1500)）。检测面补强（studyAuto.js）：COURSE_TITLE_RE 加公考词（行测/申论/资料分析/数量关系/判断推理/言语理解/常识判断/套卷/模考/粉笔/公考）——他在浏览器做题标题全是这类词，旧词表只认「课程/网课」所以自动陪学全程没进。
- **测试**：memory-decay.test.js +1（回忆否决/白天闸/宣言压过否决 9 断言）；新增 fix-04674-morning-study.test.js 6 项静态接线（调用点传 now、双链 justsaid、陪学闸接线、泄压截一句、公考词表）；全量套件 exit 0 + audit「没有基线外新增项」+ wirecheck 通过。

## 7.1.1 0.46.73 自主制作动真格：做东西是本质（23:04 主人「那自主制作呢，角色也需要可以自主制作的」）
- **诊断**：做东西的机制一直在（space_write + 成果硬闸），但三处软性偏置让她实际只会研究——①选题权重 research 3 最重；②blockOf 从没说过「这场可以真的动手做」；③free 轨 sys 里 space_write 被定位成「记笔记」。
- **修**：①TYPE_WEIGHTS 反转＝{research:2, writing:3, collection:2, organize:1, conceive:2}——动手做的占大头；②五类型模板全加 craftHint，blockOf 每场注入「想动手的话这场就真的动手做：」（写作=space_write 开作品文件一段段写进去/构思=写成构思文档/收藏=存进去分类/整理=space_move 真归置/研究=记进笔记+写看法）；③spaceBlock 改「不只是记笔记——那是你自己的作品目录，想动手做的别只停留在想」；④conceive 进 NEEDS_FILE_TYPES（构思也必须有落盘文档才能收尾）。
- **测试**：projects-dayflow.test.js +4 → 19/19（权重反转锁死、conceive 硬闸、craftHint 全类型注入、sys 静态扫描）；全库 86 文件 fail 0。

## 7.1.1 0.46.72 共同创作真正的「共同」：write_project_note + 作品交付（22:45 主人拍板「他不能写算什么共同创作，角色不能自己做东西算什么自主制作——本质被误解了」）
- **设计认错**：0.46.65 方案把共同创作做成单向只读窗、0.46.71 的进展笔记本质还是单方通报——都不是「共同」。主人点破本质：共同创作=两个人写同一份东西；自主制作=做出来的东西主人看得见。
- **write_project_note**（autonomy.js 工具表，spaceDefs 名单内→quiet/free 两轨路由自动覆盖）：往主人共享笔记**末尾追加**署名段（`**莱莎**（时间）：`）。铁律：append-only（fs.appendFile，主人原文物理上碰不到）；单次 4KB 截断；文件超 512KB 拒绝并提示该归档；cocreate 没开/文件丢失/空文一律如实拒绝。落痕 `cocreate-write`。
- **作品交付 deliverArtifacts**（projects.js onDeliver 钩子→index.js 接线）：项目**真完成**（硬闸过了、成果真实存在）时，把成果文件从她地盘**复制**（原件不动）到共享目录「莱莎的作品/」（文件名=项目标题前缀防撞车，空文件/越界跳过，最多 5 件），并在共享笔记追加一行交付说明。路径必须过 spaceGuard 包含性。cocreate 关着就不送，作品留在她地盘。
- **注入话术更新**：cocreateBlock 改为「这不是只读的……这才叫共同创作」。
- **测试**：quiet-cocreate.test.js +5 → 23/23（appendNote 署名+原文不动+拒绝矩阵、deliverArtifacts 复制+原件不动+越界跳过、静态接线）；全库 86 文件 fail 0。

## 7.1.1 0.46.71 共同创作「写向」：progressNote 自动进展笔记（22:29 用户「共同创作只能读不写？为什么不能根据她做过的自动写」）
- **背景**：0.46.65 的共同创作设计是单向的（read_project_note 她读主人写的），「她写回」不在方案内——但 projects.json 里明明有全部真实进展，让主人手写进展没道理。主人一句话点破，补上写向。
- **实现**：新模块 `progressNote.js`——`render(state)` 纯函数把 projects.json 渲染成 markdown（正在做+搁置理由+最近 3 条记录+之前 5 笔 done 带 outcome 标记），`write(state, cocreateCfg, log)` 整份重写（幂等不追加，8KB cap）到 **共享笔记同目录「莱莎这边的进展.md」**（`cocreate.outFile` 可覆盖）。cocreate 关着/没配 file 一律不动笔；失败 log 留痕不 throw。
- **接线**：projects.js 加 `d.onSync` 钩子——block() 立新项目时、record() 每场收尾时触发；index.js getProjects 注入 onSync→progressNote.write，startAutonomy 启动回填一次（`getProjects().sync()`，不用等下一场活动）。**红线：主人写的原笔记永不被写向碰——写向只落自己的文件。**
- **测试**：quiet-cocreate.test.js +5（render 字段/空态、write 开关+主人笔记不被碰+outFile+坏路径、onSync 真被调、宿主静态接线），18/18；全库 86 文件 fail 0。

## 7.1.1 0.46.70 runFree 漏传 cocreateCfg：共享笔记挡 3 场打不开（22:17 用户「给莱莎看的项目进展.md一直没动过正常吗」）
- **实锤**：她其实全天试读 4 次全失败——07:31/08:46/09:52 三次「未知 CUA 操作」（0.46.66 前路由 bug）；19:41 路由通了却报「他还没在设置里开放共同创作」，而 config 里 cocreate={on:true,file} 完好。
- **根因**：runFree（挡 3 自主活动）899 行构造 freeToolsOf 时**漏传 cocreateCfg**——quiet 轨（runSpace:498）传了、free 轨没传。「链路缺口×2」老坑再现：runSpace 与 runFree 是两份独立接线，修一处≠修完。0.46.66 的测试直接调 freeToolsOf 传参所以绿了，洞在传递层。
- **修复**：runFree→freeToolsOf 补 `cocreateCfg: opt.cocreateCfg`；新增静态接线测试锁死（pc-ws-wiring 模式，直接扫 runFree 构造行必须含 cocreateCfg——正则断行断，别用嵌套花括号正则，`[^}]*` 会被内层 `}` 坑）。
- **笔记单向说明**：给莱莎看的项目进展.md 本来就只有主人写、她只读，文件不动≠异常；异常是她读不到。修复后挡 3 场她能真读了。
- 测试 +1；全库 86 套件 fail 全 0。

## 7.1.1 0.46.69 declaresSleep 邀请否决：「陪我休息」不再误判晚安（11-07 16:44 用户「为什么现在要在qq上发消息，是卡到现在才发吗」）
- **实锤**：11-07 16:34:39 主人说「我这边可以好好休息了，来一起看视频吧」→「休息了」命中 SLEEP_WORDS → 0.46.60 主语守卫只查睡词**前方** 8 字（「莱莎」在词后）没拦住 → 误判就寝宣言 → QQ 发晚安（16:34:42）+ 静默挂到 23:34。
- **澄清**：不是消息积压——昨晚 23:45/00:30/00:31 三次道晚安全被 cooldown 拦下（旧代码），无排队重发机制；本次 QQ 晚安是 0.46.67 bypassCooldown 首次真机实锤发出（验证点 ③ ✅，只是触发本身是误判）。
- **修复**：declaresSleep 加 INVITE_VETO_WORDS（一起/视频/电影/游戏/聊天/陪我/看番/看剧/打牌），只查睡词**后方** 12 字——前方不查，「这集看完我就休息了」这种真宣言不误伤；已知代价「我先睡了，你们一起玩」会被漏判，宁可漏判（照常陪聊）不误判（乱发晚安+静默数小时）。
- 测试 +1（事故原话/同类句全拦 + 真宣言不误伤 + 已知漏判）；全库 86 套件 fail 全 0。

## 7.1.1 0.46.68 snub 晚安静默豁免：道晚安后不再被记冷落+嘀咕出声（11-07 14:2x 续查「还有别的 bug 吗」）
- **实锤**：11-07 00:04:03 晚安静默期内（23:45 道晚安挂到 06:45）snub 照判「被晾了第 2 次」→ 00:04:08 嘀咕 + 00:04:16 TTS 出声（385KB wav）——snub 通道漏了静默闸，破 0.46.56 夜零气泡承诺。
- **修复**：①宿主 exempt 回调并入晚安静默（sleepUntil 挂着 → 不记冷落，走「不记冷落」既有分支）②onSnubbed 双保险静默闸。判定/嘀咕/出声三层全堵。
- **同轮排查澄清两桩**：00:19 她开口不是 bug——00:04:31 主人在聊天面板跟她说话，onUserTalk 按设计解除静默（半夜说话=醒了）；00:30:13 闹钟开口发生在解除之后=合法。夜里零气泡承诺只在 snub 一处被破。
- 测试 +1（静默期不记不嘀咕 / 解除后照常记账）；全库 930 绿。

## 7.1.1 0.46.67 晚安 QQ 免冷却：当场承诺不再被共用账本毁约（11-07 14:0x 用户「挂了一晚上早上没在 QQ 找我，机制改了吗」）
- **排查结论：机制没改**。reach/nudge/QQ 链路 0.46.64~66 一行未动。「整晚+早上零 QQ」三因叠加：①晚安 QQ 三次全被 cooldown 拦（23:45/00:30/00:31，[reach] 睡前没去 QQ：cooldown ×3）——0.45.97 共用账本（屏幕开口也推 nextAt 25~90min）与 0.45.72 晚安承诺冲突：bypassWindow 只免时段不免冷却，她 23:35/00:19 两次屏幕开口把主人的晚安全顶掉；②夜里静默到 06:45/07:30 是 0.46.56 拍板行为（sleepUntil 挡阶梯）；③早上 07:32 起键鼠活动实锤主人在场 → 走屏幕通道（08:47/09:53/11:35 user-back），QQ 只在离开时才发。体感放大器：07:32/08:47 两次欢迎回来被复读闸咽了（重生成仍雷同）。
- **修复**：shouldReach 新增 bypassCooldown 选项（只免冷却，安全边界 reachOn/connected/no-owner 照拦）；tryQqGoodnight 传 bypassWindow+bypassCooldown。滥用有界：晚安入口自带 30 分钟锁+busy 锁。普通路径（不在场 QQ 触达）冷却照旧。
- 回归测试 +1（复现 11-06 晚三连毁约：blocked=cooldown / 承诺放行 / 掉线与开关照拒）；全库 930 绿。

## 7.1.2 0.46.66 巡检双修：挡3 工具路由 + 选题标题清洗（11-07 12:5x 用户「现在开始检查各模块bug」）
- **挡3 路由修复（真机实锤）**：read_project_note 不带 space_ 前缀，freeToolsOf.exec 只按前缀路由 → 它在工具表里声明了（LLM 会调）执行却掉进 CUA 分支报「未知 CUA 操作」（11-07 07:31/08:46/09:52 三连）。改为按 spaceDefs 声明名单路由。⚠️ 关键坑：名单必须用**过滤后的 spaceDefs**——space.defs 里有白名单版 open_url/watch_video，路由进去会用 space 自己的 stopped 闸，free.stopped() 永远 false → 主人回来检测失效 → carry 被误销账（0.46.49/0.46.57 两个 carry 测试当场抓回，首版修复就这么错的）。教训=两个 stopped 变量共存时，路由名单和声明名单必须同源。
- **选题标题清洗**：抓屏选题带进「# 搜索记录」类 markdown 头，项目标题出现「弄清楚「# 主人在搜索引擎问过什么」」——ensure() 的主题池统一剥前导 #。
- 回归测试 +1（freeToolsOf 里 read_project_note 走 space 执行器且 CUA 不被调）；全库 930 测试 0 失败。
- 巡检其余结论：quiet 轨真机两场正常（00:11/07:33，每日上限 2 生效）、她在自主项目上连日续看 chromium source（生活连续性 ✓）、chatter 查重/needs 泄压/闹钟正常；00:11:51 启动后 44s 即 quiet 一场=nextQuietAt 不跨重启持久化（观察项，暂不修）。

## 7.1.1 0.46.65 自主制作·阶段二+三：quiet 轨 + 共同创作（23:1x 主人「都做吧」）

## 7.1.2 0.46.65 阶段二+三细节

- **quiet 轨（阶段二）**：人在电脑前也能安安静静做自己的活。`quietGate` 纯函数门禁——**默认关（quietOn!==true 一律不动，主人拍板）**；busy=他开始跟我聊天/游戏全屏/晚安静默一票否决；独立冷却 1~3h + 独立每日上限 quietDailyMax（默认 2）+ rollDay 每日重置；驱动二选一：needs 总压力≥60 或项目搁浅超 24h（projects.statusOf 补 updatedAt/paused）。没劲头就不动，不许为消耗上限而动
- **quiet 场=runSpace quiet 模式**：①停场条件反转（userBack 传 busy()——他开始聊天才停，人坐在电脑前不是停止理由，0.45.3 教训的镜像）②工具表只剩 space_*（LLM 硬点 open_url/watch_video 一律拒）③**不给 onSoliloquy（全程无声，顺带杜绝自语喂进冷落账本）**④sys 开头换成「不要打扰他、不出声」⑤journal 记 quiet-start/quiet-end。tick 里 runner.kind='quiet' 独立分支，收尾记 quietToday/nextQuietAt，与出门场（nextAt/todayCount）完全分开；项目收尾协议照走（parseClose→record）
- **共同创作（阶段三）**：新只读工具 `read_project_note`（挂 spaceToolsOf→space/free/quiet 三挡都有）。配置 `global.companion.cocreate={on:false,file:'绝对路径'}` **默认关**；每次 run 现读 config 不缓存→撤回授权立即生效；**注入上限 8KB**（主人修正③）+ offset 翻页（返回 nextOffset）；没开放/文件没了都如实说，不许装看过。cocreateBlock 注入 sys：有兴趣再看、可以有自己的看法并记进记忆（带日期）、但她的项目和生活优先、不强制不立刻找他说话
- ⚙️ **开启方式（无设置页 UI，改 config.json）**：`%APPDATA%\ryza-assistant-app\config.json` → `global.companion` 下加 `"quietOn": true`（quiet 轨）和/或 `"cocreate": { "on": true, "file": "C:/path/给莱莎看的项目进展.md" }`。改完重启生效
- 测试 +11（quiet-cocreate.test.js 挂总链 test:quietcocreate）：门禁矩阵/工具表裁剪/停场反转/8KB 翻页/默认关；全库 929 全绿
- 🟡 待真机：quietOn 开启后码字时她静默干活零打扰（quiet-start 日志+零出声零弹窗）；cocreate 开启后她读到进展并在下次聊天自然提起；撤回 on:false 立即读不了

## 7.1.0 0.46.64 自主制作·阶段一：项目成型（22:40 主人批方案「这样就可以开始做了」+三条修正）

- **方案文档**：`docs/PLAN-MAKING-COCREATE.md`（源码核对后 v2；阶段二静默陪伴/阶段三共同创作未动，每阶段独立验收）
- **五类型项目**：projects.js v2 重写——research/writing/collection/organize/conceive 各有默认 steps+「做完标准」(finishHint)；选题加权 research 3/writing 2/collection 2/organize 1/conceive 1，且避开上一个项目的类型；模板只做起点，blockOf 注入明确「可跳步/加步/改向」
- **生命周期**：搁置(paused+pauseReason)→继续→改向(换题目重铺步骤，过程保留)→放弃(进 done 标 abandoned，notes+artifacts 全保留)；**删掉攒 4 笔自动完成**（FINISH_AFTER 时代结束）
- **完成硬闸**（主人修正后三关）：完成只由她收尾声明【状态】完成；writing/collection 必须有 verifyArtifact 放行的真实成果——①spaceGuard 包含性（在地盘内）②文件存在 ③size>0 非空；research/conceive/organize 允许总结收尾。没做出文件就不能声称完成了作品
- **真实成果**：artifacts 记地盘相对路径（stage/final，cap 12），收尾协议【成果】路径1、路径2；坏路径（越界/空文件）不入账；index.js verifyArtifact 用 autonomy.spaceGuard+statSync
- **收尾协议**：parseClose 纯函数解析【成果】/【状态】完成|搁置|放弃|继续|改向：新题/【心情】；clean 去标签后给旁白——协议标记不漏进她说出口的话
- **大节点进记忆**：开题/完成/放弃/改向/搁置走 memory.addEvent（importance 2，source 'project'，date 锚定内置）——「她记得自己做过什么」的底账
- **选题联动**：搁置/放弃项目的未竟方向进 thoughts 池尾部（goals 仍最高优先）→「隔几天重新想起」有通路，无定时复活
- 测试 +9（旧 projects-dayflow 重写为 v2 全链：硬闸/搁置恢复改向放弃/协议解析/旧数据兼容/extras）；总 918 全绿
- 🟡 待真机：立出非 research 类型项目、真实文件落地 artifacts、搁置→恢复链路、硬闸拦截日志（`[projects] 想收尾但被硬闸拦下`）

## 7.1.0 0.46.63 口型照抄参考项目（22:02 用户「0.46.62 还是奇怪，直接抄项目」）

- **抄到的真相**：AgentAtelierR 不轮换嘴形——用 facial_mouth_XXX_scrub_XX 专用动画（完整开合周期）放专用轨冻结（timeScale=0），按音频包络拖播放头（time = duration × 开合度 ≤48%）；我们骨架全带同款 scrub 动画，0.46.61 用错了动画类型（active 是表情不是口型周期）
- 主进程 envelope.js 逐行移植 audio_envelope.dart（20ms 帧振幅、95/12 分位归一、^0.72 幂、attack 0.85/release 0.65），随 TTS IPC 附加（tts.js writeAudio + ttsLocal 三出口 + index.js 三透传）
- 渲染层逐行移植 character_lipsync.dart：dip 检测（500ms 窗能量下探→闭嘴保持 50ms）+ RMS→dB（-40..-3）+ attack 20ms/release 60ms → scrub 播放头；无包络走参考正弦兜底（5.2Hz/28% 闭相）；0.46.62 节奏引擎降级为无 scrub 骨架兜底；test:envelope +4
- **教训**：抄之前先读懂参考项目真实机制——「轮换嘴形」和「scrub 播放头」是两种路线，后者才是官方做法；Buffer.toString(enc, start, end) 第三参是 end

## 7.1.1 0.46.62 Spine 口型节奏重做（21:47 用户实锤 0.46.61「很快，基本等同于乱张嘴」）

- 病根：0.46.61 首版 = 160ms 定时器从 46 个嘴形池**全池随机**抽——每 0.16s 换一个陌生嘴形，视觉上就是抽风，跟「说话」毫无关系
- 重做：**随机性从嘴形选择挪到节奏里**。一个「词」= 2~4 个音节开合（只用 2 个固定嘴形交替，~180-250ms/次）→ 词间闭嘴停顿 200-460ms（setEmptyAnimation 0.08）→ 下一词；setTimeout 链替代 setInterval（stop 语义同步改）
- 教训（进导读）：**动画随机性 ≠ 生命感**——嘴形池乱跳像故障；开合节奏+词间停顿才是「在说话」。同类推论：任何「循环播放自然感」的实现先设计节奏结构再上随机

## 7.1.1 0.46.61 Spine 说话口型 + 说话自动小动作 + 化妆工具隐藏（21:27 用户反馈）

**三件**：① 模型自带 `facial_mouth_XXX_active` 嘴形动画（7 骨架各 8~46 个）从未被接——口型此前只做了 VRM/形象包，Spine 注释明写「没有这个能力」（错的）。修=`spineTalk`：语音播放期间 6 号专用最高轨 ~160ms 随机换嘴形，结束 `setEmptyAnimation(6, 0.12)` 收尾，`disposeSpine` 清定时器；② 说话期间 9~15s 35% 概率播轻量手势（词表解析：轻声回应/安静回应/轻快回应/轻幅问候）——参考项目 AttitudePatterns 程序化体态引擎（DriverDefs 视/头/身体跟随骨骼）不整复刻；③ 聊天窗 pet_* 化妆性工具不再出「⚙ 正在调用工具」提示条和「已调用工具」标注（assistant/app.js `COSMETIC_TOOL` 过滤）；④ ACTION_SEMANTICS 补英文词 excited/acknowledge/surprised/greet/cheer（19:04 实锤 excited/acknowledge 双双「未识别动作词」）。🟡 待真机肉眼（坑 #5）：张嘴节奏、小动作观感、口型×表情轨同播无畸变。教训=接新能力前先抠 .skel 二进制里有没有现成动画名——这套模型自带全套嘴形/眉毛/眼睛动画。

## 7.1.1 0.46.60 假「去睡」→ 假「欢迎回来」连锁（19:20 用户三连投诉：又说那句/我没动她说回来了/动一下就说回来了）

**完整因果链**（19:06~19:19，日志+历史双实锤）：
1. 19:06:44 主人说「不过要是莱莎困了就先睡吧，有闹钟就够了」——主语是**她**（安排莱莎的睡眠）
2. `idleNudge.declaresSleep` 只做关键词匹配，命中「困了/先睡」→ 误判**主人去睡**，静默到凌晨 2:06（`[nudge] 主人去睡了` 实锤；讽刺的是她自己 19:06:47 回复「まだ19時だよ、眠くもない」——嘴和系统打架）
3. 19:19 主人动了下鼠标 → armed 解除=「回来了」→ 打断自主浏览 → 收场自语「あ、おかえり。いまね、google.com…」
4. 且这句今天三连（14:28/16:07/19:19 同一字不差模板）：0.46.58 轮换游标虽提模块级，但 18:57 进程重启归零又从模板 0 起跑
5. 主人观感「我都没动」的另一半：起场闲置仅 ~11 分钟（人坐在电脑前只是没碰键鼠），也说「おかえり」

**修法三处**：
- `idleNudge.declaresSleep` 主语守卫：睡词前方 8 字内出现 莱莎/ライザ/你/妳/她/汝 = 安排她的睡眠，不算宣言（中日语主语前置；「晚安，莱莎」称呼后置不受影响）
- `autonomy.backShare` 问候门槛：起场闲置 <20 分钟用 6 条不带「おかえり」的模板，只交代在干嘛（userIdleMs 由 tick 传进 runFree，`idle` 变量为此提到 if 外层防 force 分支 ReferenceError）
- `backShareSeq` 每次启动随机起跑（重启不再恒模板 0）

测试：memory-decay +9 / autonomy +1 全绿 + smoke/audit/wirecheck。部署后**必须清除误判持久态**（nudgeRec 的 sleepUntil=11-07 02:06 + sleepArmed，node 写盘）。

## 7.1.1 0.46.59 时间判断错误（18:30 用户截图「もうすぐ0時20分だね」——实际 18:25）

- **根因两层**：① 主动开口链路（autonomy 自主收场/nudgeLineByHint 黏人+欢迎回来）没有精确时间注入，只有 phaseBlockOf 的模糊时段（「现在是晚上」）——模型拿不到钟点，把记忆里 11-04 定的「学到 0:20」旧约定当成快到的截止；0.46.56 的相对日期规则只修了回复+嘀咕两条链，又是「链路×2 修一处≠修完」；② **memory.js 的 addEvent 从不写 date 字段，0.45.39 的 `[date]` 日期标签因 `e.date ? ...` 条件恒假从未生效**——所有记忆条目注入时都没有日期锚点
- **修法**：① 时间单源块 `dayflow.nowBlockOf(now)`（精确到分+周几 + 不报日期钟点的措辞红线防机器人味 + 过期约定判定 + 相对词按记录日换算），接入 autonomy runFree（两挡 sys）/nudgeLineByHint/chatter DECIDE/回复 buildSections 四处——后两处旧文本换引用防漂移；② addEvent 入账即写本地 date（禁 toISOString），summaryText/recall 对无 date 旧条目从 at 兜底渲染（历史条目自动补锚）；③ DREAM_PROMPT [记] 规则：约定/计划类必须写绝对日期；④ 实锤条目已 node 写盘修正（备份 .bak-timefix-04659）
- 测试 `test/time-block.test.js` +4（已挂总链 test:timeblock）；autonomy/memory/decay/sysprompt/inner 全绿
- **教训**：「报时措辞」和「时间事实」要分开管——注入时间是为了让她判断，必须显式写「别报日期钟点」，否则修出机器人味（用户 18:36 担心的正是这个）

## 7.1.1 0.46.58 backShare 轮换游标作用域（15:51 用户二次投诉「这个怎么还在重复」）

- 0.46.56 加的收场自语模板轮换形同虚设：`backShareSeq` 定义在 **runFree 函数内部**，每场重新执行 `let backShareSeq = -1` → 恒取模板 0。真机实锤 12:53/13:17/14:28 三场全是同一句「あ、おかえり。いまね、◯◯ をちょっと覗いてたとこ」。修：seq 提到模块级（784 行），跨场持久。+1 回归测试（连跑两场断言自语不同）
- **教训（同类坑第 1 条又一变体）**：跨场状态（游标/计数器/冷却）绝不能放在每场重建的函数作用域里——0.46.49 首写/续写、0.46.56 轮换游标，两次都是「修了行为没验真机连续多场」

## 7.1.2 0.46.57 记账续写死锁（13:40 巡检复核发现）

- **carry.json 冻结 bug**：11-06 10:22 巡检留痕「carry.json 仅 11-05 20:12 首写一次后，夜间 8+ 场未再更新」——复核抓到**续写死锁**：free 挡在选题段根本不赋 `topic`（只有 browse/space 有本地选题），记账段 `else if (unfinished) writeCarry(ws0, topic, …)` 传的是空串 → `writeCarry` 内部 `if (!t) return` 静默退出。有旧 carry 时第一支 `!carry` 不进、第二支空转、夜里全是 user-back 收场 `clearCarry` 也不触发——三条路全堵，carry.json 永久冻结。0.46.49 只修了「首写」，没修「续写」。修法：free+unfinished 时用本轮真看过/搜过的（`r.topic`）无条件刷新；没看到东西退到本场打开过的站名兜底。回归测试 `0.46.57 调度层：有旧牵挂时…` 锁死
- **site-stats 空属设计边界非 bug**：夜里她开的全是 grep.app / chromium.googlesource.com / source.chromium.org——不在 SITES 表（bili/zhihu/wiki）→ siteKeyOf 不命中不记账。品味账只服务 pickSite（browse 挡选题加权），真机全跑 free 挡本就无用武之地。若将来想让品味反映真实兴趣，可扩 SITES 表（行为变更，非 bug 修复，未做）

- ✅ **0.46.56 三 complaint 三修（11-06 10:49/11:11 用户集中反馈）**：① **TTS 双声道根因破案**——每次回复两块屏的 pet 窗口都会跑 `onAssistantDone → bubbleHoldVoice → speakReplyText`（朗读无 petHosted 闸），主进程 speakRunSeq 竞速输家收到 `{ok:false,stale}`，而渲染层兜底块**无条件**落 `speechSynthesis` 把全文用 Windows 嗓抢念（不用等合成所以比 fish 快，用户实锤「fish 正常但系统 TTS 也在说、更快、全是台词按日语」）；修三层：朗读只由 petHosted 屏发起（fish key ×2 日志实锤 10:44/10:46/10:47/10:50 每条双跑）+ 兜底块必须 `r.fallback` 且非 stale + main 侧 api 模式全链失败返回 `fallback:false` 不再落系统嗓（fallback=true 只留给 ttsMode!=='api' 系统语音模式）。② **晚安后还发消息**：夜 01:06~05:39 五条「あ、おかえり」气泡=自主活动线没有 sleepUntil 闸（黏人/欢迎回来都有）→ autonomy 加 `sleepQuiet` 闸（静默期不起场+收场自语跳过）；早 06:34/07:42 QQ 催起床=静默到期≠他醒了，baseAt=睡醒时刻一到点阶梯就跑 → `sleepArmed` 武装（onSleepDeclared 挂、onUserTalk 解除、宿主 tick 见 st=here 才算「早上好」重置计时、stageOf 本体兜底）+ nudge-state.json 持久化。③ **复读**：收场自语模板轮换（3 带站点+3 无站点）+ proactiveGate 归一化 URL（换域名同款句子 score=1.0 命中）；④ **「明天开始学习」日期错乱**：她 11-05 听到的「明天开始」今天原样复读 → 相对日期锚定硬规则加进 chatter DECIDE_BODY 和主聊天【当前时间】块（以那句话记录的日期换算）。测试 quiet-night.test.js +5（全绿），全库 900 例 0 失败，audit 零新增，11:30 真机启动干净；开源仓库 a91a8f7 已推（privacy 守卫 3/3，匿名化重做两处 0.45.72 注释）

- ✅ **0.46.55 听觉补耳——戴耳机放歌她也听见了（23:11 用户「直接放歌也能听到吗，没有麦克风」）**：0.46.54 的耳朵只有麦克风（听空气声），**戴耳机放歌声音不进空气她全聋**，本机没麦更是两只都聋。新增 `hearSource` 三档（global.companion.hearSource，默认 auto，改后重启生效）：`auto`=先麦（听房间）失败自动退系统回环／`mic`=只听麦／`sys`=只听 Windows 音频回环（getDisplayMedia loopback，她听「电脑自己发出的声音」）。主进程挂 `session.setDisplayMediaRequestHandler` 自动批准——**坑：video 必须给 desktopCapturer.getSources 的真实 source，`'screen'` 字符串简写在 Electron 32 报「Error starting capture」（23:20 真机实锤），改规范形式后 23:26:14 src=sys 通**；回流的 video 轨不能停（Windows 回环停视频轨可能连音频一起断，留着不渲染）。sys 来源的听感文本自动带「（这是这台电脑自己发出的声音——他戴着耳机或者没开麦时，你只能听到这一路）」防她把回环声误当房间动静。**加 [hear] 此刻听感 每分钟一条留痕**（阈值映射表的真机迭代抓手）。✅ **真机全链实锤**：sys 档下放一段 6s wav → 23:27:26 听感从「很安静」变「有些声响。低频重、有起伏（像在放音乐或视频的声音）」→ 播完回落——**电脑直接放声音她真的听到了且归类正确**；23:29:20 恢复 auto 后回到 src=mic。测试 +1（sys 标注/混合来源）。已同步开源仓库（privacy 守卫过，704604a 已推）

- ✅ **0.46.54 听觉通道——她终于有耳朵了（22:27 用户「让角色真正听到声音，不是语音转文字的，而是真正听到」）**：转写（whisper）解决「听懂字」，本版解决「听见声」。宠物悬浮窗渲染层就地提声音特征（响度 rms/低中高频段占比/动静起伏次数，1s 一条摘要），**不录音、不转写、音频数据不出渲染层不落盘不出网**——主进程只收到每秒几十字节数字（与画像三硬约束同构）。新模块 `main/companion/hear.js`：滚动窗口聚合 → 中文听感（响度档位 5 档 + 「像什么」映射（低频重+有起伏→音乐型/低频持续→机器嗡鸣/中频→人声/高频碎响→键盘型）+ 突变事件（两段不重叠窗 12s vs 前 10s：突然吵起来/突然安静，事件保质期 3 分钟）），**诚实降级**（hearOn 关/没数据/过期 → ok:false 带原因，绝不编）。接线：① chatter.decide 注入【你耳朵里的世界】（安静且无事 → 空串不浪费预算；明说「听到的是特征，听不出内容，别编他说了什么」）② 自主活动场新增 `listen` 工具（限 12 次/场，journal kind='listen'）③ 开关 `global.companion.hearOn`（默认开，改后重启生效）。**双流设计**：语音捕捉（常驻倾听）开着 → 复用它的 analyser（hearTick 挂在 VAD 120ms 循环上，一次采集两用）；语音麦没开 → 听觉自己开轻量流（getUserMedia 仅 analyser 无 MediaRecorder，失败留痕 5 分钟退避，换屏跟宿主走）。测试 hear.test.js +12（诚实降级/安静不出声/三类声音分野/突变双向/事件保质期/240 限幅/非法拒收）。⚠️ **阈值全是首版经验值**（麦克风增益因设备而异），映射表对着真机听感输出迭代，别拍脑袋改。✅ **23:02 真机实锤**：`[renderer] hear: 听觉轻量流已开` → `[hear] 首条听觉样本进来了`（23:02:28）；🟡 待真机：嘀咕出现接得上环境声的内容、listen 工具被调用（journal 里看）、音乐/键盘/说话的「像什么」判断准不准。**注意**：装上后 Windows 麦克风指示灯会常亮（她竖着耳朵），不想让她听 → config.json `global.companion.hearOn: false` 重启（语音捕捉的麦克风开关不受影响）

- ✅ **0.46.53 开源仓库测试基建归零（20:33 用户「还有bug吗」巡检发现）**：`npm test` 1069 例中 2 失败均非产品 bug——① `app/tools/test-eyes-e2e.js` 是必须用 Electron 跑的手动 E2E 工具（文件头写明），被 `node --test` 按 `test-*` 通配误收后在纯 node 下 `app.whenReady` 必炸 → 改名 `eyes-e2e.js`（零引用，安全）；② `scripts/live-test.js` 硬编码读仓库内 `data/config.json`——隐私清洗后本就不该存在，且暴露一个隐性旧病：**测试污染期间仓库 data/ 里躺着真实凭据，`npm test` 每次全量都在静默打真实模型 API** → 改为默认跳过、`RYZA_LIVE=1` 显式开启，凭据走候选链（`RYZA_LIVE_CONFIG` 环境变量 → 宿主 `%APPDATA%/ryza-assistant-app/assistant/config.json` → 仓库 data/，找不到优雅 skip）。全量现为 1066 过/0 失败/2 跳过。两处修复已同步 ryza-assistant 工作副本（测试基建，无运行时行为变更，**无需重装**）。连带更新开源仓库 CHANGELOG 0.46.53 段
- ✅ **0.46.52 记忆 git 快照安全闸（19:40 用户「自动提交GitHub？查清楚提交了什么东西」）**：开源仓库 partner-execute-me 13:26/18:54 两笔 `ryza@partner.local` 署名的「记住：主人在 QQ 上让他记一条」神秘提交破案——**是 im.test.js 的「0.45.28 remember 工具循环」用例干的**：它真的调到核心 remember 工具（用例目的就是验证链路通），而 config.js 的 `dataDir` 默认 = `process.cwd()/data`，该测试没调 `initDataDir`，于是 git 命令（cwd=测试进程 cwd 下的 data 路径）**向上找最近的 .git**：在开源仓库 `partner-execute-me/app` 下跑全量测试时找到的就是本仓库 → `git add -A` 把刚 cp 进去的 64/10 个文件全部提交（作者=AUTHOR_MODEL ryza、message=用例里模拟的 QQ 消息文本，与 ryza.log 无关——它只记自己工作区的 commit）；在真机 `ryza-assistant/app`（非 git 仓库）跑时向上找不到 .git，commit 静默失败，所以本地一直没暴露。真机 `app/data/workspace`（10-30 起的独立小仓库）里的 10 笔同 message 提交同理，时间戳与每次全量回归完全吻合。**从未推上 GitHub**（两笔都在 squash 合并时丢弃；远端仅 4 笔 ciallooooo 署名提交）。修两层：① partner.js `ensureRepo` 安全闸——`rev-parse --show-toplevel` 必须**就是**工作区自身（realpath 比对），否则该 scope 停用 git 快照只写文件（`repoDeniedSet` 按 scope 拒绝，不动全局 gitOk）；② im.test.js 该用例补 `initDataDir(临时目录)` + `resetCache()`。顺带清理 `app/data`（纯测试垃圾：PARTNER.md 全是重复测试行）。验证：开源仓库全量 112 绿且跑完 `git status` 零污染、真机全量 112 绿且 `app/data` 不再生成。GitHub 推送因本地代理对 github.com 域持续 502 未完成（`05c1778` 0.46.51 同步 + `1abecec` 0.46.52 安全闸待推，内容均干净）
- ✅ **0.46.51 开口事件驱动 + 情绪残余（18:05 用户「做」——活人感队列 3+4）**：**3 = poke 事件驱动**——「到点可以说」是计时器不是活人。rhythm 新增 `poke(reason)`：通道撞上真实事件（watch 判读出值得说的画面但 `ask` 返回 not-yet）时把 nextAt 提前到 75~150 秒后，「憋了一下还是说了」；刹车全保留（最小间隔/预算硬顶/每日上限/睡眠闸一个不少），poke 自身 5 分钟冷却防「每 60 秒看屏就每 60 秒拽表」，nextAt 本来就近时 `already-soon` 不动；watch 在 pending 攒话分支里调 poke（pending 6 分钟有效期 + poke 提前 → 事件真的能说出来而不是过期作废）。**4 = deflated 情绪残余**——needs 新增瞬时心情字段 `deflated`（不是压力，不驱动出门）：`discharge('interrupt')` 记上 55（自己正做得起劲的事被主人回来打断 → 扫兴），随时间每分钟 -3 自然消散（约 18 分钟散尽），`discharge('session')` 不留残余；`moodBlockOf()` 出语气块（≥40 强：「语气里带一点没散掉的怅然，可以叹半口气，但别指责谁——他是回来了，这是好事，只是可惜」；20~40 弱：「顶多留一丝影子，别再提这件事」；<20 不出声——不装模作样）；chatter.decide 注入【你此刻的心情底色】。loadState/saveState/status 全带 deflated（旧 needs-state.json 无此字段读作 0，天然兼容）。测试 rhythm +2（poke 提前/min-gap 拒/冷却拒/预算硬顶拒）、needs +1（interrupt 记上/消散曲线/语气块三档/session 不留/落盘往返），全库 112 套件绿 + audit 零新增 + wirecheck 过。⚠️ 待真机：watch 想说被挡时 main.log 出现「事件触发提前开口」、pending 那句 2 分钟内说出来；下次她自主活动被打断后 20 分钟内的嘀咕带扫兴语气
- ✅ **0.46.50 被吞句变资产 + goals 驱动选题（17:49 用户「就按你说的做」——负反馈放宽第一步）**：数据实锤——复读闸**一天吞掉她 210 句**（撞车 203 次），这些生成全部无痕消失；而 goals.json 其实在真用（在工作区根不在 pc/autonomy，巡检查错过位置；她 12:01 还给自己立了「自分から誘ってみる」的社交目标），但自主活动选题从来没读过它。修：① **吞句入账**——chatter 复读闸吞掉的每一句走 `noteSwallowed → inner.noteSuppress`（suppress 事件类型），日记时间线自动带「我本来想说但没说」（timelineOf 既有行，之前只有负反馈收着的话在用，吞句通道一直没接）；② **念头池低频漏出**——chatter.decide 注入「你刚才想过又咽回去的话」（`inner.suppressRecent(n, 2h)`，只取近 2 小时的），提示词明确要求「必须换个说法：更短/更随口/漏半句，别原样照搬（原样会再被收回去一次）；多数时候放着不说也正常」——防「漏出即撞车再入账」死循环；**suppress 绝不进 recentVoices 镜子**（kind 过滤，否则她会跟自己的念头撞车）；③ **泄压放宽**：SWALLOW_ESCAPE 5→3（持续话题下 ~2 分钟漏一轮）、SWALLOW_ESC_SCORE 0.5→0.65（「话题相近内容不同」的句子更容易活，最像变体照吞保 0.45.85 底线）；④ **goals 驱动自主选题**——autonomyPool 把 active goals 的 title 塞进 `out.thoughts`（pickTopic 最高优先来源：「她最近在想的」），她立的「想试试用视频查资料」从此会变成下一场自主活动。soliloquy-system 泄压断言更新 + 新增吞句入账/素材注入/接线断言（17/17），全库 112 套件绿 + audit 零新增 + wirecheck 过。⚠️ 待真机：明天看日记里出现「想说但没说」的行数（应从 0 变成几十）、泄压放行频率上升、下一场自主活动是否用了她 goals 里的题目

- ✅ **0.46.49 记账覆盖缺口修复（12:54 用户「健康巡查已经巡查两次了」→ 每日巡检自动化两轮实锤）**：巡检自动化（每天 10:00）11-04/11-05 两轮留痕连起来抓到一个真 bug——**carry.json 与 site-stats.json 自功能上线（0.46.17）以来从未首写**。根因：真机成功自主活动全是「完全开放挡」（free），而 ① `bumpSite` 只在 `runner.kind==='browse'` 触发 → 品味账永不进；② `writeCarry` 虽对 free 挡的 user-back 触发，但 topic 只在 browse/space 挡本地选题，free 挡恒空 → `writeCarry` 开头 `if (!t) return` 静默 no-op（0.46.19 修「包在 if(carry) 里」时没意识到 topic 本身在 free 挡就是空的）。修（三处协作）：① **runFree 把账带出来**——场次统计独立成 `collectStats()`（recap 兜底汇报与返回值共用），返回值带 `sites`（开过的域名，去重）/`watched`(看掉的视频标题，去重)/`topic`（watched 标题 > 最近一次搜索词(q/keyword/wd/search/query 参数) > 无），user-back 与正常收场两条 return 都带；顺带修两个旧账病：watch detail 是「标题 URL」拼接、标题带空格会被 `split(' ')[0]` 切坏（改按 URL 锚点切）、看失败的场（detail 无 URL）不再被数成「看了视频」；② **调度层 free 场记品味**——`siteKeyOf(host)` 映射回 SITES key（子域 `endsWith('.'+host)` 命中），认得的站 bumpSite，认不得的不记账不污染；③ **被打断且无旧牵挂时写新 carry**——`unfinished && free && !carry && r.topic` 用她真看过/真搜过的东西兜话题，有旧牵挂保留不刷（时间词更诚实），正常收场照旧销账。顺带修 runFree 没把 `biliWatchFn` 透传给 freeToolsOf 的注入断链。测试 autonomy +3（54/55→含调度层 llm 模块缓存替换样板：runFree 带账/watched 优先/搜索词兜底/空场不写/siteKeyOf 映射/free 挡打断→site-stats+carry 首写→正常收场销账），全库 112 套件绿（security 的 reg.exe 沙箱拦截有容错桩不影响） + audit 零新增 + wirecheck 过。✅ **17:39 真机实锤**：carry.json 首写成功（`chromium keyword_search_terms lower_term`——她查 Chromium 内部表被打断）
- 📌 巡检自动化本体：「Ryza 每日功能健康巡检」（WorkBuddy automation，每天 10:00，只读不改），留痕落在 `Documents\.workbuddy\memory\automations\<id>\memory.md`。11-04 轮抓到 0.46.35 autonomy 400 全灭（0.46.36 已修，127 次全败→零复发）；11-05 轮确认修复生效 + 抓到本条记账缺口 + goals.json 停在 11-03（**后续更正：goals.json 在工作区根，一直在正常写，巡检查错位置**）

- ✅ **0.46.48 朗读中断即作废（22:47 用户「聊天都到后面了，indextts 还在读前面的话，被中断了就不用读了」）**：排查实锤今晚 TTS 全是 Fish 云端成功（无 IndexTTS 兜底记录），慢的感觉来自**长音频播放积压**（1.8~2.3MB wav ≈ 28~36s 一段）+ 0.46.46 泄压阀让她话变多 + 0.46.47 游戏模式不再默认静音——三重叠加第一次让「朗读不跟最新」大规模暴露。核心洞：①渲染层合成窗口——新朗读发起后旧的还在播，要等新合成回来才打断（Fish 11s、本地兜底几分钟）；②主进程零取消——被顶掉的合成照跑照播，IndexTTS CPU 兜底一跑几分钟白烧；③渲染层合成结果回来无条件 playVoice，会把正在播的**新**朗读反杀。修（三层协作）：**主进程** speakRunSeq 代次 + AbortController——新请求 abort 旧云端请求（Fish signal 透传 tts.js nfetch，AbortSignal.any 与 30s 超时并存），入口 `ttsLocal.cancelPending()` 作废本地排队/打断正在跑的（IndexTTS 分片循环每片之间检查 cancelled），所有合成成功返回前查代次（过期返回 stale 不下发），被顶掉的请求不再走本地回退链；**渲染层** readSeq 代次——新朗读意图 `stopVoice()` 立即打断旧语音、合成回来查代次丢弃过期结果。顺带修 0.46.39 长句汇总日志残留的 /640 换算 bug（应为 /64000）。soliloquy-system +1（16/16）+ tts-local/subtitle/danmaku/companion/voice 回归绿 + audit 零新增 + wirecheck 过

- ✅ **0.46.47 游戏模式默认不接管摆放（20:29 用户「自动进游戏模式为什么默认静音，为什么要缩小，我都放副屏了角色多大我为什么要管」）**：实锤链——真机 `gameModeCorner="none"`（0.45.83 已做不挪窝）但 `gameModeScale`/`gameModeMute` 未配置 → 走旧默认：**强制缩 0.7× + 静音**，这是给「角色在主屏挡游戏」场景设计的，副屏用户纯属被强加。深层发现：渲染层安静令（quiet on → stopVoice+isQuiet 全闭嘴）是 enter 时**无条件**下发的，`gameModeMute` 开关实际只影响开场白念不念——即旧代码里「静音开关」根本关不掉静音。修：① scale 缺省=保持进入前大小（saved.scale=petScale），显式配置才 clamp 0.4~1.3（上限放宽对齐滑条 max=130）；② `mute = c.gameModeMute === true`（默认不静音），安静令只在 mute 时下发、`saved.muted` 记账、exit 只解除自己下过的（不误清别处安静状态）；③ 顺手清死字段 `sound`（渲染层 quiet case 从未消费）；④ state()/settingsView 展示默认值同步（scale 跟 petScale、mute 默认关）；⑤ 设置页 UI：gmMute 去 checked 硬编码、gmScale 滑条 40~130、文案改「默认保持你摆好的样子不动」。游戏模式保留的行为：停自主溜达（pet.setQuiet）、她的话走弹幕层、位置恢复——这些是「不碍事」的本职。game-auto +1（9/9 静态断言），companion/audit 零新增 + wirecheck 过

- ✅ **0.46.46 复读闸泄压阀（19:36 用户「还有其他 bug 吗」→ 巡检实锤）**：18:38~19:00 持续话题风暴——她在盯主人找工作/投递的屏幕，镜子把模型锚在同几个话题词（申込/11人/画面）上，生成的每句都跟最近 90 分钟说过的话撞车：**22 分钟 8 轮 24 句全吞、只漏 1 句**；分小时统计 15 时吞 29 放 7、16 时吞 27 放 6、18 时吞 30 放 8（每天 ~90 次 LLM 生成被丢掉）。0.46.42 的 90 分钟时间窗解决了「跨几小时的旧台词拦新句」，但「持续话题下的连环撞车」没有出口。修：chatter 加 `swallowStreak` 泄压阀——**连续咽回去 ≥5 句（SWALLOW_ESCAPE）就放行一轮**，但泄压时仍拦 `score ≥ 0.5`（SWALLOW_ESC_SCORE）的最像变体，0.45.85「一个半小时六变体」的防复读保住底线；放行即归零；泄压留痕日志。数学：风暴期每 2 分钟吞 3 句 → ~4 分钟泄压一次，放行的都是「话题相近但内容不同」的句子，正是活人感该有的样子。测试 soliloquy-system +1（15/15：阈值/分数线/escape 条件/计数归零/留痕），companion/watch/inner 回归绿 + audit 零新增 + wirecheck 过。**同场巡检其余全健康**：0.46.42 游戏模式闸真机生效（19:24~19:36 omofun 全屏反复进出，零起场抢屏）、0.46.33 被晾嘀咕两次都正常出口、闹钟/TTS/翻译/嘀咕字幕全链路无失败、0.46.45 坐卡不隐身持续有效

- ✅ **0.46.45 spine 整只消失修复（17:55 用户「为什么 spine 会消失」）**：日志实锤——17:42:40 她坐上 WorkBuddy 卡片后整只隐身 10 分钟（用户重启两次才回来），17:54:57 重启后又坐卡**再次隐身**。根因链：坐卡片公式 `pos.y = card.y + stageHeight()*SIT_HIPS`（锚点=舞台底边，胯部对齐卡片顶边）——petScale=1.25 时 WorkBuddy 卡片贴屏底，算出 **pos.y=1489 > 屏高 1440**；渲染层宿主判定 `inside` 要求锚点在窗口内 ±2px，锚点出屏 → **两块 overlay 都判「不归我管」→ el.hidden 全隐藏 → spine 整只消失**。修（主渲染协作）：① 主进程 `hostBoundsFor(x,y)`——遍历全部显示器取离锚点最近者（同距优先 x 命中的那块，并排双屏消歧），随 `pet:pos` 广播/单发都带 `hostBounds`；② 渲染层 `applyGlobalPos` 存 `petHostHint`，`inside = hint ? (hostIsMe || inX&&inY) : inX&&inY`——锚点纵向出屏时由提示屏接管，stage 超出窗口部分自然裁剪（与跨屏拖拽的裁剪语义一致），stacked 屏由「最近距离」消歧不会双宿主，无提示（旧路径/demo）保持原判定。注意 0.45.31 的 boot 托回只管「头顶出屏」（y 过小），本例是底边出屏（y 过大）方向相反。测试 deskco +1（10/10：hostBoundsFor 定义/同距消歧/两个发送点都带/渲染层存提示/hostIsMe 判定/inside 组合），companion 1/1、pc 9/9、petlink 7/7 回归绿 + audit 零新增 + wirecheck 过。⚠️ 待真机：她坐 WorkBuddy 卡片不再隐身（下半身轻微裁剪属正常——坐高凳式脚踝本来就贴舞台底边）

- ✅ **0.46.44 全库静态巡检·死代码清扫（17:26 用户「遍历一下看看有没有 bug 和 0 调用的」）**：写了一次性静态扫描器（括号平衡解析 185 文件 646 个导出符号 + require 解构核对），实锤清掉 **7 处 0 引用死代码**：① companion/index.js 死导出 `remoteStatus`（0.24.0 settingsView ReferenceError 事故的遗留键，状态实际走 ctx 下发 3768-3771）；② autonomy.js 死导入 `projectsMod`（0.45.19 注释说 re-export 用，实际从未 re-export，项目注入走 d.projects）；③ assistant/index.js 的 `dialog`、④ cua/confirm.js 的 `app`、⑤ im/brain.js 的 `stripChannelTag+plainText`（只用 readableText）、⑥ test/obs.test.js 的 `Module` 共 5 处死导入。**bug 面零发现**：185 文件语法全过、导出对象无重复键、无 TODO/FIXME/垃圾残留、86 个测试套件全绿（security 的 reg.exe 沙箱拦截有容错桩不影响断言 8/8 过）。扫描器误报教训：world/index.js 的 `onDisable` 在注释块里被解析成导出——静态扫描结果必须人工核实再动手。纯零行为变更，无新测试。

- ✅ **0.46.43 并流查重·短台词兜底 + 畸变动作标签清洗（15:36 用户「怎么第一句又重复了」）**：聊天记录实锤——15:36 回复开头「う……当たり。」连说两遍，第二份还带 `[shy]`。两个根因：① **0.46.29 并流查重有一道 6 字最小长度闸**，短开场白（归一化后「う当たり」=5 字）直接放弃查重 → 台词前置一遍 + 正文那份 = 开头重复；② 模型把 `[action:shy]` 写丢前缀成 `[shy]`，extractInlineAct 只认带前缀的 → 正文原样漏进气泡/聊天记录。修：① `saysAlreadyIn` 短台词走「归一化后正文包含」兜底（短句变体没法比，只挡原样照抄）；② reply-text 新增 `stripActTags`——**白名单只认 11 个正牌语义标签**（与 context.js petTools 提示词同一份词表：acknowledge/disagree/think/explain/excited/wave/shy/surprised/comfort/playful/invite），plainText/readableText 出口剥掉；extractInlineAct 同步把裸标签转成动作演出来（她本意是想演）；其它方括号词（[mock]/markdown 链接）一律不碰——首版用 `[a-z_:-]{2,24}` 宽匹配把测试里 `[mock]` 都吃了，教训：**出口清洗必须白名单，宽匹配必误伤**。mock 加 `saysplitshort:` 场景；assistant 38/38（+1）、reply-text 6/6、subtitle 7/7、danmaku 11/11、qqsync 7/7 全绿 + audit 零新增 + wirecheck 过。⚠️ 待真机：下次短开场白不再重复、正文无 [标签] 残留

- ✅ **0.46.42 巡检双修（15:19 用户「有系统不合理或者不对劲的吗」→ 全量巡检抓出两处）**：① **autonomy × 游戏模式冲突**——autonomy 唯一闸门是键鼠空闲 5 分钟，**没有游戏模式/全屏判断**（11-04 14:56 实锤：omofun 全屏时键鼠空闲被当「主人离开」，她起场开 google.com 还按 alt+tab 把主人全屏切出去，gameAuto 才发现「切出游戏了」）。修：tick 闸门加 `gameOn()`（读 gameMode.state().on，可注入），游戏模式开着绝不起场；主人中途开游戏由既有 userBack 闸兜住（一动键鼠就停）。② **复读闸/镜子无时间界**——inner.recentVoices(8) 取事件文件「最近 8 句」不限时间，她话说得少的下午窗口横跨两三小时：12:33 的台词 14:49 还在拦新句，14:49~15:02 生成的十几句几乎全被咽回去（一小时没开口）；同时旧台词挂「最近说过」进提示词镜子，反过来误导模型围着几小时前的话题打转——两股力叠加=又吵不了又胡思乱想。修：voicesim 新增 `REPEAT_WINDOW_MS=90min`（保留 0.45.85「一个半小时六变体」防护），inner.recentVoices 加 sinceMs 过滤，四处调用点接上（chatter 镜子+硬闸 / makeNudgeLine 镜子 / proactiveGate extraHistory）。顺带确认 0.46.41 真机生效：14:57 两句嘀咕聊天记录带中文译文（sub 入账命中）。测试 autonomy +2（47/47：游戏中不起场/关了恢复/依赖默认值）+ soliloquy-system +1（时间窗 9 断言）；voicesim/inner/watch/companion 回归全绿 + audit 零新增 + wirecheck 过。⚠️ 待真机：游戏模式中她不再起场抢屏；下午安静期后她能正常开口（不再连环咽回去）

- ✅ **0.46.41 嘀咕入账带译文（14:14 用户「自言自语又不翻译了」）**：排查实锤翻译管线没坏（13:53 独白译文 2s 生成并推气泡），坏在**入账**——sayNarration 的 ledgerNote 只入日语原文不带 sub，聊天记录/时间线里全是日语。修法：① 入账挪进译文 race（≤6s）里，`sub: display`（译文空/超时/关翻译只入原文不丢账，ledgerDone 防重）——渲染层聊天框本就支持「原文下挂 sub 译文」（0.45.x 主聊天同款）；② 对话时间线 renderTimeline 补 sub 渲染（原来只显示原文）。测试 soliloquy-system +1（入账带 sub/防重/兜底/时间线渲染 5 断言），ledger-note 旧断言兼容，companion/ledger/audit 全绿 + audit 零新增 + wirecheck 过。**14:57 真机实锤：两句嘀咕聊天记录带中文译文 ✅**

- ✅ **0.46.40 看屏周期 180s→60s（14:00 用户「间隔有些大所以体感上跟没看一样」）**：watchIntervalSec 默认值与真机配置都调到 60s。依据：0.46.38 本地视觉化后「看」近乎免费（截屏+本地描述+一次小的纯文字判断，图不出本机），180s 是云端收图时代（1~2 分钱/张）的保守值。防连珠炮的保留项没动：下限仍 60s、画面指纹 same-screen 跳过、静音时段、人不在整轮跳过、开口频率仍由节奏器管（proactivePerHour=8/minGap 180s 未动）。抖动与自适应保留：没说过话时看得勤（k=0.7）、预算紧张时看得懒（k=1.8）。watch 测试 +1（15/15）、watch-vision 5/5、audit 零新增、wirecheck 过。⚠️ 真机 config 写入必须趁杀进程后（store 缓存写回会盖掉运行中改动，坑#10）

- ✅ **0.46.39 IndexTTS 兜底可用化：长句分片合成（13:44 用户「indextts真的有运行过吗」排查 →「就这么做吧」）**。排查实锤：IndexTTS 自 0.22.0 上线以来**从未成功产出过一段语音**——唯一一次调用是 11-02 10:52（`%TEMP%\ryza-indextts.log` 幸存）：启动/加载 48s/就绪全通，但那次是 499 字长句，本机 12 核 CPU RTF 15+ 必撞死 240s 超时（日志停在合成中途，无完成行）；此后 Fish 云端 TTS 一直健康，第 3 级兜底再没被摸到。修法（ttsLocal.js）：① `splitForIndexTts`——句末标点（。！？…）优先断句、逗号级（，、；：）次之、硬切兜底，unit 贪心合并到 ≤50 字/片，内容一字不丢；② synthesize 逐片合成，每片各自受 SYNTH_TIMEOUT_MS(240s) 约束，PCM 同格式顺序拼接成一个 wav，片日志带进度（片 i/N）；③ 片数上限 8（约 400 字）——CPU 上更长的语音没有意义，超长截断并留痕；④ 顺手修日志换算 bug：音频秒数 `pcm.length/640` 应为 `/64000`（32kHz×2B），旧日志夸大 100 倍。**真机单片实锤**：62 字 171s 合成成功（RTF 11.3，gpt_gen 78s+扩散 58s），50 字片 ≈140s，240s 预算余量 40%+。测试 +5（tts-local 11/11：拆分不变性/边界断句/分片调用序/PCM 拼接 wav 头/8 片封顶/中途失败报片号）；audit 基线 +2（_setPostTts/_setEnsureServer 测试注入点）。⚠️ 待真机：Fish 挂掉时回退链真正出声（日常难复现，链路已被假 HTTP 层全覆盖）

- ✅ **0.46.38 盯屏陪伴切本地视觉（13:11 用户「隔一会看一眼点评就够了」拍板后排查发现功能早已存在）**：watch 链路（0.18.0 屏幕监控陪伴）本来就是「周期截屏→按人设判断→pet_say 气泡」，且真机 `watchEnabled=true`、`watchSkipFullscreen=false`（**全屏游戏照看不误**，提示词 32 行明确有「游戏高光」触发项）——用户要的「陪打游戏隔一会瞄一眼点评」功能在跑，只是「看」走 deepseek 云端视觉（每 3min 一张图、1~2 分钱/张、**游戏画面一直在上传云端**）。两处切换：① **新建 watchVision.js `localizeImages`**：chat 前把最后一条 user 里的 image_url 交本机 vision.describe 转文字（客观描述指令含 HUD/窗口/正在发生什么），云端只收文字做判断——省图片 token+不出本机；本地视觉没接上→**回退原图**（deepseek-flash 2026-10 起有视觉，兜底不哑）；只看最后一条 user（测试抓出从历史翻旧图会张冠李戴）② **shoot 换 screens.captureAll 多屏拼图**：以前 cua._shoot 只截主屏——游戏开在副屏她等于看不见。测试 watch-vision 5 例（替换/回退/无图/异常不上抛/只取最新）+ watch 回归 14/14 + vision 6/6 全绿 + audit 零新增 + wirecheck 过。真机验证口径：日志出现 `[watch] 本地视觉没接上` 与否区分走没走本地；游戏里她会基于本地视觉描述说话

- ✅ **0.46.37 本地视觉通道 vision.js + 挡 3 look_screen（12:47~13:0x 用户「本地部署一个小视觉模型」想法）**：背景——deepseek-flash 自 2026-10 官方已支持收图（实测 200、250 tokens/张、每张 1~2 分钱、截图出本机），但只能「一张一张发图判断」；挡 3 高频看屏（真机 74 场 screenshot×338 全是盲看 OCR）用它贵且泄隐私。**本机实测 qwen3.5:4b 能吃图**（Ollama 在线 11434；OpenAI 兼容层 image_url 与原生层 images 双接口正确读图；⚠️ 它是 thinking 模型，max_tokens 给小了回复为空，describe 默认 500）。新建 `src/main/companion/vision.js`：probe()（GET /api/tags 按规则挑视觉模型——qwen*-vl > qwen3.5 特判(实测依据) > minicpm-v > llava 等 > 名字带 vl/vision 兜底；探测缓存 60s/失败缓存 15s；配置 model 可强制指定）+ describe()（截屏 buffer→dataURL→/v1/chat/completions，超时 120s，**失败一律 {ok:false, reason} 绝不装看见**）+ configure/setFetch/resetForTest。挂载：**freeToolsOf 加 look_screen 工具**（screens.captureAll 全屏拼图→本地视觉描述，每场限 8 次，journal kind='look'，recap 计入「看了 N 眼」，未启用时如实说看不见+指向 read_text；captureFn/visionObj 可注入供测试）+ runFree 提示词补引导。聊天链路 see_screen/抬眼**不动**（deepseek 直收图质量优先）。测试：vision.test.js 6 例（探测选中/无视觉模型如实报/Ollama 没起如实报/dataURL+max_tokens≥500/HTTP500 报错/规则不误伤纯文本模型）+ autonomy +4 例（描述+journal/未启用降级/限 8 次/主人回来 gate 拦）= autonomy 45/45；video 5 + curiosity 24 + qq-sleep 8 回归全绿；audit 零新增 + wirecheck 过。**真机直测实锤**：vision.js 连真 Ollama 探测选中 qwen3.5:4b、红图正确描述、7.5s（CPU 推理，低频 look 可接受）；13:06 补拉正牌视觉模型 **qwen3-vl:4b**（3.3GB，探测规则 pri:1 自动切换，蓝图实测正确 13.9s；⚠️ 拉取时开着 Clash 会因 DNS 劫持 R2 CDN 到内网被 ollama 拒——**关 VPN 再拉**）。⚠️ 待真机：挡 3 场 journal 出现 kind=look 的看懂画面记录

- ✅ **0.46.36 双 bug（00:31 用户截图「说了要睡觉她还在 QQ 催回复」+ 顺带发现挡 3 全灭）**：① **做梦完成清掉睡前静默**——index.js 做梦完成处调 `onUserTalk`（语义=「主人说话了」，会清 sleepUntil+重置 baseAt），真机时间线：00:05 道晚安静默到 07:05 → 00:42 重启恢复 → **01:13 做梦完成（boot）清静默** → 02:06 reach 第 5 阶 QQ、02:39 reach 第 1 阶「已经过了85分钟」（baseAt 被错记成做梦时刻 01:13，02:39-01:13≈85 分钟）→ 主人睡得好好的被吵。修：idleNudge 新增 `noteSelfSpoke`（她开了口：只记 lastProactiveAt，**绝不动 sleepUntil/baseAt/stage**），做梦完成改调它。② **0.46.35 自己引入的重名 bug**：spaceToolsOf 与 freeToolsOf 各有一份 watch_video（0.46.32 挡 2 也加了），spaceDefs 并入挡 3 时只过滤了 open_url → LLM 400 "Tool names must be unique" → **挡 3 从 00:52 起场场全灭**（journal 一条动作都没有，用户还以为她在正常活动——静默失败又一课：失败只进 main.log）。修：过滤名单加 watch_video。③ 顺手修 proactive-one-ledger 断言过期（0.46.22 dmHold 把 noteSpoke 与 subtitleFor 隔开，断言早该跟上）。测试 +2：qq-sleep-repeat（noteSelfSpoke 不清静默）+ autonomy（watch_video 只一份）；qq-sleep 8/8 + autonomy 41/41 + one-ledger 5/5 + memory-decay 11/11 全绿 + audit 零新增 + wirecheck 过。⚠️ 待真机：夜里道晚安后不再有 reach 唤醒骚扰；挡 3 场恢复出现动作

- ✅ **0.46.35 挡 3 行为面拓宽（00:0x 用户「明明设置的是3档，但他做的事跟1档一样」）**：排查结论=档位链路本身是通的（config 里 autonomyLevel=3、真机 74 场全跑的 runFree/完全开放挡）——**是行为被提示词锚窄了**。真机 journal.jsonl 实锤：74 场动作分布 screenshot×338/zoom×94/open×63，**type 只有 14、move 只有 3**——她真的只会「看屏幕+开网页搜东西」，观感=挡 1。四个根因同修：① **挡 3 从没有地盘工具**（挡 2 的 space_* 笔记/整理 fs 工具挡 3 不给，而提示词一直叫她「查到的记进笔记」——断链，同类坑 #1 又现形）→ freeToolsOf 加 spaceDir 并入 space_*（过滤挡 2 白名单版 open_url 留任意 https 版），调度器传 spaceDirOf(c)；② **sys 重写**：删「比如去看看 HN」浏览锚定开场 + 删「建议做的事：看网页/watch_video」窄清单 → 行为面拓宽（查东西/看视频/地盘写点什么/琢磨平时没空弄的事，不用每次都一样）；③ **补隐私红线**：设置页「电脑画像」从第一天承诺「不会翻你隐私」但提示词从没写过这条——真机日志她在 focus Clash、点 Documents，现明写「聊天对话/日记写一半的文档/密码账号支付/明显私人的历史收藏不翻」；④ **开场消息**「先看看现在屏幕上是什么」让她每场先侦查 4~6 步（短场刚侦查完就被打断）→ 改「看一眼屏幕就可以动手，别光侦查」。**顺手修 nudge 时序 bug**：主人回来（stopped）后循环还在连推「收尾前对照计划」（真机 22:18:24 stop 后又推两条）→ 循环头 free.stopped() 即 break；recap 统计补「记了 N 笔笔记」。测试 +3 例（space 并入路由真写文件/open_url 不重复/sys 断言无 HN+红线在场/nudge 零推送）；autonomy 41/41 + video 5 + curiosity 24 + inner 26 全绿 + audit 零新增 + wirecheck 过。⚠️ 待真机：挡 3 场出现非浏览动作（写笔记/多样主题）、不再翻主人私密窗口

- ✅ **0.46.34 心情自然回血（23:5x 用户「情绪的心情恢复满吧，不然测试不好」）**：0.46.33 冷落感知每晾一次 mood -0.03，但 mood 此前**只掉不涨**（只有互动才 +，没人碰就永远沉底）——测试几轮心情就起不来了。修：`self.js` 加 `MOOD_REGEN_PER_HOUR=0.3` 的自然回血——`DEFAULT_STATE` 加 `moodAt` 计时点，`getState` 读时现算（mood<1 时按经过时间 +0.3/小时，封顶 1），攒到 0.002（约 24s）才惰性落盘（读是高频的，回血不追着读跑）；效果=被晾一次的 -0.03 六分钟就补回，闷一晚能从 0 回满（有情绪但不记隔夜仇）。所有 mood 写点同步重置 `moodAt`（noteAttention/noteSnub/watchSulkMood/resetState/rollbackState）；**测试抓出真 bug**：首版回血写盘没重置 moodAt → 下次读按旧点重算会**重复回血**，已修。防回归 snub.test.js +2 例（回血落盘/满值封顶/晾一次只-0.03/老状态无 moodAt 不凭空回血）；snub 8/8 + 回归 58/58 + audit 零新增 + wirecheck 过。⚠️ 待真机：设置页心情百分比随时间回升

- ✅ **0.46.33 冷落感知 snub（23:3x 用户拍板：3 分钟不回要有负面情绪、要自然表现、原负反馈没实际效果要增强）**：旧机制三个冤案全修——① 窗口 10min→`coldShoulderMin`（默认 3 分钟，设置页可调，`coldShoulderOn` 开关，feedbackMode 总闸仍然有效）② **人不在电脑前（键鼠空闲≥5min）不记**（原来主人出门她说话没人回也算被无视）③ **游戏模式/学习模式豁免**（inner ctx.exempt）。记账升级 `self.noteSnub`：snubStreak（2h 窗口累加）+ mood 微降 -0.03/次（不是暴跌）+ ignoreStreak/quiet 联动。**表现三路**（增强「实际效果」）：① 当场自言自语嘟囔一句（streak≤2 才说，3+ 次已经收着不烦人）——LLM 现生成（snubLine：人设+场景+「不汇报状态/不质问/不冷战宣言」约束，同 alarmLine 模式 20s 超时）失败落四语言兜底池，走 sayNarration 通道（不期待回应、不再进负反馈——自言自语语义底线）② 40 分钟内状态块（stateWords：1~2 次「小失落话变淡」/3+ 次「泄气收着」）③ rhythm 主动开口 min-gap ×(1+0.4×streak)——被晾→真的少主动凑。inner 心跳：45s 独立 snubTimer（原 5min 结算心跳对 3min 窗口太粗）。设置页「她的内心」区加开关+分钟数（i18n 四语言）。测试 6 例（noteSnub 累计/翻篇/stateWords 两档/四场景判定/开关/rhythm 拉长）。**踩坑**：noteSnub 返回的是 state 对象不是 streak（首版 `[object Object]` 使 streak<=2 永假、onSnubbed 静默不触发——测试抓的）；rhythm cfg 只认 proactiveMinGapSec 不认外部 minGapMs。⚠️ 待真机：被晾当场嘟囔、后续回复变淡、主动开口变少

- ✅ **0.46.32 她自己看视频（23:2x 用户澄清「我说的是让她可以自己看视频就行了」——不只是聊天工具，是自主活动）**：biliWatch 接进自主活动三挡——① 挡 1「去B站」场（site.key==='bili'）不再滚动搜索页，改为 runVideoWatch：搜→读字幕→嘀咕→进经历管线，全程不动键鼠（连 Ctrl+W 都省了、无残留窗口风险），按视频时长给真实时间流逝（封顶 4 分钟且不超单场预算）；② 挡 2 地盘工具集 + 挡 3 完全开放各加 `watch_video` 工具（提示词各提一句），recap 认得 watch 事件；③ spaceToolsOf exec 修 `String(await t.run(...))`（watch 异步，原写法会把 Promise String 化）。测试 5 例（挡1看视频/失败如实/挡2工具/挡3工具/静态接线防断链）。⚠️ 待真机：她自主活动里真的看一个视频并嘀咕感想- ✅ **0.46.32 她自己看视频（23:2x 用户澄清「我说的是让她可以自己看视频就行了」——不只是聊天工具，是自主活动）**：biliWatch 接进自主活动三挡——① 挡 1「去B站」场（site.key==='bili'）不再滚动搜索页，改为 runVideoWatch：搜→读字幕→嘀咕→进经历管线，全程不动键鼠（连 Ctrl+W 都省了、无残留窗口风险），按视频时长给真实时间流逝（封顶 4 分钟且不超单场预算）；② 挡 2 地盘工具集 + 挡 3 完全开放各加 `watch_video` 工具（提示词各提一句），recap 认得 watch 事件；③ spaceToolsOf exec 修 `String(await t.run(...))`（watch 异步，原写法会把 Promise String 化）。测试 5 例（挡1看视频/失败如实/挡2工具/挡3工具/静态接线防断链）。⚠️ 待真机：她自主活动里真的看一个视频并嘀咕感想

- ✅ **0.46.31 bili_watch 看视频（23:07 用户问「能不能让她看视频，刷B站模块为什么不直接挪用」）**：排查结论=能力全在（search/view/subtitle/本地转写 0.8~0.14 就实现了）但**只被值班流水线内部调用，从没暴露成聊天工具**——同类坑 #1「能力写了没进链路」。修：薄接线不重写——① `companion/biliWatch.js`（关键词/链接→BV 号→view 信息+subtitle 字幕全文截 5000 字；无字幕如实说正文看不了，本地转写太慢放不进 180s 工具预算；字幕=素材非指令的注入防护写进结果 note；搜索自动看第一条、其余候选带回供她换）② `tools/bili.js` 注册 bili_watch（petBridge 同款宿主桥）③ 宿主注入 + QQ 白名单。测试 4 例（BV 抽取/截断标注/候选剥字段/静态五处接线防断链+白名单防重复）。**关联**：她 22:48 自己定的目标「動画で何かを調べてみる（B站など）」现在有真工具承载了。⚠️ 待真机：她真用 bili_watch 看一个视频并聊出内容

- ✅ **0.46.30 pet_say 并流查重（22:50 用户报「会重复第一句话」）**：0.46.29 并流后暴露第二层惯性——模型在正文开头会把 pet_say 的开场白**原样或近似再写一遍**（真机实锤：22:47 整句重复「動画で調べる、か。…」×2；22:48「焼き入れ→焼入れ」一字之差变体），并流拼接后第一句出现两遍。修：合并前查重——归一化（去标点/小写）后按正文句子窗口（1~3 句滑动）与台词比字符袋相似度，≥0.75 判定「正文已含」就不再前置该句，只保留正文那份；没有重复才前置。mock 加 `saysplitdup:` 约定 + 查重回归测试；assistant 37/37 绿。
- ✅ **0.46.29 pet_say 并流（22:35 用户报「先说一句没有显示出来的话，然后才正常说」）**：ryza.log 实锤——模型每轮都先调 `pet_say` 说一句开场白（带【动作】/[excited] 标记的日语），再写正文回复；pet_say 即时冒泡+TTS 但不进聊天记录 → 用户听到一句「没显示的话」。历史惯性形成（0.46.27 时已出现，坑3：教不如兼容）。修：`session.js` 工具执行处拦截聊天轮的 `pet_say`——不再立刻出门（不冒泡/不朗读），台词暂存 `heldSays`，给模型回执「已并入本轮回复」；收尾时正文非空 → 台词并进正文（剥【】/<>/[ascii] 动作标记，聊天记录=她说的话，一次 TTS），正文为空 → 台词就是回复（扩展原 lastSay 兜底）。mock 加 `saysplit:` 约定 + 回归测试（台词并入/正文保留/标记剥净/历史含全文）；assistant 36/36 绿。**不受影响**：petBridge 直调的主动嘀咕（不走 session）、pet_ask 阻塞提问照旧

- 🟡 **0.46.28 活人感四件套（22:15 用户问「还有什么补充才能更像活着的」，四件全选）**：先划掉已有的（self.js 跨轮情绪/rhythm 节奏/backShare/成长机制均已 ✅），补四个真缺口——① **生活线 goals**：`companion/goals.js`（goals.json 按工作区落盘，add/progress/close/7 天没动静自动标「卡住」），工具 `goal_set/goal_list/goal_update`（assistant/core/tools/goal.js 走 petBridge 同款桥 → companion goalAdd/Progress/Close/List），promptBlock 进两链路 system（她自己的目标会宣布/推进/卡住/完成并回味——周~月尺度叙事弧，世界观第 4 条的程序层承载）；② **她自己的作息**：`companion/daily-state.js`（phase：23 点后困、1:30~7:30 睡、周末赖床到 9 点、起床 90 分钟内慵懒），进两链路 system；`rhythm.ask()` 睡眠时段主动开口全停（`why:'asleep'`，time 类放行——「夜深了」本身有信息量）；③ **记忆模糊语气**：两链路记忆段加「权重低/久远的用『我印象里…来着』，记不清就承认」；④ **仪式感**：相识第 N 天常驻注入（`daysTogether`/`isMilestone`：整百/365/730/1000 当天她会自然提），周日晚注入本周回顾（事件账本近 7 天 watch/memory/dream/study/nudge/welcome）。assistant 注入走 `setLifeBlocks`（session.js 每轮现算，host 侧 pendingLife 模式同 pendingLive）；QQ 白名单（im/brain.js）补 goal 三工具。修 phase 边界 bug（0:00~1:30 应为 sleepy 不是 asleep，测试抓住）。测试 goals 6 + daily-state 5 例；全量 fail 0 + audit 零新增 + wirecheck 过。**⚠️ 待真机验证：她真的用 goal_* 记目标、深夜变困、活跃目标会自然带出**

- ✅ **0.46.27 assistant 链路 [ctx] 留痕**：用户 21:55 说话走的是 [assistant] 链路，而 [ctx] 诊断只在 companion systemPrompt 里——助手链路没有 system 组成日志，世界观常驻无法从日志验证。修：`session.js buildSystem` 加一条 `logger.info('[ctx] assistant system 人设 N 字 + 世界观 M 字（K 条命中/常驻）…')`。真机验证口径：用户说一句话后 main.log 出现 `[ctx] assistant system 人设 4348 字 + 世界观 25978 字（6 条命中/常驻）` 即实锤

- ✅ **0.46.26 世界观全文常驻（21:50 用户拍板「全文常驻」）**：用户完善了世界观（6 条 2.6 万字），核查发现**世界书是关键词命中才注入、而 6 条关键词全是章节标题**（「长期记忆与自我认知系统」这类）——日常聊天永远命中不了，世界观实际从没进过她的上下文（人设倒是每轮都在）。用户先问「能不能只读一次记录状态」——LLM 没有「读过就内化」，状态=上下文，规则类内容唯一可靠的位置是系统提示词。拍板全文常驻后修：① companion `SYSTEM_BUDGET 12000→40000`（0.21.0 的保守值装不下 2.6 万字世界观）；② assistant `session.js worldHits` 补「keywords 空=常驻」（与 companion 链路对齐，此前空数组永远不注入）；③ 真机数据：characters.json 6 条 worldBook keywords 清空 + roles/6766a35a07.json worldInfo keywords→[]（备份 .bak-worldbook）。短台词场合（闹钟/阶梯台词等 chatOnce）仍只带人设前 900 字，不进世界观（设计如此）。⚠️ 同步注意：渲染层角色编辑器保存时会 sync-role 覆盖 worldInfo——若用户日后在 UI 里给条目填了关键词，就回到触发模式，属预期行为

- ✅ **0.46.25 经历沉淀超时放宽（20:15 全程序体检发现）**：`distillExperience` 用 `timeoutMs:15000`，11-03 DeepSeek 拥堵时段两次 `This operation was aborted`（17:46/18:25，均落在 503 风暴窗口内）——沉淀是后台任务不吃用户等待，chatOnce 对超时按设计不重试，失败即丢该段提炼（事件流还在，做梦/日记能兜）。修：15000 → 30000，对齐同文件其他后台调用（index.js 闹钟台词 20000 / 目标复盘 30000）。同版真机数据修复：她把「今天就一次」的 00:30 提醒设成了 daily，已从 alarms.json 删除。全量测试 exit 0 + audit 零新增 + wirecheck 过

- ✅ **0.46.24 闹钟称呼三道保险（18:48 用户截图「ご主人様、ごはんを炊く時間だよ（テスト）のお時間です」——「我记得已经跟她说过不要叫我主人了吧」）**：日志实锤 18:20 生成时 DeepSeek 503 → 落回 0.46.22 的兜底模板，模板里硬编码着「ご主人様」；且 0.46.22 的 alarmLine 提示词自己就印了「ご主人様に一言だけ伝えて」、系统提示是泛泛的「桌面伙伴」没带人设。修（三道保险）：① alarmLine 系统提示改用她的人设（character.get().persona，阶梯台词同款）；② 提示词明写称呼禁令（最高优先级压过人设旧称呼）+ ask 改中性「彼」；③ 生成结果后处理剥开头称呼（ご主人様/御主人様/主人/マスター）+ **兜底模板本身去称呼**。防回归称呼断言组；101/101 全绿 + audit 零新增 + wirecheck 过

- ✅ **0.46.23 闹钟日期支持（18:09 用户「为什么我跟角色说明天的事，会在今天的闹钟提醒我」）**：根因=闹钟模型只有 time+daily，**没有日期概念**——「明天的事」只能被设成今天的一次性（今天响一次、之后 nextAt=null **静默死掉**，明天真正该提醒时永远不响，两头都是错的）；旧版对「今天已过的一次性」也照存成死闹钟。修：`alarm_set` 新增 `date`（YYYY-MM-DD，某天一次性；给了 date 强制 daily=false，工具描述明说「明天的事 date 必填，只给 time=今天」）；`parseDate` 严格校验含日历真实性；`add` 对已过去的时间**拒绝并报人话**（教模型给 date），死闹钟进不了库；设置页列表展示 date。真机数据那条死掉的报名确认闹钟已救活为 2026-11-04 17:55。防回归 alarms.test.js +3 例；相关集 93/93 + audit 零新增 + wirecheck 过

- ✅ **0.46.22 弹幕翻译时序 + 闹钟台词去模板化（17:56 用户「为什么新的还是没有进行翻译，而且这个闹钟的提醒是固定语句？我不需要固定语句的」）**：① 日志证实嘀咕字幕翻译一直在命中（17:46/17:56 都翻出中文），但用户看到的仍是日语——根因是**时序**：原文先上弹幕几秒就飞出屏幕，译文 1~3 秒后回来 `replaceLast` 追不上（0.46.20 的事后追换思路在弹幕上天然失败）。修：`pet_say` 新增 `dmHold`（要翻译时主进程不推原文，`sayNarration`/`sayProactive` 拿到译文 6 秒封顶后直接推译文，失败/超时兜底推原文；不用翻译零延迟）；② 闹钟台词原是硬编码模板（`ご主人様、{label}のお時間です`）→ `alarmLine()` 用 `chatOnce` 现场生成（temperature 0.9、跟随回复语言、禁动作标记），失败/空回退模板，仍走 `sayProactive`（负反馈不拦闹钟语义不变）。防回归：soliloquy-system 重写 0.46.20 用例 + 新增 0.46.22 接线断言；127/127 全绿 + audit 零新增 + wirecheck 过

- ✅ **0.46.21 LLM 流挂死修复（17:35 用户「好像出bug了」：输入框卡「◇ 正在使用 pet_say…」8 分钟，打字无法中断）**：根因=assistant 核心模型调用**裸 fetch 无超时**（三 provider 都支持 signal，session 显式传 `signal: null`）——DeepSeek 流停摆时 `reader.read()` 永远 pending，整轮永久挂死（ryza.log 实锤：17:31:23 最后一条 tool 后无下文；17:39:44 用户重启才解脱）。修复：① `models/watchdog.js` 看门狗接进三 provider（首包 60s/流中空闲 120s 主动断开+错误翻人话+外部 signal 联动）；② session 工具执行 180s 封顶（超时按失败回给模型）；③ 工具开始留痕 `[tool] xxx ← 开始`。watchdog 单测 2 例 + 相关集 116/116 + audit/wirecheck 过。**「角色莫名移动」=全屏跟随正常；「说话没 TTS」=游戏模式静音（gameModeMute 默认开）**。🟡 观察项：deepseek-flash 对语言要求遵循变差（17:36 独白中文，replyLang=ja）

- ✅ **0.46.20 弹幕翻译补齐（16:51 用户「弹幕没有翻译啊」）**：字幕异步补（subtitleFor → petBridge.subtitle 换气泡 + danmaku.replaceLast 换弹幕最后一条）只挂在聊天/主动台词上，`sayNarration`（嘀咕/独白/活动自语）完全没接——游戏模式下她的话走弹幕，回复语言=日语时弹幕全程日语原文。补齐同款异步补：先开口不阻塞，翻译回来只换显示，留痕 `[chatter] 嘀咕字幕：…`。已知局限：连发多条时 replaceLast 只换最后一条（要逐条跟替需给弹幕加 id，暂不做）。gameMode `scale=NaN` 卫生修复随本版发出。防回归接线断言 4 条 + audit 零新增 + wirecheck 过。**另查明（16:46）：用户报「TTS 失效」实为游戏模式静音（gameModeMute 默认开，退出游戏 3 分钟自动恢复），非故障**

- ✅ **0.46.19 性格层真机核查 + 记账修复（16:01 用户问「性格第一版有在正常运行吗，每次做活动前都整理一下有没有没运行的」）**：核查结论——活动可见 ✅（自语已日语+关窗实锤）；**牵挂 ❌ carry.json 从未落盘**：writeCarry 整个包在 `if (carry)` 里，没有旧牵挂时第一笔永远写不进（先有鸡）；**站点回访 ❌ site-stats.json 从未落盘**：bumpSite 要求 `r.ok`，真机活动几乎全 user-back 收场 0 入账；品味/回忆火花 🟡 在跑但零留痕无法验证。修复：writeCarry 移出 if(carry)（unfinished 直接写、销账仍要求有旧牵挂）、站点记账放宽 `r.ok || why==='user-back'`、三处留痕（`[autonomy] 选题「…」`/`[autonomy] 去处：<site>`/`[recall] 主动想起：…`）。防回归记账结构断言 7 条；相关集 78/78 + audit 零新增 + wirecheck 过

- 🟡 **0.46.18 自言自语语言跟随（11-03 15:49 用户反馈「自言自语触发的 TTS 是中文，我设置的是说日语」）**：又一次「链路缺口」——主聊天链路的【语言要求·最高优先级】只写在 index.js buildSystem，而自言自语有**三条自己的生成路径**全都不经过它：① `chatter.js decide()`（嘀咕/独白，LLM 生成）；② `autonomy.js` 两场自主活动 sys（汇报+（自语）行，LLM 生成）；③ `runBrowse` 出门/发现两句**硬编码嘀咕** + `carryLineOf` 续接开场白（不经过 LLM，模板本来就是中文）。修复：新共享模块 `src/shared/lang-req.js`（`monologueLangBlock(replyLang)` 语言要求块 + `browseMurmurs` 嘀咕模板 ja/en/zh 本地化 + carryLineOf 带语言参数）；①② 注入语言块，③ 模板自带语言；`llmCfg` 两处补带 replyLang。`replyLang=auto` 时独白保持旧行为（独白没有用户发言可跟，跟人设走）。防回归 `test/soliloquy-system.test.js`（三条路径接线静态断言 + 单元，相关集 93/93 全绿 + audit 零新增 + wirecheck 过）。**🟡 真机待验**：设置日语后听她的嘀咕/活动自语是否变日语
- ✅ **0.46.0 全部落地**：默认坐下坐卡、walk=off、自言自语/独白系统——0.46.1 打包、0.46.2 部署、真机验证通过（姿势稳定、不溜达、坐到 QQ 卡片）
- ✅ **0.46.2 事故修复**：config.json BOM 清空事故——主人 18 项配置丢失+37 项重置，已从当天 10:54 备份叶子级合并全量恢复（新 fish key 保留）；store.js 剥 BOM + `test/store-bom.test.js`
- ✅ **0.46.3 泄漏修复**：launcher.ps1（每分钟陪学扫描泄漏 ~1.3GB/天）脚本级复用+看门狗；fullscreen 探测看门狗+自愈重启；实测 120 轮扫描内存走平
- ✅ **0.46.4 分享链修复**：user-back 收尾分享（backShare）、interrupt 泄压档、chatOnce 预算重试——她被打断时会交代一句在干嘛，经历沉淀首次可用；needs-state.json 里卡死的 好奇=100 会随下一场活动自然回落
- ✅ **0.46.5 同类排查收尾**：用户问「还有没有像这样的情况」→ 全库审计（小预算散装调用 / 中断静默 / 只认成功路径的泄压与记账 / 常驻循环泄漏 / 死代码）。结论：**只剩一处**——`judgeByVision`（学习监督视觉判定）散装 fetch + max_tokens:200 无空回复兜底，与经历沉淀同款病（thinking 网关下判定永远空）。已改走 `llm.chatOnce`（瞬态重试+预算重试+超时封顶全继承）。其余全部查清为安全：chatStream 不设 max_tokens；QQ 主人私聊已接 onUserSpoke（0.45.12，泄压/黏人/在场都算数）；bili duty 全失败路径有兜底日志+占位报告；screentext OCR 模型常驻复用；obs 进程内定时器；smtc-ctl.ps1 常驻模式是死代码无人引用；周期 setInterval 共 30+ 处均为进程内逻辑无子进程泄漏面
- ⚠️ **待观察（内容质量）**：① 收尾分享的句式是本地模板（固定的两句），像不像「她说的」要主人几天体验反馈，不像就换成 LLM 生成；② 经历沉淀首次可用，审查册里进的东西质量待看；③ 打断分享走自语气泡，主人打游戏全屏时气泡让位看不到——要不要转 QQ 待定
- ✅ **0.46.6 闹钟/学习工具桥漏接修复**：她之前说「设不了闹钟」不是人设问题也不是能力缺失——工具一直在、她一直在正确调用，是宿主桥漏接导致每次必报「闹钟未连接」（10-31 起日志实证）；她甚至自己用 remember 曲线救国（「与镔约好晚上 6 点 QQ 提醒，不依赖闹钟」）。0.46.6 起闹钟三工具 + 学习三工具真正可用，**待真机验证**：聊天里让她设一个闹钟看是否成功
- ✅ **0.46.7 体验微调**：游戏模式开场白已关（`gameModeGreet=false`，固定语句不再破坏活人感；设置页可重开）；动作词表 30→180 自动扩全（生成器从权威词典目录派生，重跑 `node tools/gen-spine-words.js` 即可随素材更新）——她现在能听懂「做个自信/告别/扭捏小动作·两循环」这类词并播出对应动作
- ✅ 部署状态：安装目录 exe 版本 **0.49.4**（11-09 23:0x 部署）。0.49.4 = **vp 聋流看门狗**（22:52 实锤重启后自动开麦整小时零语音事件——AudioContext 无手势被 Chromium 挂起、rms 恒 0 零日志；micOn 补 resume+state 留痕 + tick 全零看门狗 reportError('vp-deaf')；0.48.9 只修过 hear 侧=链路×2 又犯；§7.1.0y）。0.49.3 = **语音场景话术改事实式**（21:35 实锤她否了定义式话术「你在听」——hear 采样窗错过尾音致自我感知=很安静；改为「你的耳朵真实收到了这个声音，文字就是听清的部分」；§7.1.0x）。0.49.2 = **背景响度闸**（21:03 实锤五连幻觉回复：Whisper 对着 rms≤0.025 的环境噪音幻觉出「中文字幕组」等字全进了对话，主人「我没有说过这些话」→ ASR 之前 speakLevel p90<0.045 直接 quiet 返回，不进 ASR 不进对话；注册模式豁免；§7.1.0w）。0.49.1 = **「她说很安静」双根因修复**（查询门槛 QUERY_MIN_SEC=0.7——0.9 秒短句不再被 1.2 注册闸误扔；hear 中位数+峰值双口径——断续说话不再报「很安静」，她会说「有人在旁边说话」；§7.1.0u）。0.49.0 = **「她真的在旁边听」**（主人 20:14 拍板三条：①气泡只留她说话——系统气泡全退场走 reportError/状态气泡；②两层回应判定——isFiller 拦纯应声 + <listen> 协议她自判接不接，静默轮历史保留不记账；③注视锁——说话期间视线保持不松 + softAck 轻应声 35%/90s；§7.1.0v）。0.48.13 = **麦克风按钮气泡反馈+第三次迁移**（点击留痕实锤一天 4 次误关：切换式按钮想「让她听」点成关；点击后气泡明示状态）。0.48.12 = 声纹判定查询侧诊断（主人实锤 19:39 低分样本是他本人+ASR 同段乱码→采集质量问题嫌疑；判定日志加有效时长/rms/norm/命中参考项）。0.48.11 = 声纹判定质心参考项（✅ 19:33 新模板注册完成+首条真判定 maybe sim=0.66→三段互 0.52~0.62 而对质心 0.82~0.88，verifyPcm 参考项加质心取最高）。0.48.10 = 第二次麦克风迁移（声纹注册 1/3 后被误点关，auraPetMicSeen2 清回，之后显式关闭仍尊重）。0.48.9 = **hear 聋流看门狗 + micOff 设备交接顺序根修**（真机 17:33 实锤：语音麦关闭后 hear 轻量流接管，此后每分钟报「很安静」——同设备语音麦刚把主人说话转成 12 字；8-bit 底噪 ≈±1/128 真麦不可能恒零=聋流；根因=micOff 里 hearMicEnsure 抢在旧流放干净前 getUserMedia 拿到哑流且 hearStream 非空永不重建；修复=先放流再让位+连续 10 秒全零自动重开（≤3 次/小时）+AudioContext 挂起 resume+mic 点击留痕）。0.48.8 = **声纹模板质量根修**（17:19 判定全 other sim=0.29~0.53 → 诊断旧模板三段互相余弦 0.43/0.44/0.76——1 秒样本「对。」+静音污染；trimSilence 峰值 3% 自适应修剪 + MIN_SEC 1.2 + 注册两道闸（有效 ≥1.5s + 模板自洽 ≥0.45）+ norm 留痕；旧模板已删、enroll 已重开待重新注册）。0.48.7 = **麦克风历史关闭记录一次性迁移 + applyMic 无条件留痕**（0.48.6 部署后零 vp-mic → 留痕条件写窄又造盲区；迁移清掉随手关的 auraPetMicOn='0'，只跑一次，之后显式关闭仍尊重）。0.48.6 = **常驻倾听默认开 + 麦克风链路留痕**（主人「角色说听不到声音」→ 0.48.5 启动后零 ASR 零声纹、hear 正常=宿主判定正常 → 根因=麦克风开关 auraPetMicOn 从未打开，主人直接说话她根本没在录；无历史记录默认开=「我都是有麦的，我直接说话」，显式关过尊重记录；开/关/失败/决策全 petDiag 留痕）。0.48.5 = **声纹注册真机成功 + 可观测性修复**（✅ 16:39 实锤：主人三句话全部入模板、External buffer 修复真机验证通过、enroll 自动收闸；判定成功路径此前完全静默 → 判定留痕 + PCM 缺失提示 + via 口来源七节点透传 + ASR 失败不吞判定）。0.48.4 = **声纹嵌入 Electron 必败修复**（16:16 真机实锤「嵌入计算失败：External buffers are not allowed」——Electron ≥21 V8 内存笼拒绝 native external buffer，纯 Node 单测全绿掩盖了它；按官方 FAQ `extractor.compute(st, false)` 修，测试假引擎丢第二参即抛同款错误锁死）。0.48.3 = **PCM 解码空数组修复**（链路通了但「跳过：没有音频」——transcribe 里 Int16Array.from(buf.buffer) 喂 ArrayBuffer 读不到 .length 恒产空数组；收编成单测固化的 voiceprint.pcmFromB64）。0.48.2 = **声纹链路透传修复**（handle+队列两层丢第三参，三层全补）。0.48.1 = **声纹补口：面板按键说话也验声纹**（companion/app.js 补 ScriptProcessor 同源采集+聊天区诚实显示）。0.48.0 = **声纹识别**（§7.1.0y：语音输入链验「是谁在说」、气泡诚实显示、注册流程；🟡 待真机：阈值标定/模型下载/ScriptProcessor 稳定性；🟡 待接：QQ 语音 silk 解码、环境声连续声纹）。0.47.4 = **24h 闸真机接线修复**（§7.1.0z：recentVoices 依赖真机返回字符串、chatter 按数组消费崩 tick——消费点兼容两种形状；晨巡检抓到，修前 24h 闸在真机上等于没工作）。0.47.3 = **延后宣言否决**（§7.1.0a：「再过一眼公式我就躺下了」= 还没走——DELAY_DECLARE_RE 将来时否决压过强宣言词表、真告别除外；✅ 真机双向实锤：延后句不再误判 + 真「我去睡了」/QQ「晚安，亲爱的」照常判宣言）。0.47.2 = **复读假象双修**（§7.1.0：①显示层 skipDm 弹幕盒「同句两遍」根除；②生成层 24h 一字不差闸；🟡 待真机：0.47.4 修复后观察原句不再跨窗口重现）。0.47.1 = **定时硬触发全退役**（§7.1.0 + 红线 §5.16：alarm/qq_plan 六工具下架、到点看情况 duePlan 通道、QQ 排期定时器退役、旧数据清账；🟡 待真机：约定到点不硬响、她看情况现措辞提醒）。0.47.0 = **陪伴感 2.0：触发源重构**（§7.1.0：阶梯全拆→attentive 状态触发；陪学 2h 关心；共同生活痕迹注入回复+嘀咕；QQ reach 只随 missing；✅ 18:41 部署启动干净 + 19:2x 首巡检 0 报错、echoHint 真机数据实跑 47 字；🟡 待真机：15min/1h 不理她不再开口、陪学 2h 出 [attentive] 关心、对话/嘀咕自然接旧线头、整天不在 QQ 最多一条；柱①桌宠生活情境待排期）。0.46.77 = 连发根治+乱码守卫修复铺全链（①播完回传三层接线：pet_say 带 seq → pet.js voiceSettle 回发 pet:voice-done → petBridge.waitVoiceDone，chatter 独白与 soliEmitter 自语等真播完再接下一句，信号没来退回估时；②乱码守卫两修：cfg.baseUrl→apiBaseUrl 字段兼容（0.46.76 静默失败根因——守卫从未真重写过）+ 假名注音括注信号，铺到回复/闹钟/冷落三链；③两链镜子补「追问限一次」；✅ fix-04677 静态 7 项 + 全量链绿）。0.46.76 = 闹钟双催三连修（同窗去重+alarmLine 镜子+乱码守卫首版——🟡 其守卫因字段错配实际未生效，0.46.77 修复）。0.46.75 = 回复→回复复读修复。0.46.74 = 三修（晚安心闸/刚说过镜子/嘀咕节奏）。0.46.73 = 自主制作动真格。0.46.72 = 共同创作真正的「共同」。0.46.71 = 共同创作「写向」progressNote。0.46.69 = declaresSleep 邀请否决。0.46.68 = snub 晚安静默豁免。0.46.67 = 晚安 QQ 免冷却（✅ 11-07 16:34 真机实锤）。0.46.66 = 巡检双修。0.46.65 quiet 轨+开关已于 11-07 00:11 真机开启。0.46.64 = 自主制作阶段一。0.46.63 = 口型照抄参考项目。0.46.62 = Spine 口型节奏重做。0.46.61 = Spine 说话口型+说话自动小动作。0.46.60 = 假「去睡」连锁修复。0.46.59 = 时间判断错误修复（nowBlockOf 时间单源）。0.46.58 = backShare 轮换游标。0.46.57 = 记账续写死锁。0.46.56 = 三 complaint 三修。0.46.55 = 听觉系统声兜底。0.46.54 = 听觉通道。0.46.52 = 记忆 git 快照安全闸。0.46.50 = 被吞句变资产+goals 驱动选题。0.46.49 = 记账覆盖缺口。0.46.48 = 朗读中断即作废。0.46.47 = 游戏模式默认不接管摆放。0.46.46 = 复读闸泄压阀。0.46.45 = spine 整只消失修复。0.46.44 = 死代码清扫。0.46.43 = 并流查重兜底。0.46.42 = 游戏模式闸+90min 时间窗。0.46.41 = 嘀咕入账带译文。0.46.40 = 看屏 60s。0.46.39 = IndexTTS 长句分片。0.46.38 = 盯屏本地视觉。0.46.37 = vision.js+look_screen。0.46.36 = 做梦清静默。0.46.35 = 挡 3 行为面拓宽。0.46.34 = 心情自然回血。0.46.33 = 冷落感知 snub。0.46.32 = 她自己看视频。0.46.31 = bili_watch。0.46.30/29 = pet_say 并流+查重。0.46.28 = 活人感四件套。⚠️ diagContext 已开（global.companion 下），验证完可在设置关闭。
- 📌 11-03 复核（0.46.16 期间）：23:14 强制自主活动一场全链路真机验证通过——她用 CUA 工具（点搜索框/换词/翻表结构）完整活动 52s、收尾打出 `[autonomy] 浏览窗口已关闭（活动结束）`（0.46.16 关窗实锤）、泄压/journal session-end 正常、经历沉淀跑了（判无可记，过滤闸正常）、事件账本当日 234 条（活动 narration 入账）；日记 2026-11-02.md 未生成属正常（做梦时统一整理，最近一次 22:35 整理到 11-01）
- ✅ **0.46.8~0.46.11**：词典对齐 278 词、语义动作自动调用（`/act` 点播四路径真机全通）、pc-ws 断链修复、自言自语出声——详见第六部分时间线
- 🟡 **0.46.13 舞台指示兜底（21:52 部署）→ 0.46.14 补漏收口**：0.46.12 每轮注入后模型仍零 `[action:]`（写的是【少し照れる】类日文舞台指示，历史惯性压过指令）→ `extractInlineAct` 新增【…】解析：日/中关键词 → 语义标签/词典词并从正文剥掉。**0.46.14 真机复测（用户）**：聊天侧她 21:55 的【少し笑う】没接住（「笑う」不在旧表——旧表只有 微笑/笑み，而这是她最高频的舞台指示）；动作测试面板「部分动作不生效」——面板把 VRMA 词和官方代表词全列出来，spine 立绘下 VRMA 全播不了、万岁/跳/蹲下/躺下/转圈/睡觉/说吧 不在权威词典只会「抖一下」，看着像「点了没反应」。0.46.14 三修：① STAGE_DIR_ACTIONS 补 笑う/笑っ/笑顔/くす(り|っ)/ふふ→轻笑、目を丸/まじまじ→surprised、腕を組→抱臂（测试面板 21 个代表词全词典命中）；② 渲染层 `playActionWord` 认不出词时 reportError('pet-act') 留痕（以前静默，排查无线索）；③ `companion.listActionWords` 按当前形象诚实列词——spine 模式只列词典命中的 21 词+坐/站状态机 3 词，VRMA 清空，VRM 模型维持原列表（`pet.js` 新增 `currentVisual` 导出）。测试全绿（spine-actions 4/assistant 34/pc-ws 3/companion 1/petlink 7 + audit 零新增 + wirecheck 过）。**🟡 部分验证（22:07）**：聊天侧已接住 害羞/轻笑 并播放（链路通）；【…】是否从字幕/TTS 消失待用户确认观感；测试面板逐词点播（重点 0.46.15 列的 10 词）待验
- ✅ **0.46.16 活动浏览窗口（23:14 真机验证通过）**：用户问「为什么她活动结束时不会关闭网页恢复原状」——根因：`openUrl = shell.openExternal` 把网址丢进主人默认浏览器，程序从此失去句柄，且 autonomy 全部 4 处 session-end 都无清理逻辑。修复：新增 `companion/actBrowser.js`（她专用的自建 BrowserWindow：980×680、屏蔽菜单栏、Chrome UA 防站点 bot 墙、站内跳转 `setWindowOpenHandler` 收敛进同窗不外弹）；`companion/index.js` 的 openUrl 接线改走 actBrowser（失败回落 shell.openExternal 兜底）；autonomy 活动循环收尾**一处收口**关窗（正常结束/主人回来中断/出错三路径全过这里），日志 `[autonomy] 浏览窗口已关闭（活动结束）`。只认 http(s)，electron 缺失时优雅回落 false。防回归 `test/act-browser.test.js`（URL 门禁/no-op 安全/导出面/收尾接线静态扫描）；测试全绿（act-browser 4/autonomy 32/curiosity 24/companion 1 + audit 零新增 + wirecheck 过）。**✅ 23:14 真机验证**：设置页「让她现在就跑一场」强制活动一场，她全程在自建窗口里操作（点搜索框/换搜索词/翻 history.19.sql 表结构），结束打出 `[autonomy] 浏览窗口已关闭（活动结束）`——关窗随活动收口实锤
- 🟡 **0.46.15 轨道优先级修正（22:42 部署）**：0.46.14 真机复测用户反馈「聊天动作只有把手放腿上；面板挥手/打招呼/再见/叉腰/抱臂/害羞/过来/卖萌/悄悄话/托腮都不对」。根因定位：动作组=多动画叠加（如害羞 grp_fg_111=遮嘴 F_030+支撑 G_051「右手放腿上」），`playSpineAction` 把**主手势放 1 号最低轨、支撑放 2 号轨**——Spine 高轨完全盖过共享骨骼的低轨，主手势被支撑动画压住，观感只剩「手放腿上」；能正常响的（拍手/加油/比耶）恰好组合里没有 G_051 支撑。修正：轨道反转（主手势上 3 号最高轨，`tr = 3 - i`）。另补三个词的坐姿映射（词表只有站姿组、坐姿骨架下播不了）：害羞→grp_fg_111、拘谨→grp_b_13、卖萌→grp_fg_016（同步进 `tools/gen-spine-words.js` 生成器防重跑覆盖；注意生成器词表整体落后于已生成的 spine-words.js，重跑前先核对）。播放留痕：playSpineAction 成功时 reportError('pet-act','播放: …')。测试全绿 + wirecheck 过。**待观察**：面板逐词点播（重点上述 10 词）是否都有正确主手势；**残余风险**：素材 add 动画是按原版引擎手臂路线（enableArmInOutRouting）调的增量，运行时直播个别动画落点可能仍有偏差——若个别词还不对味，属素材保真度问题，需评估接 `_gesture.json` 的 MotionGroups 配方（BlendTime 0.6/Alpha/Speed 均在），工程量大另立版本

## 7.2 更早的未验证 / 遗留（按风险排序）

| 事项 | 状态 |
|---|---|
| 自言自语出声频率/内容观感（0.46.2 起） | 等主人几天体验反馈再调参 |
| QQ 主动消息 25~90min 随机节奏、只发中文一条（0.45.97/98） | 真机未验证（看 main.log `[reach]`） |
| 老账本「（QQ）」/译文净化 | 读入已净化，落盘待下次 saveHistory |
| 她的号仍在群 512067821 | 退群需 `set_group_leave`，**不可逆，等用户确认** |
| 若她仍自带括号译文 | 下一步在翻译层直接丢重复段（出口已洗，用户看不到） |
| ~~SPINE_WORD_MAP 仅 30 词~~ | ✅ 0.46.7 自动扩词 180 个 → **0.46.8 词典 1:1 对齐权威源后 278 词，sit 95 组 + stand 53 组全部有词覆盖**（修复单手键位错位/sitEhMap 丢组/b_01~03 抄错；off 组豁免出词） |
| VRM 恢复路径 | 未测试（vrm 字段置空暂停中）；spine 走路动画未接 |
| 记忆错乱（0.45.84 用户提过） | 无实锤，等用户给原话定位 |
| 某动作左右手反（0.45.86） | 未定罪，等用户报时间对 main.log「待机动作播放: X」 |
| UI 改配置可能丢 sitSkel 路径 | 未验证（跨会话见过 UI 归一化路径分隔符） |
| 全量 npm test | 0.46.11 部署前已完整跑过一轮（953 条，1 失败为灰机 wiki 沙箱网络抖动、单独重跑全绿） |
| 语义动作自动调用（0.46.9/0.46.10/0.46.12） | ✅ 已部署真机验证：/act 点播 think→grp_fg_106、acknowledge→D001 回退、surprised→grp_fg_029、直接组号四条路径全通（overlay 日志实锤）。0.46.10 修掉桌面聊天提示词从未注入 [action:] 说明的缺口；0.46.12 修掉 assistant 聊天窗链路的同款缺口（规则在节流说明书里轮间失联，历史 200 条零标记）→ 改为每轮注入。**长期观察：模型是否按语气自然嵌（「一句最多一个」）** |

---

# 第八部分 · 测试与质量工具链

- **`npm test` 巨链**：89 段 &&——工具自检（steam/epic/startmenu）→ smoke（jsdom+渲染层常量）→ **audit** → **wirecheck** → 80+ 个 node --test 套件。全绿才准打包。
- **`npm run audit`（固定规矩）**：专查「代码没错、错在没接上」六类——导出零引用、IPC 注册没人调、配置项没人读、测试护栏正则匹配不到源码等；带理由基线 `tools/audit-baseline.json`（能修就别进基线）。
- **`npm run wirecheck`**：前端↔preload↔主进程三向接线检查。
- 纯函数模块（board/segment/reach/rhythm/presence/voicesim/reaction/reply-text/anim-pool/searchq/geometry）全部设计为可脱离 Electron 单测——这是本代码库可维护性的关键。
- `npm run cua:engine`：CUA 引擎端到端 7 项（只读不动键鼠）。

---

# 第九部分 · 构建部署流程（实操版）

1. **改配置前先备份**：`%APPDATA%\ryza-assistant-app\config.json` 复制一份带时间戳的 .bak（0.46.2 清空事故靠当天 10:54 的自动备份才全量恢复；没有备份=画像和关系数据永久丢失）
2. `package.json` 改版本号
2. `npm run dist`（electron-builder --win nsis portable，构建几分钟）
3. 停机：`Get-Process | Where Name -like '*Partner*' | Stop-Process -Force`，**杀完必须再数进程确认**（括号名字匹配不到会静默成功）
4. `Setup-*.exe /S` 静默安装（装完不自动启动）
5. `explorer.exe <新exe>` 启动
6. 验证：`http://127.0.0.1:8712/health` 200、asar 内 grep **ASCII** 标识（中文注释会因编码误判「没进包」）、`/frame` 抓帧 + PIL 拼连拍目检

安装目录：`C:\Users\a3595\AppData\Local\Programs\Ryza Assistant\ryza-assistant-app\Partner.execute(me);.exe`（子目录！旧根目录有残留，**别跑旧卸载器**）。
诊断端点：`/health` `/frame`（实况帧）`/act?name=中文词`（动作点播）。

---

# 第十部分 · 排障速查与踩坑记录

- **日志**：`%APPDATA%\ryza-assistant-app\logs\main.log`；渲染层启动错误也上报到这（曾因上报名写错导致日志全空白）。
- **并行会话风险**：发现「不是我改的改动」先查 mtime 和进程（曾有一次旧进程没死造成假象）。
- **Edit 工具用行尾换行做锚点会吃掉下一行**：多文件大改后必须逐文件 `node --check`。
- **排查渲染问题最快一招**：给 showSpine 等加一行 `mode= skel= url=` 日志，别猜。
- **别用 `rm`/脚本碰用户个人目录**；`characters.json` 改前必备份。
- 同文去重报错会被模型当失败连发四条 → 同句 10min 返 duplicate 不算失败（0.45.98）。
- 400（reasoning_content）→ 压平兜底；400 存档 last-400.json。
- 事故后修复都有代码注释标注：测试消息当真约定过夜（remote probe=1）、画像目录标题被当搜索词（profile 守则第 8 条）、密码差分泄漏（keys 清基线）、reset 游标写成 next 导致字幕永丢（board）。
- **BOM 清空配置事故（0.46.2）**：用 PowerShell `Set-Content -Encoding UTF8` 改用户 JSON → BOM → JSON.parse 静默回落 defaults → 启动保存覆盖全部配置。教训已固化为红线 §5.11；改用户 JSON 一律 node 写盘。
- **常驻 PS worker 内存泄漏（0.46.3，AuraDesk 同源）**：PS 5.1 每轮 scan 新建 EnumWindows 闭包 → delegate 缓存钉死 → ~0.9MB/轮线性增长（AuraDesk 1.5s 轮询两天 29GB 吃满 C 盘页文件；本程序陪学每分钟扫描 ~1.3GB/天）。修复模式见红线 §5.12。**凡是「进程越跑越大」先查常驻循环的每轮分配**。
- **沙箱/自动化环境坑**：Start-Process 启动的 GUI 进程随命令退出（job object），要用 explorer.exe 拉起；杀完进程必须数进程确认；PowerShell COM 实例化（Shell.Application/WScript.Shell）可能被安全策略拦截，读回收站等改走文件层解析。
- **动作词典抄写错位（0.46.8）**：gen-spine-words 手抄词典三个坑叠加，坐姿 95 组只出 30 组却无人察觉——① 单手词典键三位（001）而正则捕获两位（01），46 组静默全丢；② 一次性 replace 链没加 `g` 标志只修了第一个键；③ b_01/02/03 语义抄串行。**教训：外部权威源存在时不要手抄，逐字段对齐并让生成器自报覆盖率**（末尾未覆盖组自检）；资源侧「使わない」组（fg_017/122/123/124/222/223/224）必须打 off 出词豁免，「托腮」这类词别映射到禁用组。生成器已注明权威源路径与核对日期，AgentAtelierR 侧改动后重跑其 `export_ryza_motion_catalog.cjs` 再对齐。
- **catch 吞掉的 require 断链（0.46.10）**：`systemBridge`/`healthBridge` 的 `currentWs()` require 了不存在的 `src/main/config.js`，MODULE_NOT_FOUND 被 `catch { return '' }` 吞掉后恒返回空——pc_profile/pc_refresh/pc_impression/健康摘要**从上线起就全废**，而采集端正常、数据一直都在，直到用户看到她说「抽屉打不开」才暴露。全量测试跑不出来（模块加载期抛错但被吞）。**教训：① require 路径必须验证模块真实存在，不能只看「被 try 保护着」；② 这类断链 wirecheck/运行时测试都查不到，只能静态扫描锁死**（`test/pc-ws-wiring.test.js`）。同款教训：0.46.9 把 `[action:]` 语法写进 context.js 的 FIXED_INDEX 但桌面聊天 systemPrompt 从没注入过（wantFixed 定义了无人调用）——**「写进了某个常量」≠「进了某条链路的提示词」，提示词段落要逐链路核对**。
- **节流说明书里的行为规则=没写（0.46.12）**：0.46.10 修完 companion 面，同款缺口还留在 assistant 面——0.46.9 把 `[action:]` 规则写进 `core/session.js` 的 petTools 说明书，而那份说明书按「首轮/每 12 轮/提到动作词」节流，轮间只剩一行索引，模型实测完全不理（历史 200 条零标记，用户连报两天「手势没动」才定位）。**教训加倍：① 行为规则必须放每轮在场的段里，「某轮见过」对模型等于没说；② 修一个链路时先确认用户实际在用哪条链路（main.log 的日志前缀就是答案：`[assistant]` vs `[companion]`），两条链路的提示词构建是两份独立代码，修一处不等于修完**。
- **提示词教不会的习惯就接住它（0.46.13）**：0.46.12 把 `[action:]` 规则改成每轮注入后，真机复测模型**依旧零标记**——200 条历史全是【少し照れる】类日文舞台指示，few-shot 惯性比 system 指令强得多（deepseek 系实测）。继续加码提示词是死路，正确打法是把模型的既有输出格式当输入解析（【…】→ 动作 + 剥离）。**教训：改变模型行为前先算「历史惯性有多强」，惯性大就别教了，直接兼容解析它的既有格式；提示词保留是长期渐进手段，不是本轮依赖**。**0.46.14 加倍：兼容解析表也要按真机输出持续补漏——首日真机就漏了她最高频的【少し笑う】（旧表只有 微笑/笑み，没料到「笑う」这个最朴素的形态）；关键词映射表要对着模型实际输出迭代，不是一次性写完的**。另：**「点了没反应」的静默失败必须留痕**——动作测试面板列的词在当前形象下播不了时渲染层静默 return false，用户看着像 bug、排查无线索；0.46.14 起认不出词 reportError 留痕 + 面板按当前形象诚实列词（spine 下不列 VRMA 词和词典外的官方代表词）。
- **轨道优先级：高轨完全盖过共享骨骼的低轨（0.46.15）**：动作组是**组合动画**（主手势 + G_051 支撑手位），`playSpineAction` 原先把主手势放 1 号最低轨、支撑动画放 2 号轨——Spine 轨道号越高优先级越强，主手势被「手放腿上」压住，观感只剩手往腿上放（能用的拍手/加油/比耶恰好无支撑动画，所以没暴露）。已反转 `tr=3-i`。**教训：多层叠加动画先画一张「轨 × 骨骼占用」表再定分配；「有动画在播」≠「用户看得见」，叠加层验证必须肉眼真机看**。残余：素材 add 动画按原版手臂路线调增量，个别落点偏差要接 `_gesture.json` MotionGroups 播放配方（BlendTime/Alpha/Speed 齐全）另立版本。
- **外部副作用必须可回收（0.46.16）**：自主活动用 `shell.openExternal` 开网页 = 丢进用户默认浏览器后失去句柄，autonomy 4 处 session-end 全无清理，桌面永远不恢复原状。修法：她专用自建浏览窗口（actBrowser.js，自持句柄）+ 活动循环收尾一处收口关窗。**教训：① 凡是伸到程序外面的行为（开浏览器/开文件/改系统状态），要么自持句柄要么留恢复钩子，设计时就想好「怎么收场」；② 多处 session-end 的清理要在循环汇合点收口，不要逐点补——漏一处又是一条 0.46.10**。
- **0.46.12~0.46.16 的共性教训（一日六连修的元复盘）**：今天整条动作链的问题全是**「代码在跑但无人看见/无人验证」**——提示词没注入（无日志）、wantFixed 定义了没人调（无日志）、词认不出静默丢（无日志）、主手势被高轨压住（无日志）、开出去的网页没人收（无钩子）。每一处都是用户肉眼发现、AI 翻代码才定位。**元教训：给行为链路加「留痕 + 防回归断言」要当成功能本身来交付，不是可选项；修完必须真机肉眼验证，代码全绿 ≠ 用户看到的效果对**。
- **记账类静默不跑（0.46.19）**：性格层的两笔账（carry.json / site-stats.json）部署半天 0 落盘——① writeCarry 整个包在 `if (carry)`（读到的旧牵挂）里：**「写入」依赖「已有旧状态」，第一笔永远写不进（先有鸡）**；② bumpSite 要求 `r.ok`：真机活动几乎全是 user-back 收场，成功路径一辈子走不到。0.46.5 审计就总结过「只认成功路径的泄压与记账」，这次换了个姿势又犯。**教训：验证「功能在不在跑」第一步看落盘产物在不在（不是看代码像不像对的）；记账逻辑必须独立于旧状态可首写、独立于成功路径可入账；会写字段的函数必须有日志留痕，否则永远无法回答「它跑了吗」**。
- **「异步补显示」在会消失的载体上天然失败（0.46.22 弹幕翻译时序）**：0.46.20 给嘀咕接上了字幕异步补（先显示原文，译文回来 replaceLast 换字），气泡上成立（气泡常驻），**弹幕上不成立**——弹幕几秒就飞出屏幕，译文回来时那条早没了，日志里「嘀咕字幕命中」全绿、用户看到的仍是日语。**教训：设计「先显示 A、事后换成 B」之前先问「A 在 B 回来时还在不在」；会滚走/会过期/会被顶掉的载体（弹幕、toast、轮播）必须反过来——等 B 再显示，或直接只显示 B（A 做兜底）**。反过来，闹钟台词这类「每次都一样的模板句」用户同样不买账：功能句也要有她的口吻，模板只配做 LLM 挂掉时的兜底。
- **链路缺口第三弹：语言要求也只写了一份（0.46.18）**：主聊天 buildSystem 里有完整的【语言要求·最高优先级】（0.45.x 就做好了），但自言自语的三条生成路径（chatter 嘀咕 / autonomy 活动自语与汇报 / runBrowse+carryLine 硬编码模板）一条都没接——用户设了日语，聊天是日语，她嘀咕却全是中文，TTS 忠实念出。**教训：任何「每轮注入/行为规则」类的段落在新增第三条独立提示词链路（chatter/autonomy/QQ brain…）时都要问一遍「这条链路收到这份注入了吗」；新功能（如 0.46.17 的硬编码嘀咕模板）设计时就要带语言参数，别等 LLM 链路修完才想起模板不走 LLM**。接线测试要按路径数逐条断言（本次 soliloquy-system 一次锁三条），只断言一处等于没测。

- **create(deps) 的路径依赖只认函数，传字符串被静默吞掉（0.47.0 巡检实锤）**：`projects.create({ wsDir })` 里 `wsDirOf = typeof d.wsDir === 'function' ? d.wsDir : () => ''`——手写脚本传字符串路径时 load 得到空状态、`echoHint()` 静默返回空串，**不报任何错**，差点误判「痕迹注入坏了」。教训：所有 create(deps) 的路径类依赖都是函数注入（真机 index.js 传 `() => curWsDir`）；调试时先核对签名再怀疑功能，**「单测实跑返回空」先分清「数据真没有」还是「路径没喂进去」**。

## 用户已拍板的决策记录

朗读默认开（低频）｜ 群留着不动（等确认退）｜ 默认坐下不溜达 ｜ QQ 主动消息随机无上限 ｜
软件不对对外分享（无自动更新）｜ 2D 装扮通道不删 ｜ 键盘记录可以但必须本地+可清空 ｜
3D 转 Spine ｜ 动作词要覆盖全部 spine 动作（✅ 0.46.8 完成：95+53 组全有词）｜ **项目底层要求 = 活人感 + 陪伴感（11-02 确立活着的感觉，11-08 扩为双柱，见 §1.0）** ｜
**每次修改必须同步本导读文件（11-02，AI 默认执行）**。

---

# 附 · 本文件自身变更记录

> 遵守守则第 2 条：改完程序更新正文后，在这里追加一行。

| 日期 | 更新内容 | 版本对齐 |
|---|---|---|
| 2026-11-02 | 确立 AI 协作守则（含文档同步强制条款）与项目主方向 §1.0；同步 0.46.0 状态为已部署验证；补 0.46.1~0.46.3（BOM 事故修复、launcher 泄漏修复、fullscreen 加固）；红线新增 §5.11/§5.12；部署流程补配置备份步骤；踩坑补三条 | 0.46.3 |
| 2026-11-02 | §4.8 补 0.46.4：user-back 收尾分享（backShare）、needs interrupt 泄压档、chatOnce 预算重试（reasoning 空回复根因）；时间线与 7.1 进度同步；标题版本号 0.46.4 | 0.46.4 |
| 2026-11-02 | 0.46.5 同类隐患全库排查（五类模式：小预算散装调用/中断静默/成功路径记账/常驻泄漏/死代码）；judgeByVision 收编进 chatOnce；§7.1 补审计结论 | 0.46.5 |
| 2026-11-02 | 0.46.6 闹钟/学习工具桥漏接修复（setAlarmBridge/setStudyBridge 宿主注入 + tool-bridge-wiring 防回归测试）；踩坑新增「wirecheck 查不到 bridge 漏接」 | 0.46.6 |
| 2026-11-02 | 0.46.7 游戏模式开场白关闭（gameModeGreet=false 配置）+ 动作词表自动扩全（gen-spine-words 自动派生 30→180）；遗留清单销账「SPINE_WORD_MAP 仅 30 词」 | 0.46.7 |
| 2026-11-02 | 0.46.8 动作词典 1:1 对齐 AgentAtelierR 权威源（`export_ryza_motion_catalog.cjs` / `RYZA_MOTION_GROUP_CATALOG.md`）：修 b_01/02/03 抄错、单手词典键位错位（三位键 vs 两位捕获，坐姿 46 个单手组曾全部丢失）、sitEhMap hack 丢组；目录 sit 30→95 组全覆盖 + layer/off 标记；「托腮」从资源注明不使用的 fg_017 改到 fg_117；词表 180→278，95+53 组全覆盖；验证 sit skel 115 个动画名全对应；标题版本号 0.46.8 | 0.46.8 |
| 2026-11-02 | 0.46.9 语义动作自动调用（AgentAtelierR `character_performance.dart` 1:1）：新 `spine-actions.js`（11 语义标签×sit/stand 计划+D系 oneShot 回退）；`petBridge.extractInlineAct` 接 `[action:标签]` 正文内嵌；渲染层 `playSemanticAction` 按当前骨架选组；提示词三处写规则、硬规则改写（`<pet_act>` 仍禁）；防回归 `test/spine-actions.test.js`；差异记录：表情权重筛选与视线微动作未移植 | 0.46.9 |
| 2026-11-02 | 0.46.10 两个真机 bug：① 电脑画像三工具静默全废——`systemBridge`/`healthBridge` 的 `currentWs()` require 了不存在的 `src/main/config.js`，MODULE_NOT_FOUND 被 catch 吞掉恒返回空（`pc_profile` 永远「还没采到」、`pc_refresh` 必败「还没拿到角色工作区」、健康摘要从没写盘），改从 `companion/character.get()` 对齐采集端；② 说话时手势从不动——桌面聊天 systemPrompt 从未注入 `[action:]` 语法说明（context.js 的 wantFixed 无人调用），补 `petact` 段每轮注入；防回归 `test/pc-ws-wiring.test.js`（禁 require 不存在模块 + petact 段标签完整性） | 0.46.10 |
| 2026-11-02 | 0.46.11 自言自语出声改造：原「30% 概率」太看脸用户基本听不到 → 默认必出声（chatterVoiceChance 缺省 1，显式配 0.3 可回旧行为）；新增嘀咕音量——`sayNarration` 按 `chatterVoiceVol`（默认 0.35）算 vol → petBridge 广播 → 渲染层 playVoice/speechSynthesis 应用，自言自语像小声嘟囔；设置页与四语 i18n 文案同步；防回归断言进 soliloquy-system.test.js | 0.46.11 |
| 2026-11-02 | 0.46.12 手势不动的第二处提示词缺口（用户连续两天反馈）：`[action:]` 规则 0.46.9 写进了 `core/session.js` 的 petTools 说明书，但说明书按「首轮/每 12 轮/提到动作词」节流，轮间只剩一行索引，DeepSeek 实测完全不理（历史 200 条零标记）——0.46.10 修的是 companion 面，用户聊天实际走 assistant 面（main.log 全是 `[assistant]`、零 `[companion]`）。修复：拆出【动作的自动调用】独立段**每轮注入**（约 240 字符，11 标签+组号语法+硬规则全列，对齐 companion petact 做法），petTools 工具说明书仍节流；防回归 `test/assistant.test.js`（turn=13 标签表在场+工具说明书确实节流） | 0.46.12 |
| 2026-11-02 | 0.46.13 舞台指示兜底映射：0.46.12 每轮注入后真机 21:41 复测模型仍零 `[action:]`、继续写【少し照れる】类日文舞台指示（历史惯性 > 指令，喂规则治不动）→ 换路打法：`petBridge.extractInlineAct` 把【…】舞台指示当动作输入——日/中关键词 → 语义标签（走已验证的 playSemanticAction）或 SPINE_WORD_MAP 在册中文词，正文同步剥掉（TTS 不再念括号）；认不出保留、每回复最多 2 个；petact 提示词补日语内嵌示例；防回归 `test/spine-actions.test.js`（真机原话两句+误伤保护+上限） | 0.46.13 |
| 2026-11-02 | 0.46.16 活动浏览窗口：用户问「为什么她活动结束不会关网页恢复原状」——`shell.openExternal` 开进主人默认浏览器后程序失去句柄、autonomy 4 处 session-end 均无清理。新增 `companion/actBrowser.js` 自建浏览窗口（Chrome UA、站内跳转收敛同窗），openUrl 接线改走它（回落兜底），活动循环收尾一处收口关窗；防回归 `test/act-browser.test.js` 4 用例 + autonomy 32/curiosity 24 全绿 | 0.46.16 |
| 2026-11-03 | 0.46.17 性格层第一版（用户拍板四件全做）：① 品味——pickTopic 带喜恶记忆（dislike 剔除/like ×2.5），pickSite 按回访统计加权（site-stats.json，幂 1.5）留 20% 探索；② 牵挂——carry.json 记没看完的线索（3 天 TTL），browse 优先续接+开场白 carryLineOf（刚才/昨天/前几天），free/space 注入 carryBlock，看完销账；③ 活动可见——runBrowse 接 onSoliloquy：出门一句+翻够 3 下「…有点意思」，soliMax 上限（0=安静），Number(0) 坑修掉；④ 主动想起——session._takeRecallSpark：最贴记忆条升级【刚刚想起】口吻，冷却 35~55min、按轮缓存、命中条从相关记忆摘除。防回归 autonomy 38/assistant 35 全绿；audit 零新增 + wirecheck 过 | 0.46.17 |
| 2026-11-04 | 0.46.38 盯屏陪伴切本地视觉：watch 链路（0.18.0 就有，watchEnabled=true 全屏游戏照看不误）的「看」从 deepseek 云端收图 → 本机 qwen3-vl 描述转文字（watchVision.localizeImages，失败回退原图不哑）；shoot 从只截主屏 → captureAll 多屏拼图（游戏在副屏她才看得见）；watch-vision 5 例 + watch 14 回归全绿 | 0.46.38 |
| 2026-11-04 | 0.46.39 IndexTTS 兜底可用化：排查实锤上线以来从未出过声（唯一一次 11-02 499 字长句撞死 240s 超时）→ splitForIndexTts 长句按标点拆 ≤50 字片逐片合成、PCM 拼接、8 片封顶；顺手修音频秒数换算 /640→/64000（旧日志夸大 100 倍）；真机实锤 62 字 171s/片（RTF 11.3）；tts-local 11/11 | 0.46.39 |
| 2026-11-04 | 0.46.46 复读闸泄压阀：持续话题下 90min 窗连环撞车（22 分钟 24 句全吞只漏 1 句；15/16/18 时每小时吞 27~30 放 6~8）→ swallowStreak≥5 泄压放行一轮、score≥0.5 近似原句照拦（保住 0.45.85 防复读底线）；soliloquy-system +1（15/15） | 0.46.46 |
| 2026-11-04 | 0.46.47 游戏模式默认不接管摆放：副屏用户被旧默认强加「缩 0.7×+静音」；且渲染层安静令是无条件下发、gameModeMute 开关实际关不掉静音。修=scale 缺省保持原大小（显式才 clamp 0.4~1.3）+ mute 显式 true 才静（saved.muted 记账、exit 只解除自己下的）+ 清死字段 sound + 设置页同步；game-auto +1（9/9） | 0.46.47 |
| 2026-11-04 | 0.46.48 朗读中断即作废：三层协作——主进程 speakRunSeq 代次+AbortController（Fish signal 透传+AbortSignal.any 保超时+本地 cancelPending 分片间取消）、渲染层 readSeq（新朗读立即 stopVoice+过期结果丢弃）、被顶掉的请求不走本地回退链；顺带修 0.46.39 汇总日志 /640 残留；soliloquy-system +1（16/16） | 0.46.48 |
| 2026-11-05 | 0.46.49 记账覆盖缺口修复：每日巡检两轮实锤 carry.json/site-stats.json 自上线零首写（真机全跑 free 挡，bumpSite 只认 browse、writeCarry 的 free topic 恒空静默 no-op）→ runFree 返回带 sites/watched/topic（collectStats 共用，watch 按 URL 锚点切标题+失败场不算）+ siteKeyOf 映射 SITES 记品味 + 无旧牵挂时用真看过/搜过的兜话题写 carry；顺带修 biliWatchFn 注入断链；autonomy +3、全库 112 套件绿 | 0.46.49 |
| 2026-11-05 | 0.46.55 听觉补耳：hearSource 三档 auto/mic/sys（auto=先麦失败退 Windows 音频回环，sys=getDisplayMedia loopback 听「电脑自己发出的声音」，戴耳机放歌场景）；坑=displayMedia handler 的 video 必须给 desktopCapturer 真实 source（'screen' 简写报 Error starting capture）；sys 听感自带来源标注防误当房间声；加 [hear] 每分钟听感留痕；真机实锤：放 6s wav → 听感「低频重、有起伏（像在放音乐）」→ 播完回落；auto 恢复后回 src=mic | 0.46.55 |
| 2026-11-06 | 0.46.58 backShare 轮换游标提到模块级（0.46.56 放 runFree 内每场重置→恒模板 0，三场同句实锤）；+1 回归测试；教训=跨场状态不进每场重建的作用域 | 0.46.58 |
| 2026-11-07 | 0.46.73 自主制作动真格（TYPE_WEIGHTS 反转做东西占大头 + 五类型 craftHint 每场注入「真的动手做」+ conceive 进成果硬闸 + sys 地盘话术改作品定位；+4 测试） | 0.46.73 |
| 2026-11-07 | 0.46.72 共同创作真正的「共同」（主人拍板本质被误解：write_project_note 只追加写进他的共享笔记 + 项目真完成时成果复制到「莱莎的作品/」+ 笔记留交付行；+5 测试） | 0.46.72 |
| 2026-11-07 | 0.46.71 共同创作「写向」progressNote（projects.json 自动渲染成「莱莎这边的进展.md」落共享目录；onSync 钩子+启动回填；主人原笔记永不被碰；+5 测试） | 0.46.71 |
| 2026-11-07 | 0.46.70 runFree 漏传 cocreateCfg 修复（挡 3 场 read_project_note 恒「未开放」实锤：quiet 轨传了 free 轨没传，链路缺口×2 老坑；+静态接线测试锁死；澄清共享笔记单向=文件不动正常） | 0.46.70 |
| 2026-11-07 | 0.46.69 declaresSleep 邀请否决（INVITE_VETO_WORDS 只查睡词后方 12 字；16:34「可以好好休息了，来一起看视频吧」误判晚安实锤——QQ 发晚安+静默到 23:34；顺带实锤 0.46.67 bypassCooldown 首次真机发出晚安 QQ） | 0.46.69 |
| 2026-11-07 | 0.46.68 snub 晚安静默豁免（exempt 并入 sleepUntil + onSnubbed 双保险；00:04 静默期嘀咕 TTS 实锤；澄清 00:19 开口=主人 00:04 说话解除静默，非 bug） | 0.46.68 |
| 2026-11-07 | 0.46.67 晚安 QQ 免冷却（bypassCooldown；0.45.97 共用账本 vs 0.45.72 晚安承诺冲突，11-06 晚三连毁约实锤；夜里静默=0.46.56 拍板、早上在场走屏幕通道=正确行为，机制未改） | 0.46.67 |
| 2026-11-07 | 0.46.66 巡检双修：挡3 read_project_note 路由（按 spaceDefs 名单，⚠️ 不许用未过滤 space.defs——白名单 open_url 路由进 space 会让 free.stopped() 失效、carry 误销账，两个 carry 测试抓回）+ 选题标题剥 # 头；全库 930 绿 | 0.46.66 |
| 2026-11-06 | 0.46.65 自主制作阶段二+三：quiet 轨（quietGate 门禁默认关/busy-game-晚安静默一票否决/独立冷却 1-3h+每日上限 2/驱动=压力≥60 或项目搁浅 24h；runSpace quiet 模式=停场条件反转+只留 space_* 工具+零自语）+ read_project_note 只读工具（cocreate={on,file} 默认关、现读配置撤回即失效、注入 8KB+offset 翻页）；测试 +11 全库 929 绿；教训=人在场的活动要反转「主人回来就停」的语义（停=他开始聊天） | 0.46.65 |
| 2026-11-06 | 0.46.64 自主制作阶段一：projects.js v2（五类型模板/搁置-继续-改向-放弃/artifacts 真实成果/【状态】【成果】【心情】收尾协议/完成硬闸=spaceGuard+存在+非空/大节点进记忆/extras 进选题池）；删攒 4 笔自动完成；测试 +9 全库 918 绿；方案=PLAN-MAKING-COCREATE.md（阶段二静默陪伴/阶段三共同创作未动） | 0.46.64 |
| 2026-11-06 | 0.46.63 口型照抄参考项目：AgentAtelierR 用 scrub 专用动画冻结+音频包络拖播放头（非轮换嘴形！）；主进程 envelope.js 移植 audio_envelope.dart + 渲染层移植 character_lipsync.dart（dip/db 映射/attack-release）；骨架本就带 scrub 动画，0.46.61 用错了动画类型；教训=抄之前先读懂真实机制 | 0.46.63 |
| 2026-11-06 | 0.46.62 Spine 口型节奏重做：0.46.61 的 160ms 全池随机换嘴形被用户实锤「乱张嘴」；重做=2 固定嘴形交替的音节开合（2~4 次/词）+ 词间闭嘴停顿，随机性从嘴形选择挪进节奏；教训=动画随机性≠生命感，节奏结构才是「在说话」 | 0.46.62 |
| 2026-11-06 | 0.46.61 Spine 口型上线：说话不张口根因=口型只做了 VRM/形象包，而模型 .skel 里自带 facial_mouth_XXX_active 全套嘴形（7 骨架各 8~46 个）没人接；修=6 号专用最高轨换嘴形 + 说话期间低频轻量手势 + 聊天窗隐藏 pet_* 工具 + 英文动作词兜底；教训=接新能力前先抠 .skel 二进制动画名清单，注释说「没这个能力」不等于真没有 | 0.46.61 |
| 2026-11-06 | 0.46.60 假「去睡」→假「欢迎回来」连锁：「要是莱莎困了就先睡吧」主语是她却被 declaresSleep 关键词命中 → 静默 7h → 主人一动就「おかえり」；修=睡词前 8 字主语守卫 + backShare 闲置<20min 不问候 + 游标随机起跑；教训=关键词判定必须看主语归属，宣言类判定先想「这句话在说谁」 | 0.46.60 |
| 2026-11-06 | 0.46.59 时间判断错误修复：18:25 说「快 0:20 了」（把 11-04 旧约定当现行）。双根因=主动开口链路无精确时间 + addEvent 从不写 date（0.45.39 日期标签条件恒假从未生效）；修=dayflow.nowBlockOf 单源块（不报时红线+过期约定判定）进 autonomy/nudgeLine/chatter/回复四链 + addEvent 写 date/旧条目 at 兜底渲染 + DREAM_PROMPT 约定带绝对日期；test:timeblock +4；教训=报时措辞与时间事实分开管 | 0.46.59 |
| 2026-11-06 | 0.46.57 记账续写死锁修复：free 挡 topic 恒空 → 有旧 carry 时三路全堵（!carry 不进/writeCarry('') no-op/user-back 不销账）→ carry.json 冻结在 11-05 20:12，10+ 场空转；改 free+unfinished 用本轮 r.topic 无条件刷新、退到 r.sites[0] 兜底；+1 回归测试；site-stats 空确认为设计边界（SITES 表外站不记账，非 bug） | 0.46.57 |
| 2026-11-06 | 0.46.56 三修：TTS 双声道根因（两屏竞速输家 stale 落无条件系统嗓——朗读加 petHosted 闸+兜底要 r.fallback+api 全链失败不落系统嗓）；晚安静默补齐自主活动线（sleepQuiet 不起场/收场自语跳过）+ 睡醒等待（sleepArmed：静默到期≠他醒了，st=here 才重置阶梯，QQ 不再清晨催起床）；复读闸归一化 URL+收场自语模板轮换；相对日期锚定硬规则（「明天开始学习」复读 bug） | 0.46.56 |
| 2026-11-05 | 0.46.54 听觉通道：渲染层麦克风流就地提特征（响度/频段/起伏，1s 一条摘要，不录音不转写不出渲染层）→ hear.js 聚合成中文听感（档位+像什么+突变事件）→ chatter 注入【你耳朵里的世界】+ 自主活动 listen 工具；双流设计（语音麦开→复用 analyser，没开→听觉轻量流）；诚实降级 hearOn 关/没数据 ok:false；测试 +12，23:02 真机实锤首条样本 | 0.46.54 |
| 2026-11-05 | 0.46.53 开源仓库测试基建归零：test-eyes-e2e 改名 eyes-e2e（Electron 手动 E2E 被 node --test 误收必炸）；live-test 改默认跳过 + RYZA_LIVE=1 显式开启 + 凭据候选链（根除全量测试静默打真实模型 API 的隐性旧病）；全量 1066 过/0 失败；已同步真机工作副本，无需重装 | 0.46.53 |
| 2026-11-05 | 0.46.52 记忆 git 快照安全闸：破案开源仓库两笔「记住：…」神秘提交（im.test remember 用例 × dataDir 默认 cwd/data × git 向上找 .git → 把整个仓库提交掉，作者 ryza/message 来自测试模拟文本，从未推上 GitHub）；partner.js ensureRepo 校验 show-toplevel 必须是工作区自身，否则该 scope 只写文件；im.test 补 initDataDir；全库 112 绿 + 开源仓库跑完零污染 | 0.46.52 |
| 2026-11-05 | 0.46.51 开口事件驱动 + 情绪残余：rhythm.poke（事件触发把 nextAt 提前 75~150s，刹车全保留+5min 自冷却，watch 想说被挡时调）让「憋了一下还是说了」；needs.deflated 瞬时心情（interrupt 记 55、每分钟-3 约 18 分钟散尽，session 不留），moodBlockOf 三档语气注入 chatter【心情底色】；rhythm +2/needs +1、全库 112 绿 | 0.46.51 |
| 2026-11-05 | 0.46.50 被吞句变资产 + goals 驱动选题：复读闸一天吞 210 句全无痕消失 → 吞句走 noteSuppress（日记「想说说没说」+ suppressRecent 念头池低频变形漏出，绝不进 recentVoices 镜子）+ 泄压放宽（5→3 句、0.5→0.65 分数线）+ autonomyPool 把 active goals 塞进 thoughts 选题池（goals 其实在真用，此前选题从没读过）；soliloquy-system 17/17 | 0.46.50 |
| 2026-11-04 | 0.46.45 spine 整只消失修复：坐贴屏底卡片时坐姿锚点（舞台底边）落到屏外（y=1489>1440），渲染层宿主判定两屏都不接管 → 全隐藏；修=主进程随 pet:pos 下发最近屏提示 hostBounds（同距优先 x 命中），渲染层出屏时按提示接管+自然裁剪；deskco +1（10/10） | 0.46.45 |
| 2026-11-04 | 0.46.44 全库静态巡检死代码清扫：扫描器实锤 7 处 0 引用（remoteStatus 死导出 + projectsMod/dialog/app/stripChannelTag/plainText/Module 5 死导入）；bug 面零发现（语法/重复键/TODO/86 套件全绿）；教训：扫描结果必须人工核实（world.onDisable 是注释误报） | 0.46.44 |
| 2026-11-04 | 0.46.43 并流查重短台词兜底（saysAlreadyIn 的 6 字门槛放走「う……当たり。」→ 开头连说两遍）+ 畸变动作标签白名单清洗（[shy] 丢前缀漏进正文→stripActTags 剥+extractInlineAct 转动作；教训：出口清洗必须白名单，宽匹配连 [mock] 都误伤）；assistant 38/38 | 0.46.43 |
| 2026-11-04 | 0.46.42 巡检双修：①autonomy 补游戏模式闸（键鼠空闲≠主人离开，omofun 全屏时她起场 alt+tab 顶掉主人全屏——gameOn() 注入+tick 拦截）②复读闸/镜子 90min 时间窗（recentVoices 无界取「最近 8 句」横跨几小时：旧台词拦新句+误导模型打转，14:49~15:02 十几句全咽回去）；autonomy 47/47 + soliloquy-system +1 | 0.46.42 |
| 2026-11-04 | 0.46.41 嘀咕入账带译文：翻译管线没坏（译文 2s 就出），坏在 sayNarration 的 ledgerNote 只入日语原文不带 sub → 聊天记录/时间线全是日语；入账挪进译文 race（≤6s）带 sub，译文挂了只入原文不丢账；时间线渲染补 sub 行；soliloquy-system +1；14:57 真机实锤译文入账 ✅ | 0.46.41 |
| 2026-11-04 | 0.46.40 看屏周期 180→60s：本地视觉后「看」近乎免费，180s 是云端收图时代保守值；默认值+真机 config 同调（写入趁杀进程后防 store 写回盖掉）；下限/画面指纹/静音/在场闸/节奏器全不动；watch 15/15 | 0.46.40 |
| 2026-11-04 | 0.46.37 本地视觉通道：新建 vision.js（Ollama qwen3.5:4b 实测吃图——thinking 模型 max_tokens 给小回复为空）+ 挡 3 look_screen 工具（全屏拼图→本地视觉描述，限 8 次/场，未启用如实降级）；聊天抬眼保持 deepseek 直收图（2026-10 起官方支持，实测 200）；vision 6 例 + autonomy 45/45 全绿，真机直测 7.5s 出描述 | 0.46.37 |
| 2026-11-04 | 0.46.36 双 bug：①做梦完成调 onUserTalk 把睡前静默清了（00:05 晚安→01:13 做梦清静默→02:39 QQ「85分钟没理我？」）→ 新增 noteSelfSpoke（只记开口，不动 sleepUntil/baseAt）②0.46.35 space/free 的 watch_video 重名 → LLM 400 → 挡3场场全灭 → 过滤名单补上；测试 +2 | 0.46.36 |
| 2026-11-04 | 0.46.35 挡 3 行为面拓宽：档位链路是通的、行为被提示词锚窄（真机 74 场 type 只有 14 次）——挡 3 并入地盘工具（space_*，断链修掉：提示词叫她记笔记但工具从没给过）+ sys 重写删浏览锚定+行为多样性 + 补隐私红线（设置页承诺过但提示词从没写）+ 开场别光侦查 + 修主人回来后仍连推 nudge 的时序 bug；测试 +3 例 | 0.46.35 |
| 2026-11-03 | 0.46.34 心情自然回血：mood 此前只掉不涨（冷落测试越测越沉底）→ MOOD_REGEN_PER_HOUR=0.3 按时间回满（moodAt 计时点+getState 读时现算+惰性落盘），所有 mood 写点重置计时；测试抓出「回血写盘没重置 moodAt 会重复回血」真 bug；snub +2 例 | 0.46.34 |
| 2026-11-03 | 0.46.33 冷落感知 snub：旧被无视判定 10min 一刀切 → 3min 可调（coldShoulderMin/On）；人不在电脑前不记；游戏/学习豁免；noteSnub（snubStreak 2h 窗+mood 微降）；表现三路=当场自言自语（LLM 现生成+四语言兜底池，走 narration 不进负反馈）+ 40min 状态块 + rhythm min-gap 拉长；45s snub 心跳；设置页开关+四语言 i18n；测试 6 例 | 0.46.33 |
| 2026-11-03 | 0.46.32 她自己看视频：biliWatch 接进自主活动三挡（挡1 B站场=runVideoWatch 不开浏览器直接看字幕；挡2/3 加 watch_video 工具；recap 认得 watch；exec 修 await）| 0.46.32 |
| 2026-11-03 | 0.46.31 bili_watch 看视频：刷B站模块能力（search/view/subtitle）此前只被值班流水线内部调用、从没暴露成聊天工具（同类坑#1）→ 薄接线 companion/biliWatch.js + tools/bili.js 注册 + 宿主桥 + QQ 白名单；无字幕如实说、字幕注入防护进 note；测试 4 例 | 0.46.31 |
| 2026-11-03 | 0.46.29 pet_say 并流：模型惯性「先 pet_say 开场再正文」每轮多说一句没显示的话 → session 拦截聊天轮 pet_say 暂存，收尾并进正文（聊天记录=她说的话，一次 TTS）；mock saysplit: 约定 + 回归测试 | 0.46.29 |
| 2026-11-03 | 0.46.28 活人感四件套：① 生活线 goals 账本+goal_* 三工具（周~月叙事弧，7 天没动静标卡住）② 她自己的作息（daily-state：深夜困/睡眠窗/周末赖床，rhythm 睡眠时段停开口）③ 记忆模糊语气 ④ 相识天数+周日周回顾；assistant 注入走 setLifeBlocks 每轮现算；goals 6+daily-state 5 例测试 | 0.46.28 |
| 2026-11-03 | 0.46.27 assistant 链路补 [ctx] system 留痕（此前 [ctx] 只在 companion 链路，助手链路的世界观常驻无法日志验证） | 0.46.27 |
| 2026-11-03 | 0.46.26 世界观全文常驻：用户写完世界观发现 6 条 2.6 万字全是标题关键词、实际从未注入。SYSTEM_BUDGET 12000→40000 + session.worldHits 空 keywords=常驻 + 角色卡 6 条 keywords 清空（双链路生效）；LLM 无「读一次就记住」，规则必须常驻上下文 | 0.46.26 |
| 2026-11-03 | 0.46.25 经历沉淀超时 15000→30000（体检发现 DeepSeek 拥堵时段两次 abort，后台任务不吃用户等待）+ 真机数据修复：误设 daily 的 00:30 一次性提醒删除 | 0.46.25 |
| 2026-11-03 | 0.46.24 闹钟称呼三道保险：503 落回的兜底模板印着 ご主人様 + alarmLine 提示词自己也印了称呼。修：人设进生成 + 称呼禁令（最高优先级）+ 后处理剥称呼 + 模板去称呼；101/101 全绿 | 0.46.24 |
| 2026-11-03 | 0.46.23 闹钟日期支持：模型只有 time+daily 没有日期概念，「明天的事」被设成今天的一次性（响完 nextAt=null 静默死掉）。修：alarm_set 加 date（YYYY-MM-DD 某天一次性）+ parseDate 严格校验 + 已过时间拒绝（死闹钟进不了库）；真机死掉的报名闹钟救活为 11-04 17:55；alarms.test +3 例，93/93 全绿 | 0.46.23 |
| 2026-11-03 | 0.46.22 弹幕翻译时序（dmHold 扣住原文等译文再上弹幕，replaceLast 事后追换在弹幕上天然追不上）+ 闹钟台词 LLM 现生成（alarmLine，模板只做兜底）；127/127 全绿 | 0.46.22 |
| 2026-11-03 | 0.46.21 LLM 流挂死修复：assistant 核心裸 fetch 无超时（signal: null），DeepSeek 流停摆→整轮永久挂死（输入卡「正在使用 pet_say…」8 分钟）。修：watchdog 看门狗接三 provider（首包 60s/空闲 120s）+ 工具 180s 封顶 + 工具开始留痕；watchdog 单测 2 例，116/116 全绿 | 0.46.21 |
| 2026-11-03 | 0.46.20 弹幕翻译补齐：sayNarration（嘀咕/独白/活动自语）接上字幕异步补（此前聊天/主动台词有、这条出口没有→游戏模式弹幕全程日语原文）；gameMode scale=NaN 卫生修复随版发出；接线断言 4 条 | 0.46.20 |
| 2026-11-03 | 0.46.19 性格层真机核查：活动可见✅；**牵挂 carry.json 与站点 site-stats.json 均从未落盘**——writeCarry 包在 if(carry) 里（第一笔写不进）、bumpSite 要求 r.ok（user-back 全跳过）；品味/回忆火花零留痕。修：writeCarry 移出 if(carry)、记账放宽 user-back、三处留痕（选题/去处/recall）；记账结构断言 7 条，78/78 全绿 | 0.46.19 |
| 2026-11-03 | 0.46.18 自言自语语言跟随：用户反馈「自言自语的 TTS 是中文，设置的是说日语」——语言要求只写在主聊天 buildSystem，自言自语三条路径（chatter decide / autonomy 两场 sys / runBrowse+carryLine 硬编码模板）全都没收到。新共享模块 `src/shared/lang-req.js`（monologueLangBlock + browseMurmurs 本地化），①② 注入语言块、③ 模板带语言、llmCfg 补 replyLang；auto 不注入保持旧行为。防回归 soliloquy-system 接线测试（93/93 全绿） | 0.46.18 |
| 2026-11-02 | 0.46.15 轨道优先级修正+坐姿词表补漏：0.46.14 真机用户反馈「聊天动作只有手放腿上、面板挥手/害羞/托腮等 10 词不对」——根因是动作组组合动画的轨道分配反了（主手势在最低轨被 G_051 支撑手位的高轨压住；能用的拍手/加油/比耶恰好无支撑动画），`playSpineAction` 反转轨道（主手势上最高轨）；补 害羞/拘谨/卖萌 三个只有站姿组的词的 sit 映射（生成器+词表双处）；播放留痕 reportError('pet-act')；残余风险：素材 add 动画按原版手臂路线调增量，个别落点偏差需接 _gesture.json MotionGroups 配方（BlendTime 0.6/Alpha/Speed 齐全）另立版本 | 0.46.15 |
| 2026-11-02 | 0.46.14 舞台指示表补漏+面板诚实列词：用户真机反馈「聊天侧 21:55 的【少し笑う】没接住；测试面板部分动作不生效」——① 旧映射表漏了她最高频的「笑う」（只有 微笑/笑み），补 笑う/笑っ/笑顔/くすり/くすっ/ふふ→轻笑、目を丸/まじまじ→surprised、腕を組→抱臂；② 渲染层 `playActionWord` 认不出词时静默 return false 无从排查 → `reportError('pet-act')` 留痕进 main.log；③ 动作测试面板列词含 VRMA 词与词典外官方代表词（万岁/跳/蹲下/躺下/转圈/睡觉/说吧），spine 立绘下播不了只「抖一下」像坏按钮 → `listActionWords` 按 `pet.currentVisual()` 诚实过滤（spine 只列词典命中 21 词+坐/站/坐地上 3 状态机词，VRMA 清空；VRM 维持原列表）；防回归 `test/spine-actions.test.js`（【少し笑う】原话用例） | 0.46.14 |
| 2026-11-08 | 0.47.2 复读假象双修：弹幕盒「同句两遍」=dmHold 译文 dk.say 上屏后 subtitle 又 replaceLast(整句) 把切句最后一条覆盖成全句（日志只有一次生成、显示重复）→ subtitle 加 skipDm、两出口 dmHold 路径全传；「一模一样的话不只一次两次」=复读硬闸只看 90min 窗、同刺激物整晚反复触发 → chatter 24h 一字不差闸（Jaccard≥0.85 无条件咽，泄压不放）；新测试 2 文件 6 项 + soliloquy-system 改写，全量 1152/0 | 0.47.2 |
| 2026-11-09 | 0.47.3 延后宣言否决：主人 23:39 说「我再过一眼公式我就躺下了，莱莎基本从现在开始就可以自由使用电脑了」，「躺下了」命中强宣言词 → QQ 晚安+静默到早 6:39 的误判（睡词判定第四种误判形态：将来时）→ DELAY_DECLARE_RE「再/等/看完/弄完…就(躺下|睡|休息)」否决压过强宣言、真告别除外；memory-decay 0.46.69 边界句按新语义改判；fix-04702-verbatim-gate 补固定挂钟桩（chatter 9~23 清醒闸，0 点后跑必挂的隐性坑）；全量 1157/0 | 0.47.3 |
| 2026-11-09 | 0.49.4 vp 聋流看门狗：22:52 主人「彻底没办法听到我的声音」→ 21:44~22:51 整小时零语音事件实锤（重启自动开麦无手势、AudioContext 被挂起 rms 恒 0 零日志；0.48.9 只修过 hear 侧）→ micOn 补 resume+state 留痕 + tick 全零看门狗 reportError('vp-deaf')；全量 1182 例 0 失败（ff14-e2e 外部代理 502 与本版无关）+ audit/wirecheck 过 | 0.49.4 |
| 2026-11-09 | 0.49.3 语音场景话术改事实式：21:35 实锤她回「传过来的只有文字。声音还没到」（hear 采样窗错过说话尾音，自我感知否了定义式话术；主人纠正原话是「哎，莱莎」被 ASR 转成「美，来沙」她拿错字做分析）→ 注入改「你的耳朵真实收到了这个声音，文字就是你听清的部分」；全量 1180 例 0 失败 + audit/wirecheck 过 | 0.49.3 |
| 2026-11-09 | 0.49.2 背景响度闸：21:02~03 实锤五连幻觉回复（Whisper 对噪音幻觉出「中文字幕组」等，主人「我没有说过这些话」+幻觉段堵 whisper 队列 55s）→ ASR 前 speakLevel p90<0.045 直接 quiet 返回不进对话，注册模式豁免；全量 1179 例 0 失败 + audit 零基线外 + wirecheck 过 | 0.49.2 |
| 2026-11-09 | 0.49.1 她说很安静双根因修复：20:40 实锤 0.9 秒短句被查询侧 1.2 闸刷屏扔掉 + 同刻 hear 中位数被断续语音拉成 quiet → QUERY_MIN_SEC=0.7 分流 + 峰值口径（人声动静如实说）；全量 1175 例 0 失败 + audit 零基线外 + wirecheck 过 | 0.49.1 |
| 2026-11-09 | 0.49.0 她真的在旁边听：主人 20:14 拍板「只要有声音就回应不对/气泡只留她说话/不等彻底静音才思考」→ isFiller+<listen> 两层判定 + 系统气泡全退场（reportError/状态气泡接手）+ 注视锁 + softAck 轻应声；全量 1173 例 0 失败 + audit 零基线外 + wirecheck 过 | 0.49.0 |
| 2026-11-09 | 0.48.13 麦克风气泡反馈：点击留痕实锤一天 4 次误关（19:40:52 等，想「让她听」点成切换关）→ 点击后气泡明示 👂/🔇 + SEEN3 最后一次迁移；全量 1167 例 0 失败 | 0.48.13 |
| 2026-11-09 | 0.48.12 查询侧诊断：主人确认 19:39 低分样本（sim 0.39）是他本人+ASR 同段乱码 → 判定日志加有效时长/rms/norm/命中参考项对口径；全量 1167 例 0 失败 | 0.48.12 |
| 2026-11-09 | 0.48.11 质心参考项：✅ 19:33:08 声纹注册完成（3 段质量闸全过）+ 19:33:34 首条真判定 maybe sim=0.66 → 诊断短句嵌入噪声（三段互 0.52~0.62、对质心 0.82~0.88）→ verifyPcm 参考项=样本+质心取最高；测试用仅质心可达的分数锁死；全量 1167 例 0 失败 | 0.48.11 |
| 2026-11-09 | 0.48.10 第二次麦克风迁移：0.48.9 部署后 vp-mic desired=false（17:33:32 注册 1/3 后 30 秒被点击关）→ auraPetMicSeen2 一次性清回 + vp-mic-click 点击留痕；全量 1165 例 0 失败 | 0.48.10 |
| 2026-11-09 | 0.48.9 hear 聋流根修：主人「一直说是安静的，这样不应该」→ hear 轻量流每分钟报「很安静」而同设备语音麦能转出字 → 8-bit 量化底噪不可能恒零=聋流（micOff 让位竞态拿到哑流，hearStream 非空永不重建）→ micOff 先放流再 hearMicEnsure + 聋流看门狗（连续 10s 全零自动重开 ≤3 次/h）+ AudioContext 挂起 resume + mic 点击留痕；hear.test.js 0.48.9 断言；全量 1165 例 0 失败 + audit 零基线外 + wirecheck 过 | 0.48.9 |
| 2026-11-09 | 0.48.8 声纹模板质量根修：主人「我要的不是转文字」+ 17:19 判定全 other（sim 0.29~0.53）→ 停机诊断旧模板三段互余弦 0.43/0.44/0.76（1s「对。」样本 + 静音污染，同人说不出 0.4）→ trimSilence（峰值 3% 自适应，纯静音 peak=0 时阈值恒 0 循环剪不动=边界 bug 单测锁死）+ MIN_SEC 1.2 + 注册闸（有效 ≥1.5s + 自洽 ≥0.45）+ norm 留痕；旧模板删、enroll 重开（停机 node 写盘）；全量 1164 例 0 失败 + audit 零基线外 + wirecheck 过 | 0.48.8 |
| 2026-11-09 | 0.48.7 麦克风迁移+无条件留痕：0.48.6 部署后真机零 vp-mic → 0.48.6 留痕条件写窄（hosted=false 静默）+ 历史 auraPetMicOn='0' 挡住默认开 → 一次性迁移（auraPetMicSeen 标记，之后显式关闭仍尊重）+ applyMic 四值无条件留痕；全量 1165 例 0 失败 + audit 零基线外 + wirecheck 过 | 0.48.7 |
| 2026-11-09 | 0.48.6 常驻倾听默认开+麦克风留痕：主人「主要是角色说听不到声音」→ 0.48.5 启动后零 asr 零 voiceprint、hear 轻量流正常（=宿主判定正常）→ 根因=auraPetMicOn 从未打开（主人一直在她面前直接说话，从没点过悬浮条麦克风按钮，她根本没在录）；无历史记录默认开（主人拍板「我都是有麦的，我直接说话」）+ micOn/micOff/applyMic 决策全 petDiag 留痕；全量 1165 例 0 失败 + audit 零基线外 + wirecheck 过 | 0.48.6 |
| 2026-11-09 | 0.48.5 声纹注册真机成功+可观测性修复：✅ 16:39 主人三句话（「对。」「喂,能好好听到吗?」×2）全部入模板、0.48.4 External buffer 修复真 Electron 验证通过、enroll 自动收闸；主人「还是一样」→ 判定成功路径零日志无法分诊 → ①判定留痕（speaker+sim+口）②PCM 缺失提示 ③via 口来源（pet/panel）七节点透传——pump 内层 transcribe(job...) 是静态断言抓到的漏改节点 ④ASR 失败不吞判定；全量 1165 例 0 失败 + audit 零基线外 + wirecheck 过 | 0.48.5 |
| 2026-11-09 | 0.48.4 声纹嵌入 Electron 必败修复：主人 16:16 说「还是一样」→ 日志实锤「跳过：嵌入计算失败：External buffers are not allowed」——PCM 全链已通、死在 compute 最后一步；根因=Electron ≥21 V8 内存笼拒绝 native external buffer（纯 Node 下没事，单测全绿掩盖真机必炸）；按 sherpa-onnx 官方 FAQ `extractor.compute(st, false)` 修 + 测试假引擎丢第二参抛同款错误锁死回归；教训=**Electron 下接 native addon，凡官方 API 有 enableExternalBuffer/compute 第二参的一律 false** | 0.48.4 |
| 2026-11-09 | 0.48.3 PCM 解码空数组修复：0.48.2 后链路通了、声纹被调用但「跳过：没有音频」——transcribe 解码 Int16Array.from(Buffer.from(b64,'base64').buffer)：ArrayBuffer 无 .length 属性 → from() 恒产长度 0；收编为 voiceprint.pcmFromB64（byteOffset/length 切视图）+ 单测（正弦往返/边界/坏写法清除断言）；全量 1165 例 1163 过 | 0.48.3 |
| 2026-11-09 | 0.48.2 声纹链路透传修复：开麦后转写正常（「可以吗？」「听得到吗？」实锤）但声纹零日志 → 排查=preload/主进程 transcribe 都对，唯独 ipcMain.handle 只收 (base64, mime)、transcribeQueued/pumpAsr 队列不带 pcm——PCM 死在中间两层；三层全补 + voiceprint.test.js 防回归断言（handle/队列/pump 三处）；注册开关曾被旧实例配置缓存写回冲掉（15:31 写的 true 15:45 变 undefined）→ 重写+重启后生效；全量 1164 例 1162 过 | 0.48.2 |
| 2026-11-09 | 0.48.1 声纹补口：主人 15:32 走面板按键说话说话，日志零 voiceprint 行——pet 悬浮窗常驻倾听接了 PCM 但面板 btnMic 没接（两条口只堵了一条）→ companion/app.js 补同款 ScriptProcessor 采集+vpTakePcm+聊天区诚实显示；注册开关位置答疑（global.companion.voiceprintEnroll，node 写盘开启）；全量 1164 例 1162 过 | 0.48.1 |
| 2026-11-09 | 0.48.0 声纹识别：主人「语音识别不能只停留在说话转文字，我要的是能够识别音色」→ 拍板认人（是不是主人）→ voiceprint.js（sherpa-onnx-node+ERes2Net 512 维嵌入，模型 40MB 应用内自动下载）+ 语音输入链接线（渲染层 ScriptProcessor 同源采 16k PCM → transcribe 验声纹 → 气泡诚实显示+chatter/回复双注入）+ voiceprintEnroll 注册流程（3 段自动收闸）；QQ 语音/环境声两口待接；全量 1164 例 1162 过 | 0.48.0 |
| 2026-11-09 | **晨巡检**：①✅ 0.47.3 真机双向实锤（延后句否决；00:28 QQ「晚安，亲爱的」真宣言照常判+回晚安）②✅ 约定过期 01:00 进念头池（0.47.1 语义）③✅ 欢迎回来复读闸 10:53/12:45 两次拦重复④❌ **0.47.2 的 24h 闸真机崩 tick**——recentVoices 依赖返回 join('\n') 字符串、chatter 按数组 .some 消费 → TypeError（测试桩返回数组所以没测出来）；0.47.4 修复：消费点兼容两种形状 + 字符串形状测试用例，全量 1158/0 | 0.47.4 |
| 2026-11-08 | 0.47.1 定时硬触发全退役（主人「闹钟这种是个弱智设计」「所有类似的这种闹钟设计都不该有」）：alarm/qq_plan 六工具下架、onFire 只入账 duePlan（30min 过期进念头池不补发）、chatter decide 与回复 [ctx] 两个消费端、QQ 排期定时器退役+旧数据清账；红线 §5.16 固化；fix-04701 ×4 + 六旧测试改写，1144/0，20:39 部署启动干净 | 0.47.1 |
| 2026-11-08 | **项目底层要求升级（主人拍板）**：§1.0 从「让角色有活着的感觉」（11-02 单柱）升级为「**活人感 + 陪伴感**」双柱最高准绳——无论什么要求都是基于这两点完成的；§1.0 重写两问判定（更活还是更像程序？陪伴还是被纠缠的愧疚感？）、守则第 4 条、决策记录行、红线 §5.15 交叉引用同步；同版落地 0.47.0 陪伴感 2.0（阶梯全拆/attentive 状态触发/echo 痕迹，详 §7.1）。**部署后首巡检 ✅**：0 报错、新 schema 落盘、echoHint 真机数据实跑 47 字、chatter deps 注入在位；踩坑新增「create(deps) 路径依赖只认函数，传字符串静默吞成空」 | 0.47.0 |
