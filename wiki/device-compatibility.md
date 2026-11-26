# 设备兼容与恢复边界

归属 [P0 / P1](product-plan.md#按依赖推进的工作包)。2026-11-18 已完成授权的真机只读检查、两份全量备份与原固件重启；详细证据和限制见 [真机检查记录](hardware-check.md)。新固件功能与恢复写入尚未验收；候选的五项安装前门槛及分级恢复见 [安装方案](installation-recovery.md)。

## 已确认和未确认

| 对象 | 当前证据 | 能说明什么 |
|---|---|---|
| Sion 固件 | 读回镜像和重启日志均为 stack-chan v1.6.2 / IDF v6.1 | 当前原助手在 ota_1；已保存并校验 |
| USB | macOS 枚举 Espressif USB JTAG/serial、VID 0x303a / PID 0x1001 | 存在 ESP USB 设备；不能单靠它证明板型、分区或绑定状态 |
| 官方硬件 | [StackChan 文档](https://docs.m5stack.com/en/StackChan)：CoreS3 / ESP32-S3，16 MB Flash、8 MB PSRAM | 本轮仅构建官方 M5STACK_STACK_CHAN；不承诺其他自制 StackChan 兼容 |
| 官方源码 | [锁文件](../firmware/upstream.lock.json)，PROJECT_VER 1.6.2 | 官方 commit + 小智 v2.5.2 + 官方补丁 + 所有直接 Git 依赖已固定 |
| SDK | ESP-IDF v6.1，Mac arm64 本地工具链 | 官方基线与启用双模式扩展的完整固件均构建通过；见构建记录 |
| 原助手 | 本轮只读备份后已重启原固件；日志到 idle | 未写 Flash/配对配置；用户已现场确认原语音回答和手机绑定正常，新固件恢复仍未实测 |

构建记录：[官方基线](../firmware/baseline-build.json)、[扩展固件](../firmware/sion-build.json)。二进制、SDK、日志放在忽略的 work/；记录中的哈希用于标识本次产物，不保证不同路径/时间的构建逐字节相同。

## 按官方工具分工

先读 [官方源码构建说明](https://github.com/m5stack/StackChan/blob/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400/firmware/README.md) 与 [ESP-IDF v6.1 macOS 安装说明](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/get-started/macos-setup.html)。源码构建使用 ESP-IDF，M5Burner 用于查询官方发行版本和评估后续烧录/救援。

[StackChan 官方文档](https://docs.m5stack.com/en/StackChan) 有 M5Burner 下载/烧录步骤；官方固件、UiFlow2、Qoder 是不同固件路线，不能为了测试工具而覆盖现有原助手。M5Burner 中先筛选官方条目并确认版本、芯片、写入地址和擦除范围。当前没有安装或启动烧录操作，也没有把网页列表中的“最新版本”当作本次 v1.6.2 的等价备份。

官方软件作为工具箱按任务选择，用户提及这些工具不代表要求安装或烧录。除下列明确已使用项外，本轮只查文档：

| 工具 | 官方用途及当前判断 |
|---|---|
| ESP-IDF | 已用于官方 C++ 固件基线、双模式修改与完整编译；适合本轮协议/音频生命周期开发 |
| [AiFlow Web / Desktop](https://docs.m5stack.com/en/aiflow/usage) | 自然语言生成 MicroPython、部署和调试；Desktop 有 Skills/MCP。可参考开发与资源管理流程，但不等于自动共享选定 DSH 会话；[设备接入说明](https://docs.m5stack.com/en/aiflow/desktop) 要求对应固件，不能当作现有原厂固件上的无损调试器 |
| [UiFlow2 StackChan](https://docs.m5stack.com/en/uiflow2/stackchan/program) | 图形化硬件开发路线，可参考硬件能力示例；本轮保留官方 C++ 助手运行基线，不切换设备固件 |
| Block Designer | 已列入官方工具清单；本轮没有 Blockly 自定义模块需求，详细兼容与接口留到实际使用前核对，不声称已测试 |
| [EzData 2.0](https://docs.m5stack.com/en/uiflow2/blockly/ezdata/ezdata_manager) | 云端设备数据共享；当前本地语音/会话桥不需要再引入该云存储 |
| [VLW Font Creator](https://docs.m5stack.com/en/guide/tools/vlw_font_creator) | 字体范围/尺寸资源生成；后续显示文本和字体占用优化时可评估，须先核对所用显示后端 |
| [EasyLoader Packer](https://docs.m5stack.com/en/guide/tools/easyloader_packer) | 将 BIN 与 esptool 打包为 EXE，属于后续 Windows 发行便利工具，不是当前 Mac 编译链 |
| Web Burner / M5Burner | 官方固件发现、后续安装与救援工具；采用前核对具体条目和操作影响 |
| Device USB Driver | 仅在设备连接问题与芯片类型证据表明需要时选用；当前 Mac 已枚举 USB 设备，没有为此安装驱动 |

## 刷写前必须形成的具体材料

此处为安装前检查顺序，**不是可直接照抄的烧录命令**。1–2 的只读材料已经取得；恢复写入和新固件安装尚未执行，具体证据见真机检查记录。

1. 对准物理设备和端口，确认实际 Flash 容量、分区表、安全启动/加密状态、正在运行的 OTA 槽与版本。USB 产品名不够。
2. 保存设备完整可读备份、实际分区表及校验结果到私有目录，包含原 NVS / OTA 元数据 / 资产。读回工具不能保证导出云端绑定；保留同设备身份并另行验证官方恢复流程。
3. 对比设备实际布局和新产物；为保留配置，单独评审应用更新与必要资产变化，不直接执行构建输出的全套 flash 建议。没有证据时不得猜写入偏移。
4. 独立 sion 配对配置只允许增量写入自己的键，必须具备容量检查、备份、失败回滚和删除步骤。[配对工具](pairing.md)已实现增量写入、容量检查与双槽提交，尚未在真机执行；不能生成一个空 NVS 分区覆盖原 NVS。
5. 明确恢复哪一个应用槽、何时需恢复元数据，以及恢复后如何验证原唤醒、语音、手机绑定。M5Burner 官方重装作为救援选项，不能当成已证明无损恢复。
6. 向用户给出确切文件/哈希、影响分区、备份位置、恢复步骤与验收清单，再进入真机安装。本轮没有到这个执行点。

锁定官方源码的布局供比较：NVS 0x9000 / 0x4000，otadata 0xd000 / 0x2000，ota_0 0x20000 / 0x4f0000，ota_1 0x510000 / 0x4f0000，assets 0xa00000 / 4 MB。本轮实际读回已确认这些偏移/大小；原助手当前位于 ota_1，实际 OTA 元数据不得替换成源码初始值。

preservation-trial-v3 启用扩展时只读已有原服务配置，远端刷新/激活和所有已审查的更新入口被阻止；过期凭据处理及完整升级策略仍待解决，详见安装方案。实际读回与尚未完成的验收见 [检查记录](hardware-check.md)，配对步骤见 [配对指南](pairing.md)。


## 适合开发的物理接口

依据 [StackChan 官方说明及 PinMap](https://docs.m5stack.com/en/StackChan)、[CoreS3 PinMap](https://docs.m5stack.com/en/core/CoreS3) 和 [ESP32-S3 内置 JTAG 文档](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/jtag-debugging/configure-builtin-jtag.html)。本次是文档/原理图核对与 USB 枚举，未拆机、改线或实测其他端口。

| 接口 | 对本项目的用途 | 当前判断 |
|---|---|---|
| 底座 USB-C | 备份、串口日志、后续独立配对；内置 USB JTAG 可用于调试 | 首选。官方推荐底座口以避免电机动作牵扯线缆；本次 USB Serial/JTAG 读取和日志成功，JTAG 调试器尚未运行 |
| 主机 USB-C | 同样支持数据 | 可用，但活动头部接线不如底座合适；不能通过 Mac 枚举判断用户线缆插在哪个物理口 |
| Grove Port C：G17/G18 | PC_TX/PC_RX，未来可配置独立 UART 通道 | 要有相应固件路由/电平匹配串口适配器；不是接上就能用的第二个原厂控制台 |
| Grove Port A：G2/G1 | SDA/SCL，I²C 外设扩展 | 更适合传感器，不替代现有 USB 调试 |
| Grove Port B：G9/G8 | 通用输入输出/扩展外设 | 按外设与固件配置选用；本轮无须占用 |
| M5-Bus：G43/G44 等 | UART0 TX/RX 及更多板级信号 | 需要核对结构与占用，当前没有必要拆机；G6/G7 已用于机身舵机，不得当空闲串口 |
| microSD | 后续资源与本地日志存储 | 需固件支持；不是直接导出原语音/账户的接口 |

日常音频/摄像头数据继续评估 Wi-Fi，USB 负责开发与恢复。USB Serial/JTAG 的存在不表示设备已经提供 USB 麦克风/摄像头，也不会绕过原厂固件缺少连续音频开放接口的限制。当前没有必要添置另一套调试硬件。

## 底座 USB-C 真机调试

官方手册给出了数据口和下载恢复流程。ESP32-S3 另外支持内置 USB JTAG，用 Espressif OpenOCD 和与运行镜像匹配的 ELF 可以单步、查看调用栈与设置硬件断点。Mac 当前枚举到一个 Espressif USB Serial/JTAG，已用既有双读备份的设备身份匹配到 Sion。此次只查询端口清单，尚未附加到芯片。量产 v1.6.2 的源码级断点需要该发行镜像匹配的符号文件。 [M5Stack 手册的恢复入口](https://docs.m5stack.com/en/StackChan/#restore-factory-firmware) · [Espressif 内置 JTAG](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/jtag-debugging/configure-builtin-jtag.html)

现场先在原厂 Settings 里分别检查 Mic Test 和 RGB LED Test，并记录原助手点屏与 Home 的基线。经具体设备方案确认后，调试自己的 DSH 镜像用同版本 ELF，先在电机静止、语音停用时验证 JTAG 识别和运行态恢复。使用硬件断点，省去改写 Flash。测试触摸轨迹、LED 变化和声学延迟时让程序连续运行，使用时间戳记录，断点用于定位故障。 [官方硬件测试](https://docs.m5stack.com/en/StackChan/#troubleshooting) · [安装与恢复范围](installation-recovery.md)

DSH 有线语音与配对占用 USB CDC。调试可用 JTAG，或用 Wi-Fi/Relay 跑语音并单独为诊断构建开放日志口。当前构建禁用了 USB CDC 次级控制台，二进制数据和日志保持分离。 [控制台配置](../firmware/agent/sdkconfig.defaults) · [USB Serial/JTAG 控制台](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/usb-serial-jtag-console.html)

### v54 启动与 USB 故障定位

先从同一构建的 `stack-chan.bin` 和 `stack-chan.elf` 生成 [GDB 诊断命令](../scripts/prepare_stock_trial_debug.py)。生成器以冻结的 v54 构建收据核对两个文件，并从实际 Xtensa `call8` 指令定位调用前及返回后的地址。命令文件只添加硬件断点、读取调用结果和回溯；打印回溯时不展开参数。生成阶段只读本机文件，不打开设备，原样输出私有命令文件。 [v54 构建收据](../firmware/agent-stock-trial-v54-build.json)

在另行确认的一次性真机试验中，从底座 USB 复用已核对的设备序列。OpenOCD 配置使用 `adapter serial` 绑定同机，设置 `ESP_FLASH_SIZE 0` 禁用基于 Flash 的断点，GDB 服务只绑定回环地址，关闭 Tcl 和 Telnet 端口。安装后在候选执行前停在启动器，用同一 ELF 附加，通过 `source` 定义下列命令。GDB 和 OpenOCD 都不加载或写入镜像，暂存和恢复沿用单次试装的 ROM 与整片读回流程。 [Espressif 硬件断点限制](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/jtag-debugging/tips-and-quirks.html) · [OpenOCD 设备筛选](https://openocd.org/doc/html/Debug-Adapter-Configuration.html) · [单次联调与恢复](installation-recovery.md#v54-保留原厂的单次联调)

| GDB 命令 | 现场可观察的结果 |
|---|---|
| `sion-check-hal` | 硬件断点依次确认调用 `Hal::init()`、其返回、到达 `StartPairingUsb()` 调用点。两个阶段之间如果进入 panic，停住并输出调用栈。 |
| `sion-check-usb` | 在 USB 调用点，同时设置任务创建返回点和 USB worker 的驱动安装返回点。即使 USB worker 先被调度，也分别记录实际结果。创建失败时停住，无需等驱动。 |
| 释放调试器后发送 USB 状态请求 | 若驱动就绪，先清除断点并恢复运行，再以实际 USB 应答证明配对服务已接通。没有应答时保留调试时序和屏幕观察，结束后按同机快照恢复。 |

QEMU 已复验板级失败和放行板级步骤后的 USB 启动路径。Mac 也已从同一台 Sion 的 USB 描述符读到 CDC 控制、CDC 数据和 JTAG 三个接口。实体 JTAG 会话及 USB 配对应答仍待验证。 [诊断验收](validation.md#v54-启动诊断演练)

### Grove Port B 作为冷启动输入候选

[M5Stack 的接口表](https://docs.m5stack.com/en/StackChan/#expand-interface) 将 Port B 的黄色信号线标为 G9，红色为 5V。M5Stack 链接的 [CoreS3 原理图](https://m5stack-doc.oss-cn-shenzhen.aliyuncs.com/490/Sch_M5_CoreS3_v1.0.pdf) 给出主控与总线的连线。[Espressif 的 GPIO 表](https://docs.espressif.com/projects/esp-idf/en/v5.5.4/esp32s3/api-reference/peripherals/gpio.html#gpio-summary) 将 GPIO9 列为普通可配置输入，不属于启动绑定位。由此支持候选选脚，仍须检查这台机器的具体端口、已有外设和电气状态。候选设计为独立无源接点和芯片内上拉，Port B 的 5V 不接入 GPIO。冷启动按住再松开的编译和夹具证据见 [V43](dual-boot-updates.md#选择器原型与-v24-原厂返回)。
