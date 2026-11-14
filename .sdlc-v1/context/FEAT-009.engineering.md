# 工程上下文：FEAT-009 同表私有资料消费与受管修改

## 当前有效方案

### 架构设计

**关联产品**：L/.sdlc-v1/context/REQ-012.product.md，SHA256 `9a74072f02084305687fb0018d704479e991c41feb36693e50718c1c765a7dfc`，spec_ready 已 match。工程上下文为 `.sdlc-v1/context/FEAT-009.engineering.md`，主 Sol 已接受本方案；Feature/Task 进度以 state.json 为准。本文件不修改产品范围。

L=`/Users/mac/hansen_agent_team/workspace/20261109-deepseek-harness/dsh-livestream`；LP=`L/packages/dsh-livestream`；Q=`/Users/mac/hansen_agent_team/workspace/20261110-qdroid-dsh-t1/dsh-qdroid`；W=`/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat`。下文带这些前缀的路径按本定义解析。

#### 背景与复用

目标是原 Drawer 中明确授权一条原记录，Live 与 Robot 私有组件按同版合同各自真实读取；owner/Live 在共同协调下做有限原记录修改，随后两侧核读。父 REQ-004 私信、获准入口、原提交及最终验收保持；独立于 T1/联动/公开模型。完整验收只按产品 SC-1–5；内部库或全部 unavailable 不能替代。

单一数据/权限合同沿 `W/req004-preparation-01/spec-stage/registration-profile-v1.contract.candidate.md`（C，visitor-registration-profile/1），后续发布唯一规范到 Q/skills/visitor-reception/references/registration-profile-v1.md；L 不维护第二份 DTO 语义。新增 v1 私有控制 API 仅承载宿主动作和 C 的引用/patch。

复用评估见 increment-plan-analysis-09/analysis.md：选择现有 DSH owner/Context/workspace/Drawer + Q 新共享模块与私有 consumer + 固定 native lark-cli；不建第二访客资料库/同步服务，不改 RobotJournal/Visits，不引入通用 SDK。控制 intent 存储选现有 Node 内置 SQLite（Q/src/journal/worker.ts:17 已使用），是有限操作账本，禁止保存四字段原值/照片副本；不沿用旧接待数据库或 schema。

#### 架构与组件

- `L/src/registration/authority.ts` 捕获真实 connection.admit(originalRequest) 的 Peer/service/signal 和当前配置代，为确切 record/用途/动作及实际组件实例签发进程内权限。JSON角色/consumer名/grantRef本身不产生权限。每个await后和私有交付前重核；撤权立即禁止新派发，迟到原值丢弃。Covers SCN-02/09/13/17。
- `workspaceExecutor.ts` 仅支持已注册的本机 workspace。固定上游 1.0.99 源码的任务自有受限派生 native/完整清单校验；实际代码把 profile、身份、Base、table、动作限制为当前授权。原CLI读取身份配置使用本调用独占的不可变配置引用快照，原凭据与签名仍由受限派生 native 内的原 CLI 认证代码处理，见决定1及1A。共享 CLI API 不能暴露给模型。Covers SCN-01/02/13/16。
- `recordAdapter.ts` 严格解析 JSON 原矩阵，以固定fieldId、类型、列索引、唯一原record关联，拒绝重复/缺列/权限忽略、额外记录、混合富文本、畸形信封。标准输出有限制，原错误先脱敏。metadata/readiness/submission 只按 C，不伪造来源。Covers SCN-04/05/16。
- `artifactLoader.ts` 一次加载 Q 的固定版本 artifact；shared core 只一份，L/Q consumer均调用该份实例。清单含规范/Skill/源/生成文件/Node和sharp依赖身份；严格固定路径/版本/摘要，不加载另一checkout latest或任意模型路径。Covers SCN-03/15。
- `livePrivateConsumer.ts` 和 Q/src/registrationProfile/{host,consumer}.ts 是两个独立确定性产品组件。L实际apply挂载Q新host到同一个Cordis Context，分配不同组件实例权限与执行关联；Robot独立向原Base读R，不复用Live快照，不依赖fixture/设备。分别生成owner私有查看/接待准备结果，不接到LLM/tools/TTS/Stage。Covers SCN-03/14/17。
- `profileCoordinator.ts`/`operationStore.ts` 使用同一控制账本协调同一Base/table/record的所有受管profile写者。Robot无patch port；旧角色不自动取得扩展权限。跨进程 reserve/dispatch/result 在SQLite事务中推进，网络不持事务，unknown持久占该记录。见决定3。Covers SCN-07–13。
- `attachmentAdapter.ts` 先用同一原CLI上下文确认exact record/field/token及extra，再通过固定官方临时下载URL元数据接口取得该token的短期链接。只在私有执行端接受经验证的平台HTTPS来源，Node流式读取按C的原字节硬限制取消；不把CLI不限大小落盘下载当受限stream。Q/photoVerifier复用sharp核原图metadata、完整解码/字节摘要，重新核原记录/附件版本。Covers SCN-06/08/16。接口可用性/必要权限必须在真实窗口证明；失败保留具体状态，正向照片仍是完整交付必要条件。
- `RegistrationSettingsPanel.tsx` 在原Drawer显示草稿/保存/明确原记录授权/两侧消费/readiness/审阅patch/原operation恢复。资料仅在原获准Peer的私有响应/局部内存显示，普通settings、/state、SSE、模型history、日志不带资料或可读引用；切主体/撤权清除原值。Covers SCN-01/19。

#### 关键设计决定

**决定1：固定配置引用，保留原 native 凭据体系。** 固定 v1.0.99 公共源证明本地UAT会重读account；直接profile+前后status不能单独绑定原业务身份。选择本次调用私有0700目录中的只读config.json（0600→只读），只包含明确选中且校验过的app/user/brand/原DPoP策略和keychain SecretInput引用；禁止复制明文appSecret/token/private key或将其放进env/argv。原文件只读、只解析确切已选profile，不扫描账号/用户数据。原值为plaintext或不支持引用时停止该方法，不隐式导出/迁移/降级。

快照转换必须保留原生 `effective strictMode`：先取选中 profile 显式值，缺省才继承原 MultiAppConfig 全局值；复制后的配置不得丢失该继承结果。执行端只取原有效身份策略与本功能 user-only 的交集。原策略不允许 user 时在任何鉴权/业务派发前拒绝，不能通过省略全局字段、强设user或使用无限制值放宽；不修改原配置。原profile/global字段与有效值的对应必须能复核。T001覆盖继承全局bot-only、profile显式覆盖、原user-only、原未限制等有限反例，核原生身份支持与快照后相同。未知/非法策略按原生有效配置约束拒绝，不猜默认策略。

明确设置专用 `LARKSUITE_CLI_CONFIG_DIR`，只继承必要可信OS环境、固定--profile/--as user；不改HOME/CODEX_HOME，不继承auth proxy/env UAT/TAT、自动workspace、API host或证书等可改变身份/网络的环境。宏观原config变化不改变已签发AuthContext；owner重配/撤权使原Context停止新调用。原context直到原子进程和清理全部退出才清理快照。

源码依据 main-executor-binding-11：core/workspace.go:126–169 是配置目录覆盖；core/config.go:305–346 校验appSecret key匹配并从选中profile取用户；macOS keychain_darwin.go:52–59,255–275 的存储不随配置目录改变；auth/token_store.go:47–93,200–219 按app/user键读并核记录主体；dpop/store.go:513–563及signer_storage_unix.go保留原签名/密钥存储。ConfigSnapshot只供部分调用，不将其误称本地UAT已经使用。

这只是来源充分的选择，尚未证明任务自有受限派生 native 具备相同行为。必要验证必须证明该固定派生构建/支持开关、错误profile/并发重配/原调用app-user关联及原DPoP不降级。使用同一不可变Context的只读user_info核对期望openId与app归属；摘要入证据、原值私有。只在明确业务动作下执行；保存不鉴权。原凭据正常续期只允许同一受信app/user存储键，不能换principal或fallback bot。无法证明时STOP，不能把身份采样/更密poll替代。

Rejected：env bearer租用作为默认方案；尚无现成租用接口且可能丢失DPoP。Rejected：自行解密/导出凭据或构建新认证服务；超出最小复用与本方案授权。

**决定1A：原生进程内的受限派生执行器（替代直接运行系统 CLI 的路径）。**

### 固定派生 native

仅此功能改用任务自有、固定源码构建的受限派生可执行文件。上游 VCS 固定 8d8357d39dd15ac5e9aa815d4ab2639d56bd3239（1.0.99），工具链明确 Go1.27.3；与系统原 Go1.26.8 build 分开标识。不改系统 binary，不称新 binary 为官方原字节。长期构建支持、精确补丁/基线/版本/NOTICE 清单放 LP/src/registration/nativeCli/**；原源码快照及构建缓存放 W/feat009-t001 新目录。

允许差异限于任务专用 main/入口、cmd 的私有执行模式与关闭 notices/update/plugin 自动动作、cmdutil factory 的来源/传输装配，以及 internal/transport 的受限层/clone 支持。原 internal/auth/**、internal/credential/**、internal/dpop/**、keychain 与 token_store 原字节保持。user-only resolver 适配器放 cmdutil 或新私有包，不修改原 credential 源。不得接受任意 argv/host/binary/extension；实际业务 method/path/body 与当前授权 Base/table/record/动作一并核对。保留原 profile/global effective strictMode 的交集，不能用 user-only 放宽原 bot-only。

只用同commit已取得的固定公开源、原go.mod/go.sum和已有artifact，不新增/升级/获取依赖。原60分钟native窗口已于2026-11-13T23:40:30.669196Z截止，累计授权170分钟及全部旧2GiB/3GiB失败保持。当前仅新增一次15分钟使用已固定现成native fixture的受影响恢复验证窗口，累计授权185分钟=11100秒；不改Go、不编译/重建、不运行真实配置/Keychain。首次实际native执行前记录唯一start/deadline，单并发、任务自有临时目录、原监测包装，合并整个W/feat009-t001普通文件（不跟随symlink）上限4GiB不变。需要新native接口/构建或artifact不匹配则STOP该部分，不挪用窗口；不得拆批/自行续额。只准清理已退出任务进程的确切可再生私有编译缓存，保留源/锁/证据/候选及重建输入，不动全局/共享缓存。Node-only原core实现及必要检查可先继续，未变且输入匹配的证据复用，不刷计数。真实业务全部0。

### 限制层与字节边界

所有 native JSON 请求/响应正文分别最多 1MiB，stdout/stderr 仍独立有限。请求在签名前固定 identity，限制层在真实叶返回后完整缓冲 max+1：超限、非 identity 编码、3xx/101、framing/截断/网络错误均关闭原 body，以受控本地策略错误返回，绝不向任一认证/SDK parser 交截断响应。完整小响应才交付原 bytes，不重编码。JSON 上传仅有限内存已核字节，禁止通用流/文件上传。

所有真实 *http.Transport 使用正常 TLS 验证、16KiB MaxResponseHeaderBytes、DisableCompression、DisableKeepAlives、HTTP1 only、无 proxy/自定义 CA 或未核 DialTLS 路径；所有 clone/transform 的最终叶继续受约束，无法证明则拒绝。一次业务 invocation 的 origin 资源请求最多一次；原认证有限 nonce/refresh 流程单独计数，不把 auth 次数混称资源次数。

新增同进程、真实 DialContext 返回连接上的入站字节预算：每个成功连接最多读取 8MiB socket 字节，含 TLS 握手/记录/HTTP framing；在 TLS 包装前装入，保留标准 hostname/SNI/证书校验。Read 只能把剩余预算范围交给底层，到限即返回本地限制错误并关闭自己的连接，不能先无界读后检查。wrapper 不接收/导出/代理秘密材料，也不引入 TLS 终止服务。最终需证明所有可达 direct/SDK/auth 与 clone 均经过该连接预算，且每请求/进程 dial 数有限；禁止竞速/旁路或无限拨号。它用于覆盖 chunk 扩展/不完整大块/trailer/额外 drain 等 HTTP 正文以外开销；不再用粗略 chunk 公式声称完整 wire 上界。TLS 内部有限缓冲与预算也须列入实际资源证据。真实 HTTP1/identity 兼容性尚未验证。

### 取消、认证与结果

Node 同步撤业务权限/禁止新 invocation 与私值交付，向已启动原进程发 SIGINT。30 秒业务结果预算是软预算，至多 120 秒原 invocation 总生命周期；原同步 UAT WithoutCancel 续期的 60 秒窗口/存储提交仍在 Execute 调用栈中完成。私有入口在 Execute/清理返回前不得自行 os.Exit；不得从 Node 等待推导内部 auth 已收尾。每次业务资源派发前必须检查实际取消上下文；认证期间收到 SIGINT 的反例必须 origin 资源为 0。已可能派发操作仍按 unknown，不承诺跨进程瞬时撤回。

超过总硬期限只能终止本任务原 PID，并保留 auth_indeterminate/原 record unknown，不自动重启/重试/修复/清除 token。本地限制错误不冒充 OAuth 明确拒绝；保持原 native 可能保留/清理/轮换存储的事实，不保证 token 从未变化。进程退出和 stdio join 不证明平台零效果。任何仍可达的 detached auth、未经限制的 parser/网络或无法关闭的业务重复派发，都是 STOP，不能用纯 unavailable 通过。

### 必要新增验证和原余项

实际派生 binary 与自有 TLS（仅测试信任根/存储替身、非真实账号）验证：正常原记录读/有限 patch；2MiB 含完整 JSON 前缀的认证策略错误、chunked、压缩、header/1xx/chunk 扩展/trailer/截断/到字节预算；parser 之前拒绝；旧 Got1xx nil/error 两分支与其它 hook 保留；各 clone 受限；真实连接关闭/EOF/redirect 下 origin 次数，Bearer GET 与 DPoP/有限写都覆盖；SIGINT 阻塞 UAT 续期/清理及资源零派发；TAT 请求在原默认 provider 前拒绝。不能只测 decorator/Node stdout 或 current=true 替身。

原 T001 全部未完项继续：真实 SDK authority、shared artifact 解包/两个独立私有 consumer、严格矩阵、共同受管写协调、可信原操作 receipt/failed/unknown、照片移除替换/下载/原图、旧 v1/Visits、匹配 typecheck/格式/构建/全部必要 suite。受管 SQL/设置/新映射不能清 unknown；同 UID 非受管恶意删除不在反回滚保证内，原失败证据保留且不记 PASS。

当前真实业务预算仍 0；真实身份/DPoP/Keychain/Base/photo 均 NOT_RUN。主 Sol 后续安排具体有限身份窗口；实现者无真实凭据读取/登录/请求权限。本次不会以新路径清空任何历史、重置 segment 或使用主诊断。T001 完整接受前 T002 不启动，无状态推进或 commit/push 授权。


**决定2：Q私有host由L现有产品入口直接挂载。** 独立builder产core/host/consumer/原图验证及规范Skill清单；L apply实际加载并mount，不修改Q旧package/exports/index/runtime，不只挂fixture。Q新目录和派生Task条件许可见coordination-10/owner-response.json。原OnsiteRobotAgent保持唯一robot_effect_execute；公共Live Agent保留原受限可信工具，资料不进入其参数/结果/assistant消息。

**决定3：一个控制账本、全部受管写入口。** 采用Node内置SQLite新schema2控制账本，位置由宿主可信策略固定，独立于可重存UI设置和workspace/app/profile映射；同一部署的所有受管writer必须用同一已核canonical journal。recordKey以真实Base/table/record确定，owner/mapping不是分队列键。拒绝远端不共享执行端、未知writer或可绕过共同端的部署开启写；只读仍可用，但Feature修改闭环仍未通过。

实际已挂载的旧profile writer清单必须在实现时核对。当前L公开工具受可信definition限制、Q Onsite只有effect；FeishuAccess未装配且现updateRecord服务Visits，不能据Skill角色文字宣称已存在运行writer，也不能把发现的旧受管writer改叫管理员。新增writer与旧v1兼容adapter均通过同一coordinator；旧generic workspace shell/CLI若能绕过，则须在实际派发/注入处限制后才开写。现有授权不足以改对应处时STOP给精确局部，不通过文档声明完成覆盖。原生管理者直接编辑按C external_conflict处理，不冒称平台CAS或禁止管理端编辑。

账本只存稳定operationId、内部原记录/映射/授权关联、预期版本、字段集合、保密HMAC摘要、dispatch/result/原执行终止事实，不存资料原值/照片/下载URL。journalId/schema及HMAC密钥引用固定；损坏/未知旧格式/别名/被替换文件拒绝，原字节保留，无自动迁移。SQLite事务BEGIN IMMEDIATE、foreign_keys、有限busy_timeout、durable同步；独占record_lanes与operation原子推进，不拿SQLite锁等网络。跨进程竞争/崩溃/重启均不得按超时抢占unknown或通过新目录/新operation绕过。

### 原执行事实持久化和只读恢复（Disposition35）

1. 继续一个固定canonical SQLite控制账本及原HMAC key引用，不引第二业务DB/外部anchor/常驻新服务。账本改为严格schema2，新增内部RecoveryDescriptor和NativeEndFact；不自动迁移schema1或创建新路径绕过旧unknown。当前没有真实journal迁移授权，旧格式保留原字节并拒绝启用；新schema测试只用task-owned新建fixture。
2. 在prepared原意图持久化时，同一事务保存metadata-only RecoveryDescriptor。它绑定原operationRef/随机nonce、recordKey/原record引用、owner/workspace/app/profile及原generation、实际app/user的HMAC主体摘要、mappingId/revision及所需物理field-ID/类型集合、originalReadRef、expectedRevision、固定native/配置摘要与原bindingDigest/patchDigest。不得保存用户名/联系方式/意向商品原值、照片字节/token副本、URL、完整command、native原stdout或凭据。可定位原目标的系统引用只按原私有控制账本权限保留。
3. 在同次prepare前，由实际buildTextPatch的唯一待发PUT body计算额外effectHmac（域分离的HMAC，不能低熵原值的裸SHA）。保存精确changed field-ID集合与固定规范化版本；摘要绑定原operation/record/authority/mapping/预期新版本。回读投影只核这些原列：文本严格原string/null；photo remove仅沿既有null/空数组语义规范为null；replace仅取原单token及photo revision/digest等原已核系统列。没有证明的rich-text转换或多附件拒绝。metadata/操作标识也在摘要内。旧patchDigest仍保留用于原意图幂等；不得以effectHmac取代原dispatchPermit或上传证明。
4. 原dispatchPermit必须同时绑定上述已持久descriptor和实际prepared body，不得给重启历史恢复permit。原native执行返回actionJoined时，只有workspaceExecutor内部核过本次真实原进程join、authIndeterminate=false、原配置/身份和原调用关联仍合格，才可铸造不可由请求/JSON/调用者bool伪造的终止事实。事实绑定journalId/原operation+nonce/原record和全部摘要、原invocationRef、固定native/配置身份；通过同账本事务+MAC持久后才向上交付可用于结算的证明。原始响应结果与“进程已终止”分开，joined不是成功。
5. 最小方案不新增native OS锁/父进程守护协议：原join后到持久事实前若父进程崩溃、事实缺失或损坏，则继续unknown/原lane，不以PID缺失、超时、新进程、当前值相同或新授权补事实。允许这种无法恢复的已披露窗口；不得宣称任意崩溃后一定解锁。这不改变原功能范围或允许重发，正向重启恢复必须在事实已可靠持久的路径完成。
6. 重启仅载入严格历史元数据/已核MAC事实，不恢复旧capability、permit或原patch。新的认证owner显式按原operationRef核对，核同一owner/workspace/app/profile及实际app/user摘要、原record和原mapping/字段；当前generation可以更新，但不得覆盖旧generation/原bindingDigest再假称相同。最小路径只接受仍能精确核对原mapping版本/固定native身份的恢复，不自动迁移。每await后/交付前/结算前重新核当前恢复权限与原对象。
7. 只有真实原NativeEndFact成立，且同冻结身份的受限原record新读取具有原operation标记、精确expectedRevision+1、原字段投影effectHmac相同，才通过原store事务结算verified并释放原lane。check只读平台，禁止任何PUT/重放/新request替代；不能由owner上传termination_proof/nativeJoined等字段。持久化失败在当前实例保持unknown/不可继续新写，重新打开后必须显式原ID检查真实已写历史事实再结算；不得把“查询到一条MAC正确历史”当新写授权。
8. failed仍要求原合同的可信原拒绝/no-effect与原执行终止；不得将任意native非零、local_guard、abort、HTTP4xx或空body泛化为无副作用。此补充不发明平台码语义，既有未证拒绝保持unknown，原必要failed正向能力不能用永远unknown代交付。任何实际需要新native字段/合同、额外生产来源或矩阵外改动先返回精确缺口。
9. schema2严格键/版本/字段类型、全关联MAC、容量上界、原path/inode/key/schema保护及BEGIN IMMEDIATE/FULL同步保持。事实和descriptor是一对一原operation附属元数据，不另建资料镜像；reserve/inspect不能凭新operation绕原unknown。跨进程争同record保持一个lane；不保SQLite事务等网络。同UID非受管恶意整行删除的原排除/失败保留，不重跑。


必要证据：真实生产组件的prepare→原permit→实际native fixture→原join→持久事实→丢ACK/关闭controller→新实例原ID只读回读→verified/无额外PUT正向；缺事实/未join/authIndeterminate、伪造/错nonce/身份/mapping/字段/摘要、晚到撤权、持久写失败/损坏、当前值同但操作标识不同、原版本变化与并发跨进程反向；text/photo remove均覆盖，replace仅保留当前拒绝及完整后续义务。恢复不要求重新输入或持久化原资料值。现factory生产部署仍拒绝写，低层fixture明确标为终止事实/恢复组件证据，不能声称writer覆盖正向通过。

写前在独占lane中核真实版本/原读证据；持久prepared意图→持久可能派发标记→执行一次原record增量更新，唯一物理写为下方决定5的固定Bitable v1 PUT，必须带exact record-id，禁止create/整行覆盖。原请求必须证明无隐藏写重试；实际fault-wire检查任何原操作的业务修改请求超过一次则STOP，不称command调用次数等于HTTP次数。成功需原operation标记+新版本+patch证据的可信回读，且原native执行/子进程清理已终止；仅值相同、HTTP200、Do返回、取消/超时不结算。副作用/原操作未核清的已可能派发失败持续unknown/占lane；可信原平台明确拒绝且无副作用与原执行终止已证时，保留C的failed分支，不把全部失败永久写成unknown；恢复仅认证owner核原操作证据，new授权不替旧消息/资料operation结算。未派发但草稿已丢失时不自动补值重发。

**决定4：元数据准备与真实资料分开。** 原四项用户填写项不变。缺真实metadata的既有记录只做获准record-only读取，不默认revision=1/collectedAt=now/consent=true。验证修改和照片的受控样本由资料负责人明确授权；如用Demo新建测试记录，必须标为测试输入，collection/用途/版本/operation源来自其真实创建/授权事实，不能伪装过去提交或真实访客。必要add-only系统列先预览实际目标/字段/权限后按既有授权执行；命中CLI高风险确认则按skill停下请求最终具体确认，不能静默--yes。没有样本/权限时保留真实覆盖缺口，不以全拒绝通过。30天/本人删除，不部署自动删除、不为演示扫描真实访客或自行删外部记录。

**决定5：照片和文本共用一次固定原记录PUT。**


保持C的RegistrationPatchCommandV1/ResultV1、真实field-ID映射、原operationRef、同record lane、先持久意图/可能派发、最多一次业务修改及failed/unknown/verified恢复合同。将工程方案中的一次原record PATCH/record-upsert物理实现替换为**固定单record Bitable v1 PUT**；“patch”继续表示只改出现的字段这一逻辑行为，不要求HTTP PATCH。产品/Task/写矩阵不变。

该唯一PUT body严格是 `{"fields":{...}}`，仅有原受控命令涉及的物理field-ID及宿主拥有的必要已映射系统字段。文本按该v1接口的相应原类型编码；可选意向清空用null。照片remove把照片字段设null，并按C清除必要photo revision/digest、失效旧验证；replace仅接受已核同Base用途/上传证据的单个确切file_token，编码为单项附件数组，并与实际宿主派生photo/profile版本、摘要、profile_operation_ref及同命令文本一起放入这个fields对象。缺元数据/证据时派发前拒绝，不猜版本/token/摘要。未出现字段不发，不写phone/purpose/Visits/确认或整行。

严禁按名称降级或自动从ID换名称，也不把原V3 CellValue形状直接塞给V1。若严格ID寻址能力尚未知，该生产写路径明确不可用；它只有在同一受信AuthContext/实际Base/table/mapping及相关字段上取得真实field-ID写入/回读能力证据后才启用。证据不能来自owner布尔值、SDK类型、offline fixture或模型自述。真实有限窗口由主Sol准备与安排，执行者当前业务预算仍0。真实窗口若否定field-ID单请求路径，保留准确结果再由owner决定，不自行回退多POST或名称寻址。

原v3记录读取/矩阵可继续用于同Base原记录的严格field-ID回读；同Base/app_token、recordId和字段类型对应必须核实，不凭相似字符串关联。V1写响应只在私有适配器内解码，逐项核原操作与原记录关联，并通过原版本/操作标记及受限patch证据回读结算；不把HTTP200/code0直接称原操作verified，不向公开路径返回完整Fields或敏感URL。若出现忽略字段/混合响应/原操作证据不足，保持原unknown/lane，不补发第二写。

### 无照片目标首次填入的系统版本来源

照片可选，合法的原目标无照片时仍应支持首次填入已核授权附件。目标必须来自factory原私有读取证据，真实profileRevision为可安全+1的正整数；原照片严格为null/空数组，已配置并实际读到的photo_revision/photo_sha256均为空。unknown、多附件、残留元数据、缺字段/映射不能等同无照片。没有真实profileRevision仍拒绝，不以Demo响应rev、时钟、默认1或源附件版本补值。

原SDK owner专用用途动作、实际核验源附件、原operation/readRef、两侧授权和版本重核全部成立后，首次填入的新photoRevision确定取本次已核目标profileRevision+1，同一单PUT也写下一profileRevision、实际源字节摘要和原operation标识。这是本次受控写对自身已拥有系统字段的前瞻分配，不是推测缺失的旧照片版本；原资料版本必须来自真实原记录。已有照片替换继续原photoRevision+1并拒溢出；移除仍清photo revision/digest，随后再填入沿相同空目标规则。照片身份按profile/photo完整tuple核对，不引独立计数器/历史表或新服务。

目标photo状态及元数据须由原解析/投影的内部事实产生，不能增加owner自报empty/ready/version参数；source/target句柄、一次性证据、MAC/permit/lane、实际body/effectHmac、撤权/冲突/unknown/恢复和writer覆盖要求不变。当前部署覆盖未证时仍拒派发，新分支不给native或真实操作额度。必要Node检查覆盖首次填入/移除后再填、拒复制源版本、缺版本/未知照片/残留元数据/溢出、原引用与撤权/版本变化及已有照片兼容。源依据及root接受决定见W/main-core-readiness-acceptance-54/acceptance-report.md；不改C公开DTO/版本、Base schema或账本格式。

## 原生执行与失败不变量

任务自有受限native只新增该明确动作的PUT方法与精确绑定路径/有限fields body，不能开放任意PUT/URL/Base/record。原JSON1MiB/连接8MiB、正常TLS、user-only/冻结配置、原DPoP、禁连接复用/H2/redirect、原进程收尾和物理业务请求上限1保持；认证有限辅助请求单独计数。原固定源码/保护/可复现patch/清单不变。不加载通用CLI、旧shortcut的隐含字段查询/多步写、自动上传或创建。

logical operation仍只产生一次可能副作用的业务资源请求；所有原操作持久标记、撤权/迟到值丢弃、两进程record互斥与managed writer覆盖、真正明确无副作用拒绝和unknown原ID核对保持。无rollback/compensation/多步photo事务，单PUT编码不另建journal；持久化版本按决定3的schema2，不建第二DB；接口文档的读写一致性检查不冒充平台CAS/跨管理员事务保证。


#### 数据与接口

C是RegistrationConfig/VisitorRef/metadata/readiness/patch/outcome的唯一schema。私有控制协议 `registration-private/1` 的严格JSON动作：

| POST路径（统一/api/dsh-livestream/registration/） | 有限输入与结果 |
|---|---|
| authorize | 当前configRevision、exact VisitorRef、目的/动作选择；宿主核owner/执行主体/映射后给private grantRef与本次允许动作。grantRef只索引原Peer+组件权限，不是Bearer权力。 |
| live/read；robot/consume | grantRef、稳定requestId；宿主选实际组件，无可自报audience/role/任意工具。结果为C私有结果及受限执行关联。两个组件各自真正执行原读。 |
| patch | grantRef、稳定operationId、expectedRevision、C patch；先验证/审阅，进入共同lane；响应只代表已证事实，不把accepted当verified。 |
| operation/check | 原operationId/授权关联；核原证据或保留unknown，禁止换键重发。 |
| revoke | 定向原grantRef/原配置代；阻止新派发/交付，原写事实留原operation。 |

请求体上限、stdout/headers/body/附件、子进程与响应超时由实现统一常量固定并以边界检查验证；不能无界读流。默认 JSON 控制/CLI stdout总量≤1MiB；原生HTTP JSON正文≤1MiB、连接读取≤8MiB。单次业务软结果预算30s，原 invocation 总生命周期≤120s，SIGINT后按决定1A保留原同步UAT有限收尾；8MiB等照片约束仅引用C。不用超时证明native进程/网络执行已结束；所有任务所属pid/stdio/abort清理必须join，未知写lane不因清理释放。原SDK Fetch只给Request，另用admit捕获真实Peer；不信任HTTP自报身份头。失败只返回受控code/私有恢复信息，原错误中PII/配置不外传。

附件元数据通过同一frozen native Context。临时URL取固定官方drive batch_get_tmp_download_url接口，仅允许exact token和已核extra，拒绝任意URL/通用HTTP。CLI实际支持raw api escape hatch已通过本机help核实，typed drive media命令未提供（其--help仅回到drive父帮助，不能算该方法存在）。HTTP路径/参数和平台权限及无需额外credential的下载需实际验证；只读URL仍是敏感能力，不入settings/log/SSE/普通模型。Node HTTPS读取禁redirect，拒绝非预期平台下载origin、IP literal/private/loopback/不受信DNS目标；检查的解析地址须固定为该次实际TLS连接地址并保留原平台hostname/SNI，不能预检一组地址后再次未受控解析。流大小/时长有界；下载失败不能改成无限制native落盘。照片正常/无照片/受限/坏图等按C分开，再读原record版本，不把转换后尺寸当原图。

#### 质量、风险与覆盖

| 产品场景 | 设计/Task | 必须证明 |
|---|---|---|
| SCN01–06 | authority/artifact/executor/双consumer；T001→T002 | 保存零业务调用；真实owner/nonowner；双侧同版本同R各自原读；record-only/no-photo/metadata/photo分层 |
| SCN07–12 | coordinator/metadata/原operation；T001→T002 | 有意义原值修改+两侧新读；旧新writer跨进程竞争；外部冲突；rejected/unknown/恢复；Robot零写 |
| SCN13–18 | capture/revoke/私有交付/版本/附件；T001→T002 | 每await后撤权；跨主体晚到值零交付；公共工具/Stage/TTS/SSE零私值；旧v1/Visits不变；真实保留来源 |
| SCN19和SC5 | 原Drawer；T002 | 375/1440、键盘焦点标签、分项状态、草稿/unknown恢复与撤权清屏 |

主要风险为native发行与固定来源差异、配置引用可用性/DPoP、隐藏write retry、下载URL权限/来源、旧writer实际派发覆盖、metadata与真实运行输入。以上均是Task前置或必要验收，未通过时只读/写入分项如实不通过；不减产品保证。回滚只关闭新能力/卸载新模块，保留unknown和原账本，不回滚旧dirty、删除数据或覆盖lib。

### 实施计划

**规划基线**：L codex/macos-yovoice@6eb5e3b17a295e7af27a000e98ee1ee1ee679fe6；Q父仓codex/dsh-t1-bridge@6e0ffd99d70554e5560f442edf79d50fd9f06867，均dirty。日期2026-11-13。相关现状/摘录由主Sol核读：L agent.ts:96–195限制可信registration，index.ts:313–334 credentials；Q onsite-agent.ts:260–263单effect，journal/worker.ts:17现有node:sqlite，host/fixture.ts:832仍unconfigured；其余直接源manifest见前置分析及main-executor-binding-11。派前补全对应Task相关输入manifest并复核，不以HEAD或他人旧测试代替当前字节。

技术栈沿Node/TypeScript/React、原DSH0.2.2-rc.1、现有esbuild/formatter、Node内置SQLite、Q已安装sharp；新schema是控制账本，不另建访客DB。所有既有lib/lib.previous、真实配置/凭据/照片/原数据、共享端口和Q设备/旧合同保护。

按用户2026-11-14“加速实现到测试验收阶段”的指令，最早读取增量由FEAT-009-T003先交付：原Drawer对owner明确授权的无照片R调用L与Q私有组件，各自原读，显示record-only或有源ready_no_photo；不等待T001写者覆盖/照片replacement来源两项局部STOP，不等DM或T1。T001与T002的原完整写入/照片/恢复条件全部保留，不将T001假记done。T003复用现有实际SDK私有读取端口并负责该端口到原Drawer的完整软件检查；最终真实平台消费仍由正式验证取证。共享index/runtime/console继续与公屏串行写入：T003可先在固定隔离副本完成界面，root收到公屏最终发布回执后才开放原位置合入和匹配检查。T002复用T003的设置/授权/读取界面，继续有意义修改、照片与完整失败旅程，不重复实现一套读取面。

原共享usage在L/examples/macos-yovoice/README.md，更新同一个配置入口故事、参数来源（真实workspace/固定artifact/selected profile/Base映射/确切record/私有grant）、显式业务动作和unknown恢复。没有新增独立后台/通用CLI教程/公开资料工具。所有新增程序/runner命令在实现实际建立并核help/运行后记录，不捏造已存在入口。

### 工程任务

#### FEAT-009-T001：受控资料执行核心、共享artifact与独立Robot私有host

**单一可验证交付**：可由真实SDK Context装配、带严格authority和真实native适配入口的固定版本共享artifact及L执行核心；完整core功能有匹配的离线组合/故障证据，不以类型定义或局部stub声称真实Base消费。

**允许源码**：Q/skills/visitor-reception/references/registration-profile-v1.md、config/registration-profile-v1.template.json、src/feishu/registration-profile.ts；Q/skills/visitor-reception/SKILL.md和docs/robot-task-v1.md §7仅append-only；Q/src/registrationProfile/**、tests/registration-profile/** (.case+自有config)、scripts/build-registration-profile.mjs；L/packages/dsh-livestream/src/registration/** 与test/registration/** (.case+自有config)。新输出只在caller-owned全新目录。暂存/类型核对完整后原子发布新增单元，不能让在途公屏tsconfig看见半成品。

**禁止**：所有旧Q parser/config/access/roles/Visits/Agent/RobotJournal、package/build/exports/index/runtime/lib、设备和用户材料；L既有index/runtime/agent/Drawer/build/package/lock/test配置不写；publicChat目录/工件不读写；无lifecycle/Git mutation/共享服务操作。主Sol只经新证据决定完成，不由实现者改state。

**实施与必要检查**：先完成决定1A的固定派生 native 构建/响应与连接限量/禁止重放/user-only可达性及取消收尾，再确认不可变配置引用、原签名路径、原profile/global effective strictMode继承及user-only交集和严格固定调用白名单可实现；然后按C交共享parser/read/patch/receipt、原图verifier、L authority/adapter/coordinator、同版artifact loader与Q私有host。必要检查包括真实SDK owner/nonowner/crossPeer、两consumer分别调用原executor、native错误profile/并发配置变更不串主体/DPoP不降级、严格矩阵与stdout边界、两进程SQLite同record互斥、原intent/dispatch/unknown/恢复/损坏/路径别名、原native子进程取消/join、实际HTTP写重试故障、URL/流/图像边界、两个合同版本、旧v1严格parser/单effect工具兼容。

本Task默认全离线、协议替身/内存TLS/Task-owned临时目录，无真实Base/行/附件/schema/模型/TTS/抖音/设备请求。需要真实Feishu身份元数据证明native可用性时先向主Sol返回具体单次只读命令、当前token状态/可能副作用及有限调用计划，由主Sol沿已有授权审计；不得自行读出凭据或启动登录/刷新/真实probe。没有真实证明就明确该覆盖NOT_RUN，不声称真实账号已接通；纯软件core完成与Feature真实验收分开，原标准不减。

**命令与完成判据**：两仓现有typecheck/check入口＋新专属.case runner/隔离builder（实现后记录实际argv）→exit0；格式检查按本仓现有配置→exit0；真实SDK/跨进程/写fault-wire/构建解包消费检查→相应正向与必要反例均满足。受限派生 native 当前未证行为必须给能复验的证据/明确剩余真实前提，不能用root源码选择或本次help当runtime PASS。sharp版本/ABI/加载和许可证进入manifest，禁止只编.d.ts或将external依赖称自包含。

**STOP**：不可变引用配置不能保留原凭据主体/签名，需plaintext导出或越权改真实配置；写实际自动重放无法关闭；附件路径需绕过既定受限来源/资源；C语义/元数据或受管writer需未获源码变更；无法完成完整匹配离线核心检查。按已有非收敛规则回报，不能降产品保证或新增重试诊断额度。

#### FEAT-009-T002（依赖T001）：原Drawer/真实宿主接线与同Base完整消费修改旅程

**可验证交付**：原产品入口实际装配L/Q私有组件，完成无照片双侧读取、一次有意义原资料修改并双侧新读、正向照片与必要失败/权限/恢复。软件行为及真实外部证据分别归因，不能仅用fixture/UI成功或metadata配置PASS结算。

**允许既有局部（主owner串行分配后）**：L src/dsh/index.ts必要import/inject/apply/dispose及专用私有路由；runtime.ts非敏感registration Settings load/save/schema局部；console/console.tsx原Drawer插槽，新console/RegistrationSettingsPanel.tsx；L/examples/macos-yovoice/README.md相关usage。新增专属测试/独立E2E入口在test/registration/**。原robot/sourceKey/tuple/课程/attention/公共Agent工具/Stage不改，Q旧启动仍不写；如果T001后真正需要额外既有位置，给精确依赖后由owner协调，不静默扩范围。

**依赖**：T001接受；公屏与其他writer在上述共享输入上的必要完整检查结束并实际交回；当前实际profile writer注册/派发约束核清；真实运行前准备exact R/附件用途/metadata来源及必要schema预览。没有授权的真实样本就保留该真实验证缺口，不造人/扫表。与公屏元数据新增不同，此Task改35个T02保护输入中的指定文件，必须先给当前真实字节/语义变化范围，不以刷新旧聚合掩盖changed inputs。

**顺序**：先接settings/保存零副作用，再native身份/权限/无照片原R双侧真实读取并及早展示；同Task继续metadata受控准备、文本patch/双读、照片验证及移除/受限替换、撤权/unknown/版本/公开隔离/访问性。构建输出隔离，启动/浏览器/任务端口全自有、结束核清理；不自动重启共享服务。必要真实动作在主Sol审计的具体有限窗口执行，CLI高风险或缺业务输入按skill处理，非逐编辑审批。

**必要验证**：生产设置保存/GET回读、真实SDK owner/nonowner、完整原Drawer 375/1440/键盘/焦点/标签与分项反馈、原模型/Stage/SSE/TTS零私值、同artifact两侧真实消费、旧场景回归、真实元数据/原operation/值改变与两侧新值/照片原字节证据、并发和unknown恢复的适用离线与真实覆盖。命令采用仓库既有check/test/e2e与新独立runner已实建入口，均记录实际exit/相关revision；自动测试不能替代真人权限/原样本证明。正式独立Validate/Review/Ship仍按生命周期执行，绑定最终业务commit；无commit/push当前授权，不能伪造正式完成。

**STOP/完成**：共享写窗口未交还或实际source drift改变契约、native/auth/元数据/URL假设被否定、真实权限缺失、需额外写范围；安全失败保留结果和可用读取，不把Feature改成只读交付。只有本Task范围及必要检查/真实前提都满足才请求done；否则incomplete，完整需求保留。

#### FEAT-009-T003：原Drawer同记录四字段私有读取增量（读取先行）

**独立交付**：保留一个现有Drawer入口，owner保存非秘密配置引用而零业务调用；显式授权exact record后，由Live私有组件和Robot私有组件各自通过固定同版artifact/原executor读取同一记录，显示四字段允许的私有投影、无照片及metadata pending的真实分项状态。只读路径不依赖共同写者闭合或replacement producer；没有照片/写入不影响合法record-only读取。本Task不取得patch port，不注册公共Agent工具，不经过公共turn/SSE/Stage/TTS，不签发现场识别或旧Visits权限。

**依赖与保留**：run08中真实SDK双组件、两个独立解包副本、现有workspace executor的Node子进程替身已有有限证据；本Task负责最终读取路径的真实组件/界面装配与匹配检查，不能以旧组件通过替代。T001的全部署writer、合法replacement producer、持久恢复及完整核心义务保持；T002的修改/照片/完整旅程保持。原segment、失败历史和唯一诊断额度不重置。该Task按读取功能独立安排，无T001完成依赖；公屏共享源码交接是原位置合入的必要条件，由root控制，不伪装成跨Feature Task ID。

**允许范围**：隔离实现只在W/feat009-read-increment-40/**，先读取固定只读基线，不复制cache/node_modules或读取其他在途源码。P=L/packages/dsh-livestream；未来原位置串行窗口内仅P/src/dsh/index.ts的registration私有路由/import/inject/apply/dispose、P/src/dsh/runtime.ts的非秘密registration设置、P/src/console/console.tsx原Drawer插槽、新P/src/console/RegistrationSettingsPanel.tsx、P/src/registration/**的读取装配必要局部、P/test/registration/**和L/examples/macos-yovoice/README.md相关usage；不改变写协调/store/permit/native协议或publicChat。Q本Task不写，复用已固定artifact与私有consumer；不改旧接待、Robot Agent/effect边界或安装输出。新增namespace先完整类型/组合检查后再原子发布，既有文件按实际公屏交回基线定向合并。

**标准构建资产补齐**：实际隔离标准构建确认native校验器位于lib/index.js并读取lib/nativeCli/registration-native，原P/build.mjs仅构建JS而未复制该固定资产。T003负责在W副本实现P/build.mjs的最小宿主资产复制修正；未来串行源码窗口仅增加该文件的这一局部。非--client构建把已锁定的现有native binary及必要LICENSE/NOTICE放入实际outDir/nativeCli，复制前后核固定摘要、普通文件/无链接及部署用户归属，完成后binary与目录均保持0500只读可执行；不执行或重建native，不改验证器的固定身份和拒绝条件。资产目录在自有输出内完整准备后原子放置，构建失败不发布半份资产；重复完整构建须可处理自身旧只读资产，禁止宽泛chmod/清理。--client不改宿主binary，DSH_LIVESTREAM_BUILD_OUT隔离语义和默认构建入口保持。当前安装lib/previous不写，实际安装由后续已授权发布步骤承担，不因这次复制修正开放共享输出。必要检查包括准确相对定位/摘要/权限、重复构建及缺失/错误摘要/链接拒绝，均不运行native。此为现有读取所必需的构建支持，不新增运行时协议/公开API。

**必要检查与完成**：真实SDK owner/nonowner/未认证；保存零鉴权/读取；两私有组件各自原executor读取并核record/mapping/subject；无照片和metadata pending合法展示；撤权/切owner/配置generation变化的迟到数据零交付且清私值；公共输出零私值；375/1440、键盘标签/焦点、加载/拒绝/未知状态、重复点击和恢复；受影响typecheck/formatter及既有相关回归。构建/解包/执行入口与最终源码摘要必须匹配。只完成隔离界面但原位置未合入时仍incomplete；完成本Task不关闭整个REQ012。真实身份/平台/记录验证与软件替身证据分开，当前业务预算0，无原账号调用。

**顺序与资源**：沿同一原Terra串行接续，无新实现者/评审/模型probe。原run8已interrupted/activeRunId=null/no pending，无所属writer；保留其未规范化完整结果/未检查项，不称完整通过。原185分钟native预算仍结束，无native执行/构建/获取；Node实现与必要UI检查沿已有工具依赖，所有旧登记及新读取产物合并同时占用上限仍4GiB，不以新目录重置上限或失败历史。公屏原位置发布期间，本Task只用已固定副本，不跑L变更中完整检查；root给实际稳定输入后完成串行合入及最终匹配检查。

## 实现记录（实际）

T001已由原Terra完成两轮暂存增量，当前incomplete，未向L/Q发布源码；90项暂存/工件清单已核0差异。原2MiB native响应在parser之后才被stdout限制的失败证据保留。主Sol接受本次决定1A及既有合法Task登记不构成软件通过。当前源码进度以state.json和实际dirty内容为准，不能把前置分析当实现。Q共享规范从C的schema/权限/行为核心发布，历史状态/未来窗口说明只作为来源记录；Q不实现写协调或Robot写入口，有限patch的真实执行/统一coordinator属于L。

## 验证记录（实际）

正式Validate及真实身份/原记录/附件消费/修改均NOT_RUN。暂存24项初始检查、旧v1 12项/Visits14项及双Cordis合成读取只覆盖对应局部；原结果在W/feat009-t001/staging-result.json与run02/continuation-19-result.json，新native路径全部构建/故障验证尚未执行，不作为完整core通过。必要检查和未证前提见Task，正式验证仍绑定最终业务commit；当前无commit/push授权，不能以阶段准备伪造验证版本。

## 评审记录（实际）

一次独立Sol工程候选检查已完成：W/req004-preparation-01/main-plan-review-13/findings.md，1项P1为effective strictMode继承缺项；主Sol核原源码并在决定1及T001反例中完整处置。59个其他实读输入与主验收时匹配，soul.md随后变化已由主Sol重读（8af5fa4b0175492bdad680de7ff6dd620d92ab68b4f40666f0337720fcf5623b），其Goal局部停止规则不改变此接口发现。原候选、发现、证据及变更diff保留；不追加第二轮检查。该检查不是正式SDLC Review，后者未执行。

## 发布与观察记录（实际）

未发布、未安装或覆盖lib。产品观察计划唯一引用REQ-012对应段；后续技术发布只记实际版本/适用证据与缺口，不另建产品指标。主Sol接受、候选前后diff和具体CLI结果见W/req004-preparation-01/main-plan-acceptance-14/。

原生响应边界两轮协议检查及主Sol处置见W/req004-preparation-01/main-native-disposition-21/decision.md；代理候选拒绝，第二轮4项实质发现已逐项修正方案并向用户说明，不做第三轮。原finding/失败/segment/未用主诊断保持，本次仅更新有效设计。

### 2026-11-14 主Sol接受单记录PUT的执行路径修正（Build继续，未验收）

固定base/v3 shortcut附件限制与官方Bitable v1单记录增量PUT支持的来源、实际公开文档及未证field-ID/账号能力见W/req004-preparation-01/photo-write-source-27/decision.md和source-evidence.json。仅替换物理写方法/编码，C逻辑patch、原operation/lane/unknown/单派发、产品/Task/写矩阵不变；无多POST补偿事务/名称fallback，未增加native或真实业务额度。原全部未完验证/失败保持，T001未验收。

### 2026-11-14 主Sol明确后续native收尾资源

依据run04产物287项核对、原2GiB触限/终止记录、post-window-inventory01.json合并2034737013字节（余112746635字节）及本次单PUT改变必要验证输入，root将当前有限native批明确为额外45分钟/累计110分钟、合并同时占用3GiB、仅现有离线缓存；原失败/窗口不重置。磁盘只读df显示约736GiB可用，本资源变动不触碰共享服务/真实数据或付费资源，不加真实业务额度。前后diff和CLI记录归W/req004-preparation-01/photo-write-source-27/resource-revision，产品/Task/写矩阵及单请求保护不变。


### 2026-11-14 主Sol接受run5局部进展与有限native收尾安排

run5仍incomplete，未发布L/Q源码。单record PUT、照片remove/replace编码、SQLite与实际派生native的早期读写/回读/unknown组合和可复现binary有实际进展；最后dispatchPermit修改后的native全链尚未运行，不能引用先前photo08为最终代码通过。临时URL固定动作/token-extra查询约束、具体私有host/共同writer/照片来源适配及全部匹配交付检查仍待齐，不用布尔callback或fixture冒充部署或真实平台能力。root只读核13,864项staging/run05清单0差异、working源3362项相对固定3352仅原12项差异、71项较宽认证/keychain/token源码保护均未变；原任务terminal且无所属写入进程。证据在W/req004-preparation-01/main-native-completion-31/。

root明确新增一次60分钟native窗口（累计已授权170分钟）及合并同时总上限4GiB，仍仅现有离线源/锁/cache、单并发、原工具链和零真实业务。依据为run5两次3GiB终止、最后凭据改动使组合证据不匹配，以及尚未实现的既定固定临时URL动作；不是重复运行同输入或按时间自动续额。root对全部任务内普通文件不跟随symlink的本次完整统计为2,434,288,693字节；worker较早cleanup统计2,012,438,601字节保留为其原口径，不混称同一统计。新批按整个W/feat009-t001根内源/cache/output/证据普通文件口径计数，启动前留峰值余量；磁盘只读df显示超过700GiB可用。旧3GiB和此前2GiB终止/清理/窗口均不追认为合规。到限不拆批或自行续额，独立原core工作仍可继续。

当前产品、全部Task/依赖/写矩阵、HTTP/原认证/DPoP/单业务写/unknown与照片保证不改；未增加自动上传、凭据导出或任意URL/方法。native收尾与最终匹配验证不能替代真实field-ID/权限/上传来源及平台观测，这些仍未证明，不能启用真实写或以永久unavailable验收完整功能。同segment/全部失败/唯一主诊断未用保持，不新派执行者/复审/模型probe。


### 2026-11-14 run06接受停点及原恢复义务收尾

主Sol只读核11,193项最终清单/成员、35个T02保护输入、lib12+previous8及71认证源均匹配，run06仍incomplete。全部署writer和replacement上传producer两项局部STOP保持；进程内WeakMap/receipts Map尚无持久原执行事实，不能以新进程/当前相同值清unknown。完整证据W/req004-preparation-01/main-run06-acceptance-34/。Disposition35据此补决定3的schema2元数据/终止事实/effectHmac/原ID只读恢复及现有fixture的有限验证；产品/Task/写矩阵、原四字段/隐私/单PUT/认证/unknown保证不变。本轮不发布L/Q、不给共享旧文件写权，不关闭writer/照片STOP，不重置失败或使用主行为诊断。

### 2026-11-14 主 Sol 接受 T003 私有读取离线增量

T003已串行合入实际L，主Sol接受原Drawer→真实SDK私有路由→Live/Robot独立读取组件与固定profile子artifact的离线软件交付。53项源码、10条实际命令结果/日志、23项标准宿主source-map输入及131项artifact成员匹配；完整类型/相关格式/标准构建与375/1440界面检查通过。native源与构建输出固定摘要相同且未执行；读取中的外部进程为Node合成替身，真实账号/Keychain/平台/照片仍NOT_RUN。无可信consent/collection时保留record-only / metadata pending。接受报告与root审计：W/main-t003-acceptance-42/acceptance-report.md、audit-result.json；原命令及最终源码清单：W/feat009-read-increment-40/integration-02/final-audit.json。仅T003由root CLI置done；T001/T002/REQ012及后续独立Validate/Review/Ship未完成，未安装共享lib、未发布Q。原失败与主诊断未用保持。


### 2026-11-14 主 Sol 接受真实合成记录双组件读取增量

root 已审阅原 run12 准备并亲自执行一次固定真实 native 的有界读取窗口：Live/Robot 两个原私有组件各自 user_info→record_get，恰四个进程均 exit/close 0，原 app/user 摘要匹配；同一合成记录三个文本比对 true、照片 absent、metadata pending、submission unverified。保存/授权零 spawn；从开始后 21.05 秒内已观察到全部结束，五个所属 PID/四进程组无残留、私有临时目录已空。当前 SDK14包/1116文件执行前后匹配，原固定 native 与 profile artifact 摘要未变。准确 argv/CWD/env、结果、资源与 root 最终接受报告见 W/main-real-read-acceptance-51/。

这是任务内真实 SDK owner 和两个私有组件到真实账号/飞书的读取证据，不等于共享 Harness 已安装、实际 Robot Agent 对话消费、原访客提交或照片用途已核实。平台物理请求次数/DPoP细节未观测，认证可能正常刷新原存储；仅此次 root 操作，执行者真实预算仍0、原185分钟fixture窗口不恢复。T001全部署受管writer覆盖、照片专用动作真实入口、系统元数据来源、完整发布及最终匹配，T002和正式Validate/Review/Ship仍未完成。当前有效方案/范围/Task状态不改；本段仅接受新Build证据，并由root显式刷新已有Plan指纹，不补FEAT008的missing历史。
