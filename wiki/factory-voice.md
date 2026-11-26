# 原厂语音接管：可行性门槛

> 已更新需求：允许 DSH 模式采用独立免费本地语音，只要求能返回原厂助手。下面“复用原厂云语音”的阻碍仅适用于该特定路线，不再阻挡整个项目。当前选型见 [本地语音与文字转接](local-voice-options.md)。

核查日期 2026-11-18。官方源码固定到 [m5stack/StackChan@28b9f0c8](https://github.com/m5stack/StackChan/tree/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400)。本机版本已由读回镜像与重启日志确认 v1.6.2，见 [真机记录](hardware-check.md)；同版本号不证明公开源码与量产二进制完全相同。

## 已证实的事实

1. 官方 [AgentConfig](https://github.com/m5stack/StackChan/blob/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/server/internal/model/xiaozhi/agent.go) 包含 llm_model、语音、character、memory、MCP endpoints；在该配置结构中没有自定义 LLM base_url，也没有逐轮固定转发目的地。不能把模型下拉框解释成可接任意本地 DSH 会话。
2. [hal_ws_avatar.cpp](https://github.com/m5stack/StackChan/blob/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/firmware/main/hal/hal_ws_avatar.cpp#L384) 中 StartAudioStream/StopAudioStream 的处理是空分支。声明消息类型不能作为已经提供连续音频能力的证据。
3. [AI.AGENT](https://github.com/m5stack/StackChan/blob/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/firmware/main/apps/app_ai_agent/app_ai_agent.cpp) 通过 requestXiaozhiStart 切入小智服务，并提示当前 App 将卸载；不能假定添加一个独立 App 就可以同时复用正在运行的 AI.AGENT 音频服务。
4. [官方使用文档](https://docs.m5stack.com/en/StackChan/) 提供 MCP 设置与原助手操作；未提供本次所需的固定转接和独立免费 TTS 接口契约。MCP 的工具返回不是独立音频/转写订阅。

以上支持“当前接口尚不能据此实现”的结论，不是证明厂商内部永远无法实现。未尝试使用设备私有鉴权冒充另一客户端，也未改网络或云账户配置。

## 与目标相容的技术路线

**优先：原语音服务侧增加确定性路由。** 保持设备与现有语音提供方连接；云端 ASR 后按 handoff 状态转到 Mac 上指定 DSH Session，DSH 文本直接交原 TTS；停止命令由路由层消费并切回原 LLM。必须有厂商支持的接口、原文播报保证、打断和恢复确认、服务可用性与费用说明。公开接口尚未找到，因此这是需上游支持的方案，不是已可安装的实现。

**其次：官方固件增加可选双路音频适配。** 保留原 AI.AGENT，提供桥接模式的输入输出与取消/归还。可以让 DeepSeek 使用同一个麦克风/扬声器，但若原云不开放独立 ASR/TTS，仍需另一套语音引擎；这不能满足“沿用同一个免费云语音”的更强要求。固件开发/部署前需要明确接口与用户授权，当前未执行。

**现有免刷 MCP 方式：** 原助手调用 DSH 工具、播报工具结果。可以继续工作，但模型仍掌握每轮路由，不满足一次接通后确定性接管。不得用固定提示词掩盖这一点。

## 下一项真正的验收

需要得到官方/已验证插件的持续转写、直接播报、打断、归还这四类接口之一套完整契约，并核实设备版本支持。拿到后接入 src/host.mjs 和 src/bridge.mjs，执行「接通→两轮对话→停止→原助手再次回应」实机测试，同时验证声音/服务配置保持原样。

当前严格结论：**尚不能确认在不改原厂免费语音服务的条件下，存在今天就能部署的完整接管方案。** 不把“可编程实现”写成“已经具备所需云端权限”。
