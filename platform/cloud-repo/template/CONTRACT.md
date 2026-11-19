# 云端与 Windows 客户端的接口契约（`kwl-cp/2`）

本仓库（云端）与 Windows 客户端（另一个仓库）各自发版。下面这些是**客户端写死依赖**的东西：改动它们会让已装的客户端失效。
运维升级云端前，先看本页“变更规则”。

## 1. 版本与兼容

| 项 | 现值 | 说明 |
|---|---|---|
| 接口版本 | `kwl-cp/2` | `GET /v1/meta` 返回 `{api, min_client_version, registration, staff_mfa}` |
| 客户端最低版本 | 控制面配置 `clients.min_version`（缺省不限） | 低于它的客户端登录、注册、取席位令牌得 426 `client_outdated`，客户端提示“请升级到 x.y.z 或以上” |
| 共享契约包 | `packages/firm-trust`、`packages/seat-token`、`packages/keys`、`packages/design-tokens` | 两端共用同一份源码（来源 monorepo，见 `SOURCE.json`）；CI 的 `npm run verify:source` 确认这里没被单独改过 |

**变更规则**
1. 只加不改：新增接口、新增可选字段、新增错误码可以随时发；客户端对不认识的字段一律忽略。
2. 改名、删字段、改语义、改签名格式 = 破坏性变更：先发能同时处理新旧两种的客户端，等 `clients.min_version` 抬到那一版之后，再在云端去掉旧的。
3. 给客户端新增一个要调用的控制面路径，要同时改客户端的通道白名单（`egress-gate/src/cp-relay.ts`）与出站登记表并发新客户端；只给网页控制台用的接口（`/v1/ops/*`、`/v1/firm/*`、`/v1/me/*`、`/v1/auth/mfa/*`、`/v1/auth/reauth`）不受此限。

## 2. 客户端会调用的控制面路径（白名单，方法 GET/POST/PUT/DELETE）

```
/v1/enroll                       /v1/devices/register            /v1/directory          /v1/license
/v1/tenant-salt                  /v1/seat-token                  /v1/policy             /v1/connectors[/{id}]
/v1/drafts[/drf_<16 hex>[/signatures|/publish]]                  /v1/anon-matters/{id}
/v1/devices/{id}/revoke          /v1/seats/{uid}/revoke          /v1/quota              /v1/quota/cap
/v1/support-token                /v1/notify-token                /v1/relay-token
/v1/auth/{register|login|logout|me|password|password-reset/request|password-reset/confirm}
/v1/auth/sessions/ses_<16>/revoke                                /v1/auth/devices/{id}/unbind
/v1/audit?after=<n>&limit=<n>
/v1/activation/redeem            /v1/join-requests               /v1/join-requests/jr_<16>/{fetch|approve|reject|withdraw}
/v1/invitations                  /v1/invitations/act_<16>/revoke
```
请求头只放行 `x-kwl-tenant`、`x-kwl-device`、`x-kwl-ts`、`x-kwl-nonce`、`x-kwl-sig`（设备签名，时钟偏差 5 分钟）与 `x-kwl-session`（账号会话）。请求体至多 256 KiB，应答至多 8 MiB。

## 3. 令牌与签名格式

| 名称 | 形态 | 谁签/谁验 |
|---|---|---|
| 账号会话 | `kws1.ses_<16>.<43 位 base64url>` | 控制面签发（只存摘要）；桌面端放 `x-kwl-session`，网页放 `Authorization: Bearer` |
| 席位令牌 | `zst1.<载荷>.<Ed25519 签名>`，含 `aud` | 签名服务签发；网关/检索/分发离线验签（公钥 = release.json `seat_keys`） |
| 支持/通知/中继专用凭据 | 同上，`aud` 分别为 support/notify/relay | 同上 |
| 签名信封类型 | `kwl-quota-view`、`kwl-license`、`kwl-device-directory`、`kwl-device-revoked`、`kwl-firm-policy`、`kwl-firm-policy-current`、`kwl-firm-connector`、`kwl-firm-connectors`、`kwl-tenant-salt`、`kwl-cp-audit-page`、`kwl-invite-mac/1` | 签名服务用控制面文档签名私钥签；客户端用 release.json `control_plane_keys` 验 |
| 入组与批准字节格式 | `joinProofBytes`、`joinMacBytes`、`approvalMacBytes`、`firmBundleBytes`、`joinCheckCode` | `packages/firm-trust/src/onboarding.ts`，任何改动两端同时发 |

## 4. 错误体与错误码

错误体一律 `{ "error": { "code": "...", "message": "中文说明", ...附加字段 } }`。客户端按 `code` 分支（`message` 只作兜底显示）：

- 账号：`auth_invalid`、`account_locked`(+`retry_after_s`)、`account_disabled`、`registration_closed`、`code_required`、`code_invalid`、`email_invalid`、`email_taken`、`member_taken`、`password_weak`(+`rules`)、`session_required`、`session_invalid`、`session_expired`、`session_member_mismatch`、`device_limit`、`device_mismatch`、`rate_limited`、`client_outdated`(+`min_version`)、`staff_client_forbidden`
- 设备与许可：`device_revoked`(+`notice`)、`device_auth_stale`(+`server_time`)、`license_expired`、`no_seat`、`admin_required`、`cap_invalid`
- 网关：401 `seat_token_missing`、`seat_session_inactive`；402 `quota_exhausted`、`quota_cap_reached`、`quota_burst`、`quota_seat_limit`、`price_unconfigured`；429 `upstream_busy`(+`Retry-After`)；502/503/504 `upstream_*`

## 5. 主要字段

- `AuthResult = {session_token, session:{sid,kind,idle_expires_at,restricted}, account:{aid,email,name,role,tid,org:{slug,name},device_limit}, onboarding:{state, firm, member, tid, device_id, claim, devices}}`，`state ∈ ready|needs_founder_setup|needs_device_join|device_limit|device_mismatch`。
- 额度视图 `kwl-quota-view`：`firm{used_ratio,remaining_ratio,in_flight_ratio,paused,cap_pct,boost_pct,legacy_used_ratio}`、`burst{hours,pct,used_ratio,resets_at}`、`own{used_ratio,denominator,estimated_rows}`、`history[]`、`models[]`、`by_member[]`（管理员/合伙人）、`unreconciled_leases`、`own_recent[]`（v1.0.6 起，**新增字段、向后兼容**：本人本期最近 20 条使用明细 `{at, kind: "qa"|"task", alias, label, tokens_in, tokens_cached, tokens_out, charge, unit, value_cny, outcome, partial, estimated}`，不含请求内容与事项；旧客户端忽略）。
- `PUT /v1/quota/cap` 体：`{monthly_cap_pct: 1–100 | null}`。

## 6. 模型网关

- `POST {gateway}/v1/chat/completions`（OpenAI 兼容，流式 SSE）：`Authorization: Bearer <席位令牌>`，`x-kwl-data-level`、`x-kwl-anon-matter`（无事项问答）、`x-kwl-request-id`（闸门编号，用于对账）。
- 模型别名写死在客户端：`legal/k3`（主任务）、`legal/k2.6`（子任务）。运营在控制台改的是“别名 → 上游与型号”，**别名本身不改名**。
- 计量：每个请求一条账，按网关请求编号去重；上游没给 usage 时按已转发内容估算并标“估算”；服务出错（未写出内容，或写到一半上游出错）不扣律师额度，后者只记成本供对账。
