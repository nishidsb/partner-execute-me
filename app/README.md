# Ryza Assistant（AI 桌面伙伴）

> **代码来源**：本项目在 AI 编程助手协助下完成，需求拆解、交互与架构决策、缺陷定位和验收由本人负责。采用 MIT 协议开源。

产品范围只有三层（详见 `docs/SCOPE.md` 精简清单）：
1. **桌面伙伴**——透明桌面层上的桌宠：Spine/VRM/立绘渲染、触摸反应、视线跟踪、拖动缩放、气泡 AI 对话
2. **有记忆的 AI 角色**——多角色（动漫/原创/通用助手）、独立人格与记忆、检索注入、语言守卫
3. **个人助手**（开发中）——文件处理/应用操作/任务调度/可选后台运行

基于 AuraDesk 已验证的桌宠技术，但**已移除其全部遗留产品功能**（游戏库/任务栏/音乐播放器/歌词/时钟/控制舱等，见 SCOPE.md）。数据目录完全隔离（%APPDATA%\ryza-assistant-app），不影响 AuraDesk。

## 启动

```bash
npm start              # 开发运行
npm run dist           # 打包安装版 / 便携版
npm run smoke          # 桌面层 jsdom 冒烟
npm run test:assistant # 助手核心桥接测试
node scripts/migrate-from-auradesk.js   # 从 AuraDesk 迁移 AI 配置/角色（--dry 预览）
```

## 使用

- **托盘** → 「助手聊天…」：会话式聊天，角色下拉即时切换、记忆面板、模型配置
- **悬停桌宠** → 输入条直接对话（走助手核心，回复显示在气泡）
- **触摸角色** → 部位反应动画 + TTS 语音（触摸语音仍走 companion 的 TTS 档位）
- **托盘 → 切换角色**：全局激活角色，气泡与聊天窗同步

## v0.2.0 · 助手核心接入（不再是 AuraDesk 换名副本）

重构方案见 `docs/REFACTOR-PLAN.md`。v0.1.0（品牌替换基线）可回退。

- **助手聊天窗**（托盘 → 「助手聊天…」）：会话式交互，**角色下拉即时切换**（通用助手/莱莎/自建角色，各自独立会话、历史与记忆）
- **长期记忆面板**：按角色查看/添加/删除记忆，每轮对话自动检索相关条目注入上下文
- **模型配置内联**：baseUrl/key/model/温度直接配置，或一键从旧版伴侣（companion）导入凭据
- **工具调用可视化**：回复中显示调用状态；高风险命令弹系统确认框
- **桌宠联动**：助手对话流式同步到桌面角色气泡
- 数据落盘 `userData/assistant/`（config/roles/history/memory，重启恢复）
- 独立助手核心（`src/assistant/core/`，ESM 零依赖）从 CLI 项目移植，测试见 `npm run test:assistant`

旧版伴侣聊天保留：托盘「AI…（旧版伴侣）」——对比体验与回退路径。

## v0.5.0 · 形象包（API 2）+ 打扮

一个 zip 换整套形象，并且能换部件、改配色、存方案——不需要美术资源也能有新形象。

- **形象包**：zip 里放 `figure.json`（`api: 2`）+ 贴图即可。装好就是「角色 → 形象 → 形象包」，桌宠立刻换
- **装扮维度由包自己声明**（帽子 / 眼镜 / 颈饰 / 配色…），程序里没有任何写死的部件，新包想加什么维度就加什么
- **双色通道**：配件用 `c:main` / `c:acc` 取所在维度的两套颜色（`c-<slot>-main` / `-acc`），也可以直写 `c:hat-acc`
- **独立装扮窗**（角色 → 形象 →「形象与装扮…」）：左边大图预览 + 桌宠尺寸样张，右边挑部件、改颜色、存方案；改色会先复制成「我的配色」，内置方案不会被改坏
- **拖入即装**：把 zip 拖进装扮窗就能装；装包失败不会留下半个包（先暂存→校验→原子安装），路径穿越 / 超大包 / 旧 API 包都会被拒并给出原因
- **不执行包里的任何脚本**：图层只有「形状 / 图片 / 颜色」三种声明，第三方包最多骗你换个颜色，跑不了代码（比 iframe 沙箱更彻底）
- 呼吸、摇摆、眨眼是程序化动画，包不用做序列帧
- 首次启动自动装一个示例包（`resources/figures/ryza-example.zip`，形状声明式生成，不含第三方美术）

```bash
npm run test:figure      # 形象包回归：zip 安全 / manifest / 原子安装 / 装扮解析 / 渲染
npm run figure:example   # 重新生成示例包
npm run figure:preview -- pack-id out.png '{"hat":"beret"}' mint   # 不开 GUI 离线出图
```

## v0.6.0 · 电脑操作（CUA）：她能看着屏幕替你动手

聊天窗右上角「电脑」→ 读完三条风险并逐条勾选 → 打开开关。默认**关闭**，没开启时这十一个工具
既不会出现在模型面前，也无法被调用（门禁在工具注册层，不是靠提示词劝住）。

| 工具 | 干什么 | 风险档 |
| --- | --- | --- |
| `screenshot` / `zoom` | 截图（默认只截你正在用的那块屏）/ 放大局部 | 只读 |
| `click` / `move` / `drag` / `scroll` | 点、悬停、拖、滚（坐标用截图里的像素坐标） | 会动鼠标 |
| `type` / `key` | 输入文字（中文/emoji 都行）/ 按 ctrl+s 这类组合键 | 会动键盘 |
| `windows` / `focus` | 列出窗口、把某个窗口切到前台 | 只读 / 会切窗口 |
| `wait` | 等程序启动、页面加载（最多 10 秒） | 只读 |
| `wechat_send` | 在微信里给某联系人发消息：Ctrl+F 搜人 → **弹窗给你看截图** → 你点「对，发送」才真发 | 自带带图确认 |

第 12 个工具 `wechat_send` 专门为「帮我在微信回消息」这类请求设计，**不要求模型会看图**：
纯文本模型（DeepSeek 官方接口就是）也能可靠地发给正确的人——关键一步（是不是这个人）由你看着截图确认。
模型读不了图时，看屏幕类工具会自动切「盲操作」说明，面板顶部会提示换模型（qwen-vl / glm-4v / gpt-4o 等）。

设计要点：

- **引擎在独立子进程里**（`koffi` 直接调 user32/gdi32）。FFI 崩溃只死 worker，主进程下次调用自动重启，聊天不会跟着挂
- **你一动就让位**：每个动键鼠的动作前查 `GetLastInputInfo`，2 秒内有输入就等，最多等 15 秒；超时就返回「已让位」交还控制权，绝不跟你抢鼠标
- **动作后自动补图**：settle 500ms 后按同一区域再截一张给模型看结果，所以它是「看一眼→动一下→再看一眼」的闭环，不是盲点
- **坐标换算集中在纯函数里**（`src/main/cua/geometry.js`）：模型说的是截图坐标，引擎要的是物理像素；越界直接报错而不是夹到边缘（点错地方比不点更糟）
- **截图不进上下文**：dataURL 从 tool 结果里剥出来，单独作为一条图片消息；端点不支持图片（纯文本模型）时自动降级成纯文本重跑
- **确认窗自绘**：60 秒倒计时，到点自动按拒绝处理。不用系统对话框是因为 `showMessageBoxSync` 会阻塞整个主进程、而且没法超时关掉
- **动作期间桌宠让位**：所有桌面层窗口临时设为完全穿透，否则她要点的位置可能正好被角色挡着

需要能看图的模型（gpt-4o / qwen-vl / gemini 等）。详细验收入口见 [`docs/TESTING.md`](docs/TESTING.md)。

## 3D 模型（VRM / 普通 GLB）

角色 → 形象 → 切到「3D」→「导入形象文件…」，选 `.vrm` 或 `.glb` 即可，导入后立刻在伴侣窗和桌宠上生效。

- **两种格式都能用**：VRM 0.x / VRM 1.0 走 three-vrm 解析（骨骼、表情、springbone 头发物理）；从 Sketchfab、Blender 导出的**普通 GLB 也支持**——不是 VRM 就降级成普通 glTF 场景（几何 + 动画，没有表情系统）
- **自带动画会播**：模型里的动作 clip 自动循环，优先挑名字含 `idle / stand / wait / breath / loop` 的那条，没有就播第一条；一条都没有就是静态姿势
- **会眨眼、说话会动嘴**：眨眼是程序化的（2.6~6.2 秒随机，闭合 110ms），口型跟 TTS 播放走（`expressionManager` 的 `aa` 预设），说完自动闭合
- **取景不写死**：相机距离按模型包围盒算（垂直/水平都塞得下 + 半个厚度），1.4m 到 2m 身高的模型都完整可见；改缩放或窗口尺寸会自动重算
- **桌宠层用 30fps 定时器渲染**：桌面层是置底透明窗口，被普通窗口覆盖时 Chromium 会暂停 `requestAnimationFrame`，用 rAF 会让模型定格（和 Spine / 形象包同一条教训）
- **限制**：`.gltf`（引用外部 `.bin` + 贴图的多文件格式）不支持，先在 Blender/DCC 里导出成单个 `.glb`；`.fbx`、MMD `.pmx` 也不支持

### MMD 的 `.pmx` 怎么用（离线转成 VRM / GLB）

应用里不能直接读 `.pmx`，仓库里带了一条 Blender 无界面转换流水线：

```bash
# 一次性准备（Blender 4.2 LTS 便携版 + mmd_tools + VRM add-on 都放在 tools/blender/）
# 转换：PMX → VRM 1.0（人形骨骼自动映射）+ GLB（同一份几何，材质最稳）
BLENDER_USER_RESOURCES=tools/blender/userres \
  tools/blender/blender-4.2.9-windows-x64/blender.exe --background --factory-startup \
  --python tools/blender/pmx2vrm.py -- "路径/模型.pmx" "输出/模型.vrm"
```

脚本做的事：MMD Tools 导入（scale 0.08 → 身高约 1.44m）→ 删掉模型自带的 `CP_*` 调色面板网格（不删会满屏色块）→ 把 `mmd_shader` 节点组重建成 Principled + 基色贴图（否则导出是白模）→ 人形骨骼 / 表情 / 弹簧骨自动映射 → 导出 `.vrm` 与 `.glb`。

注意：MMD 模型若本身没有顶点 morph（很多游戏提取模型只有骨骼动画、没有表情形变），转换出来的 VRM 也不会有眨眼和口型——这是素材限制，不是转换失败。

```bash
npm run test:vrm         # 3D 舞台回归：普通 GLB 降级 / 取景 / 动画选择 / 眨眼 / 口型 / dispose
```

## 启动

```bash
# 开发运行
npm start

# 打包安装版 / 便携版
npm run dist        # 产物在 dist/RyzaAssistant-Setup-0.1.0.exe 等

# 迁移 AuraDesk 的 AI 配置与角色数据（只读原数据，不动 AuraDesk）
node scripts/migrate-from-auradesk.js          # 加 --dry 先预览
```

## 与 AuraDesk 的关系

- 代码基础：复制自 AuraDesk v0.3.0 源码（本机完整源码，MIT），品牌与数据目录已完全分离
- 保留全部已验证能力：透明桌面层（壁纸让位、悬停热区穿透）、Spine 2D 骨骼动画（4 版本运行时，含 mesh 皮肤）、3D VRM（three.js + @pixiv/three-vrm）、触摸反应/视线跟踪、气泡对话 + 聊天面板、LLM/记忆/世界书/工具、Fish/OpenAI TTS、ASR、系统托盘
- 新增：`scripts/migrate-from-auradesk.js` 数据迁移；助手核心（`../src/`，CLI 可独立运行）将在第二阶段逐步接入为可选后台核心

## 测试

```bash
npm test                 # 全套（扫描自检 + 冒烟 + 形象包 + 3D 舞台 + 伴侣窗 + CUA）
npm run smoke            # jsdom 冒烟（渲染层回归）
npm run test:assistant   # 助手核心桥接测试（CJS→ESM/角色隔离/记忆/工具循环/持久化）
npm run test:figure      # 形象包：zip 安全 / manifest 校验 / 原子安装 / 装扮解析 / 渲染
npm run test:cua         # 电脑操作：坐标几何 / 工具门禁 / 权限四档 / 图片剥离 / 打包配置
npm run cua:engine       # 电脑操作引擎端到端（只读，不动鼠标键盘）
```

每项功能该怎么点、应该看到什么，全在 [`docs/TESTING.md`](docs/TESTING.md)。

## 已知限制（第一阶段）

- 沙箱/受限环境下 Electron GPU 进程会崩溃（0xC0000005），正常桌面双击运行不受影响
- 角色素材（Spine/VRM 文件）需在设置中导入；迁移脚本会带过已配置的角色
- Live2D Cubism 渲染未实现（评估见下；Spine 与 VRM 链路已可用）
- 后台助手核心（关闭桌宠后继续运行）为第二阶段目标，当前未实现

## 渲染格式评估（第一阶段结论）

| 格式 | 状态 | 说明 |
| --- | --- | --- |
| Spine 2D | ✅ 可用 | @esotericsoftware/spine-webgl + canvas 4.0/4.1/4.2/4.3 四版本运行时，mesh 皮肤、触摸动画已验证（商业运行时授权需注意：Spine 运行时许可要求持有 Spine 编辑器 license） |
| 3D VRM | ✅ 可用 | three.js + @pixiv/three-vrm，依赖已就位 |
| Live2D | ⏳ 未实现 | Cubism SDK 授权需单独申请（发布需遵守 Live2D Proprietary 条款），接入点预留（角色渲染层抽象） |

## 目录

- `src/main/` 主进程（窗口/托盘/伴侣编排/launcher）
- `src/renderer/overlay/` 桌面层 + 桌宠（petStage，spine-webgl）
- `src/main/companion/` AI 管线（LLM/记忆/工具/TTS/ASR/角色）
- `src/main/cua/` 电脑操作（引擎子进程 / 主进程桥 / 坐标几何 / 确认窗）
- `src/assistant/core/tools/cua.js` CUA 十一工具的声明（核心零依赖，执行靠宿主）
- `../src/` 独立助手核心（零依赖 Node，CLI：`npm start` 于上级目录）
- `docs/AURADESK-README-LEGACY.md` 原 AuraDesk 功能说明存档
