# 工程上下文：FEAT-004 直播只读天气与公开资料查询

## 当前有效方案

### 架构设计

**关联**：REQ-006 的 confirmed FR/SCN 是唯一产品规则；分支 `codex/macos-yovoice`，固定差异基线 `67d4df44e3c119b5a799029913cdef6c29c73aeb`。2026-11-11 主 Agent 接受结构化天气 Plan 修订；唯一 `FEAT-004-T001` 的实现及Build检查已接受并通过lifecycle CLI标为done；Feature仍in_progress，下一阶段为独立Validate，尚未发布。源码 HEAD 为 `efa2b20d39bca833488b7936f565a22086cb3888` 加已有工作树；旧离线与真实证据只覆盖其明确范围，新后端实现与实测证据见后文，当前候选未发布。长期方向来源为 none，观察目标引用 REQ-006。REQ-005 播出冻结、REQ-008 课程/技能与 OUT-001 不属于本 Task。

#### 背景与复用决定

正式抖音预设的原生工具调用、GLM续答和独立MP3合成已有分层证据，但旧MCP天气摘要缺绝对观测时间，原天气成功解析又依赖合成句式，不能支持可信当前天气。当前方案将天气改为窄结构化适配器，公开搜索保留固定 Coding Plan MCP；不扩大工具权限或改写原文授权。原日期交叠修复与本轮失败历史继续承接，不重置不收敛计数。

| 候选 | 实测覆盖与成本 | 决定 |
|---|---|---|
| 已有固定 MCP/SDK，含 Reader 评估 | 公开资料可用；天气/Reader未给出可信实况 | 保留 public_search 与 SDK 2.2.0；删除可达的 MCP 天气路径，不接 Reader |
| Nominatim 区域＋AWC 观测＋MET 预报 | 中国区域/完整多边形、METAR绝对观测时间/摄氏单位、MET预报时间已核实 | 采用窄 adapter，复用 Node fetch、查询归属和现有 UI/语音 |
| wttr | 实况仅有时刻，缺绝对观测日期 | 不采用，不作自动回退 |

唯一新生产依赖 `@turf/boolean-point-in-polygon@7.4.0`（MIT，官方维护，已核 npm metadata/官方文档），由 package/lock 精确声明；复用其 Polygon/MultiPolygon/holes 判断，不自写 GIS。不引入天气框架、数据库、泛化 provider 平台或新会话运行时。宿主仍为 Harness 0.2.2-rc.1、Node22目标、React18/现有 Drawer，搜索 SDK 只进入 Node bundle，shared 不反向导入 Node。

#### 天气组件、地点与固定网络契约

`body/readOnlyQuery.ts` 以一个生产执行器共享严格输入、15秒总截止、单并发/取消机制，按 kind 分派：public_search→原固定 MCP；weather→新 `body/weather.ts` source factory；`body/weatherCache.ts` 只管理公共源缓存。测试经同一工厂组合独立 fetch、cacheFile、服务配置和时钟；必要的 agent 注册组合只做内部依赖注入，无生产 reset、调试路由或模型可编辑 provider。

地点沿原 `isSupportedWeatherLocation` 格式：四直辖市及明确区县，其他地点需省＋市/县/区；格式不是地点真实性证据。原可信问题/参与者关联继续应用，不从IP、别的观众、模型或旧会话补坐标。

- 地理默认 `https://nominatim.openstreetmap.org/search`，固定 `format=jsonv2,countrycodes=cn,addressdetails=1,limit=3,accept-language=zh-CN,polygon_geojson=1`，仅q来自已校验location。核对 `country_code=cn,category=boundary,type=administrative`、叶名及提供的省/直辖市父级；不用不存在的 class。四直辖市仅显式北京↔北京市等别名，允许经核对的 address.city/state；上海真实为 state。省＋叶名、直辖市＋区县分别精确匹配，零/多实体或缺父级须澄清，不能取首条猜。
- 只接纳完整 Polygon/MultiPolygon：有限合法经纬度、闭合ring及最少点数、有界深度/点数、bbox覆盖；最多1MiB，不简化/截断后继续定位。有限中心坐标及中国支持范围也须核对，区县无观测站不能借邻区或全市机场。
- 当前观测固定 `https://aviationweather.gov/api/data/metar`，参数仅 bbox、format=json、hours=2。bbox顺序南界纬度、西界经度、北界纬度、东界经度；南/西向下、北/东向上外扩至3位小数。框只筛候选站；实际站必须在原完整polygon内，以 Turf `ignoreBoundary:true` 排除区域外、洞和边界站。
- 明确日期预报固定 `https://api.met.no/weatherapi/locationforecast/2.0/compact`，lat/lon来自已核对区域中心，最多4位小数；最终发送的四位小数坐标也必须对原完整polygon执行PIP（ignoreBoundary:true），不能因落在bbox内就当作区内。中心/舍入后的点位于洞、边界或区域外时limited，不另找替代点或扩大地域。无日期只走AWC，有日期只走MET；无站不能改用预测冒充实测。
- 正常最多地理1GET＋天气1GET，总上限3个顺序GET（含条件请求），无并行、分页、重试、扩大地域或MCP/Reader/wttr回退。天气HTTP固定目标/参数、`redirect:error`、每响应1MiB流读取上限、严格UTF-8/JSON/有界结构，signal贯穿读取。仅发公共地名/区域/坐标与识别UA；不发送GLM Authorization、Cookie、Bili密钥、参与者/房间/历史/完整问题。
- UA为包名/版本与实际项目 `https://github.com/arnow117/dsh-livestream`。可信部署owner可用 `DSH_LIVESTREAM_WEATHER_GEOCODER_URL` 切换兼容 HTTPS `/search` 服务，无userinfo/query/hash/IP literal/localhost/已识别保留内网名称；错误配置不回退。该env不是模型/控制台URL输入，不声称格式校验保证DNS安全。AWC/MET固定不可改。

#### 当前观测、预报和来源语义

AWC官方 schema 确认 temp 为摄氏、obsTime 为UNIX秒；缺值不能借schema默认补0，0℃合法。仅采用同一行的有限temp、整数obsTime、ICAO/站名和站坐标。每次（包括缓存命中）验证观测不早于2小时、未来最多5分钟工程容忍；receipt/report time不能替代。wdir=VRB不影响温度，不把CAVOK翻译成晴。

同ICAO＋同obsTime重复温度去重，该组不同temp才为冲突并limited；不同站温差与同站历史变化正常。有效站按obsTime降序、同刻ICAO升序选一站；不宣称最近、不跨行拼字段或算全市均值。成功明示“区域内［站名/ICAO］附近在［绝对时间］的观测气温，仅代表该站附近，不代表全市/全区平均”。无时间、过期、超前、无区域内站、HTTP400/截断/400条上限迹象limited，不用部分资料伪称完整成功。

MET仅为模式预报：modelUpdatedAt来自meta.updated_at，适用时点/区间来自timeseries.time/next_N_hours，retrievedAt为原响应体取得时间，三者不互换。时间只接纳已核实的完整UTC Z绝对时间profile并核对历日，不从无时区或日期only推断时刻。按Asia/Shanghai筛请求日期；仅列实际覆盖点/时段与已给单位/字段，明示缺口，不插值、制造全天最高最低、缺值补0或猜未知symbol。缺单位不假定摄氏/mm；无日期覆盖limited，不能用实况替换预报。

沿用 shared `QueryRequest/Result/Source` 与原状态枚举，无新时间kind：AWC providerTime=observed/真实obsTime ISO，MET=forecast/真实适用时点或区间，modelUpdatedAt写有界evidenceText；未知仍unknown。每结果最多3来源、evidence总12,000字符，每摘录2,000字符，截断标明。保留实际数据URL必要参数/检索时间、站名坐标与限制，资料是不可信引用，不得改变权限/身份。AWC署名 NOAA Aviation Weather Center；MET署名 MET Norway/CC BY 4.0及数据链接；地理署名 OpenStreetMap contributors/ODbL与版权链接。外链不自动抓取。

现有证据卡把“预报日期”改为“预报适用时间”，区分观测/预报/检索时间；兼容DTO中仅有YYYY-MM-DD的值保留日期，不补小时。必要的有界证据正文通过React转义。公共天气HTTP不需要或接收GLM密钥；会话模型与公开搜索仍沿原GLM凭据admission。

#### 公共缓存、预算与失败

缓存归单host单进程 `${DSH_HOME}/dsh-livestream/weather-cache-v1.json`，schemaVersion=1，只保存公共源及原时间，不存参与者/queryId/lease，不是settings迁移、位置记忆或请求journal。生产host只构造一实例，不做锁服务、reservation或跨进程协调。

正向geo30天、成功空/歧义负向1小时；全应用geo至少间隔1秒，等待计入deadline。MET相同URL成功缓存至少3小时且尊重Expires，刷新时If-Modified-Since；304必须有有效缓存且不得更新原数据/有效时间/modelUpdatedAt/retrievedAt。AWC相同bbox成功缓存5分钟，重用仍核obsTime及区域。无配置读取/轮询预加载。

有界geo16/forecast8/current8/总文件4MiB，每响应仍1MiB；损坏、未知version、过深、错型或超量文件保守limited并给owner受控诊断，不静默无限联网刷新。不得淘汰尚在成功缓存期的同URL来重复请求；不能安全容纳时在发起对应源GET之前有限返回：预检条目数与足以容纳最大有界响应的字节余量，已满时不得先联网再丢响应，避免同URL重复请求。单host串行执行下仅需同一cache的容量检查，无reservation/journal。同目录独占临时文件0600＋rename，拒绝symlink/非普通目标/settings别名，失败保留原文件/进程已有公共缓存、只清自有临时文件，不能因写失败重复刷新。

15秒包括cache IO/限频/HTTP/body读取。取消后不启动后续GET；忽略abort的fetch/body未收束前保持共同busy，所有await后/提交前沿原signal/lease核对。缓存命中不重新授权旧轮次。HTTP/解析错误为受控状态/owner诊断，不公开堆栈或原始异常。公共搜索保留一次call、无重试fallback、SDK schema漂移拒绝。settings关闭/凭据失效继续撤销旧查询。

##### 查询设置与能力 admission

- **职责**：新 `src/shared/readOnlyQuery.ts` 维护浏览器/宿主共用的非机密设置、请求/结果 DTO 与校验；复用 `runtime.ts` 的 settings 原子保存、`index.ts` state/settings 路由，以及现有设置 Drawer/SecretField。新增 `readOnlyQueries: { weather: boolean; publicSearch: boolean }`，旧文件缺字段及首次安装均为两个 `false`，升级不自动联网；部分更新保留另一字段，错误类型拒绝且不改变文件/内存。无格式迁移、无 URL/密钥/预算的持久化配置。
- **接口**：`weather_lookup` / `public_search` 作为本地工具，在 `agent.ts` 的 localRehearsal 提前 return 之前独立注册；使用宿主已有 `tools.register(..., { when })` 对每步的 session、模式、主人启用和凭据状态做条件 admission，执行时再核对。它们只属于当前有效直播线，不进入游戏线，不扩大 B 站条件注册、执行检查或 lease。
- **能力一致性**：同一 availability 计算供 `when`、执行检查和主人 state 使用。persona 的静态说明只说“查询工具实际可用时可尝试”；更新两种 persona 和每轮 `push` 说明，移除“仅 show_stats”的冲突。`complete: true` 下不依赖其他 system section 自动注入。设置读取/状态轮询/能力 admission 不发远端请求；真正执行查询才初始化和列工具。
- **凭据**：沿用 `GLM_CODING_PLAN_API_KEY`，普通设置不保存它。查询专用 resolver：有 credentials 服务时只采用该服务本次成功解析的非空值；错误/空值为不可用，禁止悄悄回退旧 env。仅服务根本不存在时允许同名 env。不要为本需求更改旧 TTS/Bili resolver 的兼容语义。主人看到 configured/unconfigured/error，不回显值；如复用 SecretField，说明它与现有 GLM 共用、修改会影响模型。工具执行再次解析，取消/关闭/凭据变化后不得用缓存 key 继续新调用。
- **覆盖**：FR-06、FR-07、FR-09。

##### 当前提问上下文与输出归属

- **职责**：复用 `LiveShow.deliver()` 的现有 Topic、实际推入的消息 ID 与 Harness `agent/pre-step` 的 `agent/turn/step/signal`，为本轮建立宿主所有的输出 lease；不再建 session runtime。不能在 execute 时重新读取可能已变化的 `lastTopic` 冒充原请求。
- **接口**：lease 绑定 `sessionId`、target/session identity、直播输出 epoch、turn、宿主提交的 topic/message 与其输入来源，持有统一的失效判断和取消信号。`exec.agent` / `exec.signal` 必须匹配；这些身份不由模型参数提供，也不发给搜索服务。多条观众输入并入一个 Topic 时保留每条可靠参与者归属，不能拼接成某人的澄清。主人直接在会话输入时使用已 admission 的本次 user message；无法绑定可信输入则先澄清。
- **地点契约**：`weather_lookup.location` 必须逐字来自本次可信输入，或同一可靠 participant ID 的本次澄清片段；没有依据返回 `needs_clarification`。只允许现有会话里一个待澄清问题的有界关联，不新增长期地点记忆；会话/目标失效清除，无法关联就重新问城市。日期从同一输入确定，支持明确绝对日期；相对日期的具体日历日/时区不明确就澄清。来源不能唯一匹配地点/日期时不得把搜索命中当成定位成功。
- **输入校验细化**：地点与日期必须来自同一个可信问题或同一参与者的有效澄清，日期与尚未解决的预报/相对时间意图一并保留，不能因后来只补城市而退回当前天气。其他参与者的无关话语不否定一个独立完整的问题，也不能为它补字段；气温、几度、降水等通常天气问法不以字面“天气”为必要条件。存在不相容的日期或无法可靠选择请求归属仍先澄清。公开资料中文关联按有界实词/主体检查，不要求来源复述完整问句；优先复用内置分词，不引入 NLP 框架。天气候选先将一致地点、时间与事实去重，再判断真实冲突，不能把重复命中本身当冲突；来源及时间充分性要求不变。
- **失效契约**：统一应用到查询接纳、工具结果提交、live assistant 正文接纳、TTS 开始、TTS 返回和舞台广播之前，以及 mic 队列执行前。原生停止生成只在活动 turn 中通过其 signal 传播；宿主明确规定 idle 时 cancel 是 no-op，不能借该 signal 观察已经结束生成后的待播取消。现有直播控制台的查询区提供“停止查询回复”入口，显式撤销该查询的插件输出 lease，无论模型仍生成还是已 idle；原生仍执行同一查询 turn 时才同时请求 native cancel，并保留后续 inbox。忽略取消的替身即使返回也不能提交。正常 turn/end 不撤销已接纳且仍有效的待播句；取消状态保留至该轮所有队列任务结束，不能因为下一轮开始而重新有效。live 的 `interrupted: true` 消息不朗读；不能只看已持久化 `assistant/message` 就认定可播。
- **下播兼容**：begin ending 立即停止新查询 admission、使旧查询输出失效并取消其工作，谢幕使用单独的现有 ending 旅程。fully offair 显式结束直播输出 epoch，拒绝旧 live 正文、音频、工具状态和待播句；不能只设置 `onAir=false`。不粗暴禁止所有 game 行为，保留既有 B 站游戏收尾规则。现 `currentSessionGeneration` 返回 sessionIdentity，不能把它与内部 sessionGeneration/turn lease 混用。断开抖音订阅本身不令有效本地舞台关闭；主人随后可创建合法的新本地查询。
- **断订阅的旧查询清理**：沿用基线 `show.disconnect()` 的 `invalidateSession(this.onAir)`，断开前快照的查询 lease 和尚未播放的输出全部失效，包括当时主人发起的查询；旧 provider、模型及 TTS 回调不得在断开后重新输出。此动作不调用原生 `agent.cancel`，保留 `onAir`、brain session 和舞台，断开后主人可在同一保留会话中创建新的本地查询。不能以“没有调用原生 cancel”声称在途查询未被取消。该决定澄清原 FR-09 的含糊表述，依据是基线和 REQ-002 对旧目标临时上下文的清理，不是新增用户范围；已开始播放内容仍可完成。SCN-13 分别覆盖断开前主人/观众查询失效和断开后新主人查询成功。
- **原生同轮多步不可重新授权**：QueryTurn 的查询归属以宿主 agent、session 和原生 turn 标识冻结，跨 pre-step 延续同一归属；输出 epoch、配置或凭据失效后，同一原生 turn 的后续 step 仍保留已失效查询及 `called` 标记，不能重建为未查询的新 lease，也不能覆盖 `forTurn` 后把旧模型续答降为无归属语音。只有新的原生 turn、仍有效目标与输出身份可接纳新查询；无法确认归属时拒绝。该决定来自 SCN-13 主人在 provider 等待中断订阅的可复核失败：原 turn 8 在 step 2 重建 `called=false` lease，旧 assistant/message 被当普通句广播。实现者须同时检查设置/凭据/目标失效的同轮续步，以及后续合法新 turn；不靠调用 native cancel 掩盖归属错误。
- **零晚到的输出范围**：失效检查拒绝插件对旧查询结果及模型续答的接纳、查询反馈、直播正文、字幕和音频；不删除或伪造宿主原生会话历史。特别是断订阅不调用 native cancel 时，底层模型仍可能完成并持久化 `assistant/message`，watcher 必须消费后拒绝将其调度到直播，不得把内部记录解释为新直播回复或声称原生事件数为零。测试同时保留该宿主事件和插件零新输出的观察，不能只看取消请求。
- **覆盖**：FR-02、FR-08、FR-09。

##### 主人证据与舞台反馈

- **职责**：现有侧栏显示当前查询状态与最近一次有界证据，现有 stage tool 提示显示“正在查询天气/公开资料”。终态区分取得资料、证据不足、失败和取消；不能把它们命名为语音/播放成功。无独立页面，不播原始 JSON、堆栈或认证错误。
- **接口**：state 仅返回安全 DTO；最近结果限制为本轮/当前目标的有界记录，切换/结束时清理。可复用现有工具结果 card 展示来源，控制台提供可核对链接、检索时间及未知时间说明。可见文本用 React 转义；外链使用 `noopener noreferrer`。口播由 GLM 基于 evidence 生成短句，只说来源名和时间限制；复用 `core/speakable.ts` 已有的 Markdown 链接/裸URL清洗，不另造同类口播过滤器。调用轨迹通过现有 show JSONL 记录结构化 query 状态（queryId、kind、turn、phase、耗时、结果类别/来源数，必要时安全来源），不存 key、请求 header、私有参与者信息或完整远端原文；取消后可有内部丢弃记录，不能产生新的舞台反馈。无 tool 行不能作为“未调用”的证据。
- **通用反馈边界**：`LiveShow.toolCall()` / `note()` 入口带 `assertBiliCurrent()`，新查询不得直接调用它们。仅在 `LiveShow` 增加独立的通用只读查询状态/广播入口，接收 query lease 和安全状态 DTO，先核对有效归属，再发布现有 stage tool 状态及主人证据。保留两个 Bili helper 的断言，不为了抖音查询删除/放宽；不顺带修正旧 show_stats 行为。测试实际抖音/彩排 query 的反馈路径，不能用 mock helper 绕过该区别。
- **输出能力状态**：复用主人 state/现有侧栏显示舞台协议能力，区分支持当前协议的非预览输出、仅预览、需刷新旧舞台和未连接；混合连接须分别统计/说明，不能因有一个新输出而隐藏旧连接。支持协议仅表示该连接可接收 owned live 事件，不证明浏览器允许出声或音频已播放。握手、订阅过滤和连接失效唯一契约见下文“舞台能力与连接归属”。
- **覆盖**：FR-03、FR-04、FR-05、FR-08。

#### 固定公开搜索接口与安全

唯一端点 `https://open.bigmodel.cn/api/mcp/web_search_prime/mcp`，复用 SDK `Client/StreamableHTTPClientTransport@2.2.0`，固定URL/redirect:error/Bearer header；不向其他源转发。initialize/listTools(refresh)只选唯一 `web_search_prime`，核对已实测input schema（required仅search_query、5个已知string属性、additionalProperties=false），不兼容、重复/缺失/分页未完成拒绝，不注册远端目录。仅固定 search_query=获准query、content_size=medium、location=cn、recency=noLimit；无天气query/domain参数。

远端text最多两层JSON解包、最多32行title/link/content字符串和可选refer；类型/大小/第三层/损坏拒绝，refer不作时间或来源。普通Markdown/bareURL解析保留，但不对尚转义JSON用正则补救。先核全部有界候选关联再选最多3来源，优先原始/官方公开资料。来源URL拒绝userinfo/非HTTP(S)/IP literal/内网保留名称，不请求来源/资源，也不将GLM生成URL作为证据；格式分类不证明DNS/公网可达性。缺来源/过期/矛盾资料按FR03降级，不把检索时间当发布或观测时间。可选GET405由SDK正常处理，其余HTTP失败保留失败即停。

##### 舞台能力与连接归属

舞台 v1 协议采用增量兼容：live say 增加可选的归属标识，并新增针对该标识的失效事件；客户端的 Audio metadata/play/fallback 回调在修改字幕或开始播放前检查归属。无该字段的既有 game/guest 事件保留原语义，不做全局音频清空。新舞台脚本在 SSE 请求中显式声明 `outputProtocol=owned-live-v1`，服务端只向声明支持的连接发送带归属的 live say/失效事件；未知或缺失能力的旧连接仍可接收原有非归属事件，但不得收到新查询语音，不得通过去掉归属字段降级补发。hello 传递所需协议及当前输出身份，主人状态区分可用输出、预览和需刷新舞台；preview 即使声明能力也不计为出声输出。不能把首次服务端 hello 的 build 或文件 mtime 当成实际加载脚本的身份；保留原缓存刷新机制，但发布必须显式刷新旧舞台并确认新能力，不能声称旧机制已保证兼容。

SSE 断线/连接替换时，客户端立即撤销尚未开始的 owned live 内容、其计时器和 Audio/pendingClick 回调，令旧连接归属失效；每个异步回调在产生字幕或开始播放前再校验。重连先处于等待 hello 的状态，hello 同步当前输出身份后才接纳新连接的有效事件，不重播或重新授权已撤销内容；Stage 的 latest 状态不得缓存并补发 say。已经开始的内容按产品约定可完成，game/guest 保持原语义；创建 Audio 或调用 play 不等于已经播放，已显示字幕也不授权取消后再开始尚未播放的音频。测试必须阻塞 Audio 开始，断流期间取消并同 build 重连，再释放 metadata/play/fallback，断言旧字幕与新播放均为零；另以旧脚本延迟首次 SSE、宿主升级、再释放 hello 的交错证明缺失能力连接收不到新查询语音。只做服务端队列测试或比较两次 hello.build 都不能代替这些验证。

#### 需求到契约与验证（全部归T001）

| 规格/场景 | 契约 | 必要验证 |
|---|---|---|
| FR01/03，SCN01/02/04 | 区域内单站观测与日期模式预报 | 0℃/VRB、秒时间、新鲜度/站点限制、跨日/单位/覆盖、不伪造极值；真实adapter成功 |
| FR02/07，SCN03/09 | 可信地点→精确行政身份→完整PIP | city/state直辖别名、省/叶错配、歧义、holes/MultiPolygon/边界/邻区站、非法坐标 |
| FR04/06，SCN01/05/08 | 原生预设/工具admission/QueryResult | 三工具及原文参数、native tool_result续答、UI来源时间、真实GLM/语音/播放分层 |
| FR05，SCN06 | 固定源/15秒/global busy/缓存/无重试 | 200/304/5xx 专测；204 空观测分支与 400/429 无专测、经 `!response.ok`/空结果路径间接覆盖（正式评审 MEDIUM 记录为残留，行为走查未发现缺陷），损坏/超限/空/过期/缓存reload/原子失败/abort |
| FR03/07，SCN05/07/09 | public MCP SDK与安全来源 | 原文query/schema/GET405、双层profile/公开许可、可核对URL必要参数/凭据脱敏 |
| FR08/09，SCN10～13 | QueryTurns/主人取消/lease/舞台能力 | geo/天气延迟与缓存命中后取消；query/model/TTS/队列失效；三模式及断订阅后新主人query；旧舞台/断线交错 |

来源可行性证据与早先失败见验证记录。主要风险为过大/缺失行政几何、无站/过旧观测、源截断/变更与cache异常，均不授权跨区借站或切源。严格地名格式和机场站覆盖是首版明确局限。

遵守 [Nominatim政策](https://operations.osmfoundation.org/policies/nominatim/)：识别UA、聚合≤1次/秒、缓存、可切换服务、署名，只用于明确天气请求，无自动补全/批量/通用地理工具。遵守 [MET接口/缓存说明](https://api.met.no/weatherapi/locationforecast/2.0/documentation)及[使用条款](https://api.met.no/doc/TermsOfService)。

### 实施计划

同一 Terra 承接唯一T001的TDD/必要验证/修正；不删除旧失败或用Plan修订重置停止规则。先为真实profile/地域/时间写红灯测试，实现最小adapter与共同dispatcher/缓存，再接现有console/native/E2E fixture并移除旧天气字符串生产路径。

**最早真实增量（T001）**：在隔离DSH_HOME的生产source factory，对明确中国城市执行一次当前天气与一个覆盖日期预报，复用公共地理缓存，核对polygon、实际观测/预报时间与单位、来源及GET/缓存计数。不等全部回归才检验来源；不连接共享Harness/Stage/DyHub、不改active lib/播出，provider成功不代表GLM或舞台。

继而用正式 `dsh-livestream-douyin` 预设验证新天气证据的真实GLM自然工具选择/原文参数/续答。原公开题GLM与17.28秒MP3只在未变路径保留适用性，不代替新天气口播/舞台/观众。已有用户授权“这类不用跟我对齐，全权授权给你”允许本研发链主Agent安排有界真实测试，不再逐次预算询问；串行、失败即停、无服务请求重试或外部写入，仍不播出/重启共享服务。worker可以执行本brief明确限定的真实provider增量，真实GLM/TTS由主Agent安排。

更新 live-query 固定目标和显式计数，分别记录geocode/current/forecast/MCP search/model/synthesis；缓存命中可0HTTP，移除每个天气必须一次MCP search的前提。保留总5分钟、失败即停、每题模型≤2次/输出≤1024token、每题一次工具、本地隔离scope/DSH_HOME/日志脱敏/资源清理；具体真实测试预算由执行前主Agent自限，不编造用户逐项确认。公共天气cache留在自有忽略目录以免临时会话清理导致重复请求：native验收通过内部runner/source factory的cacheFile依赖注入直接写该文件，正式apply仍使用DSH_HOME默认路径，不新增公开路径配置。DSH_HOME/session继续临时清理，不用symlink/hardlink/轮末复制或持久化整会话目录；离线cache每次独立。导入先前真实公共cache时保留原字节与时间，只算复用既有资料，不算新HTTP成功证据。

修复 scenario.ts 清空所有source URL search/hash导致Google goto目标丢失的验收投影：有界保留公开目标/必要参数及安全锚点，凭据类参数/已知secret（含嵌套URL）脱敏；无法安全保留要明确不可独立核对。不跟随URL，不改生产搜索授权。新增回归。

必要验证：

- 单元红绿：行政实体/完整几何/PIP holes/边界/邻区、MET实际四位点的区域归属；bbox外扩/顺序；站时点去重/同组冲突、0℃/VRB、时间单位/覆盖；固定URL/无凭据headers/body上限；缓存reload/过期/容量/损坏/深度/写失败/别名/304、取消及忽略abort下共同busy。
- 复用实际SDK与原生Harness loop、预设/模型协议fixture；更新queryHarness、API/console、live-query诊断，测试隔离source实例/cache，不新增生产reset。原查询取消/正文/TTS/舞台归属、断订阅和Bili回归全部保留。
- 相关Vitest与V8 coverage，仅排除既定macosTts.test.ts；新模块加入include，固定基线显式本轮报告，变更行≥80%/分支≥70%。旧402/8skip不覆盖新后端。typecheck/build和包解析在隔离副本，禁止覆盖活跃lib。
- 现有e2e-query更新当前/日期天气、来源、失败、启停/取消；实际Console/routes/native SDK/AgentLoop/StageServer，外部服务替身，1440×900与375×812，workers1/retries0/现有Chromium/无agent或真实模型。保留Stage能力与旧脚本/断线同build交错测试。共享3080/3081/7390/8757及非fixture外网访问0，归档report/JUnit/trace/截图/日志和失败证据，只清自有资源。
- README全局LIVE-QUERY-WEATHER/SEARCH/CONTROL导航→Mac详细指南→实际UI入口核对参数来源、默认关闭、GLM与天气凭据区别、站覆盖/时间/缓存/geo部署/署名/恢复；计划命令不能冒充实跑。

独立Validate/Review/Ship仍需对应候选commit，不能以limited/fixture/MP3/连接关闭SC002缺口。回滚采用关闭查询和既有授权的代码回退，不删settings/credentials或停止共享服务，不借删缓存规避限频。

### 工程任务

保留唯一 `FEAT-004-T001 [US1/US2/US3] 接通有来源查询并验证直播生命周期隔离`，无新Task/依赖/状态。完成条件为上述FR/SCN关联与来源/原生/UI/安全/生命周期检查具备当前相符证据，包/构建/覆盖通过，经主接受；未通过真实层具体标注，不称完整上线。

本次新增/修订代码边界：`src/body/readOnlyQuery.ts`、新 `weather.ts/weatherCache.ts`；`src/dsh/agent.ts`仅查询依赖组合，`runtime.ts`仅dataDir/owner诊断组合；`src/console/console.tsx`仅天气证据/时间/帮助/署名；shared/readOnlyQuery.ts仅必要兼容说明；包package.json/根pnpm-lock.yaml加入已批准Turf。保留既有QueryTurns日期修正，不更改其权限语义、preset/credentials resolver/Stage协议或其他业务。

测试边界：包test/readOnlyQuery、weather/cache、受影响queryHarness/queryPreset/API/console、test/live-query/**、test/e2e-query/**、vitest.config.ts及必要query E2E配置/launcher。文档边界：根README、examples/macos-yovoice/README及.env.example。主Agent维护本上下文和state，worker不得修改state/index/branch、提交推送或改upstream。阶段结果报告实际命令/版本/工作树/缺口，请求状态仅按brief allow-list；Build证据不代替独立Validate。

## 实现记录（实际）

- **同轮失效与资料边界补正**：同一原生 agent/session/turn 的查询 lease 首次创建后冻结；后续 pre-step 不因 epoch 或 signal 更换而覆盖失效归属，新 turn 才可接纳查询。地点和日期从同一可信参与者的当前输入或该参与者的有界澄清一起校验，不跨人拼接；无关观众输入不否定独立完整问题，未解决未来时间不降为当前。中文公开问题用 Node `Intl.Segmenter` 做有界主体匹配，只识别关联、不承诺通用语义核验；同一地点、规范化时刻和事实的天气观测去重，真正冲突仍 limited。

- **Task**：FEAT-004-T001；基线 `67d4df44e3c119b5a799029913cdef6c29c73aeb`，实现位于该 HEAD 上未提交工作树；主 Agent 管理生命周期状态。无提交、部署或共享进程操作。
- **查询与归属**：在两个现有直播 preset 中条件注册天气和公开资料工具。`src/body/readOnlyQuery.ts` 使用固定 MCP endpoint、精确 SDK 与唯一 `web_search_prime`；`src/dsh/queryCredential.ts`、`queryTurns.ts` 为查询专用小 helper，绑定可信参与者、实际 turn/signal/session/epoch、单次调用与取消。原始来源仅作不可信资料，城市、日期、来源时间不足返回有限结果；两项开关默认关闭。
- **地点输入边界**：首版接受北京、上海、天津、重庆及明确的直辖市区县；其余只接受用户提供的省与市/县行政层级格式。裸地名先澄清且不访问 provider；格式本身不证明地点存在或唯一，仍需来源确认。仅同一可信参与者在当前会话和输出 epoch 内的有界澄清可延续上下文，不从模型或其他参与者补全地点。不支持的地域明确要求补充。
- **取消和舞台**：增加主人查询区「停止查询回复」与鉴权 POST `/api/dsh-livestream/query/cancel`，先检查当前 session、最新 query 和 epoch 并同步失效 lease；重复取消幂等，过期请求 409。仅有当前原生事件足以证明同一 turn 正在运行时调用 `agent.cancel(..., { keepInbox: true })`。原生 idle cancel 为 no-op 的负对照保留；不把原生“停止生成”当成待播输出取消。更新 SSE capability 握手、断流撤销、Audio 开始判定及旧客户端过滤，保留游戏/guest 和断订阅后本地交互。
- **界面和文档**：沿用控制台现有组件/样式展示开关、凭据状态、来源、可读检索时间与舞台状态；详细使用说明与根 README 稳定入口已更新。新 session 才加载更新后的 preset；旧 session 不自动更新。

## 验证记录（实际）

- **多轮澄清与有效提示收尾（最新）**：`/private/tmp/feat004-clarification-red.log` 保留三轮同人地点丢失及三模式真实 preset 缺提示的红灯。仅在仍要求澄清且 session、epoch、participant 匹配时，将同一待澄清问题与本次片段合并；超过 2000 字符或无法确定归属则清除并重问。跨人、目标失效与三轮正例已覆盖；原生 Loader/registry 实际组合测试检查两个 preset 与三模式的工具 schema、来源名、时间限制、实况/预报、查询原文和不朗读长链接提示。`/private/tmp/feat004-clarification-narrow.log` 对应窄测 25/25 通过。最新完整 Vitest/coverage 退出 0，69 文件、376 通过、8 跳过，唯一排除 `test/macosTts.test.ts`；`/private/tmp/feat004-vitest-final4.log` 保留结果。显式基线 coverage-diff 退出 0：行 790/851（92.83%），分支 454/584（77.74%）；隔离副本最新 typecheck 退出 0。既有 10 项浏览器 E2E 仅复用于未修改的交互路径，新增多轮和提示依上述窄测验证，不宣称真实 GLM 已遵循提示。

- **时间意图收尾（最新）**：`/private/tmp/feat004-date-red.log` 保留“今晚、明日、今夜、明晨”原先被错误视作当前天气的四项红灯；同一轮中把各用例隔离，避免复用先前澄清状态掩盖问题。使用有界的日词与常见时段组合后，`vitest run test/queryTurns.test.ts --maxWorkers 1` 退出 0，19 项通过；“北京天气如何”“北京现在几度”和同一参与者绝对日期澄清继续通过。不承诺穷尽自然语言时间表达，也不凭相对时间生成日期。更新生产源码后完整 Vitest/coverage 退出 0：69 文件、374 通过、8 跳过，唯一排除 `test/macosTts.test.ts`；`/private/tmp/feat004-vitest-final3.log` 保存结果。显式基线 `coverage-diff` 退出 0，行 783/844（92.77%）、分支 438/567（77.25%）；隔离副本最终 typecheck 退出 0。此前 10 项 E2E 报告针对未变化的当前天气、来源和控制台路径复用，不把它当成新增时间短语的浏览器证据。

- **追加真实天气单次观测**：用户另行明确授权 1 次后，主 Agent 于 `2026-11-10T10:45:28Z` 通过当前 `runReadOnlyQuery` 执行北京天气查询，固定 `weather.com.cn` / `oneDay`，仅 1 次 `tools/call`、总耗时 2435ms（含初始化/列工具），无重试、GLM/TTS/直播输出均为 0；结果仍为 `limited`，安全 DTO 中有 3 个 `m.weather.com.cn` / `e.weather.com.cn` 来源链接，不能确认实时天气。脱敏本机证据为 [`weather-check-1.json`](../../../smoke/readonly-tools/weather-check-1.json)。本次诊断只截获安全 DTO，因返回走 SSE 而未保存原始 payload；不得据此推断完整来源文本、追加私有字段格式或证明 provider 永不支持实时天气。该次授权已使用完，没有追加调用或偷偷回退。
- **同轮回归（最新）**：先保留 `/private/tmp/feat004-disconnect-{1,2,3,4}.log` 与新增单元红灯；其中第 4 次证明断订阅后原生同轮 step 2 覆盖旧归属并产生无 owner 语音。修正后 `DSH_HOME=/private/tmp/feat004-vitest-home GLM_CODING_PLAN_API_KEY= DSH_LIVESTREAM_LOCAL_REHEARSAL=0 ./node_modules/.bin/vitest run test/queryHarness.test.ts test/queryTurns.test.ts --maxWorkers 1` 退出 0（最终完整 suite 也覆盖）：真实 Topic/Harness/Show 下，主人和观众分别在 provider、模型续答和 TTS 三个时点断订阅、释放替身并等待 watcher，旧插件朗读调度/新合成/Stage say 为零，native.cancel 零次，onAir/session 保留，之后新主人查询成功；设置关闭后重启用及凭据引用更新也覆盖同轮续步。原生 agent 未被取消，因此其会话可能仍持久化 assistant/message；上述零输出只指插件接纳、语音和舞台，并不声称原生事件未写入。
- **资料和参与者回归（最新）**：`/private/tmp/feat004-context-red.log` 保存日期澄清、多人独立提问、中文主体和重复观测四类有意义红灯。修正后窄测试与完整测试通过，包括跨参与者负例、未解决未来意图、无关来源及冲突观测。未根据合成天气句式推断真实服务成功。
- **最终测试快照**：基线 HEAD 与工作树同上；上次完整 Vitest/coverage 命令在最新生产源码重跑退出 0，69 文件、365 通过、8 跳过，唯一排除 `test/macosTts.test.ts`；显式基线 `coverage-diff` 退出 0，行 783/844（92.77%）、分支 436/567（76.90%）。`/private/tmp/feat004-vitest-final2.log` 保存结果。最终同配置 E2E 退出 0，desktop/narrow 共 10 项；报告仍在 `.e2e/feat-004-build/`，独立 fixture 日志记录共享和外部请求均为 0。隔离副本最新源码的 typecheck、`node build.mjs`、Node 入口和 SDK 解析、`npm pack --dry-run` 均退出 0，活跃包 lib 未动。

- **最早增量**：`packages/dsh-livestream/.e2e/feat-004-build-increment-1/` 保存首次隔离桌面/窄屏旅程及请求/事件截图；之后的 `increment-2` 至 `increment-6`、`failure-1` 至 `failure-8` 保留修正历史。最近完整结果在 `.e2e/feat-004-build/`，包含报告、JUnit、trace、定向截图和 fixture.log。
- **Vitest**：在包目录以 `DSH_HOME=/private/tmp/feat004-vitest-home GLM_CODING_PLAN_API_KEY= DSH_LIVESTREAM_LOCAL_REHEARSAL=0 ./node_modules/.bin/vitest run --coverage --coverage.reportOnFailure --coverage.reportsDirectory coverage/feat-004-build --exclude test/macosTts.test.ts --maxWorkers 1` 执行，退出 0：69 文件、359 通过、8 跳过；`macosTts.test.ts` 是唯一排除。后补的九行双层编码样例以 `vitest run test/readOnlyQuery.test.ts --maxWorkers 1 -t 'nine-row'` 单独通过。该测试首次因 `example.org` 属于拒绝的保留域而失败，改为合规公开域 fixture 后通过，未改变生产代码。未经授权的系统 `say` 未调用。
- **变更覆盖**：`node packages/dsh-livestream/test/coverage-diff.mjs 67d4df44e3c119b5a799029913cdef6c29c73aeb packages/dsh-livestream/coverage/feat-004-build/coverage-final.json` 退出 0，行 740/810（91.36%），分支 408/539（75.70%）。新增九行测试未改变生产输入和本轮覆盖报告。最初受沙箱本地端口限制的 Vitest 已中止（退出 130）；授予本地 fixture 端口后完整重跑，不触及共享端口。
- **实际 loop / preset**：`queryHarness.test.ts` 通过真实 Harness adapter/loop 并捕获工具 schema、调用、结果、续答；`queryPreset.test.ts` 读取实际 patch 并经 native Loader/registry 验证 Bili、Douyin、本地模式的新 session persona 和可用工具。真实 Show/Stage 测试覆盖 query、模型续答、延迟 TTS、mic 队列、取消/切换/结束/下播及新回复。实际 Anthropic 格式的 `tool_use` / `tool_result` 与续答也由浏览器 fixture 捕获；OpenAI 格式测试不充当该协议证据。
- **浏览器**：`./node_modules/.bin/e2e run --config e2e-query.config.ts --workers 1 --retries 0 --trace on --reporter list,junit --max-duration 600000` 退出 0，desktop/narrow 共 10 项通过；有来源天气成功与资料不足、公开资料成功/失败/空、开关/凭据/键盘、原生 active 取消、idle 后主人取消、断流丢 invalidate、同 build 重连、旧脚本升级、断订阅后的本地交互均为独立夹具证据。天气成功为合成数据，非真实天气。最后一次 fixture 日志记录 `sharedRequests=0`、`externalRequests=0` 且自有服务停止。新增天气断言初次把模型收到的正文误当作控制台展示内容，失败保留 `failure-8`；纠正为验证实际 tool_result 后通过。
- **隔离构建**：源码复制到 `/private/tmp/feat004-build-stQngL/repo`，使用隔离依赖运行 `npm_config_manage_package_manager_versions=false pnpm --offline --store-dir /private/tmp/feat004-build-stQngL/store --filter dsh-livestream check`、包目录 `node build.mjs`、`npm pack --dry-run --json --ignore-scripts --cache /private/tmp/feat004-build-stQngL/npm-cache` 均退出 0。四个 bundle、`stage/index.html`、CSS 和 patch 存在；两个 Node 入口可导入，SDK 解析到隔离环境的 2.2.0；浏览器 bundle 不包含 SDK。一次包检查误写为 `lib/stage/index.html` 失败，核实实际包路径为 `stage/index.html` 后检查通过。活跃包 `lib` 未构建或覆盖。
- **真实层缺口**：本 Task 未调用真实 MCP/GLM/TTS/yovoice 或正式播出。主 Agent 此前两次授权的只读 provider 样本仅证明公开 OBS 查询可得来源；天气混杂旧/异地结果，新查询和过滤未做真实调用，可信当前天气未验证。真实 GLM 工具续答、yovoice 合成与播放、正式观众端仍需独立授权和验证；不可将离线替身视为 Feature 全链路通过。独立 Validate/Review/Ship 尚未执行。

- **首次真实限量执行**：用户明确批准后，主 Agent 从固定本机凭据引用加载 key，在隔离入口执行 `node test/live-query/run.mjs --real --approve=search:2,model:4,tts:1,seconds:300`，退出 1；没有重试或追加请求。实际 GLM 请求 3 次、搜索 1 次、yovoice 0 次：首题“北京当前天气”经真实 `weather_lookup` 和 GLM 两步续答，取得中国天气网链接但观测/预报时间未知，结果 limited，模型说明无法确认当前天气；此为工具调用与有限资料续答的真实证据，不是可信天气成功。第二题在首次模型请求后停止，现有记录仅有 phase=scenario_2/failure=stopped，未保留实际工具参数或结束原因，根因未知，不能推断公开搜索服务失败或生产参数校验错误。该轮未合成音频、未播放舞台或向观众播出，脚本子进程已退出、临时会话已清理；共享服务未重启。脱敏证据 [acceptance-real-20261110.json](../../../smoke/readonly-tools/acceptance-real-20261110.json)，SHA-256 `8fc708409d9428c1cb403d6657715d5555600088ad3b5cb5cb142b3cacf9ddd3`，对应 efa2b20 加当时未提交验收入口；后续诊断改动不继承此次真实通过结论。失败即停约定已执行，后续真实调用需重新明确预算，Task 继续 in_progress。

- **追加授权内第1轮诊断**：主 Agent 执行同一真实入口，退出1，实际模型3/搜索1/语音0。天气仍limited并完成GLM续答；第二题确实调用public_search，参数为string、无额外字段，但不匹配固定原问题文字，failureCode=tool_input_rejected、queryStatus=not_started，因此不是该题的搜索服务失败。参数的非原问题内容按约定省略，未据占位符猜词。脱敏 [result.json](../../../smoke/readonly-tools/diagnostic-round-1/result.json) 与逐题文件保留；执行前 [source manifest](../../../smoke/readonly-tools/diagnostic-round-1-source.json) 绑定 efa2b20 加85个生产/入口/配置文件的实际SHA。该轮没有生产preset，正式预设效果仍未知；主Agent据当前有效方案安排隔离组合修正，未放宽生产校验或自动重试，临时会话与子进程均结束。

- **追加授权内第2轮：正式preset真实增量**：在主Agent接纳当前preset组合和29项定向回归后，以同一单轮限制运行真实入口，退出0：模型4/搜索2/语音1，两个独立抖音preset scope均释放。天气weather_lookup仍limited，GLM准确说明资料不足；公开题public_search实际参数为原文“OBS Studio许可证”，返回evidence并完成GLM续答；yovoice取得MP3，ffprobe确认48000Hz单声道、17.280秒。两轮追加合计模型7/搜索3/语音1，未超内部预算。脱敏 [result](../../../smoke/readonly-tools/diagnostic-round-2/result.json)、逐题记录及音频保留；[source manifest](../../../smoke/readonly-tools/diagnostic-round-2-source.json)绑定86个实际文件SHA。该增量证明正式preset的真实工具/续答和独立本地合成，未证明实际舞台播放、观众播出或可信天气成功。公开答案的来源归属仍需核对：当前证据URL去query会丢失google.com/goto的跳转目标，不能仅据口播认定官方来源已经验证。Task仍in_progress，未自动更新运行中的DSH。

### 真实验收入口续接：离线实现与证据

- **版本和写入边界**：在 `codex/macos-yovoice` / `efa2b20d39bca833488b7936f565a22086cb3888` 的现有工作树上接续同一 T001；新增 `test/live-query/` 入口和测试、修改 `queryTurns.ts` 的已定位日期交叠、更新 usage。没有更改其他生产模块、生命周期状态或在用 `lib`；原有未提交产品/状态修改保留。当前结果不是独立 Validate/Review，也不请求 Task 状态变更。
- **先红后绿**：`/private/tmp/feat004-resume-date-red.log` 是以 HEAD 原始 `queryTurns.ts` 和新回归在单独临时目录复现的红灯，退出 1：27 项中 2 项失败，分别为“北京当前天气”和“北京目前天气”；前天、明天及混合时间意图均保持拒绝。修复只排除当前/目前文字中的交叠，不更改参与者、地点、日期或 lease 规则。原生双题 fixture 首次还实测模型地址以 `?beta=true` 结尾，以及在未结束隔离 Show 时直接更换 session 会失去查询能力；入口据此精确允许地址，并先结束自有 Show 再创建第二个 session。
- **可运行入口**：在隔离副本包目录运行 `node test/live-query/run.mjs`，退出 0，输出两题分别调用 `weather_lookup` / `public_search`，结果 `limited` / `evidence`，模型发送 4、搜索 2、合成 0；来源 URL/时间、限制、替身答复和执行阶段保存在其输出所指临时 `result.json`。天气 limited 不是当前天气成功，替身结果不是实际 GLM 或真实资料证据。未设置真实模式、未读取真实 key、未连接真实端点、未访问共享端口；音频、舞台播放和观众播放均未验证。
- **离线安全和协议检查**：`./node_modules/.bin/vitest run test/queryTurns.test.ts test/live-query --maxWorkers 1` 曾退出 0（6 文件 46 项），覆盖固定请求预算、非法目标与端口、最多一段 120 字、工具结果失败后禁止模型续答、软截止、隔离 session、真实 `YovoiceClient` 在失败与调用者取消后仅清理本次 job，以及默认模式不传入环境中的假凭据。随后针对 MCP session header 的实际 SDK GET 和真实参数缺失/错误预算拒绝运行 `./node_modules/.bin/vitest run test/live-query/mcp-adapter.test.ts test/live-query/entry.test.ts --maxWorkers 1`，退出 0（3 项）；没有真实网络请求。入口在总时限内为清理预留 30 秒，强制结束子进程时报告清理未知；语音音频文件不代表播放。
- **累计检查**：隔离副本 `DSH_HOME=/private/tmp/feat004-resume-test-home GLM_CODING_PLAN_API_KEY= DSH_LIVESTREAM_LOCAL_REHEARSAL=0 ./node_modules/.bin/vitest run --coverage --coverage.reportOnFailure --coverage.reportsDirectory coverage/feat-004-resume-build --exclude test/macosTts.test.ts --maxWorkers 1` 在允许自有 loopback 的环境退出 0，74 文件、401 通过、8 跳过，日志 `/private/tmp/feat004-resume-coverage-loopback.log`。第一次沙箱运行退出 1，`listen EPERM 127.0.0.1` 导致依赖自有监听的测试失败/跳过，保留 `/private/tmp/feat004-resume-coverage.log`；不将它归因于业务逻辑。隔离副本 `npm_config_manage_package_manager_versions=false pnpm --offline --store-dir /private/tmp/feat004-build-stQngL/store --filter dsh-livestream check` 退出 0；包目录 `node build.mjs` 在该副本退出 0，生成四个 bundle，未触碰共享 lib。已核对隔离副本与工作树 `src/` 一致，并将覆盖报告路径映射到工作树；`node packages/dsh-livestream/test/coverage-diff.mjs 67d4df44e3c119b5a799029913cdef6c29c73aeb /private/tmp/feat004-resume-coverage-mapped.json` 退出 0，行 791/851（92.95%）、分支 462/588（78.57%）。累计覆盖后补充了 MCP GET、入口拒绝断言，并把待合成文字改为先脱敏再截断；最终相关 6 文件 46 项定向重跑通过，生产源码未再变化。
- **尚未完成**：本次没有运行真实模型、MCP 搜索、yovoice 或舞台；真实层必须先由主 Agent 审核入口并获得明确预算授权。未重复未改变 UI 路径的既有 10 项浏览器 E2E；其证据不覆盖本次日期措辞的真实服务行为，也不替代后续独立 Validate/Review。当前脚本只是待评审候选，不能据离线通过推断真实天气充分、真实模型按预期调用工具或播放成功。

**累计检查输入范围更正**：主 Agent 的输入比对发现，上述 401 项通过的隔离副本使用了较旧的 `test/queryPreset.test.ts`，缺少当前 HEAD 的 persona/schema 断言，故不能将该次完整结果表述为覆盖当前全部测试输入。按补正指令同步该测试后，双方 SHA-256 均为 `9386a471e609ee321c20aa6e5929aa835a56f78e8dd8f851afc4c3d09e1e40eb`；隔离副本中运行 `DSH_HOME=/private/tmp/feat004-resume-test-home GLM_CODING_PLAN_API_KEY= DSH_LIVESTREAM_LOCAL_REHEARSAL=0 ./node_modules/.bin/vitest run test/queryPreset.test.ts --maxWorkers 1` 退出 1，三个 preset 均因 persona 不包含 `weather_lookup` 失败。该测试读取的 `cordis.patch.yml` 也存在输入差异：工作树 SHA-256 为 `379225ac785037ae708f15b3378c4d1d14972ac7358fcbfb89ce13973fd8a0b2`，隔离副本为 `2ea63f5e58782c00808ab5cec032fcb8804d1676853661bbf3ba4498fcfd40ba`；工作树文件包含所需提示，隔离副本返回旧文本。此次补正未同步该配置或改变生产文件，待主 Agent 决定后续复核。保留 401 项原结果及先前失败，不把不同输入的测试通过或失败归属到当前工作树。

**2026-11-10 续接修正与当前累计证据**：主 Agent 授权将当前 HEAD 已有的 `cordis.patch.yml` 同步到隔离副本；不修改工作树配置或断言。此前旧配置与新测试组合的 3 项失败保留在本段上方；同步后 `DSH_HOME=/private/tmp/feat004-resume-test-home GLM_CODING_PLAN_API_KEY= DSH_LIVESTREAM_LOCAL_REHEARSAL=0 ./node_modules/.bin/vitest run test/queryPreset.test.ts --maxWorkers 1` 退出 0、3 项通过（`/private/tmp/feat004-resume-preset-green.log`）。

独立 review 核实 MCP SDK 2.2.0 可把固定端点的 GET 405 解释为不支持可选 SSE；之前 transport 把它当错误停止。实际 SDK fixture 改为 GET 405 后先复现 `failed` 而非 `limited`（退出 1，`/private/tmp/feat004-resume-mcp405-red.log`），然后只允许该固定端点的 GET 405 原样交还 SDK；固定端点 POST 405 和 GET 503 仍停止。`./node_modules/.bin/vitest run test/live-query/mcp-adapter.test.ts test/live-query/transport.test.ts test/queryPreset.test.ts --maxWorkers 1` 退出 0、17 项通过（`/private/tmp/feat004-resume-mcp405-green.log`）；实际 SDK 完成一次 `tools/call`，模型请求 0、搜索调用 1。该兼容试验不证明真实服务当前返回 405，也没有访问真实端点或新增 fallback。

对当前工作树与隔离副本的 `src/`、`test/`、preset patch 和依赖/构建/测试配置逐文件 SHA-256 比对，174 项、差异 0；完整检查前后均一致。随后以 `DSH_HOME=/private/tmp/feat004-resume-test-home GLM_CODING_PLAN_API_KEY= DSH_LIVESTREAM_LOCAL_REHEARSAL=0 YOVOICE_API_TOKEN= YOVOICE_URL= ./node_modules/.bin/vitest run --coverage --coverage.reportOnFailure --coverage.reportsDirectory coverage/feat-004-current-build --exclude test/macosTts.test.ts --maxWorkers 1` 在隔离副本和自有 loopback 环境运行，退出 0：74 文件、402 项通过、8 项跳过；日志 `/private/tmp/feat004-current-coverage-loopback.log`。覆盖报告路径按先前方法映射到工作树后，`node packages/dsh-livestream/test/coverage-diff.mjs 67d4df44e3c119b5a799029913cdef6c29c73aeb /private/tmp/feat004-current-coverage-mapped.json` 退出 0：行 791/851（92.95%），分支 462/588（78.57%）。上一轮 401 项结果仍为历史证据，不代替此轮当前输入检查。

生产 `src/`、构建入口及依赖未因本次 405 修正变化；上一轮同源码的隔离 typecheck 和 build 证据继续适用。UI 未变化，不重复既有浏览器 E2E；真实 GLM/MCP/yovoice、舞台及观众播放仍未获授权或未验证，Task 不因此关闭。

### 结构化天气生产适配器最早真实增量（2026-11-11 本地时间）

同一Terra在隔离source factory与独立公共缓存执行当前上海和2026-11-11预报；主读取并接纳[`structured-adapter-increment.json`](../../../smoke/readonly-tools/structured-adapter-increment.json)。真实请求严格串行，geo/AWC/MET各1次、均HTTP200，总3GET，GLM/TTS/共享端口/直播输出均0。当前结果为区域内浦东站ZSPD于2026-11-10T17:00:00Z的10℃（只代表站附近）；预报保留实际覆盖时点和MET模型更新时间2026-11-10T13:20:19Z，未制造全天极值。这证明当时未变的生产地理/观测/预报路径及真实数据可用，不证明正式预设GLM、缓存304、控制台或舞台播放。后续304窗口红绿、集成与累计检查仍在同一Task，不因增量通过标done。

### 结构化天气来源核实（2026-11-11 本地时间）

在用户“这类不用跟我对齐，全权授权给你”的测试授权内，主 Agent 使用有界、串行、失败即停的公开只读请求核实天气服务；不调用额外模型或语音，不连接/修改共享 Harness、Stage 或采集器，不向直播间播出。以下证据是来源可行性检查，尚非新适配器的生产或舞台验收：

- [`source-diagnostic.json`](../../../smoke/readonly-tools/source-diagnostic.json)：现有 MCP 北京天气摘要缺明确绝对观测时间；旧字符串成功 parser 亦过于依赖合成句式。`limited` 合理，但该路径不能满足可信实况成功验收。
- [`reader-weather-check.json`](../../../smoke/readonly-tools/reader-weather-check.json)：固定天气页的 Reader 结果以新闻为主，未得到可核对实况；不引入 Reader 或任意 URL 工具。
- [`structured-weather-probe.json`](../../../smoke/readonly-tools/structured-weather-probe.json)：Nominatim 唯一北京市行政区；MET 返回含 `meta.updated_at`、有效时点和摄氏单位的真实预报。MET 数据为预报，不能冒充当前观测；相同全球预报 URL 至少间隔三小时并遵守缓存策略。
- [`wttr-weather-probe.json`](../../../smoke/readonly-tools/wttr-weather-probe.json)：当前条件只有时刻，没有绝对观测日期；不从其他日期推断，不采用为当前观测来源。
- [`aviation-weather-probe.json`](../../../smoke/readonly-tools/aviation-weather-probe.json)、[`aviation-metar-fields.json`](../../../smoke/readonly-tools/aviation-metar-fields.json)：NOAA/NWS AWC 的公开 METAR 返回北京、上海、天津、重庆站温度与秒级 UTC `obsTime`，官方 schema 确认 `temp` 为摄氏；0℃是合法值。
- [`shanghai-region-probe.json`](../../../smoke/readonly-tools/shanghai-region-probe.json)、[`shanghai-metar-bbox-probe.json`](../../../smoke/readonly-tools/shanghai-metar-bbox-probe.json)：上海是 `category=boundary/type=administrative/addresstype=state` 的 MultiPolygon；官方文档 bbox 顺序为南界纬度、西界经度、北界纬度、东界经度（即 `lat0,lon0,lat1,lon1`），三位小数，真实 bbox 查询得到两站共八条时序观测。同一时间不同站温度不同是正常空间差异，不能当作同一站来源冲突。行政区精确多边形与站坐标筛选、最新观测选择、来源署名和缓存仍须实现并验证。

资料依据：[AWC API](https://aviationweather.gov/data/api/)、[MET 接口](https://api.met.no/weatherapi/locationforecast/2.0/documentation)、[Nominatim 政策](https://operations.osmfoundation.org/policies/nominatim/)。Nominatim 仅在主人/观众明确询问天气时解析地名，应用聚合不超过每秒一次，缓存结果并署名 OSM；不作为通用地理搜索工具开放。新后端设计必须保持当前天气与预报的类型和时间区别，不以 HTTP 200 或来源探测替代产品 FR-01/03/04 验收。

### 结构化天气候选的最终 Build 检查（2026-11-11）

同一Terra返回功能源冻结；主接纳其限定范围的证据：隔离副本与工作树180项源码/测试/preset/依赖配置SHA一致，78文件470 passed/8 skipped（仅排除既定macosTts.test.ts）；固定基线差异覆盖行94.33%、分支83.41%；desktop/narrow E2E 10/10，隔离tsc/build通过，Turf打入Node bundle，默认离线与tts:0入口通过。日志/报告：`/private/tmp/feat004-date-final-coverage.log`、`/private/tmp/feat004-date-final-coverage-worktree.json`、`/private/tmp/feat004-build-stQngL/repo/packages/dsh-livestream/.e2e/feat-004-build/`。旧461/8skip和36项入口结果是此前输入的历史证据，不冒充本次新增日期控件回归。

复核修正有红绿证据：MET最终四位点区域PIP；304只延长缓存请求间隔而保留原源时间；条目/字节容量预检使溢出URL连续重问均0HTTP；迟到fetch/503/过大响应的body清理未结束时维持共同busy；站点Polygon/MultiPolygon/holes/边界排除及同刻冲突、零度、实际时间；Console兼容date-only不补造08:00。MET严格UTC Z与历日校验在先前源快照已存在，主较早读取的宽松Date.parse判断已撤回，没有作为当前新生产缺陷或重复修正记录。完整日历/无zone等负例追加证明原行为。

主首次从当前checkout启动真实入口时，在请求前因新增Turf尚未安装而失败，未取得场景结果；进程报告cleanup unknown，保留空产物路径`/tmp/dsh-query-artifacts-0lzrnJ`。随后只读模块加载对照为checkout ERR_MODULE_NOT_FOUND、已测隔离副本成功；静态ESM依赖解析失败发生于请求代码执行前，不归因为模型/天气失败。没有对失败服务请求重试。改用已检查隔离副本前重新核对91项实际入口输入SHA全一致，并执行默认离线入口exit0。当前checkout依赖未修改，隔离安装曾因既有ignored-builds策略非零的历史保留，不能把它写成安装成功；实际部署仍需验证锁定依赖/构建。

### 正式预设真实 GLM 两题验收（2026-11-11 本地时间）

主在已验证的隔离副本执行 `node test/live-query/run.mjs --real --approve=search:2,model:4,tts:0,seconds:300`，exit0；91项实际入口输入SHA与工作树一致，绑定[`source manifest`](../../../smoke/readonly-tools/weather-native-glm-20261111-source.json)。两次新建scope均dispose，预设为dsh-livestream-douyin，三工具集合/schema/有效persona核对全true，原文参数未改写且没有强制模型工具选择。

- 北京当前天气：原生weather_lookup({location:北京})，status=evidence；GLM答首都机场附近0℃并说明NOAA来源和不代表全市。主核对同次持久公共cache中ZBAA观测为0℃、obsTime=2026-11-10T17:30:00Z，与QuerySource时间及答复一致；不是把检索时间当观测。
- OBS Studio许可证：原生public_search使用原文query，status=evidence，GLM答GPLv2；完整官方来源URL保留，独立核对[OBS帮助FAQ](https://obsproject.com/help)支持该结论。此次不再有Google goto参数被全部抹除导致来源丢失的问题。
- 实际总计model4、MCP1、geocode1、current1、forecast0、TTS0，audio=not_requested；Stage/观众播放显式not_tested。此前上海日期预报只证明真实source层，不据此冒称该日期的真实GLM口播。普通TTS路径旧17.28秒音频证据保留未变范围，不重复合成凑数。

脱敏结果：[`result.json`](../../../smoke/readonly-tools/weather-native-glm-20261111/result.json)、[`scenario-1.json`](../../../smoke/readonly-tools/weather-native-glm-20261111/scenario-1.json)、[`scenario-2.json`](../../../smoke/readonly-tools/weather-native-glm-20261111/scenario-2.json)。真实执行前共享服务CPU只读检查为Harness0.4%、yovoice0%、DyHub0%；未重启、更新active lib、改在用依赖或播出。首次ps在沙箱受限，随后只读提权检查成功。此次不请求新的测试预算，沿用用户全权授权。

主接受本轮实现及以上分层Build证据，核对同一Terra的canonical请求与help契约后，通过lifecycle CLI将T001设为done；next实际返回Validate。独立Validate/Review/Ship、正式舞台及真实观众播放仍未执行，Feature/Requirement未据此标完成或发布。

### 早期诊断与正式预设组合的历史证据

以下保留各次快照的事实和失败历史；其中“当前”“未验证”“需追加预算”均指当时快照，不是现行授权或进度。现行方案及最终470项/真实GLM证据见前文，用户全权测试授权继续有效。

**真实执行后诊断增量（离线）**：针对上文已授权真实运行只保留首题、第二题缺少工具和结束事实的问题，验收入口在每题开始时创建结果，清理临时会话前以私有权限原子写入 `scenario-1.json` / `scenario-2.json`；最终 `result.json` 同样包含已完成或失败的题目。字段包括预期/实际工具、仅限固定公开问题文字的参数、已知参数类型和额外字段数、query 状态、原生 turn/end kind、受控失败代码、适用的整数 HTTP 状态、每题与总请求计数。其他参数文字以省略标记代替，不保存原始请求/响应、headers、完整 session、key 或堆栈；首题资料和答复继续保留。若记录文件写入失败，入口停止，不能据此假设诊断已保存。

`/private/tmp/feat004-diagnostics-red2.log` 保留修复前两种第二题离线失败均只留下首题的红灯；修正后在同一隔离副本运行 `./node_modules/.bin/vitest run test/live-query --maxWorkers 1`，退出 0：6 文件、26 项通过（`/private/tmp/feat004-diagnostics-final.log`）。五种实际 Harness/插件替身场景覆盖公开参数不匹配、参数含假密钥、模型 HTTP 503、MCP HTTP 503、参数类型错误；均保留首题并停止后续发送。新增测试核对失败题目的独立文件内容、密钥不出现在结果中，以及离线 fixture 选项不能进入真实模式。诊断分类的中间测试发现 MCP 503 同时产生 tool error，已优先保留可直接观测的 HTTP 状态，随后定向重跑通过。

在隔离副本包目录运行 `node test/live-query/run.mjs`，退出 0（`/private/tmp/feat004-diagnostics-final-offline.log`）；两题仍仅使用替身，模型发送 4、搜索 2、语音 0，临时会话清理完成，输出目录含每题诊断文件。相关文件随后检查为 mode 0600、内容与汇总中的对应题目一致；这是离线使用证据，不是对真实第二题原因的判断。本轮仅改变测试入口及其指南，没有修改生产源码、provider、生产工具协议或现有 state；未重跑生产未变的全量覆盖/typecheck/build，也未调用任何真实模型、搜索或语音服务。此前真实第二题的原因仍未知，后续真实调用仍需新的明确预算授权。

**正式抖音预设组合：离线实现和证据**：在同一验收入口从当前 `cordis.patch.yml` 读取 `dsh-livestream-douyin`，严格只将 persona 和直播 agent 两个预设模块映射为进程内 builtin，再由现有 Loader、AgentPresetRegistry、Persona 和原生 AgentLoop 为每题创建独立 session scope。每次在内存 Show 建立查询归属前用 sentinel 阻止 director 定时器创建；不启动 StageServer、平台连接或输入，不加载在用插件 lib。每题先核对实际组合的工具和有效提示，再执行原固定问题，最后单独结束自有 Show 并 dispose 对应 scope。没有强制模型选择工具、改写问题或放宽生产查询授权。

首个入口测试红灯 `/private/tmp/feat004-preset-runner-red.log` 记录旧入口没有实际预设标识；补充 schema 核对前的红灯保留于 `/private/tmp/feat004-preset-schema-red.log`。第一次协议替身问题原文核对只考虑内容数组、未识别 Anthropic 字符串内容，随后按实际两种 wire 形状核对并通过；没有据此改动问题文字。检查前将源码、测试、preset patch 和依赖/运行配置同步至隔离副本并逐文件 SHA-256 比对，共 176 个相关输入、差异 0。

隔离副本 `./node_modules/.bin/vitest run test/live-query test/queryPreset.test.ts --maxWorkers 1` 退出 0，7 文件、29 项通过（`/private/tmp/feat004-preset-runner-final.log`）。默认 `node test/live-query/run.mjs` 退出 0（`/private/tmp/feat004-preset-runner-final-offline.log`）：两题各实际挂载该 preset、各自 dispose scope；可用 schema 严格为 `public_search`、`show_stats`、`weather_lookup`，包括公开查询原文/70 字及天气地点约束，不含 B 站、OBS 等特权工具。scope 的有效 persona 及模型协议替身接收的 system 均核对原文核心、来源时间、limited/unknown、不朗读长链接；替身收到固定问题原文且没有强制工具选择。两题分别得到 limited / evidence 的合成结果，模型发送 4、搜索 2、合成 0。失败即停、脱敏诊断、语音任务清理及 405 兼容的定向回归也通过；两份独立题目文件与汇总一致、权限 0600。以上只证明离线替身与实际 preset 组合，不证明真实 GLM 会遵从提示或真实公开资料查询成功。

本轮未调用真实服务、未更改生产源码/patch/依赖或 state，也未运行不受本次测试入口变化影响的全量 suite、typecheck、build 或 UI E2E。上一轮 402 项生产检查只适用于其相同生产源码和配置，不冒充覆盖本次新增测试入口；真实第二题已知请求参数不在原问题范围，未调用搜索服务，仍需后续受控真实验证，不推断 provider 故障。

## 评审记录（实际）

2026-11-11 结构化天气设计独立只读复核（非正式 commit Review）发现 P2：geocoder中心在bbox内并不保证位于完整行政区域内。主接受，已明确MET实际发送的最终四位小数点同样需原polygon的PIP检查，不通过即limited；主已核对同一Terra的实现、针对性红绿和最终470项累计检查，此设计P2关闭；不是正式commit Review。其余所审地域、时间、截止/busy、公共cache与凭据边界未发现可证实设计阻塞。

后续独立核心复核发现缓存容量耗尽后先GET再丢响应的P2；同一实现者已改为请求前容量检查，主核两种容量红灯（原连续重问2次GET）及修正后0GET/累计通过，关闭此增量发现。主另核body迟到/错误/超限清理三例红绿与全局busy行为。以下较早增量审阅结论按当时快照保留，不替代最新Build证据，也不作为正式Review记录。

- **失败诊断增量接纳**：主 Agent 核对当前 11 个验收入口/测试文件与隔离副本无差异，检查实际日志为 6 文件、26 项通过，默认离线入口及逐题 0600 原子证据写入已验证。只扩充内部诊断和测试，生产源码、preset 与依赖未再改变，沿用对应代码的 402 项累计证据，不把旧完整 suite 当成新增诊断场景的证据。当前入口直接挂载原生 Harness 与插件工具，未挂载直播 persona preset；其真实观测只证明该隔离组合的工具调用/续答，不证明生产直播人设、口播风格、舞台播放或正式观众结果。首次真实第二题根因仍未知，没有用离线参数拒绝示例冒充现场根因。后续真实调用需在明确追加预算内执行，未提交、部署或标记 Task done。

- **本轮 Build 增量接纳**：主 Agent 已核对工作树与隔离副本的 267 个非忽略文件，运行/测试相关输入无差异；其余差异仅为 SDLC/usage 文档和本功能未引用的实验制品。当前完整检查为 74 文件、402 通过、8 原有跳过（唯一排除 macosTts），变更覆盖行 92.95% / 分支 78.57%。此前旧隔离 preset/断言导致的结果不冒充当前配置通过，补验和失败历史见上。独立只读增量评审发现的 MCP GET 405 兼容 P2 已由同一实现者修正，原 reviewer 核对精确条件及红绿证据后关闭；这不是正式 SDLC Review。生产修正、限量验收入口与离线证据获接纳；真实调用预算尚未获准，Task 保持 in_progress，未部署或覆盖运行中的 lib。

- **主 Agent 离线接纳**：已核对最终三轮澄清与原生同轮失效修正、有效 preset 提示及实际日志：69 文件、376 通过、8 原有跳过，新增提示/上下文路径的 Harness/Loader 窄测 25 通过，变更覆盖行 92.83% / 分支 77.74%，最新隔离 typecheck 与 diff 检查通过。既有 10 项浏览器证据仅用于未改变的交互路径，不能替代真实 GLM 遵从、天气数据或语音验收。保留全部实际失败与修正记录；未据离线结果请求 Task done、未提交/部署或结束当前直播。后续仍需获得相应提交/外部运行授权及有效证据，不将这次接纳写成正式 Review。
- **状态**：Plan 内一次有界独立协议设计复审已执行并接受处理方案；Build 离线检查见上，独立 Validate 与正式 `sdlc-review` 尚未执行。
- **范围、发现与处理**：主 Agent 的 fresh-context `query_protocol_review` cycle 1 使用 doubt-driven-development，识别两项真实兼容遗漏：断流丢失 invalidate 可让旧 Audio 回调在同 build 重连后晚播；首次 hello 接纳宿主 build 及 mtime 不能证明页面 JS 能力。主 Agent 已选择显式能力与断线撤销契约，Build 已实现并提供上述隔离检查证据，仍须独立验证和代码评审。未发起第二轮设计复审或增加 Task。

主另接纳Onboard对project.md的局部事实刷新：固定天气来源/可信geocoder配置、公共cache与native验收入口，未修改业务源码或状态。README/指南中的旧“真实GLM未验证”结论已由主按本次限定证据纠正。

## 发布与观察记录（实际）

- **产品观察计划引用**：REQ-006“发布后观察计划”。
- **技术发布准备、实际结果、反馈证据与缺口**：尚未执行；未重启/修改共享Harness、yovoice、DyHub、Stage，未开始正式播出。

### 独立 Validate（2026-11-11，未通过：公开资料真实层）

本验证由 Claude Code 原生子代理执行（相对此前 codex Terra 的环境变化），只读于实现，绑定业务候选 fd48d0a5d9a18a3759428c3286f28480630eeb9a（HEAD 06c294a 仅 .sdlc-v1 差异，已核实）。依赖前提复核 Turf 解析 exit 0 后，全部命令本轮实际执行：

1. 完整 Vitest+V8 coverage（DSH_HOME=/private/tmp/feat004-validate-home、排除 macosTts.test.ts、maxWorkers 1）退出 0：78 文件、470 通过、8 跳过，与最近 Build（78/470/8）一致；报告 coverage/feat-004-validate/。
2. coverage-diff 基线 67d4df44 退出 0：行 1148/1217（94.33%）、分支 706/846（83.45%）。
3. typecheck 退出 0。
4. 离线原生入口退出 0：weather_lookup（北京当前天气，limited，geocode 1/current 1/model 2）与 public_search（OBS Studio许可证，evidence，search 1/model 2），总数 model 4/mcp 1，证据 smoke/readonly-tools/validate-feat-004/offline-mode-20261111-result.json。
5. 真实原生入口（--approve=search:2,model:4,tts:0,seconds:300，key 仅经环境变量注入）退出 1 未通过：第 1 题真实天气成功（queryStatus=evidence，真实 METAR 观测 2026-11-11T02:00:00Z，Nominatim geocode，3 个可独立核对来源，model 2/geocode 1/current 1，无 TTS）；第 2 题 public_search 入参被 authorizesSearch 原文子串校验拒绝（模型未按原文引用固定问题，failureCode=tool_input_rejected），MCP search 0 次，入口失败即停无重试（实际消耗 model 3/4、search 0/2、tts 0/0）。脱敏证据 smoke/readonly-tools/validate-feat-004/real-mode-20261111-{result,scenario-1,scenario-2}.json；公共天气缓存写 .e2e/feat-004-live-weather/weather-cache-v1.json。
6. e2e-query（workers 1/retries 0/trace on/max-duration 600000）退出 0：desktop 5+narrow 5 共 10 通过，fixture 日志 sharedRequests=0 externalRequests=0，报告/JUnit/trace/截图留存 .e2e/feat-004-build/。

收尾核对：git status 无新增已跟踪修改；自启进程全部退出；key 未进任何产物。结论：单元/覆盖/类型/离线原生/浏览器 E2E 全部通过，真实层仅天气链路取证成功（SCN01 真实证据首次取得），真实 MCP 公开资料层未通过（SCN05/09 真实证据缺口维持 open）。第 2 题失败与 2026-11-10 第 1 轮诊断同因：模型对“原文参数”提示的遵循非确定，authorizesSearch 严格原文子串校验将其拒绝；修正方向为主 Agent 设定的等价规范化匹配与提示强化，见后续修正记录。

### 修正段 1：公开资料原文参数等价匹配与提示强化（2026-11-11，Build 内修正，执行环境：Claude Code 原生子代理）

独立 Validate 第 2 题失败后，主 Agent 定案两处修正：

1. **等价规范化**：`src/dsh/queryTurns.ts` 的 `authorizesSearch` 在比较前对可信参与者问题原文与 query 入参做有界规范化——Unicode NFC、移除全部 Unicode P/S 类标点/符号字符、连续空白折叠为一个空格、去首尾空白、casefold——规范化后仍要求 query 是规范化原文的子串。只吸收大小写、空白量和中英文/全半角标点的书写差异；改写句、添加新词、另一个问题、空串、纯标点串仍拒绝；不放宽为前缀/编辑距离/语义/词序匹配。规范化顺序为先去标点再折叠空白。
2. **提示强化**：`public_search` 工具 description 与 query 参数说明（`src/dsh/agent.ts`，两个直播 preset 共用同一注册）及 `dsh-livestream-douyin` persona（`cordis.patch.yml`）统一改为：「query 必须逐字复制用户当前问题原文，不得改写、翻译、省略、添加或概括，最多 70 字」，并给出正例「OBS Studio许可证」。仅改说明文本，schema、参数定义、执行路径未动。

先红后绿：实现前 8 项等价变体红灯（大小写、多余/连续空白、中英文标点、全半角标点），拒绝类负例当时即全绿；实现后定向 9 文件 83 项、全量 78 文件 487 通过/8 跳过（+17 恰为新测试）、coverage-diff 行 94.38%/分支 83.41%、typecheck、e2e-query 10/10（sharedRequests=0/externalRequests=0）全部退出 0。真实原生入口第 1 次调用（预算 1/2，无重试）退出 0：两题均 evidence，第 2 题实参为逐字原文 `{"query":"OBS Studio许可证"}`（string、无额外字段、failureCode=null），GLM 答 GPLv2；第 1 题天气链路继续 evidence（geocode 0 缓存命中/current 1）；总计 model 4/mcp 1/tts 0。脱敏证据 `smoke/readonly-tools/correction-feat-004-public-search/{result,scenario-1,scenario-2}.json`（0600），key 仅经环境变量注入。边界确认：规范化不含 NFKC（全角拉丁字母/数字不折叠）；query 省略原文中实际存在的空白仍拒绝（折叠而非删除）。真实通过为单次样本，模型遵循保持非确定假设，由独立 Validate 复核后才能关闭 SCN05/09。

### 独立 Validate 复验（2026-11-11，通过：修正段 1 后全部必要检查通过，执行环境：Claude Code 原生子代理）

本复验只读于实现，绑定业务候选 e20f22da85b31572f2cc186e77f24ddc3bda1cb0（记录时点的提交后 HEAD 为其仅文档差异的后代，业务内容一致；已核对 fd48d0a→e20f22d 仅含修正段 1 的 authorizesSearch 等价规范化、public_search 提示强化与 17 项新测试）。开始时 Turf 解析复核 exit 0。全部命令本轮实际执行，未复用历史证据：

1. 完整 Vitest+V8 coverage（DSH_HOME=/private/tmp/feat004-validate2-home、排除 macosTts.test.ts、maxWorkers 1）退出 0：78 文件、487 通过、8 跳过，与修正段全量结果一致（487=470+17 恰为新测试）；报告 coverage/feat-004-validate-2/。
2. coverage-diff 基线 67d4df44 退出 0：行 1159/1228（94.38%）、分支 709/850（83.41%）。
3. typecheck 退出 0。
4. 离线原生入口退出 0：weather_lookup（北京当前天气，limited，geocode 1/current 1/model 2）与 public_search（query 原文「OBS Studio许可证」，evidence，search 1/model 2），总数 model 4/mcp 1，证据 smoke/readonly-tools/validate-feat-004-2/offline-mode-20261111-result.json。
5. 真实原生入口（--approve=search:2,model:4,tts:0,seconds:300，key 仅经环境变量注入，本轮仅运行 1 次无重试）退出 0：第 1 题天气 evidence（geocode 0 为公共缓存命中属预期，current 1/model 2，failureCode=null，来源含 AWC METAR bbox、Nominatim、OSM copyright 均可独立核对）；第 2 题 public_search evidence，实参为逐字原文 {"query":"OBS Studio许可证"}（string、无额外字段、failureCode=null），MCP search 1、来源 3 条。总计 model 4/4、search 1/2、tts 0/0，预算内；scopesDisposed=2，cleanup=finished。上一轮 Validate 记录 fail 的真实公开资料层（SCN05/09）本轮取得真实证据：等价规范化与提示强化后模型实际发送逐字原文，authorizesSearch 通过。
6. e2e-query（workers 1/retries 0/trace on/max-duration 600000）退出 0：10/10 通过（JUnit failures=0/errors=0），fixture 日志各停止行 sharedRequests=0 externalRequests=0，报告/JUnit/trace/截图留存 .e2e/feat-004-build/。

脱敏证据（0600）：smoke/readonly-tools/validate-feat-004-2/real-mode-20261111-{result,scenario-1,scenario-2}.json；key 泄漏扫描 14 个产物文件均未发现。收尾核对：git status 无新增已跟踪修改；无自启进程残留；本轮临时 artifact 目录已清理；共享服务未触碰、未播出。结论：修正段 1 后六项必要检查全部通过，上轮 fail 项复验通过；真实 GLM 对逐字原文参数的遵循仍为单次样本，非确定假设保持不变；舞台/观众播放继续不在本轮范围（tts:0，audio=not_requested、not_tested）。

### 正式 sdlc-review（2026-11-11，approved，执行环境：Claude Code 原生子代理）

独立评审绑定候选区间 67d4df44..e20f22da（验证 commit e20f22da），全程只读、未运行测试/构建、未触网络；评审时工作树干净、src/test 与候选逐字节一致。结论：未发现 CRITICAL/HIGH。

- **MEDIUM（已处置：修订表述）**：上文「需求到契约与验证」表 FR05 行原声称验证 200/204/304/400/429/5xx；实际专测仅覆盖 200/304/5xx，AWC 204 空观测分支（`src/body/weather.ts:138` 缓存空结果返回 limited）无测试驱动，400/429 经 `!response.ok` 同分支间接覆盖。行为经评审代码走查未发现缺陷；主 Agent 选择修订该行表述为实际覆盖（见上表），204 专测与来源 URL 去重一并登记为残留，留待下次触碰天气代码的修正段补齐，不为本项单独触发重验证。
- **LOW（已知局限，暂不修）**：`src/body/readOnlyQuery.ts` 结构化 JSON 行路径挑选来源时不按 URL 去重（纯文本回退路径有 `seen` 去重），同一链接多行可重复进入 sources 挤占 3 来源预算，且 `console.tsx:305` 以 source.url 作 React key 产生重复 key。属展示质量，无安全或事实正确性后果；与 MEDIUM 残留同一批处理。
- 其余镜头结论：模块边界/安全（固定端点、1MiB 上限、凭据隔离、publicUrl 校验、缓存 0600 原子写、转义与脱敏）/服务端（规范化拒绝负例 8 组、同轮冻结、失效检查覆盖提交前/正文接纳前/TTS 前/队列前/舞台广播、取消路由三重匹配）/客户端（时间区分、date-only 不补造）/qa 抽查关键路径断言均到位。

### 合并候选上的验证重建（2026-11-11，通过）

FEAT-006 的业务提交使本 Feature 在 2d3ac8b 的验证按 CLI 规则失效（业务路径变化须重新验证）。FEAT-006 的独立 Validate 在合并候选 04746f6bc0062eb8313e07f37be993768e9e3eee（= e20f22da 业务内容 + FEAT-006 实现，本 Feature 生产文件在该候选上与已评审内容的一致性由 FEAT-006 评审对本 Feature diff 的覆盖承接）上执行了全套件与本 Feature 全部入口：完整 Vitest（含本 Feature 全部测试）84 文件 544 通过/8 跳过 exit 0、e2e-query 10/10、离线原生入口 exit 0、真实原生入口单次 exit 0（两题 evidence、第 2 题逐字原文、预算内 model 4/4/mcp 1/2/tts 0）。六项必要检查在合并候选上全部保持通过；证据明细存于 FEAT-006.engineering.md 同日验证记录与 smoke/readonly-tools/validate-feat-006/。本 Feature 状态按该证据在合并 HEAD 重建 validation（pass）与 review（approved，评审主体为本文件上文的正式 sdlc-review 结论；共享文件在 FEAT-006 变更后的行为由 FEAT-006 独立验证的三套回归与 e2e-query 复核）。

### 统一独立 Validate（2026-11-12，通过：候选 2b107efc 全部必要检查通过）

执行环境：T3 `claudeAgent` / 请求 `glm-5.3-flash[1M]` / `effort=xhigh`（executedModel 元数据沿用交接记录：返回不含上下文后缀，1M 容量未独立验证）。独立验证执行者，非实现者；真实 GLM/TTS/天气/MCP 搜索/账号/推流预算 0，本轮**无新增真实调用**；未改实现/产品/state，未 commit/push，共享服务零触碰。本节与 FEAT-006.engineering.md 同日「统一独立 Validate」共享同一候选、同一隔离副本与命令证据（引用一次，不重跑）；此处只补本 Feature 专属行。

**候选与副本绑定**：`2b107efc1672b2d51aa8984ba45d5b88dd5484b3`（分支 `codex/macos-yovoice`，开始时工作树干净）；副本 311 个跟踪文件 blob 哈希逐字节核验一致；依赖只读 APFS 克隆；环境 Node v26.13.0、HeadlessChrome/156.0.8078.4。

| 检查（本 Feature 验收条件） | 结果 | 证据或缺口 |
|---|---|---|
| typecheck / build | PASS | exit 0（09:18:21 / 09:18:28，四 bundle，lib/index.js 零 dsh-tools/dsh-llm 引用） |
| 完整相关 Vitest+coverage（含本 Feature 全部测试，一次证明 unit+coverage） | PASS | exit 0：86 文件、587 通过、8 跳过（`--exclude test/macosTts.test.ts`；87−1/589−2 与三轮最终代码精确吻合）；报告 coverage/feat-006-validate/ |
| coverage-diff **本 Feature 基线 67d4df4**（80%行/70%分支，不复用 006 基线） | PASS | exit 0：行 3050/3408（89.50%）、分支 1603/2027（79.08%）；同一映射报告对两个基线分别执行 |
| 四套 Web E2E（e2e-session-context / e2e / e2e-douyin / e2e-query） | PASS | 4/4、6/6、12/12、10/10 全 exit 0，JUnit failures=0/errors=0；HeadlessChrome/156.0.8078.4；e2e-query 与 e2e-session-context fixture `sharedRequests=0 externalRequests=0`（本 Feature 的 e2e-query 为其中 10 项） |
| 离线原生入口 `node test/live-query/run.mjs`（默认 offline） | PASS | exit 0（09:21:31）：weather_lookup 北京 limited（geocode 1/current 1/model 2）＋ public_search 逐字原文「OBS Studio许可证」evidence（search 1/model 2），总 model 4/mcp 1，scopesDisposed=2、cleanup finished；audio offline_not_requested |
| 真实 GLM 样本引用（协议等效性） | PASS（按协议引用，无新增真实调用） | `git diff e20f22da..2b107efc` 核对：queryTurns.ts/queryCredential.ts/body 三文件（readOnlyQuery/weather/weatherCache）/shared/readOnlyQuery.ts/test/live-query 全部**零差异**；agent.ts 仅新增会话上下文行（public_search/weather_lookup 工具描述与逐字提示、authorizesSearch 未动）；cordis.patch.yml 零差异。故 e20f22da 的真实样本（两题 evidence、逐字原文、预算内计数）对本候选按协议引用；模型遵循为非确定假设不变 |
| 舞台/观众播放、真实服务全链路 | 不在本轮范围 | tts:0/合成 0；运行期观察项保持，不以外推当通过 |

**收尾与状态请求**：进程零残留、共享端口零请求、副本产物保留于 `/private/tmp/dsh-unified-validate-20261112/`；共享 checkout 收尾仅新增两条允许的工程记录。canonical `stage:validate`，`status:awaiting_acceptance`；`allowed_transitions`＝请求 `record-validation --feature-id FEAT-004 --result pass --test-command "node test/live-query/run.mjs" --commit 2b107efc1672b2d51aa8984ba45d5b88dd5484b3`（完整命令列表见 FEAT-006.engineering.md 同日记录与本节）。`context_updates.project_candidates`＝[]。未执行任何 lifecycle mutation。

### 正式Sol Review（2026-11-12，建议 approved，待主 Agent 验收）

本次为新的独立正式 Review。T3 `t3_thread_configure` 返回 `modelSelection.instanceId=codex`、`model=gpt-6.1-sol`、`options=[{id:reasoningEffort,value:xhigh}]`；该配置元数据已核实，单独的 `executedModel` 字段未返回，不推断其他执行元数据。评审者自行串行完成 qa、security、architect、server-dev、client-dev 及本次 UI 相关 design 视角，未创建下级执行者。

候选为 `2b107efc1672b2d51aa8984ba45d5b88dd5484b3`，评审开始及记录前 HEAD 均为 `fd8f4b28b4da3d59c33802e3e7fbc3b93e6859f8`，分支 `codex/macos-yovoice`。`git rev-parse 67d4df4` 解析为 `67d4df44e3c119b5a799029913cdef6c29c73aeb`；按此基线检查累计生产变化，并优先核对上次正式评审业务版本 `e20f22da85b31572f2cc186e77f24ddc3bda1cb0` 之后的共享接线。实际 `git diff --quiet 2b107efc..HEAD -- . ':(exclude).sdlc-v1/**'` exit 0，业务 `git status --porcelain --untracked-files=all -- . ':(exclude).sdlc-v1/**'` 为空；两 Feature 的 state 均为 validated/pass，绑定本候选，review pending。仅本次 Review 文字写入工程上下文，不写 state。

**契约与调用链覆盖**：从 owner 开关/凭据 admission、宿主归属输入及逐字参数校验，经 `queryTurns`、固定 MCP 或天气 source/cache，追到工具结果、原生 assistant 观察、`show.say`/mic 队列、Stage 连接能力和撤销。核对了参与者地点/日期关联、观测与预报时间、受限来源、15 秒/单并发/取消、同一原生 turn 失效不可重新授权、断订阅后新 owner turn、下播及旧连接回调；FEAT-006 的早绑定/限制安装没有改写这些查询规则。实际 `git diff e20f22da..2b107efc --` 查询归属、凭据、三个查询/天气 body 文件、shared DTO、原生查询测试及 preset patch 均为空；`agent.ts` 共享变化按上述调用链审查，不以零差异代替交互检查。宿主 index 保持经 runtime 回调核对绑定，无静态 agent/dsh-tools/dsh-llm 依赖；`build.mjs` 仍共同构建 index/agent chunks，检查独立验证副本 `lib/index.js` 未命中上述外部依赖。

**证据与适用范围**：已读本文件和 FEAT-006 同日统一独立 Validate/主 Agent 接纳记录，以及 `/private/tmp/dsh-unified-validate-20261112/logs/{typecheck,build,vitest-coverage,e2e-all,live-query-offline}.log` 和 `sc002/{phase1,phase2,phase3,phase4,phase5,hostA,hostB}.log`。已有单元/类型/构建、两基线覆盖和 E2E 证据按原记录引用，不复制结果表或机械重跑。guide 的 `LIVE-QUERY-WEATHER`/`LIVE-QUERY-SEARCH`/`LIVE-QUERY-CONTROL` 与 Mac 指南对应已确认 story、owner 配置/环境参数、原生离线输入及 E2E；旧真实来源/GLM 样本只覆盖未变协议，模型遵循仍非确定。TTS 两个 macosTts 集成用例本轮未执行；实际舞台/正式观众播放及 dsh web CLI 顶层包装仍未验证，不外推为 live 通过。宿主最终证据采用 hostA.log 20 项与 hostB.log 23 项；保留中间失败和旧 hostA.final.log 的历史归属。

**发现与结论**：本 Feature 未发现新的必须修复项，建议 `approved`。FEAT-006 新定位的资料/配置问题统一列在该工程上下文的本次 Review，不当作查询功能的新增缺陷，也不据此重复旧查询断言。既有 AWC 204 专测和来源 URL 去重的有据延期决定继续保留，未发现要求重新打开的回归证据。本次 diff 未发现有证据支持的查询重复实现或可避免工程债；只读注册内部结构依赖按 FEAT-006 的固定版本兼容边界保留，不能仅因 private/any 判为漏洞。没有稳定工程入口变化，`project_candidates=[]`。

仅请求主 Agent 验收后执行 `record-review --feature-id FEAT-004 --decision approved --by sdlc-review-sol-20261112`；本评审未执行该操作，未提交、推送、部署或宣称整个目标完成。

### 统一独立 Validate 重建（2026-11-12，通过：候选 0b38f9d 全部必要检查通过）

执行环境与共享证据同 [FEAT-006.engineering.md](FEAT-006.engineering.md) 同日「统一独立 Validate（候选 0b38f9d）」一节：候选 `0b38f9dfda7b6c2d0e6add27f47cb2c2a0d9b196`、312 blob 逐字节核验、隔离副本/依赖只读/共享服务零触碰/无新增真实调用均在该节记录，此处引用不重跑。本节只补本 Feature 专属行；本验证为 FEAT-004 在最终业务 HEAD 的重建（旧 reviewed/pass 绑定 2b107efc，按既定决定不能抵扣本候选），全部命令本轮实际执行。

| 检查（本 Feature 验收条件） | 结果 | 证据或缺口 |
|---|---|---|
| typecheck / build | PASS | exit 0（共享记录同两条命令，11:45:20–22） |
| 完整相关 Vitest+coverage（含本 Feature 全部查询测试，一次证明 unit+coverage） | PASS | exit 0：87 文件、605 通过、8 跳过（排除 macosTts.test.ts，2 项真实 OS 语音 NOT_RUN）；readOnlyQuery/queryTurns/queryPreset/queryHarness/weather/cache/live-query 全部在内 |
| coverage-diff **本 Feature 基线 67d4df4**（80%行/70%分支） | PASS | exit 0：行 3093/3430（90.17%）、分支 1675/2092（80.07%）；同一映射报告，不与 006 基线混用 |
| 四套 Web E2E（本 Feature 的 e2e-query 为其中 10 项） | PASS | e2e-query 10/10 exit 0，JUnit failures=0/errors=0；fixture `sharedRequests=0 externalRequests=0`；其余三套 4/6/12 同通过（共享记录） |
| 离线原生入口（本 Feature 验收入口默认 offline） | PASS | exit 0：weather_lookup 北京 limited（geocode 1/current 1/model 2）＋ public_search 逐字原文 evidence（search 1/model 2），总 model 4/mcp 1，failureCode 双 null，scopesDisposed=2 |
| 真实 GLM 样本引用（协议等效性） | PASS（按协议引用，无新增真实调用） | `git diff 2b107efc..0b38f9d` 核对：queryTurns.ts/queryCredential.ts/readOnlyQuery/weather/weatherCache（body 三文件）/shared DTO/test/live-query/cordis.patch.yml 全部**零差异**；agent.ts 查询工具描述与 authorizesSearch 未动。故 2b107efc 真实样本（两题 evidence、第 2 题逐字原文 {"query":"OBS Studio许可证"}、预算内 model 4/4、mcp 1/2、tts 0）对本候选按协议引用；模型遵循仍为非确定假设，不外推到 live |
| 舞台/观众播放、真实服务全链路 | 不在本轮范围 | tts:0/合成 0；运行期观察项保持 |

**收尾与状态请求**：进程零残留、共享端口零请求、副本产物保留于 `/private/tmp/dsh-validate-0b38f9d-114156/`；共享 checkout 收尾仅新增两条允许的工程记录。canonical `stage:validate`，`status:awaiting_acceptance`；`requested_transitions`＝请求 `record-validation --feature-id FEAT-004 --result pass --test-command "node test/live-query/run.mjs" --commit 0b38f9dfda7b6c2d0e6add27f47cb2c2a0d9b196`（完整命令列表见 FEAT-006.engineering.md 同日共享记录与本节）。`context_updates.project_candidates`＝[]。未执行任何 lifecycle mutation，不自称正式 review 或已发布。


### 正式Sol复审（2026-11-12，候选 0b38f9d，建议 approved，待主 Sol 验收）

本轮为新独立执行者，按 `sdlc-review` 与 role-routing 串行完成 qa、security、architect、server-dev、client-dev，用户可见部分补 design；未创建任何下级 Agent。运行时说明明确为 T3 Code / Codex harness / `gpt-6.1-sol` / `xhigh`，本轮没有单独的 `executedModel` 或工具返回的 target/options 配置对象，不从历史线程配置推断。只读核对根 AGENTS/soul/user、项目上下文、REQ-006/REQ-010、两 Feature 当前有效方案与最新统一独立 Validate；目标与源码范围未发现更近 AGENTS.md。

**版本与范围**：业务候选 `0b38f9dfda7b6c2d0e6add27f47cb2c2a0d9b196`，开始及落笔前 HEAD `a74683ff3eb6f824e15e8a29bbe5ecb4336beccd`，分支 `codex/macos-yovoice`。实际 `git diff --quiet 0b38f9d..HEAD -- . ':(exclude).sdlc-v1/**'` exit 0，业务 `git status --porcelain --untracked-files=all -- . ':(exclude).sdlc-v1/**'` 为空；state 中本 Feature validated/pass 绑定该候选，review pending。优先审查 `2b107efc..0b38f9d` delta 与共享调用链，累计一致性基线仍为 `67d4df44e3c119b5a799029913cdef6c29c73aeb`。

**契约与证据覆盖**：delta 的 agent.ts 仅改变 Skill 重复加载输出，console.tsx 增加 invalid 开始拒绝，sessionContext.ts 改路径发现、预算及 active；定向 `git diff --name-only 2b107efc..0b38f9d --` 对 queryTurns/queryCredential、body/readOnlyQuery/weather/weatherCache、shared 查询 DTO、test/live-query、test/e2e-query、cordis.patch.yml 均无输出。结合当前 Agent 的 query ownership/pre-step、可信原文 admission、工具 execute、assistant 接纳与原有 show/Stage 归属链核对，未见此次会话限制或 Skill 输出改变查询权限、平台隔离、取消、断订阅后新 owner turn 或晚到输出规则。宿主 index 仍只经 runtime 回调核对 ready；只读检索最新独立副本 lib/index.js 未命中 `@deepseek-ai/dsh-agent`/`dsh-tools`/`dsh-llm`，共享 bundle/runtime 边界保留。

引用本文件「统一独立 Validate 重建（候选 0b38f9d）」及 FEAT-006 同日共享记录，不复制验证表。已实际读取 `/private/tmp/dsh-validate-0b38f9d-114156/run-validate.sh`、`logs/{summary.txt,chain-final.txt,check.log,build.log,vitest.log,coveragediff-004.log,coveragediff-006.log,e2e-sc.log,e2e-voice.log,e2e-douyin.log,e2e-query.log,livequery.log,hostA.log,hostB.log,sc002-phase1.log,sc002-phase2.log,sc002-phase3.log,sc002-phase4.log,sc002-phase5.log}`，并定向核对 sc002 原始脚本。原日志支持完整链各 STEP exit 0、605 pass/8 skip、查询 E2E 与离线原生两题；旧真实 GLM/来源样本仅按未变协议引用，未新增外部调用，不把模型遵循视为确定保证。

**usage / design / 限制**：README 的 LIVE-QUERY-WEATHER/SEARCH/CONTROL → REQ-006 story → Mac 指南/shared schema/owner 配置 → 原生离线与实际 E2E 结果链一致；来源时间、limited、取消入口、静音预览及未部署范围没有被文档检查替代。UI 仅做静态状态/语义检查，引用现有桌面/375px E2E；Impeccable 在运行时目录可见且 SKILL.md 可读，本轮未启动其 launcher、浏览器或完整 critique，不声称独立渲染/键盘通过。两项真实 macOS TTS、完整 90 秒道别、dsh web CLI 顶层包装、实际舞台/正式观众播放仍未验证；1M 容量及单独 executedModel 未验证。

**结论**：FEAT-004 没有新的必须修复项，建议 approved。FEAT-006 本轮 R9～R11 与 R8 残余统一记录在其工程上下文，不重复作为查询发现；既有查询的有据保留/延期项没有新的回归证据，不重新打开。本次 diff 未发现有证据支持的查询重复实现或可避免工程债。`project_candidates=[]`。仅请求 `record-review --feature-id FEAT-004 --decision approved --by sdlc-review-sol-0b38f9d-20261112`；未执行 mutation、Git 写入或部署。
