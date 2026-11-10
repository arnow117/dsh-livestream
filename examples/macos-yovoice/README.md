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

本地模式不连接 B 站或 OBS，只向会话暴露 `show_stats`。回复仍消耗 GLM 额度。yovoice 请求串行处理，字幕按音频时长估算；取消失败且无法确认服务端终态时，会停止提交后续语音任务，先检查服务状态再重启 Harness。

## 后续维护

源码、测试和配置模板在分支中维护；凭证、模型和会话放在独立数据目录。可按版本生成 npm 安装包供其他环境安装。内置大肥鱼素材沿用其独立的 [CC BY-NC-SA 4.0 许可](../../packages/dsh-livestream/assets/characters/dafeiyu/LICENSE.md)，代码许可见仓库根 [LICENSE](../../LICENSE)。
