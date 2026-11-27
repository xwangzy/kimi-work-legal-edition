# impl-K 内核进度（第 73 批，W2）

- 范围：`packages/kernel/**`、`packages/egress-gate/**`（白名单）、`packages/safe-log/**`（事件登记）、`docs/privacy/**`；产物经 `npm run build:kernel` 重建。未提交（按要求不 commit）。
- 状态：契约 2.1～2.6 全部实现（已随 8665838f 提交）；之后按协调方“补四项”再改（未提交，见文末“补四项”）；新用例 `packages/kernel/test/b73-team-matters.test.ts` 5/5（含 W1 的真实 `/v1/team/roster`）；回归 544/544；`npx tsc -b tsconfig.check.json` 干净；`npm run build:kernel` 已跑。
- 契约只加不改的细节已写进 `03-契约变更记录.md` 第三行（W3 请据此补 `api.ts` 类型）。

## 改了什么（文件）

| 文件 | 内容 |
|---|---|
| `packages/kernel/src/services/team-roster.ts`（新） | 名单答复校验（只认本租户、成员编号 `usr_<tid 去 ten_>_<member_slug>` 与控制面 `uidOfAccount` 同式、不认识的状态按 disabled、只留四项）、连不上 / 旧云端判定、封装缓存 `keys/team-roster.json` 读写（经 `writeStagedSecret`，kwl-sealed/1） |
| `packages/kernel/src/services/share-relay-policy.ts`（新） | 开通底稿 = 当前生效规则 + `share_relay: allow`（其它项原样）、草稿内容比对、剩余天数、到期前 7 天、状态四态、签名人按成员计 |
| `packages/kernel/src/control-plane/governance.ts` | `latestPolicyDoc()`：最后一份已接受的策略原文（续期按它原样重签） |
| `packages/kernel/src/api/index.ts` | 新方法 `team.roster`、`matters.members.list`、`firm_policy.share_relay_status / enable / renew`；`matters.create` / `matters.update` / `matters.members.add / remove` 加固；`kernel.status.share_relay_expiring`；团队成员管理动作后作废内存名单 |
| `packages/egress-gate/src/cp-relay.ts` + `test/cp-relay.test.ts` | 白名单加 `^\/v1\/team\/roster$`（只 GET、不带查询串与子路径的反例用例） |
| `packages/safe-log/src/events.ts` | `KERNEL_TEAM_ROSTER`（fetch_failed / cache_used / invalid / cache_failed + 原因代码）、`KERNEL_SHARE_RELAY_POLICY`（enable / renew、published / pending_second_signature、签名数与门限） |
| `docs/privacy/egress-paths.json` | 控制面通道登记新路径与说明 |
| `docs/privacy/residency.json` | 第 29 类补同事名单（数据、落盘 `keys/team-roster.json` 封装、网络、日志、残余）、强制点 `team-roster.ts writeRosterCache`、用例；`devices.ts` 写盘点说明与所属类加 29 |
| `packages/kernel/test/firm-node.test.ts`、`im.test.ts` | 原先建 strict（L3b）的团队事项来测节点门禁 / IM 卡片——D-307 后内核拒绝，改为断言拒绝 + 用个人 strict 事项照样测原门禁 |

## 方法与最终参数 / 应答

### 2.1 `team.roster`（律师可调，无参数）
`{ available, reason?: personal_workspace | offline | not_supported, fetched_at: string|null, members: [{ user_id, member_slug, name, role, status, can_receive, is_me }] }`
- 账号工作空间才去取（旧律所体系 / 没接控制面 → not_supported）；本机记的是个人空间 → personal_workspace（不联网）；云端 403 `team_only` 也按 personal_workspace；`/v1/meta.features` 没有 `team_roster`、404、闸门 `cp_path_not_allowed` → not_supported。
- 连不上（cp_unreachable / cp_timeout / cp_tls_* / gate_* / 5xx）或答复不合格 → 缓存（内存 → 磁盘），`available:false, reason:offline`；会话失效等其它错误照常抛（账号层已提示重新登录）。
- `can_receive`：本人 = `device_issuer === firm_root`；别人 = 本机设备表里有在用、未墓碑、非节点的电脑（本机设备表只收律所根签的证书）；非 active 一律 false。
- 内存名单 60 秒内复用；管理员移出 / 停用 / 改角色后作废。

### 2.2 `matters.create`（扩展）
- 新参数 `collab_scope`、`members: [{ user_id, matter_role: editor|viewer }]`（本人略去、去重、≤100；personal 带 members → 422）。
- team 前置不满足 → `team_scope_unavailable`（409），`detail.reason`：personal_workspace / workspace_unknown（账号工作空间而本机没记下类型且取 `/v1/auth/me` 也取不到）/ device_not_confirmed / client_no_cloud（strict 或 consent refused）。
- 名单核对在建事项之前：账号工作空间里每人须在名单里且 active，否则 `member_not_in_team`（detail.user_id + reason not_in_roster/disabled/removed/left）；名单取不到也没缓存 → `roster_unavailable`。
- 建事项、genesis、逐个加人（`addOrUpdateMember`，负责人设备签名的成员事件）在**同一个事务**里；`users.display_name` 写名单里的真实姓名。
- 应答（team 时）加 `members_added: [{ user_id, name, matter_role, devices_wrapped, can_receive, lawyer_note }]`。

### 2.3 `matters.members.list { matter_id }`（须有读权限）
`{ matter_id, collab_scope, my_role, is_owner, can_manage, relay_controller, members: [{ user_id, name, matter_role, can_receive, departed, is_me, added_at }], sync }`
- 不列节点服务成员；负责人在前、再按加入时刻。`name` 先用名单、再用本机记的姓名。`departed` = 名单（现取或缓存）里 status 非 active。
- `sync`：没有中继服务 / `blocked=not_configured` → not_configured；`not_allowed` 如实；其它 blocked（退出模式等）→ unknown；最近一次收 / 发的错误是连不上类且晚于最近一次成功 → unreachable；团队事项在 `relay_outbox` 有积压或本机还没经中继收发过它 → pending；否则 ok。
- `can_manage` = 负责人 && 中继控制成员不是别人 && 没有 `owner_unverifiable` 告警 && 事项进行中。

### 2.4 `matters.members.add / remove`
- add：门禁顺序不变（refreshChain → 负责人 → 中继控制成员 → 无告警 → 进行中）；之后账号工作空间里核名单（现取 30 秒内复用，连不上用缓存，缓存也没有 → `roster_unavailable` reason offline / not_supported）；改角色同样要在名单里 active。应答加 `name`、`can_receive`、`lawyer_note`（团队事项按“他的电脑还不能接收 / 所内开通同事之间同步后才收到 / 同步后能打开”三种说；个人事项写明只在你电脑上）。旧律所体系照旧不核名单。
- remove：不变（移出即轮换）；应答加 `name`、`lawyer_note`：“已把 X 移出这个事项：他的电脑拿不到此后的新内容；已同步到他电脑上的不会被收回”。

### 2.5 `matters.update` 的 `collab_scope`
- 只有负责人能改（非负责人 403“只有事项负责人能改“谁能看到””）；personal → team 走 2.2 同一前置（按本次 patch 后的密级 / 同意状态判 L3b）、须进行中；成功即在本机**立即锚定成员链**（原先等首个同步周期，期间加人走不上链的旧路径），应答带 `lawyer_note`；team → personal → `scope_irreversible`（409，reason team_to_personal）；同值视为没有变化。
- **核实 V46 10b**：“matters.update 改 collab_scope 返回无可更新字段”是调用方参数问题——把 `collab_scope` 放在了顶层（应放 `patch` 里）。现在这种调用回 422 `reason: patch_missing`、说明要放 patch（用例覆盖）。

### 2.6 同事之间同步的开通与续期
- `firm_policy.share_relay_status`（任何电脑可调）：`{ relay_configured, state, expires_at, days_left, expiring, can_manage, threshold, signatures, pending, carry_relaxations: { enable, renew }, fallback_reason, policy_version }`；管理员电脑另取草稿找“内容与底稿逐字一致”的待签草稿（不认别的改动，防止借开通签下别的放宽 / 收紧）。
- `firm_policy.share_relay_enable { ttl_days? }`：要求管理员电脑、中继已配置；已开通直接返回；底稿 = 当前生效规则 + share_relay（过期回退时就是回退后的规则 + share_relay——不静默恢复别的放宽项）。找一致的待签草稿（没有就起草）→ 本机签名 → 签名人数（按成员）达门限即发布并同步，否则 `pending_second_signature`（lawyer_note“还需另一位管理员在自己的电脑上确认（1/2）”）。第二位管理员在自己电脑上调同一个方法即签同一份并发布。
- `firm_policy.share_relay_renew { ttl_days? }`：按最后一份已接受策略原样重签（已过期的续期即恢复那一份，`carry_relaxations.renew` 列出会一并恢复的放宽项给界面写明）；没开通 → 422 not_enabled。
- `kernel.status.share_relay_expiring`：生效策略来自控制面、允许 share_relay 且剩余 ≤ 7 天 → `{ days_left }`，否则 null。

## 用例结果

- `packages/kernel/test/b73-team-matters.test.ts` 5/5（约 4 秒）：
  1. 名单答复纯函数（本租户、成员编号、坏项、未知状态、不带邮箱手机号账号编号；连不上 / 旧云端判定）；
  2. 开通底稿纯函数（其它五项原样、比最严还严的档位也原样、比对、剩余天数、7 天提醒、四态、签名人按成员计）；
  3. 旧律所体系（律所版门限 2，两台管理员电脑，真实控制面 + 中继）：L3b 建 / 转都拒且不留事项；个人事项不能带 members；顶层字段 → patch_missing（V46 10b）；个人 → 团队即锚定且不可逆、同值不算改动；名单 not_supported；A 开通 → pending（1/2，再点同一草稿）→ B 看到待签、B 开通即签同一份并发布 → A 同步后 allowed、30 天不提醒；
  4. 旧律所体系：建团队事项同时加 B（包到 1 台）；成员视图 sync pending → 中继收发后 ok；B 拉到后 my_role editor、can_manage false；**非负责人不能改范围、不能加人**；负责人 team → personal 拒绝；移出有结果说明、新纪元；
  5. 账号体系（W1 真实 `/v1/team/roster`）：个人空间名单 personal_workspace、建团队事项拒（personal_workspace）；升级后名单含本人；**甲（account_ca 电脑）不能建 / 转团队事项**（新档案 workspace_kind 起初为 null，内核取一次本人资料补记为 team 后按证书拒）；乙的名单里甲 can_receive false、不含邮箱、缓存已写且不含邮箱；带名单外的人建事项整体失败、事项数不变；L3b 拒；建事项同时加甲（viewer、包 0 台、“还不能接收”）；成员视图 sync not_allowed；加名单外的人拒；**开通同步不收紧其它项**（先发布带两项放宽的策略，开通后生效规则 = 原两项 + share_relay）；续期 5 天 → `share_relay_expiring {days_left:5}`、规则原样；**离线用缓存名单**加人并存真实姓名、删缓存后 roster_unavailable(offline)；甲被移出团队 → 名单 removed、事项成员 departed、不能再加（removed）、负责人移出带姓名的结果说明。
- 回归（`node --test --test-concurrency=4`）：
  - 第一组 460/460：b44*、b66*、b68*、b72*（含 b72-device-share-confirm）、b73、onboarding*、member-*、device-recovery、share-relay*（17 个）、control-plane、cp-dispositions、cp-self-revoke、cp-migration、egress、privacy-residency、firm-node、im、sync、r12b*、b48-matter-folder、blobs-cipher、epochs、reminders*、recovery-drill、t17-drill、matters、e2e、w1-dispositions、offboarding-archive、sample-matter，以及 `packages/egress-gate/test/*`（含 outbound-surface、egress-paths、cp-relay）与 `packages/safe-log/test/*`；
  - 第二组 84/84：b47*、b48-ai-authorization、b51、b56-authz、b62*、b63、b64、b70、b71*、matter-archive、matter-lifecycle、matter-stage-todos、v94-b23、w1*、kernel-probes、node-authz（凡调用 matters.update / members.add / collab_scope 的都在内）。
- `npx tsc -b tsconfig.check.json`：0 错（含当时工作区里 W1 / W3 的未提交改动）。
- `npm run build:kernel`：已重建 kernel / parse-worker / egress-gate 三个产物（gitignore，不入库）；产物里有新方法与新白名单。

## 需要 W1 / W3 配合

- **W3**：
  1. 按 03 第三行补类型；错误按 `code` + `detail.reason` 分支（四个新码不在 domain FaultCode 里，是字符串）。
  2. “谁能看到”置灰判断：`kernel.status.workspace_kind === "team"` 且 `device_issuer === "firm_root"`。**注意**：刚接受邀请换到的团队档案 `workspace_kind` 起初为 null（新档案还没记，2 分钟内会话核对或第一次选团队时内核才补记）——null 时别直接隐藏整个入口，可按“还没确认”处理或先调一次 `team.roster`；内核在选团队时会自己补取。
  3. 成员页能否操作用 `can_manage`（比 `is_owner` 准：中继控制成员是别人、同步告警时负责人也不能改）。
  4. 第二位管理员的入口：`firm_policy.share_relay_status.pending` 非空且 `signed_by_me:false` 时给“确认开通 / 确认续期”，调同一个 `enable` / `renew`。过期（state expired）给“续期”，并用 `carry_relaxations.renew` 写明会一并恢复的项。
  5. `matters.update` 一律带 `patch`（`api.ts updateMatter` 已是）。
- **W1**：无阻塞。内核按 03 第二行的码分支：`team_only` → personal_workspace；`not_found` / 404 → not_supported；session_* / account_disabled → 抛出（账号层提示重新登录）。

## 补四项（8665838f 之后，未提交）

1. **sync 的回退口径**：`relay.status` 为 not_allowed 且 `policy_fallback` → `unknown`；真没开通（生效规则来自控制面、没放开）→ `not_allowed`。用例：律所版两位管理员签名开通后停用 B 的电脑（签名人不足门限 → 规则回退）→ `relay.status {blocked: not_allowed, policy_fallback: true}`、成员视图 `sync: unknown`、`share_relay_status {state: expired, fallback_reason: signers_insufficient}`；账号体系里真没开通时 `policy_fallback:false`、`sync: not_allowed`。
2. **律师层报错**（错误码不变，只改 message，原因进 `detail.reason`，带 `controller_user_id` / `controller_name`）：
   - 中继控制成员是别人：“这个事项的同事名单由某某管理：请他来加人或移出”（relay_controller_other）；规则回退：“这个事项的同事之间同步暂停了（所内的规则需要更新）：请先联网同步一次再加人…”（relay_policy_stale）；还在确认：“正在确认这个事项的同事名单由谁管理…”（relay_controller_pending）；管理者已不是负责人 / 电脑都已停用：“…请联系中软客服办理交接”（relay_controller_not_owner / relay_controller_departed）；状态异常（relay_state_broken）。
   - 对方负责同步不能降角色：“某某负责这个事项与同事之间的同步，不能改成只看（一起办）：请联系管理员”（relay_controller_role_change；律师端没有移交入口，`matterRelayHandoff` 界面无调用方）。
   - 同步告警：“这台电脑暂时确认不了这个事项的负责人是谁，现在不能加人：负责人的电脑同步一次后会自动恢复；负责人都已离所的，请联系中软客服”（owner_unverifiable）。
   - 非负责人加人 / 移出：“只有事项负责人能加人或移出同事”；成员事件在链上不成立（member-log.ts）：“这次调整同事没有生效：多半是你的负责人身份已被另一位负责人取消，请同步后再看”（conflict，`detail: {reason: member_event_invalid, why}`）；本机缺当前加密信息（内部错误）也改成人话。
   - 用例逐条断言不出现“中继 / 控制成员 / 纪元 / 包裹 / 证书 / 密钥”；旧用例里按旧原句断言的 5 处（share-relay、share-relay-r4-gate、share-relay-r5-policy-fallback、member-log-relay、member-offboarding）改按新句。
3. **D-307 补拦截**：团队共享事项 `matters.update` 设 strict 或记客户拒绝云端（变成 L3b）→ 409 `team_scope_conflict`（reason strict / consent_refused），message “这个事项已和同事一起办，经中软转送加密内容；客户要求不上云时，请为这部分工作另建一个只有我的事项”（团队共享不可改回，所以不写“全部移出后”）；拒绝在任何写入之前（策略版本不变）；设敏感（L3a）照常；只有我的事项照常可记拒绝；原本就是 L3b 的旧团队事项改别的字段不拦。**W3 注意**：RunSheet“记为客户要求不上云”在团队共享事项上会收到这个错误。
4. **FaultCode**：`packages/domain/src/errors.ts` 只加五项（teamScopeUnavailable / memberNotInTeam / rosterUnavailable / scopeIrreversible / teamScopeConflict），内核 `teamFault` 去掉类型断言、按 `Extract<FaultCode, …>` 收窄。
- 验证：b73 5/5；回归 535/535（两组合并：b44/b66/b68/b72/b73、onboarding*、member-*、device-recovery、share-relay*、control-plane、cp-*、egress、privacy-residency、firm-node、im、sync、r12b*、b47/b48/b51/b56/b62/b63/b64/b70/b71、matter-*、w1*、kernel-probes、node-authz 等 + egress-gate / safe-log 全部）；`npx tsc -b tsconfig.check.json` 0 错；`npm run build:kernel` 已重建。

## 实拍补两项（cdd366a0 之后，未提交）

1. **`team.refresh_share_state { matter_id? }`** → `{ refreshed, sync }`（sync 同 `matters.members.list.sync`）：当前是 not_allowed / unknown 且距上次控制面同步 > 60 秒才立即同步（`ControlPlaneClient.syncInFlight()` 新增：在跑就等它，不另起一次）；节流内、已开通、没配中继、退出模式都不同步；规则刚放开时后台收发一次（收件循环在不能收发时 30 秒才再看）。节流间隔可用 `ZR_SHARE_REFRESH_MS` 调（1 秒～10 分钟，缺省 60 秒；用例用 4 秒）。
   用例：没配中继 → `{false, not_configured}`；B 刚同步 → 节流内 `{false, not_allowed}`；A 发布开通后 B 在节流内仍 `{false, not_allowed}`、B 还不知道；过了间隔两次并发调用都 `{true, ok}`（第二次等第一次那次同步），B 已知道；已开通再调 `{false, ok}`。
2. **`guide.progress`**：`own_matters` 改为“我在其中、未删除的事项”（含团队共享，字段名不变）；加 `created_matters`、`shared_matters`；`latest_matter_id` 同口径。用例：B 一个没建、被 A 加进团队共享事项 → `own_matters 1 / created 0 / shared 1 / latest = 该事项`；A 的 `shared_matters 0`。
- 验证：b73 6/6；回归 536/536；tsc 0 错；build:kernel 已重建（产物含新方法）。已写进 03 第六行。

## 验收修四项 + 席位（10 号 P2-1 / P2-2 / P2-3 / P3-3；未提交）

- **P2-1 没有席位**：`ShareRelaySync` 记下最近一次申领凭据失败的原因（`credential_error`，如 `credential_no_seat`；退避期间收发仍报 `credential_backoff`），`clearCredentialBackoff()`（席位令牌变了即调，`governance.onSeatChange`）；`sync` 加 `no_seat`（凭据 `credential_no_seat`，或控制面同步席位一步 `no_seat` 且没有席位令牌）；`team.refresh_share_state` 在 `no_seat` 时按节流同步。名单成员透传云端 `seat`（`team.roster`、`matters.members.list`，旧云端 null）。用例：1 个席位的律所，B 没席位 → `relay.status.credential_error = credential_no_seat`、事项成员 `sync: no_seat`、`team.refresh_share_state` 同；有席位的 A 照常 ok；账号体系名单与事项成员都带 `seat`。
- **P2-2 被移出者这一侧**（查明的原因）：负责人移出即轮换到新纪元、整体替换中继上的读者；移出事件写在新纪元的段里，被移出者既不是读者（中继不给）也没有新纪元的钥匙（解不开），所以本机投影里一直“在册”；再写入时推送 `have` 被中继答 `not_reader`，原逻辑把“在册成员被答不是读者”当成中继状态异常（被抢先登记，复核 S11A-21），标“卡住”、6 小时重试——界面于是写“还在等第一次同步”。修法（只在内核，不改中继协议）：本机**不是负责人**而中继答“不是读者”，即记为已被移出（`relay_kv removed:<事项>`，带当时本机的最高纪元）；推送时遇到即记、这一段丢弃不重试；打开事项成员页 / `team.refresh_share_state {matter_id}` 时向中继核对（history，没记为移出的每事项至多 60 秒一次，`ZR_RELAY_PROBE_MS` 可调）。记下后：不再推送（已出的段丢弃）、写入 403 `removed_from_matter`、成员视图 `removed_me / sync: removed / can_manage:false`、`matters.get` 带 `removed_me`；又被加回（本机拿到更高纪元的包裹）自动解除。中继答错只会让本机停发，不泄露内容。本机仍以为自己是负责人（降级与移出都发生在离线期间）的仍按原先的“状态异常”处理（与被抢先登记分不开）。用例（真实中继）：A 两步把 B 降为一起办并同步、再移出；B 不知情时加材料 → A 登记新纪元 → B 推送 `removed_from_matter`、丢弃、`stuck 0`、`removed_matters 1`；B 成员视图 `removed_me / removed / can_manage:false`，`matters.get` `removed_me / can_write:false`、已有材料照常能看；B 再写被拒（律师话）；再同步不重试；A 那边没有 B 的新材料；清掉本机记号后打开成员页即向中继核对，同样如实。
- **P2-3 客户授权与数据去向**（查明的数据结构）：D-216（迁移 0072）在 `matters` 上记 `basis_source / basis_ref / basis_notice_version`（次处理者清单版本），D-225 每次记录追加审计事件 `matter.ai_authorization`（detail 明文 JSON：依据类型、出处、清单版本、四项）；授权是否有效全部经 `gate-host.authorizationStateOf`（闸门、kap 事项策略、网关摘要、内核前置、归档同一函数）按 `AI_SUBPROCESSORS.version` 核对；开始前确认卡的次处理者来自 `ai_authorization.get.subprocessors`（全局一份），“系统另外做到 / 案卷只存这台电脑”是界面写死的。改为按事项范围：`AI_SUBPROCESSORS_TEAM`（`sp-2026-11-team`）、`subprocessorsFor / noticeVersionFor / dataFlowsFor`；`authorizationStateOf` 的 `collab_scope` 改为必填（漏传即编译失败，五个调用点都补了查询列）；记录授权按事项范围写版本，授权审计 detail 加 `scope`、`data_flows`；只有我转团队共享后原授权 `reconfirm`。`matters.get` / `ai_authorization.get {matter_id}` / `runs.estimate.data_where` 给 `subprocessors`、`data_flows`。用例：团队共享事项记录即 `sp-2026-11-team / valid`、去向两条、历史带范围；只有我照旧；只有我记过授权后转团队 → `reconfirm`、开放任务估价 `reconfirm:true`、重新记录后 valid、历史两条（team 当前 / personal 旧）。
- **P3-3 只看**：`requireMatterWriter` 只看成员 → “你在这个事项里是“只看”：不能加材料或发起任务，请找负责人某某”（`reason: viewer_read_only`、`owner_name`）；`matters.get.matter.can_write`。旧用例 member-gates（2 处）、v94-b25（1 处）按新句改；member-gates 补 `can_write` 断言。
- 验证：b73 8/8；回归 609/609（含 b51 / b56 授权、matter-archive、v94-b25、member-gates、e2e、w1*、gate、approvals、send-preview 等）；tsc 0 错；build:kernel 已重建。已写进 03（W2 第五行）。

## 实拍小口径两项（未提交）

- `seat_revoked` 系列（中继凭据 `credential_seat_revoked`、控制面席位一步 `seat_revoked` 且没有席位令牌）也映射为 `sync: "no_seat"`：判定收成纯函数 `seatProblemOf`（share-relay-policy.ts），单元用例覆盖四个码与“已重新取得令牌 / 连不上”反例；端到端用例里运营收回 A 的名额后 A 的事项成员 `sync` 为 `no_seat`。
- 团队共享事项 0 位同事时 `data_flows` 不写“0 人”：“经加密同步到之后加进来的同事电脑；他们电脑上也会有材料与成果”。
- 验证：b73 8/8；回归 609/609；tsc 0 错；build:kernel 已重建。已写进 03（W2 第六行）。

## 未做 / 留给主会话判断

- A4 K6（云端移出团队不吊销设备、本机不自动移出事项与轮换）未做：现在靠成员页 `departed` 标记 + 负责人一键移出（D-308 口径）。
- 名单缓存在离开团队后仍留在该账号档案的工作区里（封装），残余已写进 residency 第 29 类。
