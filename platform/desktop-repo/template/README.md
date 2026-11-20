# Kimi Work 法律版 · 桌面客户端（Windows EXE / macOS DMG）

本仓库是 Kimi Work 法律行业发行版的**桌面客户端**：Electron 界面 + 本机法律内核（事项账本、任务队列、法律工具、文书引擎）+ 出站闸门 + Agent 宿主。
云端（统一控制台、账号、设备、额度、模型路由、计费、法律模型网关）在另一个仓库 `kimi-work-legal-cloud`，两端各自开发、构建、发版，接口契约见 [CONTRACT.md](CONTRACT.md)。

> 本仓库由 monorepo 的 `platform/desktop-repo/export.mjs` 导出，来源提交与每个文件的摘要记在 [SOURCE.json](SOURCE.json)。
> `packages/firm-trust`、`seat-token`、`keys`、`design-tokens` 是两端共用的契约包，只在 monorepo 改（`npm run verify:source` 核对）。

## 边界（客户端不做什么）

- **不保存上游模型密钥**：模型调用一律经云端法律模型网关，凭据是控制面签发的短期席位令牌；
- **不决定可信计费**：用量与额度以网关逐请求账本为准，客户端只显示控制面签名的额度视图；
- **云端地址只认构建时写入的 `apps/desktop/electron/release.json`**（地址 + 证书公钥钉住 + 控制面/席位公钥，打进 asar 受完整性校验）。
  安装包形态不读环境变量；地址迁移用发布方签名的 `cloud-endpoints.json`（见 [docs/构建与云端接入.md](docs/构建与云端接入.md) §5）。

## 快速开始（开发）

```bash
nvm use            # Node 26.8.1（.nvmrc）
npm ci
npm run pretest    # 构建法规库、Agent 配置、工具清单、方法模板
npm test           # 客户端用例（要起本机云端栈的联调用例留在 monorepo，清单见 SOURCE.json monorepo_only_tests）
npm run dev:desktop
```

## 构建安装包

| 目标 | 命令 | 产物 |
|---|---|---|
| Windows x64 安装包 | `node scripts/package-desktop.mjs --target win32-x64 --sign none` | `apps/desktop/release/KimiWorkLegal-Setup-<版本>.exe` |
| macOS Apple 芯片 | `node scripts/package-desktop.mjs --target darwin-arm64 --sign none` | `apps/desktop/release/KimiWorkLegal-<版本>-arm64.dmg` |

连接哪一套云端由 `release.json` 决定：先按 [docs/构建与云端接入.md](docs/构建与云端接入.md) 生成它，再打包。
没有 `release.json` 的包只有本机能力（`--dev-build`），不能登录云端。

## 没有域名、只有公网 IP 时

可以。客户端对 IP 地址与域名一视同仁：地址写 `https://<公网 IP>:8443` 等，证书须带该 IP 的 SAN。证书两种来源：

1. **公共 CA 的 IP 证书（推荐）**：Let's Encrypt 为公网 IP 签发短期证书（约 6 天，自动续期、复用私钥使钉住不变）。客户端无需任何额外信任配置。
2. **演示 CA**：云端自建一把演示 CA，CA 证书随**测试构建**（`test_build: true`）的 `release.json` 下发，只对中软云端上游生效且替换公共根，钉住照常必须命中。正式发布构建拒收。

两种方式都**不关闭、不放宽证书校验**。详见 [docs/构建与云端接入.md](docs/构建与云端接入.md)。
