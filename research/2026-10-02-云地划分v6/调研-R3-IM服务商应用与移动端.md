# 调研 R3：IM 服务商应用与移动端签发/投递技术约束

> 调研日期：2026-10-02　调研员：Claude（R3）
> 范围：企业微信 / 钉钉 / 飞书的服务商应用（第三方、代开发、商店应用）与企业自建应用 / 智能机器人在法律 Agent 中的接入方式；手机端签发与材料投递约束。
> 标注规则：【一手】= 平台官方文档/官方公告；【二手】= 社区、媒体、第三方博客；【推断】= 由一手/二手推出但无直接原文；「未查到」= 本轮检索未获得依据。

## 一、企业微信

### Q1 四类接入形态的区别、能否单聊收文件、下载凭据

| 形态 | 谁创建/安装 | 收消息通道 | 能否收成员发来的「文件」 | 下载方式与凭据 |
|---|---|---|---|---|
| 企业自建应用 | 律所管理员在后台建 | HTTP 回调（XML，EncodingAESKey 加密） | **否**。应用「接收消息」官方支持类型只有文本、图片、语音、视频、位置、链接，无文件类型 | 图片/语音/视频给 MediaId，用 `cgi-bin/media/get?access_token=企业access_token&media_id=` 下载；media_id 有效 3 天，超 20M 需 Range 分块 |
| 第三方应用（服务商通用应用） | 服务商开发，律所管理员授权安装 | 数据回调 URL（与自建应用同格式） | **否**（消息格式文档与自建应用完全一致，无 file 类型） | 服务商用 `suite_access_token + permanent_code` 调 `service/get_corp_token` 换「授权企业 access_token」，expires_in=7200 秒；该 token 与企业自建 token「本质上是一样的」，可调该企业已授权的全部接口 |
| 代开发应用（自建应用代开发） | 服务商用模板为单个企业代开发，企业授权 | 代开发应用回调 URL | **否**（「用户在应用里发送的消息……与自建应用类似」） | 用代开发应用 secret 取 access_token，权限=基础权限+企业确认的自定义权限（含「素材管理：上传与下载」） |
| 智能机器人（API 模式） | 企业内成员/管理员在「安全与管理 > 管理工具 > 智能机器人」创建 | 二选一：①URL 回调；②**长连接** `wss://openws.work.weixin.qq.com`（BotID+Secret 订阅） | **能，但仅单聊**；群聊只收文本/图文混排/引用。URL 回调模式文件 ≤100M | 消息里直接给**腾讯云 COS 预签名下载 URL（5 分钟有效）**；长连接模式额外给**每个 URL 唯一的 aeskey**（AES-256-CBC，IV=aeskey 前 16 字节）；URL 回调模式则用机器人统一的 EncodingAESKey 加密 |

要点与出处：
- 智能机器人长连接：每个机器人同一时间只能保持 1 条有效长连接，新连接踢旧连接；建议 30 秒心跳；文件/图片/视频/语音「仅支持单聊」；文件结构体 `{url, aeskey}`，「url 资源下载地址，5 分钟内有效」「每个下载链接的 aeskey 唯一」；支持 `aibot_send_msg` 主动推送；回复与主动推送合计「每会话 30 条/分钟、1000 条/小时」，收到消息后 24 小时内可回复；长连接还支持分片上传临时素材（单片 ≤512KB、最多 100 片≈50MB、素材 3 天有效、30 次/分钟）。【一手】https://developer.work.weixin.qq.com/document/path/101463 （2026-10-02 抓取）
- 智能机器人 URL 回调「接收消息」：「用户单聊中向智能机器人发送本地文件消息」触发回调；文件 url「五分钟内有效。注意获取到的文件是已加密的……加密 AESKey 与回调加解密的 AESKey 相同」；「智能机器人目前仅支持 100M 大小以内的文件回调」；示例 URL 为 `ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/...?sign=q-sign-time=...`（签名窗口 300 秒）。【一手】https://developer.work.weixin.qq.com/document/path/100719 （抓取 2026-10-02）
- `from.userid`：创建者为超级管理员时是明文 userid，否则为企业主体下加密 userid，需用**自建应用** access_token 调 `batch/openuserid_to_userid` 转明文。【一手】https://developer.work.weixin.qq.com/document/path/101521 （最后更新 2026-05-20）
- 应用「接收消息」消息类型：文本、图片、语音、视频、位置、链接（无文件）。【一手】自建 https://developer.work.weixin.qq.com/document/path/90239 ；第三方 https://developer.work.weixin.qq.com/document/path/90375 （两页均标「最后更新 2019/10/23」）
- 获取临时素材：media_id「在同一企业内所有应用之间可以共享」「有效期只有 3 天」，>20M 用 Range 分块。【一手】https://developer.work.weixin.qq.com/document/path/90390 （最后更新 2026-01-09）
- 第三方应用换企业 token：`service/get_corp_token`，返回 `expires_in: 7200`；「与企业获取 access_token 拿到的 token，本质上是一样的」。【一手】https://developer.work.weixin.qq.com/document/path/90605
- 代开发差异：代开发 oauth2 与自建一致、不可用第三方身份验证接口；用户在应用里发送的消息回调到代开发应用回调 URL。【一手】https://developer.work.weixin.qq.com/document/path/97165 （最后更新 2025-02-06）；权限明细含「消息推送：发送与接收消息」「素材管理：上传与下载」。【一手】https://developer.work.weixin.qq.com/document/path/98980

### Q2 服务商能否给客户端「短期、只读、单文件」凭据

- **企业 access_token 不能降权**：无论第三方还是代开发，拿到的是企业级 access_token（2 小时），可调用该应用被授权的全部接口，**不存在「只读某一个文件」的子凭据**；未查到官方提供 scoped/单文件下载 token 的接口。【一手推断，依据 90605、90390】
- **最小可行方式只有智能机器人长连接**：回调里的 `file.url` 是 COS 预签名 URL（5 分钟、仅能 GET 该对象），配套 `aeskey` 每个 URL 唯一。把「url + aeskey」二元组转发给律师电脑，客户端即可直连 COS 下载并本地 AES-256-CBC 解密，云端不落盘文件内容。该二元组只授权这一个文件，泄露面最小。【一手 101463 + 推断】
- 但注意：①长连接方式的 BotID+Secret 是**企业内机器人**凭据，持有它的进程就能收该机器人全部消息——若长连接跑在中软云端，则中软云端**能看到 url+aeskey，技术上可以下载**，「不经手」只能靠「不下载」的承诺与审计，而非密码学隔离；②URL 回调模式的文件用机器人统一 EncodingAESKey 加密，转发给客户端等于交出全局解密密钥，不可取。【推断】
- 应用（自建/第三方/代开发）路线：成员根本无法把文件以消息形式发给应用（见 Q1），只能走 H5 上传或微盘等其他通道——**未查到**可直接复用的「客户端短期下载凭据」。

### Q3 智能机器人长连接是否支持第三方/代开发
- 长连接文档挂在「企业自建应用开发 > 服务端API > 消息接收与发送 > 智能机器人」目录下；第三方应用开发目录（如 90600 所在目录）与代开发目录（97163 所在目录）的导航中**均无「智能机器人」「长连接」条目**。【一手，目录比对 2026-10-02】
- 凭据是企业后台创建机器人时生成的 BotID + Secret，「API 模式只能选择一种方式（长连接或设置接收消息回调地址）」。【一手】101463
- 结论：**未查到**服务商可代企业创建/持有智能机器人的官方机制；长连接**实际上只能是企业内创建的机器人**（律所自己建，然后把 BotID/Secret 交给执行方）。是否存在「服务商智能机器人」灰度能力：未查到。【推断】

### Q4 接口许可收费
- 自 2022-05-16 起，第三方应用与代开发应用需购买「接口调用许可」，取代按收款比例的技术服务费；授权安装后 90 天免费试用（删了重装试用期不变）；一个成员无论装该服务商多少应用只需一个许可；账号年按 372 天算。【一手】https://developer.work.weixin.qq.com/document/path/95652 （最后更新 2023-08-04）
- 价格（元/账号/年，按企业维度累进阶梯）：1–5 个：基础 5 / 互通 50；6–200：4 / 40；201–500：3 / 30；501–1000：2 / 20；1001–10000：1 / 10；>10000 面议。【一手】https://open.work.weixin.qq.com/wwopen/common/readDocument/38829 （发布于 2022-05-09；WebFetch 2026-10-02 读取）
- 基础账号失效影响：身份验证（OAuth）提示联系服务商、发送应用消息时该成员进入 `unlicenseduser` 收不到。互通账号只在需要「微信客户联系」时才要。【一手】95652
- **律所 20 人年费估算**：只需基础账号：5×5 + 15×4 = **85 元/年**（若全部买互通账号为 5×50+15×40=850 元/年）。【按一手价格表推算】
- 企业自建应用、企业内智能机器人：不需要接口许可（许可面向服务商应用）。【一手推断，依据 95652 FAQ「代开发应用与第三方应用都需要接入」】

### Q5 模板卡片回调、消息推送频率、H5 身份
- 发送应用消息频率：每应用每天 ≤ 账号上限数×200 人次；每应用对同一成员 ≤30 次/分钟、1000 次/小时，超出丢弃不下发；建议避开整点/半点。【一手】https://developer.work.weixin.qq.com/document/path/90236 （最后更新 2025-09-24）、https://developer.work.weixin.qq.com/document/path/90312
- 模板卡片：按钮交互型/投票型/多选型等返回 `response_code`，用户点击回调也带 `response_code`，「72 小时内有效，且只能使用一次」用于 `update_template_card`。【一手】https://developer.work.weixin.qq.com/document/path/94888 （最后更新 2025-07-24）
- 智能机器人模板卡片：长连接下按钮点击走 `aibot_event_callback`，用 `aibot_respond_update_msg` 更新卡片；会话级限频 30 条/分、1000 条/小时。【一手】101463
- H5 身份：OAuth2 链接 `open.weixin.qq.com/connect/oauth2/authorize?appid=CORPID&...&scope=snsapi_base&agentid=...`，跳转回 `redirect_uri?code=`，用 code 换 userid；第三方/代开发填 agentid 或在工作台/应用会话内发起时会**触发接口许可自动激活**。【一手】https://developer.work.weixin.qq.com/document/path/91022 （最后更新 2024-07-30）

### Q6 企业微信内置浏览器的 WebCrypto / IndexedDB 非导出密钥

- 内核：微信官方文档写明小程序视图层 Android 用「微信 XWeb（基于 Mobile Chromium 内核）」、iOS/iPadOS/macOS 用 WKWebView。【一手】https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/env.html （2026-10-02 抓取）。企业微信内置浏览器同样为 Android XWeb/系统 WebView、iOS WKWebView【二手/推断：社区帖中企业微信 4.1.26 Android UA 含 `; wv) AppleWebKit/537.36`，来源 developers.weixin.qq.com 社区帖 000a4ccdcfc14858ff919dbbb6b400，经 so.com 摘要】。**XWeb 当前对应的 Chromium 主版本号：未查到一手**。
- MDN 兼容数据（@mdn/browser-compat-data 8.1.4，2026-10-01 构建）【一手数据源/对 IM WebView 属推断】：
  - `crypto.subtle` 需安全上下文（HTTPS）：Chrome 60+ / Safari 15+ 强制。
  - ECDSA P-256 签名、ECDH 派生、AES-GCM：`sign/verify/encrypt/decrypt` Chrome 37+、`deriveBits/deriveKey` Chrome 41+；Safari 7/11+。→ **任何仍在维护的 XWeb/系统 WebView 与 iOS WKWebView 都可用**【推断】。
  - **Ed25519**（generateKey/sign/verify/import/export）：Chrome & Android WebView **137+**，Safari & iOS **17+**，Firefox 129+。
  - **X25519**（generateKey/deriveBits/deriveKey）：Chrome & Android WebView **133+**，Safari & iOS **17+**，Firefox 130+。
  - CryptoKey 对象：Chrome/WebView 37+、iOS Safari 9+；`extractable:false` 的 CryptoKey 可结构化克隆存入 IndexedDB（Chromium/WebKit 早已支持；BCD 未单列「存 IndexedDB」子特性，此条为推断）。
  - 来源：https://cdn.jsdelivr.net/npm/@mdn/browser-compat-data/data.json （api.SubtleCrypto.*.ed25519 / x25519、api.CryptoKey）
- 设计含义【推断】：
  1. 手机端签名/密钥协商应以 **ECDSA P-256 + ECDH P-256 + AES-GCM** 为基线，Ed25519/X25519 只能作为「检测到才用」的可选项（XWeb 若低于 Chromium 133/137 或 iOS < 17 即不可用），否则需 noble-curves 等纯 JS 兜底（纯 JS 私钥无法做到「不可导出」）。
  2. IM 内 WebView 的 IndexedDB 可能随「清除缓存」、换机、iOS WKWebView 存储回收而丢失；**非导出密钥只能当「本设备会话密钥」，不能当长期身份密钥**，需配套重新绑定流程。
  3. 实测清单（建议上线前做）：企业微信 Android/iOS 内打开测试页，`navigator.userAgent` + `crypto.subtle.generateKey({name:'Ed25519'})` 探测，并验证 IndexedDB 中 CryptoKey 在杀进程/清缓存后的存活。

## 二、钉钉

### Q7 第三方企业应用 vs 企业内部应用：机器人收文件、Stream、downloadCode、互动卡片

- **两类应用都能挂「应用机器人」**：开发者后台「企业内部应用 > 钉钉应用」或「第三方企业应用 > 企业应用」创建应用后，在「机器人与消息推送」开启机器人配置；官方建议不要用历史遗留的「机器人」类型。【一手（钉钉官方开发者百科 GitHub 源码）】https://github.com/open-dingtalk/developerpedia/blob/main/docs/learn/bot/appbot/overview.md （2026-10-02 拉取）
- **单聊收文件：可以**。「人与机器人单聊」支持接收语音、文件、视频；群里 @ 机器人、人与人单聊中**不支持**语音/文件/视频。文件消息体 `msgtype:"file"`，content 含 `fileName / downloadCode / spaceId / fileId`。【一手】https://help.dingtalk.io/open/development/download-the-file-content-of-the-robot-receiving-message.md （钉钉国际站官方文档，2026-10-02）；消息体示例见 https://github.com/open-dingtalk/developerpedia/blob/main/docs/learn/bot/message.md
- **下载接口**：`POST /v1.0/robot/messageFiles/download`（国内 api.dingtalk.com，国际 api.dingtalk.io），Header `x-acs-dingtalk-access-token`，Body `{downloadCode, robotCode}`，返回 `downloadUrl`（示例为带 `Signature=…&Expires=…` 的对象存储签名 URL）。「支持的应用类型：企业内部应用、第三方企业应用」；权限点 `qyapi_robot_sendmsg`；token：内部应用用应用 accessToken，第三方企业应用用「第三方应用授权企业的 accessToken」。错误码含「downloadCode 错误或已过期」「调用组织与机器人所属组织不一致」。【一手】同上 help.dingtalk.io 页面；国内原页 https://open.dingtalk.com/document/orgapp/download-the-file-content-of-the-robot-receiving-message （JS 渲染，未能直接抓取正文）
  - **downloadCode 有效期、downloadUrl 有效期：官方页未写明，未查到具体数值**（只能看到 URL 自带 `Expires` 参数）。
  - 下载的文件是**明文**（无需额外解密密钥）——与企业微信长连接的「url+aeskey」不同。【一手推断：文档只要求下载后改扩展名】
- **Stream 模式支持第三方企业应用：是**。Stream 协议「建立连接」接口的 `clientId`：「三方应用：旧称 SuiteKey；企业自建：旧称 Appkey」，`clientSecret` 同理；官方 Python SDK 参数说明为「app_key or suite_key」。连接 ticket 90 秒有效且只能建一条连接；可开多条 Stream 通道，服务端随机选一条推送（支持多进程负载均衡）；服务端会定时断开以做负载均衡；需外联 `api.dingtalk.com`、`wss-open-connection.dingtalk.com:443`。【一手】https://github.com/open-dingtalk/developerpedia/blob/main/docs/learn/stream/protocol.md 、https://github.com/open-dingtalk/dingtalk-stream-sdk-python （README）、https://open-dingtalk.github.io/developerpedia/docs/learn/stream/faq/
  - 注意：网络上有二手说法称「第三方企业应用不支持 Stream」（WebSearch 汇总，来源不明），与上述官方协议文档矛盾，**以官方协议文档为准，建议上线前用 SuiteKey 实测**。
- **Stream 已支持的回调**：机器人收消息、事件订阅、**互动卡片回调**（用户点击卡片的交互通过 Stream 推送）；打字机效果可用「互动卡片（普通版）更新接口」实现。【一手】https://open-dingtalk.github.io/developerpedia/docs/learn/stream/overview/ 、.../stream/faq/
- **对「中软云端不经手」的含义**【推断】：第三方企业应用 + Stream 可以由**中软一条（或多条）长连接服务所有授权律所**，律所无需公网/服务器；文件下载需「授权企业 accessToken + downloadCode + robotCode」，云端可调接口换出 `downloadUrl` 后只把签名 URL 交给律师电脑直下，云端不读取内容；但同样是「承诺不下载」而非密码学隔离（云端持有企业 token，随时可下）。若要更强隔离，可把 downloadCode 交给律师电脑，由电脑用短期企业 token 调用——但企业 accessToken 是全量权限（2 小时），下发到终端风险更大，不推荐。

### Q8 钉钉服务商应用收费/上架
- 第三方企业应用需以服务商身份在开发者后台创建，企业管理员授权安装；可上架钉钉应用市场。【二手】WebSearch 汇总（developer.aliyun.com 问答 585182 等）
- **钉钉是否对第三方企业应用收取类似企业微信「接口许可」的按人头费用：未查到**；应用市场交易佣金比例：**未查到一手**（媒体称钉钉对 ISV 交易抽佣，比例不明）。【二手】https://www.36kr.com/p/1775742102751881 （所述主要为企业微信），https://m.163.com/dy/article/H8L3HSCP0552CUFR.html
- suiteAccessToken 仅第三方企业应用可获取，需订阅推送的 suiteTicket（约 10 分钟推一次）。【二手】https://developer.aliyun.com/ask/530950

## 三、飞书

### Q9 商店应用能否收 im.message.receive_v1、下载消息资源；长连接是否仅自建

- **接收消息事件 `im.message.receive_v1`：支持的应用类型 = Custom App（企业自建）、Store App（商店应用）**。单聊需 `im:message.p2p_msg` 或 `im:message.p2p_msg:readonly`；群 @ 需 `im:message.group_at_msg(:readonly)`；群全量需 `im:message.group_msg`。可能重复推送，用 message_id 去重。【一手】https://open.feishu.cn/document/server-docs/im-v1/message/events/receive.md （2026-10-02 抓取）
- **下载消息资源 `GET /open-apis/im/v1/messages/:message_id/resources/:file_key`**：支持 Custom App、Store App；Authorization 可用 **`tenant_access_token` 或 `user_access_token`**；权限任一：`im:message` / `im:message:readonly` / `im:message.history:readonly`；限频 1000 次/分、50 次/秒；file 类型不分片仅支持 <100MB，≥100MB 需 Range 分片（单片 ≤32MB）；前提「机器人和待操作的消息需要在同一会话内」。返回二进制流（明文）。【一手】https://open.feishu.cn/document/server-docs/im-v1/message/get-2.md
- **商店应用 tenant_access_token**：`POST /open-apis/auth/v3/tenant_access_token`，入参 `app_access_token + tenant_key`，「最大有效期是 2 小时」，剩余 <30 分钟时再取会得到新 token（新旧并存）。【一手】https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token.md
- **user_access_token**：授权码 5 分钟一次性；`expires_in` 示例 7200 秒、`refresh_token_expires_in` 示例 604800 秒（需 `offline_access`），均「非固定值」；**支持在换 token 时用 `scope` 参数缩减权限范围**。【一手】https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token.md
- **长连接：仅企业自建应用（复核确认）**。原文：「长连接模式仅支持企业自建应用。商店应用事件订阅方式参考将事件发送至开发者服务器」「目前长连接模式不支持商店应用」；每应用最多 50 个连接；推送为集群模式，多客户端时只有随机一个收到。【一手】https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case.md
- **结论**：商店应用的事件**只能走 HTTP 回调**（中软云端需公网回调地址）；但文件下载可以**不用 tenant token**——律师电脑用本人 OAuth 得到的 `user_access_token`（可用 scope 缩到 `im:message:readonly`），直接对自己与机器人的单聊消息调资源下载接口。这是三家里唯一「官方支持、凭据天然按用户收窄」的客户端直下方案。中软云端只需转发 `message_id + file_key`（不含内容）。【一手 + 推断；user token 能否下载「用户与机器人单聊」中的文件，需实测确认】

### Q10 「代客户一键创建企业自建应用」是否有官方能力

- **飞书：有，但未见公开文档**。飞书官方 npm 包 `@larksuite/openclaw-lark-tools`（1.0.47，`@larksuite/openclaw-lark` 2026.7.16 的安装器）源码显示：向 `https://accounts.feishu.cn/oauth/v1/app/registration` 依次 POST `action=init`（返回 `supported_auth_methods`）→ `action=begin, archetype=PersonalAgent, auth_method=client_secret, request_user_info=open_id`（返回 `verification_uri_complete`、`device_code`、`interval`、`expire_in` 默认 600 秒）→ 终端打印二维码「请使用飞书扫码，配置机器人」→ 轮询 `action=poll` 直到返回 `client_id / client_secret / user_info.open_id / tenant_brand`；随后用 `tenant_access_token/internal` 校验，说明产物是**企业自建类应用（archetype=PersonalAgent）**。【一手代码，飞书官方 npm 包；2026-10-02 下载审阅】https://www.npmjs.com/package/@larksuite/openclaw-lark-tools
  - 飞书官网文章也称「通过飞书客户端扫描二维码，选择一键创建飞书机器人」（2026-03-05）。【一手（营销文）】https://www.feishu.cn/content/article/7613711414611463386
  - **未查到**：该 registration 接口在 open.feishu.cn 的公开文档、是否允许第三方（非飞书官方）调用、`archetype` 可选值、是否需租户管理员审批、预置了哪些权限与事件。这是 OAuth Device Flow 风格接口，第三方直接调用存在「未公开接口」风险。【推断】
- 钉钉/千问办公一键创建：见下文 Q12 汇总（本轮检索未查到钉钉官方公开的「代客户一键创建企业内部应用」API）。

### Q10（续）钉钉与千问办公的「扫码一键创建」

- **钉钉：同样存在 Device Flow 式「一键创建新机器人」，未见公开文档**。钉钉官方 OpenClaw 插件 `@dingtalk-real-ai/dingtalk-connector`（npm 0.8.26，描述「钉钉官方 OpenClaw 插件」）README：「安装过程中终端会显示钉钉授权二维码，使用钉钉手机 App 扫码，点击『一键创建新机器人』即可完成授权」。源码：`POST https://oapi.dingtalk.com/app/registration/init {source:"DING_DWS_CLAW"}` → 返回 nonce → `/app/registration/begin {nonce}` → 返回 `device_code / verification_uri_complete / user_code / interval` → 轮询 `/app/registration/poll {device_code}`，`status=SUCCESS` 时返回 `client_id / client_secret`。【一手代码，钉钉官方 npm 包；2026-10-02 下载审阅】https://www.npmjs.com/package/@dingtalk-real-ai/dingtalk-connector
  - `source` 参数（默认 `DING_DWS_CLAW`）提示该接口按来源白名单放行，**第三方（中软）能否申请自己的 source：未查到**。产物应为企业内部应用（client_id/secret 即 AppKey/AppSecret），可直接走 Stream。【推断】
- **千问办公**：文档称钉钉/飞书「扫码自动创建应用」「系统会自动在你的组织下创建应用，并配置好所需的权限和事件回调」，企业微信则「快捷绑定或手动填 Bot ID/Secret」。【一手，转引 R1】https://docs.qwenwork.cn （见本目录《调研-R1-国内办公Agent云地划分.md》§2.1-C）
- **企业微信**：WorkBuddy 支持企微扫码「一键创建企业微信智能机器人」，普通成员可在客户端创建；长连接只需 Bot ID + Secret。【一手，转引 R1 §1】企业微信侧对应公开 API：**未查到**。
- **小结**：飞书、钉钉都已有「扫码→在用户所在组织创建自建应用→回传 client_id/secret」的官方 Device Flow，但目前只在各自官方 OpenClaw 插件中使用、未公开文档、带 source/archetype 参数；中软要用需走平台商务合作申请接入，否则只能引导律所管理员手工创建（或按「权限 JSON 批量导入」降低难度）。【推断】

## 四、移动端与个人微信

### Q11 微信小程序：wx.chooseMessageFile、加密能力、法律类目、备案

- `wx.chooseMessageFile`：「从客户端会话选择文件」；`count` 必填「最多可以选择的文件个数，可以 0～100」；`type` all/video/image/file；`extension` 过滤（2.6.0+）；返回 `tempFiles[{path,size,name,type}]`；基础库 2.5.0+，Windows/Mac/鸿蒙版支持，插件不支持。**单文件大小上限：官方文档未写明（未查到）**。【一手】https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.chooseMessageFile.html （2026-10-02）
- 加密能力：官方「加密」分类只有 `wx.getUserCryptoManager`（基础库 2.17.3+，含 `getLatestUserKey`、`getRandomValues`，用于「小程序加密网络通道」）与 `wx.getRandomValues`。**未查到小程序逻辑层提供 WebCrypto `crypto.subtle`（ECDSA/ECDH/AES-GCM）的官方说明**。【一手】https://developers.weixin.qq.com/miniprogram/dev/api/base/crypto/wx.getUserCryptoManager.html
  - 纯 JS 库可行性【推断】：逻辑层 iOS 跑 JavaScriptCore、Android 跑 V8；官方写明「JavaScriptCore 无法开启 JIT 编译……运行性能低于其他平台」（https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/env.html ）→ 用 noble-curves/noble-ciphers 做 P-256/X25519 签名与协商、AES-GCM 解密几 MB 预览文件可行但 iOS 较慢；私钥只能存 `wx.setStorage`（明文本地存储），**做不到「不可导出密钥」**。替代：小程序 `web-view` 内嵌 H5 使用浏览器 WebCrypto（需业务域名、非个人主体）。
- **法律类目资质**（非个人主体·商业服务）：
  - 「律所服务」：2 选 1 ——《律师事务所执业许可证书》或「经司法厅批准成立法律服务机构的文件」；适用「律师事务所机构提供在线法律咨询、代理参加诉讼等服务」。
  - 「法律服务平台」：2 选 1 ——《营业执照》经营范围含「法律咨询」，或《仲裁委员会登记证》；适用「提供专业法律咨询、法律调解仲裁等服务」。
  - 【一手】https://developers.weixin.qq.com/miniprogram/product/material/ （「小程序开放的服务类目」，2026-10-02 抓取，页面声明「以提交时所要求的材料为准」）
  - 含义【推断】：若小程序由**律所主体**注册（每家律所一个），用「律所服务」类目、交执业许可证；若由**中软主体**统一提供，需营业执照含「法律咨询」，否则只能选办公/工具类目、不得面向公众提供法律咨询。仅供律所内部「签发/投递」的工具定位，类目选择需与审核沟通。
- 小程序备案：本轮**未抓取一手原文**。（背景：工信部 2023 年起要求 App/小程序备案，未在本轮核验，勿直接引用。）

### Q12 主流桌面 Agent「手机遥控电脑」的实现（转引 R1，已核来源）

| 产品 | 通道 | 端到端加密 | 来源 |
|---|---|---|---|
| Kimi Work 3.2.5 / 3.2.14 手机远程控制 | 发布日志：3.2.5「新增远程控制功能：可通过手机远程控制桌面端 Kimi Work」；3.2.14「支持在手机端直接预览 Office、html 等文件类型」「支持在手机端向 Kimi Work 上传附件」。链路是经 Kimi 云中转还是直连、鉴权方式：**未查到**官方说明 | 未查到 | R1 §3（Kimi Work 更新日志，一手） |
| WorkBuddy 手机 App「连接电脑」 | 「连接电脑：直连本地设备，调用桌面端完整能力」；桌面端须登录在线；更新日志「提升移动端连接电脑的稳定性……休眠唤醒和网络切换后的同步与重连」。实为**腾讯账号体系下的厂商云同步/中继**（官方未写明拓扑，推断） | 未查到；官方口径为「HTTPS 全链路加密，TLS 1.2/1.3」 | R1 §1；https://cloud.tencent.com/document/product/1831/134324 |
| WorkBuddy「助理（远程任务）」 | **IM 通道**：「通过手机上的即时通讯软件（微信、企业微信、QQ、钉钉、飞书）远程控制电脑上的 WorkBuddy」；「通过主流 IM 内置的 WebSocket 通道通信……不需要在企业防火墙上开放额外端口」；企微走智能机器人长连接（Bot ID+Secret） | 未查到（IM 平台可见明文） | R1 §1 |
| 千问办公 IM 频道 | **IM 通道**（桌面端功能）：钉钉/飞书扫码自动建应用、企微 Bot ID/Secret；开放/配对两种准入；企业后台可逐渠道关闭 | 未查到；口径为 TLS + 静态加密 | R1 §2；https://docs.qwenwork.cn/enterprise-ultimate/security/im-channels.md |

- 共同点：**没有一家公开宣称手机↔电脑端到端加密**；IM 通道模式下消息与文件对 IM 平台可见。【一手口径汇总 + 推断】

## 对法律发行版 IM 与移动端设计的结论

### 0. 总判断
「中软当服务商、律所一键安装、云端只收发通知卡片、文件由律师电脑用短期凭据直下」**在钉钉、飞书基本走得通，在企业微信走不通（文件收取这一段）**。三家另有一个共同硬约束：**长连接/Stream 的推送是「每机器人一条」或「集群随机投递」**，多台律师电脑共用一个应用时消息不会按人路由——必须要么每位律师一个机器人/应用，要么有一个中继（中软云或律所执行器）按 userid 分发。

### 1. 三家推荐接入模式

| 平台 | 推荐模式 | 文件能否「中软云端不经手」 | 约束 | 成本 |
|---|---|---|---|---|
| **企业微信** | **双轨**：①中软「代开发/第三方应用」只做通知、模板卡片、H5 签发页（OAuth 取身份）；②文件收取用**每位律师自建的智能机器人（API 模式·长连接）**，Bot ID+Secret 交给本人电脑上的执行器，长连接直接跑在律师电脑上 | **能，且是三家里唯一的密码学级别**：长连接回调直接到律师电脑，拿到 COS 5 分钟签名 URL + 每 URL 唯一 aeskey，本地下载解密，中软云不在链路里 | 服务商应用（第三方/代开发/自建应用）**收不到成员发的文件消息**（消息类型无 file）；智能机器人只有企业内创建、无服务商模式；文件只支持**单聊**、≤100MB；每机器人仅 1 条长连接；电脑须在线；`from.userid` 非超管创建时为密文 | 接口许可：20 人只需基础账号约 **85 元/年**（1–5 人 5 元、6–200 人 4 元/人/年），首次安装 90 天免费；智能机器人不收许可费 |
| **钉钉** | **中软第三方企业应用 + 应用机器人 + Stream**（clientId=SuiteKey，官方协议支持），一条/多条 Stream 服务全部律所；云端把 downloadCode 换成 downloadUrl 后只转发签名 URL 给律师电脑直下 | **流程上能、密码学上不能**：云端持授权企业 accessToken，随时可以下载；只能靠「不下载」的策略 + 审计证明。文件为明文签名 URL，URL/downloadCode 有效期官方未写明 | 文件只支持人与机器人**单聊**；Stream 多通道随机投递，云端需按 userid 路由给对应律师电脑；建议上线前用 SuiteKey 实测 Stream（网上有相反的二手说法） | ISV 费用/应用市场抽佣：**未查到** |
| **飞书** | **中软商店应用**：事件只能 HTTP 回调到中软云（云端只看到 message_id、file_key、文件名等元数据）；**律师电脑用本人 user_access_token（scope 缩到 `im:message:readonly`）直接调资源下载接口** | **能（凭据层面最干净）**：云端不需要用 tenant token 碰文件；客户端凭据按用户、按 scope 收窄，2 小时有效 | 商店应用**不支持长连接**（复核确认）；user token 下载「用户↔机器人单聊」文件需实测；>100MB 要分片；自建应用长连接每应用 ≤50 连接且集群随机投递 | 商店应用上架/费用：本轮未查 |
| 备选（三家通用） | **一键创建的自建应用 + 律所执行器**：飞书 `accounts.feishu.cn/oauth/v1/app/registration`、钉钉 `oapi.dingtalk.com/app/registration/*` 都是 Device Flow 扫码建应用并回传 client_id/secret | 能（长连接在律所侧） | 两接口**未公开文档**，仅见于两家官方 OpenClaw 插件，带 `source`/`archetype` 白名单参数，第三方使用需商务申请 | — |

### 2. 手机签发预览能否在 IM 内 H5 端到端解密
- **能，但限定算法**：企业微信/钉钉/飞书内置浏览器为 Android Chromium 系（微信 XWeb 基于 Mobile Chromium）与 iOS WKWebView；ECDSA P-256、ECDH P-256、AES-GCM 在 Chrome 37/41+、Safari 7/11+ 即支持（需 HTTPS）→ **以 P-256 + AES-GCM 为基线可行**。Ed25519 需 Chromium 137+/iOS 17+、X25519 需 Chromium 133+/iOS 17+，XWeb 实际 Chromium 版本未查到 → 只能检测后可选使用。
- **约束**：①IM WebView 的 IndexedDB 可能被清缓存/换机清空，非导出私钥只能做「设备会话密钥」，要有扫码重新绑定流程；②H5 页面的 JS 由中软服务器下发，端到端只防「服务器存储/传输被窥探」，不防「服务器下发恶意 JS」——需代码签名/版本固定说明；③企业微信 H5 走第三方/代开发应用 OAuth 时，每个使用成员必须有基础账号许可（否则提示联系服务商）。
- **小程序不适合承载端到端**：无 `crypto.subtle`，纯 JS 私钥只能明文存本地，iOS JavaScriptCore 无 JIT 性能差；且「律所服务」类目需律所执业许可证、「法律服务平台」需营业执照含「法律咨询」。若要用，宜以小程序 `web-view` 嵌 H5 复用 WebCrypto。
- **竞品对照**：Kimi Work、WorkBuddy、千问办公的手机遥控/IM 频道均**未宣称端到端加密**；WorkBuddy 与千问办公的 IM 频道都是「桌面端主动连 IM 平台长连接」，Kimi Work 远控链路未公开。法律发行版若做到「IM 只传通知 + 文件端到端加密直达律所电脑」，可作为差异化卖点。

