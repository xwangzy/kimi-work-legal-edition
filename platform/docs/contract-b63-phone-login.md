# 第 63 批接口契约：手机号验证码登录、绑定手机号与短信服务集中配置

> 在第 62 批（`contract-b62-registration.md`：手机号验证码注册、找回、注册管理、赛邮云通道）之上补齐“登录”环节。
> 云端：`services/control-plane`（`src/sms.ts`、`src/registration.ts`、`src/server.ts`）。律师端：`packages/kernel`（`services/onboarding.ts`、`api/index.ts`、`account-session.ts`）、
> `packages/egress-gate/src/cp-relay.ts`（控制面通道白名单）、`apps/desktop/src`（`pages/Activate.tsx`、`components/AccountPanel.tsx`、`components/SmsCodeFields.tsx`）。
> 控制台：`apps/console/pages/registration.js`、`apps/console/api.js`。

## 0. 设计取舍（第一性原理）

| 问题 | 取舍 |
|---|---|
| 账号的身份标识 | 账号仍以**邮箱**为主键（网页控制台、复核、找回、审计都依赖它）；**验证过的手机号是第二个登录标识**，与账号一对一（第 62 批已有 HMAC 唯一索引）。不另建“手机号账号”，不会重复建号。 |
| 验证码登录走哪个接口 | 复用 `POST /v1/auth/login`：请求体给 `phone + sms_code`（不给 `email + password`）。设备签名绑定、同账号新电脑入组、凭邀请注册后改绑、`onboarding` 状态、会话与审计全部沿用密码登录的同一段代码——两种登录方式到“核对身份”之后完全一致。 |
| 没注册的手机号要不要发码 | **不发**：发码时就回 `404 phone_not_registered`（不花短信费、律师立刻知道要先注册）。第 62 批注册发码已回 `phone_taken`，手机号是否注册本来就可查；另加“来源每小时查询上限”防批量探测。 |
| 老账号（只有邮箱）怎么用验证码登录 | 先用邮箱 + 密码登录，在“设置 → 账号”**绑定手机号**（`purpose=bind`，要会话；换绑另要当前密码）。登录页发码遇到 `phone_not_registered` 时同时提示“新用户去注册 / 老用户用密码登录后绑定”。 |
| 模板项目 | 登录、绑定、找回的模板项目**不填即沿用注册模板**（与 MaaS 一致：赛邮云同一个验证码模板 `@var(code)`、`@var(time)` 通用）。 |
| 启停 | 短信总开关 `enabled`（第 62 批）之外另有 `login_enabled`（手机号验证码登录开关，缺省开）。关掉只影响验证码登录，注册、找回、绑定照常。 |
| 码能不能跨用途 | 不能：码记录绑定用途（HMAC 输入含用途），登录码不能拿去注册、找回、绑定，反之亦然。 |
| 暴力尝试 | 单码最多校验 `max_attempts` 次（缺省 5）后作废；同号重发间隔、同号每日上限、来源每小时上限、全平台每日上限（第 62 批）照旧；验证码登录成功同样清零该账号的密码失败计数。 |
| 平台人员 | 平台人员（`stf_…`）没有手机号、只能网页 + 邮箱密码登录，不受本批影响。 |

## 1. 公共接口

### 1.1 `GET /v1/meta`（无鉴权）

`registration_policy` 增加两项，`features` 增加 `phone_login`、`phone_bind`：

```json
{ "registration_policy": { "...第 62 批字段": "…", "phone_login": true, "phone_bind": true },
  "features": ["sms_send", "phone_register", "phone_reset", "registration_invites", "phone_login", "phone_bind"] }
```

- `phone_login` = 短信总开关开、`login_enabled` 开、且能发送（凭据 + 签名 + 登录模板（或沿用注册模板）齐全，或允许的 dry-run）。
- `phone_bind` = 短信能发送（总开关开、凭据齐）。
- 客户端：`features` 里没有 `phone_login` 即按第 62 批界面（只有邮箱密码登录）。

### 1.2 `POST /v1/auth/sms/send`

`purpose` 取值扩为 `register | reset | login | bind`。应答形状不变。新增规则：

| 用途 | 规则 |
|---|---|
| `login` | 验证码登录不可用 → `503 sms_login_disabled`；手机号没有对应账号 → `404 phone_not_registered`（不发短信）；账号已停用 → `403 account_disabled`（不发）；其余照第 62 批频控后发送。模板：`projects.login ?? projects.register`。 |
| `bind` | 须带成员账号会话（`Authorization: Bearer kws1…` 或 `x-kwl-session`）；平台人员 → `403 member_only`；手机号就是本账号的 → `409 phone_same`；已绑在别的账号 → `409 phone_taken`；其余照频控后发送。模板：`projects.bind ?? projects.register`。 |
| `reset` | 模板改为 `projects.reset ?? projects.register`（其余同第 62 批：手机号没有有效账号时照样回 200、不发）。 |

“查询型”拒绝（`phone_not_registered`、`phone_taken`、`account_disabled`）按来源每小时计数，超过 30 次 → `429 sms_probe_limit`（防批量探测手机号是否注册）。

### 1.3 `POST /v1/auth/login`（新增验证码方式）

请求：`{ "phone": "138 0013 8000", "sms_code": "123456", "client": {version, platform} }`（不带 `email`、`password`；同时带两种的按密码方式处理）。

顺序：入口限速（与密码登录同一桶，每来源每分钟 20 次）→ 最低客户端版本 → 验证码登录可用（`503 sms_login_disabled`）→ 手机号格式（`400 phone_invalid`）→ 有对应账号（`404 phone_not_registered`）→ 核对并作废登录验证码（`sms_code_invalid` / `sms_code_expired` / `sms_code_attempts`）→ 账号停用 `403 account_disabled` → 之后与密码登录完全相同（设备签名、改绑、`device_mismatch`、`onboarding`、会话）。

应答与密码登录相同（`AuthResult`：`session_token`、`account`（含打码 `phone`）、`onboarding`）。律所可见审计动作 `account.login_sms`（密码登录仍为 `account.login`）。

### 1.4 `POST /v1/auth/phone`（新增；成员账号会话）

请求：`{ "phone": "…", "sms_code": "…", "password"?: "…" }`。

- 账号还没有手机号 → 绑定（不要密码）；已有手机号 → 换绑，须带当前密码（错 → `401 auth_invalid` 并计入失败次数；锁定中 → `423 account_locked`）。
- `phone_same`、`phone_taken`、`sms_code_*` 同上；核对 `bind` 用途的验证码。
- 应答 `{ ok: true, account: AccountView }`（`account.phone` 为打码）；审计 `account.phone_bind` / `account.phone_change`。

## 2. 运营接口（`/v1/ops/registration/*`）

- `GET/PUT /v1/ops/registration/sms`：设置多 `login_enabled: boolean`（缺省 true）与 `projects.bind`；视图多：
  `login_enabled`、`login_available`（= 1.1 的 `phone_login`）、`projects_effective: { register, reset, login, bind }`（不填时沿用注册模板后的实际值）、`missing_by_purpose: { register: [], reset: [], login: [], bind: [] }`。
- `GET /v1/ops/registration`：`sms` 多 `login_enabled`、`login_available`；`meta` 即 1.1 的策略（含 `phone_login`、`phone_bind`）。
- `GET /v1/ops/registration/sms/logs?limit&purpose&result`：`purpose` 可为 `register|reset|login|bind|test`；应答另带 `stats`（最近 7 个北京时间自然日，新的在前）：

```json
{ "logs": [ … ],
  "stats": [ { "day": "2026-11-24", "sent": 12, "failed": 1, "dry_run": 0,
               "by_purpose": { "register": 3, "login": 8, "reset": 1, "bind": 0, "test": 0 },
               "fail_codes": { "sms_template_invalid": 1 },
               "blocked": { "sms_too_frequent": 2, "sms_probe_limit": 0 },
               "verify_ok": 10, "verify_failed": 2, "attempts_exhausted": 0 } ] }
```

  `blocked` = 被频控 / 探测上限挡下的发码请求（按代码计数）；`verify_*` = 验证码核对结果（注册、登录、找回、绑定合计）。只计数，不含手机号与验证码。

## 3. 错误代码（新增）

| 代码 | HTTP | 场景 | 律师端说法（内核换成人话） |
|---|---|---|---|
| `sms_login_disabled` | 503 | 验证码登录未开放 | 手机号验证码登录暂未开放，请用邮箱和密码登录 |
| `phone_not_registered` | 404 | 手机号没有对应账号（登录） | 这个手机号还没有注册账号。新用户请先注册；已用邮箱注册的，请用密码登录后在“设置 → 账号”绑定手机号 |
| `phone_same` | 409 | 绑定的就是当前手机号 | 这个手机号已经绑定在你的账号上 |
| `sms_probe_limit` | 429 | 来源每小时查询过多 | 获取验证码过于频繁，请一小时后再试 |
| `member_only` | 403 | 平台人员绑定手机号 | （控制台不提供该功能） |

## 4. 律师端（内核方法；Windows 与 macOS 同一份）

| 方法 | 模式 | 变化 |
|---|---|---|
| `account.registration_meta` | 待激活 + 已激活（新增） | 结果多 `phone_login: boolean`、`phone_bind: boolean`；旧云端 / 取不到 → `{ legacy: true }`（两项视为 false） |
| `account.sms_send({ phone, purpose })` | 待激活：`register|reset|login`；已激活（新增）：`login|reset|bind` | 结果同第 62 批：`{ ok, phone, resend_after_s, expires_in_s, code_length, dry_run?, debug_code? }` |
| `account.login({ email, password } \| { phone, sms_code })` | 两种模式 | 验证码方式；已激活模式只许登这台电脑已登记成员的账号（与密码方式相同） |
| `account.bind_phone({ phone, sms_code, password? })` | 已激活（新增） | `{ ok: true, phone: "138****8000" }` |
| `account.me` | 已激活 | `account.phone`（打码或 null，第 62 批已有） |

失败时 `DomainError.detail.reason` 为上表代码（例如 `phone_not_registered`），`detail.retry_after_s` 照第 62 批。控制面通道白名单新增 `/v1/auth/phone`（`docs/privacy/egress-paths.json` 同步登记）。

## 5. 界面（律师端）

- 登录页（待激活）与“登录已失效”就地登录框：云端 `phone_login` 时显示分段“验证码登录 | 密码登录”，缺省上次用过的方式（本机记住；没有记录时缺省验证码登录）；没有 `phone_login` 时只有密码登录（与第 62 批完全相同）。
- 验证码登录：手机号 → “获取验证码”（倒计时按云端间隔）→ 输入验证码（填满位数后可回车提交）→ 登录。`phone_not_registered`：在表单内写明原因并给两个动作——“用这个手机号注册”（切到注册、手机号带过去）与“改用密码登录”。
- “设置 → 账号与团队 → 账号”：账号卡显示手机号（打码）或“未绑定”；`phone_bind` 时有“绑定手机号 / 更换手机号”（对话框：手机号 + 验证码，换绑另要当前密码）。
- 短信相关文案不出现“令牌、HMAC、dry-run”等词；测试环境（云端 dry-run）照第 62 批写明“测试环境：验证码是 …”。

## 6. 部署与回滚

- 部署顺序：先云端（旧状态读回：`login_enabled` 缺省 true，`projects.bind` 空；线上已配好短信 → 升级后验证码登录立即可用）→ 再发新客户端。旧客户端（0.3.0 及以前）看不到验证码登录，照常用邮箱密码，不受影响；不需要调整最低客户端版本。
- 只想停用验证码登录：控制台“短信服务”关闭“手机号验证码登录”（`login_enabled=false`），注册与找回不受影响。
- 回滚云端到第 62 批代码：旧代码不认识 `login_enabled` / `projects.bind`（读回时丢弃）、不认识 `purpose=login|bind`（400 `sms_purpose_invalid`，新客户端据 `/v1/meta` 无 `phone_login` 自动退回密码登录）；绑定过的手机号仍在账号上（第 62 批字段），不丢。
