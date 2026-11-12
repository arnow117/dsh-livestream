# 工程上下文：FEAT-007 既有课件的直播讲解与弹幕互动

## 当前有效方案

### 架构设计

**关联产品上下文**：`.sdlc-v1/context/REQ-008.product.md`，唯一产品规则为其中 NEED/CON/DEC、CRS-01～07、SCN-08～20、SC-001～003 及课件资产 baseline 表。配置部分（CFG-01～05、SCN-01～07）属 [REQ-010/FEAT-006](REQ-010.product.md)，本条只**消费**其已交付能力，不重述、不修改其契约。

**工程上下文**：`.sdlc-v1/context/FEAT-007.engineering.md`。

**分支与基线**：`codex/macos-yovoice`。原 Plan 静态源码基线 `7e72c8c6534e1ccfa00cfb993b54cda17aa76a17`（读取时 HEAD `c858712cab837ad68f20dd5fd2191a7fc0832da1`）保留为历史。2026-11-12 主 Agent 接收 Build 前复核：实际 checkout `/Users/mac/hansen_agent_team/workspace/20261109-deepseek-harness/dsh-livestream`，HEAD `a2c93c68c7fffdcc7c877b89a343d78fa6f87c1c`，与 origin 一致且工作树干净。当前业务/coverage-diff 基线固定为已正式验证、评审和实际安装的 `d70fcf9519069ac5ede0ef04629dd000cc25eb6e`；后续仅 SDLC 提交不改变该基线。原基线到当前业务源的相关变化限 FEAT-006 的9个配置/权限/路径文件；show/stage/server/attention/课件引擎未变。实读 index/runtime/console/shared 的差异与 agent 的当前注册、pre-step、sessionContext 快照接口：安全语义已加强，rootBindings 与 snapshotForSession 的消费形状保持，接线改为 onCreated/verify，不再允许 bind 补装权限。本方案按下述已交付接口消费，不采用历史 WIP 或旧 bind 假设。

**创建日期 / 状态**：2026-11-11 创建；2026-11-12 主 Agent 已接受并完成前置核对，进入 FEAT-007-T001 Build；正式进度仅以 state.json 为准。

**运行约束（用户 2026-11-11 确认）**：正式播出以**专用屏幕全屏显示舞台**的运行模式承载；SCN-20 窗口状态证据范围限定为该模式；[REQ-005](REQ-005.product.md) 失焦修复推迟不阻塞本条（其 P0 未修复，后台帧停更风险仍归 REQ-005，本条不另修渲染）。

**范围澄清（主 Agent 已定）**：本条只承接**课程展示与弹幕互动**（CRS-01～07、SCN-08～20、SC-002 分层①～⑤）；配置能力按 FEAT-006 交付的以下已确定契约消费：`SessionContextConfig` 保存/revision、会话快照（`rootBindings: {rootId, binding}` 目录身份绑定、冻结 Skill 正文）、`load_livestream_skill({name})` 与 `read_livestream_material({rootId,path,startLine?,maxLines?})` 两个 Agent 自身 scope 受限工具、cwd/资料根独立授权、宿主组合检查。本条不新增第二个配置存储，不改变"保存/新会话/快照"语义。


#### 2026-11-12 Build 接收核对与已定接口细化

本节是当前有效方案的一部分，替代上文历史基线的待修前提及下列模糊表述；不新增产品范围。FEAT-006 已在批准源 d70fcf9 完成本地安装及实际路径 smoke（98+45 项），没有同路径实现写者。N2 disabled 健康行属于已保留的非阻塞问题，本 Task 不顺带修复。

- **普通话题声音互斥**：主 Agent 接受决定6的保守解释，课程播放期间任何拟实际开口的话题均先确认暂停旁白；不只依赖问题分类。owner 操作递增控制 revision 并使旧动作/恢复意图失效，内部 speech 暂停与 owner 暂停分开。owner 原已暂停或课程等待作答时不会因答完跳步。
- **播放完成事实**：实读当前 Stage.waitSaid：其 void 结果在超时、取消、无观看者估算到时均 resolve；当前 stage/store 的 /said 也可能来自文本计时或音频失败兜底，不能当真实播放完成。加性提供结构化音频结果（audio ended / error / cancelled / timeout / unknown），旧入口和无课程行为保持兼容。只有对应当前输出归属的显式 audio ended 可作为自动恢复依据；无音频、无 watcher、旧客户端仅 legacy said、合成失败、回执超时/丢失均保持暂停。必须等同一真实 turn 结束且其全部待播分段都确认完成，不能每句结束即恢复导致下一句与旁白重叠。guestSay 等实际说话路径也执行先暂停纪律，失败不推断成功。
- **仅断订阅**：CRS-07/SCN-18 为权威。当前 show.disconnect 会换 outputEpoch，但保留 onAir/currentSession；应撤销断开前观众在途动作/回答并停止新订阅输入，保留本地课程及主人控制。不要以笼统 onOutputChange 或 invalidateSession 回调直接 end 课程；完整结束和仅输出撤销分别处理，重连不重放旧输入。
- **窄课程动作**：采用 active session 内可撤销的 `apply_livestream_course_action` 工具，输入为 CourseActionInput，param 显式携带单位（left/right=m，force=N）；load 必须核对当前 onAir 会话、snapshotForSession 与 sessionTools.verify(bound) 一致；只允许当前题答案/当前实验一项参数/纯问题，不含 next/reset/end/任意代码。工具仅在对应有效课程会话可见，经已有受信任注册身份机制接线，结束/卸载时移除；其他会话及未加载课程时的工具集合不变。同一真实 native turn、选中消息/事件 id、courseEpoch、步骤/attempt/control revision 必须匹配，每轮至多一项；课程正文或模型文本不能直接调用 owner 管理 API。注册/注销的最小适配限 agent.ts，不回退按名称放行或改变 FEAT-006 的失败锁定。
- **资产与打包**：bridge 放在包的 `stage/course-bridge.html`（现有 files.stage 交付），不用未打包的 src HTML 充当运行依赖。外部 lever-lab 只读引用，禁止复制进仓库或修改；加载时建立有界文件/hash清单，运行期资产身份/边界/hash不符即拒绝，重新加载才接受新内容。单源根全套当前28文件/1435956字节，最大文件152092字节，13段mp3；无需无限扫描/无限文件预算。静态额度初值 maxFiles=128、单文件=2MiB、清单总量=16MiB，并验证拒绝边界；每次响应缓冲有界，固定 canonical 根及其上级替换、逐段symlink、末端fd身份与读后复核均需覆盖，在复核通过前不发出正文，不重用模型文本读取预算。
- **写入边界补齐**：除 T001 既有列表，允许上文 show.ts/stage.ts 的必要接线、stage/course-bridge.html 及对应既有测试；若选择编译桥接 TS 而非静态页，保持实际包内可达并说明，不添加新依赖或修改外部资产。check/build 必须在自有副本执行，实际安装 lib 与 lib.previous-92a3019 均为只读边界。
- **执行与证据**：同一个实现者完成三个实施阶段、测试和必要修正；先给可复验最早增量，再继续全部 T001。GLM 五小时额度明确耗尽至19:01:53，按已获授权的 Terra/xhigh 兜底执行，原首个只读路由探针成功；不推测1M已启用。业务模型/合成/天气/搜索/账号/推流预算0，coding-agent调用已获授权；SC-002①②必须实际取证，③④⑤的真实调用与正式观众层保留缺口，不外推为完成。两次不收敛停止纪律及已有失败历史保持，不能为新名字清除旧修正段历史。

资产前置实读（2026-11-12）：`ch01/index.html` SHA-256 `650460359a1202db4f1e4c78d23f24001ea95ae4a8b36d5d565f32be0c5a93df`，`lib/engine.js` `29738bbe5d57029a0477d7ba6ba5486bb8f0872844e396213fb9e4612d673026`，`lib/engine.css` `f2da3a079b3be1d9ccf2301c966ff31e1d75078e2c20c5e252b0697ec954f39e`，`ch01/audio/zh/timings.js` `e014e0aef5dead3e9517aaab9effd5cab02d65f1147186d467509c1f26d462bf`。章节仍13步，lab输入范围/步长与原表一致；这只是只读前置，不是集成播放PASS。decision-context只读召回 Papermorph 卡片仅支持复用既有资产的背景，没有DSH接入或音频恢复结论；具体契约以当前源码/产品为准。

#### 背景

以下事实经本轮只读核实（读法见基线说明；lever-lab 资产在兄弟工作区按实际文件只读读取），均为静态事实、不是运行通过证据。`src/` 均指 `packages/dsh-livestream/src/`。

| # | 事实与源码锚点 | 设计影响 |
|---|---|---|
| 1 | 课件章节 [ch01/index.html](../../../../20261110-papermorph-lever/site/lever-lab/ch01/index.html)：`BEATS` 共 13 步 `intro, parts, distance, arm, balance, q1, distance_cost, kinds, lab, q2, wrap, final1, finish`（203–256 行）。`q1/c-force`：`choice([['20 N'],['60 N'],['180 N']], 0, 解析, 3 条错误解析)`（227 行）；`q2/c-arm`：3 选项、正确 0（249 行）；`final1/p-arm`：`blanks([{parts:['L = ',{box:'2'},' m'],...}])`（254 行），答案由资产 `input.box` 的 `dataset.ans` 判定。`lab()`（125–202 行）：闭包 `state={left:2,right:1,force:20}`；`#left-arm`/`#right-arm` range 0.5–2.3 step 0.1、`#force` range 10–100 step 5；`input` 事件更新；平衡判 `Math.abs(force*left − 60*right) < 0.01`；`#reset-lab` 重置、`#lab-next` 继续（`generation === P.gen` 才生效）。 | 步骤序列、题目判定、参数范围/步长/固定阻力（60 N）全部以资产为准；宿主不得重造判题。调参注入只能用"值恰在网格上"的 input 事件，不能截断/四舍五入。 |
| 2 | [engine.js](../../../../20261110-papermorph-lever/site/lever-lab/lib/engine.js)（2226 行）：`quiz()` 约 957 行——闭包题卡；`api.grade(ok,msg)` 记 `SCORE` 首次尝试；答错显示解析、错误选项 `disabled`、可继续作答；答对 `resolve()` 锁定并出"继续"。播放器 `P` 约 1703 行（`{i,t,end,playing,waiting,done,gen,audio,afail,...}`）；`seek(i, play=P.playing)` 约 1764 行——重建场景并快进前序步骤后 `start(i)`；`setPlaying(v)` 约 1850 行——暂停/播放当前音频剪辑；ask 步骤 `b.ask(done)` 等待读者，`P.waiting=true`，`done()` 受 `P.gen` 保护。音频时钟驱动画面（`P.audio` + rAF）。 | 这些是**页面 realm 内的全局词法绑定与函数**（`P`、`BEATS`、`seek`、`setPlaying` 被章节页脚本直接引用，如 index.html 194/282 行），不是 `window` 属性，也**没有公开 postMessage 控制协议**。同源代码可以进入该 realm 读取/调用；跨源不可。这是控制适配器的核心约束，也是"窄适配器"决定的依据。 |
| 3 | [StageServer](../../packages/dsh-livestream/src/body/server.ts)：每请求校验 query `token`（401），只监听 `127.0.0.1`；路由 `/`（舞台页）、`/stage.js|css`、`/characters|templates/<id>/<file>`（packs）、`/events` SSE、`POST /said`、`POST /media`、`/video` 代理；`file(res, file, within)` 用 normalize+前缀防 `../` 越界；`TYPES` 已含 html/js/css/mp3/png/jpg/webp/woff2。 | 舞台静态服务模式可直接复用：新增课程资产路由沿用 token + containment 骨架；需要补 symlink 拒绝与大小/类型上限。 |
| 4 | 舞台协议（[protocol.ts](../../packages/dsh-livestream/src/stage/protocol.ts)）v1：`say`（含 `owner: StageOutputOwner`）、`invalidate`、`output`（epoch）、`media play/stop`、`game {url} | {window, overlay?}`、`brain/focus/room/reload` 等；owned 事件只发给声明 `OWNED_OUTPUT_PROTOCOL` 的连接。[store.ts](../../packages/dsh-livestream/src/stage/store.ts)：`preview=1` 静音不回执；owned say 按 `outputEpoch` 校验并 revoke；`media/game` 更新状态。[widgets.tsx](../../packages/dsh-livestream/src/stage/widgets.tsx) 502 行：game 挂件把 `{url}` 渲染成 `<iframe class="ls-game-frame" src allow="autoplay">`（无 sandbox 属性）。[layout.ts](../../packages/dsh-livestream/src/stage/layout.ts)：`chat/video/game` 三模式，`game` 缺省借 `video` 布局；default/deepsea/sunset 模板均有 `layouts.game`。 | 舞台已有"网页画面上舞台"的成熟通路（iframe + 布局切换 + 音频授权 `allow="autoplay"`）。课程展示可加性扩展协议与布局，不复用 `game` 状态字段（其宿主语义含 `assertBiliCurrent`/persistLive，见事实 8）。 |
| 5 | 弹幕调度：[attention.ts](../../packages/dsh-livestream/src/core/attention/attention.ts)（评分/热度/优先级、按 uid 去重合并、`maxPendingChats 200`、TTL 衰减）；[show.ts](../../packages/dsh-livestream/src/body/show.ts) `director` 每 200ms（133 行）跑 `direct()`→`take()/takeLive()`→`deliver()`（783 行）→`hooks.push(session, text, midTurn)`；`turnRunning` + `TURN_MAX_MS` 3 分钟（135 行）兜底；`priority` 队列承载 owner 话题。 | CRS-03 的"每次一项动作"挂接在 deliver→push 链路：课程动作作为 topic 交付，一轮最多一项；选择/去重/冷却复用 attention，不建新调度系统。 |
| 6 | 语音：[show.ts](../../packages/dsh-livestream/src/body/show.ts) `say()`（916 行）：`queued/activeSpeech/speaking` 计数、`stage.withMic()` 单麦克风串行、`hooks.synthesize` 最多 2 次尝试、单次 `SYNTH_TIMEOUT_MS` 15s（143 行）、`stage.waitSaid(id, estimateMs, signal)` 回执兜底（无 watchers 按估算、有 watchers +15s）；`guestSay()`（984 行）共用麦克风。[stage.ts](../../packages/dsh-livestream/src/body/stage.ts) `withMic(priority)` 按优先级串行。[runtime.ts](../../packages/dsh-livestream/src/dsh/runtime.ts) `prepareSpeech()`（441 行）预合成缓存 ≤40 句——**当前无人调用它于直播链路**，属既有能力。 | CRS-06 的声音互斥由两个机制合成：课件旁白暂停（适配器 `setPlaying(false)`）+ 舞台 `withMic` 串行。回答走既有 synthesize→say→waitSaid 管道；不新增预合成路径。 |
| 7 | 失效机制：[show.ts](../../packages/dsh-livestream/src/body/show.ts) `invalidateSession(keepSession)`（404 行）递增 `sessionGeneration`（每事件）与 `sessionIdentity`（会话级）、`stage.setOutputEpoch(null|新)`、清零 `queued/speaking`；`disconnect()`（317 行）→`invalidateSession(this.onAir)`+退订 hub；`connectTarget()` 平台/房间变更→`retireSession()`。[biliOperations.ts](../../packages/dsh-livestream/src/shared/biliOperations.ts)：`epoch` 计数 + AsyncLocalStorage lease，`assertCurrent()` 抛"直播目标已变化"。[index.ts](../../packages/dsh-livestream/src/dsh/index.ts) `POST /disconnect`（601–612 行）→`invalidateTarget()+show.disconnect()`；目标切换保护（449–474 行）。FEAT-004 的 [queryTurns.ts](../../packages/dsh-livestream/src/dsh/queryTurns.ts)：`QueryTurn` lease（`agent/turn/sessionId/epoch/signal/valid()`）、`invalidateAll()`、有界 100 条；agent.ts 562–563 行在 `stage.onOutputChange` 时全部失效，355 行在念出前校验 `lease.valid() && outputEpoch === lease.epoch`。 | CRS-07 课程归属失效复用：课程实例 epoch + turn lease（模仿 QueryTurn）+ 挂接既有 `invalidateSession`/`disconnect`/目标切换钩子；念出前的归属校验照搬 agent.ts 既有模式。 |
| 8 | FEAT-006 已提交契约（`7e72c8c`）：`SessionContextSnapshot{schemaVersion,sessionId,revision,platform,presetId,effectiveCwd,cwdBinding,rootBindings:[{rootId,binding:DirectoryBinding}],skills,issues,createdAt}`；`readMaterial()` 拒绝绝对/越界/symlink、UTF-8 文本、`MATERIAL_LIMITS`（每 turn 尝试数、单文件字节、行段 1–200、turn 缓冲/输出字节、2s 超时、单在途）；`loadSkill()` 只回冻结正文；`checkHostComposition()`；`createManagedSession()`/onair 核对；当前 `runtime.sessionTools.onCreated/verify` 回调避免静态引入。**当前状态**：FEAT-006 修正已在 d70fcf9 完成独立 Validate/Sol Review 并安装发布；原 WIP 及待修描述仅为历史。 | 课程会话要求"有效管理会话快照 + 至少一个可用资料根"作为开始课程的前提；课程资产根身份从 `snapshotForSession()` 取，不经 settings 二次推导。该串行前置已满足；本条不得改写 sessionContext* 或限制安装契约。 |
| 9 | 课件资产供给：`lever-lab/` 位于兄弟工作区 `workspace/20261110-papermorph-lever/site/lever-lab/`（$REPO 外，只读引用）；含 `index.html`、`ch01/`（页面+`audio/zh/timings.js`+逐步骤 mp3）、`lib/engine.js|css` 等、`THIRD-PARTY-LICENSE.txt`（Papermorph MIT）。音频文件名 `audio/<lang>/<beat>.mp3?v=<dur>` 由 `beatClip()`（engine.js）拼装。 | 资产不复制、不入库、不修改（OUT-001）。授权根=owner 在 FEAT-006 配置的资料根；课程加载把该根的快照绑定转成舞台静态服务授权（见决定 5）。 |

#### 架构与组件

##### 课程域模型与串行动作引擎（`src/body/course.ts`，新）

- **职责**：课程实例状态机（`idle → loading → ready(paused) → playing ⇄ paused → ended`）、当前步骤（beat 序号/id）、题目尝试与实验参数镜像、`CourseTurn` lease、课程动作的机械校验与下发、CRS-06 暂停/恢复状态机、失效登记。纯状态与决策，无 IO 注入细节（委托给适配器接口）。
- **接口**：`CourseController`（`load/open/close/start/pause/resume/selectStep/reset/end`；`applyAction(candidate)`；`noteFrame(state)` 接收适配器回读；`view()` 供控制台/状态）；`CourseTurn { courseEpoch, outputEpoch, turn, stepSeq, attemptId, signal, valid() }`。失效钩子按原因区分：下播/会话/目标切换作废课程；仅 disconnect 或 outputEpoch 改变撤销旧输出/在途 lease，不自动清除仍有效本地课程（见下述接收核对）。
- **覆盖**：CRS-01、03、04、05、07；SCN-08～10、13、16、17。

##### 课程控制窄适配器（舞台侧 bridge，插件自带静态页）

- **职责**：同源（`127.0.0.1:<stagePort>`）加载课件页为内层 iframe 的 bridge 页（插件包自带，非课件文件）：接受舞台页经 `postMessage`（限定 targetOrigin/来源校验、固定消息 schema）转来的课程命令；在同 realm 内以受控探针调用 `seek(i,play)`/`setPlaying(v)`、对 `#left-arm/#right-arm/#force` 派发 `input` 事件、对题目按钮/填空派发 click/赋值；轮询或事件读取状态（`P.i/P.t/P.playing/P.waiting/P.done/P.gen`、`BEATS[P.i].id`、`#bPlay` aria-pressed、`.lab-result`/`#left-out` 等输出、quiz `.fb` ok/no）并回传。
- **接口**：命令 `{cmd: 'seek'|'play'|'pause'|'param'|'answer'|'read', ...}`；回读 `{i, beatId, playing, waiting, done, lab:{left,right,force,balanced}, quiz:{state, feedbackKind}}`（经舞台页 POST 回宿主，见 StageServer 扩展）。课件页本身零修改。
- **覆盖**：CRS-01、02；SCN-08、09、11、12、16。

##### 课程展示面（舞台协议加性扩展）

- **职责**：`StageEvent` 新增 `{v:1, type:'course', action:'open'|'close', url, title, at}` 与状态类 `course` 事件；[store.ts](../../packages/dsh-livestream/src/stage/store.ts) 增 `course` 状态并转发命令给 bridge iframe；[layout.ts](../../packages/dsh-livestream/src/stage/layout.ts) 增 `course` 展示模式（缺省借 `game`/`video` 布局，模板无 `layouts.course` 时零模板改动即可用）。挂件复用 game 挂件的 iframe 结构（独立 `ls-course-frame`，`allow="autoplay"`）。
- **接口**：见数据模型 `CourseStageEvent`。
- **覆盖**：CRS-01；SCN-08、19；DEC-003（复用媒体舞台展示模式）。

##### 课程静态资产服务（`server.ts` 扩展）

- **职责**：`GET /course/bridge`（插件自带 bridge 页）与 `GET /course/asset/<rootId>/<path...>`：按**当前已加载课程**的快照 root 绑定限定（`CourseController` 持有绑定，server 不读 settings）；同 stage token；路径逐段校验：词法 containment → 目录身份（dev/ino）→ 逐段 lstat 拒绝 symlink → 普通文件 + 类型白名单（html/js/css/mp3/png/jpg/svg/woff2/json）+ 单文件大小上限；只读，`no-store` for html/js。与 `read_livestream_material` 的关系：**同一快照授权、两条独立路径**——工具路径面向模型读文本（256KiB 文本预算、行段语义）；静态路径面向舞台 iframe 送资产（类型/大小按静态服务语义，支持 mp3/png 等二进制）。互不冒充：静态路由不得被模型当作读取通道，工具也不能用于资产服务。
- **覆盖**：CRS-01、02；SCN-08；CFG-04 边界的消费侧一致性。

##### 课程动作语义解释与校验（agent 侧 + 宿主校验）

- **职责**：课程会话的 prompt 注入当前课程状态（步骤/开放题/实验参数/允许范围，插件自有 context source，模仿 FEAT-006 manifest 注入方式，不含绝对路径）；GLM 输出中的**课程动作**（答案/参数/纯提问）由宿主按资产表机械校验（选项索引 0–2、填空数值、`left/right∈[0.5,2.3] 且为 0.1 整数倍`、`force∈[10,100] 且为 5 的倍数`、阻力固定 60 不可改），通过后**每 turn 至多一项**经适配器下发，判定结果回读自资产。非动作弹幕走既有普通回复。
- **覆盖**：CRS-02、03、04；SCN-09～12。

##### CRS-06 声音协作状态机（在 CourseController 内）

- **职责**：课程播放中有任何话题被选中开口（课程问答与普通弹幕回复同理，见决定 6）→ 先 `pause(reason:'speech')` 并记录 `wasPlaying/step/turn`；等适配器确认课件已静音后进入 GLM 回答与 `say()` 管道；回答**实际播放完成**（下述结构化音频 ended 回执，不能以旧 waitSaid 正常返回作为证明）后仅当 `wasPlaying ∧ 同课程轮次/步骤仍有效 ∧ owner 未另行暂停/切步/重置/结束 ∧ 课件状态可确认` 才自动 `resume()`；否则保持暂停并给 owner 明确反馈。合成/播放失败、状态未知、归属失效一律不自动续播。
- **覆盖**：CRS-06；SCN-14、15。

##### 控制台课程控制区（`console.tsx` 局部扩展，可抽 `CoursePanel`）

- **职责**：owner 专属课程区：加载（选资料根 + 课件相对路径）、开始/暂停/继续/选步（步骤下拉或列表，显示资产步骤名）/重置/结束，状态只读区（当前步骤、播放/暂停原因、当前题/尝试、实验参数与平衡、加载中/可用/执行中/已应用/拒绝或过期/播放未知）。复用 `dl-*` CSS、`useBusy`、label/id 键盘可达、`aria-live` 文字状态，375px 不溢出；关键状态不靠颜色。
- **接口**：`POST /api/dsh-livestream/course`（action 分发，见 API 契约）；`GET state` 增加 `course` 视图。
- **覆盖**：CRS-01、05；SCN-08、13、16、19；SC-003。

#### 关键设计决定

##### 决定 1：控制适配器 = 插件自带 bridge 页 + 同源 realm 访问，不改课件

| 候选 | 需求覆盖与扩展方式 | 成本与风险 | 决定 |
|---|---|---|---|
| 给课件增加 postMessage 控制协议 | 语义最干净 | 需修改课件资产，违反只读/不修改边界（OUT-001）；课件属外部工作区资产，无修改授权 | 不采用 |
| 每命令 URL 重载（`?beat=N`） | 零注入 | 破坏音频时钟与实验闭包状态、无法读取实时状态、每步黑屏重载 | 不采用 |
| 复用 `game` 事件与 `showGame()` | 零协议改动 | `showGame` 带 `assertBiliCurrent()`/persistLive 语义，douyin 课程误挂 B 站断言；`gameStatus` 字段语义不符；`{url}` 虽同为 iframe 但宿主生命周期（游戏线）与课程无关 | 不采用 |
| 插件自带 bridge 页同源嵌入 + realm 受控探针 | 资产零修改；控制代码全在插件侧；同源（舞台 origin）使 `contentWindow` realm 访问可行；命令来源限定为舞台页转发 | 探针依赖 engine 内部扩展点（无稳定性承诺）；需加载时核对资产完整性并把资产版本锁定为授权根当时内容 | **采用** |

`P/BEATS/seek/setPlaying` 是页面 realm 全局词法绑定（事实 2），同源 bridge 可经 `contentWindow` 受控求值访问；跨源/观众/技能内容均不可。舞台页与 bridge 之间用固定 schema `postMessage`（origin 校验），bridge 与课件之间是同源 realm 调用。

**覆盖**：CRS-01/02；SCN-08/12/16。

##### 决定 2：课程展示为加性协议扩展，不复用 game 状态

新增 `course` StageEvent 与展示模式；模板缺省借 game/video 布局，既有模板零改动可用。理由见事实 4/8（`game` 宿主语义纠缠 B 站断言与游戏线生命周期）；放弃零协议改动方案以换取语义诚实与平台无关。协议仍为 v1 加性扩展（未知事件被旧舞台页忽略，不破坏兼容）。

**覆盖**：CRS-01；DEC-003；SCN-08。

##### 决定 3：CourseTurn 租约（模仿 QueryTurn + biliOperations epoch）

- `courseEpoch`：一次"开始课程"生成；owner 暂停不换 epoch，切步/重置/结束/会话失效/目标切换换 epoch 或作废。模仿 `biliOperations.epoch` 与 `show.sessionGeneration`。
- `turn`：GLM 真实 turn（照搬 queryTurns 对真实 turn 的坚持，不采信文本）。
- `stepSeq`/`attemptId`：当前步骤序号与本次开放作答尝试；切步/重开/重置/关闭题使旧 `attemptId` 失效（CRS-04：不同观众相同语义消息不是同一事件，重复事件不重复应用——按消息 id 去重，同 attention 既有实践）。
- 念出前校验（agent.ts 既有模式）：`lease.valid() ∧ stage.outputEpoch === lease.outputEpoch`，失败则该句不播不推进。
- 有界：turns Map 上限 100（同 queryTurns），`invalidateAll` 挂接 `stage.onOutputChange` 与课程失效钩子。

**覆盖**：CRS-03/04/05/07；SCN-09/10/13/16/17/18。

##### 决定 4：语义解释归模型，机械校验归宿主，判题归资产

模型只把观众文本解释为候选动作（结构化）；宿主按事实 1 的参数表与选项表做确定性校验（范围/步长/单位/固定参数/开放题匹配），不通过即拒绝并给"允许值"反馈，不截断、不四舍五入、不部分应用；通过后经适配器注入，结果以资产回读为准，模型文本/工具提交不冒充"已应用"（CRS-02/05）。

**覆盖**：CRS-02/04；SCN-09/11/12。

##### 决定 5：课件资产 = 快照授权根 + 舞台静态路由（独立预算语义），不复制不入库

课程根必须是活动会话快照 `rootBindings` 之一；开始课程时重查目录身份（dev/ino），记录关键文件（`index.html`、`engine.js`、`timings.js`、13 个 mp3 存在性）清单与 SHA-256 到课程实例与 show 记录（证据用）。运行期仅伺服加载时清单中的资产，每次提交响应前核对固定 canonical 边界、文件身份与加载时 hash；文件或祖先发生变化则零内容拒绝并要求 owner 重新加载，不热更新（与 FEAT-006"活动会话不重读"一致）。`read_livestream_material` 继续用于模型读文本资料（如课件 README）；静态路由不进入模型上下文。**残余风险如实记录**：授权资产页运行在舞台 origin、与舞台页同级信任（可读自身 URL 中的 stage token），与既有角色/模板包同级；不声称内核级隔离，更强隔离（独立 origin/端口）超出本条边界。

**覆盖**：CRS-01/02；SCN-08；CFG-04 消费一致性；OUT-001。

##### 决定 6：暂停条件与自动恢复状态机

工程解读：CRS-06"选中课程问答时先暂停"落地为**课程播放中任何需要开口的话题（含课程问答与普通弹幕回复）先暂停**——因为舞台与课件是两个独立音频源，`withMic` 串行只保证舞台侧不重叠，无法压低课件旁白；"声音不能重叠"（CRS-06/CON-001）要求凡开口必先静音课件。恢复条件严格按 CRS-06/DEC-004：`wasPlaying ∧ 同轮次/步骤有效 ∧ owner 未另行操作 ∧ 回答播放完成 ∧ 状态可确认`；任一不满足保持暂停等 owner。本来已暂停/等待作答的课程不因回答跳步（恢复即停在原步骤）。此为比字面更保守的实现，请主 Agent 复核（见 unresolved_items）。

**覆盖**：CRS-06；SCN-14/15。

##### 决定 7：owner 控制走既有 owner-only 路由模式；观众零控制面

课程控制仅 `POST /api/dsh-livestream/course`（owner exact-fetch 准入，同 settings/sessions 模式）；Stage token 只证明"舞台页"，不赋予管理权（FEAT-006 既有结论）；bridge/课件无任何宿主管理入口；观众、技能正文、课件内容不能获得控制权（CON-002）。

**覆盖**：CON-002；CRS-01；SCN-16/17；CFG 边界。

#### 数据模型 / 关键实体

以下为拟新增契约，不声称现有源码已有。公共对象仅 JSON，`schemaVersion: 1`。

```typescript
interface CourseLoadRequest { rootId: string; path: string; } // 快照 root 内课件入口（如 site/lever-lab/ch01/index.html）
type CourseActionInput =
  | { kind: 'answer'; target: 'choice'; index: number }        // 0..2，仅当前开放题
  | { kind: 'answer'; target: 'blank'; value: string }         // 填空原文，宿主核数值
  | { kind: 'param'; which: 'left' | 'right' | 'force'; value: number; unit: 'm' | 'N' }
  | { kind: 'question' };                                      // 纯课程提问，不动课件

interface CourseStateView {           // GET state.course / 控制台
  phase: 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended';
  pauseReason: 'owner' | 'speech' | 'none';
  courseEpoch: string | null;
  step: { index: number; id: string; title: string } | null;
  question: { open: boolean; attemptId: string | null; lastResult: 'pending' | 'correct' | 'wrong' | 'expired' | null } | null;
  lab: { left: number; right: number; force: number; balanced: boolean } | null;
  playUnknown: boolean;               // 舞台回执丢失/重连时真实未知（SCN-19）
  lastAction: { kind: string; status: 'applied' | 'rejected' | 'expired' | 'unknown'; detail?: string; at: number } | null;
}
```

| 实体 | 存储/所有权 | 约束 | 覆盖 |
|---|---|---|---|
| 课程实例 | `CourseController` 内存（不持久化）；epoch/步骤/题目尝试/实验镜像/加载时文件 hash 清单 | 宿主重启不恢复课程（CRS-01），仅配置按 CFG-02 恢复 | CRS-01 |
| CourseTurn lease | 内存 Map ≤100，同 queryTurns | 绑定真实 GLM turn + outputEpoch；念出前校验 | CRS-05 |
| 课程状态回读 | bridge → 舞台页 POST 回执 → CourseController | 回执丢失时 `playUnknown=true`，不把发送成功当已播放 | CRS-01/07；SCN-19 |
| 课程动作消息去重 | 按 LiveEvent `id`（attention 既有 id 语义） | 重复事件不重复应用；不同观众相似消息各自独立 | CRS-04 |

#### API / 接口契约

- `POST /api/dsh-livestream/course`（owner-only，`{ok:false,error}` 约定）：`{action:'load', rootId, path}`｜`{action:'start'|'pause'|'resume'|'reset'|'end'}`｜`{action:'step', index}`。校验：load 要求活动管理会话快照 + rootId 在 `rootBindings` 且可用、path 为根内普通文件、重查目录身份；start 要求 ready 且资料/展示能力就绪；step index 有界（回读 `BEATS` 长度）。失败保留当前课程状态并给可修正反馈；不自动开播/开课。
- `GET /api/dsh-livestream/state` 增加 `course: CourseStateView | null`（owner-only/no-store 既有约定不变）。
- `StageServer` 新增：`GET /course/bridge`（插件自带 bridge 页，带 token）；`GET /course/asset/<rootId>/<path...>`（仅当前已加载课程绑定的根；token；containment + symlink 拒绝 + 类型/大小上限）；`POST /course/report?id&token`（bridge 状态回执，模仿 `/said`/`/media`）。所有拒绝零内容、零路径回显（对舞台页可给受控文案）。
- `StageEvent` 新增 `course` 事件（open/close/cmd/state），owned 类事件沿用 epoch 语义。
- Agent 侧：课程状态经插件自有 context source 注入 prompt（每 turn 冻结快照，模仿 queryTurns/FEAT-006 manifest 模式）；模型课程动作为结构化候选，宿主 `applyAction()` 校验后下发；一轮至多一项。

#### 时序与数据流

1. **开始课程**：owner 控制台 → `course/load`（快照 root 重查、hash 清单、bridge/资产路由授权就绪）→ `course` open 事件 → 舞台切 course 布局、bridge 加载课件页（默认第 0 步暂停）→ `course/start` → 适配器 `setPlaying(true)` → 回读确认 → `playing`。
2. **课程问答（CRS-06）**：弹幕入 attention → director 取题 → 课程在播 → 适配器 `pause('speech')` 并确认 → `hooks.push`（prompt 含冻结课程状态）→ GLM 回复 → assistant 正文经 lease 校验后 `say()`（withMic 串行）→ 真实 turn 收束且全部音频 ended 确认 → 恢复条件判定 → `resume()` 或保持暂停并反馈 owner。
3. **调参/作答动作**：GLM 提出候选 → 宿主机械校验 → 每轮至多一项注入（input 事件/click/填空赋值）→ 回读资产结果 → 状态/字幕与事实一致后再继续；拒绝时给允许值，不改状态。
4. **失效（CRS-07）**：owner 结束课程/下播/切会话/平台切换 → 原因明确的生命周期钩子 → `courseEpoch` 作废 + lease `abort`；仅断订阅撤销旧观众动作/回复 lease 并保留本地课程与 owner 控制 → 晚到的回执/回答/音频不再产生新输出；结束课程不等于下播，普通交互保留。
5. **舞台断开/宿主重启**：回执缺失 → `playUnknown=true`，不报告已播放；重启不恢复课程进度（仅 CFG-02 配置恢复），等 owner 显式重新开始。

#### 横切质量设计

- **权限**：课程管理 owner-only（exact fetch/no-store 既有准入）；bridge 命令仅接受舞台页转发且 schema/origin 固定；模型/技能/课件文本不可触达控制路由；公共输出（字幕/台词/终端）不含宿主绝对路径、token、stack（沿用 FEAT-006 脱敏点）。
- **诚实状态**：加载中/可用/执行中/已应用/拒绝或过期/播放未知分立；发送成功≠已播放；模型完成≠已念出；合成失败保持暂停。
- **资源**：不新增模型/TTS 调用路径（复用既有 turn/synthesize 预算：`TURN_MAX_MS` 3min、合成 2×15s）；不自动开播/重连/重放；后台帧停更风险归 REQ-005（全屏运行模式承载正式播出）。
- **可访问性/布局**：控制区延续键盘/焦点/`aria-live`/窄屏约束；关键状态文字可读。
- **可信边界声明**：授权课件页与舞台页同 origin 同信任级（与角色/模板包同级）；不声称恶意资产零风险，授权根之外内容零可达。

#### 风险与取舍

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| engine 内部扩展点无稳定性承诺（`P/seek/setPlaying` 为内部实现） | 资产更新破坏适配器 | 课程加载时记录文件 hash 清单（版本锁定语义）；bridge 探针失败显式 `playUnknown`/加载失败，不谎报；资产更新需 owner 重新加载核对 |
| iframe 自动播放策略（课件音频需手势/授权） | 课程开始无声 | 复用 game iframe `allow="autoplay"` + 舞台页既有声音解锁实践；④层验证专门核对首次开始出声；失败显式反馈等 owner 处理 |
| 同 origin 资产可读 stage token | 授权资产与舞台页同级信任 | 记录残余风险（决定 5）；token 仅舞台语义无管理权（FEAT-006 结论）；不扩大到声称内核隔离 |
| 话题分类误判（课程动作 vs 普通弹幕） | 该调参的没调/普通聊天误触发 | 机械校验兜底：不明确/越界一律拒绝并给允许值；一轮至多一项；判题以资产为准 |
| 声音协作时序（暂停未确认即开口） | 声音重叠 | 状态机等待适配器"已暂停"回执后才进入 GLM/`say`；回执超时按未暂停处理（不开口，反馈 owner） |
| FEAT-006 修正段未落地 | 依赖契约漂移、共享路径冲突 | 本 Feature Build 前置 = FEAT-006 修正段合并；落地前不开始实现（串行集成）；不触碰其 WIP |

#### 需求覆盖

| 规则 / 验收 | 设计 / 契约 | Task | 计划验证 |
|---|---|---|---|
| CRS-01、SCN-08/16/19 | 域模型状态机、控制台控制区、course 展示面、`playUnknown` | FEAT-007-T001 | 单测状态机；e2e 控制旅程；断开/重启分支 |
| CRS-02、SCN-09/11/12 | 动作机械校验表、资产判题、bridge 注入 | FEAT-007-T001 | 有效/无效/越界/固定参数/歧义参数逐类断言 |
| CRS-03、SCN-11/12/13 | CourseTurn 每轮一项、attention 串行复用 | FEAT-007-T001 | 多观众并发 + owner 优先交错测试 |
| CRS-04、SCN-09/10/13/16 | attemptId 失效、消息 id 去重、错误可续答 | FEAT-007-T001 | 旧归属迟到结果反例；重开/切步/重置失效 |
| CRS-05、SCN-10/13～17 | lease 念出前校验、outputEpoch 联动 | FEAT-007-T001 | 状态变更中途答案抑制；不污染当前状态 |
| CRS-06、SCN-14/15 | 声音协作状态机、恢复条件判定 | FEAT-007-T001 | 暂停→答→条件恢复；禁止恢复分支逐条 |
| CRS-07、SCN-17/18/19/20 | 失效钩子挂接、断订阅语义、全屏模式边界 | FEAT-007-T001 | 晚到结果零新输出；仅断订阅保留本地课程 |
| SC-002 分层①～⑤ | 验证策略（见实施计划） | FEAT-007-T001 + 独立 Validate | 逐层证据；前层不抵扣后层 |
| SC-003、控制台可操作 | 控制区与状态视图 | FEAT-007-T001 | 原 console 全程控制旅程 |

### 实施计划

**关联产品上下文**：REQ-008（CRS/SCN/SC 部分）；**关联设计**：上文架构设计；**已确认需求**：REQ-008 的 CRS-01～07、SCN-08～20、SC-001～003、CON-001～04、OUT-001～03、DEC-001～004；配置部分按 REQ-010 已交付契约消费。**创建日期**：2026-11-11；**状态**：Draft。

#### 背景

本条在既有直播宿主上加一个有界课程域：舞台展示一个 iframe 课件、owner 用原控制台控制、观众经既有弹幕调度有限参与、语音与生命周期复用既有机制。外部依赖两项：FEAT-006 修正段落地（消费契约 + 共享路径串行）、课件资产在 owner 授权资料根内真实可用。

#### 目标 / 非目标

**目标**：完成上文需求覆盖表——同一控制台与舞台加载并控制既有杠杆课件；观众作答/提问/调参经串行调度有界生效；CRS-06 声音协作成立；失效与断线语义正确；按 SC-002 分层留存①～⑤证据（⑤在获授权的真实播出窗口、限定全屏模式）。

**非目标**：不制作/修改/复制课件，不做课程后台/新课库；不修 REQ-005 失焦渲染；不替换 GLM/yovoice；不新增平台权限/公网托管；不给观众或课件内容任何控制权；不做通用课件框架（多课程支持仅留数据形状，不建注册/发现机制）。

#### 技术栈

TypeScript 严格模式、Node 22 目标、React 18 + `dl-*` CSS、Cordis/DSH `0.2.2-rc.1`、esbuild/Vitest 3.2.4/jsdom、tester-army/e2e `0.23.0` / `@e2e-dev/web `0.15.5`。无新依赖、无插件安装、无外部下载（bridge 页为插件自带静态资产）。

#### 实施层决定

##### 决定 1：单一实现 Task，串行集成，先等 FEAT-006 修正段落地

**背景**：课程域横跨 body/stage/console/shared/agent 与静态资产服务，全部消费同一快照契约与舞台协议；拆"后端/前端/测试"无法独立满足 SC-002，且与 FEAT-006 修正段共享 `sessionContext*/agent/index/console` 路径。

**实际候选**：1) 单 Task 串行集成（同一实现者完成实现+测试+修正）；2) 按层拆多 Task 并行。

**选择**：候选 1。

**理由**：写入边界集中、契约共享；FEAT-006 修正段在进行中，串行避免同路径双写者。

**覆盖**：CRS-01～07；设计：全部组件。**决定层级**：计划层实施决定。

**前置**（非本 Feature Task）：主 Agent 确认 FEAT-006 修正段已合并、重新验证/评审完成；本条 Build 绑定的业务 HEAD 由主 Agent 在开始时登记。

#### 风险 / 取舍

| 风险 | 可能性 | 影响 | 缓解措施 |
|---|---|---|---|
| bridge 探针对 engine 内部点依赖 | 中 | 中 | hash 版本锁定 + 加载核对 + 失败显式未知；不静默降级 |
| e2e 无法用真实课件全覆盖（音频/时序） | 高 | 中 | 合成替身课件测协议与状态机；真实资产加载/出声归②④层独立验证 |
| coverage 基线选择不当（复用 fd48d0a） | 中 | 中 | 基线=Build 开始时业务 HEAD（fd48d0a 会把 FEAT-006 已交付变更重复计量）；由主 Agent 登记 |
| 真实 GLM/TTS/正式观众预算 | 高 | 低 | 本 Plan 不消耗；③④⑤层缺口如实标注，归属 Validate/Ship 由主 Agent 安排 |

#### 实施阶段

1. **最小旅程（T001 内）**：course 域模型 + bridge 页 + 舞台 course 展示面 + 静态资产路由 + 控制台最小控制区（加载/开始/暂停/继续/选步/结束/重置 + 状态回读）。最早可检验结果：隔离副本中，owner 在原控制台加载授权根内的课件并开始，舞台全屏可见课件逐步播放、可暂停/选步，状态区与实际画面一致；此时即可向主 Agent 报告版本/入口/实际范围。**覆盖**：CRS-01、SCN-08/16 基础；设计：域模型/bridge/展示面/静态服务。
2. **同 Task 完整边界**：课程动作引擎（校验表/注入/判题回读）、CourseTurn 失效挂接、CRS-06 声音协作状态机、控制台动作反馈与拒绝反馈、`playUnknown`/断开/重启分支、路径脱敏与权限回归。**覆盖**：CRS-02～07、SCN-09～15/17～19；设计：动作引擎/lease/声音状态机。
3. **同 Task 交付与检查**：单测/集成、e2e 资产选择与旅程、vitest include 更新、coverage-diff、check/build、usage 文档锚点（根 README + `examples/macos-yovoice/README.md`：课程加载前提=管理会话快照与资料根、控制区用法、全屏播出约束、失效行为）。**覆盖**：SC-001/002①②、SC-003；设计：验证策略。

#### 验证策略（仅计划，本轮不执行）

所有命令在**另外的隔离复制目录**执行（沿用 FEAT-006 既有方法）：保留有效 Git 基线、候选业务代码与固定依赖；副本使用自有 DSH_HOME、动态 loopback 端口，拦截 3080/3081/7390/8757 与非 fixture 外网；不触碰共享服务、在用 `lib/`、真实直播与 FEAT-006 修正 worker 的产物。只清理自有子进程与临时输入，保留失败证据。

**SC-002 分层证据计划**：

- **①替身层**：合成输入/替身课件验证配置消费、动作顺序、权限与晚到分支（单测 + e2e）；断言越权/失效后新输出为 0。
- **②真实宿主会话层**：真实管理会话（FEAT-006 路径）+ 真实 lever-lab 资产（owner 授权根，只读）：加载、hash 清单、静态路由伺服、舞台显示、owner 控制、受限读取边界与静态路由边界各自取证。
- **③真实 GLM 层**：真实 GLM 对课程状态作答、候选动作结构化、拒绝路径（预算/授权缺口如实标注，由 Validate 时主 Agent 安排；本 Plan 不消耗模型）。
- **④真实音频/舞台层**：既有课件旁白（资产 mp3）出声、yovoice 回答音频与舞台画面/字幕对齐（首次开始自动播放策略专门核对）。
- **⑤正式观众层**：同场正式播出链路 + 独立真实观众可见可听；**仅限"专用屏幕全屏显示舞台"运行模式**（SCN-20 证据范围）；由主 Agent 在 Ship/验收授权窗口安排，本地结果不抵扣。

**单元与契约测试**（新增 `test/course*.test.ts(.tsx)`）：课程状态机全迁移；CourseTurn 失效矩阵（owner 暂停/切步/重置/结束/断订阅/会话失效/outputEpoch 变更 × 在途动作/在途回答）；动作校验表逐类（有效、越界、步长不符、固定参数、非实验步骤、歧义、重复事件、多观众单应用）；CRS-06 恢复条件真值表（wasPlaying×owner 操作×播放完成×状态未知）；bridge 协议替身（postMessage schema/origin 校验/命令丢弃）；静态路由 containment/symlink/类型/大小拒绝（沿用 FEAT-006 路径纪律，独立 helper 不复用 256KiB 文本读取器）；权限回归（非 owner 403、无 token 401、课件/技能文本不可触达控制）。用 barrier 控制并发交错，不靠 sleep。

**E2E 资产选择**：新增 `e2e-course.config.ts` 与 `test/e2e-course/`（start.mjs/server.ts/client.tsx/course.e2e.ts），复用 query fixture 的真实 React/路由/StageServer 模式与 launcher 隔离。课件用**合成替身页**（按事实 2 的扩展面构造：BEATS 数组、`seek/setPlaying` 全局、quiz/lab 形状的 DOM），保证确定性协议/控制旅程断言；真实 lever-lab 资产不做 e2e 常驻 fixture（二进制 mp3/时序不确定性），其加载与出声归②④层。全程确定性 locator、无 `agent.*`、模型/TTS/平台调用预算 0；Chromium 1440×900 与 375×812、workers=1、retries=0、每测试 120s、整次 10 分钟、`cache:{mode:'read-only',strict:true}`。产物写该副本 `.e2e/feat-007-build/`（Validate 用 `feat-007-validate/`），不复用 FEAT-004/006 路径。

**coverage/check/build**：`vitest.config.ts` coverage include 增加全部新生产源码/面板；新 Web 测试目录加入 test.exclude。**coverage-diff 基线为主 Agent 登记的 `d70fcf9519069ac5ede0ef04629dd000cc25eb6e`**（含 FEAT-006 修正合并）：`coverage-diff.mjs` 按 `git diff <baseline> -- packages/dsh-livestream/src` 计量，若沿用 `fd48d0a` 会把 FEAT-006 已交付变更重复计入本条（降低通过参考性、混淆归属）；已由主 Agent 在本轮登记；不把后续文档提交当作新的业务基线。显式报告路径 `packages/dsh-livestream/coverage/feat-007-build/coverage-final.json`（Validate 用 `feat-007-validate/`）。check/build 沿用 project.md 既有命令形状。

**usage**：根 README 全局导航增加 `LIVE-COURSE` 锚点；`examples/macos-yovoice/README.md` 补课程前提（FEAT-006 会话快照与资料根）、加载/控制/结束操作、全屏播出运行约束、失效与恢复边界。不写个人绝对路径或 secret。

#### 需求覆盖

实施阶段与 Task 验收引用上文唯一需求覆盖表。项目 surface 涉及 body-integrations、stage-and-assets、agent-and-core、console、shared-contracts（如课程视图 DTO 进 shared）、tests/web-e2e、engineering-config-and-docs；验证组合为 correctness、e2e:Web；真实 GLM/TTS/观众层的 eval-bench/现场证据由独立 Validate 与 Ship 安排。

### 工程任务

**输入**：上文设计/实施计划与 REQ-008；**前置**：主 Agent 接受本文；**FEAT-006 修正段落地并完成重新验证/评审**（外部前置，非本 Feature Task）；主 Agent 登记 Build 业务 HEAD 与 coverage 基线；确认相同源码路径无其他实现写者。测试随同一实现 Task 完成，不拆给另一实现者。

#### FEAT-007-T001 [US2/US3] 交付既有课件直播讲解与弹幕互动完整旅程

- **依赖**：无本 Feature 内 Task 依赖；外部前置见上（FEAT-006 修正段合并）。选择单 Task 的理由见实施层决定 1。
- **写入范围**：包内路径均相对 `packages/dsh-livestream/`：新增 `src/body/course.ts`（或 `src/body/course/` 有界拆分）、`stage/course-bridge.html`（插件自带 bridge 页，由现有 package files.stage 一并交付）、必要的 `src/stage/{protocol.ts,store.ts,widgets.tsx,layout.ts,stage.css}` 加性扩展、`src/body/server.ts` 课程路由、`src/body/show.ts` 的课程/话题/语音生命周期接线、`src/body/stage.ts` 的课程保留事件与加性播放结果回执、`src/dsh/index.ts` 课程 owner 路由与失效挂接、`src/dsh/runtime.ts` 最小接线、`src/dsh/agent.ts` 课程 lease 注入/念出前校验（沿用既有模式）、必要的 `src/shared/course.ts` DTO、`src/console/console.tsx` 及可抽出的 `src/console/CoursePanel.tsx`；`test/course*.test.{ts,tsx}`、受影响既有测试、`test/e2e-course/**`、`e2e-course.config.ts`、`vitest.config.ts`；仓库根 `README.md`、`examples/macos-yovoice/README.md`。不写：`sessionContext*` 契约文件（消费不改）、upstream、其他 Feature 工程候选、共享服务、真实课件资产、已存在测试产物。`.gitignore` 仅在既有忽略不能覆盖新产物路径时有界补充。
- **完成条件**：需求覆盖表全部实现；隔离副本中①②层证据具备（含真实 lever-lab 加载与舞台显示、owner 全控制、受限/静态两条授权路径的允许与拒绝）；CRS-02～07 的失败/失效分支逐条有测试；CRS-06 恢复条件真值表全过；越权/失效后新状态污染与新增输出为 0；无课程时既有行为/工具/声音/平台隔离回归通过；已提交 e2e、usage、coverage-diff（主 Agent 登记的基线）、check/build 可重复且通过；③④⑤层缺口如实标注不抵扣。任务完成不代替独立 Validate/Review。
- **验证方式**：上文验证策略，绑定实际候选 SHA、源码 diff、版本、环境、身份、资产 hash 清单与产物；失败先定位，遵循仓库连续两次不收敛停止规则。
- **覆盖**：REQ-008 全部 CRS/SCN(08～20)/SC；**计划**：三个实施阶段，由同一实现者持续完成。

#### 依赖与执行顺序

唯一 Task，无并行实现单元；外部串行前置为 FEAT-006 修正段落地。独立 Validate/Review 按生命周期另行执行，不创建额外实现 Task 抵扣必要检查。③④⑤分层证据中超出本 Task 环境/预算的部分（真实 GLM、真实音频对齐、正式观众全屏播出）由主 Agent 在 Validate/Ship 安排，本文不预支授权。

#### 发布准备与回滚

只准备安装包与说明；实际替换/重载共享插件由主 Agent 在 Ship 授权内协调，本 Plan/Build 不操作共享服务与在用 `lib/`。回滚使用先前已评审业务版本及其构建产物；课程能力无持久化新格式（课程状态不落盘），回滚无数据迁移；owner 配置的资料根与 FEAT-006 快照保留不动。

## 实现记录（实际）

- **状态**：尚未执行。仅新建本工程上下文候选；未运行任何 lifecycle 命令、测试、构建、依赖安装或 Git 写操作。
- **实际改动与 Task 引用**：FEAT-007-T001 为计划 ID，尚未登记。源码核实全部只读：$REPO 侧用 `git show 7e72c8c:<path>`（读取 HEAD `c858712cab837ad68f20dd5fd2191a7fc0832da1`）；课件资产在兄弟工作区按实际文件只读读取。
- **工作区事实**：开始时工作树存在 FEAT-006 修正段 WIP（10 个已跟踪修改 + 2 个未跟踪测试，集中于 `sessionContext*`/`agent.ts`/`index.ts`/`SessionContextSettingsPanel.tsx` 及其测试），属其他在跑 worker；本阶段未读取其 diff、未采用其内容、只写了本文件。

## 验证记录（实际）

- **状态**：尚未执行业务验证。Plan 只读核实不是 PASS；未启动浏览器、Harness、模型、TTS 或共享服务。
- **被测版本、环境、命令与结果**：none；上文命令仅为策略。
- **覆盖与缺口**：bridge 探针对真实引擎的运行兼容性、iframe 自动播放、CRS-06 端到端时序均无运行证据，归 T001 及独立 Validate。

## 评审记录（实际）

- **状态**：候选待主 Agent 接受；未做独立评审。
- **范围、发现与处理**：本文将"凡开口必先暂停课件"的保守工程解读、coverage 基线归属、资产信任级别残余风险显式列出，交主 Agent 裁定，未擅自改写产品规则。

## 发布与观察记录（实际）

- **产品观察计划引用**：`.sdlc-v1/context/REQ-008.product.md` 的"发布后观察计划"。
- **技术发布准备、实际结果、反馈证据与缺口**：尚未发布；正式播出⑤层证据以"专用屏幕全屏显示舞台"模式为前提，由主 Agent 在授权窗口安排。
