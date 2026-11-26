# DSH StackChan

让 [M5Stack StackChan](https://docs.m5stack.com/en/StackChan/) 成为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 会话的身体。DSH 用它的眼睛、耳朵、嘴、脖子、灯和屏幕；人格、记忆和判断仍然留在 DSH 里。

*Turn an M5Stack StackChan into a body for a DeepSeek Harness session: firmware that exposes every part of the robot as raw capabilities, a Mac plugin that hands them to DSH as tools, and the engineering wiki behind both.*

> **状态：开发中，不是成品。** 所有身体接口都在真机上验证过。DSH 固件可以常驻在原厂的另一个 OTA 槽里，原厂仍是默认启动；需要身体时由 Mac 切进去，回原厂点 Home（[wiki/residency.md](wiki/residency.md)）。本仓库不提供可直接刷写的固件镜像。

## 由哪几部分组成

| 层 | 在哪里 | 做什么 |
|---|---|---|
| 0 身体 | `firmware/agent/`（ESP-IDF 6.1，ESP32-S3） | 一个独立应用，装在原厂分区表的另一个 OTA 槽里，原厂固件和语音保持不动。只提供原始机能（读、订阅、写、事件），保护只用来防止损坏 |
| 1 神经 | `src/`（Node，DSH 插件） | 经 USB 认证连接设备，把机能包装成 DSH 工具。本地语音识别和合成、配对、诊断也在这一层 |
| 2–3 大脑 | DSH 会话 | 怎么理解、什么时候用这些机能，由 DSH 的技能和意图决定。本仓库不写死助手的性格 |

设计原则见 [wiki/split-design.md](wiki/split-design.md) 和 [wiki/body-interface.md](wiki/body-interface.md)。

## 身体能做什么（DSH 工具）

- **醒来**：`stackchan_wake` 从原厂助手切进身体固件，原厂仍是默认，点 Home 回去。
- **头**：单次移动、关键帧、实时目标流、保持或放松扭矩、读全部舵机寄存器、偏航连续旋转。
- **屏幕**：表情、文字、图片；帧库可以预存 48 张画面、按编号快速切换，整屏每秒约 30 帧，和头的运动走同一条时间线（[头耦合透视](wiki/head-coupled-view.md)）。
- **灯**：12 颗 LED 逐颗多帧。
- **声音**：说话、播放、录音、音量。
- **相机**：单张、连拍。
- **感觉**：头顶三区电容、触屏、IMU（含地磁原始值）、光感和接近、电源、红外收发、NFC 读卡（只读）。可以按时间窗录下来。

## 先读

- [wiki/README.md](wiki/README.md)：工程 wiki 入口，按问题找页面。
- [wiki/validation.md](wiki/validation.md)：每个版本的真机和离线验收记录，最新的在最上面。
- [wiki/installation-recovery.md](wiki/installation-recovery.md)：安装和恢复。**刷写前必读。**

## 开发

```sh
npm ci --ignore-scripts
npm test                 # Mac 插件和协议
npm run test:agent       # 固件主机测试，含 C++ 会话与 Mac 端的端到端
npm run build:plugin
```

固件用 ESP-IDF 6.1 构建：`scripts/prepare_agent.py` 准备源码，`scripts/build_agent.py` 编译。Python 测试建议用 Homebrew Python（`PATH=/opt/homebrew/bin:$PATH`）。

发布到公开仓只用 `zsh scripts/publish_public.zsh "说明" --push`：它从当前提交导出一份整理过的树，去掉本地数据和不能再分发的素材，`scripts/check_public_tree.py` 检查通过后才提交和推送。私有检出本身不推送。

直测驱动 `scripts/body_probe.mjs` 不经过语音和模型，按脚本逐项调用身体接口，并把读回和耗时记录下来。

## 刷写和设备安全

- 只在你自己的设备上、清楚风险后操作。先做两份整片只读备份并比对一致，再写。
- 本项目的试装只写一个 OTA 槽和一次性启动选择，不改启动器、分区表、原厂 NVS 和绑定。恢复按整片读回逐字节核对。
- 原厂的生产鉴权（StackChan World 等）不在本仓库里，自己编译原厂固件会失去它。本项目不这么做。

## 鲸鱼娘形象素材（不包含）

设备上的鲸鱼娘脸来自社区素材。素材整体是 CC BY-NC-SA 4.0 或更严格的条款，作者没有授权公开再分发，所以**本仓库不包含**：

- 原图（`firmware/whale-sources/*.jpg`）；
- 生成的形象数据（`firmware/agent/whale_assets.bin`）；
- 预览图。

生成形象的代码（`scripts/build_whale_avatar.mjs`）和署名说明（`firmware/whale-sources/NOTICE.md`）保留了。要构建带形象的固件，请自己合法取得素材，放进 `firmware/whale-sources/` 后运行生成脚本。

## 许可

- 本仓库的代码和文档使用 [MIT](LICENSE)。
- 第三方组件保留各自的许可：`vendor/` 下各目录的 NOTICE 和 LICENSE；`contributions/` 是针对 [m5stack/StackChan](https://github.com/m5stack/StackChan)（MIT）的补丁；构建时拉取的 ESP-IDF、LVGL、xiaozhi-esp32 等按各自许可。
- 鲸鱼娘角色和画作不是 MIT 素材，见上一节。

本项目与 M5Stack、DeepSeek 都没有官方关系。
