# 恢复检查点：FEAT-008

## 定位

- REQ-011 / FEAT-008；branch `codex/macos-yovoice`；提交前HEAD `aaa4cefc1bbe80c35523ed37563ede8aedfe2564`；固定版本见W/main-final-matching-86/commit-receipt.json。
- L=`/Users/mac/hansen_agent_team/workspace/20261109-deepseek-harness/dsh-livestream`；W=`/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat`。
- T001、T002均已done；validation/review pending。Goal保持公屏完整交付，资料/课程排队，资料原在途已收尾。

## 已确认

- 原run20已completed、activeRunId=null、无pending；R82渠道代次/关闭期间旧事件重放修正已核。没有再恢复原worker。
- root81/83/85直接完成小型Review修正，首尾控制字符/协议相对链接/IPv6/原文4096上限，以及Node/Go Unicode空白、ASCII大小写一致性；原文及digest不改。
- root85最终27 Node/2 Go定向通过；错误的首轮大小写样例预期及其失败保留，正确区分样例为douyin.com/uſer。
- root86最终匹配通过：49文件267 Node，83.24%行/77.08%分支；65 Go/83.5%语句、27 race；标准build/source与built sender/当前helper、54项host hash/mode及固定native复制匹配。
- 四个正式strict/read-only Web旅程1440/375均通过；PNG尺寸/几何/焦点/完整ID及built截图已核。573项检查前后源码不变；已记272 PID/93端口无残留。
- 已通过lifecycle CLI将T002置done，尚未记录新的validation/review/release。

## 未完成

- 正在固定并推送上述业务版本；独立Validate和完整累计Review尚需执行，再做既定本机发布与实际版本/smoke。
- 真实账号/固定房间/发送/另一观众/gift NOT_RUN/DEFERRED；用户明确后续与直播间联合验收，不能宣告整个Goal完成。
- 首次Web因临时依赖链接错误未收集，已修正到原可用依赖后只补四Web旅程。首次Go实际telemetry为local，之后实际设off并确认；不追认此前合规，不为抹历史重跑已过检查。
- R82/75历史PGID缺口保留；当前资源只证明已记录集合，不称穷尽全部短命后代。

## 下一步

- 固定commit/push后派fresh独立Validate，绑定实际HEAD及当前完整产品/工程上下文。必须首个Go作业前实际go telemetry off并go env确认；GOTELEMETRY为不可设置的查询值，不能用同名env替代。
- 复用root86既有测试定义/命令及固定D导出；新任务自有输出与新fixture数据。不能以root Build通过代独立执行；不得改源码/测试/断言或缩覆盖分母。
- 使用`P/node_modules`作为正式Web runner依赖（R82/node_modules只供另一些fixture，缺Web engine）。真实业务/凭据/资料native/模型/TTS预算0。
- Validate通过后由root登记，再fresh独立Sol Review完成80未读累计范围及当前修正；未批准不Ship。
- 当前无运行worker。T3 Codex子执行者禁止下派；已有Terra兜底route codex/gpt-6.1-terra/xhigh，独立executedModel未提供仍NOT_VERIFIED。
- 同segment全部失败、新因果和唯一主诊断未用保持；不停止共享服务、不清全局temp、不重置Git。

## 必要引用

- `.sdlc-v1/state.json`、`context/REQ-011.product.md`、`context/FEAT-008.engineering.md`为权威；本检查点不替代它们。
- W/main-final-matching-86/{pipeline-result.json,acceptance-audit.json,environment-correction.json,source-before.json,source-after.json,output/}；W/main-text-policy-parity-85/result.json及原red/green。
- W/feat008-independent-review-aaa4cef-80/result.json；W/main-deployed-smoke-contract-84/source-contract.json和原71/76发布准备。
