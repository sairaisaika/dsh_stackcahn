# 工作规则

成品实施先读 wiki/product-plan.md 的对应工作包与验收，再核对源码；全局依赖/状态只在本仓计划维护，不将模拟或阶段产物当最终交付。

先读 wiki/README.md，再按问题路由阅读对应章节；以源码验证实现，完成修改后更新 wiki 的状态和验收证据。
编辑独立 Agent 前按 wiki/development-workflow.md 运行 wiki_context prepare，阅读全部路由页，然后 check；Wiki 变化后重新捕获并阅读。此处显式调用自研 skill 的 gate，不宣称 Codex 自动 hook 已启用。手册操作以 wiki/manual-alignment.md 为入口，不能将内部软件重启写成用户要按重启键。
实施前先核对相关官方文档；官方工具是按需选择的工具箱，不局限于 M5Burner，也不表示用户要求烧录。工具选择与限制见 wiki/device-compatibility.md。
保留原厂语音和绑定。未经用户明确授权，不刷机、OTA、擦除、改默认语音服务或启动 App。录音和模型保存在忽略的本地目录，不加入公开仓库。
人格、系统提示、记忆和任务决策属于 DSH；设备项目只提供有版本的能力与事件，不写死助手性格。
当前仓库已有部分运行核心，真机接入未完成；先读 wiki/runtime.md。不要把设计图、mock 测试或上游 README 当成本机实测。
这台 Mac 挂载外置 SSD 时，新的固件构建和大型仿真优先使用 `work/active/`。按 [开发存储与归档](wiki/development-workflow.md#开发存储与归档) 保留发布与恢复证据，及时回收可重建的中间目录。

2026-11-18 用户澄清：DeepSeek 模式可以使用另一套免费本地 ASR/TTS；需要保留原厂免费助手并可切回。不得继续把沿用同一个云 TTS 当硬要求。硬件写入仍需具体方案与恢复路径，当前尚未执行。
