# V40 实施 D：个人账号取消设备绑定与数量限制 + 个人用量接口（第 66 批）

- 分支 / worktree：`claude/kimi-legal-b66-ux`（`platform/`）。未提交（按要求不 commit / stash / 切分支）。
- 依据：`audit-A-云端模型账号额度.md` B.3（推荐方案：账号设备由控制面签发，仅限个人账号）与 C.4。
- 偏离：**D-292**（个人租户放开“控制面不签发设备证书”与 D-186“批准方核对 12 位核对码”）、**D-293**（个人租户不按套餐台数挡、硬上限 20 台滚动吊销），已登记在 `platform/docs/v9-开发计划与进度.md` D-291 之后。
- 迁移：内核 **0074**（`firm_identity.account_ca_public_key_pem`）。控制面状态无迁移脚本，读回时按规则判定（见 §2）。

## 1. 改动文件

| 层 | 文件 | 改了什么 |
|---|---|---|
| 密钥格式 | `packages/keys/src/device.ts` | 证书新增可选字段 `issuer?: "account_ca"`（在签名范围内；缺省 = 律所根，存量证书字节不变）；字段核对拒非法值 |
| 信任锚 | `packages/firm-trust/src/device-anchors.ts`（新）、`index.ts` | `verifyDeviceCertificateAny(cert, {root, accountCa})` 按证书写明的签发者选锚（两把钥不能互相冒充；没给 accountCa 时 account_ca 证书一律不过）；`certIssuerOf`；`deviceEnrollProofBytes`（持有证明，绑租户/账号/会话/设备编号/两把公钥） |
| 签名者 | `services/control-plane/src/signer.ts` | `ControlPlaneKeys.accountDeviceCa`；`SignerPublicKeys.account_device_ca {kid, public_key_pem}`；`CpSigner.issueAccountDeviceCert`（本地与远程两种；远程回来的证书按签发钥验、字段逐项对照）；`accountDeviceCertProblem`（issuer 固定 account_ca、不签 node、≤366 天、签发时刻±5 分钟）；新信封种类 `kwl-usage-page`、`kwl-device-enroll` |
| 签名服务 | `services/cp-signer/src/index.ts`、`ledger.ts` | 新操作 `POST /v1/sign/device-cert`（只收 request_id / req_now / cert；按上面规则核对；签后自验；记签名账 op=device_cert）；两种新信封的结构核对（device-enroll 拒任何 PRIVATE 字样） |
| 部署脚本 | `scripts/cloud-init-secrets.mjs`、`scripts/cloud-serve.mjs`、`scripts/stack-local.mjs` | 新部署生成 `account-device-ca.pem`、`signer-keys.json.account_device_ca`（kid `acct-ca-<env>-<id>`）；cloud-serve 认这一项（可选）；stack-local 对第 66 批之前建的本机栈补一把 |
| 控制面 | `services/control-plane/src/server.ts`、`accounts.ts`、`usage-ledger.ts` | 见 §2～§4；`accounts.ts`：`LoginRecord`/`AccountRecord.logins`、`coarseNet`、`PERSONAL_DEVICE_HARD_CAP=20`、`PERSONAL_DEVICE_NUMBER_MAX=999`、设备编号可到 `_D999`；`usage-ledger.ts`：`UsageQuery.before` |
| 控制台 | `apps/console/pages/plans.js`、`firm-overview.js` | 套餐“每账号设备数 / 电脑数”标“仅多人律所”，并说明个人账号的硬上限 |
| 出站登记 | `packages/egress-gate/src/cp-relay.ts`、`docs/privacy/egress-paths.json` | `/^\/v1\/auth\/devices\/enroll$/`；`/^\/v1\/quota\/usage\?(?:before=<ISO>&)?limit=\d{1,3}$/`（只许这一种查询串） |
| 内核 | `services/onboarding.ts` | `needs_device_auto` 自动登记（§5）；`onboarding.device_confirm`（短信确认后重试）；新电脑编号正则放宽到 `_D999` |
| 内核 | `devices.ts`、`migrations/0074_v40_account_device_ca.sql`、`ledger-signer.ts`、`api/index.ts`、`control-plane/governance.ts`、`control-plane/client.ts`、`config.ts`、`index.ts`、`account-session.ts`、`services/qa-chat.ts` | 第二信任锚只进**本机**验证点（暂存入组、本机账本证书链、本机审批证明、删除回执）；设备目录跳过 account_ca 证书；创始设备登记时上传律所公钥包；`quota.usage_page`；`QuotaView` 追加字段；文案个人口径 |
| 日志 | `packages/safe-log/src/events.ts` | `KERNEL_ONBOARDING_AUTO_ENROLLED`、`KERNEL_ONBOARDING_AUTO_ENROLL_FAILED{reason}` |
| 桌面端 | `src/api.ts`（只追加） | `QuotaStatus.personal / own_models / plan.{note,period,burst,models}`、`UsagePageRow`、`UsagePage`、`api.quotaUsagePage()`、`AccountMe.personal / recent_logins`、`onboarding.deviceConfirm()` |
| 桌面端 | `src/components/AccountPanel.tsx`、`src/pages/Activate.tsx` | 只改设备部分：“我的电脑”→“登录过的电脑”，去掉“最多 M 台”，“解绑”→“移除这台电脑”，新增“最近登录”；激活页个人账号自动登记的完成文案与“短信确认是本人”页 |
| 桌面端 | `src/lib/account.ts`、`src/lib/firm-usage.ts` | 设备状态“已解绑”→“已移除”；`quotaLawyerLine` 改个人口径（优先 `personal`，旧云端回退 own）、试用/开发句子改“你的用量” |
| 用例 | `services/control-plane/test/b66-personal-devices.test.ts`（新）、`packages/kernel/test/b66-personal-auto-enroll.test.ts`（新）、`packages/kernel/test/cloud-cp.ts`（加 `accountCa` 选项） | 见 §7；旧用例里随文案改动的断言：`apps/desktop/test/batch9-lib.test.ts`、`b44-account-usage.test.ts`、`b46-client-polish.test.ts`，`packages/kernel/test/b46-client-polish.test.ts`、`b47-qa-model-choice.test.ts`、`b52-cloud-connection.test.ts` |

未动：`Composer.tsx`、`Home.tsx`、`ScenarioStart.tsx`、`Chat.tsx`、`Deliverables.tsx`、`Sidebar.tsx`、`PersonalUsage.tsx`、`Connections.tsx`、任何 `.css`、`lib/scenarios.ts`、`Matter.tsx`、`RunView.tsx`、`lib/quota-notice.ts`、`lib/start-block.ts`。`server.ts`、`api/index.ts`、`cp-relay.ts`、`egress-paths.json`、`signer.ts`、`cp-signer/index.ts`、`client.ts` 与模型目录代理共改：每次按锚点就地追加，没有重排它的段落（`/v1/models`、`kwl-model-catalog` 原样保留）。

## 2. 个人租户：定义、标记与存量迁移

- 定义：租户只有 **1 个账号且为管理员**、没有别的成员的设备、没有未撤的成员邀请（账号自己的认领不算）——`personalShape(t)`。
- 标记 `TenantRecord.personal`：自助注册（`createTenant createdVia:"self"`）时置 true。每次用到时（`personalOf`）复核形状，**不成立即永久转回 false**（发了成员邀请、运营给这家律所加了第二个账号、出现别的成员设备），之后新电脑恢复“另一台电脑批准”。
- 存量迁移（`applySnapshot` 读回时，一次性、幂等）：没有 `personal` 字段的租户，`created_via === "self"` 且 `personalShape` 成立 → true，其余（运营开通、多人、发过邀请）→ false。
- 自动登记的前提 `autoEnrollReady(t)`：签名者有账号设备签发钥 **且** 个人租户 **且** 律所根已登记 **且** 有律所公钥包。任一不满足 → 照旧走 `needs_device_join` / `device_limit`（平滑回落）。
- `account_device_ca {kid, public_key_pem, since}`：个人租户开通（`/v1/enroll`）、创始设备登记或首次自动登记时记下；之后 `/v1/devices/register` 对 account_ca 证书按它验（租户转为团队后已登记的个人电脑照常能登记，但不再新签）。
- `firm_bundle`（恢复托管公钥 + 律所根签名，公开数据）：新开通由 `/v1/enroll` 一并上传；**存量回填**两条路：① 读回时从已批准的入组申请里取（批准时留过一份）；② 创始电脑每次 `/v1/devices/register` 都带 `firm_bundle`（内核 `client.ts` 新依赖 `firmBundle()`，按律所根签），控制面验签后存（已有不覆盖）。所以存量个人用户**升级创始电脑客户端并联网一次**之后，新电脑才能自动登记；在那之前回落为批准流程。

## 3. 设备接口（控制面）

- `GET /v1/meta`：有签发钥时 `features` 追加 `device_auto_enroll`、另带 `account_device_ca: {kid}`；没有签发钥时两者都不出现（旧字段集不变）。
- 登录 / 注册的 `onboarding`：个人租户新电脑 → `{ state: "needs_device_auto", tid, firm, member, devices_used, device_limit: 20, personal: true, device_id }`（网页登录不给 device_id）。编号沿用 `dev_<所>_<成员>_D<n>`，n 取第一个从未用过的，至多 999。
- `POST /v1/auth/devices/enroll`（会话鉴权 `x-kwl-session`）：请求 `{ device_id, sign_pub, enc_pub, proof, client, phone?, sms_code? }`。核对：自动登记条件、会话是桌面会话且**尚未绑定设备**、会话 **10 分钟内**新建、编号等于预分配的下一个、公钥合格（Ed25519 / P-256 + X25519）、`deviceEnrollProofBytes` 持有证明。风控（§6）。硬上限滚动吊销（§6）。签 365 天证书（issuer=account_ca，P-256 设备写 signAlg）→ 直接登记设备（`client_version`、报到日）→ 会话绑定这台 → 记登录 → 告警 `new_device` → 审计 `device.auto_enroll`（滚动吊销另记 `device.auto_revoke`）。应答 = 签名信封 `kwl-device-enroll`：`{ tid, issued_at, device_id, cert, root_public_key_pem, firm_bundle, ca:{kid, public_key_pem}, rotated:[…] }`。错误码：`device_auto_unavailable`(409)、`session_not_enrollable`(409)、`session_not_fresh`(401)、`device_id_mismatch`(409)、`device_keys_invalid`/`proof_invalid`(400)、`device_enroll_hold`(403，附 `reason: burst|multi_region`、`sms_available`、`phone_masked`)、`sms_phone_mismatch`/`sms_code_*`(400)、`signer_unavailable`(503)。
- `GET /v1/auth/me`：追加 `personal`、`recent_logins`（最近 5 次：`at, kind: login|enroll, device_id, platform, version, net`），`devices[].issuer`。
- 移除这台电脑：沿用 `POST /v1/auth/devices/:id/unbind`（密码 → 吊销证书 + 撤该设备会话），不改。
- 团队功能只认律所根：`requireAdmin` 拒 `issuer=account_ca`（`firm_root_device_required`）——覆盖发邀请、批准/拒绝入组、草稿与发布策略/连接器、设律所上限；`adminCheck`（管理员门限签名）、入组批准接口仍只按律所根验。

## 4. 个人额度接口

- `GET /v1/quota`（设备签名，`kwl-quota-view`）**不改已有字段**，追加：
  - `personal: { used_ratio, remaining_ratio, limited_by: "allowance"|"cap"|"burst"|"seat"|null, paused: 同上|null }`。`availability(q, ctx, sid, uid)` 折算；分母 = 个人上限（设了或套餐对个人生效）> 单席位律所的本期总额度 > 每席位额度；`remaining_ratio = min(1, avail/分母)`；`limited_by` = 可用量低于分母时卡住的那项；`paused` = 律所层面暂停原因，否则本人已无可用时为卡住的那项（与 `PersonalUsage.tsx` 的 `paused?: string|null` 约定一致）。
  - `own_models: [{ alias, label, share, requests }]`：本人本期按模型（份额按 token，与 `/v1/me/usage.by_model` 同口径），不含金额。
  - `plan: { id, label, note, period, burst, models }`：`models` 是**显示名数组**（`modelCatalogBody` 与模型目录同源，按套餐别名过滤；目录取不到时用路由登记的 label）。不下发金额与单价。
- `GET /v1/quota/usage?before=<ISO>&limit=<1..100>`（设备签名 + 会话，同 `/v1/quota`；信封 `kwl-usage-page`）：`{ tid, uid, issued_at, rows:[{ at, kind, alias, label, tokens_in, tokens_cached, tokens_out, charge_ratio, outcome, partial, estimated, pending, in_period }], next_before }`。只含证书成员本人的行，往前至多 180 天，不含金额与请求内容。查询串在设备签名之内（改了即 401）。
- 内核：`quota.usage_page({ before?, limit? })` → `{ mode, rows, next_before }`（`client.quotaUsagePage` 验信封、tid 与 uid）；`quota.status` 原样透传新字段。

### `api.ts` 用法（桌面端）

```ts
const q = await api.quotaStatus();
const used = q.personal?.used_ratio ?? personalUsedRatio(q);     // 旧云端回退
const left = q.personal?.remaining_ratio;                          // 0..1
const why  = q.personal?.paused;                                   // null | "allowance" | "cap" | "burst" | "seat"
q.own_models?.map((m) => `${m.label} ${Math.round(m.share * 100)}%`);
q.plan?.models;                                                    // ["Kimi K3", …]（显示名）
let page = await api.quotaUsagePage({ limit: 50 });                // 最新一页
if (page.next_before) page = await api.quotaUsagePage({ before: page.next_before, limit: 50 });
const me = await account.me();  me.personal; me.recent_logins;     // 登录过的电脑 / 最近登录
await onboarding.deviceConfirm(phone, smsCode);                    // 自动登记被暂停后短信确认（先 account.smsSend(phone, "login")）
```

## 5. 内核与界面流程

- 待激活模式 `account.login` / `account.register` 拿到 `needs_device_auto`：存会话 → 本机生成设备密钥 → 持有证明 → `POST /v1/auth/devices/enroll`（带 `x-kwl-session`）→ 按内置控制面公钥（`ZR_CONTROL_PLANE_KEYS`）开信封 → 核对：tid、编号、证书 `issuer=account_ca` 且对信封里的签发钥验过、成员是本人、公钥是本机的、律所公钥包对律所根验过 → 写 `join-approved.json`（多带 `account_ca_public_key_pem`）与激活记录 → 请求重启（与批准后的路径相同）。返回 `{ kind:"member", next:"restart", auto:true, firm_check_code }`。
- 重启时 `applyStagedJoin` 用 `verifyDeviceCertificateAny` 验暂存证书，落 `firm_identity`（含签发钥公钥，迁移 0074）与设备行。
- 本机验证点接受第二锚：本机账本证书链（`ledger-signer` 链核对）、本机审批证明（`certVerifying` / 证明包 `certChainValid`）、删除回执留档证书。**团队路径不接受**：`member-log`、`sync-engine`（团队密文同步）、设备目录（account_ca 证书直接跳过，不进本机设备表、不告警）、目录预吊销、公钥变更核对、设备恢复文件导入、整机恢复包——仍只按律所根。
- 被风控暂停：返回 `next:"sms_confirm"`（附原因与能否短信）；激活页显示“确认是你本人在登录”：手机号 + 验证码（`account.smsSend(phone,"login")`）→ `onboarding.deviceConfirm` 重试（沿用同一对设备密钥）。没绑手机号或短信不可用时只说明办法。
- 界面：`AccountPanel`“登录过的电脑”（个人账号说明“换电脑直接登录、各机资料独立”）、“移除这台电脑”（对话框文案按个人/团队区分）、“最近登录”（时刻、哪台、平台、网段）；`Activate` 完成文案“这台电脑已登记为你的电脑，正在打开…”。

## 6. 安全分析与补偿控制（D-292 / D-293）

- **放开了什么**：只对个人租户，控制面（经签名服务的账号设备签发钥）可以签设备证书，且不再有人核对 12 位核对码。
- **最坏情况**：控制面或签名服务被攻破 → 可给个人账号签一台“新电脑”。能得到：用该账号的 AI 额度、看云端账号信息。**拿不到**：任何案卷（个人工作区各机独立、事项密钥只包给本机设备，新电脑没有旧电脑的事项密钥）、律所根私钥、恢复私钥。账号会话被盗同理（与原来“有会话即可用额度”相比，增加的是“可以多一台电脑”）。
- **补偿控制**：① 团队功能只认律所根证书（控制面 `requireAdmin`、`adminCheck`、入组批准；内核设备目录、成员日志、团队同步）——多人律所的“云端不能冒充成员收团队案卷密钥”不变；② 新电脑登录提醒（审计 + 本所告警 `new_device` + `recent_logins` + 界面）；③ 风控暂停：24 小时内已自动登记 3 台、或 1 小时内 ≥3 个网段 → `device_enroll_hold`，须短信验证码；④ 吊销即时生效照旧；⑤ 签名服务逐项核对设备证书申请并记签名账（可审计每一张 account_ca 证书）；⑥ 会话须 10 分钟内新鲜且尚未绑定设备（一个会话只能登记一台）；⑦ 签发钥与信封钥、席位钥分开，可单独轮换/停用（停用即回落批准流程）。
- D-293 风险：盗号者反复登记新电脑挤掉真主人的旧电脑——先被 ③ 拦住；被挤掉的电脑本机资料不删，重新登录即可再登记。

## 7. 用例结果

- `services/control-plane/test/b66-personal-devices.test.ts`：**6/6 通过**——个人租户自动签发（含编号、证明、信封、证书锚区分、移除即时生效、account_ca 设备发邀请被拒、新设备提醒、`/v1/auth/me` 最近登录）；发邀请后转团队、仍须批准；硬上限 20 台滚动吊销最久未用的（审计 `device.auto_enroll`+`device.auto_revoke`，编号 `_D21`）；24 小时第 4 台暂停、短信手机号不符拒绝、多网段暂停；`/v1/quota` 新字段与按 uid（别人的请求不计入）、`/v1/quota/usage` 翻页（2+1 条、next_before、闸门白名单认内核查询串、改查询串 401）；签名者核对规则。
- `packages/kernel/test/b66-personal-auto-enroll.test.ts`：**1/1 通过**——真实控制面 + 两个数据根：第二台 `account.login` 即 `next:"restart", auto:true`，重启后已登录、登记 ok、席位 accepted、不持律所根、`audit.verifyChain` 通过（账本证书链按签发钥核）、`account.me` 两台与 enroll 记录、第一台同步目录不报证书无效、`quota.usage_page` 空页与参数校验、`quota.status.personal`。
- 控制面、签名服务、出站闸门（含 egress-paths 登记）、firm-trust、keys（含 KP-02 签名者表面门禁）全部用例：367 个里第一轮 2 个失败，都是 `staff-console.test.ts` 对 `/v1/meta` 做整对象比较、多出 `account_device_ca: null`——已改为**只在配置了签发钥时**才带这个字段；复跑 `staff-console` + `b66` 15/15 通过，其余 365 个第一轮即通过。
- `apps/desktop/test/*.test.ts`：**564/564 通过**。
- 相关内核用例（b66、b44-account 批准流程回落、b46/b47/b52 文案、b63 手机登录、b47-account-disabled、privacy-residency、cp-migration）：45 个里 44 过；唯一失败是 `privacy-residency`“渲染存储”门禁——`apps/desktop/src/pages/Home.tsx` 用了未登记的 localStorage 键 `kwl.home.lastMatter`，属主会话的改动（本批没碰 Home.tsx），需在存储登记表补登或改键。
- 类型检查：`tsc -p tsconfig.check.json --noEmit` 与 `apps/desktop` `tsc --noEmit` 均 0 错误。

## 8. 未做与风险

- **短信二次确认**：已实现（复用验证码登录的 `login` 用途与 `consumeSmsCode`），但只在“账号已绑手机号且短信通道可用”时可用；没绑手机号的账号被暂停后只能等 24 小时窗口过去或联系客服（界面写明）。没有单独的“设备确认”短信模板，短信文案是登录验证码。
- “短时多地”没有 IP 地理库：按**网段**（IPv4 前两段 / IPv6 前两组）近似，`recent_logins` 只给网段，不给城市。控制面在反向代理后时 `remoteAddress` 是代理地址（与现有 `sourceOf` 同一限制）——生产要先让代理传真实来源再启用这一条判断的意义。
- **签发钥轮换**：租户只记一把 `account_device_ca`；换钥后旧 account_ca 证书在 `/v1/devices/register` 验不过（那些电脑需重新登录）。要无感轮换需改成多把并存，未做。
- **恢复包**：account_ca 电脑生成的整机恢复包 / 设备恢复文件，在 `onboarding.restore`、`recovery.import` 仍按律所根核证书，会被拒（这类电脑直接重新登录即可得到新证书；本机数据从备份恢复的路径未打通）。
- 存量个人用户：须**创始电脑升级并联网登记一次**补传律所公钥包后才能自动登记（读回时能从已批准入组申请回填的除外）；之前回落为批准。
- 生产签名服务配置须加 `keys.account_device_ca`（`cloud-init-secrets` 新生成的有；已部署环境要运维补一把并重启 cp-signer 与控制面）。没加时功能关闭、行为与之前完全一致。
- `personalShape` 每次按全部账号扫描：运营账号列表对每个账号算一次，账号数上万时是 O(N²)（毫秒到百毫秒级），未加索引。
- 未在 Windows 真机、未在真实云端联调；`AccountPanel` / `Activate` 新界面未经浏览器走查。

## 9. 本机联调怎么验（审计 D.3 第 4～5 条）

1. 按 D.2 拉起本机栈（`node scripts/stack-local.mjs --dir "$STACK" …`）。第 66 批之前建的 `$STACK` 会自动补一把账号设备签发钥（写 `init/secrets/account-device-ca.pem`、改 `init/public/signer-keys.json`）；`curl -s http://127.0.0.1:18401/v1/meta` 应见 `"device_auto_enroll"` 与 `account_device_ca.kid`。
2. 工作区 1（WS，5173/7720）：注册个人账号 → 开通 → 进入工作区（创始电脑首次同步即上传律所公钥包）。
3. 工作区 2（WS2，新空目录，开发桥换 7721/5175）：同一账号登录 → 应直接显示“这台电脑已登记为你的电脑，正在打开…”并进入工作区，无“等待批准”、无核对码。
4. 工作区 1：设置 → 账号与团队 → “登录过的电脑”出现第二台（没有“最多 N 台”）、“最近登录”有“新电脑登记 · macOS · 网段 127.0.x.x”；控制台本所概览告警有“新电脑登录”。点第二台“移除这台电脑”→ 输入密码 → 工作区 2 下一次联网进入退出模式（席位令牌失效）。
5. 风控：同一账号再连开 3 个新工作区登录 → 第 4 个出现“确认是你本人在登录”；账号绑过手机号且短信可用时（本机栈可开短信测试模式）收码确认后继续。
6. 套餐与用量：工作区里发几次问答 → `/v1/quota` 的 `personal.used_ratio` 与“套餐与用量”页一致；`quota.usage_page`（开发桥 `/invoke`）条数与账本按 uid 过滤一致；翻页 `next_before` 可用。
