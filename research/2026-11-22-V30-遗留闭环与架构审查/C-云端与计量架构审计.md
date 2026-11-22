# C 云端与计量架构审计（2026-11-22）

> 只读审计。范围：`platform/services/control-plane/src`、`platform/services/legal-gateway/src`、`platform/apps/console`、`cloud-repo/template/deploy`、`scripts/cloud-serve.mjs`。行号以本工作区（含本轮未提交改动）初读时为准；审计期间主会话改动了 `server.ts`/`quota.ts`，个别行号会偏几行。
> 严重度：P0 = 已在发生的错账或越权；P1 = 正常运营路径上会出错账、丢数据或大面积不可用；P2 = 特定条件下出错或规模上去后出问题；P3 = 口径、提示、低概率。

## 一页结论

1. **计量主链路设计是对的**：单请求单编号、重试与跨上游只计一次、预写发件箱 + 偏移检查点 + 控制面按编号去重、按记录里的价目版本重算、partial 不扣额度只记成本。没找到 P0 级的多计 / 漏计。
2. **账单是“每次现算”的，这是最大的计费风险源**：历史月加量费恒为 0、席位与套餐按当前值（1-A，主会话已在改，修法还有一个时序漏洞，见复核意见）；迟到回报改写已出账月份（1-B）；回滚恢复会丢账本（8-A）。
3. **控制面的结构性隐患是“每请求全量序列化 + 全局回滚”**：GET 也全量 stringify，写请求三次全量序列化 + 同步 fsync（3-A），网关健康回报每 15 秒白写一次（3-F），已关闭租约保留 7 天且本轮 `releaseIdle` 让租约条数随请求量线性涨。全局回滚会误伤并发请求的未落盘改动并“假成功”（2-A），目前没找到会出错的具体写路径，但任何新加的 `await` 都会踩中。
4. **稳定性一处会放大故障**：429 计入熔断，单上游部署下 3 次限流 = 全平台 30 秒“没有可用的上游”（6-A）。
5. **租户隔离与权限扎实**：设备接口租户取自验签证书、成员接口取自会话、跨所 404、律所内 admin/partner 边界、运营固定角色表 + 危险操作复核；控制台零 `innerHTML`、CSP 严格。只有一个同类遗漏：收紧个人上限不收回在途租约（4-A）。
6. **本轮新字段前后兼容成立，不需要迁移**；只需发布说明写明“收紧即收回需网关与控制面同版本”。

**P0：无。P1：4 条（1-A、2-A、3-A、8-A）。P2：10 条。P3：若干。**

## 总表

| 编号 | 问题 | 证据位置 | 影响 | 严重度 | 估时(h) | 建议 |
|---|---|---|---|---|---|---|
| 1-A | 历史月账单加量费恒 0、席位/套餐按当前值 | `server.ts:1638-1647`（初读版）；`quota.ts:157` | 计费 | P1 | 3 | 本轮修（主会话已在改；补 setPlan/plan.upsert 先跨期，见复核） |
| 2-A | 全局回滚误伤并发请求未落盘改动、对象被替换后“假成功” | `server.ts:613-616,3879-3883`；`3315-3334`；`3269-3272` | 数据/稳定 | P1 | 4 | 本轮先加断言（`send` 时 `t===tenants.get(t.tid)`）+ 约定；根治立项 |
| 3-A | 每请求全量 stringify，写请求 3 次序列化 + 同步 fsync；关闭租约留 7 天无上限 | `server.ts:505-521,597-611,1128-1140`；`quota.ts:85,195,236` | 稳定/规模 | P1 | 1 + 4 | 本轮：保留期降到 1 天（9-A）；立项：GET 不落盘、dirty 标记 |
| 8-A | `rollback.sh --restore` 丢掉备份后的账本行与网关发件箱 | `deploy/scripts/rollback.sh:24-30`；`upgrade.sh:24`；`cloud-serve.mjs:516,647` | 计费/数据 | P1 | 2 | 本轮修（恢复后并回 `kwl.before-restore.*` 的账本，或恢复时排除账本） |
| 1-B | 迟到回报改写已出账月份（账单不冻结） | `server.ts:1477,1489,3237`；`usage-ledger.ts:337` | 计费 | P2 | 2 | 立项（出账后变动提示/调整项） |
| 1-C | 去重集合重启后只覆盖当月+上月 | `usage-ledger.ts` 构造函数、`append` | 计费 | P2 | 1.5 | 立项 |
| 1-D | 非流式缺 usage 输出记 0；估算口径未在账单写明 | `gateway.ts:554,625,667,699-701` | 计费 | P2 | 1 | 本轮修（小） |
| 3-B | 账单页租户×全部行、设备页设备²扫描 | `server.ts:1641,1651,1655,3727`；`usage-ledger.ts:338` | 稳定/规模 | P2 | 2 | 立项（随手可做） |
| 3-C | PG 快照无版本号，后写覆盖；只适合一主多备 | `pg-state-store.ts:136`；`cloud-serve.mjs:66,515` | 数据 | P2 | — | 不动代码；部署手册写死“控制面单活” |
| 3-F | 上游健康回报每 15 秒触发全量落盘 | `upstreams.ts:272-274`；`server.ts` recordHealth 处 | 稳定 | P2 | 1.5 | 立项（与 3-A 一起） |
| 4-A | 收紧个人上限不收回该成员在途租约 | `server.ts:3706-3716`；`quota.ts:284-300` | 计费 | P2 | 1 | 本轮修 |
| 6-A | 429 计入熔断：单上游下 3 次限流 = 全平台 30 秒不可用 | `gateway.ts:507-511,519`；`upstreams.ts:69,165-173` | 稳定/体验 | P2 | 1 | 本轮修 |
| 7-x | 金额/token 取整口径、前后端校验未逐页对 | `billing.ts:192-196`；`apps/console/pages/*` | 体验 | P2 | 3 | 立项 |
| 2-B | 登录改绑在最后检查前直接写审计 ok | `server.ts:2798-2813` | 数据（审计） | P3 | 0.5 | 本轮修（小） |
| 2-C | 改绑取新邀请姓名时姓名已被清空，修复不生效 | `server.ts:2807,3148` | 体验 | P3 | 1 | 本轮修 |
| 2-D | settle 落盘失败后租约 used 永久少记（偏保守、自愈） | `server.ts:3241-3242` | 计费（在途偏大） | P3 | — | 不动 |
| 1-E/F/G/H | 缓存/推理口径、跨期归属、超时成本不记、未知价目版本静默回落 | 见方向 1 | 计费口径 | P3 | 0.5–1 | 补说明；1-H 加标记 |
| 4-B/C | 改套餐一律收回全部租约；viewer 可见成本价 | `server.ts:1956-1958`；`rbac.ts:18,29` | 稳定/权限 | P3 | — | 不动 / 问商务 |
| 5-A | 邮件码只按来源限速、无按账号申请上限 | `server.ts:2823,2848` | 安全 | P3 | 1 | 立项（低） |
| 6-B/C | 4xx 清零熔断计数；订阅 15 秒窗口与无陈旧上限 | `upstreams.ts:151-157`；`routing.ts:471-477` | 稳定 | P3 | — | 不动；手册写换密钥步骤 |
| 8-B/C/D | 新字段兼容、最低版本闸 ≤96h 生效、热备份截半行 | 见方向 8 | 升级 | P3 | — | 不动；发布说明 |
| 9-A/C | 租约保留期 7→1 天；`snapshot()` 去掉二次 parse | `quota.ts:85`；`server.ts:521` | 稳定 | — | 1.5 | 本轮做 |


## 方向 1：计量与计费准确性

链路：网关 `gateway.ts:363` 预估 → `quota.reserve`（租约本地扣）→ 上游（`gateway.ts:441-517` 逐候选尝试）→ `extractUsage(tail)`（`gateway.ts:650`）→ 结局判定（`gateway.ts:664-705`）→ 先写 meter.jsonl settle 行（发件箱，`gateway.ts:756-781`）→ `LeaseQuota.settle` 入队 → 15 秒或满 100 条回报 → 控制面 `/v1/quota/settle`（`server.ts:3230-3249`）→ `rowOf` 按记录里的价目版本重算（`server.ts:1468-1517`）→ `UsageBook.append` 去重 + fsync（`usage-ledger.ts` append）→ 额度视图 / 账单都从账本出。

### 设计对的地方（核过）
- 重试与跨上游回落只计一次：一个网关请求只有一个 `request_id`，attempts 只是附带明细（`gateway.ts:403-517`），失败的尝试不产生 usage 行。
- 发件箱重放与去重：meter.jsonl settle 行带整条记录，`meter.ack` 记最小未确认偏移（`quota.ts:493-509`），重启重放（`quota.ts:325-336`），控制面按 `request_id` 去重（`usage-ledger.ts` `append` 内 `seen`）。重复发送安全。
- `cached > input`：网关 `unitsOf` 夹紧（`usage.ts` unitsOf：`Math.min(input, cached)`），控制面 `rowOf` 再夹一次（`server.ts:1470`），`chargeOf` 第三次夹（`routing.ts` chargeOf）。不会出现负数或超额。
- 价目版本切换：网关记录用请求开始时订阅里的 `prices.version`（`gateway.ts:365,732`），控制面 `priceTableOf(routing, r.price_version)` 按那个版本重算（`routing.ts:157`）。改价瞬间在途请求按旧价，口径一致。
- 流式中断（partial）：不扣律师额度，只记成本（`gateway.ts:668-705`、`server.ts:1471-1478`）；旧版控制面读到 partial 行也不会计入额度（usage 为 null，估算放 `partial_usage`）。设计周到。

### 问题
**1-A（P1，计费）历史月份账单的加量费恒为 0，席位费按“现在”的套餐与席位算。** `server.ts:1638-1647` `billRow`：`const boost = cur ? q.boosts.reduce(...) : 0;`——注释写“历史月份的加量百分比取历史行”，代码却直接给 0；`QuotaState.history`（`quota.ts:157`）也没有存加量百分比，所以确实取不到。同时 `plan: planFor(t)`、`seats: t.seats` 都是当前值。触发：11 月给某所加量 50%，12 月 1 日之后在运营或律所控制台查 11 月账单（`/v1/firm/billing?period=2026-11`，`server.ts:3783-3788`），加量费变 0、应收少了；若 12 月改了套餐或席位，11 月席位费也跟着变。修法：跨期时（`ensurePeriod`，`quota.ts:149-165`）把 `boost_pct`、`plan_id`、`seats`、`seat_price` 冻进 history 行，`billRow` 对非当前月取冻结值。约 3 小时（含用例）。**建议本轮修**（会进客户对账）。

**1-B（P2，计费）迟到回报会改写已出账月份。** `rowOf` 的 `at` 只设上限不设下限（`server.ts:1477` `Math.min(Date.parse(r.at), now()+60s)`），`day` 由 `at` 定（`server.ts:1489`），账单按 `day` 取（`usage-ledger.ts:337` monthRows）。网关停了几天后重启重放 meter.jsonl，或租约过期后迟到的回报（`server.ts:3237` 明确“仍入账”），会把行追加进上个月的文件。账单是每次现算的（不冻结），所以上月数字在出账后还会变。是否算 bug 取决于商务口径（“按发生时间”是对的），但需要：(a) 出账后变动要有提示或调整项；(b) 控制台账单页写明“截至何时”。约 2 小时（只做提示）。**立项**。

**1-C（P2，计费）去重集合重启后只覆盖当月与上月。** `UsageBook` 构造只读 `[prev, cur]` 两个月（`usage-ledger.ts` 构造函数），`seen` 也只含这两个月。一条 `at` 在两个月前的记录被重放（网关 meter.ack 丢失 + 长期停机，或手工拷回旧 meter.jsonl）会被当新行再记一次。触发条件苛刻，P2 只因为它是“重复计费”类。修法：`append` 时对 `day` 早于已载入最早月份的行，按需加载该月去重或直接拒收并告警。约 1.5 小时。**立项**。

**1-D（P2，计费口径）估算用量照常计费，非流式拿不到 usage 时输出记 0。** `gateway.ts:667` `estimated()` 输出 = `ceil(outChars/2)`，而 `outChars` 只在流式时由 `countTap` 计数（`gateway.ts:554,625`）——非流式成功但上游没回 usage（`source="estimated"`，`gateway.ts:699-701`）时输出为 0，只收输入估算，少计。反过来客户端取消（client_gone）且没 drain 到 usage 时，按 `JSON.stringify({messages,tools}).length/2` 估输入照常扣额度、计售价（`gateway.ts:682-690,705`）。中文正文 1 字约 0.6–1 token，`/2` 偏低；JSON 转义与工具定义又偏高，方向不定。界面有“估算行数”（`quota.ts:355` estimated_rows、`server.ts:3613` estimated_share）。建议：非流式也计 `completionTexts(whole)` 字数；在账单与律所用量页写明“标‘估算’的行按字数折算”。约 1 小时。**本轮修（小）**。

**1-E（P3，口径）tokens 单位下缓存输入按全额计、reasoning 不单列。** `usedIn`（`usage-ledger.ts` usedIn）与 `unitsOf`（`usage.ts`）都是 `input + output`，cached 包含在 input 里按 1:1 扣额度；cny 单位缓存按缓存价。reasoning 只记录（`usage.ts` extractUsage 取 `completion_tokens_details.reasoning_tokens`），不另计——是否已含在 `completion_tokens` 里取决于上游（OpenAI 约定是含；中软 MaaS / K3 是否如此 **未核实**）。控制台与律师端界面是否写明“tokens = 输入（含缓存）+ 输出（含推理）” **未核实**（没逐页查文案）。**不动代码，补一句口径说明**。

**1-F（P3，计费）跨期请求按结束时刻归期。** `day = dayOf(at)`，`at` 是网关结算时刻（`gateway.ts:712`），`started_at` 只存不用。月末 23:59:59 发起、次月 00:01 结束的请求记到次月；用的却是上月发的租约（上月 `outstanding` 释放、次月 `used` 增加）。口径自洽，只需写明“按完成时间归期”。**不动**。

**1-G（P3，成本对账）头超时 / 非流式超时的上游成本不记。** `header_timeout` 与非流式 `timeout` 时 `u=null, source="none"`（`gateway.ts:677,691-693`，`markPartial` 只对流式且已有输出的生效），上游可能已经算了 token。对“与上游对账”会出现我方少于上游账单的固定差。**立项（对账报表里列“超时请求数”即可）**。

**1-H（P3）价目版本不认识时静默按当前价重算。** `priceTableOf` 找不到版本（网关传了字符串版本、或版本被裁剪）回落 `currentPrices`（`routing.ts:157-159`），无告警。网关 `price_version` 类型是 `number | string`（`usage.ts` UsageRecord）。建议回落时在行上标 `price_fallback` 并计数。约 0.5 小时。

---

## 方向 2：“出错请求整体回滚”的副作用

机制：`route().catch → rollback()`（`server.ts:3879-3906`）把内存整体恢复到 `lastSaved`（`server.ts:613-616`，`applySnapshot` 会**重建整个 tenants/accounts/sessions 映射为新对象**，`server.ts:523-587`）；成功路径 `send()` 先审计再 `persistNow()` 再回复（`server.ts:1128-1140`）；运维接口包装同理（`server.ts:1016-1053`）。

### 已自行落盘、回滚不丢的（核过）
- 成员登录失败计数：`noteFailure(a); persistNow(); throw`（`server.ts:2784-2789`）；人员登录 `server.ts:2548-2554`、复核 `2658-2660`；重置码尝试次数 `2851-2853`；会话类 `2885/2915/2939` 同样先 `persistNow`（逐处看过 2885、2915、2939 三处前后均有 `persistNow`，**行号对得上的只核了 2786 与 2851 两处的完整上下文，其余三处只看到 grep 命中，未逐行核实**）。
- 限速计数（`authAllowed`、`issueWindow`、`rejectedWindow`，`server.ts:1099-1124`）在快照之外，不受回滚影响。
- nonce：回滚保留（`server.ts:612` 注释，`applySnapshot(lastSaved,false)` 不清 nonce）。
- “被拒绝”审计：catch 里另写（`server.ts:3894-3902`），审计文件不随快照回滚。
- 本轮修过的 `last_denied`：`/v1/quota/lease` 被拒时直接 `send(402)` 而非抛错（`server.ts:3224`），落盘成立。

### 问题
**2-A（P1，数据/稳定）并发请求之间的“误伤回滚”。** 回滚是全局的：请求 A 改了内存、还没 `send()`（中间有 `await`），此时请求 B 出错 → `rollback()` 把 A 的改动一并抹掉，且 `tenants` 被换成新对象，A 手里的 `t` 成了脱离的旧对象；A 随后 `send()` → `persistNow()` 发现状态与上次落盘相同、不写 → **A 回 200 但改动丢失**。代码里“改内存 → await → send”的位置（`grep "await " server.ts` 逐条看过）：
  - `/v1/quota/view`：`quotaView` 内 `ensurePeriod`/`sweepLeases`（跨期写 history、关过期租约）之后 `await seal(...)`（`server.ts:3315-3334`）。丢了也会在下次调用重做，影响小。
  - `/v1/seat-token` 等四种凭据：`accountGate` 可能“在此绑定会话到设备”（`server.ts:1173-1176` 注释）后 `await seatToken(...)`（`server.ts:3269-3272`）。丢了下次再绑，影响小。
  - `/v1/auth/password-reset/request`：`issueAccountCode` 后已 `persistNow()` 再 `await mailer`（`server.ts:2828-2831`），**安全**。
  - `/v1/auth/login`：`await optionalDevice` 在改动之前（`server.ts:2793`），**安全**。
  目前没找到“丢了就出错”的写路径，所以定 P1 而非 P0；但这是结构性隐患：任何以后在改动与 `send` 之间加 `await`（例如签名服务换成远程 KMS、`seal` 变慢）的处理器都会中招，而且现象是“偶发地操作没生效、却显示成功”，极难排查。建议：(a) 回滚改为“只回滚本请求的改动”做不到时，至少在 `rollback()` 里检测“有别的请求在途且有未落盘改动”时改为先 `persistNow()` 其它改动——更简单可行的是 (b) 约定并加用例守住：改内存之后到 `send` 之前禁止 `await`（把 `seal` 提前到改动前，或改动后立刻 `persistNow()`），并在 `send` 里断言 `t === tenants.get(t.tid)`（对象被替换即抛 500 而不是假成功）。约 4 小时。**本轮至少做 (b) 的断言**。

**2-B（P2，数据）登录改绑在最后一道检查之前写了审计。** `server.ts:2798-2811` 改绑：先改 `a.member_slug`、`indexAccount`、**直接 `audit(... "account.rebind", result:"ok")`**，随后 `server.ts:2813` 仍可能抛 `device_mismatch` → 内存回滚，但审计已记“ok”。按现有条件（`t.devices.has(dev...)` 已在 2803 检过）2813 不会再失败，**实际触发路径未找到**；但审计“ok”早于落盘违背了 `send()` 里“先审计后落盘、失败补记 rolled_back”的约定。改为 `auditCtx` 的 `extra` 即可。约 0.5 小时。**本轮修（小）**。

**2-C（P3）改绑时取“新邀请里的姓名”基本取不到。** `server.ts:2807` 从 `t.activations` 找该 slug 的 `member.name`，但入组申请一提交就把姓名清空（`server.ts:3148` `rec.member.name = null`，另见 `930/948/2987/3553`）。改绑发生在“申请 → 批准 → 登录”之后，此时姓名已是 null，`if (invited)` 分支在正常流程里走不到，账号名保持旧邀请的名字。本轮修的“显示名不一致”在改绑这条路上**没有生效**。是否有用例覆盖改绑后的显示名：`test/b54-invite-register-name.test.ts:96-128` 只断言能登录与拒绝条件，**未见断言姓名**。约 1 小时（申请时把姓名转存到 joinRequest 或账号上）。**本轮修**。

**2-D（P3，计费）settle 写账本成功、快照落盘失败时租约已用量回滚。** `/v1/quota/settle` 先 `book.append`（独立文件、已 fsync，`server.ts:3241`）再 `chargeLease` 改内存，`send()` 里 `persistNow` 失败 → 回滚 `lease.used`，网关收到 500 下次重发 → 账本去重（不重复计）但 `chargeLease` 只对 `fresh` 执行（`server.ts:3242`），这批行不再是 fresh → **该租约的 `used` 永远少记这一批** → `outstanding()`（`quota.ts:182-186`）多算在途，直到租约关闭。效果是额度暂时被多占（偏保守），租约关闭后自愈。P3，**不动**，写进运维说明即可。

---

## 方向 3：多实例与并发、全量快照的规模上限

**3-A（P1，稳定/规模）每个请求都全量 `JSON.stringify` 状态，写请求再全量写盘 + fsync。** `send()` 无条件调 `persistNow()`（`server.ts:1136`），`persistNow` 先 `stateOnly()`（`server.ts:505-520`，把所有租户的设备、席位、草稿、anon 映射、额度租约、账号、会话、码、路由、价目历史、告警序列化成一个字符串）再与上次比较（`server.ts:599-600`）；变了就 `snapshot()`——又 `JSON.parse` + `JSON.stringify` 一遍以并入 nonce（`server.ts:521`）——再同步写 + fsync（`state-store.ts:104-131`；PG 版经工作线程 `Atomics.wait` 同样阻塞，`pg-state-store.ts:11`）。即 **GET 也付一次全量序列化，写请求付三次 + 一次同步盘写**，全程阻塞事件循环。
  热点：`/v1/quota/settle`（每个网关每 15 秒每个有记录的租约一次，`quota.ts:318,520-558`）、`/v1/quota/lease`（每次领租约）、设备登记报到（`server.ts:2995-` 每台每天至多一次写）、额度视图（`/v1/quota/view` 律师端轮询）。
  体量来源：`QuotaState.leases` 保留已关闭租约 7 天（`quota.ts:85,195`）；本轮 `releaseIdle`（`legal-gateway/src/quota.ts:409-418`）让“额度紧时每次换租约都关掉旧的”，租约条数随请求量线性涨。粗估：一所 50 人、每人每天 100 次请求、租约每 4 次请求换一份 → 每所每周约 8.75 万条 × 约 300 字节 ≈ 26 MB——**单所就足以让每个请求的序列化到百毫秒级**。这个估算对“每 4 次换一份”的假设敏感（`leaseQuota` 发 `need*4` 或可发放的 1/4，`quota.ts:246-248`；额度宽裕时一份能用很久），**真实分布未核实**，但上限无界是确定的（`MAX_OPEN_LEASES` 只限未关闭的，`quota.ts:236`）。
  建议（按收益排序）：(1) 已关闭且已对账的租约保留期从 7 天降到 1 天或只留计数（`LEASE_KEEP_MS`），1 小时；(2) GET 路径不调 `persistNow`（引入 dirty 标记，改动处置位），约 4 小时；(3) 长期把租约与 nonce 移出快照（同 usage 账本一样按行存）。**(1) 本轮修，(2) 立项**。

**3-B（P2，规模）账单与设备列表的二次方扫描。** `billRow` 每个租户都 `book.monthRows(month).filter(tid)`（`server.ts:1641`），`monthRows` 每次 `this.rows.filter`（`usage-ledger.ts:338`）——运营账单页 = 租户数 × 全部行。`deviceRow` 每台设备都对**全平台所有设备**做一遍 `flatMap + sort` 求最新版本（`server.ts:1655`）——设备列表 = 设备数²·log。`deviceRow`/`/v1/firm/devices` 还对每台设备扫全部 `sessions`（`server.ts:1651,3727`）。试点规模无感，100 所 × 50 台时设备页约 2,500² 次比较。修：最新版本提到循环外算一次；账单按 `byTenantDay` 聚合取（已有索引，`usage-ledger.ts` byTenantDay）。约 2 小时。**立项（低风险可随手做）**。

**3-C（P2，并发）多网关实例同席位领租约：控制面端安全，网关端无跨实例协调。** 控制面单进程、处理器同步段内完成“算可发放 → 记租约”（`quota.ts:232-253`），两个实例并发领不会超发；每次至多发可发放的 1/4 防一个实例领走全部（`quota.ts:247`）。同一 `request_id` 并发 settle：`book.append` 同步去重（`seen`），安全。**结论：现设计在单控制面下正确**；控制面多实例（多进程共享 PG 快照）**不支持**——快照整份覆盖，后写者覆盖前写者，`pg-state-store` 没有乐观锁版本号（`pg-state-store.ts:136` save 直接写）。部署文档是否明确“控制面只能单实例” **未核实**。**不动代码，部署文档写死单实例**。

**3-D（P2，计费）租约被收回后，在途请求的回报去向。** 本轮 `revokeLeases` 后网关收到 `revoked` 即 `leases.delete(id)`（`legal-gateway/src/quota.ts:543`），哪怕该租约 `holds > 0`（还有在途请求）。这些请求结束时 `settle` 找不到本机租约（`quota.ts:483-487`），但仍按 `hold.leaseId` 入队回报；控制面该租约已 `closed_at` 但还在保留期内，`chargeLease` 照记、账本照记（`server.ts:3236-3242`）。**不漏计**，核过。小瑕疵：在途请求结束时预占余量不再还给本机（本来就要丢），无害。

**3-E（P3）`releaseIdle` 与后台预取的竞态。** `releaseIdle` 先 `await this.flush()` 再逐个关闭（`quota.ts:409-418`），关闭前复查 `holds===0 && !pending`，删除与复查同步，安全；关闭报文失败只退化为“到期释放”，与注释一致。核过，无问题。

**3-F（P2，稳定）上游健康回报每 15 秒触发一次全量落盘。** 网关 `UpstreamHealth.startReporting` 每 15 秒报一次（`legal-gateway/src/upstreams.ts:272-274`），控制面 `recordHealth(routing, ...)` 把带时间戳的健康写进 `routing.health`（`server.ts` 约 3202 行），`routing` 属于快照（`server.ts:505-520`），所以**没有任何业务流量时每个网关实例也让控制面每 15 秒全量序列化 + 写盘 + fsync 一次**。健康是易失数据，不该进持久快照。建议放进内存旁路（重启后 15 秒内即重建），约 1.5 小时。**立项（与 3-A(2) 一起做）**。

> 审计过程中注意到：`server.ts` 的 `billRow` 与 `quota.ts` 的 history 在我读完之后被主会话改过（已按本报告 1-A 冻结期末套餐、席位、单价与加量）。下文“复核意见”对这个新改动另有一条。行号以初读时为准，个别会有几行偏移。

---

## 方向 4：租户隔离与权限

### 核过、成立的
- 设备签名接口的租户来自**验签通过的设备证书**（`authDevice`，`server.ts:1162-1170`：`tenantOf(v.tid)`，`v` 是验签结果），不读请求体里的 `tid`。
- 成员网页接口 `/v1/me/*`、`/v1/firm/*` 的租户来自会话账号（`server.ts:3589-3597` `tenantOf(a.tid)`）；按成员操作时校验 `x.tid !== t.tid → 404`（`server.ts:3669-3670`）；用量记录查询强制 `tid: t.tid`（`server.ts:3757`）；本所账单剔除成本与毛利（`server.ts:3787`）。
- 律所内部边界：写操作只给 admin、partner 只读（`server.ts:3621-3622`）；设备端改上限 `requireAdmin`（`server.ts:3338`）；吊销设备 / 席位要 admin 或 partner 设备（`server.ts:1204`）；管理员之间不互发重置码（`server.ts:3701`）；最后一名管理员不能停用（`server.ts:3676`）。
- 运营权限：固定角色表（`rbac.ts:23-34`），危险权限要 10 分钟内复核（`rbac.ts:40`，`server.ts:2603-2604`）；唯一的 `perm: null` 是 `GET /v1/ops/roles`（`server.ts:1816`，只读角色说明，无害）；总览对无 `billing.read` 者裁掉金额（`server.ts:1883-1889`）；路由视图只给“是否已设 + 尾号”，不给密文（`routing.ts` `routingView`）。
- 控制台前端：按钮按 `can(perm)` 置灰（如 `apps/console/pages/tenants.js:269,508,528`），后端每条路由独立校验 perm，不依赖前端。

### 问题
**4-A（P2，计费/权限）收紧个人上限不收回该成员的在途租约。** 本轮 `revokeLeases` 只在改上限（`quota.ts:300`）、改套餐内容（`server.ts:1958`）、换套餐或改席位（`server.ts:2420`）时调用；律所管理员调低成员个人上限（`/v1/firm/members/:aid/limits`，`server.ts:3706-3716`）与运营改账号个人上限（`account.manage` 路由，未逐行看）都**不收回**。触发：成员手里有一份 5 分钟租约，管理员把他的个人上限从 100 万调到 10 万 token，租约余量内他仍可继续用到过期。与本轮修的“收紧后在途租约仍可用”同类遗漏。修法：只收回该 `sid`/`uid` 的租约（`revokeLeases` 加过滤参数）。约 1 小时。**本轮修**。

**4-B（P3，计费）改套餐内容不论放宽还是收紧都收回全部租户的租约。** `server.ts:1956-1958` 对用该套餐的所有律所 `revokeLeases`；放宽（加额度、加模型）也收回，带来一轮集中重领（每所每席位一次 `/v1/quota/lease`，各一次全量落盘，见 3-A）。规模大时是一次小型惊群。**不动**，3-A 修好后无感。

**4-C（P3，权限口径）`viewer`（只读）能看到成本价。** `route.read` 在 `READ_PERMISSIONS` 里（`rbac.ts:18`），`viewer` 全拿；`routingView.prices.items` 含 `cost_input/cost_output`（`routing.ts` routingView）。财务角色反而没有 `route.read`（`rbac.ts:29`）。是否符合商务预期 **未核实**（角色说明写“看全部”，可能是有意）。**不动，问一句**。

**4-D（未发现问题）服务间接口 `/v1/quota/lease`、`/v1/quota/settle` 信任请求体 `tid`。** 只凭服务密钥（`requireService`，`server.ts:3204,3231`），`tid`、记录里的 `uid/sid` 都不与租约交叉校验（`server.ts:3233-3242`）。网关是受信组件，这是设计取舍；只在“服务密钥泄露”威胁模型下有意义。**不动**。

---

## 方向 5：API 密钥与敏感数据

核过、成立的：
- 上游密钥：控制台浏览器端 ECDH 封装（`apps/console/seal-key.js`），控制面只存 `key_sealed` + 尾号（`routing.ts:5,26,245-264`），运营视图不回密文（`routingView`），只有网关订阅里带密文（`routingFeedBody`，签名下发）。
- 网关访问日志只记方法、路径（去掉查询串）、状态、客户端请求编号（`gateway.ts:808-812`）；计量文件按白名单字段重建（`meter-file.ts` `FIELDS`，`usage.ts` `cleanUsageRecord`），不含正文、错误体、密钥。上游非 2xx 正文丢弃不透传（`gateway.ts:500-506`）。
- 错误应答：控制面未知异常一律 `control_plane_error / 控制面错误`（`server.ts:3893`），网关一律 `gateway_error / 网关错误`（`gateway.ts:826`），不回内部消息。
- 一次性码只存 MAC（`server.ts` `issueAccountCode`：`codeMac(accountPepper, ...)`）；重置码明文只在应答里回给发起的管理员（`server.ts:3703-3704`）与邮件里。
- 首个系统管理员设置码写 0600 文件、日志只写路径（`server.ts:3797-3799` 注释与 `writeBootstrapFile`）。`console-login.txt` 为 0600（`scripts/stack-local.mjs:9,20`），只在本机演示栈用。

问题：
**5-A（P3）邮件验证码只有 6 位十进制。** `issueAccountCode` 对 `email_reset` 取 `randomBytes(4) % 1_000_000`（`server.ts` 约 1458 行附近），每码 5 次尝试（`server.ts:2848`），每来源 10 次/窗口限速（`server.ts:2839`）。按来源限速而非按账号：攻击者换来源可对同一账号持续申请新码再猜。单码命中率 5/10⁶，可接受；但没有“按账号”的申请频率上限。**立项（低优先）**。

没发现密钥、席位令牌、密码进日志的路径；`obs` 目录内容 **未逐文件核实**。

---

## 方向 6：路由与上游稳定性

核过：并发上限按上游计（`upstreams.ts:92-120`），排队有超时并随客户端断开取消；只在**还没给客户端写出任何字节之前**换上游（`gateway.ts:435-517`），不会重复生成；其它 4xx 不换上游（`gateway.ts:511-516`）；全部 429 时把最短 `Retry-After` 回给客户端（`gateway.ts:520-521`）；**网关自身不做重试退避**（每个候选只试一次），不放大上游压力。

**6-A（P2，稳定/体验）429 计入熔断：单上游部署下 3 次限流 = 全平台 30 秒不可用。** `tk.failure(code)` 对 429 与 5xx 一视同仁（`gateway.ts:511`），连续 3 次即熔断 30 秒（`upstreams.ts:69,165-173`）。当前部署只有一个上游（中软 MaaS，`routing.ts:143` 引导配置）：一个所的突发把上游打出 3 个 429，**所有律所**接下来 30 秒拿到的是 `503 upstream_unavailable “没有可用的上游”`（`gateway.ts:519`）而不是“繁忙稍后重试”，且没有 `Retry-After`。熔断本意是隔离坏上游，限流应走“排队 / 429 透传”。修法：429 记 `neutral`（或单列计数，只在多上游时用于降权），不触发熔断。约 1 小时 + 用例。**本轮修**。

**6-B（P3）其它 4xx 会清零失败计数。** `neutral` 把 `failures` 和熔断状态清零（`upstreams.ts:151-157`），“5xx、400、5xx、400……”交替时永不熔断。实际影响小。**不动**。

**6-C（P3）订阅 15 秒延迟窗口。** 改价：窗口内仍按旧版本计价，控制面也按旧版本重算（口径一致，见 1）；停用上游 / 换密钥：窗口内仍用旧配置（旧密钥若已在上游作废，会得到 401 → 不切换 → 律师见错误）；没有订阅陈旧上限（`routing.ts:471-477`，控制面不可达时无限期沿用旧表）——额度靠 5 分钟租约失败关闭，所以不会无限期免费用。**不动**；运维手册写明“换密钥先加新、等 30 秒、再删旧”。

---

## 方向 7：控制台（apps/console）

核过：
- 全站 DOM 构造（`ui.js:4` 约定、`ui.js:37-49` `h()`/`svg()`），全仓 `innerHTML/insertAdjacentHTML/outerHTML` **零命中**；CSS 只经 `cssVars` 且只收数字（`ui.js` cssVars）；CSP `script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`（`index.html:7`）。XSS 面很小。
- 危险操作走 `confirmAction`（如作废开通码 `pages/tenants.js:467`、终止订阅 `525`、收回席位 `266`），后果写明。
- 时间统一 `Asia/Shanghai`（`ui.js:12`）。

未核实：金额、token 显示取整口径是否处处一致（`unitOut` 后端 4 位小数，`billing.ts:192-196`；前端各页 `fmt` 用法没逐页对）；其它前后端校验规则不一致（除本轮已知的套餐编号）**没有逐字段比对**。这两项需要专门对一遍，约 3 小时，**立项**。

---

## 方向 8：部署与升级

**8-A（P1，计费/数据）`rollback.sh --restore` 会丢掉备份之后的全部用量账本行与网关发件箱。** 账本（`usage-ledger.ts` `<dir>/YYYY-MM.jsonl`）、网关 `meter.jsonl` / `meter.ack`、控制面快照都在 `/var/lib/kwl`（`deploy/config/control-plane.example.json:6`、`gateway.example.json:8`）。`upgrade.sh` 升级前备份（`upgrade.sh:24`），`rollback.sh --restore` 把 `/var/lib/kwl` 整体换成备份（`rollback.sh:24-30`）——升级后到回滚之间产生的计费行在账本里消失，网关的 meter.jsonl 与 ack 也回到旧值，**这段时间的请求不会再被重放**（重放只看 ack 之后，而 ack 与文件一起被换回去了）。旧目录被改名保留（`rollback.sh:27` `kwl.before-restore.<ts>`），所以数据没物理删除，但没有任何步骤把它并回去。修法：恢复后把 `kwl.before-restore.*/usage/*.jsonl` 追加回新目录（账本按 `request_id` 去重，重复行无害），或恢复时排除账本目录只恢复快照。约 2 小时（脚本 + 手册一段）。**本轮修**（回滚恰是出事时用的）。

**8-B（P3）新字段的前后兼容：成立。** 逐项核：
- `QuotaState.last_denied`（可选）：旧版 `migrateQuota` 对 v2 `...r` 原样保留（`quota.ts:116`），不读不崩；回到新版照用。
- `LeaseRecord.revoked`：收回时同时置 `closed_at`（`quota.ts:288-290`），旧版只看 `closed_at`，语义一致。
- `price.manage`：权限从角色表现算（`rbac.ts:47-51`），人员记录只存角色；回滚到旧版只是系统管理员失去 `plan.manage`、运营失去改价，不崩。
- 新版 history 行的冻结字段（主会话正在加的 `boost_pct/plan_id/seats…`，`quota.ts:52-55`）：均为可选，旧版忽略。
- 旧网关 + 新控制面：settle 应答里的 `revoked` 被忽略 → 收紧在网关升级前不生效（最多 5 分钟）。`upgrade.sh:47` 的顺序是先控制面后网关，单机同时升级无窗口。
- 本轮改动**不需要数据迁移**，但发布说明应写一句“收紧即收回需网关与控制面同版本”。

**8-C（P3）客户端最低版本闸只在续签席位令牌时生效。** `/v1/seat-token` 返回 426（`server.ts:3271`），令牌 96 小时（`server.ts:636`），所以旧客户端最长约 4 天才被拦。设计如此（控制面停机容忍 72 小时），**不动**，只需在运营控制台“设最低版本”处写明生效延迟。

**8-D（P3）备份不停机时 tar 可能截到账本半行。** `backup.sh:13`；读回时坏行跳过并计数（`usage-ledger.ts` 构造 `bad += 1`），但跳过的是**一条真实计费行**。只在“用这份备份恢复”时有影响。`--stop` 可避免。**不动**，手册里恢复前推荐 `--stop` 的备份。

---

## 方向 9：过度设计与可删减（只列收益明确、风险低的）

**9-A 租约保留 7 天 → 1 天**（同 3-A(1)）：`LEASE_KEEP_MS`（`quota.ts:85`）。保留期只用于“迟到回报仍记到租约上”，而迟到回报本来就照常入账本（`server.ts:3237`）。收益：快照体积一个数量级。风险：网关停机超过 1 天后重放的记录拿到 `lease_unknown`？——**注意**：`/v1/quota/settle` 对不存在的租约**不报错、照常入账**（`server.ts:3236-3242`，`l` 为 undefined 时跳过持有者校验），网关端 `lease_unknown` 分支只在 `final` 关租约时出现（`quota.ts:263`），所以缩短保留期不会丢账。约 1 小时含用例。

**9-B 上游健康移出持久快照**（同 3-F）。

**9-C `snapshot()` 的二次解析。** `JSON.stringify({...JSON.parse(state), nonces})`（`server.ts:521`）可改为字符串拼接（`state.slice(0,-1) + ',"nonces":' + JSON.stringify([...nonces]) + '}'`），每次写盘省一次全量 parse + stringify。约 0.5 小时，零语义变化。

**9-D 不建议删的“可选服务”。** relay-api（873 行）、notify-api（552）、support-api（383）、dist-api（109）、search-service（224）：默认部署只启用 cp-signer / control-plane / gateway（`deploy/scripts/install.sh:118`），但内核都有调用方（`packages/kernel/src/control-plane/client.ts:500-520` 的 support / notify / relay 凭据，`packages/kernel/src/index.ts:645,675`，`packages/kernel/src/api/index.ts:5472`）。删了要连同内核功能一起下线，收益小于风险，**不动**。

**9-E 北京时间取日的重复实现**：控制面内 `billing.ts:200` 与 `usage-ledger.ts:115` 各一份常量；notify-api、support-api 各一份 `bjDay`（`notify-api/src/index.ts:126`、`support-api/src/index.ts:138`）；内核有 `local-date.ts`（Intl 版）与 `reminders.ts:105`。都是一行、且都对（无夏令时）。合并收益很小，**不动**；只建议控制面内部 `periodBounds` 复用 `BJ_MS`。

---

## 方向 10：明确不该动的 5 项

1. **发件箱 = 预写计量日志 + 字节偏移检查点**（`meter-file.ts`、`legal-gateway/src/quota.ts:230-292,493-509`）。看起来可以“直接 HTTP 回报、失败重试”简化掉，但它是“网关崩溃不丢账”的唯一保证；检查点取“最小未确认行首”而不是“最后发送行尾”，乱序确认也不会跳过记录。别动。
2. **控制面按记录里的价目版本重算，而不是采信网关算的 `charge_units`**（`server.ts:1479-1484`）。网关的数只用于本地扣租约。容易被当成“重复计算”删掉；删了就让网关（以及网关的旧版本）决定账单。
3. **只在写出第一个字节之前换上游**（`gateway.ts:435-517`）。看似“流中断了为什么不自动换一家续上”——续上会让律师拿到两个模型拼起来的文书，且上游两边都计费。
4. **partial 行 usage 置空、估算放 `partial_usage`**（`usage-ledger.ts` UsageRow 注释、`server.ts:1471-1478`）。看起来别扭（为什么不直接 usage + charge=0），但这样旧版控制面读到也不会算进额度——回滚安全靠的就是它。
5. **租约每次至多发可发放的 1/4、按席位领、5 分钟到期 + 30 分钟宽限**（`quota.ts:82-85,246-248`）。看似可以简化成“每次请求都问控制面”或“一次发够”，前者把控制面放进每个请求的关键路径（控制面停机即全停），后者在多网关实例下会让一个实例领走全部余量。本轮的 `releaseIdle`/`revokeLeases` 是在这个框架里补洞，方向对。

（第 6 条备选：全局“出错整体回滚”本身也不该简单删掉——它保证了“失败的请求不留半截状态”；问题在并发误伤，修法是 2-A 的断言与约定，不是去掉回滚。）

---

## 对本轮已修项的复核意见

| 已修项 | 复核结论 |
|---|---|
| 设备“最近使用”按北京日 | 控制面 `/v1/firm/devices` 与 `deviceRow` 都用 `dayOf`（`server.ts:3719,1653`），成立。内核 `executor.ts` 两处 **未核实**（不在本次范围）。 |
| `price.manage` / `unpricedAliases` 守卫 | 套餐保存（`server.ts:1951-1955`）与改价（`server.ts:2184`）两处都守，成立。`plan.models` 为 null（不限模型）时 `unpricedAliases` 检哪些别名 **未核实**。改套餐内容时不论放宽收紧都收回全部租约（4-B，无害）。 |
| 邀请注册显示名 / 被拒后重新受邀改绑 | 注册路径成立（`server.ts:2746,2756`）。改绑路径取姓名时姓名已被入组申请清空（2-C），**显示名修复在改绑路径上不生效**；改绑前写审计 ok（2-B）。 |
| 策略草稿规则类拒绝的客户端提示 | 客户端改动，**未核实**。 |
| `releaseIdle` | 复查 `holds===0 && !pending` 与删除同步完成，并发安全；关闭失败退化为到期释放（3-E）。成立。 |
| `last_denied` 与出错回滚 | 被拒时直接 `send(402)` 自行落盘（`server.ts:3224`），10 分钟时效（`quota.ts:306-321`），跨期清空（`quota.ts:163`）。成立。小注：任何一次成功领取都会清掉它（`quota.ts:245`），语义是“还能发出请求就不算暂停”，可接受。 |
| `revokeLeases` + settle `revoked` | 改上限、换套餐 / 改席位、改套餐内容三处已接（`quota.ts:300`、`server.ts:2420,1958`）；网关收到即丢本机租约，在途请求结束仍照常入账（3-D）。**遗漏：个人上限收紧（4-A）**。旧网关忽略 `revoked`（8-B）。 |
| 主会话审计中途改的 1-A（history 冻结期末套餐、席位、单价、加量；`billRow` 取冻结值并标 `basis`） | 方向对。**时序漏洞**：冻结发生在 `ensurePeriod`（懒触发），而 `ops.setPlan` 是**先改 `t.plan`/`t.seats` 再 `qOf(t)`**（`server.ts` setPlan：`if (plan...) t.plan = plan; ... qOf(t);`）；`plan.upsert` 也是先 `Object.assign(prev, next)` 再收回租约（`server.ts:1956-1958`）。若某所月初还没有任何请求触发跨期，运营在新月第一天先改了套餐 / 席位 / 套餐单价，上月 history 冻结到的是**新值**。修法：`setPlan` 开头先 `qOf(t)`；`plan.upsert` 在 `Object.assign` 前对用该套餐的所有租户 `qOf`。约 0.5 小时 + 一条跨期用例。 |

## 未核实清单

- 上游（中软 MaaS / K3）的 `completion_tokens` 是否已含 reasoning tokens；律师端与控制台是否写明 tokens 口径（1-E）。
- 3-A 的规模估算依赖“租约多久换一份”的真实分布；未拿生产或验收数据测快照体积与单次 `stateOnly()` 耗时。建议在验收栈上打一个 `persistNow` 耗时直方图再定优先级。
- 方向 2 中 `server.ts:2915、2939` 两处失败计数的完整上下文只看了 grep 命中（2885 处已核）。
- 运营侧改账号个人上限的路由（`account.manage`）是否收回租约，未逐行看（推断同 4-A）。
- 控制台金额 / token 取整与前后端校验规则一致性（方向 7）。
- `obs` 日志目录逐文件内容；`demo-launch.mjs` 打印登录信息的方式（本机演示用，不在云端范围）。
- 部署手册是否已写明“控制面单活、PG 只做一主多备、`usage_dir` 放共享存储”（`cloud-serve.mjs:66,515` 有告警，手册未查）。
- 内核 `executor.ts` 的 `asOf` 修复、客户端策略草稿提示修复（不在本次范围）。
- 没有运行任何用例（按要求未跑全量；本报告的结论都来自读代码，触发条件均为思想实验）。
