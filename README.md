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

<a id="LIVE-DOUYIN-CONNECT"></a>
<a id="LIVE-DOUYIN-DISCONNECT"></a>
<a id="LIVE-ROOM-CONFIG"></a>
<a id="LIVE-DOUYIN-RETRY"></a>
<a id="LIVE-DOUYIN-STOP"></a>
## 配置直播间与抖音只读接入

Harness 主人在「直播」主页选择 B 站或抖音，填写房间并点击「保存」；输入中的草稿不会改变当前目标。抖音需要预先运行独立匿名采集器，连接后可在本地舞台互动；出错时在同页显式重试。断开只停止本插件接收；要停止该房间采集，确认对其他使用者的影响后点击「停止此房间采集」。若结果未确认，页面会保护原目标，不能通过重复连接或停止来猜测结果。具体准备、账号前提、恢复限制与未验证范围见 [抖音接入说明](examples/douyin/README.md)。

## macOS 本地彩排

在启动 Harness 的进程环境中设置 `DSH_LIVESTREAM_LOCAL_REHEARSAL=1` 和 `DSH_LIVESTREAM_TTS_BACKEND=macos`。本地语音调用系统 `say`、PATH 中的 `ffmpeg` 和 `ffprobe`，不需要豆包密钥；默认使用 `Tingting`，可通过 `DSH_LIVESTREAM_MACOS_VOICE` 指定已安装的系统音色。语音转换需要能够访问 macOS 的语音服务；某些沙箱会让 `say` 输出空音频。字幕时间按实际音频时长均分估算，并非逐字强制对齐。文字通过临时文件传递，不经过 shell；取消或超时后清理文件。

彩排模式不连接或登录 B 站，不推流、不探测 OBS、不轮询账号消息，也不向直播会话暴露 B 站及游戏工具；`show_stats` 仍可使用，天气和公开资料工具仅在主人启用且凭据可用时提供。它不恢复之前未结束的直播。抖音只读接入另需独立匿名采集器，见上方说明。正式直播不设置 `DSH_LIVESTREAM_LOCAL_REHEARSAL`，仍使用原有行为；没有保存过后端且不设置语音后端时使用豆包。

启动前，在插件设置中把 `distillModel` 设为现有的 `provider/model`，例如本机 GLM 路由 `glm-coding-plan/glm-5.3-flash`，并在 Harness 会话中选择同一模型。这样需要提炼记忆时也会使用该路由。控制台中打开直播并用模拟观众发送消息，舞台地址可在本机浏览器打开；结束时点击下播。不开 B 站、无需 OBS 或 B 站 Cookie。模拟事件和主播回复仍会调用所选模型并消耗其额度。

也可将 `DSH_LIVESTREAM_TTS_BACKEND` 设为 `yovoice`，并在 Harness 进程环境中提供 `YOVOICE_URL` 和 `YOVOICE_API_TOKEN`。此后端使用 yovoice 的任务接口，默认选择 `voxcpm2-q8` 和中文女声描述；可分别通过 `DSH_LIVESTREAM_YOVOICE_MODEL`、`DSH_LIVESTREAM_YOVOICE_VOICE` 设置尚未保存字段的初始值。它将任务串行提交，取消时请求服务端取消并等待终态，音频转成 MP3 后按时长估算字幕；不会自动切换到其他语音服务。如果无法确认被取消任务的终态，插件会停止提交后续 yovoice 任务；先检查该任务和共享服务状态，再重启 Harness。模型冷启动可能较慢，服务闲置后会再次冷启动。


<a id="LIVE-QUERY-WEATHER"></a>
<a id="LIVE-QUERY-SEARCH"></a>
<a id="LIVE-QUERY-CONTROL"></a>
### 天气与公开资料

主人在「直播」→「设置」中分别启用天气查询和公开资料搜索，两项首次均关闭。查询沿用已有 `GLM_CODING_PLAN_API_KEY` 的启用校验，公开资料搜索使用该凭据；天气来源请求不发送此凭据或身份。它与模型共用，修改也会影响模型。启动新的直播会话后，可在「跟她说话」中询问“北京天气如何”或“OBS Studio 许可证是什么”；有明确日期时可写“北京 2026-11-12 天气预报”。控制台显示查询状态、可核对的来源与检索时间；资料不足、服务失败或来源时间未知时不会当作已确认的天气事实。要撤销本次查询尚未播放的回复，在查询区点击「停止查询回复」；会话的「停止生成」只作用于正在生成的轮次。舞台预览静音，旧舞台需要显式刷新；控制台提示“舞台已连接”仅表示兼容连接，不表示音频已播放。

配置、来源限制、离线验收入口和未验证范围见 [天气与资料查询说明](examples/macos-yovoice/README.md#天气与公开资料查询)。当前天气使用区域内站点观测，指定日期使用预报；站点覆盖不足时返回资料不足。查询会使用联网服务及其额度；已在隔离环境验证正式抖音预设的真实天气/公开搜索工具调用与 GLM 续答，当前候选尚未部署，实际舞台和正式观众端播放仍待验收。

<a id="LIVE-SESSION-CONTEXT"></a>
<a id="LIVE-SKILL-LOAD"></a>
<a id="LIVE-MATERIAL-READ"></a>
### 新直播会话：工作目录、Skill 与资料

主人在「直播」→「设置」→「新直播会话」保存工作目录、显式 Skill 来源和资料根；保存成功后，下一次在控制台新建的直播会话使用该配置，正在播的会话不变。Skill 只从显式来源加载 Markdown（同名异源冲突会被拒绝；每个启用的来源必须实际发现有效声明，空容器不能保存），正文在该会话内冻结，同一轮内同名 Skill 只注入一次完整正文；资料只能按快照内的资料根只读读取，越界、绝对路径和符号链接一律拒绝且零内容返回。活动会话跟随真实开播状态，下播后显示无活动。Skill 不获得脚本执行、依赖安装或文件写入能力。清空、关闭或删除条目也只影响之后的新会话。配置细节、失效恢复与支持范围见 [新直播会话说明](examples/macos-yovoice/README.md#新直播会话)。

<a id="LIVE-ROBOT-LIVE"></a>
<a id="LIVE-ROBOT-RULES"></a>
<a id="LIVE-ROBOT-TASKS"></a>
### 机器人联动（可选）

主人在「直播」→「设置」→「机器人联动」填写机器人绑定 ID 和她直播用的会话 ID，勾选动作白名单，配置关键词规则（弹幕原文逐字相等才触发；同一文字只能配一个动作）和共享冷却秒数后点「保存联动设置」。两条路径——她自己决定和关键词规则——共用同一份配置、同一个目标冷却和机器人的执行账本；保存会撤销旧的联动授权并中止其持有的动作。未安装 dsh-qdroid 插件、联动关闭或机器人离线时，直播照常独立运行，机器人无副作用；机器人的说话、字幕、舞台和课程都不受影响，委派的只有动作，不会让机器人替她说话或跟随。

规则只在绑定会话开播期间消费原始弹幕；一次话题聚合了同一位观众的多条弹幕或多位观众时，她那一轮没有可执行的来源，不会提交动作（面板会显示来源未核实）。弹幕在共享冷却内或机器人忙时被持久跳过，不排队、稍后不补做；「冷却中」和「机器人忙」在面板里是分开的文案。原任务（接纳、跳过、取消受理、unknown）可在面板的「原任务」区查询和取消；取消只是受理，实际停止要等机器人自己的停止证明，unknown 没有「清除并重试」捷径。停用或改绑后，这些历史任务仍可在机器人插件的原路由查询。

联动有严格的生命周期与来源边界：下播收尾、真正下播、直播会话被替换或直播间连接断开时，机器人授权会在同一时刻被撤销，之后回到直播也不会自动复活——需要主人重新保存一次联动设置才有动作资格；被撤销时刻在途的请求不会产生新动作，已有任务与 hold/unknown 记录原样保留。来源方面，只有受控的离线注入（控制台「模拟观众」）带受信进入证明；普通平台回调、重连补发和历史回放不足以证明实时资格，机器人一律拒绝（直播本身照常处理这些事件）。等真实平台的实时证明接入（后续验收）后，真实弹幕才会获得动作资格。

前提与边界：需要同一 Harness 宿主安装 dsh-qdroid 机器人插件（fixture 档案；面板顶部显示装配状态、配置版本和机器人当前能力，白名单的实际可执行集合还要与机器人硬件能力取交集）。真实直播、真实模型与实体机器人效果尚未验收，当前全部为软件 fixture 证据——因此真实平台弹幕目前不会触发机器人动作，这是刻意的 fail-closed 行为；设备凭据和观众弹幕都不授予机器人配置权限，只有 Harness 主人能保存这份设置。

<a id="LIVE-COURSE"></a>
### 既有课件直播

在新直播会话的资料根中授权既有杠杆课件后，主人可在「课程」区加载、播放、暂停、切步、重置和结束。观众可以针对当前题目和实验互动；具体前提、支持范围和恢复方式见 [课件直播说明](examples/macos-yovoice/README.md#既有课件直播)。正式播出请在专用屏幕全屏显示舞台。

<a id="LIVE-VOICE-EDIT"></a>
<a id="LIVE-VOICE-PREVIEW"></a>
<a id="LIVE-VOICE-BACKEND"></a>
### 声音设置与试听

主人在 Harness 侧栏打开「直播」→「设置」→「声音」，选择 yovoice、Mac 本地语音或豆包，编辑对应音色后点「保存声音」。保存成功后新语音立即使用新设置，不需要重启；已在生成或播放的语音继续使用原设置。可先填写短句点「试听」，只在当前浏览器播放，不发到舞台，也不需要开播；修改设置、取消试听或关闭设置会停止并清理试听。

首次缺少保存值时使用启动环境变量作为默认；保存后每个已保存字段优先。yovoice 地址和 token 仍由启动环境提供，Mac 音色须事先在系统安装；豆包密钥通过现有 DSH 凭据服务或环境变量提供，不写入声音设置。保存成功不等于服务可用：试听失败时检查所选模型、服务和对应凭据。具体步骤、范围和取消恢复见 [声音操作说明](examples/macos-yovoice/README.md#声音设置与试听)。

可复用的 Harness、GLM 和 yovoice 配置模板及启动说明见 [Mac 本地语音示例](examples/macos-yovoice/README.md)，已完成的检查及实测范围见 [验证记录](examples/macos-yovoice/VALIDATION.md)。

<a id="LIVE-PUBLIC-CHAT"></a>
### 抖音公屏文字（可选）

Harness 主人在「直播」→「设置」→「公屏文字」保存开关和手动草稿；保存不会连接发送账号或授权。核对固定主体与房间后，依次维护发送材料、核查资格、明确授权，才能提交一条普通文字。Agent 回复、进场欢迎和礼物感谢分别开启，默认均关闭。结果未知时按原请求核对，不能换 ID 重发。部署前提、参数、操作和限制见 [抖音公屏文字说明](examples/douyin/README.md#公屏文字发送)；Mac 启动环境的导航见 [Mac 示例](examples/macos-yovoice/README.md#抖音公屏文字)。
