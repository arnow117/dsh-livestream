# 本地适配验证记录

验证日期：2026-11-09。业务代码基于上游 `6c2f405b5520bea932808c224ba9ca6d65f41756`，包含 macOS 系统语音、yovoice、本地彩排隔离及 Harness peer 兼容修复。配置模板经过 JSON / YAML 解析、环境变量解析和假 CLI 参数检查；当前分支保存这些配置与说明，真实新机器的完整安装尚未验证。

## 自动检查

以下命令已在仓库根目录成功执行。相关测试共 4 文件、14 项通过；macOS 语音测试访问了本机系统语音，yovoice 协议测试使用假服务，不加载真实模型。

```sh
npm_config_manage_package_manager_versions=false pnpm --filter dsh-livestream exec vitest run test/macosTts.test.ts test/yovoiceTts.test.ts test/localRehearsal.test.ts test/guest.test.ts
npm_config_manage_package_manager_versions=false pnpm --filter dsh-livestream check
npm_config_manage_package_manager_versions=false pnpm --filter dsh-livestream build
git diff --check
```

覆盖内容包括本地模式隔离、MP3 输出、串行请求、取消与预合成取消、任务终态清理、错误处理及下载地址校验。本次记录不表示在所有平台执行了完整测试套件。

## 真实本地联调

Apple M5 / 32 GiB，yovoice 配合 audio.cpp `v0.9.1` Metal 与 `voxcpm2-q8`。单任务串行执行；以下每项只取一个样本，合成时间不含 GLM 生成和浏览器开始播放的耗时。

| 场景 | 合成耗时 | 音频时长 |
| --- | ---: | ---: |
| CLI 首次冷启动，客户端计时 | 18.218 秒 | 5.60 秒 |
| 常驻服务首条，服务日志计时 | 5.862 秒 | 5.60 秒 |
| 模型已加载后的短句，客户端计时 | 2.547 秒 | 2.72 秒 |

GLM-5.3-Flash 的新直播会话真实调用了 `show_stats`。开场和弹幕回复经 yovoice 合成，舞台收到三段带字幕与表情的 48 kHz MP3，时长为 4.48、5.44、3.84 秒，均由 ffprobe 检查。Chrome 独立舞台的声音开关已开启；不据此推断其他机器的音质或延迟。

引擎空闲五分钟会卸载模型，之后的首条可能增加加载等待。该记录只覆盖本地彩排，未验证 B 站开播或 OBS 推流。原始本机日志、认证地址、凭据、会话和试听文件不提交到源码仓库。
