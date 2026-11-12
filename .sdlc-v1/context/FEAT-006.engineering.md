# 工程上下文：FEAT-006 直播会话的工作目录与 Skill 设置

## 当前有效方案

### 架构设计

**关联产品上下文**：`.sdlc-v1/context/REQ-010.product.md`，唯一产品规则为其中 NEED/CON/DEC、CFG-01～05、SCN-01～07、SC-001/002。

**工程上下文**：`.sdlc-v1/context/FEAT-006.engineering.md`。

**分支与基线**：`codex/macos-yovoice`；起始核实 HEAD 为 `06c294a38f1c1dc8265b403bfd3ab501508c647e`，源码基线为 `fd48d0a5d9a18a3759428c3286f28480630eeb9a`，这两个版本之间仅有 SDLC 文档变化。并行工作在本轮收尾时推进仓库 HEAD 至 `6f57866e552e5ae500f0dcfb6961e1267ed259f0`；已用限定路径 Git diff 确认本方案相关生产源码、包配置与构建/验证配置相对起点未变，且生产源码仍与固定功能基线一致。不采用并行工作的验证结果。

**创建日期 / 状态**：2026-11-11 / Plan 已接受、Feature/Task 已登记；历史 Build/Validate 已完成，当前处于评审修正，尚未通过本修正段验收或发布。正式进度以 state.json 为准。

**方向与结果**：长期方向来源为 `none`，沿用 project.md；预期结果是 owner 在既有抽屉保存配置后，下一次控制台创建的直播会话实际使用所选 cwd、冻结的 Skill Markdown 和受限资料读取。产品观察标准只引用 REQ-010 的发布后观察计划。

#### 背景

REQ-008 的来源、历史确认与源码证据和 REQ-009 的取消分析仅用于追溯；其中旧归并交付安排不覆盖 REQ-010。未读取、未引用其他需求的未登记工程候选。以下事实经本轮只读核实，均不是运行通过证据。路径以仓库根为准；`../upstream` 固定在 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，安装包从工作区父目录 `../node_modules/@deepseek-ai/` 对照，相关 DSH 包版本均为 `0.2.2-rc.1`。

| 事实与源码锚点 | 设计影响 |
|---|---|
| `src/console/console.tsx:195` 的 `createBrainSession()` 取第一个 workspace，调用 `sessions.create({workspaceId})`，再 `remote.agentPresets.select()`，最后 `sessions.using()` 等待就绪并命名；`:596` 的 `goLive()` 随后 POST `onair`。这里的 `src/` 均指 `packages/dsh-livestream/src/`。 | 实际新会话入口在控制台，不在 agent.ts；不能仅修改 preset 描述、settings 回显或 `/onair` 参数。 |
| upstream `packages/api/session-controller/src/index.ts:307` 的公开宿主方法 `sessionController.create(request)` 转到 `commands.ts:120`；请求支持 `sessionId`、`agentPreset`，`workspaceId` 与 `cwd` 互斥。安装版 `lib/index.js:666` 具有相同逻辑。`agent.ts:262/435` 在发布 Agent 前挂载 preset，将 cwd 写入 session header，同时会 `mkdir(cwd,{recursive:true})`。 | 宿主适配调用公开 `create()`，显式选原有直播 preset；先校验现存目录，不把 native mkdir 当校验或目录创建功能。不同时传 cwd/workspaceId，也不先创建 Standard Agent 再切换。 |
| upstream `packages/core/session/src/index.ts:139/536` 校验并冻结 header；`packages/workspace/workspace/src/types.ts:69` 的 workspace.path 是创建时 realpath，不能改写。`packages/session/working-directory/src/index.ts:86` 从 header 初始化有效 cwd；其 set 只改变有效 cwd，不提供权限隔离。 | cwd 必须进入新会话的原生创建参数并核对 header/workingDirectory；不迁移活动会话，不注册 cwd 修改工具。 |
| upstream `packages/skill/skill-filesystem/src/index.ts:48/251/737/811` 有 `customSkillDirs`、`includeDefaultRoots`、watch；发现根下 `.md` 或子目录 `SKILL.md`，校验 YAML name/description/invocation。默认根含项目 `.dsh/.agents`、用户与 bundled，不自动扫描 `.claude`。安装版同名 Config/roots 逻辑一致。 | 可参考其格式，但不能把 Codex 可见的 Skill 当作直播会话已加载。原生 provider 没有本需求的文件/总量预算与会话冻结承诺。 |
| upstream `packages/skill/skill/src/index.ts:345/556` 与 installed `dsh-skill/lib/index.js:299` 合并 global 与 scope；`tool-skill/src/index.ts:130/185/217` 每次调用/步骤查 registry 和 Markdown。用户显式 `/name` 路径也会加载定义，不只依赖模型工具目录。 | 仅关闭默认 roots 或 watch 不足以证明来源隔离、内容冻结；仅隐藏 native `skill` 工具也不足以屏蔽全局显式调用监听器。 |
| native Skill 加载结果只有 Markdown、metadata/resourceBase，未自动安装依赖、运行脚本或赋予工具。isolated Cordis service 可组合，见 preset registry 测试 `registry.spec.ts:210` 和 session `skill-catalog.ts:65`。preset `select()` 仅首 turn 前允许，旧 Agent 保留旧 revision，见 `agent-preset-registry/src/index.ts:357` 及其测试。 | 隔离 registry 是可选组合事实，不是已实现的 per-session 选择/内容冻结 API；不能虚构 `selectedSkillNames`。 |
| upstream `packages/fs/fs-sandbox/src/index.ts:2` 明确读取不受 sandbox mode 限制；sandbox-policy 只有 writable roots。 | 不使用通用 `tool-fs`，不把 readonly/cwd 当读取授权。 |
| `runtime.ts:169/225/250` 的 load/save/updateSettings 将同目录独占 0600 临时 JSON rename 成功后才发布内存；`readOnlyQueries` 使用 shared DTO/merge、默认关闭。`index.ts:343` 先验证 patch 再整体 update。 | 复用 settings.json 和原子发布，不增加第二个配置存储或修改旧字段优先级。 |
| upstream `packages/client/connection/src/rpc-host.ts:215` 的 exact fetch 路由拒绝非 owner；installed `dsh-client-connection/lib/index.js:830` 相同。web 入口先验证 browser auth、Host/Origin。 | 管理状态、保存和新会话路由全部继续经 `ctx.connection.fetch.register`；模型工具、Stage 和观众均不提供管理入口。 |
| `index.ts:181/293` 的 B 站 `resumeLive()` 可自动 resolve Agent、connect、resumeLive/adopt；抖音和彩排直接跳过。 | REQ-010 管理的会话必须显式跳过自动恢复；旧安装未使用新增配置时保留原恢复行为。 |
| Drawer `console.tsx:875`、`TtsSettingsPanel`、`SecretField:260`、`useBusy()`、`dl-*` CSS 已存在；`src/shared/readOnlyQuery.ts` 无 Node。`build.mjs` 合并 index/agent chunks，打包 YAML 等普通依赖，仅 external `@deepseek-ai/*` 及可选原生加速包。 | 复用局部表单、独立草稿/保存/文字状态，不引入 Tailwind/新 UI 库。现有锁定 `yaml 2.9.1` 可打入宿主 bundle，不新增或安装 Skill 依赖。 |

只读核对的实际 Papermorph 数据：项目 `.claude/skills/papermorph/SKILL.md` 为 2049 字节，`config/papermorph/upstream/skill/SKILL.md` 为 12167 字节，均为可读 UTF-8，均声明 `name: papermorph`。二者同时启用必须报同名异源冲突。选择前者不会自动读取它引用的后者或运行 `ensure/check-update/doctor`；这些指令作为受限 Skill 内容处理。本条不预填个人绝对路径，也不执行 Papermorph。真实资料根由 owner 指定；REQ-008 记录的既有 `workspace/20261110-papermorph-lever/site/lever-lab/` 只是后续读取验证候选，不授权执行或课程播放。

#### 架构与组件

##### 共用配置与状态 DTO

- **职责**：新增 `packages/dsh-livestream/src/shared/sessionContext.ts`，定义浏览器/宿主共用 JSON DTO、纯结构校验、默认值、状态与受限工具结果枚举。不得 import runtime、Node/fs/path、服务实例或将 Node 类型传给浏览器。
- **接口**：`SessionContextConfig`、`SessionContextSaveRequest`、`SessionContextView`、`SessionContextSnapshotView`；完整形状见下文。结构规则只定义一处，宿主再加实际 IO 验证。
- **覆盖**：CFG-01/02/05、SCN-01/05/07。

##### 宿主设置验证与受限资源读取

- **职责**：新增 `src/dsh/sessionContext.ts`，组合纯 DTO 校验、路径验证、有界 Skill Markdown 解析、资料读取、owner 健康检查与会话快照存取；复用 runtime 的 settings 原子提交。具体路径算法可独立放同目录 `sessionContextPaths.ts`，不建立通用文件系统框架。
- **接口**：验证保存候选、取得完整保存版本、准备/绑定指定 sessionId 的快照、按快照加载 Skill、按 rootId/relativePath 读取资料。只对插件自有 settings/快照执行写入；Skill、cwd 与资料树只有受限只读 IO。
- **覆盖**：CFG-02～05、SCN-02～06。

##### 原生会话适配与 Agent 接线

- **职责**：新增 `src/dsh/sessionContextSessions.ts` 或同模块的有界适配器，由 index.ts 的 owner 路由调用 `ctx.get('sessionController').create()`；agent.ts 为绑定快照的 **Agent 自身 scope** 注册两个窄工具，并注入不含宿主绝对路径的会话 manifest。
- **接口**：`POST /api/dsh-livestream/sessions`；Agent 侧 `load_livestream_skill({name})`、`read_livestream_material({rootId,path,startLine?,maxLines?})`。每次调用从 `exec.agent.session.id` 查绑定；不接受模型提交 sessionId、cwd、根路径或设置。
- **覆盖**：CFG-01～05、SCN-01～07、SC-002。

##### 原控制台局部表单

- **职责**：在原 Drawer 的声音/查询设置相邻位置增加“新直播会话”section；可独立抽成 `SessionContextSettingsPanel`。复用带 label 的输入、checkbox、`dl-field/dl-row/dl-hint/dl-btn`、`useBusy`/局部保存状态及 SecretField 的提交反馈方式。路径是普通输入，不改成密码字段，不影响 SecretField 凭据读写。
- **接口**：草稿启用状态、可留空 cwd、显式 Skill 来源列表、资料根列表、增删/启停、一个“保存会话设置”按钮。分区展示已保存 revision/健康检查、活动 sessionId/快照 revision/实际 cwd/加载状态；没有活动会话明确写出。轮询不能覆盖未保存草稿，保存失败保留输入；关闭抽屉不隐式保存。
- **覆盖**：CFG-01/02/05、全部控制台场景。

实际变化是多个 Skill 来源/根列表，以及 B 站/抖音/彩排的既有 live preset；共同稳定机制是 `保存版本 → 会话快照 → 两个受限工具`。来源和目录是数据，平台差异仍由原 preset/平台权限承担；不把工具、代码或权限写成配置字符串。只处理 live 主线，游戏线继续原创建路径，不继承新增资料/Skill 授权。

#### 关键设计决定

##### 决定 1：原生会话 + 插件内受限 Skill 加载

| 候选 | 需求覆盖与扩展方式 | 成本与风险 | 决定 |
|---|---|---|---|
| native filesystem + native tool-skill，直接 customSkillDirs | 现成发现/YAML/catalog/loader；没有 session 独立选择和内容冻结，仍合并 global provider | 重复名有优先级而非本条要求的错误；动态文件变动、默认扫描和原生通用 fs 不能提供读取边界 | 不采用 |
| isolated native skill service + 内存 snapshot provider + native loader | 可隔离一个 service，并用 provider 固定内容 | 仍需自写有界解析/校验/provider、per-session 分派和状态；native resourceBase 含路径，cold catalog 也需匹配，新增多项宿主耦合 | 不是本条最小方案 |
| 既有原生 session/preset + 插件内有界 parser/内存定义 + 两个窄工具 | 完整表达显式来源、重复/冲突、内容冻结、资料根、错误与缺能力 | 需维护很小的 Markdown 格式子集和路径校验；测试聚焦真实加载/读取边界 | **采用** |

选择属于“复用现有实现 + 补齐原生缺口”，不新建 Agent runtime。YAML 使用仓库已锁定的 `yaml 2.9.1`（MIT），由现有 esbuild 打包；Node fs/path/crypto、现有 DSH/React 均直接复用，无新包、外部下载或插件安装。DSH 机制与许可证按现有依赖边界使用，不复制 upstream 私有实现。没有需要扩大外部检索的候选缺口。

Skill 来源允许显式 `.md` 文件、直接含 `SKILL.md` 的目录，或一个容器目录。容器仅发现直接 `.md` 和一级子目录的 `SKILL.md`，不递归读取 references/scripts/dependencies，不跟随容器内符号链接；遇到直接 `SKILL.md` 就作为单 Skill 目录，不再扩展其兄弟文件。仅有 Markdown 名称不算加载：工具成功返回冻结正文才记 `loaded`。

首版格式是严格 UTF-8、`---` YAML frontmatter、非空正文；必需 name（原生 kebab-case 规则、最多 64 字符）与 description（最多 2048 字符）。未知 metadata 作为惰性数据不执行；不接受 YAML 自定义 tag、重复 key、alias/merge、非标量必需字段，限制 frontmatter 深度 8。支持原生 `disable-model-invocation` / `user-invocable` 的已核实布尔语义；拒绝历史 camelCase 别名。模型 loader 只可加载 modelInvocable 定义；明确禁止模型调用的来源显示为“可发现、不可由模型加载”，不偷偷绕过。首版不实现 native slash command 注册或脚本调用。

宿主组合边界：本条不启用 native skill/filesystem/tool-skill。默认 Web patch 明确禁用全局 filesystem/tool-skill，**不据此推定当前 live 状态**。新配置启用时，以已核实的 `ctx.get('loader').entries()`（installed plugin-inventory 同样使用它）只读检查有效全局 entry；若全局 native `tool-skill`、默认扫描 filesystem 或 agent-instructions 处于启用/加载中、或无法确认隔离，返回 `HOST_COMPOSITION_UNSUPPORTED`，不自动禁用或修改共享宿主。其他 global skill providers 可存在：本条完全不调用 registry，不消费其目录。每次本条 Agent pre-step 再核对这一组合条件；不满足则拒绝该步，不调用后续可能扫描全局来源的处理器。状态给 owner 可修正说明，不能声称换到 Standard 可以解决。正常 Web 发行组合和非标准 global loader 分别列入集成验证。

管理会话在 Agent 自身 scope 设置 inherited-tool 允许名单，但必须保留父 preset scope 的既有直播工具。由持有注册/注销 disposer 的 preset 上下文记录实际 definition 和来源身份；名单计算须核对这个可信注册来源，不能用受当前 Agent 限制影响的 `tools.get(name,agent)` 判断注册是否存在，也不能只凭同名或临时解除限制来检查。原生发行组合实测：恢复时三个抖音工具属于 inherited scope，不能永久使用空 allow 丢掉它们。本条两个 Agent 自身 scope 的窄工具按原生规则保留；未知或同名替换的 global 工具不能获准。平台往返注册时先安装新限制再释放旧限制；若刷新失败，保留旧安全限制、取消当前执行并标记会话不可继续，不释放成无限制。首次安装失败须让串行创建/恢复拒绝，不能返回绑定成功；若临时空 allow 用作失败保护，不将其当正常完成状态。最终实际首个 toolset 再核对无额外 Shell、fs、插件安装等工具；无配置的 legacy 会话不安装新增限制。

Skill“已加载”只表示 Markdown 已进入该会话实际工具结果/上下文，能力固定为 Markdown + 指定资料读取。owner 状态同时显示“脚本、依赖安装、文件写入不可用”；请求制作脚本时明确缺能力。Skill 内文字、路径或 required-tools metadata 不注册任何能力。

**可信注册核对的安装版本依赖（2026-11-12 主 Agent 核实）**：当前 `dsh-tools@0.2.2-rc.1` 的公开 `view()` 会受既有限制过滤，不能用于恢复名单。实现通过 `tools.layers.global.tools` 与 `tools.layers.chainLayers(agent)` 只读取得未过滤的原始 registration，并与所属 preset 实例保存的 definition 对象核对。`lib/types/index.d.ts:38` 将 `layers` 声明为 `private readonly`；因此这是对固定安装组合内部结构的受控兼容依赖，不能称为公开 ToolsService API。该结构缺失或读取失败时，首装拒绝并回滚、刷新失败锁定，绝不按名称兜底或临时解除限制。当前真实发行组合已覆盖此访问；宿主版本升级必须重新核对，正式独立 Validate/Review 应检查该依赖与失败行为。

**覆盖**：CON-001/002、CFG-01/03/04、SCN-02/03/07。

##### 决定 2：整体保存与创建使用不同的不可变值

配置唯一持久化于原 settings.json 新增 `sessionContext` 字段；只有保存成功才发布该字段/revision。已保存配置是输入与目录绑定，Skill 正文只在创建会话时取得并冻结，避免每个工具调用重新读取。保存校验不执行 Skill；校验全部通过才允许一次原子提交。新增字段不存在时是 legacy 状态，与显式保存 `enabled:false` 区分。

保存的耗时验证在提交前做完；最终同步临界区再次比较 context revision，并由 `updateSettings()` 从**当时最新 settings** 合并 patch、rename、发布内存。不得把 await 前的整份 settings 再写回，避免覆盖期间成功保存的声音/房间/查询配置。上下文更新冲突返回 409；同一请求混合其他设置时，任一字段无效则整个请求不提交，不产生旧字段即时副作用。

新会话路由在首次 await 前同步复制最近成功发布的完整记录，这是保存/创建的线性化点。之后保存 B 不修改正在准备的 A；A 仍是创建请求取得的完整版本。捕获后完成有界重查和 Skill 正文冻结，再创建原生 session。只在捕获点之前已返回成功的保存必须可见；重叠操作可取 A 或 B，不能出现混合版本。失败的验证/快照写入/原生创建不会替换旧活动快照或调用 onair。

**覆盖**：CFG-02/05、SCN-01/04/05/06。

##### 决定 3：cwd 不授予资料权限，实际读取按固定根校验

cwd、Skill 来源与资料根是三个独立授权集合。cwd 只进入 native header/workingDirectory；Skill 来源只授权读取选定 Markdown；资料工具只访问快照内 rootId 指定的根。Skill references 不自动成为资料根。所有配置与读取拒绝都使用字段定位/错误码，模型结果和公共舞台不包含宿主绝对路径或原生 Error/stack。

**覆盖**：CFG-01～04、SCN-02～04/06/07。

#### 数据模型 / 关键实体

以下是拟新增契约，不声称现有源码已有这些字段。公共对象仅 JSON 数据，schemaVersion 为整数 1。

```typescript
interface SessionContextConfig {
  enabled: boolean;
  cwd: string; // 空串沿用原控制台 workspace；非空为宿主绝对路径
  skillSources: Array<{ path: string; enabled: boolean }>;
  readRoots: Array<{ path: string; enabled: boolean }>;
}

interface SessionContextSaveRequest {
  expectedRevision: number; // 首次保存为 0
  config: SessionContextConfig; // 整组替换，不对数组逐项 patch
}
```

| 实体 | 存储/字段 | 约束与所有权 | 覆盖 |
|---|---|---|---|
| 保存记录 | `settings.sessionContext = {schemaVersion:1, revision, config, bindings}` | revision 由宿主递增；bindings 为 active cwd/资料根及 Skill 来源目录的 canonical path、dev/ino 字符串。客户端不能提交 bindings。文件型 Skill 绑定父目录，允许下次新会话读取同一路径的合法新正文；活动会话不重读。 | CFG-02/05 |
| owner 状态 | `sessionContext: {saved, health, active}` | `saved` 返回 revision/config；health 含字段/来源索引、checkedAt、valid/not_found/unreadable/invalid/conflict/disabled；active 为 null 或实际会话快照视图。`settings` 回显必须显式去掉内部 bindings/正文，不能任由现有 spread 泄漏新内部字段。 | CFG-01/02 |
| 不可变会话快照 | `{schemaVersion:1,sessionId,revision,platform,presetId,effectiveCwd,cwdBinding,rootBindings,skills,issues,createdAt}` | cwdBinding 固定最终 native cwd 的目录身份；skills 含 name/description、规范文件来源、原始文件 sourceHash、去 frontmatter 后正文 contentHash（均 SHA-256）、正文与 invocation；roots 生成会话内稳定 `root-1` 等别名；全部深拷贝/冻结。目录绑定和启停列表都不从后来 settings 取。 | CFG-02～04 |
| 活动加载/读取状态 | 按 sessionId 的运行时观测 | discovered/available/loaded/unavailable 与 capability limitation 分开；记录加载 hash、rootId、相对路径、字节数、错误码，不记录资料正文到公共状态。 | CFG-01/03/04 |

旧文件没有新字段时默认不启用，不在启动时迁移/扫描目录；原声音、env 默认、查询及未知旧字段保留。未知 schemaVersion 或损坏的新子记录保留原始持久值并显示 `invalid`，阻止将该记录用于新会话；不能像查询开关一样悄悄回退成有效空配置。owner 显式替换、清空或关闭后才能恢复。仅新字段的解码做有界 shape/depth/字符串长度校验，不顺带重做整个旧 settings 格式。

快照持久化为 `${dataDir}/session-context/<host-generated-sessionId>.json`，只包含上述固定输入/正文，不保存资料文件内容。写入沿用 0600 独占同目录临时文件 + rename，目录 0700；禁止符号链接文件/父目录、目录别名及非宿主生成的文件名。单条 JSON 最多 2 MiB、解码深度最多 16、目录最多 128 条且总量最多 128 MiB；满额拒绝新建并提示 owner，由后续有界维护处理，不自动删除仍可能使用的会话记录或新增清理后台。重启/手动打开原会话按 id 恢复原定义，不用最新 settings 替换；快照缺失、编码/JSON/版本/绑定不合法则两个新增能力不可用。恢复快照不自动启动 turn/开播或重放旧回答。路径再次校验是有效性重查，不改变快照授权。

#### API / 接口契约

##### 保存、状态与创建

- `POST settings` 在既有 patch 增加 `sessionContext: SessionContextSaveRequest`，请求总量沿用 `controlBody()` 的 64 KiB。只接受完整 config、准确类型/已知字段；列表各最多 8 项、单路径最多 4096 字符，拒绝 NUL/控制符/孤立 surrogate、URI、相对路径和隐式 `~`/环境变量展开。空 cwd 合法；列表空 path 非法。schema/路径/声明错误 400，revision 冲突 409，持久化失败 500。返回遵循 `{ok:false,error}`，可附 `{code,field,issues}`；无原生错误文本。一次保存任一项失败，磁盘/内存/revision/活动快照/旧设置副作用均不变。
- 同一规范文件/目录来源和资料根以 realpath 及对象身份去重；重复同一项不增加加载。重复项启停不一致返回可修正冲突。不同规范 Skill 文件同名则整个保存拒绝；不按原生 rank 静默覆盖。目录重叠去重到同一 Markdown 后仍只加载一次；不扩大资料根到公共祖先。
- `enabled:false` 或单项关闭仅做结构校验，保留合法路径文本、不读取磁盘、不加载。允许 owner 关闭已失效项；状态显示“已关闭，未检查”。启用项按下文 IO 规则验证，空容器/缺 SKILL.md 为 `not_found`，无效声明不是成功的空 Skill。
- GET `state` 继续 owner-only/no-store，增加上表 sessionContext 视图。启动时、保存前、新会话准备时重查；owner `POST /session-context/recheck` 提供不保存、不创建会话的显式重查，最多每秒一次、单在途，state 轮询只读取最近检查结果。实际工具访问始终重查路径，不依赖 UI 健康缓存。移动/删除后 owner 可点重查得到失效项，旧活动定义仍为旧 hash，资料失效则返回 unavailable。
- `POST /sessions` 输入仅 `{workspaceId?: string}`，由已认证控制台在显式新会话动作中调用；不接收配置、目录、preset、脚本或权限。路由按捕获配置从当前平台选择 `dsh-livestream` 或 `dsh-livestream-douyin`，生成全新 SessionId 并准备快照。有效显式 cwd 时仅传 `{sessionId,cwd,agentPreset}` 给 native create；cwd 空/整体关闭时使用控制台原第一个 workspace 的 `{sessionId,workspaceId,agentPreset}`，先由宿主验证 workspace 存在、实际目录有效。不能将显式 cwd 挂到旧 workspace。成功后核对返回 id/preset、Agent 的 header.cwd 与 effective workingDirectory，绑定工具/快照，再返回 `{ok:true,sessionId,sessionContext:<snapshot view>}`。
- native API 可能改变参数行为/返回另一个 id；本条拒绝复用、拒绝不匹配结果，不事后改旧 header。若宿主缺少公开 create/必要服务或验证失败，返回 503/409，不回退旧创建路径。平台在准备途中变化则拒绝该次入场，不隐式开始错误平台。未完成原生会话若已落盘，只留为未开播空会话并报告，不删除或取消其他会话。
- `createBrainSession()` 仅 live 主线在 `saved != null` 时使用新 `/sessions`；完成命名可保留 `sessions.using()`，不再对该新会话二次 preset.select。游戏线和完全未使用新设置的安装保持旧路径。管理路径在 `goLive()` 中先完成会话校验/创建，之后才进入已明确要求的 broadcast/onair，避免无效 cwd 先触发推流。`/onair` 对管理会话验证绑定 ready、平台与 native cwd 后才调用 `show.goLive()`，不重新从 settings 生成快照；保存、重查、创建会话本身均不调用 onair。

##### 目录、Skill 与实际读取验证

1. 保存时：有启用配置才做 IO；cwd/资料根必须存在且为可遍历、可读目录（R_OK + X_OK），不 mkdir、不修权限。规范化为 realpath 并建立目录 dev/ino 绑定；owner 显式选择的根级 symlink 可解析为其规范目标并在 UI 显示，之后授权只记该目标，不追随原链接未来的重新指向。配置中的非空 cwd 失效时，必须修正/清空/关闭后才能新建，不回退 home/其他 workspace。
2. 启用来源：必须是可读普通 `.md` 或已授权的可读目录；有界发现，逐个做严格解码/语法/重名检查。目录内 symlink 和非普通文件不跟随；候选 Markdown 指向外部则拒绝来源，不默默当成“未发现”。不将来源目录本身授权给资料工具。
3. 创建时：重新检查保存的规范路径/目录身份，不接受被替换成 symlink 或不同 inode 的根。cwd 失效阻止创建；已失效 Skill/资料条目标记 unavailable，保留原别名/问题，可用条目仍可组成新会话，不扩展来源。重新读取造成新同名冲突、预算超限或无法获得一致完整快照时拒绝创建。下一会话可取得合法更新后的 Skill 正文；既有会话的定义不变。
4. 资料读取：模型只提交 snapshot.rootId 和该根的相对 path。拒绝绝对路径（含本机/Windows/UNC/URI 形式）、`..` 路径段、NUL/控制符、非法 rootId、目录与特殊文件；不做 URL decode 或通配展开。`cwd` 内未同时授权的文件仍拒绝。
5. 先做词法 containment，再校验保存根身份和目标 realpath 的分隔符边界；逐段 lstat 拒绝后续 symlink（即使链接仍在根内，也采用这个更小的首版语义）。用只读 `open` + `O_NOFOLLOW` 打开终端普通文件，对 fd.fstat 与已验证目标 dev/ino 比对，**匹配后才读取**；在打开前后和缓冲读取结束后复核根/祖先/规范目标身份与范围。发现重定向、替换或取消立即丢弃缓冲，绝不返回部分越界字节。不能只 `startsWith(root)`、只在保存时 realpath、或先 readFile 再检测。相同 helper 供来源 Markdown 和资料使用，各自传入独立授权范围。
6. 读出文件失效/替换/不可读为 unavailable；越界/symlink 为 denied；所有拒绝不返回正文、绝对路径、stack。原生 API 自身可能 mkdir，验证与调用间目录消失仍使该次创建失败并禁止 onair，不把 native 的创建结果当成有效已选目录；不宣称这是可隔离任意本机恶意进程的内核 sandbox。

##### 预算与拒绝语义

预算是本 Feature 的工程默认值，不是新增产品 SLA；超限明确失败，不通过自动重试、截断 Skill 或扩大目录解决。

| 操作 | 固定预算 | 超限行为 |
|---|---|---|
| 保存/创建的 Skill 发现 | 启用来源最多 8；每源最多检查 128 个直接条目、最多一级子目录；最终最多 16 份唯一 Skill | 整体拒绝，指出来源索引与预算，不忽略超额项 |
| Markdown 解析 | 每份原始 UTF-8 最多 64 KiB，frontmatter 最多 8 KiB；全部 Skill 原始字节合计最多 256 KiB；扫描/验证整体 5 秒、单在途 | `LIMIT_EXCEEDED`/`UNAVAILABLE`，不保存部分候选；创建失败不替换活动会话 |
| Skill loader | 仅返回快照中单份完整正文；每 turn 最多 4 次调用、合计最多 128 KiB 正文字节 | `LIMIT_EXCEEDED`，相同 name 在一 turn 重复不重复注入；无磁盘重读 |
| 资料文件 | 仅普通 UTF-8 文本，原始文件最多 256 KiB；拒绝二进制/NUL、目录/设备/FIFO/socket；不读取图像/音视频/PDF | `UNSUPPORTED` 或 `LIMIT_EXCEEDED`，零正文 |
| 资料读取请求 | startLine 默认 1，maxLines 默认 80、范围 1～200；返回最多 16 KiB UTF-8，带 relativePath/rootId/实际行号和内容 hash | 请求行段超过输出上限则拒绝并提示缩小行段，不默默截断；不存在行段返回 empty |
| 每 turn 的资料读取 | 最多 4 次尝试；实际读取缓冲累计最多 512 KiB、返回正文累计最多 32 KiB；每会话最多一个在途读取；单次 2 秒 | 尝试/字节预算先保留再执行；超额、busy、timeout/cancelled 均零正文，失败不无限重试 |

turn 标识使用真实 native agent/turn，不采纳工具参数或文本中的 turn。计数是执行限制，不是新的调度系统；在途读取持有原 snapshot，后来保存/删除不变更其授权。IO 成本按实际文件缓冲计费而非返回片段；取消/超时后晚到缓冲不回传。JSON/YAML 的大小、深度与 UTF-8 错误只在本条实际编码边界处理。不能依赖 `Promise.race` 后仍把文件操作结果交回。

两个工具只对已绑定且启用、对应项可用的 Agent scope 暴露。管理快照在 native create 前已落盘；在原 live preset 内注册并等待串行 `agent/created` listener，按原 sessionId 恢复及核查该快照、安装限制和两个窄工具，然后才能完成 native 创建/恢复。安装或管理快照验证失败须抛出受控错误，使宿主回滚该 Agent 的创建/恢复；真实缺失快照的 legacy 路径保留。该入口同时覆盖新建与 native resume，不依赖先 onair，也不在 `agent/pre-step` 首次安装权限：安装版已证明 pre-step 前先解析 toolset。pre-step 只保留已安装状态检查、turn 预算与 manifest 注入；失败时拒绝该步，不能用它补救已发出的模型或工具执行。preset 共用 revision 不能保存单个会话的授权或正文；Agent 卸载时只释放它自己的工具 disposer/计数。manifest 在 `agent/pre-step` 的 `PreStepDecision.messages` 以插件自己的 context source 注入，列出可加载的 Skill name/description、资料 rootId、能力限制与已选 cwd 的逻辑说明；不含绝对路径，也不冒充 owner/user 消息。不用普通 systemPrompt.section 注入，因为当前 persona.complete 会隐藏该 section；实际 loader 的 output.render 则把冻结正文交给 native 模型消息链。结果使用单一 schema 的 `available/loaded/empty/unavailable/denied/unsupported/busy/timeout/cancelled/limit_exceeded`，owner 诊断单独记录实际来源/hash。`loaded` 与 capability limitation 可同时存在。模型回复中已知配置路径及其用户输入别名须在 `agent.ts` 现有 assistant → `show.say`/字幕输出前脱敏；工具错误始终是受控文案。Skill/资料正文不进入 `/events` 或 Stage 配置广播，owner 可在原生会话核对内容；增加含恶意路径回声的输出验证。

#### 时序与数据流

1. owner 编辑草稿 → POST settings → 全部结构/IO/Skill 校验 → 比较 expectedRevision → 原子写盘 → 同步发布新保存记录。之前任一步失败均保留最近成功值。
2. 控制台显式新会话 → POST sessions **同步捕获完整已保存版本** → 有界重查/读取 Markdown → 将冻结快照以生成的 sessionId 原子落盘 → native `sessionController.create()` → 校验实际 cwd/preset、绑定自身工具 → 返回。预备快照不是活动快照，不可被 `/state.active` 误报为已开播。
3. 控制台后续显式 onair → 核对该 sessionId 的 ready 绑定 → show 使用同一快照。活动视图从 `show.currentSession` 对应快照派生，不能从最新 settings 推导。原活动 A 保存 B 或另建未入场 C 均不改变 A。
4. Agent 实际调用 loader → 只返回该 session 的冻结定义并记加载 hash；实际调用资料工具 → 独立根校验/预算/fd 读取并记证据。加载不能证明读取，工具 schema/catalog 不能证明正文进模型。
5. 重启 → 恢复保存记录及健康检查，不恢复播出。`resumeLive()` 在 resolve Agent、连接、stage 输出/adopt 之前，若 saved live 的 sessionId 有本条快照或当前已有 sessionContext 记录，则跳过自动恢复，并向 owner 显示“已恢复设置，请手动开始新会话”。未使用新增配置的 legacy 安装保持原分支。手动打开旧会话只恢复其快照，失效资料如实拒绝，不补发旧回答。

保存与创建的同步发布/捕获点足以解释 A/B 重叠，不建立跨服务事务；快照落盘与 native 创建不是同一个事务，失败最多留下可诊断的预备记录/空会话，不能留下可用的无快照授权。权限执行始终以 ready 绑定为必要条件。本文以有序说明表达时序，本轮未做运行或图形渲染。

#### 横切质量设计

- 管理接口沿用 owner-only exact fetch/no-store；Stage token 不赋予管理权限，不能通过 Stage 或模型工具修改 config。路径明细、来源错误与 JSON 内部字段只留 owner；终端/日志不打印凭据或正文。
- 在启动及显式重查重新验证目录，不安装 watchers、不扫描 home/global/cwd 默认 Skill；不因根失效改为父目录。配置关闭/删除不删除磁盘文件，也不撤换活动快照。
- shared DTO 是跨浏览器/宿主的唯一 schema；宿主内部使用 fs 绑定/快照对象，浏览器只提交 config 和 revision。snapshot schemaVersion 与 settings 新字段兼容处理明确，不给已有 SessionHeader 增加私有必填字段。
- UI 状态用文字与 `aria-live`，保存 busy 防重复提交和误关闭；输入保持 label/id、列表增删键盘可操作、错误关联具体项，375px 不横向溢出。已有声音草稿/凭据状态不因 session 配置轮询被重置。

#### 风险与取舍

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 原生目录 ensure 与外部文件变动 | 选中目录可能在校验后失效 | native 前/后核对绑定与 header，失败不上播；不声称 Node 路径检查是内核级隔离 |
| 非标准宿主全局 loader/默认扫描或额外能力 | 可能读取未选 Skill 或扩大工具集 | loader entry 预检、每步检查、自身 scope 限制；不支持时拒绝，不改共享宿主配置；用真实 extra-global 组合测试 |
| snapshot 与 native 创建跨文件边界 | 失败后可能有预备记录/空会话 | 原子写快照优先、ready 才开放工具、上播独立校验；不删除未知会话，重启不自动恢复 |
| YAML 文本/私有路径进入会话 | 可发生提示注入或路径回声 | 只有受限工具、显式 capability、Markdown/引用不执行；owner 诊断与公共输出分开并测脱敏 |
| 既有验收固定 preset 工具清单 | 新能力可能破坏无配置行为 | 新工具在 Agent 自身 scope 按快照注册；无配置原清单不变，禁止简单放宽所有测试 allowlist |

#### 需求覆盖

下表是唯一紧凑“验收 → 设计 → Task → 验证”映射；其余章节引用，不另行定义产品规则。

| 规则 / 验收 | 设计 / 契约 | Task | 计划验证 |
|---|---|---|---|
| CFG-01、SCN-01/03/07 | owner 路由、DTO/状态、真实 loader 观测、公共输出脱敏 | FEAT-006-T001 | owner/non-owner/未认证 API；Drawer 草稿/错误/空态；观众/Skill 指令不能保存或扩权 |
| CFG-02、SCN-01/04～06 | settings 原子提交、revision、同步捕获、持久不可变快照、restart 分支 | FEAT-006-T001 | rename/写失败注入；A/B 保存创建双向延迟交错；清空/关闭/删除；重启和 cold 手动打开；实际 header/effective cwd |
| CFG-03、SCN-02/03/05/07 | 显式有界 parser、冲突去重、冻结正文、scope 工具与宿主预检 | FEAT-006-T001 | Papermorph 实际文件/hash 到 native 工具结果/模型输入；修改/删除正文后 A 仍用旧定义、B 重查；无默认/global 扫描；缺执行能力 |
| CFG-04、SCN-02/04/06 | rootId、独立目录绑定、fd/realpath 检查、读取预算 | FEAT-006-T001 | 真文件允许/拒绝内容独立断言；cwd 未授权、绝对/相对越界、symlink/祖先替换、失效、预算/取消/二进制 |
| CFG-05、SCN-05/07 | 字段缺省兼容、关闭/删除时机、既有平台/查询保留 | FEAT-006-T001 | 无配置、显式关闭、B 站/抖音/彩排/游戏线；声音/查询/房间配置回归和实际 toolset |
| SC-001/002、SCN-01～07 | 控制台 → 新 owner 路由 → native create → 实际工具执行 | FEAT-006-T001 | tester-army/e2e 已提交旅程 + 独立原生入口证据；不能以配置回显、schema、工具卡或手工构造 Agent 抵扣 |

##### 正式评审后实施约束（2026-11-12，R1～R8）

沿用 CFG-01～05 和既定预算，不新增产品范围。具体修正以本文件正式 Sol Review 的 R1～R8 为依据；以下明确本轮共享状态与输出合同，供同一实现者完整执行：

- 资料与 Skill 的读取校验共享一致的路径身份规则；根、所有祖先段和末端须在打开前后及读后核对，移动祖先并以 symlink 换回、保留末端 inode 不能使正文越界返回。取消/内部 deadline 在每个异步读取或复核后及返回提交前生效，任何晚到正文丢弃；busy 保持到真实 IO 及收尾完成。
- 保存记录 invalid 与没有新增配置的 legacy 是不同状态；真实开始回调必须在任何 native/preset/broadcast/onair 副作用前拒绝 invalid，按钮禁用仅作补充。保存后的 Skill 发现只消费保存的 canonical 文件/目录与身份，原始别名只供 owner 回显/脱敏，不在创建时重新决定来源。
- 资料每 turn 实际缓冲 512 KiB、输出正文 32 KiB、单文件 256 KiB/2 秒的限制不变。IO 前预留或限制剩余额度，已读字节即计费，失败/取消不得免单；达到预算后新增 FileHandle.read 字节为零，返回行段小不能减少原始缓冲计费。真实在途操作跨 turn 收束时不提前解除 busy，结算归属原 turn，不能污染新 turn 的预算。
- 区分会话历史 Skill 加载状态与本 turn 已输出正文集合。同 turn 同名首次成功才输出一份冻结正文，重复请求只返回明确“本轮已加载”的无正文提示；新 turn 若再次明确请求，可以返回同一冻结正文并重新计入该 turn 的 128 KiB。调用次数仍最多 4 次，实际工具结果/模型消息中的正文字节必须计量，不能只在唯一名称上计费。沿用既有对外状态值，可有界扩展内部结果字段以表达重复而非伪造新的正文。
- owner 的 active 以实际开播状态和当前直播会话 id 选择；仅创建/恢复/准备其他快照不能改变它，下播显示无活动会话。持久快照与按 id 的绑定继续保留，不以 Map 最早/最新登记项代替当前直播。先前宿主探针在尚未 onair 时把准备快照当活动的断言不满足本契约，需改为开播前 active=null、显式 onair 后才对应当前 id；这不改变原生首个 toolset 必须早于 onair 的要求。
- 每个启用 Skill 来源须实际发现有效声明；空目录、仅 references/scripts 或缺 SKILL.md 应为 not_found，而同一 canonical 声明的合法重复来源应去重成功。来源在创建时后续失效按既有 unavailable/拒绝合同处理，不能扩大授权或误报 valid。

写入范围在原 T001 基础上包括受 R2 直接影响的 `src/console/console.tsx`、相应真实组件/开始操作测试及必要的现有 session-context E2E fixture；不得旁及课程实现。N1 无生产用途的重复 helper/集合可在实际调用证据明确且测试迁移到真实 helper 时一并清理，不为此扩成新任务。原权限早绑定、身份核对、失败锁定、快照完整性和双 preset 合同继续保留。此前诊断和失败历史不重置。

##### 固定 canonical 授权与来源合并约束（2026-11-12，R9～R11/R8 残余）

以下由主 Agent 根据新复审源码和受控证据明确，是原 CFG-01～04 和现有预算的落实，不增加产品范围或持久化版本：

- **授权根不动态重定义**：DirectoryBinding.path 是绑定/保存时已经规范化的 canonical 授权边界。合法用户别名（包括 macOS 系统别名）在首次绑定时规范化一次；读取/恢复/重查不得再把当前 realpath 的新目标当作原授权根。即使 root 和末端 inode 保持，根之上的祖先被移动并以 symlink 换回、造成 canonical 目标偏离保存值，也必须零正文拒绝。整链读取前后和读后复核都对固定边界；内部测试不得以未规范化 raw path 冒充 canonical binding 来迫使放宽检查。不引入新快照格式来代替现有 path 合同。
- **来源原子发现与统一合并**：每个来源先独立得到完整成功的声明集合或明确失败结果，失败不能部分修改全局声明、seen 路径/名称或总量。保存、按已存 canonical bindings 创建及健康重查复用一致的发现规则，避免单文件/目录分支各自维护不同语义。全局按 canonical 来源身份去重，并维护名称到来源身份映射；同名不同 canonical 文件为硬 conflict（含单文件/目录的两种顺序），同 canonical 的合法重复不额外加载/计费，不能仅按名称丢弃异源声明。
- **所有出口保持同一预算**：单份原始 Markdown 64 KiB、全部 canonical 唯一定义的原始字节 256 KiB、最终最多 16 份、发现整体 5 秒等现有上限不变。文件 read/parse 的 limit_exceeded、来源内/来源间冲突及整体预算超限都整体拒绝，native create 零调用；不能降级为普通 unavailable，也不能漏计失败分支留下的部分定义。合并后在转换/持久化快照之前对最终唯一集合的 raw 字节、名称及数量再次校验；原始字节计量包括 frontmatter，不以 body/hash 代替。同 canonical 的重复在已达 16 份等边界仍允许正常去重。仅缺失、不可读、绑定失效等既定可降级情形可记录 unavailable 并丢弃该来源整体结果；无效格式、冲突及硬预算错误不能静默保留部分候选。
- **健康状态是真实声明状态**：owner 重查从保存的 canonical 来源及身份执行有界发现/校验，不能只把存在的目录当 valid。删除声明、仅 references/scripts、缺 SKILL.md 应显示 not_found；合法重复来源保持 valid。重查只更新健康诊断，不写配置/revision/绑定，不重新指向原别名，不改变活动快照或已加载正文，不自动创建/开播。创建时后续缺失来源按既定 unavailable 语义反馈并保持范围，不误报 valid。

**逐条绑定与实际资源去重（2026-11-12，第六轮接收补充）**：来源条目的归属绑定与声明/授权资源去重是两件事。新保存记录为每个启用的 Skill 和资料根条目保留已有格式的 index + canonical path/dev/ino（文件型另含 file），即使两个条目指向同一 canonical 目标；现有 schemaVersion=1 和解码器支持该形状，不增加字段或迁移版本。发现合并只按实际已发现的 canonical 声明文件去重，不能把目录路径前缀视为整棵目录已被发现：直接含 SKILL.md 的目录来源不会发现更深的显式文件，后者仍应加入或触发同名异源 conflict。最终资料授权按已核对的 canonical 目录去重，不能因逐条绑定重复生成 rootId/授权。

健康检查按配置 index 查保存绑定并核对该固定目标，不再解析 raw alias；别名改指另一个已绑定来源也不能借用其状态。已有合法记录若因历史去重缺少某个 index 的绑定，无法安全恢复其保存目标，应明确 unavailable/not_found 并提示重新保存，创建时以同一诊断反馈缺失条目，绝不自动跟随 alias 补绑；仍有有效绑定的条目沿用既定可用/失效规则，不降级为 legacy。重查不改变 settings 字节、revision、bindings、活动或冻结正文。回归须覆盖重复单文件/目录/资料根、别名改指其他已绑定目标、旧记录缺绑定，以及目录先/文件先时更深显式 Skill 的独立名称和异源同名。

本轮写入继续原 T001 边界，以 sessionContextPaths/sessionContext 的现有读取与发现模块及相应测试为主；不要建立通用文件系统框架、第二套合并规则或扩大到课程。对应验收包括根之上祖先替换及合法首次规范化、异源同名混合顺序、超限/坏声明失败出口的最终快照及 native 零调用、删声明后的重查与创建。历史失败、诊断已用、外部预算和共享资源边界均保留。

##### 发现截止时间的统一传递与提交校验（2026-11-12，R12）

5秒是同一次Skill发现/校验操作的共享预算，不能按来源、候选或异步读取重新开始。保存候选、按保存绑定准备快照、声明健康重查分别在首次Skill发现前建立有限扫描上下文，使用单调时间判定截止并向候选发现/读取传递同一取消信号。候选循环、每次异步IO/钩子/身份复核后、解析合并前及成功发布前均核对；同步扫描阻塞事件循环时也不能仅依赖定时器触发，必须在恢复执行时检查时间。最后一个来源/文件的迟到结果与中途超时同样整体limit_exceeded，不能转换成missing/unreadable、局部成功或valid。

调用方保留同一扫描上下文至本次验证结果发布：保存不得覆盖旧配置/revision；准备不得持久化迟到快照或进入native create；健康超时以受控不可用/超时诊断报告，不沿用本轮已过期的valid结果。若提交前存在额外异步绑定/身份核对，也必须在其后再次核对同一截止时间。未启用Skill时保持既有无扫描分支，不把预算扩大到课程、查询或其他业务。

取消只能协作停止后续IO与丢弃晚到缓冲，不能声称强制中断已经发出的系统文件读取。底层读取/close未收束时不得因Promise.race提前释放操作在途状态或泄漏fd/资源；收束后只发布失败，不能在后台追加定义或触发创建。无需修改持久化v1/schema/public工具DTO。回归覆盖单来源、末来源末文件，目录与单文件绑定，save/prepare/recheck三个入口的期限内正例与期限外拒绝，真实native调用点计数为0（替身须注明），旧settings/revision/active/冻结快照不变；超时后新一次正常操作可恢复。复用评审原始探针和现有FileHandle/受控时钟测试机制，不再启动主Agent诊断或构造通用扫描框架。

### 实施计划

**关联产品上下文**：REQ-010；**关联设计**：上文；**已确认需求**：仅 REQ-010 的 confirmed 来源及 CFG/SCN/SC；**创建日期**：2026-11-11；**状态**：Draft。

#### 背景

本条是单一 owner 配置与新直播会话故事，新增路径校验、持久快照、两个受限工具和局部表单。契约多于一般局部 UI 修改，因此本文展开并发、冷恢复、目录与解析预算；没有引入通用文件服务/Skill 分发框架。

#### 目标 / 非目标

目标：完成上述需求覆盖表，交付能从原控制台保存并实际使用的最小旅程，保留无配置安装与现有权限。非目标沿用 REQ-010 范围外；不实现课程播放器/互动、推流修复、脚本执行、自动安装、通用文件浏览或新导航。不修改 upstream 或共享 Harness/Stage/DyHub/yovoice。

#### 技术栈

TypeScript 严格模式、Node 22 目标、现有 React 18/dl CSS、Cordis/DSH `0.2.2-rc.1`、已有 yaml/esbuild/Vitest 3.2.4/jsdom、tester-army/e2e 0.23.0 / @e2e-dev/web 0.15.5；无新依赖或外部 provider。

#### 实施层决定

**一个完整 Task，串行集成。** settings、native 创建、Agent scope、UI 共同构成 CFG-02 和 SC-002 的结果；仅保存配置或仅增加表单不能独立满足故事。测试资产/验证不是另一个实现 Task。由同一实现者完成必要单测、集成、Web 资产、文档和修正；主 Agent 保留独立 Validate/Review 与 lifecycle 权限。当前 FEAT-004 的验证资源与运行产物不纳入本条证据或写入边界；实现接线开始前由主 Agent确认共享源码交付边界，不能并行覆盖同路径。

#### 风险 / 取舍

本条不调用模型/TTS/真实平台来填补静态证据。Plan 未证明 native 全套测试 fixture 已具备：现有 query fixture 虽有真实 AgentLoop，却用 `/__session` 和 `/__preset` 替身创建/选择，不能直接证明本条 native create；需在同一 Task 扩展为实际 SessionController + preset + workspace/session 持久化组合。环境缺口须如实报告，不能降级为手工构造 header 即通过。

#### 实施阶段

1. **最小旅程（FEAT-006-T001 内）**：先完成 DTO/校验、原子保存和真实新会话适配、最小 Drawer 字段、snapshot 绑定与两个工具及核心失败测试。最早可检查结果是：隔离副本的原控制台保存一个真实 Papermorph 文件/资料根，走 `/sessions` 的 native create，核对 header/workingDirectory 和实际 loader 正文/hash，再读取一个允许文件并拒绝一个越界文件；这时即可向主 Agent 报告版本/入口/实际范围，不等待所有回归，也不宣布 Task 完成。模型/TTS/开播预算均为 0；工具可通过真实 native executor 确定性调用，后续本地协议模型替身另证正文进入模型。**覆盖**：CFG-01～04、SCN-01～04、SC-002；设计：会话适配/受限加载。
2. **同 Task 完整边界**：补齐重启/关闭/删除/重复/冲突、并发原子性、路径替换、解析/读取预算、非标准宿主拒绝、公共输出脱敏、无配置与平台/查询回归。**覆盖**：需求覆盖表全部；设计：保存/快照/路径协议。
3. **同 Task 交付与检查**：完成已提交 e2e 资产、usage、隔离副本 check/build/coverage/E2E 和原生路径证据；实际失败与缺口写本文既有记录。**覆盖**：SC-001/002；设计：完整控制台旅程。

#### 验证策略（仅计划，本轮不执行）

所有命令在**另外的隔离复制目录**执行，保留有效 Git 基线、当前候选业务代码与固定依赖；不在当前 checkout 执行 build/test、不替换在用 `packages/dsh-livestream/lib`。依赖准备只能复用/复制已存在的相容安装或由主 Agent另行处理；本 Plan 不授权安装。副本使用自有 DSH_HOME、输入 fixture、artifact/report/cache 路径与动态 loopback 端口，拦截 3080/3081/7390/8757 和非 fixture 外网；不借用共享服务/真实 profile。只清理本次自有子进程和临时输入，保留失败证据。

**单元与契约**：新增 `test/sessionContext*.test.ts` 和必要 `.tsx` 表单测试，复用现有 runtime/host route/真实工具测试方式。覆盖结构/编码、YAML 冲突/alias/depth/超限、对象身份去重、同名异源、root 与 cwd 独立授权、symlink（终端/祖先）、根替换与受控延迟交换、fd 身份不符、特殊文件、文件增长、不可读、行段及实际字节预算、timeout/abort 晚到丢弃。不可读 fixture 应注入 IO 拒绝，不依赖当前运行用户的 chmod 特例。验证保存读/写/rename 失败保护原文件/唯一临时文件和内存、revision 竞争、未知旧字段/无配置兼容；用 barrier 控制保存 A/B 与创建顺序，不靠 sleep。snapshots 覆盖缺失/过大/损坏 JSON、错误 UTF-8/版本、目录 symlink/别名、容量耗尽和重启。不得为了达到覆盖率删除拒绝逻辑。

**E2E 资产选择**：新增 `e2e-session-context.config.ts` 与 `test/e2e-session-context/{start.mjs,server.ts,client.tsx,session-context.e2e.ts}`，复用 query fixture 的真实 React/路由/Stage、launcher 隔离模式，复用 `test/live-query/scenario.ts` 装载正式 `cordis.patch.yml` 的方式；以实际 SessionController 创建路径替换 `__session/__preset` 结果替身。本条 fixture 保留额外测试探针，核对真实 header/effective cwd、实际 tool result/hash、allow/deny 的文件正文/零返回、禁止工具/进程/依赖安装/资料写入计数为零，不将探针变成生产 API。身份测试经过真实 connection 的 owner/non-owner admission，不能只 mock handler 返回 403。为此补充所需已安装 DSH 模块的测试引用；若包内未声明测试所需模块，按现有版本固定开发声明并由主 Agent处理依赖准备，不能假定父级安装是可复现工程资产。

测试使用 Chromium 桌面 1440×900 与窄屏 375×812；workers=1、retries=0、每测试 120 秒、动作/断言各 5 秒、整次上限 10 分钟，显式 `cache:{mode:'read-only',strict:true}`。全程确定性 locator，无 `agent.*`、远端模型、GLM/TTS/B 站/抖音真实调用；协议模型替身只用本次动态本机端点。允许根和 Papermorph 输入在测试临时目录中准备固定内容/来源/hash；真实源验证另取本机已核实 Papermorph 文件，以 owner 明确选项只读使用，不替换合成 fixture 的身份范围。成功、失败、空态、保存 B/活动 A、关闭/清空/删除、重复/同名冲突、重启/失效、键盘/错误关联/窄屏和声音草稿共存均有确定性业务断言。保留 report/JUnit/trace/语义截图、fixture.log、脱敏 native/path 观测；截图不是实际读取证据。产物仅写该副本 `.e2e/feat-006-build/` 或 `feat-006-validate/`，launcher 写独立 `feat-006-*-fixture/`，不得复用 FEAT-004 路径/失败报告。

**原生 SC-002 证据**：隔离本机 Harness 发行组合使用实际 connection、SessionController、workspace、正式直播 preset 和原生 tool executor，从控制台创建管理会话。必须分别取得真实 cwd（header 与有效 workingDirectory）、源 Markdown SHA-256/实际加载正文、指定真实文件允许读取的正确内容、越界请求零内容、无脚本/安装/资料写入及无自动播出结果。测试 provider 替身能证明消息和工具接线，不能声称真实 GLM 作答；此需求允许不调用 GLM/TTS。若只能装载 fixture 的部分 Harness，而完整发行入口尚不可用，则 SC-002 保持未验证并向主 Agent报告，不能以配置回显替代。后续独立 Validate 对已提交候选重新运行，记录 candidate SHA、安装版本、环境/身份、步骤、结果与未覆盖范围。

**coverage/check/build**：现有 `vitest.config.ts` coverage include 为显式列表，须加入所有新生产源码/表单；将新 Web 测试目录加入 test.exclude，避免 Vitest 误收集。现有 checker 的最低变更行/分支为 **80%/70%**，不调整。固定本功能基线为 `fd48d0a5d9a18a3759428c3286f28480630eeb9a`，显式报告路径 `packages/dsh-livestream/coverage/feat-006-build/coverage-final.json`（正式独立验证用 `feat-006-validate/`）；禁止缺参或复用默认 feat-001 / FEAT-004 报告。起始 HEAD 相对基线仅多 SDLC 文档，收尾 HEAD 的相关生产源码仍未变化；不换成动态 HEAD。若实现前业务基线改变，由主 Agent 更新有效方案和基线归属，不能把别的 Feature 变更计成本条通过。

待执行入口取自 project.md 和实际源码的参数契约，本轮未运行，下列是副本中的计划调用：

```text
# 副本仓库根：覆盖率、类型检查和构建；DSH_HOME 必须预先设为本次独占临时目录
npm_config_manage_package_manager_versions=false pnpm --filter dsh-livestream exec vitest run --coverage --coverage.reportsDirectory=coverage/feat-006-build
node packages/dsh-livestream/test/coverage-diff.mjs fd48d0a5d9a18a3759428c3286f28480630eeb9a packages/dsh-livestream/coverage/feat-006-build/coverage-final.json
npm_config_manage_package_manager_versions=false pnpm --filter dsh-livestream check
npm_config_manage_package_manager_versions=false pnpm --filter dsh-livestream build

# 副本 packages/dsh-livestream：新增配置由 T001 完成后才可运行
npm_config_manage_package_manager_versions=false pnpm exec e2e run --config e2e-session-context.config.ts --workers 1 --retries 0 --trace on --reporter list,junit --max-duration 600000
```

无独立 lint/formatter 已确认入口；沿现有 TypeScript check/build 与正常可读排版，不引入工具链。上述新 config/目录为计划产物，Build 必须核对实际 runner/Vitest 参数和报告路径，不能把本段当已执行证据。

**usage**：修改根 README 唯一全局入口，增加稳定导航 `LIVE-SESSION-CONTEXT` / `LIVE-SKILL-LOAD` / `LIVE-MATERIAL-READ`，链接本故事/REQ-010 及既有详细本地操作指南；在 `examples/macos-yovoice/README.md` 补 owner/现有控制台入口、config 参数由 owner 与 shared schema 提供、空 cwd 默认、保存后新建、实际快照核对、Skill 缺能力、失效/冲突恢复和支持范围。不写个人实际路径或 secret。Validate 按文档在上述隔离代表性宿主操作一次，区分合成/provider 替身与真实本机文件/原生入口，记录未运行项。

#### 需求覆盖

实施阶段与 Task 的验收引用上文唯一需求覆盖表。项目 surface 涉及 shared-contracts、host-runtime-api、agent-and-core、console、tests/web-e2e、engineering-config-and-docs；验证组合为 correctness、e2e:Web、e2e:OpenAPI，Agent 实际工具/权限回归为确定性 eval-bench，不新增 benchmark 系统。正式独立评审检查架构/安全/客户端/服务端/QA 相关差异，模型路由与阶段独立性由主 Agent 管理。

### 工程任务

**输入**：上述设计/实施计划和 REQ-010；**前置**：主 Agent 接受候选并先登记 Feature 与完整 Task 集合，确认相同源码路径没有其他实现写者。测试随同一个实现 Task 完成，不拆给另一实现者。

#### FEAT-006-T001 [US1] 交付直播会话目录、Skill 与受限资料配置完整旅程

- **依赖**：无。选择单 Task 的理由是保存、native 创建、冻结正文、资料授权和 UI 共用 runtime/Agent 契约；拆成“后端/前端/测试”不能独立满足 SC-002，且制造同路径交接。阶段内增量见实施阶段 1。
- **写入范围**：包内路径均相对 `packages/dsh-livestream/`：`src/shared/sessionContext.ts`、`src/dsh/sessionContext*.ts`、`src/dsh/{runtime,index,agent}.ts`、`src/console/console.tsx` 及必要新 `SessionContextSettingsPanel.tsx`；必要的 `src/console/client.tsx` 类型接线；`test/sessionContext*.test.{ts,tsx}`、受影响既有测试、`test/e2e-session-context/**`、`e2e-session-context.config.ts`、`vitest.config.ts`。仓库根路径为 `README.md`、`examples/macos-yovoice/README.md`。测试所需已核实 DSH 开发模块缺声明时才补 `packages/dsh-livestream/package.json`/根 lockfile，不引入新版本或生产依赖。`.gitignore` 仅在现有 coverage/.e2e 忽略不能覆盖新路径时有界补充；保持 index/agent 同 chunk 共享状态。不得写 upstream、产品上下文、其他 Feature 工程候选、共享服务、真实设置/Skill/资料或已存在测试产物。
- **完成条件**：需求覆盖表全部实现；真实 native 创建与正文/读取证据具备；所有保存失败保护旧值，A/B 冻结和重启失效语义成立；无配置现有行为/工具和声音/查询/平台隔离通过；已提交 E2E、usage 和全部必要检查可重复；变更行/分支 80%/70%，check/build 通过；未授权配置/范围外内容/新增执行权限成功数为零。隔离副本证据不能宣称共享在用版本已更新，任务完成不代替独立 Validate/Review。
- **验证方式**：上文策略及命令，绑定实际候选 SHA、源码 diff、版本、环境、身份、输入来源/hash 和产物；新 native fixture 和权限检查不能跳过。失败先定位，遵循仓库连续两次不收敛停止规则，不在没有新证据时重复改同一契约。
- **覆盖**：REQ-010 全部 CFG/SCN/SC；**计划**：三个实施阶段，由同一实现者持续完成。

#### 依赖与执行顺序

唯一 Task 可在登记/交接满足后开始；没有并行实现单元。最早原生增量与完整边界都由 T001 负责，独立 Validate/Review 仍按原生命周期执行，不创建额外实现 Task 抵扣其必要检查。

#### 发布准备与回滚

只准备安装包和 schema 兼容说明；实际替换/重载共享插件由主 Agent 在后续 Ship 授权内协调，本 Plan/Build 验证不操作共享服务。现有构建会清空 lib，必须只在副本执行。回滚使用先前已评审业务版本和其构建产物，保留新 settings 字段/快照文件，不删除 owner 资料；旧版本不理解新能力时不能声称目录隔离或继续运行管理会话，应显式停止使用该会话并人工重建。是否恢复旧 B 站自动续播须在发布/回滚步骤核对，不能借回滚自动开播。产品观察只引用 REQ-010 的“首次保存、首次新会话、一次失败恢复”安排。

## 实现记录（实际）

- **状态**：尚未执行。仅新建本工程上下文候选；未运行任何 lifecycle 命令、测试、构建、依赖安装或 Git 写操作。
- **实际改动与 Task 引用**：FEAT-006-T001 为计划 ID，尚未登记。主要源码核实的起点为 `06c294a38f1c1dc8265b403bfd3ab501508c647e`；收尾读取 HEAD 为 `6f57866e552e5ae500f0dcfb6961e1267ed259f0`，相关源码无变化，入口/原生机制的只读命令见阶段返回 evidence。
- **工作区事实**：开始时仅 `.sdlc-v1/state.json` 已有他人修改；未读取其 diff 或据此写状态。收尾时并行工作已提交，工作区仅本候选文件未跟踪；本阶段只写了本文件。FEAT-004 的 coverage/.e2e/smoke/node_modules 变化不作为本条推论或证据。
- **经验召回边界**：decision-context 在主上下文只读有限检索，关键词为 DSH/skill-filesystem/readRoots/symlink，候选卡片关于规则链接、桌面分发和另一个 dsh-superagent 原型，不适用于本条 DSH 0.2.2-rc.1 会话/受限读取选型；结论 NO_MATCH。本轮未隔离召回，成本未知；只读输入二次 hash 未观察到变化，无知识库写入。决定依据仍为上表实际源码。

## 验证记录（实际）

- **状态**：尚未执行业务验证。Plan 只读核实不是 PASS；本轮没有启动浏览器、Harness、模型、TTS 或共享服务。
- **被测版本、环境、命令与结果**：none；上文命令仅为策略。源码/安装版机制为静态事实，所有 CFG/SCN 的运行结果仍待 T001 及独立 Validate。
- **覆盖与缺口**：native create/真实 cwd、实际加载/受限读取、宿主组合检查、UI、覆盖率与重启均无本轮运行证据；不以历史 Feature 报告填充。

## 评审记录（实际）

- **状态**：候选待主 Agent 接受；未做独立代码/架构评审。
- **范围、发现与处理**：本文明确 native registry 的 global 合并/动态正文、原生 fs 缺读取根限制、现有创建顺序和 B 站自动恢复，均纳入当前候选设计，不修改产品规则。

## 发布与观察记录（实际）

- **产品观察计划引用**：`.sdlc-v1/context/REQ-010.product.md` 的“发布后观察计划”。
- **技术发布准备、实际结果、反馈证据与缺口**：尚未发布；共享 3080/3081/7390/8757 和在用 lib 未操作。后续仅在实现/独立验证/评审满足后由主 Agent 处理发布与观察。

### T001 Build 记录（2026-11-11，执行环境：Claude Code 原生子代理 GLM-5.3-flash，非 Codex Terra）

同一实现者完成全部三个实施阶段；生产源码与测试写入严格限定在 T001 范围；主 Agent 保留独立 Validate/Review 与 lifecycle。被测对象为真实 checkout 工作树候选（实现期间 HEAD 为 ba24c85，生产源码相对固定基线 fd48d0a 的差异仅本 Feature）；隔离副本 /private/tmp/feat006-build/repo 逐文件 SHA-256 核对 178 个源/测试文件与 7 个配置/文档文件一致。依赖准备：既有 store 离线安装（ignored builds 非零但 369 包链接、imports 可解析，按既有先例记录为功能就绪）。

关键实现决定：(1) settings.sessionContext 沿用 runtime 原子提交；保存校验（结构→IO→发现/解析）完成后在同步临界区比较 expectedRevision 再 updateSettings，从当时最新 settings 合并 patch，不回写 await 前快照。(2) 文件型 Skill 来源绑定父目录并记录 file 字段，允许同路径新正文；同一规范来源/根去重到一份绑定。(3) 创建时缺源/不可读降级处理（issues 标记、可用条目仍组会话）；同名冲突与预算超限整体拒绝；cwd 失效阻止创建。(4) index.ts 不静态 import agent.ts——绑定入口经 runtime.sessionTools 运行时回调接线；静态依赖会使 dsh-tools→dsh-llm 进入宿主端 bundle（lib/index.js:848 顶层 `createRequire('../package.json')`），曾致声音/抖音 fixture APP_UNREACHABLE，已用 fd48d0a 基线 git-archive 对照副本定位并修复。(5) 平台工具注销/注册后经 refreshSessionToolRestrictions 以「先装新限制再释放旧限制」更新 allow 名单；名单只认名称与 `tools.get(name,agent)` definition 身份都匹配的 preset 记录。(6) manifest 经 agent/pre-step 的 PreStepDecision.messages 以插件 source 注入（每会话一次）；工具预算按真实 native turn 重置；公共输出在 show.say 前按快照 canonical 路径+owner 输入别名脱敏。无契约修改；README 与示例新增三个稳定锚点导航及「新直播会话」操作说明。

验证（隔离副本，实际命令全部 exit 0）：check、build（四 bundle、index/agent 共享 chunk）；vitest --coverage 85 文件 546 通过/8 跳过；coverage-diff 基线 fd48d0a：行 1387/1710（81.11%）、分支 603/813（74.17%）；e2e-session-context 4/4（fixture.log：native create 全部携带真实 cwd 与 agentPreset=dsh-livestream、无 workspaceId；sharedRequests=0/externalRequests=0）；三套既有回归 e2e.config 6/6、e2e-douyin 12/12、e2e-query 10/10。原生证据：真实 agentLoop.create + 真实 Session header cwd + workingDirectory 语义核对；冻结正文带 SHA-256；load/read 工具允许与拒绝（越界/绝对路径/未知根零内容）断言；A/B 冻结、预算、宿主组合拒绝、onair 核对、重启跳过自动恢复有测试；能力边界探针 executedScripts=0/installedDependencies=0/materialWrites=0/externalFetchByAgents=0。

**SC-002 发行组合缺口（如实保留，归属正式 Validate）**：fixture 内 sessionController 为忠实契约替身（互斥校验/显式 sessionId 不复用/mkdir/返回形状按 installed 0.2.2-rc.1 对照），会话创建走真实 agentLoop.create+真实 header，但未调用公开宿主方法 sessionController.create() 本体；agentPresets.mount 的正式 preset 装载路径未在该入口执行（preset 工具经根 ctx 装载）。原因：@deepseek-ai/dsh-api-session-controller 及其 inject 依赖不在 checkout 声明依赖、不在可用离线 store，未以配置回显抵扣。主 Agent 已裁定：由独立 Validate 使用已安装发行组合（工作区 ../node_modules 的 @deepseek-ai/*）补取证；owner/non-owner 真实 connection 准入同属该范围。真实本机 Papermorph 文件的同名异源冲突与受限读取已用合成 fixture 覆盖规则路径，真实源文件只读核验由 Validate 执行（主 Agent 已授权只读本地文件，无模型/TTS 消耗）；真实进程重启全旅程属发行组合验证范围。隔离副本证据不宣称共享在用 lib/服务已更新。主 Agent 接纳本 Build 结果并将 T001 标记 done（依据工程上下文完成条件及其 SC-002 兜底条款），未请求额外修正。

### 独立 Validate（2026-11-11，通过：合并 HEAD 全部必要检查通过，执行环境：Claude Code 原生子代理 GLM-5.3-flash）

绑定候选 04746f6bc0062eb8313e07f37be993768e9e3eee（分支 codex/macos-yovoice，工作树干净）。git archive 隔离副本 305 个跟踪文件逐字节核验后执行；依赖离线准备（ignored builds 非零按先例记录）。全部命令本轮实际执行：

1. typecheck exit 0；build exit 0（四 bundle，index/agent 共享 chunk 确认）。
2. 完整 Vitest+V8（DSH_HOME=/private/tmp/feat006-validate-home、排除 test/macosTts.test.ts——差额 1 文件 2 测试即该文件，84+1=85、544+2=546 精确吻合）exit 0：84 文件、544 通过、8 跳过；报告 coverage/feat-006-validate/。
3. coverage-diff 基线 fd48d0a exit 0：行 1387/1710（81.11%）、分支 603/813（74.17%）；副本无 git 历史，按既有方法映射报告到 $REPO 路径后从仓库根执行（副本 src 与 HEAD 逐字节一致已先行核验）。
4. e2e-session-context 4/4 exit 0（fixture.log：native create 携带真实 cwd+agentPreset，sharedRequests=0/externalRequests=0）；三套回归 e2e.config 6/6、e2e-douyin 12/12、e2e-query 10/10 全部 exit 0。
5. FEAT-004 原生入口在合并候选上复验：离线 exit 0（weather limited + search evidence）；真实入口单次运行 exit 0（两题 evidence、failureCode=null，第 2 题逐字原文 {"query":"OBS Studio许可证"}，预算 model 4/4、mcp 1/2、tts 0）；舞台/观众播放不在范围（tts:0）。
6. **SC-002 发行组合证据补齐（49/49 检查通过，smoke/readonly-tools/validate-feat-006/sc002-released-composition.json）**：以已安装发行组合（工作区 ../node_modules @deepseek-ai/* 0.2.2-rc.1，只读）组合真实 dsh-host-webserver（动态端口）+dsh-client-connection（真实 credentials-local/BrowserAuth）+真实 dsh-api-session-controller 及其全部 inject 依赖+候选副本 lib bundle+真实 agentPresets（cordis.patch.yml douyin preset 经 Loader builtins 装载）。取证：公开 sessionController.create() 真实调用（显式 sessionId/cwd/agentPreset → 真实 Session header cwd、workingDirectory 一致、workspaceId 互斥 RemoteError 拒绝）；未认证 401 / owner cookie 200（真实 /connect launch-token 交换）/ 非 owner principal 403 均为 installed 代码本体；经该入口创建的会话 load_livestream_skill 冻结正文与真实 Papermorph 源逐字一致、持久快照 sourceHash/contentHash 与真实文件/正文 SHA-256 吻合、read_livestream_material 允许读取真实 lever-lab 资料而相对/绝对/深层越界与未知 rootId 全拒且零内容、managed toolset 无脚本/安装/写入工具、外网请求 0；同名异源（.claude/skills/papermorph 2049B 与 config/papermorph/upstream/skill 12167B）整单保存拒绝、指定来源装载正确；agentPresets.mount 经 create 路径装载。组合边界如实保留：'/' 索引路由（dsh-host-frontend-static）未组合；loader.entries() 为空组合（真实 loader 服务、非完整插件清单）——不削弱已证链路。SC-002 判定：真实发行组合核心链路（公开 create、真实准入、冻结正文、受限读取、能力边界、preset 装载）已验证。

收尾：git status 无新增已跟踪修改（仅脱敏证据与忽略目录产物）；key 泄漏扫描 18 个文件 0 命中；无自启进程残留；共享服务零触碰；未播出。

### 正式 sdlc-review（2026-11-11，changes_requested，执行环境：Claude Code 原生子代理 GLM-5.3-flash）

独立评审绑定区间 fd48d0a..af3e9b66 中 FEAT-006 变更（主体 7e72c8c），全程只读、锚定已提交内容；FEAT-004 部分不重复评审，共享文件交互专项核查无回归。结论：**1 HIGH + 2 MEDIUM + 8 LOW**，主 Agent 已接纳并安排修正：

- **HIGH（必修）**：`src/dsh/sessionContext.ts` Skill 发现的 SKILL.md 分支（顶层与一级子目录）仅 existsSync 即 readFileSync 跟随读取，未 lstat 拒绝符号链接——直接 .md 分支有检查（201-206 行）而 SKILL.md 分支缺失，违反工程上下文「目录内 symlink 不跟随；候选 Markdown 指向外部则拒绝来源」硬规则。攻击面：来源目录内一层写权限的进程将 subdir/SKILL.md 换成指向源外文件的 symlink，合法 frontmatter 的外部文件正文可进入冻结快照并被 load_livestream_skill 注入模型上下文。
- **MEDIUM-1（必修）**：`src/dsh/agent.ts` 限制名单刷新用 restriction-aware 的 `tools.get(name, agent)` 计算 allow（installed dsh-tools 0.2.2-rc.1 对被限制排除的 global 工具 reads-as-absent，已对照 installed lib 核实），平台工具往返注销/重注册后新 allow 永久缺失；且 get 与 restrict 之间并发注销时 catch 静默不装限制（fail-open）。修复：allow 计算改用与限制无关的依据（preset 注册记录/registry 身份），catch 分支 fail-closed 并记录诊断。
- **MEDIUM-2（必修）**：持久快照恢复路径未实现——activeSessions 仅 createManagedSession 填充；重启后手动打开旧管理会话不恢复绑定/受限工具/限制名单，且 `verifyManagedOnair` 对未注册 sessionId 直接放行，磁盘有快照的管理会话以「非管理会话」身份通过 onair（跳过 cwd 复核、能力静默消失）。须实现契约「重启/手动打开原会话按 id 恢复原定义」：恢复时校验快照形状/深度/绑定合法性（762-784 行待实现校验），恢复后重装受限工具与限制名单、失效项标记 unavailable；onair 核对必须识别磁盘快照的会话（恢复后核验或拒绝并提示手动恢复）。
- **LOW（随本修正段一并修）**：writeSnapshot/readSnapshot 的 statSync 后判 isSymbolicLink 为死代码应改 lstatSync；decodeBindings 损坏宽松回退应整体转 invalid；保存失败注入测试的弱断言加固；A/B 交错测试按契约用 barrier 控制真实并发交错；面板第二个 legend 改为独立 fieldset；空 workspace 列表时创建前校验并给可修正提示；资料根 '/' 与 dataDir/settings 目录拒绝、$HOME 警告；bidi 控制字符补 U+202A/U+202B。
- 评审同时确认的安全/架构/服务端/客户端/QA 正面结论：读取防护链条（词法→根身份→逐段 lstat→O_NOFOLLOW→fd dev/ino→读后复核）对中间目录替换/fd 换绑/根替换/读中换根闭环；模型可见面无绝对路径；shared DTO 无 Node 反向依赖；线性化点实现正确；预算表全部落实；FEAT-004 交互零回归。SC-002 两项组合余项与模型遵循非确定性维持为运行期观察项。

主 Agent 处置：FEAT-006 回 Build 修正段（同一写入边界），修正后重新独立验证（合并 HEAD）与评审；FEAT-004 的 reviewed 状态与合并 Ship 安排顺延至修正后统一重建（CLI 规则：业务路径变化使既有验证失效，两个 Feature 在最终 HEAD 统一重建 validation/review 后一次发布）。

### 2026-11-11 修正段交接

用户在当前 Codex 会话授权继续完成现有交付。主 Agent 只读核对：分支 `codex/macos-yovoice`、HEAD `98e5bdf`，保留 10 个已修改源/测试文件与 2 个新增测试；原 T3 执行线程已 completed/settled，当前 Claude 进程无原 session 标识或该 session 打开的文件。原生子 Agent 无法从当前执行上下文恢复，因此以相同范围交接替代实现者，不启动并行写者。

原执行者最后证据：冷进程 onair 恢复与 active snapshot 检查通过，但公开 `resolveAgent` 返回 error，受限工具绑定/冻结 Skill/资料读取的四项断言失败；该证据尚不能区分夹具未恢复 native Agent 与实际装配缺陷。接手者先核实真实宿主打开/恢复会话路径与既有隔离取证脚本，再完成原 HIGH、两项 MEDIUM、八项 LOW 清单。保留原失败历史和非收敛规则的诊断额度；交接不重置 delivery segment，不用旧版本 PASS 代替当前修复验证。

实现路由为 T3 `claudeAgent` / `glm-5.3-flash[1M]` / `effort=xhigh`，只交付本 Task 的代码、必要验证与本工程记录；不创建子 Agent、不修改 state、不提交推送、不操作共享服务、真实模型/TTS/播出。主 Agent 接受后另行独立 Validate/Review。

本次 GLM 派发在任何工具/代码执行前失败：HTTP 429 / 1308，五小时额度耗尽，接口显示 2026-11-11 18:07:26 重置。用户随后明确批准临时使用 Codex Terra（xhigh）实现、Sol 独立评审与验收。失败任务已关闭并保留结果；只读探针成功，T3 请求模型 `gpt-6.1-terra`、`reasoningEffort=xhigh`，返回正确目标 root/branch/完整 HEAD 和 11 modified/2 untracked（其中新增 modified 为本交接正文）。执行模型单独字段 `executedModel` 未提供，探针自报 Terra/xhigh；未修改任何全局或项目模型配置。后续同范围实现以该临时授权接续，原失败历史和完成条件不变。

### 2026-11-11 Terra 修正段增量与交接（未完成）

临时授权执行环境为 Codex `gpt-6.1-terra` / `xhigh`；目标分支 `codex/macos-yovoice`、HEAD `98e5bdf99945967ff23a0be473a4435990e7b70d`，沿用之前失败与诊断历史。未变更 lifecycle、未提交或推送。原 WIP 保留。

最早本轮被测增量：`readSnapshot` 区分真实缺失和已存在的 symlink/非普通文件，后者拒绝 onair；同时用 `O_NOFOLLOW` 和打开后身份核对保护文件读取。`test/sessionContextRestore.test.ts` 增加 symlink 与目录的 onair 拒绝断言。隔离副本 `/private/tmp/feat006-terra-build/repo` 的恢复测试 9/9、六个定向测试文件 56/56、`pnpm run check` 均 exit 0；最初新增断言在修改前 2/2 失败（期望 invalid，实际 missing）。198 个 source/test/config 文件的目标与副本 SHA-256 一致，清单 `/private/tmp/feat006-terra-build/source-hashes.txt` 的 SHA-256 为 `27ca6a80efb3cf71a409dd308fe59677ab62b5a159490f3c983542446720341b`。其中限制首装失败测试的旧断言错误（成功且无限制），定向测试通过不证明 fail-closed。日志保留在同目录 `red.log`、`restore.log`、`focused.log`、`check.log`。

冷恢复最小实验：复制先前隔离数据至 `/private/tmp/feat006-terra-diagnosis/` 并仅增加错误打印，phase3 两次 exit 1；真实 RemoteError 是 `SessionQueryError: failed to project session ... Invalid input: expected object, received undefined`，发生在 `resolveAgent` 恢复 Agent 之前，仍未区分夹具投影注册/存储与发行组合缺陷，证据 `sc002/experiment-detail.log`。两个实验进程及动态监听端口已退出，无共享/外网请求。另对 installed 0.2.2-rc.1 源码核实 `dsh-agent-loop/lib/index.js` 的 `preStep()` 先 `tools.resolve` / prompt assemble 再触发 `agent/pre-step`，所以现有 WIP 在 pre-step 恢复及装限制过晚：本轮工具集早已决定，首次限制失败更可能保留危险 inherited globals。`agent/created` 文档声称串行 listener 在释放队列前完成，可供主 Agent 评估，但本次未验证其 preset 作用域/新建与恢复交错，不能作为完成方案。需主 Agent 据此调整有效接线方案及 fail-closed 契约后继续，同一修正段不重置失败历史或诊断额度。

未完成：首装及刷新失败的真正 fail-closed、限制 allow 名称与实际 definition 身份、真实冷 native reopen 和工具执行、恢复快照字段/绑定/body 完整性、Skill 发现读时防替换、所有 findings 的最终回归及 build/coverage/E2E/发行组合验证。禁止以本轮局部 PASS 代替以上检查或独立 Validate/Review。

### 主 Agent 有界诊断与有效方案修正（2026-11-11）

本修正段的一次主 Agent 诊断额度已使用：2026-11-11 07:42–07:50 UTC，预设上限 15 分钟，假设为原生投影器收到不完整的夹具依赖。只操作已有 `/private/tmp/feat006-terra-diagnosis/` 隔离数据、动态 loopback 端口与本地模型替身；未改业务源码、安装包、共享服务或真实资料。

1. `node --import /private/tmp/feat006-terra-diagnosis/sc002/register.mjs .../primary-probe-1.mjs phase3`，exit 1：用 `observeSession(...,{projectionMode:'none'})` 取同一持久事件，逐个原生投影验证。仅 `imageLimits` 的 wire view 为 undefined，其余五个 view 通过；其 schema 错误与 resolveAgent 原错误一致。证据 `primary-probe-1.log`。第一次调用漏传解析 hook 的启动错误未进入组合，补上现有 `--import` 后执行上述实验。
2. `primary-probe-2.mjs phase3`（同解析 hook），exit 0 / 15 checks：唯一依赖改动是把夹具的抽象 `dsh-attachment` 换成已安装的 `dsh-attachment-local`，配置 `{dshHome: HOME}`。imageLimits 恢复合法对象，原生 resolveAgent 返回 agent，原四项工具/正文/读取断言全部通过。安装源的 `session-controller` imageLimits 常量投影直接读取 attachments.imageLimits；抽象服务无该实际字段，因而已定位为夹具装配缺陷，不修改 DSH 上游或生产恢复路径来掩盖。证据 `primary-probe-2.log`。
3. `primary-probe-3.mjs phase3`（同解析 hook），exit 0 / 15 checks：在 live preset 的原 apply 上下文内注册纯观察 `agent/created` listener，实际收到 source=resume、匹配的原 sessionId，且 agent.ctx.tools.restrict 可用。恢复前原生 tool view 显示 own=[]、inherited=[weather_lookup,public_search,show_stats]，证明正常空 allow 会误删父 preset 工具。证据 `primary-probe-3.log`。安装版 agent-loop 在 setup/preset mount 后等待 agents.announce，随后才释放 maintenance；与 tools.resolve 早于 pre-step 的源码证据共同支持上文接线修正。

上述 exit 0 只证明诊断对照成立：旧脚本仍有手动 bind 兜底，不能作为生产早期权限安装或完整 Feature 验收。三个进程均结束，按脚本 dispose 并退出；未遗留本诊断命令进程。Build 必须把正确附件装配与无需手动 bind/onair 的冷恢复断言纳入可重复测试，覆盖 create/resume 首个实际 toolset 和安装失败回滚。按本文件当前有效方案向同一 Terra 执行者发送完整 supersedes brief，保留此前失败历史；若证据支持的恢复后再次触发非收敛停止，不再追加第二次主 Agent 诊断。

### 2026-11-11 额度故障与 GLM 恢复交接

Terra ordinal 3 最终因 `Your ChatGPT usage limit was reached` 失败，并非实现验收完成。主 Agent 调用 `task_cancel` 后返回 failed；随后线程状态为 failed、activeRunId=null、pendingRequestCount=0。本机未发现 FEAT-006 测试、构建或诊断进程；未停止共享服务。目标仍为 `codex/macos-yovoice`、HEAD `98e5bdf99945967ff23a0be473a4435990e7b70d`，原 11 modified / 2 untracked 保留。恢复期间主 Agent 只读核对源码和测试，没有进行业务代码修改或测试。

GLM 原错误明确报告本地 18:07:26 重置；18:19:46–18:20:30 的一次小型只读请求成功，确认目标 root、branch、完整 HEAD 与 13 个 dirty 文件。T3 返回 provider=`claudeAgent`、请求 model=`glm-5.3-flash[1M]`、options=`effort=xhigh`，但 executedModel=`glm-5.3-flash`；实际返回不含上下文后缀，`1M` 上下文容量未独立验证，不宣称所有实际配置已确认。后续委托继续显式请求规定的完整 model ID 和 effort，保留该元数据差异；不修改 provider 配置。

按用户最新 AGENTS 路由恢复首选 GLM 承担剩余实现及必要验证；Sol 继续负责复杂分析、独立评审与最终验收，Codex 这些职责不降级到 GLM。此次接替原因是原 Terra 执行者额度不可用；实现边界、验收清单、已有失败和一次诊断已使用的事实均不重置。现有局部 PASS 不能替代首装 fail-closed、preset-scoped 早绑定及无需手动 bind/onair 的真实冷 native reopen 证据；未改 lifecycle、未提交或推送。

### 2026-11-11 GLM 修正段实现与验证（T001 修正段， awaiting_acceptance）

执行环境为 T3 `claudeAgent` / 请求 `glm-5.3-flash[1M]` / `effort=xhigh`（executedModel 元数据沿用交接记录：返回不含上下文后缀，1M 容量未独立验证）。目标 `codex/macos-yovoice`、HEAD `98e5bdf9` 未变；收尾工作树为 14 modified + 2 untracked（新增 modified：`src/dsh/runtime.ts`、`src/dsh/sessionContextPaths.ts`、`test/sessionContextRead.test.ts`，均在原写入范围内）。无 lifecycle 变更、无 Git commit/push、无共享服务操作。

**被测对象与隔离副本**：`/private/tmp/feat006-glm-correction/repo`（含 .git 与既有 node_modules 的完整副本；排除 `.e2e/`、`coverage/`、`lib/` 后按 git 跟踪+未跟踪清单补齐）。311 个源/测试/配置文件逐文件 SHA-256 与目标工作树一致，清单 `/private/tmp/feat006-glm-correction/source-hashes.txt`（311 行）的清单哈希 `9ce9de857b05f894978483d85c7f3ff1277b04e8232978b86004f46c72dfb8ab`。build 只在该副本执行（删 lib 不影响在用共享 lib；共享 lib 时间戳核验未变）。依赖为既有安装，无新装。

**本轮新增实现（相对交接 WIP）**：

1. **preset-scoped 串行 `agent/created` 早绑定（MEDIUM-2 + 主 Agent 边界）**：`agent.ts` 新增 `handleAgentCreated`（在 `apply` 经 `ctx.on('agent/created')` 注册于 preset 上下文，原生创建/恢复在返回与首个工具集合解析前的串行等待点调用）：磁盘三态判定（真实 ENOENT → legacy 原样放行；存在但损坏/symlink/目录/超大 → 抛受控错误让原生回滚；恢复成功 → 恢复快照登记 + 安装继承限制与两个窄工具，全部在本次创建/恢复返回前完成）；`bindSessionContextTools` 只在早绑定入口调用并返回首装结果。`runtime.sessionTools` 由 `bind` 改为 `onCreated`/`verify` 两个回调（保持 index→agent 无静态依赖的 chunk 边界）；`index.ts` 创建路由改为 `verifySessionBinding` 核对（不补绑、不补装），未绑定返回 409。
2. **首装失败 fail-closed 抛错（主 Agent 边界 #5）**：`installSessionRestriction` 分 `initial`/`refresh` 双模式：首装失败返回 false → `handleAgentCreated` 抛受控错误 → 原生创建/恢复整体回滚，不再产生「绑定成功但无限制」的会话；fail-closed 标记在位时重复公告同样拒绝。
3. **刷新失败保留旧安全限制并取消工作（MEDIUM-1 收尾）**：refresh 模式失败保留旧限制层（不 lift）、卸下两个新增工具、`agent.cancel({kind:'user'})` 取消该会话当前工作并锁定不可用；先装新限制成功才释放旧限制（不变）。
4. **恢复三态与防幽灵**：`sessionContext.ts` 新增 `restoreManagedSnapshot`（none/snapshot/invalid；损坏不缓存成缺失，只缓存真实缺失）、`discardActiveSession`；`createManagedSession` 在 native 失败/返回 id 不一致/preset 不一致/cwd 核对失败路径丢弃恢复阶段登记的活动快照（预备快照文件保留可诊断）。
5. **评审 HIGH：发现到读取的替换防护**：`sessionContextPaths.ts` 新增 `readRegularFileNoFollowSync`（O_NOFOLLOW 打开 → fd 身份与 lstat 比对 → 有界读取 → 读后路径身份复核，ELOOP→symlink 拒绝、身份不符→零正文）；`discoverSource` 候选读取改用该 helper（读取前重新 lstat 建立身份），顶层/嵌套 SKILL.md 与直接 .md 分支全部覆盖。
6. **pre-step 重构（主 Agent 边界 #6）**：只做有效性/宿主组合核对（组合不满足返回 `{kind:'reject'}` 拒绝该步）、turn 预算重置与 manifest 注入；fail-closed 停用的会话不再广播能力清单；不再承担首次恢复/绑定（那是 agent/created 的职责）。
7. 平台工具往返刷新、公共输出脱敏、冻结正文、预算表、README/示例等既有 WIP 内容保持不变。

**测试（failing-first）**：先改测试后改源码——`sessionContextAgentRestrictions.test.ts` 首装失败旧断言（期望绑定成功）按新合同重写为「必须 rejects」；红状态实测 4 failed（`onCreated` 缺失/行为不符），实现后 28/28 绿。新增：首装失败回滚、legacy 会话不装限制、pre-step 组合拒绝/manifest 注入一次/fail-closed 不广播、`readRegularFileNoFollowSync` 六态（正常读取/symlink ELOOP/身份不符/预算/目录/缺失）；`sessionContextRestore.test.ts`/`sessionContextSessions.test.ts` 的假 native create 改为经 `sessionTools.onCreated` 驱动（与原生串行事件同序），恢复用例改为冷 resume 早绑定断言，新增无效快照 resume 拒绝与创建整体失败（503、无活动绑定）用例。

**验证命令与结果（隔离副本，全部 exit 0）**：

```text
pnpm run check                                          # tsc，exit 0
pnpm run build                                          # 四 bundle + 共享 chunk，exit 0；lib/index.js 零 dsh-tools/dsh-llm 引用（bundle 边界保持）
vitest run --coverage --coverage.reportsDirectory=coverage/feat-006-build
                                                        # 87 文件，576 通过 / 8 跳过，exit 0（DSH_HOME=/private/tmp/feat006-glm-correction/home）
node test/coverage-diff.mjs fd48d0a5d9a18a3759428c3286f28480630eeb9a packages/dsh-livestream/coverage/feat-006-build/coverage-final.json
                                                        # 副本内直接执行（副本含 .git）；exit 0：行 1786/2077（85.99%）、分支 823/1092（75.37%），阈值 80%/70%
e2e run --config e2e-session-context.config.ts --workers 1 --retries 0 --trace on --reporter list,junit --max-duration 600000
                                                        # 4/4 exit 0；fixture.log：native create 全部真实 cwd+agentPreset，sharedRequests=0/externalRequests=0
e2e run --config e2e.config.ts --workers 1 --retries 0      # 6/6 exit 0（声音/控制台回归）
e2e run --config e2e-douyin.config.ts --workers 1 --retries 0   # 12/12 exit 0
e2e run --config e2e-query.config.ts --workers 1 --retries 0    # 10/10 exit 0
```

会话上下文 E2E 与全部回归在收尾源码状态（哈希清单一致）上复跑通过；产物在副本 `packages/dsh-livestream/.e2e/feat-006-build/` 与 `coverage/feat-006-build/`。

**SC-002 发行组合取证（新增 owned 探针，无任何手动 bind/restore/onair 前置）**：`/private/tmp/feat006-glm-correction/sc002/sc002-correction.mjs`（三个独立进程，`node --import ./register.mjs <script> phaseN`；组合与上轮一致：真实安装 @deepseek-ai/* 0.2.2-rc.1 只读 + 副本 lib bundle + 真实 WebServer/client-connection/SessionController/AgentPresets（douyin preset 经 loader builtins 装载）+ `dsh-attachment-local {dshHome}` 修正装配；隔离 DSH_HOME、动态端口、共享端口与外网拦截、本机协议模型替身）：

- **phase1（21/21，exit 0）**：未认证 401 / owner cookie 200（真实 /connect launch-token 交换）/ 非 owner principal 403（真实 Peer + shared fetch handler）均为安装代码本体；注入 restrict 首装失败 → 公开 create 整体 503、注册表无该 agent、无活动绑定（原生回滚）；真实 create 后**返回即解析首个工具集合**＝[show_stats, load_livestream_skill, read_livestream_material]（两个窄工具在列、preset 常驻工具保留、根 scope 探针全局工具 probe_global_tool 被限制排除——限制在首个工具集合解析前已生效）；持久快照正文与真实文件逐字一致、sourceHash=真实文件 SHA-256；允许读取真实资料、越界拒绝零内容；真实 turn 落盘。
- **phase2（11/11，exit 0）**：新进程损坏快照 → `controller.resolveAgent` 冷恢复按其失败契约返回 `{error}`，错误信息为受控的「直播会话快照无法恢复…已拒绝本次会话创建/恢复」，注册表无 agent（不降级为未管理）；onair 409；还原后注入恢复首装失败 → resolveAgent 同样失败（「限制名单首次安装失败」），注册表无 agent。
- **phase3（17/17，exit 0）**：新进程 `resolveAgent` 冷打开（原生 resume，`agent/created` 串行点）→ **早于任何 onair/手动调用**核对首个工具集合：两个窄工具在列、probe_global_tool 被排除；`verifySessionBinding` 确认生产早绑定；冻结正文与真实文件一致；允许/拒绝读取；onair 200、owner 状态显示活动快照；legacy 直建会话（真实 ENOENT）不受限制（probe_global_tool 可见）、无窄工具；sharedRequests=0/externalRequests=0。

**环境变化说明（如实记录）**：工程上下文原引用的项目级 `.claude/skills/papermorph`（2049B）已在 2026-11-11 技能目录重组中移除（更名为 research-paper-reproduce）；发行组合探针改用当前真实存在的用户级 `/Users/mac/.claude/skills/papermorph/SKILL.md`（12167B，上游变体）作为真实 Skill 来源，仍为只读核验（不执行脚本、不安装依赖）；lever-lab 资料根路径未变。同名异源冲突规则路径由单测与既有 validate 证据覆盖。

**限制与边界**：模型为本机协议替身（预算 0，无真实 GLM/TTS/天气/搜索/账号/推流调用）；SessionController 组合为 `nativeOpen:false`（冷打开经其公开 `resolveAgent` 显式 resume 完成，原生 announce 串行点真实执行）；'/' 索引静态路由未组合（与上轮一致）；真实进程宿主重启未测（phase2/3 为独立新进程组合，覆盖冷恢复语义；完整宿主重启旅程属正式 Validate 范围）；共享 3080/3081/7390/8757 未触碰（fetch 钩子 0 请求）；探针进程均已退出，副本与 /private/tmp 产物保留可复验。

**最早实测增量**：failing-first 红状态（19:11，首装失败旧断言按新合同 4 failed）→ 源码实现后 28/28 绿（19:16）→ 隔离副本 check/build 绿（19:22）→ 发行组合 phase1 create 路径取证（首个工具集合 + 首装回滚）→ 冷恢复 phase3 取证。

**移交状态**：`stage: build`，`status: awaiting_acceptance`。artifacts.changed_files 为上列 14 modified + 2 untracked；evidence.commands 见本节；requested_transitions=[]，allowed_transitions=[]。主 Agent 将审阅 diff 与证据并另行安排独立 Validate/Sol Review；本记录不宣称 released/accepted。

### 2026-11-11 主 Agent 接收评估与同执行者修正

用户已授权完成当前具备实施条件的需求。FEAT-006 修正段尚未被主 Agent 接受，FEAT-007 继续等待其修正、独立验证和评审完成。独立 Sol/xhigh 只读专项评审绑定 HEAD `98e5bdf99945967ff23a0be473a4435990e7b70d` 的 14 modified + 2 untracked；源码、测试和配置与既有 311 项证据清单一致，唯一文档差异为追加实现交接。原有测试成功仅覆盖其实际场景，不抵扣本次发现或正式 Validate。

主 Agent 核对源码及当前有效方案后，接受以下问题为同一修正段的剩余工作；未进行新的故障实验，原失败历史与已经使用的唯一主 Agent 诊断机会均保留：

1. **HIGH，Skill 中间目录替换**：候选发现时检查子目录，但读取前仅重取末端文件身份；`O_NOFOLLOW` 不保护中间目录。须核对来源根、各路径段及发现时身份，目录在发现后被替换时拒绝，源外正文不得进入快照或 loader 结果。
2. **HIGH，每步宿主组合复核**：pre-step 目前读取创建时缓存的 `compositionForSession()`，未重新检查实际 loader。安全创建后启用不支持的全局组件，下一步须拒绝且不得调用后续 Skill 监听器；检查异常也不得继续。
3. **MEDIUM，刷新失败不可继续**：失败标记分支目前仍调用 `next()`，后续刷新还能清除标记但不恢复窄工具。刷新失败后须持续拒绝后续步骤、绑定持续非 ready；旧允许名称对应的 preset 工具消失并露出同名 global 时，该 global 执行次数须为零。真实发行组合的这一故障链尚未实测。
4. **MEDIUM，注册来源隔离**：模块级名称 Map 和按名称删除未保持 preset 实例归属，名单计算未核对保存的 definition。须按可信 owner/registration/definition 管理，A 卸载不得删除 B 的有效注册；真实双 preset 与同名 global 场景需断言。正常近 scope 覆盖远 scope，不能由此声称普通同名 global 已直接越权。
5. **MEDIUM，onair 绑定 ready**：现有核验只保证快照、平台和 cwd，未保证受限工具绑定。未恢复、恢复首装失败、刷新失败的管理会话均须返回 409，且不得调用 `show.goLive()`；创建/恢复失败的活动登记应撤销。onair 不能补绑或重新生成授权。
6. **MEDIUM，冻结正文完整性**：恢复仅检查哈希格式和正文上限，须核对正文非空及实际 `contentHash`。不匹配或空正文判 invalid，原生恢复回滚，不读取当前来源代替冻结正文。
7. **LOW，cwd 读写预算一致**：快照读取对 `effectiveCwd` 使用 512 字符，配置允许 4096。须保持同一合法路径预算，覆盖系统支持的长 cwd 保存、创建及冷恢复。

以上修正不改变产品范围或当前有效方案的权限、恢复与冻结语义。由原 GLM 实现者批量修正，并负责相应失败先行测试、真实安装版 registry/创建恢复组合、受影响回归及最终源码状态的必要检查。仅在自有隔离副本构建和测试；真实服务调用预算仍为零，共享服务、在用 `lib/`、真实课件与凭据保持原边界。仅主 Agent 经 lifecycle CLI 将 T001 恢复为 `in_progress`；实现者只返回所允许的状态请求。候选提交、独立 Validate/Review 和发布均尚未完成。

生命周期实际操作：CLI 拒绝 `done → in_progress` 且未写入；按其现行转换合同完成 `done → todo → in_progress`，中间重读 `next` 后继续选择 FEAT-006。该操作清除了 FEAT-006 的旧 validation/review/release 记录；历史证据保留在上述工程记录与 Git 中，不作为当前候选已通过证明。FEAT-004 状态不因本次操作变化，但仍须遵守两个 Feature 在最终业务 HEAD 统一重建验证/评审的既定决定。

### 2026-11-11 二轮修正实现与验证（同执行者，7 项逐条处置完成，awaiting_acceptance）

执行环境沿用 T3 `claudeAgent` / 请求 `glm-5.3-flash[1M]` / `effort=xhigh`（executedModel 元数据同前，1M 容量未验证）。HEAD `98e5bdf9` 未变；本轮收尾工作树 15 modified（含主 Agent 专属的 state.json，非本实现者写入）+ 2 untracked。无 lifecycle mutation、无 Git commit/push、无共享服务/在用 lib 操作、真实外部调用预算 0。

**被测对象与隔离副本**：`/private/tmp/feat006-glm-correction-2/repo`（311 个跟踪+未跟踪文件与目标工作树逐字节一致；收尾清单哈希 `58bdd063aec13ce470c658814d5d3b901d5434572a1927d64730d82c1ec12e81`）。check/build 只在副本执行（共享 lib 时间戳核验未变）。

**failing-first**：先写 11 个红测试并核实红因（hook 缺失/缓存读取/共享名称 Map/next 继续/onair 恢复/哈希不核对/512 限制），再实现后转绿；最终三套直接相关测试文件 46/46。

**7 项逐条处置**：

1. **HIGH 中间目录替换**：`sessionContextPaths.ts` 新增 `readDiscoveredSkill`——以发现时 lstat 的来源根（目录来源=容器、单文件来源=父目录）为锚，逐段核对根/各中间目录段/末端文件 dev/ino 身份，O_NOFOLLOW 打开 + fd 身份比对 + 有界读取 + 读后整条路径复核；`beforeRead/afterRead` 钩子供测试在「发现到读取」之间注入受控替换。`discoverSource` 改异步并经 `discoverSkills(config,{hooks})` 透传（生产不传钩子）。测试：sub 目录换成指来源外 symlink（同名异正文）→ 发现整体拒绝、源外正文零进入；容器根整体替换（新 inode + 埋入正文）→ identity_mismatch 拒绝。旧 `readRegularFileNoFollowSync` 不再使用（已移除引用）。
2. **HIGH 每步宿主组合复核**：pre-step 对管理会话每步真实调用 `checkHostComposition(agent.ctx.get('loader'))`，不再读创建时缓存（缓存仍供 owner 展示/绑定判定）；全局组件启用、加载中（fiber 未激活）或 loader 缺失（无法确认隔离）一律 `{kind:'reject'}` 且不调用 next（下游监听器不继续）。
3. **MEDIUM 刷新失败永久锁定**：新增 `refreshLockedSessions`；refresh 模式失败保留旧安全限制、卸下窄工具、`agent.cancel({kind:'user'})` 取消工作并**永久锁定**；pre-step 对锁定会话每步 reject 不调 next；`refreshSessionToolRestrictions` 跳过锁定会话（不清除标记、不回装、verify 持续非 ready）；标记仅随会话释放清理。
4. **MEDIUM 注册来源隔离**：模块级名称 Map 改为按 preset 插件实例的 `PresetBindingState.trustedTools`（`registerLiveTool` 记录本实例注册的 definition 对象，注销按对象身份删除）；`sessionOwnerStates` 记录会话归属实例，限制名单按 owner 实例的可信注册 ∩ `restrictableNames` 计算。单测假 registry 扩展为真实语义（global 层 + 双 preset scope + 近 scope 遮蔽 nearest-wins）：A 实例卸载后 B 实例同名的 allow/可见性不受影响；B 注销后刷新收缩、同名 global 不获准。
5. **MEDIUM onair 只核对**：`verifyManagedOnair(sessionId, binding?)` 重写——内存无快照时只读磁盘判定（真实 ENOENT → legacy 放行；存在但未恢复/损坏 → 409 可修正提示），**不再在此恢复**；快照在内存但 `binding.bound=false`（宿主经 `sessionTools.verify` 运行时回调传入，保持 index→agent 无静态依赖与 chunk 边界：lib/index.js 零 dsh-tools 引用）→ 409；ready 会话照旧核对平台/cwd。`handleAgentCreated` 绑定失败与绑定 effect 清理均 `discardActiveSession`（恢复期登记随原生回滚/会话释放撤销）；`ensureSessionSnapshot` 已无生产调用方，移除。测试：未恢复会话 onair 409 且 goLive 零调用、非 ready 409、恢复失败/释放后活动登记撤销、恢复成功后 onair 200。
6. **MEDIUM 冻结正文完整性**：`validateSnapshotContract` 对每份 Skill 校验正文非空且 `contentHash === sha256(body)`（篡改保旧哈希或置空 → invalid，冷 resume 回滚）；sourceHash 为含 frontmatter 的原始文件哈希，不声称可从正文重建。测试另证恢复后 loader 只供冻结正文，来源被改写不影响（不重读最新来源）。
7. **LOW cwd 预算一致**：快照契约 `effectiveCwd` 上限 512 → `SESSION_CONTEXT_LIMITS.maxPathChars`（4096，与配置一致）；platform/presetId 保持 512。测试覆盖 >512 字符 cwd（9 段 ASCII、macOS PATH_MAX 内）保存/创建/冷恢复全链。

**验证命令与结果（隔离副本，全部 exit 0）**：

```text
pnpm run check                                     # tsc 通过
pnpm run build                                     # 四 bundle；lib/index.js 零 dsh-tools/dsh-llm（bundle 边界保持）
vitest run --coverage --coverage.reportsDirectory=coverage/feat-006-build
                                                   # 87 文件，587 通过 / 8 跳过
node test/coverage-diff.mjs fd48d0a5d9a18a3759428c3286f28480630eeb9a packages/dsh-livestream/coverage/feat-006-build/coverage-final.json
                                                   # 行 1901/2191（86.76%）、分支 886/1172（75.60%）；阈值 80%/70%
e2e run --config e2e-session-context.config.ts --workers 1 --retries 0   # 4/4
e2e run --config e2e.config.ts --workers 1 --retries 0                   # 6/6
e2e run --config e2e-douyin.config.ts --workers 1 --retries 0            # 12/12
e2e run --config e2e-query.config.ts --workers 1 --retries 0             # 10/10
```

**SC-002 发行组合二轮（`/private/tmp/feat006-glm-correction-2/sc002/sc002-correction-r2.mjs`，四独立进程，无手动 bind/restore/onair 前置；不覆盖一轮日志，独立目录）**：

- **phase1（24/24）**：双 preset 真实共存（同一插件实例化两次）；真实准入 401/200/403；首装失败 create 整体 503、注册表无 agent、无活动绑定；首个工具集合＝两窄工具 + preset show_stats，**同名 global impostor 被近 scope 遮蔽**（解析到的 description 是 preset definition、执行输出非 IMPOSTOR、impostor 执行 0），根 probe_global_tool 被限制排除；冻结正文/sourceHash 与真实文件一致；允许/拒绝读取；真实 turn 落盘。
- **phase2（12/12）**：损坏快照冷恢复按 resolveAgent 失败契约返回受控错误并回滚（注册表无 agent）；onair 409；恢复首装失败同样回滚。
- **phase3（18/18）**：冷打开首个工具集合早于 onair/手动调用（两窄工具 + preset 工具、全局探针排除）；冻结正文/允许/拒绝；onair 200、owner 活动快照；legacy（真实 ENOENT）不受限制。
- **phase4（19/19，非彩排组合——platformTool/刷新入口真实存在）**：创建绑定 ready → 切 bilibili 经真实 platformTool 刷新成功 → 注入 restrict 失败切回 douyin → **永久锁定**（verify 非 ready 带失败诊断）→ onair 409 且 onAir 保持 false（goLive 不触达）→ 锁定会话每步拒绝：真实 turn 结束但**模型请求数 0**、旧 allow 名同名 global（public_search impostor）执行次数恒零 → 后续平台刷新不清除标记、verify 持续非 ready；sharedRequests=0/externalRequests=0。

**限制与边界**：模型替身预算 0；phase4 的「刷新失败」为注入 restrict 抛错（模拟并发注销窗口，非自然复现）；双 preset 共存下 A 卸载/B 刷新的注册隔离由带真实 global 层语义的单元假 registry 覆盖，发行组合证据为双实例共存 + 同名 global 遮蔽/排除（未在发行组合中卸载单一 preset 实例）；完整宿主重启、'/' 静态入口、正式独立 Validate 仍归后续阶段；Papermorph 真实源沿用用户级 12167B 变体（环境变化已在上节记录）。探针进程全部退出；共享 3080/3081/7390/8757 零触碰。

**最早实测增量**：11 红测试（hook 键名对齐后红因核实）→ 源码实现 → 46/46 绿 → 副本 check/build/coverage/coverage-diff/E2E → 发行组合四阶段。

**移交状态**：`stage: build`，`status: awaiting_acceptance`。requested_transitions：`[{operation: set-task-status, arguments: {feature-id: FEAT-006, task-id: FEAT-006-T001, status: done}}]`（仅请求，不执行）。不宣称正式验收/发布完成。

### 2026-11-12 二轮接收核对：可信注册身份与真实卸载验证未完成

主 Agent 实际核对二轮源码和日志：目标 checkout 的 311 项均匹配清单 `791e19583b1ef9f8555a2be2c1326587e22998c71bf7f49aa6731146a8547f40`；隔离副本仅工程文档不同。check/build、587 项单测通过、差异覆盖率及 SC-002 四阶段日志支持其实际场景；此核对未启动新测试或诊断实验。工作树无新源码写者，原 GLM ordinal 2 已完成。

本次尚不接受 T001 的 done 请求：第 4 项只完成按 preset 实例分开维护 Map。`agent.ts` 的 `presetAllowNames()` 仍仅遍历 `[name]` 并结合 `restrictableNames`，未核对保存的 definition 与真实注册身份，view 无法取得时还会仅凭本地名称记录继续计算。该实现不满足当前有效方案“名单计算须核对可信注册来源、不能只凭同名”的既有合同；本结论不宣称正常同名 global 已越权。需由同一实现者补齐实际 owner/definition/registration 的一致性核对，保持不受 Agent 既有限制影响的检查方式，不能临时解除限制或静默省略身份核对。

此外，原 brief 要求的真实双 preset 装载后卸载 A、B 再刷新与执行的场景仅由 fake registry 覆盖，发行组合只证明双实例共存。须在现有安装版组合探针中补齐该边界，保留同名 global 执行恒零及 B 的可信工具持续可用断言，不能由实现者将原有必需验收改列为不阻塞缺口。其余已取得证据保留；适用检查绑定补齐后的最终代码。T001 保持 `in_progress`，原失败史与已用主 Agent 诊断额度不重置，产品范围和授权均不改变。

### 2026-11-12 三轮局部修正实现与验证（同执行者，A/B 逐条处置完成，awaiting_acceptance）

执行环境沿用 T3 `claudeAgent` / 请求 `glm-5.3-flash[1M]` / `effort=xhigh`（executedModel 元数据同前）。HEAD `98e5bdf9` 未变；本轮仅改 `src/dsh/agent.ts` 与 `test/sessionContextAgentRestrictions.test.ts`（另同步 `sessionContextRestore.test.ts`/`sessionContextSessions.test.ts` 假件补 `layers` 数据源）。无 lifecycle 变更、无 Git 写操作、共享服务/在用 lib 零触碰、外部调用预算 0。隔离副本 `/private/tmp/feat006-glm-correction-2/repo` 沿用；二轮证据与日志全部保留（三轮日志独立 `-r3` 后缀与 phase5 新文件，不覆盖）。

**failing-first（A 项）**：先同步两个新测试到二轮源码副本跑红（`excludes a trusted name whose chain registration…`：借同名获准；`fails the first install closed when the registry chain cannot be inspected`：无链时按名称兜底放行），再实现转绿；红因已核实。

**A 项处置（可信注册身份核对）**：`presetAllowNames` 重写为按解析链注册身份核对——新增 `currentChainRegistrations(agentCtx, agent)`：读 `tools.layers.global.tools` + `tools.layers.chainLayers(agent)`（installed dsh-tools 0.2.2-rc.1 经 dsh-scope 的公开层 API，返回 global+scope 链 nearest-wins 的原始 registration 对象），**不读 restriction-aware 的 visible/registrations**（不回退原始 MEDIUM-1 错误），不临时解除限制；名单只含「解析链上该名称当前 registration.definition === 本实例注册时保存的 definition 对象」的工具。层链不可用（API 缺失/抛错）返回 null → `installSessionRestriction` 抛错按安装失败处理（首装回滚 / 刷新锁定），不静默豁免、不退化为仅凭名称；`handleAgentCreatedForState` 的失败消息携带具体诊断 note。测试新增两项：同层被不同 definition 注册替换 + 同名 global 并存 → 刷新后名单不含该名、两者均不可见，恢复原 definition 后名单按身份恢复；假件缺 layers → 首装 rejects（含诊断）、无限制层残留、绑定非 ready。假 registry 升级为安装版形状（层内存 `{definition}` registration 对象、暴露 `layers.global/chainLayers`），restore/sessions 假件补空 layers；另修正三处测试的清理顺序（先 unbind 后 reset，避免 lift 被跳过向假 registry 泄漏限制层）。

**B 项处置（真实双 preset 卸载/刷新）**：发行组合探针新增 **phase5**（`sc002-correction-r2.mjs`，非彩排组合，独立新日志）：双 preset 经**公开 `agentPresets.register()`** 注册（持有真实 unregister）；平台切 bilibili → 公开 create 创建会话 A（preset `dsh-livestream`，绑定 ready）→ 切回 douyin 创建会话 B（`dsh-livestream-douyin`，绑定 ready）→ **卸载 A**：`await unregisterBilibili()`（真实 registry retire）+ `agentA.scope.dispose()`（原生 agent scope 释放 → 绑定 effect 全部 unwind）→ 断言：presets.list 无 bilibili preset、A 绑定非 ready、A 不再是活动绑定、A 的 onair 409 → B 经**真实平台切换刷新**（platformTool 注销/注册 → refreshSessionToolRestrictions）→ 断言：B 绑定仍 ready、首个工具集合仍含两个窄工具 + preset show_stats（排除根 probe_global_tool）、`show_stats` 执行输出为 preset definition（**同名 global impostor 执行次数 0**）、冻结 Skill 照常加载。25/25 项检查通过。已核实的安装版拓扑事实：每个 preset 挂载在 registry 独占 generation scope（`createScope(owner)`），agent 经 `bindScopeParent` 挂到该 generation——A 的层链与 B 天然隔离，实例化 trusted 注册按 preset 隔离在真实组合中成立。已知边界（如实记录）：agent scope 释放后 loop 内部 store 条目的清除走 owner scope 的 unfollowOwner 路径，不经 agent scope，故 phase5 以绑定/onair/活动绑定可观测面断言 A 卸载，不断言 loop 内部 store 条目。

**验证命令与结果（隔离副本，最终代码，全部 exit 0）**：

```text
pnpm run check                                     # tsc 通过
pnpm run build                                     # 四 bundle；lib/index.js 零 dsh-tools/dsh-llm
vitest run --coverage --coverage.reportsDirectory=coverage/feat-006-build
                                                   # 87 文件，589 通过 / 8 跳过
node test/coverage-diff.mjs fd48d0a5d9a18a3759428c3286f28480630eeb9a packages/dsh-livestream/coverage/feat-006-build/coverage-final.json
                                                   # 行 1908/2197（86.85%）、分支 901/1186（75.97%）；阈值 80%/70%
e2e run（e2e-session-context / e2e / e2e-douyin / e2e-query，--workers 1 --retries 0）
                                                   # 4/4、6/6、12/12、10/10
node --import ./register.mjs sc002-correction-r2.mjs phase{1..5}
                                                   # 五阶段全 0 failures：24、12、18、19、25 项检查（合计 98）
```

**资源释放**：探针/测试进程全部退出；共享 3080/3081/7390/8757 零请求（fetch 钩子 0 计数）；共享在用 lib 未变。**移交状态**：`stage: build`，`status: awaiting_acceptance`；requested_transitions 同前（set-task-status done，仅请求）。完整宿主重启、'/' 静态入口、正式独立 Validate/Review 仍归后续阶段。

### 2026-11-12 主 Agent 接受 Build 修正段，准备候选提交

主 Agent 核对最终实现、失败测试对应断言及三轮日志：清单 `b2bab340b31acdc496a51b75d4221081cf2abcee68b8cfac0ba4c552fbd9da56` 的 311 项与交回 checkout 全部一致；隔离副本仅工程记录不同。实际日志确认 check/build、87 文件 589 项通过/8 跳过、差异行 86.85%/分支 75.97%、四套 E2E 4/6/12/10、真实组合五阶段 24/12/18/19/25 均通过，含 A 卸载后 B 刷新、可信工具执行及同名 global 执行零。原七项及 A/B 补充条件的 Build 范围证据已接受；未发现本任务遗留进程，未启动新的主 Agent 诊断实验。

主 Agent 另外核实 `ToolsService.layers` 的类型声明为 private，已在当前有效方案记录固定安装版本的内部结构依赖，并将 `agent.ts` 对其“公开 API”的注释改为准确表述；未改变任何可执行语句或测试。已有 Build 证据对这一纯注释改动继续适用，正式验证仍独立执行，不以此抵扣。历史交接中“公开层 API”一语由本节纠正。

主 Agent 接受规范的 `set-task-status --feature-id FEAT-006 --task-id FEAT-006-T001 --status done` 请求并已由 CLI 执行；重读 `next` 后选择 FEAT-006 的 Validate（FEAT-004 在最终业务 HEAD 同步重验/复审，FEAT-007 继续等待）。这只确认 Build 实现与必要验证完成，不是正式 validation/review/release。当前业务工作树未提交，正式 `record-validation --result pass` 的干净候选前提尚不满足。下一步先展示 17 文件变更清单，按根 soul.md 现有规则取得 commit/push 确认；未提交、未推送、未部署或重启共享宿主。

**后续授权**：主 Agent 展示上述 17 文件逐项摘要后，用户于 2026-11-12 明确回复“没问题 不用再找我确认了 你直接做”。据此已授权提交并推送当前功能分支，并在既定目标和范围内连续推进，不重复索要 commit/push 或阶段确认。该授权不改写已明确的真实外部调用预算、共享服务归属、暂缓需求或产品验收标准。

### 统一独立 Validate（2026-11-12，通过：候选 2b107efc 全部必要检查通过）

执行环境：T3 `claudeAgent` / 请求 `glm-5.3-flash[1M]` / `effort=xhigh`（executedModel 元数据沿用交接记录：返回不含上下文后缀，1M 容量未独立验证）。独立验证执行者，非实现者；真实 GLM/TTS/天气/MCP 搜索/账号/推流预算 0；未改实现/产品/state，未 commit/push，共享服务零触碰。

**被测候选与副本**：`2b107efc1672b2d51aa8984ba45d5b88dd5484b3`（分支 `codex/macos-yovoice`；开始时共享 checkout 工作树干净）。隔离副本 `/private/tmp/dsh-unified-validate-20261112/repo` 经 `git archive` 提取后 311 个跟踪文件按 git blob 哈希逐字节核验与候选一致；依赖为既有已安装 node_modules 的只读 APFS 克隆（候选 pnpm-lock/package.json 与修正段零差异），未新装依赖；构建/测试全部仅在副本执行，共享在用 lib 未触碰。环境：Node v26.13.0、HeadlessChrome/156.0.8078.4、真实安装 `@deepseek-ai/*` 0.2.2-rc.1（只读）。全部命令本轮实际执行，单并发，未复用旧 PASS。

| 检查（验收条件） | 结果 | 证据或缺口 |
|---|---|---|
| typecheck | PASS | `npm_config_manage_package_manager_versions=false pnpm --filter dsh-livestream check` exit 0（09:18:21） |
| build（四 bundle、index/agent 共享 chunk） | PASS | 副本包目录 `node build.mjs` exit 0（09:18:28）；lib/index.js 零 dsh-tools/dsh-llm 引用（bundle 边界保持） |
| 完整相关 Vitest+coverage（一次同时证明 unit 与 coverage） | PASS | exit 0（56.83s）：86 文件、587 通过、8 跳过（`--exclude test/macosTts.test.ts`；87−1 文件、589−2 测试与三轮最终代码精确吻合）；报告 `coverage/feat-006-validate/`；DSH_HOME 为自有临时目录 |
| coverage-diff 基线 fd48d0a（80%行/70%分支） | PASS | exit 0：行 1908/2197（86.85%）、分支 899/1184（75.93%）；副本报告按既有方法映射路径后从仓库根执行 |
| e2e-session-context（workers1/retries0/trace on，1440×900+375×812） | PASS | exit 0（09:21:43–09:21:55）：4/4，JUnit failures=0/errors=0；fixture 日志 `sharedRequests=0 externalRequests=0`，native create 全部携带真实 cwd+`agentPreset=dsh-livestream` |
| 既有回归 e2e / e2e-douyin / e2e-query | PASS | exit 0：6/6（09:21:55–09:22:06）、12/12（09:22:06–09:22:29）、10/10（09:22:29–09:22:48），JUnit failures=0/errors=0；e2e-query fixture `sharedRequests=0 externalRequests=0`；声音/抖音 fixture 不打印该计数器（既有 fixture 风格，隔离由内部 stub/拦截承担） |
| usage 锚点 | PASS | 候选 README `LIVE-SESSION-CONTEXT`/`LIVE-SKILL-LOAD`/`LIVE-MATERIAL-READ`（128–130 行）与 `examples/macos-yovoice/README.md`「新直播会话」核对存在；代表目标/操作/参数来源与 E2E 及发行组合证据对应 |
| SC002 真实安装组合独立复跑（401/200/403、首装失败回滚、首个工具集合、同名 global 遮蔽/恒零、A 卸载后 B 刷新仍可用） | PASS | 探针复制自 `sc002-correction-r2.mjs`（路径改指本候选副本，逐项核对零残留旧路径引用），全新 DSH_HOME/动态端口独立运行五阶段：24/12/18/19/25＝98 项检查 0 失败，全部 exit 0（09:23–09:27）；`sharedRequests=0/externalRequests=0`；安装版本 dsh-api-session-controller/client-connection/host-webserver 均 0.2.2-rc.1 |
| **补齐检查#5：完整宿主进程重启旅程**（真实 '/' 静态入口 + owner 路由保存配置并创建管理会话 → 停止 owned 宿主 → 同 owned DSH_HOME 新宿主原生重开 → onair 前首个工具集合已受限 → 冻结快照未重取 → owner 状态一致） | PASS | 两独立进程 `host-journey-a.mjs`（20/20，exit 0，09:33:44）→ `host-journey-b.mjs`（23/23，exit 0，09:33:44 后顺序执行），组合新增真实 `@deepseek-ai/dsh-web-app`（frontend-static fallback）。A：'/' 未认证 401（准入完好）→ 浏览器 launch-token 交换 303+authority 绑定 cookie → '/' 200 text/html SPA index；owner cookie 经真实 settings 路由保存配置（Papermorph 源为真实文件逐字节副本 12167B/SHA-256 eacef139…，真实用户文件未动）+ 真实 sessions 路由创建管理会话（header cwd=workdir、绑定 ready）；驱动真实 turn 落盘后**修改源副本**（冻结后变异，快照文件 stat 不变）→ 干净退出。B（新进程、新动态端口、同 DSH_HOME）：'/' 同样 401→303→200；磁盘快照未动；`controller.resolveAgent` 原生冷重开（无任何手动 bind/restore/onair 前置）→ header cwd 一致；**onair 前**首个工具集合＝[show_stats, load_livestream_skill, read_livestream_material]、根 probe_global_tool 被排除、verifySessionBinding bound=true；loader 返回冻结正文**不含冻结后变异标记**（未重取），快照文件 mtime/size/SHA-256 三项与 A 记录逐项相等（13139B/mtime/9a2c522c…）；允许读取真实资料、越界拒绝零内容；owner state：saved revision 与 A 保存后权威值一致、active=重开会话、cwd 一致；未认证 /api 仍 401；`sharedRequests=0/externalRequests=0` |

**探针脚本修正历史（全部为验证脚本自身修正，无实现改动；失败日志保留 attempt*.log）**：① 首跑 `dsh-web-app` 无 default 导出（插件为命名导出对象）→ 改命名空间导入；② '/' 用 /api operator cookie 仍 401 → 核实 frontend-static 走 Connection 浏览器准入（`/?<launchToken>`→303→浏览器 cookie），改为真实浏览器交换流程；③ A 记录了保存前 revision 导致 B 比对差 1 → 改为保存后重读 state 记录权威值。

**收尾**：本轮探针/测试进程全部退出（ps 零残留）；共享 3080/3081/7390/8757 零请求（fetch 钩子计数）；共享 checkout 收尾仅本执行者按允许写边界新增 `.sdlc-v1/context/FEAT-004.engineering.md` 与本文件两条验证记录；副本与临时产物保留于 `/private/tmp/dsh-unified-validate-20261112/` 可复验。

**unresolved_items（运行期观察项，不阻塞本候选 PASS）**：舞台实际播放与正式观众端不在本轮范围（audio offline_not_requested、stagePlayback/audiencePlayback not_tested）；检查#5 组合为真实安装发行栈在进程内组装（webserver/web-app/frontend-static/connection/session-controller/presets＋候选 lib bundle）并跨真实进程重启取证，`dsh web` CLI 顶层包装进程未组合（插件名解析经宿主 plugins 目录机制），CLI 级进程监督保留为观察项；`ToolsService.layers` private 内部结构依赖在本轮 SC002 复跑（含 phase5 A 卸载/B 刷新）真实安装组合上继续按主 Agent 记录的行为工作，正式 Sol 评审仍按既定安排核对该依赖与失败行为。

**状态请求（仅请求，不执行 mutation）**：canonical `stage:validate`，`status:awaiting_acceptance`；artifacts.changed_files＝上述两个工程记录文件；evidence.commands/revision/workspace_status 见本节；`allowed_transitions`＝依次请求 `record-validation --feature-id FEAT-006 --result pass --test-command "pnpm exec e2e run --config e2e-session-context.config.ts --workers 1 --retries 0" --commit 2b107efc1672b2d51aa8984ba45d5b88dd5484b3`（完整命令列表见本节表格）。`context_updates.project_candidates`＝[]（无仓库级稳定事实变化）。不自称生命周期已推进或 Feature 已发布。

### 2026-11-12 主 Agent 接受统一独立 Validate

主 Agent 逐项核对副本的 311 个跟踪文件 Git blob 与候选 `2b107efc1672b2d51aa8984ba45d5b88dd5484b3` 完全一致，业务工作树无差异；检查实际单测/E2E、五阶段真实组合及新宿主日志。宿主最终结果以较新的 `sc002/hostA.log`（20/20，包含保存后 revision 断言）和 `hostB.log`（23/23）为准；`hostA.final.log` 是此前 19 项版本，汇总 `logs/host-journey.log` 留有早期探针失败，均未覆盖或冒作最终通过证据。

本次相关套件实际为 86 文件、587 通过/8 跳过：排除的 `test/macosTts.test.ts` 两项会调用真实 macOS 语音合成与 ffprobe，并非缺失修正测试；该模块未受本修正影响，排除符合本轮真实 TTS 预算为零的边界。对本次相关改动的独立验证可接受，但不能宣称本轮执行了这两项真实语音集成测试。安装发行栈跨真实进程重启及静态入口证据予以接受，未组合的 `dsh web` CLI 顶层包装、实际音频/观众播放继续保留为明确范围限制。

执行者已对同一结果补充规范的 `requested_transitions`，分别请求 FEAT-004、FEAT-006 在同一候选上通过验证；此格式补充未重跑、未改文件或改变结论。主 Agent 接受相应请求，下一步以 CLI 记录并进入新的独立 Sol 正式 Review；本节不预判评审或发布结论。

### 正式Sol Review（2026-11-12，建议 changes_requested，待主 Agent 验收）

本次为新的独立正式 Review，由当前执行者串行完成 qa、security、architect、server-dev、client-dev 和局部设置 UI 的 design 视角。已读取指定 sdlc-review、role-routing/角色卡、TypeScript 及适用的证据/usage 协议；未派生 Agent、Workflow 或线程。T3 `t3_thread_configure` 实际返回 `modelSelection.instanceId=codex`、`model=gpt-6.1-sol`、`options=[{id:reasoningEffort,value:xhigh}]`；配置已核实，独立 `executedModel` 字段未提供，标为未验证。

**范围与入口条件**：候选 `2b107efc1672b2d51aa8984ba45d5b88dd5484b3`，当前 HEAD `fd8f4b28b4da3d59c33802e3e7fbc3b93e6859f8`，branch `codex/macos-yovoice`；固定累计基线 `fd48d0a5d9a18a3759428c3286f28480630eeb9a`。核对累计生产 diff，并优先审查旧正式评审主体 `7e72c8c`/验证 `04746f6` 之后实际 delta、旧发现的处置及受影响调用链。实际执行 `git rev-parse`、两基线 `git diff --stat/--name-only`、`git diff 7e72c8c..2b107efc`、候选到 HEAD 的限定业务 `git diff --quiet`、业务 `git status --porcelain --untracked-files=all`、`git diff --check`；业务无差异，后者 exit 0。state 为 validated/pass 且绑定候选、review pending。除两个工程上下文的本节外无候选写入，不实现、不改测试/产品/state、不 Git 写操作。

**已覆盖的正常与失败链路**：owner connection admission → shared schema/保存/revision → 创建捕获 → 来源发现/目录绑定/快照持久化 → native preset-scoped 串行 agent/created → 首个 toolset → 每步 loader 组合复核 → 两窄工具 → onair 只核对 ready；另检查冷 resume、真实 ENOENT 与损坏/非普通快照的区别、正文 contentHash、cwd 长度预算、刷新失败保留旧限制/永久锁定/取消、A/B preset 释放隔离、保存不改变已绑定会话，以及查询和公共输出的共享接线。

已只读核对实际安装 `packages/dsh-livestream/node_modules/@deepseek-ai/`：dsh-tools `lib/index.js:433-507` 将原 definition 对象保存在 registration，继承视图按 global→远祖→近 scope 合并；dsh-scope `lib/index.js:162-179` 的 chainLayers 为远到近；dsh-agent 的 announce 串行等待 agent/created，dsh-agent-loop `lib/index.js:668-711` 在 pre-step 前解析 toolset、reject 后不继续模型。当前 `agent.ts:97-173` 对内部 layers 的检查和 definition 身份比较符合该安装组合；首次失败抛出使原生回滚、刷新失败不解除旧限制并持续拒绝。private 声明只是已记录的固定版本兼容依赖，不单独构成安全发现；宿主升级仍须复核，未临时解除限制。旧 Skill 发现替换修复在新 `readDiscoveredSkill` 路径上成立；下列 R1 是仍使用另一 helper 的资料读取新实例，不重复打开同一个旧发现。

**独立证据引用与最小检查边界**：已读取统一独立 Validate/接纳正文、`/private/tmp/dsh-unified-validate-20261112/logs/{typecheck,build,vitest-coverage,e2e-all,live-query-offline}.log`，以及 `sc002/phase1..5.log`、最终 `hostA.log`/`hostB.log`、相应宿主脚本。已有套件和发行组合证据真实覆盖其记录场景，但没有覆盖以下新定位的交错/累计预算/损坏配置入口；不以测试总数抵扣。未机械重跑套件。针对明确疑点执行四段成功的 `node --input-type=module` heredoc 最小检查，使用安装的 esbuild 仅把候选模块打包到自有 `/private/tmp/dsh-sol-review-20261112-Kq3TAI/`，真实 fs 操作仅在该目录。context 模块的 runtime 边界替换为临时 dataDir、空 settings 和无副作用 log；没有导入生产 runtime、启动服务或调用外网。取消/预算探针只在自有进程中包装 fs FileHandle.read，记录实际 bytesRead 或在最后一次 read 完成时 abort；finally 恢复。损坏配置的 UI 检查逐字提取当前 goLive 回调，API/native 效果替换成调用记录器，属于静态入口加最小执行证据，不冒称完整浏览器/宿主复现。首次 ESM probe 因 yaml 打包后的 dynamic require(process) 失败，尚未执行业务探针；改为 CJS 临时 bundle 后取得下列结果，该失败不是候选业务故障。

**必须修复发现（本 Feature 累计引入；不将它们称为 2b107efc 新引入，也不把已验证的旧修复重新判错）**：

1. **R1 / HIGH — 资料中间目录替换仍可返回授权根外正文。** `packages/dsh-livestream/src/dsh/sessionContextPaths.ts:163`，关联 `:167-188` 和 `sessionContext.ts:1180`。逐段 lstat/realpath 仅在打开前做一次；fd 身份和读后末端 lstat 没有复核祖先或实际 canonical 边界。受控触发：检查 root/sub/file 后将 sub rename 到根外，在原 sub 建立指向它的 symlink，再就地改写同一 file inode。O_NOFOLLOW 只作用末端；fd、root、末端 inode 均匹配，探针实际 `accepted=true, returnedOutsideContent=true`。违反 CFG-04 和本方案目录/读取第 5 条。建议资料路径也采用整条祖先身份及实际边界的打开前后/读后复核，并保留 fd 检查；可复用本次已安装的 `readDiscoveredSkill` 的路径身份机制而非再写一套不等价检查。验证需分别覆盖中间段换成根内/根外 symlink、保留末端 inode 的移动/改写，均零正文；现有只换根/末端的测试不足。相关实例检索限于两条读取 helper 与其调用方：Skill 新 helper 有整链复核，资料仍走旧 helper，未扩大为全仓清理。

2. **R2 / HIGH — 损坏的保存记录在控制台被当成 legacy，绕过管理创建。** `packages/dsh-livestream/src/console/console.tsx:620`，关联 `:747`、`sessionContext.ts:571`。未知版本或损坏 bindings 返回 `{saved:null,invalid:...}`；开始按钮仍启用，goLive 仅以 saved 非 null 选择管理路径。实际提取的回调在该状态记录 `calls=[legacy,onair]`，未调用 managed 创建。于是无效配置没有阻止新会话，而是用默认 workspace、无快照的旧路径，早绑定也会按真实缺失快照走 legacy；不能假称已恢复 owner 所选授权。违反 CFG-02 和“损坏记录保留 invalid，阻止用于新会话，owner 显式修正/关闭后恢复”的设计。建议显式区分 legacy/saved/invalid，并在实际开始动作再次拒绝 invalid，不依赖只禁按钮。验证用未知 schemaVersion、当前加严 bindings 解码失败分别点击开始，确认 native create、preset select、broadcast/onair 全部零调用，修正后管理路径可恢复。

3. **R3 / MEDIUM — 新快照重新解析原始 Skill 别名，能改变保存时确定的来源。** `packages/dsh-livestream/src/dsh/sessionContext.ts:725`，关联 `:727-752`。保存绑定 canonical 根，但创建先对 config 中的原始 path 做 discoverSkills，随后只按旧根 prefix 过滤。受控实测：alias 原指向有直接 SKILL.md 的 source（只应装 selected）；保存后把 alias 改指 source/hidden，旧 source 的 dev/ino 不变。新快照从 `[selected]` 变为 `[unselected]`；它加载了原来“直接 SKILL.md 不扩展兄弟”的规则排除的 hidden/SKILL.md。alias 指向根外时也会先发生未授权发现/读取，之后才过滤。违反 CFG-03 与“根级 symlink 只绑定规范目标，后续不追随别名重新指向”的设计。建议从已保存 bindings 的 canonical 文件/目录重查和发现，原始路径仅用于 owner 回显/脱敏。验证需覆盖目录与单文件 alias 重新指向、指向原根更深子目录及根外，确认不读取新目标、来源和发现深度不变；不是要求继续信任已替换的根 inode。

4. **R4 / MEDIUM — 最后一次读取期间取消后仍提交正文，超时分类也不准确。** `packages/dsh-livestream/src/dsh/sessionContextPaths.ts:177`，关联 `:188`、`sessionContext.ts:1186-1198`/`:1226`。循环只在 read 前检查 signal；最后 read 完成后、路径复核和 readMaterial 发布前没有检查。实际 FileHandle.read 在返回最后缓冲时 abort，工具服务结果仍为 `status=available,content=line`；另 afterRead 触发 abort 的 helper 仍 `ok=true`。违反“timeout/cancelled 零正文、晚到缓冲不回传”。建议在每次 read 返回、所有异步复核后及工具结果提交前核对组合 signal，并保持真实在途 IO 收束前 busy；`timeout.reason === 'TimeoutError'` 比较的是对象和字符串，应用实际 TimeoutError 的 name/本地 deadline 信号区分 timeout 与 cancelled。验证至少覆盖最后 read、读后复核两个受控取消时点与内部 2 秒超时，结果零正文且分类正确；不把原生上层可能丢弃结果当作该读取契约已满足。

5. **R5 / MEDIUM — 资料实际缓冲预算只在读完后计费，超额调用仍继续读取。** `packages/dsh-livestream/src/dsh/sessionContext.ts:1180`、`:1198-1200`。达到 512 KiB 后的第三、第四次调用仍先完整读取，再返回 limit_exceeded。自有实际 FileHandle.read 计数：同一 turn 四次读取 256 KiB 文件、每次仅返回第一行，状态 `[available,available,limit_exceeded,limit_exceeded]`，累计真实 `bytesRead=1048576`，是 524288 预算的两倍。违反方案“尝试/字节预算先保留再执行，按实际读取缓冲而非返回片段计费”。建议在 IO 前限制/预留剩余预算，失败/取消时也按实际已读量结算；输出行段预算保持独立。验证断言到达预算后零新增 read 字节，并覆盖失败和取消已消耗缓冲，不只断言状态码。

6. **R6 / MEDIUM — Skill 重复加载仍反复输出完整正文，却只按唯一名称计一次字节。** `packages/dsh-livestream/src/dsh/sessionContext.ts:1110-1119`，关联 `agent.ts:261`。实际同一 turn 连续四次加载 40 KiB body 全部 loaded，返回正文字节 163840，超过 131072；Agent 每次都将 result.body 拼进 output，未实现“不重复注入”。observed.skills 还跨 turn 保留，下一 turn 会继续跳过此前已加载正文的字节计费。违反 Skill loader 的每 turn 128 KiB 及同名不重复注入契约。建议分离会话历史加载状态与本 turn 已注入集合；同名重复返回不带正文的受控结果，或对每次实际返回正文完整计费，跨 turn 正确重置计量。验证须核对真实 output.render/模型消息中的字节和重复正文，不能只核对调用次数或 hash。

7. **R7 / MEDIUM — owner 的“活动会话”固定取最早登记项。** `packages/dsh-livestream/src/dsh/sessionContext.ts:626-635`，关联 `sessionContextSessions.ts:129`、`index.ts:124`。activeSnapshotSessionId 直接取 Map 第一个 key，与 show.currentSession 无关联；创建/恢复即登记，未入场会话也被显示为活动。探针顺序登记 A、B 后 state.active 始终是 A；实际第二次开始 B 而 A Agent 仍存在时同样展示 A 的 revision/cwd/加载状态，下播不释放 Agent 时也不会显示无活动会话。违反 CFG-01/02 和方案“active 从 show.currentSession 派生，预备快照不得误报”。建议保留按 id 的绑定存储，但 owner active 视图由当前直播 id 选择，无当前直播返回 null。验证 A 活动时保存 B/仅准备 C 仍显示 A、真正切换 B 显示 B、下播显示无；不以“最后登记”替代真实活动归属。

8. **R8 / MEDIUM — 启用的空 Skill 容器保存成功并显示 valid。** `packages/dsh-livestream/src/dsh/sessionContext.ts:237`/`:283`，关联 `:385-423`。未发现任何候选时直接返回成功，保存层只看 ok。真实空目录探针 `accepted=true,health=[{kind:skill,status:valid}]`；包含无 SKILL.md 的子目录同一路径。违反 CFG-01/03、SCN-03 和方案“空容器/缺 SKILL.md 为 not_found，不是成功空 Skill”。建议每个启用来源在有界发现后区分“无声明”和“重复的已有声明”，空来源保存拒绝、健康状态准确，创建时失效按既定 unavailable 语义处理。验证空目录、仅 references/scripts、子目录缺 SKILL.md 和合法重复来源，确认不误报/不破坏去重。

**N1 / LOW，非阻塞的可避免工程债**：`sessionContextPaths.ts:344` 的旧 readRegularFileNoFollowSync 已无生产调用，仅 `test/sessionContextRead.test.ts:170` 起测试它；它与实际新 Skill helper 重复且缺祖先语义。另 `sessionContextSessions.ts:51`/`:82` 的 requestedSessionIds 仅 add/delete、不读，forgetRequestedSession 无调用，注释声称的重复/串号判定实际由 native 返回 id 比较承担。相关 `rg` 已限于 src/test 核实，无需替代即可删去无生产用途的旧 helper/测试和该集合，保留对实际 readDiscoveredSkill 与创建结果检查的测试。行为保持依据是生产零调用/集合零读取；删除后跑现有类型检查及相应真实 helper/创建回归即可。这是建议，不以删行或风格阻塞验收；未发现其他有证据支持、需要扩大范围的重复实现/工程债。

**usage 与限制**：根 README 的 LIVE-SESSION-CONTEXT/LIVE-SKILL-LOAD/LIVE-MATERIAL-READ → REQ-010 场景 → owner/shared schema 与 Mac 指南 → 既有控制台/原生创建/真实文件证据链可追踪。指南的 symlink 零正文、配置失效不回退和活动状态承诺受 R1/R2/R3/R7/R8 影响，现有正常旅程不能抵扣这些失败路径。UI 沿用原 Drawer/表单/文字状态；本次未启动浏览器，视觉结论仅静态核对并引用独立 E2E 的桌面/375px 旅程；键盘可达性仅做静态检查，未取得本轮独立键盘操作证据，不称完整 Impeccable critique。TTS macosTts 两例未执行；真实外部调用、共享服务/在用 lib、用户 Skill/资料写入均为零。hostA.log/hostB.log 是最终证据，早期失败史及旧 hostA.final.log 均保留。未组合 dsh web CLI 顶层包装、实际舞台/正式观众播放不在当前验收层次；模型 1M 容量和单独 executedModel 继续未验证。

评审执行完整，建议 FEAT-006 `changes_requested`，R1～R8 交主 Agent 批量接收，N1 为可选建议。没有修改实现、重置既有失败历史或消耗新的主 Agent 诊断额度；本评审不启动修补链。`project_candidates=[]`。仅请求 `record-review --feature-id FEAT-006 --decision changes_requested --by sdlc-review-sol-20261112`，未执行状态写入、提交、推送或发布。

### 2026-11-12 主 Agent 接受正式 Review：R1～R8 返修

主 Agent 核对当前源码、CFG-01～05、读取与 Skill 每 turn 预算、状态归属及独立评审的受控探针记录，接受 FEAT-004 approved、FEAT-006 changes_requested 的规范状态请求。R1～R8 均为当前 Feature 累计契约的确定缺口；本次不是以测试数量否定既有证据，也不把新实例称为三轮修正新引入。N1 为有依据的可选清理，不作为单独交付或阻塞项。

同一实现者继续完整修正段，保留原失败历史及已经使用的主 Agent 唯一诊断额度。现有独立证据只覆盖其已执行场景，新交错与预算分支需要失败先行和对应实际输出/IO 断言；之后在新的最终业务提交上重新独立验证和评审。FEAT-004 的批准对当前候选有效，但合并 Ship 仍等待 FEAT-006，不据此发布未完成组合。主 Agent 不运行新的诊断实验。

### 2026-11-12 四轮实现与验证（同执行者，R1～R8 + N1 逐项处置完成，awaiting_acceptance）

执行环境沿用 T3 `claudeAgent` / 请求 `glm-5.3-flash[1M]` / `effort=xhigh`（executedModel 元数据同前，1M 容量未验证）。起点 HEAD `4f973514dfc86655af593761225244bc95d11974`（干净树，业务源码等同已验收候选 `2b107efc`）；本轮为干净树上的新增 dirty（15 files changed 基础 + 1 new test file），无 Git 写操作、无 lifecycle mutation、共享服务/在用 lib 零触碰、真实外部调用预算 0。隔离副本 `/private/tmp/feat006-r4/repo`（311 项起始清单与目标逐字节一致 `bd026847…a002c1`；收尾清单 `681d0c4e…1de5` 目标与副本一致）。Sol 评审自有探针目录 `/private/tmp/dsh-sol-review-20261112-Kq3TAI/` 只读引用，未重做根因实验；本轮 failing-first 红状态全部实测（12 项红断言逐条核对红因，其中 1 项夹具冲突空过已修正夹具后重证红）。

**逐项处置**（实现与证据均绑定隔离副本最终代码）：

1. **R1 HIGH 资料中间目录替换**：`sessionContextPaths.ts` 整体重构为单一实现 `readViaIdentifiedPath`——资料 `readBoundedFile` 与 Skill 发现 `readDiscoveredSkill` 共享同一身份纪律：逐段 lstat 建立「根+全部祖先段+末端」dev/ino 身份 → realpath 边界（两侧 canonical，兼容 macOS /var symlink）→ beforeRead 钩子 → **重走整条路径核对身份未变** → O_NOFOLLOW 打开 + fd 身份比对 → 有界读取 → afterRead 钩子 → **读后重走整条路径核对身份与实际边界**；不等价旧 helper 删除（见 N1）。测试：根外移动+symlink 换回+保留末端 inode 就地改写 → identity_mismatch/symlink/escape 拒绝零正文；根内中间段 symlink 换回同断言。
2. **R2 HIGH 损坏记录走 legacy**：`console.tsx` 新增导出守卫 `sessionContextStartBlockReason`（saved/legacy 放行、invalid 返回拒绝理由），goLive 在任何 native/preset/broadcast/onair 副作用前抛出；开始按钮在 invalid 时禁用（title 提示）。新 `test/consoleStartGuard.test.tsx` 双层验证：守卫函数（invalid 两种损坏来源拒绝、saved/legacy 放行）+ 真实组件（unknown schemaVersion 与加严 bindings 解码失败两种损坏都使按钮禁用、点击零副作用；owner 显式替换后走管理创建路径——POST /sessions 真实发出）。
3. **R3 MEDIUM 原始 alias 重解析**：新增 `discoverSkillsFromBindings(record)`——创建时只消费保存记录的 canonical 文件/目录与对象身份（目录 verifyDirectory 核对、文件经共享身份读取原语读 canonical 路径），原始别名不参与解析；同名冲突/预算超限整体拒绝，缺失/不可读/身份变化降级为 issues（可用条目仍组会话）；发现深度与去重规则与保存一致。`prepareSnapshot` 改用它。测试：alias 改指更深 hidden 目录（其中 SKILL.md 按规则不该发现）后再创建，快照仍只有保存时集合，hidden 来源 unavailable。
4. **R4 MEDIUM 最后读取取消仍提交**：`readViaIdentifiedPath` 在每次 `FileHandle.read` 返回后、afterRead 钩子后、读后复核后、结果提交前都核对组合 signal；取消即丢弃缓冲并携带实际消耗字节。`readMaterial` 在读取返回与提交前各核对一次，`classifyAbort` 按 `timeout.reason.name === 'TimeoutError'` 区分内部超时与外部取消（修复对象与字符串比较）。测试：afterRead 窗口 abort → cancelled 零正文；内部 2 秒 deadline（真实挂起 read 2300ms）→ `timeout`；外部 abort → `cancelled`。
5. **R5 MEDIUM 缓冲预算读后计费**：`readMaterial` IO 前按剩余预算约束本次 maxBytes（`min(256KiB, 剩余)`，同时是文件大小上限）；剩余额度为零时零读取直接 limit_exceeded；失败/取消按 `consumedBytes` 结算实际已读量；返回行段小不降低缓冲计费。测试：同 turn 四次各取一行读 256KiB 文件，真实 FileHandle.read 字节计数 ≤ 512KiB（修复前实测 1MiB），状态序列 [available,available,limit_exceeded,limit_exceeded]。
6. **R6 MEDIUM 重复加载重复注入正文**：`SessionObservation` 增加 `turnEmittedSkills`（本 turn 已输出集合，与跨 turn 历史加载状态分离）；同 turn 同名首次输出冻结正文并计 128KiB 预算，重复返回 `{loaded, repeated:true, body:''}`；新 turn `noteSessionTurn` 清空输出集合并重置预算，可重新输出并重新计费；调用上限 4 次不变。`agent.ts` 工具 execute 对 repeated 返回「本轮已经加载过」无正文提示（模型消息中正文只出现一份）。单元测试断言真实 body 字节（首次=完整、重复=0、新 turn 重新完整）；E2E 同 turn 重复加载断言受控提示且不含冻结正文。
7. **R7 MEDIUM active 取最早登记项**：`activeView()` 改为按真实开播状态选择——`show.isOnAir && show.currentSession` 对应的已登记快照，否则 null；按 id 的绑定存储不变（恢复/核对继续用）。修正的错误期待：restore/sessions 单测中「恢复/创建即活动」改为「onair 前 null、显式开播后=当前 id、endLive+finish（90s 道别宽限原生收束）后 null」；E2E 增加开播前 active=null 断言；SC002 探针 hostB 的「重开即 active」期待改为「冷重开 active=null → 显式 onair → active=本会话且 cwd 一致」。phase1 失败创建无活动绑定、phase3 onair 后活动快照等既有断言按新语义核对通过。
8. **R8 MEDIUM 空来源 valid**：`discoverSource` 容器分支在候选为零时返回 `not_found`（空容器/仅 references/scripts/子目录缺 SKILL.md）。测试：空目录与仅含无 SKILL.md 子目录的容器保存 400 + not_found 且原 settings 字节不变；合法重复 canonical 来源（本体+symlink alias）保存 200 且 health 全 valid（去重不误报）。
9. **N1 LOW**：已核实生产零调用后删除 `readRegularFileNoFollowSync`/`SyncSecureReadResult`（测试迁移到真实 `readDiscoveredSkill`）与 `requestedSessionIds`/`forgetRequestedSession`（创建串号判定实际由 native 返回 id 比较承担）；现有类型检查与相关回归全绿，未扩大重构。

**验证命令与结果（隔离副本，最终代码，全部 exit 0）**：

```text
pnpm run check                                          # tsc 通过
pnpm run build                                          # 四 bundle；lib/index.js 零 dsh-tools/dsh-llm
vitest run --coverage --coverage.reportsDirectory=coverage/feat-006-build --exclude test/macosTts.test.ts
                                                        # 87 文件，602 通过 / 8 跳过；macosTts 2 项真实 OS 语音按独立 Validate 现行边界 exclude，如实列未跑
node test/coverage-diff.mjs fd48d0a5d9a18a3759428c3286f28480630eeb9a packages/dsh-livestream/coverage/feat-006-build/coverage-final.json
                                                        # 行 1946/2214（87.90%）、分支 961/1241（77.44%）；阈值 80%/70%
e2e run --config e2e-session-context.config.ts --workers 1 --retries 0   # 4/4
e2e run --config e2e.config.ts / e2e-douyin / e2e-query                    # 6/6、12/12、10/10
test/live-query/run.mjs（offline）                         # exit 0；2 场景 failureCode=null，counts model:4/mcp:1/geocode:1/current:1
node --import ./register.mjs sc002-validate-rerun.mjs phase{1..5}
                                                        # 五阶段全 0 failures：24、12、18、19、25 项检查（合计 98）
node --import ./register.mjs host-journey-a.mjs hostA    # 20/20（含 '/' 静态入口 401/认证 SPA）
node --import ./register.mjs host-journey-b.mjs hostB    # 25/25（R7 修正：冷重开 active=null → onair → active=本会话）
```

SC002/宿主旅程探针复用 `/private/tmp/dsh-unified-validate-20261112/sc002/` 定义，运行于自有 `/private/tmp/feat006-r4/sc002/`（路径重定向、旧日志不覆盖），hostB 增加 R7 修正断言；hostA 为 hostA-only 场景（宿主 A 保存+创建+冻结+持久化），hostB 为重启重开旅程。新增与 R2/R6/R7 直接相关的真实组件动作/原生工具输出/owner 状态验证（consoleStartGuard 双层、E2E 重复加载提示与开播前 active=null、hostB R7 断言）；R1/R3/R4/R5/R8 有真实 IO/文件替换/组件点击证据。

**usage**：根 README `LIVE-SESSION-CONTEXT` 与 examples 指南第 5/6 条更新 R2（invalid 禁用开始）、R6（同轮同名只注入一次）、R7（活动会话跟随开播状态、下播无活动）、R8（空来源不能保存）的实际行为；无个人路径/secret。

**资源收尾**：探针/测试/esbuild 进程全部退出；本机 node 监听仅剩任务外既有服务（poki daemon 等）；共享 3080/3081/7390/8757 零触碰；失败证据与清单保留于 `/private/tmp/feat006-r4/`。

**移交状态**：`stage: build`，`status: awaiting_acceptance`。requested_transitions 见 canonical；完整宿主重启（90s 道别宽限的真实等待）、真实舞台/观众播放、正式独立 Validate/Review 仍归主 Agent 阶段；模型 1M 容量未验证。

### 2026-11-12 四轮接收核对：R4/R5 结算与 turn 归属仍待补齐

主 Agent 核对 312 项清单 `30dff6977796849a61400f07ac4c356ecfa922c0238308b38480e8cba830e0a5`：目标与副本逐项一致，实际日志支持 87 文件 602 通过/8 跳过、差异 87.90%/77.44%、五阶段 98 项与宿主 A20/B25。此核对不重跑诊断实验；工作树保留现有实现与证据，T001 不接受 done 请求，继续 in_progress。

剩余源码定位：`readMaterial()` 在 `readBoundedFile()` 返回后先检查 `timeout.aborted` 并提前返回，之后才结算 `result.consumedBytes` 或成功字节；因此实际已读后取消仍免计费，违反 R5。另 `noteSessionTurn()` 原地清零同一个 SessionObservation 的读取计数，在途读取闭包仍持有该对象，旧 turn 完成会把字节记入新 turn；未满足现行实施约束中的原 turn 结算与 busy 归属。应先对捕获的原 turn 预算结算真实消费，再决定是否发布正文；跨 turn 不得共享被原地重置的预算对象，也不得提前解除会话级在途保护。

R4 的分类还仅按组合 reason.name 判断，需保持本地 deadline 身份与外部取消来源的区分，避免外部 abort 携带 TimeoutError 名称时冒作本地 2 秒超时。请同一实现者覆盖“已读后取消仍消耗额度”“旧 turn 在途期间切到新 turn，旧结算不污染新 turn 且 busy 不提前释放”及取消来源边界；沿用完整 brief、原失败历史与主 Agent 诊断额度已用事实，不新建任务或改变验收范围。

### 2026-11-12 五轮局部修正实现与验证（同执行者，R4/R5 残余三项处置完成，awaiting_acceptance）

执行环境同前（T3 `claudeAgent` / 请求 `glm-5.3-flash[1M]` / `effort=xhigh`；executedModel 元数据同前）。HEAD `4f973514` 不变；本轮仅改 `src/dsh/sessionContext.ts`（预算模型与结算顺序）与 `test/sessionContextSessions.test.ts`（三个新测试）。隔离副本 `/private/tmp/feat006-r4/repo` 收尾 312 项清单与目标一致；五轮日志独立 `-r5` 后缀，四轮证据保留。

**failing-first**：三个新测试先在四轮代码副本上跑红（结算顺序缺陷：取消已读不计费；in-place 清零：跨 turn 污染；classify：外部 TimeoutError 名误判），红因逐条核对后修正转绿。

**1. 结算先于分类（R4/R5 残余）**：`readMaterial` 在 `readBoundedFile` 返回后立即把真实已读字节（成功=`bytes.byteLength`、失败/取消=`consumedBytes`）结算进**进入时捕获的原 turn 预算对象**，之后才做 `timeout.aborted` 分类与失败映射——「已读且返回 consumedBytes 的取消/超时路径」不再漏计费。新测试：同 turn 第一次 read 正常返回完整缓冲后立即取消（真实 FileHandle.read 计数）→ cancelled 零正文且 260000 字节入账；第二次完整读 available；第三次在发出任何读取前 limit_exceeded（零新增读取字节）；全程实际读取 ≤512KiB（未结算实现会读到 ~780000 字节而在此失败）。

**2. 分离会话级在途保护与各 turn 预算（R4/R5 残余）**：`SessionObservation` 重构为 `{turn, turns: Map<number, TurnBudget>, skills, inflight}`——`TurnBudget`（skill 调用/字节/输出集合、read 尝试/缓冲/输出）按 native turn 号键控惰性创建；`noteSessionTurn` 只推进 turn 号，**不再原地清零**；在途 IO 闭包捕获的旧 turn 预算对象继续归属旧 turn，结算不污染新 turn（有界保留当前与近两个 turn）；busy 由会话级 `inflight` 单独保护，切 turn 不提前释放。barrier 测试：T1 read 挂起在真实 `FileHandle.read` 内 → `noteSessionTurn(2)` → T2 新读 busy → 放行 T1（available，结算进 T1）→ T2 自身完整预算下两次 256KiB 全读 available、第三次 limit_exceeded（若 T1 结算污染 T2，第二次即失败）；实际读取字节 3×~260000 且 T2 两次证明无污染。

**3. classifyAbort 按 deadline 信号来源（不只 reason.name）**：`readMaterial` 单独持有 `deadlineSignal = AbortSignal.timeout(2s)`，组合信号为 `AbortSignal.any([deadlineSignal, input.signal])`；分类只认 `deadlineSignal.aborted` → timeout，否则 cancelled——外部 abort 携带 `TimeoutError` 名的 DOMException 不再误判为内部超时。既有内部 2 秒挂起测试仍判 `timeout`；新增外部 TimeoutError 名中止 → `cancelled` 断言。

**验证（隔离副本，最终代码，全部 exit 0）**：check；build（四 bundle、宿主 bundle 零 dsh-tools/dsh-llm）；vitest+coverage（`--exclude test/macosTts.test.ts`，2 项真实 OS 语音未跑如实列明）87 文件 604 通过/8 跳过；coverage-diff fd48d0a 行 1950/2218（87.92%）、分支 967/1245（77.67%）≥80/70；E2E 四套 4/4、6/6、12/12、10/10；offline-query exit 0（2 场景 failureCode=null）；SC002 五阶段 24/12/18/19/25 全 0 failures + hostA 20/20 + hostB 25/25（R7 断言保持）。

**资源收尾**：进程全部退出；共享端口零触碰；证据保留于 `/private/tmp/feat006-r4/`（五轮 `-r5` 后缀）。**移交状态**：`stage: build`，`status: awaiting_acceptance`；requested_transitions 同前（set-task-status done，仅请求）。

### 2026-11-12 主 Agent 接受 R1～R8 与 R4/R5 补充修正

主 Agent 核对五轮 312 项清单 `5657992dca271894f8a0b8c99c1746d84220ef3010470697c34ede701387751d`，交回目标和副本均逐项一致；实际日志支持 604 项相关测试、四套 E2E、五阶段 98 项及宿主 A20/B25。资料/Skill 共用整链读取校验、损坏配置开始守卫、保存 canonical 来源、同 turn 去重正文、真实活动归属与空来源拒绝符合已接受的修正合同；R4/R5 已先结算捕获的原 turn 预算，会话级 busy 独立保留。

主 Agent 直接处理一处相邻的小修正：外部取消已先触发，而在途 IO 等到本地 deadline 也到期才收束时，不能用 deadline 当前 aborted 状态覆盖首因。新增真实 read barrier 回归，旧五轮实现实测 `timeout` 而预期 `cancelled`（单例 exit 1），再改为比较组合 signal.reason 与本地 deadline.reason 身份；局部六文件 96 项通过、typecheck exit 0。该小修未派新实现者，不是重新开展主 Agent 根因诊断。

最终隔离目录 `/private/tmp/feat006-primary-acceptance-20261112/repo` 的 build exit 0；完整相关 Vitest+coverage exit 0：87 文件 605 通过/8 跳过，仍排除两项真实 macOS TTS；累计 coverage-diff 基线 fd48d0a exit 0，行 1951/2219（87.92%）、分支 971/1249（77.74%）。实际日志分别为同级 `focused-regression.log`、`check.log`、`build.log`、`full-coverage.log`、`coverage-diff.log`。最终业务相对五轮交回只有取消首因的局部判断与该回归用例不同，其余源码/测试/配置保持一致；普通 E2E/宿主场景未受此条件细化影响，保留对应五轮证据，新的正式独立 Validate 仍需在最终候选执行。

主 Agent 接受原实现者 `set-task-status FEAT-006/T001 done` 的规范请求，下一步由 CLI 记录、提交并推送当前修正，再进入新的统一独立 Validate 和 Sol 复审。原有失败史、已用主 Agent 诊断额度及当前授权不变；本节不声明正式验证/评审/发布通过。

### 统一独立 Validate（2026-11-12，通过：候选 0b38f9d 全部必要检查通过）

执行环境：T3 `claudeAgent` / 请求 `glm-5.3-flash[1M]` / `effort=xhigh`（executedModel 元数据沿用交接记录：返回不含上下文后缀，1M 容量未独立核实）。独立验证执行者，非实现者；真实 GLM/TTS/天气/MCP 搜索/账号/推流预算 0，本轮**无新增真实调用**；未改实现/产品/state，未 commit/push，共享服务零触碰。总时长约 22 分钟（含收尾），单并发。

**候选与副本绑定**：`0b38f9dfda7b6c2d0e6add27f47cb2c2a0d9b196`（分支 `codex/macos-yovoice`，开始时工作树干净，与 origin 同名分支一致）；副本 `/private/tmp/dsh-validate-0b38f9d-114156/repo` 经 `git archive` 提取后 312 个跟踪文件按 git blob 哈希逐字节核验与候选一致（mismatch=0）；依赖为既有已安装 node_modules 的只读 APFS 克隆，未新装依赖；构建/测试全部仅在副本执行，共享在用 lib 未触碰。环境：Node v26.13.0、Chrome for Testing 156.0.8078.4（chromium_headless_shell-1248）、真实安装 `@deepseek-ai/*` 0.2.2-rc.1（只读）。探针复制自 `/private/tmp/feat006-r4/sc002/`（五轮 -r5 最新场景定义）到自有 `sc002/`，HOME/COPY/SESSION_FILE/EVIDENCE/VDIR 五处路径常量改指本候选副本，无 feat006-r4 残留路径；探针 SHA-256 前缀 sc002-validate-rerun.mjs `0f4236988a2976bd`、host-journey-a.mjs `3c461dd0734480ac`、host-journey-b.mjs `511fbc4ff4fdd4d7`；全新 DSH_HOME 与动态端口，旧日志未覆盖。

| 验收条件 | 结果 | 证据或缺口 |
|---|---|---|
| typecheck | PASS | `tsc -p tsconfig.json` exit 0（11:45:20–22） |
| build（四 bundle、index/agent 共享 chunk） | PASS | 副本包目录 `node build.mjs` exit 0（11:45:22）；lib/index.js 零 `@deepseek-ai/dsh-tools`/`dsh-llm` 引用（bundle 边界保持） |
| 完整相关 Vitest+coverage（一次同时证明 unit 与 coverage，排除 macosTts.test.ts） | PASS | exit 0（62.76s）：87 文件全过、605 通过、8 跳过（与主 Agent 接受记录 87/605/8 精确吻合，含其小修新增 read barrier 回归）；`--exclude test/macosTts.test.ts` 生效，两项真实 macOS 语音测试未跑、如实列 NOT_RUN；报告 `coverage/feat-006-validate/`；DSH_HOME 自有临时目录 |
| coverage-diff 基线 fd48d0a（80%行/70%分支） | PASS | exit 0：行 1951/2219（87.92%）、分支 970/1248（77.72%）；副本报告按既有方法映射路径后从仓库根执行；本轮实际分支计数与主 Agent 记录差 1（970/1248 vs 971/1249），两值均≥阈值 |
| coverage-diff 累计基线 67d4df4（FEAT-004，80%行/70%分支） | PASS | exit 0：行 3093/3430（90.17%）、分支 1675/2092（80.07%） |
| e2e-session-context（workers1/retries0/trace on，1440×900+375×812） | PASS | exit 0（11:46:27–37）：4/4，JUnit tests=4 failures=0 errors=0；fixture 停止行 `sharedRequests=0 externalRequests=0`（app=61428/model=61438/stage=61439 动态端口），native create 全部携带真实 cwd+`agentPreset=dsh-livestream` |
| 既有回归 e2e / e2e-douyin / e2e-query | PASS | exit 0：6/6（feat-001 junit）、12/12（feat-003-correction-1）、10/10（feat-004-build），failures=0/errors=0；e2e-query fixture 停止行 `sharedRequests=0 externalRequests=0`（app=61762/bridge=61780）；声音/抖音 fixture 不打印该计数器（既有风格，隔离由内部 stub/拦截承担） |
| 离线原生入口 `node test/live-query/run.mjs`（默认 offline） | PASS | exit 0（11:46:26–27）：weather_lookup 北京 limited（geocode 1/current 1/model 2，failureCode=null）＋ public_search 逐字原文「OBS Studio许可证」evidence（search 1/model 2，failureCode=null），总 model 4/mcp 1，scopesDisposed=2、cleanup finished；audio offline_not_requested |
| SC002 真实安装组合独立复跑（401/200/403；create/resume 首个 toolset 早于 onair 且无手动 bind；坏快照/首装失败回滚；真实资料/越界零正文/冻结正文；legacy 仅真 ENOENT；刷新失败永久锁定+模型请求 0+同名 global 执行 0；真双 preset 卸 A 后 B 刷新/可信工具保持） | PASS | 五阶段独立运行 exit 0（11:47:57–48:11）：24/12/18/19/25＝98 项检查 0 失败；组合为真实安装发行栈（dsh-host-webserver/client-connection/api-session-controller/attachment-local 均 0.2.2-rc.1）+候选副本 lib bundle+正式 preset 经 loader builtins 装载；真实 Skill 来源为用户级 papermorph 12167B 真实文件逐字节副本（源文件未动）、资料根为真实 lever-lab 只读 |
| 补齐检查：完整宿主跨进程 A/B 旅程（'/' 401→launch-token 303→200 SPA；owner 保存/创建；源 fixture 冻结后改写；B 原生重开 onair 前受限且不重取冻结正文；快照 mtime/size/sha 不变；R7 onair 语义） | PASS | hostA 20/20（11:48:11–14）→ hostB 25/25（11:48:14–17），均 exit 0：'/' 未认证 401、303 authority 绑定 cookie、保存 revision 3→4、真实 sessions 路由创建、header cwd=自有 workdir；冻结后变异源、快照文件 sha256/size/mtime 三项重开前后逐项相等（13133B/f5040fc7…）；hostB 首个 toolset=[show_stats, load_livestream_skill, read_livestream_material]、根 probe_global_tool 排除、冻结正文不含变异标记；冷重开 active=null（R7）→ 显式 onair 200 → active=本会话且 cwd 一致 |
| R1～R8 修正证据为实际 IO/真实组件/工具输出 | PASS | 本轮实际执行全部相关测试（605 项含 consoleStartGuard 真实组件点击零副作用、sessionContextRead afterRead 窗口 identity_mismatch、sessionContextSessions 真实 FileHandle.read 字节≤512KiB/取消先结算再分类/重复加载 body=''/R7 全序列、sessionContextSave 空容器 400+not_found）与 98+45 项发行组合检查；非仅状态码 |
| usage 锚点 | PASS | 候选 README `LIVE-SESSION-CONTEXT`/`LIVE-SKILL-LOAD`/`LIVE-MATERIAL-READ` 与 examples 指南第 5/6 条（R2/R6/R7/R8 行为）核对存在 |
| 下播 90s 道别宽限真实计时 | 边界如实记录 | 下播后 active=null 语义由单测全序列验证（endLive+finish 立即收束，sessionContextSessions.test.ts:378-400）及 E2E/hostB 开播前 null 断言；90 秒真实宽限等待本轮未执行，不以强行 finish 冒称 90s 计时通过 |
| `dsh web` CLI 顶层包装、舞台实际播放、正式观众端 | NOT_RUN（范围边界） | 发行栈为进程内组合+跨真实进程重启取证；运行期观察项保持，不外推为 live 通过 |
| 真实 GLM 样本（协议等效引用） | PASS（按协议引用，无新增真实调用） | `git diff 2b107efc..0b38f9d` 对 queryTurns/queryCredential/body 三查询文件/shared DTO/test/live-query/cordis.patch.yml/e2e-query 测试零差异；agent.ts 查询工具描述与逐字提示未动。2b107efc 的真实样本（两题 evidence、逐字原文、预算内计数）按协议引用；模型遵循为非确定假设不变，不外推到 live |

**R1～R8/N1 覆盖归因**：R1 整链身份（readDiscoveredSkill/readViaIdentifiedPath 共享身份纪律 + R1 专项替换测试）、R2 consoleStartGuard 双层、R3 discoverSkillsFromBindings 只消费保存 canonical、R4 每次读取返回/复核/提交前信号核对 + deadline 身份分类（含主 Agent 小修：组合 reason===本地 deadline.reason 判首因）、R5 IO 前按剩余预算约束 + 先结算原 turn 再分类 + 会话级 busy 独立、R6 turnEmittedSkills 同轮去重、R7 activeView 按开播状态派生、R8 空来源 not_found——均有对应真实断言测试且在本轮 605 项中实际执行；N1 旧 helper/集合删除后 605 项全绿（类型检查通过）。

**收尾**：本轮探针/测试/esbuild 进程全部退出（ps 零残留，仅存任务外既有 poki daemon）；共享 3080/3081/7390/8757 零请求（探针 fetch 钩子计数 shared=0/external=0）；共享 checkout 收尾仅按允许写边界新增两条工程验证记录；副本与日志保留于 `/private/tmp/dsh-validate-0b38f9d-114156/` 可复验。

**unresolved_items（运行期观察项，不阻塞本候选 PASS）**：macosTts.test.ts 两项真实 OS 语音（预算 0 排除）；90s 宽限真实计时；`dsh web` CLI 顶层包装；实际舞台播放与正式观众端；`ToolsService.layers` private 内部结构依赖按主 Agent 已记录的固定版本兼容边界保留，正式 Sol 复审仍按既定安排核对该依赖与失败行为；模型 1M 容量与单独 executedModel 继续未验证。

**状态请求（仅请求，不执行 mutation）**：canonical `stage:validate`，`status:awaiting_acceptance`；artifacts.changed_files＝`.sdlc-v1/context/FEAT-004.engineering.md`、本文件；evidence.commands/revision/workspace_status 见本节表格；`context_updates.project_candidates`＝[]（无仓库级稳定事实变化）。`requested_transitions`＝依次请求：

```yaml
requested_transitions:
  - operation: record-validation
    arguments:
      feature-id: FEAT-004
      result: pass
      test-command: node test/live-query/run.mjs
      commit: 0b38f9dfda7b6c2d0e6add27f47cb2c2a0d9b196
  - operation: record-validation
    arguments:
      feature-id: FEAT-006
      result: pass
      test-command: node test/live-query/run.mjs
      commit: 0b38f9dfda7b6c2d0e6add27f47cb2c2a0d9b196
```

不自称生命周期已推进、正式 review 已完成或 Feature 已发布。

### 2026-11-12 主 Agent 接受 0b38f9d 独立 Validate

主 Agent 实际核对 `/private/tmp/dsh-validate-0b38f9d-114156/repo` 的 312 个跟踪文件 Git blob 与候选 `0b38f9dfda7b6c2d0e6add27f47cb2c2a0d9b196` 全部一致；工作树只有两份允许的工程记录追加，无业务差异。原验证线程后台作业通知后的同线程续接已完成，最终 `logs/summary.txt`/`chain-final.txt` 给出各步骤 exit 0。实际日志确认 605 项相关单测、两基线差异覆盖率、四套 E2E、五阶段 98 项及 hostA20/hostB25 均通过，未检测到本任务残留进程。

接受本候选统一独立验证和规范 `requested_transitions`，由 CLI 分别记录 FEAT-004/FEAT-006 pass。两条状态中的 `node test/live-query/run.mjs` 为实际执行的代表入口，完整检查链和本条会话验收证据以上表和原日志为准。排除的两项真实 macOS TTS、未执行完整 90 秒宽限、CLI 顶层包装及舞台/观众播放继续保持明确限制；不把测试替身或 finish 收束断言外推。下一步独立 Sol 对 2b107efc 以来 delta、R1～R8/N1 及受影响契约正式复审，不预判结果。


### 正式Sol复审（2026-11-12，候选 0b38f9d，建议 changes_requested，待主 Sol 验收）

本轮为新的独立正式评审执行者，自行串行采用 qa、security、architect、server-dev、client-dev 及相关 design 视角，未 spawn、nested delegate、Workflow 或创建新线程。运行时说明明确为 T3 Code / Codex harness / `gpt-6.1-sol` / `xhigh`；本轮没有单独 executedModel 或工具返回的 target/options 配置对象，未复用历史线程元数据冒充本轮实测。已读取根 AGENTS/soul/user、`sdlc-review`、role-routing/角色卡及相关证据/usage 协议、project、REQ-006/REQ-010、两 Feature 当前有效方案；目标和源码路径无更近 AGENTS.md。结论依据当前源码、原始 Validate 和本轮边界探针，不采用实现对话或“已修好”的自评。

**入口与范围**：业务候选 `0b38f9dfda7b6c2d0e6add27f47cb2c2a0d9b196`，开始及落笔前 HEAD `a74683ff3eb6f824e15e8a29bbe5ecb4336beccd`，branch `codex/macos-yovoice`。实际 `git diff --quiet 0b38f9d..HEAD -- . ':(exclude).sdlc-v1/**'` exit 0、业务 `git status --porcelain --untracked-files=all -- . ':(exclude).sdlc-v1/**'` 为空；本 Feature state 为 validated/pass 且 validation.commit 是该候选，review pending。优先检查上次正式评审对象 `2b107efc1672b2d51aa8984ba45d5b88dd5484b3` 以来 delta、R1～R8/N1 与受影响链路，必要累计对照基线 `fd48d0a5d9a18a3759428c3286f28480630eeb9a`。

**原始证据与实际命令**：引用上文「统一独立 Validate（候选 0b38f9d）」及 FEAT-004 同日记录，不重建验证表。已读 `/private/tmp/dsh-validate-0b38f9d-114156/run-validate.sh`、`verify-blobs.mjs`、`logs/{summary.txt,chain-final.txt,check.log,build.log,vitest.log,coveragediff-004.log,coveragediff-006.log,e2e-sc.log,e2e-voice.log,e2e-douyin.log,e2e-query.log,livequery.log,sc002-phase1.log,sc002-phase2.log,sc002-phase3.log,sc002-phase4.log,sc002-phase5.log,hostA.log,hostB.log}`，并定向读取 `sc002/{sc002-validate-rerun,host-journey-a,host-journey-b}.mjs`。日志支持既有检查链 exit 0、87 文件 605 pass/8 skip、两基线覆盖、四套 E2E、五阶段 98 检查及 hostA20/hostB25；宿主 A/B 含 '/' 401→launch-token 303→200 SPA、原生冷恢复首个 toolset 早于 onair、冻结正文与快照 mtime/size/hash 保持。312 blob 对候选一致为主 Agent 已核实的版本事实，本轮未机械重跑整套验证。

实际执行了 `git diff 2b107efc..0b38f9d -- <相关生产文件>`、定向 `nl -ba`/`rg`，以及三次 `node --input-type=module` 内联最小探针（全部 exit 0）。探针用已安装 esbuild 将候选 `sessionContext.ts`/`sessionContextPaths.ts` 只读打包至自有临时目录，`./runtime` 通过显式 bundler 插件替换成仅 settings/show/hooks/dataDir 的数据替身，未 import 生产 runtime、启动服务/端口或请求外部。对照版本通过 `git show 2b107efc:...` 只读取源并在同样边界打包。仅临时 fixture 有 mkdir/write/rename/symlink；原始结果在 `/var/folders/zn/9h5xx7817g1byxssf2d_8k7w0000gn/T/dsh-sol-rereview-0b38f9d-YFL3r5/{probe-result,comparison-result,health-result}.json`，是探针原始输出，不是独立评审报告。三次均在秒内收束，没有实现/修补尝试，不消耗或重置主 Agent 已用的唯一诊断额度。

**旧发现与正常/失败链路核对**：

- R1 原 root 内中间段移出+symlink 换回的具体实例已被共享整链 walk/fd/读后核对处理；R3 原始 alias 在创建时不再参与来源解析，canonical 文件/目录绑定及直接 SKILL.md/一级容器发现规则可追踪。新整合同时引入下述 R9，以及独立新发现 R10/R11，不能据旧实例通过推定全部边界正确。
- R2 的 stateView 对 invalid 与 legacy 区分，Console 初始 null 时禁止开始、加载/修正/轮询通过 host 更新，goLive:632 在 native create/preset select/broadcast/onair 前执行实际拒绝；按钮 disabled 为补充。结合真实组件原始证据和显式修正后的 managed POST，未发现本次守卫新回归。
- R4 每次 read 返回、读后复核和 readMaterial 提交前检查组合 signal；首因按 `timeout.reason === deadlineSignal.reason` 分类，外部先取消、IO 收束前本地 deadline 也过期仍为 cancelled。R5 IO 前按剩余缓冲约束，实际已读量先结算捕获的原 turn budget，再分类；会话 inflight 独立，跨 turn 保持 busy 至真实 IO/close 收束。已核对实际 FileHandle.read 字节计数、取消后结算、跨 turn barrier 和首因回归原始测试/日志；512KiB 缓冲、32KiB 正文、单文件256KiB、4尝试/单在途/2秒保持。
- R6 历史 loaded 与本 turn 已输出集合分离，首次完整冻结正文计量、重复 body 空，execute 返回短提示，output.render 原样交给 native 消息；新 native turn 在实际 pre-step 推进并重新计量，4次/128KiB 不变。现有单元和真实工具输出 E2E 断言支持，没有新重复正文证据。
- R7 activeView 使用 show.isOnAir/currentSession 对应绑定，不依登记顺序；保存/准备/恢复不冒作 active。show.endLive 的既有 90秒道别与 finish 收束未被此次 delta 修改；原始测试的 endLive+finish 只证明收束后 null，不证明真实等待90秒。
- R8 空来源在保存的 discoverSource 分支现为 not_found，合法 canonical 重复与失败保留旧记录有原始 IO/路由断言；owner 启动/显式重查仍有下述残余。N1 的旧同步 helper/无读取集合已删除，定向 `rg` 在 src/test 均未命中旧符号；删除未移除真实身份校验或串号拒绝，未扩成清理任务。
- 旧权限链仍为 owner exact fetch → 原子 settings/revision → canonical snapshot 先落盘 → native create/resume 串行 agent/created 早绑定 → 真实首个 toolset → 每 step 实际 loader 组合检查 → 实际 execute/render；onair 仅核对 ready/platform/cwd。真实 ENOENT 才 legacy，坏快照/首装失败回滚、刷新永久锁定及双 preset 卸 A 后 B 保持均有当前原始 SC002 证据。只读核对实际 installed `@deepseek-ai/*@0.2.2-rc.1`，dsh-tools 类型的 private layers 与 lib registration.definition/chainLayers 语义匹配当前适配；缺结构拒绝/锁定路径保持，不仅因 private/any 宣告漏洞。cwd 预算、冻结 hash、index 无静态 agent 依赖、共享 bundle/runtime、平台及查询取消/归属未见本次回归。

**必须修复发现（按严重度；均为独立源码与探针事实）**：

1. **R9 / HIGH — 共用读取重新接受变化后的 canonical 根，资料可返回保存根外正文（本次引入）**。`packages/dsh-livestream/src/dsh/sessionContextPaths.ts:201`，关联 `:195-212`、`:258-267` 与 `sessionContext.ts:1299`。新的 helper 用每次 `realpath(rootPath)` 得到的当前地址作为授权边界，取消了旧资料路径的固定 canonical 根/verifyDirectory 检查；walk 只检查根本体及其以下路径。真实触发：绑定 parent/root 后把 parent 移到 moved-outside，在 parent 放指向 moved-outside 的 symlink，就地改写原 doc inode。root/末端 inode 都不变；独立 `verifyDirectory(root)` 已为 identity_mismatch，但实际 readMaterial 返回 `available` 和 `outside-after`，readBoundedFile 也 accepted=true。同样 fixture 的 2b107efc 返回 denied/零正文。违反 CFG-04、保存 canonical 绑定及 R1 共享整链边界合同。建议始终以保存/发现时固定的 canonical 根为边界，打开前后/读后核对它未改变；保留首次合法别名规范化（含 macOS /var）兼容，不能把访问时新 realpath 当重新授权。验证新增“根之上的祖先移动+symlink 换回、保留 root/末端 inode”的工具级零正文断言，并对共享 Skill helper 的调用边界核对同一规则。本轮在 runtime 替身边界直接调用候选 readMaterial 已复现，完整原生工具链未另跑；execute/render 直传该正文由静态调用链核对。不把直接 helper 的事实外推为已证明全部 Skill 生产调用可利用。

2. **R10 / MEDIUM — 创建时把不同 canonical 文件的新同名冲突静默去重（本次引入）**。`packages/dsh-livestream/src/dsh/sessionContext.ts:395`。两个文件 a.md/b.md 在保存时分别 name:first/second；保存成功后把 b.md 改成 name:first。新的文件型创建分支只看 seenNames 就 continue，prepareSnapshot 返回 ok:true、仅 first、issues=[]；同一保存记录在 2b107efc 返回409“不同来源的 Skill 同名”。目录分支仍会通过 discoverSource:271 拒绝，因此来源形状/顺序改变了同一冲突合同。违反 CFG-02/03、创建时新冲突整体拒绝及合法 canonical 去重应与同名异源区分的设计。建议先按 canonical 文件去重，不同文件同名返回 conflict，并共用目录/文件的同名判定。验证保存后变更 name 的文件/目录混合两种顺序，确认 native create/onair 零调用；同一 canonical 重叠来源继续正常去重。

3. **R11 / MEDIUM — 发现失败分支绕过 Skill 文件/总量预算（本次引入）**。`packages/dsh-livestream/src/dsh/sessionContext.ts:386`、`:424-435`。单文件 read 的 limit_exceeded 被转成“不可读”issue并继续；实测将已保存 b.md 增至65536字节以上，当前 prepareSnapshot 仍成功，旧版为409预算超限。另 discoverSource 会原地 push 已通过的前缀，遇后一个坏声明返回 invalid；调用方继续时跳过 totalBytes 结算，却保留已 push 定义。受控五个容器先各保存两个合法小声明，再各将 a.md 改成约60KB合法正文、b.md 改坏，当前创建成功，最终5份冻结正文合计300005字节（仅正文已大于262144原始总预算），issues=5；旧版在首个坏声明即409。违反既定每份64KiB/总256KiB预算及“预算超限整体拒绝、不保存部分超额候选”合同。建议单文件预算失败保持 limit_exceeded 分类，来源结果在纳入 snapshot 前明确暂存/结算，不能在失败 continue 上留下未计量正文；若允许保留合法部分，也必须按全部实际纳入定义计量。验证同时断言最终快照字节、失败分支预算和 native create零调用，不只看issue存在。

4. **R8 残余 / MEDIUM — 已保存来源变空后，owner 重查仍显示 valid（原缺陷未完全处置）**。`packages/dsh-livestream/src/dsh/sessionContext.ts:623`，关联 `:582-600`。保存一个含 SKILL.md 的来源后删除该文件、保留空目录，实际 recheckSessionContext 返回 ok:true，stateView.health.entries[0].status 仍为 valid。该分支只确认目录存在/可读，不检查任何可发现声明，启动 refreshHealth 同样经过它。保存时的空来源拒绝已成立；此处保留的是原 R8 的健康状态义务，非否定该修正或重开已解决的保存分支。违反 CFG-01/03、SCN-03/06 和 R8 的空/仅references/scripts/缺SKILL.md 为not_found要求，使 owner 重查报告可用而下一次创建实际没有 Skill。建议健康重查以现有有界发现规则至少确认声明存在，不执行 Skill/脚本、不扩展来源；合法重复 canonical 仍应 valid。验证删除SKILL.md后的重查/启动、仅references/scripts与合法重复来源，核对 owner 实际状态与创建结果一致。

**有界相关实例、工程债与可读性**：搜索限定两条读取 wrapper/共用原语及 readMaterial、两种 Skill 来源创建/保存/健康分支、实际工具 execute/render 与 owner 状态调用方。R9 在资料调用链确认，Skill 生产调用另有 verifyDirectory 预检，未据 helper 单独结果扩大结论；R10/R11 在新 canonical 单文件与容器分支出现，保存分支保留原有拒绝。新增 discoverSkillsFromBindings 与 discoverSource/原 discovery 的名称、失败和预算纪律已发生实际漂移，相关可避免重复规则的影响归入 R10/R11，不另按删行/风格增加阻塞项。除此之外，本次 diff 未发现有证据支持的重复实现或可避免工程债；代码保持正常缩进/JSX/逻辑分段，没有仅因长行或 any 要求无关重写。

**usage / design 与限制**：README 的 LIVE-SESSION-CONTEXT/SKILL-LOAD/MATERIAL-READ → REQ-010 SCN → shared schema/owner参数/Mac指南 → 现有真实 Console/原生create-resume/文件读取证据可追踪；其“symlink零正文、同名异源拒绝、失效可核对”承诺仍受上述发现影响，正常旅程不抵扣失败链。UI 按 Operate 的状态、文字反馈和语义静态检查，引用最新桌面/375px E2E；Impeccable 可加载且文件可读，未启动 launcher/浏览器或完整 critique，不声称本轮独立渲染/键盘通过。两项真实macOS TTS、完整90秒真实道别计时、dsh web CLI顶层包装、实际舞台/正式观众播放未测；旧真实GLM仅等效引用，模型非确定性、1M容量与单独executedModel未知维持。无真实外部调用/共享服务/在用lib/用户Skill与资料修改。

**结论与交接**：复审执行完整，原 R2/R4/R5/R6/R7/N1 处置及原 R1/R3 具体实例均有进展，但 R9～R11 为 delta 新回归、R8 健康状态残余未消除，故建议 FEAT-006 changes_requested；不以605项通过抵消这些独立可复现触发。发现批量交主 Sol 接收，不实现、不重新启动推测修补链，既有失败历史与诊断额度已用事实保持。`stage: review`、`status: awaiting_acceptance`；`project_candidates=[]`。只请求 `record-review --feature-id FEAT-006 --decision changes_requested --by sdlc-review-sol-0b38f9d-20261112`，未执行 lifecycle mutation、Git写入/推送、部署或宣称目标完成。

### 2026-11-12 主 Agent 接受 0b38f9d 复审：R9/R10/R11 与 R8 残余

主 Agent 核对当前读取 helper、canonical 来源合并与健康重查调用链，接受独立 Sol 的 FEAT-004 approved、FEAT-006 changes_requested 请求。R9 为本轮共同 helper 对根重新 realpath 定义边界的新回归；R10/R11 为创建时按来源分支合并的冲突及错误出口问题；R8 残余为健康重查仍只检查目录存在。以上均有新的明确因果证据，本次不重复打开无新证据的旧发现，不执行新的主 Agent 诊断实验。

同一实现者按下列当前有效方案补充约束继续修正，保留此前失败历史和唯一主 Agent 诊断额度已用事实。旧候选独立 Validate 的通过只覆盖其实际场景；新的边界需要失败先行及对应零正文/原子合并/原生创建零调用/重查状态证据。FEAT-004 当前批准仍不独立发布，统一组合等待 FEAT-006 最终候选重建验证和复审。

### 2026-11-12 六轮实现与验证（同执行者，R9～R11 + R8 残余逐项处置完成，awaiting_acceptance）

执行环境同前（T3 `claudeAgent` / 请求 `glm-5.3-flash[1M]` / `effort=xhigh`；executedModel 元数据同前，1M 容量未验证）。起点 HEAD `d24dc4b529538b8150cac1e81ef8bb57e44ca755`（干净树，业务源码等同 `0b38f9d`+主 Agent 小修）；本轮 dirty 仅 5 个文件（sessionContext.ts、sessionContextPaths.ts 与三个 sessionContext 测试），无 Git 写、无 lifecycle mutation、共享服务/在用 lib 零触碰、真实外部调用预算 0。隔离副本 `/private/tmp/feat006-r6/repo`（312 项起始清单与目标一致 `a68e3ecf…b534a`；收尾 `45f5969e…fb384` 目标与副本一致）。Sol 复审探针目录 `/var/folders/…/dsh-sol-rereview-0b38f9d-YFL3r5/` 只读引用，未重做根因实验；四个 failing-first 红状态全部实测（R9 根外正文 available 红、R10 混合同名 200 红、R11 超限仍 200 红、R8 重查 valid 红），红因逐条核对。

**R9 HIGH 固定 canonical 边界**：`readViaIdentifiedPath` 移除读取时 `realpath(rootPath)` 重新定义边界的逻辑，改为调用方传入**绑定/保存时固定的 canonical 根**（`options.canonicalRoot`）：打开前后（`realpath(rootPath) === canonicalRoot` 核对，等价恢复 verifyDirectory 的祖先保护）与读后（rootReal 再核 + targetAfter withinRoot）均对固定边界。`readBoundedFile` 传 `request.root.path`（bindDirectory 时已规范化）；`readDiscoveredSkill` 首参改为 canonicalRoot（discoverSource/discoverSkillsFromBindings 传 canonical 绑定路径）。测试：parent 移出+symlink 换回+root/末端 inode 保持 → identity_mismatch/escape 零正文（修复前返回根外正文 available）；合法首次 canonical 化（alias→bindDirectory→canonical 路径读取）正例保留。discovery-time 测试套件 dir 改为真实 realpath（bind 语义），不以 raw /var 冒充 canonical。

**R10 MEDIUM 异源同名静默去重**：新增统一合并收集器 `mergeDiscoveredSource` + `SkillMergeState`——按 canonical 来源身份（file 绑定=binding.file、目录=binding.path）去重；`nameToSource` 映射检冲突：同名不同 canonical 来源 → 硬 conflict 整体拒绝；同 canonical 重复合法去重（含 16 份边界与路径包含去重：文件已在其目录来源内发现时不重复计）。文件/目录共用同一合并判定，不再按 seenNames 单独去重。测试：file/file 同名改写 → 409 同名 + native 0 + 恢复后可用；dir/file 与 file/dir 两种形状方向 → 409；同 canonical alias 替换入口 → 保存/创建仍成功且 16 份不重复。

**R11 MEDIUM 失败分支绕过预算**：`discoverSourceAtomic` 原子来源发现（结果只写局部集合，失败不污染全局 defs/seenPaths/名称/总量）；文件 read `limit_exceeded` 恢复为硬失败整体拒绝（不再降级「不可读」）；无效格式（parse 失败）创建时整体拒绝；merge 点原子结算唯一数量/总原始字节（含 frontmatter）；`prepareSnapshot` 在转换/持久化快照前对最终唯一集合再校验（`validateMergedSkills`：数量/字节/名称唯一/单文件上限）。保存路径 `discoverSkills` 同一收集器（保存分支原有拒绝语义保持）。测试：单文件超 64KiB → 409 `Skill 文件超过` + native 0；容器前缀合法后 b.md 坏声明 → 409 声明无效 + native 0；五容器 a.md 各 ~55KB 合法 → 409 `Skill 原始字节合计超过 262144` + native 0。

**R8 残余 MEDIUM 重查只查目录存在**：`discoverSkillsForHealth` skill 分支重写——从保存 canonical 绑定执行 `discoverSkillsFromBindings` 有界发现/校验，按 `sourceStatus` 报告真实声明状态（删除 SKILL.md/空/仅 references → not_found；绑定失效 → invalid；合法重复 canonical（无独立绑定的条目按 realpath 比对绑定）→ 同状态 valid）；整体硬失败（冲突/预算）如实标记 conflict/invalid。重查只更新健康诊断，不改 config/revision/bindings/active/frozen body，不跟随 raw alias 重定向（alias 重指向后 realpath 不匹配任何绑定 → not_found）。资料根保持目录存在性检查（合同即目录只读授权）。测试：删声明后 recheck → not_found，settings 字节与 revision 不变、active null、创建路径同诊断（无 Skill）；恢复声明 → valid；合法重复两 entry 全 valid。recheck 限频窗口用真实 1.1s 流逝（该用例本身测真实时钟限频）。

**验证（隔离副本，最终代码，全部 exit 0）**：check；build（四 bundle、宿主 bundle 零 dsh-tools/dsh-llm）；vitest+coverage（`--exclude test/macosTts.test.ts`，2 项真实 OS 语音未跑如实列明）87 文件 **615 通过/8 跳过**；coverage-diff fd48d0a **行 2048/2318（88.43%）、分支 1032/1325（77.89%）** ≥80/70；E2E 四套 **4/4、6/6、12/12、10/10**；offline-query exit 0（2 场景 failureCode=null）；SC002 五阶段 **24/12/18/19/25 全 0 failures** + **hostA 20/20 + hostB 25/25**（R7/R9 断言保持，复用 0b38 validate 定义于自有目录，旧日志不覆盖）。

**资源收尾**：进程全部退出；共享端口零触碰；证据保留于 `/private/tmp/feat006-r6/`。**移交状态**：`stage: build`，`status: awaiting_acceptance`；requested_transitions 同前（set-task-status done，仅请求）。

### 2026-11-12 六轮接收核对：R10 实际声明去重与 R8 逐条绑定残余

主 Agent 核对 HEAD d24dc4b529538b8150cac1e81ef8bb57e44ca755 下的六文件 WIP 与 `/private/tmp/feat006-r6/source-hashes.txt`：312 项在目标及隔离副本均逐字节一致，清单 SHA-256 为 993a17684563b52da5c3dae068a50e59e58937e04855a4ec31aa5c6ce19b1e1f；实际日志含 87 文件、615 通过/8 跳过及四套 E2E 4/6/12/10。此核对不冒称新执行或正式 Validate。

第六轮已补固定 canonical 根、原子来源与硬预算拒绝，有明确验收进展；但当前不接受 done。静态源码因果核对确认两处残余：(1) mergeDiscoveredSource 使用 mergedDirRoots 前缀过滤，将目录来源未实际发现的更深显式文件也静默丢弃，独立名称和同名异源均受影响；(2) validateSaveCandidate 将重复来源的绑定行去重，健康检查对缺失 index 重解 raw alias，文件型又把文件 realpath 与父目录 binding.path 比较，合法重复单文件也会错误 not_found；资料根重查同样重解 raw alias。以上依据实际控制流，无新增主 Agent 诊断实验。

已在当前有效方案中明确逐条绑定与实际资源去重规则，交同一 GLM 实现者集中修正并做必要验证。保留此前全部失败历史、唯一主 Agent 诊断额度已用事实与外部调用预算 0；不重开已无新证据的发现，不修改生命周期状态。

### 2026-11-12 七轮实现与验证（同执行者，逐条绑定/实际声明去重 + R8 绑定健康处置完成，awaiting_acceptance）

执行环境同前（T3 `claudeAgent` / 请求 `glm-5.3-flash[1M]` / `effort=xhigh`；executedModel 元数据同前，1M 容量未验证）。HEAD `d24dc4b` 不变；本轮在六轮 WIP 上继续，dirty 仍为同一组文件（sessionContext.ts、sessionContextPaths.ts、三个 sessionContext 测试、engineering.md 等）。隔离副本沿用 `/private/tmp/feat006-r6/repo`（收尾 312 项清单与目标一致）；验证/日志用 `r7` 后缀与 `/private/tmp/feat006-r7/sc002/`（探针定义复用 0b38 validate，COPY 绑定当前候选 r6 副本构建产物，数据/日志独立，旧证据不覆盖）。

**failing-first（六项红全部实测红因）**：深层显式文件被目录前缀静默丢弃（[container-skill] ≠ 两项）；同名异源保存 200 未拒；逐条绑定被去重（bindings.roots 长度 1 ≠ 3）；孤儿条目 issue 为空；健康重复条目误报 not_found / valid。

**逐项处置**：

1. **实际声明路径去重（R10 残余）**：`mergeDiscoveredSource` 移除 `mergedDirRoots` 前缀过滤——直接含 SKILL.md 的容器不会发现更深文件，深层显式文件是独立来源；去重只按「实际已合并的 canonical 声明文件路径」（mergedPaths）+ seenSourceIds（同 canonical 来源重复）。名称冲突按声明身份（nameToSource ≠ 本来源）整体拒绝。测试：容器（直接 SKILL.md）+ 深层显式文件两种顺序都加载两个独立名称；同名后保存 400/创建 409 + native 0；同实际文件重叠（容器+内层文件绑定）仍一份定义、限额计一次。
2. **逐条绑定保留（R10/绑定归属）**：`validateSaveCandidate` 对每个启用 Skill 条目无条件保留 index 绑定（文件型含父目录+file；目录型含 canonical 目录）；重复 canonical 资料根条目同样逐条保留 roots 绑定。schemaVersion=1/decodeBindings 原格式支持，无新字段/迁移。
3. **健康按保存绑定（R8 残余）**：`discoverSkillsForHealth` skill 分支按 `record.bindings.skills.find(index)` 取绑定，状态来自 `discoverSkillsFromBindings` 的 per-index `sourceStatus`（canonical 绑定有界发现）；**绝不 realpath/bindDirectory raw entry.path 找孪生或替换授权**（r6 的 twin/realpath 逻辑删除）。alias 重指向另一个已绑定目标后重查：各条目仍按各自保存绑定 valid、路径为各自固定 canonical（不跟随 alias 新目标）；删除 A 的 SKILL.md 后 A 及其 alias 条目均 not_found，而独立 B 保持 valid。资料根健康同样按保存绑定 verifyDirectory 固定 canonical（不再 bindDirectory raw path）；重复条目各 valid。
4. **历史孤儿条目（缺 index 绑定）**：健康 → `not_found` + 「当前保存记录中没有该条目的独立绑定：请重新保存会话设置」；创建 → 对应 issue（「请重新保存会话设置」），只把显式绑定的安全资源纳入快照，不重解 raw alias、不降级 legacy；资料根孤儿条目同样处理。测试：构造 config 两启用条目 + bindings 仅 index0 → 创建 200 管理会话、issue 含 orphan 与 resave 指引、快照无 orphan-skill；重查 entry not_found + resave 指引。
5. **资料授权去重（R8/授权）**：`prepareSnapshot` 按 `seenRootGrants`（canonical path）去重——重复根条目复用同一 grant，不产生重复 rootId；rootId 按唯一授权序号分配。测试：materials×2 + materials-2 → 持久快照 rootBindings 恰 2 个（root-1/root-2）、create 响应 rootIds 同、root-1 读取 available。

**验证（隔离副本，最终代码，全部 exit 0）**：check；build（四 bundle、宿主 bundle 零 dsh-tools/dsh-llm）；vitest+coverage（`--exclude test/macosTts.test.ts`，2 项真实 OS 语音未跑如实列明）87 文件 **622 通过/8 跳过**；coverage-diff fd48d0a **行 2039/2310（88.27%）、分支 1038/1322（78.52%）** ≥80/70；E2E 四套 **4/4、6/6、12/12、10/10**；offline-query exit 0（2 场景 failureCode=null）；SC002 五阶段 **24/12/18/19/25 全 0 failures** + **hostA 20/20 + hostB 25/25**。

**资源收尾**：进程全部退出；共享端口零触碰；证据保留于 `/private/tmp/feat006-r6/`（实现副本）与 `/private/tmp/feat006-r7/sc002/`（探针/日志）。

**移交状态**：`stage: build`，`status: awaiting_acceptance`；requested_transitions 同前（set-task-status done，仅请求）。

### 2026-11-12 主 Agent 接受第六、七轮 Build，准备最终候选

主 Sol 核对最终源码 diff、固定 canonical 边界、原子合并/硬预算、实际声明路径去重、逐条绑定与按绑定重查、历史缺绑定诊断及唯一资料授权。312 项清单与目标/隔离副本逐字节一致（SHA-256 4fd0d7b847a16a26c08c8c0739165a9e9c54625f81a5214d62dd6fc1b8622896），原始 r7 日志确认 check/build、87 文件 622 通过/8 跳过、差异行 2039/2310=88.27%/分支1038/1322=78.52%、四套 E2E 4/6/12/10、offline-query 双 failureCode=null、SC002 五阶段98与跨宿主45项全部通过。git diff --check 通过；任务路径进程检查无残留。未重复执行实现者已在同输入上完成的整套检查；正式独立 Validate 另行实际执行。

T3 终态确认 completed、无活动下级；请求/实际元数据为 claudeAgent、glm-5.3-flash[1M]、effort=xhigh，executedModel=glm-5.3-flash，1M 容量仍未验证。接受 FEAT-006-T001 done 请求，后续仅以最终已提交业务候选重建 FEAT-004/006 的独立 Validate 与 fresh Sol Review。此为 Build 验收，不是正式批准或发布。实现者误追加的重复七轮记录已合并为一份；此后差异仅为工程记录及主 Agent 生命周期更新。既有失败史、主 Agent 诊断额度已用及真实外部预算0不变；macOS真实语音两例、90秒实计时、CLI包装、舞台/观众播放继续如实列为未测边界。

### 统一独立 Validate 重建（2026-11-12，通过：最终组合候选 5aa3354 全部必要检查通过）

执行环境：T3 `claudeAgent` / 请求 `glm-5.3-flash[1M]` / `effort=xhigh`；验证执行者未取得该字段；主 Agent 收尾 task_status 实际返回 executedModel=glm-5.3-flash，target/options 为 claudeAgent / glm-5.3-flash[1M] / effort=xhigh；1M 容量仍未验证，未静默切换模型。独立验证执行者，非实现者；真实 GLM/TTS/天气/MCP 搜索/账号/推流预算 0，本轮**无新增真实调用**；未改实现/产品/state，未 commit/push，共享服务零触碰。前置负载检查：load 1.80、共享 3080/3081/7390/8757 无监听；初始并发 1。时间线：13:27 前置核对 → 13:27–13:29 副本/依赖/探针准备 → 13:29:18–13:32:20 全链 18 步实际执行。

**候选与副本绑定**：`5aa3354b15079539bb6bd02b99edad91c66226aa`（分支 `codex/macos-yovoice`，origin 同名分支一致，开始时工作树 porcelain=0）。副本 `/private/tmp/dsh-validate-5aa3354-132700/repo` 经 `git archive 5aa3354` 提取，**312 个跟踪文件按 git blob 哈希逐字节核验（verified=312 mismatch=0）**；相对 0b38f9d 的业务 delta 仅 `sessionContext.ts`/`sessionContextPaths.ts` + 3 个测试文件（另 SDLC 文档/state），查询面文件零差异。依赖为既有已安装 node_modules 的只读 APFS 克隆（`cp -Rc`，根 274M＋包 80K；vitest 3.2.4 解析正常），未新装依赖；构建/测试全部仅在副本执行，共享在用 lib 未触碰（mtime 保持 2026-11-10 14:48）。环境：Node v26.13.0；真实安装 `@deepseek-ai/*` 0.2.2-rc.1（只读，解析钩子指向 harness node_modules）。**runner/探针哈希（SHA-256 前 16 位）**：`run-validate.sh b82cdb9d0dbe58b5`、`hook.mjs a7a5bcad7343f679`、`host-journey-a.mjs 3f112f315aee7b4a`、`host-journey-b.mjs 08c6f059c2114e6d`、`register.mjs d593bf49d6b2ae77`、`sc002-validate-rerun.mjs b479f5b679caf5ca`；探针复制自 `/private/tmp/feat006-r7/sc002/`（最新已接受场景定义）改指本候选副本，无 r6/r7 残留路径；全新 DSH_HOME 与动态端口，旧日志未覆盖。

| 检查（验收条件） | 结果 | 证据或缺口 |
|---|---|---|
| typecheck | PASS | `tsc -p tsconfig.json` exit 0（13:29:18–19） |
| build（四 bundle、index/agent 共享 chunk） | PASS | 副本包目录 `node build.mjs` exit 0（13:29:19–20）；lib/{index,agent,client,stage}.js＋chunks＋stage/index.html 存在；`lib/index.js` 零 `dsh-tools`/`dsh-llm` 引用（bundle-check exit 0） |
| 完整相关 Vitest+coverage（一次同时证明 unit 与 coverage，排除 macosTts.test.ts） | PASS | exit 0（13:29:20–13:30:30，69.45s）：**87 文件全过、622 通过、8 跳过**，与预期 87/622/8 精确吻合；报告 `coverage/feat-006-validate/`；DSH_HOME 自有临时目录。R9～R11/R8 残余与逐条绑定/深层显式文件回归（真实 IO/组件断言，如中间段移出+symlink 换回零正文、per-index 绑定、取消先结算再分类、同轮去重正文、空容器 400+not_found）均在 622 项中实际执行；两项真实 macOS 语音 NOT_RUN（预算 0 排除） |
| coverage-diff 基线 fd48d0a（80%行/70%分支） | PASS | exit 0：行 2039/2310（88.27%）、分支 1039/1323（78.53%）；副本报告按既有方法映射路径后从仓库根执行 |
| coverage-diff 基线 67d4df4（FEAT-004，80%行/70%分支） | PASS | exit 0：行 3181/3521（90.34%）、分支 1745/2168（80.49%）；同一映射报告，不与 006 基线混用 |
| e2e-session-context（workers1/retries0/trace on，1440×900+375×812） | PASS | exit 0（13:30:30–40）：4/4，JUnit tests=4 failures=0 errors=0；fixture 停止行 `sharedRequests=0 externalRequests=0`（feat-006-build，动态端口） |
| 既有回归 e2e / e2e-douyin / e2e-query | PASS | exit 0：6/6（13:30:40–50）、12/12（13:30:50–13:31:14）、10/10（13:31:14–59），JUnit failures=0/errors=0；e2e-query fixture 停止行 `sharedRequests=0 externalRequests=0`（feat-004-build，app/model/stage/bridge 动态端口）；voice/douyin fixture 不打印该计数器（既有风格，隔离由内部 stub/拦截承担） |
| 离线原生入口 `node test/live-query/run.mjs`（默认 offline） | PASS | exit 0（13:30:30）：weather_lookup({location:"北京"}) limited（geocode 1/current 1/model 2，**failureCode=null**，limited 说明「区域内没有可确认时间的气温观测站」）＋ public_search **逐字原文**「OBS Studio许可证」evidence（search 1/model 2，**failureCode=null**，来源 github.com/obsproject/obs-studio）；总 model 4/mcp 1/geocode 1/current 1，synthesis 0，audio offline_not_requested，scopesDisposed=2、cleanup finished、homeRemoved=true |
| SC002 真实安装组合独立复跑（401/200/403；create/resume 首个 toolset 早于 onair 且无手动 bind；坏快照/首装失败回滚；冻结正文/允许读取/越界零正文；legacy 仅真 ENOENT；刷新失败永久锁定+模型请求 0+同名 global 执行 0；真双 preset 卸 A 后 B 刷新/可信工具保持） | PASS | 五阶段独立运行 exit 0（13:31:59–13:32:14）：**24/12/18/19/25＝98 项检查 0 失败**；组合为真实安装发行栈（`@deepseek-ai/*` 0.2.2-rc.1）+候选副本 lib bundle+正式 preset 经 loader builtins 装载；每阶段收束行 `model budget stays local-only :: shared:0 external:0`；真实 Skill 来源为用户级 papermorph 12167B 真实文件逐字节副本（源文件未动）、资料根为真实 lever-lab 只读 |
| 补齐检查：完整宿主跨进程 A/B 旅程 | PASS | hostA **20/20**（13:32:14–17）→ hostB **25/25**（13:32:17–20），均 exit 0：'/' 未认证 401 → launch-token 303 authority 绑定 cookie → SPA 200；owner 保存 revision 3→4、真实 sessions 路由创建管理会话（header cwd=自有 workdir、绑定 ready）；真实 turn 落盘后变异源副本、冻结快照文件 sha256/size/mtime 重开前后逐项相等（13133B/aee691d3…）；hostB 原生冷重开（无手动 bind/restore/onair 前置）onair 前首个 toolset=[show_stats, load_livestream_skill, read_livestream_material]、根 probe_global_tool 排除、冻结正文不含冻结后变异标记（未重取）；允许读取真实资料、越界拒绝零内容；**R7：冷重开 active=null → 显式 onair 200 → active=本会话且 cwd 一致**；saved revision 跨重启保持、未认证 /api 仍 401 |
| R1～R11/N1 修正覆盖归因 | PASS | R9 固定 canonical 根（ancestor 移出+symlink 换回零正文测试在本轮 622 项中执行）、R10 异源同名 409/合法去重/深层显式文件独立名称、R11 硬预算整体拒绝（native 0）、R8 残余按保存绑定重查（删声明 not_found/重复 valid/alias 不重解）、R4/R5 结算与跨 turn 隔离、R2 consoleStartGuard、R6 同轮去重、R7 activeView、N1 旧 helper 删除后全绿——均由本轮实际测试与 98+45 项发行组合检查支撑，非仅状态码 |
| usage 锚点 | PASS | 候选 README `LIVE-SESSION-CONTEXT`/`LIVE-SKILL-LOAD`/`LIVE-MATERIAL-READ`（128–130 行）与 `LIVE-QUERY-WEATHER`/`SEARCH`/`CONTROL`（119–121 行）存在；`examples/macos-yovoice/README.md`「天气与公开资料查询」「新直播会话」章节核对 owner 入口、参数来源（shared schema/owner 输入）、空 cwd 默认、保存→新建生效、R2 invalid 禁用开始、R6 同轮同名只注入一次、R7 活动跟随开播、R8 空来源不能保存及受限读取/拒绝行为；代表操作与 E2E/发行组合证据对应 |
| 真实 GLM 样本（协议等效引用） | PASS（按协议引用，无新增真实调用） | `git diff 0b38f9d..5aa3354` 核对：queryTurns/queryCredential/body readOnlyQuery/weather/weatherCache、shared/readOnlyQuery、test/live-query、cordis.patch.yml、test/e2e-query **零差异**；agent.ts 未在本次 delta 中（delta 仅 sessionContext 两文件+3 测试）。0b38f9d 验证按协议引用的 2b107efc 真实样本（两题 evidence、第 2 题逐字原文、预算内 model 4/4、mcp 1/2、tts 0）对本候选继续按协议引用；模型遵循为非确定假设不变，不外推到 live |
| 舞台/观众播放、真实服务全链路、`dsh web` CLI 顶层包装、90s 真实宽限计时 | NOT_RUN（范围边界） | tts:0/合成 0；发行栈为进程内组合+跨真实进程重启取证；运行期观察项保持，不外推为 live 通过 |

**验收条件对应**：CFG-01→SC002 phase1 真实准入 401/200/403＋e2e-session-context owner 路由＋consoleStartGuard 组件断言；CFG-02→hostA 保存 revision 3→4/hostB 重启恢复 saved revision＋原子保存/revision 测试；CFG-03→SC002 冻结正文 sourceHash=真实文件 SHA＋R10/R11/R8 残余与逐条绑定/深层显式文件测试＋hostB 冻结正文不重取；CFG-04→SC002 允许/越界零正文＋R9 祖先替换零正文＋预算结算测试；CFG-05→phase3 legacy 仅真 ENOENT＋phase4/5 平台刷新与注册隔离＋livequery/e2e-query 查询兼容回归；SC-001/002→四套 E2E＋98 项发行组合＋hostA20/hostB25；SCN-01～07 全部有上述对应证据。旧 PR/评审等状态查询不受影响。

**收尾**：本轮探针/测试/esbuild 进程全部退出（ps 零任务残留，仅存任务外既有 poki daemon）；共享 3080/3081/7390/8757 零请求（探针 fetch 钩子 shared=0/external=0，本机检查无对这些端口的任务监听）；key 泄漏扫描 logs/evidence 无命中；共享 checkout 写入记录前 porcelain=0，写入后仅两条允许的工程记录修改；副本与日志保留于 `/private/tmp/dsh-validate-5aa3354-132700/` 可复验。

**unresolved_items（运行期观察项，不阻塞本候选 PASS）**：macosTts.test.ts 两项真实 OS 语音 NOT_RUN（预算 0 排除）；90s 道别宽限真实计时；`dsh web` CLI 顶层包装；实际舞台播放与正式观众端；`ToolsService.layers` private 内部结构依赖按主 Agent 已记录的固定版本兼容边界保留，正式 Sol 复审仍按既定安排核对该依赖与失败行为；模型 1M 容量未验证（executedModel 由主 Agent 收尾返回值核实）。

**状态请求（仅请求，不执行 mutation）**：canonical `stage:validate`，`status:awaiting_acceptance`；artifacts.changed_files＝`.sdlc-v1/context/FEAT-004.engineering.md`、本文件；evidence.commands/revision/workspace_status 见本节表格与 summary 日志。`context_updates.project_candidates`＝[]（无仓库级稳定事实变化）。`requested_transitions`＝依次请求：

```yaml
requested_transitions:
  - operation: record-validation
    arguments:
      feature-id: FEAT-004
      result: pass
      test-command: node test/live-query/run.mjs
      commit: 5aa3354b15079539bb6bd02b99edad91c66226aa
  - operation: record-validation
    arguments:
      feature-id: FEAT-006
      result: pass
      test-command: pnpm exec e2e run --config e2e-session-context.config.ts --workers 1 --retries 0
      commit: 5aa3354b15079539bb6bd02b99edad91c66226aa
```

不自称生命周期已推进、正式 review 已完成或 Feature 已发布。

### 2026-11-12 主 Agent 接受 5aa3354 独立 Validate

主 Sol 核对 git archive 副本的312项 Git blob，全部与候选5aa3354b15079539bb6bd02b99edad91c66226aa一致；summary.txt及18份exitcode文件均为0，差异覆盖率双基线、622通过/8跳过、四套E2E、SC00298项与跨宿主45项有原始日志。当前HEAD仍为候选，业务工作树干净，仅两份允许的工程记录追加，git diff --check通过，任务路径进程零残留。当前产品决定和有效方案未在验证后改变；本轮覆盖逐条绑定/固定canonical与实际声明去重义务，旧业务候选通过未抵扣本次独立执行。

接受工程正文canonical requested_transitions，依序记录FEAT-004与FEAT-006 pass并绑定同一业务候选；随后进入fresh Sol正式复审。元数据按本轮task_status返回值补证，不从历史模型标签推断；两项真实OS语音、90秒实计时、CLI顶层与实际舞台/观众播放仍维持未测边界。此为Validate验收，不是Review批准或发布；失败历史与主Agent诊断额度已用事实保持。


### Fresh 独立正式 Sol Review（2026-11-12，候选 5aa3354，建议 changes_requested，待主 Sol 验收）

本轮为全新独立正式 review，自己串行采用 qa、security、architect、server-dev、client-dev 和相关 design 视角；未 spawn、followup、嵌套 delegate、Workflow 或创建顶层线程。已读取当前根 soul/user/AGENTS、指定 sdlc-review、stage-agent-protocol、receiving-feedback、role-routing/角色卡、相关 validation/usage 协议、project、REQ-006/REQ-010 与两 Feature 当前有效方案；目标及相关子路径没有更近 AGENTS。实际 `t3_thread_configure({})` 返回 instanceId=codex、model=gpt-6.1-sol、options=[{id:reasoningEffort,value:xhigh}]，宿主 runtime_info 同为 Sol/xhigh；独立 executedModel 字段未返回，标为未验证，未借旧模型标签或推断容量替代。结论来自当前 artifact、源码及原始证据，不采用实现者的正确性结论。

**入口与范围**：checkout `/Users/mac/hansen_agent_team/workspace/20261109-deepseek-harness/dsh-livestream`，branch `codex/macos-yovoice`；开始与落笔前 HEAD `79d74798276614b621d9b6ec367f704af2fd6a2e`。业务候选 `5aa3354b15079539bb6bd02b99edad91c66226aa`；`git diff --quiet 5aa3354..HEAD -- . ':(exclude).sdlc-v1/**'` exit 0，业务及全树 git status 为空。两个 Feature 的 validation=pass、commit=该候选、review=pending、Tasks=done 已自行从 state 核实。优先检查 `git diff --unified=5 0b38f9d..5aa3354 -- packages/dsh-livestream/src/dsh/sessionContext{,Paths}.ts`、三份相关测试及 R8～R11，必要累计核对 FEAT-006 基线 fd48d0a5d9a18a3759428c3286f28480630eeb9a 与 FEAT-004 基线 67d4df44e3c119b5a799029913cdef6c29c73aeb。业务 delta 只有两份生产文件与三份测试，其余是 SDLC；未发现课程等无关 scope drift。

**复用的验证与本轮实际检查**：引用上文「统一独立 Validate 重建（最终组合候选 5aa3354）」及 FEAT-004 同日记录的现有表，不另建报告/评分/验收表。已读 `/private/tmp/dsh-validate-5aa3354-132700/{run-validate.sh,verify-blobs.mjs}`、`logs/summary.txt`、18 份 exitcode、check/build/bundle-check/Vitest/双基线覆盖、四套 E2E、livequery、sc002-phase1..5 和 hostA/B 原始日志，及 `sc002/{register,hook,sc002-validate-rerun,host-journey-a,host-journey-b}.mjs` 的组合、身份、断言和网络拦截。实际另以 `git ls-tree -r 5aa3354` + Python Git blob SHA-1 核 archive 副本，312 项 mismatch=0；18 个 exitcode 全为 0（均 exit 0）。622/8、双基线 88.27%/78.53% 与 90.34%/80.49%、E2E 4/6/12/10、SC002 98、hostA20/B25 有日志支持。真实安装组合含 owner 401/200/403、首个 toolset 早于 onair、跨真实进程恢复、冻结文件 mtime/size/hash 保持、首装失败回滚、刷新永久锁定零模型/同名 global 执行、卸 A 后 B 保持；未把它们等同于顶层 CLI 或 live 播出。本轮没有重跑完整 suite。

实际按 hook 的 createRequire 路径解析 installed dsh-tools/dsh-api-session-controller/dsh-client-connection/dsh-scope，均为 sibling harness 的 0.2.2-rc.1。核对 dsh-tools `lib/types/index.d.ts:38` 的 private layers、`lib/index.js:433` registration.definition、`:453` restriction/`:478` view，以及 dsh-scope `lib/index.js:162` chainLayers 的远到近顺序；与 agent.ts:97/118/138 的 definition 身份校验和失败策略相符。layers 确属 private 固定版本内部依赖；当前源事实与真实 SC002 支持其实际语义，结构缺失/抛错走首装拒绝或刷新锁定，不按名称放行。因此未仅因 private/any 提出漏洞。升级或内部结构变化是重新核实触发条件。

**已知发现与受影响正常/失败链**：

- **R9**：shared read 原语固定 canonicalRoot，读前 rootReal 与读后 rootRealAfter 都必须等于保存边界，目标 containment 不使用变化后 realpath 重新授权。bindDirectory 只在首次合法别名输入规范化。核对两 wrapper、verifyDirectory、readMaterial 与真实 ancestor-above-root/同 inode/首次 alias 测试，未见原具体逃逸残余；不声称 Node 检查是内核 sandbox。
- **R10**：单来源先独立成功，统一 merge 使用实际声明 sourcePath 集合及名称冲突检查。直接 SKILL.md 容器不吞掉未发现的更深显式文件；文件/目录两种顺序的同名异源仍拒绝，重叠同 canonical 声明去重。已读深层显式文件、混合顺序冲突、合法重叠与 native 零调用测试，不再只按目录前缀或名称丢弃。
- **R11 原文件/总量与原子性问题**：单文件 limit_exceeded 保持硬失败；无效格式/冲突拒绝；目录局部集合失败不污染全局；merge 和快照转换前核对 raw 字节（含 frontmatter）、64KiB/256KiB/16 份。缺失/不可读可降级且丢弃该源整体。已读超64KiB、坏声明前缀、超256KiB和16份边界测试，原字节与部分定义问题未发现残余。另有下述独立时间预算发现，不能以这些通过证明 5 秒截止也成立。
- **R8**：新保存为每个启用 index 保留 canonical 绑定；创建的根授权再按已验证 canonical 去重成唯一 rootId。健康按保存的 index 绑定发现声明，不再重解 raw alias；删除声明/空容器为 not_found，合法重复 valid，历史缺 index 绑定给 resave 诊断并保持 managed。核对 shared v1 decoder、save/create/recheck 流程和 alias 改指另一已绑定目标、历史孤儿条目、重复根及 settings 字节不变测试。refresh 只改内存健康，不改 revision/bindings/活动或冻结正文。
- 必要累计链仍是 owner exact fetch → 校验/同步 revision/原子 settings → 捕获完整保存版本 → 快照先落盘 → preset 串行 agent/created 恢复/限制 → 首个 native toolset → pre-step 当前组合与真实 turn → execute/render。invalid Console 开始守卫早于 native/preset/broadcast/onair，legacy 仅真缺配置/快照；坏正文 hash 与首装失败拒绝，失败刷新保留限制并锁定，可信注册归属按实例。资料取消/timeout 首因、实际 IO 先记原 turn、跨 turn busy 至 close、Skill 同轮正文去重/新轮计量、active 按真实 onair/currentSession 的实现及现有原始测试已定向核对；无本次回归证据，不重新打开已解决问题。FEAT-004 查询面在本 delta 零差异，兼容性结论见其本轮 review。

**必须修复：R12 / MEDIUM — 最后一个来源的慢读取越过 5 秒后仍可成功创建，新增健康重查复用同一缺口。** 位置 `packages/dsh-livestream/src/dsh/sessionContext.ts:445` / `:447`、`:503`、`:517`，关联保存分支 `:378`/`:414`/`:423`、新健康入口 `:682` 及 `sessionContextSessions.ts:79`/`:95`。deadline 只在外层来源循环入口核对；discoverSourceAtomic 的内部候选循环与 readDiscoveredSkill 没有扫描 deadline/signal，最后一次 await 后到 merge/finalCheck/成功出口也不检查时间。只有一个来源或最后一个来源的最后读取变慢时，超时不会成为 limit_exceeded，仍写预备快照并进入 native create。新健康重查也会等待超时扫描后显示 valid。违反当前有效方案的「发现整体 5 秒、硬预算超限整体拒绝、native create 零调用」以及本次中性 brief 明确的所有出口预算要求；这不是个人性能偏好。

**可复现证据与归因**：在自有目录 `/var/folders/zn/9h5xx7817g1byxssf2d_8k7w0000gn/T/dsh-sol-review-5aa3354-l600go/`，用现有 esbuild@0.28.2 将已核 blob 的候选副本源码只读打包，runtime 仅替换 settings/show/hooks/dataDir。首次 `node --input-type=module` 使用已有 beforeRead hook 延迟 5150ms，真实本地合法 SKILL.md 的 discoverSkills 实测 5155ms 后 ok=true、skillCount=1（exit 0，`deadline-result.json`）。随后实际 `node /var/folders/zn/9h5xx7817g1byxssf2d_8k7w0000gn/T/dsh-sol-review-5aa3354-l600go/adapter-probe.mjs` exit 0：FileHandle.read 替身仅延迟 5150ms 后转发真实 fd IO，其他候选路径/解析/合并/持久化原样；本地 counted sessionController 替身用于观察调用（不是实际 native 宿主）。结果 create.ok=true、elapsedMs=5157、nativeCalls=1；refreshHealth elapsedMs=5156、skill[0].status=valid，原始结果为 `adapter-deadline-result.json`。只写自有 fixture/快照/bundle，无真实宿主/外网/端口/Skill/课件写入。这个探针证明生产适配会越过预算进入 native 调用点，不声称另跑了真实宿主慢磁盘场景。

`git show 0b38f9d:.../sessionContext.ts` 表明保存/创建的“仅循环入口计时”已在旧候选存在，故不称该部分由本 delta 新引入。**本 delta 的新放大点是 `discoverSkillsForHealth → discoverSkillsFromBindings` 全文读取复用（旧版仅做轻量存在性检查），以及本轮明确要求 5 秒预算覆盖所有出口；R12 为新观察到的独立缺口，不重新否定已修复的 R11 字节实例。** 有界搜索仅扫描 sessionContext/Paths/Skills、两种来源入口、健康调用方与相关测试；`rg 'scanBudgetMs|发现整体超时' src test` 仅命中常量和两个外层检查，没有最终读取/成功提交的 deadline 断言。没有将它扩成全仓清理。

建议由原实现者在同一有限扫描上下文中传递 deadline/取消，候选循环、每个异步 IO 后及合并/发布/持久化前核对；超时不能转成普通 missing/unreadable 或成功。底层 IO 未收束时继续保持正确在途边界，晚到定义丢弃。必要验证是单来源和最后来源末文件在期限内/外两侧，save/prepare/recheck 共用路径；超时创建 native 调用为 0、旧保存/活动/冻结内容不变。当前 probe 是已观察的定位证据，本轮不实施修正或增加诊断/盲目返修轮次。

探针准备失败保留于本轮原始工具输出：live root 未直接解析 esbuild（MODULE_NOT_FOUND，exit 1，改用既有 Validate 副本已安装依赖）；首个临时 ESM bundle 的 YAML dynamic require(process) 不兼容（exit 1，补 Node createRequire banner）；延迟 fd shim 初稿少一个闭括号构建失败（Unexpected end of file，exit 1，改为可读完整临时脚本后上述正式 probe exit 0）。这些是自有取证装置错误，不是业务测试失败、实现修正尝试或模型切换。一次安装包名称探查误用 dsh-session-controller 报 MODULE_NOT_FOUND，随后依实际 probe import 的 dsh-api-session-controller 正确解析；未据该探查宣告依赖不可用。没有覆盖或删除任何失败证据。

**usage / design、复用与限制**：README 的 LIVE-SESSION-CONTEXT/SKILL-LOAD/MATERIAL-READ 各唯一，关联 REQ-010 SCN/CFG → owner config/shared schema 与 Mac「新直播会话」指南 → 现有真实 Console/owner/native create-resume/文件读取证据。默认 cwd、保存后新会话生效、活动快照独立、受限能力/恢复说明可对应；真实正常旅程不抵扣 R12 的慢读取失败路径。Operate 视角静态核对完整 Panel、Console 开始操作、label/fieldset/aria-live/error，复用1440/375 E2E与组件证据；Impeccable 可加载且可读，仅借用判断维度，不跑 launcher/完整 critique/新浏览器或声称新渲染/键盘通过。新统一原子发现与合并有当前规则共享职责；仍存在未用参数等可选简化，但没有已证实正确性或兼容影响，不列阻塞项。本次 diff 未发现有证据支持的重复实现或可避免工程债。

macosTts 两项真实 OS 语音、真实90秒道别计时、dsh web CLI 顶层包装、实际舞台/观众播放和完整 live 链未测；REQ-010 可独立于这些范围验收，完整发行栈进程组合/跨进程入口已有本候选证据，故不把上述边界另列实现阻塞。真实 GLM 仅既有协议等效引用、无新真实 API 调用，模型遵循非确定，1M 容量未验证。

**决定与交接**：R9/R10、R11 原字节/原子性与 R8 逐条绑定/声明健康有实质进展；仍有 R12 的明确预算合同缺口，建议本候选 FEAT-006 **changes_requested**。本轮 review 执行完整，`stage: review`、`status: awaiting_acceptance`，`context_updates.project_candidates=[]`。只请求 `record-review --feature-id FEAT-006 --decision changes_requested --by sdlc-review-sol-5aa3354-20261112`；批量交主 Sol 验收，不自行执行状态转换、修代码、commit/push、发布或宣称 released。历史失败和主 Agent 唯一诊断额度已用事实保持；新必需独立 review/可复现新观察不自动重置或触发额外诊断，后续由主 Sol 按既有停止纪律处理。

### 2026-11-12 主 Agent 接受 5aa3354 正式复审：R12 返修

主Sol核对review原始adapter-probe.mjs/adapter-deadline-result.json、discoverSkills/discoverSkillsFromBindings的循环与成功出口、共享读取wrapper及createManagedSession提交调用点，接受R12。最后一次await后无截止时间核对是明确因果；受控真实fd延迟5150ms后创建仍ok、native替身计数1、健康仍valid的原始证据边界清楚，不外推成真实宿主慢磁盘实验。当前R9/R10、R11字节/原子性及R8逐条绑定有实质验收进展；R12是新观察到的共享时间预算缺口，不是无新证据的重复返修。未开展新的主Agent诊断，失败历史和唯一诊断额度已用事实保持。

已通过lifecycle CLI接受FEAT-004 approved、FEAT-006 changes_requested，并以done→todo→in_progress重开T001；该Feature旧validation/review自动清除，历史仍保留。当前有效方案新增“发现截止时间的统一传递与提交校验”，覆盖保存/创建/健康及底层读取收束，是跨入口deadline策略修正，仍由同一实现者承担完整实现与必要验证，不另建只补测试的执行者。FEAT-004统一分发等待最终FEAT-006候选，不使用本轮通过绕过其返修。
