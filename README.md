# Partner.execute(me);

> **名字出处**：程序名 **Partner.execute(me);** 致敬日本音乐组合 **Mili** 的歌曲
> **《world.execute(me);》**（收录于专辑《Miracle Milk》，2016）。
> 程序的视觉语言（炭黑单色、电源符号、代码感排版）同样取自该曲 MV。
> 本项目与 Mili 及其发行方无任何隶属关系，仅作致敬与引用说明。

一款 Windows 桌面 **AI 伙伴**：一只住在多屏桌面上的 VRM 小人 + 一个有长期记忆、会自己思考的助手核心。
她会聊天、会看你的屏幕、会陪你打游戏和自习、会记住你们之间发生过的事。

基于 AuraDesk 架构扩展，独立运行，不依赖其他软件。

---

## 功能总览

### 桌宠（多屏 VRM 小人）
- **跨屏自由移动**：任意屏拖拽、抛掷惯性、低频自主走动闲逛、坐在启动器卡片上休息
- **动作系统**：VRMA 动作池（待机小动作低频触发）、程序化姿态（坐姿 / 走路 / 呼吸），动画与程序化骨骼平滑交接
- **全屏让位**：检测到全屏游戏 / 视频时自动收起，退出自动回来
- **交互**：点击、拖拽、右键菜单、托盘菜单、实况帧（`127.0.0.1:8712/frame`）

### AI 对话与记忆
- **LLM 聊天**：OpenAI 兼容接口，流式输出、工具调用（她能帮你开程序、查时间、搜资料…）
- **长期记忆**：事件账本 + 记忆衰减 + 事实守护（防记错）+ 用户画像，每次对话自动沉淀
- **看屏幕**：定期截屏理解 + 本地 OCR，她知道你正在干什么（可关）
- **自主性**：自主搭话、内心戏、好奇心驱动、每日复盘、需求系统（不是你问才答的僵尸）

### 游戏模式
- 进入后缩小、静音、话改走弹幕，不挡画面
- **待哪自己选**：四角吸附，或 **「不固定（保持原位）」**——角色本来就在副屏的话，进出只缩放、不搬家；角落移动带平滑滑动，不再瞬移
- **自动进退**：检测到已知游戏（FF14 / 星穹铁道 / 原神 / 绝区零，可加名单）自动进入，退出自动恢复；切屏回消息 3 分钟内不断场，回来接着算
- **记忆同步**：玩了什么、玩了多久，进退出都写进本体记忆，她不会忘了陪你打过的游戏

### 学习模式（陪学监督）
- 视觉监督四分类：在学习 / 在玩 / **人不在（黑屏锁屏，不冤枉）** / 看不出（温柔问一次）
- 在玩会被生气（阶梯式），抓到才说，不胡猜
- 自动陪学与手动陪学同一套规则；会话结束自动写学习账本

### 语音
- **本地语音识别**（faster-whisper，中文优化 + 繁转简），录音不出机器
- 本地 TTS 语音合成，音色可选

### 其他
- **QQ 陪伴**：接入 NapCat，会主动找你、说晚安（可关）
- **游戏库**：Steam / Epic / 开始菜单自动扫描，按名字帮你开游戏
- **提醒与闹钟**、健康提醒、OBS 控制、字幕、远程访问
- **多形象**：VRM 模型 / 静态立绘（Spine 立绘运行时**不随开源版提供**，见下）

---

## 下载与安装

- 安装包：`Partner.execute(me);-Setup-x64.<version>.exe`（也有便携版 Portable）
- 双击安装，默认装到 `%LOCALAPPDATA%\Programs\`，可自选目录
- 开机自启可在 设置 → 通用 里勾选

### 首次配置
1. 启动后在 **设置 → 模型** 填 LLM 的 API Key（OpenAI 兼容接口：baseURL + key + 模型名）
2. 想要语音识别 / 本地 TTS，在 **设置 → 语音** 里选本地引擎
3. 桌面小人会自动出现；右键托盘图标可打开完整界面

### 数据在哪
- 所有配置、记忆、模型资产都在 `%APPDATA%\ryza-assistant-app\`，卸载不删（手动删才删）
- 记忆、聊天史、学习账本全部**只存本地**，不上传任何服务器

---

## 使用手册

详细手册见 [docs/MANUAL.md](docs/MANUAL.md)，包含：

- 托盘菜单 / 右键菜单逐项说明
- 游戏模式与自动进退的配置项（含 `gameAutoLeaveMin`、`gameAutoProcesses`）
- 学习模式的判定规则与账本
- 语音（ASR/TTS）配置
- 记忆系统原理与手动纠错
- 配置文件（`config.json`）常用字段速查

更新记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## 开发

```bash
cd app
npm install        # 安装依赖
npm run libs       # 重新打包渲染层第三方库（改了 three/vrm 版本时）
npm start          # 开发运行
npm test           # 全量测试（node:test，100+ 套件）
npm run dist       # 构建 NSIS 安装包 + 便携版
```

目录：`app/src/main` 主进程（companion 桌宠 / assistant 对话 / im 即时通讯 / cua 电脑操作 …）、
`app/src/renderer` 渲染层（overlay 桌宠 / companion 设置主界面）、`app/resources` 随包资源（OCR 模型、示例动作）、
根目录 `src/` 为早期独立助手核心（CLI），保留作参考。

### 关于 Spine 立绘（重要）

本项目的**开源版不含 Spine 运行时**（Spine Runtimes 的再分发条款与开源协议不兼容，仓库里也不含任何 Spine 素材）。
代码保留了静态立绘与 VRM 的完整能力；如果你持有 Esoteric Software 的合法授权，
可自行安装 `@esotericsoftware/spine-canvas` / `spine-webgl` 系列包并执行 `npm run libs`，
Spine 立绘功能会自动启用。

### 第三方组件致谢

- [three.js](https://github.com/mrdoob/three.js)（MIT）、[@pixiv/three-vrm](https://github.com/pixiv/three-vrm)（MIT）
- [Electron](https://www.electronjs.org/)（MIT）、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)（MIT）
- PaddleOCR 轻量模型（Apache-2.0）
- [Mili - world.execute(me);](https://www.youtube.com/watch?v=ESx_hhx1N4A) —— 名字与视觉灵感的出处

## License

MIT
