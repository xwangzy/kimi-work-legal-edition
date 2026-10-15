# 第 4 批复核 A：隐私安全与 Windows 交付（2026-10-14）

复核人：独立复核员（只读审查；运行了既有用例 `apps/desktop/test/update-verify.test.ts`、`apps/desktop/test/release-config.test.ts`、`packages/kernel/test/child-process-surface.test.ts`、`packages/kernel/test/secret-files.test.ts`，12/12 通过）。
对象：工作区未提交改动中第 4 批“Windows 交付、Windows 稳定性、隐私（Y5 P0 + P1-7）”部分；依据 `docs/v9-开发计划与进度.md` 第 4 批节与 D-58～D-61，`research/2026-10-14-生产化方案v9.2/00-生产化完整方案v9.2.md` §3、§4.1、§4.5。
另外读了 `node_modules/electron-updater/out/{NsisUpdater,AppUpdater,electronHttpExecutor}.js`（6.8.9）和 `node_modules/app-builder-lib/out/winPackager.js`（26.15.3），用来核实实际调用路径。

## 结论先行

| 级别 | 数量 | 编号 |
|---|---|---|
| 阻断 | 0 | — |
| 重要 | 4 | B4-A03（Windows CI 若证实，升为阻断）、B4-A11、B4-A12、B4-A16 |
| 一般 | 12 | B4-A01、A02、A04、A05、A06、A07、A08、A09、A10、A13、A18、A19 |
| 建议 | 4 | B4-A14、A15、A17、A20 |

逐题结论：

| 题 | 结论 | 要点 |
|---|---|---|
| 1 随包运行时完整性 | 部分成立 | 期望摘要取自 asar 内副本、熔断已配、`node.exe` 不重签（已核 26.15.3 源码，负模式生效）、清单 12 项与 `REQUIRED_FILES` 一致，这几点都成立。但核验只覆盖 12 个入口文件，依赖闭包和 asar.unpacked 里的原生模块不在范围内（A01）。交叉构建的目标锁定只对 win32-x64 闭合（A02）。另有一处同类“开发形态掩盖安装包缺陷”：熔断 `grantFileProtocolExtraPrivileges:false` 加上 file:// 加载 ES 模块，界面可能空白，而冒烟发现不了（A03） |
| 2 自动更新链路 | 部分成立 | `verifySignature` 覆盖确实在 6.8.9 的下载路径上（NsisUpdater.js:52），全量和差分下载都经过它。签名清单、不降级、sha512、渠道都正确。缺口：缓存命中路径跳过核验，安装前不复核（A04）；清单没有有效期（A05）；证书回调返回 0 会关闭 CT（A06）；app-update.yml 仍被读取（A07） |
| 3 冒烟模式 | 部分成立 | 结果内容只含非敏感事实，成立。但任何启动者都能触发，可写任意路径，并在真实数据上运行（A08）；界面检查只看 `did-finish-load`（见 A03） |
| 4 数据根迁到 %LOCALAPPDATA% | 部分成立 | 内核、ledger-key、崩溃转储、渲染存储、userData 都已迁移，`.electron` 与律所标识不冲突。`attrib +I` 的参数写法很可能达不到“数据根及其内容”（A09）；旧 Roaming 位置无迁移、无清理说明，还有两处注释过时（A10） |
| 5 设备恢复导出/导入 | 不成立（导入） | 导出修复正确。导入会写出“备份私钥 + 现有公钥”的错配密钥对，`devices` 表公钥列也不更新。真实恢复场景（device.json 丢失后重启已自动换新密钥）下，恢复后的新事项密钥解不开（A11）。设备编号核对只看文件里的明文字段，证书未经验证就写入，已吊销的设备会被复活（A12） |
| 6 子进程 | 部分成立 | 5 个启动点都有 windowsHide 与 SystemRoot。看门狗在 Windows 上只靠 `kill(pid,0)`，PID 复用时会误判父进程存活；它在同一事件循环上运行，帮不了“主线程忙”的情形（A13）。管道后缀可预测（A14） |
| 7 预览与回执文案 | 部分成立 | 发起前预览与令牌化实现一致（案号只在全部化名时替换），删除回执如实，未见对外禁用词。但 D-58 说更新通道已“写入中软看得到什么”，页面上没有这一行；更新请求还带持久的 `x-user-staging-id`，与“只发送版本号与更新编号”的口径不符（A16） |
| 8 CI 工作流 | 部分成立 | 路径、shell、证书生成与导出、`CSC_LINK` 注入、安装目录 `kimi-work-legal`（已按 `getWindowsInstallationDirName` 核实）、冒烟退出码都能对上，密钥泄露风险低。但冒烟不含 release.json，更新链与云上游都没有覆盖；签名只打印不断言；`Start-Process -Wait` 可能等待子孙进程（A18） |

---

## 一、随包运行时完整性（题 1）

### B4-A01（一般）完整性核验只覆盖 12 个入口文件，依赖闭包与原生模块不在范围

- **结论**：部分成立。
- **证据**
  - 成立的部分：
    - `apps/desktop/electron/main.cjs:56` 在安装包形态传 `trustedManifestFile = __dirname/runtime-manifest.json`（asar 内），由 `scripts/package-desktop.mjs:105` 暂存时放入。
    - `electron-builder.yml:39-47` 已配熔断：`runAsNode:false`、`enableEmbeddedAsarIntegrityValidation`、`onlyLoadAppFromAsar`。
    - `signExts: ["!node.exe"]` 在 app-builder-lib 26.15.3 中确实生效：`winPackager.js:203-217` 支持 `!` 负模式，extraResources 经 `createTransformerForExtraFiles`（`:218-230`）逐文件判定，所以 `resources/runtime/node/node.exe` 不会被重签，摘要不变。
    - `scripts/build-runtime.mjs:196-207` 清单的 12 个键与 `runtime-paths.cjs:24` 的 `REQUIRED_FILES` 一一对应。
    - `electronVersion: 44.5.1` 与已装 electron 版本一致。
  - 缺口：
    - `runtime-paths.cjs:67-87` 只核对 12 个入口：Node、kap 宿主两件、闸门、W 三件、parse-worker、ort 绑定、OCR 三件。没有核对的有：`parse/node_modules/**`（pdfjs-dist 的 JS 会处理不可信 PDF；`@napi-rs/canvas-win32-x64-msvc/*.node`；onnxruntime 的 DLL；ppu-ocv/opencv wasm）、`w/node_modules/just-bash/**` 中除 `dist/bundle/index.js` 以外的文件（CPython wasm 与标准库），以及 `resources/app.asar.unpacked/node_modules/better-sqlite3-multiple-ciphers/prebuilds/*.node`（内核进程装载，asar 完整性不覆盖 unpacked）。
    - `runtime-paths.cjs:85`：`ent.sha256` 缺失时直接跳过摘要比对，安装包形态下等于失败开放。
    - 核验只在启动时做一次（`main.cjs:396`），kap 宿主、闸门、解析进程在之后按需拉起，中间存在 TOCTOU 窗口。只有 W 与闸门会在拉起时复核 Node 摘要。
    - 按用户安装的目录 `%LOCALAPPDATA%\Programs\kimi-work-legal` 对本人可写，`KimiWorkLegal.exe` 本身也可以被替换，Windows 不会在每次启动时校验 Authenticode。
- **影响**：完整性检查的实际保护面是“杀毒隔离或部分损坏”与“只改入口脚本”。改一个依赖 JS 或原生 DLL 就能绕过，而文档措辞（“摘要不符即运行时损坏”）容易被读成“随包组件整体受保护”。
- **建议修复**：
  1. 清单改为对 `runtime/` 全部文件生成 `files[]`，主进程至少核对“全部 .node/.dll/.wasm/.mjs/.cjs/.js 与模型”。
  2. 安装包形态下 `sha256` 缺失即判损坏。
  3. 把 `app.asar.unpacked` 里的原生模块也写进 asar 内清单并核对。
  4. 在 D 表或《中软看得到什么》之外的安全说明里写明：按用户安装时，同一 Windows 账户下的恶意程序不在防护范围内；律所要防这一层，应选择按机器安装（Program Files，需管理员才能写）。
- **建议补测**：`release-config`/`runtime-paths` 单测增加：①安装包形态清单项缺 `sha256` 时拒绝；②清单外的依赖文件被改动时拒绝（改动 parse/node_modules 下一个 .js）；③asar.unpacked 原生模块摘要不符时拒绝。

### B4-A02（一般）交叉构建的目标平台选择与锁定只对 win32-x64 闭合

- **结论**：部分成立。win32-x64 下可靠，其他目标不可靠或失败。
- **证据**：
  - `scripts/package-desktop.mjs:43` 接受 `win32-arm64`，但：
    - `win-runtime.lock.json` 只有 x64 的 Node 与 `canvas-win32-x64-msvc`；
    - `fetch-win-runtime.mjs` 把目标目录写死为 `-win32-x64`（`destDir`）；
    - `electron-builder.yml` 写死 `arch: [x64]`，与 `--${arch}` 参数冲突。
  - `build-runtime.mjs:65-77` 的 `findPackageDir` 先在仓库 `node_modules` 逐级向上查找，找不到才用锁定缓存。如果构建机的仓库 `node_modules` 里恰好已有目标平台包（例如有人用 `npm i --os=win32 --cpu=x64` 装过），就直接复制，不经锁文件 integrity 核对。
  - `@napi-rs/canvas`（1.0.10）与锁文件里的 `canvas-win32-x64-msvc@1.0.10` 目前一致，但没有任何一处自动校验这两个版本相等，升级时会静默错配。
  - 在 Windows CI（构建机即目标平台）上，原生包来自 `npm ci` 按 package-lock 的 integrity 安装，这条路径可靠。
- **影响**：arm64 构建会在中途失败；失败是关闭的，不算安全问题。版本错配会让扫描件解析在律师电脑上失败。
- **建议修复**：
  - 暂时只接受 `win32-x64`，入口处直接拒绝 arm64。
  - 交叉构建时，目标平台原生包只从锁定缓存取，跳过仓库 `node_modules`。
  - `build-runtime` 校验 `@napi-rs/canvas` 的 `optionalDependencies[canvas-<triple>]` 等于锁文件版本。
- **建议补测**：对 `build-runtime` 的平台过滤函数（`platformPackageWanted`/`pathWanted`/`findPackageDir`）抽出做单测：交叉目标下仓库已有同名包时仍取锁定缓存；canvas 版本与锁文件不符时报错。

### B4-A03（重要，Windows CI 若证实即升阻断）`grantFileProtocolExtraPrivileges:false` 加 file:// 加载 ES 模块，安装包界面可能空白；冒烟发现不了

- **结论**：属于同类“开发形态掩盖安装包缺陷”的残留风险，需在 Windows CI 核实。
- **证据**：
  - `electron-builder.yml:47` 设 `grantFileProtocolExtraPrivileges: false`。
  - `main.cjs:350` 生产形态用 `loadFile(dist/index.html)`。
  - `apps/desktop/dist/index.html` 是 `<script type="module" crossorigin src="./assets/index-*.js">` 与 `<link rel="stylesheet" crossorigin ...>`。
  - Electron 熔断文档说明，这个熔断关闭后，file:// 页面不再拥有“经 file:// 加载其他资源”等额外权限，行为与普通浏览器相同；而普通 Chromium 下，file:// 的模块脚本按 CORS 请求加载，源为 `null`，会被拦截（这正是 Vite 文档说构建产物不能经 file:// 打开的原因）。
  - 这个熔断不是本批新增（HEAD 已有），但此前从未产出过真实安装包。开发形态和 `ZR_DESKTOP_PROD=1` 都不翻转熔断，本机冒烟因此覆盖不到。
  - 冒烟 `main.cjs:91-92` 只等 `did-finish-load`。即使模块脚本被拦截，HTML 照样加载完成，`renderer_loaded` 仍记为 ok。
- **影响**：如果成立，Windows 安装包打开后是白屏，而 CI 冒烟显示通过。
- **建议修复**：二选一。
  - 改用自定义协议提供界面：`protocol.registerSchemesAsPrivileged([{scheme:"app",privileges:{standard:true,secure:true,supportFetchAPI:true}}])` 加 `protocol.handle`，并同步改 `url-policy.cjs` 的放行规则。这是 Electron 推荐做法，熔断可以保持关闭。
  - 或者有意识地保留该熔断为 true，并在偏离表中登记。
  - 无论选哪种，冒烟都要加“界面真正渲染”的断言：preload 在 React 根挂载后经 IPC 报告 `renderer.ready`，或主进程 `executeJavaScript("document.getElementById('root')?.childElementCount")`，加载失败（`did-fail-load`、控制台错误）计为失败。
- **建议补测**：Windows CI 冒烟增加 `renderer_mounted` 检查项；另加一例负向冒烟：篡改 `app.asar` 一个字节后启动，期望退出码非 0（验证 asar 完整性熔断确实生效）。

---

## 二、自动更新链路（题 2）

先列成立部分：

- `update-verify.cjs` 的签名对象是规范 JSON（键排序、`__proto__` 拒绝）。
- Ed25519 用 `crypto.verify(null,…)`，key_id 取 SPKI sha256 前缀。
- 渠道、产品、格式都有核对；文件名正则、sha512 格式、大小上限 2 GB 都有约束。
- `checkDownloaded` 核对“清单版本 = 待装版本 > 当前版本”，再比对大小与 sha512；`allowDowngrade=false`、`disableWebInstaller=true`。
- 覆盖的 `verifySignature` 确在 `NsisUpdater.doDownloadUpdate` 的 task 内调用（`NsisUpdater.js:52`），全量与差分下载都会经过；返回非空即抛出 `ERR_UPDATER_INVALID_SIGNATURE` 并删除临时文件（`:53-57`）。
- 证书链遍历（`updater.cjs:38-42`）沿 `issuerCert` 走、上限 8 级，写法正确；`verificationResult !== "net::OK"` 先失败关闭。
- 更新会话分区名 `electron-updater` 与 electron-updater 内部 `NET_SESSION_NAME`（`electronHttpExecutor.js:6-8`）一致，钉住与主机限制确实作用在 electron-updater 自己的请求上。
- `update_base` 只取自 asar 内的 `release.json`。

### B4-A04（一般）缓存命中路径跳过核验；安装前不复核；按机器安装时以管理员身份运行用户可写目录里的安装包

- **结论**：部分成立。
- **证据**：
  - `AppUpdater.js:604-607`：`validateDownloadedPath` 命中缓存（`%LOCALAPPDATA%\kimi-work-legal-updater\pending`）后直接 `done(false)`，不进入 task，因而不调用 `verifySignature`。缓存判定只比对 latest.yml 的 sha512（来自更新源）。
  - `NsisUpdater.doInstall`（`NsisUpdater.js:100-130`）在退出时直接运行该文件，安装前没有复核签名清单。
  - `isAdminRightsRequired` 为真时（IT 选择“为所有用户安装”，`nsis.allowElevation: true`、`perMachine:false` 允许切换），经 `elevate.exe` 以管理员身份运行这个用户可写的文件。
- **影响**：
  - 从“下载核验”到“退出安装”可能相隔数天，期间同账户恶意程序可以替换 pending 文件。按用户安装时这不构成越权，因为对方本来就能改安装目录。
  - 按机器安装时，这就成了一条本地提权路径（经 UAC 确认，但律师通常会点“是”）。
  - 缓存命中这条路径没有任何本产品自己的核验，只能依赖“首次进入缓存时核验过”这一前提。
- **建议修复**：
  - 在 `KwlUpdater` 中覆盖 `doInstall`（或监听 `before-quit-for-update`），安装前用内存中保存的已验 payload 重算 `installerPath` 的大小与 sha512，不符即删除并放弃安装。
  - 缓存命中时同样重新取 `kwl-update.json` 核验。
  - 正式证书到位后必配 `update_publishers`，让 Authenticode 校验在安装前再做一次。
  - 文档写明：按机器安装时，更新以管理员身份运行。
- **建议补测**：`update-verify` 单测增加“已验 payload 与安装时文件不符即拒绝”的纯函数用例；Windows CI 增加一例：下载完成后篡改 pending 文件，期望不安装。

### B4-A05（一般）签名清单没有有效期与最低版本，挡不住冻结与“合法旧版本重放”；`file` 字段核了格式却不参与比对；渠道共用一个清单

- **结论**：部分成立。
- **证据**：
  - `update-verify.cjs:63-85` 不检查 `released_at`（`sign-update.mjs:57` 写了，但只写不验），也没有 `expires` 或 `min_version`。
  - `p.file` 经正则核验（`:68`），但 `checkDownloaded`（`:89-110`）不把它与 latest.yml 的 `path` 或下载文件名比对。正则还允许空格与中文，与 `electron-builder.yml` 中“文件名只用 ASCII”的约定不一致。
  - `updater.cjs:52` 固定取 `${base}/kwl-update.json`，beta 与 latest 同源时只能描述一个版本，另一渠道必然核验失败。
- **影响**：更新源被攻破时，攻击者虽然投放不了未签名程序，但可以：
  - 长期停供更新（冻结）；
  - 重放一份旧的、已签名、版本高于部分律师当前版本但含已知漏洞的清单与安装包，让这些机器升级到“有漏洞的中间版本”。
- **建议修复**：
  - payload 增加 `expires`（例如 30 天），客户端拒绝过期清单；可选增加 `min_version`。
  - `file` 与 latest.yml `path` 做等值核对，或者删掉这个字段以免造成误解。
  - 清单按渠道命名为 `kwl-update-${channel}.json`。
- **建议补测**：过期清单拒绝；`file` 与 latest.yml 不一致时拒绝；beta 渠道读取独立清单。

### B4-A06（一般）证书回调返回 0 会关闭证书透明度校验；主机限制对 net 请求是否生效未经验证

- **结论**：部分成立。
- **证据**：
  - `updater.cjs:43` 钉住命中时 `cb(0)`。按 Electron 约定，`0` 表示“成功并关闭 CT 校验”，`-3` 表示“沿用 Chromium 的结果”；此前已要求 `verificationResult === "net::OK"`，此处返回 `-3` 即可保留 CT。
  - `updater.cjs:26-35` 的 `webRequest.onBeforeRequest` 主机限制是否拦得住 electron-updater 的 `net.request`，没有任何测试证明。
  - 如果 `update_pins` 填的是 CA 级公钥（`release.example.json` 的说明写“证书链中任一证书”），同一 CA 签发的其他主机也能通过钉住检查，这时主机限制就成了唯一约束。
- **影响**：降低纵深；如果主机限制对 net 请求不生效，且钉住集含 CA 公钥，会话就能访问同 CA 下的任意主机，例如 latest.yml 里写的绝对 URL。
- **建议修复**：
  - 改为 `cb(tlsPinMatch(...) ? -3 : -2)`。
  - 在 `release.example.json` 的说明中要求钉住叶子或中软自有中间证书，不要钉公共 CA。
  - 在 `verifySignature` 中额外断言 `fileInfo.url` 与 `cfg.base` 同主机（electron-updater 的 `updateInfoAndProvider` 可取到）。
- **建议补测**：Windows CI（或 Electron 主进程测试）用本地 https 服务验证：非更新主机的请求被取消，未命中钉住时请求失败。

### B4-A07（一般）任何核验失败都报“未通过发布签名核验”，并每 6 小时重下整包；app-update.yml 仍被读取

- **结论**：部分成立。
- **证据**：
  - `updater.cjs:53` 网络错误或 HTTP 404 返回字符串，`:55` 版本竞态（发布方在下载期间更新了清单）返回字符串。electron-updater 一律包装为 `ERR_UPDATER_INVALID_SIGNATURE`，`updater.cjs:86-88` 再统一显示“下载的更新未通过发布签名核验，已丢弃。请联系所内 IT 或客服。”
  - 失败时临时文件被删（`NsisUpdater.js:54`），下一轮（`CHECK_EVERY_MS` 6 小时）重新下载整包。
  - 注释称“不读 resources/app-update.yml”（`updater.cjs:4-5`、`electron-builder.yml` 注释），但 `AppUpdater.js:545-550` 仍从它读取 `updaterCacheDirName`，用来拼接缓存目录。
- **影响**：
  - 一次瞬时网络故障就会让律师看到“签名未通过、联系 IT”的告警，造成误报与无谓的工单。
  - 每次失败都重下约 200 MB 以上，占用律所带宽。
  - 被改写的 app-update.yml 会让缓存目录（以及 `clear()` 删除的目录）指向别处。只有同账户能改写，风险低，但“不读”的表述不准确。
- **建议修复**：
  - 把“取不到清单”与“签名或摘要不符”分开：前者在 `verifySignature` 中抛出普通错误或返回特定前缀，界面显示“检查更新失败，稍后重试”；只有签名或摘要不符才显示 `rejected`。
  - 下载前先取 `kwl-update.json` 并核验签名与版本（可在 `update-available` 时做），不符就不下载。
  - 注释改为“更新地址与发布者不取自 app-update.yml；缓存目录名仍取自它”。
- **建议补测**：`update-verify` 增加“清单取不到”与“签名无效”返回不同类别的用例；`updater` 的状态映射抽成纯函数单测。

---

## 三、冒烟模式（题 3）

### B4-A08（一般）`--kwl-smoke` 在安装包内对任何启动者开放：可写任意路径、覆盖已有文件，并在真实数据上运行

- **结论**：部分成立。结果内容是非敏感事实，这一点成立；滥用面没有收口。
- **证据**：
  - `main.cjs:63-69` 只要命令行带 `--kwl-smoke=<路径>` 就进入冒烟，没有任何前置条件。
  - `main.cjs:100`、`:148`、`:402` 用 `writeFileSync` 直接写这个路径：已有文件会被覆盖，UNC 路径（`\\host\share\x`）会发起 SMB 连接。
  - 冒烟在真实 `DATA_DIR` 上完整执行：解封 DPAPI 主密钥（`:144`）、拉起内核、打开窗口；首次运行的机器上还会创建 ledger-key 与数据库。
  - 写出的内容：`version`、`packaged`、时间、`checks`（runtime/kernel_ready/ocr_available/egress_gate/sole_exit/control_plane_mode/lawdb/renderer_loaded/被拦截请求计数）、`error`（异常消息）、`problems`（清单相对路径），以及密钥失败时的 `code`。没有事项内容、密钥或令牌，这部分成立。
  - 冒烟分支不启动更新器（`:420-423`），这一点正确。
- **影响**：
  - 任何能让律师点开一个快捷方式（.lnk 参数）的人，都能覆盖该账户下任意一个可写文件（完整性方面的拒绝服务），或者借 UNC 路径泄露 NTLM 质询。后者 .lnk 图标路径本来也能做到，所以增量有限。
  - IT 在律师电脑上跑冒烟时，会在律师的真实数据上启动一次内核，这是预期行为，但没有写明。
  - `error` 字段原样写出异常消息，将来内核错误消息里若出现路径或事项名，会进入结果文件。
- **建议修复**：
  - 结果文件用 `{ flag: "wx" }`，已存在即失败；拒绝 UNC 与非本地盘路径，只接受 `%TEMP%`、`%RUNNER_TEMP%` 下的路径或扩展名为 `.json` 的新文件。
  - `error` 只写错误码与固定文案，不写原始消息。
  - 在 IT 部署说明中写明：冒烟会在本账户真实数据上启动一次。
  - 可选：冒烟要求同时设置环境变量（例如 `KWL_SMOKE=1`）；因为 `runAsNode` 已关，`NODE_OPTIONS` 熔断也已关，这项环境变量不会扩大攻击面。
- **建议补测**：抽出冒烟结果写出函数做单测：已存在文件拒绝写；UNC 拒绝；`error` 只含错误码。

---

## 四、Windows 数据根与 userData（题 4）

成立部分：

- `main.cjs:24-28` 在 app ready 之前把 userData 设为 `%LOCALAPPDATA%\KimiWorkLegal\.electron`。
- `ledger-key`（`:41`）、崩溃转储（`:357`，`crashDumps` 在 userData 下）、渲染进程存储、日志与会话数据（缺省都随 userData）因此都落在本地目录。
- 内核数据目录经 `kernelChildEnv` 写定为 `DATA_DIR`（`release-config.cjs:115`，安装包形态不可覆盖）。
- 内核缺省目录（`config.ts:93`）同为 `LOCALAPPDATA`。
- 律所标识规则 `checkSlug`（`config.ts:153-156`，要求以字母或数字开头）保证不会与 `.electron` 重名。
- electron-updater 缓存本来就在 `%LOCALAPPDATA%`。

### B4-A09（一般）`attrib +I <DATA_DIR> /S /D` 的写法很可能达不到“数据根及其内容不编入索引”

- **结论**：部分成立，需实机核对。
- **证据**：`main.cjs:387` 执行 `attrib.exe +I <DATA_DIR> /S /D`。`attrib` 的 `/S` 语义是“在当前（这里是父目录 `%LOCALAPPDATA%`）及所有子目录中处理与文件规格匹配的项”。文件规格是目录全路径时，它只匹配名为 `KimiWorkLegal` 的项，不会处理该目录里的内容；同时它还会遍历整个 `%LOCALAPPDATA%` 树去找同名项（树很大时可能撞上 60 秒超时）。递归标记内容的常见写法是 `attrib +I "<DATA_DIR>\*" /S /D`，目录本身再单独执行一次。另外，该命令每次启动都会全量运行。
- **影响**：数据根下已有文件很可能仍会被 Windows 搜索编入索引，文件名与元数据进入索引库，P1-7 声称的效果打折扣。启动时还会多出一次对 `%LOCALAPPDATA%` 的大范围遍历。
- **建议修复**：
  - 改为两次调用：`attrib +I "<DATA_DIR>"`，再 `attrib +I "<DATA_DIR>\*" /S /D`。
  - 只在首次创建数据根或版本升级时执行，用标记文件记录。
  - 新文件是否继承 `FILE_ATTRIBUTE_NOT_CONTENT_INDEXED` 需在实机核对，结论写进待核验清单。
- **建议补测**：Windows CI 冒烟后执行 `attrib "<DATA_DIR>\<律所>\*"` 与 `fsutil`/`Get-Item ... .Attributes`，断言数据根之下的文件与子目录带 `NotContentIndexed`。

### B4-A10（一般）旧位置（Roaming）数据没有迁移或清理说明；两处注释过时

- **结论**：部分成立。
- **证据**：
  - 此前 Windows 形态的数据根是 `%APPDATA%\KimiWorkLegal`，userData 是 Electron 缺省的 `%APPDATA%\Kimi Work 法律版`（内含 `ledger-key`）。本批没有任何检测、迁移或提示代码（`main.cjs` 全文没有提到旧路径）。
  - `electron-builder.yml:70` 的注释仍写“卸载时保留本机案件数据（数据在 %APPDATA%\KimiWorkLegal …）”。
  - `release-config.cjs:7-8` 的注释仍写“asar 完整性校验须在第 4 批打包时配置……在此之前不能宣称受熔断保护”，而熔断已经在 `electron-builder.yml` 配置。
- **影响**：
  - 真实律师此前没有拿到过 Windows 安装包（D-60），用户层面的影响有限。
  - 但内部试用机或开发机上，旧的 Roaming 数据（事项密文加 DPAPI 包裹的主密钥）会继续跟随漫游配置同步，F1 要消除的正是这一风险。新版本启动后看到的是空库，容易被误认为“数据丢失”。
- **建议修复**：
  - 启动时检测旧路径：存在时提示“旧位置有数据”，并给出 IT 处置说明（迁移步骤：关闭应用，移动 `%APPDATA%\KimiWorkLegal\<律所>` 与旧 userData 下的 `ledger-key`；或确认无需保留后删除）。不建议自动搬迁加密材料。
  - 修正两处过时注释。
- **建议补测**：主进程路径决策抽成纯函数（输入平台与环境变量，输出数据根、userData、旧路径列表），单测覆盖 win32 有或无 `LOCALAPPDATA`、旧路径存在时返回提示。

---

## 五、设备恢复导出/导入（题 5）

导出部分成立：经 `getDeviceKeys` 解封读取，私钥缺失即拒绝；口令按码点计数，至少 10 个；写审计（`api/index.ts:2506-2525`）。导入的封装写回与“重启生效”提示也成立（`devices.ts:209-211`，`api/index.ts:2535-2545`）。以下两项是导入逻辑本身的问题。

### B4-A11（重要）导入写出“备份私钥 + 现有公钥”的错配密钥对，`devices` 表公钥列不更新；真实恢复场景下，恢复后的新事项密钥无法解开

- **结论**：成立（缺陷）。
- **证据**：
  - `api/index.ts:2536`：`writeDeviceKeys(keysDir, { ...getDeviceKeys(keysDir), signPrivateKeyPem: <备份>, encPrivateKeyPem: <备份> })`。公钥字段 `signPublicKeyPem`/`encPublicKeyPem` 沿用当前 device.json 里的值。
  - `:2537-2539` 只更新 `cert_json`，不更新 `devices.sign_pub_pem`/`enc_pub_pem`。
  - 真实恢复场景是 device.json 丢失或损坏后重启。此时 `devices.ts:245-276` 的 `ensureDevice` 发现文件不存在，会生成新密钥，并以同一个 `device_id`（`dev_${firm}_${user}`，确定性）覆盖 `devices` 行的公钥与证书。所以导入时当前 device.json 里的是新公钥，备份里的是旧私钥，两者不成对。
  - 重启后的使用点：
    - `api/index.ts:554`、`:2465` 用 `keyctx.device.keys.encPublicKeyPem` 包裹新事项密钥；`:2206-2232`、`:2270-2277` 用 `devices.enc_pub_pem` 包裹。两者都是新公钥，而本机此时只有旧私钥。
    - `index.ts:185` 审批签名用旧私钥，但声明的公钥是新的。
  - 现有用例 `secret-files.test.ts:101-107`、`recovery-drill.test.ts:67-73` 只在同一台设备上“导出后立即导入”（密钥相同），掩盖了这个问题。
- **影响**：恢复之后：
  - 恢复后新建的事项、轮换后的事项密钥，在下一次读取时解不开，等于数据不可用。
  - 设备被换新密钥到执行导入之间创建的事项，其密钥包裹给了新公钥，而新私钥已被覆盖，这批数据永久丢失。
  - 审批签名验签失败。
  - 这正是恢复功能要服务的场景，风险高。
- **建议修复**：
  1. 导入时用 `crypto.createPublicKey(privatePem)` 从备份私钥推导两把公钥，写入完整一致的四元组。
  2. 同一事务里更新 `devices.sign_pub_pem`/`enc_pub_pem`。
  3. 覆盖前检查 `matter_keys` 中是否有包裹给当前（临时）公钥、而备份私钥解不开的条目：有就先用当前私钥解开、再用备份公钥重新包裹，或者拒绝导入并说明原因。
  4. 证书必须与推导出的公钥一致（见 A12）。
- **建议补测**：在 `secret-files.test.ts` 增加完整场景：
  1. 建事项 A；
  2. 导出；
  3. 删除 device.json 后重开内核（生成新密钥）；
  4. 建事项 B；
  5. 导入并重开；
  6. 断言 A、B 都能读，新建事项 C 能读；`devices` 行的公钥等于由私钥推导出的公钥；审批签名可以验签。

### B4-A12（重要）设备编号核对只看文件里的明文字段；证书未验证就写入；已吊销的设备会被复活

- **结论**：成立（缺陷）。“只接受本设备的恢复文件”实际上可以被绕过，而且导入还带来了新问题。
- **证据**：
  - `api/index.ts:2532` 比对的是 `doc.device_id`，它是恢复文件里的明文 JSON 字段，不在 scrypt 包裹的密文里，可以随意编辑。用例 `secret-files.test.ts:96-98` 恰好只测了“改这个字段就拒绝”，反方向（把别人的文件改成本机编号）一定能通过。
  - `device_id` 由律所标识和用户标识确定性生成（`devices.ts:234`）。同一律师的另一台电脑编号相同，所以“本设备”实际上是“同所同用户”。
  - `:2537-2539`：`UPDATE devices SET cert_json = <文件内证书>, status = 'active', revoked_at = NULL`。证书没有验证律所根签名，也没有核对其中的公钥、`device_id`、`memberId` 和有效期。
  - 设备已被吊销（丢失或离职）时，导入会把本地状态改回 `active`。
- **影响**：
  - D-61 要防的“导入别的设备的私钥会冒用身份”并没有防住，改一个字段就能绕过。
  - 被吊销的设备只要还有恢复文件和口令，就能在本地自行复活；本地依据 `devices.status` 的检查（例如退出模式“本设备被吊销”）随之失效。
  - 文件中被改过的证书（例如角色字段）会原样进入 `devices` 表。
- **建议修复**：
  1. 用推导出的公钥与本机已登记的公钥（或律所设备目录中该 `device_id` 的公钥）比对，不一致即拒绝。在“device.json 已重建”的场景下，应与“吊销前、最后一次由律所根签发的证书”中的公钥比对，或者要求律所管理员签名的恢复授权。
  2. 证书必须通过律所根公钥验签，且其中的公钥与推导结果一致；否则不写入。
  3. 导入不得改变 `status`/`revoked_at`；设备已吊销时直接拒绝，提示“请由管理员重新签发”。
  4. 把 `device_id` 与证书摘要纳入 scrypt 包裹的明文，或用 AEAD 的附加数据绑定，使明文字段不可篡改。
- **建议补测**：
  - 别的设备的恢复文件改成本机 `device_id` 后拒绝；
  - 证书被篡改（改角色）后拒绝；
  - 已吊销设备导入后拒绝，且 `status` 保持 `revoked`；
  - 私钥与登记公钥不符时拒绝。

---

## 六、子进程：windowsHide、SystemRoot、命名管道、看门狗（题 6）

成立部分：

- 产品源码中真正的启动点只有 5 处，全部带 `windowsHide`，并补了系统目录：
  - `kernel/src/egress/gate-host.ts:293`
  - `kernel/src/executor/kap-agent-client.ts:213-215`
  - `kernel/src/executor/agent-host-manager.ts:370-372`
  - `exec-wasm/src/host.ts:178-190`
  - `parse-ocr/src/worker-client.ts:62`、`:137`
- 主进程 `attrib` 调用（`main.cjs:387`）用绝对路径并带 `windowsHide`。
- 其余引入 `child_process` 的文件（`egress-gate/src/main.ts`、`kap-host/src/main.ts`、`kernel/src/electron-entry.ts`、`kernel/src/egress/kernel-gate.ts`）只在注释中提到它，已逐一核对。

### B4-A13（一般）父进程看门狗：Windows 上 ppid 永不变化，PID 复用会误判父进程存活；与“主线程忙”的理由不符

- **结论**：部分成立。
- **证据**：三处实现相同：`egress-gate/src/main.ts:169-187`、`kap-host/src/main.ts:326-345`、`exec-wasm/src/supervisor.ts:204-222`。
  - Windows 不会重新指定父进程，`process.ppid`（libuv 读 `InheritedFromUniqueProcessId`）在父进程退出后保持原值，所以 `process.ppid === parentPid` 恒为真，判定完全依赖 `process.kill(parentPid, 0)`。Windows 的 PID 复用很快，父进程退出后，只要 2 秒内有新进程拿到同一个 PID，就会被判为存活；若新进程属于其他账户或受保护，还会返回 EPERM，同样被当作存活。
  - macOS 上父进程退出后 ppid 变成 1，判定有效；EPERM 只会出现在 PID 被他人进程复用时。
  - 注释给出的理由是“主线程正忙时，IPC 断开事件可能迟到”。但 `setInterval` 与断开事件在同一事件循环上，主线程忙时看门狗同样触发不了。看门狗真正能补上的，只有“断开事件永远不来”的情形。
- **退出路径与数据**：
  - 闸门走 `shutdown(0)`；
  - kap 宿主走 `runtime.close()` 后清除密钥环再退出；断开与看门狗可能先后各触发一次，导致 `close` 被调用两次，需确认它是幂等的；
  - W 监督进程直接 `process.exit(0)`，W 没有持久状态，可以接受。
  - 未见因此丢数据的路径。但主进程在 `will-quit` 中对内核用 `kernel.kill()`（`main.cjs:441`），这是强制终止，内核没有机会按序关闭子进程。更新安装（`quitAndInstall`）时，残留的 `resources\runtime\node\node.exe` 在看门狗生效前持有文件句柄，可能导致 NSIS 覆盖失败；静默更新会因此报错。
- **建议修复**：
  - Windows 上改用 IPC 心跳：父进程每秒发一次 `ping`，子进程超过 5 秒没收到即退出。或者在启动时把父进程的创建时间（由父进程经参数或环境传入）与 PID 一起核对。
  - 内核退出改为先发 `kernel.shutdown` 并等待最多 N 秒，再 `kill`；`before-quit-for-update` 中等待内核及其子进程全部退出后再交给安装程序。
  - 修正注释中的理由。
- **建议补测**：
  - 用例：父进程退出后，子进程在 3 个看门狗周期内退出（Windows CI 跑）。
  - Windows CI 冒烟结束后断言没有残留的 `resources\runtime\node\node.exe`（`Get-Process node | Where Path -like *kimi-work-legal*`）。

### B4-A14（建议）命名管道后缀可预测，RDS 上“抢先占名”造成拒绝服务的问题仍在

- **结论**：部分成立。解决了冲突，没有解决抢占。
- **证据**：`config.ts:64-74` 的 `pipeSuffix = sha256(用户名 \0 小写数据目录)` 前 16 位。用户名与数据目录（`C:\Users\<名>\AppData\Local\KimiWorkLegal\<律所>`）对同机其他用户都可推算。libuv 创建第一个实例时带 `FILE_FLAG_FIRST_PIPE_INSTANCE`，名字被他人先占就会绑定失败。注释已写明“不作凭据”，通道另有令牌鉴权，所以这里只是可用性问题。
- **影响**：在 RDS 或云桌面上，同机另一个账户可以让某位律师的 Agent 与闸门无法启动。
- **建议修复**：后缀加入随机盐，首次运行时生成并保存在数据根内（只有本账户可读）。客户端连接后核对服务端进程身份（`GetNamedPipeServerProcessId` 加可执行路径，或令牌双向挑战），防止连到冒名的服务端。
- **建议补测**：`pipeSuffix` 单测覆盖“同用户同目录稳定、不同用户不同”（已有则补“加盐后同一盐稳定”）。

### B4-A15（建议）静态测试只扫固定文件清单；taskkill 按 PATH 查找；W 子进程环境只补 SystemRoot

- **结论**：建议。
- **证据**：
  - `kernel/test/child-process-surface.test.ts:13-19` 写死了 5 个文件，新文件引入 `child_process` 时不会被扫到。注释说“新增一处不带的调用即失败”，这只对这 5 个文件成立。
  - `agent-host-manager.ts:120` 写成 `spawn("taskkill", …)`，按 PATH 查找（v5 SDK 宿主，安装包中不可达，但写法不一致）。
  - `exec-wasm/src/host.ts:178` 只补 `SystemRoot`、不补 `windir`，与 `child-env.ts` 不一致。exec-wasm 不依赖 kernel，所以没有复用 `windowsSystemEnv`。
- **建议修复**：
  - 测试改为扫描 `packages/*/src/**/*.ts` 与 `apps/desktop/electron/*.cjs` 中所有引入 `child_process`（或 `node:child_process`）的文件，排除构建产物与测试。
  - `taskkill` 用 `%SystemRoot%\System32\taskkill.exe` 绝对路径。
  - W 环境同时补 `windir`。
- **建议补测**：即上述测试改造本身。

---

## 七、发起前预览与删除回执文案（题 7）

### B4-A16（重要）D-58 所说“写入中软看得到什么”没有落实；更新请求带持久编号，与“只发送版本号与更新编号”的说法不完整

- **结论**：不成立。
- **证据**：
  - `apps/desktop/src/pages/Connections.tsx` 中《中软看得到什么》页的情形表（`:186-200` 起）没有“自动更新”这一行。全文搜索“更新源”“自动更新”“检查更新”，只在 `App.tsx`/`api.ts` 的横幅逻辑里出现。
  - D-58 的回归计划写的是“登记为第二出口写入《中软看得到什么》”；`updater.cjs:10` 的注释写的是“更新检查只发送版本号与更新编号……（写入中软看得到什么）”。
  - 实际发出的内容：electron-updater 在每次检查时带 `x-user-staging-id` 请求头（`AppUpdater.js:387`），值是每台安装持久保存的随机 UUID；此外还有源 IP、Chromium/Electron 的 User-Agent（含操作系统版本）和每 6 小时一次的请求时刻。当前版本号不会主动发送，服务器从请求的时间与内容推断。
- **影响**：对律所的告知不完整。更新服务器（中软）可以持续看到“某个持久编号的设备在何时、从哪个 IP 在线”，这是一个设备在线时间线。它不涉及事项内容，但属于应当如实告知的元数据，也和告知函口径相关。
- **建议修复**：
  - 在《中软看得到什么》中增加一行“自动更新（安装包形态、律所未关闭更新源时）”。
    - 看得到：本机更新编号（随机、持久，用于分批推送）、IP、操作系统与应用版本（请求头）、检查时间（约每 6 小时）、下载记录。
    - 看不到：任何事项内容、账号与席位。
  - 写明律所 IT 可以在律所版 `release.json` 不配 `update_base` 来关闭更新源。
  - 同步修改 `updater.cjs:10` 注释与告知函。
  - 可选：不使用分批推送时，不发送 `x-user-staging-id`（electron-updater 无开关，可在会话的 `onBeforeSendHeaders` 中删去该请求头，但这样分批推送功能会失效，需要取舍）。
- **建议补测**：在 `egress-gate/test/desktop-surface.test.ts` 或 `outbound-surface` 类静态测试中加一条：主进程中存在 `initUpdater` 时，`Connections.tsx` 必须包含“自动更新”行，即出口登记与告知页联动。

### B4-A17（建议）预览与回执的新文案总体如实，有两点小建议

- **结论**：基本成立。
- **证据**：
  - `api/index.ts:1018-1032` 原文类别的口径与令牌化实现一致：
    - 案号只在 L3a 或全部化名时替换（`kernel/src/egress/matter-tokens.ts:111` 中 `caseNumbers: full`）；
    - 机构名称只在全部化名时替换（`tokenizer/src/index.ts:217-220`）；
    - “未能识别的姓名也会以原文发送”如实；
    - 上游留存口径分三类（私有、自带密钥、标准），与 `Connections.tsx:233` 的“上游留存以企业协议为准”一致。
  - 删除回执（`services/matter-lifecycle.ts:278` 起）新增“系统还原点与卷影副本”，并写明“不在本次删除范围，同一 Windows 账户可以取回并解开”，表述如实。
  - 《中软看得到什么》页的“导出诊断信息”这次不是撤回，而是兑现成了真实功能（`Connections.tsx:92-130` → `diagnostics.export`，`api/index.ts:2778`；进度文档第 4 批“脱敏诊断包 Y5 P1-2”条目是复核期间新增的）。按钮文案承诺“只包含……不包含任何事项名称、当事人……发现可能含有当事人信息即不导出”，本复核没有审查 `services/diagnostics.ts` 的白名单与自证逻辑，**列为未覆盖项，须单独复核**（重点：错误代码与状态字段里会不会带出路径、事项名或文件名；“自证”是否失败关闭）。没有发现“绝对安全”“零留存”“永不”一类对外禁用表述。
  - 小问题一：替换类别只写了“证件、账户、联系方式与自然人姓名”，实际还会替换地址、车牌、出生日期、统一社会信用代码（`tokenizer/src/patterns.ts:9`）。说得比做得少，方向安全，但律师可能误以为地址会以原文发送。
  - 小问题二：预览写“协议状态见‘中软看得到什么’”，需确认该页确实展示企业协议状态（零留存与否、签署日期）。本次只在 `:233` 看到“以企业协议为准”，没有看到状态字段。
- **建议修复**：替换类别写全，或改写为“证件、账户、联系方式、地址等标识与自然人姓名”。如果《中软看得到什么》页没有协议状态，就补上状态，或把预览里的指引改成“协议说明见……”。
- **建议补测**：`run-progress`/`matters` 类用例中，对 `runs.estimate` 的预览文案做快照断言，分别覆盖标准、全部化名、私有、自带密钥四种组合。

---

## 八、CI 工作流（题 8）

### B4-A18（一般）CI 主体可行；冒烟覆盖不到更新链与云上游，签名只打印不断言，冒烟步骤可能挂起

- **结论**：部分成立。
- **能跑通的部分**：
  - `defaults.run.shell: bash` 在 windows-latest 上用 Git Bash，`node --test packages/.../*.test.ts` 的通配由 bash 展开，可行。
  - 证书步骤用 pwsh：`New-SelfSignedCertificate -Type CodeSigningCert` 默认密钥可导出，`Export-PfxCertificate` 可行。口令先 `::add-mask::` 再写入 `GITHUB_ENV`；pwsh 7 的 `-Encoding utf8` 不带 BOM，可行。
  - `--sign env` 在 `package-desktop.mjs:128` 检查 `CSC_LINK`。
  - 安装目录：`productFilename` 含中文，`getWindowsInstallationDirName`（`app-builder-lib/out/targets/targetUtil.js:40-42`）回落到 sanitizedName，即 `kimi-work-legal`，可执行文件是 `executableName` 的 `KimiWorkLegal.exe`，与工作流 `:97` 一致。
  - 冒烟退出码由 `app.exit(result.ok ? 0 : 1)` 给出，`:105` 据此断言。
  - `permissions: contents: read`，不在 `pull_request` 上触发，自签名证书与测试发布密钥都是每次新建的，上传物不含 pfx 或私钥，密钥泄露风险低。
- **缺口**：
  1. 打包时没有 `electron/release.json`（`package-desktop.mjs:112` 只打印提示）。安装包不含更新配置与云上游，所以：
     - `initUpdater` 返回 `not_configured`；
     - 冒烟跳过更新器；
     - `sign-update.mjs` 生成的 `kwl-update.json` 无人消费；
     - `dev-codesign.mjs` 注释中“跑通签名、安装、更新校验整条链路”的说法在 CI 中不成立。
  2. `:93-94`、`:99-100` 的安装包签名状态与 `node.exe` 的签名者（期望 OpenJS Foundation）只打印、不断言。如果 `signExts` 将来失效导致 node.exe 被重签，CI 不会失败，只会在冒烟阶段以“摘要不符”的形式暴露。
  3. `Start-Process ... -Wait` 在 Windows 上会等待整个进程树。若内核子进程（闸门、kap 宿主）在 `app.exit` 后靠看门狗才退出，或因 A13 的 PID 复用没有退出，这一步会挂到作业超时（90 分钟）。步骤本身没有 `timeout-minutes`。
  4. 冒烟只判断 `did-finish-load`（见 A03）。
  5. `package-desktop.mjs:41` 在 Windows 上以 `shell: true` 加参数数组调用。Node 不会转义这些参数（DEP0190）。CI 路径没有空格，可以通过；本地 Windows 开发机上路径含空格（例如本仓库根目录 `Kimi Work Legal`）时，`--out` 等参数会被拆开。
  6. “全量”步骤 `continue-on-error: true`，可以接受，但需要按计划逐条转为阻断。
- **建议修复**：
  - CI 生成一份测试用 `release.json`：`update_base` 指向工作流内起的本地 https 服务（自签证书，用该证书的 SPKI 作钉住），`update_keys` 取 `sign-update.mjs --print-public-key` 的输出。之后增加一步“安装 1.0.0 → 发布 1.0.1 → 检查更新并下载 → 核验 → 退出安装 → 版本断言”；再加两个负例：篡改安装包被拒、用错误密钥签发的清单被拒。
  - 断言 `$sig.Status`（自签名在 runner 上通常是 `UnknownError`，可以断言签名者主体）和 node.exe 签名者包含 `OpenJS Foundation`。
  - 冒烟步骤设 `timeout-minutes: 10`；或用 `-PassThru` 加 `WaitForExit(600000)` 只等主进程，再断言没有残留的 node 进程。
  - `run()` 在 Windows 上只对 `npm`/`npx` 使用 shell，`node` 直接 `execFileSync(process.execPath, …)`。
- **建议补测**：即上面的 CI 更新链与负向冒烟。

---

## 九、其他问题（题 9）

### B4-A19（一般）单实例锁失败后仍注册了 `whenReady` 处理（既有问题，第 4 批的冒烟与更新使其更容易触发）

- **结论**：需核实，属于既有问题。
- **证据**：`main.cjs:366-376` 获取锁失败时只调用 `app.quit()`，而 `:393` 的 `app.whenReady().then(...)` 在 if/else 之外，无条件注册。Electron 官方示例把 `whenReady` 放在 else 分支内。若 ready 之前调用 `quit()` 后 ready 事件仍然触发，第二个实例就会执行 `markNotContentIndexed`、`bundledRuntime`、`startKernel`（解封密钥并在同一 `DATA_DIR` 上再拉起一个内核），冒烟模式下还会写结果文件。本批新增的 `--kwl-smoke` 和更新安装后的 `--force-run` 都会在应用已运行时产生第二个实例。
- **影响**：两个内核同时打开同一个加密库与工作区，代码注释自己也写了“会互相锁死”；命名管道绑定失败会导致第二个内核报错退出。
- **建议修复**：把 `whenReady` 与其他启动逻辑移进 else 分支。拿不到锁时，若是冒烟模式，写 `{ok:false,error:"already_running"}` 后 `app.exit(2)`。
- **建议补测**：主进程启动编排抽出纯函数并单测；Windows CI 在应用运行时再启动一次冒烟，期望退出码 2，且只有一个内核进程。

### B4-A20（建议）安装包形态仍下发指向不存在文件的入口

- **结论**：建议。
- **证据**：`main.cjs:139-143` 在安装包形态给出 `__dirname/agent-host.bundle.mjs`、`egress-gate.bundle.mjs`、`kap-host.bundle.mjs`，但 `package-desktop.mjs:103` 只暂存了 `preload.cjs` 与 `kernel.bundle.cjs`。其中闸门与 kap 的入口会被 `runtimeEnv` 的 `ZR_EGRESS_GATE_ENTRY`/`ZR_KAP_HOST_ENTRY` 覆盖（`release-config.cjs:116-119`，后者展开在后），而 `ZR_AGENT_HOST_ENTRY` 不会被覆盖。由于 `kernel/src/index.ts:291` 在 `ZR_AT_REST=required` 时禁用 SDK 引擎，这条路径目前不可达。`main.cjs:142` 的注释“安装包随包制品尚未构建”也已过时。
- **建议修复**：安装包形态不下发 `ZR_AGENT_HOST_ENTRY`；入口只从 `runtimeEnv` 取，`runtimeEnv` 缺项即判运行时损坏；修正注释。
- **建议补测**：`release-config.test.ts` 断言：安装包形态下，`kernelChildEnv` 输出的每个 `*_ENTRY` 都等于 `runtimeEnv` 的值，且不含 `ZR_AGENT_HOST_ENTRY`。

---

## 附：应补测试汇总（按优先级）

1. **A11/A12**：设备恢复的完整场景（device.json 重建 → 导入 → 新旧事项可读、公钥与私钥成对），以及篡改编号、篡改证书、已吊销设备三个负例。
2. **A03**：Windows CI 冒烟增加“界面真正挂载”检查，并加一例篡改 asar 后启动失败的负向冒烟。
3. **A18/A04/A05**：CI 跑通“安装 → 检查更新 → 核验 → 安装 → 版本断言”，负例覆盖篡改安装包、错误密钥、过期清单、篡改 pending 文件。
4. **A16**：出口登记与《中软看得到什么》联动的静态测试。
5. **A01**：清单覆盖依赖闭包与 asar.unpacked 原生模块；缺 `sha256` 时拒绝。
6. **A09/A13**：Windows CI 断言 `NotContentIndexed` 属性；冒烟后无残留 node 进程；父进程退出后子进程按时退出。
7. **A15/A20/A08/A07**：静态扫描全部 `child_process` 引入点；入口环境只来自 `runtimeEnv`；冒烟结果文件不覆盖已有文件、不写 UNC；更新失败按类别区分。

---

## 处置（2026-10-14，同日）

| 编号 | 处置 | 改动 | 补测 |
|---|---|---|---|
| A03（实为阻断） | **已修复**。先用 Playwright Chromium 复现：file:// 下 vite 产物的模块脚本与 crossorigin 样式被 CORS 拦下，根节点 0 个子元素。界面改由特权自定义协议 `kwl://app/` 提供（standard、secure、supportFetchAPI，在 ready 之前登记）。处理器只读 dist 内已知类型的文件，穿越、空字节、未知类型、非 GET 一律 404。地址策略在生产形态只认 `kwl://app`，任何 file:// 地址都拦，UNC 问题随之消失。熔断 `grantFileProtocolExtraPrivileges:false` 保持不变。冒烟增加 `renderer_mounted` 检查（根节点有子元素）。本机用 Electron 44 实测：界面挂载，源为 `kwl://app`，CSP 拦下页面内的穿越 fetch | `electron/app-protocol.cjs`（新）、`url-policy.cjs`、`main.cjs` | `desktop-surface.test.ts` 改写：协议地址放行，file://、别的主机、带端口或口令的地址拦截；dist 内路径解析的穿越负例；静态断言 `registerAppScheme`/`loadURL(APP_INDEX_URL)`、无 `loadFile`、熔断保持关闭 |
| A11 | **已修复**。导入时由备份私钥推导两把公钥（同时核对是 Ed25519/X25519），写回一致的四元组，`devices.sign_pub_pem`/`enc_pub_pem`/`cert_json` 在同一事务里更新。“丢失后重开到导入之间”用临时密钥包裹的 `matter_keys` 与 `matter_ws_keys`：先用临时私钥解开，再改包裹给备份公钥；备份私钥本来能解的保持不动，两边都解不开的如实计数（`unreadable`）。账本先提交、密钥文件后写：写文件失败时重新导入即可，不会丢数据。同一设备编号下被替换的证书留档（迁移 0024 `device_cert_history`；`ensureDevice` 换新密钥时、导入时各留一次）。链复核、成果审批、删除回执验签时，先试当前证书、再试留档证书，每张都须律所根签发且编号一致，所以伪造不出来。导入后、重启前，其余操作一律 409（`restartLatch`），避免新事项被包裹给旧密钥 | `api/index.ts`（`recovery.*`、`approvals.verify`、删除回执视图、API 组装）、`devices.ts`（`archiveDeviceCert`）、`ledger-signer.ts`（`archivedCertsOf`、`certVerifying`、链复核回退）、`migrations/0024_v9_device_cert_history.sql` | `device-recovery.test.ts` 完整场景：事项甲 → 导出 → 删 device.json 重开（换临时密钥，甲不可读）→ 事项乙 + 一份设备签名签发 → 导入（改包裹 ≥1、不可读 0、重启前建事项被拒）→ 重开后四元组与原设备一致、私钥与公钥成对、devices 行等于推导公钥，甲、乙、新建丙都可读，见证链与检查点全部通过，临时密钥期间的签发仍 valid（证明包给出实际签名的证书），再导入一次改包裹为 0。变异核验：去掉留档回退后此用例失败（seq 5–7 签名验签失败） |
| A12 | **已修复**。恢复文件 v2 把 `device_id` 与证书摘要放进 scrypt 包裹的明文，外层明文字段被改即拒绝。证书须律所根签发、未过期，编号与成员是本机，其中公钥等于推导结果，否则不写入。设备已吊销（`devices.status` 或控制面墓碑 `cp_revoked_devices`）时直接拒绝，提示由管理员重新签发，不改 `status`/`revoked_at`。v1 文件没有包裹内绑定，靠证书与公钥核对 | 同上 | `device-recovery.test.ts` 负例：别的设备的文件改成本机编号、证书改角色（v2 摘要不符）、v1 形态改证书（根验签不过）、私钥换成别的密钥（与证书不符）、已吊销设备（409，状态仍为 revoked），拒绝时 device.json 不变 |
| A16 | **已修复**。《中软看得到什么》增加“自动更新”一行：本机 IP、User-Agent（操作系统与应用版本）、渠道，保存在更新服务器访问日志里；看不到账号、设备编号、任何持久本机标识与事项内容。`x-user-staging-id` 固定为全零，不再生成 `.updaterId`。D-58 措辞改正 | `Connections.tsx`、`updater.cjs`、进度文档 D-58 | — |
| A01 | **已修复**。运行时清单 `all[]` 列出 runtime 目录全部文件（含依赖闭包、原生模块与 DLL、wasm、模型）。安装包形态启动时同步核对：入口摘要、全部文件的存在与大小、清单外多出的文件、asar.unpacked 里 better-sqlite3 原生模块的摘要（暂存时写进 asar 内清单副本）；清单项缺 `sha256` 即判损坏。全部文件的摘要在后台核对，不符即有序关闭内核并显示修复指引；冒烟同步等这一结果。按用户安装时，同一账户下的恶意程序不在防护范围内，已写进 `release-config.cjs` 说明（要防这一层选按机器安装） | `scripts/build-runtime.mjs`、`scripts/package-desktop.mjs`、`runtime-paths.cjs`（`treeProblems`、`unpackedProblems`、`verifyRuntimeDigests`）、`main.cjs` | `w-runtime-bundle.test.ts` 新例：依赖闭包里同样大小的 JS 被改（同步放行、后台发现）、清单外文件、缺摘要、unpacked 原生模块被改 |
| A02 | **已修复**。安装包只接受 `win32-x64`。交叉构建时，目标平台原生包只取按锁文件核验过的缓存，并核对锁定版本等于 `@napi-rs/canvas` 声明的版本 | `package-desktop.mjs`、`build-runtime.mjs` | — |
| A04 | **已修复**。覆盖 `doInstall`：安装前用内存中已核验的清单重算安装包大小与 sha512，没有核验记录或不符即删除文件、放弃安装。缓存命中（`update-downloaded` 时本次运行没有核验记录）重新取清单核验缓存文件。D-58 写明按机器安装时更新以管理员身份运行 | `updater.cjs` | `update-verify.test.ts`（核对函数的不符分支）；篡改 pending 文件的 Windows CI 用例见 A18 未完成项 |
| A05 | **已修复**。清单增加 `expires_at`（不超过 90 天，`sign-update` 缺省 30 天，可用 `--valid-days` 调整）；`released_at` 不得晚于本机时间 1 天以上。`file` 只许 ASCII，并须等于 latest.yml 的文件名。清单按渠道命名为 `kwl-update-<渠道>.json` | `update-verify.cjs`、`sign-update.mjs`、CI 上传路径 | 过期、签发在未来、有效期过长、缺字段、非 ASCII 文件名、文件名不一致、渠道命名 |
| A06 | **已修复**。钉住命中后回调 `-3`（沿用 Chromium 结果，保留 CT）。latest.yml 里的安装包地址若为绝对地址，须同为更新源主机与 https。`release.example.json` 说明只钉叶子或中软自有中间证书 | `updater.cjs`、`release.example.json` | 本地 https 实测见 A18 未完成项 |
| A07 | **已修复**。取不到清单（网络或 HTTP）抛 `ManifestUnavailableError`，界面显示“稍后重试”；签名或内容不符才显示“已丢弃、联系 IT”。改为先核验清单再下载（`autoDownload=false`），清单不符就不下载约 200 MB 的安装包。关于 app-update.yml 的注释改为“缓存目录名仍取自它” | `update-verify.cjs`（`classifyUpdateError`）、`updater.cjs` | 错误分类纯函数用例 |
| A08 | **已修复**。冒烟须同时设置 `KWL_SMOKE=1`。结果文件只能是本地盘符下的绝对 `.json` 路径，拒绝 UNC 与设备路径，已存在即拒绝；带了参数却不合规时直接以 3 退出，不进入正常界面。结果只写登记的错误代码。冒烟会在本账户真实数据上启动一次内核，已写在模块说明里 | `electron/smoke-io.cjs`（新）、`main.cjs`、CI | `smoke-io.test.ts`；CI 第二次以同一结果文件冒烟，须以 3 退出且文件不变 |
| A09 | **已修复**（属性继承仍待实机核对）。分两次调用：先 `attrib +I <根>`，再 `attrib +I <根>\* /S /D`；按应用版本写标记文件，只在首次或升级时执行 | `main.cjs` | CI 打印数据根及子项属性（只报告，不阻断） |
| A10 | **已修复**。检测旧漫游位置（`%APPDATA%\KimiWorkLegal`、旧 userData 的 `ledger-key`），首次发现时提示一次 IT 处置办法，不自动搬迁加密材料。两处过时注释已改 | `main.cjs`、`electron-builder.yml`、`release-config.cjs` | 未抽纯函数单测（剩余项） |
| A13 | **已修复**。父进程经 IPC 每 2 秒发心跳。三个子进程在 `KWL_PARENT_HEARTBEAT_MS` 存在时看心跳：30 秒（至少 5 个周期）收不到即退出；自身事件循环卡顿超过 6 秒的那一轮跳过，避免主线程忙时误判。其他平台仍检查 ppid。注释中的理由已改正。内核增加 `kernel.shutdown`：退出与安装更新前先有序关闭闸门、Agent 宿主与账本，最多等 8 秒再强制终止；冒烟结束前同样走这一步 | 三个子进程的 `main.ts`/`supervisor.ts`、`child-env.ts`、`gate-host.ts`、`kap-agent-client.ts`、`exec-wasm/src/host.ts`、`electron-entry.ts`、`main.cjs`（`stopKernel`） | `parent-heartbeat.test.ts`：没有心跳的子进程在 30.1 秒退出，有心跳的继续运行；CI 冒烟后断言安装目录下无残留进程 |
| A14 | **已修复（部分）**。每个数据目录首次运行生成随机盐（0600），参与管道名摘要，他人无法推算。客户端核对服务端进程身份未做：通道另有令牌鉴权 | `config.ts`（`pipeSalt`） | `pipe-salt.test.ts` |
| A15 | **已修复**。启动面测试改为扫描全部引入 `child_process` 的产品源码，并包含 exec/execFile 系列。taskkill 改用系统目录下的绝对路径。W 进程同时补 `windir` | `child-process-surface.test.ts`、`agent-host-manager.ts`、`exec-wasm/src/host.ts` | 即测试本身 |
| A17 | 见下方后续处置 | | |
| A18 | **部分修复**。冒烟步骤：`timeout-minutes: 15`，只等主进程（`WaitForExit`）；断言安装包签名者是本次测试证书、随包 node.exe 签名者是 OpenJS Foundation；冒烟后断言无残留进程；打印索引属性；第二次冒烟以 3 退出。`package-desktop.mjs` 中 node 直接运行，npm/npx 经 shell 时逐个参数加引号。**未做**：CI 内“安装 1.0.0 → 发布 1.0.1 → 本地 https 更新源（自签证书，SPKI 钉住）→ 下载核验 → 退出安装 → 版本断言”，以及篡改安装包、错误密钥、过期清单、篡改 pending 文件四个负例。这些需要 Windows runner 反复调试，列入下一批 | `.github/workflows/windows-desktop.yml`、`package-desktop.mjs` | 见左 |
| A19 | **已修复**。拿不到单实例锁的实例在 ready 回调里直接返回，不拉起内核。冒烟模式写 `already_running` 后以 2 退出 | `main.cjs` | CI 双实例用例未做（同 A18 剩余项） |
| A20 | **已修复**。安装包形态的闸门与 Agent 宿主入口只来自核验过的随包运行时，缺项即判运行时损坏；不再下发 SDK 宿主入口 | `release-config.cjs`、`main.cjs` 注释 | `release-config.test.ts` |

验证：`npx tsc -b tsconfig.check.json` 无错误；本批相关套件见进度文档“第 4 批处置”条目。
