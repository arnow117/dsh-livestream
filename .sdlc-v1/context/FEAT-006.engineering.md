# 工程上下文：FEAT-006 直播会话的工作目录与 Skill 设置

## 当前有效方案

### 架构设计

**关联产品上下文**：`.sdlc-v1/context/REQ-010.product.md`，唯一产品规则为其中 NEED/CON/DEC、CFG-01～05、SCN-01～07、SC-001/002。

**工程上下文**：`.sdlc-v1/context/FEAT-006.engineering.md`。

**分支与基线**：`codex/macos-yovoice`；起始核实 HEAD 为 `06c294a38f1c1dc8265b403bfd3ab501508c647e`，源码基线为 `fd48d0a5d9a18a3759428c3286f28480630eeb9a`，这两个版本之间仅有 SDLC 文档变化。并行工作在本轮收尾时推进仓库 HEAD 至 `6f57866e552e5ae500f0dcfb6961e1267ed259f0`；已用限定路径 Git diff 确认本方案相关生产源码、包配置与构建/验证配置相对起点未变，且生产源码仍与固定功能基线一致。不采用并行工作的验证结果。

**创建日期 / 状态**：2026-11-11 / Plan 候选，待主 Agent 接受。Feature/Task 尚未登记，本文不宣布生命周期变化。

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

管理会话在 Agent 自身 scope 设置 inherited-tool 允许名单，但必须保留父 preset scope 的既有直播工具：由 agent.ts 的既有注册/注销入口记录当前有效的工具 definition 对象，只有名称和 `tools.get(name,agent)` 的 definition 身份都匹配本 preset 记录，才放入 `tools.restrict({allow: names})`。本条两个 Agent 自身 scope 的工具按原生规则保留；未知 global 工具不在名单内。不能直接使用空 allow 数组，因为原生限制同时作用于 global 和祖先 scope，会误删既有直播工具。平台工具注销/注册时同步更新名单，先安装新限制再释放旧限制，不改共享 preset 的全局注册表；保存配置不触发该更新。最终实际 toolset 再核对无额外 Shell、fs、插件安装等工具，无配置会话不安装这些新增限制。

Skill“已加载”只表示 Markdown 已进入该会话实际工具结果/上下文，能力固定为 Markdown + 指定资料读取。owner 状态同时显示“脚本、依赖安装、文件写入不可用”；请求制作脚本时明确缺能力。Skill 内文字、路径或 required-tools metadata 不注册任何能力。

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

两个工具只对已绑定且启用、对应项可用的 Agent scope 暴露；创建完成立即按 Agent ctx 注册，恢复时在其第一步预检中绑定，均须在首次工具集合解析前完成。preset 共用 revision 不能保存单个会话的授权或正文；Agent 卸载时只释放它自己的工具 disposer/计数。manifest 在 `agent/pre-step` 的 `PreStepDecision.messages` 以插件自己的 context source 注入，列出可加载的 Skill name/description、资料 rootId、能力限制与已选 cwd 的逻辑说明；不含绝对路径，也不冒充 owner/user 消息。不用普通 systemPrompt.section 注入，因为当前 persona.complete 会隐藏该 section；实际 loader 的 output.render 则把冻结正文交给 native 模型消息链。结果使用单一 schema 的 `available/loaded/empty/unavailable/denied/unsupported/busy/timeout/cancelled/limit_exceeded`，owner 诊断单独记录实际来源/hash。`loaded` 与 capability limitation 可同时存在。模型回复中已知配置路径及其用户输入别名须在 `agent.ts` 现有 assistant → `show.say`/字幕输出前脱敏；工具错误始终是受控文案。Skill/资料正文不进入 `/events` 或 Stage 配置广播，owner 可在原生会话核对内容；增加含恶意路径回声的输出验证。

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
