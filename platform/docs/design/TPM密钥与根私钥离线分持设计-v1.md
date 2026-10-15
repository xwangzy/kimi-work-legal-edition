# TPM 密钥与根私钥离线分持设计 v1（可评审稿）

> 定稿日期 2026-10-15 · 对应：生产化方案 v9.2 §7.1“第 3–5 周：TPM 与根私钥离线方案”、§3.5、§4.6 C6；调研 Y5 §7（7.1 残余、7.2 G1 方案、根私钥离线分持 6 步、7.3 对外声明）；偏离登记 D-24、D-33、D-36、D-41、D-42。
> 性质：防御性设计文档。只读代码与文档、联网核实公开资料；未改源码、未装依赖、未在 Windows 实机运行任何东西。
> 行号以 2026-10-15 工作区为准（基线 `main` 5ce453e；撰写时 `api/index.ts`、`Connections.tsx` 有他人未提交改动，行号可能漂移，引用处同时给函数或接口名）。“待核实”= 公开资料查不到权威说法或须实机测；“决定”= 本稿建议的默认，评审可推翻。

---

## 0. 结论先行

1. **根私钥离线以后，新成员设备的入组方式改为“管理员门限联署”**：律所根只签三样东西——**律所信任锚**（根公钥、恢复公钥、版本与管理员门限、管理员名册、分片登记表）、**管理员设备证书**、**根交接声明**；成员设备与节点设备的证书由不少于门限的管理员设备联署签发（团队版 1 名、律所版 2 名，按不同成员计）。复用现成的 `verifyAdminSignatures`（`firm-trust/src/admin.ts:54-101`），所以不需要发明新的密码学。根私钥只在开通、更换管理员、全部管理员设备丢失、律所恢复事项、分片与根轮换时出场，每次都要两名分片持有人到场（§2）。
2. **律所主秘密（FMS，32 字节）一处分持，两把密钥派生**：根签名密钥与律所恢复密钥都由 FMS 经 HKDF 派生；律所版按 Shamir 2-of-3 分片，团队版是单张恢复码。现在“恢复托管 3-of-5 份额同机落盘”（`devices.ts:150-159,182-189`）等于没有分持，一并取消（§3）。
3. **设备签名密钥入 TPM，算法从 Ed25519 改为 ECDSA P-256**（Platform Crypto Provider 在 Chromium 的实现里只用到 P-256 ECDSA 与 RSA，没有 Ed25519）。账本见证是同步写、频率高，TPM 签名又只能经主进程异步调用，所以**账本、出站批准凭据、同步段改用“会话签名密钥”**（每次启动生成、只在内存、由 TPM 设备密钥签发会话证书）；对外可验证的单据（控制面请求、管理员签名、证书申请、删除回执、归档清单、诊断包）由 TPM 直签（§4.2）。
4. **加密私钥与数据库主密钥的 TPM 包裹层，只做一处：数据库主密钥**。设备加密私钥文件本来就由数据库主密钥派生的密钥封装（`devices.ts:59-75`），包住主密钥就把它们一起绑在这块 TPM 上。原生模块只在**主进程**装载，与 `secret-store.cjs` 并列；内核只经 IPC 请求签名（关闭 D-24 的主体部分）。
5. **删除即轮换本机包裹密钥（F9）不能如实宣称“旧快照解不开”**：TPM 用户密钥在磁盘上有一个由 TPM 存储根包裹的密钥文件（第三方资料称在 `%LOCALAPPDATA%\Microsoft\Crypto\PCPKSP\`，待实机核实），卷影副本会连它一起保存，在同一台电脑上恢复该文件，旧密钥就能再次装载。真正销毁需要 TPM 内部状态（NV 索引或持久对象）参与，Windows 下普通用户能否做到待核实。本稿把 F9 做成“代际包裹 + 崩溃一致的两阶段轮换”，安装时登记 `FilesNotToSnapshot`（微软写明是“尽力而为”），对外只说“已尽力”（§5）。
6. **人周**：C6 的 8 人周只够“根离线 + 证书链 v2 + 入组 + TPM 签名与主密钥包裹”的最小集，按本稿完整范围约 17 人周（§7.2）。须拍板：扩大 C6，或把 F9、会话密钥以外的优化、存量根轮换工具与 Windows Hello 后移。
7. **现在就能做、不需要硬件的有 12 项**，优先级见 §7.4；前 5 项是：签名者抽象与软件实现、算法敏捷（P-256 软件密钥跑全量用例）、Shamir 2-of-3 份额编码、证书链 v2 与信任锚、离线仪式状态机。

---

## 1. 现状与威胁模型

### 1.1 密钥现状（以代码为准）

| 密钥 | 算法 | 落盘位置与形态 | 进内存的时机 | 代码 |
|---|---|---|---|---|
| **律所根私钥**（含恢复码 = 种子本身） | Ed25519，种子经 HKDF 派生（`root.ts:37-60`） | `<workspace>/keys/firm-root.json`，kwl-sealed/1；字段含 `privateKeyPem` 与 `recoveryCode` | 首次引导、每次签发本机或节点设备证书（`devices.ts:398,446`）、控制面开通（`index.ts:229-236` → `client.ts:132-139`） | `devices.ts:134-202` |
| 同上，**分布** | — | **每个成员工作区一份**：同律所第二台机器靠复制该文件引导（`devices.ts:135-147`，D-41） | — | — |
| **恢复托管私钥** | X25519（`recovery.ts:20-26`） | 私钥本体不落盘；**5 份 Shamir 份额（3-of-5）全部写在同一目录** `keys/recovery-shares/share-1..5.json`，kwl-sealed/1 | 破窗恢复时由份额文件重组（`api/index.ts:2673-2685`） | `devices.ts:165-189` |
| 同上，**副作用** | — | 第二台机器引导时**另生成一对独立托管密钥**（`devices.ts:148-160`），所以同一律所不同工作区的“恢复公钥”不同，事项的恢复包裹给谁取决于在哪台机器建的事项 | — | 新发现，见 §3.7 |
| **设备签名私钥** | Ed25519（`device.ts:27-36`） | `keys/device.json`，kwl-sealed/1（`devices.ts:419-422`） | 内核启动即装载，整个进程生命周期常驻（`index.ts:103-104`），传入账本签名器、批准凭据、同步、回执、诊断、控制面客户端 | D-24 |
| **设备加密私钥** | X25519 | 同上 | 同上；事项密钥解包（`blob-cipher.ts:9-20`、`ws-keys.ts:48`、`sync-engine.ts:86-90`） | — |
| 节点设备两把私钥 | 同上 | `keys/node-device.json` | 节点授权时（`api/index.ts:2620`） | `devices.ts:437-470` |
| **数据库主密钥** | 32 字节随机 | `userData\ledger-key`，Electron safeStorage（Windows DPAPI）包裹（`secret-store.cjs:23-68`） | 主进程解封后经 `kernel.init` 一次性交给内核（`main.cjs:256-272`），内核常驻；同时派生密钥文件封装密钥（`devices.ts:74`） | — |
| 事项密钥 | AES-256 | `matter_keys` 行：ECIES 包裹给各成员设备加密公钥 + `recovery`（`matter-keys.ts:75-92`），在 SQLCipher 账本里 | 用时解包并缓存（`blob-cipher.ts:12-21`） | — |
| 设备恢复文件 | scrypt(N=2^15) + AES-GCM 包裹两把设备私钥 | 律师自选位置（`api/index.ts:2740-2766`） | 导入时暂存、重启生效（`devices.ts:239-358`） | — |
| 控制面签名密钥 | Ed25519 | 控制面侧（不在律所） | — | `envelope.ts` |

**今天根私钥被用来做的事**（`grep getFirmRootPrivateKey|firmRoot` 全部命中）：
1. 签发本机成员设备证书（`devices.ts:398-411`）；
2. 签发同机节点设备证书（`devices.ts:446-458`）；
3. 控制面开通证明 `enroll proof`（`client.ts:132-139`，服务端 `services/control-plane/src/server.ts:515-533` 只接受 5 分钟内的时间戳）；
4. 引导第二台机器（复制文件，`devices.ts:145-147`）；
5. 隐含用途：持有者可以自签角色为 `admin` 的证书，独自满足放宽类策略的门限（`admin.ts:69-77` 只核“根签发 + 角色 admin”）——这正是 D-41 的残余。

根公钥被用来核验的地方（离线后都要换成“证书链核验”）：`admin.ts:69`、`devices.ts:291`、`ledger-signer.ts:176,503,511-514`、`sync-engine.ts:472`、`api/index.ts:337,1870-1881,2808`、`governance.ts:406,641,958`、控制面 `server.ts:343,542`、归档包离线核验说明 `matter-archive.ts:86-94,224`。

### 1.2 谁能拿到什么（现状）

| 攻击者 | 根私钥 | 恢复托管私钥 | 设备私钥 | 数据库主密钥 | 说明 |
|---|---|---|---|---|---|
| 同一 Windows 用户下的恶意程序（机器开着） | **能**（DPAPI → 主密钥 → HKDF → 解封 firm-root.json） | **能**（同目录 3 份以上份额） | 能 | 能 | 任何一台成员机被攻破 = 全所签名信任与全部事项恢复能力 |
| 拿到硬盘或文件拷贝、没有用户凭据 | 否（密文；DPAPI 需用户凭据） | 否 | 否 | 否 | 前提：没有漫游（F1 已修） |
| 域管理员（持有 DPAPI 域备份密钥） | **能**，离线解开用户的 DPAPI 数据 | 能 | 能 | 能 | [MS-BKRP] |
| 卷影副本、文件历史、备份 + 本人账户 | 能 | 能 | 能 | 能 | 并能解开“已删除”事项（F9） |
| 中软控制面（被攻破） | 否 | 否 | 否 | 否 | 但首个许可决定门限（D-36）；开通时接受谁的根公钥取决于第一个来开通的人 |
| 成员本人（离职前） | **能** | 能 | 本机能 | 能 | 离职成员带走根私钥 = 永久残余，只能轮换根 |

### 1.3 目标状态

| 密钥 | 目标位置 | 谁能拿到 |
|---|---|---|
| 律所主秘密 FMS（派生根私钥与恢复私钥） | **不在任何联机设备**。律所版：2-of-3 纸质分片分持；团队版：一张恢复码；只在“离线仪式进程”内存里短暂出现，进程退出即释放 | 两名分片持有人共同到场；中软不持有 |
| 根公钥、恢复公钥 | 每台设备固定（信任锚，根签名），控制面登记 | 公开 |
| 管理员设备签名私钥 | TPM（不可导出）；无 TPM 退回软件并在设备页与管理员名册如实标注 | 同用户恶意程序可**调用**（签名预言机），但不能拷走 |
| 成员设备签名私钥 | 同上 | 同上 |
| 会话签名私钥（账本等高频签名） | 只在内核内存，每次启动或每 24 小时换新，不落盘 | 内核内存被读 = 只能在该会话的序号与时间窗内伪造见证 |
| 设备加密私钥 | 文件，经数据库主密钥派生密钥封装（不变），数据库主密钥再加 TPM 包裹层 → 传递地绑在本机 TPM | 同用户恶意程序（机器开着）仍能拿到；拷贝到别的电脑、域管理员离线解 DPAPI 都解不开 |
| 数据库主密钥 | `ledger-key` v2：外层 DPAPI，内层 TPM | 同上 |
| 事项密钥本机静态形态（F9） | 本机包裹密钥 LWK 第 g 代包裹（TPM 密钥），删除事项即换代 | 见 §5 的限制 |

**威胁模型边界（如实）**：TPM 的“不可导出”只挡“拷走”与“换一台电脑解”，**不挡机器开着时同一用户下的恶意程序把 TPM 当签名或解密预言机用**。可选的“启动时 Windows Hello”只把这一预言机的门槛提到“每次启动一次手势”，不改变运行期的结论。

---

## 2. 根私钥离线后的协议变更（关键）

### 2.1 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A 管理员门限联署（推荐）** | 根只签信任锚、管理员证书、根交接；成员与节点证书由 ≥ 门限名管理员的设备联署 | 根用得最少；与现有“放宽须管理员门限签名”同一语义、同一核验函数；新成员入组不需要分片持有人到场 | 证书变成两级；管理员设备被攻破可以签发成员证书（与它能签放宽策略同级的风险，门限挡单点）；律所版每台新设备要两名管理员点批准 | **采用** |
| B 仪式时一次性预签若干管理员证书 | 开通时为将来的管理员预签证书 | 之后少开仪式 | 证书须绑定设备公钥，预签时公钥还不存在；预签“空白证书”或“下级签发密钥”等于把根能力放到联机设备上 | 否决 |
| C 联机中间 CA（根签一把常驻的“发证密钥”） | 发证密钥在某台管理员机或所内节点 | 入组自动化 | 把 D-41 的问题挪到另一台机器；门限签名（FROST 等）要引入新的密码库 | 否决 |
| D 根放在硬件安全钥（PIV 智能卡）由主任保管 | 每次入组插钥签发 | 签发路径简单 | 每次入组主任都要在场；钥匙丢失或损坏即根丢失，仍要纸质备份；PIV 对 Ed25519 的支持依固件版本（待核实） | 作为 G2 可选“仪式载体”，不作入组路径 |
| E v9 §9.11“新设备由本人已登记设备扫码批准” | 成员自己的旧设备批准新设备 | 换机不打扰管理员 | 只解决“已有设备的成员加设备”；第一台设备仍要管理员 | 作为 A 的补充（§2.4 的“本人联署”待拍板项） |

### 2.2 新的证书链与文档格式

所有待签字节一律加**域前缀**（今天证书签的是 `canonicalJson(unsigned)`，没有前缀，`device.ts:58`；删除回执同样没有，`matter-lifecycle.ts:287`）。这样主进程可以按前缀白名单决定 TPM 签什么（§4.3）。

**① 律所信任锚 FTA（Firm Trust Anchor，根签名）**

```jsonc
{
  "kind": "kwl-firm-anchor", "v": 1,
  "tid": "…", "version": 1,              // 单调递增；本机只接受更大的版本
  "issued_at": "2026-…Z",
  "root":     { "alg": "ed25519", "spki_pem": "…", "fp": "<安全码格式指纹>" },
  "recovery": { "alg": "x25519",  "spki_pem": "…" },
  "edition": "firm", "admin_threshold": 2,   // 门限由根签名固定（修 D-36：不再由首个许可决定）
  "admins": [ { "cert_id": "…", "member_id": "…", "sign_spki_sha256": "…" } ],
  "share_set": { "set_id": "…", "threshold": 2, "total": 3,
                 "tags": [ { "x": 1, "tag": "<8 字节>", "holder": "主任" }, … ] },
  "enroll_challenge": "…",                   // 仅 version 1：控制面事先发的一次性开通挑战
  "prev_anchor_sha256": null
}
// 签名：root Ed25519 对 "kwl-firm-anchor-v1\n" + canonicalJson(上述)
```

**② 管理员证书 v2（根签名）与 ③ 成员 / 节点证书 v2（管理员联署）**

```jsonc
{
  "v": 2, "certId": "…", "tid": "…", "memberId": "…",
  "deviceId": "dev_<律所>_<10 位随机 base32>",   // 按安装生成（修 D-42）；v1 的确定性编号继续有效
  "role": "admin" | "partner" | "lawyer" | "assistant" | "node",
  "signAlg": "ecdsa-p256-sha256" | "ed25519",
  "signPublicKeyPem": "…", "encPublicKeyPem": "…",
  "keyProtection": "tpm2" | "software" | "vbs",   // 设备自报；未经证明（见 §4.6）
  "anchorVersion": 1,
  "issuedAt": "…", "expiresAt": "…",
  "issuer": { "kind": "root" }                    // 管理员证书
         | { "kind": "admins" },                  // 成员与节点证书
  "signature": "…",                               // 仅 issuer=root
  "issuers": [ { "cert": <管理员证书 v2>, "sig": "…" } ]   // 仅 issuer=admins，结构即现有 AdminSignature
}
// 待签字节："kwl-device-cert-v2\n" + canonicalJson(去掉 signature 与 issuers 的全部字段)
```

**④ 根交接声明（存量迁移与根轮换用，新旧两根各签一次）**：`{kind:"kwl-root-transition", tid, old_root_fp, new_root_fp, new_anchor_sha256, effective_at}`。

**⑤ 证书申请 CSR（新设备生成，设备签名私钥签名作持有证明）**：`{kind:"kwl-device-csr", v:1, tid, memberId, deviceId, role, signAlg, signPublicKeyPem, encPublicKeyPem, keyProtection, invite_id, created_at, nonce}`。

**签发与有效期规则（决定）**：

| 证书 | 签发者 | 有效期 | 续期 |
|---|---|---|---|
| 管理员证书 | 根（仪式） | 27 个月（与每 2 年一次的例行分片轮换仪式对齐，留 3 个月余量） | 例行仪式顺带续签同一公钥 |
| 成员、节点证书 | ≥ 门限名管理员联署 | 12 个月（同今天 `devices.ts:410`） | 到期前 30 天设备自动发“同一公钥续期”申请，**一名**管理员批准即可（不换公钥、不扩权限） |
| 角色限制 | 管理员**不能**签发 `admin` 角色；`admin` 只能由根签 | — | — |

### 2.3 核验逻辑（客户端与控制面一处实现）

新函数 `verifyCertChain(cert, trust)`（`packages/keys/src/chain.ts`，新文件），`trust = { anchor（本机固定的最新信任锚）, anchorHistory, rootHistory, revoked: {id → {at, kind}}, firstSeen(certId) }`：

1. `v` 缺省（v1）：按今天的 `verifyDeviceCertificate`（`device.ts:65-82`）以**当前根或历史根**核验；历史根只对“交接前已在本机出现过”的证书有效（`firstSeen < 交接生效序号`，与 `device_cert_history.superseded_seq` 同一思路，`devices.ts:220-237`）。
2. `issuer.kind = "root"`：根公钥核签名，角色须为 `admin`，`certId` 须在该 `anchorVersion` 的 `admins` 名册中。
3. `issuer.kind = "admins"`：逐条调用现有 `verifyAdminSignatures`（`admin.ts:54-101`），但 **ctx.now 取 `cert.issuedAt`**（管理员证书在签发当时有效即可，管理员证书后来过期不连累成员证书；这一口径今天已在 `governance.ts:400-406` 用于预先吊销），门限取**签发时信任锚版本**的 `admin_threshold`（团队版升律所版后，旧证书在到期前继续有效，避免全所设备同时失效）。
4. 签名管理员后来被吊销：吊销原因分 `retired`（离职、换机）与 `compromised`（被盗、疑似攻破）。`retired` 时，该管理员在吊销**之前**联署、且本机在吊销之前已见过（`firstSeen`）的成员证书继续有效，并提示“30 天内由其他管理员重签”；`compromised` 时，只靠它凑足门限的成员证书立即失效（与今天 `signersStillSufficient` 的重算一致，`admin.ts:104-108`）。
5. 角色为 `admin` 而 `issuer` 不是根 → 拒绝；`issuers` 中有人签了 `admin` 角色 → 拒绝并告警。

**代码改动点**：
- `packages/keys/src/device.ts:38-95`：`DeviceCertificate` 增 v2 字段；`issueDeviceCertificate` 保留（根签管理员证书用，加域前缀）；新增 `certSigningBytesV2`。
- `packages/keys/src/chain.ts`（新）：`verifyCertChain`、`verifyAnchor`、`verifyRootTransition`。注意 `firm-trust` 依赖 `keys`，`verifyAdminSignatures` 要么下沉到 `keys`，要么 `chain.ts` 放进 `firm-trust`——**决定**：放 `firm-trust/src/chain.ts`，`keys` 只放格式与签名原语，避免循环依赖。
- 全部根公钥核验点改调 `verifyCertChain`：`admin.ts:69`、`devices.ts:291`、`ledger-signer.ts:173-187,493-514`、`sync-engine.ts:472`、`api/index.ts:337,1868-1881,2808`、`governance.ts:406,641,958`、`server.ts:343,542`。
- `governance.ts:215-216` `trustContext()` 返回信任锚而不只是根公钥；`governance.ts:461-466` 门限改为“信任锚固定，许可只能抬高、不能降低”（D-36 收敛）。
- `matter-archive.ts:7,86-94,224`：归档包增 `firm-anchor.json` 与 `signer-chain.json`，离线核验说明改为“先用根公钥核信任锚，再核管理员证书，再核成员证书，再核清单签名”；`signer-cert.json` 保留。

### 2.4 新成员设备入组流程（替代“复制 firm-root.json”）

| 步 | 谁 | 做什么 | 防什么 |
|---|---|---|---|
| 1 | 管理员 | 在“成员与设备”页发邀请（成员、角色、72 小时有效），得到**邀请码 + 律所根指纹**（二维码，或电话读出 6 组 5 位数字） | 根指纹走带外，挡“控制面换根”的首次信任攻击 |
| 2 | 新设备 | 安装 → 生成设备密钥（有 TPM 则在 TPM 内）→ 输入邀请码 → 从控制面取信任锚，**核对根指纹与邀请一致**才固定 → 生成 CSR 并用设备私钥签名 → 上传控制面信箱 | 持有证明；控制面只看到公钥（今天它也看到） |
| 3 | 新设备 | 进入“等待批准”有限模式：可以看本机说明，不能建事项、不能出站（无证书 = 闸门不发席位令牌） | — |
| 4 | 管理员 1 | 收到待批准项，界面显示成员、角色、设备安全码（`safetyCode`，`docs.ts:68-73`）；**与新设备屏幕上的安全码当面或电话核对**后联署 | 挡控制面替换 CSR 公钥 |
| 5 | 管理员 2（律所版） | 联署；界面显示管理员 1 已核对安全码，可选再核对一次 | 门限挡单个管理员设备被攻破 |
| 6 | 控制面 | 收齐签名、拼出证书 v2，新设备取回 | 控制面拼不出未签的证书 |
| 7 | 新设备 | 本机 `verifyCertChain` 通过 → 写 `devices` → 登记（`/v1/devices/register` 改为链核验）→ 正常模式 | — |

团队版第 5 步省略。节点设备同一流程，角色固定 `node`，节点机器上用机器级 TPM 密钥（PCP 机器密钥，第三方资料称存于 `C:\ProgramData\Microsoft\Crypto\PCPKSP\`，待核实）。

**代码改动点**：
- `devices.ts:376-424` `ensureDevice`：生产形态不再签证书，改为 `ensureDeviceEnrollment`——无证书时生成密钥与 CSR、返回 `pending` 状态；`index.ts:103-104` 据此进入有限模式。开发与测试形态保留“自签”路径，只在 `ZR_DEV_SELF_ROOT=1` 下可用，安装包构建拒绝该变量（与 `ZR_REQUIRE_CONTROL_PLANE` 同法）。
- `devices.ts:432-470` `ensureNodeDevice` 同上。
- `devices.ts:375-381` 设备编号改按安装生成（D-42）：`dev_<firmSlug>_<随机>`，编号写进 `keys/install.json`；存量确定性编号继续认。
- 控制面 `server.ts` 新增：`POST /v1/invites`（管理员设备签名）、`POST /v1/csr`（新设备，持邀请码）、`GET /v1/csr/pending`、`POST /v1/csr/{id}/signatures`、`GET /v1/csr/{id}`、`GET /v1/anchor`；`server.ts:535-570` 登记改链核验；`server.ts:557-566` “席位自动分配”保持只对已签发证书生效。
- 内核：`api/index.ts` 新增 `enroll.invite`、`enroll.pending`、`enroll.approve`（管理员）、`enroll.status`（新设备）；界面：`apps/desktop/src/pages/Connections.tsx` 设备页增“待批准的设备”。

### 2.5 控制面开通的变化

| 今天 | 离线后 |
|---|---|
| 首台设备持根私钥，`register` 收到 `root_not_enrolled` 就现签开通证明（`client.ts:130-141`），服务端要求时间戳 5 分钟内（`server.ts:521`） | 中软开户后给律所一个**开通码**（合同渠道）；管理员设备凭开通码取**开通挑战**（72 小时一次性）；仪式中根把挑战签进信任锚 v1；管理员设备联网后上传“开通包”（信任锚 + 管理员证书，全是公开内容）；服务端核根签名与挑战、固定根公钥 |
| 首个许可的版本决定门限（D-36 残余） | 门限写在根签名的信任锚里；许可只能抬高门限 |

改动点：`client.ts:38-39,130-141` 删除 `firmRoot` 依赖，`root_not_enrolled` 只报“律所尚未完成开通仪式”；`index.ts:225-236` 删除 `firmRoot` 注入；`request-auth.ts:88-91` `enrollProofBytes` 改为 `anchorSigningBytes`；`server.ts:515-533` 按上表重写。

### 2.6 存量律所迁移（“每台机器都有根私钥” → 离线）

**能否证明旧机器上的根私钥已清除？不能。** 应用可以删除 `firm-root.json` 与 `recovery-shares/` 并写一条签名审计 `firm_root.legacy_purged`，但卷影副本、文件历史、备份软件、SSD 磨损均衡、离职成员拷走的副本都在应用控制之外。所以**决定：存量迁移一律轮换根**，“已清除”只作为过程记录，不作为信任依据。

| 步 | 内容 | 改动点 |
|---|---|---|
| 1 | 升级到含本功能的版本后，设备进入“待迁移”：照常工作，但不再用旧根签任何东西（删除 `getFirmRootPrivateKey` 的生产调用点） | `devices.ts:193-202,398,446`、`index.ts:229-236` |
| 2 | 律所开新仪式（§3），生成新 FMS → 新根、新恢复密钥、新信任锚、新管理员证书（管理员设备先生成新 CSR，可沿用现有公钥） | — |
| 3 | 仪式机上**用旧根**（此时旧根仍在那台机器）签根交接声明的旧根部分；新根签另一部分 | 新增 `verifyRootTransition` |
| 4 | 控制面 `POST /v1/root/transition`：须旧根与新根双签 + 由已登记管理员设备提交；**72 小时冷静期**，期间通知全体管理员；冷静期内出现第二份不同的交接声明 → 冻结租户、转中软人工核实（与律所主任带外确认） | `server.ts` 新增；`server.ts:529` “root_already_enrolled” 改为走交接 |
| 5 | 各设备收到交接声明 + 新信任锚：**本机显示新根指纹，由管理员在所内公告（当面或 IM）后成员点确认**——旧根持有人也能伪造交接声明，所以设备不能全自动接受 | `governance.ts` 新增 `applyRootTransition` |
| 6 | 管理员批量为全体现有设备公钥签发 v2 成员证书（成员无需操作）；旧证书留档 | 复用 `archiveDeviceCert`（`devices.ts:220-237`） |
| 7 | 旧根进入 `firm_root_history(root_pub, superseded_seq, transition_json)`：只对交接前的签名事件有效（账本、回执、归档的历史核验照常通过） | 新迁移 `00xx_firm_root_history.sql`；`ledger-signer.ts:173-187` |
| 8 | 恢复包裹迁移：每台设备把自己持有密钥的事项改包裹给新恢复公钥（§3.7）；全部完成后才销毁旧托管份额 | `api/index.ts` 新增 `recovery.rewrap_progress` |
| 9 | 各设备删除 `firm-root.json` 与 `recovery-shares/`，写 `firm_root.legacy_purged`；设备页显示“旧根副本：本机已删除（备份与快照中的旧副本不在删除范围，已通过轮换使其失效）” | `devices.ts` 新增 `purgeLegacyRootFiles` |

**无法完成迁移时的处理**：某台设备长期不上线、收不到交接 → 旧根签的证书仍被它信任，但它发出的一切在其他设备与控制面看来都是“旧链”，到证书到期自然失效；管理员可直接吊销该设备。试点前的 G0 开发数据（尚无真实律所）建议**重新开通**而不是迁移，迁移工具按 G1 首家存量律所需要再做（§7.3）。

---

## 3. 开通仪式与分片

### 3.1 律所主秘密与派生（决定）

- `FMS = randomBytes(32)`；
- `rootSeed = HKDF-SHA256(FMS, salt="kwl-fms-v1", info="kwl-firm-root-v2", 32)` → Ed25519（复用 `root.ts:50-60` 的派生）；
- `recoverySeed = HKDF-SHA256(FMS, salt="kwl-fms-v1", info="kwl-firm-recovery-v2", 32)` → X25519（复用 `matter-keys.ts:56-60`）；
- 重建正确性的核验 = **由重建的 FMS 派生出的根公钥等于信任锚里的根公钥**，不再另存秘密的哈希（今天份额里带 `privateKeyHash = sha256(seed)`，`recovery.ts:29-36`；对 256 位随机秘密无实际风险，但新格式不需要）。
- 根签名保持 **Ed25519**：根永远不进 TPM，换算法只增加迁移面；v9 第 02 篇 §9.11 写的是 P-256，这里登记为偏离（§9 第 9 项）。

### 3.2 Shamir 参数与份额编码 `kwl-share/1`

| 项 | 值 |
|---|---|
| 有限域 | GF(2^8)，约减多项式 x^8+x^4+x^3+x+1（0x11b），与现有 `shamir.ts:4-43` 及 SLIP-0039 相同 |
| 秘密 | FMS 32 字节，逐字节独立多项式；系数取均匀随机（含 0，这是标准做法，单份额信息论上不泄露） |
| 门限 / 总数 | 律所版 2 / 3；团队版不分片（t=1，“恢复码”即 FMS） |
| 份额编号 x | 1..3（拒绝 0 与重复，`shamir.ts:93-96` 已实现） |
| 分片集编号 set_id | 4 字节随机；每次重新分片都换新；不同分片集的份额混用即拒绝 |
| 二进制布局（43 字节） | `ver(1)=0x01 ‖ set_id(4) ‖ (t<<4 \| n)(1) ‖ x(1) ‖ y(32) ‖ check(4)`，`check = SHA-256("kwl-share-v1" ‖ 前 39 字节)` 前 4 字节 |
| 团队版恢复码 | `ver=0x02`，无 x、无 t/n，`y` 即 FMS，同样带 check |
| 文本 | Crockford base32（复用 `root.ts:20-29`，解码时 O→0、I/L→1），43 字节 = 69 字符；前缀 `KWS1`；每 4 字符一组、每行 6 组，**每行末尾加 1 位行校验字符**（按位置加权模 32），抄错时能指出哪一行；整体再由 `check` 兜底 |
| 二维码 | 内容 `KWS1:` + 69 字符，全部落在 QR 字母数字模式字符集内，约为版本 3–4 的码（待生成核实） |
| 分片标签 tag | `SHA-256("kwl-share-tag-v1" ‖ 43 字节)` 前 8 字节，写进根签名的信任锚 `share_set.tags`；季度核验只比 tag，不重建 |

实现注意（参照 SLIP-0039 的告诫）：
- 份额本身不带认证，**错误的份额插值出错误的秘密而不报错**（`shamir.ts:6-7` 已写明）；所以每片先查 `check`，重建后再比根公钥；
- 只提示可能出错的行，**不做自动纠错**（纠错可能纠成一个“有效但错误”的份额）；
- 现有 GF 运算用对数表查表（`shamir.ts:35-43`），有依赖秘密的内存访问；仪式在独立进程、离线、一次性运行，风险低，仍建议改为逐位乘法的常量时间实现（§7.4 第 3 项顺带）。

### 3.3 卡片与抄写（决定：默认抄写，不默认打印）

- **为什么不默认打印**：Windows 打印经假脱机目录落盘（`%SystemRoot%\System32\spool\PRINTERS`），网络打印机会把内容送上网络并可能留存作业；这与“根秘密不落盘、不上网”冲突。
- **默认**：仪式包随附 3 张预印的空白“律所恢复分片卡”（印好律所名称、卡号位置、6 行×(6 组+1 校验位) 的格子、保管须知）；屏幕逐片显示，持有人手工抄写。
- **可选**：仪式机直连（USB）打印机且网络已断开时打印二维码卡；界面写明残余“打印假脱机文件可能留在本机磁盘（BitLocker 开启时为密文）”，并在打印后提示 IT 清理假脱机目录。
- 不允许：复制到剪贴板、截图（仪式窗口 `setContentProtection(true)`）、用手机拍照（界面明示，手机相册会同步到云）。

### 3.4 “离线仪式模式”的断网检测（及其局限）

**仪式在独立进程中运行**：主进程以随包运行时拉起 `kwl-ceremony`（与 `kwl-egress` 同法复制同字节的 node，摘要入运行时清单，`scripts/build-runtime.mjs`），只装载 `keys` 与仪式模块，不装载内核、闸门、Agent 宿主；仪式窗口为独立 `BrowserWindow`，其会话把一切网络请求拦为失败。进程退出即释放全部秘密内存——JS 字符串无法清零（现有 `keys` 包以 PEM 字符串承载私钥），所以“进程退出”才是可靠的清除手段；仪式代码内一律用 `Buffer` 与 `KeyObject`，用完 `fill(0)`，作为补充。仪式进程启动前写 WER 排除并关闭 Crashpad 上报（与 Y5 P1-5 同法）。

| 检测 | 方法 | 判定 |
|---|---|---|
| 网卡 | `os.networkInterfaces()` 除回环外无可路由地址（链路本地 169.254/fe80 除外） | 必须满足 |
| 物理网卡 | 固定只读 PowerShell：`Get-NetAdapter -Physical` 全部非 Up；Wi‑Fi 关闭 | 必须满足（Hyper‑V/WSL 虚拟网卡不算，但其上有可路由地址即不通过） |
| 系统连接状态 | NLM（网络列表管理器）显示无连接 | 必须满足 |
| 主动探测 | 解析控制面域名、向控制面 IP 与 3 个公共任播地址发 TCP 连接，2 秒超时，**都必须失败** | 必须满足 |
| 持续监视 | 仪式全程每 2 秒复查；任何一项翻转 → 立即中止、清除、退出进程、记 `firm_root.ceremony_aborted` | — |
| 人工确认 | 见证人确认“网线已拔、Wi‑Fi 已关、手机热点已关” | 记入仪式记录 |

**局限（须写进仪式说明）**：
1. 断网检测只能证明“此刻没连上”，**挡不住机器上已有的恶意软件把秘密暂存、等联网后再发出**——这是仪式最大的风险（§9 第 2 项）。建议仪式机用**全新安装、尚未入域、只装本产品的电脑**；退而求其次用管理员本人电脑并在仪式前跑一次杀软全盘扫描。
2. 同一用户权限的恶意程序可以篡改本进程的探测结果。
3. 蜂窝网卡、蓝牙个人网络、隐藏的虚拟网卡可能漏判（以“物理网卡全部非 Up + 主动探测失败”双重条件尽量覆盖）。
4. 进程内存可能被换页到页面文件；可选由原生模块 `VirtualLock` 锁定秘密所在页（待核实在 Node `Buffer` 上的可行性），否则列为残余。
5. Node 的权限模型能否在进程级禁止网络（`--permission` 对网络的支持情况）待核实；若可用则加一层。

### 3.5 仪式状态机（开通与使用共用）

```text
开通：IDLE → PREFLIGHT（离线检测、环境检查、关转储/剪贴板/截屏）
      → COLLECT_CSR（导入管理员 CSR：二维码或 U 盘文件；逐个核对安全码）
      → INPUT_CHALLENGE（开通挑战码）
      → GENERATE（FMS，仅内存）
      → SIGN（信任锚 v1、管理员证书、开通包）
      → SHARE_OUT[x=1..3]（显示 → 抄写 → 隐藏 → 回读校验 → 持有人确认）
      → VERIFY_PAIRS（用三份回读结果两两重建，3 种组合都须得到同一根公钥）
      → SEAL（清除；输出公开的开通包；生成仪式记录）→ EXIT（进程退出）
      任何状态 ──网络翻转/取消/异常──→ ABORT（清除、记录、退出；不留任何秘密）

使用：IDLE → PREFLIGHT → COLLECT_SHARES（两片，逐片查 check 与 set_id）
      → RECONSTRUCT（比对根公钥）→ OPERATION（仅限下列之一）→ SEAL → EXIT
      OPERATION ∈ { 签管理员证书 | 签信任锚新版本 | 律所恢复某事项 | 重新分片 | 轮换根 | 续签管理员证书 }
```

**回读校验**：抄写完毕后屏幕隐藏份额，持有人用**仪式窗口内的屏幕键盘**（不用系统输入法，避免输入法云联想）逐字回输，或扫描刚打印的卡；常量时间比对。不一致只提示出错的行号并重新显示该片。VERIFY_PAIRS 用回读得到的文本（而不是内存里的原值）重建，证明“纸上的东西能用”。

**审计事件**（`firm_root.*`，经开通管理员设备的 TPM 直签；仪式记录另由两名见证人的设备联署，即 Y5 的“三人设备签名”）：

| 事件 | 内容（不含任何秘密） |
|---|---|
| `firm_root.ceremony_started` / `_aborted` | 仪式编号、模式、中止原因码 |
| **`firm_root.offline_sealed`** | 信任锚版本与摘要、根与恢复公钥指纹、`set_id`、三片 tag、持有人身份、见证人设备、离线检测结果摘要 |
| `firm_root.share_verified` | `set_id`、x、核验人、结果 |
| `firm_root.used` | 用途（上表六选一）、到场持有人、产出物摘要；**同时通知全体管理员** |
| `firm_root.reshared` / `firm_root.rotated` | 新旧 `set_id` 或新旧根指纹 |
| `firm_root.legacy_purged` | 存量迁移时本机删除旧根文件的记录 |

仪式进程本身不写账本（它不装载内核）：事件以“仪式记录”文件（签名后的 JSON，公开内容）交回主进程，再由内核入账并经控制面同步给其他设备。

### 3.6 季度核验、使用、轮换

- **季度核验**：持有人在任意已登记设备（不需离线）扫码或输入自己那片；设备只算 `check` 与 `tag`，与信任锚中的 tag 比对，**不重建、不在内存里同时出现两片**；份额文本只在核验函数内以 `Buffer` 存在，算完清零，不入日志、不入剪贴板。结果记 `firm_root.share_verified`。超过 100 天无核验，管理员首页提示。
- **使用**：Y5 第 5 步的三类用途 + 本稿新增的“签信任锚新版本”（增减管理员）。两片持有人到场，离线仪式，用完即退出进程。
- **轮换（决定：区分“重新分片”与“轮换根”）**：

| 触发 | 动作 | 理由 |
|---|---|---|
| 持有人离职、遗失一片、每 2 年例行 | **重新分片**：重建 FMS → 新多项式、新 `set_id` → 新三片 → 信任锚新版本（新 tags）→ 销毁旧片 | 2-of-3 下旧的单片在其余旧片销毁后无用；不改根就不用重签全所证书 |
| 怀疑两片以上泄露、存量迁移、持有人与管理员串通的迹象 | **轮换根**（§2.6 流程） | 旧根可能已被重建 |
| 例行仪式顺带 | 续签管理员证书（同一公钥） | 管理员证书 27 个月 |

### 3.7 恢复托管并入 FMS

- 新开通：恢复密钥由 FMS 派生（§3.1），不再生成独立托管密钥、不再写份额文件（删除 `devices.ts:148-160,165-166,182-189`）。
- `recovery.restore_matter`（`api/index.ts:2673-2738`）不再读份额文件路径，改为在“使用”仪式中重建 FMS、派生恢复私钥、解出事项密钥后**直接改包裹给指定设备的加密公钥**，仪式输出的是新的包裹行（公开内容），不把事项密钥带出仪式进程。
- 存量：§1.1 发现同律所不同工作区有不同的恢复公钥。迁移时每台设备把自己能解的事项改包裹给新的恢复公钥（`matter_keys` 中 `wrapped_for='recovery'` 的行替换为新包裹，同一密钥不同包裹，多台设备重复做无害）；进度按事项计，全部完成前保留旧份额（仍按 3-of-5 文件，开发形态），完成后删除。
- `recovery.ts:41-47` `combineRecoveryPrivateKey` 保留给迁移期读取旧份额。

### 3.8 测试与验收（本节）

- `packages/keys/test/share-codec.test.ts`：编码往返；三片任两片重建、单片失败；任一字符错误被 `check` 拒绝并指出行；两组互换、不同 `set_id` 混用、x=0、重复 x 均拒绝；团队版恢复码往返；tag 稳定性。
- `packages/ceremony/test/state-machine.test.ts`（新包）：注入假的网络探测器与时钟，覆盖每个状态的中止路径；回读不一致不前进；VERIFY_PAIRS 三组合；SEAL 之后进程退出（以子进程跑一遍断言退出码与内存中不残留——后者只能断言“没有写盘、没有发 IPC 消息含秘密”）。
- `services/control-plane/test/enroll-v2.test.ts`：挑战过期、重放、根签名错、门限与信任锚不符。
- 实机：离线检测在 Win11/Win10、有线/Wi‑Fi/Hyper‑V 虚拟网卡/手机 USB 共享网络下的判定矩阵（§6.3）。

**无 TPM 时的降级**：仪式不依赖 TPM（FMS 在纸上）；只有“仪式记录由设备签名”这一步用的是开通管理员设备的签名密钥，无 TPM 即用软件密钥，记录里如实写 `keyProtection: software`。

---

## 4. TPM：设备签名密钥、包裹层与原生模块

### 4.1 能力事实与待核实项

| 事实 | 出处 | 状态 |
|---|---|---|
| Platform Crypto Provider 是使用 TPM 的 CNG 密钥存储提供程序，经 `NCryptOpenStorageProvider(MS_PLATFORM_CRYPTO_PROVIDER)` 打开；**官方页面没有列出它支持的算法表**（软件 KSP 与智能卡 KSP 都有） | Microsoft Learn《CNG Key Storage Providers》 | 已核（2026-10-15） |
| Chromium 在 Windows 上用 PCP 做不可导出密钥：算法只映射 **ECDSA P‑256（SHA‑256）与 RSA PKCS#1 SHA‑256**，用 `NCryptIsAlgSupported` 选；Ed25519 走不到；`NCryptSignHash` 返回 64 字节 r‖s，再转 DER；用 `Tbsi_GetDeviceInfo` 要求 TPM 2.0；还有基于 `NCRYPT_USE_VIRTUAL_ISOLATION_FLAG` 的“虚拟（Credential Guard）”提供者 | Chromium `crypto/unexportable_key_win.cc` | 已核 |
| PCP 对 **ECDH（`NCryptSecretAgreement`）** 与 **RSA‑OAEP 解密**的支持 | 无官方说明 | **待核实**（实机 `NCryptIsAlgSupported` + 自检） |
| PCP 用户密钥在磁盘上有密钥文件（按名称的 SHA‑1 命名、扩展名 `.PCPKEY`），用户级在 `%LOCALAPPDATA%\Microsoft\Crypto\PCPKSP\`，机器级在 `C:\ProgramData\Microsoft\Crypto\PCPKSP\` | 第三方开源项目 pcpcrypto 的说明 | **待实机核实**（对 §5 的结论至关重要） |
| Windows 11 最低硬件要求含 TPM 2.0 | Microsoft Learn《Windows 11 requirements/compatibility》 | 已核 |
| 律所现有电脑的 TPM 2.0 普及度（Win10 机器 TPM 关闭、无 TPM、fTPM 未开） | — | **待核实**，纳入“试点律所电脑盘点”（外部条件表） |
| TPM 签名延迟（fTPM 与独立 TPM、不同厂商） | — | **待实测**；设计不依赖它低于某个值（§4.2） |
| Node 26.8.1：P‑256 私钥 `sign(null, …)` 产出 DER 签名、可用 `"sha256"` 验；指定 `dsaEncoding: "ieee-p1363"` 得 64 字节 | 本机实测（`node -e`，v26.8.1） | 已核；仍要求代码显式写 `"sha256"` |
| Electron 20 起禁止原生模块把堆外内存包成 ArrayBuffer 交给 JS，须复制进 V8 内存 | Electron 博客《Electron and the V8 Memory Cage》 | 已核 |
| Electron 原生模块须按 Electron 重建，升级 Electron 后通常要重建 | Electron 文档《Using Native Node Modules》 | 已核；用 Node‑API 并锁定 Electron 版本（`electron-builder.yml:7`） |
| Windows Hello 能否门控 PCP 密钥（或须改用 Passport KSP / `KeyCredentialManager`） | — | **待核实** |

### 4.2 设备签名密钥入 TPM 与算法迁移（Ed25519 → ECDSA P‑256）

**决定**：
- 有 TPM 2.0 且自检通过：设备签名密钥 = PCP 中不可导出的 ECDSA P‑256；无 TPM：软件 ECDSA P‑256（新安装）或继续 Ed25519（存量），统一走算法敏捷的核验。
- 签名编码统一 **IEEE P1363（r‖s，64 字节）**——即 `NCryptSignHash` 的原生输出，省掉 DER 转换；签名后在 JS 侧**规范化为低 S**，核验时**拒绝高 S**（ECDSA 签名可塑：(r, n−s) 同样有效；本系统多处以签名串比较或去重，如 `server.ts:553` 比较证书签名，必须消除可塑性）。
- 一切签名显式写算法，不再 `sign(null, …)`。

**签名用途分两类**（因为账本见证在 SQLite 同步事务内调用 `signBytes`，`ledger-signer.ts:84-109`，而 TPM 在主进程、只能异步）：

| 类别 | 用途（代码） | 签名密钥 | 理由 |
|---|---|---|---|
| 对外可验证、低频 | 控制面请求（`request-auth.ts:42-47`，每次同步约十次）；管理员签名（`admin.ts:19-21`、`client.ts:396`）；CSR；成员证书联署；删除回执（`matter-lifecycle.ts:287`）；归档清单（`matter-archive.ts:257`）；诊断包（`diagnostics.ts:244`）；会话证书；仪式记录 | **TPM 设备密钥直签**（异步） | 第三方或其他设备只认设备证书 |
| 本机高频、同步 | 账本见证与检查点（`ledger-signer.ts:103,123`）；出站批准凭据（`egress-approvals.ts:128-130`，闸门验签）；同步段（`segment.ts:77`，同事设备验签） | **会话签名密钥** | 同步路径、频率高 |

**会话签名密钥**（决定：必做，不是性能优化）：
- 内核启动时生成 Ed25519 会话密钥对（只在内存）；请主进程用 TPM 签 `SessionCert {kind:"kwl-session-cert", v:1, deviceId, certId, sessionPub, notBefore, notAfter(≤24h), startSeq, nonce}`（域前缀 `kwl-session-cert-v1\n`）；
- 每个会话的第一条见证行是“会话开始”，**由 TPM 设备密钥直签**，锚定会话证书摘要；其后见证由会话密钥签；会话每 24 小时或每次重启轮换；
- 新表 `device_sessions(session_id, device_id, cert_id, session_cert_json, start_seq, end_seq)`，`signed_events` 增列 `session_id`；
- 核验（`ledger-signer.ts:173-187` 的 `certProblem/signatureProblem`）：见证签名 → 会话公钥；会话证书 → 设备证书公钥（P‑256）；序号须在 `[start_seq, 下一会话 start_seq)`；
- 闸门：内核拉起闸门时传会话公钥与会话证书（今天传的是设备公钥，信任关系相同）；`egress-gate/src/approval.ts:108` 改为按会话证书核验；
- 同步段：段头增 `session_cert_json`（今天已带 `device_cert_json`，`sync-engine.ts:202`），同事设备按 设备证书 → 会话证书 → 段签名 核验（`sync-engine.ts:472`、`segment.ts:98`）。
- 残余（如实）：内核内存被读，攻击者能在该会话的时间与序号窗口内伪造见证；不能延伸到会话之外，也拿不走设备签名密钥。对比今天：持久的设备私钥常驻内核内存（D-24）。

**算法迁移影响面**：

| 面 | 影响 | 处理 |
|---|---|---|
| 证书格式 | 增 `signAlg`；缺省视为 `ed25519` | `device.ts:38-53` |
| 签名原语 | `signBytes/verifyBytes` 只支持 Ed25519（`signing.ts:8-19`） | `verifyBytes` 按公钥类型分派（`createPublicKey(pem).asymmetricKeyType` 为 `ed25519` 或 `ec` 且曲线 P‑256），EC 路径用 `"sha256"` + `ieee-p1363` + 拒绝高 S；`signBytes` 改为接受 `DeviceSigner` |
| 直接调 `crypto.verify(null, …)` 的地方 | `admin.ts:84`、`request-auth.ts:79`、`approval.ts:108`、`server.ts:524`（根，Ed25519 不变） | 改调分派后的 `verifyBytes` |
| 控制面 | 设备目录里的证书、请求验签 | 同上；控制面签名密钥（信封、席位令牌）不变 |
| 审计链 | 新旧算法混在一条链上 | 按每条见证对应的证书算法核验；历史 Ed25519 见证继续由留档证书核验（`device_cert_history`） |
| 存量证书留档 | `device_cert_history`（迁移 0024/0025） | 不变；存量设备首次启用 TPM 时**换签名密钥**：旧证书以 `reason='rekeyed'` 留档（`devices.ts:220-237`），`superseded_seq` 照旧限定其有效范围 |
| 设备恢复 | 导入时要求 `ed25519`（`api/index.ts:2799`）；TPM 签名密钥不可导出 | 恢复文件 v3（§4.5） |
| 安全码 | 由两把公钥 PEM 的哈希算出（`docs.ts:68-73`） | 不变；换签名密钥 = 公钥变更，走现有“核对安全码后才替换”（`governance.ts:691-702`） |

### 4.3 原生模块接口草案、构建与装载

**装载位置（决定）：主进程**，与 `secret-store.cjs` 并列。理由：数据库主密钥本来就在主进程解封（`main.cjs:78`）；内核处理渲染进程与 Agent 宿主的大量输入，攻击面大；主进程可以对签名请求做**域前缀白名单 + 计数**，设备页可显示“本机硬件密钥今日签名次数（按用途）”。内核不装载 TPM 模块，只经 IPC 请求签名。

**包**：`platform/packages/kwl-tpm/`（新），C++（node-addon-api，Node‑API v9），只链接 `ncrypt.dll`、`tbs.dll`、`bcrypt.dll`；JS 门面 `apps/desktop/electron/key-provider.cjs`。

```ts
// packages/kwl-tpm/index.d.ts（草案；所有耗时调用都是 AsyncWorker，返回 Promise，不阻塞主进程事件循环）
export interface TpmProbe {
  tpm: "2.0" | "1.2" | "none";            // Tbsi_GetDeviceInfo
  pcp: boolean;                           // NCryptOpenStorageProvider 成功
  algs: { ecdsaP256: boolean; rsa2048: boolean; rsaOaepDecrypt: boolean; ecdhP256: boolean }; // NCryptIsAlgSupported + 自检
  vbsKeys: boolean;                       // 虚拟隔离密钥可用（待核实条件）
  manufacturer?: string; firmware?: string;
  selfTest: "ok" | "failed" | "skipped";  // 生成临时密钥 → 签名 → 用公钥验 → 删除
}
export function probe(): Promise<TpmProbe>;

export type KeyName = string;             // "KimiWorkLegal/<tid>/<installId>/<用途>/<代>"，只允许 [A-Za-z0-9/_-]
export function createSigningKey(name: KeyName, o: { alg: "ECDSA_P256"; scope: "user" | "machine" }): Promise<{ spkiDer: Buffer }>;
export function createWrappingKey(name: KeyName, o: { alg: "RSA2048_OAEP_SHA256" | "ECDH_P256"; scope: "user" | "machine" }): Promise<{ spkiDer: Buffer }>;
export function openKey(name: KeyName, scope: "user" | "machine"): Promise<{ exists: boolean; alg?: string; spkiDer?: Buffer }>;
/** 对 32 字节 SHA-256 摘要签名，返回 64 字节 r‖s（P1363）；低 S 规范化在 JS 侧做。 */
export function signDigest(name: KeyName, digest: Buffer): Promise<Buffer>;
/** 解包：RSA-OAEP(SHA-256) 解密，或 ECDH 后由 JS 侧 HKDF；包裹（加密）在 JS 侧用公钥完成，不经 TPM。 */
export function unwrap(name: KeyName, blob: Buffer): Promise<Buffer>;
export function deleteKey(name: KeyName, scope: "user" | "machine"): Promise<{ deleted: boolean }>;
export function listKeys(prefix: string, scope: "user" | "machine"): Promise<KeyName[]>;
```

`key-provider.cjs`（主进程）在其上实现：

```ts
interface KeyProvider {               // 同一接口另有 SoftwareKeyProvider（今天的行为）与测试用 FakeTpmProvider
  kind: "tpm2" | "software" | "vbs";
  ensureDeviceSigningKey(): Promise<{ spkiPem: string; alg: "ecdsa-p256-sha256" | "ed25519" }>;
  sign(domain: AllowedDomain, bytes: Buffer): Promise<string>;  // 先查前缀白名单，再 SHA-256，再 TPM 签，再低 S、base64url
  wrapSecret(name: string, secret: Buffer): Promise<Buffer>;
  unwrapSecret(name: string, blob: Buffer): Promise<Buffer>;
  destroy(name: string): Promise<boolean>;
  stats(): Record<AllowedDomain, number>;
}
```

内核侧：`packages/keys/src/signer.ts`（新）定义 `DeviceSigner { alg; publicKeyPem; sign(bytes): Promise<string> }` 与 `SessionSigner { sign(bytes): string }`；`IpcDeviceSigner` 经 utilityProcess 消息通道向主进程请求（`electron-entry.ts` 增消息类型 `key.sign`），开发与测试形态用 `SoftwareDeviceSigner`（读 `device.json`，即今天的行为）。

**构建与签名**：
- Windows CI（`windows-2025`）用 MSVC 与 `node-gyp` 按 Electron 44.5.1 头文件构建 `kwl_tpm.node`；产物进 `node_modules/@zr-legal/kwl-tpm/`，加入 `electron-builder.yml:13-21` 的 `files` 与 `asarUnpack`；
- Authenticode 签名 `.node`（`electron-builder.yml:49` 的 `signExts` 须确认包含 `.node`，electron-builder 的缺省范围待核实）；未取得正式证书前用开发证书（与第 4 批相同）；
- 摘要写入 asar 内的运行时清单，主进程**核对通过后才 `require`**（第 4 批已对 asar.unpacked 原生模块做全文件核验，沿用）；
- 原生模块以 `LoadLibraryExW(..., LOAD_LIBRARY_SEARCH_SYSTEM32)` 或延迟装载只从 System32 取系统 DLL，防 DLL 劫持；
- 返回给 JS 的数据一律复制进 V8 内存（V8 内存笼）。

### 4.4 加密私钥与数据库主密钥的 TPM 包裹层

**决定**：只给**数据库主密钥**加 TPM 内层；设备加密私钥文件不另包。理由：密钥文件封装密钥 = HKDF(数据库主密钥)（`devices.ts:69-75`），TPM 包住主密钥，`device.json`、`node-device.json`、暂存恢复文件就一起绑在本机 TPM 上；两者最终都进内核内存，分开包裹不增加安全性。

`ledger-key` v2（`secret-store.cjs`）：

```text
文件 = DPAPI( JSON{ v:2, layer:"tpm2"|"none", key_name, alg:"RSA2048_OAEP_SHA256"|"ECDH_P256", blob } )
解封：DPAPI 解外层 → TPM 解内层 → 数据库主密钥
```

- 外层仍用 DPAPI（与 Windows 账户绑定）；内层 TPM（与这块芯片绑定）。效果：**拷贝到别的电脑、域管理员离线解 DPAPI、备份或快照恢复到另一台电脑都解不开**；同一台电脑同一用户的程序仍能解（§1.3 边界）。
- 首次升级：读 v1（只有 DPAPI）→ 生成 TPM 包裹密钥 → 写 v2（临时文件 + 原子改名，沿用 `secret-store.cjs:17-21`）→ 读回自检通过才删 v1 备份。`secret-store.cjs:23-68` 的“不覆盖、解封失败即停”的规则不变。
- **可选：启动时 Windows Hello**。若核实 PCP 密钥可设使用条件（或改用 Passport KSP 的密钥），则包裹密钥加“每次启动一次手势”；只用于启动，不用于后台逐次操作（Y5 §7.2）。G2，待核实后定。

### 4.5 无 TPM、TPM 故障、主板更换

| 情形 | 行为 | 恢复 |
|---|---|---|
| 无 TPM 2.0 / PCP 不可用 / 自检失败 | 软件密钥（今天的形态）；设备页写“软件密钥（原因：…）”；证书 `keyProtection: software`；管理员名册与成员列表同样显示 | 律所策略可设“仅硬件密钥”（收紧类）：管理员界面对软件密钥设备的入组申请给出明显提示，策略开启时拒签 |
| TPM 存在但运行中签名失败（暂时性） | 主进程重试 3 次（退避）；失败则内核进入“只读 + 不出站”并告警；本地已解密的工作照常读 | 重启；仍失败按下一行 |
| TPM 被清除、固件更新重置（厂商相关，待核实）、**主板更换** | TPM 内层解不开 → 数据库主密钥取不回 → 应用拒启（不覆盖，同今天） | **设备恢复文件 v3**：律师口令 + 原磁盘数据 → 取回数据库主密钥与加密私钥 → 在新 TPM 上重建包裹层 → 生成新签名密钥 → 走“同一成员换签名密钥”的续期申请（一名管理员批准）→ 旧证书留档 |
| 磁盘也坏了 | 本机账本与工作区不可恢复 | 事项数据靠同事设备与共享文件夹同步、或律所恢复仪式（§3.7）；如实告知 |

**设备恢复文件 v3**（`api/index.ts:2740-2830` 改）：内容 = 加密私钥 + 数据库主密钥 + 设备编号 + 证书摘要，**不含签名私钥**（TPM 下不可导出；软件密钥设备也不再导出签名私钥，恢复后一律换签名密钥，消除“备份文件可冒充本设备签名”的风险）；scrypt 参数从 N=2^15 提到 N=2^17（内存约 128 MiB，`root.ts:114-119` 的 `maxmem` 相应调整；Node 是否已内置 Argon2id 待核实，若有则改用）。**开通流程要求导出一次恢复文件并演练导入**（v9 §9.11“创建第一个真实事项之前完成一次恢复演练”）。

### 4.6 设备页如实显示“硬件密钥 / 软件密钥”

`apps/desktop/src/pages/Connections.tsx:201-207`“本机安全码”之后新增“密钥保护”一行，内核 `devices.list`（`api/index.ts:2385-2395`）返回 `key_protection` 与主进程 `stats()`：

| 状态 | 显示 |
|---|---|
| tpm2 | “硬件保护：签名密钥在本机安全芯片（TPM 2.0）中，不能被拷走。以你的 Windows 账户运行的程序仍能在电脑开着时调用它。” |
| software | “软件保护：本机没有可用的安全芯片（原因：未检测到 TPM 2.0 / 已禁用 / 自检失败）。签名密钥加密保存在本机。” + “如何开启 TPM”说明链接 |
| 数据库主密钥 | “数据库密钥：Windows 账户保护 + 本机安全芯片保护” 或 “仅 Windows 账户保护” |
| 签名计数 | “今日由安全芯片签名：控制面同步 N 次、管理员签名 N 次、回执 N 次” |

成员列表中别人的设备：显示“硬件（设备自报）”。**TPM 密钥证明（attestation）**能让控制面与管理员验证“确实在 TPM 中”，PCP 支持相关属性（Chromium 用到 `NCRYPT_PCP_TPM_WEB_AUTHN_ATTESTATION_STATEMENT` 等），但涉及 EK 证书链与厂商根，列为 G2。

环境自检（`kernel/src/services/env-probe.ts`）增 TPM 一行，数据来自主进程 `probe()`（`Tbsi_GetDeviceInfo` 不需要管理员权限；`Get-Tpm` 需要，故不用）。

---

## 5. 删除即轮换本机包裹密钥（F9）

### 5.1 为什么只有在包裹密钥能被真正销毁时才有意义

快照里的解密链：`ledger-key`（DPAPI）→ `ledger.db`（`matter_keys` 中给本设备的 ECIES 包裹）+ `device.json`（加密私钥）→ 事项密钥 → 块密文。三点结论：
1. **轮换必须针对“每事项的本机静态包裹”**，而不是加密私钥：加密私钥不随删除而换，现在活着的私钥能解开快照里旧账本中的 ECIES 包裹。所以本机静态形态要改成“本机包裹密钥 LWK 第 g 代包裹”，并且**本机不再保存给自己的 ECIES 包裹行**（收到后即转成 LWK 包裹）。
2. **LWK 必须放在快照恢复不回来的地方**。若 PCP 密钥文件确如第三方资料所述在 `%LOCALAPPDATA%\Microsoft\Crypto\PCPKSP\`，卷影副本就会保存它，在同一台电脑上恢复该文件即可重新装载（TPM 存储根未变）——`NCryptDeleteKey` 删的只是当前文件。能真正销毁的是 TPM 内部状态：NV 索引或持久对象；它们的定义一般需要所有者授权，Windows 默认是否保留、普通用户能否使用，**待核实**。
3. 同步来的数据（共享文件夹里的同步段带有给本设备的包裹行，`sync-engine.ts:489-494`）不在本机快照的范围内，加密私钥不轮换时它们一直可解——列为残余。

因此：**F9 的密码学擦除，对“快照或备份被拿到另一台电脑”成立（这来自 TPM 包裹层本身），对“同一台电脑上恢复快照”只能尽力**。

### 5.2 设计（决定）

- 新表：`local_wrap_gens(gen PRIMARY KEY, key_name, provider, status: pending|active|retired|destroyed, created_at, destroyed_at)`；`local_matter_keys(matter_id, epoch, gen, ct)`（`ct = AES-256-GCM(LWK_gen, 事项密钥)`，附加数据 = `matter_id|epoch|gen`）。
- LWK_g 本身 32 字节随机，由 TPM 包裹密钥 `…/lwk/<g>` 包裹存于 `local_wrap_gens`（TPM 不可用时由数据库主密钥派生密钥包裹——**此时轮换没有任何快照防护效果**，回执须如实写）。
- 收到或生成事项密钥时：写 `local_matter_keys`（当前代），删除本设备在 `matter_keys` 中的 ECIES 行（同步引擎导出时按需从 LWK 解出再给同事设备包裹，`sync-engine.ts:172`）。
- `blob-cipher.ts:12-21`、`ws-keys.ts:48`、`sync-engine.ts:86-90` 的 `resolveMatterKey` 改为先查 `local_matter_keys`，旧行回落 ECIES（迁移期）。

**删除事项时的两阶段轮换**（挂在 `matter-lifecycle.ts:138-189` `purgeMatter` 删除事务之后）：

| 步 | 动作 | 持久化点 |
|---|---|---|
| 1 | 生成 LWK_{g+1}，在 TPM 中建包裹密钥 `…/lwk/<g+1>`，写 `local_wrap_gens(g+1, pending)` | 提交 ① |
| 2 | **单个 SQLite 事务**：对除被删事项外的全部 `local_matter_keys(gen=g)` 解出、以 g+1 重新包裹插入；`g+1 → active`、`g → retired` | 提交 ② |
| 3 | 删除 `gen=g` 的全部行 | 提交 ③ |
| 4 | `deleteKey(…/lwk/<g>)` 并删除 PCP 密钥文件；`g → destroyed` | 提交 ④ |
| 5 | 删除回执的“本机包裹密钥”一项由 `pending` 改 `done` | 回执补签 |

**崩溃一致性**（启动时 `recoverLocalWrapGens()`，在 `applyStagedRecovery` 之后、任何组件装载密钥之前，`index.ts:100-103`）：
- 有 `pending` 而无对应 `active` 切换（断在 ①–② 之间）→ 删除该 pending 代的 TPM 密钥与行，回到 g（被删事项的行在步骤 2 之前仍在 g 代中——所以**删除事务本身必须先删掉被删事项在 g 代的行**，即把“删被删事项的 LWK 行”并入 `purgeMatter` 的删除事务，`matter-lifecycle.ts:189` 旁）；然后重新执行轮换。
- 有 `retired` 未 `destroyed`（断在 ②–④ 之间）→ 完成 ③④。
- 不变量：任何时刻都有且只有一代 `active` 完整覆盖全部存活事项；旧代只在新代提交之后销毁；被删事项的密钥在删除事务提交时已不在任何代中。
- 开销：重新包裹 N 把 32 字节密钥 + 两次 TPM 操作，N=1,000 时应在秒级以内（待实测）。
- 连续删除多件事项：排队合并为一次轮换（批量删除只轮换一次）。

**`FilesNotToSnapshot`**：律所版全机安装时（需管理员，`build/installer.nsh`）登记本产品数据根下密钥相关文件与 PCP 密钥文件目录中本产品的文件。微软说明它“尽力而为、不保证删除”，且对部分快照（如用 Vssadmin 创建的）无效——只能作为补充（Microsoft Learn《Excluding Files from Shadow Copies》）。是否登记 PCPKSP 目录（系统目录、只能按文件名通配到本产品的密钥）待实机确认文件名可预测。

**G1 技术探针（建议立项 2 人日）**：在 TPM 测试机上验证 ① PCP 密钥文件位置与“恢复文件后能否再次装载”；② 普通用户经 TBS 定义 NV 索引或建立持久对象是否可行；③ `FilesNotToSnapshot` 对系统还原点的实际效果。三项结果决定对外口径能否从“尽力”升级。

### 5.3 测试与验收

- 软件模拟：`kernel/test/f9-rotation.test.ts` 用 `FakeTpmProvider`（删除即真的不可再取）跑：删除后旧代密钥不可取、存活事项可读、被删事项不可读；**故障注入**在步骤 ①②③④ 之后各崩溃一次，重启后不变量成立、无事项丢失；批量删除只轮换一次。
- 实机：快照前后对照（§6.3 TPM-11）。

---

## 6. 测试策略

### 6.1 可在 macOS/Linux CI 用软件模拟的

| 范围 | 做法 |
|---|---|
| 签名者抽象、算法敏捷 | `SoftwareDeviceSigner` 两种算法（Ed25519 / 软件 P‑256）；**全量用例按算法跑矩阵**（环境变量 `ZR_TEST_SIGN_ALG=p256`），确认所有核验点都已分派 |
| TPM 行为 | `FakeTpmProvider`：不可导出（导出调用直接抛错）、可注入延迟（模拟 200 ms 签名）、可注入故障（暂时失败、永久失效）、“删除即不可再取” |
| 会话密钥 | 账本核验、跨会话序号窗口、会话证书伪造、闸门与同步段 |
| 证书链 v2、信任锚、根交接 | 纯函数；控制面服务端用现有测试控制面（`kernel/test/cloud-cp.ts`） |
| 入组流程 | 内核 + 测试控制面 + 两台“设备”（两个工作区）端到端 |
| Shamir 与份额编码、仪式状态机 | 纯函数 + 注入网络探测器 |
| F9 两阶段轮换 | 故障注入 |
| `secret-store` v2 | 注入假的 safeStorage 与假的 KeyProvider（`secret-store.cjs` 已是依赖注入写法，`secret-store.cjs:1-12`） |
| 恢复文件 v3、主板更换流程 | 模拟“TPM 丢失”（FakeTpm 清空） |

### 6.2 只能在 Windows 实机（TPM 测试机）验收的

原生模块的全部真实行为、PCP 算法支持、签名延迟、密钥文件位置、快照恢复、TPM 清除与主板更换、离线检测在真实网卡上的判定、仪式窗口的防截屏与剪贴板、Authenticode 与原生模块完整性核验、WER 排除对仪式进程生效。

**测试机需求**（外部依赖）：至少 4 台——Intel PTT（fTPM）Win11 专业版、AMD fTPM Win11、独立 TPM（Infineon 或 Nuvoton）Win11、无 TPM 或 TPM 关闭的 Win10 22H2；另加 1 台带虚拟 TPM 的 Hyper‑V 虚拟机作自托管 CI 运行器（GitHub 托管的 Windows 运行器是否提供 TPM 待核实，按“没有”计划）。

### 6.3 验收用例清单

| 编号 | 用例 | 环境 |
|---|---|---|
| KP-01 | 软件 P‑256 矩阵下全量用例通过 | CI |
| KP-02 | 每个签名调用点都经 `DeviceSigner`/`SessionSigner`（静态扫描：生产代码不再出现 `signPrivateKeyPem` 读取，除 `SoftwareDeviceSigner`） | CI |
| KP-03 | 高 S 签名被拒；同一消息两种编码只认 P1363 | CI |
| CH-01 | 根签管理员证书、管理员联署成员证书、门限不足拒绝、管理员签 admin 角色拒绝 | CI |
| CH-02 | 签发后管理员证书过期，成员证书仍有效；管理员 `compromised` 吊销后相关成员证书失效、`retired` 不失效 | CI |
| CH-03 | 团队版升律所版：旧证书按签发时门限有效；新证书须 2 名 | CI |
| CH-04 | 信任锚版本回放、跳跃、同版本不同内容均拒绝 | CI |
| EN-01 | 邀请 → CSR → 两名管理员联署 → 登记，端到端 | CI |
| EN-02 | 控制面替换 CSR 公钥 → 安全码不一致 → 管理员拒签 | CI |
| EN-03 | 控制面换根 → 新设备根指纹与邀请不符 → 拒绝固定 | CI |
| EN-04 | 待批准设备不能建事项、不能出站 | CI |
| SH-01…05 | 份额编码往返、任两片重建、错字定位、混集拒绝、团队版恢复码 | CI |
| CE-01 | 仪式各状态网络翻转即中止、无秘密写盘、无秘密进 IPC | CI（注入）+ 实机 |
| CE-02 | 回读不一致不前进；三组合重建一致 | CI |
| CE-03 | `firm_root.offline_sealed` 内容齐全、不含秘密（按诊断包同法自证） | CI |
| CE-04 | 季度核验只比 tag；输入错误片不泄露是哪一位错（只给行号） | CI |
| CE-05 | 断网判定矩阵：有线、Wi‑Fi、手机 USB 共享、Hyper‑V 虚拟交换机、VPN 残留网卡 | 实机 |
| MG-01 | 存量迁移：根交接 + 冷静期 + 冲突交接冻结 + 设备人工确认 + 历史签名仍可验 | CI |
| MG-02 | 恢复包裹迁移进度与完成前不删旧份额 | CI |
| SS-01 | 会话证书核验、跨会话序号伪造被拒、闸门与同步段按会话证书验 | CI |
| TPM-01 | `probe()` 在 4 类机器上的输出与自检结果 | 实机 |
| TPM-02 | 创建 P‑256 签名密钥、签名、Node 侧验签；导出尝试失败 | 实机 |
| TPM-03 | 签名延迟 P50/P99（100 次）；主进程事件循环不被阻塞 | 实机 |
| TPM-04 | `ledger-key` v1 → v2 升级、读回、失败不覆盖 | 实机 |
| TPM-05 | 把数据根与 `ledger-key` 拷到另一台同账户电脑 → 解不开 | 实机 |
| TPM-06 | 清除 TPM 后启动 → 拒启并给出恢复指引；用恢复文件 v3 恢复 | 实机 |
| TPM-07 | 无 TPM 机器：软件密钥、设备页如实显示 | 实机 |
| TPM-08 | 原生模块摘要被改 → 主进程拒载并退到“软件密钥 + 告警”还是拒启（**决定：拒启**，与运行时清单一致） | 实机 |
| TPM-09 | 主进程签名域白名单：内核请求非白名单前缀被拒 | CI（假提供者）+ 实机 |
| TPM-10 | ECDH 与 RSA‑OAEP 支持探测（定包裹算法） | 实机 |
| TPM-11 | F9：删除事项 → 创建卷影副本前后对照 → 恢复旧 PCP 密钥文件能否再装载（定对外口径） | 实机 |
| TPM-12 | 机器级密钥（节点）在 `ProgramData` 下的行为与权限 | 实机 |

---

## 7. 实施拆分、人周、外部依赖与“现在就能做”

### 7.1 对齐 v9.2 §4.6 C6

C6 原文：“TPM 密钥、根私钥离线仪式、设备编号按安装、中继客户端”，8 人周。本稿覆盖前三项，不含中继客户端。

### 7.2 工作量（人周，传统估算；本项目编码类按实际速度另行下调）

| # | 工作项 | 人周 | 依赖硬件 | 阶段建议 |
|---|---|---:|---|---|
| W1 | 签名者抽象 + 软件实现 + 全部调用点改造 | 1.5 | 否 | G1 必做 |
| W2 | 算法敏捷（证书 `signAlg`、核验分派、P1363 与低 S、域前缀） | 1.0 | 否 | G1 必做 |
| W3 | 会话签名密钥（账本、批准凭据、同步段） | 1.0 | 否 | G1 必做 |
| W4 | 证书链 v2、信任锚、核验点替换、控制面服务端 | 2.0 | 否 | G1 必做 |
| W5 | 入组（邀请、CSR、联署、有限模式、设备编号按安装、界面） | 2.5 | 否 | G1 必做 |
| W6 | 份额编码 + 仪式进程与状态机 + 离线检测 + 卡片与回读 + 审计 + 季度核验 + 界面 | 3.0 | 部分 | G1 必做 |
| W7 | 恢复托管并入 FMS、恢复事项改仪式路径 | 0.5 | 否 | G1 必做 |
| W8 | 原生模块、构建签名、主进程接入、`secret-store` v2、设备页 | 2.0 | **是** | G1 必做 |
| W9 | 恢复文件 v3 与主板更换流程 | 0.5 | 部分 | G1 必做 |
| W10 | F9 代际包裹与两阶段轮换 + 实机探针 | 1.0 | 部分 | 可后移 |
| W11 | 存量根轮换工具（交接、冷静期、恢复包裹迁移） | 1.0 | 否 | 首家存量律所前 |
| W12 | Windows 实机验收（§6.3 TPM 与 CE-05） | 1.0 | **是** | G1 必做 |
| | **合计** | **17.0** | | 必做约 15，可后移约 2 |
| | Windows Hello 启动门控、TPM 证明、国密 | — | 是 | G2 |

**结论**：C6 的 8 人周不够（§9 第 1 项）。若必须守 8 人周：保留 W1、W2、W4、W5（单管理员门限先行）、W6 的核心（份额编码与仪式，界面从简）、W8，约 11 人周，仍超；须拍板扩大 C6 或接受 G1 首家律所版先以“根离线 + 软件密钥”上线、TPM 在 G1 后半补上。

### 7.3 外部依赖

| 依赖 | 阻断 | 负责 | 截止建议 |
|---|---|---|---|
| 代码签名证书（EV/OV；与 v9.2 §7.3 同一项） | 原生模块正式签名 | 中软 IT/法务 | 11-20 |
| TPM 测试机 4 台 + 带 vTPM 的自托管运行器 | W8、W12、F9 探针 | 测试负责人 | 11-07 |
| 试点律所电脑盘点增“TPM 2.0 是否可用”（env-probe 先行版） | 硬件比例与降级口径 | 产品 | 11-20 |
| 法务：分片保管人制度文本（保管协议、离职交接、公证保管可选）、仪式记录的证据效力 | 律所版开通 | 法务 + 试点律所 | G1 前 |
| 中软开户流程与“开通码”交付渠道 | 控制面开通 v2 | 中软运营 | M1 |
| 预印空白分片卡与仪式说明（印刷） | 开通仪式 | 产品 | G1 前 |

### 7.4 现在就能做、无需硬件（按优先级）

| 优先 | 项 | 文件落点 | 测试 |
|---|---|---|---|
| 1 | **签名者抽象**：`DeviceSigner`/`SessionSigner` 接口与 `SoftwareDeviceSigner`；把 `signPrivateKeyPem` 的 12 处传递改为签名者（`ledger-signer.ts:64`、`egress-approvals.ts:24,129`、`matter-lifecycle.ts:29,287`、`matter-archive.ts:36,257`、`diagnostics.ts:26,244`、`segment.ts:72,77`、`sync-engine.ts:207`、`api/index.ts:317,993,1801,3038`、`client.ts:37,108,396`、`admin.ts:19`、`request-auth.ts:42`）；行为不变 | `packages/keys/src/signer.ts`（新） | 全量用例不变通过 + KP-02 静态扫描 |
| 2 | **算法敏捷**：`verifyBytes` 分派、P1363 + 低 S、证书 `signAlg`、显式算法、所有 `verify(null,…)` 改调；软件 P‑256 签名者 | `signing.ts`、`device.ts`、`admin.ts:84`、`request-auth.ts:79`、`egress-gate/src/approval.ts:108` | KP-01 矩阵、KP-03 |
| 3 | **Shamir 2-of-3 与份额编码** `kwl-share/1`、团队版恢复码、tag、季度核验函数；GF 常量时间乘法 | `packages/keys/src/share-codec.ts`（新）、`shamir.ts` | SH-01…05、CE-04 |
| 4 | **证书链 v2 与信任锚**：格式、`verifyCertChain`、`verifyAnchor`、核验点替换、控制面 `enroll v2` 与链核验 | `firm-trust/src/chain.ts`（新）、§2.3 所列核验点、`server.ts:515-570` | CH-01…04 |
| 5 | **离线仪式状态机**（纯逻辑，注入网络探测器与时钟）+ FMS 派生 + 仪式记录格式 + `firm_root.*` 事件码登记（safe-log 事件表） | `packages/ceremony/`（新包） | CE-01（注入）、CE-02、CE-03 |
| 6 | 入组：邀请、CSR、联署、有限模式、设备编号按安装（D-42） | `devices.ts:376-470`、`api/index.ts`、控制面 | EN-01…04 |
| 7 | 会话签名密钥（账本、批准凭据、同步段） | `ledger-signer.ts`、新迁移、`egress-gate`、`sync-engine.ts` | SS-01 |
| 8 | 恢复托管并入 FMS、`recovery.restore_matter` 改仪式输出 | `devices.ts:134-191`、`api/index.ts:2673-2738` | MG-02 部分 |
| 9 | F9 代际包裹与两阶段轮换（`FakeTpmProvider`） | `kernel/src/local-wrap.ts`（新）、`matter-lifecycle.ts:189`、`blob-cipher.ts` | §5.3 故障注入 |
| 10 | 恢复文件 v3 | `api/index.ts:2740-2830`、`devices.ts:239-358` | 改写 `device-recovery.test.ts` |
| 11 | 存量根交接与历史根 | `governance.ts`、新迁移、控制面 | MG-01 |
| 12 | 原生模块的 C++ 骨架与 JS 门面、`FakeTpmProvider`、`secret-store` v2（假提供者） | `packages/kwl-tpm/`、`apps/desktop/electron/key-provider.cjs` | 只在 Windows CI 编译；逻辑用假提供者测 |

---

## 8. 对外如实声明的更新（对比 Y5 §7.3）

Y5 §7.3 是“当前版本”的五条。G1 律所版按本设计落地后，建议改为下文；**同一版本中，设备有无 TPM 的说法不同，由设备页与律所管理员页按实际状态显示，白皮书两种都写**。

> **本机密钥保护（律所版，G1 起）**
> 1. 案件数据在本机加密保存。解密所需的数据库密钥受两层保护：Windows 账户（DPAPI）与**本机安全芯片（TPM 2.0）**。把数据或备份拷到另一台电脑、或由域管理员离线解开 Windows 账户保护，都无法解密。**以您的 Windows 账户在这台电脑上运行的其他程序（包括恶意软件），在电脑开着时仍可以调用同一保护机制**。（无可用安全芯片的电脑：只有 Windows 账户这一层，设备页会显示“软件保护”。）
> 2. 设备签名密钥生成并保存在本机安全芯片中，**不能被导出或拷走**；但同上，本机运行的程序在电脑开着时可以请求它签名。为降低这一影响，记录日常操作的签名使用每次启动生成、只在内存中的临时密钥，它由安全芯片中的设备密钥签发。（无安全芯片的电脑：签名密钥加密保存在本机文件中。）
> 3. **律所根密钥不在任何联网电脑上**：它在开通仪式中生成，按“三份取二”写在三张纸质分片上，由律所指定的三人分别保管；任何一人单独无法使用。增加成员设备由律所管理员（律所版两名）在各自电脑上核对后联合签发，不需要根密钥。中软不保管根密钥或任何分片。开通仪式在断网状态下进行，但断网检测不能防止仪式电脑上已存在的恶意软件，因此我们建议使用全新安装的电脑完成仪式。
> 4. 删除事项会销毁本机密钥并删除数据，并更换本机用于保护其余事项密钥的包裹密钥。**Windows 还原点、文件历史和备份软件中的旧副本不在删除范围内**：这些副本若被拿到另一台电脑，无法解密；若在同一台电脑上恢复，我们已请求系统在快照中排除相关密钥文件，但 Windows 只按“尽力而为”处理，不能保证。
> 5. 我们建议开启 BitLocker，并为本应用使用本机（非漫游、非重定向）的用户目录；设备页“电脑环境”会提示不符合之处。

**相对 Y5 §7.3 的变化**：第 1 条增加“TPM 层”与“拷走、域管理员离线”的收益，保留“同账户程序可调用”的残余；第 2 条从“尚未存放在 TPM”改为“在 TPM、不可导出、但可被调用”，并如实说明会话密钥；第 3 条从“根密钥在各成员电脑上”改为离线分持，并写出仪式的局限；第 4 条从“不在删除范围”细化为“拿到别的电脑解不开 / 同机恢复尽力而为”；第 5 条不变。**在 F9 实机探针（§5.2）得出结论之前，第 4 条后半句不得改得更强。**

---

## 9. 风险与待拍板项

| # | 风险或待拍板 | 影响 | 建议 |
|---|---|---|---|
| 1 | **C6 8 人周不够**（本稿约 17，必做约 15） | G1 律所版日期 | 拍板：C6 扩到 15 人周；或 G1 首家律所版先“根离线 + 软件密钥”，TPM（W8、W12）在 G1 后半补齐并如实标注 |
| 2 | **仪式电脑可信度**：断网挡不住已潜伏的恶意软件暂存根秘密、联网后外发 | 根秘密泄露 = 全所签名信任失效 | 默认要求全新安装、未入域、只装本产品的电脑（可由中软实施人员携带）；退而求其次：管理员电脑 + 仪式前全盘扫描 + 仪式后立即重新分片的选项。待拍板：是否由中软提供“仪式专用电脑”服务 |
| 3 | **PCP 密钥文件在快照中可恢复**，F9 对同机快照只能尽力 | 删除回执与对外口径 | 先做 G1 技术探针（2 人日）；结论出来前口径按 §8 第 4 条；若 NV 方案可行再升级 |
| 4 | **TPM 签名延迟与可用性**（fTPM 与独立 TPM 差异、厂商固件问题，待实测） | 同步、批准、回执卡顿；TPM 故障时应用不可用 | 会话密钥承担高频签名；TPM 只签低频单据；暂时失败重试、永久失败走恢复文件 v3 |
| 5 | **律所版每台新设备要两名管理员批准**的运营负担 | 入组慢、律师抱怨 | 默认 2 名（与放宽策略同门限，挡单点）；待拍板：允许“1 名管理员 + 成员本人已登记设备”替代第二名管理员（仅限成员为自己加设备） |
| 6 | **主板更换、TPM 清除导致本机数据库打不开** | 本机账本与工作区丢失 | 开通流程强制导出恢复文件 v3 并演练导入；IT 更换主板前在设备页“准备更换电脑”导出 |
| 7 | **分片持有人不可用**（两人同时离开、去世、失联） | 无法更换管理员、无法律所恢复 | 三片分散（主任、风控合伙人、保险柜或公证保管）；季度核验发现异常立即重新分片；法务出保管制度 |
| 8 | **存量迁移时旧根持有人抢先发布交接声明** | 律所信任被劫持 | 双签 + 72 小时冷静期 + 冲突即冻结 + 设备端人工确认新根指纹；试点前的开发数据一律重新开通 |
| 9 | **偏离登记**：v9 第 02 篇 §9.11 写“P‑256 + HPKE”，代码与本稿：根 Ed25519、设备签名 P‑256（新）/ Ed25519（存量）、加密 X25519 ECIES | 方案与实现不一致 | 登记为新偏离（建议编号 D-69；D-65 已被第 5 批占用）：根保持 Ed25519，加密保持 X25519 ECIES（不进 TPM，换算法无收益）；国密套件另立项 |
| 10 | **ECDSA 引入的验证面**（签名可塑、DER/P1363 混用、`sign(null)` 隐式摘要） | 签名比较、去重出错 | 统一 P1363 + 低 S + 显式 `sha256`；KP‑03 门禁 |
| 11 | **原生模块供应链**（证书未到位、DLL 劫持、摘要核验遗漏） | 主进程被植入 | 只从 System32 装系统 DLL；摘要入 asar 清单、核验后才装载；摘要不符拒启 |
| 12 | **国密要求**（政企律所可能要求 SM2/SM3/SM4；TPM 2.0 芯片对 SM2 的支持依厂商与 Windows PCP 是否暴露，待核实） | 部分客户准入 | G2 立项：国密软件套件先行，硬件看国产 TPM/TCM 与 Windows 支持 |
| 13 | **管理员证书 27 个月、每 2 年例行仪式**的负担；管理员换机须开仪式 | 运营 | 待拍板：是否允许“既有门限管理员联署 + 本人旧设备”签发同一成员的替换管理员证书（不扩权） |
| 14 | **会话密钥残余**：内核内存被读可在会话窗口内伪造见证 | 审计链可信度 | 会话 ≤ 24 小时；会话开始行由 TPM 直签；对外口径已写明（§8 第 2 条） |
| 15 | **设备自报 `keyProtection`** 未经证明 | 管理员误以为全所都是硬件密钥 | 界面写“设备自报”；TPM 证明列 G2 |
| 16 | **Windows Hello 能否门控 PCP 密钥**待核实 | 可选功能落空 | 不进 G1 承诺；核实后再定 |
| 17 | **相对 v9.2 §3.5 的收窄①：TPM 包裹层只包数据库主密钥**（§3.5 写“加密私钥与主密钥加 TPM 包裹层”） | 设备加密私钥文件由数据库主密钥派生的密钥封装，效果等同；但与方案原文不一致（复核 S6B-13） | 拍板认可后登记偏离；不认可则加密私钥另加一层 TPM 包裹（+0.5 人周） |
| 18 | **相对 v9.2 §3.5 的收窄②：团队版只有单张恢复码；恢复托管由 3-of-5 并入律所主秘密 2-of-3**（§3.5 写“根私钥 2-of-3 线下分持”，未述团队版与恢复托管） | 团队版单点保管；恢复托管份额数变化（复核 S6B-13） | 拍板：团队版是否也要求 2-of-3；恢复托管并入是否接受 |

---

## 附 A：出处（访问日期均为 2026-10-15）

- Microsoft Learn，《CNG Key Storage Providers》：https://learn.microsoft.com/en-us/windows/win32/seccertenroll/cng-key-storage-providers （PCP 小节无算法表）
- Chromium，`crypto/unexportable_key_win.cc`：https://chromium.googlesource.com/chromium/src/+/refs/heads/main/crypto/unexportable_key_win.cc （P‑256 ECDSA 与 RSA、`NCryptIsAlgSupported`、`Tbsi_GetDeviceInfo` 要求 TPM 2.0、r‖s 转 DER、虚拟隔离提供者）
- ElMostafaIdrassi/pcpcrypto（第三方）：https://github.com/ElMostafaIdrassi/pcpcrypto （PCP 密钥文件位置；待实机核实）
- Microsoft Learn，《Registry Keys and Values for Backup and Restore》：https://learn.microsoft.com/en-us/windows/win32/backup/registry-keys-for-backup-and-restore
- Microsoft Learn，《Excluding Files from Shadow Copies》：https://learn.microsoft.com/en-us/windows/win32/vss/excluding-files-from-shadow-copies （FilesNotToSnapshot 为尽力而为、对 Vssadmin 创建的快照无效）
- Microsoft Learn，Windows 11 兼容性与最低要求：https://learn.microsoft.com/en-us/windows/compatibility/windows-11 （TPM 2.0）
- SatoshiLabs，SLIP‑0039：https://github.com/satoshilabs/slips/blob/master/slip-0039.md （GF(256) 0x11b、RS1024 校验、摘要份额、拒绝 x=0、不自动纠错）
- Electron，《Using Native Node Modules》：https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
- Electron 博客，《Electron and the V8 Memory Cage》：https://www.electronjs.org/blog/v8-memory-cage
- [MS‑BKRP]（DPAPI 域备份密钥，沿用 Y5 §7.1 的引用）：https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-bkrp/
- 本机实测：Node v26.8.1 P‑256 `sign(null)` 产出 DER、`dsaEncoding: "ieee-p1363"` 产出 64 字节（2026-10-15）

## 附 B：待核实清单（汇总）

1. PCP 对 ECDH P‑256 与 RSA‑OAEP 解密的支持（TPM‑10）。
2. PCP 用户与机器密钥文件的确切位置、命名，以及“恢复旧文件能否再次装载”（TPM‑11）。
3. 普通用户经 TBS 使用 NV 索引或持久对象的可行性；Windows 默认所有者授权的保留级别。
4. `FilesNotToSnapshot` 对系统还原点与“以前的版本”的实际效果。
5. TPM 签名延迟（各类芯片）（TPM‑03）。
6. GitHub 托管 Windows 运行器是否提供 TPM。
7. electron-builder `signExts` 缺省是否签 `.node`。
8. Windows Hello 能否门控 PCP 密钥，或须改用 Passport KSP / `KeyCredentialManager`。
9. 固件更新或 BIOS 设置变更导致 TPM 清除的厂商差异。
10. Node 26 是否内置 Argon2id；Node 权限模型能否禁止网络。
11. 在 Node `Buffer` 上用 `VirtualLock` 锁页的可行性。
12. PIV 硬件钥对 Ed25519 的支持（方案 D 的可选载体）。
13. 国产 TPM/TCM 与 Windows PCP 对 SM2 的支持。
14. 试点律所电脑 TPM 2.0 可用比例。
