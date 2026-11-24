# 第 62 批接口契约：手机号验证码注册、注册管理与注册邀请码

> 云端：`services/control-plane`（`src/sms.ts`、`src/registration.ts`、`src/server.ts`）。律师端：`packages/kernel`（`account.registration_meta`、`account.sms_send`）、`apps/desktop/src/pages/Activate.tsx`。
> 控制台“注册管理”一级菜单与短信配置页按本契约实现（`apps/console/` 不在本批改动范围）。
> 用例：`services/control-plane/test/b62-registration.test.ts`、`packages/kernel/test/b62-registration-account.test.ts`、`apps/desktop/test/b62-registration-ui.test.ts`。

## 1. 现状与复用（不另起一套）

| 已有 | 本批怎么用 |
|---|---|
| 注册方式 `registration: open / code / closed`（`/v1/ops/settings`，第 44、46 批） | 原样保留，`code` 即“仅凭码注册”；新增 `phone_required`（注册是否必须验证手机号），同一份 `RegistrationSettings` |
| 注册字段 `code`：20 位创始开通码、36 位成员邀请码（控制面段 20 位 + 本机核对段 16 位） | 同一个字段另认 **12 位平台注册邀请码**；开通码与成员邀请码流程不动（律所内成员邀请仍由律所根私钥在客户端签发） |
| 开通码的 Crockford Base32 字母表、输入归一（忽略大小写 / 空格 / 连字符，I、L 读作 1，O 读作 0）、胡椒 HMAC 查找 | 注册邀请码用同一字母表、同一归一、同一把胡椒（域分隔串 `kwl-reg-invite/1`） |
| 一次性码只存 HMAC、恒定时间比较（`accounts.ts`） | 短信验证码同样只存 HMAC（绑定用途、手机号摘要与记录编号），一次性 |
| 平台人员会话 + RBAC + 危险操作复核（`opsRoute`）、内部访问审计 `opsAccessLog` | 新接口全部挂在 `/v1/ops/registration/*`，同一套鉴权；另记“注册管理操作记录”供控制台查看 |
| 状态快照（文件两代 / PostgreSQL，整份封装加密） | 短信设置、验证码记录、发送记录、邀请码、操作记录都随快照落盘；“没写成就等于没发生”的回滚语义不变 |

注册邀请码 vs 开通码：开通码绑定运营先建好的律所；注册邀请码不绑律所，凭它注册即开一家试用律所（套餐、试用天数、席位可随批次设定，不设则用注册设置里的 `trial_*`）。

## 2. 数据结构（控制面状态快照）

```ts
// 账号新增（旧账号没有，照常用邮箱登录）
AccountRecord.phone?: { mac: string /* HMAC(胡椒派生键, 手机号) 唯一索引 */; masked: string /* 138****8000 */; sealed: string /* AES-256-GCM 密文 */; verified_at: string } | null
AccountRecord.invite_id?: string | null   // 凭哪个注册邀请码注册（inv_…）

// 注册设置新增
RegistrationSettings.phone_required?: boolean   // 缺省 false

// 短信设置（state.sms）
SmsSettings = { enabled, provider: "submail", app_id, app_key_sealed /* 只写不回显 */, app_key_hint /* 末 4 位 */, sign_name,
  projects: { register, reset, login /* 预留，本批不开手机号登录 */ },
  code_length /* 4–8，缺省 6 */, ttl_minutes /* 1–30，缺省 10 */, resend_seconds /* 30–600，缺省 60 */,
  daily_limit_per_phone /* 1–50，缺省 10 */, ip_hourly_limit /* 1–1000，缺省 20 */, daily_total_limit /* 1–100000，缺省 2000 */,
  max_attempts /* 1–10，缺省 5 */, dry_run, updated_at, updated_by }

// 注册管理（state.registration）
SmsCodeRecord = { id: "smc_…", purpose: "register"|"reset"|"test", phone_mac, mac, created_at, expires_at, attempts, used_at, superseded }  // 48 小时后清理
SmsLogEntry   = { at, purpose, phone /* 打码 */, result: "sent"|"dry_run"|"failed", code /* 本平台失败代码 */, provider_code /* 赛邮云代码 */, by }  // 最近 500 条
InviteBatch   = { id: "ivb_…", name, note, count, max_uses, expires_at|null, plan|null, trial_days|null, trial_seats|null, created_at, created_by }
InviteCode    = { id: "inv_…", batch_id, mac, sealed, max_uses, used, expires_at, status: "active"|"disabled", disabled_at, disabled_by, disabled_reason, created_at, uses: { at, aid, tid }[] }
RegAuditEntry = { at, actor /* stf_… */, action, target, detail }   // 最近 1000 条
```

密钥：手机号 HMAC、验证码 HMAC、控制面自持密文（AppKey、手机号、邀请码明文）三把，均由开通码胡椒（`code_pepper_file`，KMS 挂载）HKDF 派生、用途分开；状态快照本身另有封装密钥。

**邀请码存储取舍**：存 HMAC（查找、比对）+ AES-GCM 密文（运营要再次查看、复制、导出 CSV 交给渠道，只显示一次不够用）。快照泄露但胡椒没泄露时解不开；只有 `registration.manage` 能看完整的码，`registration.read` 只看打码 `ABCD-****-WXYZ`。码 12 位 Crockford（60 bit），注册入口每来源每分钟 10 次，猜中的概率可以忽略。总量上限 10,000 个（快照整份重写，控制体积）。

## 3. 公共接口（律师端经内核闸门转发；网页注册直连）

### 3.1 `GET /v1/meta`（无鉴权）——能力字段，客户端据此做特性检测

```json
{ "api": "kwl-cp/2", "min_client_version": null, "registration": "code",
  "registration_policy": { "mode": "code", "invite_required": true, "require_phone": true, "sms_available": true, "phone_reset": true,
                           "sms": { "code_length": 6, "resend_seconds": 60, "ttl_minutes": 10 } },
  "sms_available": true,
  "features": ["sms_send", "phone_register", "phone_reset", "registration_invites"] }
```

- 旧云端只有前三个字段：客户端看不到 `registration_policy` 或 `features` 里没有 `sms_send` 即按旧流程（不显示手机号，码可勾选填写），不报错。
- `sms_available` = 短信已启用且（凭据、签名、注册模板齐全，或本部署允许且打开了 dry-run）；`phone_reset` 同理看找回模板。

### 3.2 `POST /v1/auth/sms/send`（无会话）

请求：`{ "phone": "138 0013 8000", "purpose": "register" | "reset", "client"?: {version, platform} }`（手机号可带 +86 / 空格 / 连字符）。

应答 200：`{ ok, purpose, phone: "138****8000", code_length, expires_in_s: 600, resend_after_s: 60 }`；dry-run 另带 `dry_run: true, debug_code: "123456"`（只在允许 dry-run 的非生产部署；验证码不进任何日志）。

发送前依次检查：入口限速（每来源每分钟 5 次）→ 用途 → 手机号格式（`^1[3-9]\d{9}$`）→ 短信可用 → 注册用途：注册未关闭、手机号未注册 → 同号重发间隔 → 同号每日上限（北京时间自然日）→ 来源每小时上限 → 全平台每日上限。找回用途：手机号没有对应的有效账号时照样回 200（不发短信、不给码），不泄露是否注册。发送失败时验证码记录作废（不占重发间隔），发送记录写明失败代码与赛邮云代码。

### 3.3 `POST /v1/auth/register`（新增字段）

`{ email, password, name, org_name?, code?, phone?, sms_code?, client? }`

- `phone_required` 打开时 `phone` + `sms_code` 必填；没打开时也可以填，填了就要验证。手机号与账号一对一。
- `code`：20 位开通码 / 36 位成员邀请码（客户端只发控制面段）/ 12 位注册邀请码。先查码、不改状态 → 核对并作废短信验证码 → 占用码（已用次数 + 1）与建律所、建账号在同一段同步代码里完成（并发注册时后到的看到“已用完”）。
- 应答不变；`account.phone` 为打码。

### 3.4 `POST /v1/auth/password-reset/confirm`（新增手机号方式）

`{ phone, code /* 短信验证码 */, password }`（不带 `email`）。先查密码规则（不合格不耗验证码）→ 核对验证码 → 改密、所有登录退出。邮箱方式不变。

## 4. 运营接口（`/v1/ops/registration/*`；Bearer 平台人员会话）

| 方法 路径 | 权限 | 复核 | 说明 |
|---|---|---|---|
| GET `/v1/ops/registration` | registration.read | | 概览：`policy`、`meta`（同 /v1/meta 的策略）、`sms`（enabled、available、mode、unavailable_reason、dry_run、dry_run_blocked、missing）、`invites`（total、batches、by_status） |
| PUT `/v1/ops/registration/policy` | registration.manage | 要 | 体：`registration`、`phone_required`、`trial_plan`、`trial_days`、`trial_seats`、`default_device_limit` 任选；与 `/v1/ops/settings` 是同一份设置。打开 `phone_required` 时短信须可用（`409 sms_required_for_policy`） |
| GET `/v1/ops/registration/sms` | settings.manage | | `{ sms: SmsView }`：不含 AppKey，只给 `app_key: { set, hint }`；另有 `available`、`mode`、`missing`、`dry_run_allowed`、`dry_run_blocked` |
| PUT `/v1/ops/registration/sms` | settings.manage | 要 | 部分字段：`enabled`、`provider`("submail")、`app_id`、`app_key`（只写；`""`/null 清除）、`sign_name`（不带【】）、`projects.{register,reset,login}`、各项上限、`dry_run`。启用且非 dry-run 时须齐全（`400 sms_incomplete` + `missing`）；生产部署打开 dry-run → `409 sms_dry_run_forbidden`；`phone_required` 开着时不能停用 → `409 sms_required_by_policy`。应答 `{ ok, changed: string[], sms }` |
| POST `/v1/ops/registration/sms/test-connection` | settings.manage | 不要 | 查赛邮云余额（不发短信，不要求已启用）：`{ ok, provider, balance, transactional_balance, checked_at }`；失败带 `provider_code` |
| POST `/v1/ops/registration/sms/test-send` | settings.manage | 要 | 体 `{ phone }`：按注册模板发一条随机码（不能用来注册），受同号间隔与每日上限约束；`{ ok, phone: 打码, sent_at }` |
| GET `/v1/ops/registration/sms/logs?limit&purpose&result` | registration.read | | 发送记录（打码，不含验证码） |
| GET `/v1/ops/registration/audit?limit` | registration.read | | 注册管理操作记录 |
| GET `/v1/ops/registration/invite-batches` | registration.read | | 批次列表（含 `used_total`、`by_status`） |
| POST `/v1/ops/registration/invite-batches` | registration.manage | | 体：`name`(1–40)、`count`(1–1000)、`max_uses`(1–1000，缺省 1)、`expires_at`(ISO) 或 `ttl_days`(1–3650)（都不给 = 长期）、`note`(≤200)、`plan`、`trial_days`(1–365)、`trial_seats`(1–50)。应答 `{ ok, batch, codes: InviteView[] }`（含完整的码） |
| POST `/v1/ops/registration/invite-batches/{ivb}/disable` | registration.manage | | 停用整个批次：`{ ok, disabled, batch }` |
| GET `/v1/ops/registration/invites?batch_id&status&q&limit&cursor` | registration.read | | `status` ∈ available / exhausted / expired / disabled；`q`：完整的码精确查，否则按批次名、码末 4 位、使用人邮箱或手机号。`{ invites, next, total, revealed }`，没有 manage 时 `code` 为 null、只给 `code_masked` |
| GET `/v1/ops/registration/invites.csv?…` | registration.manage | | 导出（同上筛选）：邀请码、批次、状态、可用次数、已用次数、有效期至、套餐、试用天数、试用席位、生成时间、最近使用、使用人；UTF-8 BOM，防公式注入 |
| GET `/v1/ops/registration/invites/{inv}` | registration.read | | `{ invite, uses: [{ at, aid, email, name, phone(打码), tid, tenant_name }], batch }` |
| POST `/v1/ops/registration/invites/{inv}/disable` · `/enable` | registration.manage | | 单个停用（体 `{ reason? }` ≤100 字）/ 重新启用 |
| POST `/v1/ops/registration/invites/disable` | registration.manage | | 批量：`{ ids: inv_…[] (1–1000), reason? }` → `{ ok, disabled }` |

`InviteView = { id, code|null, code_masked, batch_id, batch_name, status, max_uses, used, remaining, expires_at, plan, trial_days, trial_seats, created_at, last_used_at, disabled_at, disabled_by, disabled_reason }`

另：`/v1/ops/accounts` 的行增加 `phone`（打码）与 `invite_id`；`q` 是手机号时按手机号摘要精确查。`/v1/ops/settings` 的应答多一个 `phone_required`。

## 5. 权限

新增 `registration.read`、`registration.manage`（`rbac.ts`）。分配：系统管理员 = manage + read（另有 settings.manage 管短信通道）；客户运营 = manage + read；客服 = read；只读 = read；财务、开通专员不变。短信通道配置与测试是系统设置（`settings.manage`，危险权限，写操作复核）。

## 6. 错误代码（`{ error: { code, message, ... } }`；律师端由内核换成人话）

| 代码 | HTTP | 场景 |
|---|---|---|
| phone_invalid | 400 | 手机号格式不对 |
| phone_required / sms_code_required | 400 | 策略要求手机号 / 没填验证码 |
| phone_taken | 409 | 手机号已注册 |
| sms_code_invalid | 400 | 验证码不对（`attempts_left`） |
| sms_code_expired | 400 | 过期、已用过、被新码取代或没获取 |
| sms_code_attempts | 400 | 单码校验次数用完 |
| sms_too_frequent | 429 | 重发间隔内（`retry_after_s`） |
| sms_daily_limit / sms_ip_limit / sms_daily_total_limit | 429 | 同号每日 / 来源每小时 / 全平台每日上限 |
| sms_purpose_invalid | 400 | 用途不是 register / reset |
| sms_disabled / sms_not_configured | 503 | 未启用 / 未配置（测试发送另带 `missing`） |
| sms_balance_insufficient | 503 | 赛邮云 903 / 904 / 905 |
| sms_template_invalid | 503 | 模板或项目不存在 / 未审核（117、118、120、305–307、406、407、409、417、418、420） |
| sms_sign_invalid | 503 | 签名问题（116、126、127、154、401、402、411–413） |
| sms_auth_failed / sms_ip_blocked | 503 | AppID/AppKey/签名校验/时间戳（101–111、119、151、152）/ 服务器 IP 不在白名单（113） |
| sms_phone_rejected | 400 | 号码无效、黑名单、退订（114、251–253） |
| sms_provider_throttled | 429 | 赛邮云频控（115、408、901） |
| sms_timeout / sms_network_error / sms_provider_error | 504 / 502 / 503 | 超时（10 秒）/ 连不上 / 其他 |
| code_invalid | 400 | 码不对（开通码、成员邀请码、注册邀请码统一说法） |
| code_required | 403 | 仅凭码注册而没填码 |
| invite_exhausted / invite_expired / invite_disabled | 409 / 410 / 403 | 注册邀请码已用完 / 已过期 / 已停用 |
| registration_closed | 403 | 关闭注册（发注册验证码同样拒绝） |
| sms_dry_run_forbidden / sms_incomplete / sms_required_by_policy / sms_required_for_policy | 409 / 400 / 409 / 409 | 运营设置校验 |
| batch_*_invalid / plan_unknown / trial_*_invalid / too_many_invites / ids_invalid / invite_unknown / batch_unknown / status_invalid / policy_invalid | 400/404/409 | 运营接口参数 |

## 7. 审计事件

- 内部访问审计（`opsAccessLog`，每个运营请求先记 requested、再记 ok / rejected:代码）：动作 `registration.read`、`registration.policy_update`、`sms.settings_read`、`sms.settings_update`（target = `fields:改了哪些字段`，不记值）、`sms.test_connection`、`sms.test_send`（target = 打码手机号）、`sms.logs`、`registration.audit`、`invite.batches`、`invite.batch_create`、`invite.batch_disable`、`invite.list`、`invite.export`、`invite.read`、`invite.disable`、`invite.enable`、`invite.disable_many`。
- 注册管理操作记录（`GET /v1/ops/registration/audit`）：`registration.policy_update`（detail：fields、registration、phone_required）、`sms.settings_update`（fields、enabled、dry_run、换 AppKey 时的新尾号）、`sms.test_connection`（result、provider_code）、`sms.test_send`（打码手机号、result）、`invite.batch_create`（批次规格）、`invite.batch_disable` / `invite.disable_many`（数量）、`invite.disable`、`invite.enable`、`invite.export`（行数）。
- 律所可见审计流水：`account.register`、`account.password_reset`（手机号找回同一动作）照旧。
- 任何日志与审计都不含验证码、AppKey 与完整手机号。

## 8. 控制台“注册管理”建议结构（供实现参考）

概览（`GET /v1/ops/registration`）→ 注册策略（PUT policy，复核）→ 注册邀请码（批次列表、生成对话框、码列表筛选与搜索、详情与使用记录、单个 / 批量 / 整批停用、导出 CSV）→ 短信配置（仅 settings.manage 可见；AppKey 输入框只写、显示“已设置 ··末 4 位”；测试连接、发送测试短信；`dry_run_blocked` 时告警）→ 发送记录 → 操作记录。生成批次的应答含全部码，可直接给“复制全部 / 下载 CSV”。

## 9. 律师端（Windows 与 macOS 同一份界面代码）

- 内核新方法（待激活模式开放）：`account.registration_meta`（GET /v1/meta，归一后回 `{ legacy, mode, invite_required, require_phone, sms_available, phone_reset, sms }`；旧云端、取不到、格式不对一律 `{ legacy: true }`）、`account.sms_send({ phone, purpose })`；`account.register` 增加 `phone`、`sms_code`，码另认 12 位；`account.reset_confirm` 可用 `{ phone, code, password }`。
- 闸门控制面通道白名单新增 `^/v1/meta$`、`/v1/auth/sms/send`（`docs/privacy/egress-paths.json` 已登记，驻留面清单第 29 类已补手机号）。
- 注册页：legacy → 与第 61 批完全相同；新云端 → 短信可用显示手机号（要求时必填，否则选填）与“获取验证码”（按云端间隔倒计时；频控时按 `retry_after_s`）；仅凭码时码必填；dry-run 时写明“测试环境：验证码是 …”。找回密码在 `phone_reset` 时多一个“用手机号”。

## 10. 部署与回滚

**部署顺序**

1. 先部署云端（本批的控制面）。旧状态读回：短信关闭、`phone_required` = false、没有注册邀请码；现有账号没有手机号，照常邮箱登录；注册方式与开通码、成员邀请码不变。
2. 控制台“注册管理 → 短信配置”填赛邮云 AppID、AppKey、签名（不带【】）、注册与找回模板项目 → 测试连接（查余额）→ 发送测试短信 → 启用。服务器出口 IP 若在赛邮云开了白名单，须先加上（否则 `sms_ip_blocked`）。
3. 发新客户端。**开启“注册必须验证手机号”或开始发 12 位注册邀请码之前**，先在“系统设置”把客户端最低版本设为本批客户端版本：旧客户端不认识这两项，注册时只会看到通用失败提示（旧客户端本机就拒绝 12 位码）。
4. 生产配置不要写 `sms.allow_dry_run`（`ops.deployment` 以 prod 开头时写了即拒绝启动）；测试 / 联调部署可写 `"sms": { "allow_dry_run": true }`。状态里带着 dry_run 搬到生产时视为关闭，控制台显示 `dry_run_blocked`。

**回滚**

- 只回滚客户端：新客户端对旧云端按特性检测走旧流程，旧客户端对新云端在策略未打开时照常可用——互不阻塞。
- 回滚云端到第 61 批代码：先在控制台关闭“必须验证手机号”、把注册方式改回原值（旧代码不认识 12 位码，`code` 模式下凭注册邀请码的人会注册不了）；再回滚代码。旧代码读快照时不认识顶层的 `sms`、`registration` 两段（忽略，下次写盘即丢失：短信设置、验证码与发送记录、注册邀请码与使用记录、操作记录）；账号上的 `phone`、`invite_id` 字段旧代码原样带着、不使用；`phone_required` 留在设置对象里不起作用，下次改设置时被丢弃。凭手机号 / 注册邀请码注册的账号照常用邮箱 + 密码登录。如需再升级回来保留短信设置与邀请码，回滚前先备份状态快照（`state.1/.2` 或 PostgreSQL 行），升级回来时用备份恢复；不恢复也能用，只是短信要重新配置、邀请码要重新生成（手机号唯一索引随账号读回，不受影响）。
- 只想停用新功能而不回滚代码：短信设置 `enabled=false`（先关 `phone_required`），注册方式改回 `open` / `code`，整批停用注册邀请码。
