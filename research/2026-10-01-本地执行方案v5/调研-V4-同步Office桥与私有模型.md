# 调研 V4：私有模型端点、Office/WPS 本机桥、本地优先同步、竞品本地化形态

> 调研日期：2026-10-01。联网方式：curl 直连一手来源（Hugging Face API / raw、GitHub API、官方文档站、厂商官网）。
> 证据等级：**一手**＝官方仓库/官方文档/官网原文；**二手**＝第三方媒体或社区；**未核实**＝本次未能取到原文。

## 结论速览

| # | 问题 | 结论 | 证据等级 | 来源 |
|---|---|---|---|---|
| 1 | K3 规格 | 2.8T 总参 / 104B 激活（896 专家选 16）；MXFP4 权重 + MXFP8 激活（QAT）；权重约 **1.56 TB**；1M 上下文；原生多模态 | 一手 | https://huggingface.co/moonshotai/Kimi-K3 |
| 2 | K3 许可证 | **Kimi K3 License**：MIT 式宽许可 + ① MaaS 条款（经营“可对输入/参数实质控制”的模型 API 业务且集团 12 个月收入 > 2000 万美元须另签协议；嵌入特定功能的终端产品、纯转发不算 MaaS）② MAU > 1 亿或月收入 > 2000 万美元须显著展示 “Kimi K3” ③ 内部使用、经官方产品或**认证推理伙伴**访问可豁免 ①② | 一手 | https://huggingface.co/moonshotai/Kimi-K3/blob/main/LICENSE |
| 3 | K3 推理硬件 | vLLM：**至少 8×GB300**（或 8×MI355X），生产需多节点；SGLang：B300 1×8、H200 2×8、H100 4×8、昇腾 A3 32 卡；vLLM/SGLang/TokenSpeed 均已支持。**单家律所不可行**，只适合中软/认证伙伴机房 | 一手 | https://recipes.vllm.ai/moonshotai/Kimi-K3 ；https://docs.sglang.io/cookbook/autoregressive/Moonshotai/Kimi-K3 |
| 4 | 律所可私有部署的月之暗面模型 | **Kimi-K2.6**（1T/32B，INT4 约 595 GB，单节点 8×H200，Modified MIT，256K）＝大所/联盟上限；**Kimi-Linear-48B-A3B**（MIT，约 98 GB，官方示例 TP4，1M 上下文）＝2–4 卡；**Kimi-VL-A3B-Thinking-2506**（MIT，约 33 GB）＝单卡做 OCR/图像理解 | 一手 | HF API 与各模型卡（§1.2） |
| 5 | Office.js → 本机服务 | Windows 为 WebView2，受 Chromium **Local Network Access** 约束：公网源访问本机默认拦截，需用户点允许、企业策略或 iframe `allow="local-network-access"`；2025-12 曾大面积回归，2026-02 修复；本地部署 Exchange 的 OWA 仍有问题；**Mac 访问 http 本机被判 By Design 不通**。建议 taskpane 由本机内核以 `https://localhost` 同源提供 | 一手 | §2.1 |
| 6 | .NET 8 COM 加载项 | **官方不支持**进程内加载（微软：VSTO/COM 不能用 .NET Core/.NET 5+ 构建，也不会更新）；**.NET Framework 4.8 VSTO/COM 继续支持**，但 4.8 是最后一个主版本 | 一手 | https://github.com/dotnet/core/issues/5156#issuecomment-853430132 |
| 7 | WPS JS 加载项 | 官方 publish 模式分**在线**（拉取 地址/ribbon.xml、index.html）与**离线**（7z 包）；官方示例加载项地址即 `http://localhost:8080/...`，本机服务托管可行；新个人版不再支持 oem.ini/jsplugins.xml，只能走 publish；加载项内 fetch 本机是否受 CORS/LNA 限制**未核实** | 一手 / 未核实 | https://qn.cache.wpscdn.cn/encs/doc/office_v19/index.htm |
| 8 | Joplin 同步 | **AGPL-3.0-or-later**；同步目标是“类文件系统驱动”（含本地目录）；每 item 单独上传；主密钥经用户密码加密后随同步数据分发，可多主密钥并存，共享用独立数据密钥 + 公私钥；冲突＝本地副本进“冲突笔记本”、远端覆盖。可借鉴设计，不能直接复用代码 | 一手 | §3.1 |
| 9 | Automerge / Yjs | 均 **MIT**、均活跃（Automerge JS 3.5.0；Yjs 13.6.33 / v14 RC）；均**不内置签名与身份**；审计事件日志宜自研签名哈希链，Automerge 仅用于多人合并同一草稿 | 一手（许可/版本）/推断（适配性） | §3.2 |
| 10 | 共享目录多写者坑 | 网络文件系统写入可能乱序/丢失、锁不可靠（SQLite 官方）；同步器产生临时文件与冲突副本（Syncthing `.sync-conflict-*`、Dropbox conflicted copy）；按需同步占位符。⇒ 共享目录只放不可变段文件与密文块，单写者、原子改名、封口校验 | 一手 | §3.3 |
| 11 | 国内网盘桌面同步目录 | **坚果云、群晖 Synology Drive 有**（官网原文）；企业微信微盘、钉钉钉盘、飞书云盘**未核实** | 一手 / 未核实 | §3.4 |
| 12 | 国内竞品本地化 | **腾讯 WorkBuddy**：本地执行（操作本地文件、工作空间沙箱），本地↔云端端到端加密，模型可选云端（含 Kimi）或 **Ollama 本地模型**；**iCourt Alpha**：网页/客户端/Word 插件/移动多端，等保三级，未见本地执行原文；智合 Skill、QoderWork、Kimi Work **未核实** | 一手 / 未核实 | §4.1 |
| 13 | 海外 BYOK/私有部署 | **Legora 有 BYOK**；Harvey、Spellbook 原文只承诺模型方 **ZDR**，BYOK/私有部署未见；三家均未见私有部署原文 | 一手 / 未核实 | §4.2 |
| 14 | 法律/大模型一体机 | 项目既有资料：杭州拱墅区检察院大模型一体机 24.82 万元（大华 70B 工作站）；其他产品与价格区间本轮未取到原文 | 二手 / 未核实 | §4.3 |


---

## 1. 私有模型端点可行性（Kimi K3 与更小的月之暗面开源模型）

### 1.1 Kimi K3（一手）

| 项 | 数值/原文要点 | 来源 |
|---|---|---|
| 发布 | HF 仓库 `moonshotai/Kimi-K3` 创建于 2026-06-13，最后更新 2026-09-02；非 gated，可直接下载 | https://huggingface.co/api/models/moonshotai/Kimi-K3 |
| 总参数 / 激活参数 | **2.8T / 104B**（MoE，896 个路由专家选 16 个 + 2 个共享专家；93 层，69 KDA + 24 Gated MLA） | https://huggingface.co/moonshotai/Kimi-K3 （README “Model Summary”） |
| 上下文 | 1,048,576（1M） | 同上 |
| 模态 | 原生多模态（文本/图片/视频），视觉编码器 MoonViT-V2 401M | 同上 |
| 权重精度 | **MXFP4 权重 / MXFP8 激活，SFT 起量化感知训练（QAT）**；注意力、共享专家、lm_head、视觉塔保留 BF16 | README + config.json `quantization_config`（compressed-tensors, mxfp4-pack-quantized） |
| 权重体积 | 96 个 safetensors 分片，全仓约 **1,561 GB（≈1.45 TiB）** | HF API `?blobs=true` 汇总（本次计算） |
| 推理引擎 | 官方推荐 vLLM（recipes.vllm.ai，`vllm/vllm-openai:kimi-k3` 镜像，仅 CUDA 13 / r580+ 驱动）、SGLang（cookbook）、TokenSpeed | README §5；https://recipes.vllm.ai/moonshotai/Kimi-K3 |
| 最低硬件（vLLM 原文） | “**At least 8x GB300. Multi-node for real production traffic.**” ROCm：“At least 8x MI355X/MI350X” | https://recipes.vllm.ai/moonshotai/Kimi-K3 |
| 硬件拓扑（SGLang 原文） | B200 2×8、GB200 4×4、**H100 4×8**、B300 1×8、**H200 2×8**（高吞吐 4×8）、GB300 2×4、MI350X/MI355X 1×8、**昇腾 A3 4×8（32 卡/64 die）**、昇腾 950PR/DT 4×8；另有 NVIDIA 官方 NVFP4 检查点 `nvidia/Kimi-K3-NVFP4` | https://docs.sglang.io/cookbook/autoregressive/Moonshotai/Kimi-K3 |
| 国产卡 | vLLM 页面引用了昇腾 W4A8 检查点（ModelScope `Eco-Tech/Kimi-K3-w4a8`）与 vLLM-Ascend 教程 | recipes.vllm.ai 同页；https://docs.vllm.ai/projects/ascend/en/v0.23.0/tutorials/models/Kimi-K3.html （未单独打开） |
| 工具调用提示 | vLLM 页面：“K3 occasionally emit a tool-call format its own parser doesn't expect”，建议做 schema 校验与重试 | recipes.vllm.ai 同页 |
| 使用约束 | 始终开启思考；多轮/工具调用必须把 assistant 消息（含 `reasoning_content`、`tool_calls`）原样回传；`reasoning_effort` 取 low/high/max（默认 max）；推荐 Kimi Code CLI 作为 Agent 框架 | README §6 |

**Kimi K3 License 要点（一手，LICENSE 原文）** https://huggingface.co/moonshotai/Kimi-K3/blob/main/LICENSE
- 底子是 MIT 式宽许可：可使用、复制、修改、分发、再许可、销售、部署、微调、做衍生品。
- **第 2 条 MaaS 条款**：“Model as a Service”= 让第三方以“对输入、参数或训练数据有实质控制”的方式访问模型推理或微调（如 API）；**明确不包括** (a) 模型能力仅嵌入特定功能或 harness 的终端用户产品；(b) 仅转发请求到他人托管的模型。若被许可方及关联方经营 MaaS 业务、且任意连续 12 个月合计收入超过 **2000 万美元**，商用前须与月之暗面另签协议。
- **第 3 条署名条款**：产品/服务月活超 1 亿或月收入超 2000 万美元，须在 UI 显著展示 “Kimi K3”。
- **第 4 条豁免**：第 2、3 条不适用于 (a) **内部使用**（不把软件、其输出或底层能力提供给第三方）；(b) 通过月之暗面官方产品或**认证推理伙伴（certified inference partners）**访问。
- 对本项目的含义（推断）：律所自建 K3 端点自用＝内部使用，豁免；中软把 K3 嵌入“法律工作台”功能中给律所用＝属于 (a) 例外，不构成 MaaS；但若中软对外开放“可自由传参的 K3 API”，且中软集团合计收入超 2000 万美元，则需另签协议——这与“中软云端只提供 token API”的形态直接相关，应走“认证推理伙伴”或在合作协议中写明。

**可行性判断**：K3 私有部署的最低门槛是 **8×GB300/B300 或 8×MI355X 单节点，或 16×H200 / 32×H100 / 32 张昇腾 A3**，权重约 1.5 TB。以 2026 年市场价估算单套硬件在数百万到千万元人民币量级（**价格为推断，未核实**），**不适合任何单家律所**；只适合中软/运营商/律协级集中托管或“认证推理伙伴”。

### 1.2 月之暗面更小的开源模型（一手，HF API 与模型卡）

| 模型 | 总/激活参数 | 权重精度与体积 | 上下文 | 许可证 | 官方部署示例 / 硬件 | 律所私有部署适配度 |
|---|---|---|---|---|---|---|
| Kimi-K2.7-Code（2026-06） | 1T / 32B | 原生 INT4（QAT），≈595 GB | 256K | Modified MIT（MAU>1 亿或月收入>2000 万美元须展示 “Kimi K2.x”） | 与 K2.5/K2.6 同架构：vLLM/SGLang/KTransformers | 同 K2.6；偏代码，法律场景非首选 |
| **Kimi-K2.6**（2026-04） | 1T / 32B | 原生 INT4，≈595 GB | 256K | Modified MIT（同上，无 MaaS 收入门槛条款） | 官方部署指南：**单节点 8×H200 TP8**（vLLM/SGLang）；**KTransformers+SGLang CPU+GPU 异构**（示例 TP4、部分专家放 GPU、其余放 CPU 内存）；LoRA SFT 示例：2×4090 + Intel 8488C + 1.97T 内存 | **8 卡 H200/H20 级（或国产同级）单机可跑**，是“律所/律所联盟私有端点”的现实上限；KTransformers 方案可用 4 卡 + 大内存降本，但吞吐低 |
| Kimi-K2.5 / K2-Thinking | 1T / 32B | INT4，≈595 GB | 256K | Modified MIT | 同上 | 已被 K2.6 取代 |
| Kimi-K2-Instruct-0905 | 1T / 32B | FP8，≈1,029 GB | 256K（未单独核实） | Modified MIT | — | 体积更大，不推荐 |
| **Kimi-Linear-48B-A3B-Instruct**（2025-10） | 48B / 3B | BF16，≈98 GB | **1M** | **MIT** | 官方示例 `vllm serve ... --tensor-parallel-size 4 --max-model-len 1048576`；KV cache 最多降 75%、1M 上下文解码最高 6× | **2–4 卡单机可跑**（如 4×48GB 或 2×80GB），长文阅读/检索预处理/摘要合适；能力远低于 K2.6/K3，不能替代主模型 |
| Kimi-VL-A3B-Thinking-2506 | 16B / 3B | BF16，≈33 GB | 128K（未单独核实） | MIT | — | **单卡 48GB 可跑**，适合本机 OCR/扫描件理解辅助 |
| Moonlight-16B-A3B-Instruct | 16B / 3B | BF16，≈32 GB | 8K（未单独核实） | MIT | — | 单卡可跑，能力偏弱，仅作实验 |
| Kimi-Dev-72B（2025-06） | 72B 稠密 | BF16，≈145 GB | — | MIT | — | 编程专用，法律场景不适用 |

来源：https://huggingface.co/api/models?author=moonshotai ；各模型 `https://huggingface.co/api/models/moonshotai/<id>?blobs=true` ；README：https://huggingface.co/moonshotai/Kimi-K2.6 、https://huggingface.co/moonshotai/Kimi-K2.6/blob/main/docs/deploy_guidance.md 、https://huggingface.co/moonshotai/Kimi-Linear-48B-A3B-Instruct ；K2.6 LICENSE：https://huggingface.co/moonshotai/Kimi-K2.6/blob/main/LICENSE

### 1.3 对“私有模型端点”选项的建议（推断）
1. **主路径不变**：律所默认走中软云端 K3 token API；私有端点作为“高敏客户/涉密律所”的可选项，产品内核只需支持“OpenAI/Anthropic 兼容 base_url 可配置 + 模型能力分级”。
2. **私有端点分三档**：A 档（大所/联盟/律协集中托管）K2.6 INT4 单节点 8×H200 级或国产同级；B 档（中所）Kimi-Linear-48B 或 Kimi-VL-A3B 做本地预处理（脱敏、摘要、OCR、检索），主推理仍回云端；C 档（个人律师）不建议本机大模型。
3. **K3 本地化只在中软/合作方机房**：需在与月之暗面的合作协议中确认“认证推理伙伴”身份或 MaaS 例外的适用，避免触发第 2 条。
4. K3 必须原样回传 `reasoning_content`，私有端点与云端端点在消息存储格式上要一致，否则审计日志与重放会出问题。


---

## 2. Office / WPS 加载项访问本机服务

### 2.1 Office.js 加载项 → 本机 `127.0.0.1` / `localhost`

| 事实 | 证据等级 | 来源 |
|---|---|---|
| Windows 版 Office 加载项运行在 **Microsoft Edge（Chromium）WebView2** 中；Mac/iOS 是 **Safari WKWebView**；Office 网页版是用户所用浏览器 | 一手 | https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/browsers-used-by-office-web-add-ins |
| 微软文档原文（Power Apps 页面，适用于同一 Chromium 内核）：“**Chrome and Microsoft Edge block requests from public origins to local endpoints by default**”，嵌入场景需在 iframe 上加 `allow="local-network-access"`，或由企业策略放行 | 一手 | https://learn.microsoft.com/en-us/power-apps/developer/code-apps/how-to/create-an-app-from-scratch |
| Chromium **Local Network Access（LNA）** 上线后（WebView2 143 / Edge 143 起），Office 加载项访问 localhost 出现大面积故障。Office.js 团队成员（GitHub MEMBER wandyezj）确认是“**regression ... due to the rollout of the Local Network Access change in Chromium**”；之后用户需在弹窗点“允许”，点了拒绝就要去浏览器设置改；“Ideally, organizations push a policy to allow specific network access”；并预计 Firefox/Safari 也会跟进 | 一手（官方仓库，微软成员评论） | https://github.com/OfficeDev/office-js/issues/6366 |
| Word/Excel/PPT 网页版已给加载项 iframe 补上 `allow="local-network-access"`（2025-11 中合入）；新版 Outlook / OWA 修复于 2026-02-04 部署、2–3 周全球生效（Outlook 修复的说明者账号在仓库中无 MEMBER 标识，身份未核实） | 一手（官方仓库）/修复时间为二手 | https://github.com/OfficeDev/office-js/issues/6400 ；https://github.com/OfficeDev/office-js/issues/6426 |
| 临时绕过：Edge 策略 `LocalNetworkAccessRestrictionsTemporaryOptOut=1`（名称即“临时”），新 Outlook 桌面端在该策略下表现仍“时好时坏” | 二手（开发者报告） | 同上 #6400 |
| 仍未解决：Exchange Server 本地部署的 OWA 加载项 iframe 缺 LNA 权限（2026-07 开放）；OneNote Online on Chrome LNA 不生效（2026-07 开放） | 一手（官方仓库 open issue） | https://github.com/OfficeDev/office-js/issues/6860 ；https://github.com/OfficeDev/office-js/issues/6874 |
| **Mac**：Word for Mac 加载项向 `http://127.0.0.1:23119` 发 XHR 报 “access control checks” 失败，微软以 **By Design** 关闭（网页版 Word 可以） | 一手（官方仓库） | https://github.com/OfficeDev/office-js/issues/3674 |
| 混合内容：Chromium 把 `http://127.0.0.1` / `http://localhost` 视为“潜在可信源”，https 页面请求它们**不按混合内容拦截**，但受 LNA 约束；微软 Office 文档未见专门表述 | 未核实（微软文档无原文；属 Chromium 通行行为） | — |

**对本项目的设计含义（推断）**
1. **不要让“云端 https 页面 → 本机 http 服务”成为主通道**：LNA 已经让这条路在 2025-12 至 2026-02 大面积中断过一次，Mac 端更是 By Design 不通。
2. **推荐形态**：Office 加载项的 taskpane 页面**直接由本机内核以 `https://localhost:<端口>` 提供**（与其 API 同源，不触发跨地址空间请求）；证书用安装时生成并写入当前用户受信根的本地 CA（或 Electron 主进程签发），manifest 由律所 IT 通过 M365 集中部署或共享文件夹目录（SMB catalog）侧载。注意：manifest 指向 localhost 用于生产在微软文档中没有明确支持表述（**未核实**），需 PoC。
3. **兜底**：若必须从云端页面访问本机，则 (a) 律所 IT 下发 Edge/WebView2 LNA 允许策略（按 origin 白名单），(b) 首次使用引导用户点“允许”，(c) 退化为“加载项只做 UI，本机内核通过轮询云端/所内节点中转”的间接通道。
4. Mac 端（若有）只能走 `https://localhost` + 受信证书，或放弃本机直连。

### 2.2 COM / VSTO 加载项与 .NET 8

| 事实 | 证据等级 | 来源 |
|---|---|---|
| 微软 .NET 团队（AaronRobinsonMSFT，2021-06-02）官方表态：“**VSTO/COM Add-Ins cannot be created with .NET Core and .NET 5+.** ... .NET Core/.NET 5+ cannot work together with .NET Framework in the same process and may lead to add-in load failures. **Microsoft will not be updating VSTO or the COM Add-in platform to use .NET Core or .NET 5+**.” | 一手（微软成员在 dotnet/core 官方仓库的正式声明） | https://github.com/dotnet/core/issues/5156#issuecomment-853430132 |
| 同一声明：VSTO/COM 平台“将继续以 **.NET Framework 4.8 作为最后一个主版本**获得支持”，.NET Framework 会继续服务与支持；推荐方向是跨平台 JavaScript API（Office Web Add-ins） | 一手 | 同上 |
| 技术根因：同一进程不能同时承载 .NET Framework CLR 与 .NET Core CLR（官方仓库 issue 仍 open）；.NET 5+ COM 宿主同一进程只能加载一个 .NET 版本 | 一手（官方仓库 issue） | https://github.com/dotnet/runtime/issues/53729 ；https://github.com/dotnet/runtime/issues/49686 |
| .NET Core/.NET 5+ 可以通过 `EnableComHosting` 暴露 COM 组件，但不生成 TLB，且与 .NET Framework 同进程有诊断/调试限制 | 一手 | https://learn.microsoft.com/en-us/dotnet/core/native-interop/expose-components-to-com |

**结论**：Office 进程内加载 .NET 8 COM 加载项**不受官方支持**（技术上可能跑通，但与其他 .NET Framework 加载项同进程时会加载失败）；**.NET Framework 4.8 VSTO/COM 仍受支持**但不再演进。若需要 Word 深度能力（修订、批注、域代码、宏级操作），可选：(a) .NET Framework 4.8 薄 COM 外壳 + 本机 IPC（命名管道/localhost）连到 Electron/本机内核；(b) 进程外 COM（本地 EXE 服务器）用任意语言实现。法律场景首选 Office.js（跨 Win/Mac/网页），COM 只作为“修订/比对”等 Office.js 能力不足时的 Windows 增强件。

### 2.3 WPS JS 加载项

| 事实 | 证据等级 | 来源 |
|---|---|---|
| WPS 提供两种部署：**publish 模式**（`wpsjs publish` 打包，部署到打包时填写的服务器地址，用户打开 publish.html 安装/卸载，本地生成 `%appdata%/kingsoft/wps/jsaddons/publish.xml`）与 **jsplugins.xml 模式**（oem.ini 中 `JSPluginsServer` 指向 jsplugins.xml，需二次打包） | 一手（金山官方开发文档） | https://qn.cache.wpscdn.cn/encs/doc/office_v19/index.htm → “WPS 加载项开发说明 / 发布部署” |
| publish 模式分**在线模式**（WPS 请求“地址+/ribbon.xml”和“地址+/index.html”）与**离线模式**（校验地址能否访问到压缩包，下载 7z 包到本地加载） | 一手 | 同上 |
| 官方 jsplugins.xml 示例中加载项包地址即为 `url="http://localhost:8080/demo_et_3.6.7z"`，说明**加载项可从本机 HTTP 服务加载**；oem.ini 可开 `JsApiPlugin=true`、`JsApiShowWebDebugger=true` | 一手 | 同上 → “WPS 加载项可用性” |
| publish 模式版本要求：Windows 企业版 20200425 分支之后、Linux 企业版 20200530 分支之后 | 一手 | 同上 |
| **个人版限制**：通过修改 oem.ini 加载加载项的方式已被限制，新个人版上 jsplugins.xml 模式不再支持，需改用 `wpsjs publish` | 一手 | 同上 → “加载项概述” |
| wpsjs 工具 2.1.7 起支持 `customDomain`（把离线加载项本地文件模拟成自定义域名下的在线文件，仅鸿蒙版 WPS 生效）；2.2.0 增加 Mac 适配；npm 最新 2.2.3（2025-09） | 一手（官方 npm 包 changelog） | https://registry.npmjs.org/wpsjs |
| 社区实现（Zotero-WPSJS）：WPS JS 加载项 + 本地 proxy.exe 访问 Zotero 本机服务，安装说明要求“信任对于 wpsjs 项目的访问”并**关闭“沙箱保护”** | 二手（社区开源） | https://github.com/bigben446/Zotero-WPSJS |
| WPS 加载项内 `fetch` 到 `http://127.0.0.1` 是否受 LNA/跨域限制、是否需 CORS | 未核实（官方文档未找到明确表述；WPS 内核为 Chromium/CEF，推断需本机服务返回 CORS 头） | — |

**结论**：WPS 侧比 Office 宽松——加载项本身可以是本机 HTTP 服务提供的在线模式页面（publish 在线模式的服务器地址填 `http://127.0.0.1:<端口>`），或离线 7z 包；但需注意 (1) 个人版只能走 publish；(2) 社区经验显示可能要用户调整“沙箱保护/可靠发行商”设置，信创/政企版本差异大，需按目标律所的 WPS 版本做兼容矩阵 PoC。


---

## 3. 本地优先同步参考实现

### 3.1 Joplin（一手，官方仓库 spec 文档）

| 维度 | 原文要点 | 来源 |
|---|---|---|
| 许可证 | 仓库默认 **AGPL-3.0-or-later**（子目录有自带 LICENSE 的除外，如 packages/server）；Joplin 是 JOPLIN SAS 注册商标 | https://github.com/laurent22/joplin/blob/dev/LICENSE |
| 活跃度 | 5.6 万星，2026-09-25 发布 v3.7.21 | GitHub API |
| 同步目标 | 不绑定任何服务；通过“提供类文件系统接口（读、写、删、列）”的轻量驱动接入，现支持 Joplin Cloud、Nextcloud、S3、WebDAV、Dropbox、OneDrive、**本地文件系统** | https://github.com/laurent22/joplin/blob/dev/readme/apps/sync/index.md |
| 同步单元 | “items”= 笔记、笔记本、标签、资源（附件），每个 item 单独序列化上传；修改后几秒内上传以减少冲突，另每几分钟轮询下载；每条 item 的同步状态记在本地 `sync_items` 表（按 sync_target 区分），`info.json` 中属性带 `updatedTime` 以启发式解决同属性冲突 | https://github.com/laurent22/joplin/blob/dev/readme/dev/spec/sync.md |
| 锁 | 两类锁：SYNC（可多个并存）、EXCLUSIVE（升级同步目标时，仅一个）；锁须每 X 秒刷新，超过 Y 秒视为过期；锁过期后正在进行的操作必须中止 | https://github.com/laurent22/joplin/blob/dev/readme/dev/spec/sync_lock.md |
| E2EE 密钥模型 | **主密钥（Master Key）**用于加解密数据，主密钥本身用用户密码加密后**随同步数据一起传输**，新设备输入密码解密；支持多个主密钥（应对两台离线设备各自开启加密），加密时只有一个 active，解密按密文头中的 Master Key ID 选钥；共享笔记本时动态生成独立数据密钥，并用**公私钥对**在用户间传递秘密；数据分块加密，仅在序列化上传时加密 | https://github.com/laurent22/joplin/blob/dev/readme/dev/spec/e2ee/index.md |
| 冲突处理 | 同一笔记/附件在两处修改后同步：把本地版本复制到 “Conflict” 笔记本，远端版本覆盖本地；用户可用“历史版本”恢复；无自动合并 | https://github.com/laurent22/joplin/blob/dev/readme/apps/conflict.md |

**可借鉴点**：文件系统驱动抽象（本地目录即可作同步目标）、每条目一文件、主密钥密码包裹后随数据同步、多主密钥并存、共享单元独立数据密钥 + 公私钥分发。**不宜照搬**：AGPL 许可证（闭源商用不能直接复用代码，只能借鉴设计）；“远端覆盖本地 + 冲突本”的处理对法律审计不够——本项目“每设备只追加写自己的事件段”从根上避免了写冲突，比 Joplin 更适合审计。

### 3.2 Automerge 与 Yjs

| 项 | Automerge | Yjs |
|---|---|---|
| 许可证 | **MIT**（GitHub API） | **MIT**（仓库 LICENSE 文件；GitHub API 显示 NOASSERTION 是因文件格式） |
| 成熟度 | 6.6k 星；JS 包 3.5.0 发布于 2026-09-16，持续活跃 | 2.3 万星；稳定版 v13.6.33（2026-09-23），v14 处于 RC（v14.0.0-rc.28，2026-09-29） |
| 适合签名事件日志吗（推断） | 变更以哈希寻址、按依赖哈希组成 DAG，结构上接近“内容寻址事件日志”，但**不内置签名、身份与权限**，需在外层对每个 change/段文件签名；适合“同一份结构化文书/清单的多人离线合并” | 面向实时协作文本/结构的 state-based CRDT，更新是二进制增量，**无哈希链、无签名**，更适合编辑器协同（与 ProseMirror/TipTap 集成成熟），不适合直接做审计日志 |
| 来源 | https://github.com/automerge/automerge | https://github.com/yjs/yjs ；https://raw.githubusercontent.com/yjs/yjs/main/LICENSE |

**建议（推断）**：审计/审批/事件用**自研追加式签名事件段**（每设备一条哈希链 + Ed25519 签名 + 内容寻址密文块），不依赖 CRDT 库；只有“多人同时编辑同一份文书草稿”这种场景才在事件载荷里嵌 Automerge 变更（MIT，许可无障碍）。Yjs 留给将来的实时协同编辑器。

### 3.3 SMB / NAS / 网盘同步目录多写者的已知坑

| 坑 | 原文要点 | 证据等级 | 来源 |
|---|---|---|---|
| 网络文件系统写入乱序/丢失 | SQLite 官方：网络文件系统中客户端写入的部分内容可能“out of time order”落盘，存在乱序与丢失，必须确保一组写入完成后才开始下一组 | 一手 | https://www.sqlite.org/useovernet.html |
| 网络文件系统锁不可靠 | SQLite 官方：部分文件系统锁实现有 bug，“especially true of network filesystems”，多进程同时访问会损坏数据库 | 一手 | https://www.sqlite.org/howtocorrupt.html |
| 部分写入/临时文件 | Syncthing：块校验通过后先写入**临时副本**再替换；外部同步器在复制过程中，其他设备可能看到未完成的文件 | 一手 | https://docs.syncthing.net/users/syncing.html |
| 冲突副本 | Syncthing：两端同时修改 → 较旧者改名为 `<文件名>.sync-conflict-<日期>-<时间>-<设备>.<扩展名>`，且**冲突副本作为普通文件继续传播**；Dropbox：多人同时编辑同一文件会生成 “conflicted copy” | 一手 | 同上；https://help.dropbox.com/organize/conflicted-copy |
| 按需同步占位符 | 群晖 Drive “按需同步”：访问时才把文件串流到本机——占位文件对扫描/哈希/索引程序会触发下载或读失败 | 一手（官网功能描述）；影响为推断 | https://www.synology.cn/zh-cn/dsm/feature/drive |

**对本项目的设计约束（推断）**：(1) 共享目录里**绝不放 SQLite/任何需要锁的文件**，只放不可变文件；(2) 段文件写入采用“写临时名 → fsync → 原子改名”，读取端只认已封口（含尾部哈希/签名）的段，忽略 `.tmp`、`*.sync-conflict-*`、“冲突副本/conflicted copy/(1)” 等变体；(3) 每设备独占自己的段目录（单写者），因此网盘冲突副本理论上不应出现，一旦出现即告警；(4) 密文块以内容哈希命名，重复写入幂等；(5) 本地索引库（SQLite）放在本机 `%LOCALAPPDATA%`，由同步目录重放生成。

### 3.4 国内网盘是否提供 Windows 桌面同步目录

| 产品 | 结论 | 证据等级 | 来源 |
|---|---|---|---|
| 坚果云 | **有**。官网定位“同步盘”，“支持任意文件夹的存储、备份、同步、分享和协作”；帮助中心有“同步您的文件/同步文件夹的权限设置/局域网同步加速/智能增量同步”，提供 Windows 客户端 | 一手 | https://www.jianguoyun.com/ ；https://help.jianguoyun.com/ |
| 群晖 Synology Drive | **有**。官网：文件和文件夹变动“自动同步至所有连接的设备”，支持**按需同步**、版本回溯、Drive ShareSync 跨 NAS 同步；Windows 端为 Synology Drive Client | 一手 | https://www.synology.cn/zh-cn/dsm/feature/drive |
| 企业微信微盘 | 本次未能从官方帮助中心取到原文（页面为前端渲染） | 未核实 | — |
| 钉钉钉盘 | 同上 | 未核实 | — |
| 飞书云盘 | 官网产品页为前端渲染，未取到“桌面同步目录”原文 | 未核实 | https://www.feishu.cn/product/drive |

**建议**：首批只对“**本地 SMB/NAS 共享目录 + 坚果云 + 群晖 Drive**”做兼容认证；企业微信微盘、钉盘、飞书云盘在拿到官方说明并实测“是否有真实本地目录、是否按需占位、冲突副本命名规则”后再列入支持清单。


---

## 4. 竞品本地化形态（只记官网/官方文档原文能支持的结论）

### 4.1 国内

| 产品 | 官网/官方文档原文能支持的结论 | 本地执行 | 数据是否上云 | 私有化/本地模型 | 证据等级 | 来源 |
|---|---|---|---|---|---|---|
| **腾讯 WorkBuddy** | 文档：与传统 AI 对话相比“**自动操作本地文件**”；默认权限“以工作空间为边界”，沙箱约束文件/命令/网络，越界和高危需确认；安全中心：“**本地与云端通信使用端到端加密通道**”（默认开启）、工作空间出入流量经安全网关、敏感信息检测拦截、删除保护与批量删除审批；模型可选内置模型、腾讯云 Token Plan（兼容混元、MiniMax、**Kimi**、GLM）、自定义 API，以及 **Ollama 本地部署**（“代码与对话内容不出本机，适合金融、政企、敏感项目场景”）；另有 WorkBuddy Enterprise、小程序、移动端 | 是 | 默认调用云端模型（推断：对话内容进入云端模型）；可选本地模型 | 有本地模型选项（Ollama）；企业版私有化未取到原文 | 一手 | https://www.codebuddy.cn/docs/workbuddy/Overview ；…/Function-Description/Permission-Modes ；…/Function-Description/Model |
| **iCourt Alpha** | 官网：“支持网页版、**客户端**、**Word 插件**、iOS、Android、iPad 及小程序”；ISO 27001、公安部**等保三级**；权限控制；“成员离职后账号下全部文件信息自动删除” | 官网未写本地执行（推断为云端 SaaS + 多端客户端） | 官网未明示（推断在 iCourt 云端） | 未见原文 | 一手（多端与认证）/未核实（本地化） | https://www.icourt.cc/product/alpha |
| **智合 AI（智拾网）** | 官网为网页工具集：AI 法律研究/检索、文书&合同起草、合同&文件审查、超级文件助手、**“智合AI Skill中心（内测申请）”** | 未见桌面端/本地执行原文 | 未见原文 | 未见原文 | 未核实 | https://www.zhi10.com/page/zhiheai |
| **千问办公 / QoderWork（阿里）** | 官方文档站存在 “QoderWork CN 更新日志”，产品页为前端渲染，未取到原文 | 未核实 | 未核实 | 未核实 | 未核实 | https://docs.qoder.cn/product-overview/qoderwork-cn-update-log |
| **Kimi Work** | 官网页面为前端渲染，本轮未取到原文；项目既有资料记为“本地 Agent 形态” | 二手（项目既有资料） | 未核实 | 未核实 | 未核实 | https://www.kimi.com/work |

### 4.2 海外

| 产品 | 原文要点 | BYOK | 私有部署 | 证据等级 | 来源 |
|---|---|---|---|---|---|
| **Legora** | “Manage your own encryption keys with our **BYOK option**”；传输 TLS 1.2+、静态 AES-256；“For customers who require additional control, we also offer the option to encrypt data with their own encryption keys”；SSO；数据治理（实时查看谁在访问数据） | **有** | 未见原文 | 一手 | https://legora.com/security |
| **Harvey** | 合同禁止模型提供方用客户数据训练；“Harvey requires **Zero Data Retention** (ZDR) by model providers”；客户可显式要求用其数据训练定制模型 | security 页未见 | 未见 | 一手（ZDR）/未核实（BYOK、私有部署） | https://www.harvey.ai/security |
| **Spellbook** | 与 OpenAI、Anthropic 签有 **ZDR** 协议；SOC 2 Type II；有 Trust Portal | 未见 | 未见 | 一手（ZDR）/未核实（BYOK、私有部署） | https://www.spellbook.legal/security ；https://www.spellbook.legal/pricing |

**观察（推断）**：海外头部法律 AI 普遍以“云端 SaaS + 模型方 ZDR + （部分）BYOK”回应保密要求，**没有一家在官网原文中提供私有部署**；国内 WorkBuddy 已把“本地执行 + 云端模型 + 可选本地模型（Ollama）”做成通用办公 Agent 的标准配置，并直接兼容 Kimi。本项目“案卷与审计本地化 + 云端只出 token”的形态与 WorkBuddy 同构，差异化必须落在**法律专属治理**（签名审计链、审批签发、所内节点、律协指引合规）和**法律内容资产**上，而不是“本地执行”本身。

### 4.3 法律 AI / 大模型一体机

| 项 | 内容 | 证据等级 | 来源 |
|---|---|---|---|
| 杭州拱墅区检察院大模型一体机 | **24.82 万元**（大华 70B 工作站） | 二手（项目既有调研 `research/00-关键判断-running.md` 第 381 行，原始公告链接本轮未复核） | — |
| 山西高院 元典智库 V3.0 | **270 万元**（属法律大模型平台采购，非纯一体机） | 二手（同上） | — |
| 其他“法律大模型一体机”产品与价格区间 | 本轮搜索引擎检索无有效结果，未取到官网或新闻原文 | 未核实 | — |

**参考换算（推断）**：能跑 Kimi-Linear-48B / Kimi-VL-A3B 的 2–4 卡工作站与上述 20–30 万元级“一体机”同档；能跑 Kimi-K2.6 INT4 的 8×H200 级单机属百万元级以上；K3 需 8×B300 或 16×H200 起，不在律所采购范围。
