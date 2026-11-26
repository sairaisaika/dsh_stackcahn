# StackChan 语音与鲸鱼娘形象：软件 A 方案

状态：2026-11-21 爹已在本会话确认 A 方案及并行修改、测试软件；本文是该确认的落盘设计，尚未实施代码。真机写入与日常配置档安装不在授权内。

## 目标与边界

并行修复 StackChan↔DSH 语音链路和指定图集形象。保留已有会话、模型、人格、原厂服务绑定以及 Default/Fish/Text 外观。禁止自动重启 DSH、刷机、OTA、擦除、启动设备 App、操作硬件、安装到日常配置档、改凭证或自动重发已接受的提示。退出语音只释放本通道，不全局取消桌面任务。没有 Git HEAD，不创建提交；以限定文件副本和 SHA-256 为本轮基线。

## 已核实证据及不确定性

- v56 真机记录：收音后首轮尚未出现 dsh-turn-returned，Host gap 827ms 后发生过载 Stop。无法据此判断模型、桌面任务或当前源码存在同一故障。
- 当前 src/agent-transport.mjs 使用 inputBacklogFrames=400、inputBatchLimit=4，清队列递增 generation；与旧过载策略不同。先核对文件摘要与证据版本，旧包不可得则明确无法做同版本对照，不重建猜测的旧实现。
- src/dsh-session.mjs 依次等待 prompt 回执、归属回合 completed；取消仅撤订阅。现有测试未完整覆盖提交后取消和迟到结束。
- scripts/build_whale_avatar.mjs 中 Sharp extend/resize/extract 单链产生错行。C12 样本应为 320×240×3=230400 字节，原链得到 237168 字节；先物化补边再缩放的内存探针得到 230400。尚未验证修后图片或固件。
- whale_assets.h 是 Face/Talk/Blink/Hand 接口；whale_assets.cc、whale_avatar.h 仍为 Base/Eyes/Mouth/Top 接口，device_main.cc 尚未接鲸鱼娘。
- 草稿 C82 得意→pat、C84 吃醋→sad 是语义不准确的临时映射。手和爱心为脚本绘制，不能写成现成摸头差分。
- preferences.h 已有 Whale=3 和 v6 编码草稿，但 DecodePreferences 会将 v1–v5 的 Default 自动迁移为 Whale；对应测试也固化了此行为。该草稿尚未接入设备外观入口。本方案需要纠正该迁移，使历史 Default 选择保持不变，不重复添加已有枚举。

## 方案比较与选择

A（已确认）：保留架构，语音按回归证据局部修复，形象统一现有整脸与局部动画接口。B：重写调度/渲染，范围大且证据不足，放弃。C：只接静态形象，缺少所需差分，保留为构建资源不足时需重新确认的降级选项。

## 语音设计

1. 记录当前关键文件摘要，查可读的现场证据摘要；不读取受保护 asar，不读取配置档凭证或会话正文。
2. 使用真实 createDshSessionAdapter 与内存 controller 测试：prompt 回执等待、归属回合结束等待、Stop 后迟到事件。断言提示只提交一次、零全局 cancel、订阅退出、迟到内容不播放。失败要证明是实现问题，再做最小改动。
3. 固定输入轨迹覆盖 827ms 消费者暂停及突发到达两个场景，验证队列容量、generation、重置与 Stop 行为，避免真实 sleep 和机器负载依赖。不可把模拟写成现场复现。
4. 如需要可观测性，只记录固定阶段/计数/耗时，不写音频、提示词、回复或身份信息。保持当前对外错误码及桌面任务隔离。

## 形象设计

- 优先统一到已有 FaceImage/TalkImage/BlinkImage/HandImage 接口，避免再设计一套资源格式。整脸放只读资源区，口型/眨眼/手势局部更新；不能每帧解码整图或无界分配。
- 图像生成拆为补边原始像素物化和定尺寸缩放裁切两步；每张图检查宽高、通道、字节长、资源偏移和边界，失败不得产出可误用的资源。
- 新增 Whale 外观选项；保留旧 NVS 值与默认行为，新增值验证和往返测试。无效值回退已有安全默认；不自动切换设备设置。
- 复用官方 HAL 及现有头触摸手势，短暂摸头动画到期恢复表情。页面退出销毁对象、停止更新并释放本页资源；重复进入退出无重复事件或遗留指针。
- 通话时现有 TapFace Stop 保持；摸头不触发通话、不启动服务、不驱动舵机。表情六态语义保持；不得把得意当摸头或吃醋当悲伤蒙混验收。

## 素材与官方依据

优先使用爹指定图集已有素材，逐张保留出处和适用许可。图库协议不覆盖原作者权利；权利不明的新增素材暂缓引入或分发，不能据代码 MIT 推定图片 MIT。需要裁切或自绘补片时明确标注，预览呈现实际效果，不声称它是原图已有差分。

- M5Stack StackChan 文档：https://docs.m5stack.com/zh_CN/StackChan
- 锁定上游：m5stack/StackChan 28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400；ESP-IDF v6.1 fff9895c82d744c7237be8847347bdd1b07c6643；smooth_ui_toolkit v2.12.0。
- Avatar：https://raw.githubusercontent.com/m5stack/StackChan/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/firmware/main/stackchan/avatar/skins/default/default.h
- HAL：https://raw.githubusercontent.com/m5stack/StackChan/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/firmware/main/hal/hal.h
- Sharp 顺序依据：https://sharp.pixelplumbing.com/api-resize/#extend
- 图集逐图权利：https://github.com/Iphsiibl/deepseek-whale-girl-gallery/blob/main/ATTRIBUTION.md

## 并行所有权与验证

语音 lane 独占 src/dsh-session.mjs、src/bridge.mjs、src/agent-transport.mjs、src/local-voice.mjs 及对应 test；形象 lane 独占 scripts/build_whale_avatar.mjs、firmware/agent/whale*、device_main.cc、preferences*、head_touch_gestures* 及相关新增测试。主代理独占路由、Wiki、设计、计划和整合。两 lane 不修改共享 Wiki 或运行全量生成/构建，不碰对方文件；先通报扩大范围需求。主代理审核全部差异并运行整合测试。

离线验收：相关 Node 测试、图像各项断言及修后预览、固件 host 测试与离线编译。新大型构建仅在已确认可用的 work/active/ 外置路径独立目录；不得覆盖旧准备目录，不能为构建下载或升级工具链而扩大范围。

真机待验收：相同 DSH 会话连续两轮、播报中语音 Stop、等待时退出与桌面任务继续、触摸 Stop、摸头动画恢复、反复页面切换资源、Host 停顿后恢复。上述均未执行；离线测试和固件编译不能替代真机通过。
