# 常驻方案：让 DSH 平时就能用这具身体

2026-11-25 主人要求「一起做」：常驻方案和本地提交同时推进。主人选了 R1，两步都做；**2026-11-26 已完成并真机验收**，用法和结果见文末。

## 现状

| 项 | 事实（2026-11-26 整片读取） |
|---|---|
| `ota_1`（0x510000） | 原厂 `stack-chan 1.6.2`，已确认、默认启动。原厂语音、小智、StackChan World 绑定都在这里，**不动** |
| `ota_0`（0x20000） | 主人从 App Center 下载的 `ir_remote` 应用 |
| 每次试装 | 把 DSH 固件写进 `ota_0`，只写一次性启动选择（select-once）。测完把 `ota_0` 和启动选择还原成试装前的字节 |
| 日常 DSH 的插件 | 还是 v65 时期的包（`work/active/v65-bubble/...tgz`），v66 以后的身体接口都只在试装时临时换上 |

所以「DSH 平时用不到这具身体」有两半：设备上没有常驻的 DSH 固件；Mac 上的日常插件太旧。

## 几条路

| 路线 | 做法 | 好处 | 代价 / 风险 | 结论 |
|---|---|---|---|---|
| **R1 ota_0 常驻 + Mac 发起进入** | DSH 固件长期留在 `ota_0`，取代 IR Remote。原厂仍默认启动。Mac 需要身体时，经 USB 只写一次 select-once 记录（与试装相同，一个 4 KiB 扇区），设备启动进 DSH；DSH 里点 Home 或重启，就由原版启动器回到原厂 | 不改启动器、分区表、NVS 和原厂镜像。全是已经在真机上跑过很多次的路径 | ① IR Remote 被替换，以后要用可以再从 App Center 下载，但下载会把 DSH 覆盖掉；② 每次进入要让设备进 ROM。自动进入偶尔报 1.8 V 或 ROM 无响应，这时会被安全检查拦下，需要主人按 RST；③ 原厂 OTA 升级会写非活跃槽，可能覆盖 DSH，Mac 要能识别并提示重装 | **现在就能做，推荐** |
| R2 原厂 App Center 的 Open / 主菜单快捷入口 | 给原厂加补丁，从主菜单直接打开已装的 DSH | 体验最好，不需要 Mac 发起 | 必须由 M5Stack 在带生产鉴权的正式版里采纳（`contributions/` 里已有补丁和审查包）。自己编原厂会破坏 StackChan World 鉴权 | 等官方 |
| R3 自定义启动器 + USB / Grove 入口 | 换掉二级启动器，开机时听 USB 请求或 Grove 手势来选 DSH | 不需要 ROM 模式，进入更快 | 要改启动器，断电时有变砖风险。只在 QEMU 和夹具里验证过 | 以后再说 |

## R1 的具体步骤（等主人同意）

1. **Mac 侧先升级日常插件。** 用试装时的 `mac-swap.zsh` 流程，把日常 DSH 的插件换成当前版本（v76 包），配置逐字节备份，可以随时换回旧包。这一步不碰设备。
2. **设备常驻写入。** 和试装一样只写 `ota_0`，但**测完不还原**。写之前整片双读，留一份外部备份（IR Remote 的镜像也在里面）。
3. **Mac 新增「进入身体」入口。** 由插件或 DSH 工具发起：
   1. 确认设备是原厂在跑、`ota_0` 里的 DSH 摘要与已装版本一致；
   2. 写 select-once；
   3. 等 DSH 连上。

   失败时报告原因，不重试写入。电压检查不通过，就提示主人按 RST。
4. **回原厂：** DSH 的 Home，或者断电重启。
5. **原厂升级检测：** 每次进入前比对 `ota_0` 的摘要。不一致就报告「原厂升级覆盖了 DSH，需要重装」，不自动重装。
6. **验收：**
   - 进出各两次；
   - 原厂语音能回答、StackChan World 仍连着同一台设备；
   - DSH 会话能用全部身体工具；
   - 重启后默认还是原厂。

## 主人当时要决定的（已同意 R1 两步）

- 同意用 DSH 替换 `ota_0` 里的 IR Remote 吗？
- 同意每次进入都写一次 otadata 扇区吗？它是 Flash 的一个 4 KiB 扇区，寿命约十万次擦写，日常用不会成为问题。
- 先做第 1 步（只换 Mac 插件）吗？这一步可以单独做。

## 2026-11-26 完成与验收

| 项 | 结果 |
|---|---|
| Mac 日常插件 | 换成 v76 包。96 个文件逐个核对一致，`autoStandby` 保持关闭（原厂在跑时插件不会自己去开串口）。换回旧包：`zsh .local/residency/swap-plugin.zsh rollback` |
| 设备常驻 | DSH v76（`c63be13a…`）已写进 `ota_0`，整片读回核对通过，IR Remote 被替换。写之前的整片备份在 `.local/backups/sion-resident-v76-before-*` |
| 进入身体 | `scripts/enter_dsh.py`：在一次 ROM 连接里依次做设备身份、3.3 V 电压绑定、两条 OTA 记录、`ota_0` 镜像 MD5 的核对，然后写一条「下次启动进 DSH」的记录，读回确认后重启。和试装用的选择完全一致：原厂序号 + 1，写进另一个扇区。主机测试覆盖 6 种接受、4 种拒绝的状态 |
| 回原厂 | DSH 里 Back → Home，或重启 |
| 真机往返 | 首次启动 1 次；用命令进入 3 次，最后一次从原厂全自动进入、不用按 RST。每次回原厂后原厂助手都能回答，StackChan World 仍连着（主人确认） |
| 现场遇到并修掉的 | ① 写函数的参数类型错了，在写入前报错，没有写入；② 经 USB 复位进入下载模式会留下「强制下载启动」标志，重启后又回到下载模式，现在重启前会清掉这个标志；③ 选择已经写好、只是没能启动时，再次运行不写入、只重启 |
| 仍然存在的 | 自动进 ROM 有时报告 1.8 V（会被拒绝，需要按 RST）；DSH 启动后要点一下脸才连 Mac；原厂恢复后有时要重插 USB 线 |

用法：

```sh
PYTHONPATH=scripts work/idf-tools/python_env/idf6.1_py3.15_env/bin/python scripts/enter_dsh.py \
  --identity .local/residency/device/identified-device.json --image .local/residency/dsh-resident.bin \
  --sha256 c63be13a00040073ccc06fcdc54e8fd68b4b1f92739462030342a0d8895aa3a1 --auto-rom --log .local/residency/enter.jsonl
```

### DSH 工具 `stackchan_wake`（2026-11-26）

DSH 可以自己醒来，不用主人在 Mac 上跑命令：

- **它运行什么：** 插件包里带的 `scripts/enter_dsh.py`，不经过 shell，也不运行别的命令。
- **参数从哪来：** 本机清单 `~/.dsh/profiles/desktop/.stackchan-resident/resident.json`，记有 Python（需要 esptool 5）、设备身份、常驻镜像和它的摘要。清单只在本机，不进仓库。
- **成功之后：** 等身体启动约 5 秒，再让语音服务经 USB 去连接身体。语音服务没开时 `attending` 为 false，要主人开服务或点一下脸。
- **拒绝时：** 告诉 DSH 该怎么跟主人说。比如电压检查不过，就请主人按 RST 后再调用；ota_0 里的 DSH 被原厂升级覆盖了，就说明需要重装。
- **不会自动重试。**

测试：`test/body-wake.test.mjs` 共 5 组。真机上用同一模块从原厂唤醒，结果是鲸鱼脸（主人确认）。日常 DSH 的插件已换成带这个工具的包（98 个文件核对一致，设置没变）。

还没做：在日常 DSH 会话里实际调用一次（要重开 DSH 才会加载新插件，并且语音服务要开着）；DSH 启动后要点脸才连上的问题。

返回 [身体机能接口](body-interface.md) · [应用中心](app-center.md) · [官方升级共存](dual-boot-updates.md)
