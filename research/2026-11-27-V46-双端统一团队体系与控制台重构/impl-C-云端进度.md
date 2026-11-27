# 第 72 批云端实施进度（impl-C）

- 11-27 开工：读契约 02 §0～§6、D-299/D-304/D-305/D-306、A3、A1。
- 收到补充范围 §8（ops 接口）。accounts.ts：AccountRecord 加 person/disabled_by/onboarding/last_workspace，email 可空，created_via 加 team_invite，accountView 可传主账号邮箱/手机号；billing.ts：PlanSpec.audience（缺省 any，validatePlan 校验）。
- server.ts 第一轮：TenantRecord.kind/member_device_policy/team_invites、TeamInviteRecord、读回定型（kind、路由纪元，迁完即写盘）、personalOf 只读 kind、autoEnrollReady 扩到 auto 团队（personalAuto 保留个人封顶 20 口径）、邮箱手机号索引只索引主账号、人与工作空间辅助函数、登录按人认证后 pickWorkspace、找回密码/改密码/绑手机/复核/解绑走主账号、/v1/auth/workspaces 与 switch、me/登录应答带 person/workspace/workspaces、meta features。
- memberRoute：/v1/me/onboarding、/v1/workspace/upgrade、/v1/team/invites*、/v1/teams/join|leave；/v1/firm/* 个人写 403 team_only、remove/role/seats assign|release/policy、停用释放席位+disabled_by、启用挡 platform_disabled、重置码改发短信、limits ≤ 套餐、requireMemberOf/requireDeviceOf；R4 合伙人不能吊销管理员；/v1/invitations 个人 409 upgrade_required。
- routing.ts：内置映射 legal/k2.6→kimi-k2.6、K2.6 scopes qa+task、说明写实、epoch（建立/迁移生成，运营修改不换）、same_upstream 置灰 + reason_text、routingView.warnings（routing.same_upstream）；server.ts：modelLabel 统一用 modelMetaOf(m).label（7 处）、用量明细 aux/purpose_label“任务辅助步骤”（计量记录没有用途字段，按 alias=legal/k2.6 且 qa=false 近似；律师主动在任务选 K2.6 时也会被标上）；ops：/v1/ops/people(+/:aid)、tenants ?kind= 与 kind/member_count/seat_used、seats/:aid/assign、upgrade-team（danger）、invites、accounts 行带 person、平台停用记 disabled_by、个人工作室不能代建成员、setPlan 校验 audience。tsc 控制面干净（packages/kernel 有他人在改的 slog 错误）。
- 网关本机兜底 legal/k3→kimi-k3.1-pro、legal/k2.6→kimi-k2.6（gateway.test.ts 两处期望 kimi-k3 改为 kimi-k3.1-pro，理由：D-299 三处同口径）；网关不改思考参数（客户端 model-broker 按 toggle 发 thinking、effort 发 reasoning_effort，网关原样转发、只换 model），legal/k2.6 改指 kimi-k2.6 后 thinking 参数终于发到支持它的上游；部署模板、cloud-serve.mjs 注释、stack-local.mjs（新增 --model-k26，缺省 kimi-k2.6）同口径；cloud-repo/template/package.json 1.7.0。网关用例 57/57 过。
- 原有用例因口径变化改期望（逐条理由）：
  - b44 凭邀请码注册成员、b54 两条、b68 两条、b69 团队成员换 9 台：自助注册的个人工作室发 /v1/invitations 现在 409 upgrade_required（契约 §3.1 取消悄悄转团队）→ 发邀请前加 toTeam（就地升级同名 + 成员电脑策略 approve，保持这些用例要验证的“管理员批准”流程；团队缺省 auto 是 D-304）。
  - b44 API 路由：bootstrap 期望 legal/k2.6 → kimi-k2.6（D-299 真实映射）。
  - b66 目录两条：K2.6 scopes 期望 qa+task（D-299 第 2 条）；目录项键多 reason_text（契约 §5 置灰说明）。
  - b66 团队租户仍须批准：改为先断言个人发邀请 409 upgrade_required 且 kind 不变，再升级 + approve 后验证 needs_device_join 与自动登记拒绝。
  - b71 开通两家客户：用例直接把运营开通的租户改成个人，原先只改 personal 布尔，现在类型是显式 kind，改为同时设 kind（后两条是它的连锁失败）。
  - staff-console 本所接口：电脑上限 3 > 套餐 2 现在 400 device_limit_over_plan（A3 R1），改为 2 并补断言；重置码不再回明文（A3 R3），无手机号回 409 phone_unbound，改用运营重置码完成后续改密；“账本 partial”是它的连锁失败。
  - 网关 gateway.test.ts：本机兜底 legal/k3 期望 kimi-k3.1-pro。
- 邀请码限流改为只计核对失败（10 次 / 10 分钟 / 来源）：成功接受不是枚举；契约写“来源限流 10 次 / 10 分钟”未区分，记入契约变更记录。
- 新增用例：test/b72-workspaces-teams.test.ts 19 条（契约 §6 1～11、A3 X1～X9、§8 运营接口、R1～R5）全过；test/b72-model-catalog-epoch.test.ts 4 条（真实映射、同上游置灰与告警、纪元迁移、读回定型 kind/纪元即写盘且重启不变）全过。
- 03-契约变更记录.md 追加 C-1～C-12。
- 主会话否决 C-8：撤掉逐请求记录的 aux / purpose_label 近似字段（by_model 照实按模型汇总），b72 用例改为断言没有这两个字段；03 的 C-8 行已补注。
- 收尾：全量 node --test services/control-plane/test/*.test.ts 211/211 过；网关 57/57；内核用到账号签发钥的 3 个用例 6/6 过；tsc -b tsconfig.check.json 0 错；运维手册 v1.7.0 行、verify-capabilities.sh 另核 5 项。

## 安全审查处置（09-安全审查.md，11-27；基于 92f32673 + 主会话两处小改动，未提交）

- **P0-1** 移出不覆盖平台停用：`removeMember` 改为 `disabled_by !== "platform"` 时才写 team（退出团队同一函数）；启用照旧拒 `platform_disabled`。用例：b72-security「P0-1：平台停用 → 团队启用 403 → 团队“移出”不覆盖平台停用…」。
- **P0-2** 设备签名管理权限按有效角色：新增 `effectiveRoleOf(t, dev)`（账号存在时取证书角色与账号当前 role 的较低者；账号非 active 或这个人被平台停用 → 403 `account_disabled`；没有账号的历史成员看证书）。`requireAdmin` / `requireRevoker` 改签名为 `(t, dev)`，全部设备路由（`/v1/invitations*`、`/v1/join-requests*` 审批与列表、`/v1/audit`、草稿 / 策略 / 连接器、`/v1/quota/cap`、`/v1/devices/:id/revoke`、`/v1/seats/:uid/revoke`）一并生效；合伙人不能吊销管理员按有效角色与账号当前角色判；`/v1/quota` 的按成员明细按有效角色；新收的管理员签名（草稿签名、发布）用 `adminCheck(..., strict)` 排除已停用 / 已非管理员的电脑（已发布文档的历史签名不变）；`requireDeviceMemberActive` 让停用 / 移出成员的电脑取不到 `/v1/license`、`/v1/seat-token`、support / notify / relay 专用凭据。设备记录不吊销（契约原样）。用例：b72-security「P0-2：被降级的管理员…被移出后不带会话的设备签名请求一律 403…」。
- **P1-1** `requireRevoker`（含 `/v1/audit` 读）拒 `issuer = account_ca`（403 `firm_root_device_required`）；读回定型时存量团队（kind 缺字段的）显式写 `member_device_policy: "approve"` 并写盘；`ops.createTenant` 开通的团队与就地升级的团队缺省 `auto`。用例：b72-security「P1-1：账号签发钥…不能读本所审计、不能吊销…」；b72-model-catalog-epoch「读回定型…」断言存量团队为 approve、个人空间不写。
- **P2-1** 读回时已停用且无 `disabled_by` 的账号回填 `"platform"` 并写盘。用例：b72-model-catalog-epoch「读回定型…」。
- **P2-2** 平台停用主账号 = 停用这个人：`personBlocked` / `memberActive`；`pickWorkspace`（任何凭证登录）403 `account_disabled`；`sessionOf` 拒这个人的关联账号会话；`personActive` 为假 → 发登录码拒绝、找回密码不发码（应答与原来停用账号相同）；运营停用主账号时撤这个人全部工作空间的会话；relogin 取手机号、设备暂停名单、有效角色同口径。团队停用主账号的成员身份（disabled_by = team）不影响其他工作空间（C-3 原样）。用例：b72-security「P2-2：团队停用主账号的成员身份不影响…平台停用主账号 = 停用这个人…」。
- **P2-3** 移出 / 退出 / 从 admin 降级时撤回他发出且未接受的团队邀请（`revokeInvitesBy`，审计 detail `invites_revoked`）；接受邀请（`/v1/teams/join`、注册带 `team_invite_code`）时邀请有 `phone_hint` 即核对接受人主账号手机号末 4 位，不符或没有手机号 → `invite_invalid`（计入失败限流）。用例：b72-security「P2-3：从管理员降级时撤回…」「P2-3：邀请带手机号提示时…」。
- **P2-4** `/v1/firm/members` 与 `/v1/firm/usage/summary` 的成员邮箱改为打码（`maskEmail`）；团队邀请新建的成员身份（关联账号与凭邀请注册的主账号）`member_slug` 用随机串 `u` + 6 位十六进制。设备签名的 `/v1/join-requests` 列表（管理员电脑）仍给原邮箱（不在本条范围，且第 44 批用例依赖；如需一并打码请拍板）。用例：b72-security「P2-4：…」；b72-workspaces-teams「契约 §6.2…」改断言打码邮箱与随机成员标识。
- **P2-5** 运营重置码对关联账号作用于主账号，审计在主账号所在租户（target = 主账号）与团队租户各记一条；运营“启用”关联账号时解锁作用于主账号的失败计数，并在主账号租户记 `account.unlock`。用例：b72-security「P2-5：…」。
- **P2-7** 团队侧 `enable` 对已是 active 的成员为幂等空操作（`unchanged: true`），不清零失败计数。用例：b72-security「P2-7：…」。
- 原有用例改动：b72-workspaces-teams 两处（乙的邀请不再带 phone_hint、另起一张验证只存打码；成员行断言打码邮箱与随机成员标识）。
- 结果：控制面全量 221/221 过（新增 test/b72-security.test.ts 10 条）；内核里用 cloud-cp 的 8 个相关用例文件 42/42 过；`npx tsc -b tsconfig.check.json` 0 错。

## 验收 Q 处置（10-真实端到端验收.md，11-27；未提交）

- **Q-1** 电脑“最近使用”取真实活动：`server.ts` 新增内存里的 `sessionSeen`（会话核对，2 分钟粒度）与 `deviceSeen`（设备签名请求：`authDevice` 与 `/v1/devices/register`），`usage-ledger.ts` 加 `deviceLastAt`（网关计量里这台的最近一条）；`deviceLastActive(tid, device, aid)` 取三者与会话持久 `last_seen_at` 的最近者，用于同时登录选择页 / `/v1/auth/me` 的电脑 `last_seen_at`（客户端“默认预选登录中最久没用的”读的就是它）、运营电脑行与本所电脑页的 `last_active_at`；会话视图（`/v1/auth/me` sessions、运营账号详情）的 `last_seen_at` 同口径。活动不进状态比对（不为它整份写盘），随下一次正常落盘写进快照 `activity`、启动读回；持久字段 `last_seen_at` 仍按小时续写（连带空闲期续期，不变）。用例：b72-acceptance-q「Q-1：一台电脑持续有请求…」「Q-1：会话最近活动只改内存、不为它整份写盘…」。
- **Q-7** 新增 `bindSession`：会话绑到电脑的四处（账号闸 / 席位令牌、`/v1/auth/onboarding`、`/v1/auth/devices/enroll`、`/v1/devices/register` 带会话）都经它，同一账号同一电脑上的其它桌面会话以 `replaced` 收回（登录时直接绑原本就收回）。用例：b72-acceptance-q「Q-7：…」。
- **Q-5** 客户行（`/v1/ops/tenants` 与组织详情同一 `tenantRow`）`member_count` 只算 active，新增 `members_removed`（disabled + disabled_by = team 的成员身份数）；运营账号列表“未占席”不算停用 / 已移出；本所概览 `counts.members` 同口径并加 `members_removed`；人员行的工作空间项保留状态与 `disabled_by`（控制台据此不写“另在 N 个团队”）。用例：b72-acceptance-q「Q-5：…」。
- 结果：控制面全量 229/229 过（新增 test/b72-acceptance-q.test.ts 4 条）；`npx tsc -b tsconfig.check.json` 0 错。
