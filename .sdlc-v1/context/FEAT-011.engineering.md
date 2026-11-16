# 工程上下文：FEAT-011 原问卷登记与固定私有读取交付

关联产品：`.sdlc-v1/context/REQ-014.product.md`。主 Sol 于2026-11-16接受本期独立范围和下列方案；Feature/Task 状态以 state.json 为准。准备输入与22项源码核对见 W/registration-readonly-phase-20261116。原FEAT-009修改代码、P1及unknown不在本期。

## 当前有效方案

### 架构设计

#### 背景、基线与事实

用户 2026-11-16 已选择读取分期；原 REQ-012 完整修改规格及 FEAT-009 blocked T001/T002 不变。本期复用已接受 T003，完成尚未验证的“原问卷→同表确切记录→授权私有读取”与实际固定版本交付，不把 writer 完成作为前置。

L=`/Users/mac/hansen_agent_team/workspace/20261109-deepseek-harness/dsh-livestream`；P=`L/packages/dsh-livestream`；W=`/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat`。规划核对时间为2026-11-16；完整 H=`e740bd1d359a92d0819c5f7cdf00e2dcddbf916e`，实际分支 `codex/macos-yovoice`。本次原位置状态：主线程拥有的六项 `.sdlc-v1` dirty 记录，三个 dirty 宿主源码及一个未跟踪 managed host；它们都不进入候选。前者作为最新产品/状态输入读取，后三个源码仅读 H blob，managed 文件不读。22项已接受源码/构建/包入口与 H 相同，见 `accepted-inputs.json`；这不是整个工作树干净的证明。

已执行只读 `git diff --name-status 74d2a953509cf975ec3517934ae1139e53313ad9..H`，范围为 P/src、P/test、P/build.mjs、P/package.json、根 pnpm-lock.yaml，输出为空。FEAT-010 已核组合的这些已提交业务输入到 H 未变；L 当前 dirty 宿主当然不在该结论内。旧运行环境、原产物及资源结论仍只能按原证据范围引用。

本期不引入长期架构正文；继承已有 SDK owner、同一 runtime chunk、共享合同单一语义、单 Base、原 Drawer 和环境隔离约束，来源为本次明确委托、REQ-004 CON-001/003、REQ-012 的只读与私有边界、project.md:108/121/125/237–244。project.md 中旧实现模型条目不覆盖当前 AGENTS 的模型路由。不存在需要用户重新选择的普通实现分歧。

#### 复用评估

| 候选 | 需求覆盖/代价 | 决定 |
|---|---|---|
| 固定 H 宿主读取＋原问卷＋现有 artifact/SDK/native | T003 已做 UI、权限、双消费者、严格适配与构建资产；只缺本期关联/当前权限/交付证据及相应 usage | 采用。仅补可复验入口/证据与文档，不改生产读接口 |
| 接入当前 dirty managed writer 后禁用写按钮 | 带入未接受的宿主、覆盖与P1，依赖原停止段，改变被测来源 | 不采用；不能通过配置“只读”洗成已接受候选 |
| 新登记后台/数据库/SDK或全表 Agent 查询 | 重复外部表单/存储、扩大权限，未解决原关联且违反单库和确切记录边界 | 不采用 |

复用现有 Node/TypeScript/React、esbuild、SDK 和测试依赖，无新增框架/依赖/账号/服务。P/package.json 当前 SDK `0.2.2-rc.1`、Cordis `4.1.0`、React `18.3.1`、TypeScript `6.0.3`、esbuild `0.28.2`、Vitest `3.2.4`，E2E `0.23.0`/Web `0.15.5`。原清单固定共享 artifact 为 darwin/arm64、Node `v26.13.0`、N-API `10`，sharp `0.35.5`；实际运行必须逐项匹配，不因构建 target Node22 就声称任意 Node22 可加载。全部依赖现有 lock；清单含 libvips 等许可证，分发保留原 NOTICE/许可。

#### 架构与组件

1. 访客使用原分享问卷；平台直接在原 Base/table 创建新行。L 不代理收集、不建第二 DB、不自动修改原行。
2. 未来验收入口在本次单一提交中观察原平台请求与响应，提取可信原提交/record 关系；仅保存必要的合成验收证据。它是测试/验收入口，不是新的生产资料服务、全表 selector 或提交账本。
3. owner 用原生 Base 权限确认 exact record，沿原 Drawer 的 ReadSettings 保存引用；两个私有组件使用现有固定读取链。原生整表视图由 owner 本人操作，不把表格行交给 Agent 扫描。
4. 读取实际路径为 H:index.apply→createReadService→registerReadRoutes→mountRegistrationPrivateApplication→两个独立 private consumer→readRegistrationProfile→readBoundRecord→固定 native user_info/record_get→固定 core.projectRecord→owner 私有响应。每层继续复用原撤权/配置代和晚到校验；公开 Agent 工具集不增加资料工具。

本期真实变化只有输入记录及验收路径/文档，不存在需要新策略框架的业务变体。Live/Robot 两侧共用一个 core 和同一 adapter，但各自请求原记录；匿名填写和 owner 管理是不同身份/权限，不能共用浏览器 cookie 或把接收端身份从 JSON 传入。

#### 固定来源与分发决定

- 候选的生产源码逐字来自 H Git 对象。实现者留在原 L 已登记分支，只写本Task新增验收/usage路径；构建和测试使用任务自有的固定Git源导出及允许路径overlay，不从dirty原树取生产代码。导出是无.git的构建输入/分发工件，不是新的checkout、clone或worktree。逐文件manifest必须证明生产源与H一致，新测试/usage与允许diff一致；不宣称原L业务工作树干净。
- 未来实现只叠加下文明确的新验收文件/usage 变更。完整业务来源必须能映射到 H＋该 allow-list；不能仅核三个文件后从 dirty L 宽泛复制，不能借 source-map 替换吞入别的 dirty 字节。
- 不允许 import 或接线 `managedLivestreamHost`、新 writer/coordinator；H:index.ts:425–431 的直接 read service 组合保持。readService.ts:19 固定 manifest `cff638ff461fab35b082e93d62c28c768472688d03888b69864700f89abb8fcb` 不改。
- artifact 位置唯一沿接受证据：`W/feat009-read-increment-40/delivery/registration-profile-v1-cff638ff461fab35/`。loader 要核 manifest、全部成员、无链接/只读权限/uid、Node/ABI；本轮只核 manifest 并读取核心相关段，没有重新验证全部依赖。未来分发使用原不可变 artifact 或其完整匹配副本，不从 Q 当前树、staging 或 latest 再生成。
- H 的 registration 目录仍有完整 writer 目标未验收的库/操作账本代码；shared core 有纯 validatePatch，固定 native 也有既有受限写动作。保留这些已固定字节不等于发布其 writer 能力。本期验收实际装配只签发 read、可达 HTTP 动作只有读取集合、原 native 派发只有 user_info/record_get。不得用“全包无 patch 字符串”这种错误检查，也不宣称同 UID/owner 在其他应用无写权。
- 标准构建沿 P/build.mjs，输出只在自有新目录；该脚本默认删除/重建 lib，绝不在 L 默认位置执行。固定 native 仅按原已接受构建支持复制/核摘要与0500权限，不执行、编译 Go 或换 native；真实读取窗口才允许运行既有154145…固定 binary。不得使用后续 writer 的另一个 native 身份替代。

#### 数据、接口、身份与兼容

| 边界 | 唯一契约/实际输入输出 | 失败和约束 |
|---|---|---|
| 原问卷 | 产品上下文固定的 share/Base/table/form 及四 fieldId；用户名/联系方式必填、可选空 | 原表单确认仅代表其实际返回；没有已核 record 关系不得结算保存。无上传/自动补写/新建列 |
| 原提交证据 | 优先本次真实提交响应绑定 exact recordId；否则平台原生 submissionId→record 的可核关系。保留同一请求关联、响应中实际字段路径和目标 tuple | 当前字段形状未知，不预造 endpoint/schema；仅 can_submit_again、成功页、标记文本或 owner 选行不构成关联。不引入姓名搜索/API record-create fallback |
| settings GET/POST | readSettings.ts:2–21 的完整严格 schema，保存非秘密 workspace/profile/app-user/artifact/Base/table/record/映射引用 | 任意新增字段会被拒绝，本期不加 formId/来源字段或读取 secret。保存清旧授权，无业务/native调用 |
| authorize/revoke | readRoutes.ts:98–108、137–149；POST空对象；宿主从当前已保存 tuple 和 SDK Peer 签发/失效读权限 | 明确授权会读原本机配置引用/artifact，不做账号/业务探针。原 SDK owner、workspace 服务及目录身份必须实际有效；模型角色/HTTP自报头不能赋权 |
| live/read、robot/consume | readRoutes.ts:110–135；POST空对象；同一授权下两个独立 component 和 requestRef，各自原读；私有投影输出 | host 选择 consumer；客户端不能给 grant/role/record 换目标。body≤64KiB、no-store；forbidden 403，其余受控失败409，匿名可由 SDK 在进入路由前401 |
| 平台调用身份 | SDK owner/Peer 与飞书 user 是两种身份。沿原选中 profile 的 appId/openId/keychain 引用快照；每读原 user_info→record_get | 不能从SDK kind推断自然人或平台主体；已有 ready 仅历史事实。保留原strictMode/DPoP/认证刷新路径；未读真实配置、不复制明文密钥；auth可能正常更新原存储，不声称无认证副作用 |
| 资料投影 | 同版 `visitor-registration-profile/1`，严格 fieldId/矩阵/exact record；共享core唯一语义，不改变旧visitor-access-v1/phone/purpose/Visits | `privateApplication` 当前不提供 getTrustedEvidence，readService 将formId/submission_ref置null。即使外部验收已证明某次原提交保存，reader仍保持record-only/submission unverified及pending；不伪造revision/consent/collection，不为改状态重做来源适配 |
| 照片 | 本次真实提交为空；reader保留absent/reference_only/unknown等实际状态，不显示token | 无照片不等于识人就绪；本期没有附件读取/上传/修改/正向内容核验，原REQ-012照片义务不减 |

提交副作用归平台原问卷；保存/授权/内部读取不写业务数据。响应丢失时不自动重提、换operation/身份/表、另建记录或扫描补找；保持原请求关联及unknown。两个不同 record即使文本相同也不合并。读取是显式可重复的只读动作，但超时/不存在/权限不足/解析失败必须区分实际可知程度，不能把unknown改成不存在。撤权后结果只允许丢弃，不交新主体；本期不触碰原 writer unknown/账本/receipt。

usage以根README新增稳定入口 `LIVE-REGISTRATION-FORM`、`LIVE-REGISTRATION-PRIVATE-READ` 导航到既有示例指南同一段，分别对应访客REG-01–03/05与owner REG-04/06–10。说明actor、入口、原分享权限/SDK owner/平台user前提、owner提供的现行问卷引用与ReadSettings参数来源、保存→明确记录→授权→分侧读取→撤权步骤及失败/unknown恢复。公共源码指南使用owner提供的部署引用，不写真实身份/本机配置/私有记录链接；不复制共享schema或另建第二套usage文档。原提交证明与reader当前未消费来源的状态分别解释，防止把“原提交关联未核对”文案误当本期原平台取证已经失败或通过。

#### 需求覆盖与必要检查

| 产品场景 | 现有实现/本期缺口 | 计划 Task / 检查 |
|---|---|---|
| REG-01/02 | 原托管问卷；当前必填/匿名/可选空未完整验 | T001；未来原问卷真实 UI、一次有效空可选提交，保存必要语义截图/校验观察 |
| REG-03 | 原关联无证据，现reader没有来源适配 | T001；同次提交可信原record关系→exact回读，缺关系则incomplete，不改reader状态掩盖 |
| REG-04/08 | 复用T003双组件/固定core/native | T001；当前真实SDK、原平台身份、双独立requestRef、四字段匹配、absent/pending真实呈现 |
| REG-05 | 历史closed/直接成员仅owner，不是完整当前证明 | T001；当前owner有效权限核对、匿名原问卷及已知合成record内部链接拒绝；不扫描或读取其他人的行 |
| REG-06 | 已有T003与FEAT-010 S6有限证据 | T001；当前候选await期间revoke/重配/Peer失效，完整HTTP409正文无result/fields/标记；UI清除及重新授权正向恢复 |
| REG-07/09 | 原隔离/严格parser及受控错误 | T001；实际动作白名单、公共工具不增加、公共state/SSE/Stage/日志0私值；错误/未知/不盲重提反例 |
| REG-10 | 原Drawer与标准构建可复用；固定来源/usage/安装事实缺口 | T001→独立Validate→Review→Ship；双视口/键盘与当前源码、标准包、目标宿主分别匹配 |

### 实施计划

#### 背景、目标与技术栈

本期不写生产 TypeScript，不重做T003、不做schema/协议迁移，也不重新实现认证、账户选择、授权协调或Robot Agent接线。交付内容是可审计的固定只读候选、最小本期验收入口/数据关联证据与同一usage。Node/SDK/native/artifact版本沿上文，平台UI/网络版本在实际执行时记录，当前不探测。

#### 实施阶段与最早可检验结果

1. 主 Sol 接受产品/工程候选，合法登记新的 Requirement/Feature 及唯一计划 Task；父REQ-004、REQ-012和FEAT-009状态/依赖不改。确认新测试/usage写范围无其他writer；为隔离工作区登记实际分支和H。先核输入漂移及引用可读性，再开始实现。
2. 同一实现者准备固定快照和最小验收入口，先有本地拒绝误目标/多次提交/未授权执行的检查，再接原读取。新入口默认离线，不读取真实配置、不访问分享链接；真实模式必须由主 Sol 已核的窗口显式启动，不能凭路径或本计划自动运行。测试构建配置seam只返回自有配置路径/Node子进程；标准产物不含seam。先完成保证这一步安全所需的小范围检查，不把整套课程/照片/writer基础工作排到它前面。
3. **最早真实增量属于 T001**：未来获准窗口只完成一条带明确合成标记的原问卷有效提交，照片及意向商品空；在该次原提交响应或平台原生关联中取得exact record，由本人确认和授权，再让两私有组件分别真实原读并比对。立即向主 Sol 交付原问卷入口、固定候选、实际结果/未定项；不能等writer、T1、直播入口/私信、全屏S1或照片闭环。该增量不要求开播。没有可信record关系时保留“提交确认/结果未知＋单行读取”分项，不称本期通过。
4. 同一实现者继续当前有效ACL、匿名拒绝、撤权迟到/私有与公开隔离、严格失败分支及usage/构建/解包/可操作性检查，收齐 Task 自测和修正。已通过且输入/环境未变的历史检查按证据适用性复用，不为了格式重跑所有T003或FEAT-010套件。实际新失败按原归因保留。
5. 主线程接受任务和allow-list diff后，在非主分支按既有授权commit/push；独立Validate只读验证该明确业务commit。已有L dirty业务文件阻止在L直接宣称“干净验证”；实际检查须用固定Git源导出和明确overlay，完整核对受测源身份，不能从原dirty宿主执行。不得reset/stash/clean旧WIP来满足条件。必要的独立上下文由主线程安排，本准备不委托。

#### 最早真实窗口的精确需求

这是未来计划，不是本准备的执行许可或“当前外部条件缺失”结论。

| 动作/入口 | 身份与权限来源 | 拟定有限边界/结果 |
|---|---|---|
| 打开并填写原分享问卷、一次有效提交 | 不带owner cookie的访客上下文；沿原分享权限；资料本人授权的纯合成内容 | 仅四题，两个可选空；不登录/上传/改分享设置。未来窗口提案为一个浏览器/context串行使用、10分钟上限；具体请求/响应大小和目标允许范围由实现者基于实际入口形成可审计启动清单，不能把139旧GET-only脚本取消限制后直接用于写入 |
| 原提交→exact record定位 | 本次原响应的stable recordId，或平台原生可核的submission→record关系；本人确认 | 先观察现成原响应，无并行造行，无昵称/联系方式/时间窗口搜索；缺关系即停止有效提交。不要猜内部Web API或预写“存在recordId”的断言 |
| 保存→授权→两侧原读 | 实际SDK owner admission/Peer；已注册workspace；本人选中profile及原app-user/keychain引用；same Base/table/record读权限 | 保存/授权零native；读取各user_info→record_get，首窗合计最多4次固定native启动，不另加auth/status/账号probe。不把每调用最多8 auth+1 resource源码预算说成观测到的物理HTTP次数；正常token刷新可能发生 |
| 当前匿名读取拒绝与owner权限核对 | 前述匿名上下文与本人原生权限管理面分别核验；不扩scope或成员 | 仅本次已知合成record链接及Base/表单访问面；不读其他记录或Q账号。若实际需要新身份/权限，先交主线程，不擅自创建 |

SDK owner、平台身份与artifact必须出自真实路径；用fixture的owner HTTP头或合成native替身取得的结果只能标为offline。主线程在执行前确认当前具体授权已覆盖这些创建/读取/浏览器/原认证可能副作用；已覆盖则继续，不增加逐步骤确认。若真实访问不可用，记录实际拒绝或未知原因；不能把“本准备不执行”登记成平台不可用。

139失败脚本不重跑、不修理或弱化DNS/public检查；未来窗口是经本期合法登记和具体授权的原提交业务验收，不能号称复现/修复139或获得该段新诊断。遇到同样未定位网络拒绝按原失败历史停止依赖动作、返回观察，不自行开新DNS/账号实验。

#### 风险、回滚与记录

主要未知是原响应能否提供可信record关系、当前匿名/继承权限、原配置身份与实际交付宿主。前两者需实际观察，后两者由主线程提供/核验现有授权环境，均不靠新布尔配置补齐。失效回退是撤销本期私有授权、关闭新验收入口/停止新派发；不自动删合成行、不补偿原提交、不恢复旧WIP或旧私有快照，不操作原writer日志/marker/receipt。数据保留/删除沿产品负责人规则。

原始响应不落凭据、Cookie、认证URL、原userinfo或人员原值；合成窗口只保留必要的目标关联/字段匹配布尔、响应来源字段路径、整数exit与时间、候选/依赖摘要及清理范围。必要私有原提交证明保存在任务自有0600文件，先移除认证/敏感字段，记录脱敏范围；不能只留一个无法检查关联的hash又声称独立验证已复核原关系。其他资料原值不采集；不把私有证据提交到Git。

### 工程任务

#### FEAT-011-T001：固定只读候选与原问卷同表读取交付

**独立可验证交付**：基于H、无原dirty接线的固定可构建/分发候选，本期重复可用的受限验收入口、准确usage，以及一次原问卷有效提交到exact record双私有读的实际证据和必要安全/失败检查。只安排一个完整纵向Task；同一实现者负责其测试和修正，不拆出补测worker。形式依赖 `[]`；已接受FEAT-009-T003和固定artifact是复用输入，不能把blocked T001/T002、captured REQ-004或完整in_delivery REQ-012设为完成前置。

后续派工沿用户已明确选择的Codex路线：实现/必要验证为 codex/gpt-6.1-terra、reasoningEffort=xhigh，规划/独立评审/最终接受为 codex/gpt-6.1-sol、reasoningEffort=xhigh；主线程核实际回执。旧GLM unknown-model及Claude限额历史保留，不探测或切换provider。T3执行者是terminal executor，brief必须明确禁止spawn/followup/delegate/新线程；本设计准备没有发起任何委托。宿主配置与独立后端元数据分别记录，缺失写unknown，不猜测或切provider。

**T001允许源码写范围**：

- 新 `P/test/registration/readonly-phase/**`：固定来源核对、有界验收runner、实际SDK私有读/完整HTTP晚到正文观察、原提交关联/匿名访问检查及必要fixture。只放手写小文件和合成数据，不复制node_modules/native/旧运行证据/真实配置。
- 新 `P/e2e-registration-readonly.config.ts`：复用现有e2e/Web依赖与目标/报告结构，仅本期精确locator旅程；不改全局suite或package/lock。
- `L/README.md`：只增加本期usage story导航；`L/examples/macos-yovoice/README.md`：仅既有“登记资料的私有读取”段及相邻原问卷/同表操作说明。
- 自有、全新且由主线程明确的输出/temp/DSH_HOME/标准构建目录；具体运行/证据大小上限由后续brief规定，原证据累计和原segment失败历史不清零。

**禁止写/接管**：P/src全部，包括dirty index/agent/runtime、managedLivestreamHost和原writer/账本/permit/native；原test/registration、test/acceptance与其他Feature测试；Q/H/D、共享Skill、W/feat009-t001/staging、安装lib/lib.previous、旧证据/原敏感日志、真实配置/凭据/平台schema/ACL。`.sdlc-v1`及Git由主线程处理。本期不改问卷题目/必填/schema/分享策略；若当前可见用途或ACL确不满足既有产品规则，返回精确差异和最小所需外部配置动作，不能靠验收runner静默修改。

**实施与必要检查**：

- 读取H中实际宿主接线与当前已接受模块，比较相关已提交/暂存/未暂存/未跟踪变化；旧WIP不读。候选来源校验须识别误用dirty宿主/错artifact，正常候选通过；输出source-map/metafile和测试seam范围，证明标准产物无测试替换。
- 复用现有fixture结构与原检查定义；旧脚本改HOME、直接写peers表的片段不运行。新测试构建仅在readService.ts导入的`node:os.homedir`局部返回任务自有配置位置，其他路径与生产模块不改；Node/native替身只用于离线。SDK非owner反例用公开`connection.createPeer`/原route，区分匿名HTTP401与SDK guest403，不声称browser guest已认证。
- 原读取安全正向/反例按上表有界覆盖：保存/授权零native、两组件各自原读、可选空/pending、精确目标/矩阵与权限失败、撤权/改record/workspace/Peer后迟到完整正文无值、UI清除与重授权、公共观察0私值、native动作仅user_info/record_get。复用41/51/FEAT-010 S6证据前核相关输入/环境，不以Task done代替本次判断。
- 新原提交关联检查包括：真实原record关系才允许结算、只有can_submit_again/错误tuple/缺关联/响应丢失保持unknown、不发第二次有效提交、不搜索/创建替代行。离线合成协议反例不冒称平台确实返回那些字段。
- 新Web旅程采用项目e2e精确locator，375/1440、键盘/标签/焦点、loading/拒绝/pending与原Drawer；真实问卷另存其实际观察。守卫在任何import/监听前准备DSH_HOME和stagePort=0，拒共享3080/3081/7390/8757及非任务目标；guard负例与正式计数分开。只清理所属浏览器/profile/PID/临时目录，不扫描或停止共享服务。
- 类型/新增脚本语法/格式、必要测试、标准构建与新解包目录的读入口内容/资源检查。已存在且有接受证据的入口为包check/build及 `test/registration/build-{read,fullhost}-fixture.cjs` 和相关.case；后者有上述旧隔离片段，不能原样直接运行。新runner/config尚未建立，现无可运行argv；实现后先核help/实际执行再写usage，不把本计划当已验证命令。

**自动完成检查的期望**：未来实际记录的typecheck/format/语法/有界runner/E2E/标准build/新解包smoke均exit0；正向exact双读字段匹配，两requestRef不同；错误候选/未授权/错误tuple/晚到反例明确拒绝且无私值/写派发；全部输出与同一候选源/fixture/依赖相符。真实REG-01–05的观察判据由主Sol根据原平台响应、当前权限与明确原行核对，不能从exit0推导。无可信原提交关系、无必要真实权限或仅task fixture时T001仍incomplete，并列已交付部分。

**Task特有停止条件**：需要改生产src/新schema/新scope/账号/问卷策略；固定artifact/SDK/Node或原配置主体不匹配；关联只能靠扫表/猜行；原可能已生效的提交结果未知；实际运行需要共享安装或原未交还写范围；出现指向原writer/P1的依赖；必要验证不具备。只停止受影响动作并回主Sol，保留差异和证据。原139、writer、S1失败及唯一诊断使用状态全部继承；本计划不是这些段的第三次尝试或新的诊断许可。普通新实现检查失败由同一实现者在范围内修正，非收敛时严格按阶段协议§5停止，不换名清零。

#### 依赖、独立验证、Review与Ship

- 新计划只有T001，登记顺序由主线程合法执行；本准备无生命周期CLI请求或变更。主线程接受候选前先处理REQ-004:8的旧未确认措辞与最新明确决定的一致性，不再向用户索取已经给出的范围选择。
- **Validate**：独立上下文读取固定业务commit和纳入该commit的测试/usage，实际验证本期读/权限/晚到/公开隔离及标准产物。原有效提交只做一次；可独立核必要原提交证明并对同一已授权exact record重新读取，无需再创建记录。独立真实回读需要另有当前授权预算，不继承Build首窗4次额度。没有真实独立检查时如实保留未完成，不把实现者报告冒充独立Validate。
- **同版FEAT-010依赖**：H与74d的上述已提交业务范围无差异，但本期测试/usage/目标输入有新增，须检查本期私有读取在当前标准宿主中的S6及公共输出交叉行为。只有实际影响课程/公屏/结束路径时才补相应检查；不为补旧S1样本重复跑全屏/字幕/音频，不复活原writer，不将本期证据替FEAT-010的S7或旧fail改pass。父Feature整体验收由其主线程独立判定。
- **Review**：由主线程按生命周期安排独立只读Sol/xhigh上下文，检查完整diff、固定来源、动作可达性/权限、原提交证明、usage和同版验证证据；本设计分析不算独立Review。发现实现问题退同一实现者，新增业务commit后重新判断受影响验证，Review不改实现/usage。
- **Ship**：只分发Review所对应、Validate绑定且已核定源内容的commit；原L停止段WIP不属于受测或分发输入；在新解包目录核内容/源身份/固定artifact和native资源，做实际加载smoke。完整本期结果还需在用户实际获准的私有宿主确认固定版本、实际owner/workspace和读取入口；纯源码分发/fixture不冒称共享Harness已接通。目标部署位置和串行安装窗口由主线程沿现有授权落实；它若涉及当前受保护lib/服务，本准备及Build均无权操作，必须留到合法Ship写范围。不得打包当前L dirty产物或以安装切换掩盖原WIP。
- 目标/环境改变后的必要只读smoke另按实际许可安排；不再次提交问卷，不用新身份/记录替代原目标。发布保留30天删除责任与当前pending边界。回滚只撤本期授权/新能力，保留原证据和旧writer事实。

## 实现记录（实际）

未执行。本稿与scope-analysis/产品上下文仅写在R；未启动编译、测试、服务、浏览器、native、Go或外部请求。

## 验证记录（实际）

本准备只核文档/源码/manifest、22项明确输入字节与提交间路径差异。无产品验证或运行通过；未来测试命令及整数exit、业务commit、工作区/环境/资源事实由实际执行者记录。

## 评审记录（实际）

未执行；主Sol仍拥有本分析接受、有效方案和最终验收。

## 发布与观察记录（实际）

未执行。技术发布/目标装配按上述Ship；产品观察条目、窗口、责任和回流只引用产品上下文“发布后观察计划”。

### 主 Sol 接受与执行环境决定（2026-11-16）

本期只覆盖原问卷登记与内部读取，复用T003；不要求完成旧修改核心。原匿名检查139及其他历史失败均保留；一次真实业务窗口是本期原问卷提交验收，不是重跑139或新增其诊断。当前尚无真实提交/关联/部署通过证据。

首次T3委托因本地target.projectId跨项目限制被invalid_request拒绝，未创建执行器、checkout或源码变化；实际T3父项目是hansen_agent_team，不能据此创建正确L隔离工作区。故本Task保持L/codex/macos-yovoice登记，改用同一T3 shared执行方式，仅写允许的新验收/usage文件；不改模型/provider、不借shell或新顶层线程创建checkout。测试/构建输入为本地已提交基线的Git对象导出，加本Task允许diff；生产源逐文件固定到H，原三个dirty宿主及managed文件完全排除。记录源manifest/构建输入/sourcemap，明确原L仍dirty。独立Validate随后对已提交业务commit新导出再验证，不能复用已经mutated的测试数据或从dirty原L宽泛复制。root保留状态/文档和最终接受，执行者不Git mutation/lifecycle。

### 首轮Build处置与同一执行器接续（2026-11-16）

主Sol核对首轮result/DELIVERY、实际命令日志、nativeArtifact源码及npm成员清单后保留Build incomplete；不请求T001 done或进入正式Validate/Review/Ship。固定标准构建54成员、源映射、真实SDK配合Node合成子进程的迟到409及双视口E2E只按其实际范围接受为可复用输入；真实问卷GET在取得HTTP响应前被相同未细分DNS/public检查拒绝，零有效提交/原记录/真实native读，保留139及本轮停止。此接续不增加任何浏览器、DNS、账号、平台、模型/TTS或native执行窗口。

执行偏差按原事实披露：早期仅新Node测试从L运行，不含禁用生产源，最终已在导出重做；首次解包导入缺DSH_HOME，产生任务自有fallback设置但当时监听/网络未完整观测，之后全新guarded导入通过。上述事实不构成产品缺陷，也不能改写为全程隔离合规。npm缓存曾造成合并采样超旧上限19,418,423字节，已清理；原违规和未知峰值保留，不用后续容量扩展追认合规。

**新的已核包装问题与有效方案。** npm归档中固定native字节匹配但mode0700，许可文件0600；构建对应0500/0400。生产verifiedNativeExecutable还要求父目录无写位、同uid、单硬链接和固定SHA；仅入口import成功不能证明native路径可用。目标是本机固定私有交付，不新增npm发布要求。本轮提供完整、保留权限的私有交付归档（含标准lib、package声明的stage/assets/patch/license及同版usage），用显式完整成员清单映射固定源/标准输出；新解包核原native目录/文件模式、uid/nlink/字节并通过原校验，绝不执行native或放宽nativeArtifact。保留原npm失败包及证据；npm安装兼容性仍未验证，不描述为已修复。只读源/标准JS保持原字节，不重建原writer或重跑无关套件。

同一执行者在原新增test/registration/readonly-phase范围内补可复用归档/解包工具及必要检查，不改生产src、build.mjs或package/lock；如系统归档工具不能满足合同，报告具体缺口，不新建通用归档框架。必要时在现有测试fixture补实际自有Stage端口0/SSE及可用公共历史的私值观察，保留合成依赖标签，不重跑旧S1或生成语音/实际发送。usage须区分“owner明确选择exact记录即可record-only读取”和“本期登记保存验收另需原提交关联”，不能将后者强加为日常读取前置。

**容量与时间。** 旧合并上限4,831,838,208 bytes及其超限不改历史。基于已核完整包/解包需要同时保留原59,367,190字节失败包和固定native/完整资源，主线程将后续合并容量上限明确增加268,435,456 bytes，成为5,100,273,664 bytes（4.75GiB）；R仍不超过512MiB。主线程本次df只读确认可用762,416,744 KiB。先核当前占用和预计同时占用再写，避免npm缓存复制；只清本Task可重建重复件，原日志/唯一证据与旧目录不删。首轮02:19:28合并点采样4,792,106,434 bytes仅为当时观察，非当前或峰值证明。原start01:12:14Z、最终deadline02:52:14Z及100分钟窗口保持，不重置；实际执行层起止也计入。无新诊断额度、外部调用或原修改写权。

原实现线程已completed/activeRunId=null；root随后向同一线程接续被T3以runtime_mode_escalation_denied拒绝，因为原child full-access高于当前parent auto-accept-edits。未启动新run或写入。现有工具没有降低该线程runtimeMode的接口；不申请提升parent、不换模型。root对R的lsof及原记录PID复核均无匹配（有限采样），并通过task_cancel关闭原task执行归属、保留结果；因原执行器在当前权限不可用，按既有交接规则用相同codex/gpt-6.1-terra/xhigh、显式auto-accept-edits模式接替剩余离线包装。实际写范围、原deadline02:52:14Z、资源累计、失败/非收敛/诊断额度和无外部调用边界全部继承，不以新线程重置。新执行者只完成已核包装缺口和其必要检查，不是独立Review或对旧停止段的替代执行。

### 用户要求加速并行与DSH界面联合验收（2026-11-16 07:57 UTC）

用户明确“赶快补齐，我现在可以开直播跟你做验收测试了”，允许并行子线程，并要求从DSH配置界面操作。原自动修改后续决定保持；新增实际直播场次验收授权不恢复writer/P1、不自动授权任意账号/房间或多次发送。现场优先使用DSH界面中本人选择/保存的配置，由root串行控制真实对外动作；公屏仅一条原约定测试文字，不自动重试，原请求unknown不得补发。来源、账号权限与观众核验逐项核实，不把界面代码存在视为运行就绪。

此前包装执行已completed且无活动run。越期Stage/SSE与打包检查保留实际时间和命令作为观察，不追认符合02:52:14截止，不靠重跑擦除偏差。新发现原Git根目录LICENSE存在，内容明确MIT及动画例外；包装缺失应复用根许可证原字节，不能杜撰授权。原package.files是分发包含清单，不将可选名缺失一概推导运行缺陷；本次实际补齐package README/根license副本以满足可用交付。

并行边界：A沿原auto-accept-edits Terra执行器完成package README/LICENSE及新完整私有归档/必要解包检查，唯一源码增补为P/README.md和P/LICENSE，原新readonly-phase包装工具可必要局部修改；不写其他生产src/package/lock或真实业务。B由独立Terra仅只读核对现有本机服务/已安装产物及DSH配置字段、sender现有部署引用与最小缺口，证据写新W/live-acceptance-readiness-20261116；不操作浏览器/保存配置/启停服务/账号/发送。root独占.sdlc-v1、现场浏览器、表单访问原因与所有真实操作。接口稳定、A写包/B只读已安装版，无共享源码或运行写者。

用户新指示下新增有界窗口：A截至08:17:42 UTC，B截至08:07:42 UTC，root表单访问单次诊断仅3分钟且先声明假设/最小观察；原全部耗时、失败、非收敛与唯一诊断使用状态保留，不以本窗口重置。包装输出总量R上限增为768MiB、相关合并上限增为5.25GiB（5,637,144,576 bytes），用于保留旧59MB失败包、旧私有包及新包/新解包；旧19,418,423字节违规仍保留。先预算后写，不复制依赖树或重复native资产，不删除原唯一证据。root仅在有新的可复核来源/环境因果事实时更新表单执行方案；不能按旧同输入重复请求。
