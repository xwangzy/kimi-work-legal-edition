# Kimi Work 法律行业发行版 · 云端

律师在桌面客户端（Windows / macOS，仓库 `kimi-work-legal-desktop`）里用法律 AI；这里是它背后的云端：账号与设备、额度与计费、模型路由，以及给运营、律所管理员和律师用的**统一云端控制台**。

运维人员不需要读客户端的源码。部署、升级、排障按 `docs/` 里的手册做即可。

## 里面有什么

| 目录 | 是什么 | 部署时 |
|---|---|---|
| `apps/console` | 统一云端控制台（静态网页，原生 ES 模块，无第三方依赖） | `npm run build:console` 打包成 `apps/console/dist/`，交给 nginx 托管 |
| `services/control-plane` | 控制面：账号、会话、角色权限、手机号验证码与注册邀请码、律所与成员、设备、额度、用量账本、计费、路由登记 | 一个 systemd 服务 |
| `services/cp-signer` | 签名服务：持有文档与席位令牌签名私钥，只接受控制面的 mTLS 调用 | 一个 systemd 服务，只在内网 |
| `services/legal-gateway` | 法律模型网关：验席位令牌、按路由调上游模型、逐请求计量 | 一个 systemd 服务 |
| `services/search-service` | 法律检索代理 | 可选 |
| `services/relay-api` | 共享中继：团队共享事项在同事电脑之间的密文同步（中继只存密文、解不开）；v1.8.0 起为标准服务，端口 8446、与控制面同一张证书 | 一个 systemd 服务（`deploy/scripts/relay-setup.sh` 开通） |
| `services/{dist-api,support-api,notify-api}` | 内容分发、技术支持、期限通知 | 可选 |
| `packages/*` | 共用库；`firm-trust`、`seat-token`、`keys`、`design-tokens` 与桌面客户端共用 | — |
| `scripts/cloud-serve.mjs` | 生产入口：一个进程一个角色，`--config /etc/kwl/<角色>.json` | systemd 的 ExecStart |
| `scripts/cloud-init-secrets.mjs` | 一次生成全部密钥文件 | 首次部署 |
| `deploy/` | systemd 单元、nginx 配置、各角色配置样例、安装/升级/备份/回滚脚本 | 照抄改域名；只有公网 IP 时用 `install.sh --public-ip`（部署手册 4.5） |
| `docs/` | 部署手册、运维手册、客户端接入说明 | 先读 |

运行时只依赖 Node.js（≥ 24.15，CI 用 26.8.1）的内置模块；`npm ci` 只为建立工作区链接和装类型检查工具，服务器上可以用 `npm ci --omit=dev`。

## 快速开始（本机）

```bash
npm ci
npm test                      # 全部云端用例
npm run typecheck
npm run build:console
npm run dev:console           # 进程内控制面 + 控制台（开发数据），打印登录信息
```

## 文档

- [docs/部署手册.md](docs/部署手册.md)：从一台空的 Ubuntu 24.04 到上线（已在虚机上从零走通）。
- [docs/运维手册.md](docs/运维手册.md)：首个管理员、上游密钥、日志、备份、升级、回滚、排障。
- [docs/客户端接入.md](docs/客户端接入.md)：桌面客户端（Windows / macOS）如何指向本云端、注册登录、设备授权、经网关调模型。
- [CONTRACT.md](CONTRACT.md)：与客户端的接口契约与兼容规则。

## 仓库地址

https://gitee.com/xcsi/kimi-work-legal-cloud （发布以标签 `vX.Y.Z` 为准）

## 来源

本仓库由客户端 monorepo 的 `platform/cloud-repo/export.mjs` 导出，`SOURCE.json` 记着源提交与每个文件的摘要。
与客户端共用的契约包以 monorepo 为准：`npm run verify:source` 在 CI 里确认它们没有在这里被单独改过。
