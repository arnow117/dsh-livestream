# 项目上下文：dsh-livestream

## 项目概览与事实边界

| 项目 | 已确认的事实 |
|---|---|
| 定位与使用者 | DeepSeek Harness 的直播插件；主人通过侧栏「直播」管理会话、平台/房间、角色和舞台。保留 B 站直播能力，新增指定抖音房间的只读输入与本地舞台输出；助手正文经现有 TTS 生成音频与字幕。 |
| 仓库范围 | 拥有直播插件、控制台、舞台、事件适配器、角色素材、测试、操作工具和配置示例；不拥有 Harness/DyHub 核心、用户 Chrome/profile、GLM/TTS 服务、模型权重和共享运行数据，也不负责停止这些共享资源。 |
| 运行形态 | Node ESM 宿主插件、Harness 动态 Web client、独立本机 HTTP/SSE 舞台、外部 yovoice HTTP 服务；抖音输入使用独立进程运行的 loopback DyHub HTTP/WS bridge。 |
| 事实依据 | `package.json`、`packages/dsh-livestream/{package.json,build.mjs,tsconfig.json,cordis.patch.yml}`、`src/`、`test/`、`README.md`、`examples/{macos-yovoice,douyin}/`；下文路径默认相对仓库根目录。 |
| 本次测绘边界 | 只读取源码、配置、文档、工程证据与既有产物；本次刷新未启动或重启服务、浏览器、模型，也未重跑测试或构建。命令入口依据实际实现及工程上下文的执行记录，正式验收证据仍归对应 Feature。 |

## 仓库结构与入口

| 区域 | 入口与主要路径 | 职责 |
|---|---|---|
| 包与宿主 | `packages/dsh-livestream/src/dsh/index.ts`、`src/dsh/runtime.ts` | 根插件、`/api/dsh-livestream/*`、设置持久化、共享运行时、TTS 路由和预合成。 |
| Agent | `packages/dsh-livestream/src/dsh/agent.ts`、`cordis.patch.yml` | 注册直播预设和工具、监听助手正文、绑定模型服务；凭据 resolver 属于根插件生命周期。 |
| 控制台 | `packages/dsh-livestream/src/console/client.tsx`、`console.tsx` | 侧栏「直播」面板、设置 Drawer、`TtsSettingsPanel` 声音草稿/保存/私有试听、DSH credentials 输入、状态轮询与事件流。 |
| 共享声音配置 | `packages/dsh-livestream/src/shared/ttsSettings.ts` | 浏览器与宿主共用 TTS 类型、环境兼容默认值和增量字段验证；不依赖 Node API。 |
| 原生房间控制 | `packages/dsh-livestream/src/shared/roomControl.ts`、`src/dsh/douyinRoomControl.ts`、`douyinControlJournal.ts` | 主页平台/房间原子保存、owner 房间控制、revision、匿名采集前提与插件自有操作日志；固定 loopback HTTP/WS，未知结果保守保护。 |
| 直播目标与操作归属 | `packages/dsh-livestream/src/shared/liveTarget.ts`、`biliOperations.ts` | 抖音字符串房间输入验证；进程内 B 站/OBS 操作计数、目标 epoch 与 AsyncLocalStorage lease，用于切平台和拒绝过期异步结果。`biliOperations.ts` 是 Node 端模块。 |
| 舞台 | `packages/dsh-livestream/src/stage/`、`stage/index.html`、`stage/stage.css` | 协议、状态、音频播放、字幕、布局、组件与特效。 |
| 身体与集成 | `packages/dsh-livestream/src/body/` | `LiveShow`、舞台服务器、豆包/macOS/yovoice TTS、B 站、OBS、ASR 和媒体。 |
| 核心逻辑 | `packages/dsh-livestream/src/core/` | 弹幕/注意力、文本处理、平台协议、记忆、安全规则与成本。 |
| 抖音 source/归一化 | `packages/dsh-livestream/src/core/platforms/douyin/douyinSource.ts`、`platforms/index.ts`、`core/live.ts` | `DouyinLiveSource` 对接指定房间 WS 与有界状态 GET；在 source 中校验/归一化 envelope、ID、统计和礼物增量，输出共同 LiveEvent/LiveRoomStats。 |
| 测试 | `packages/dsh-livestream/test/*.{test.ts,test.tsx}`、`vitest.config.ts` | Vitest 覆盖声音、平台 source/路由/UI/状态、操作 lease 和既有业务。配置排除 `test/e2e/**`、`test/e2e-douyin/**`、`.e2e/**`；大部分本机 fixture 忽略，带来源的合成 DyHub wire fixture 有明确例外，作为测试资产纳入版本控制。 |
| Web 测试 | `packages/dsh-livestream/{e2e.config.ts,e2e-douyin.config.ts,e2e-voice-regression.config.ts}`、`test/{e2e,e2e-douyin}/` | tester-army/e2e 精确 locator 旅程；真实 React/宿主路由及抖音真实 source，外部服务替身、动态端口、fixture 自有 Stage stub 和隔离数据/构建。 |
| 变更覆盖检查 | `packages/dsh-livestream/test/coverage-diff.mjs` | 显式 Git 功能基线必需；可选 coverage report path，不传时兼容原 FEAT-001 报告路径。 |
| 静态资源 | `packages/dsh-livestream/assets/` | 角色、模板、字体与 ASR worker。角色素材有单独许可。 |
| 构建 | `packages/dsh-livestream/build.mjs`、根 `pnpm-workspace.yaml` | 输出宿主 `lib/index.js`/`agent.js`、控制台 `lib/client.js`、舞台 `lib/stage.js`。 |
| 工具与实验 | `tools/`、`spikes/mcp-transport/` | 现有直播运维/观测脚本、Windows 部署与 MCP transport 实验；不是本地 Mac 的默认启动流程。 |
| 文档与配置示例 | 根 `README.md`、`examples/macos-yovoice/`、`examples/douyin/README.md` | 根 README 为全局 usage 导航；`LIVE-DOUYIN-CONNECT` / `LIVE-DOUYIN-DISCONNECT` 链接采集器部署、显式连接、断开/停止与恢复边界，声音/Mac 导航保留。 |

## 技术栈

| 领域 | 技术与选择依据 |
|---|---|
| 语言与运行时 | TypeScript `6.0.3`，严格类型检查、`noEmit`、ES2023；包为 ESM。构建面向 Node 22；本机只读版本检查为 Node `26.13.0`。 |
| 包管理 | 根声明 `pnpm@12.11.2`；本机实际 `12.18.0`。本机命令使用 `npm_config_manage_package_manager_versions=false` 避免自动管理包管理器版本。 |
| 宿主兼容性 | peer 与 devDependency 的 `@deepseek-ai/dsh-tools` 均为 `0.2.2-rc.1`；示例 Harness 同版本。 |
| UI | React/React DOM `18.3.1`，现有 `dl-*` CSS 与原生表单控件；未发现 Tailwind、shadcn 或 `components.json`。控制台 React 由宿主提供，舞台自行打包 React。 |
| 构建与测试 | esbuild `0.28.2` 同时构建宿主、动态控制台和舞台；Vitest 与 `@vitest/coverage-v8` 均为 `3.2.4`、jsdom `26.1.0`。包脚本含 `build`、`check`、`test`、`test:coverage`、`test:e2e`；无独立 lint 脚本。 |
| Web E2E | 项目 devDependencies 固定 `e2e 0.23.0`、`@e2e-dev/web 0.15.5`；包内配置、fixture 和测试通过项目模块解析运行，不依赖父仓库共享 CLI 的绝对路径。 |
| 存储 | `${DSH_HOME}/dsh-livestream/settings.json`；无 `DSH_HOME` 时用 `~/.dsh/dsh-livestream`。运行时还持有直播状态、包资源与内存预合成缓存。凭据使用 Harness credentials，环境变量为 fallback。 |
| TTS | 豆包 HTTP 流式响应接口；macOS `/usr/bin/say`；yovoice `/v1/jobs/:id` 和 `/v1/audio/:id`。本地音频由 FFmpeg 转 MP3，ffprobe 获取时长。 |
| 外部系统 | Harness、GLM、B 站、OBS、豆包、yovoice，以及独立 DyHub browser collector。抖音模式不使用 B 站账号/OBS/长期观众记忆，GLM 与 TTS 选择沿已有部署配置。DyHub 固定版本与外部许可说明见 `examples/douyin/README.md`，插件不复制签名实现。 |

## 入口与配置

| 用途 | 路径或入口 | 已确认行为 |
|---|---|---|
| 宿主启动 | `examples/macos-yovoice/harness-package.example.json` 的 `npm start` | 独立 Harness 工作区用 `.env`、`DSH_HOME=$PWD/.dsh`、`127.0.0.1:3080` 启动 DSH web；示例禁用 telemetry、不开浏览器。 |
| yovoice 启动 | 同一示例的 `npm run tts` | 调用外部 `YOVOICE_CLI serve`，监听 `127.0.0.1:3081`，使用外部 `YOVOICE_DATA_DIR`。本阶段未执行。 |
| 控制台 API | `src/dsh/index.ts` 的 `apply()` | 通过 `ctx.connection.fetch.register` 注册路由，身份校验依赖 Harness connection；插件未实现独立登录。主要入口为 GET `state`、POST `settings`、`tts/preview`、`onair`、`offair`、`owner`、`simulate`，以及 GET `events`，均在 `/api/dsh-livestream/` 下。 |
| 设置 | `runtime.ts` 的 `Settings`、`loadSettings()`、`updateSettings()` | `settings.tts` 包含 backend、yovoice 模型/描述、Mac 音色、豆包 speaker/rate；保存字段优先旧 env 默认。旧 `settings.voice` 保留豆包 alias，空串在每次合成时跟随角色。保存同目录独占临时 JSON 后 rename，再发布内存。 |
| 平台与房间 | `settings.livePlatform`、`settings.douyinRoomId`、`shared/liveTarget.ts` | 平台默认 `bilibili`，旧数字 `roomId` 保留。抖音房间为 1–64 位 ASCII 数字字符串或完整 `https://live.douyin.com/<digits>`，不接受短链/query/hash/任意 URL，不转换成 Number；房间/用户/事件 ID 保留字符串语义。 |
| 抖音部署地址 | `DSH_LIVESTREAM_DOUYIN_BRIDGE_URL`、`normalizeDouyinBridgeUrl()` | 默认 `http://127.0.0.1:8757`，由 DSH 启动者管理；只接受 HTTP 数字 loopback `127.0.0.1` / `[::1]` 和合法端口，拒绝 userinfo/query/hash/非根 path/远端与重定向。页面不编辑 bridge 地址或 Cookie，部署参数见抖音指南。 |
| 抖音订阅与停止 | `DouyinRoomControl`、`DouyinLiveSource`、GET `room-control`、POST `connect/disconnect/collector/stop` | 主页同页显式连接/重试、只读状态及确认后停止已保存房间；断开订阅仍不停止采集。socket-open/初始化 ack 不代表 live；终态不自动重订阅。支持独立匿名目录，拒绝含认证账号或无法确认的账号集合；不管理全局进程。外部 mutation 前持久 journal，未确认结果锁定目标，重启/uptime 不单独解除保护。 |
| 目标切换与旧操作 | `shared/biliOperations.ts`、`index.ts`、`body/show.ts` | 舞台活动、已有订阅、Bili/OBS 在途操作或清理未完成时，平台/房间变更返回 409；目标 epoch 和 lease 检查拒绝旧结果继续产生副作用。断开清理旧 Hub/attention/控制台/舞台临时目标上下文，保留历史、声音与已存 B 站设置。 |
| 平台预设与权限 | `cordis.patch.yml`、`console.tsx`、`agent.ts` | 独立 `dsh-livestream-douyin` 预设只说明只读抖音输入、本地输出和 `show_stats`；旧 `dsh-livestream` B 站及游戏预设保留。Console 按平台选择预设；B 站工具注册、执行及异步结果检查当前平台，抖音不登录、不发言、不推流、不自动续订或恢复采集。 |
| TTS 选择与缓存 | `runtime.ts` 的 `speechSnapshot()`、`speech()`、`prepareSpeech()` | 每次合成使用完整声音快照；超时和成本语义使用有效 `settings.tts.backend`。prepared key 含配置/实际 speaker/文字，声音或角色设置保存后清除未消费缓存，已取走的合成不在该 Map 中。 |
| 私有试听 | `index.ts` 的 POST `tts/preview`、`runtime.ts` 的 `previewSpeech()` | 输入 `text` 和可选 `tts` 草稿，文本 1–200 Unicode 字符；不保存草稿，直接返回 `audio/mpeg`/`no-store`。请求信号与 90 秒超时传播至同一 provider 管道，不经过 `show.say/guestSay`、舞台或会话。 |
| yovoice 参数 | `src/shared/ttsSettings.ts`、`src/body/yovoiceTts.ts` | 已保存模型/描述逐请求传入；旧 env 提供初始默认。支持 VoxCPM2 q8/bf16 的 design 参数，默认 q8；URL/token 仍只来自 `YOVOICE_URL`/`YOVOICE_API_TOKEN`。模块级客户端、串行队列和 blocked 状态始终共用。 |
| Mac 音色 | `src/body/macosTts.ts` | 有效 `tts.macosVoice` 逐请求传入；旧 `DSH_LIVESTREAM_MACOS_VOICE` 或 `Tingting` 提供默认。`say` 经临时文件读取正文，子进程参数不经过 shell。 |
| 豆包配置 | `src/body/tts.ts`、`voices.ts`、`runtime.ts` 的 `ttsAuth()` | 有效 `tts.doubaoVoice`/角色默认与 `tts.doubaoRate` 逐请求使用；2.0/复刻音色使用 API Key，1.0 使用 APP ID/Access Key。credentials 名称为 `DOUBAO_TTS_API_KEY`、`DOUBAO_TTS_APP_ID`、`DOUBAO_TTS_ACCESS_KEY`。 |
| 凭据与 UI | `index.ts` 根 effect、`console.tsx` 的 `SecretField`、`client.tsx` 的 `bindCredentials()` | 根插件按调用时动态读取 DSH credentials，缺服务时保留 env 兼容，不依赖 Agent 开播。控制台复用 `remote.credentials.describe/set`，按音色展示新版 API Key 或旧版 APP ID/Access Key，仅回显配置状态。 |
| 舞台 | `src/body/server.ts`、`src/stage/store.ts` | 默认 `127.0.0.1:7390`；所有舞台请求检查 query token。SSE `hello.build` 暴露舞台构建标识。控制台预览使用 `preview=1`，静音且不作为播放回执方。 |
| 本地彩排 | `DSH_LIVESTREAM_LOCAL_REHEARSAL=1` | 与平台、TTS provider 为不同维度；该开关隔离 B 站/OBS，不代表抖音输入一定是模拟数据。抖音无论此开关如何都只提供 `show_stats` 和本地输出，显式连接仍可能启动独立采集器。 |

## 常用命令

以下入口保留 `.sdlc-v1/context/FEAT-001.engineering.md` 实际记录中验证过的通用调用；当前源码和测试变化后的结果由对应 Feature 工程证据管理，不能沿用旧通过结论。本次只读核对、不重跑。除 `e2e` 在 `packages/dsh-livestream/` 执行外，其余从仓库根执行；`unit` 与 `coverage` 可由同一次完整 coverage 运行提供证据。

```yaml
commands:
  unit: "npm_config_manage_package_manager_versions=false pnpm --filter dsh-livestream exec vitest run --coverage"
  coverage: "npm_config_manage_package_manager_versions=false pnpm --filter dsh-livestream exec vitest run --coverage"
  e2e: "npm_config_manage_package_manager_versions=false pnpm exec e2e run --config e2e.config.ts --workers 1 --retries 0 --trace on --reporter list,junit --max-duration 600000"
  typecheck: "npm_config_manage_package_manager_versions=false pnpm --filter dsh-livestream check"
  lint: none
  build: "npm_config_manage_package_manager_versions=false pnpm --filter dsh-livestream build"
```

包内脚本 `test` 为 `vitest run`，`test:coverage` 为 `vitest run --coverage`，`test:e2e` 为 `e2e run --config e2e.config.ts`；上表保留证据中的完整实际命令，含报告/时限参数。历史 Mac/yovoice focused 回归仍可从 `examples/macos-yovoice/VALIDATION.md` 获取。

覆盖率检查器调用形状为 `node packages/dsh-livestream/test/coverage-diff.mjs <baseline-commit> [coverage-report]`（参数形状从源码确认，本次未执行）；基线必须由调用方按功能工程上下文显式确定。可选 report path 相对仓库根解析，缺省仍为 `packages/dsh-livestream/coverage/feat-001/coverage-final.json`；不同功能的报告不能混用。脚本结合基线 diff 和未跟踪新源码，按 instrumented 行/分支检查 80%/70%；缺参/无效 commit/无可计量改动或缺报告非零退出。旧实际调用样例与功能基线见 FEAT-001 工程证据，FEAT-002 的独立报告与固定基线见其工程契约；不以当前 HEAD 或旧报告代替。

`e2e-douyin.config.ts` 是平台/房间草稿与抖音旅程入口，`e2e-voice-regression.config.ts` 复用声音测试并写独立回归产物。调用时将上表 E2E 的 `--config` 切换为对应文件；实际结果索引当前 Feature 工程上下文。FEAT-002 是历史接入记录，FEAT-003 是统一主页与房间控制记录，二者的实现/验证范围分开。

构建会删除并重建 `packages/dsh-livestream/lib/`；共享运行环境仍使用该产物时，构建/独立验证使用隔离复制目录，不能删除在用 lib。E2E launcher 自行将测试 bundle 写入忽略的 `.e2e/`，不使用生产 lib。宿主缓存控制台模块，实际加载新插件产物由主 Agent 协调 Harness；声音保存本身即时生效，不得自动重启共享彩排/采集服务。

## 验证资源与准备

| 项目 | 已确认准备与缺口 |
|---|---|
| correctness | `vitest.config.ts` 使用 V8，包含 text/JSON/LCOV；在声音和 DOM 测试之外，纳入平台 source/Hub/attention/Show、输入、预设、房间状态、Bili/OBS lease/清理及 stage 变更。配置排除两套 E2E 与生成目录；报告目录可由实际运行参数覆盖。Mac 音频测试依赖系统语音/FFmpeg/ffprobe，沙箱限制仍适用。 |
| e2e:OpenAPI | 无 OpenAPI schema；声音和抖音路由测试调用真实 handler/适配器，Web fixture HTTP 转发真实注册路由，抖音 fixture 自建真实 WS bridge 模拟固定 wire 协议。fixture 不启动完整 Harness，不等同生产 owner 鉴权；共享环境的写入/订阅副作用不能用 synthetic 结果授权。 |
| e2e:Web 工具 | 项目已固定 CLI/Web engine，`test:e2e` 与配置存在；Web engine 依赖 `playwright-core 1.64.1`。父仓库共享 CLI 可作辅助，但仓库运行脚本不写入其绝对路径。SDLC 正式 Validate 必须运行纳入被测提交的测试。 |
| Web 浏览器 | 配置 Chromium，目标 desktop 1440×900、narrow 375×812；工程运行记录为 `HeadlessChrome/156.0.8078.4`。使用现有匹配浏览器缓存，不为验证自动下载；后续运行仍记录实际浏览器/构建版本。 |
| Web 测试资产 | `test/e2e/voice-settings.e2e.ts` 保留声音旅程；`test/e2e-douyin/{atomic-target,douyin}.e2e.ts` 覆盖原子保存、连接/live 输入、同页重试/停止、共享影响确认、unknown 保护和切换限制。真实 Console/CSS、routes/controller/source/存储保留，push/TTS 与外部服务采用替身；配置/fixture/测试随实现提交，存在资产不等于本轮通过。 |
| 合成协议 fixture | `test/fixtures/dyhub-normalized-defaults.json` 记录固定 DyHub commit、真实 normalizer 编译方法、protobuf 合成输入及 frames，用于缺失总数变 0、全零礼物/组 ID 等边界。`.gitignore` 明确放行该文件，不提交真实用户抓包或本机数据；不再将整个 fixtures 目录视为均被忽略。 |
| 核心验证能力 | 已有确定性 API/持久化/请求参数、stage 零事件、错误恢复、取消、键盘与宽度断言及截图。provider 替身音频不能证明真实音频可解码、听感或生产播放；主 Agent 的真实浏览器/yovoice 有界检查单独记录，截图不代替业务断言。 |
| 模型、身份与预算 | E2E 仅精确 locator，无 `agent.*`、模型 provider 或真实凭据，模型调用预算 0；fixture 注入测试身份/环境。业务 GLM 模型由部署配置维持，不因 TTS 改变。不得将真实 token 或认证 URL 写入产物。 |
| 环境与资源隔离 | 两套 E2E 均用 `127.0.0.1:0`、runner `{port}`/app.command、临时 DSH_HOME；新桥接也使用专属 ephemeral WS/HTTP 端口。新旧 fixture 都将 stage URL 指向自身 `/__stage` stub，测试拦截 `127.0.0.1/localhost` 的 3080/3081/7390/8757 并断言零访问，避免 iframe 静默访问共享 Stage。fixture 只清理自有资源，不能操作用户 Chrome、真实 profile、GLM/TTS、共享 Harness/Stage/DyHub。 |
| 产物 | `coverage/feat-001/` 为旧兼容默认，当前功能用 `coverage/feat-003-build/` / `feat-003-validate/`。当前 Web 输出 `.e2e/feat-003/`、`.e2e/feat-003-voice/`；旧 Feature 报告保留在各自编号目录。保存 report/JUnit/trace/截图/fixture.log，launcher bundle 位于 `.e2e/feat-003-build/`、`.e2e/feat-003-voice-build/`；旧失败证据归档 `.e2e/archive/`。包内 `.e2e/`、`coverage/` 忽略，原始报告不入 Git/state。 |
| 缓存与独立验证 | 配置显式 `cache.mode: read-only`、`strict: true`、workers=1、retries=0；每测试 120 秒，动作/断言各 5 秒，实际命令另限整次 10 分钟。严格缓存不保证零模型调用，零调用来自无 Agent 步骤/模型配置；正式 Validate 独立运行已提交测试，不能以实现者证据或浏览器探索替代。 |
| CI | 未发现 `.github/` 或仓库内 CI 配置；目前为本机命令验证。 |
| 准备边界 | 本次 onboard 未执行业务检查；实际命令/退出结果、测试数、覆盖率数值、候选版本与阶段只保留在 Feature 工程证据，project.md 仅索引稳定入口。 |

## 变更面映射

角色与 modes 使用 `role-routing.md` 中现有取值。音频设置涉及控制台、API、持久化和播放；实际变更须合并对应检查，不能因后端改动而遗漏 Web 旅程。测试文件还应按被测区域补齐适用 E2E。

```yaml
surfaces:
  - name: host-runtime-api
    globs:
      - packages/dsh-livestream/src/dsh/index.ts
      - packages/dsh-livestream/src/dsh/runtime.ts
    roles: [server-dev, architect, security, qa]
    modes: [correctness, "e2e:OpenAPI", "e2e:Web"]
  - name: agent-and-core
    globs:
      - packages/dsh-livestream/src/dsh/agent.ts
      - packages/dsh-livestream/src/core/**
      - packages/dsh-livestream/cordis.patch.yml
    roles: [server-dev, architect, qa]
    modes: [correctness, eval-bench]
  - name: body-integrations
    globs:
      - packages/dsh-livestream/src/body/**
    roles: [server-dev, architect, security, qa]
    modes: [correctness, "e2e:OpenAPI", "e2e:Web"]
  - name: console
    globs:
      - packages/dsh-livestream/src/console/**
    roles: [client-dev, design, security, qa]
    modes: [correctness, "e2e:Web"]
  - name: shared-contracts
    globs:
      - packages/dsh-livestream/src/shared/**
    roles: [client-dev, server-dev, architect, security, qa]
    modes: [correctness, "e2e:OpenAPI", "e2e:Web"]
  - name: platform-input-and-operations
    globs:
      - packages/dsh-livestream/src/core/platforms/**
      - packages/dsh-livestream/src/shared/liveTarget.ts
      - packages/dsh-livestream/src/shared/biliOperations.ts
    roles: [server-dev, architect, security, qa]
    modes: [correctness, "e2e:OpenAPI", "e2e:Web"]
  - name: stage-and-assets
    globs:
      - packages/dsh-livestream/src/stage/**
      - packages/dsh-livestream/stage/**
      - packages/dsh-livestream/assets/**
    roles: [client-dev, design, qa]
    modes: [correctness, "e2e:Web"]
  - name: tests
    globs:
      - packages/dsh-livestream/test/**
      - packages/dsh-livestream/vitest.config.ts
    roles: [qa]
    modes: [correctness]
  - name: web-e2e
    globs:
      - packages/dsh-livestream/test/e2e/**
      - packages/dsh-livestream/test/e2e-douyin/**
      - packages/dsh-livestream/e2e.config.ts
      - packages/dsh-livestream/e2e-douyin.config.ts
      - packages/dsh-livestream/e2e-voice-regression.config.ts
    roles: [qa, client-dev, server-dev, security]
    modes: [correctness, "e2e:OpenAPI", "e2e:Web"]
  - name: operations-and-spike
    globs:
      - tools/**
      - spikes/mcp-transport/**
    roles: [server-dev, security, qa]
    modes: [correctness, "e2e:OpenAPI"]
  - name: engineering-config-and-docs
    globs:
      - package.json
      - pnpm-lock.yaml
      - pnpm-workspace.yaml
      - .gitignore
      - .gitattributes
      - packages/dsh-livestream/package.json
      - packages/dsh-livestream/tsconfig.json
      - packages/dsh-livestream/build.mjs
      - README.md
      - LICENSE
      - docs/**
      - examples/**
      - .sdlc-v1/**
    roles: [ai-readiness, qa]
    modes: [correctness]
```

未归类主要代码目录：none。`assets/asr/whisper_worker.py` 属于 stage-and-assets 的现有资源路径；若实际修改其语音识别逻辑，按服务端/外部进程行为补 `server-dev`、`security` 和相应 correctness 检查。

## 工程约定与约束

| 范畴 | 约定与依据 |
|---|---|
| 宿主共享状态 | `build.mjs` 对 index/agent 使用共同 chunks，保证同进程共享 `runtime.ts` 实例；不能分开打包成不同运行时状态。 |
| 依赖和 UI 复用 | 现有 React 18、自有 Drawer、`dl-*` CSS、`SecretField` 与 DSH credentials 为可复用入口；当前无 Tailwind，用户的 React/Tailwind shadcn 默认规则不构成新引入依赖的要求。 |
| 可读性与检查 | 保留正常缩进、语句和 JSX 分行。现有 TypeScript `check` 与 build 为稳定入口；无已确认 formatter/lint 命令。 |
| 错误与日志 | API 使用 `{ok:false,error}`，控制台有 `useBusy()` 错误反馈；宿主日志经 hooks 或带插件前缀输出。新错误不应回显凭据或认证 URL。 |
| 机密与数据 | 普通设置与 credentials 分开；不读取、复制或提交真实 `.env`、认证地址、session、模型权重、本机路径中的数据或试听音频。示例只保留变量名。 |
| 共享环境 | 不停止、重启、替换编排方指定的 Harness/yovoice/Stage/DyHub，不复用用户 Chrome 私有 profile；不运行 Windows 运维脚本、不启动共享数据目录的竞争实例。新插件加载由主 Agent 协调；测试构建/fixture 使用隔离目录与专属资源。 |
| 代码边界 | `../upstream` 仅只读参考；DyHub、Chrome、GLM/TTS 及真实运行数据为外部依赖，插件不修改它们。DyHub 仅独立 browser 模式，固定来源/部署说明在 `examples/douyin/README.md`，不导入签名实现/启用 lightweight。保留原生豆包整合边界，不扩展到 Harness STT。 |
| 项目指令 | 继承 `/Users/mac/hansen_agent_team/AGENTS.md`、`soul.md`、`user.md`；目标仓库和源码范围无更近的 `AGENTS.md`。代码实现遵循 Terra worker 路由；测绘文档由本阶段写者维护。当前运行时模型元数据不可见，不猜测实际模型。 |
| 生命周期与 Git | `.sdlc-v1/state.json` 由主 Agent 管理；本阶段只写 `project.md`，不创建需求/Feature/Task，不 commit/push，不改分支/index。后续操作按既有授权与阶段协议执行。 |

## 已知风险与未确认事实

| 项目 | 当前源码事实与验证含义 |
|---|---|
| 热更新与客户端复用 | 生效设置在 `settings.tts`，合成捕获快照并逐请求传参；yovoice 仍复用唯一客户端。连接 URL/token 继续为启动配置，不能把更换普通音色扩展为随意重建客户端/改目标地址。 |
| 预合成与在途语音 | prepared 身份已包含全部 TTS 配置和实际 speaker；声音/角色更新清除未消费缓存，已消费项不再位于 Map。后续修改须保留这一清理边界，避免中断正在使用的语音或复用旧声音。 |
| 单队列与取消 | yovoice 客户端串行提交，取消后等待服务端终态；无法确认终态会置 `blocked` 并拒绝后续任务。不能为改音色或试听随意创建独立客户端，绕开队列或丢弃未知任务状态。 |
| 试听与直播隔离 | 私有 preview 已直接返回音频，控制台负责请求标识、取消和 ObjectURL 清理；`LiveShow` 普通说话/`guestSay()` 仍会广播，不能替代试听。嵌入舞台预览仍静音，与私有播放器是不同入口。 |
| 保存与兼容 | 同目录临时 JSON + rename 成功后才更新内存，保留旧 voice alias 和未知字段；旧 env 是未保存字段的初始来源。以后增字段仍需保持这一优先级和角色默认空串，不将 env 覆盖已保存值。 |
| Provider 参数不同 | 豆包 speaker ID、yovoice 自然语言描述和 Mac 已安装系统音色不是同一参数。现有 `settings.voice` 不能无条件当自然语言描述使用；旧豆包双凭据模式仍由适配器支持。 |
| 首条时延与超时 | yovoice 存在冷启动，服务空闲后可能卸载模型；当前每任务有超时、轮询、取消和 MP3 转码。试听 loading/取消和直播排队需要验证，不能由历史单样本延迟推断稳定性能。 |
| 真实服务覆盖 | 隔离测试覆盖适配器/路由/表单，不能证明真实音频解码/听感、完整 Harness owner 鉴权、B 站开播或 OBS 推流；真实云试听缺凭据时保持未测，不调用云服务补数。 |
| 覆盖率与 Web 证据适用性 | diff coverage 必须绑定显式功能基线和同一源码的 V8 报告；零可计量改动不是通过。E2E fixture 的外部 I/O 替身和非 Harness 身份有明确边界；正式 Validate 需使用被测提交的资产独立执行。 |
| 抖音归一化与来源变化 | source 限定平台/目标房间、字符串 ID、帧和字段上限；下游 ts 使用本地接收时间，去重/礼物累计差值缓存有 2 分钟 TTL 与 4000 项限制。未知礼物金额不视为免费，不换算人民币；在线/累计观看/点赞只有正安全整数视为已知，normalizer 缺失→0 保守视为未知。上游 wire/匿名采集变化须重新核对来源 fixture，不能拿 synthetic 证明真实房间、礼物或长期稳定性。 |
| 采集订阅生命周期 | DyHub WS 首次订阅可能启动采集，因此不能把自动重连当无副作用恢复；source 错误后不自动重新订阅。当前房间 live 状态优先过时 progress.error，终态则清传输/统计并提示人工恢复；断开插件不等于停止采集器，不能发送全局 stop 影响其他使用者。 |
| 跨平台旧结果与临时上下文 | B 站/OBS 的 lease/target epoch、在途计数和清理状态是切平台必要条件；异步结果不能在目标改变后继续使用旧身份/上下文。抖音禁用长期观众记忆和 B 站账号/视频/游戏动作，断开/切换清临时上下文，不删除已有 B 站历史。 |

## 部署与运行环境

```yaml
target: other
config_paths:
  - packages/dsh-livestream/package.json
  - packages/dsh-livestream/cordis.patch.yml
  - packages/dsh-livestream/build.mjs
  - examples/macos-yovoice/harness-package.example.json
  - examples/macos-yovoice/glm.patch.example.yml
  - examples/macos-yovoice/.env.example
  - examples/douyin/README.md
environments:
  dev: "本机独立 Harness 工作区；共享 Harness 3080、Stage 7390、yovoice 3081；抖音 bridge 默认 127.0.0.1:8757，由部署 env 管理"
  staging: none
  canary: none
  full: "本地安装已构建插件，协调 Harness 加载新版本；不包含公网发布或 B 站/OBS 推流授权"
health_check: none
```

操作文档以 `examples/macos-yovoice/README.md` 为 Mac 环境入口。编排方说明本机外部 yovoice 位于兄弟工作区 `workspace/20261108-yovoice-dependency`，数据目录位于 `workspace/20261012-hypit-services/yovoice-data`；目前只有 VoxCPM2 q8 和 audio.cpp `0.9.1` Metal runtime。本阶段未启动或查询这些资源。维护目标继续保留 `codex/macos-yovoice` 分支；源码、测试、模板在分支中维护，运行数据不入库。仓库的 `tools/deploy-server.sh` 是旧 Windows 远程部署路径，不能作为当前 Mac 发布目标或执行授权。

抖音部署导航为 `examples/douyin/README.md`：外部 DyHub v0.3.1 固定 commit `3a79c57d85c59289db3b77211b3ec01fae47d42c`、独立匿名源码/数据目录、browser-only、数字 loopback 监听与已有 Chrome。插件在 owner 显式操作下管理指定房间的采集与订阅，不安装/管理用户浏览器、不登录/导入 Cookie、不启动模型/TTS 或管理全局采集进程。日志位于插件数据目录的 `douyin-control.json`，不删除未确认日志来绕过保护。源码中的默认 bridge env 本身不授权额外操作。

## 仓库上下文来源（Repository context sources）

```yaml
root_guidance: /Users/mac/hansen_agent_team/AGENTS.md
scoped_guidance: []
canonical_documents: []
repo_context:
  status: none
  analyzed_commit: none
```

`.repo-context/manifest.yaml` 和 `.repo-context/evidence.json` 均不存在，长期工程上下文来源为 `none`；本次直接从源码和配置测绘，未调用或创建 repo-context。行为和偏好另由父仓库 `soul.md`、`user.md` 提供。现有 README 和 Mac 示例用于操作与历史证据导航，不冒充经过 repo-context 证据绑定的 canonical 架构文档。

## 长期上下文导航与维护提示

入口、命令、provider 配置、测试资源或部署目标变化时，由后续 onboard brief 定向刷新本文件。普通修复、测试数量、候选版本和阶段进度不写入本文件；验证结果写入对应 Feature 研发上下文。Mac 安装和启动变化应同时核实 `examples/macos-yovoice/README.md`；历史 `VALIDATION.md` 只证明其记载范围。

## AI 可读性

单个业务包按 `dsh/console/stage/body/core/shared` 分层，平台 source、共享输入/操作归属、独立预设、Vitest/DOM/Web E2E 及带来源合成协议 fixture 可发现。生成的 lib、依赖、覆盖率、浏览器产物和真实数据忽略；可提交的来源 fixture 例外不能与本机抓包混淆。长期架构索引与 scoped 指令仍缺失；Feature 工程记录是实际检查/缺口的导航，存在测试或公开样例探针不等于用户目标房间/生产身份已验证。
