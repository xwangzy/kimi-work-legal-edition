# 调研 V1：Kimi token 通道、中软 token 业务、三家 IM 长连接、Electron 运行时

调研日期：2026-10-01（下文所有来源访问日期均为 2026-10-01）
调研方式：curl 抓取官方文档原文（Kimi 开放平台 `.md` 文档、飞书 `.md` 文档、钉钉开源文档仓库、企业微信开发者中心页面、港交所披露易 PDF、Electron 官方 JSON 与源码）。360、搜狗、必应在本环境被拦截或返回空结果；中财网页面有"我不是机器人"验证页，按规则没有绕过，改用港交所原文。
证据等级：**一手** = 官方文档、协议、公告或源码原文；**二手** = 官方 SDK 仓库的 README、第三方插件或媒体；**未核实** = 本次没有取到原文。

---

## 结论速览

| # | 问题 | 结论 | 证据等级 | 来源 |
|---|---|---|---|---|
| A1a | 项目与 Key 数量 | 按组织认证类型设上限：企业认证 50 个项目、100 个 API Key；个人认证 20/50；未认证 1/10。更多需要找客服 | 一手 | platform.kimi.com/docs/guide/org-best-practice.md |
| A1b | 额度与消费上限 | **项目级**可以设月、日消费预算，超出后拒绝请求，约有 10 分钟延迟；**项目级**可以设 TPM 上限，不能超过组织 TPM；**Key 级**没有额度设置 | 一手 | 同上 |
| A1c | IP 白名单 | **只有组织级**：最多 20 条，只收公网 IPv4 或 CIDR，不支持 IPv6 和内网地址，对组织下所有 Key 生效 | 一手 | 同上 |
| A1d | 用量查询 API | 文档里只有 `GET /v1/users/me/balance`，查组织余额。**没有**按 Key 或项目查用量的 API；分项目消费只能在控制台看或导出账单 Excel | 一手（API 端点一览中没有） | api/overview.md、api/balance.md |
| A1e | 子账户与临时令牌 | 文档未见子账户、临时令牌或短期令牌。只有组织成员和项目成员两类角色；成员移出项目后，他建的 Key 一起失效 | 一手（文档未见 = 不存在的证据较弱） | org-best-practice.md |
| A1f | 限流分级 | 按累计充值分 Tier0–Tier5。Tier5 门槛 ¥20,000：并发 100、RPM 300、TPM 5,000,000、TPD 不限、搜索 QPS 50。**限速在组织（用户）级别执行，不按 Key**；组织内所有项目共享限速和余额 | 一手 | pricing/limits.md、introduction.md |
| A1g | 企业版与专属额度 | 没有公开的自助开通流程，统一"联系销售"（platform.kimi.com/contact-sales）。已签合同的用户按合同约定扣费 | 一手 | guide/account-and-payments.md、changelog |
| A2a | 上下文缓存 | **自动前缀缓存**。缓存**按组织隔离**：同一组织内共享，组织之间不共享。按块存储，不足一块的部分按未命中计费；不能手动清除 | 一手 | guide/context-caching.md |
| A2b | 缓存计费（K3） | 写入：5m 档 ¥20/M，1h 档 ¥40/M；命中 ¥2/M；未命中 ¥20/M。命中后按原 TTL 免费续期。只有 K3 收写入费，K2.6、K2.7 不收 | 一手 | 同上、pricing/chat.md |
| A2c | Anthropic 端点 `cache_control` | **只在请求顶层生效**，写在消息体里会被忽略。传了就按 5m 或 1h 写入；**不传则只读 5m 缓存，不写入** | 一手 | api/messages.md、context-caching.md |
| A3a | 嵌入产品与转售 | 许可原文是"非排他的、不可转让、不可再许可的普通许可"，"仅供您内部使用或向最终用户提供服务"。所以**嵌入自有产品服务企业客户是允许的**。协议没有"转售"二字，但账号不得"出借、出租或提供给他人使用"，又不可再许可，**直接转卖裸 API 不在许可范围内** | 一手 | agreement/modeluse.md（2026-08-31 生效版） |
| A3b | "用于模型服务优化"条款 | **仍然有效**：用户授予月之暗面一项免费使用权，可在法律允许范围内把输入输出和反馈用于模型服务优化。ZDR 页面却写着"默认不使用企业客户数据训练模型"，两处口径不一致，需要在合同里写定 | 一手 | modeluse.md 第 3 条；guide/zero-data-retention.md |
| A3c | ZDR | 面向企业客户按需开放，要联系销售评估。开通后接口、参数、计费不变。**不覆盖**：通过文件上传方式提交的图像和视频、托管智能体（Hosted Agents）数据、安全日志和账单等运营数据、第三方模型、连接器和插件。内容安全审核照常进行 | 一手 | guide/zero-data-retention.md |
| A3d | 文件与 Batch 留存期 | 单个文件最大 100 MiB；按组织总存储量限制，默认 10 GiB；文件接口限时免费。**文档没有写留存期**，Batch 输入输出文件也没有写 | 一手（上限）/ 未核实（留存期） | api/files-upload.md、guide/use-batch-api.md |
| A3e | 内置联网工具 | `$web_search` 每次触发 ¥0.03，搜索结果另计 token；**预计 2026-10-20 下线**。新接口按次计费：`/v1/tools/search` ¥0.01、`search_pro` ¥0.015、`/v1/tools/fetch` ¥0.01，有独立 QPS，不占 TPM | 一手 | pricing/websearch.md、guide/use-web-search.md |
| A4 | 价格与 K2.8 | 每百万 token：K3 未命中 ¥20、命中 ¥2、写入 ¥20 或 ¥40、输出 ¥100；K2.7 Code 6.5/1.3/27；K2.7 Code 高速版 13/2.6/54；K2.6 6.5/1.1/27。Batch 打 6 折，只支持 K2.7 Code 和 K2.6。**K2.8 不在 API 模型列表里**，所以到 10-01 没有开放 API | 一手 | pricing/chat.md、pricing/batch.md、models.md |
| B5a | 中软 token 业务 | 06-03 公告"進軍算力業務"，三种模式之一是"token銷售"：依托 allmeta、smart code 的 token 调用能力，**按实际使用量向企业和开发者卖大模型推理 token，并配套 API 接入**。官网有"Token运营"栏目，写到 Token 级计量计费，支持订阅、按需付费、包年包月。**没有找到公开的自助 MaaS 控制台或 API 文档**，看不出是否基于 new-api，增值电信许可也未核实 | 一手（公告与官网）/ 未核实（平台形态与资质） | HKEX 2026060302433_c.pdf；chinasofti.com/pages/products-token |
| B5b | 07-20 协议原文 | 写的是"Token分成機制"：合作落地过程中**基于 Kimi 大模型产生的 Token 消耗收益**和其他合作衍生收入，双方按协议约定比例分成。**没有"分销"或"转售"字样**；首期优先能源电力，行业表述是"能源电力、金融等"，没有提法律 | 一手 | HKEX 2026072000262_c.pdf |
| C6 | 钉钉 Stream | 内网机器只要能出公网就能接入，**不需要公网 IP、域名或白名单**。机器人单聊和群聊（群里需 @）消息走 Stream，互动卡片回调也走 Stream（`/v1.0/card/instances/callback`）。**机器人消息是"fire-forgot"模式，不重投**；事件订阅超时会重投。有多条连接时随机推送到其中一条 | 一手（钉钉开源文档仓库）/ 未核实（连接数上限、费用、离线保留） | open-dingtalk/developerpedia protocol.md、faq.md |
| C7 | 飞书长连接 | **只支持企业自建应用**。每个应用最多 50 条连接，集群模式：多个客户端时只有随机一个收到。3 秒内处理完；事件失败后按 15 秒、5 分钟、1 小时、6 小时重推，**最多 4 次**。**卡片回传交互（card.action.trigger）可以走长连接**，但必须 3 秒内响应，超时会在用户端直接报错。资源文件下载不用 Range 时限 <100 MB；**外部群不支持**（错误码 234009） | 一手 | open.feishu.cn 长连接、卡片回调、资源下载、事件概述文档 |
| C8 | 企业微信 | **有不需要公网回调的方式**：智能机器人"长连接 API 模式"，连 `wss://openws.work.weixin.qq.com`，文档写明"无需固定的公网 IP"。**每个机器人同时只能有 1 条连接**，新连接会踢掉旧连接。文件、图片、视频消息**只支持单聊**；下载地址 5 分钟内有效，并带 aeskey。模板卡片按钮事件走长连接，更新卡片要在 5 秒内完成。自建应用的回调需要公网 URL；"可信域名与备案主体一致"这一条本次没取到原文 | 一手（101463 页，2026-05-25 更新）/ 未核实（自建应用可信域名、费用、离线） | developer.work.weixin.qq.com/document/path/101463 |
| C9 | 闭环能否实现 | **三家都能实现**"转文件→本机处理→回卡片→合伙人点卡片审批"，前提是**连接节点在线**。节点离线时：钉钉机器人消息丢失；飞书消息在约 7 小时内重推 4 次，卡片点击立即报错；企业微信文档没写离线行为。**另外，飞书和钉钉都把消息随机派给某一条连接，企业微信只允许 1 条连接，所以不能让每台律师电脑各连一个同名机器人** | 一手推导 | 见 C6–C8 |
| D10a | Electron 版本与 Node | 42.x：Node 24.19.0，**2026-10-20 EOL**。43.x：Node 24.21.0，EOL 2027-01-05。44.x：Node 24.21.0，EOL 2027-03-02。45：2026-10-20 发布稳定版（alpha.13 内置 Node 24.21.0），EOL 2027-04-27。**都满足 Node ≥ 24.15，但都不是 Node 26** | 一手 | releases.electronjs.org/schedule.json、releases.json |
| D10b | utilityProcess 沙箱 | **不能**。源码里固定写死 `[ServiceSandbox=sandbox.mojom.Sandbox.kNoSandbox]`，`utilityProcess.fork` 也没有 sandbox 选项，Windows 和其他平台都一样。降权只能在 Electron 之外做 | 一手（源码） | electron/shell/services/node/public/mojom/node_service.mojom；docs/api/utility-process.md |

---

## 最影响架构的判断（供决策）

1. **Kimi 只在组织这一级做隔离**。限速、缓存、IP 白名单、余额都在组织级；项目级只有预算、TPM 上限和账单拆分；Key 级什么控制都没有。
   - **中软中转（一个组织）**：所有律所共享一份 Tier 限速，Tier5 是并发 100、5M TPM。项目上限 50 个，按"一律所一项目"做最多 50 家。超过这些都要找销售签专属额度。缓存在组织内共享，对律所之间的保密是一个需要评估的点（同一前缀会跨租户命中）。
   - **律所直连（一所一组织）**：每家律所要自己完成企业认证、自己充值才能升 Tier（K3 不能用新用户代金券）、自己申请 ZDR。中软拿不到用量数据，因为没有用量 API；token 分成也无从计量。
2. **Key 不能放进律师客户端**。Key 级没有任何限额，IP 白名单只在组织级而且只收公网 IPv4，协议又规定账号和 Key 不得提供给他人使用。如果用中软的组织，Key 必须留在服务端，可以是中软的 token 中转，也可以是律所服务器上的代理。
3. **"云端只提供 token"在数据条款上还不成立**。默认协议仍然授权月之暗面把输入输出用于"模型服务优化"。ZDR 要单独签，而且图像和视频走文件上传时不在 ZDR 覆盖范围内。本地执行方案应满足：图片和扫描件只用 base64 内联发送、不走 Files API；不用 Hosted Agents；不用连接器和插件。合同里要写明 ZDR 和不训练。
4. **请求签名接口可以作为信任凭据**（`X-Msh-Request-Nonce` + 校验接口）。律所可以自己验证某次请求确实到达了 Kimi API、用的就是声明的模型、没有被中间层改走。这正好支撑"中软中转但不碰数据"的说法；当然中转层仍然看得到明文，只有改成律所直连才能根除。
5. **IM 接入要有一个"律所常驻节点"，不能放在每台律师电脑上**。原因有三：飞书和钉钉把消息随机派给一条连接，企业微信只允许一条连接；飞书卡片回调 3 秒内必须响应，企业微信卡片更新要在 5 秒内完成；钉钉机器人消息离线即丢。所以这个连接器应该常驻在律所服务器或一台指定的常开电脑上，再把任务派发到对应律师的本机。
6. **企业微信只能单聊收文件，飞书外部群不能下载资源**。"把文件转给机器人"的流程应该设计成在单聊里完成。
7. **Electron 内置的 Node 是 24.21，不是 26**。platform/README 写的是"本机需 Node ≥ 26"。如果后端服务要放进 Electron 的 utilityProcess 里跑，就要降到 Node 24 能用的 API，或者另外打包一个独立的 Node 26 运行时。utilityProcess 没有沙箱，规则、核验这类不可信代码的隔离要另想办法。
8. **版本选型**：42 在 10-20 就 EOL。首发建议用 44（支持到 2027-03-02），或者等 45（10-20 稳定版，支持到 2027-04-27）。

---

## A. 月之暗面 Kimi 开放平台的 token 通道能力

文档域名：`platform.moonshot.cn/docs/*` 会 301 跳到 `platform.kimi.com/docs/*`。每页都可以直接取 `.md`，索引在 https://platform.kimi.com/docs/llms.txt 。

### A1 组织、项目与 API Key

- **项目与 Key 数量**（一手，https://platform.kimi.com/docs/guide/org-best-practice.md ）

  | 组织类型 | 项目个数上限 | API Key 个数上限 |
  |---|---|---|
  | 未认证 | 1 | 10 |
  | 个人认证 | 20 | 50 |
  | 企业认证 | 50 | 100 |

  表中的 Key 上限是组织级还是项目级，文档没有明说；从表头看是按组织类型给的。超出需要扫码联系客服。

- **项目级消费控制**（一手，同上）
  - 可以按项目设月预算和日预算。原文："项目内的 API Key 消费使用达到预算后，任何后续该项目的 API 请求会被拒绝"，"实际执行限制预计会有 10 分钟左右的延迟"。
  - 可以设项目消费提醒，通过短信发给组织管理员。
  - 可以设项目 TPM 上限，不能超过组织 TPM。
  - 原文还写明"组织下的所有项目共享组织内的限速""共享组织的账户余额"。
- **Key 级控制**：文档未见 Key 级的额度、限速、过期时间或 IP 绑定。原文："速率限制是在用户级别而非密钥级别上实施的。"（一手，https://platform.kimi.com/docs/introduction.md ）
- **IP 白名单**（一手，org-best-practice.md；2026 年 6 月上线，见 changelog）
  - 组织级配置，个人认证和企业认证都能用；企业认证时只有组织创始人和管理员能配。
  - 最多 20 条，只收公网 IPv4 或 CIDR，不支持 IPv6、内网地址、100.64/10 等；保存时整体覆盖原配置。
  - 对组织下所有 API Key 生效。
- **用量查询 API**：API 端点一览里只有 `/v1/users/me/balance`，返回 `available_balance`、`voucher_balance`、`cash_balance`，**没有**按 Key 或项目的用量接口（一手，https://platform.kimi.com/docs/api/overview.md 、api/balance.md ）。按项目、组织、Key 维度的明细只能在控制台"计费明细 → 请求明细"里看，或者导出月账单 Excel（context-caching.md 的 FAQ 提到账单里有"项目、组织、API Key 等维度"）。每次响应的 `usage` 字段和 `Msh-Usage-Cache-Write-Tokens-5m/1h` 响应头可以用来自己计量。
- **子账户与临时令牌**：文档未见。成员体系只有"企业管理员 / 普通成员""项目管理员 / 项目普通成员"。原文："成员被移除项目后，成员创建的 API Key 也会同时失效。"只有企业认证组织才能邀请成员。
- **限流分级**（一手，https://platform.kimi.com/docs/pricing/limits.md ）

  | Tier | 累计充值 | 并发 | RPM | TPM | TPD | 搜索 QPS |
  |---|---|---|---|---|---|---|
  | Tier0 | ¥0 | 1 | 3 | 500,000 | 1,500,000 | 1 |
  | Tier1 | ¥50 | 15 | 100 | 2,000,000 | 不限 | 3 |
  | Tier2 | ¥100 | 40 | 100 | 3,000,000 | 不限 | 5 |
  | Tier3 | ¥500 | 50 | 200 | 3,000,000 | 不限 | 10 |
  | Tier4 | ¥5,000 | 60 | 200 | 4,000,000 | 不限 | 20 |
  | Tier5 | ¥20,000 | 100 | 300 | 5,000,000 | 不限 | 50 |

  补充说明：
  - 代金券不计入累计充值。
  - 集群满载时平台可能临时调整限速；风控限速"一旦触发即无法解除"。
  - 限速按请求里的 `max_completion_tokens` 预估。
  - 单个请求超时 2 小时。
  - 所有模型共享同一份限速。
- **企业版与专属额度**：只有"联系销售"一个入口（https://platform.kimi.com/contact-sales ），没有公开的档位（一手，guide/account-and-payments.md ）。2026 年 9 月起，账户消耗按现金和代金券各 50% 扣除；"已签署合同的用户以合同约定为准"（一手，changelog/index.md ）。

### A2 上下文缓存

一手，https://platform.kimi.com/docs/guide/context-caching.md

- **是否自动**：自动。Chat Completions 和 Responses 不传 `prompt_cache_options` 时默认按 5m 档写入；`mode` 目前只支持 `implicit`。
- **作用域**：原文是"缓存按组织（org）隔离：同一组织内共享，组织之间不共享"。不能手动清除，超过 TTL 无活动后自动过期。
- **命中条件**：
  - 按请求前缀匹配，前缀任何一处变了，后面的内容都不能复用。
  - 按块存储，不足一整块的部分按未命中计费。
  - 5m 档和 1h 档互不相通；条目的 TTL 在首次写入时锁定。
- **计费**：
  - 写入单独计费：K3 的 5m 档 ¥20/M，1h 档 ¥40/M。
  - 命中 ¥2/M，命中后按原 TTL 免费续期。
  - 官方说法是"总价不变"，即拆分只是让计费更透明。
  - 只有 `kimi-k3` 收写入费；`kimi-k2.7`、高速版和 `kimi-k2.6` 不收写入费，但有命中价。
- **Anthropic 兼容端点** `/anthropic/v1/messages`（一手，api/messages.md ）：
  - `cache_control` 只在顶层生效，格式为 `{"type":"ephemeral","ttl":"5m"|"1h"}`；写在 messages 内的 `cache_control` 会被忽略。
  - 不传时，本次请求只尝试读 5m 档缓存，不写入，也不产生写入费。
  - 用量字段：`cache_read_input_tokens`、`cache_creation_input_tokens`，以及 `cache_creation.ephemeral_5m_input_tokens / ephemeral_1h_input_tokens`。
- **对架构的含义**：如果用 Kimi Code 或 Anthropic SDK 走 Messages 端点，又没在顶层传 `cache_control`，就**永远不会写入缓存**，只能蹭到 OpenAI 端点写入的 5m 缓存。缓存的有效单位是"组织"，所以一所一组织时，缓存只在本所内部复用。

### A3 服务协议、数据与工具

**协议**：一手，https://platform.kimi.com/docs/agreement/modeluse.md ，版本更新日期 2026-08-24，生效日期 2026-08-31。

- **定位**：用于"开发面向组织内部或终端用户的产品及服务的使用场景"。
- **许可**："非排他的、不可转让、不可再许可的普通许可，本服务仅供您内部使用或向最终用户提供服务。"
  - 结论：把 API 能力嵌入自有产品、向企业客户提供服务，**在许可范围内**。
  - 协议没有出现"转售"一词。但许可不可再许可，账号又"不得以任何形式将账号擅自转让、出借、出租或提供给他人使用"，因此**把 Key 或裸 API 转卖给第三方不在标准许可内**，需要另签商务协议（07-20 的 Token 分成协议可能就是这个载体，见 B）。
- **数据使用**：
  - 第 3 条原文："您授予我们一项免费的使用权，以在法律允许的范围内将您输入输出之内容及反馈用于模型服务优化。"
  - 另一处写明输入内容"会在本协议约定范围（包括提供、优化服务等）内被使用"，并提示谨慎输入个人信息或商业秘密。
  - **到 2026-10-01 这一条款仍然有效**。
- **品牌**：未经同意，不得在公开场合把月之暗面写成案例或合作对象。这会影响宣传口径，但中软本身有合作公告，两者需要对齐。

**ZDR**：一手，https://platform.kimi.com/docs/guide/zero-data-retention.md

- 申请方式：面向企业客户按需开放，要联系销售评估。开通后"接口、参数、计费完全不变"。
- 开通后的处理：提示词和响应在返回后清除，不用于训练。
- 不覆盖的范围：原文是"通过直接文件上传方式提交的图像或视频，使用 Kimi Hosted Agents 托管智能体的数据，零数据留存无法保证。安全日志、账单记录等运营数据不属于零留存范围；第三方模型、连接器、插件等不受本协议约束。"
- 内容安全审核对全部流量照常生效。
- 平台不回溯请求内容，需要自己留存日志。
- 口径冲突：ZDR 页写着"Kimi 开放平台默认不使用企业客户数据训练模型"，与服务协议第 3 条的"模型服务优化"授权不一致。**以签署合同为准，建议在合同里明确写出"不训练、不用于优化、ZDR"**。

**文件与 Batch**：一手，https://platform.kimi.com/docs/api/files-upload.md 、guide/use-batch-api.md 、pricing/batch.md

- 单个文件最大 100 MiB，不能为空；按组织总存储量限制，默认 10 GiB；文件解析"限时免费"。
- 2026 年 8 月起：新文件 ID 统一加 `file_` 前缀；图片不再做 OCR，要用 `purpose=image`。
- Batch：上传时 `purpose="batch"`，`completion_window` 示例为 `24h`，超时变成 `expired`；价格是标准价的 60%，只支持 K2.7 Code 和 K2.6，不支持 K3。
- **文件、Batch 输入输出的留存期在文档中没有写**，未核实。只有隐私政策写了"为实现服务目的所必需的时间内"。

**联网与官方工具**：一手，https://platform.kimi.com/docs/pricing/websearch.md 、guide/use-web-search.md 、guide/use-official-tools.md

- `$web_search`（在 chat/completions 的 tools 里触发）：每次 ¥0.03，搜索结果计入下一次请求的 token；**预计 2026-10-20 下线**。
- 新的 REST 接口：
  - `/v1/tools/search` ¥0.01/次，`/v1/tools/search_pro` ¥0.015/次，`/v1/tools/fetch` ¥0.01/次；失败或结果为空不收费。
  - 有独立 QPS，不占 RPM 和 TPM。
  - 支持组织级和项目级的搜索 QPS 限额。
- 官方 Formula 工具（`moonshot/web-search` 等）里，除 web-search 外都是限时免费。
- 对法律场景的提醒：搜索和抓取由云端执行，查询词会出域，需要列入数据出境和出域清单。

**其他**

- 请求签名（一手，https://platform.kimi.com/docs/api/signatures-verify.md ）：在请求头带 `X-Msh-Request-Nonce`，响应会返回时间戳和签名，任何一方都可以调用校验接口。原文说明它用于证明请求"确实到达了 Kimi API 本身，而不是被中间层转发到了其他服务或替换了模型"。服务端不记录 nonce，防重放需要调用方自己做。
- Hosted Agents：2026 年 9 月 Beta 上线，只对国内企业认证用户开放，**不在 ZDR 范围内**。

### A4 价格

一手，https://platform.kimi.com/docs/pricing/chat.md ，单位为 ¥/百万 token。

| 模型 | 缓存写入 5m | 缓存写入 1h | 输入·命中 | 输入·未命中 | 输出 | 上下文 |
|---|---|---|---|---|---|---|
| kimi-k3 | 20.00 | 40.00 | 2.00 | 20.00 | 100.00 | 1,048,576 |
| kimi-k2.7-code | — | — | 1.30 | 6.50 | 27.00 | 262,144 |
| kimi-k2.7-code-highspeed | — | — | 2.60 | 13.00 | 54.00 | 262,144 |
| kimi-k2.6 | — | — | 1.10 | 6.50 | 27.00 | 262,144 |

- K3 不按上下文长度分段计费；新用户的 ¥15 代金券不能用于 K3（一手，account-and-payments.md ）。
- **K2.8**：models.md 的在售列表只有 `kimi-k3`、`kimi-k2.7-code`、`kimi-k2.7-code-highspeed`、`kimi-k2.6`；下载的 26 个文档页中都没有 "k2.8"。**结论：到 2026-10-01，K2.8 没有在开放平台开放 API**（一手，https://platform.kimi.com/docs/models.md ）。
- 已下线：`kimi-k2.5` 和 `moonshot-v1` 全系 2026-08-31 下线，`kimi-k2` 系列 2026-05-25 下线。

---

## B. 中软国际自有 token / MaaS 服务

1. **06-03 自愿公告《面向高專業價值TOKEN運營 中軟國際正式進軍算力業務》**（一手，https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0603/2026060302433_c.pdf ）
   - 三种模式：算力硬件转售、算力租赁、token 销售。
   - 第三种原文："依託allmeta、smart code等AI產品的token調用能力，面向企業及開發者客戶按實際使用量提供大模型推理token銷售，並配套API接入及應用集成等增值服務。"
   - 公告说明这项业务"尚處於佈局及推進階段"。
2. **官网"Token运营"栏目**（一手，https://www.chinasofti.com/pages/products-token ）：
   - 定位：以 Token 为计量单元，提供"从算力基建、异构调度、Token级精细化运营"的方案。
   - 写明建立了"Token级计量计费、成本分摊与动态定价体系，支持订阅制、按需付费、包年包月"。
   - 栏目还包括智算中心（昇腾）、灵析企业智能体平台（基于 openJiuwen）、AI 云服务（华为云）。
   - **页面没有提到 Kimi 模型**；也**没有找到**面向公众的自助 MaaS 控制台、API 文档地址或模型列表。
3. **是否基于 new-api**：没有公开信息，未核实。仓库内 `platform/` 是本项目自建的模型网关 v0，与中软对外的 token 平台无关。
4. **资质**：只看到官网的 ICP 备案号 京ICP备05028939号-3。是否持有经营 MaaS 所需的增值电信业务经营许可证（如 B1/B2 类），**未核实**；工信部查询需要验证码，没有尝试。
5. **07-20 自愿公告《中軟國際與月之暗面簽署Token分成及聯合創新合作協議》**（一手，https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0720/2026072000262_c.pdf ）
   - 定性："登月計劃"之 Token 分成及联合创新合作协议，是公司"面向高專業價值Token運營商轉型的關鍵戰略舉措"。
   - 技术底座：AllMeta + K2.7 Code 及 K3 和后续迭代版本；行业写的是"能源電力、金融等"，**首期优先能源电力**。
   - 分成原文："針對合作落地過程中基於Kimi大模型產生的Token消耗收益及其他合作衍生收入，雙方將按照協議約定比例進行分成。"
   - **公告里没有"分销""转售""代理"等字样，也没有披露比例**。中软能否以自己的名义向律所销售 Kimi token、律所直连的消耗能否计入分成，要看协议正文，公告没有回答。
   - 另外，中软自建行业算力中心"將優先滿足月之暗面的算力需求"。

---

## C. 三家 IM 在"无公网回调地址"下的接入

### C6 钉钉 Stream 模式

来源：钉钉官方开源文档仓库 https://github.com/open-dingtalk/developerpedia （`docs/learn/stream/overview.md`、`faq.md`、`protocol.md`；仓库最后推送 2025-05-16），以及官方 SDK https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs （2026-07-30 推送）。opensource.dingtalk.com 和 open.dingtalk.com 是 SPA，本环境取不到正文。

- **网络要求**（一手）："不需要依赖公网IP或域名"，"只需保证运行环境具备公网访问能力"。出站域名为 `api.dingtalk.com:443` 和 `wss-open-connection.dingtalk.com:443`；钉钉不提供固定 IP 列表。
- **支持的推送**（一手，protocol.md）：
  - 机器人消息 `/v1.0/im/bot/messages/get`：单聊直接收，群聊要 @ 机器人。
  - 卡片互动回调 `/v1.0/card/instances/callback`。
  - 事件订阅 `*`。
  - 系统消息 `ping` 和 `disconnect`：服务端会定时断开连接做负载均衡，客户端要重连。
- **文件消息**（二手、部分核实）：
  - 官方 Python SDK 用 `downloadCode` 调 `POST /v1.0/robot/messageFiles/download` 下载机器人收到的文件和图片，注释链接的官方文档是"下载机器人接收消息的文件内容"。
  - FAQ 说机器人能接收图片、语音、视频等富文本。
  - **单聊和群聊里 `file` 消息类型的覆盖范围，本次没有取到官方消息类型表**，未核实。
- **可靠性**（一手，protocol.md FAQ）：
  - 原文："机器人消息当前是fire-forgot模式，不会因为网络超时而重复推送。"
  - "事件订阅"支持相对可靠的推送，不回 ACK 会超时重推。
  - 有多条连接时，"通过随机策略选取一个Stream通道推送"。
- **卡片回调**：官方 Node SDK README（2026-07）写 CALLBACK 达到并发上限时"不会 ACK，由服务端稍后重投"，**和协议文档"ACK 仅用于诊断"的说法不完全一致**，卡片回调离线时是否重投未核实。
- **连接数上限、是否要求企业认证、费用**：本次没有取到原文，未核实。
- **离线行为**：机器人消息**不保留、不重投**（一手）。卡片点击离线时的行为未核实。

### C7 飞书长连接

全部是一手，来自 open.feishu.cn 的 `.md` 原文。

- **适用范围与限制**（https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode ）：
  - "长连接模式仅支持企业自建应用"，商店应用不支持。
  - 要在 3 秒内处理完且不抛异常，否则超时重推。
  - "每个应用最多建立 50 个连接"。
  - 集群模式，不支持广播，"只有其中随机一个客户端会收到消息"。
  - 只要能访问公网，不需要公网 IP 或域名。
- **事件重推**（https://open.feishu.cn/document/server-docs/event-subscription-guide/overview ）：长连接场景下失败后"以 15秒、5分钟、1小时、6小时 的间隔重新推送事件，最多重试 4 次"，并且是至少一次投递，会出现重复。也就是说，**节点离线约 7.3 小时内恢复，消息事件还能收到；超过就丢失**。
- **卡片回传交互**：
  - 可以选择"使用长连接接收回调"（https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks ）。
  - 回调类型为 `card.action.trigger`，要 3 秒内响应；超时时客户端提示错误（错误码 200341）。
  - 回调里的 token 可在 30 分钟内用于更新卡片，最多更新 2 次（card-callback-communication）。
  - 官方 Node SDK 的 Channel 模块（docs/channel.zh.md，2026-04）默认用 websocket 传输，处理 `cardAction`，要求订阅 `card.action.trigger`，并使用卡片 V2 schema。
  - SDK 的 README.zh 里还留着"长连接仅支持事件订阅，不支持回调订阅"这句旧说法，**以官方文档为准**。
- **收文件**（https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get ）：
  - 接口：`GET /open-apis/im/v1/messages/:message_id/resources/:file_key`。机器人和消息要在同一会话里。
  - `type=file` 时，不用 Range 只能下载 <100 MB；更大的文件用 Range 分片，每片 ≤32 MB。
  - 频率限制 1000 次/分钟、50 次/秒。
  - **外部群不支持**：错误码 234009"暂不支持在外部群中进行本操作"。
- **费用**：长连接本身的收费，以及各版本飞书的 API 调用额度，本次没有核实。

### C8 企业微信

- **智能机器人长连接**（一手，https://developer.work.weixin.qq.com/document/path/101463 ，页面标注"最后更新：2026/05/25"）：
  - 在管理后台给智能机器人开启"API 模式"，选择"长连接"，拿到 BotID 和长连接专用 Secret，然后连 `wss://openws.work.weixin.qq.com`。私有部署的企业要在管理端查看地址。
  - 文档的对比表写着：Webhook 需要"公网可访问的 URL"，WebSocket"无需固定的公网 IP"，也不用加解密。
  - **连接数限制**："每个智能机器人同一时间只能保持一个有效的长连接"，新连接会踢掉旧连接，旧连接会收到 `disconnected_event`。高可用建议用主备切换。
  - 长连接和回调 URL 两种模式**只能二选一**，切换后另一种失效。
  - **消息类型**：文本、图文混排可以在单聊或群聊里 @ 机器人发送；**图片、语音、文件、视频"仅支持单聊"**。长连接模式下，image、file、video 会额外返回 `aeskey`，下载地址"5 分钟内有效"。
  - **事件**：`enter_chat`、`template_card_event`（用户点击模板卡片按钮）、`feedback_event`、`disconnected_event`。可以用 `aibot_respond_update_msg` 更新卡片，用 `aibot_send_msg` 主动推送给用户或群，不需要用户先发消息。
  - 心跳建议每 30 秒一次。订阅请求有频率保护。
- **官方 SDK**（二手，官方组织仓库）：https://github.com/WecomTeam/aibot-node-sdk （npm `@wecom/aibot-node-sdk` 1.0.7，2026-05）。README 写明更新卡片和回复欢迎语都要在收到事件后 5 秒内完成，内置 AES-256-CBC 文件解密和指数退避重连。另有官方 `wecom-openclaw-plugin`，支持 Bot（WebSocket）和 Agent（自建应用 HTTP 回调）两种模式。
- **自建应用回调**：
  - 自建应用（插件里的 Agent 模式）走 XML 加密的 HTTP 回调，需要公网可访问的 URL（二手，wecom-openclaw-plugin README）。
  - 同一份 README 写到服务器 IP 必须在企业微信可信 IP 名单里，否则要配固定出口代理（二手）。
  - "回调域名须为可信域名且与备案主体一致"这一要求，**本次没有取到官方原文**，未核实。
  - 回调配置页（path/90930）只取到了签名机制和"获取企业微信回调 IP 段"的说明。
- **离线行为**：101463 文档没有说明连接断开期间的消息是否保留或重投，**未核实**。按照"单连接 + 被动回复要带 req_id"的设计推断，离线期间的消息大概率无法补收（这是推断，不是事实）。
- **费用与接口许可**：智能机器人长连接是否收费、"接口许可"是否适用于自建智能机器人，**未核实**。接口许可一般针对第三方应用和代开发应用，这一点本次也没有核实。

### C9 一句话结论：律所只有内网电脑、没有公网 IP

| IM | 能否完成"转文件→本机处理→回卡片→合伙人点卡片审批" | 离线时的行为 |
|---|---|---|
| 钉钉 | **能**。Stream 只需要出站 443；机器人能收文件，用 downloadCode 下载；卡片回调走 Stream | 机器人消息**直接丢失**（fire-forget）；事件会重推；卡片点击离线是否重投未核实 |
| 飞书 | **能，但只限企业自建应用**；外部群里拿不到文件 | 消息事件约 7.3 小时内重推 4 次；**卡片点击要 3 秒内响应，离线时用户立即看到报错** |
| 企业微信 | **能，前提是用智能机器人长连接，而且文件必须在单聊里发**。自建应用回调需要公网 URL，不适用 | 文档没写（未核实）；每个机器人只能 1 条连接；卡片更新要在 5 秒内完成 |

**共同的约束**：三家都要求"律所侧有一个常驻在线的单一连接节点"。不要让每台律师电脑各自连接同一个机器人：飞书和钉钉会把 A 律师发的文件随机派到 B 律师的电脑上，企业微信则会互相踢线。这个节点收到消息后，按发送人把任务派发到律师本机或律所服务器的执行队列；处理完再由节点回卡片、接收审批回调。如果硬性要求"只用律师个人电脑、没有常驻节点"，合伙人审批就要接受"律师电脑开着才能点"的限制，飞书还会出现点击报错。

---

## D. Electron 运行时

一手：https://releases.electronjs.org/schedule.json 、https://releases.electronjs.org/releases.json 、https://github.com/electron/electron/blob/main/docs/tutorial/electron-timelines.md

| 主线 | 稳定版发布 | EOL | 10-01 最新版本 | 内置 Node | 内置 Chromium |
|---|---|---|---|---|---|
| 42 | 2026-05-05 | **2026-10-20** | 42.11.10（09-30） | 24.19.0 | 148 |
| 43 | 2026-06-30 | 2027-01-05 | 43.7.7（09-30） | 24.21.0 | 150 |
| 44 | 2026-08-25 | 2027-03-02 | 44.5.1（09-29） | 24.21.0 | 152 |
| 45 | 2026-10-20（计划；beta 10-01） | 2027-04-27 | 45.0.0-alpha.13（09-28） | 24.21.0 | 155–156 |
| 46 | 2027-01-05（计划） | 2027-06-22 | nightly | 24.21.0 | 156+ |

- 支持策略：原文为"The latest three stable major versions are supported"，只支持各主线的最新 minor。
- **Node ≥ 24.15.0**：42 从 beta 起就是 24.15.0，43、44、45 都是 24.21.0，**都满足**。**没有任何一条主线带 Node 26**。
  - 本仓库 `platform/README.md` 写的是"本机需 Node ≥ 26"。如果要把服务放进 Electron 内置 Node（utilityProcess）里运行，就要兼容 Node 24.21，或者另外打包独立的 Node 26 运行时，作为普通子进程启动。
- **utilityProcess 的沙箱与降权**（一手，源码）：
  - `shell/services/node/public/mojom/node_service.mojom` 第 41 行声明了 `[ServiceSandbox=sandbox.mojom.Sandbox.kNoSandbox]`，Node 工具进程**固定不开沙箱**。
  - `utilityProcess.fork` 的选项只有 `env`、`execArgv`、`cwd`、`session`、`partition`、`stdio`、`serviceName`、仅限 macOS 的 `allowLoadingUnsignedLibraries` 和 `disclaim`，以及 `respondToAuthRequestsFromMainProcess`，**没有 sandbox 或降权选项**（docs/api/utility-process.md，最后提交 2026-09-17）。
  - 结论：**在 Windows 上没法通过 Electron API 给 utilityProcess 开沙箱或降权**，它和主进程用同一个用户令牌。
  - 如果需要隔离，只能在 Electron 之外自己做。这里只是方向，没有验证：用 `child_process` 启动独立运行时，再配合 Windows Job Object、受限令牌或 AppContainer，或者用低权限服务账户运行。

---

## 未核实清单（建议下一步向厂商书面确认）

1. Kimi：文件、Batch 输入输出的留存期；企业专属额度的档位和价格；Key 级限额或临时令牌是否在路线图上；按 Key 或项目查询用量的 API；"模型服务优化"条款能否在企业合同中排除。
2. 中软：对外 token 平台的名称、网址、技术栈（是否基于 new-api）；增值电信许可；07-20 协议正文里能否以中软名义向第三方销售 Kimi token，以及法律行业是否纳入分成范围。
3. 钉钉：单个应用的 Stream 连接数上限；是否要求企业认证、是否收费；卡片回调离线时是否重投；机器人在单聊和群聊中支持的 `file` 消息类型。
4. 飞书：各版本的 API 调用额度和费用。
5. 企业微信：自建应用回调的可信域名和备案主体一致性要求（官方原文）；智能机器人长连接离线时的消息行为；费用和接口许可。
