# 桌面客户端与云端的接口契约（`kwl-cp/2`，客户端视角）

云端仓库 `kimi-work-legal-cloud` 的 `CONTRACT.md` 是这份契约的完整版本（路径白名单、令牌格式、错误码、额度视图字段）。本页只列**客户端写死依赖、改动须两端协调**的部分。

## 1. 客户端只从 release.json 取的东西

| 键 | 含义 | 规则 |
|---|---|---|
| `control_plane_base` / `gateway_base` / `search_base` | 控制面、法律模型网关、检索服务地址 | 必填三项；只许 `https://`；域名或 IP 都可以（IP 须在证书 SAN 里） |
| `dist_base` / `support_base` / `notify_base` / `relay_base` | 内容分发、诊断上传、期限提醒、共享中继 | 可选，同上 |
| `<上游>_pins` | 证书公钥钉住（`sha256/<base64>` SPKI 摘要） | 每个上游至少两把：当前 + 离线备份；证书链上任一证书命中即可 |
| `control_plane_keys` | 控制面文档签名公钥（Ed25519，2–8 把） | 信任锚，只随安装包 |
| `seat_keys` | 席位令牌公钥（1–8 把） | 信任锚，只随安装包 |
| `cloud_ca_pem` | 中软云端私有 CA（演示/测试部署） | 只许 `test_build: true`；只对中软上游生效、替换公共根 |
| `endpoint_profile` | `{deployment, keys}`：签名的云端地址配置的验签公钥 | 可选；有它客户端才读 `cloud-endpoints.json` |
| `update_*` | 自动更新源（Windows） | 可选 |
| `test_build` | 测试/演示构建标记 | 正式发布不写 |

## 2. 地址迁移（不重装客户端）

发布方用 `scripts/endpoint-profile.mjs sign` 签出 `cloud-endpoints.json`，放到律师电脑：

- macOS：`~/Library/Application Support/KimiWorkLegal/cloud-endpoints.json`
- Windows：`%LOCALAPPDATA%\KimiWorkLegal\cloud-endpoints.json`

重启应用生效。只能改地址、钉住与（测试构建的）私有 CA；控制面/席位公钥不能经它改。签名不对、部署标识不符、三项不齐、钉住不足两把——整份不生效，沿用随包地址。

## 3. 改动须两端同时发版的部分

- 共享契约包：`packages/firm-trust`（入组与批准字节格式）、`seat-token`（席位令牌）、`keys`（签名原语）、`design-tokens`；
- 控制面路径白名单：`packages/egress-gate/src/cp-relay.ts`（客户端只经出站闸门调用白名单内的路径）；
- 模型别名：`legal/k3`、`legal/k2.6`（运营在控制台改别名指向的上游与型号，别名本身不改）；
- 接口版本：`GET /v1/meta` 的 `api` 为 `kwl-cp/2`；云端可用 `clients.min_version` 要求客户端升级（426 `client_outdated`）。

## 4. 版本对应

| 客户端 | 云端 | 说明 |
|---|---|---|
| 0.2.x（本仓库） | kimi-work-legal-cloud v1.0.6 起 | 同一 monorepo 提交导出（见两端 `SOURCE.json` 的 `monorepo.commit`） |
