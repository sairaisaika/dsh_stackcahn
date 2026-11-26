# StackChan 语音与鲸鱼娘软件修复 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 在不操作真机、不安装日常配置档的范围内，修复可复现语音故障并接入鲸鱼娘差分形象。

**Architecture:** 保留现有 DSH 会话适配器、语音桥和固件 Avatar 生命周期。两条 lane 分别占有语音文件和形象文件，主代理统一维护路由与验证文档，最后串行生成资源和构建。根因未复现时只增加保护性测试，不猜测调参。

**Tech Stack:** Node.js ≥22、node:test、Sharp、C++、LVGL、smooth_ui_toolkit v2.12.0、官方 StackChan 锁定提交、ESP-IDF v6.1；Python 3.13 用于本仓脚本。

---

## 执行约束

- 先读本目录设计；爹已确认 A 方案，设计及实施计划已审查后执行。2026-11-21 结果与未完成条件见 [软件回归](../../wiki/validation.md#2026-11-21-a-方案软件回归)。
- 不提交 Git、不重启 DSH、不访问硬件、不启动设备 App、不改绑定/凭证/日常配置档；不得重发已接受 prompt 或全局 cancel 桌面任务。
- 基线：`.local/software-a-baseline-20261121/manifest.json` 及对应限定文件副本。该目录不包含配置档、凭证或会话。新增文件单独列出，不能用整个 untracked 仓库作为本次 diff。
- 新路径先由主代理补具体 Wiki 路由。共享 `.local/wiki-context.json` 只有一个：主代理先确定包含两 lane 文件的完整清单并 prepare/read/check；两个独立 lane 启动时按主代理明确放行顺序，依次用完全相同的完整清单 prepare/read/check，以满足各独立代理的门禁要求。首个 lane 门禁完成并回报后，主代理才准许第二个 lane 捕获；两次记录覆盖范围必须一致，prepare/check 不并发。随后冻结 Wiki、路由和计划，lane 不再 prepare、不改 Wiki。新增路径或必读页面需要改动时暂停两 lane，由主代理统一重捕获并依次复核，不能让不同范围互相覆盖门禁。两 lane 完成后主代理再更新 Wiki、重新捕获并验收。
- 不运行安装、真机 probe、原生会话 rehearsal、模型或音频服务。测试使用内存 controller/音频替身，清楚标注模拟范围。

## Lane V：语音（与 Lane A 可并行）

### V1：固定版本证据

**Files:** 只读 `src/{agent-transport,dsh-session,bridge,local-voice}.mjs`、`wiki/validation.md`，以及该页明确指向的非敏感版本收据。

1. 读取关键源码，记录 SHA-256、当前队列常量与执行路径。
2. 仅检查已知现场收据的文件摘要，不读配对密钥、音频或对话正文。
3. 找不到现场包则记“缺少同版本对照”，不按记忆重建旧逻辑，不把当前回放称为 v56 原因复现。
4. 向主代理回传现场/当前是否可比较；无需修改阈值。

### V2：真实适配器的提交后取消回归

**Files:** `test/dsh-session.test.mjs`；仅在失败证明实现缺陷后修改 `src/dsh-session.mjs`。

1. 阅读已有 fixture，复用 follow/projections/prompt 的实际事件格式，加入 deferred 控制 prompt 回执和已归属 turn/end。
2. 增加两项测试：提交后回执未到时 abort；已归属回合未 completed 时 abort。
3. 分别验证一次 prompt、follow 的 finally 已退出、无任何 controller.cancel；释放 deferred 后迟到 completed 不产生回复。每项注册清理，避免测试挂起或未处理 rejection。
4. Run: `node --test test/dsh-session.test.mjs`。如果新测试失败，应记录准确断言、原因与挂起阶段，禁止用真实长时间 sleep 掩盖。
5. 最小修复仅限被证明有问题的取消等待；等待槽、rpcId/turn 归属过滤和 completed 条件不放宽。
6. 再运行相同命令，应全部通过；既有测试保持通过。如果本来通过，保留新增回归并报告“未发现该分支缺陷”。

### V3：Stop 及迟到回复的桥接回归

**Files:** `test/local-voice.test.mjs`、`test/bridge.test.mjs`；必要时 `src/local-voice.mjs`、`src/bridge.mjs`。

1. 在既有替身测试之外，用真实适配器接内存 controller 测试提交后 Stop。
2. 断言停止本通道、清队列、迟到文本/音频均不播报，桌面任务不被 cancel、不重新 prompt。
3. Run: `node --test test/dsh-session.test.mjs test/bridge.test.mjs`。LocalVoice 仅跑已审内存用例：`node --test --test-name-pattern='^(a capture gap drops|a failed DSH turn speaks|spoken Stop is recognized while DSH is pending|capture and recognition continue while synthesis waits)' test/local-voice.test.mjs`。禁止全文件运行，其中含 localhost listener 与 opt-in 模型场景。
4. 出现失败先缩小到对应取消路径，写最小修复后重复命令。预期全部通过；不改业务超时作为修复。

### V4：827ms 两种轨迹回放

**Files:** `test/agent-transport.test.mjs`；只有回放失败才考虑 `src/agent-transport.mjs`。

1. 阅读现有队列/代次测试，用相同帧序列区分“消费者暂停”和“帧集中到达”；10ms 帧的 827ms 间隔不使用墙钟 sleep。
2. 断言有界队列、generation 何时增加、清队列后的旧识别结果不能提交；场景本身不应无证据地引入新的 Stop 策略。
3. 容量越界另立测试，不将 827ms 与 4s 容量混淆；只测当前事实，旧版本只有可得的原代码可对照。
4. Run: `node --test --test-name-pattern='^memory USB ' test/agent-transport.test.mjs`；LocalVoice 仅运行 V3 列出的内存白名单。当前三例只证明 transport FIFO/generation；本轮未新增把双轨迹与跨代 ASR 组合的验证。不得全跑 transport / LocalVoice 文件中的监听场景。

## Lane A：形象（主代理确定新增路径路由后执行）

### A1：图像生成的失败用例与可导入边界

**Files:** `scripts/build_whale_avatar.mjs`；新增 `test/whale-avatar-assets.test.mjs`（主代理先补路由）。

1. 读取生成器完整内容，保留既有输出路径和输入。将像素放置函数暴露给测试时，CLI 入口必须有直接执行判断，import 不得写文件。
2. 新增测试覆盖 C12 实图和至少一个非零 padding/边缘裁切用例：输出 width=320、height=240、channels=3、data.length=230400。使用合成图测试可避免依赖源图分发许可。
3. Run: `node --test test/whale-avatar-assets.test.mjs`，记录旧管线失败的字节量；不能先改实现再声称 RED。
4. 使用两阶段物化，核心逻辑为（变量和返回形状跟现有调用保持一致）：

```js
const padded = await sharp(input)
  .extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' })
  .removeAlpha().raw().toBuffer({ resolveWithObject: true });
const result = await sharp(padded.data, { raw: {
  width: padded.info.width, height: padded.info.height, channels: padded.info.channels,
} }).resize(scaledWidth, scaledHeight, { kernel: 'lanczos3', fit: 'fill' })
  .extract({ left: cropLeft, top: cropTop, width: 320, height: 240 })
  .removeAlpha().raw().toBuffer({ resolveWithObject: true });
if (result.info.width !== 320 || result.info.height !== 240 ||
    result.info.channels !== 3 || result.data.length !== 320 * 240 * 3) {
  throw new Error('whale-avatar-invalid-frame');
}
return result.data; // place() 保持既有 Buffer 返回契约
```

5. 运行测试为 GREEN；测试导入前后没有资源输出变化。生成过程对每张图和补片做尺寸、通道、字节检查，写文件前完成全部校验。

### A2：统一资源接口与语义

**Files:** `firmware/agent/whale_assets.{h,cc,S,bin}`、`firmware/agent/whale_avatar.h`、`scripts/build_whale_avatar.mjs`。

1. 以当前生成头 Face/Talk/Blink/Hand 为唯一契约，检查 offset+length 不越 blob，RGB565 字节序与 LVGL 格式一致。
2. 修复 C++ 资源描述符和 Avatar 消费接口；不能再引用不存在的 Base/Eyes/Mouth/Top 枚举。
3. 先用测试/离线编译捕获接口错误，再最小修复；生成结果由主代理串行生成，lane 不生成共享 blob 或预览。
4. 摸头不能继续映射为“得意”；缺少可核对的脸红差分时使用明确标注的中性脸加摸头补片，不宣称现成摸头素材。悲伤同样不能用吃醋脸替代，需核对视觉与来源或标为待选，不伪造六态验收。
5. 图集逐图许可核查及出处先回传主代理；权利不明不得新增下载/打包或对外分发。

### A3：外观设置兼容

**Files:** `firmware/agent/preferences.h`、`firmware/agent/preferences_test.cc`、`firmware/agent/device_main.cc`。

1. 阅读原有持久化格式和版本迁移。当前已有 Whale=3 与 v6 草稿，DecodePreferences 将旧 Default 强制迁为 Whale；先修正测试预期为历史 Default 保持，保留 Fish/Text 值、Whale 往返与非法值拒绝测试。非法记录沿用载入层安全回退，不用新增解码规则掩盖 CRC/格式错误。
2. 不运行会串联配对/relay 的总脚本，只编译运行已读的 preferences host 用例：`mkdir -p .local/software-a-host-tests && clang++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -g -pthread firmware/agent/preferences_test.cc -o .local/software-a-host-tests/preferences && .local/software-a-host-tests/preferences`。预期在旧 Default 兼容断言处 RED；若编译环境先失败则记录实际失败，不把环境错误当目标 RED。不运行硬件 probe。
3. 删除强制 Default→Whale 迁移，复用已有枚举值、合法范围和 v6 格式，补外观选择项；只在选择 Whale 时构建 Whale Avatar。不改变默认值、不写实体 NVS。
4. 重复第2步精确命令，目标用例 GREEN，既有 preferences 用例通过；编译前检查 Default/Fish/Text 分支仍存在。

### A4：摸头与页面生命周期

**Files:** `firmware/agent/whale_avatar.h`、`firmware/agent/device_main.cc`；确有需要才改 `head_touch_gestures.h` 和对应测试。

1. 阅读现有官方 HAL 手势消费与 Avatar 生命周期，测试 Press/Release/swipe 到短动画、到期恢复，不触发舵机或启动连接。
2. 测试页面退出时动画更新/事件解绑，重复进入退出不持有旧页面指针。
3. 保持通话状态 TapFace Stop 与原厂返回入口；不把脸部触屏事件替换成摸头事件。
4. 用 host 单测与静态源码验证分别记录能力边界，无法 host 模拟的 LVGL 生命周期进入固件构建/真机待验项。

## 主代理串行整合

### I1：审查与串行生成

1. 收集两 lane 的准确修改清单、RED/GREEN 证据、未完成事项。对照本轮 baseline 逐文件 diff，确认没有对方或共享页面被覆盖。
2. 分别做规格和代码质量审查；缺陷修复后重复相关测试。
3. 确认生成器输出白名单后运行 `node scripts/build_whale_avatar.mjs`，检查预期资源变更和 blob 边界。
4. 打开实际修后预览，检查每态脸部、眼口对齐、裁切、摸头手势；尺寸断言通过仍不等于视觉通过。若图语义/来源未满足则明确待选，不冒充成品。

### I2：测试与固件构建

1. 不直接运行 `test/*.test.mjs`。先完整审查显式白名单的测试及其导入依赖：`test/dsh-session.test.mjs`、`test/bridge.test.mjs`、`test/local-voice.test.mjs`、`test/agent-transport.test.mjs`、`test/whale-avatar-assets.test.mjs`。确认没有真实模型/音频服务、硬件、日常配置档访问或外网请求后 Run: `node --test test/dsh-session.test.mjs test/bridge.test.mjs test/local-voice.test.mjs test/agent-transport.test.mjs test/whale-avatar-assets.test.mjs`。本批不启动监听；如其中用例必需 localhost 监听先隔离标记待验，不自动扩大范围。记录实际通过/跳过/失败数量及审查排除项；opt-in 不启用。要扩展全套测试须先逐项盘点副作用，独立记录允许的临时 loopback、身份夹具及生成目录，不能将总脚本直接等同纯内存测试。
2. 阅读 `scripts/prepare_agent.py`、`scripts/build_agent.py` 及 Wiki 中锁定构建说明，确认现有 SDK 与外置 work/active 可用。
3. 只在全新有版本名目录准备构建；不修改旧 prepared checkout，不联网下载工具链。SDK/磁盘不可用则报告具体条件，不转系统盘、不刷机。
4. 构建通过后核对 Flash 分区和只读资源体积；不自动运行或安装。主代理记录真实命令、退出码、产物摘要及软件验证限制。

### I3：Wiki 和交付

**Files:** `wiki/validation.md`、`wiki/device-settings.md`、必要的 `wiki/runtime.md` / `wiki/voice-runtime.md` 及精确路由。

1. 更新本次根因、离线证据、形象入口和仍缺的素材/真机项，不覆盖 v56 历史。
2. 检查已有图示与变更是否冲突；写明已核对无需更新或更新图示。
3. 重新 prepare、读取更新页面、check，再运行现有文档结构检查。
4. 交付源码与预览链接、测试实数、候选构建状态及真机验收清单。停止在硬件前，等待爹另行授权；不能声称完整目标已通过。

## 2026-11-21 执行结点

- V2、V3、A1–A4 的限定软件变更与 host 回归已完成，最终静态审查无新增 P1/P2。A4 只接现有 fresh Snapshot，未改手势识别，也未证明真实 LVGL/实体头触摸。
- V1 缺同版本 v56 原包；V4 完成当前 transport 两轨迹及容量三例，尚无双轨迹与跨代 ASR 的新增组合证明。生产 transport/bridge/local-voice 不调参。
- I1 逐图许可未闭合而停止；未生成新预览或资源，旧 blob 门禁关闭，不能交付可用 Whale 外观。I2 外盘路径 PATH_RESTRICTED 而未执行完整固件构建，不绕路、不改用系统盘。
- I3 已回写入口、运行规则及软件验收。既有关系图保留为历史；本轮未重新渲染或验收整套图示，当前状态以最新软件验收及源码为准。未发现专用 Wiki 结构测试，收尾采用限定文档本地链接检查与重新捕获门禁；二者均不证明运行正确性。
- 综合测试曾误运行一个 localhost TLS listener 例，偏离禁监听约束，已记录并更正后续命令；不得用全量测试重跑本阶段。

## 真机验收单（本阶段不执行）

同会话连续两轮；播报中语音 Stop；等待时退出且桌面任务继续；触屏 Stop；头触摸动画恢复；反复页面切换；Host 停顿恢复；原厂返回。执行前另给候选摘要、当前设备状态和恢复方案。
