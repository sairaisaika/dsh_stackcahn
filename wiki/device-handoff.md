# 设备双模式切换：源码决策与第一实施门槛

范围说明：本页保留此前同进程候选的实现契约，并非新独立应用已部署的行为。当前入口见 [独立 Agent](independent-agent.md)，用户操作见 [官方手册对齐](manual-alignment.md)。

最新约束已调整：允许手动切换，新增应用方向及鉴权范围修正见 [成品计划](product-plan.md#独立-dshagent-方向手动切换已获允许)。本文此前的自动回归/双启动推荐属于旧约束下的分析，不代表新架构已选定。

归属：[P1 成品计划](product-plan.md#按依赖推进的工作包)。方案已产生补丁并通过完整构建；未安装设备。实现入口见 [固件运行契约](firmware-runtime.md)，版本与恢复见 [兼容页](device-compatibility.md)。

P0 构建检查：官方基线与双模式扩展均经 ESP-IDF v6.1 完整构建通过。补丁在干净固定 checkout 上可应用；尚不证明固件可启动或本机设备兼容。

## 源码给出的事实

本轮固定 [M5Stack StackChan 28b9f0c8](https://github.com/m5stack/StackChan/tree/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400)，其 firmware/repos.json 固定 [xiaozhi v2.5.2 / 49b4380b](https://github.com/78/xiaozhi-esp32/tree/49b4380b3faa0ceadd28a3e78aaf0f311c46c57e)，还叠加官方 firmware/patches/xiaozhi-esp32.patch。设备 v1.6.2 与分区已读回并校验，原语音/绑定由用户确认正常；量产镜像与公开源码的鉴权实现不应假定一致，见 [安装审查](installation-recovery.md)。

| 证据位置 | 核对到的行为 | 对设计的约束 |
|---|---|---|
| 官方 firmware/main/main.cpp::app_main | AI 启动请求后 uninstallAllApps / DestroyMooncake，接着 startXiaozhi | 原 AI 模式中不能假定 App 管理器仍然存活 |
| 官方 firmware/main/hal/board/hal_bridge.cc::start_xiaozhi_app | Application::Initialize 后 Run，Run 永不返回 | 不能以普通 App onClose 实现回退 |
| 小智 main/application.cc::InitializeProtocol | 依据 OTA 配置创建 MQTT 或 Websocket，统一装音频/JSON/连接回调 | 原服务可能是 MQTT，不能把恢复硬编码为一个 WebSocket URL |
| 小智 main/protocols/websocket_protocol.cc::OpenAudioChannel | 每次读 websocket NVS 的 url/token/version | 需要本地独立端点注入；不能反复改原 NVS 来假装运行时选择 |
| 小智 main/ota.cc::CheckVersion | 服务器配置写入 mqtt/websocket namespace | 本地运行路径需隔离 OTA/激活/凭据更新；不得用本地 OTA 响应覆盖原云配置 |
| 小智 main/application.cc::ResetProtocol | Schedule 中关闭音频通道并 reset 指针 | 既没有完整重建握手，也没有报告原云就绪；调用它不是恢复完成 |
| 小智 main/application.cc::InitializeProtocol 回调 | 音频关闭回调会 Schedule 到 Idle；其他回调捕获 this | 更换 protocol 指针后旧回调/已排队任务可能污染新模式；需要 generation 和生命周期防护 |
| 小智 main/application.cc::Run / MAIN_EVENT_SEND_AUDIO | 清空剩余编码队列避免编码线程堵塞 | 切换要覆盖输入/编码/解码/播放队列，不能只 close socket |
| 小智 main/application.cc::GetDefaultListeningMode | 无 AEC 时为自动停止模式，有 AEC 时 realtime | 播放中能听见“停止”不是默认保证；须音频处理和 AEC 的真实验证 |

上述定位是未加本扩展时的上游事实；新增 API 见固件运行契约。源码保留在忽略的 work/ 克隆；公共证据链接用固定 commit。官方 patch 必须先应用再验证我们的修改。已在忽略的 work/ 中配置 ESP-IDF v6.1、CMake/Ninja 与 S3 工具链；主机 C++ 测试和完整固件构建分别记录。

## 方案比较与推荐

2026-11-18 重开条件已触发：官方 #134 确认生产鉴权未公开。下面保留此前实现依据，不再将“源码保留原功能”当作量产集成兼容。新候选比较见 [量产边界与折中](production-boundaries.md)，尚未采用双启动或修改启动器。

| 选择 | 保留原助手 | 持续接管/停止 | 结论 |
|---|---|---|---|
| 原云 LLM 每轮调 MCP 工具 | 当前能保留 | 仍由原模型决定转发与转述 | 不作为成品主链路 |
| USB 改 NVS 后重启切后端 | 备份可能可恢复 | 退出依赖 USB/重启，不是运行时切换 | 不作为日常模式接口 |
| 另起 Remote App，关闭时恢复 | 需重建已销毁的应用生命周期 | 清理 App 不证明原协议就绪 | 不优先；若采用必须重做调度/生命周期，成本更高 |
| 在原 Application 内注入本地协议，并管理原/本地互斥资源 | 原配置可隔离保留，官方 App 鉴权仍阻塞 | 能设计确定性切换、设备看门狗和旧回调隔离 | 此前实现方向；构建已过，现因量产鉴权重开选型 |

推荐单一音频所有者，原云和本地互斥；原路径仍通过官方配置创建，新增本地配置位于单独命名空间，默认启动原模式。本地失效由设备自身恢复选择原路径，不能依赖 Mac 发送退出。原云不可达时选择恢复与服务恢复分开显示。日常切换不刷写默认配置，不清激活绑定。

## 目标进入与退出时序（提案）

进入：Mac 验证所选 DSH 会话存在与能力就绪 → 配对控制通道请求本代租约 → 设备冻结原路径的新音频、注销旧回调并清空旧音频 → 以独立本地端点建立协议 → 确认有效采集和播放通道后授予租约 → 才开始投递转写。部分成功须在设备端回滚；任何迟到成功必须被释放，不得默默进入后台。

退出：Mac 的停止检测立即撤销代次 → 阻止更多 DSH/TTS 输出 → 设备打断并清空本地音频和待执行动作 → 销毁本地协议/回调 → 通过原配置重建官方路径 → 报告模式选择及原服务就绪阶段 → 桥只在完成约定成立后报告 originalReady。若没有 Mac，应由租约超时或物理返回触发同一设备路径。

控制通道必须能在音频协议已关闭时查询恢复结果；不能关掉唯一连接后仍等待其返回确认。具体采用独立已配对控制连接或可重连状态查询，在 P1 固件资源审查决定。所有确认关联 device boot/generation/lease；重复退出幂等，过期退出不释放新租约。

语音停止依赖本地 ASR 能持续听到输入；仅有设备 watchdog 不能满足此项。音频播放时的 AEC、采集、停止识别与硬件队列释放需一起验收。不把“发送 abort”写成“扬声器已经静音”。

## 实施与真机门槛

1. P0 核实实际板型/固件/分区与可恢复路径，锁定兼容范围；保留官方差异，先构建未经我们修改的基线。
2. 在应用事件循环中列出 protocol 的所有读写与异步回调，确定单一切换执行者；对音频任务/队列补所有权和 drain/cancel 规则。
3. 设计并实现独立端点配置、模式状态与确认字段；验证原 MQTT/Websocket 两种来源，不能只测新本地连接。
4. 固件通过构建后，附具体产物哈希、修改点、原配置影响、备份/恢复命令与验收步骤，再处理设备安装；不能把尚未可构建的 patch 当刷机方案。

若第 2 步证明共享 Application 无法安全隔离音频回调/任务，或内存不足，则回到方案比较，记录失败证据后再选生命周期重构。未做完时可以推进 DSH Host 和本地语音独立接缝，不以未知接口承诺免刷或成品已完成。
