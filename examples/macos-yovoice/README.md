# Mac 本地彩排：GLM + yovoice

此示例配合 `codex/macos-yovoice` 分支使用，锁定 Harness 和 `@deepseek-ai/dsh-tools` 为 `0.2.2-rc.1`。对话由 GLM Coding Plan 提供，声音由本地 yovoice / VoxCPM2 生成。配置模板不包含密钥、模型、运行时、会话数据或本机路径。

「直播」主页可保存平台和房间。此彩排配置不连接 B 站；抖音只读互动需要另行准备独立匿名采集器，操作与未知结果处理见 [抖音接入说明](../douyin/README.md)。

## 前置条件

- Apple Silicon Mac、可运行本仓库的 Node.js / pnpm、PATH 中的 FFmpeg 和 ffprobe。
- 已准备好的 yovoice CLI、audio.cpp `v0.9.1` Metal 运行环境和 `voxcpm2-q8` 模型。本仓库不分发这三项；模型权重约 2.96 GB。
- 可用的 GLM Coding Plan 凭据。

已在 Apple M5 / 32 GiB、Node `26.13.0`、pnpm `12.18.0` 上验证当前业务代码。新机器的完整配置流程仍需实际检查，详细范围见 [VALIDATION.md](VALIDATION.md)。

## 声音设置与试听

主人进入 Harness 的「直播」侧栏，打开「设置」中的「声音」。选择后端并填写对应字段：yovoice 选择已安装的 VoxCPM2 q8 或 BF16 模型并描述声音；Mac 输入已安装的系统音色名；豆包选择跟随角色、已有 2.0 音色或自定义 speaker ID，并可调整语速。当前本机只验证过 q8，BF16 必须预先自行安装，本插件不会下载模型。

输入 1–200 个字符的短句后点「试听」；生成完成后使用播放器。试听使用当前草稿但不保存，不开播、不向舞台发送音频。可取消试听；修改草稿、切换后端或关闭设置也会取消并清理旧音频。确认后点「保存声音」，成功提示出现后新合成使用新值；已开始的语音继续使用原值。重新打开或刷新后保存值仍有效。

豆包 2.0 和复刻音色使用已有 `DOUBAO_TTS_API_KEY`；1.0 音色使用 `DOUBAO_TTS_APP_ID` 与 `DOUBAO_TTS_ACCESS_KEY`。可在控制台对应凭据项保存，或由进程环境提供；没有凭据时仍可保存配置，但试听会提示不可用。yovoice 的 `YOVOICE_URL`、`YOVOICE_API_TOKEN` 始终来自进程环境；Mac 需 `say`、`ffmpeg` 和 `ffprobe`。各字段的初始值来自旧设置或环境，保存后各字段以保存值为准；旧 `voice` 空值仍跟随角色默认音色。

试听失败时检查当前后端、模型、音色及其凭据，修改后重试；不会自动切换后端。yovoice 取消后如无法确认任务终态，停止提交后续任务，先检查对应任务和共享服务状态，再协调重启 Harness。不要为恢复试听而停止其他用户的共享任务。

## 天气与公开资料查询

1. 加载包含此功能的插件后，开始一个新的直播会话；已有会话保留创建时的预设版本，不会因插件更新自动获得新 persona。保持原 GLM 模型选择不变。
2. 在「直播」→「设置」→「天气与公开资料」分别勾选需要的能力。两项默认关闭；保存的是开关，密钥不写入普通设置。可在该区域填写已有 `GLM_CODING_PLAN_API_KEY`，也可在没有凭据服务时由 Harness 进程环境提供。凭据服务存在时，空值或读取错误不会回退到环境变量。此凭据与 GLM 模型共用，修改会影响模型。天气也沿用这项启用校验，但其公开来源请求不会发送 GLM 凭据或身份。
3. 在「跟她说话」中询问“北京天气如何”“北京 2026-11-12 天气预报”或“OBS Studio 许可证是什么”。地点和日期应在当前提问中明确。首版接受北京、上海、天津、重庆及其明确区县，其他地区请一次写全省和市或县，如“辽宁省朝阳市”“浙江省杭州市”；单写“朝阳”会先要求补全，不会联网猜测。行政层级格式不代表地点已核实，未支持的地区请补充说明；来源不能确认地点或时间时仍会显示资料不足。公开资料查询应使用当前问题中的文字。
4. 在「查询状态与来源」核对结果和链接。检索时间只是取回资料的时间；来源没有提供更新时间时会明确标注。天气来源未能证明当前观测时显示资料不足，不应把它当成此刻温度。服务失败、空结果和取消分别显示状态；查询服务上次可用不代表后续一定成功。要撤销本次查询尚未播放的回复，请点「停止查询回复」；它也适用于模型已结束生成但音频仍在等待的情况。原会话的「停止生成」只停止正在生成的轮次。
5. 明确刷新旧的独立舞台页，再查看控制台的舞台连接提示。控制台预览静音；“舞台已连接”只说明舞台可以接收新的归属事件，是否听到声音仍需在独立舞台确认。更新插件后无需改变 GLM 或 yovoice，但本阶段没有重启正在使用的共享服务。

天气先用 Nominatim 确认中国行政区域，再用 [NOAA Aviation Weather Center](https://aviationweather.gov/) 区域内站点的最新有效观测；温度只代表所列站点附近，缺站或时间无法确认时显示资料不足。指定日期改用 [MET Norway](https://api.met.no/weatherapi/locationforecast/2.0/documentation) 预报，只列该日期实际覆盖时点和模型更新时间，不代表实况或全天极值。地图数据署名 [OpenStreetMap contributors / ODbL](https://www.openstreetmap.org/copyright)，MET 预报采用 CC BY 4.0。

公共天气数据缓存在 `${DSH_HOME}/dsh-livestream/weather-cache-v1.json`（未设置时为 `~/.dsh/dsh-livestream/`），包含来源及原始时间，不包含参与者身份；地理结果、观测和预报各有独立有效期，同一 MET 地址至少缓存三小时。缓存损坏、不可写或容量不足会产生受控诊断或资料不足；检查 Harness 日志和缓存文件权限，协调恢复，不要删除缓存来绕过来源限频。部署者可设置 `DSH_LIVESTREAM_WEATHER_GEOCODER_URL` 为可信 Nominatim 兼容服务的 HTTPS `/search` 地址；默认使用公共 Nominatim，地址不可含凭据、查询或片段。

页面旅程使用隔离 fixture，模型、搜索和音频均为替身。隔离真实来源增量已取得上海站点观测及指定日期预报；随后正式抖音预设的真实北京天气与公开资料两题均完成工具调用和 GLM 续答。两题实际使用4次模型请求、1次MCP搜索和2次天气HTTP请求，TTS为0；这些结果不证明舞台或观众端播放，当前候选也尚未部署。

### 离线验收入口

在已安装项目开发依赖的 `packages/dsh-livestream` 目录执行：

```sh
node test/live-query/run.mjs
```

默认使用本地协议替身，为每题装载仓库当前的 `dsh-livestream-douyin` 预设，并按顺序执行“北京当前天气”和“OBS Studio许可证”；不会读取真实模型或语音凭据，也不连接真实服务。结果记录预设、允许的工具 schema 及有效提示核对，离线模式还记录协议替身实际收到的核对结果。结果目录中的 `result.json` 包含工具、来源地址和时间、限制、答复及实际计数；每题还在清理会话前写入 `scenario-1.json` / `scenario-2.json`，失败时保留预期和实际工具、固定问题中的公开参数、查询状态、结束种类、受控失败代码和适用的 HTTP 状态。结果分别计数地理解析、当前观测、预报、MCP 搜索、模型和语音请求；缓存命中可没有天气 HTTP 请求。非固定问题文本只标记为已省略，不保存原始请求、响应或认证信息；替身的 `limited` 和 `evidence` 只说明离线链路，不能证明真实资料或声音。临时会话目录会清理，结果目录保留供核对。

真实模式会调用外部服务并消耗额度：脚本要求 `--real`、完整预算参数及进程环境中的 `GLM_CODING_PLAN_API_KEY`。预算中的 `tts:0` 不读取语音凭据或请求语音；原有 `tts:1` 保留一次合成，并要求 `YOVOICE_API_TOKEN`。该模式固定使用 `glm-coding-plan/glm-5.3-flash`、固定公开资料搜索端点、天气公开来源和 `127.0.0.1:3081` 的 yovoice，最多四次模型请求、两次查询工具调用、一段不超过 120 字的语音；270 秒后停止新工作，在总计五分钟内保留最多 30 秒处理本次语音任务。发生网络、协议或预算错误时停止；若任务终态未确认，结果会标记 `unknown`。选择 `tts:0` 时结果标记 `audio: not_requested`；音频文件仅表示已取得合成结果，不表示舞台或观众已播放。真实模式使用独立持久公共天气缓存，临时会话仍会清理；结果中的音频取得不代表舞台播放。正式预设真实两题已在源码输入一致、依赖可解析的隔离环境通过；仍未验证实际舞台或观众端播放。验收入口直接运行源码，执行环境必须具备锁文件依赖（含 Turf）；仅有先前的已构建插件不能替代这些开发依赖。


## 准备独立 Harness 工作区

1. 按仓库根 [README](../../README.md) 的开发安装流程安装依赖并构建插件。插件目录为本仓库的 `packages/dsh-livestream`。
2. 新建独立 Harness 工作区，将这里的 `harness-package.example.json` 复制为 `package.json`，`.env.example` 复制为 `.env`，并保留 `.gitignore` 中的排除规则。
3. 填写 `.env`：`YOVOICE_CLI` 和 `YOVOICE_DATA_DIR` 使用本机绝对路径；`YOVOICE_API_TOKEN` 使用自行生成的随机值；`GLM_CODING_PLAN_API_KEY` 填入自己的凭据。可用 `openssl rand -hex 32` 生成 yovoice token，并以 `chmod 600 .env` 限制文件访问。
4. 在新 Harness 工作区执行 `npm install`，再用 `npm run dsh -- plugin --profile web add link:/绝对路径/dsh-livestream/packages/dsh-livestream` 安装已构建的本地插件。替换命令中的绝对路径。该开发安装保留源码链接，修改并重新构建后需重启 Harness 才会加载新产物。
5. 将 `glm.patch.example.yml` 合并到 `.dsh/profiles/web/cordis.patch.yml`。模板适用于全新隔离的 web profile；已有配置的 `providers` 会整体覆盖，手工合并时保留其他 provider。模型 ID 使用 `glm-5.3-flash`，不要加 `[1m]` 后缀。

## 启动和互动

在独立终端进入上述 Harness 工作区，先执行：

```sh
npm run tts
```

另一个终端进入同一目录，执行：

```sh
npm start
```

默认仅监听本机：yovoice `127.0.0.1:3081`、Harness `127.0.0.1:3080`、舞台 `127.0.0.1:7390`。修改 TTS 监听地址时，同时修改模板启动参数与 `YOVOICE_URL`。已有服务运行时无需重复启动；数据目录被其他 yovoice 实例占用时先核对使用者，不停止共享任务。

Chrome 首次连接使用 Harness 终端打印的完整认证地址。打开侧栏「直播」，将插件的 `distillModel` 设为 `glm-coding-plan/glm-5.3-flash`，并确认新会话选择同一模型。点击「开始彩排」，打开控制台显示的完整本地舞台地址；出现开启声音按钮时点击一次。控制台预览始终静音，声音由独立舞台播放。通过「模拟观众」发弹幕，或通过「跟她说话」发送主持人的话。

本地模式不连接 B 站或 OBS；`show_stats` 可用，天气和公开资料查询需要主人分别启用并配置凭据。回复仍消耗 GLM 额度。yovoice 请求串行处理，字幕按音频时长估算；取消失败且无法确认服务端终态时，会停止提交后续语音任务，先检查服务状态再重启 Harness。

## 后续维护

源码、测试和配置模板在分支中维护；凭证、模型和会话放在独立数据目录。可按版本生成 npm 安装包供其他环境安装。内置大肥鱼素材沿用其独立的 [CC BY-NC-SA 4.0 许可](../../packages/dsh-livestream/assets/characters/dafeiyu/LICENSE.md)，代码许可见仓库根 [LICENSE](../../LICENSE)。
