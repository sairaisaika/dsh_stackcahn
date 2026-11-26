# 本地免费语音 + 文字工具转接（2026-11-18）

## 新约束与结论

用户明确：原厂免费语音保留、能切回即可；DSH 接管时允许另一套免费本地 ASR/TTS。前一轮把“同一个云语音必须复用”当成硬条件过强，现已修正。DSH 会话仍使用本地选择配置，不新增另一套人格/记忆。

结论：社区已经证明 StackChan 可以使用本地识别/合成，也有后台文字转接 Agent 的源码。尚未核实一个现成项目同时提供“现有原厂不替换、指定 DSH 会话、说停止即时返回原助手”的完整成品。关键缺口缩小为设备双后端切换与 DSH provider 接入，不再等待官方开放免费云 TTS。

## 重点候选、维护与限制

| 项目 | 证据与最近状态 | 如何采用 |
|---|---|---|
| [rebelthor/warble](https://github.com/rebelthor/warble) | whisper.cpp + Silero + Piper + Ollama；支持 macOS/arm64。最新提交 6/16，9 次提交，无 release，维护者说明 best-effort | 小而直接的语音/设备协议参考。connect/disconnect 经 USB 修改 NVS ota_url 并复位，不是热切换；不可直接照搬为“说停止” |
| [Jonaaaa/StackChan-LocalAI](https://github.com/Jonaaaa/StackChan-LocalAI) | SenseVoice + Kokoro，本地小智服务。最新 7/16，3 次提交，无 release | 验证原固件可经 NVS 重定向；恢复原 NVS 返回云。CC BY-NC 4.0，不能作为宽松许可代码直接复制进本项目 |
| [BrettKinny/dotty-stackchan](https://github.com/BrettKinny/dotty-stackchan) | 本地 ASR/TTS + pi Agent，10/29 固件 fw-v1.3.5，11/13 最新公告宣布硬件故障暂停开发，PR 可能无人回应 | Agent 接入思路可参考；不优先投主要贡献。默认 Kid Mode/persona 不能带进我们的 DSH |
| [DrakTheDude/stackchan-local-llm](https://github.com/DrakTheDude/stackchan-local-llm) | 最新 10/25，9/20 v0.5.0；作者声明单台真机验证 | 完整本地链路参考，但替换固件、存在原厂功能差异，不符合无缝保留原助手的即装要求 |
| [migratorywhale/stackchan-mcp](https://github.com/migratorywhale/stackchan-mcp) | 10/7 有修复；脚本后台采集转写并发给选定 frontend session | “文字转接”直接证据。自己的 Arduino 固件；默认 Fish/Groq/Edge 不是全本地免费组合，需要换 ASR/TTS provider |
| [xinnan-tech/xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server) | 11/16 仍有功能与合并提交，多个社区整套方案都在用 | 优先评估其语音流水线与自定义 Agent provider，减少自己重写 Opus/VAD/ASR/TTS |

快照存放于 [候选维护记录](local-voice-maintenance.json)。日期表示观测，不把旧更新自动等同弃坑。Dotty 暂停来自明确公告，不是由提交频率猜测。

## 源码核查

warble @ ed98ba1dbda047977d2fdee0236d0a94fb63f0a9：

- `server/internal/pipeline/pipeline.go` 真正连接 ASR、LLM、TTS；RunFromText 仍会经过 LLM，并非纯 TTS，不能误当 speak 原文接口。
- `server/internal/llm/ollama.go` 调用 /v1/chat/completions；直接改成 DSH 模型网关不能自动复用指定 DSH Session。需要替换这一层为我们的 Session adapter，并关闭其第二套 system prompt/历史。
- `warble::cmd_disconnect` 指向官方 OTA URL；`nvs-tool/switch_backend.sh` 实际读取、修改、写入 NVS 和复位。脚本还会打印部分配置项，本轮没有运行。

migratorywhale @ 7673c4c9cb93…：`scripts/stackchan_voice_bridge.py` 的 while 循环调用 capture_ready_recording → 生成 transcript → forward_event_to_frontend；`resolve_wake_session` 支持指定会话。证明 Agent 边界只用文字完全可行。其默认唤醒筛选和供应商不等于我们的确定性持续转接。

mountgram @ d252568fe289…：REMOTE.AGENT 的 onClose 停止音频任务、连接与检测器并恢复 Avatar；这证明 App 有清理生命周期，尚不证明退出自动启动原 AI.AGENT 或原云连接恢复。应在此类兼容固件方案上补明确切回接口，而不是假设 close=原助手已恢复。

## 两种文字工具转接，不能混为一谈

A. 原厂云助手主动调用 dsh_chat 工具：可以用，用户不必每轮口头说“调用工具”；工具调用本身仍可能每轮发生。会话模式与描述能改善自动转发，但云模型仍决定是否调用、如何转述。不能保证确定性逐轮转发/原文播报，不作为成品主链路。

B. 本地后台循环：机器人收音 → 本地 ASR → DSH 指定 Session（文字）→ 本地 TTS → 机器人播报。工具或普通函数负责设备 I/O；后台程序持有循环与停止检测，DSH 无需决定下一轮是否继续 listen。它可以实现持续接管，是本项目主路线。

“听/说通过工具”没有根本问题；要核实工具究竟能否取到麦克风、播放音频，以及停止时是否能释放硬件给原助手。

## 本地语音选择

识别候选：whisper.cpp（Mac/Apple Silicon 路线）或 SenseVoice；合成候选：Kokoro 或 Piper。下载后本地推理无需按次云 API 费用，仍占内存、磁盘和电力。DSH 模型的费用/服务仍按它原有来源计算，不因本地语音而免费。

Kokoro 官方模型卡标 Apache-2.0；Piper 引擎为 GPL-3.0，具体 voice 文件还需核对许可。中文识别、中文音色与速度要在此 Mac 上实测，不能由英文示例推出。EdgeTTS 虽常被称免费，仍是云端，不列入离线方案。

## 收敛的实现路线

1. 采用现有本地小智语音链路/设备协议，把其中 LLM 层替换成指定 DSH Session adapter。禁止引入第二套 personality/history。
2. 沿用本项目 VoiceBridge 控制连续会话、停止优先级和迟到消息隔离；preservesOriginalAssistant 只要求保留原助手，允许 DSH 模式不同音色/引擎。
3. 明确实现并验收设备双后端/双 App 切换：原配置独立保存，进入只选本地链路，退出关闭本地捕获/播放并启动原助手。研究是否可通过兼容固件扩展完成；目前未验证这台设备，不能把 USB 写配置当日常语音切换。
4. 优先贡献通用 DSH/外部 Agent provider 或设备切换接口到方向相符的维护中项目；暂停项目仅参考。未读实现并确认兼容前不直接整套安装。

本轮仅克隆/读代码、修订本地契约与 wiki；未执行 NVS 写入、刷机、重启设备、安装模型或改变当前语音服务。

成品实施顺序以 [product-plan](product-plan.md) 为准；以下选型不等于已安装。

源码补查：xiaozhi-esp32-server @ 61a8c04477a1334447679e319dccaad3db3e43dc，`core/handle/receiveAudioHandle.py::startToChat` 在 ASR 后经过 intent 再 submit(conn.chat)，`core/connection.py::chat` 持有自身 dialogue/memory 并调用 LLM。`core/providers/llm/base.py::response` 接口只有 session_id/dialogue。故单加 LLM provider 不足以实现我们需要的停止优先级和无第二套人格；P2 应在识别入口旁路本地 intent/dialogue/LLM 循环，将 final 转写送 VoiceBridge，并接纯 TTS 输出/取消，或选更小的语音组件。
