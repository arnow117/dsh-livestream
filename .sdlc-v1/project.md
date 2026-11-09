# 项目上下文：dsh-livestream

## 项目概览与事实边界

| 项目 | 已确认的事实 |
|---|---|
| 定位与使用者 | DeepSeek Harness 的直播插件；主播通过 Harness 侧栏「直播」控制台管理会话、直播间、角色和舞台。助手正文经 TTS 生成音频与字幕，在独立舞台播放。 |
| 仓库范围 | 拥有直播插件、控制台、舞台、角色素材、测试、操作工具和本地配置示例；不拥有 Harness 核心、GLM 服务、豆包服务、yovoice CLI、模型权重和本机运行数据。 |
| 运行形态 | Node ESM 宿主插件、Harness 动态 Web client、独立本机 HTTP/SSE 舞台、外部 yovoice HTTP 任务服务。 |
| 事实依据 | `package.json`、`packages/dsh-livestream/{package.json,build.mjs,tsconfig.json,cordis.patch.yml}`、`src/`、`test/`、`README.md`、`examples/macos-yovoice/`；下文路径默认相对仓库根目录。 |
| 本次测绘边界 | 只读取源码、配置、文档、工程证据与既有产物；本次刷新未启动或重启服务、浏览器、模型，也未重跑测试或构建。命令入口依据实际实现及工程上下文的执行记录，正式验收证据仍归对应 Feature。 |

## 仓库结构与入口

| 区域 | 入口与主要路径 | 职责 |
|---|---|---|
| 包与宿主 | `packages/dsh-livestream/src/dsh/index.ts`、`src/dsh/runtime.ts` | 根插件、`/api/dsh-livestream/*`、设置持久化、共享运行时、TTS 路由和预合成。 |
| Agent | `packages/dsh-livestream/src/dsh/agent.ts`、`cordis.patch.yml` | 注册直播预设和工具、监听助手正文、绑定模型服务；凭据 resolver 属于根插件生命周期。 |
| 控制台 | `packages/dsh-livestream/src/console/client.tsx`、`console.tsx` | 侧栏「直播」面板、设置 Drawer、`TtsSettingsPanel` 声音草稿/保存/私有试听、DSH credentials 输入、状态轮询与事件流。 |
| 共享声音配置 | `packages/dsh-livestream/src/shared/ttsSettings.ts` | 浏览器与宿主共用 TTS 类型、环境兼容默认值和增量字段验证；不依赖 Node API。 |
| 舞台 | `packages/dsh-livestream/src/stage/`、`stage/index.html`、`stage/stage.css` | 协议、状态、音频播放、字幕、布局、组件与特效。 |
| 身体与集成 | `packages/dsh-livestream/src/body/` | `LiveShow`、舞台服务器、豆包/macOS/yovoice TTS、B 站、OBS、ASR 和媒体。 |
| 核心逻辑 | `packages/dsh-livestream/src/core/` | 弹幕/注意力、文本处理、平台协议、记忆、安全规则与成本。 |
| 测试 | `packages/dsh-livestream/test/*.{test.ts,test.tsx}`、`vitest.config.ts` | Vitest；音频适配、声音 schema/持久化/路由、jsdom 控制台行为和既有直播业务。配置排除 `test/e2e/**`；`test/fixtures/` 被 Git 忽略。 |
| Web 测试 | `packages/dsh-livestream/e2e.config.ts`、`test/e2e/{voice-settings.e2e.ts,client.tsx,server.ts,start.mjs}` | tester-army/e2e 精确 locator 旅程；真实 React 与宿主路由，外部 provider I/O 替身、动态端口和隔离数据。 |
| 变更覆盖检查 | `packages/dsh-livestream/test/coverage-diff.mjs` | 从 V8 coverage 与相对指定 Git 基线的改动行/分支计算覆盖率；需显式传入功能基线。 |
| 静态资源 | `packages/dsh-livestream/assets/` | 角色、模板、字体与 ASR worker。角色素材有单独许可。 |
| 构建 | `packages/dsh-livestream/build.mjs`、根 `pnpm-workspace.yaml` | 输出宿主 `lib/index.js`/`agent.js`、控制台 `lib/client.js`、舞台 `lib/stage.js`。 |
| 工具与实验 | `tools/`、`spikes/mcp-transport/` | 现有直播运维/观测脚本、Windows 部署与 MCP transport 实验；不是本地 Mac 的默认启动流程。 |
| 文档与配置示例 | `README.md`、`examples/macos-yovoice/{README.md,VALIDATION.md,harness-package.example.json,glm.patch.example.yml,.env.example}` | 安装、Mac 本地彩排、GLM/yovoice 模板与历史验证边界。 |

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
| 外部系统 | GLM Coding Plan 对话/提炼、Harness、B 站、OBS、豆包、yovoice；本地彩排隔离 B 站/OBS。已配置的 GLM 对话模型属于外部配置，不由 TTS 选择决定。 |

## 入口与配置

| 用途 | 路径或入口 | 已确认行为 |
|---|---|---|
| 宿主启动 | `examples/macos-yovoice/harness-package.example.json` 的 `npm start` | 独立 Harness 工作区用 `.env`、`DSH_HOME=$PWD/.dsh`、`127.0.0.1:3080` 启动 DSH web；示例禁用 telemetry、不开浏览器。 |
| yovoice 启动 | 同一示例的 `npm run tts` | 调用外部 `YOVOICE_CLI serve`，监听 `127.0.0.1:3081`，使用外部 `YOVOICE_DATA_DIR`。本阶段未执行。 |
| 控制台 API | `src/dsh/index.ts` 的 `apply()` | 通过 `ctx.connection.fetch.register` 注册路由，身份校验依赖 Harness connection；插件未实现独立登录。主要入口为 GET `state`、POST `settings`、`tts/preview`、`onair`、`offair`、`owner`、`simulate`，以及 GET `events`，均在 `/api/dsh-livestream/` 下。 |
| 设置 | `runtime.ts` 的 `Settings`、`loadSettings()`、`updateSettings()` | `settings.tts` 包含 backend、yovoice 模型/描述、Mac 音色、豆包 speaker/rate；保存字段优先旧 env 默认。旧 `settings.voice` 保留豆包 alias，空串在每次合成时跟随角色。保存同目录独占临时 JSON 后 rename，再发布内存。 |
| TTS 选择与缓存 | `runtime.ts` 的 `speechSnapshot()`、`speech()`、`prepareSpeech()` | 每次合成使用完整声音快照；超时和成本语义使用有效 `settings.tts.backend`。prepared key 含配置/实际 speaker/文字，声音或角色设置保存后清除未消费缓存，已取走的合成不在该 Map 中。 |
| 私有试听 | `index.ts` 的 POST `tts/preview`、`runtime.ts` 的 `previewSpeech()` | 输入 `text` 和可选 `tts` 草稿，文本 1–200 Unicode 字符；不保存草稿，直接返回 `audio/mpeg`/`no-store`。请求信号与 90 秒超时传播至同一 provider 管道，不经过 `show.say/guestSay`、舞台或会话。 |
| yovoice 参数 | `src/shared/ttsSettings.ts`、`src/body/yovoiceTts.ts` | 已保存模型/描述逐请求传入；旧 env 提供初始默认。支持 VoxCPM2 q8/bf16 的 design 参数，默认 q8；URL/token 仍只来自 `YOVOICE_URL`/`YOVOICE_API_TOKEN`。模块级客户端、串行队列和 blocked 状态始终共用。 |
| Mac 音色 | `src/body/macosTts.ts` | 有效 `tts.macosVoice` 逐请求传入；旧 `DSH_LIVESTREAM_MACOS_VOICE` 或 `Tingting` 提供默认。`say` 经临时文件读取正文，子进程参数不经过 shell。 |
| 豆包配置 | `src/body/tts.ts`、`voices.ts`、`runtime.ts` 的 `ttsAuth()` | 有效 `tts.doubaoVoice`/角色默认与 `tts.doubaoRate` 逐请求使用；2.0/复刻音色使用 API Key，1.0 使用 APP ID/Access Key。credentials 名称为 `DOUBAO_TTS_API_KEY`、`DOUBAO_TTS_APP_ID`、`DOUBAO_TTS_ACCESS_KEY`。 |
| 凭据与 UI | `index.ts` 根 effect、`console.tsx` 的 `SecretField`、`client.tsx` 的 `bindCredentials()` | 根插件按调用时动态读取 DSH credentials，缺服务时保留 env 兼容，不依赖 Agent 开播。控制台复用 `remote.credentials.describe/set`，按音色展示新版 API Key 或旧版 APP ID/Access Key，仅回显配置状态。 |
| 舞台 | `src/body/server.ts`、`src/stage/store.ts` | 默认 `127.0.0.1:7390`；所有舞台请求检查 query token。SSE `hello.build` 暴露舞台构建标识。控制台预览使用 `preview=1`，静音且不作为播放回执方。 |
| 本地彩排 | `DSH_LIVESTREAM_LOCAL_REHEARSAL=1` | 与 TTS provider 为两个不同配置维度；本地彩排不连接 B 站/OBS，状态中强制显示不推流，直播工具仅保留 `show_stats`。 |

## 常用命令

以下入口已在 `.sdlc-v1/context/FEAT-001.engineering.md` 的实际验证记录中执行成功，并与当前脚本/配置相符；本次 onboard 仅核对证据，不重跑。除 `e2e` 在 `packages/dsh-livestream/` 执行外，其余从仓库根执行。`unit` 与 `coverage` 复用同一条已执行的完整 Vitest coverage 命令，一次运行可提供两类证据，无需重复执行。

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

生成覆盖率后，变更范围检查须从仓库根运行 `node packages/dsh-livestream/test/coverage-diff.mjs 66034dc55e370fedb2268733b7162d1cb6403b5e`；这是 FEAT-001 已记录的功能基线，后续功能必须显式替换成自己的确定基线。脚本读取 `coverage/feat-001/coverage-final.json`，结合基线 diff 和未跟踪新源码，按 instrumented 行/分支检查 80%/70%。缺少或无法解析为 commit 的基线、没有可计量改动行/分支时退出非零；`test/coverageDiff.test.ts` 提供对应回归。不可在提交后用当前 HEAD 代替功能基线，也不能将旧覆盖率文件用于已变化源码。

构建会删除并重建 `packages/dsh-livestream/lib/`；`node build.mjs --client` 只重建控制台和舞台。宿主缓存控制台模块，加载新插件产物需主 Agent 协调 Harness；声音设置保存本身即时生效。不得自动重启正在使用的共享彩排服务。

## 验证资源与准备

| 项目 | 已确认准备与缺口 |
|---|---|
| correctness | `vitest.config.ts` 使用 V8，报告包含 text/JSON/LCOV；`ttsSettings/ttsPersistence/ttsRoutes/yovoiceRoutes/ttsPanel` 测试覆盖新增声音路径，DOM 行为使用 jsdom；保留既有音频/彩排等测试。Mac 语音测试需要系统语音与 FFmpeg/ffprobe，沙箱空音频限制已在工程证据注明。 |
| e2e:OpenAPI | 无 OpenAPI schema；`ttsRoutes` 与 `yovoiceRoutes` 直接测试真实 handler/适配器，Web fixture 通过 HTTP 转发真实注册路由。fixture 不启动完整 Harness，不等同生产 owner 鉴权证明。共享环境只执行授权内的只读/幂等检查，写入/取消优先使用隔离 fixture。 |
| e2e:Web 工具 | 项目已固定 CLI/Web engine，`test:e2e` 与配置存在；Web engine 依赖 `playwright-core 1.64.1`。父仓库共享 CLI 可作辅助，但仓库运行脚本不写入其绝对路径。SDLC 正式 Validate 必须运行纳入被测提交的测试。 |
| Web 浏览器 | 配置 Chromium，目标 desktop 1440×900、narrow 375×812；工程运行记录为 `HeadlessChrome/156.0.8078.4`。使用现有匹配浏览器缓存，不为验证自动下载；后续运行仍记录实际浏览器/构建版本。 |
| Web 测试资产 | `test/e2e/voice-settings.e2e.ts` 包含草稿试听/保存刷新、后端参数/失败、取消/编辑/关闭三条确定性旅程；fixture client 使用真实 Console/CSS，server 使用真实 settings/preview 路由与文件存储，外部 provider I/O 用替身。测试/配置/fixture 必须随实现提交。 |
| 核心验证能力 | 已有确定性 API/持久化/请求参数、stage 零事件、错误恢复、取消、键盘与宽度断言及截图。provider 替身音频不能证明真实音频可解码、听感或生产播放；主 Agent 的真实浏览器/yovoice 有界检查单独记录，截图不代替业务断言。 |
| 模型、身份与预算 | E2E 仅精确 locator，无 `agent.*`、模型 provider 或真实凭据，模型调用预算 0；fixture 注入测试身份/环境。业务 GLM 模型由部署配置维持，不因 TTS 改变。不得将真实 token 或认证 URL 写入产物。 |
| 环境与资源隔离 | `e2e.config.ts` 用 `127.0.0.1:0`、runner `{port}` 和 app.command；fixture 创建临时 `DSH_HOME`，关闭时清理自身数据/进程。不得使用共享 3080/3081/7390 或真实 DSH_HOME；生产服务实际加载版本另行核实。 |
| 产物 | 包内 `coverage/feat-001/` 存 coverage-final.json/LCOV；`.e2e/feat-001/` 存 report.json、JUnit、trace、截图和 fixture.log；构建 fixture 在 `.e2e/fixture/`。既有报告文件已存在，失败证据可归档 `.e2e/archive/`；`.gitignore` 忽略包内 `.e2e/` 和 `coverage/`。原始报告不入 Git/state。 |
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
  - name: shared-tts-config
    globs:
      - packages/dsh-livestream/src/shared/**
    roles: [client-dev, server-dev, architect, security, qa]
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
      - packages/dsh-livestream/e2e.config.ts
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
| 共享环境 | 不停止、重启、替换编排方指定的现有 Harness/yovoice/舞台；不运行 Windows 运维脚本，不启动第二个占用共享数据目录的 yovoice。 |
| 代码边界 | 旁边 `../upstream` 仅只读参考；本地运行数据和 yovoice 依赖在仓库之外。用户所称原生 TTS 配置指本插件豆包设置；不扩展到 Harness 的语音输入/STT。 |
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
environments:
  dev: "本机独立 Harness 工作区；现有共享彩排服务为 127.0.0.1:3080、舞台 7390、yovoice 3081"
  staging: none
  canary: none
  full: "本地安装已构建插件，协调 Harness 加载新版本；不包含公网发布或 B 站/OBS 推流授权"
health_check: none
```

操作文档以 `examples/macos-yovoice/README.md` 为 Mac 环境入口。编排方说明本机外部 yovoice 位于兄弟工作区 `workspace/20261108-yovoice-dependency`，数据目录位于 `workspace/20261012-hypit-services/yovoice-data`；目前只有 VoxCPM2 q8 和 audio.cpp `0.9.1` Metal runtime。本阶段未启动或查询这些资源。维护目标继续保留 `codex/macos-yovoice` 分支；源码、测试、模板在分支中维护，运行数据不入库。仓库的 `tools/deploy-server.sh` 是旧 Windows 远程部署路径，不能作为当前 Mac 发布目标或执行授权。

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

单个业务包按 `dsh/console/stage/body/core/shared` 分层，构建入口、共享类型、Vitest/DOM/Web E2E 资产可发现；生成的 `lib/`、依赖、覆盖率、浏览器产物和运行数据已忽略。声音配置、预合成和单队列契约已有源码入口；长期架构索引与 scoped 指令仍缺失，真实服务/生产身份的验证边界应从 Feature 证据导航，不能由测试配置存在推断通过。
