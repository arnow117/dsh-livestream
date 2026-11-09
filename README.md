<p align="center">
  <img src="docs/hero.jpg" alt="大肥鱼直播计划" width="100%">
</p>

<h1 align="center">dsh-livestream</h1>

<p align="center">
  <b>DeepSeek Harness 的直播插件：让 DSH 里的 agent 在 B 站直播间当主播。</b><br>
  默认角色是「大肥鱼」。她自己看弹幕、谢礼物、点播视频、给观众写私信，用自己的声音说话。
</p>

<p align="center">
  <a href="LICENSE"><img alt="code: MIT" src="https://img.shields.io/badge/code-MIT-3f7cf0"></a>
  <a href="packages/dsh-livestream/assets/characters/dafeiyu/LICENSE.md"><img alt="大肥鱼素材: CC BY-NC-SA 4.0" src="https://img.shields.io/badge/大肥鱼素材-CC%20BY--NC--SA%204.0-e0763c"></a>
  <img alt="DeepSeek Harness 插件" src="https://img.shields.io/badge/DeepSeek%20Harness-插件-283270">
  <img alt="Bilibili 直播" src="https://img.shields.io/badge/Bilibili-直播-fb7299">
</p>

<p align="center">演示视频：<a href="https://www.bilibili.com/video/BV1xpn66GExn/">《大肥鱼你来B站直播嘛！大肥鱼彩排、Claudia被记仇？》</a>（B 站）</p>

---

## 是真的在直播

<p align="center"><img src="docs/live-proof.jpg" alt="左边本机 DSH 里的她，右边 B 站直播间里的她" width="100%"></p>

左边是本机 DSH 控制台里的她，右边是 B 站直播间里观众看到的她：同一个她，B 站那边晚几秒。插件调 B 站开播接口、驱动本机 OBS 推流，弹幕和礼物从 B 站直播间的消息服务实时收进来。

## 她会做什么

<table>
<tr>
<td width="38%" align="center"><img src="docs/expressions.gif" alt="边说话边换表情" width="100%"></td>
<td>

**自己的声音、自己的表情**
豆包语音合成，字幕按发音一个字一个字亮；她在话里写个 `[shocked]`、`[shy]`，念到那里就换表情。换表情时挑姿势最像的那一帧切，不叠影。

**接住直播间里的事**
弹幕、礼物、SC、上舰、进场、关注，插件按轻重缓急一件一件交给她，她自己决定怎么回。人多的时候先回舰长和老粉，冷场了她会自己找话说。

**记得人**
这一场和以前来过的观众、他们说过的话，她都记得；常来的人会被认出来。

</td>
</tr>
</table>

<table>
<tr>
<td width="50%"><img src="docs/video.jpg" alt="在直播间里放 B 站视频" width="100%"></td>
<td width="50%"><img src="docs/ending.jpg" alt="下播谢幕" width="100%"></td>
</tr>
<tr>
<td><b>点播视频</b>：观众想看什么，她自己去 B 站搜、在直播间里放，她说话时视频自动调小声；还能看主页、写私信。每次用工具，舞台终端里都记一行「调用 …」，观众看得到她做了什么。</td>
<td><b>开播和下播</b>：控制台一键开播，下播前她先道别，舞台出谢幕画面（播了多久、几条弹幕、吃了几粒米、谢谢的人）。右上角的饭碗是这场用掉的 token 换算成的米饭。</td>
</tr>
</table>

## 控制台

<p align="center"><img src="docs/console.jpg" alt="DSH 里的直播控制台" width="100%"></p>

在 DSH 侧边栏打开「直播」：看舞台预览、换皮肤、开播下播、跟她说话、模拟观众（不开播也能彩排）。

## 需要

- DeepSeek Harness（网页版）
- OBS Studio 30 以上（开 WebSocket）
- B 站账号的 cookie（开播需要实名认证过的账号）
- 豆包语音（火山引擎）的 API Key / App ID / Access Key

## 安装（开发方式）

```bash
pnpm install
pnpm -C packages/dsh-livestream build
```

把 `packages/dsh-livestream` 链接到 DSH 主目录的插件目录（例如 `$DSH_HOME/profiles/web/node_modules/dsh-livestream`），重启 DSH。

密钥写在 DSH 主目录的 `.env`：

```
BILIBILI_COOKIE=...
DOUBAO_TTS_API_KEY=...
DOUBAO_TTS_APP_ID=...
DOUBAO_TTS_ACCESS_KEY=...
```

然后在 DSH 侧边栏打开「直播」：填房间号，选「本地彩排」或「推流到 B 站」，开播。

## 许可

- **代码**：MIT（见 [`LICENSE`](LICENSE)）。
- **大肥鱼的动画片段**（`packages/dsh-livestream/assets/characters/dafeiyu/`）：CC BY-NC-SA 4.0，是社区作品的衍生作品，署名和来源见那个目录里的 [`LICENSE.md`](packages/dsh-livestream/assets/characters/dafeiyu/LICENSE.md)。只能非商业使用；商业用途请自备角色素材，或向原作者申请许可。
- `docs/` 里的截图来自演示视频的录制，其中 B 站视频的画面做了模糊处理。

## macOS 本地彩排

在启动 Harness 的进程环境中设置 `DSH_LIVESTREAM_LOCAL_REHEARSAL=1` 和 `DSH_LIVESTREAM_TTS_BACKEND=macos`。本地语音调用系统 `say`、PATH 中的 `ffmpeg` 和 `ffprobe`，不需要豆包密钥；默认使用 `Tingting`，可通过 `DSH_LIVESTREAM_MACOS_VOICE` 指定已安装的系统音色。语音转换需要能够访问 macOS 的语音服务；某些沙箱会让 `say` 输出空音频。字幕时间按实际音频时长均分估算，并非逐字强制对齐。文字通过临时文件传递，不经过 shell；取消或超时后清理文件。

彩排模式不连接或登录 B 站，不推流、不探测 OBS、不轮询账号消息，也不向直播会话暴露 B 站及游戏工具；`show_stats` 仍可使用。它不恢复之前未结束的直播。不要在彩排期间开启推流或连接直播间。正式直播不设置 `DSH_LIVESTREAM_LOCAL_REHEARSAL`，仍使用原有行为；不设置语音后端时仍使用豆包。

启动前，在插件设置中把 `distillModel` 设为现有的 `provider/model`，例如本机 GLM 路由 `glm-coding-plan/glm-5.3-flash`，并在 Harness 会话中选择同一模型。这样需要提炼记忆时也会使用该路由。控制台中打开直播并用模拟观众发送消息，舞台地址可在本机浏览器打开；结束时点击下播。不开 B 站、无需 OBS 或 B 站 Cookie。模拟事件和主播回复仍会调用所选模型并消耗其额度。

也可将 `DSH_LIVESTREAM_TTS_BACKEND` 设为 `yovoice`，并在 Harness 进程环境中提供 `YOVOICE_URL` 和 `YOVOICE_API_TOKEN`。此后端使用 yovoice 的任务接口，默认选择 `voxcpm2-q8` 和中文女声描述；可分别通过 `DSH_LIVESTREAM_YOVOICE_MODEL`、`DSH_LIVESTREAM_YOVOICE_VOICE` 覆盖。它将任务串行提交，取消时请求服务端取消并等待终态，音频转成 MP3 后按时长估算字幕；不会自动切换到其他语音服务。如果无法确认被取消任务的终态，插件会停止提交后续 yovoice 任务；先检查该任务和共享服务状态，再重启 Harness。模型冷启动可能较慢，服务闲置后会再次冷启动。

可复用的 Harness、GLM 和 yovoice 配置模板及启动说明见 [Mac 本地语音示例](examples/macos-yovoice/README.md)，已完成的检查及实测范围见 [验证记录](examples/macos-yovoice/VALIDATION.md)。
