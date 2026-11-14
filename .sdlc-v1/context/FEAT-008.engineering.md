# 工程上下文：FEAT-008 公屏最小接入

## 当前有效方案

### 架构设计

关联产品上下文[REQ-011.product.md](REQ-011.product.md)。本文是唯一当前有效方案，主Sol已接受冻结实际HTTP认证方向及其标准库/commit/连续Write修订；历史候选与报告只作证据。state仍原主线程唯一串行CLI写入；T001未接受、T002依赖未满足。

#### 背景与复用决定

保留现有LiveSource→Hub/Attention/Topic→Agent/TTS/舞台。原受控浏览器写入已因采样Cookie ABA无法满足认证替换失效保证停下；不再用BrowserContext作为实际写入认证载体，不把缺完整通知改成更密采样。原同文echo/输入框提交不作为HTTP回执。固定DyHub 3a79c57d85c59289db3b77211b3ec01fae47d42c仅在git archive自有副本复用既有raw回调；原D/匿名实例/WIP不动。

实际写入为独立私有Go helper的冻结认证HTTP请求。复用yunsur/douyin-mcp@7e90d139007f141cb7389aa509d8e6e67f7b5840的固定端点/查询顺序与四个MIT纯算法；不导入其可变Client/MCP/登录/后台MsToken/WebID/Set-Cookie吸收或挑战重放。实际transport仅Go标准库，TLS指纹库调研已拒绝进入此方案。API为非官方网页接口，不宣称官方开放API；没有当前账号/API成功实证，缺完整材料/绑定一律不可用。

#### 组件与权限

src/publicChat包含Node固定目标Controller/Client/v1 sender/Authority/journal、helper及协议/可复现构建支持、raw证明/自动策略/受限Agent工具；T002才装配真实owner与Drawer/Agent。sender-only entry不加载原DyHub buildApi，不存在旧chat/任意rooms/connect/Cookie/login写入口。外部仅固定数字loopback、受保护部署token、精确构建身份与原nonce，无开放CORS/重定向；缺装配拒启动。登录维护另显式流程，保存设置零登录/连接/发送/开播副作用。

accountRecordId只代表本地记录，不能证明主体。主体来自实际冻结Context的HTTP响应；模型/普通settings不能选择URL/账号/UID/role/材料、伪造控制快照。helper固定账号/room与受保护部署装配，正常OS同用户全部凭据已失陷不在本任务防御范围，不扩建通用认证系统。配置只进原dl-* Drawer，无第三方平台管理/登记/私信行为。

#### 不可变材料与真实主体

##### 不可变认证材料

受保护部署配置仅含credential resolver引用/0600文件引用、helper/build清单摘要、固定预期principalUid、固定web_rid。普通settings/模型无账号、URL、材料字段。Node只在显式owner维护操作解析引用、安全打开文件并把只读继承FD传给唯一helper；helper一次读取、校验并深复制到私有未导出结构。材料不经argv/env/日志/journal/v1响应传输；IPC不提供读取、编辑、补字段、重新加载或任意URL指令。

材料来源必须是该发送账号一次受控维护的完整导出/安全提供，不读取私人Chrome profile，不从现有匿名D复制Cookie，不扫描真实配置。本轮不实现登录/读取真实材料；缺材料显示unavailable。来源说明/维护代标记本身不证明身份，仍须下面同Context实际HTTP采证。

最低字段：完整且带来源scope的Cookie集合、冻结UA/浏览器几何及指纹参数、固定msToken/webID/verifyFp/UIFID等被采用算法实际需要的值、Ticket/TsSign/PrivateKey、live CSRF材料（origin/path/关联维护代/有效期）、明确选用的BD签名模式及所需服务器证书/派生材料、有效期。密钥格式、公私钥/证书可验证关联做本地校验；无法仅靠格式证明Cookie/Ticket属于同账号，跨材料关联实际有效性保持平台NOT_RUN，不把配置标签当证据。缺项不随机生成、后台刷新或降级另一算法来“成功”。每请求timestamp/随机nonce/签名计数是从冻结材料派生的请求数据，不能改变认证Context。

**Cookie scope先取最窄可证明子集：** 首版只接受显式Domain=.douyin.com、Path=/、Secure且同时合法覆盖www与live两个固定HTTPS目标的材料；拒host-only/其他domain/path、partitioned/不明scope、重复同名与冲突、控制字符及过期值。保留httpOnly/sameSite/expiry元数据并严格校验，不将只含name=value的header当作有domain/path证明，不用map静默覆盖重复。构造一份确定顺序的完整Cookie header，在profile与chat两个origin使用完全相同字节；全部Cookie元数据与设备材料一起入私有digest。若真实材料需其他scope，先STOP给主Sol来源/字段事实，不能忽略scope后声称同主体。此严格子集的真实账号可用性未验证。

helper生成随机authContextId、helperProcessNonce及只对该维护代有效的materialDigest（可使用进程私有盐避免跨部署关联），不得采用caller给的context ID。材料内容无setter，getter只给摘要/ID；构造后不再读取文件/浏览器Cookie/resolver。Jar=nil且禁止SetCookies/响应吸收，任何Set-Cookie仅是未应用的响应建议，不是实际认证替换；后续wire仍使用原材料。若服务器要求新材料，停止资格并进入owner维护，不自动续期。文件在磁盘A→B→A而未执行显式install并不改变已冻结wire；真正Context install即使同内容或失败都属于下面的认证变更。

##### 认证变更权威

Node SenderRuntime是唯一维护入口；同进程串行执行`beginAuthenticationMaintenance`：在任何await/读文件/解析/启动helper前，同步失效资格、authorizing/active grant、旧队列和旧sourceKey续体，推进authContextRevision，建立原grant/Context撤销事实。即使后续读取/验证失败或内容相同，旧代永久无效。保存开关不调用此入口。

随后targeted请求helper失效原Context/原grant，等待原ID/nonce可信ACK；不先启动替换写者。原helper活执行仍占单在途，不能用新Context接管。维护未获得原终态/取消证明时控制hold保持；原消息unknown也不因helper退出、新nonce或上下文替换解除。完成后只构造新ID、显式采证/授权，不从相同材料digest找回旧对象。Node在helper exit/IPC断连回调中同步废弃全部旧grant并推进连接代，恢复新helper也不恢复grant/队列。

##### 同一Context身份核查

helper的profile操作只用其冻结Cookie/指纹/签名构造固定profile/self与query/user两个只读请求；禁止页面profile、传入UID自证或另一套Cookie。严格HTTP200、JSON类型/大小/编码/深度、单根无尾随/重复key、明确数值status_code=0；query/user的user_uid必须为无损数字字符串或可按原始JSON整数token无损规范化为uint64十进制字符串，不经float64/JS Number。与部署预期UID完全一致；两个响应若出现身份字段冲突、缺字段/异常结构则unavailable。profile/self的准确UID结构仍NOT_VERIFIED，不能沿用原data.user假设；canonical身份来自已核query/user字段。

证明含authContextId/helperNonce/materialDigest/authContextRevision、原captureId/revision、principalUid、采证时点与schema版本；Node每await后/发布前仍核原ID/代/槽。材料固定不等于登录永远有效，保留原短资格有效窗；账号风控/过期/签名失败保持不可用。实际设备材料和API可用性仍NOT_RUN。

#### 固定房间与raw-only来源

保留L匿名输入、WeakMap、sourceKey/tuple/机器人标记与TTS/课程。只在W固定D受控副本复用现有raw回调；原D服务与WIP不动。该BrowserContext仅是只读raw证据源，禁止旧sendChat/旧chat或Cookie写入口，不能为helper提供“当前Cookie”或决定HTTP账号。

必须区分web_rid与API内部room_id：固定D normalizer.ts:124声明对外roomId=web_rid；proto Common.roomId是uint64。新增最小RoomBindingProof，从固定房间页/原raw Session/已识别push连接的common.roomId无损取得platformRoomId，绑定原rawSourceSessionId/连接代/页URL与当前liveEpoch。只接受非零、单一、一致且新鲜的内部ID；变化/冲突/失连同步废弃依赖grant。不得把普通输入frame自报、用户填的长数字或昵称当映射，不从web_rid猜internal ID；缺映射不授权。

完整grant同时固定`roomId=web_rid`与platformRoomId；HTTP Referer用固定web_rid，chat query room_id只用该证明的内部ID。如何从原raw CDP连接精确关联固定页与push socket，需要在受控副本做最小装配/fixture，不认为仅已有frame.meta自动证明；原proto形状与现有callback已核，实际映射仍待验证。

自动事件继续双来源关联，rawId/type/当前输入代与受信raw来源会话/代次、内部房间、grant精确匹配；首次接收固定原grant，下界max(originalGrant.authorizedAtMs,liveEpochStartedAtMs)，真实Long无损/范围、缺时间拒绝、30秒窗/未来漂移及增量感谢不变。raw Browser Cookie变化不会替换HTTP AuthContext；其连接down/up仍废弃原raw资格及依赖grant，不能用HTTP已认证绕过旧raw来源代限制。真实匿名gift能力仍NOT_RUN。

#### helper协议、授权commit与完整绑定

##### helper所有权与装配

Node独占一个经清单核验的helper子进程；无TCP/Unix socket公开服务，只用继承的stdin/stdout私有长度限定JSON帧，单写者；stderr仅固定错误码，禁止原URL/query/头/原始响应。使用Node child_process.spawn启动已核验的绝对可信helper路径，直接argv、shell:false、显式stdio映射只读材料FD与私有stdin/stdout，清理DY_*及代理等非白名单env；父/子各自关闭归属FD并记录自己PID/stdio/退出收尾。材料FD只来自受控维护入口，核只读权限、安全文件身份及从起点读取的偏移，不将材料放入argv/env或改用可写FD。helper不自行读cwd Cookie文件、用户home或任意材料路径。此处是OS子进程API，不允许创建Agent子代理。不能把同OS凭据拥有者可直接起程序描述为公开API防护，沿原部署威胁边界。

外部仍仅受保护v1 owner/grant routes；helper协议不可由普通HTTP/模型调用。hello需核binary/source/纯算法/transport清单摘要、helperNonce、能力`frozen-http-auth-v1/no-replay-http1-v1/unknown-recovery-v1`；缺/旧能力unavailable，不回退浏览器发送。私有wire版本`dsh-public-chat-http-v1`，旧未发布browser版拒绝；v1 URL路径可保留，DTO显式不兼容，不静默忽略新字段。

##### 最小私有DTO与状态归属

共用envelope为`{protocol, seq, kind, operationId, payloadHash, expectedHelperNonce, authContextId, authContextRevision, materialDigest}`，响应回原引用与明确kind/state。稳定ID跨kind/payload冲突，容量满未登记不是可信终态。无任意URL/账号/room参数；目标来自受保护装配及已固定RoomBindingProof。payloadHash不代替认证。

| 私有操作 | 主要输入/输出 | 权限/时序 |
|---|---|---|
| hello/install | 只读材料FD、固定部署摘要；回helper产生的Context/nonce/digest | 一进程仅一次install；替换通过上述维护/终止旧写者，不提供就地更新 |
| profile | captureId/原Context引用/固定预期UID | 同Context两固定只读端点；重复原ID只返回原采证记录，不隐式重采 |
| bindGrant | Node authorizing槽固定的完整proposal/authorizationId/payloadHash，不含final grantId/authorizedAtMs | helper在实际commit生成完整grant并返回；ACK前Node不得发布可发送grant；原撤销tombstone优先 |
| send | requestId/sourceKey、外层requestHash、完整grant/普通text、固定raw/房间证明引用；helper独立计算textDigest与私有payloadHash | 仅helper登记且当前有效grant；一在途，稳定ID重复只查原操作，不签名重发 |
| revoke | 原revokeId+target capture/auth/grant/Context及原nonce | 同步登记精确tombstone再ACK，不影响后来的无关槽；已writeAttempt不结算消息unknown |
| reconcileMessage | 稳定controlId、原MessageRef、完整facts head/摘要与originControlPayloadHash；严格DTO见下方恢复合同 | 原历史对象核对，不要求旧grant/live当前；helper本原worker joined判定与receipt，零平台请求 |
| query | 原授权/撤销/核对控制或原消息ID+原holder nonce/引用 | 只原记录及核对receipt；空表/not_found不代表未执行，不接任意termination_proof |

完整GrantSnapshot的规范字段为version、transportKind=frozen_http、buildDigest、instanceId、senderProcessNonce、senderConnectionGeneration、authorizationId、grantId、captureId、qualificationDigest、qualificationRevision、identityEpoch、accountRecordId、principalUid、roomId(web_rid)、platformRoomId、helperProcessNonce、authContextId、authContextRevision、materialDigest、rawSourceSessionId、rawSourceConnectionGeneration、rawBrowserContextId、roomBindingProofDigest、inputConnectionGeneration、liveEpoch、liveEpochStartedAtMs、authorizedAtMs。旧browserContextId/senderSessionId/authCookieGeneration不在新HTTP协议里充当认证身份或自动补字段；旧wire不兼容拒绝，rawBrowserContextId仅raw来源证明。identityEpoch表示资格/撤销代，authContextRevision来自实际认证变更权威，两者不混用。Node/helper连接down/up代与raw连接代分开保存且全部精确匹配；L进程标识只在local revision，不能当sender/helper nonce。

L仍先journal稳定authorizationId及完整原proposal/local revision再HTTP。proposal包含原资格、材料/Context/全部目标与live/input/raw绑定，不包含已final的authorizedAtMs或grantId。Node先同步登记唯一authorizing槽、原ID/payloadHash，再向helper发送bindGrant；helper核原Context/取消事实与不可变proposal，唯一authorizing/active槽内在一个无await的commit段生成独立grantId并取当时可信壁钟authorizedAtMs、固定完整GrantSnapshot与原记录，然后ACK。helper是实际授权commit/time权威，不接受调用方预填旧时间；重复原ID/payload只回原完整grant及同一commit时点，跨kind/payload冲突不签发。

Node严格核helper完整ACK的原proposal/ID/hash/helper及sender nonce、材料Context、实际commit字段与当前原槽/revision/raw binding，仍当前才发布Node active grant并回L；L严格核原revision并落盘ACK后才启用。取消/新捕获/断连/重启/迟到ACK只更新原记录，不能恢复授权。helper commit到Node publish之间收到的raw没有current active关联，不可在ACK后升级；pending grant永远不能给raw资格。所有raw首次关联原已commit且Node current的grant，时间下界仍max(originalGrant.authorizedAtMs,liveEpochStartedAtMs)。时钟缺失/倒退/不可信或commit事实矛盾使授权不可用，不以资格采集/预留槽时间代替。

targeted revoke在Node本地先同步禁发/废原槽，再向helper定位原target；只有helper建立匹配tombstone并保证不能新开始相关Write后才回受信终态；ordinary busy/400/503/not_found不清hold。旧capture取消只影响其依赖槽，不能清后来的qualification/new grant。Node/journal负责持久controls/消息最小摘要，不持久材料或可发送grant；helper只内存原ID记录/tombstone/执行事实，不建第二业务DB。明确schema更新，旧schema保留原字节并unavailable，不自动迁移真实文件。helper新nonce/Node重启空表不清原控制/消息hold，迟到原结果只追加原记录。

##### 外部受保护v1路由

state须同时声明显式grant、冻结HTTP认证、no-replay-http1与unknown-recovery-v1能力，私有协议dsh-public-chat-http-v1；旧browser sender/缺能力不能兼容降级。路由如下，所有目标均由可信装配/原保存房间及原proposal固定：

| 路由 | 请求 | 响应与语义 |
|---|---|---|
| `GET /v1/state` | 无目标参数 | 原固定实例/nonce/资格状态，加显式grant能力、当前授权槽摘要；不能作为原授权已撤销证明。|
| `POST /v1/qualification` | 稳定captureId、预期sender nonce | 原采证结果加captureId/身份revision；只产生qualification关联，无grant。通过实际冻结AuthContext固定两只读端点采证，每await后/发布前核原F2 revision；资格开始/失效也使依赖它的旧grant失效。|
| `POST /v1/grant/authorize` | authorizationId、expectedSenderProcessNonce、qualificationToken及其captureId/摘要/代次、完整原proposal（无grantId/authorizedAtMs，含helper/AuthContext及两种room ID），本地revision关联 | `authorized`返回原ID、payloadHash及完整GrantSnapshot；或结构化rejected/pending/revoked结果（rejected的可用证明条件见下文）。grantId由helper在实际commit生成，不能等于qualificationToken。|
| `GET /v1/grant/operations/:operationId` | 原authorizationId、原revokeId或message_reconcile controlId | 受信、明确kind的原控制记录：完整引用/payloadHash/原nonce、状态与已登记快照/撤销tombstone。not_found=未知，不等于未到达或已撤销。|
| `POST /v1/grant/revoke` | 稳定revokeId、原sender nonce、target。授权撤销target含authorizationId及已知时grantId/完整原快照；采证取消target含原captureId | 同步登记精确目标tombstone并失效其权限后ACK，回原revokeId/target/nonce及原控制终态。授权ID尚无grantId也可取消；不使用无目标global revoke影响后续授权。|
| `POST /v1/send` | 原requestId/sourceKey、已登记GrantSnapshot对应的完整绑定、普通text及自动事件引用 | 只有当前显式登记active grant且全tuple相同才执行；原业务幂等/unknown/应用Write边界保持。资格token、伪tuple、旧grant均拒绝。|
| `POST /v1/operations/:requestId/reconcile` | 仅下方恢复合同的严格MessageRef/facts/control DTO | 零平台请求；原holder核对/逐层ACK/持久化，不能只清L暂停。|
| `GET /v1/operations/:requestId` | 原消息ID | 原完整引用/nonce、accepted/Write/join、facts head与恢复receipt；GET或新空表不解除暂停。|


##### 控制状态、持久化与恢复


**L：** schema4 的原子 records/controls、观察/冲突/message_reconcile 与历史 receipt 规范唯一见下方“冻结原消息事实、unknown 核对与未来动作恢复”。AuthorizationControlRecord仍固定authorizationId、原资格摘要、原sender nonce/完整proposal及live/input/Context绑定、local revision、payloadHash、状态与受信ACK/取消引用；RevokeControlRecord仍固定revokeId、精确target/nonce/快照、状态与ACK。grant仅内存；磁盘快照不能恢复可发送对象。

授权HTTP前先0600/独占临时/fsync/原子rename保存稳定原ID与快照；ACK也先完整持久化，再按下方“单 journal 历史与当前实例采用”发布本实例内存许可及仍当前的内存grant。任何write/rename/fsync/close失败暂停，并失效依赖该次保存的采用许可；磁盘状态不代替当前许可。撤权先同步禁本地grant/旧队列，不等网络或持久化成功后才禁发。schema3/不支持schema保留原字节unavailable，不自动迁移真实文件、不当空表。损坏/不安全路径/超限fail-closed，无第二业务DB，未知/未终止/原ID事实不驱逐。

**sender Node与私有helper：** 各只有一个对应原proposal的authorizing/active槽，及有界的控制记录/撤销tombstone表；只在内存，不恢复grant。槽身份包含authorizationId、payloadHash、原qualification对象/revision及冻结AuthContext/helper nonce、原完整快照。authorizing一开始先同步登记ID与槽，才允许任何await；每await返回/commit前复核原槽身份、资格/Context/Session/认证/连接代和撤销tombstone。并发其他授权拒绝；不能让旧await覆盖新槽。active也不得被另一次authorize悄悄替换，必须先完成原目标撤销。

每个sender nonce内原ID记录与tombstone不可因TTL/容量删除而允许旧请求复活，达到上限拒绝新控制操作。新sender nonce使旧HTTP目标无效，但不充当旧进程/helper执行已终止的证明。原消息单在途/活执行仍独立占用，不因控制槽撤销被视为已结束。

##### 允许转移与失败结果

###### L控制状态

- 无授权 → `authorizing`：只有显式owner调用、当前资格/平台/房间/live/input有效、消息与控制操作均无hold时；先写journal再发HTTP。此时send拒绝。
- `authorizing` → `active`：仅受信ACK的authorizationId/payloadHash/nonce/全tuple相符，且本地revision、live/input仍为原值；ACK记录落盘后才发布内存grant。内部authorize改为异步，不能以Promise开始或HTTP受理当完成。
- 授权超时、丢响应、无效ACK → `authorizing_unknown`：持久暂停发送及新授权。仅查原ID或对原ID做targeted revoke，不生成新authorizationId掩盖未知。not_found、owner备注、一次新state GET均不能解除。
- 本地撤权/下播/换目标/live/input失效 → 立即取消内存grant和旧队列，并进入`revoking`；不等HTTP。若授权ACK尚未收到，仍使用已持久化authorizationId/原nonce取消。
- 撤权超时、丢响应、无效ACK → `revoking_unknown`：继续暂停发送和新授权；仅原ID查询或可信精确目标撤销证明可收敛。
- 只有同一原nonce、原ID/payloadHash/tuple匹配的受信、可查询且不可复活的rejected或revoked终态，才能把对应控制不确定性收敛；这只处理控制操作，不解除任何消息unknown。迟到ACK只追加原控制记录，不恢复已撤权/重启后的grant，不覆盖新目标状态。

###### sender控制状态

- 未登记 → `authorizing`：校验原nonce/资格及控制请求，在await前登记ID/payloadHash与唯一槽；只有该流程可创建grant。
- `authorizing` → `active`：所有异步核查通过且原槽/revision未变、无tombstone；helper实际无await commit生成独立grantId和当时authorizedAtMs并返回完整ACK；Node仍当前才publish/ACK，L落盘后可发送。
- `authorizing/active/尚未到达` → `revoked`：按原authorizationId+nonce同步建立tombstone并失效相关资格/continuation，再ACK。revoke-before-authorize、during-await、after-commit都使旧授权未来不生效。取消原captureId同样保留取消事实，晚到采证不得成为原流程可用结果。
- 同ID再次到达只返回原记录；不同payload拒绝。更换qualification或新grant不能接管旧authorizationId、旧请求/队列/sourceKey。所有旧绑定仍被最终同步guard拒绝。

授权/撤权网络动作一经发出，L不能承诺跨进程绝对原子取消。sender撤销ACK只证明该授权已失效、不能开始未来提交；已经开始应用Write或仍活着的发送必须按原消息记录保留可能副作用/unknown和单在途，不能写not_sent。

L重启不恢复任何active grant、队列或采用许可；持久化的authorizing、active尚未确认撤销、revoking及unknown授权/撤销控制先进入恢复hold。已有完整受信且符合原合同的安全终态ACK，须经下方显式原ID核对、本次完整持久化及当前实例采用后才解除相应控制hold；缺完整ACK仍只查/取消原holder的原ID。authorized ACK不证明撤销，不能据其释放尚未确认撤销的授权。旧ACK从不安装grant。sender重启缺原控制/nonce已换不证明旧helper执行死去；消息历史终态/receipt也只按下方专门规则采用，不能凭新空表或备注解除。

**控制终态的可信边界：** 能清控制hold的`rejected`必须是受信sender已登记、可按原ID查询、绑定原payloadHash/nonce且不可复活的终态，同ID晚到或重放也不能在条件改变后再次签发。普通HTTP 400、409 busy、503、容量不足而未登记、not_found只是拒绝/未知观察，不是终态取消证明。容量达到上限时fail-closed，不以丢弃旧记录腾空间；L不得用这些响应清hold或另建授权覆盖未知。

**定向取消的作用域：** 原captureId取消与原authorizationId撤销只能影响各自原记录/原槽及明确依赖该记录的continuation。旧capture取消只使该capture及依赖它的授权失效，不得全局清空后来capture产生的qualification或new grant；旧authorization撤销也不能清空后来的授权槽。乱序、重复及并发返回均按原ID/nonce/payloadHash匹配，不能以全局revision递增的实现误撤无关新槽。



#### 冻结原消息事实、unknown 核对与未来动作恢复

复用原 journal、原操作记录、controls/query 和私有帧；不引入依赖、第二业务 DB、消息框架或通用证明服务。schema4、一个受保护 POST、一个私有 reconcileMessage 及查询扩展是唯一恢复合同；L 单方面清布尔值、取消 helper 独立暂停或把观察当平台 receipt 均禁止。同步 HTTP/1 与完整原 worker joined 路线不变。

`message.state=unknown` 是保留的原历史结果；`recovery` 是当前事实版本是否核准允许未来新动作的独立记录。观察/恢复不把原 unknown 变为 api_reported_success/not_sent，不生成或恢复 grant/队列，不重发原 request/sourceKey。原可信 never-written 终态仍可单独记 terminal_not_dispatched，原 ID/来源 tombstone 永久保持。

核对访问原历史对象，不要求旧授权仍 active，也不要求原 live/input/raw 仍当前。访问准入仍是当前受保护 sender 的凭据/构建身份；业务核对必须逐项命中原不可变 MessageRef 和原 holder 的 sender/helper/Context 身份，不用当前新 grant/代次补引用。原材料过期、已撤权或已换直播不妨碍查询仍存在的原 holder 历史；不存在原 holder 且没有已完整验证落盘的终态/receipt 时保持 hold。未来发送必须重新满足全部当前资格、真实 raw 与显式授权条件。

##### 原消息引用、事实与 schema4

`MessageRef` 固定为 `{requestId, sourceKey, requestHash, helperPayloadHash, textDigest, grant}`。grant 是 frozenGrant.ts 的完整 FrozenGrantSnapshot，所有字段原字串/整数精确相等，含 sender/helper nonce、AuthContext/digest/revision、真实 UID、web_rid/platformRoomId、authorization/grant/capture、raw/input/live 全代次及 authorizedAtMs。`refDigest=现有跨 Node/Go canonicalHash(MessageRef)`，摘要不代替逐项校验，也不允许发送时新代次修补旧引用。

Go 原消息新增并保存 `requestHash`、`textDigest`、`acceptedAtMs`、`firstWriteAttemptAtMs|null`。Node 在私有 send payload 转交已计算的外层 requestHash；helperPayloadHash 仍为整个私有 payload 的独立 canonical hash，不包含自身，避免自引用。helper 自行计算 textDigest：最终实际 text query 参数在百分号编码前的 UTF-8 精确字节 SHA256，不作额外 Unicode 归一化；L/Node 同样计算并核对。记录只存摘要，不存发送原文。accepted/Write/join 时点由原 helper 产生；时钟矛盾按不可用/冲突处理。

L schema4 保留原 controls/records 结构与原子写纪律。每条消息增加：

| 字段 | 含义 |
|---|---|
| createdAtMs、facts[] | 原消息登记时间；仅追加的事实与内部冲突事件 |
| factsRevision、factsDigest | revision 等于已接纳事实条数；digest 由有序规范事实数组计算；空数组为 revision0 |
| conflicts[] | 内部产生的矛盾标记，含来源事实/受信原记录引用与原因码；owner 不能直接提交/清除 conflictOpen |
| terminalEvidence|null | 仅内部可信原消息查询接纳的原 helper joined/Write 事实与完整引用 |
| recovery | blocked / pending / recovery_unknown / committed / invalidated；保存历史事实版本、控制 ID 和完整已验证 ACK；当前有效视图另核本实例内存采用许可，磁盘 committed 不直接解除 hold；原 unknown 不改 |

controls 新增 `kind=message_reconcile`：稳定 controlId、MessageRef、事实完整快照/版本/摘要、payloadHash、localFactsToken、状态、原 Node/helper ACK。完整 proposal/grant 仍仅作核对快照，不能从磁盘恢复可发送对象。

`recordVerificationFact()` 在冻结路径必须真正委托 FrozenControllerCore；冻结 lookup、fact 去重、持久化和恢复判断都用 schema4 原消息，不能读旧 operations 冒充。旧路径继续独立校验，不把其 Enter 证明转换成 HTTP Write 证明。读到 schema3 或其他旧格式：保留原字节、明确 unavailable，不自动迁移真实文件，不当空表；fixture 新建 schema4。保留 mode0600、独占临时/fsync/rename、symlink/别名/损坏/容量保护；未知/事实/原 ID 不驱逐。

###### 事实输入的权威边界

每个事实有稳定 factId、seq、refDigest、hostRecordedAtMs；同 factId/同内容只回原记录，不增长 revision；异内容拒绝且保留原记录，协议矛盾在受控事实集合记冲突。factId 是宿主生成/分配的关联 ID，不是身份凭证。

- `note`：短非敏感说明，沿现有最多500字符及整帧字节上限；包括“未看到”只能作备注。备注永不满足恢复观察条件。
- `positive_observation`：source=owner/designated-viewer、attributionStrength=direct/indirect、observedAtMs、textDigest、principalUid、roomId、platformRoomId，以及完整原 MessageRef 关联。hostRecordedAtMs、owner 准入/指定观众来源由可信宿主附加，模型/公屏输入不能自报来源。指定观众以无联系方式的宿主分配引用和指定事实关联，由 owner 记录其观察，不新增观众直连管理 API。
- 合格观察限定为 direct：核对者直接确认原账号、两种房间引用、时间和内容摘要，并能归属于原操作；indirect 只记录，不解锁。同文其他人回显不构成 direct，helper 也不凭同文 echo 猜作者。真实人工陈述的真实性依原 owner 信任边界，helper 只核严格关联，不声称机器验证了观众可见。
- 观察须匹配原 UID/房间/完整 ref/textDigest；observedAtMs 不早于 helper 原 accepted/firstWriteAttempt 时点，且不晚于可信 hostRecordedAtMs+已有5秒时钟容差。无可靠时点不能核准。缺字段/错 tuple 整条拒绝，不能修正原绑定或部分落盘。
- termination_proof、joined、executionEnded、writeAttempted、safeToResume、force、风险承担、清冲突等字段一律不属于 owner DTO，严格拒绝未知 keys。终止只来自 helper 原 worker 的内部事实，不能用 caller 传来的 receipt 作为新证明。

新事实在任何 await 前同步进入本地 hold、推进 localFactsToken、废当前 grant/旧队列；完整事实持久化失败不发核对 HTTP，保留暂停。与已有 targeted revoke 协作撤销旧授权。新事实和冲突不能让旧 ACK 恢复授权。

##### 最小接口与稳定记录

沿已有数字 loopback、部署 token、构建身份和固定实例访问控制；能力增加 `unknown-recovery-v1`，旧 sender/helper 缺能力 unavailable，不兼容降级。接口不接模型工具，不提供任意 room/UID/URL/材料选择。真实 SDK owner 准入仍由 T002 接线，T001 不以伪 owner 布尔值冒充。

| 接口 | DTO/结果 |
|---|---|
| 新增 `POST /v1/operations/:requestId/reconcile` | 严格 `{controlId, expectedSenderProcessNonce, ref:MessageRef, factsRevision, factsDigest, facts, localFactsToken}`；路径 ID 必须等于 ref ID。只接可信 L 完整事实快照与原引用，不接执行证明或解锁布尔。|
| 复用 `GET /v1/grant/operations/:controlId` | 扩展 control kind=message_reconcile，查询原核对控制的状态/原快照/Node ACK；名字虽含 grant，明文声明该新增 kind，不改授权含义。not_found 仍未知。|
| 原 `GET /v1/operations/:requestId` | 增加原 accepted/Write/join 事实、当前 facts head、恢复控制引用/receipt；不因 GET 本身或返回 executionEnded 就清暂停。|
| 新私有 `reconcileMessage` | 原 controlId、同一 ref/facts 快照、originControlPayloadHash；通过既有私有帧核 helper nonce/Context/material/revision/seq。复用私有 query 查询原 controlId 或原消息。无公开 helper 写入口。|

外部 `payloadHash=canonicalHash({kind:'message_reconcile',controlId,expectedSenderProcessNonce,ref,factsRevision,factsDigest,facts,localFactsToken})`，由 L/Node 独立计算；不由 owner 提供 hash 来替代正文核查。私有 frame payloadHash 单独计算，helper 保存 originControlPayloadHash 与自己的 payloadHash，ACK 同时关联，不混用。

Node 与 helper 在任何 await 前登记原 controlId/kind/hash/槽身份；同 ID 同 payload 只查询/返回原控制，不重新核准或生成新 receipt；跨 kind/异 payload 拒绝。原 request/sourceKey 永久去重。沿现有有界表（1024总控制/原操作记录），每消息最多32个事实，整体 journal1MiB/私有帧64KiB限制保持；任何先达到的上限拒绝新操作且保持暂停，不截断事实、驱逐 tombstone 或把未登记容量拒绝当终态证明。

每原消息最多一个未终结 reconcile 控制（含 pending、pending_join、recovery_unknown）。新事实到达先同步本地 hold/废旧 grant，并原子持久化新事实；不得以新 controlId 覆盖旧未终结控制。先按原 controlId 查询至受信、可查询且不可复活的终态；旧 receipt 即使对旧 head 有效也只存历史，不解除当前 head 的暂停。原控制终态后，owner 才能对最新完整 head 新建显式 reconcile。pending_join 仅因同一原 worker 真实 joined 而继续判定，零新平台请求。

完整事实快照必须是已知事实的严格追加前缀扩展。旧控制已可信终态后，较大 revision 可携一次完整连续 seq/旧前缀覆盖多个尚未单独同步的本地追加事实；不得绕过未终结控制；不接受删事实、改历史、改 ref。较小版本控制得到不可复活的 superseded；相同版本异摘要/已知 fact 异内容产生冲突且暂停。等版本等摘要的新控制只用于明确查询/重新请求此前终态 held 的核对；不能覆盖仍 pending/unknown 的控制。一个原消息同时只允许一个 pending 核对槽，当前单在途原执行规则不变。

##### helper 核准与逐层 ACK

所有记录时间采用跨 Node/Go 可无损的整数毫秒，规范 UTF-8 文本摘要与 canonicalHash 两侧必须一致；任何时间/精度/先后矛盾不核准。helper 本原 worker joined 仍是唯一终止权威，不能导入 owner 或 caller 的执行证明。

helper 将 messageHold 改为由每个原消息/原事实 head 的未解决条件派生，不能直接全局 false；Node/L 同理。原 worker 未 joined 时始终保留原活执行/单在途，绝不由核对控制清除。

1. **L 先保存。** owner 显式请求核对/恢复时，固定当前事实 head、完整 ref、稳定 controlId 和 localFactsToken，原子保存 controls=pending 后才发 HTTP。仅追加事实不自动发送平台消息或恢复。持久化失败零核对 HTTP、继续 hold。
2. **Node 登记。** 访问原历史记录，不检查旧 grant/live 当前；核原 sender nonce/build、原消息/requestHash/helperPayloadHash/grant/digest，登记该原消息的唯一核对槽、原事实 head/token 和 holder 身份；同步废依赖旧恢复许可的 grant/队列，再向唯一原 helper 发私有操作。不得把 L 的本地“安全”判断转成 helper 终止证明。
3. **helper 固定事实。** 核本进程原消息、全部 ref、原 sender/Context/helper nonce，登记控制及事实 head。接纳更高 head 先让依赖较早 head 的许可失效，原 receipt 保留历史。查询不存在/nonce已换一律不构造“已结束”。
4. **helper 判据。** 只有本原消息的真实 syncWork 全体已 joined，内部 executionEnded/Write 事实单调一致、无任何未决冲突，才可 commit。已 Write 的 unknown 另需该当前 head 至少一条合格 direct 正面观察。never-written 分支须自身可信 joined+writeAttempted=false；若又出现声称该消息可见的正面观察则矛盾，不能取有利一边解锁。
5. **helper commit。** 在原 mutex 中复核控制/事实槽仍当前，产生一次 `recoveryCommitId` 和实际 committedAtMs；保存不可变 receipt、撤销原授权/资格并永久取消旧队列/续体，不生成新 grant。对已 Write 的原消息保持 state=unknown，记录 decision=observed_unknown_released；never-written 仅原终态为 terminal_not_dispatched。两者只是解除该原消息对未来动作的暂停；其他未知/控制/活执行继续阻止。
6. **Node publish。** 接受原 helper 的真实完整 ACK，核原控制两级 hash/ref/facts head/nonce/当前槽及 joined receipt，然后才记录当前恢复许可、解除该原消息的 Node hold并回 L。所有 await 后与最终 publish 前仍核原槽/head/token；期间换 helper/维护/新事实/冲突使旧 ACK 仅存原记录，不发布当前许可。helper commit 不等于 Node 已发布。
7. **L 完成。** 所有 await 后及发布前核 Node ACK、原本地 control 对象/事实版本/token、所有原引用，先按下方单 journal 算法完成完整ACK及所需历史事实的全部原子持久化；成功返回后再次核本实例/原槽/head，再登记本实例内存采用许可，才更新当前恢复判据。write/rename/fsync/close失败、ACK丢失/无效/迟到保持 recovery_unknown，按原 controlId 核对；不另造 control 覆盖未知。失败后磁盘可见committed也不发布许可。所有阻塞消息/控制均已闭环并已在本实例采用后，UI才显示“可重新显式核查/授权”；仍无可发送 grant，必须新 owner 资格/授权和新请求。

Receipt 严格包含版本、原 controlId/kind、origin/helper payloadHash、完整 MessageRef/refDigest、factsRevision/digest、原 helper/sender/Context 身份、helper 自有 joinedWitnessId/joinedAtMs、accepted/firstWrite时点、实际 Write 标记、recoveryCommitId/committedAtMs、decision；不含凭据/原文/平台 receipt。joinedWitnessId 由原 worker 完整退出后的内部入口生成，不能作为 caller 请求参数；只凭此字段存在也不代实际内部 joined 检查。

控制状态：pending → pending_join / held / committed / superseded / rejected。只有未 joined 可为 pending_join；原 joined 通知或按原控制 query 在同一槽/事实 head 仍当前时完成判定，无新平台动作。held 是该控制的不可复活未核准终态（缺合格观察/冲突）；新增事实后可显式建新控制。rejected 必须已登记、可查询、同 hash/nonce不可复活；普通400/409/503/容量未登记/not_found不解任何 hold。任何层 unknown 不是终态，不复用新 ID“再试”。

###### 并发、冲突及不可撤回边界

- 新事实/冲突在 L 先禁发并推进事实代；Node/helper 只能在收到时失效其所知旧许可，不能承诺尚未收到网络更新就跨进程同时撤权。端到端安全由 L 不再发送新授权/请求及既有每层最终 Write 检查维持；已发网络/已开始 Write 按原 unknown 边界处理。
- helper 收到较新事实，或其自有原执行事实出现矛盾，立即使旧许可不再当前，并撤销依赖许可的当前授权。旧 receipt 仍可查询，不能用它覆盖新冲突/新 head。旧 Node ACK 若只匹配旧 head，只能回原控制；L 当前 token 不符不能放行。
- 本轮不提供 owner 直接“清冲突”或风险接受入口。错 tuple 输入整条拒绝，不借其改原消息；受信内部事实互相矛盾、同事实版本不同内容、never-written与可见观察矛盾则锁定冲突并保留全部证据。新备注/新的 direct 声称不能删除矛盾。
- 所有暂停检查是原消息集合派生：核准 A 不清 B 的 unknown，不清 grant revoke/capture/control_unknown，也不复活旧 sourceKey/排队项。

##### 单 journal 历史与当前实例采用

L 是唯一业务 journal 持久写者；Node/helper 的原控制/receipt/facts head只在内存，原容量纪律保持，不新建第二DB。单次原子替换后可见的文件，不能证明上一个进程最后的目录fsync是否成功返回；本方案不恢复过去系统调用的返回值，也不增加同类committed标记或无限commit阶段。

**磁盘保存历史，采用许可仅内存。** schema4仍保存稳定原ID、完整受信ACK/receipt、事实head、终态及tombstone。Controller有私有采用集合，绑定当前boot/Controller实例、原controlId/kind/payloadHash、完整ACK/receipt摘要和事实head。它不是第二持久状态库，不接owner/HTTP传入的采用布尔或证明对象。磁盘committed/revoked/rejected、序列化state或原localFactsToken均不等于当前采用许可。所有由历史结果解除的消息/控制hold还必须具有匹配的本实例采用记录；其他未闭环条件照常阻止。

**每次启动先暂停。** journal严格校验schema、原ID/记录关系及完整receipt，原字节不启动自动迁移/回写；queued/dispatching等原重启转换保持。Controller初始采用集合为空，不恢复任何grant或队列。即使磁盘为committed，凡依赖该历史结果解除hold的当前恢复视图仍为recovery_unknown/待核采用，不能构造后直接放行；历史结果本身不改成新的平台结果。

**显式采用复用既有reconcileControl/reconcileFrozenControl。** owner仅指定同一原controlId，不上传ACK、joined或safe证明，也不新建通用平台/证明接口。若journal已有当时通过受信Node/helper链取得的完整历史ACK/receipt，恢复处理器重新核原kind、两级hash、完整MessageRef/目标、原holder的sender/helper/Context身份与构建、事实head/冲突，以及原joined/不可复活终态等对应控制所需证据；随后对该确切安全快照执行现有原子journal写入的全部文件与目录持久化/关闭步骤。仅全部成功返回后，复核当前Controller实例、原槽/head及全部关联仍匹配，才登记内存采用许可。此路径零平台请求，不要求旧live/grant当前，也不因原helper后来退出而否定已完整合格的历史事实。

**证据不全仍核原holder。** 没有完整ACK、只有state/布尔值、记录不完整、receipt/head不匹配或有冲突，不能靠本地fsync或owner说明补成证明。继续既有Node/helper原controlId查询/定向取消合同；原holder丢失、新nonce、空表或not_found不清hold。取得同一原控制的合格结果后，也必须先完成本次持久化和内存采用。不新建控制或重发原消息来替换未核清操作；新事实/冲突的旧控制终态及新head顺序仍依上文。

**运行期最后发布许可。** 正常新操作先保存完整ACK与原历史事实，所有必要write/rename/fsync/close成功返回、当前关联仍匹配后才发布本实例采用许可。任一错误立即禁发、失效依赖该次写入的许可；内存回滚不能撤回已可见文件，磁盘committed也不自动生效。当前实例若已degraded不默默清除，可重启后用同一原ID显式采用；再次启动仍从空集合/hold开始。新事实/冲突、原head/槽或实例变化使旧许可失效，旧ACK只归历史。

**适用所有解除hold的结果。** 已Write unknown恢复、never-written、授权rejected/revoked、撤权ACK、capture取消等，凡借历史结果放行未来动作，都要保存原合同要求的完整受信ACK并取得本实例采用记录。缺失ACK的候选实现须补齐，不能把旧state当ACK；authorized ACK不证明原授权已撤销。schema4仍是未发布合同实现，不支持完整合同的旧候选文件保留原字节并unavailable，不猜字段、不自动迁移真实数据或自创版本；严格格式若需要本次既定schema之外的新语义，STOP给具体冲突。

| 已取得事实 | 显式恢复与丢进程边界 |
|---|---|
| 完整受信never-written joined终态/对应ACK | 先hold；显式原ID严格核对并完成本次持久化/内存采用后，才解除该原操作的相应hold。它是历史终止依据，不是新nonce空表证明；原ID/sourceKey仍不重发。|
| 完整Node发布+helper committed receipt/ACK，当前head相同且无冲突 | 干净重启也先hold；显式原ID采用成功后，仅允许在其他阻塞均闭环时重新显式采证/授权。原unknown保持，不恢复旧grant/队列；不得一律拒绝所有合格历史来冒称安全交付。|
| helper已commit，但L缺完整合法Node ACK/receipt | recovery_unknown；只查原Node/helper的原控制。原进程可返回同一receipt，丢失则不凭空重建；本地fsync不能补齐链路证据。|
| 只有state/bit、executionEnded、备注/观察、未publish结果、pending_join、not_found或新nonce/空表 | 无采用依据，保持hold；新进程不能接收L上传的所谓旧joined证明冒充自己产生。|
| 历史receipt后追加事实/冲突，或head/绑定/完整性不符 | 旧receipt仅历史，不发布采用许可；按原holder/旧控制终态/新head合同核对，原holder丢失且无合格当前依据时继续hold。|

完整ACK仅由内部受信响应处理器写入，不是owner可提交字段或文件导入功能；依赖既定0600、安全路径/单写者及同OS凭据失陷不在本任务威胁边界。L采用真实历史闭环不要求Node/helper新进程导入该blob或伪造joined。既有未完成reconcile控制的recovery_unknown及授权/revoke/capture的各自hold不变；迟到ACK不能安装grant。未来发送仍须新显式资格/授权及新请求，旧request/sourceKey永久不重放。


#### 标准库同步 HTTP/1 与原操作 worker

实际 HTTP 路径只用 Go1.27.3 标准库 net/http、crypto/tls、net。唯一实现为 helper 明确拥有的原 worker 顺序调用 Request.Write、ReadResponse 和有界 body 读取，不再使用 http.Client/Transport 的后台 readLoop/writeLoop。此处替代此前必须 Client/Transport 的工程限制；不引入/下载 tls-client、fhttp、utls、其他外部模块或通用传输框架，不保留旧 Transport/第三方/UI 并行 fallback，不改为每请求进程。真实账号是否接受标准 TLS 仍 NOT_RUN；实际授权验证拒绝时回主 Sol，不自动换指纹或协议。

三个固定端点仍是原 query/签名/headers 的 GET；强制 Body=nil、ContentLength=0、TransferEncoding/Trailer 为空，拒任意 method/body/Reader/trace 输入。Request.Write 同步完成最终 Flush 后才返回；上述 nil-body 路径不进入 transferWriter.probeRequestBody。显式 Close=true，原 Cookie/User-Agent/Referer 等 frozen headers 保留。没有 Jar、重定向跟随、代理、DefaultTransport、连接池、HTTP2/3、协议竞速、alternate transport、自动解压或上层重试。

helper 在发布 ready/资格及接受授权前，完成固定两个 origin 的受控地址准备，冻结本 helper/Context 内的一个数值 IP+443 目标；正常 hostname/证书验证、SNI 及 http/1.1 ALPN 使用原 origin。普通请求、settings、模型及材料文件均不能给任意 IP/URL/CA。准备工作须登记并收束，超时/失败不可伪装 ready；未确认结束不启动替换写者。地址改变只经既有维护、新 Context/nonce、重新采证授权，不在原请求内换 IP 或重拨。测试仅用可信内部 DI 的自有数值 fixture，不查真实平台 DNS。

原请求只对这个数值地址执行一次标准库 typed TCP dial（例如零 Timeout/Deadline/Cancel 的 Dialer.DialTCP，Background、明确 tcp4/tcp6），不经过 hostname DialContext、多地址回退或 Happy Eyeballs。原 worker 拥有整个 dial 调用；若 connect 未返回，外层 15 秒结果预算/撤权不证明它结束，原执行与单在途保持。晚到原连接在同一操作核 seal，已取消则关闭，不能开始 TLS/应用 Write 或交给新请求。禁止用尚未加入的库 context.AfterFunc 清理回调替代终止证明。

socket 取得后设置原操作绝对 deadline。同步 TLS Handshake（Background，无 caller Done 回调）由本任务预先登记、可加入的 supervisor 关闭自己的原 socket 来取消；保留正常 hostname/证书验证，拒 InsecureSkipVerify，握手后核原授权和 ALPN。包装握手后的 HTTP 应用 Write，TLS 握手包或 TCP 重传不算第二应用请求。读取限制 HTTP 明文总字节（含头/framing）、状态/版本、body 及时间，不能只用 ReadResponse 加 body 限制而漏掉头大小。

原 worker 在任何 dial/握手/请求前登记，顺序拥有数值 dial、TLS、Request.Write 的整个调用栈/Flush/同步回调、ReadResponse、响应消费及原资源清理；必要关闭/supervisor 工作也须预先登记并加入。只有完整 worker 与全部已登记资源工作结束后的内部 joined 事实，才能调用 finishSendWithResponse、标 executionEnded 或释放活执行。I/O 计数归零、trace、ReadResponse 返回、socket close、seal、revoke ACK 或新进程空记录均不能替代 joined；不能保留 Client.Do 再改一个计数名字。worker 未退出时继续 unknown/未终止及单在途，不以始终 unknown 代完整正向交付。两个 profile 请求也同样顺序完成原工作，旧 capture 取消/迟到不能为新槽复用连接或发布资格。

旧 Go Transport retry-loop 的 c9146e77adc22d4b74ba77384ec7be7fc27c3af21ff20485f642b4d611b381a4 源码核对只保留为已替代实现的历史证据，不再声称当前生产路径运行该循环。当前同步路径的结构依据、完整终止条件、连接准备和必要回归见主 Sol `/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/t001/main-http-worker-disposition-10/decision.md`；这是源代码支持的工程决定，不是行为 PASS。仍须真实本地 TLS 证明正向恰一次、反向零发送及所有故障最多一个原连接/应用请求；出现第二请求、不可加入的原工作或必须 H2 时 STOP，不改 API/UI/请求 ID/判据绕过。

#### 发送副作用与结果层级

Node出队/所有await后核原L授权、sender槽、helper/context/原grant/live/input/raw代；发私有send帧前最后一次无await同步核查。发送IPC后不能保证跨进程绝对取消；Node/L在此之前已持久dispatching，丢ACK默认unknown。

helper先同步登记原requestId/payloadHash/单在途，纯签名/URL构造不得有隐藏网络/认证修改；TLS握手完成、由原同步HTTP worker使用的guardedConn在**第一次HTTP应用数据Write调用前**，在与helper revoke/context失效共用的mutex内核原槽/full tuple/取消状态，同步记录writeAttempted，然后调用已握手TLSconn.Write。不得以WroteRequest回调充当实际应用Write开始、写前检查或原执行终止的证据，也不把TLS握手本身记成chat已写入。写调用一经开始即保守unknown，即使n=0/抛错也不凭该错误断言平台没收到；后续部分Write/响应读取与取消结束仍在原操作上。每一次后续应用Write也在同一mutex内核完整原grant/Context/revoke状态，不能只检查第一笔marker。targeted revoke只取消/关闭原record持有的有界I/O，建立原tombstone后ACK；匹配revoke ACK后不得新开始旧continuation的Write。原Write已经开始即使返回零字节/异常也保留writeAttempted/unknown，不能转not_sent；取消/关闭不能误伤后来无关槽。mutex用于序列化写调用开始与撤权，I/O有deadline并安全取消/关闭，不承诺跨进程绝对取消。

可信terminal_not_dispatched需helper原nonce/完整引用、原执行已终止、writeAttempted=false，且所有可能发送continuation已终止；Node不得由普通本地错误或新进程空表制造。writeAttempt=true后网络断/超时/重定向/5xx/不可信JSON仍unknown，单在途到原执行终止才释放；原unknown的hold核对条件保持，不因控制ACK/新Context解除。

实际结果层级：

1. dispatching / http_write_attempted：只证明本地写入边界；无平台受理承诺。
2. http_response_received：保存受信原请求HTTP状态/长度/摘要，不等于业务成功。
3. api_reported_success：仅固定端点最终HTTP200、JSON content-type/严格UTF-8、有界完整对象/无重复key尾随、明确整数status_code=0、status_msg若存在仅允许空或success且无矛盾错误/风险字段时，显示“接口返回成功码，观众未核对”。保留schema版本/响应摘要/原操作引用，不能称平台receipt或观众可见。固定SendMsg源码没有已核的发送成功回执结构/真实成功实例；本层只精确陈述收到的成功码，不虚造msg_id或业务投递保证。
4. 非零/缺status、验证码/签名挑战、结构不符等不以JSON外形过关；没有该错误码的可靠未执行语义时保持unknown，不自动重试。页面echo不用，原sender操作终止与owner关联正面观察仍分离。

平台echo或观众观察独立人工事实；联系方式/链接等text策略、单在途/队列10/30秒/间隔3秒、原request/sourceKey永不重发、消息unknown与控制unknown各自保持。

##### 消息幂等与unknown记录

两端默认单在途、L队列最多10条、等待最多30秒、间隔至少3秒、外层HTTP结果等待预算15秒（超时不证明原worker已结束，未终止仍占用）；是本地限制，不冒称平台限额。出队前核绑定和source新鲜度，条目固定原grant，新grant不接管旧队列。sender记录原request/sourceKey及执行阶段，保留可受信查询的终态；重复request/sourceKey只查原操作，不再发出应用Write。L在任何发送HTTP之前将`dispatching`及绑定/来源/文本摘要持久化（原authorizationId/grantId、senderProcessNonce及完整原绑定不可省略）；失败零外发。派发后超时、5xx、断连、redirect、协议错误或不可信响应一律unknown，只有受信v1原操作终态能细化。`api_reported_success`只证明已核原HTTP响应显式返回成功码；echoed完全不参与结算。unknown全目标暂停新发送，禁止换目标/账号/UI绕过。

owner事实存储、严格关联、helper joined核准、三层ACK/持久receipt及重启条件仅按上方“冻结原消息事实、unknown核对与未来动作恢复”执行。未知事实不因恢复改写；新nonce/空表/备注/单独executionEnded/控制revoke ACK均不是恢复证明。旧grant/live失效不阻止原holder历史核对，但未来发送仍需全部当前资格。journal schema4/旧schema保护、每消息一个未终结核对控制和全目标派生hold不另设宽松分支。

#### 输入输出与Agent


- `LiveSource`不增加send。新增输出接口只接收可信固定binding与普通text，无模型target参数。
- `douyinSource.ts`仅给原event对象登记输出专用WeakMap元数据`{rawId, rawType, rawFrameTsUntrusted, receivedAt, sourceConnectionToken}`，不改LiveEvent结构/ts/去重/增量/机器人标记；`Hub`真实source回调将其关联当前输入连接代次与房间，普通ingest/模拟入口不升级来源。相同event复制/序列化不继承资格。
- 自动资格的另一半来自受控sender：在同房间真实raw proto进入归一化之前，取`msgId/method/common.createTime`，明确区分平台时间与Date.now回退，按字符串rawId/类型/当前sender连接代次保留有界短期证明。controller提交的自动事件须匹配其进程内真实匿名事件rawId/原类型、当前输入连接代次、当前直播epoch及该sender grant；sender在最终校验中再次核raw证明属于该raw来源会话/连接代与原实际HTTP授权、平台时间不早于当前直播/授权边界且在30秒本地有效窗内，未来漂移超限也拒绝。缺时间/证明/精确匹配均unavailable；昵称/文字/普通frame自报不是证明。sender proof只校验输出，不替换匿名输入或启动第二套通用采集服务；复用该发送Session已有消息回调。sender未收到对应raw消息时该自动动作不可用。
- Agent工具只在当前受管会话/回合且有上述真实公屏chat关联时可用；从现有query/course回合关联范式取得可信引用，模型不传eventId自证。每原事件/回合最多一次；`sourceKey`由宿主以输入连接代、原rawId/类型、直播epoch产生并固定，不能换请求ID重放。同一原输入不能因new grant变成新业务事件。TTS维持原路径，不自动镜像助手正文到公屏。
- 欢迎/感谢取真实原事件；优先在Hub聚合前使用Source的gift增量和对应rawId证明，或显式维护累计基线再取差，不把Hub累计count当增量，也不以稳定组ID吞掉后续原raw消息。欢迎每用户60秒最多一次；礼物感谢按短窗合并增量但不跨epoch/grant。模板固定、名称只允许短安全文本，不反射URL/联系方式/控制字符。真实匿名gift接收保持NOT_RUN。
- 公开文字禁止电话/邮箱/明确微信联系方式标记、URL/附件/data/file/记录引用和控制字符。没有登记读取接口或资料输入；此校验不声称能自动识别任意语义隐私。失败拒发，不以截断/替换把敏感原文“修成成功”。

##### 自动事件的原授权时间边界

raw proof不使用qualification capturedAt。自动事件必须与原active GrantSnapshot关联，freshness下界为 `max(grant.authorizedAtMs, grant.liveEpochStartedAtMs)`，并继续满足当前sender/input连接代、原rawId/type/房间及有效窗/未来漂移规则。

sender原始接收事实还须证明该事件首次可用关联属于当前grant，不能把资格后、授权前收进的raw事件，在授权后重新消费/重放升级为资格。最小实现可将raw首次接收关联与授权代固定；grant前记录不得因新grant而获得发送资格。helper授权实际commit时点用其可靠时钟，live开始边界取受信owner原快照，缺失/不可信/相互矛盾时unavailable，不用资格采集时间或Date.now回退放行。authorizedAtMs是helper实际commit点，ACK前L仍不允许提交。


#### UI与兼容


原Drawer沿dl-*：发送默认关闭，部署账号记录与真实主体分开只读展示（无主体证据显示未核实）；当前房间只读，单独核查/授权/撤权。资格、授权、HTTP写入/接口返回成功码、观众未核对、unknown独立显示。手动一条文字为最早可用旅程，随后Agent/欢迎/感谢开关。草稿/保存失败与375/1440px/键盘状态沿原设计。真实owner准入复用已实读的Q安装SDK `@deepseek-ai/dsh-client-connection@0.2.2-rc.1/lib/index.js:820-834`：精确fetch route调用前验证`peer.principal.kind==='owner'`；真实SDK fixture证明owner/non-owner/未认证通路，不能以自造isOwner布尔值替代。

#### 风险

实际冻结认证材料/资格、平台字数和内容限制、观众可见、匿名gift能力保持未验证。下游HTTP写入不能撤回，unknown需人工核对。独立发送服务的安全装配是上线前提；没有装配则明确不可用。当前无commit/push授权，正式commit绑定Validate/Review/Release不伪造，本地WIP证据单列。


### 实施计划


基线：L=`6eb5e3b17a295e7af27a000e98ee1ee1ee679fe6`、branch=`codex/macos-yovoice`，2026-11-13实读。L非干净：机器人T02已完成交还，接受的35文件聚合为`0a97e5f1873d932923efc19be9378a017992438f5181d8cbfa28caeaa061bac4`，完整接管基线为`/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat-handoff/l-owner-handoff-baseline.json`。原主线程已按下表分配增量写权，无其他L写者；其state唯一串行权保留。FEAT-007文档与REQ-004另有已声明WIP，不归本实现。保护当前lib（12文件）、`lib.previous-92a3019`（8文件）及所有用户数据/配置；不能用本任务早期未涵盖全部备份的manifest替代原主线程完整保护清单。D固定commit如上，browser.ts及probe-offline.mjs他人WIP保护；Q只读。

已核对位置：`core/platforms/source.ts:15`只有start/stop；`douyin/douyinSource.ts:45`固定loopback校验、`:263`礼物增量并保持稳定group eventId；`dsh/douyinRoomControl.ts:181`匿名账号检查拒认证；`dsh/index.ts:394`原owner设置、`:110`state；`dsh/agent.ts:526`会话观察、`:600`现有say；`body/show.ts:469`会话失效、`:1168`generation；DyHub`api/server.ts:152`旧同文echo仅作历史、`collector.ts`/`liveSession.ts`原raw回调；实际写入由新helper承担。派工前与首次写前重核这些依赖及实际diff；契约变化停止受影响写入。

#### 工程任务与写入矩阵

所有路径前缀P=`L/packages/dsh-livestream`，W=`/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat`。两Task串行推进，每个Task的同一实现者承担完整实现/必要检查/修正；实现路由依AGENTS，已授权额度接管保留原Task/失败历史，主Sol接受T001并由原主线程CLI置done后才能T002；不为单文件或缺测试另起实现者。

| Task | 实际允许路径 | 交付与依赖/STOP |
|---|---|---|
| FEAT-008-T001 | 暂存与验证仅`W/t001/**`（专属固定DyHub导出、patch、src/publicChat候选、test/publicChat候选、私有config/fixture、输出）；发布与增量纠正仅`P/src/publicChat/**`与`P/test/publicChat/**` | 独立可验收输出为有真实HTTP/私有helper/TLS fixture的固定目标一次发送与所有失效/unknown边界；不装配宿主。首次发布已按两目录原先不存在、W副本先noEmit/离线验证、原子rename完成；此为历史条件。当前同任务39文件可增量纠正，首写前核精确manifest/diff与归属；出现第三方文件或不明漂移即停，不删除重建或覆盖。专属cases用`.case.ts`，自有vitest显式include，不改默认runner。|
| FEAT-008-T002，依赖T001 | `P/src/dsh/{index,runtime,agent}.ts`、`P/src/console/console.tsx`、`P/src/body/show.ts`、`P/src/core/hub.ts`、`P/src/core/platforms/douyin/douyinSource.ts`；本任务新增的`P/src/publicChat/**`和`P/test/publicChat/**`；`L/README.md`、`L/examples/macos-yovoice/{README.md,.env.example}`、`L/examples/douyin/README.md`；`P/build.mjs`仅下述公屏资产打包局部；工件`W/t002/**` | 在接受T001的相同接口上装配owner/Drawer、Agent及真实事件旅程；Source仅输出WeakMap元数据，Hub仅必要真实来源钩子，机器人原标记/tuple/sourceKey语义保持。最早可检验结果为原Drawer授权后向fixture手动发送一条普通文字，仅一次收到且UI只报接口返回成功码、观众未核对；随后Agent/欢迎/感谢。|

共同禁止：attention/topics/robot/课程、既有test、vitest/tsconfig/package/lock、build的下述公屏资产打包例外以外部分、state/project/REQ-004/FEAT-007、D/Q源码和现有安装输出。新REQ-011/FEAT-008 context已由本线程Sol原字节落位并由原主线程接受/登记；实现者不改context或state。需要越过矩阵、固定快照/主体来源无法核实、现状契约证伪、缺真实owner/Session关联或保护产物变化时STOP，返回事实/差异/剩余工作；不擅改标准。

#### T002 标准构建校验资产打包（2026-11-14实际缺口处置）

原run13已用标准生产构建定位ERR_MODULE_NOT_FOUND：trustedSender被esbuild splitting放进chunks，import.meta.url相对的dyhub/verified_sender_loader.mjs未随产物分发。只复制loader仍缺buildSupport、sender_entry及manifest校验的源闭包。T002在原build.mjs增加这一必要资产打包局部，保留T003刚合入的registration native复制、--client及DSH_LIVESTREAM_BUILD_OUT语义；不改package/lock/协议或引入新依赖。

保持既有运行时相对定位与加载前全部校验：Node构建启用metafile，依据实际包含trustedSender输入的输出确定对应资产根，不猜chunk文件名；该关系缺失/歧义则构建失败。将当前publicChat中验证所需的真实源码闭包、dyhub四项buildSupport及sender_entry按原相对结构完整复制到该输出的相邻位置。复制清单明确、普通文件无链接、不混入测试/凭据/用户数据/Go二进制；完整准备并核源/目标字节及归属后发布资产，缺失/变更失败时不得把半份产物称可用。--client不改宿主资产。原installed lib和备份仍禁止写入。

sender bundle/manifest仍由原固定源码builder和已核fixed-D导出构建；针对最终已打包绝对源码位置重新生成真实metafile、sources、buildSupport和bundle，不复制旧绝对清单改标签、不删除source/patch/export/bundle检查、不绕过verified loader。源格式schema及可信部署引用不变，构建过程无认证/平台/开播副作用。部署usage给出固定导出、实际输出根、原builder与受保护引用的准确顺序；原W历史路径不能成为未来checkout唯一运行来源。

必要验收为标准构建产物实际startTrustedSender加载成功并进入原生产Controller/HTTP/Runtime/helper/TLS纵向；缺/错/symlink资产拒绝且sender未执行，重复全构建和client构建保持registration资产语义。最终发布后从实际L源码重新生成并核匹配manifest，完成原T002全部剩余UI/恢复/生命周期与必要suite。此为原Task同segment的新装配因果，原失败和唯一主诊断未用保持，不另起Task或削减原保证。

#### Usage、故事与参数合同

唯一总入口`L/README.md`链接Mac部署`examples/macos-yovoice/README.md`和抖音发送部署`examples/douyin/README.md`。T002文档覆盖：独立固定源码导出/核验→显式登录维护（本轮NOT_RUN）→实际主体/房间核对→原Drawer只保存开关→显式资格/授权→手动一条→可选自动动作→撤权/unknown原操作核对。明确发送不是官方API、不等于观众可见，不指向未获准登记入口。

部署参数只来自受信环境/credentials：sender数字loopback URL（无默认共享端口）、token的credential引用、预期真实主体字符串UID、固定构建/部署清单摘要及独立数据根；不在普通settings/模型参数添加任意URL或账号。房间沿已保存douyinRoomId；UI只保存默认false的enabled/reply/welcome/thanks及普通安全文字草稿，授权在内存。每个参数文档列来源、默认/缺失行为、合法范围和保存/生效时机；凭据示例只占位。准备脚本参数固定baseline/export目标/patch摘要/离线模式/输出根，输出仅清单与路径，目标存在、基线不符、symlink或patch非唯一匹配失败退出，不能回退复制WIP。

验收映射：场景1–3/8/10→T002路由/Drawer宿主旅程；4–5→T002可信原事件/工具回合；6–7→T001控制器/HTTP+T002生命周期集成；9→T001文本/模板+T002来源隔离。源代码正常分行与缩进，formatter/check按现有可用命令，不能压缩源码。


#### 可复现helper源码与构建

长期源代码/协议schema/无外部依赖go.mod、四个MIT纯算法来源及变更说明/NOTICE、构建支持放在P/src/publicChat/httpHelper/**，不以W唯一源码或硬编码W二进制作为交付。runtime从受保护部署清单读取helper binary路径/源与binary digest，核后加载，不改现有package/lock/build。构建支持必须可从未来checkout内该目录重建到调用方指定的自有W输出；不得自动覆盖P/lib或安装树。

Go1.27.3本机可用，最终manifest重新核工具链、transport源码/Go许可及binary依赖信息。Go module仅标准库+仓内提取的MIT算法，不含外部require；go list -m all/实际模块图必须证明只有本模块。GOTOOLCHAIN=local/GOWORK=off，task-local GOMODCACHE/GOCACHE/GOTMPDIR，GOPROXY=off以防隐式获取；无go install、全局配置或用户cache写入。保留yunsur MIT版权/修改来源与实际Go BSD再分发notice；第三方TLS库的未闭合许可不带入此实现。源码读取/fixture不触真实材料。Go源码/构建支持归原Task同worker完整实现与检查。

#### 验证与资源

验证版本必须是同一119文件停点基线后续增量的源码、raw-only固定D patch、helper Go源码/binary、Node bundle与完整清单。旧107/126/150/205局部计数和旧v7工件都不替代最终验证。下列是最终匹配版本的完成条件，已有局部证据不抵扣未完成项，由同一实现者完成；禁止以全部unavailable当固定正向旅程通过。

- 生产Controller→Client→真实HTTP→Service/Runtime→实际私有helper进程→真实TLS loopback：qualification-only/ACK前零chat请求，helper实际commit且完整ACK/Node当前/L落盘后固定目标恰一次，伪tuple/旧grant/旧Context/任意room或URL零额外请求。不能只计Do或使用相似port替身；真实owner SDK与Drawer纵向仍T002。
- helper commit时间专测：proposal禁止预填final时间；提交前raw、helper已commit但Node尚未publish/current的raw均不能后升级；重复ID返回原grant/time，迟到ACK/新槽不复活；实际正向raw下界max(commit authorizedAtMs,liveEpochStartedAtMs)。
- 原控制六组：稳定ID/跨kind/payload冲突；revoke-before-authorize/during-await/after-commit；旧capture/旧auth取消不伤新槽；授权/撤权丢ACK、无效ACK与重启hold；400/409 busy/503/容量未登记/not_found不能清hold；可查询不可复活的受信rejected终态才可收敛；控制ACK不结算消息unknown。
- F1–F4继承按真实HTTP边界验证：同nonce完整grant贯通；profile/授权每await更换/撤权；真实AuthContext A→B→A、同值/失败维护均同步废旧；TLS前/后与第一次及每次后续应用Write前撤权；revoke ACK后旧continuation零新Write；已经开始Write后零字节/异常/迟到结果仍unknown、活执行仍单在途。原Browser ABA反例原字节/失败保持，另证明raw Browser变化不改实际冻结wire，不能说旧反例自动已绿。
- transport故障真实TLS fixture：完整收请求后断开、半响应/半写、EOF/timeout、301/302/307/308、复用诱导、H2/协议诱导、HTTP响应业务错误，每原operation服务端至多一应用请求；发送前确定终止则零。Set-Cookie各种响应后冻结header/材料digest不变、Jar=nil；profile两固定只读+单send精确请求预算，无隐藏background认证/挑战重放。
- F5/raw：固定decoder真实Long无损/范围、web_rid→platformRoomId可信绑定/冲突与原push连接、旧frame/缺时间/原rawId类型不匹配/上一场/跨grant/断连代全部拒绝；授权后当前有效raw正向允许，礼物仍按增量，模拟输入不升级。Source/Hub/机器人现语义保持。
- 原文本/模板隐私、journal安全/损坏/别名/超限/旧schema保护、owner观察与内部终态证据隔离、旧公开写入口拒绝、loopback/凭据/redirect/构建清单副作用前核验全部保留。当前匿名真实gift、真实平台身份/API/观众可见/标准TLS平台接受NOT_RUN。

##### unknown恢复的必要组合检查

| unknown恢复组合检查（全部NOT_RUN） | 可判定结果 |
|---|---|
| 生产Controller→真实受保护HTTP→Runtime→spawn实际helper→原TLS请求响应丢失，原worker随后joined | 原请求真实wire恰1，三层unknown/hold，终止事实与观察分别记录；helper替身不算这条通过。|
| 同一原消息合法direct观察→显式reconcile→真实helper commit→Node ACK→L落盘 | 原消息仍unknown，原request/sourceKey重放0额外请求；只有新显式资格/授权/新普通文字才出现第2个独立请求；旧grant/队列0复活。|
| never-written joined原记录 | 可信terminal_not_dispatched可恢复未来动作；无joined/活Write/零字节错误不冒充；与正面可见观察矛盾则hold。|
| 错tuple/nonce/hash/文本/时间、备注/未看到/间接/同文他人、owner termination或safe布尔 | 严格拒绝或记录但不核准；受控端无新平台请求。|
| Write栈/清理屏障未释放，pending_join；随后原worker结束 | 未释放时不清单在途；同原控制查询后只基于真实joined完成，保持原unknown。|
| 丢helper/Node/L ACK、落盘失败、重复/跨kind/异payload/容量、乱序完整快照 | 原控制可重复查询且receipt稳定，未知不另ID重试；高head使旧ACK失效，旧head不覆盖新；失败不清其他消息/控制hold。|
| 新观察/冲突在helpercommit后、Nodepublish前、L落盘前到达 | 当前事实代/token不符保持暂停；无自动新grant；已发网络按原不可撤回规则。|
| L重启/Node重启/helper丢失、新nonce/空表、后加冲突 | L构造时采用集合为空/hold；完整历史ACK/receipt须显式同原controlId核对、本次持久化成功并登记内存采用后才放行未来新显式动作。无完整依据仍核原holder，不导入caller证明，不重放原请求。|
| 原首次held ACK写入失败、第二次committed写入rename成功后目录fsync失败 | 保留原exit1反例/字节；修改后当前实例及重建实例均hold，磁盘bit不发布采用许可。|
| never-written与已Write unknown的完整历史receipt干净重启，显式原ID采用成功 | 重启先hold；本次全部持久化成功且实例/原槽/head仍匹配后可未来新显式采证/授权；原request/sourceKey平台重发0，unknown分类与旧grant/队列不恢复。|
| 采用本身write/rename/fsync/close失败、新事实/冲突、旧ACK、缺ACK/错绑定或非法schema/别名 | 不发布或失效依赖采用许可，当前及再次启动都hold；不能用本地fsync/备注/新nonce补证明，不默清degraded。|
| 授权rejected/revoked、撤权ACK、capture取消的实际放行路径与必要故障点 | 持久完整受信ACK，重启显式原ID采用；state/bit不代ACK。authorized ACK不证明撤销；各自hold闭环，不清消息unknown/其他控制，不伤后来无关槽。|
| schema3/损坏/别名/写失败/超限、来源权限 | 原字节保持unavailable；控制响应先核身份和完整引用；真实SDK owner/non-owner纵向仍T002。|

新增事实在旧pending/recovery_unknown期间到达的回归必须证明：先本地hold/持久化，旧controlId查询到可信终态后才新head显式核对；旧ACK只存历史、不能放行当前head。撤权/下播/换live/input后，合法原holder历史核对仍可访问；不得拿新grant/当前代次补原引用。每层hold按原消息闭环，其他控制hold不清。

必要命令形状（计划入口，不作为最终匹配版本已运行证据）：

| CWD | 入口/预期 |
|---|---|
| P/src/publicChat/httpHelper | 指向自有W caches/output的构建支持调用标准go build -mod=readonly -trimpath -buildvcs=false；同源go list -m all及go version -m输出只有本模块/标准库；exit0及binary/notice/源hash齐全 |
| 同上 | go test -mod=readonly -count=1 -timeout=60s ./...；只本helper的显式离线测试，无上游live测试或真实Cookie发现 |
| P/自有源码副本 | Node专属noEmit、发布候选包级适用noEmit及显式.case.ts runner，包含实际helper/TLS完整组合；脚本由实现者核实际CWD/完整命令/exit，禁止head/tail/管道末端成功掩盖错误 |
| W/t001 | prepare只git archive固定D commit导出raw-only副本；已有目标/错基线/不唯一patch拒绝且原字节不动；实际fixed-copy noEmit及最终patch/源清单/Node bundle验证 |
| W/t002，尚未放行 | 既有自有副本tsc/build、直接受影响输入/权限回归、375/1440 Drawer E2E与SDK会话旅程；入口详T002被接受时的完整brief，不提前改接线/usage |

测试资产只.case.ts+显式自有config，不改默认runner；Go tests只在新增helper module，不执行上游服务/二进制。报告真实完整命令/退出码/测试输入及最终所有source/patch/helper/bundle hash，运行结果与NOT_RUN分开。使用动态loopback、自有DSH_HOME；导入宿主前stagePort=0与listen/request guard，禁3080/3081/7390/8757。TLS fixture可信DI不开放生产任意URL/自签CA参数。构建自有副本/输出、依赖只读、lib/备份原字节。finally按自己PID/端口关闭核清，不全局kill/停共享服务。真实账号/平台/开播/产品模型/TTS预算0，无commit/push/worktree/checkout/安装。正式独立Validate/Review仍遵SDLC；不请求整个Feature完成。

#### 正式 Validate 的验收资产纠正（2026-11-14）

独立 Validate 对 e4da234 的实际结果为 INCONCLUSIVE，已由 root 登记 validation=fail；不是确认生产发送实现失败。原输出与偏差保留于下方 Validation 及 W/feat008-validate-59。root 将 T002 恢复 in_progress，仅补齐已定位的验证资产，不改变产品、业务协议或离线/真实结果边界。

允许原实现者串行纠正 P/test/publicChat/e2e/{integration.config.ts,public-chat.config.ts} 的 read-only/strict 缓存设置；P/test/coverage-diff.mjs 的有限 Git diff 缓冲、明确范围与可计量源文件处理；P/test/roomControlIntegration.test.ts 仅在首次宿主 import 前为其实际私有 DSH_HOME 准备 stagePort=0。兼容命令优先使用实际支持的 CLI 缓存禁用或自有缓存路径，不修改全局/default Vitest 配置、不覆盖已被前轮写入的共享缓存。必要测试只在上述范围及原 P/test/publicChat/** 补充，不改生产控制/发送实现；若覆盖率或实际行为需要更大修正，先给具体因果和范围，不降低阈值、删场景或凭文件过滤取得通过。

标准宿主 build 与资产拒绝测试明确允许把现有固定登记 native 复制到任务自有完整构建输出，这是既有 build.mjs 必需的分发动作；不执行该 native，不获取新源/依赖，不覆盖安装 lib/lib.previous，不另复制历史 native 或 node_modules。上轮 root 的泛化“禁止复制登记 native”不再阻止本项必要构建。登记兼容采用已接受的原 profile artifact 目录及 manifest，不能将 read-test-bundle 文件当 artifactDirectory；现有读取成功/失败逻辑不因此放宽。

本次 Build 纠正应给可复用的准确命令、匹配产物及必要受影响检查，并补齐标准构建/资产、正式 Web CLI 两视口和真实私有读取兼容的执行证据；覆盖率明确对应实际本 Feature 变更和适用工具，其他 Feature/第三方/Go 非 V8 源分别归因，不能把不可统计写成通过。旧独立 Validate 中未改且输入/配置/环境相同的有效检查可按适用性保留，Build 检查不能冒充后续独立 Validate。原隔离偏差、全部失败、同 segment 和唯一主诊断未用保持。用户已授权的 e4da234 checkpoint 已推送；本次实现者仍无 Git/state/context 权限，修正候选须由 root 接受并固定新业务 commit 后再次独立验证，未接受前不进入 Review/Ship。

## 规格与规划接受记录

主 Sol 已分别接受 Spec 原字节 SHA256 `331db28912fcad186b67576eb6a85cd4dfba4da1ec345c1d9cc60729d4a0351f` 与 Plan 原字节 SHA256 `fe553cde295b611328ac791593eb329703b0fc8ff60d25973cc53a646e5aada1`，并经 CLI 登记 REQ-011、FEAT-008 和矩阵内全部 Task。登记证据：`/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat-handoff/lifecycle-registration-result.json`。本次标题、实际 ID、权威引用整理不改变已接受产品或工程合同；本线程无 state 写权。

首个 Build 交接时 T001 实现尝试=0、连续不收敛=0、唯一主诊断未用；后续修正或替换保留同一目标 segment 的历史。主会话/独立评审 T3 返回均为 provider=codex、model=gpt-6.1-sol、options.reasoningEffort=xhigh，executedModel=null，实际执行模型标识独立核验未验证；不从 catalog 推断。

## 协议复审与本次收敛

同一独立pass报告`/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/protocol-review.md`，5项P1/2项P2均接受为真实问题/缺合同：P1-01→真实主体/Context证明与代次；P1-02→队列内await后复核/Enter边界；P1-03→sender同步连接代次；P1-04→原执行终止与核对证据分离、无备注解锁；P1-05→sender-only entry/旧路由关闭/凭据与部署清单/真实owner SDK；P2-01→原raw证明+输出WeakMap，不信本地now；P2-02→精确矩阵/先类型检查后原子发布/.case自有config及usage/命令形状。该pass是静态证据，不是运行PASS；按原主线程指令不追加重复复审。相关研究报告不改变本次scope/方案。

## Build 证据：FEAT-008-T001

首次候选新增18个源码文件及13个专属测试文件。实现者报告107项离线case及类型检查通过；主协调者检查结果为 `incomplete`，未请求done、未放行T002。实际模块HTTP组合与受控异步时序实验复现5项未满足行为：sender nonce未贯通导致完整组合零发送、撤权后采证资格恢复、最终Cookie await撤权后仍Enter、重新采证后旧grant仍发送、固定protobufjs解码Long不被raw时间校验接受。详细静态装配/unknown证明缺口及复现命令见 `/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/t001/sol-acceptance/acceptance-report.md`；canonical结果与精确文件摘要在同目录。

主协调者实际复验T02的35个保护源码聚合及安装lib12/备份8个文件全相符；本轮实验未改实现或state，自有HTTP listener已关闭。真实平台相关验证继续NOT_RUN。实现尝试1，本次产生5项新的因果定位，唯一主诊断在首次验收时未用；后续实现与停点见下方证据。

实际T3 task_status：providerInstanceId=claudeAgent，配置model=glm-5.3-flash[1M]、effort=xhigh，executedModel=glm-5.3-flash；模型ID等价和1M上下文未验证。原主线程已只读核配置，保留运行差异，不触发额度兜底；候选及后续修正的接受/模型限制由原主Sol统一处理。

### 模型元数据处置证据（主 Sol）

主 Sol 已只读回查原worker配置，确认 instanceId=claudeAgent、model=glm-5.3-flash[1M]、effort=xhigh。其处置为：保留 configuredModel 与 executedModel 原值，完整身份/容量仍 NOT_VERIFIED；无后缀基础标识既不证明1M生效，也不单独证明配置已换为其他模型。本Task的软件验收不要求1M容量实测，因此披露该缺口后可继续请求同一精确配置，不为此切换provider/model、使用别名、额外模型探针或触发Terra兜底。后续若出现其他基础模型/provider或明确实际配置不符，停止并报告。该处置是验收边界判断，不是模型ID等价证明。

### 实现额度兜底交接证据

GLM批量纠正途中收到provider明确[1308]“已达到5小时使用上限”，给出重置文字`2026-11-13 16:06:43`（提示未注明时区）。这符合已授权AGENTS实现额度兜底，与此前模型标识差异无关。原纠正task已terminal failed并task_cancel，无pending child/approval，本机无所属写入/测试进程。36个当前发布文件摘要、20个改/新增路径、未完成类型检查和原证据保护已记录于 `/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/t001/quota-handoff.json`；35个T02与20个安装保护文件复验相符。

首次Terra只读探针已结束：T3返回providerInstanceId=codex、model=gpt-6.1-terra、options.reasoningEffort=xhigh，宿主运行说明一致；executedModel=null，独立后端执行标识仍未验证。接管继续使用该精确配置，原失败历史和所有完成条件保持，完整接管brief位于 `/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/t001-terra-handoff-brief.md`。现有部分改动/旧bundle/管道末端EXIT=0不作为通过证据，剩余实现与验证由接替执行者完整承担；state不由本线程推进。

### 跨进程授权合同修订证据（2026-11-13）

Terra在同一T001返回qualification-only仍能Enter的真实生产模块反例，主Sol接受STOP及新因果证据、拒绝软件done。主Sol已接受合同候选SHA256 `6f877bbd46d297c140b6900b1e466cc30d1eb4f5d00640676deec32261b621c3`及canonical Plan候选 `9236092d767fc16a020daf8f4913ad7c5038242bd8698f0104c0623e72ea7ff3`，并明确终态rejected与定向capture取消的解释。本文当前有效方案已替换旧本地authorize/资格即grant/泛化revoke/资格采集时间授权边界，W候选仅留作原接受证据，不是第二权威方案。

修订前后原文、diff、精确源码manifest、原反例字节与保护复验见 `/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/t001/contract-revision-02/`。实际基线为L `codex/macos-yovoice@6eb5e3b17a295e7af27a000e98ee1ee1ee679fe6` + T02已接受dirty + 36个publicChat候选；与Terra `correction-01/terra-completion/source-manifest.json`的current逐项相符。35个T02聚合及20个lib/备份保持。修订只更新工程合同，不更改产品/Task/写矩阵或state，不代表运行PASS。

失败历史仍为同一segment：原实现尝试1定位5项因果，GLM纠正额度中断，Terra授权反例进一步定位；两次连续无验收进展且无新因果才触发停止，唯一主诊断未用。继续原Terra的已授权额度接管，不新建实现者/复审/模型探针；configured route为codex/gpt-6.1-terra/reasoningEffort=xhigh，executedModel=null仅标独立执行身份未验证。GLM身份/1M限制保留，不按无时区reset文字或经过时长推定恢复。T001尚未获最终接受，T002依赖未满足、仍todo；真实平台相关保持NOT_RUN。

### Cookie ABA 停点与只读接受证据（2026-11-13）

原Terra本轮以blocked返回：真实隔离BrowserContext在采样间经历认证Cookie A→B→A，当前tracker摘要/代次不变，生产Runtime仍执行fixture Enter回调一次。原反例与失败日志保留在 `/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/t001/grant-revision-03/`；该反例使用局部sendPort/队列替身，不是最终patched Session/完整HTTP或真实平台发送证据。协调Sol只读核对接受此因果定位与STOP，不接受软件done；不把“已有握手”当身份前提闭合。

只读报告、API证据、精确39文件manifest、原结果hash与未生效的认证边界候选在 `/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/t001/sol-acceptance-grant-03/`。39/39同worker停点，35个T02、20个安装输出及55个原证据保持。working sender入口与v7清单源摘要不符，v7导出/旧bundle仅内部匹配早版本；最终源码完整回归/匹配构建与真实装配未完成。当前源类型检查通过仅按worker记录，Sol未重跑未改输入的ABA或其他行为测试。

现有采样不能证明所有Cookie替换；仅受控维护入口写前撤权不足以覆盖浏览器自主变化，当前没有已验证完整事件/顺序来源。原当前有效方案和产品保证均未收窄；候选需原主Sol处置后才能形成新的有效方案/supersedes，不恢复实现、不另派worker/review/模型探针、不放T002、不写state。此轮有新因果，失败历史保留、唯一主诊断未用。T3回读仍codex/gpt-6.1-terra/reasoningEffort=xhigh、executedModel=null（独立执行身份未验证）；真实平台/登录/公屏/开播/产品模型/TTS继续NOT_RUN。

### 冻结HTTP标准库方向接受与生效证据（2026-11-13）

主Sol已全文接受原冻结HTTP候选fa30579ccc72497152ff07e2cf9fd8b4d8b76e52ce3679e3c721372cf3b93370，并以W/t001/frozen-http-plan-04/main-sol-disposition.md作有约束修订：仅Go标准库、helper源码/无依赖go.mod/出处与notice/构建支持进入P/src/publicChat、helper实际commit/time权威、每次后续Write均核原授权。第三方transport分析仅留历史，不进入有效实现；软件尚未done。

本次有效方案已完整替换原浏览器写入/网页profile/Enter/page_submitted合同，保留显式授权/完整绑定/targeted控制、持久hold/unknown/原事件、固定主体与零重发保证。REQ011只泛化必要实现词，不扩大用户功能。前后文/diff、39文件精确基线、35+20保护、原55及扩展历史证据清单见W/t001/frozen-http-revision-05；state未改。原Browser ABA原文/失败不覆盖，不宣称转绿。

同一segment保留原尝试1→5因果、GLM额度中断、Terraqualification-only反例、当前ABA反例；新工程路线不重置失败历史，唯一主诊断未用。继续原codex/gpt-6.1-terra/reasoningEffort=xhigh额度接管，无新worker/review/模型探针；executedModel缺失仍未独立验证，不凭时间猜GLM恢复。最终匹配完整suite与生产HTTP/helper/TLS正向一次/反向零额外请求未跑，不以全部unavailable称完成。真实平台相关仍NOT_RUN。

### 2026-11-13 主 Sol 原请求工作所有权修订（Build 继续，未验收）

主 Sol 接受接续08的新因果STOP：原Transport写入工作可在guarded I/O计数归零后仍活跃，原反例/真实Go exit1及整次15修改+12新增均保留。经只读核对当前固定nil-body GET及安装Go同步Write/ReadResponse、TLS/net取消分支，已将唯一有效实现更新为上述受控同步HTTP1/明确原worker joined；不放松未知结果、授权、原ID、资源归属或完整生产组合。全部原始失败与诊断历史保留，唯一主诊断未用；本次主Sol无行为实验。源依据和处置原文见main-http-worker-disposition-10。T001仍未接受，T002 todo，state/Spec不变，验收指纹missing不补历史；同一Terra由协调者完整supersedes后接续，无新worker/review/probe。

### 2026-11-14 主 Sol 接受冻结原unknown恢复合同（Build继续，未验收）

主Sol已全文接受unknown-recovery-contract-13/candidate.md SHA256 4f411a31eb4e66e0aa02917ae38557461693e7c157c1d96ef6fa9a7b22f19a75，并以main-unknown-recovery-disposition-14/decision.md SHA256 e4e9d300851b3e277aa48165847478946c27303dfbee111a56124c38eefda69d的七项解释明确历史对象访问、每消息一个未终结控制、新事实/原ID终态/新head时序、helper唯一joined权威和receipt重读。本文已机械合入唯一规范，旧候选/STOP仅作历史；schema4与新接口运行仍NOT_RUN，不接受软件done。

修订前后/差异与97源码/35T02/20安装/旧历史及实际state有限变化基线归档于W/t001/unknown-recovery-revision-14。REQ011、Task/依赖和写矩阵保持；state由原主owner唯一串行写，T001未接受/T002 todo，allowed_transitions=[]。REQ012/FEAT009独立登记与新增registration/Q单元来源按主owner实际回执精确核对，不泛化忽略漂移，不干预其执行者/共享接线。旧spec_ready/plan指纹missing不补历史或refresh。

第7次接续局部8测试与专项noEmit不是全链通过；整轮85→97的17改/12增和末片段5改均保留。原F1–F5、握手/ABA、FD/原请求工作及本次三层恢复STOP同segment历史不重置，唯一主诊断未用。候选9分28秒落盘、归档10分19秒的19秒超限照实保留，不追认额度合规。接续仍原codex/gpt-6.1-terra/xhigh，executedModel缺失NOT_VERIFIED，不新worker/review/模型probe。

### 2026-11-14 主 Sol 接受单 journal 当前实例采用修订（Build继续，未验收）

主Sol接受run8的rename成功/目录fsync失败后重建实例误放行新因果，原exit1及119源码停点保留；以W/t001/main-durability-disposition-24/decision.md（SHA256 f0ad1818417113824bf17d5d2be4343400f50943cb76d7517d334a54599f29d4）明确磁盘历史与当前Controller内存采用许可分离。上方唯一规范已替换直接历史放行表述，保留完整合格历史的显式原ID采用正向能力及所有原控制/消息保护，不引第二DB/版本迁移或平台请求。修订前后、差异、119/35/20与历史证据基线归档W/t001/durability-adoption-revision-24；Spec/Task/写矩阵/state不改，软件未验收、T002 todo。原segment/失败/新因果与唯一主诊断未用保持，最终实际helper/TLS及匹配工件完整suite义务不减。


### 2026-11-14 主 Sol 接受 T001 离线核心候选

主 Sol 已读原 run10 完整候选、协调 Sol 的只读验收及实际 loader/纵向 case 源码，接受 FEAT-008-T001 当前离线交付。A 的加载前核验使用受保护 manifest 的实际摘要，并绑定 Runtime/Service；B 已实际经过 createFixedRawSession→RawSenderSession→固定 patched LiveSession/CDP/decodeFrame/原 decoder 与 Long，再进入 Controller→受保护 HTTP→Runtime→spawn helper→本地 TLS。维护分支的 observer 替身不作为主 raw 纵向证据。

接受版本为122源文件清单 SHA256 `291c2f947bb3d8b7fc7e5cb9e2f1653ba424660e3aa581e7a8ffa7aa44dabd6d`、Node bundle `f72c75b5f33c7ec14cacd0ea21368fe053034f62fbc91f9d0638fa19b916a64b`、受保护 sender manifest `332160945a636863f2d4544610a11d2d0c72fb9084c857e2af0d1651aa542fd5`。最终31文件/222项 Node、包级/专项/fixed-D noEmit通过；Go47项源/测试及5项相关配置未变，复用原 run9 的57顶层/选定race和可复现生产helper证据。候选、实际命令及匹配范围见 W/t001/build-identity-raw-build-27/build-result.json；协调完整报告见 W/t001/sol-acceptance-build-identity-27/acceptance-report.md（SHA256 `424441f302a8085137e3844a98616d8f0eeeef45a6bb6355a635d7e6e1dcb1a9`），root最终决定与串行CLI回执归 W/t001/main-t001-acceptance-28/。不为接受重跑未改检查。

35项T02、20项安装输出与原历史保护经同版只读audit匹配，已记录77PID/63端口无当前残留。早期Go系统临时目录路径未记录的执行偏差原样保留，无法逐项独立追溯；不追认为合规、不全局清理，也不把它改写成新增软件缺口。可观察配置 codex/gpt-6.1-terra/xhigh，executedModel=null仍独立NOT_VERIFIED。全部旧失败和唯一主诊断未用保持。

本接受只覆盖本Task的离线核心，不接受整个Feature或真实平台：真实材料/账号/API/标准TLS接受、公开发送/观众/gift/开播/业务模型/TTS仍NOT_RUN；T002的真实owner/Drawer/Agent/事件/usage及后续独立Validate/Review/Ship仍须完成。当前有效方案、产品、Task依赖和写矩阵不改；原spec_ready/plan指纹missing不补历史、不冒称match。T001生命周期仅由root通过既有CLI串行登记，T002仍todo，实际状态以state.json及本次CLI回读为准。


### 2026-11-14 主 Sol 接受 T002 离线宿主候选

主 Sol 接受原 run15 的完整 T002 离线 Build：真实 SDK owner/Drawer、无 live/input/材料时的本机历史、同 host 唯一 Controller 与本 boot 采用、真实 Source→AgentLoop→NativeToolExecutor→sender/helper/TLS、取消回合及模拟来源拒绝均有匹配证据。最终实际 L 源码清单 167 项 SHA256 `04d69db19201d371ea7f1f6b1b31547c44958807dda9841e012672ec849c7811`；44 文件/243 项专属套件、包级 noEmit、隔离标准构建和 1440/375 原 Drawer 各 1 项 E2E 通过。最终 sender manifest `87079e6ebcb9bc524a74c68c9ffb8f558638db39a18d03288bc8d9ebe09616f4`、bundle `45a5331da22a1bea7e2a9cbb7b7254a7b38f3a98320b7d8cc5f2a54334408231`。33 源/4 支持/43 固定导出、84 共享/122 核心/48 登记/20 安装输入经 root 只读核对匹配；未改 Go 源/配置复用原 57 顶层及 race 证据。

完整命令、失败和限制见 W/t002/history-build-11/output/build-result-02.json；root 最终报告、audit 与仅 T002 done 的 CLI 回执见 W/main-public-t002-acceptance-50/。原历史与本续体中间审计覆盖错误照实保留，52 记录 PID/37 端口当前无残留。此为离线 Task 实现接受，独立 commit 绑定 Validate/Review/Ship、真实材料/账号/API/公开发送/观众/gift/开播/模型/TTS仍未完成；不刷新原 missing 指纹、不接受整个 Feature。REQ012/FEAT009、Task 写矩阵和有效工程合同不随本记录改变。

## Validation — e4da2349499eb15048ba2d149a58ca60f1befd45（独立 Validate，2026-11-14）

**汇总 `INCONCLUSIVE`，请求 root `record-validation --feature-id FEAT-008 --result fail`。** `fail` 是必要证据未齐，不表示已证实公屏实现缺陷。本轮未执行 lifecycle CLI、Review、Ship 或业务代码修改。初始分支 `codex/macos-yovoice`、HEAD 与本地 origin 跟踪 ref 均为上列完整 commit，工作树干净；T001/T002 为 done，Feature validation/review/release 均 pending。初始 state SHA256 `fbdcbd82705b44c36597c480e4eb367bf04e1ded04fa6e297b372154a8ad9315`，REQ011 `e165e21a81c2bc9b90269db251b70c2f5ed8fc9cb1c84ff4b0b1a46a3f783f1a`，本文件追加前 `5e72170d0d8127cde796767fae9b58e4bafa11ef6f31ba0fd5d447995319342b`，project `17cf6f07075f746a84bad07f8dc109d394db8fe01fae97b0abb10699f19e10f2`。旧 spec_ready/plan/validation/review acceptance 指纹依 root 的只读结果仍为 missing；不补写或冒称匹配。基线 `6eb5e3b17a295e7af27a000e98ee1ee1ee679fe6` 至提交中的 27 项既有共享依赖不称为 FEAT-008 新增。

UTC 首项实际验证开始 09:50:41；自有 start/deadline 文件按更保守的 09:50:22–10:20:22 记录。以下 `P` 为本包目录，`R=/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/feat008-validate-59`，`F=$R/actual-helper-yx7Tw6`，`G=/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/t002/packaging-build-10/fixture-network-guard.cjs`。每个实际命令的开始/结束、CWD、整数退出码分别在 `$R/output/<名称>.meta`，原始输出在同名 `.log`。公共运行设置：任务私有 HOME/DSH_HOME/TMPDIR/TMP/TEMP、Node 请求与 listen guard、`GOTOOLCHAIN=local GOWORK=off GOPROXY=off` 和任务私有 Go caches；正式组合及公屏覆盖率命令使用 `env -i`、PATH `/opt/homebrew/bin:/usr/bin:/bin`、单 worker、无重试。首次类型/构建准备及兼容性命令继承了环境，其指定的 HOME/DSH_HOME/TMPDIR 和 guard 被覆盖为自有路径，不能声称整套均为 `env -i`。实际宿主首次 import 前使用任务内 settings 的 `stagePort=0`；真实 SDK 引用 Q 的既有只读 `node_modules` 依赖，未读取其 WIP。原固定 D 导出从指定 commit 在 R 重新生成；无网络业务、无产品模型调用。

### Correctness

| 名称 / 实际命令（省略上文相同环境前缀） | UTC 开始–结束 / exit / 结果 |
|---|---|
| `typecheck`: `P/node_modules/.bin/tsc --noEmit -p tsconfig.json`，CWD P | 09:50:41–09:50:42 / 0；包级通过。 |
| `client-build`: `DSH_LIVESTREAM_BUILD_OUT=$R/output/client node build.mjs --client`，CWD P | 09:50:42–09:50:43 / 0；客户端和舞台构建，不等于标准宿主构建。 |
| `prepare-raw`: `python3 src/publicChat/dyhub/prepare_raw.py --repo /Users/mac/hansen_agent_team/workspace/20261109-deepseek-harness/douyin-research/repos/dyhub --baseline 3a79c57d85c59289db3b77211b3ec01fae47d42c --output $R/output/fixed-d`；`sender-build`: `node src/publicChat/dyhub/build_raw.mjs --fixed-d $R/output/fixed-d --export-sha256 832cbc54ed74bbe3b4467ee39aafbd3000ac9d089529ef7b8ae35cb3a400ccb1 --output $R/output/sender.mjs --manifest $R/output/sender.manifest.json`，CWD P | 均 09:50:43 / 0；固定导出摘要匹配，实际 sender bundle `ef7056508d3a7162ab9a3b246f8540dddaf3f3c034ceb5bd86738ea2ccba611d`，manifest `f8017be4f4d721a0a2bba14143ba38047fc6a50b267a786f2f9ccd5880ceb3e6`。 |
| `helper-build`: `sh ./build.sh $R/output/production-helper`，CWD P/src/publicChat/httpHelper | 09:50:43–09:50:46 / 0，离线固定工具链；没有执行登记 native。 |
| `composition`: `P/node_modules/.bin/vitest run --config test/publicChat/vitest.public-chat.config.ts test/publicChat/actualHelperComposition.case.ts --maxWorkers 1 --no-file-parallelism --retry 0`，CWD P；`DSH_PUBLIC_CHAT_FIXTURE_ROOT=$R`、`KEEP_FIXTURE=1`、sender/manifest/固定导出为上述自有产物，私有 Chrome 和合成 preset | 09:51:42–09:52:27 / 0；1 文件、1 通过、0 失败、0 skip。实际 loader→createFixedRawSession→patched LiveSession/CDP/decodeFrame/raw callback，Controller→HTTP→Runtime→派生 helper→自有 TLS，真实 SDK 与源码宿主、Source→AgentLoop→NativeToolExecutor 合成模型协议；日志记录合成模型请求 5、取消及模拟输入零工具。使用源码宿主，不能证明标准打包产物。 |
| `go-test`: `go test -v -mod=readonly -count=1 -timeout=60s -p=1 -parallel=1 ./...`；`go-race`: 同参数加 `-race -run 'Test.*(Write\|Join\|Revoke\|PrepareFixedTargets\|UnsupportedResponseVersions\|ProfileResponseFault)'`（实际 shell 正则竖线无反斜线），CWD P/src/publicChat/httpHelper，`DSH_HELPER_FIXTURE_BINARY=$F/fixture-helper` | 分别 09:53:02–09:53:27 / 0（57 顶层通过，0 skip）和 09:53:27–09:53:58 / 0（27 顶层通过，0 skip）。fixture helper 由本轮组合从当前源码派生并限定 loopback TLS。 |
| `public-coverage`: `P/node_modules/.bin/vitest run --config test/publicChat/vitest.public-chat.config.ts --maxWorkers 1 --no-file-parallelism --retry 0 --exclude '**/actualHelperComposition.case.ts' --exclude '**/buildAssets.case.ts' --coverage --coverage.reportsDirectory $R/output/coverage --coverage.reporter text --coverage.reporter json`，CWD P；`DSH_HELPER_FIXTURE_BINARY=$F/fixture-helper`，`DSH_HELPER_FIXTURE_SOURCE=$F/helper-source`，其他输入同上 | 09:54:20–09:54:53 / 0；42 文件、239 通过、0 失败、0 skip；含真实 SDK owner/guest/未认证、保存、加载前身份检查、授权撤权/迟到/unknown、原 ID 恢复、来源、欢迎/gift、文本策略与真实 HTTP 拒绝。组合已另行执行；排除的资产测试会复制 58 MB 登记 native，违反本轮边界。 |
| `compatibility`: `P/node_modules/.bin/vitest run test/roomControlIntegration.test.ts test/douyinSource.test.ts test/ttsSettings.test.ts test/courseTurns.test.ts test/courseLifecycle.test.ts test/robotLive.test.ts test/sessionContextRead.test.ts test/readOnlyQuery.test.ts --maxWorkers 1 --no-file-parallelism --retry 0`，CWD P | 09:55:47–09:56:10 / 0；8 文件、94 通过、0 失败、0 skip。证明所选旧房间、匿名输入、声音设置、课程、机器人及有界读取行为；不是登记私有读取全链。 |
| `private-build`: `node test/registration/build-read-fixture.cjs`；`private-read`: `node test/registration/read-routes.case.cjs`，CWD P，`REGISTRATION_TEST_ROOT=$R/registration-fixture`、`REGISTRATION_TEST_ARTIFACT=$R/registration-fixture/read-test-bundle.mjs` | 均 09:56:10；前者 exit 0，后者 exit 1：断言期望 `configuration_unavailable`，实际 `artifact_unavailable`。本轮误把 bundle 文件作为 `artifactDirectory`；源码要求受信工件目录/manifest，故该失败不能归因实现；已保留日志，不重跑同输入。匹配的已提交工件目录未确认，登记私有读取兼容 `INCONCLUSIVE`。 |
| `diff-coverage`: `node test/coverage-diff.mjs 6eb5e3b17a295e7af27a000e98ee1ee1ee679fe6 $R/output/coverage/coverage-final.json`，CWD P | 09:57:36 / 1，Node `spawnSync git ENOBUFS`，脚本在读取完整基线 diff 时失败，无 diff 汇总；不得以 suite 总数代替。原始输出保留。 |
| `go-coverage`: `go test -mod=readonly -count=1 -timeout=60s -p=1 -parallel=1 -coverprofile=$R/output/go-coverage.out ./...`，CWD P/src/publicChat/httpHelper，fixture binary 同上 | 09:58:42–09:58:59 / 0；模块 statement coverage 74.3%，不是新增/改动代码行覆盖或分支覆盖；此项为补充覆盖测量而重复全量测试。 |

覆盖结论 `INCONCLUSIVE`：V8 报告为排除两文件的部分套件，报告全文件聚合 lines 77.44%、branches 71.05% 不能当作 FEAT 改动行/分支结果；diff 工具 ENOBUFS，Go statement 74.3% 也不能替代行/分支指标。默认新增/改动代码 80% 行、70% 分支尚未证实，不能据此判断已满足或宣称具体实现未达标。标准 `node build.mjs`、构建资产缺失/错 hash/symlink 对标准宿主闭包的本轮检查 **NOT_RUN**：当前 build 及 `buildAssets.case.ts` 会复制 57,996,370 字节登记 native，明确禁止本轮复制；未修改源码/测试/构建配置绕过。已测 loader 本身的错摘要/symlink/加载前 sentinel 拒绝，不等于标准宿主资产检查。

### E2E

| 旅程 / 场景 | 覆盖 | 本轮事实与剩余条件 |
|---|---|---|
| 1、3 保存零派发、真实 SDK owner/guest/未认证、未装配与错误资格 | PARTIAL | `composition`、`hostSettingsSdk.case.ts` 实际通过，合成宿主和来源；指定 Web CLI 旅程未执行，且相关旧兼容仅选定回归。 |
| 2 固定账号/房间授权、一次发送及真实结果层级 | PARTIAL | `composition` 真实 raw/HTTP/helper/TLS 组合和原 SDK Drawer 通过；标准宿主构建产物及指定 Web CLI 尚缺。另一观众与真实平台发送 **NOT_RUN**。 |
| 4 当前事件/Agent、旧回合和模拟来源 | COVERED（离线） | `composition` 合成模型协议调用实际 Source→AgentLoop→NativeToolExecutor，日志记录取消与模拟来源无工具；`eventRefAgentTool`、`agentTurns` 等包含在本轮 239 项。无真实产品模型调用。 |
| 5 欢迎与 gift 增量 | COVERED（离线） | `rawProofWelcome` 15 项和来源/正文策略本轮通过；真实匿名 gift 接收 **NOT_RUN**。 |
| 6 切换/撤权/断连、队列和迟到 | COVERED（离线） | `composition`、`correctionComposition`、`senderClientGuard` 与 Go race 本轮通过。 |
| 7 unknown、重启、不可借新 ID 重发 | COVERED（离线） | `composition`、`schema4Composition`、`controllerSend` 和 `frozenRecovery` 本轮通过，原请求被保留。 |
| 8 原 ID 核对及本 boot 采用 | PARTIAL | 本轮组合和历史/核对 case 通过；原 Drawer 正式 CLI 旅程尚未运行。 |
| 9 联系方式/链接/模板注入与匿名保护 | PARTIAL | `textPolicy`、`rawProofWelcome`、来源及旧房间测试通过；登记私有读取的匹配工件未就绪，兼容性未证实。 |
| 10 375/1440、键盘、错误/空态/重复提交 | PARTIAL | Node 合成 owner journey 和 `settingsPanel` 通过；指定 tester-army/e2e CLI/Web engine 的两个 viewport、键盘和完整视觉反馈 **NOT_RUN**。 |

`e2e:OpenAPI` 为 `PARTIAL / INCONCLUSIVE`：本轮 `senderEntry`、`senderClientGuard`、`hostSettingsSdk` 和真实组合执行本地 HTTP、身份、状态及拒绝断言；标准构建宿主接口及登记私有读取尚缺。`e2e:Web` 为 `MISSING / INCONCLUSIVE`：被提交的 `test/publicChat/e2e/integration.config.ts` 明确 `cache.mode='off'`；本机 e2e 0.23.0 的 `run --help` 无设置 read-only 模式的参数，安装实现的 `resolveCacheConfig` 保留显式 off，`createAgentCacheContext` 对 off 返回 undefined，`--strict-cache` 不能将 off 改为 read-only。当前 `sdlc-validate` 要求显式 read-only，且该正式旅程要求标准宿主产物；不修改配置、录制、断言，不以组合或旧 Build 的 1440/375 通过替代。需 root 协调 Build 准备合规的已提交配置/工件及获准标准构建条件后重验。真实账号、登录、平台 API、平台消息、另一观众、gift、开播、TTS、设备与真实模型均 **NOT_RUN**；离线验收不外推外部验收。

原始证据 SHA256：`composition.log` `e66838cba59f736b9c864f3bc0239b5c143a5397616e9a2b82307a5c9518f680`；`public-coverage.log` `fbc1c2475a6d53fbd8ad6e48bc80523cb00d663af1fb1a796ac5a3a2f2429997`；`coverage/coverage-final.json` `98ecb43aaa5aafc0174699845e0d7e884ae8e973cb384e365b2fd0d2c5b03493`；`go-test.log` `c826fd7fb2c595e5f019b540c5fa3f159fb0aefbbaca58c94212575509637e56`；`go-race.log` `356d63b53b28eda055b2b8127f6e9909a8cad6947c833fed90a4e5b3a551a4d9`；`go-coverage.out` `b46fa49c3f89fae5e7d00d3b4a472ccb152c29c9058e507dfb7d8f6192d1e5d2`；`compatibility.log` `37a72db455de9a60b28386514a6410f63a69a0b9b14535450b9af9c4d35e10fa`；`private-read.log` `3961046da7f9deff34f638f8363c3b9e15f1be40488451b3d387086ab952d053`；`diff-coverage.log` `1731b760fe8b251cae2ccfe934bc7abcbcad2b150fa70a935b35e6df88dbba7b`。配置输入：P/package.json `b7b33fe4205c241b67a6d439e76cdaed7d78e628dd702af0350f54d6ab26a3c4`，build.mjs `f37239873e8cc33996982e89082a81ee4be54c7c19612fd801cf5df0a28444d7`，专属 vitest config `f4fbd913e6f035e2dcdc7e432cf5dcb33e83632391ababa2def175b6e33e7e36`，已提交 integration config `227e42a03753e1ad3ca14e656f7a142ec37a006d8f1386265570f95b49c80404`，旅程 `25113f876754b0abae5b7461d2fcde5eed72e1de9956279c2ec536b70263df83`。

资源与边界：从本轮日志提取的 23 个记录 PID、81 个记录端口在 `output/resources.json` 快照中均无存活/监听（SHA256 `4f2e4d09b62e95ec467c40e6d16edc16e184f7fe627cf02f1128fb4b9dcfca1a`）；PID/端口复用可能，兼容性 runner 和非 verbose Go coverage 的未记录子进程/端口不能由此证明，未全局 kill 或清理。原较早 Go 系统 temp 路径未记录的限制继续保留。安装 `lib` 12 项、`lib.previous-92a3019` 8 项按 `W/t002/build-handoff-preparation-01/protection.json` 在本轮中途和末尾核对，成员与摘要均匹配；末次原始 `output/installed-audit.json` SHA256 `16123db69120da38e04bc0c458de78506b20cc48b18be25dc3a2888396e9ecc2`。

**边界偏差如实记录**：兼容性测试使用仓库默认 `vitest.config.ts`，其默认结果缓存实际写到了 `P/node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json`；mtime `2026-11-14T17:56:10+0800` 与该命令结束相符，违反了本轮只写自有目录的限制。原内容未知，未删除、回滚或再次覆盖；后续运行须先确保缓存重定向或禁用且不改变受测配置。验证期间另一写者于 09:58:50 UTC 更新了 `.sdlc-v1/state.json` 中 FEAT-009 plan 及 `.sdlc-v1/context/FEAT-009.engineering.md`，本执行者未写入；状态当前 SHA256 `7bfc5a40339a21408a38a43304f043160f08d7ff5e6e5eecc5ecfab67ad4822c`。root 应按实际共享工作树核对这些外部变更，不能称最终仅本文件 dirty。`executedModel` 的独立元数据仍 `NOT_VERIFIED`；`project_candidates=[]`。

后续 authority 协调：root 指定的 `W/main-field-id-source-trace-60/authority-update.json` 实读确认上列 state 前后摘要及仅 FEAT-009 acceptance plan 时间、Plan 摘要和 FEAT-009 更新时间三处变更；仅对这项有来源的 metadata 差异采用例外，不改变本次 FEAT-008 验证输入、提交或结论，也不刷新任何公屏 missing 指纹。

补充隔离偏差：`compatibility` 中 `test/roomControlIntegration.test.ts:71` 在首次宿主 import 前将 `DSH_HOME` 改为该测试自建临时目录，未先在该目录写入 `settings.stagePort=0`。先前为 `$R/compat-home` 准备的设置不适用于该测试自己的目录；该项虽通过且本次 Node request/listen guard 生效，不能声称满足本轮宿主 import 前隔离要求。其 6 项仅作受限观察，正式兼容证据尚缺。相关临时目录由测试自身清理，未重新运行、修改测试或扩大授权；其他兼容项的通过数不因此改写。

### 公屏覆盖率补齐的执行策略（2026-11-14，主 Sol）

root 已核原 run16 的四文件补丁、52项 V8 源与其基线摘要，以及48项命令日志/metadata摘要，全部匹配。接受双视口严格只读 Web 旅程、94项兼容、标准/重复构建、资产拒绝与正确工件目录的私有读取增量；T002仍 in_progress，Build incomplete。当前已测改动行5165/7760（66.56%）、分支2471/3230（76.50%），不降低80%/70%。详见 W/main-public-coverage-65/run16-assessment.json；旧失败、隔离偏差和唯一主诊断未用均保留。

只读定位表明测量有两个不同来源：build_raw.mjs的子进程执行、verified_sender_loader的原生动态导入、sender bundle和浏览器执行未归回仓库源码；另一方面automaticEvents及保留的旧controller/runtime分支确有未覆盖范围。不能把所有零值都归为工具问题。生产sender构建未输出source map，现有V8报告中的copy/bundle执行不能仅按文件名合并或凭metafile声称逐行命中。

当前纠正继续由原实现者完整承担，仅写原四个测试/工具文件与P/test/publicChat/**。允许在此测试目录实现可复用的覆盖采集/转换/合并与必要的行为用例，采用现有依赖，不改生产源码/构建/锁文件/default runner。不为覆盖率复活旧浏览器发送。优先采集现有有效组合的真实计数，再补有行为断言的缺失场景。原生Node进程/动态模块可使用受控V8/Inspector覆盖采集，浏览器采用既有本地测试runner支持的覆盖接口。源码映射须以同一输入、源码摘要、实际运行bundle字节及source map相符为依据；测试侧可复建独立sidecar map，但只有生成JS与实际被测JS逐字节相同才可使用。无法证明映射时保持未验证，不改生产身份验证或向已核bundle插入代码。合并须保留真实零计数、未执行分支与每份来源；不能按不相容statement ID合并、复制命中或删分母。这里不新增“每种执行上下文均必须合并”的完成条件：若准确的源码测试计数已覆盖完整范围并达到阈值，未映射上下文保持零命中，原组合仍独立证明行为，也可满足计量要求；采用最小可核方案。

完整Feature V8范围清单保留所有公屏源与七个共享接入文件；既有其他Feature/Go/非V8归因不变。测试工具须拒绝来源缺失、错误摘要/源码、映射到未核成员、零分母及低于阈值的反例。Go检查继续按已核输入使用原57顶层/27选定race与实际coverage.out分开陈述，不把74.3% statements冒称改动行/分支已通过；最终独立Validate仍须明确适用覆盖的未证实项，不能因V8通过自动放行Go未知指标。

本次有限纠正执行窗口40分钟，从首次当前实际执行记录起；新自有输出上限2GiB，串行、无自动重试、离线/loopback，真实平台/账号/业务模型/TTS/资料native执行预算0。未改的Go、Web、兼容、构建证据可按同输入复用，不无依据重跑；受影响的测试和最终相关覆盖套件必须实际运行，独立Validate仍用新执行者。若需生产变化/依赖安装/更大写域，先返回具体原因和剩余项。超时不续额，同segment与失败/诊断历史不重置。

### Build 覆盖增量接受及 Go 原生检查约定（2026-11-14，主 Sol）

主Sol已核run17的8项源码增量、204项基线及52项coverage成员，85项产物/命令/日志摘要均符；实读四个行为测试、来源采集器、计量工具和两处源码选择开关。接受Node覆盖增量：48文件260项全通过，同一完整范围6456/7760行（83.20%）、3032/3942分支（76.92%），未合入浏览器或未匹配bundle计数；真实源码host/helper/TLS组合及默认构建路径1440/375正式旅程通过。基线只有3项授权测试文件改动，生产代码未改。证据W/t002/coverage-completion-65/output/build-result-06.json，root核对W/main-public-build-acceptance-67/assessment.json。仍非独立Validate，T002暂留in_progress。

本Feature明确采用按语言的项目覆盖约定：V8新增/改动源码保持80%行、70%分支和现有完整范围；Go helper使用标准go test -coverprofile的全模块语句覆盖至少80%，包括改写的四个算法文件，不过滤main.go或未命中文件，并保留授权/撤权、真实应用Write至多一次、未知结果/原ID恢复、响应限制、认证材料和并发失败分支的明确行为断言及适用race证据。Go原生coverprofile仅提供代码块计数和语句数，不能据此输出JavaScript式分支率；这里是主Sol对本Feature验证策略的明确项目约定，不宣称74.3%或80%语句等价80%行/70%分支，不外推其他Feature，也不为获取分支数字自研Go覆盖工具。质量判断由后续独立Validate/Review核查；真实平台仍另行验收。

上述决定依据已读profile：旧Go覆盖仅74.3%语句，main.go0/39且部分实际helper执行在未插桩子进程中；bd_ticket、auth_context、params等亦有真实未命中代码块，不能全部归因工具。当前非test helper源及支持27项原字节匹配。只授权同一原实现者继续完整补齐Go必要行为测试（P/src/publicChat/httpHelper/*_test.go）及确需的P/test/publicChat/**测试支持，不改任何生产源/算法/协议/默认构建或依赖。优先复用现有fixture与断言；全模块原生coverage一次运行应同时完成原57顶层与新增检查，必要受影响race按实际风险选择。生产源/Node测试未变时不重跑260项Node、旧Web或全套兼容。25分钟有限窗口、单并发、自有HOME/TMP/Go缓存、离线和任务loopback、新输出<=1GiB；这是公屏Go测试检查，不续资料native额度，资料native/Keychain/真实平台/模型/TTS预算仍0。原失败和同segment/唯一主诊断未用保持。

用户已明确当前暂无真实发送条件，将与抖音直播间一起验收；本轮继续软件交付，真实发送/另一观众核验保持未完成，不任意选择账号或房间。资料原run16已结束并归档，仅收回未发布诊断候选，没有续派，T001仍incomplete。

### 主 Sol 最终接受 T002 软件候选（2026-11-14）

接受run16–18的验证资产补齐。Go最终65顶层/0skip，全21个生产Go文件1531/1840条语句（83.21%），含main()未命中部分，不声明Go行/分支率；新增3个_test.go覆盖合成签名、独立ECDSA验证/HKDF向量、ECDH/证书及材料/部署/有序参数失败路径。27项non-test helper与209项当前输入均符，Node260/80行70分支、标准/重复build、兼容94和双视口旅程按各自匹配输入接受。root实读新增测试，39项Go结果/日志/产物摘要匹配，详W/main-public-final-build-acceptance-68/acceptance.json。

首次gofmt使用继承环境、早期Go telemetry实际local的偏差原样保留，不能事后追认完全隔离；local目录在任务私有HOME，随后实际off且完整65项复验通过。接受当前有效软件/最终检查，不以历史偏差虚构新产品缺陷或重复不变检查。旧未记录系统temp/编译子PID等限制照原，不全局清理。原失败、同segment、主诊断未用和executedModel NOT_VERIFIED保持。

T002离线软件实现完成，root将以合法CLI置done并固定推送候选；Feature仍待正式独立Validate、独立Review与本机发布smoke。当前144项coverage范围含新增3个Go测试的非V8分类，52项V8源/原基线未变；旧Build报告/receipt不改，正式Validate用W/main-public-final-build-acceptance-68/coverage-scope.json生成其独立报告和receipt。用户明确真实发送与另一观众核验后续与直播间一并进行，该项仍未完成；不将软件测试通过称为平台可见、完整真实交付或整个Goal完成。


## Validation — 832e14ee02e97acfab4940b6a1343b96cf41aa9f（独立 Validate，2026-11-14）

**结论：INCONCLUSIVE；请求 `record-validation --feature-id FEAT-008 --result fail --commit 832e14ee02e97acfab4940b6a1343b96cf41aa9f`。** 本轮必要软件运行多数通过，但故事 10 的视觉/可达性证据存在下列具体问题；不得将 CLI 的 locator 通过直接作为该条件通过。未修改实现或测试；由 root 评估并安排修正/重验。真实发送与另一观众观察由用户明确延至直播间联合验收，不计为本轮已实证。

### 输入、环境与证据索引

被测 L=`/Users/mac/hansen_agent_team/workspace/20261109-deepseek-harness/dsh-livestream`，P=`L/packages/dsh-livestream`，R=`/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/feat008-validate-832e14e-69`。13:29:58 UTC 首次 preflight，截止 14:04:58 UTC；执行前后业务 HEAD 与 origin/codex/macos-yovoice 均为上述 commit，执行前及本次附加证据前 L 工作树干净。`feature-projection`：T001/T002 done、Feature in_progress，validation/review/release pending。输入 Spec `e165e21a81c2bc9b90269db251b70c2f5ed8fc9cb1c84ff4b0b1a46a3f783f1a`、Plan（追加前）`2891ec3d98b3c180ae116f60f75ba05ef8de92edaeae9225a28c14d938050c9a`、state `f5798e7e1b3857eebc65bfa554d8ebe479fbcf4a90920d5fbebfe44013615b85` 均与 authority 一致。`verify-acceptance` 的 spec_ready 与 plan 均为 **missing**，不是 match、也不是 stale；按 root 已接受的当前语义与精确 Plan 执行，不补旧指纹。

全部实际命令的完整 argv、cwd、脱敏显式环境、PID、精确 UTC 起止与 exit 在 `$R/output/<名称>.json`，对应原始输出 `$R/output/<名称>.log`；以下时间均 UTC，exit 为进程实际退出码。命令由 `$R/run.py` 以最小显式环境启动（等同 env -i）：私有 HOME/DSH_HOME/TMP/XDG/Go caches，单 worker、无测试重试、只读依赖、loopback guard；宿主 import 前 task settings 为 stagePort=0。`go telemetry off` 随后 `go env GOTELEMETRY GOTELEMETRYDIR`：off，目录在 R 私有 HOME。Go 1.27.3、Node 26.13.0；GOTOOLCHAIN=local、GOENV/GOWORK/GOPROXY/GOSUMDB=off。客户端截图与合成账户数据均为任务 fixture。注册 native 仅按明确许可复制和做 hash/mode 检查，未执行。

### Correctness / 构建与兼容

| 名称（完整命令及环境见对应 JSON） | UTC 起止 / exit / 实际结果 |
|---|---|
| `typecheck`：P 的 `tsc --noEmit -p tsconfig.json` | 13:32:26–13:32:28 / 0 |
| `build`：P 的 `node build.mjs`，`DSH_LIVESTREAM_BUILD_OUT=$R/output/host` | 13:32:28–13:32:29 / 0；标准宿主、客户端和舞台均输出到 R。`client-build` 13:38:22 / 0；前后 53 个非客户端文件 hash/mode 与成员一致。 |
| `registration-build-assets`、`registration-output-symlink` | 13:42:13–13:42:14、13:42:14 / 均 0；两次标准构建、client 保留及 native missing/wronghash/symlink 和输出 symlink 拒绝；测试报告 nativeExecuted=false。公屏 `buildAssets.case.ts` 的 missing/symlink/new-dependency 3 项包含在下述全量 suite 中。native 本次源/产物 SHA256 均 `154145d18732e0a1823d91be611dcff55bdda36ac46c1fce7c3354748d9e94c4`、均 mode 0500、57,996,370 bytes；NOTICE/许可输出 mode 0400、字节摘要与源相符。详 `output/audit.json`。 |
| `prepare-raw`：原 `prepare_raw.py` 从 D 仓库固定 `3a79c57d85c59289db3b77211b3ec01fae47d42c` 的 git archive 导出到新 R 路径 | 13:32:29 / 0；archive `127c884b84a34a59d3cd0cfcbd438d4b3a49fe3d25b6da8a7bb6490491b6881b`，export manifest `832cbc54ed74bbe3b4467ee39aafbd3000ac9d089529ef7b8ae35cb3a400ccb1`。`raw-typecheck` 13:49:33 / 0，复用只读 D node_modules；无读取 D 未提交源码。 |
| `sender-source`、`sender-built`：分别以当前源码和标准构建的原 `build_raw.mjs` 处理本轮固定导出 | 13:33:42、13:33:41 / 均 0；source bundle/manifest `9c36514e91ffdcd2b62f1878f12f82b6757f128db1588ab24b8b94cf7e4846b3` / `e7d9395f7e15103be4450fd75f4a87aaee324c743763764c70b9c07b3ea9e303`；built bundle/manifest `a041ec1456934a6eede6902d5322ff69e3ec2eaa1ecd06595b4d596d88be463c` / `1853a4d1c704cfc5723340af737799cb94fcb06b40e2196a5809f16cadaded69`。实际绝对位置不同，清单身份分别核验。 |
| `go-build`、`fixture-build`、`go-modules`、`go-version-binary` | 13:33:42–13:33:46、13:34:11–13:34:12、13:49:33、13:49:33 / 均 0。生产 helper 离线构建、不用于真实发送；模块列表仅本模块。私有 hello fixture 从当前源码复制，仅 main 准备调用替换成已有受控 fixtureTargets 并复用原 fixture 定义；真实纵向行为由 actualHelperComposition 自建动态 loopback TLS fixture。生产/fixture binary SHA256 `d51c6b6a29efa37fb8deaa84a4fae347caf078d1ce6b42adebc1d896ed4ce76f` / `b3b46438d5b3245dea52b535900fd803f647aecdda380175b10b1ebc5472ef76`。 |
| `go-coverage`：`go test -v -mod=readonly -count=1 -timeout=60s -p=1 -parallel=1 -coverprofile=$R/output/go-coverage.out ./...`，CWD P/src/publicChat/httpHelper | 13:34:30–13:34:57 / 0；65 顶层通过、0 skip；21 个生产 Go 文件含 main，1530/1840 **语句**、83.15%（原工具显示 83.2%），不是行率或分支率。`go-cover-func` 13:34:57 / 0。 |
| `go-race`：同目录 `go test -v -race -mod=readonly -count=1 -timeout=60s -p=1 -parallel=1 -run 'Test.*(Write\|Join\|Revoke\|PrepareFixedTargets\|UnsupportedResponseVersions\|ProfileResponseFault)' ./...`（实际 argv 内竖线无转义） | 13:45:52–13:46:25 / 0；27 顶层通过、0 skip。此次独立重验，不依赖旧 race；关键授权/撤权、原 Write 至多一次、unknown、响应限制、材料、joined 并发行为对应 `$W/t002/go-native-coverage-67/output/behavior-mapping.json` 中的测试，均在本轮 Go 输出中。 |
| `coverage`：`node test/publicChat/run-source-coverage.mjs <scope> <report> <receipt> -- vitest run --config test/publicChat/vitest.public-chat.config.ts --maxWorkers 1 --no-file-parallelism --retry 0 --no-cache --coverage ...` | 13:35:08–13:36:31 / 0；48 文件、260 项通过、0 skip，包括 actualHelperComposition 和 buildAssets；`DSH_PUBLIC_CHAT_COVERAGE_SOURCE=1`，同时提供本轮标准 built 和本轮 source sender/manifest。组合实际经过固定 patched raw Session/CDP/decodeFrame→Controller→HTTP→Runtime→实际 fixture helper→loopback TLS；合成模型 5 请求，不是实际模型。 |
| `coverage-diff`：以 `6eb5e3b17a295e7af27a000e98ee1ee1ee679fe6`、当前 144 路径 scope 与本轮 receipt | 13:36:58–13:36:59 / 0；改动行 6456/7760=83.20%，分支 3033/3943=76.92%，超过 80%/70%。scope SHA256 `6f8114067397a7990b4bce852502e82d667fca90600555a133c7e1eeb01a525c`；未把浏览器或未归源子进程命中凭空合并，真实零值/未计量保留。report/receipt SHA256 `e34f020e6a0ad8dcc7e671ba40dacbd15955684590caf3238401f14b150548fa` / `01fd207ed8e1df656f97e7485c6bb3f1a5dbb8e56a3efd34bd6c7b5ec4558d41`。 |
| `compatibility`：原 8 文件含 roomControlIntegration 的 Vitest 命令，`--no-cache` | 13:36:59–13:37:22 / 0；8 文件 94 项通过（roomControl 6 项），0 skip；原 test 在实际临时 DSH_HOME import 前设置 stagePort=0。 |
| `private-build-corrected`、`private-read-corrected` | 13:37:58–13:37:59 / 均 0；实际读取指定 registration-profile **目录**，其 manifest SHA256 `cff638ff461fab35b082e93d62c28c768472688d03888b69864700f89abb8fcb`；真实 SDK fixture、Node 子进程替身，授权前无读取、撤权/配置变更迟到拒绝、无写。非真实 Harness 用户身份，也未执行登记 native。首次自有目录权限错误见下。 |

### E2E、截图与未通过的视觉证据

四次均使用已提交配置和测试的逐字节副本（配置及测试各 SHA256 见 `$R/runner`；与 P 原文件一致）、tester-army/e2e 0.23.0 CLI、Chromium 156、strict read-only cache、1 worker、0 retries、任务内 profile、实际标准 built sender/host，本轮无 `DSH_PUBLIC_CHAT_COVERAGE_SOURCE`：

| 名称 | UTC 起止 / exit / 实际结果 |
|---|---|
| `e2e-settings-desktop-corrected`、`e2e-settings-narrow` | 13:40:03–13:40:12、13:40:28–13:40:34 / 均 0；1440×900 与 375×812 各 1 测试、1 通过，保存零 sender 动作及失败保留草稿。 |
| `e2e-integration-desktop`、`e2e-integration-narrow` | 13:40:34–13:41:18、13:41:18–13:42:03 / 均 0；各 1 测试、1 通过；合成 owner 通过 built sender 单次发送并核对原 unknown，零重试。 |

每次新鲜 `report.json`、JUnit、逐步 trace 位于 `$R/runner/.task-e2e/{settings-desktop-corrected,settings-narrow,integration-desktop,integration-narrow}/`；fixture 日志及 `e2e/*/output/*cleanup*.json` 有各自服务正常退出记录。由于 runner 放在 R，框架报告中的 VCS 自动识别为外层仓库 `9b16b514.../main dirty`，不是本次业务 commit；commit 关联依据 L 实际 HEAD、提交配置拷贝 hash 与命令中本轮 built 资产，不能把报告 VCS 字段当 832e14e。测试使用确定 locator，真实模型调用为零；浏览器 fixture 中有合成模型协议调用。CLI trace 记录 stagePort=0 的舞台预览/图片 `ERR_UNSAFE_PORT`、fixture 未注册的 events/room-control/registration 路由 404；保留观察，不据此宣称舞台或这些其他路由已在此旅程验证。CLI 本身未输出 PNG；以下补充组合实际产生截图。

`built-visual-corrected` 13:44:54–13:45:39 / 0，实际使用本轮 standard built host/sender 和 `actualHelperComposition`/`owner-journey` 默认 built 分支，1 文件 1 项通过，输出 `$R/output/owner-journey-52438-trace.zip` 和截图。**截图直接观察**：`owner-unknown-52438-1440.png` 实测 1440×900、`owner-unknown-52438-375.png` 实测 375×812，两个视口都出现 Drawer 左侧文字/按钮部分裁切；375 图中“维护发送材料”等文字不能完整显示。`PublicChatSettingsPanel.tsx:167` 的操作行使用 `dl-row`，`console.tsx:1598,1664` 为不换行 flex 与可滚动 Drawer；这提示需要检查横向溢出与滚动状态，但截图本身不足以证明所有被裁切控件不可通过横向滚动或键盘到达，不把猜测当成确定根因。**测试资产问题**：`owner-journey.ts:409` 将 viewport 设为 375，之后 `:457` 保存文件名 `owner-drawer-...-1440.png` 前未恢复 1440；实际两个 `owner-drawer-52438-{1440,375}.png` 均为 375×812。不要以文件名宣称晚期状态有 1440 截图。以上裁切与误标使故事 10 响应式/可达性证据为 PARTIAL / INCONCLUSIVE；请 root 交回核实并补齐后重验。

### 首次失败、保护和范围

- `private-build` / `private-read` 首次 13:37:22 均 exit 1、入口报 `test_paths_unavailable`：本执行者新建的 R/registration-fixture 为 0755，而测试要求 0700；修改此任务目录权限后显式运行上述 corrected 命令通过。原失败日志保留。
- `e2e-settings-desktop` 首次 13:38:56–13:38:57 exit 3，0 测试、无报告：私有 HOME 中未配置已有浏览器，框架自动尝试下载 Chromium headless shell，内部尝试 5 次均被 loopback 网络 guard 拒绝，未下载安装；此自动重试与本轮不自动重试约束存在执行偏差。首轮框架提示遥测默认启用，不能声称首轮已关闭；连接保护生效，但不臆称遥测发送状态。随后复制本机已有 shell 至 R，明确设置 `PLAYWRIGHT_BROWSERS_PATH`、`E2E_TELEMETRY_DISABLED=1` 和 `DO_NOT_TRACK=1`，手动 corrected 运行；原失败日志保留。
- `built-visual` 首次 13:43:57–13:44:18 exit 1，1 项失败，`dsh-livestream: 找不到插件包目录`：本执行者漏设深层隔离输出所需 `DSH_LIVESTREAM_PACKAGE_DIR`；实际 runtime 的包查找条件与已提交 integration config 的参数确认该原因。显式补充 P 路径后 corrected 运行通过；首次结果不抹除。
- 本次 R 输出约 1 GiB，低于 2 GiB。安装 `lib` 12 文件和 `lib.previous-92a3019` 8 文件成员及 SHA256 与既有保护基线匹配，未覆盖。`output/final-resources.json`：从本轮日志/命令提取的 137 个 PID 无存活、94 个端口无监听；只证明已记录资源，不能证明未记录的后代或旧 Go temp 路径，旧 run16/17/18 隔离偏差和原诊断历史保留。未杀共享服务。

### 故事、使用和范围映射

| 故事 | 本轮合成/loopback 结果与边界 |
|---|---|
| 1 | COVERED：settings 双视口、`hostSettingsSdk`；默认关闭、保存/失败及零 sender 动作。 |
| 2–3 | 软件路径 COVERED：built integration、`identityQualification`、`senderEntry`、`senderClientGuard`、Go grant/race；固定目标、owner/非 owner、拒绝和一次性边界。真实账号、真实身份、平台接受及另一观众 **NOT_RUN / DEFERRED**。 |
| 4–5 | 软件路径 COVERED：`eventRefAgentTool`、`agentTurns`、`rawProofWelcome`、`automaticEventsCoverage`、actualHelperComposition；当前原事件关联、去重、欢迎/礼物增量。真实匿名 gift **NOT_RUN**。 |
| 6–8 | 软件路径 COVERED：`controllerSend`、`frozenControl`、`correctionComposition`、`operationsReconciliation`、`frozenJournal`、actual helper/TLS 与 Go race；旧队列、撤权、迟到、unknown、原 ID 恢复、历史采用和持久失败边界按各测试断言，不将接口码当观众回执。 |
| 9 | COVERED：`textPolicy`、`rawProofWelcome`、`journalSecurity` 等合成负例；规则不声称识别全部语义隐私。 |
| 10 | PARTIAL / INCONCLUSIVE：两视口 CLI locator 与键盘断言通过，补充截图发现上述裁切、晚期 1440 文件误标；不能确认完整视觉/可达验收。 |

使用入口 `L/README.md#LIVE-PUBLIC-CHAT` → `examples/douyin/README.md#公屏文字发送`，参数来自固定导出、受信部署及 Mac 模板；本轮实际按该入口的固定导出、标准 builder、合成 owner 保存/授权/发送及原请求核对运行，参数及结果均为任务 fixture。未验证真实登录维护、真实身份/API、真实 TLS 平台接受、公开发送/观众、真实 gift、开播、真实模型/TTS/设备、真实 registration native、Robot 部署或生产发布。不存在以接口成功码证明平台接收或可见的结论。

**模型元数据**：dispatch 返回 providerInstanceId=codex、model=gpt-6.1-terra、reasoningEffort=xhigh；`executedModel=null`，独立执行模型标识为 NOT_VERIFIED。root 唯一拥有 lifecycle/state 与最终验收；本执行者未调用状态变更、Git 或发布。

### 主 Sol 对第二次独立 Validate 的处置与 Drawer 修正（2026-11-14）

832e14e的独立Validate为INCONCLUSIVE，已先实际record-validation fail。root核11项结果/工件摘要及两张unknown原图，保留独立Node260、V8行83.20%/分支76.92%、Go65/语句83.15%及27race、94兼容、标准build/assets和四个正式Web旅程的对应范围；没有把这些数字抵扣响应式条件。当前视觉截图左侧文字/按钮出现裁切，晚期1440文件实际375×812已由owner-journey.ts:409/457的视口切换确认是测试资产错误。root按done→todo、next/依赖→in_progress恢复T002；reopen由CLI清空validation，但原fail和日志永久保留W/main-validate-acceptance-72/。首轮浏览器下载尝试被guard阻止和遥测状态未核等执行偏差照原，不追认为完全合规。

只读源码定位：公屏根section只标dl-field，操作行复用不换行的dl-row（console.tsx:1598）；Drawer自身overflow:auto（:1664）；普通请求/来源/控制标识段落包含长不间断字符串，只有FullBinding details已有overflow-wrap:anywhere。这支持“内容横向溢出、聚焦后容器发生横向滚动”的可证伪假设，尚未用DOM测量排除动画或截图时机；不得将假设写成已证实根因。原实现者先在源开发fixture+fresh browser context记录1440/375下Drawer/panel/动作按钮与长ID的scrollWidth/clientWidth、scrollLeft和边界，再修正已确认的实际原因。

目标保持原故事10：375与1440下长来源/绑定及unknown/recovery内容仍完整可访问，按钮/标签不被横向裁切，键盘焦点不引起内容横移，允许正常纵向滚动；不通过overflow-x:hidden、截短标识、隐藏操作或重置scrollLeft/裁图掩盖问题。优先复用现有dl-check与局部样式模式，只为公屏组件加作用域并处理动作行换行、字段宽度和长标识断行。无新UI框架、结构重做或共享Drawer/全局dl-row改动；所有授权、pending/unknown、请求ID与事实核对语义保持。

完整写域仅P/src/publicChat/PublicChatSettingsPanel.tsx的局部语义class/必要无行为布局标记、P/src/console/console.tsx的公屏专属CSS区块、P/test/publicChat/**必要回归与截图资产。截图在unknown和核对后两个状态分别显式设置1440/375，记录实际viewport与PNG尺寸；不得再依文件名推定尺寸。新增真实浏览器几何/滚动与键盘回归，不只断言locator存在。代码改动前后均保留原失败与匹配图/DOM证据。

源开发验证先行，再包级noEmit/标准build，重启自有fixture并用fresh context检查正式产物，运行受影响的四个正式strict read-only Web旅程和当前完整Node覆盖（仍80%行/70%分支）。coverage范围仍144路径/52 V8源，基线和排除类别不变，只有本次授权两源的currentSha随真实diff更新；新文件必须完整归类，不能缩分母。当前未改Go27非test/65及race输入、94兼容和私有读取相关逻辑可按独立69原证据匹配复用，不无依据重跑Go或整个旧套件。生产核心/协议/Go/固定patch/host接线/资料/Q/安装目录不改。35分钟有限纠正窗口、自有输出<=1.5GiB、单并发、隔离/已安装浏览器/遥测预先关闭、真实业务预算0；到限不自续。保留同segment与全部失败，原唯一主诊断未使用；本次新增视觉发现不是重复无进展的同输入循环。


### 主 Sol 接受 Drawer 响应式修正（2026-11-14，独立重验前）

root 已读取原实现者 run19 终态、完整结果及实际 diff，接受 FEAT-008-T002 的本次软件修正。仅两处生产输入改变：PublicChatSettingsPanel 增加公屏局部 class；console 的公屏专属 CSS 允许操作行换行、限制字段宽度并完整断开长标识。原授权、发送、unknown、原 ID 核对与恢复语义未变。源开发 fresh context 的前后 DOM 测量证实两视口 Drawer scrollWidth 原为1492，修正后等于439/344 clientWidth；焦点与Tab后scrollLeft为0。实际标准构建client.js经测试宿主ModuleLoader加载；unknown及核对后375/1440图均有实际viewport、PNG尺寸和无水平裁切几何证据，root已直接查看375图。正式settings/integration四旅程、标准构建、包级noEmit与最终48文件260项Node通过；52源/144分类保持原覆盖范围，仅两个实际修改源currentSha更新，最终改动行6456/7760=83.20%、分支3031/3941=76.91%。未改Go/兼容/私有读取执行输入，复用独立69对应证据，不为汇总重复运行。

原结果仍为build/incomplete，唯一未完是早期命令未记录PGID、部分浏览器/编译子PID无法重建。root将其处置为不可追补的执行记录偏差，照实保留，不追认为资源记录完全合规，不宣称未记录资源全部退出；已有193个PID/133个端口无残留和任务路径进程扫描为空的证据只按原范围引用。这不是已发现的产品缺陷，不通过重跑已完成检查伪造历史完整性，也不新增实现轮次。后续独立执行须从首次命令记录归属与进程收尾。开发fixture三次准备失败、旧隔离与临时目录偏差、全部历史失败和唯一主诊断未用均保留。

匹配范围：本轮9项源码候选、23项证据工件、217保护输入、5项authority、52项coverage源及10张PNG，root只读机械核验0差异；原生结果SHA256 `26de023e9307b0a0ece0ca5599a2ef872e3baee3f17742232b2f33c9cbd6107c`，逐项核查见W/main-drawer-acceptance-74/input-audit.json，原命令/失败/截图见W/t002/drawer-responsive-73/output/build-result-incomplete-01.json。此为root的软件Build接受，原结果不改写；不等于独立Validate、Review、发布或真实外部验收。root通过CLI将T002恢复done并固定提交push后，派不同执行者做独立受影响Validate；真实账号/房间暂无，用户已明确与直播间一起验收，发送/另一观众/真实gift保持NOT_RUN/DEFERRED。REQ012/FEAT009/Q无新工作。
