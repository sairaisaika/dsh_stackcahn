# 官方手册与 Sion 操作基线

2026-11-18 核对 [官方手册](https://docs.m5stack.com/en/StackChan/)。本页是用户操作的事实入口；公开源码解释实现，不能替代手册或量产实测。手册会更新，下次相关修改须重新核对对应章节。

| 主题 | 手册明确的行为 | 对项目的约束 / 未知 |
|---|---|---|
| UI Navigation | 主菜单左右滑选功能；顶部向内滑显示状态栏，底部向内滑显示 Home，点击回主菜单 | 不要求用户按重启键。用户报告上滑两次也可返回；这是用户实测，非本轮手册明文。内部 warm reboot 不等于用户重启操作 |
| AI Agent | Hi, StackChan 或点屏唤醒。手册提示连续点屏可能退出唤醒。机身左上状态灯收音绿、播报蓝、空闲灭 | DSH 点脸用本机开始和停止。v60 源码的挂机是常连：设备保持连接，由 Mac 识别「小D在吗」，实体未验收，见 [挂机待命](device-settings.md#挂机待命与语音唤醒) 和 [常连挂机](voice-runtime.md#常连挂机与唤醒词)。设备不再识别任何唤醒词。主人声纹仍未实现。两条头部灯条可另指示 DSH 状态。 |
| 头顶互动 | AI Agent 空闲时，沿顶部触摸区滑动触发开心表情和动作。摇晃机身会触发眩晕表情。开发文档分别演示头顶触点和屏幕手势。 [头顶传感器](https://docs.m5stack.com/en/arduino/stackchan/touchsensor) · [触摸屏](https://docs.m5stack.com/en/arduino/stackchan/touch) | DSH 的 Si12T 头顶轻点、长按和滑动只进入互动报告。基础开麦、停止和 Home 独立处理。 [头顶手势](device-capabilities.md#头顶手势-v2) |
| AI Agent / Setup 更新 | 进入 AI 时检查更新，设置里也能触发 | 锁定的公开源码发现更新或收到强制更新标志时进入升级。Sion 保存的 v1.6.2 设置启用了开机进 AI。首次试启动可能回原厂，按 [首装的更新条件](installation-recovery.md#原厂返回与自动更新) 在重启前确认网络隔离。 |
| Avatar | 对应手机监控/动作等；文档说明语音通话未提供 | 相机和手机控制不能当作已存在的完整双向音频接口 |
| Dance | 手机蓝牙编排音乐、动作、灯光 | 不推定可借 BLE 连续读出机身麦克风 |
| App Center | 下载小游戏、IMU 稳定器、IR 学习遥控器 | 独立镜像 OTA 是源码证据；官方目录第三方上架和 IR 退出契约未确认，见 app-center.md |
| EZData | 尚未可用 | 不将其列成 DSH 已可用存储/记忆能力 |
| 解绑 | 设备或手机解绑均清 AI 设置、对话记录和手机连接 | 不以解绑作为 DSH 配对/故障修复步骤；DSH 配对使用独立配置 |
| 恢复 | M5Burner 的 Only Official 可获取官方固件 | 恢复固件不等于恢复绑定、云端状态或相同版本；以本机备份和恢复验证另行判断 |
| USB / 下载模式 | 两个 USB-C 可传数据，推荐底座；找不到端口时 RST 按住 3 秒进入下载模式 | 下载模式是维护操作，不作为普通返回菜单教程；本轮不操作 |

软件路线：[独立 Agent](independent-agent.md)。安装路线：[应用中心](app-center.md)、[恢复](installation-recovery.md)。上述条目区分手册、源码和用户观察，不表示新固件已通过真机验收。

用户在 Setup 看到的 **App Visibility** 对应 v1.6.2 的内置应用显示设置。它只管理已登记入口的显示。每个 OTA 槽是整份可启动固件，可以包含多个入口。 [App Visibility 与 OTA 槽](app-center.md#app-visibility-与-ota-槽的关系)

启用接入的公开候选在 **Setup → Apps → App visibility** 提供 DSH.AGENT 开关。Setup 始终可见。退出 Setup 后，主菜单按保存的设置刷新。原量产界面的操作仍依照手册。 [DSH.AGENT 显示设置](app-center.md#dshagent-显示设置)

v38 触屏候选沿用底部向内滑、点 **Home** 的操作。它会等待会话资源释放，再在内部软件重启并回到打开 DSH 的同一主菜单。普通开机照常使用原 AI Agent 启动偏好。Sion 当前运行量产 v1.6.2，重启后菜单仍只有原厂界面。 [v38 触屏往返](app-center.md#home-返回同一主菜单)

较早的独立入口试验中，Home 回独立入口，**Factory assistant → Return** 才发起跨镜像返回。Grove 和 USB 属于对应试验的入口。 [启动与返回 V43](dual-boot-updates.md#选择器原型与-v24-原厂返回)

## 官方故障排查与空闲卡死对照

2026-11-20 复核 M5Stack 手册的「异常排查与处理」和 Arduino 触屏示例。手册的网络检查针对原厂 AI Agent 唤醒和播报。硬件检查按症状选择设备设置内的麦克风、RGB 灯或舵机测试。CoreS3 UserDemo 的 Power Test 可看电池和 USB 电压，运行该方案需要另行刷入诊断固件。 [官方硬件故障排查](https://docs.m5stack.com/en/StackChan/#hardware-issues)

对 Sion 的空闲触屏症状，用原厂主菜单的触屏切换作硬件对照，已有的正常使用观察优先复用。候选独立执行 [无 Mac 待命、无调试器的静置测试](hardware-check.md#v56-空闲启动与-usb-的分段验收)。若候选再次无响应，可参照官方触屏示例，在对应的触屏驱动侧记录触摸状态变化，再与应用是否收到点击、是否完成页面更新对照。官方示例单独烧录属于额外的硬件对照。 [官方触屏示例](https://docs.m5stack.com/en/arduino/stackchan/touch)

## 产品手册全项对照

2026-11-20 对照了产品规格和版本变更、开关机和接口、原厂各功能与手机配置、开发快速入门、恢复和自检。下表区分原厂可继续使用的功能、DSH 缺少的接入和现有代码仍需通过的实体核验。 [中文产品手册](https://docs.m5stack.com/zh_CN/StackChan/) · [原厂固件开发说明](https://github.com/m5stack/StackChan/blob/main/firmware/README.md)

| 手册范围 | DSH.AGENT 的现状 | 缺口或待验证 |
|---|---|---|
| 导航、触屏、状态栏与显示批次 | 继承 FT6336U 触屏和 ILI9342C/E 两条初始化路径，使用底部手势与 Home。新增点击到 SPI 完成诊断。 | Sion 的实际 LCD 批次、静置后触屏、真机 Home 往返待验。顶部网络、时间、电量状态栏及亮度、时区控制尚未接入独立界面。 [诊断](hardware-check.md#v56-触屏动作到屏幕传输的日志) |
| AI Agent 的唤醒、语音和状态灯 | 有设备点脸开始、触屏停止、Mac 本地识别与合成、语音停止、选定 DSH 会话和自定义头像。原厂云语音由原厂运行。 | DSH 的口令唤醒和个人声纹属于独立 Wake 项目。实体 USB 对话、Stop、整机状态灯的观感与 Wi-Fi/Relay 声学表现仍待验。原厂单颗灯的颜色提示与 DSH 灯环分别验收。 [设备偏好](device-settings.md) · [连接方式](product-plan.md#连接声音和屏幕) |
| 自身部件控制、表情与互动 | 选定会话已有拍照、有限位置转头、表情、灯环工具。已有音量/静音、头顶 Si12T、BMI270、LTR-553 和电量。垂直舵机软件目标为 5–85°，与手册推荐范围一致。 | 相机实体图像、各外设实体结果及组合释放待验。自动睡眠/摇晃表情、持续旋转、设备端舵机重新校准、BMM150 地磁、IR 和 NFC 尚未接成 DSH 能力。 [能力与工具](device-capabilities.md) · [舵机](motion.md) |
| Avatar、实时监控、手机 Motion 与 Dance | DSH 支持单张照片和命令式控制。原厂手机分身、监控和 BLE/Wi-Fi 舞蹈继续由原厂提供。 | DSH 的实时视频、手机分身及舞蹈编排尚无。手册里的原厂 Avatar 语音通话也尚未提供。 [相机](camera.md) |
| 手机绑定、Wi-Fi、MCP 与 Qoder | DSH 独立配对并使用所选会话，可读取已保存的原厂 Wi-Fi 凭据作为连接回退，亦可另行配置外出中继。 | DSH 独立 Wi-Fi 向导、原厂版 Home Assistant MCP 接入的产品体验需单独评估。Qoder 官方路径是单独的 QChan 固件和账号，具备任务卡片及桌面工作台入口。 [官方 Qoder 教程](https://docs.m5stack.com/zh_CN/guide/stackchan/qoder) · [独立配对](agent-pairing.md) |
| App Center、ESP-NOW 摇杆、EZData | 临时 OTA 启动与恢复已有保存副本演练，原厂应用入口继续由原厂管理。 | 原版菜单持久上架、Home 后重复进入、与官方升级共存尚无完整实体证据。ESP-NOW 摇杆未接 DSH。原厂 EZData 手册仍标为待开放。 [App Center](app-center.md) |
| 两个 USB-C、Grove、microSD、维护和开发工具 | 临时联调使用底座数据口和同机备份。已记录 M5Burner、硬件自检和下载模式。Arduino、UiFlow2 可作为独立开发和板级对照。 | DSH 对用户的通用扩展接口、USB OTG 和 microSD 文件接口尚未公开。独立诊断日志留在内存，Mac 取证后解析，无需在设备上写日志文件。 [设备接口](device-compatibility.md#适合开发的物理接口) · [Arduino](https://docs.m5stack.com/en/arduino/stackchan/program) · [UiFlow2](https://docs.m5stack.com/zh_CN/uiflow2/stackchan/program) |

近期验收顺序是空闲触屏、USB 连续对话与停止、相机及代表性外设、Wi-Fi 和远程、原厂菜单持久入口及升级共存。表中属于原厂的功能和探索项按既有 [产品验收范围](product-plan.md#完整验收矩阵) 处理。
