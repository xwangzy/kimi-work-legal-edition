# impl-C 云端进度（第 73 批，W1）

> 范围：`platform/services/control-plane/**`、`platform/cloud-repo/**`、`platform/scripts/stack-local.mjs`。没碰内核、出站闸门、律师端与 `docs/privacy`。没有提交（主会话统一提交），没有启停本机栈（18740～18746）与律师端实例。
> 契约变更：`03-契约变更记录.md` 两行（`/v1/meta` 不加版本号；名单鉴权的错误码口径补全）。

## 1. `GET /v1/team/roster`（契约 1.1，D-308）

- 位置：`platform/services/control-plane/src/server.ts`，memberRoute 里（`/v1/team/*` 本来就走会话路由）。
- 鉴权：本人账号会话（`sessionOf`：被移出 401 `session_team_removed`、退出 401 `session_team_left`、停用会话已撤 401）→ 团队空间（个人空间 403 `team_only`）→ 这台电脑的设备签名（`authDevice`，缺签名 401 `device_auth_*`）→ 会话与设备同一租户、同一成员（否则 403 `session_member_mismatch`）→ 会话须是客户端会话、且没绑别的电脑（否则 401 `session_invalid`；还没绑设备的客户端会话照样可读，不在这里绑）。平台停用了这个人（主账号）时会话 403 `account_disabled`（现有口径）。
- 应答：`{ ok: true, tid, members: [{ member_slug, name, role, status }] }`；按姓名（`Intl.Collator("zh-Hans-CN")`）再按成员标识排序；只含本租户账号；`status`：`active`（`memberActive`）/ `removed`（团队移出）/ `left`（本人退出）/ `disabled`（团队停用、平台停用这个身份或这个人）。不含邮箱、手机号、aid、设备。
  - `member_slug` 不是新暴露：它就是设备证书里 `usr_<firm>_<member_slug>` 的后半段，本所设备目录 `/v1/directory` 早已对每台成员电脑公开。
- **验收 P2 补（07396e70 之后，未提交）**：每人加 `seat: boolean`（此刻是否占有席位，只有是 / 否，不给席位编号与额度）——没有席位的成员领不到中继凭据、同步永远失败，负责人据此看出是谁、为什么。用例加 R7（与管理员成员页的席位一致；收回 / 分配后名单随之变化，来回一次）；R4 字段集改为五项、不含 `sid`；R6 加“移出 / 停用 / 退出即无席位”。契约变更见 `03` 第 W1 第三行；CONTRACT.md 与运维手册 v1.8.0 行同步。控制面全量用例 258 / 258。
- `/v1/meta.features` 追加 `team_roster`（无条件）。
- 用例 `platform/services/control-plane/test/b73-team-roster.test.ts`（7 条）：features；律师（账号签发钥电脑）与管理员（律所根电脑）读到同一份、字段只有四项、按姓名排序、成员标识与证书成员编号对得上、不含邮箱 / aid / 设备编号；缺会话 / 缺签名 / 别人的会话 / 网页会话 / 已绑别的电脑的会话；个人空间 403；跨租户（另一团队的会话配本团队电脑、反之）403、查询串写别的租户无效；移出 / 停用 / 退出后这些人的会话 401、名单标 `removed` / `disabled` / `left`、启用后回 `active`、平台停用这个人后名单记 `disabled`。

## 2. 共享中继纳入标准部署（契约 1.2，D-309）

| 文件 | 改动 |
|---|---|
| `cloud-repo/template/deploy/config/relay.example.json`（新） | `role: relay`、`listen 0.0.0.0:8446`、`tls` = 控制面的 `cp.crt` / `cp.key`（证书复用，钉住集相同）、`service_secret_file`、`control_plane`（同网关）、`seat_keys_file: /etc/kwl/public/seat-relay-public-keys.json`、`data_dir: /var/lib/kwl`（中继数据在 `/var/lib/kwl/relay`） |
| `deploy/scripts/relay-config.mjs`（新） | 按 `control-plane.json`（证书、服务间凭据、数据目录）与 `gateway.json`（控制面地址、`connect_address`）写 `/etc/kwl/relay.json`；已有配置只改地址与 `--port`；中继受众席位公钥表不在时从 `cp-signer.json` 的 `keys.seat_audiences.relay` 私钥导出（只写公钥）；签名服务没有中继受众密钥退出 3 并写明怎么补；公钥表混了别的受众、端口撞控制面退出 2；末行 `relay_base=https://<控制面主机>:<端口>` |
| `deploy/scripts/relay-setup.sh`（新） | 一步开通：relay-config → 改属主权限 → ufw 在用时放行端口（提示云安全组）→ `systemctl enable` + `restart kwl@relay` → 等 `/readyz` 200 → 核对中继证书公钥 = 控制面 → 纯公网 IP 部署重生成 `client-inputs/` → 打印 `relay_base` 与钉住值、律所开通提示 |
| `deploy/scripts/verify-capabilities.sh` | features 另核 `team_roster`；中继：已配置、已启用、`/readyz` 200、证书公钥与控制面相同（不同即缺项）；`--no-relay` 跳过 |
| `deploy/scripts/upgrade.sh` | 参数改循环（`--cp-origin`、`--no-relay`）；中继未开通时提示 relay-setup；末尾核对失败的说明改为按缺项分别处理（补签发钥 5.2 / 中继 5.3），退出码仍为 3 |
| `deploy/scripts/rollback.sh` | `--restore` 时中继数据（`relay`）与账本一样保留恢复前的那一份（不让段号倒退、不让已按租户删除的数据复活）；代码回滚不碰中继（1.7.x 代码里就有中继角色） |
| `deploy/scripts/healthcheck.sh` | 只补注释：按已装载的 `kwl@` 单元查，`kwl@relay` 自动在内 |
| `deploy/scripts/install.sh` / `ip-config.mjs` / `tls-ip.sh` | 纯公网 IP：`ip-config` 同时写 `relay.json`（不在时从样例新建，控制面地址 + `connect_address`）；`install.sh` 改属主时带上 `relay.json`、结尾提示 relay-setup；`tls-ip.sh` 续期热换与演示 CA 重启带上 `kwl@relay`，`pins` 在有 `relay.json` 时给说明文件写 `relay_base` 与 `pins.relay`（= 控制面钉住值），`pins.txt` 加一行 |
| `deploy/systemd/kwl@.service` | 只补注释（`kwl@relay`、数据目录在 `ReadWritePaths` 内） |
| `deploy/client-release-spec.example.json` | 加 `relay_base: https://cp.kwl.example.com:8446`、`relay_backup_pins`（同控制面备用钉住） |
| `docs/运维手册.md` | 5.1 加 v1.8.0 一行（变化；升级六步：upgrade → relay-setup → 安全组 8446 → verify → **发新客户端或分发带中继地址的 release.json** → 律所管理员开通；端口、证书复用、兼容、回滚）；新 5.3“开通共享中继”（命令、配置要点、交给客户端、律所侧、容量与按租户删除、停用）；监控表、备份说明、排障三行（“中软还没开通同事之间同步”“所内还没开通同事之间同步”“kwl@relay 起不来”）；运营接口一句改为“支持、通知与共享中继” |
| `docs/部署手册.md` | 全貌图与端口表加 8446；ufw 与安全组放行 8446（六个端口）；4.2 续期钩子 `try-reload-or-restart kwl@relay`、中继不单独签证书；4.3 备用钉住同控制面；4.5～4.7 中继随 IP / 域名一起改；第 5 节装 `seat-relay-public-keys.json`；第 6 节复制 / 表格加 `relay.json`；第 7 节跑 relay-setup 与 verify、预期输出、外部 curl 8446；上线清单加两项 |
| `docs/客户端接入.md` | 交付材料加 `relay_base` / 钉住；“改这些要重打 exe”加“v1.8.0 起新开通共享中继” |
| `CONTRACT.md` / `README.md` / `package.json` | 客户端路径加 `/v1/team/roster` 与应答口径、中继为标准服务；README 把 relay-api 从“可选”挪成标准服务；云端版本 **1.8.0** |
| `platform/scripts/stack-local.mjs` | 起中继：端口 base+6（本机栈 18746）、与控制面同一张证书（`--tls` 时）、只信中继受众席位公钥（缺了从签名服务密钥导出）、数据 `<dir>/data/relay`；`client.env` 写 `ZR_RELAY_BASE`（`--tls` 时另写 `ZR_RELAY_PINS` = 控制面钉住值） |

用例 `platform/services/control-plane/test/b73-relay-deploy.test.ts`（5 条，monorepo 与独立云端仓库两种布局都能跑）：样例口径；relay-config 生成 / 幂等 / `--port`；三类拒绝与 `--cp-url`；ip-config 写 relay.json 与 `--no-connect-address`；部署脚本 `bash -n`。

## 3. 验证结果

- `node --test services/control-plane/test/*.test.ts`：**257 / 257 通过**（含新增 12 条）。
- `npx tsc -b tsconfig.check.json` 与 `npx tsc -p tsconfig.check.json --noEmit`：干净（tsc 7.0.2；含别的工作线当下的改动）。
- `node cloud-repo/export.mjs --out <临时目录>`：238 个文件、导出校验（forbidden_imports、相对路径、运行时路径）无问题；随后 `--check` 一致。在导出目录里（手工链接工作区包）跑 b73 两个用例 + b52 ip-config 用例 13 / 13 通过；导出仓库全量用例（与云端 CI 的 `npm test` 同一命令，`--test-concurrency=1`）**448 / 448 通过**。
- 临时本机栈（`--base-port 19500`、草稿目录、假上游密钥、上游 `upstream.invalid`，不连任何外部服务，跑完即停）：中继 19506 `/readyz` 200，`client.env` 含 `ZR_RELAY_BASE=http://127.0.0.1:19506`，`/v1/meta.features` 含 `team_roster`。
- `tls-ip.sh pins` 在沙箱里（改 ETC 到临时目录）：无 `relay.json` 时说明文件不带中继；有时带 `relay_base: https://<IP>:8446`、`pins.relay` = 控制面钉住值，`pins.txt` 多一行；生成的说明文件经 `make-release-config --offline` 用客户端同一份校验代码通过，`release.json` 有 `relay_base` 与两把 `relay_pins`。

## 4. 发现（不在本批范围，未改）

- **`stack-local.mjs --tls` 早已起不来**：控制面拒绝 `console.origins` 里的 `http://127.0.0.1:<base+3>`（TLS 形态要求 https 来源），与本批无关；本批的 `--tls` 中继分支（复用 `cp.crt`、`ZR_RELAY_PINS`）因此没能端到端跑过。
- `scripts/cloud-smoke.mjs`（云端仓库 CI 的生产入口冒烟）还没起中继——不在本次授权范围，建议补一个 relay 角色。
- 内核侧（W2）要做的：出站闸门控制面白名单加 `^/v1/team/roster$`（`packages/egress-gate/src/cp-relay.ts`）与 `docs/privacy/egress-paths.json` 登记；按 `03` 第二行的错误码分支（401 `session_*` 走重新登录、403 `team_only` → `personal_workspace`、`/v1/meta` 没有 `team_roster` → `not_supported`）。

## 5. 需要主会话做的事

- 本机栈要**重启一次**才会起中继：照原命令重跑 `node scripts/stack-local.mjs --dir <原目录> --base-port 18740 …`（新中继在 18746，数据在 `<原目录>/data/relay`，不沿用 10c 演练时 18806 那份草稿数据），然后用新生成的 `client.env`（多了 `ZR_RELAY_BASE=http://127.0.0.1:18746`）重启律师端开发实例。
- 线上（1.7.0 → 1.8.0）按运维手册 5.1 v1.8.0 那一行：`upgrade.sh v1.8.0` → `relay-setup.sh` → 安全组放行 8446 → `verify-capabilities.sh` → 发带 `relay_base: https://legal.matetrip.cn:8446`（钉住集同控制面）的新客户端。
