# 持续转接运行核心（2026-11-18）

最新独立应用的实现与状态见 [独立 Agent](independent-agent.md)。下文 original 路径描述保留的自动归还 profile；新增 device-idle profile 不宣称恢复原助手。

最新独立语音组合：[LocalVoice](local-voice.md)已实现真实输入/识别/合成后端与桥、认证传输的接线。下文原厂 adapter 缺口仍成立；[正式 Host 运行控制](voice-runtime.md)已接设置并通过隔离测试，用户会话与真机未验收。

## 先看完成度

已实现：Mac/DSH Host 可组合的转接状态机、指定 Session Controller 适配器、终止与资源归还协议、能力门槛、命令行模拟器。本轮全套 36 项 JS 测试通过（含独立模式及 Host 组合测试）。

未实现/未验证：原厂免费云语音的连续转写订阅、确定性直接播报/打断/恢复接口、机器人实际 adapter、DSH 进程内加载与指定会话实测。**本版本不能安装后直接让原厂机器人持续转接。** `npm run doctor` 预期报告 not ready，退出码 2。

用户选择的会话 ID 只存在忽略的 `.local/binding.json`，文件权限 0600。已在本机找到该 ID 的 DSH 持久化目录，并只读核对 V4 文件头中的身份；没有读取聊天正文、修改人格、启动新 Session 或提交测试提示。保存目标 ID 不等于已经建立运行时绑定。

## 如何运行已有部分

```sh
npm test
npm run demo
npm run doctor
```

运行全套检查先 `npm ci --ignore-scripts` 和 `npm run build:plugin`；核心 demo 不使用开发工具。demo 使用模拟转写、模拟 DSH、模拟播报；既不录音也不调用云模型。连续输入两句会维持同一个绑定；输入整句「停止」后归还模拟原助手。

## 接线与编辑入口

| 问题 | 实现接缝 | 验证 |
|---|---|---|
| 一次接通保持转发 | `src/bridge.mjs::VoiceBridge.enter/receive` | 连续两轮仅绑定一次；队列有界 |
| 停止优先于普通问答 | `isStop/stop/release` | 排队中/连接中/播报中停止，拒绝迟到消息 |
| 原助手没恢复却显示成功 | `release` 的 originalReady 确认 | 未确认/超时/失败进入 recovering，可重试 |
| 沿用指定人格/记忆 | `src/dsh-session.mjs::createDshSessionAdapter` | projections 检查原 ID；prompt 仅传用户原文；不调用 create、不传 system/model/preset |
| 上一轮还在执行，或 DSH 有待处理输入 | `ask` 通过 `SessionController.observeState` 等待 | 转写留在当前语音桥，Stop 能取消未提交输入；混合来源回合拒绝播报 |
| 原厂接口缺失 | `src/factory-voice.mjs` | 进入前拒绝 unsupported-voice，无设备或会话写入 |
| 嵌入 DSH Host | `src/host.mjs::createHostBridge` | 注入 ctx.sessionController 和 agents；未在真实进程加载 |

## 状态和停止语义

默认 profile 状态：original → connecting → bridged → releasing → original。独立 profile 为 idle → connecting → bridged → releasing → idle，必须 deviceIdle=true 确认；createHostAgent 强制选择该 profile。任何归还失败进入 recovering，再调用 stop 重试。连接超时且 adapter 迟到返回 lease，必须等该 lease 被释放才能报告 original。

停止词采用整句匹配：`停止`、`退出DeepSeek`、`回到原助手`、`stop`，允许结尾标点。「不要停止」「如何停止」不会被子串误判。只在转接模式接收 final 转写；commandEligible=false 的长句片段不作为停止命令，旧生产者默认允许；停止不送入 DSH，不等普通问答队列。

本轮按用户最新要求，将单独的「停止」定义为退出转接；此前设计里的“停止仅打断播放”已修正。可另加“暂停播报”命令，但本轮未实现。

退出只解除语音通道与丢弃迟到播报，不销毁或全局取消用户选择的 DSH Agent。已经被 DSH 接受的任务可能继续执行并记入该会话；这是避免中断桌面任务的明确行为。若将来要求取消机器人发起的任务，需要增加按 requestId 删除队列/取消所属 turn 的可靠接口，不能直接无条件 session.cancel。

## DSH 接口证据

核对隔离安装的 0.2.2-rc.3：`@deepseek-ai/dsh-api-session-controller` 的 `projections`、`follow`、`prompt`，以及 `dsh-agent-loop` 的 turn/start、user/message、assistant/message、turn/end。请求使用 `mode: queue`、独立 requestId 和原始用户文本。 [官方 Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md)

2026-11-21 软件修复：prompt 已提交但 Host 回执尚未返回时，本地 AbortSignal 现在可结束语音等待并进入订阅清理；迟到 Promise 的 resolve/reject 均被处理，不重发 prompt，不取消桌面 Agent。真实适配器加内存 controller 的两阶段取消测试通过，真机仍待验收。 [A 方案软件回归](validation.md#2026-11-21-a-方案软件回归)

follow 在 prompt 之前打开。先凭 user/message.data.source.rpcId 找本请求，再取所属 turn 最新、无工具调用、未中断的 assistant 正文。只有支持预合成的 lease 才订阅 `assistantStream`，流式帧有独立的尝试内序号，不推进持久事件的 seq。turn 非 completed、持久事件缺序、流关闭或同轮出现其他用户消息均拒绝输出。流结束或退出仅取消本地订阅。 [尝试确认与首句复用](voice-runtime.md#首句预合成)

已有 DSH 回合、下轮排队消息或用户转向消息会延后这次新语音输入。等待使用官方状态订阅的 `running`、队列位置和游标，收到可用状态才重新检查 follow 的 durable inbox。下轮排队消息和用户转向优先；插件注入的被动上下文（`context`）继续由 DSH 带入下一步。待提交转写仍在现有语音桥有界队列内，受单轮超时和当前连接的 AbortSignal 约束。Stop、Home 或再断线会丢弃尚未发给 DSH 的转写，不取消 DSH 中已经接受的任务。 [流程与回执归属](runtime-sequences.md#连续对话与既有会话)

使用 Host 现有 Session Controller 的恢复策略，保留原会话配置与已装记忆插件的作用域；插件缺失或该会话原本无某类记忆，不会自动补造。尚未验证这台 Mac 的实际人格/记忆插件效果。

## Voice adapter 契约（实现接口，设备端缺口）

默认 profile 必须报告 `continuousTranscripts/speakText/interruptPlayback/restoreOriginal/preservesOriginalAssistant` 全部可用。独立 profile 使用 `continuousTranscripts/speakText/interruptPlayback/releaseToIdle`，acquire 接收 exitTarget，release({target:"device-idle"}) 必须返回 {deviceIdle:true}；originalReady 不可代替。acquire 接收 signal、onTranscript、onDisconnect，返回 lease：`speak(text,{signal})`、`interrupt()`、`release() → {originalReady:true}`。这是桥内契约，**不是已经存在的 M5Stack 官方 API**。

acquire 应在失败时回滚部分占用，响应取消；返回前不得投递转写。可选 activate() 由桥保存 lease 后调用，实际 adapter 在此预热/Start；激活失败也必须释放已持有的 lease。speak/interrupt/release 必须幂等处理取消并隔离旧代次，停止完成后不能迟到播放。事件需唯一 ID、完整转写文本、final=true，不重放已过期的捕获；桥保留最多 1024 个去重 ID。

默认超时为连接/释放 10 秒、单轮/播放 180 秒，待测配置值，非实际性能承诺。默认最多 4 个待处理请求。设备音频 codec/缓冲和 VAD 由真正 adapter 负责，本模块不声称支持某个采样率或直接 Opus。

## 原厂免费语音可行性结论

证据详见 [原厂接管门槛](factory-voice.md)。目前只能确认现有 MCP 结果可以经原云助手播报；不能确认任意 DSH 原文可不经其 LLM 处理而直接合成，也不能确认每次识别都强制发给 DSH。

保持原助手可用，与复用原厂云 ASR/TTS 是两件不同的事。用户已明确允许 DSH 模式使用另一套免费本地 ASR/TTS。当前门槛已改为 preservesOriginalAssistant：保留原助手与可靠返回路径，不要求相同 TTS。factoryMcpVoice 仍因自身缺少输入输出接口而拒绝接管；这不否定其他本地 adapter。具体候选见 local-voice-options.md。

## 本轮检查范围

单元/契约：20/20 通过；包含停止竞争、迟到连接、迟到回复、旧回调、恢复失败、指定 session、人格不覆写、流序列和混合输入。命令行模拟器另做两轮加停止。没有真机连续会话测试，没有独立盲测，没有把模拟语音当原厂恢复证据。

## DSH 插件设置接入进展

2026-11-18 只读安装包确认 0.2.2-rc.3（早期 0.2.1-rc.3 为历史记录）。`src/plugin.mjs` 提供原生 Config/stackchanSettings，`src/settings-view.mjs` 与 controller 提供已有会话选择和偏好保存；具体证据见 [设置页](settings-ui.md#首版原生插件验证2026-11-18)。全套 48 项 JS 通过，其中真实 Cordis 和 DSH 临时 profile 测试验证持久化/冲突/重启。没有真实用户会话输入；语音桥仍未安装或接通，不修改前述真机未完成结论。
