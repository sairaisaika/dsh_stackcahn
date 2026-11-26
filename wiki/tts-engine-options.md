# 本地中文 TTS 引擎选型：比 Kokoro 更自然的候选（2026-11-22）

归属 P2/P4（本地语音）。本页只做调研，**没有安装任何东西、没有下载权重、没有运行任何模型，也没有改代码或碰设备**。数据全部来自公开页面（仓库、模型卡、licence 文本、issue、社区文章），由四路并行调研汇总；本页作者另行复核了三处关键陈述（见「复核」）。所有引擎的 Apple 芯片时延都**没有在本机 Mac mini M4 Pro 上实测**，必须在试用阶段自己测。

背景：现用 Kokoro-82M v1.1-zh（[local-speech](local-speech.md)），用户选了音色 zf_038（年轻、偏少女），但认为所有 Kokoro 音色的语气都不自然。约束：免费、运行时完全离线、不用付费云 API、密钥不进日志/仓库、Mac 负载在合理范围内可以接受。

## 结论（先看这里）

| 排名 | 候选 | 一句话理由 | 最大风险 |
|---|---|---|---|
| 1 | **Qwen3-TTS（1.7B CustomVoice / VoiceDesign，经 mlx-audio）** | Apache-2.0；主线 mlx-audio 有维护；有真正的分块流式；自带年轻女性中文音色（Vivian、Serena）；支持用中文指令控制情绪/语气；还能用文字描述“设计”音色 | 官方仓库停滞，稳定性（语速漂移、多余笑声/字词）靠第三方 MLX 库；本机时延未测 |
| 2 | **Ming-3.0-tts-0.5B（经 mlx-audio）** | MIT；README 明说 M4 Pro 上“约实时、峰值约 4.4 GB”；100+ 中文内置音色，情绪/语速/音高控制；与 1 号共用同一个 mlx-audio 环境，A/B 试听成本最低 | 只有厂商基准，没有独立中文听感证据；约 1× 实时，没有余量；输出 44.1 kHz 需重采样；MLX 版不做数字规范化 |
| 备选 | IndexTTS-2.5（MLX/GGML 端口）、VoxCPM2（MLX） | IndexTTS2.x 是唯一能把音色与情绪分开控制的；VoxCPM2 是 Apache-2.0 且能用文字设计音色 | 前者：自定义 licence、个人维护的端口、M3 Max 上 RTF≈1；后者：MLX 量化版慢于实时 |

**必须先说清的三点：**

1. **没有任何一个引擎有“比 Kokoro 更自然”的独立中文听感评测。** 各家公布的 Seed-TTS-eval CER/SIM 衡量的是“读得对不对、像不像参考音色”，**不衡量语调、节奏和情绪**，而这恰恰是你不满意的地方。排名依据是“文档里是否有直接针对语气的功能”加“Mac 上是否可行”，不是听感结论。
2. **用 Kokoro zf_038 渲染一段参考音频去“克隆”，很可能连平淡的语气一起继承。** F5、GPT-SoVITS、Spark 的风格都跟着参考音频走（F5 维护者称模型不分离音色与口音；GPT-SoVITS README 说 v3/v4 的音色和语气“更偏向参考音频”）。所以优先试**内置音色 + 指令/情绪控制**的路线，克隆只作为补充。这条推断来自几份调研的共同观察，没有任何来源直接测过，试用时必须听。
3. 排名里的 1 号和 2 号共用 mlx-audio，意味着一个独立 venv 就能把两者和 Kokoro 放在同一组句子上盲听。

## 现状基线：现有 worker 与 Kokoro 的实际数据

来自 `scripts/local_speech.py`、`src/local-speech.mjs`、[local-speech](local-speech.md)（均为本仓库）：

- 单一常驻 Python 3.11 进程，stdin/stdout 为 JSON 行协议 v1。请求字段严格为 `request_id/text/language/voice/speed`；回复为 `ready{protocol:1,rate:24000,channels:1}`、`pcm{sequence,data=base64}`（每块最多 24000 字节，即 0.5 s）、`done{frames}`、`error`。任何异常后进程直接退出（不复用）。
- 启动时 `offline()` 设置 HF 离线环境变量，并把 `socket.connect` 等替换成抛异常，作为对隐式下载的防护；资产有固定大小与 SHA-256 清单，加载前逐个校验。
- Kokoro 按句段逐段生成（`for result in pipeline(...)`），所以现有流式粒度就是“句子级”，这与下面各引擎能提供的粒度一致。
- 本机实测（Mac mini M4 Pro，仅 CPU 4 线程）：Kokoro 就绪约 3.7 s；就绪后中文首块约 453 ms，英文约 217 ms（单次样本，未隔离其他负载）。DSH 还会在回合结束前预合成首句，所以用户感知延迟比单纯“首块”短。这是新引擎的对比基线。
- 同机还在跑 whisper.cpp（Metal + BLAS）做识别。MLX 引擎同样用 Metal，**GPU 争用**是试用时必须测的新变量（Kokoro 目前在 CPU 上，不与 Whisper 抢 GPU）。

**Kokoro-zh 为什么平？** 官方模型卡说明它是 StyleTTS 2 + ISTFTNet 的“只有解码器”结构，82M 参数，v1.1-zh 只是一次短训练（约 120 A100 小时）、提前发布以收集反馈，“不是严格升级”。由此推断（这是推断，不是作者的话）：语调是文本与一个固定风格向量的确定性函数，没有随机风格采样，也没有显式的情绪控制。社区中文帖（知乎、CSDN，证据较弱）提到的问题是：分词断错、多音字、中英混读、“语气机械僵硬”。没有找到 hexgrad/kokoro 或 misaki 里关于语调的 issue；也**没有找到**任何能改善平淡的已验证技巧（Kokoro-FastAPI 的音色加权混合只有英文例子；speed 参数无证据能增加表现力）。

## 证据标签

[文档]＝官方仓库/模型卡/论文所述；[用户]＝issue、博客、论坛等第三方报告；[计划]＝仅路线图；[未知]＝没找到。作者“推断”均明说。厂商基准一律按“厂商自测”看待。

## 总览表

粗体为推荐试用。时延列只写**来源明确的** Apple 芯片数字，括号内为芯片，缺失处写“未知”，不拿 CUDA 数字替代。

| 引擎 | 代码 / 权重 licence | 规模 | Mac 路径 | Apple 芯片速度（来源） | 流式 | 音色 |
|---|---|---|---|---|---|---|
| **Qwen3-TTS** 0.6B/1.7B | Apache-2.0 / Apache-2.0 [文档] | 1.7B≈1.92B 参数，4.5 GB；MLX 6-bit 运行约 3.9 GB | MLX（mlx-audio）；官方包无 MPS | mlx-audio README：6-bit 批量 1，20.8 tok/s≈1.67× 实时，首包 84.8 ms，芯片未写；Swift 端口 M2 Max RTF≈0.55 [文档/用户] | mlx-audio 有 `stream=True` 分块；官方包不流式 | 9 个内置音色（中文：Vivian、Serena、Uncle_Fu、Dylan、Eric）；VoiceDesign 文字设计；Base 克隆 |
| **Ming-3.0-tts-0.5B** | MIT / MIT [文档] | 0.5B，约 3 GB | MLX（mlx-audio）；官方仓库只测过 CUDA | mlx-audio：“M4 Pro 约实时，峰值约 4.4 GB”（端口作者自述，无方法）[文档] | 无原生；MLX 端口按约 24 词/字分片，适合句级 | 100+ 中文内置音色；克隆需参考转写；文字设计；情绪/语速/音高控制 |
| IndexTTS-2.5 / 2.0 | 自定义 bilibili 协议 / 同；1/1.5 权重 Apache-2.0 [文档] | 约 0.8B GPT，官方仓库 5.5 GB + 辅助模型 | 官方 PyTorch-Mac 内存爆炸；MLX/GGML 个人端口 | M3 Max（8-bit MLX 端口）温态 RTF≈1.04；M2 Max 2.0 约 1.3 [用户自述] | segment 级（原生 `stream_return`，CUDA 上首包约 2 s） | 零样本克隆 5–15 s，无需转写；情绪向量/情绪参考/文本情绪 |
| VoxCPM2 | Apache-2.0 / Apache-2.0 [文档] | 2B；MLX 量化 2.3–5 GB | MLX（mlx-audio、speech-swift）、MPS、GGUF | mlx-community 卡：7 步，bf16 0.48×、8-bit 0.85×、4-bit 0.90× 实时，芯片未写，全部慢于实时 [文档] | `generate_streaming()`（PyTorch）；mlx-audio 分段 | 无预设音色；文字设计、克隆；输出 48 kHz |
| GPT-SoVITS v2ProPlus/v4/v5 | MIT / 权重未声明 [未知] | 约 1.3 GB | 上游仅 CPU；MLX 分支为个人维护未审计 | README：M4 CPU RTF 0.526；个人分支 M5 24 GB MLX int8 RTF≈0.12–0.13 [文档/用户] | api_v2 有 streaming_mode，Mac 是否可用未知 | 3–10 s 零样本；约 1 分钟少样本微调；语气跟随参考 |
| Fish Audio S2-Pro | Fish Audio 研究协议（仅非商用）；仓库 Community License [文档] | 4B+0.4B，11 GB；官方要求 ≥24 GB 显存 | 仅社区 MLX 端口 | M4 Max 64 GB：bf16 1.12×、int8 1.80×、int4 2.55× 实时（端口作者）[用户] | 端口按文本分块+交叉淡化 | 克隆 10–30 s；15000+ 内联英文标签 |
| F5-TTS v1 | MIT / **CC-BY-NC-4.0** [文档] | 336M | MPS（需回退）、MLX 端口 | M5 Pro，16 步 RTF 0.57、32 步 1.13 [用户] | 非自回归，维护者称不可真流式 | 仅零样本克隆（≤12 s+转写）；无情绪控制 |
| CosyVoice 3（Fun-CosyVoice3-0.5B-2512） | Apache-2.0 / Apache-2.0 [文档] | 0.5B，HF 仓库 8.8 GB | 官方仅 CUDA/CPU；MLX 端口个人项目 | M4 mini CPU fp32 RTF 1.56 [用户]；M1 Pro Metal 端口自称 0.3–0.5 [用户] | 官方 `stream=True` | 无内置；零样本克隆；instruct 情绪 |
| Spark-TTS 0.5B | Apache-2.0（仓库）/ **CC-BY-NC-SA-4.0**（权重）[文档，互相矛盾] | 0.5B，3.95 GB | mlx-audio 有；官方 MPS 有已知报错 | Mac 无可靠数字 [未知] | 无 | 克隆或“虚拟说话人”（性别/音高/语速档位） |
| ChatTTS | AGPL-3.0 / CC BY-NC 4.0 [文档] | 约 1.1–1.3 GB | 建议 CPU；MPS 有泄漏/噪声报告 | 无可信 Apple 数字 [未知] | 有（路线图已勾） | 随机说话人，无命名音色 |
| MeloTTS | MIT / MIT [文档] | 52M（第三方），中文模型 208 MB | CPU；MPS 有 issue | 第三方 M4：MPS 首音 512 ms、15× 实时（语言未写，多半英文）[用户] | 无原生 | 仅 1 个中文音色 |

## 重点候选详述

### 1. Qwen3-TTS（阿里 Qwen，2026-01-22 发布）

- **licence**：代码与全部 HF 权重 Apache-2.0 [文档]。未找到克隆/使用条款（README 只在第三方博客中被提醒“克隆真人声音需获同意”）。**本页作者复核**：`mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit` 的 HF 元数据为 apache-2.0。
- **规模**：1.7B 约 1.92B 参数、4.52 GB；0.6B 约 2.5 GB。MLX 6-bit 批量 1 约 3.9 GB 内存 [文档]。Swift 端口 bf16 峰值 5.14 GB，剪枝 4-bit 2.13 GB（有人称 int4 因质量被放弃）[用户]。
- **Mac**：官方 `qwen-tts` 面向 CUDA+FlashAttention，Mac 的 MPS/MLX PR 未合并；有人在 MPS 上跑通（M3 Ultra bf16 正常；M3 Air 上 Base 的 float16 报 NaN/inf 须用 float32；M4 Pro 上 CPU float16 挂了约 20 分钟）[用户]。**可行路线是 mlx-audio**（MIT，Python ≥3.11，0.6.7，PyPI 2026-11-19，维护很勤）支持 Base/CustomVoice/VoiceDesign 的 bf16/8/6-bit [文档]。一篇评测称“无 MPS”，与上述用户报告冲突，且该文把 Kokoro 说成只会英文（实为有中文版），可靠性低。
- **速度**：见总览。三处数字互相吻合，约 1.5–1.8× 实时；**无 M4/M4 Pro 的中文数字**。官方论文的首包 97/101 ms 是 GPU 上的主张，不可用于 Mac。
- **流式**：官方包的 `non_streaming_mode` 只“模拟流式文本输入”，不是真正流式输出 [文档]。mlx-audio 的 `stream=True`（`streaming_interval=0.32` s）会**先预填整段文字，再逐块输出** [文档]。对“句子级”协议足够。已知风险：流式输入下克隆语速漂移（官方 PR #362 想默认关闭）；偶发多余笑声/多余字词（issue #16，已关）[用户]。
- **中文自然度证据**：Seed-TTS test-zh WER 1.7B-Base 0.77、0.6B-Base 0.92，Qwen 表中 F5-TTS 1.56（Qwen 团队自测）[文档]。主观：一篇博客称普通话“出色”、韵律优于 Kokoro，没有盲测、没有方法，可靠性低；日语 M3 博客称语调自然、情绪指令有效（不是中文）。0.6B 的情绪控制不稳定、2 分钟以上长文退化；1.7B 较稳 [用户，低可靠]。**无独立中文对比**。
- **音色**：CustomVoice 9 个内置音色，中文有 Vivian（“明亮、略带锋芒的年轻女声”）、Serena（“温柔的年轻女声”）、Uncle_Fu、Dylan（北京话）、Eric（四川话）；`instruct` 支持如“用特别愤怒的语气说”，仅 1.7B。VoiceDesign 可用中文/英文描述设计音色（如“一个活泼、高音调的年轻女声”）；也可 VoiceDesign → 短参考音 → Base 克隆做可复用音色 [文档]。是否真像 zf_038：**未知**，须听。
- **接入**：`load_model(...)` 一次，每句 `generate(..., stream=True)`。需预下载 HF 权重与单独的 `Qwen3-TTS-Tokenizer-12Hz` 仓库；mlx-audio 运行时是否仍有联网请求**未知**，须在断网下验证。输出采样率本页未核实（常见为 24 kHz，未证实）。

### 2. Ming-3.0-tts-0.5B（蚂蚁 inclusionAI）

- **licence**：代码与权重 MIT；模型卡附使用声明（不得未经同意冒充、合成语音须标注）[文档]。
- **规模与 Mac**：0.5B（Qwen2.5-0.5B 骨干 + DiT 头），约 2.96 GB；官方仓库只在 H800/H20 CUDA 上测过；MLX 经 mlx-audio（`mlx-community/Ming-3.0-tts-0.5B-bf16`，HF 元数据 MIT，最近更新 2026-10-22，本页作者复核）。**本页作者复核**：mlx-audio 的 dense README 原文为“On an M4 Pro it runs at about real time and peaks at about 4.4 GB”——这是端口作者的自述，无方法、无首音时延。
- **流式**：无原生；MLX 端口把文本切成约 24 词/字的片段并裁掉各片尾静音；自由文本与音色设计限一个片段（约 30 s）[文档]。
- **输出 44.1 kHz**，需用合格重采样器降到 24 kHz（本仓库既有原则：不用线性插值冒充抗混叠重采样）。
- **音色与控制**：100+ 中文内置音色（如“灵小柔”，目录在上游 cookbook）；克隆需参考音+准确转写（自动提取说话人嵌入未实现，可传 192 维 `spk_emb`）；用中文描述设计音色；情绪（高兴/悲伤/愤怒…）、语速、音高、音量；14 个内联副语言标签（如 `[Sigh]`）[文档]。
- **证据**：Seed-TTS-eval zh CER 0.800%、SIM 0.758；情绪控制在 CV3 上平均 72%（CosyVoice3-0.5B 为 66%）；InstructTTSEval-ZH 音色设计 72.3%（Qwen3-TTS 77.1%）——全是厂商自测。模型卡自承“开放式音色设计尚不及最强对比系统”。独立中文听感：**未知**。
- **接入注意**：MLX 端口不做数字/日期/单位规范化，须自行先把数字展开成汉字；有的生成会有很长的静音尾巴（“换个种子重跑”）。Tiny 变体是 MoE，约 18 GB，官方需 CUDA 11.8，不推荐。

### 备选：IndexTTS-2.5（bilibili，2026-08-10）

- 有最强的“语气”证据：音色与情绪分离，情绪可由参考音、8 维向量（高兴/愤怒/悲伤/害怕/厌恶/忧郁/惊讶/平静）或文本（Qwen）给出，`emo_alpha`、2.5 的 `duration_factor`；支持 `<行|XING2>` 内联多音字标注 [文档]。作者自测 Seed-TTS test-zh WER 1.008、SMOS 4.44，情绪集 EMOS 4.22（对 F5 3.16、CosyVoice2 3.09）[文档，自测]。
- licence 为自定义“bilibili Model Use License Agreement”（本页未亲自核对，转述调研）：免版税、允许商用，超过 1 亿月活或 10 亿元年营收须另签；**输出被定义为衍生作品，不得用来训练其他（商用）AI 模型**；中文版本为准、上海仲裁；另有 DISCLAIMER 禁止克隆公众人物。个人桌面机器人用途不冲突，但**试用前须由你本人读原文**。
- **官方 PyTorch 路径在 Mac 上不可用**：内存暴涨（M4 24 GB 用户报告内存满+约 10 GB 交换；M3 Ultra 达 249 GB）、MPS “Output channels > 65536” 报错 [用户]。MLX 端口（vanch007、Jup33Q、mlx-community）为个人维护（vanch007 仅 6 星）；M3 Max 8-bit 温态 RTF≈1.04，默认 25 步 1.7–2.2 [用户自述]。M4 Pro 会不会更慢是外推，未测。mlx-audio 里的 `indextts` 只是 IndexTTS-1 架构，没有情绪路径。
- 已知缺陷：吞字、只出第一个分句、换参考音即漏字（issue #187/#210/#520），常用重抽种子绕开 [用户]。

### 备选：VoxCPM2（OpenBMB，Apache-2.0，2B）

- 模型卡称“根据文本内容自动推断合适的韵律与表现力”（营销性表述，未验证）；Seed-TTS-eval zh CER 0.97、SIM 79.5（自测）；音色设计示例就是“(A young woman, gentle and sweet voice)”；模型卡自承音色设计/风格控制结果每次不同，建议生成 1–3 次 [文档]。
- Mac：mlx-audio（`mlx-community/VoxCPM2-8bit/4bit`）、官方 `voxcpm`（MPS，但文档提醒 `mps.is_available()` 不保证每条路径可用）、llama.cpp-omni GGUF（Metal）、speech-swift。MLX 卡速度表全部低于实时（芯片未写）；VoxCPM 自己的 README 给出 llama.cpp-omni “RTF ~1.76 (Q8_0) on Apple M4 Pro”，该数字的方向（越大越快还是越慢）有歧义，不要引用 [文档，歧义]。官方文档页仍说 VoxCPM2 不在 MLX 覆盖内，与 mlx-audio README 冲突，大概率是文档过期。输出 48 kHz。

### GPT-SoVITS：音色最贴，语气不保证

最大的价值是“用很少的数据贴近一个指定音色”（零样本 3–10 s；少样本约 1 分钟），中文前端用 G2PW 处理多音字。问题：上游在 Mac 上只能走 CPU（README 说明 GPU 训练的 Mac 模型质量显著下降；维护者称 MPS “不适合 AR 部分”），M4 CPU 的 RTF 0.526（README）；个人 MLX 分支（Rainshower258，作者自测 M5 24 GB RTF≈0.12）单人维护、未审计；Mac 安装有依赖冲突报告（PR #2872）。语气跟随参考音频，所以“用 Kokoro 渲染参考”会把平淡带过来。**没有任何 GPT-SoVITS 对 Kokoro 的对比**。权重 licence 在 HF 元数据中未声明，需另行确认。适合在“只想要 zf_038 的音色、语气另想办法”时作为第三顺位。

## 不推荐及原因（简）

- **F5-TTS**：中文权重 CC-BY-NC-4.0（仅非商用，个人使用可，但不干净）；只有克隆、无情绪控制，维护者称不分离音色与口音；一篇 M1 Pro 博客评其韵律“略平”、多音字偶尔失败（单人意见）；Issue #1237 仍开着（“未”读音随机、漏字）。
- **Fish Audio S2-Pro**：表达力潜力最高（内联情绪标签），但权重按研究协议仅非商用、官方要求≥24 GB 显存、MLX bf16 实测在 M4 Max 才 1.12× 实时，外推 M4 Pro 约 0.5–0.6×（外推，非实测）；标签是英文的，对中文是否有效**未知**。Drama 3 只支持 NVIDIA。
- **CosyVoice 3**：licence 干净，但没有维护且有基准的 Mac 路径：官方代码硬编码 cuda/cpu；M4 mini CPU fp32 RTF 1.56 [用户]；MLX/Candle/GGUF 端口均为小型个人项目，已报告静音词元循环和 `<|endofprompt|>` 断言。**Fun-CosyVoice 3.5 仅阿里云 API**（国内区），权重未发布，违反离线约束。
- **Spark-TTS**：仓库自 2025-04 无提交；权重 CC-BY-NC-SA；IndexTTS2 论文测得其情绪集 EMOS 仅 3.16，无情绪控制。
- **ChatTTS**：说话人随机、种子到音色映射跨环境不稳定、MPS 有泄漏、中文文本规范化依赖在 Mac 上缺失（数字需手动转汉字）、权重 NC；无法保持 zf_038 音色。
- **MeloTTS**：仅一个中文音色、近 11 个月无更新、MPS 有已知 bug；速度最快，但**没有它比 Kokoro 更自然的证据**（同属 VITS 类）。
- **sherpa-onnx 系（Matcha/VITS/kokoro-multi-lang/ZipVoice）**：纯 CPU 离线、易部署，但同属 VITS/Matcha 类，没有迹象表明语调优于 Kokoro；其中“kokoro-multi-lang”就是 Kokoro 同族。
- **其他在 mlx-audio 表里的**：Higgs Audio v3（研究/非商用协议）、OmniVoice（权重 CC-BY-NC）、MOSS-TTS 8B（太重）、GLM-TTS（智谱，MIT，强调 RL 改善“情感平淡”，但仓库偏 CUDA、未找到 MLX 端口）、Step-Audio-EditX（3B，偏 CUDA）、LongCat-AudioDiT-1B（MIT、24 kHz，克隆只能带参考音，无内置音色，Mac 速度未知）、MOSS-TTS-Nano-100M（Apache-2.0，100M，最便宜可试，但需要 WeTextProcessing+pynini，且无中文自然度证据）。这些作“快速试听”备选，不进排名。

## 接入现有 worker 协议的难度

共同模式：新建**独立**的 Python 3.11+ 环境（mlx-audio 需要 ≥3.11；现有环境用 hash 锁定的依赖和 torch，不要混装），进程内 `load_model` 一次，每个请求按句段 `generate(..., stream=True)`，把音频转成 24 kHz 单声道 PCM16 后沿用现有的 24000 字节分块与 `ready/pcm/done/error` 协议。需要处理的差异：

1. **采样率**：Ming 44.1 kHz、VoxCPM2 48 kHz、GPT-SoVITS 32/48 kHz、Qwen3-TTS 未核实；必须用正规重采样器。
2. **音色/参数映射**：现有 `request_fields` 只允许固定音色名和 0.5–2 的 `speed`。新引擎的音色是名字（Vivian/Serena/Ming 音色）、描述文本或参考音；`speed` 对 Qwen3-TTS 只能通过指令间接影响，需要明确映射或忽略。
3. **文本预处理**：Ming 的 MLX 端口不规范化数字，需自行把数字、日期、单位展开；F5/ChatTTS 同样要求。中英混读各引擎表现不同，必须单测。
4. **离线与资产固定**：保留 `offline()` 套接字拒绝与 `HF_HUB_OFFLINE=1`，所有权重改为显式本地路径，并把权重文件（含 Qwen3 的独立 tokenizer 仓库）加入带大小与 SHA-256 的清单；mlx-community 转换权重是第三方上传，要固定修订与哈希。mlx-audio 迭代很快，需固定确切版本并 hash 锁依赖，加载时是否有隐式联网请求**必须断网实测**。
5. **失败语义**：现有 worker 在任何异常后退出，MLX 引擎偶发长静音/吞字的话，需要在 worker 内检测（时长/能量）而不是整进程退出。
6. **内存/GPU**：Qwen3 约 4 GB、Ming 约 4.4 GB（自述），24 GB 机器上与 Whisper 并存应可行，但 Metal 争用对 Whisper 识别延迟的影响**未知**。
7. 工作量判断：mlx-audio 路线属于“替换 `load()` 与 `synthesize()`”级别；PyTorch 路线（官方 CosyVoice、IndexTTS）依赖重、Mac 不稳，不建议。

## 排名建议与试用设计

**推荐试用：① Qwen3-TTS 1.7B（CustomVoice 6-bit，必要时 VoiceDesign）；② Ming-3.0-tts-0.5B（bf16）。** 同一个 mlx-audio 环境，Kokoro zf_038 作对照。若两者都不满意，再试 IndexTTS-2.5 的 MLX 端口（先读 licence 原文）和 VoxCPM2-8bit。

**试用范围（只在隔离目录，不动设备、不动现有 worker 和资产）：**

- 固定 20 句中文测试集：短回复、疑问、感叹、长句（>40 字）、含数字/日期/单位、中英混读、多音字、需要情绪的句子（开心/撒娇/担心）、机器人人设台词；对每个候选和 Kokoro zf_038 用同一批句子。
- **时延**：冷启动加载时间（断网）；温态“收到请求→第一块 PCM”的 p50/p95，与 Kokoro 的 453 ms（中文，温态）比；RTF；整句总时间。
- **资源**：峰值内存（RSS）；与 whisper.cpp 同时运行时两边各自的延迟变化（Metal 争用）；连续 100 句的稳定性（长静音、漏字、重复、速率漂移的发生率）。
- **离线**：断网（现有 worker 的套接字拒绝）下完整运行，核对无 HF 请求。
- **听感（最关键）**：本人盲听 A/B/X（Kokoro zf_038 对候选，随机顺序），对“自然度、年轻度、情绪表现、是否像 zf_038”打分；对 Qwen3 比较内置 Vivian/Serena、VoiceDesign 描述、以及 Kokoro 渲染参考克隆三种来源，验证“克隆继承平淡”的推断。先在 Mac 扬声器听，再决定是否上设备（设备端音频链路是另一项验收，不在本试用内）。
- **ASR 回读 CER**（Whisper）只用来筛漏字/乱读，不能当作自然度分数。
- **通过标准建议（供讨论，非既定）**：听感盲测明显优于 Kokoro；温态首块在 1 s 内或可被首句预合成吸收；RTF 低于 1；与 Whisper 并发不使识别延迟明显变差；断网可运行；100 句无需人工干预。

## 本机试用：Qwen3-TTS 1.7B（2026-11-22）

用户选定先试 Qwen3-TTS。隔离环境 `.local/tts-trial`（mlx-audio 0.6.7，Python 3.13），模型 `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit`，固定版本 `1c6c0ff5`，Apache-2.0，2.7 GB（自带语音分词器，不需要另下 `Qwen3-TTS-Tokenizer-12Hz`）。全程断网（HF 离线变量加套接字拒绝）运行成功。没有改现有语音进程，也没有接触设备。

| 项 | Qwen3-TTS 1.7B（本机 Mac mini M4 Pro） | Kokoro zf_038（同一组句子） |
|---|---|---|
| 冷加载 | 8.6 s | — |
| 温态首块（流式） | 0.11–0.13 s | 0.25–0.52 s |
| 实时率 | 0.29（Vivian）、0.29（Serena）、0.29（Vivian 加语气指令） | — |
| 峰值内存 | 2.24 GB | — |
| 输出 | 24 kHz 单声道，与现有协议一致 | 24 kHz |

10 句测试集，每句四个版本：Kokoro zf_038、Vivian、Serena、Vivian 加「用自然、活泼可爱的语气说，像在和好朋友聊天」。40 段均有声、时长正常。盲听页面在 `StackChan/.local/previews/voice-blind/index.html`，顺序随机，答案在同目录 `key.json`。**听感结论等用户打分。**未测：与 Whisper 同时运行时互相拖慢多少、连续 100 句的稳定性、数字规范化（第 6 句含阿拉伯数字，留意读法）。

## 复核

本页作者直接读取了以下原文（仅文本）：mlx-audio README 与 dense README（Ming 的 M4 Pro 约实时、4.4 GB、44.1 kHz；mlx-audio 为 MIT）；mlx-audio Qwen3-TTS README（6-bit 批量 1：20.8 tok/s、1.67×、TTFB 84.8 ms、3.88 GB；`stream=True`；Vivian/Serena 音色与 `instruct`）；HF 元数据（Qwen3 1.7B CustomVoice 6-bit 为 apache-2.0；Ming bf16 MLX 为 MIT）。其余数字来自调研代理的报告，未逐一回查原文。

## 未验证与未知

- 任何引擎在本机 M4 Pro 上的中文首音时延、RTF、加载时间：**全部未知**。
- 任何独立的、与 Kokoro 的中文听感对比：**未找到**。
- Qwen3-TTS 输出采样率、mlx-audio 离线加载是否无联网请求、VoiceDesign 能否稳定得到 zf_038 式音色：**未验证**。
- Ming 在中文上的实际韵律、MLX 端口的静音尾巴出现频率：**未验证**。
- GPT-SoVITS 权重的 licence 文本；IndexTTS 协议原文（本页转述）：**未亲自核对**。
- Kokoro zf_038 渲染音频用于克隆的权利问题：Kokoro 为 Apache-2.0，中文数据由 LongMaoData“自由、宽松授权”，调研未发现对生成音频的限制，但该音色来自真人数据集，肖像/声音权利**未知**，这不是法律意见。
- 仅有计划/公告的事项：Fun-CosyVoice 3.5 开放权重为 [计划/未知]（相关 issue 无人回应后被自动关闭）；Qwen 在 Qwen3-TTS 之后没有找到更新的 TTS 发布。

## 来源

- mlx-audio：[README](https://github.com/Blaizzy/mlx-audio)、[Qwen3-TTS 说明](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/tts/models/qwen3_tts/README.md)、[Ming 说明](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/tts/models/dense/README.md)
- Qwen3-TTS：[仓库](https://github.com/QwenLM/Qwen3-TTS)、[论文](https://arxiv.org/abs/2601.15621)、[MPS issue #69](https://github.com/QwenLM/Qwen3-TTS/issues/69)、[流式 PR #362](https://github.com/QwenLM/Qwen3-TTS/pull/362)、[Swift 端口基准](https://soniqo.audio/guides/speak)
- Ming：[模型卡](https://huggingface.co/inclusionAI/Ming-3.0-tts-0.5B)
- VoxCPM2：[模型卡](https://huggingface.co/openbmb/VoxCPM2)、[MLX 8-bit 卡](https://huggingface.co/mlx-community/VoxCPM2-8bit)、[仓库](https://github.com/OpenBMB/VoxCPM)
- IndexTTS：[仓库与 LICENSE](https://github.com/index-tts/index-tts)、[论文](https://arxiv.org/html/2506.21619)、[MLX 端口](https://github.com/vanch007/mlx-indextts2)、[Mac 内存 issue #414](https://github.com/index-tts/index-tts/issues/414)
- CosyVoice：[仓库](https://github.com/FunAudioLLM/CosyVoice)、[论文](https://arxiv.org/html/2505.17589v2)、[MLX 端口 mlx-audio-plus](https://github.com/DePasqualeOrg/mlx-audio-plus)、[M4 CPU 实测（Zenn）](https://zenn.dev/ysic/articles/a2e117af693de0)
- F5-TTS：[仓库](https://github.com/SWivid/F5-TTS)、[MLX 端口](https://github.com/lucasnewman/f5-tts-mlx)、[Apple 基准](https://soniqo.audio/benchmarks)、[Issue #1237](https://github.com/SWivid/F5-TTS/issues/1237)
- GPT-SoVITS：[仓库](https://github.com/RVC-Boss/GPT-SoVITS)、[Apple 分支](https://github.com/Rainshower258/GPT-SoVITS-AppleSilicon)
- Fish：[仓库](https://github.com/fishaudio/fish-speech)、[S2-Pro 协议](https://huggingface.co/fishaudio/s2-pro/raw/main/LICENSE.md)、[MLX 端口](https://github.com/gafiatulin/fish-speech-mlx)
- Spark-TTS：[仓库](https://github.com/SparkAudio/Spark-TTS)、[权重卡](https://huggingface.co/SparkAudio/Spark-TTS-0.5B)、[Mac MPS issue #95](https://github.com/SparkAudio/Spark-TTS/issues/95)
- ChatTTS：[仓库](https://github.com/2noise/ChatTTS)、[MPS issue #772](https://github.com/2noise/ChatTTS/issues/772)
- MeloTTS：[仓库](https://github.com/myshell-ai/MeloTTS)、[MPS issue #228](https://github.com/myshell-ai/MeloTTS/issues/228)、[第三方 Mac 基准](https://5uck1ess.github.io/tts-bench/mac-default/speed.html)
- Kokoro-zh：[模型卡](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)、[知乎](https://zhuanlan.zhihu.com/p/29717800643)
- sherpa-onnx：[预训练 TTS 模型表](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/index.html)
