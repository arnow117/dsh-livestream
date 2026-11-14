# 抖音只读接入 / 本地舞台

主人在 DSH 的「直播」控制台操作。角色继续使用现有会话模型和声音，接入只读取主人指定房间；角色的话只在本地舞台播放，不发送抖音弹幕、不登录账号、不推流，也不使用 B 站观众记忆和账号工具。

## 准备独立采集器

本插件与采集器分进程运行。使用 [DyHub](https://github.com/ymstar/dyhub/tree/3a79c57d85c59289db3b77211b3ec01fae47d42c) v0.3.1 的固定 commit `3a79c57d85c59289db3b77211b3ec01fae47d42c`，Node.js 20 或以上，和本机已有的 Chrome。获取该固定版本后，在采集器源码目录安装并构建：

```sh
npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=15000
npm run typecheck && npm run build
```

这两条命令已在 macOS arm64、Node 26.13.0 的固定版本 checkout 上执行。采集器源码和数据目录应独立于插件及其他使用者；启动时将工作目录切换到专用空目录，让采集器在其中创建 `data/`。以只绑定本机的 browser 模式启动构建后的 `dist/index.js`，例如把下列路径替换成自己的 checkout 绝对路径：

```sh
DYHUB_HOST=127.0.0.1 DYHUB_PORT=8757 DYHUB_COLLECTOR=browser DYHUB_COOKIE= node /path/to/dyhub/dist/index.js
```

使用独立匿名数据目录，不使用私人 Chrome profile、不登录或导入 Cookie。该目录中所有账号都必须明确没有 Cookie 和登录状态；账号状态无法确认或存在登录账号时，插件拒绝连接并提示使用独立匿名目录。插件需要新账号时会创建自己的匿名记录；已有采集可复用。控制期间不要用其他管理器修改该目录、账号或同一房间的采集状态；上游不提供跨管理器的原子操作。采集器重启后也必须使用同一固定版本和同一匿名数据目录。

插件部署配置由启动 DSH 的人管理：`DSH_LIVESTREAM_DOUYIN_BRIDGE_URL` 默认 `http://127.0.0.1:8757`，只接受 HTTP 数字 loopback 地址 `127.0.0.1` 或 `[::1]` 和合法端口。若采集器改端口，在启动 DSH 前设置匹配地址。`DYHUB_CHROME` 可由采集器启动者指定浏览器可执行文件；留空时由采集器自动查找。

## 连接并停止

1. Harness 主人在 DSH「直播」主页选择「抖音只读接入 / 本地舞台」，填写数字房间号或完整 `https://live.douyin.com/<数字>`，先点击「保存」，再点击「连接」。草稿不会改变已保存目标；不接受短链接、查询参数或其他网站地址。B 站也在这里选择并保存；本地彩排模式不连接 B 站。
2. 连接中只表示正在等待采集；显示「已连上」才表示采集器报告房间 live。打开本地舞台，点击「开始本地舞台」进行互动。
3. 点「断开订阅」只关闭本插件的订阅，采集可能继续运行。要停止采集，在同页勾选共享影响提示后点「停止此房间采集」；插件先断开本地订阅，再仅停止已保存的房间。关闭插件不会自动停止采集。
4. 断网或采集失败后不会自动重订阅。状态确定为已结束或出错时，可在同页显式「重试连接」。如果页面显示操作结果未确认，插件会保留原目标并禁止重复启动或停止；仅在只读检查能确认本次创建的新会话或匿名账号时自动解除保护。不能用房间不存在、停止成功、重启服务或刷新单独证明迟到的创建不会发生；重启并刷新不保证解除保护。没有可证明结果时保持保护，不删除日志或反复尝试。

订阅初始化若一直没有有效确认，超时后本插件会关闭该次连接；之后到达的帧不能再作为该次初始化完成的证据，未知状态继续受保护。

礼物显示名称与数量，未验证的金额视为未知，不换算人民币。零值在线、累计观看和点赞无法与缺失区分，显示未知；点赞聚合不会被展开成多条。抖音不上舰、不产生醒目留言，也不启用长期观众记忆。

## 验证与边界

固定采集器已有一次公开示例房间的短时匿名观察，看到弹幕、点赞、进场和房间统计；当次没有观察到礼物。自动测试使用独立的模拟桥接和替身模型/语音，不代表用户的房间、真实礼物、账号登录或长期稳定性已验证。网站协议、访问限制或房间状态可能变化。

DyHub 根项目声明 MIT；其 `third_party/douyin-sign` 是另有 AGPL-3.0 声明的第三方签名材料。本方案仅运行独立的 browser 模式，插件不复制或导入该签名实现，也不启用 lightweight 模式。请自行查阅上游许可证和使用条件。

## 公屏文字发送

这是单独的可选发送能力，使用非官方网页接口；匿名接收与本地舞台仍按上文配置。只有 Harness 主人能保存、维护、核查、授权和核对发送。以下说明描述受信部署；真实材料、账号主体、平台 API、标准 TLS 接受、真实 gift 与观众可见性尚未验证，直播伴侣自动发送不可用。

### 准备固定资产

维护者在独立目录准备固定 DyHub commit `3a79c57d85c59289db3b77211b3ec01fae47d42c` 的 Git 仓库，使用本插件源码的 `src/publicChat/dyhub/prepare_raw.py` 导出到一个尚不存在的绝对路径。此步骤通过 `git archive` 读取固定 commit，不读取工作区未提交改动；它核对固定源码、唯一 patch 和摘要。`--repo` 是该独立仓库的规范绝对路径，`--output` 是新目录：

```sh
python3 src/publicChat/dyhub/prepare_raw.py --repo /absolute/path/to/fixed-dyhub --baseline 3a79c57d85c59289db3b77211b3ec01fae47d42c --output /absolute/path/to/new-fixed-export
```

从插件包目录执行标准 `node build.mjs`，或设置 `DSH_LIVESTREAM_BUILD_OUT` 指向独立输出目录；构建输出的 `public-chat-assets=` 行给出当前实际资产根。构建只复制校验资产，不登录或请求平台。随后使用该行路径下的原 builder，输出到尚不存在的两个绝对路径：

```sh
node /absolute/path/to/public-chat-assets/dyhub/build_raw.mjs --fixed-d /absolute/path/to/new-fixed-export --export-sha256 832cbc54ed74bbe3b4467ee39aafbd3000ac9d089529ef7b8ae35cb3a400ccb1 --output /absolute/path/to/new-sender.mjs --manifest /absolute/path/to/new-sender.manifest.json
```

这个 manifest 绑定实际打包源码绝对路径、固定导出、patch、builder 和 bundle；换输出位置或源码后应从该位置重新构建，不能修改旧 manifest 来复用。所需 pako、protobufjs、long 和原固定导出的许可文件须随受信部署保留并由 Node 解析到对应版本。还需从本 checkout 的 `src/publicChat/httpHelper` 源构建独立 helper，并准备只含 `schemaVersion: 1`、`binaryPath`、`binarySha256`、`sourceFiles` 的 0600 manifest；`sourceFiles` 为该目录所有非 `_test.go` 普通文件名及其 SHA-256。helper 与材料目录不能指向匿名采集器或私人浏览器 profile。构建、目录归属、文件权限、文件身份或摘要不符时不可用。

维护者准备两个 0600 受保护 JSON：构建部署文件只含 `bundlePath`、`exportPath`、`manifestPath`、`manifestSha256`；发送部署文件只含 `schemaVersion`、`listenUrl`、`token`、`expectedPrincipalUid`、`roomId`、`accountRecordId`、`buildDigest`、`instanceId`、`profileOrigin`、`dataDir`。`buildDigest` 是实际 sender manifest 的 SHA-256。`listenUrl` 必须是非零端口的数字 loopback HTTP 地址，`profileOrigin` 只接受 `https://douyin.com` 或 `https://www.douyin.com`；主体 UID 和房间为数字字符串，房间必须与当前保存的抖音房间一致。账号记录 ID 是本地引用，不证明真实主体。token 和材料内容只由维护者安全提供，不放入普通设置、模型参数、命令行或文档。

Harness 启动环境中的八个 `DSH_PUBLIC_CHAT_*` 引用及占位例子见 [Mac 环境模板](../macos-yovoice/.env.example)：两个部署文件、浏览器可执行文件、helper manifest 及其 64 位小写 SHA-256、helper 源目录、材料文件和私有 helper 数据目录。路径必须为规范绝对路径；私有数据目录由当前用户拥有且不能允许组或其他用户写入。没有默认值；发送所需引用缺失或校验失败时发送服务不可用。仅查看和采用本机历史时，只需两个受保护部署引用及通过校验的构建资产，不读取认证材料，也不启动 helper 或浏览器；缺少这两个引用或日志损坏时历史显示不可用并保持暂停。两个部署引用在本次进程首次打开历史时固定；发送器建立后持有其材料引用，部署或引用变化需重启 Harness。材料必须由发送账号受控维护提供，并包含 helper 要求的完整 Cookie scope、身份与签名材料和有效期；本功能不采集私人 profile，也不自动续期。

### 操作与恢复

1. 主人在「直播」→「设置」→「公屏文字」保存总开关、可选 Agent 回复/欢迎/感谢和普通文字草稿。四个开关默认关闭；保存本身不维护材料、不连接、不授权、不发送，也不开播。文字上限为 200 个 UTF-16 代码单元；电话、邮箱、微信标记、链接、附件、记录引用和控制字符会被拒绝，语法检查不能识别全部隐私内容。
2. 开播和输入连接均有真实当前生命周期证明后，点击「维护发送材料」，核对本地记录、实际认证 UID、固定房间与内部房间，再点击「核查资格」和「明确授权」。授权只属于当前内存与绑定，断连、目标变化、下播或维护会失效；重启不会恢复旧授权。
3. 输入普通文字后点击「发送这条文字」。重复提交同一原请求不会增加发送；“接口返回成功码，观众未核对”不表示观众已看到。Agent 仅能对关联的当前真实事件选择一次回复，普通助手正文不自动发送；欢迎同一观众有 60 秒限制，礼物按原始正增量在 8 秒内合并，未知金额不写成零。
4. 结果未知时保留页面中的原请求、绑定和控制编号。备注或“未看到”不会解除暂停；可按原主体、房间、内容摘要和时间记录正面观察，再按原请求或原控制编号核对。原执行未终止、事实冲突或原 holder/ACK 不可核实时继续暂停。即使当前未开播、未连接、发送开关关闭或材料缺失，仍可查看历史并按原控制编号显式采用完整有效回执；没有完整回执且原 holder 已丢失时保持暂停。旧消息仍为 unknown、旧请求与事件不重发；后续新动作仍需当前直播、材料、新的核查和授权。
