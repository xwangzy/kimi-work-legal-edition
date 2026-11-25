# 审计 B：事项—材料—任务—成果关系（V40 UI/UX 重构）

- 范围：worktree `kimi-legal-b66-ux`，分支 `claude/kimi-legal-b66-ux`（基于 main 02e8f84a），只读审计，未改代码。
- 路径约定：下文 `kernel/` = `platform/packages/kernel/src/`，`desktop/` = `platform/apps/desktop/`，迁移 = `kernel/migrations/`。
- 用户诉求：文件上传、材料引用、事项管理关系不直观；首页 @ 材料在事项无材料时只能提示“先导入”；要求从第一性原理判断“独立 Workspace”还是“事项体系增强”。

---

## 1. 数据模型现状

### 1.1 事项（matters）

| 字段/能力 | 位置 | 说明 |
|---|---|---|
| 基本表 | 迁移 `0001_init.sql:40-57` | `matter_id/tenant_id/title/client_name/counterparty/stance/jurisdiction/key_dates/confidentiality/model_endpoint/collab_scope/consent_status/status('active','archived')/created_by` |
| 生命周期 | `0021_v9_matter_lifecycle.sql:5-10` | `lifecycle active→closed→purged`、`closed_at/retention_until/legal_hold/purged_at`；删除 = 密码学擦除 + 签名删除回执（`deletion_receipts`） |
| 客户授权（D-202） | `0070_v22_ai_authorization.sql`（整文件） | `matters.basis_source`（engagement_terms / confirmed / NULL）+ `user_ai_authorization` 律师本人默认；四项依据逐项记录 |
| 授权逐案留痕（D-216/D-225） | `0072_v51_authorization_evidence.sql`；`kernel/api/index.ts:1073-1076` | `matters.get` 返回 `authorization_history` |
| 案卷文件夹（D-203） | `0071_v22_matter_folder.sql:7-11` | `matters.folder_root/folder_linked_at/folder_synced_at`（仅本机，同步不导出：`kernel/sync-engine.ts:686`）；`document_versions.rel_path` |
| 成员 | `0001_init.sql:59-66` | `matter_members`（owner/editor/reviewer/issuer/viewer）——伦理墙与权限按事项 |

结论：**事项就是唯一的“工作区/隔离单元”**——权限（`requireMatterAccess/requireMatterWriter`）、加密密钥（`0020_v9_matter_ws_keys.sql`，块按事项加密，见 1.2）、代号表（令牌化按 `matter_id`）、客户授权、模型端点、生命周期都挂在事项上。

### 1.2 材料（document_versions + 附属表）

| 项 | 位置 | 现状 |
|---|---|---|
| 主表 | `0001_init.sql:69-84` | `document_version_id, matter_id(NOT NULL), tenant_id, filename, sha256, size_bytes, mime, storage_mode('mount'|'import'), storage_uri, supersedes(自引用版本链), uploaded_by, created_at`；索引 `(matter_id)`、`(tenant_id, sha256)` |
| 隔离（国家秘密标志） | `0022_v9_quarantine_anchors.sql:6-7` | `quarantined_at/quarantine_reason`；`kernel/api/index.ts:696-743` 隔离时删解析文本、派生风险卡与事实，同事项同 hash 的登记一并隔离 |
| 文件夹位置 | `0071_v22_matter_folder.sql:10-11` | `rel_path`（相对路径，可空；同一位置内容变化→新导入一份，`supersedes` 指上一版） |
| 用途标签（我方/对方/参考） | `0027_v9_document_roles.sql:5-12` | **单独成表** `document_roles(document_version_id PK, matter_id, role IN ('ours','theirs','reference'), set_by, set_at)`——因为文档行在签名事件链上，改列会改行摘要；写入 `materials.set_role`（`kernel/api/index.ts:1309-1326`） |
| 解析 | `0001_init.sql:86-117`、`0003_parse_ocr.sql` | `parse_versions`（可多版，重解析不改原件）、`parse_texts`、`parse_pages`（逐页质量 ok/low/unreadable）、`evidence_anchors`（引用锚点） |
| 存储位置 | `kernel/blobs.ts:86-101` | 导入副本 `blob://<matter_id>/<sha256>`，按事项密钥 AES-GCM 加密；**跨事项不复用密文块**（`blobs.ts:89` 注释“伦理墙——读块只需本事项密钥”）；挂载 `file://绝对路径`（只读引用，不复制） |
| 去重/哈希 | `kernel/api/index.ts:1235-1236`、`blobs.ts:91-99`、`kernel/services/matter-folder.ts:1-4,53,489` | 内核复算 sha256（与声明不符即拒收）；**块级**同事项同内容只存一份文件；但 **`materials.import` 本身不去重**——同一文件导入两次会产生两条 `document_versions` 行（材料列表里两份）。只有“案卷文件夹同步”按 sha256 跳过已有内容（`matter-folder.ts:53` “内容与事项里已有的材料相同……没有重复导入”） |
| 来源标记 | 无 DB 列；靠**文件名约定** | 《当事人信息（律师填写）.txt》（`desktop/src/lib/parties.ts:155-157`，D-224）、案情说明 `briefFilename(day)`（`desktop/src/lib/scenarios.ts:1505`）均以 `materials.import` + `text/plain` 存为普通材料；成果转材料以“（第 N 轮修改后）”后缀命名（`kernel/api/index.ts:1284-1290`）；来源成果只记在审计（`index.ts:1304`） |
| 删除 | **无单份材料删除/归档方法** | 方法表里只有 `materials.import/from_artifact/set_role/mount/reparse/link_folder/sync_folder/unlink_folder/search/text/triage/send_preview` 与 `document.patch`（`index.ts:1217-1428, 2340, 3447, 3621, 3645`；`matter-folder.ts:454-513`）；文件夹里删掉的文件“只报告、不删事项材料”（`matter-folder.ts:3`）。材料只能随**整个事项** `matters.purge` 擦除（`index.ts:1464`），或因国家秘密标志被隔离 |
| 版本 | `supersedes` 链 | 只在三处产生：文件夹同步同位置变更、`materials.import` 带 `supersedes`（D-224 当事人信息改版，`index.ts:1237-1247` 仅允许取代本事项内未被取代的那份）、`document.patch` |

`matters.get` 一次返回事项全部材料（含 `dr.role`、`rel_path`、`supersedes`、`quarantined_at`）与最近 50 个任务（`kernel/api/index.ts:1055-1081`）。**材料列表不过滤已被取代的旧版**，由界面处理。

### 1.3 任务与材料的关系

| 项 | 位置 | 现状 |
|---|---|---|
| 任务表 | `0001_init.sql:118-139`（`0009` 重建状态） | `runs(run_id, matter_id NOT NULL, scenario, input_snapshot JSON, status...)` |
| 勾选材料 | `runs.input_snapshot.document_version_ids`（JSON 数组） | 估价时逐份校验未隔离（`kernel/api/index.ts:1586-1596`）；**没有 run_documents 关联表**，任务↔材料只在快照 JSON 里 |
| 没勾选 = 可读全部 | 界面文案 `desktop/src/lib/scenarios.ts:1772`；内核 `kernel/tools/tools/review.ts:37,70,153-154`；`kernel/executor/executor.ts:1086` | D-183“勾选即边界”（`platform/docs/v9-开发计划与进度.md:1755`）：勾了的任务，未勾材料只给文件名（`not_provided`），读取/修订/比对一律拒绝；一份都没勾 = 不设边界，可读本事项全部材料 |
| 追问补勾 | `kernel/api/index.ts:1840-1860`；`desktop/src/pages/RunView.tsx:497` | `followup_added_document_version_ids`：只能补、不能改成不限 |
| 我方/对方/参考 | `document_roles`（事项级，不是任务级） | 运行时写进 A1 材料快照清单（“001.txt（文件名 · 我方材料）”，`0027` 注释）；**同一份材料在不同任务里不能有不同用途** |
| 案情说明/当事人信息 | `desktop/src/components/ScenarioStart.tsx:218-225`、`desktop/src/lib/parties.ts:564` | 发起时存成事项材料；“勾了别的就把它一并勾上；一份没勾=已在全部里” |
| 任务运行中上传的文件 | 无专门通道 | 运行页没有“给这个任务上传文件”；只有追问补勾**已在事项里**的材料。任务级专用材料这一概念**不存在**——所有材料都是事项级 |

### 1.4 成果（artifact_versions）

| 项 | 位置 | 现状 |
|---|---|---|
| 主表 | `0001_init.sql:195-213` | `artifact_version_id, matter_id(NOT NULL), run_id(可空), kind, version, baseline_id, audience('internal','client','counterparty','court'), status('draft','pending_verification','pending_review','approved','issued','blocked','superseded','withdrawn'), filename, sha256, storage_uri, open_items, manifest JSON`；`UNIQUE(matter_id, kind, audience, version)` |
| 同一份文件的版本线 | `0066_v94_artifact_lineage.sql:8-17`；`kernel/services/artifact-lineage.ts` | `lineage`：场景+输入材料+去日期文件名 / 追问链+文件名 / 审查表与修订稿按所审合同 `doc:<source_document_version_id>`；`artifacts.list` 用 `withFileVersions` 给出“第 n 版、is_latest”（`kernel/api/index.ts:2199-2201`） |
| superseded | `kernel/services/attempt-supersede.ts:1-22` | 重新运行时上一次的草稿标 `superseded`（界面“已被替代”，只能预览下载、不能提交复核）；`LIVE_ARTIFACT = "status <> 'superseded'"` |
| 对外版/清洁稿/修订稿 | 文件名后缀约定 + `audience` | “（修订稿）（清洁稿）（修订稿·对外版）”见 `kernel/api/index.ts:1287`；签发绑定最终字节 hash（`approvals.artifact_sha256`） |
| 成果↔来源材料 | `manifest.source_document_version_id`（审查表、修订稿，`kernel/executor/executor.ts:1824,1846`）；其余经 `run_id → runs.input_snapshot.document_version_ids` 间接 | **没有成果→材料的显式外键或关联表**；界面要展示“这份成果用了哪些材料”只能解析任务快照 |
| 成果转材料 | `materials.from_artifact`（`kernel/api/index.ts:1270-1306`） | 仅 .docx；还原真名（代号还原不了即拒收，防代号进原件）；作为新材料登记、不动原成果 |
| 正文存储 | `blob://<matter_id>/<sha>`（令牌形态），下载时还原真名（`kernel/api/index.ts:2209-2255`） | 预览 `restore:false` 只显示代号形态 |

### 1.5 跨事项引用

- 内核：`runs.estimate` 只按 `document_version_ids` 查隔离状态（`index.ts:1588-1590`），而 Agent 读取工具 `materials.read_excerpt` “只校验材料属于本事项”（D-183 原文，`v9-开发计划与进度.md:1755`）；块存储按事项加密、不跨事项复用（`blobs.ts:89`）；`materials.from_artifact` 写回成果**所在事项**（`index.ts:1293`）。=> **当前不存在跨事项引用通道**，跨案误引用在数据层已被阻断；唯一的“复用”是把同一文件分别导入两个事项（两份密文、两条登记）。
- 问答（Chat）：`chat.send` 明确拒收 `matter_id/document_version_ids/attachments/files/...`（`kernel/api/w1.ts:207-212`，D-225 口径：一般问答不带案件材料）。

### 1.6 小结（第 1 部分）

1. 现有模型已经是“事项 → 材料（版本链）→ 任务（快照勾选）→ 成果（lineage 版本线）”的**以事项为根的树**；缺的是**显式关联**和**界面上的可见性**，不是缺一个新的容器。
2. 三个真实缺口：(a) 单份材料不能删除/归档/隐藏旧版；(b) `materials.import` 不按 sha256 去重（文件夹同步才去重）；(c) 任务↔材料、成果↔材料只在 JSON 快照/manifest 里，没有可查询的反向索引（“这份材料被哪些任务用过”要扫 `runs.input_snapshot`，`kernel/api/index.ts:721` 隔离时就是这么扫的）。
3. “事项级公共材料 / 任务级专用材料 / 任务成果”三分法里，第二类在数据上不存在：任务专用 = “本事项材料 + 本任务勾选”。


---

## 2. 上传与导入路径

### 2.1 链路总览（界面 → 渲染层 api → 主进程 → 内核）

公共底座：
- 选择文件：`pickMaterials()`（`desktop/src/api.ts:88-102`）→ 桌面端 `window.zrKernel.pickFiles` → 主进程 `ipcMain.handle("kwl:pick-files")`（`desktop/electron/main.cjs:778-796`，`dontAddToRecent`，只回**一次性句柄**+文件名+大小）；web 开发形态退回隐藏 `<input type=file>`。
- 拖放：preload `fileHandleFor(file)` 经 `webUtils.getPathForFile` 取路径 → `kwl:register-file` 换句柄（`desktop/electron/preload.cjs:43-56`）；网络路径一律不收（`desktop/electron/file-dialogs.cjs:167-172`）。
- 主进程转发内核调用时把 `file_handle` 换成 `path`：`OPEN_METHODS` 只登记了 `materials.import`、`materials.mount`（`file-dialogs.cjs:15-17`），文件夹 `materials.link_folder`（`file-dialogs.cjs:29-34`）。
- 渲染层封装：`api.importMaterial`（句柄 / 拖放句柄 / web 退回 base64，`desktop/src/api.ts:966-976`）、`api.importMaterialText`（文字→base64，`api.ts:982-983`）、`api.mountMaterial`（`api.ts:988-993`）、`api.linkFolder/syncFolder/unlinkFolder`（`api.ts:999-1012`）、`api.artifactToMaterial`（`api.ts:987`）。

| # | 入口（界面） | 组件:行 | 渲染层 | 内核方法 | 备注 |
|---|---|---|---|---|---|
| 1 | 首页输入框左下“+” | `desktop/src/components/Composer.tsx:132-143` | `pickMaterials` → `onImport` → `Home.importFiles`（`pages/Home.tsx:238-265`）→ `api.importMaterial` | `materials.import` | **无事项时按钮禁用**（`disabled={!props.matterId}`，title“先选事项，再导入材料”）；导入成功后自动把新材料加入本次勾选（`Home.tsx:252`） |
| 2 | 首页“@ 材料”托盘按钮 / 输入框末尾打 `@` | `Composer.tsx:170-172`（按钮，无事项禁用）、`Composer.tsx:90`（打 `@` 不判断事项，仍会弹出）、弹层 `Composer.tsx:212-234` | 只做勾选，**没有上传入口** | — | 空时只显示 `本事项还没有材料，先“导入”。`（`Composer.tsx:215`）；没选事项时打 `@` 同样显示这句（误导：并不是“本事项”）；列表来自 `Home.docs`，只滤掉隔离的（`Home.tsx:211`），**不滤“已被取代的旧版本”**，也不显示用途/来源/文件夹位置 |
| 3 | 开始面板“还有材料？拖到这里，或选择文件” | `desktop/src/components/ScenarioStart.tsx:476-498` | `addFiles` → props.onImport = `Home.importFiles`（`Home.tsx:455`） | `materials.import` | 新导入的自动勾选；面板列表滤掉旧版本（`ScenarioStart.tsx:63`）；无事项时显示“新建事项”（`ScenarioStart.tsx:396,431`），`docsReady=false` 时不显示拖放区（`ScenarioStart.tsx:59,478`） |
| 4 | 开始面板“案情说明”字段 | `ScenarioStart.tsx:218-225,543` | `api.importMaterialText(…, briefFilename(day), text)` | `materials.import`（`text/plain`） | 同一段文字只存一次；作为普通材料 |
| 5 | 事项概览“当事人信息”对话框 | `desktop/src/components/PartiesInfo.tsx:149,167` | `api.importMaterialText(…, PARTIES_FILENAME, text, prev)` | `materials.import` 带 `supersedes` | D-224；事项里只留一份当前有效 |
| 6 | 事项页“材料”标签拖放区 / 选择文件 | `desktop/src/pages/Matter.tsx:427-442` | `upload(files,"import")`（`Matter.tsx:151-178`） | `materials.import` | 文案“加密保存一份副本，原文件不改动” |
| 7 | 事项页“只引用、不复制” | `Matter.tsx:439,441` | `upload(files,"mount")` → `api.mountMaterial` | `materials.mount` | 只读引用 `file://`；**只有事项页有此入口** |
| 8 | 事项页内输入框“+” | `Matter.tsx:350-361` | `upload(f,"import")` | `materials.import` | 与首页不同：导入后**不会自动勾选** |
| 9 | 案卷文件夹（关联/同步/取消） | `desktop/src/components/MaterialFolderBar.tsx:44-46`（挂在 `Matter.tsx:424`） | `api.linkFolder/syncFolder/unlinkFolder` | `materials.link_folder / sync_folder / unlink_folder`（`kernel/services/matter-folder.ts:454-510`），逐份内部调用 `materials.import`（`kernel/api/index.ts:1356-1365`） | 唯一按 sha256 去重的路径；文件夹里删掉的只报告 |
| 10 | 成果“作为材料继续修改” | `api.artifactToMaterial`（`api.ts:987`），调用点在成果行/运行页 | — | `materials.from_artifact`（`kernel/api/index.ts:1270-1306`） | 仅 .docx；还原真名，代号还原不了拒收 |
| 11 | 运行页追问 | `desktop/src/pages/RunView.tsx:497` | 只“补勾”已有材料 | `runs.start`（followup，`kernel/api/index.ts:1840-1860`） | **运行页没有上传入口** |
| 12 | 问答（Chat）附件 | `desktop/src/pages/Chat.tsx`（无附件控件；遇到案件材料时给“到事项「…」中处理”链接，`Chat.tsx:291`） | — | `chat.send` 拒收任何材料字段（`kernel/api/w1.ts:207-212`） | 设计如此（D-225） |

**一致性结论**：所有“文件进事项”最终都收敛到两个内核方法——`materials.import`（9 条路径）与 `materials.mount`（1 条），文件夹同步与成果转材料在内核内部复用同一套 `insertDocumentWithParse`（`kernel/api/index.ts:635-670`）。内核侧是一致的；**不一致全在界面**：
- 首页 `+` 导入后自动勾选，事项页输入框导入后不勾选（`Home.tsx:252` vs `Matter.tsx:165-173`）；
- 开始面板滤掉旧版本，首页 @ 弹层不滤（`ScenarioStart.tsx:63` vs `Home.tsx:211`）；
- “只引用不复制”与“关联文件夹”只在事项页；
- 首页输入框本身不支持拖放（`Home.tsx`/`Composer.tsx` 无 `onDrop`），开始面板与事项页支持；
- 导入后都不调用 `notifyDataChanged()`（只有新建事项、发起任务等调用，见 `desktop/src/lib/events.ts:1-9` 与调用点），侧栏等其他视图不会立刻知道材料数变化。

### 2.2 导入后的处理状态（同步完成，没有后台队列）

`materials.import`（`kernel/api/index.ts:1217-1263`）→ `insertDocumentWithParse`（`index.ts:635-670`）在**一次调用内同步**完成：
1. 读字节：`path` 时 `lstat` 拒绝符号链接（`index.ts:1224-1225`）；大小上限 `MAX_BYTES`（`index.ts:1234`）；复算 sha256，与声明不符拒收（`index.ts:1235-1236`）。
2. 解析/OCR：`parseAny(bytes, filename, mime)`（`index.ts:650`）；OCR 未就绪时扫描页标 unreadable、不伪造文本（`index.ts:1426`）。
3. 密级闸门：`classifiedGate`（`index.ts:676-690`）——国家秘密标志直接拒绝、**不留任何副本**（块存储写入放在闸门之后：`index.ts:642-643,652`）；“内部★/工作秘密”照常导入并返回 `marking_notice`。
4. 加密入块：`blobs.put(bytes, matter_id)`（按事项密钥 AES-GCM，`kernel/blobs.ts:87-101`）。
5. 登记：一个事务写 `document_versions + parse_versions + parse_texts + parse_pages`（`index.ts:655-668`）。
6. 审计：`materials.import`（只记 sha256，`index.ts:1261`）。

**不在导入时做的**：
- **代号化（令牌化）不在导入时做**：原件按明文解析存储（加密块 + 解析文本），代号替换发生在发给模型之前（`runs.estimate` 的数据去向预览说明“发送前替换为代号”，`index.ts:1631-1634`；`summarizeSend` 在 `runs.start` 时全量扫描，`index.ts:1890`）；Composer @ 弹层标题“助手看到的是已替换代号的版本”（`Composer.tsx:214`）。
- **客户授权检查不在导入时做**：导入只要求事项写权限（`requireMatterWriter`）；授权/端点闸门在发起任务时（`modelBlockReason(matter)`，`index.ts:1613`）。=> 导入是纯本机动作，**任何时候都可以先导入、后补授权**，这一点对“首页先上传”很重要。
- 没有服务端事件广播：内核不推“材料已导入”事件（`materials.loaded` 是运行事件，`index.ts:2404`）；界面靠调用返回后 `reload()/loadMatter()` 刷新。

---

## 3. 首页没有选事项时，上传的文件应该归到哪里

现状：
- **没有“未归档 / 收件箱 / 草稿事项”概念**。`document_versions.matter_id NOT NULL`（`0001_init.sql:71`），块存储无事项时走 `_shared` 明文（`kernel/blobs.ts:86,90,93` 注释“须有充分理由”）——材料不可能无主。
- 首页其实很少处于“没选事项”：`loadMatters` 默认选中第一个进行中的事项（`desktop/src/pages/Home.tsx:169`）。真正没选的情形只有“一个事项都没有”或律师手动切成空。此时 `+` 与“@ 材料”按钮都禁用（`Composer.tsx:132,170`），`importFiles` 直接 `return`（`Home.tsx:239`），发送会弹新建事项（`Home.tsx:223`）。
- 反过来的风险：**默认选中第一个事项**意味着律师在首页随手拖/选文件，会进到“恰好排第一”的事项——这是“归属不明/跨案误放”的真实来源，比“无处可放”更危险。现有界面只在托盘写事项名（`Composer.tsx:160-162`），导入成功提示 `已添加 xxx（n 字）` 不写进了哪个事项（`Home.tsx:253`）。
- Chat 附件：不存在，且内核明确拒收（`kernel/api/w1.ts:207-212`）。问答页遇到案件材料引导“到事项中处理”（`desktop/src/pages/Chat.tsx:291`）。

判断：**不建议新增“未归档”收件箱**。理由：
1. 材料从导入那一刻起就按事项密钥加密、按事项令牌表还原、按事项客户授权放行；“无主材料”要么明文放 `_shared`（破坏现有“只有显式例外才明文”的纪律），要么再造一把“收件箱密钥”，后续“移入事项”需要解密重加密 + 改 `matter_id`（签名事件链上的行，`0027` 注释已说明改列会改行摘要）。
2. “未归档”会把“跨案误引用”从数据层阻断退化为界面层约束。
3. 律师的心智是“先有委托/案件再有卷宗”；首页上传的正确做法是**在上传那一刻强制确认归属**：选已有事项，或“用这些文件新建事项”（标题可由文件名/首段预填，`NewMatterDialog` 已有，`Home.tsx:458-470`）。新建事项本身已经很轻（客户授权按律师默认设置一次记录，D-202，`0070_v22_ai_authorization.sql` 注释）。


---

## 4. 成果页与事项页成果列表

### 4.1 全局“成果”页（`desktop/src/pages/Deliverables.tsx` `DeliverablesPage`，侧栏入口 `desktop/src/components/Sidebar.tsx:31`）

| 项 | 现状 | 位置 |
|---|---|---|
| 数据源 | `api.listMatters()` 后**逐事项并行**调 `artifacts.list`（最多 50 个事项），合并后按时间倒序；标题在渲染层还原代号 | `Deliverables.tsx:30-35,52-69`；内核 `kernel/api/index.ts:2184-2203`（带 `run_scenario/run_skill/run_primary/run_title/run_goal`，`withFileVersions` 给 version/is_latest） |
| 分组 | 事项 → 一次任务 → 每份文件（最新版 + 旧版）与过程文件、上一次运行的文件 | `Deliverables.tsx:77-84`；`desktop/src/lib/deliverables.ts:5`（groupDeliverables）、`:34`（groupByTask）、`:167`（splitTaskFiles：files/process/earlier）、`:74`（PROCESS_KINDS） |
| 筛选 | 复核流程条：草稿 → 待复核 →（退回）→ 已签发，末尾“全部”；缺省停在最该处理的一段；搜索框按文件名或事项名（本机内存） | `Deliverables.tsx:44-100`；`lib/deliverables.ts:237-269` |
| 操作 | 整行点开 = `/review/<id>`（左预览、右签发前检查）；下载（`artifacts.download` 还原真名 + `deliveries.create` 记下载）；悬停“提交复核”（`review.submit`）；展开旧版本；过程文件只下载 | `Deliverables.tsx:101-126,231-243`；`desktop/src/components/ArtifactRow.tsx:1-6,69,95,112,122,164` |
| 成果转材料 | 只在复核页：“作为材料继续修改” → `materials.from_artifact` | `desktop/src/pages/Review.tsx:168-172` |
| 依据材料 | 成果页**不显示**这份成果用了哪些材料；复核页只显示“材料读取 已读 x/y 份” | `Review.tsx:52-54` |

### 4.2 事项页“成果”标签（`MatterDeliverables`，`Deliverables.tsx:279-392`，挂在 `desktop/src/pages/Matter.tsx:560`）

- 数据源：本事项 `artifacts.list`（`Deliverables.tsx:300-310`）。
- 分组：按任务（`groupByTask`），每个任务一段：“看这次任务”跳 `/run/<run_id>/<matter_id>`、“预览交付包”（`deliveryPackage`：哪些可以交、哪些被扣下及原因，`lib/deliverables.ts:203-235`）。
- 没有复核流程条与搜索；空时“本事项还没有成果。任务完成后，生成的文件会出现在这里。”（`Deliverables.tsx:313`）。

### 4.3 运行页（任务）里的材料与成果

- `RunView.tsx:1031-1059`：两栏（过程/成果），材料收在标题下“材料 n 份 ▾”，没指定时写“材料：按需读取 ▾”；追问可补勾（`RunView.tsx:497-506,1221-1224`）。=> **任务页是目前唯一同时看得到“这次用了哪些材料 + 出了哪些成果”的地方**，但它是按任务看，不能从材料或成果反查。

### 4.4 事项页材料表（对照）

`Matter.tsx:413-521`：工具栏（列表/表格审阅 + 案卷文件夹条）→ 拖放区（添加 / 只引用不复制）→ 材料搜索（`MaterialSearch`，文件名即时筛 + 回车全文搜，`materials.search`）→ 表格列“文件｜用途（我方/对方/参考）｜初判｜读取｜审查意见｜时间”；旧版本标灰“旧版本”（`Matter.tsx:448,462`）。
**缺少**：预览原文（`materials.text` 已有，`kernel/api/index.ts:2340`，界面只在 `ReviewWorkbench.tsx:143`、`PartiesInfo.tsx:69` 用）、“用于哪些任务/产生哪些成果”、移除误放材料、来源（律师上传 / 文件夹 / 律师填写 / 成果转入）。

### 4.5 小结（第 4 部分）

材料与成果分处“材料”“成果”两个标签与一个全局成果页，三处之间**没有互相跳转的关联线**：材料行不知道被谁用，成果行不知道依据谁，只有任务页把两头串起来。用户说的“缺乏清晰的案件与文件对应关系”，在代码上就是这条缺失的关联线 + 入口不一致，而不是缺一个文件容器。


---

## 5. 方案比较与推荐

### 5.1 第一性原理判断

1. **律师工作的最小可信单元是“事项（委托）”**：保密义务、利益冲突（伦理墙）、客户授权、数据去向、保留期与删除，全部按委托来定义。产品已经把这些都绑在 `matter_id` 上：块加密密钥（`kernel/blobs.ts:86-101`）、代号表（`tokens.restore(matter_id, …)`，`kernel/api/index.ts:1276,2216`）、客户授权与端点（`0070`、`index.ts:1613`）、生命周期与密码学擦除（`0021`）、成员与角色（`0001_init.sql:59-66`）。**文件的“归属”就是“它落在哪个委托的保密范围里”**，所以文件不能脱离事项成为一级容器——独立 Workspace 至多是“视图”，不能是“容器”。
2. 审计发现的真实痛点都能在事项体系里解决：
   - 关联线缺失：材料不知道被哪些任务用，成果不知道依据哪些材料（第 1.3、1.4、4.5 节）；
   - 入口不一致与死胡同：12 条路径、4 种界面行为，@ 弹层空态只能“先导入”（第 2.1 节，`Composer.tsx:215`）；
   - 归属不显式：首页默认选中第一个事项（`Home.tsx:169`），导入提示不写事项名（`Home.tsx:253`）；
   - 整理动作缺失：不能移除误放材料、`materials.import` 不去重、@ 弹层列出旧版本、事项页不能预览原文（第 1.2、2.1、4.4 节）。
3. “事项级公共材料 / 任务级专用材料 / 任务成果”三分法：在 D-183“勾选即边界”之下，“任务专用” = 本事项材料 + 本任务勾选，**不需要也不应该新造一类存储**（新造会出现“同一份文件在任务 A 是专用、任务 B 想用要再传一次”的重复存储）。需要的是把“勾选”与“产出”在界面上画出来。

### 5.2 三个方案

**方案 A：独立“文件” Workspace（全局文件管理器 + 未归档收件箱）**
- 形态：侧栏新增“文件”，跨事项列出全部材料与成果，可在里面上传（进收件箱）、移动到事项、引用到任务。
- 需要：`document_versions.matter_id` 可空或造“收件箱”伪事项；移动 = 解密→用目标事项密钥重加密→改 `matter_id`（这是签名事件链上的行，`0027` 注释已说明改列会改行摘要）→重建解析、代号、事实与风险卡归属；同步引擎、生命周期删除、驻留面登记（`platform/docs/privacy/residency.json`）都要改。

**方案 B：事项为中心增强（推荐）**
- 形态：事项页把“材料—任务—成果”关联线画出来；首页 @ 材料直接上传到当前事项；无事项时上传即引导“选已有事项 / 用这些文件新建事项”；统一一套上传/勾选组件；补齐预览、去重、移除。
- 不新增容器、默认不新增迁移。

**方案 C：B + 跨事项只读“案卷总览”**
- 在 B 之上加一个只读的全局视图（事项为文件夹、点进即进事项案卷），复用全局搜索 `search.titles`（已覆盖事项/任务/成果/材料，`kernel/api/index.ts:2810-2830`）与 `matters.list`。**不在跨事项视图里做上传、移动、引用**，只做“找文件 → 进事项”。
- 变体（不推荐）：“收件箱 = 一个 `model_endpoint='none'` 的特殊事项”，零迁移，但“移入事项”= 复制到目标事项 + 在收件箱移除，仍是第二套心智，且收件箱里的材料归属不明正是用户要消除的问题。

| 维度 | A 独立 Workspace | B 事项为中心增强 | C = B + 只读总览 |
|---|---|---|---|
| 用户体验 | 网盘式熟悉，但与事项页两套入口；“先传后归档”养成归属不明的习惯 | 一个心智：一切文件都在某个事项里；首页/开始面板/事项页/追问同一组件；上传时就定归属 | B 的全部 + 跨事项找文件更顺手 |
| 功能完整性 | 最全（移动、跨事项复用） | 覆盖上传、分类（用途+来源）、预览、检索、引用、复用（成果转材料已有）、移除；不支持跨事项复用（有意为之） | 同 B，外加全局浏览 |
| 开发量 | 约 25–35 人日 + 迁移 + 同步/生命周期/驻留面改造 | 约 9–12 人日（内核 2–3、界面 5–7、测试与真实走查 2），零迁移（可选 1 个） | B + 约 3–4 人日 |
| 数据安全 | 最弱：收件箱需明文 `_shared` 或新密钥；跨事项移动/引用打开误引用通道；授权判定时点变复杂 | 不变或更强：入口仍只走 `materials.import/mount`；归属显式确认；误放可擦除；不开跨事项通道 | 同 B（总览只读） |
| 长期维护 | 两套文件语义并存，每个新功能都要考虑“收件箱里的材料” | 一套语义，复用现有内核方法 | 同 B，多一个只读页 |

**推荐：B（第一步），C 作为第二步视使用反馈再做。**

### 5.3 方案 B 落地清单

#### 内核（`platform/packages/kernel/src/`，默认零迁移）

| 编号 | 改动 | 位置 | 说明 |
|---|---|---|---|
| K1 | `materials.import` 同事项同内容去重 | `api/index.ts:1235` 之后、`insertDocumentWithParse` 之前 | 查 `matter_id=? AND sha256=? AND quarantined_at IS NULL` 且未被取代的那份；命中返回 `{document_version_id, duplicate: true, filename(原名)}`，不新建行；带 `supersedes`（D-224）时跳过；只对 `import` 生效（`mount` 语义不同）。文件夹同步已有同口径（`services/matter-folder.ts:256-262`），可抽公共查询。注意既有用例里重复导入同一夹具的断言 |
| K2 | `matters.get` 补关联字段 | `api/index.ts:1057-1069` | `runs[]` 加 `document_version_ids`（`snap` 已解析，`:1067`）与成果数；`documents[]` 加 `quarantine_reason`、`used_by`（反算：哪些任务勾选过；未勾选的任务记为“可读全部”另列）。也可另开只读 `materials.usage`，避免 `matters.get` 变重 |
| K3 | 新增 `materials.remove`（移除误放材料） | 复用 `quarantineDocument`（`api/index.ts:696-745`） | `reason="removed_by_lawyer"`；参数化成果待处置文案（现写死“国家秘密标志”，`:726`）与 `materials.text` 拒绝文案（`:2345`）、`runs.estimate` 拒绝文案（`:1590`）；守卫：`requireMatterWriter`、示例事项拒绝（`assertNotSample`）、有进行中任务勾选了它时拒绝；挂载材料只解除引用不删原件；审计 `materials.removed`。`quarantine_reason` 无 CHECK（`0022_v9_quarantine_anchors.sql:6`），零迁移。注意：同步会把 `quarantined_at/quarantine_reason` 带给同事（`sync-engine.ts:667-668`），**同事电脑上的副本与解析文本是否随之擦除需另行确认**（本次未核） |
| K4 | 主进程无需改动 | `apps/desktop/electron/file-dialogs.cjs:15-17` | 仍走 `materials.import/mount` 的句柄换路径 |
| 可选迁移 0073 | `document_annotations(document_version_id PK, matter_id, origin, source_artifact_version_id, archived_at, set_by, set_at)` | 新迁移 | 与 `0027 document_roles` 同理由（不改签名行）。**仅当**要求“来源”精确持久（成果转材料的来源成果现在只在审计里存哈希，`api/index.ts:1304`）或要“归档但不擦除”时才做；否则来源按规则推断：`rel_path`→案卷文件夹，`storage_mode='mount'`→引用原文件，`PARTIES_PREFIX`/`briefFilename`→律师填写，“（第 N 轮修改后）”→由成果转入 |

#### 界面（`platform/apps/desktop/src/`）

| 编号 | 改动 | 位置 |
|---|---|---|
| D1 | 新组件 `components/MaterialPicker.tsx`：勾选列表 + 上传按钮 + 拖放 + 逐份进度 + 逐条结果（含“已在本事项，未重复保存”）+ 标题写目标事项名；列表统一滤掉旧版本与已移除，显示用途/来源小标签 | 复用于 Composer @ 弹层、`ScenarioStart.tsx:476-498`、`RunView.tsx:1221-1224` |
| D2 | `components/Composer.tsx`：@ 弹层（`:212-234`）空态改为“上传文件到〔事项名〕”+ 拖放；标题写事项名；`composer-shell`（`:78`）支持拖放；无事项时“+”/“@”不再禁用（`:132,170`），改为弹“这些文件放到哪个事项？”（已有事项列表 / 用这些文件新建事项） | |
| D3 | `pages/Home.tsx`：`importFiles`（`:238-265`）无事项时暂存所选文件 → 打开 `NewMatterDialog`（`components/NewMatter.tsx:33`，加可选 `initialTitle` 由首个文件名预填）→ `onCreated`（`Home.tsx:458-470`）后立即导入；成功提示写“已加入事项「X」”；调 `notifyDataChanged()`；`docs` 过滤旧版本（`:211`，与 `ScenarioStart.tsx:63` 同口径）。注意一次性句柄 10 分钟有效、用一次即作废（`electron/file-dialogs.cjs:13,77`），新建事项要在此时限内完成，超时提示重选 | |
| D4 | `pages/Matter.tsx`：材料行（`:457-507`）加“预览”（`materials.text` + `components/SafePreview.tsx`）、“用于 n 次任务”（K2，点开列任务并可跳 `/run/...`）、来源标签、“移除”（K3，`ConfirmButton` 二次确认，写明“删除本产品保存的副本与解析文字，原文件不动，留审计”）；旧版本默认折叠；事项页输入框导入后自动勾选（`upload` `:151-178` 与首页一致） | |
| D5 | 材料与成果互链：`pages/Deliverables.tsx` 任务段头（`MatterDeliverables` `:318-330`、全局页任务段）加“依据材料 n 份”（悬停列文件名、点击跳事项材料行）；材料行“用于”反向跳到任务与成果。可选：事项页把“材料”“成果”两个标签合并成“案卷”两栏（左材料按来源分组、右成果按任务分组，中间以任务为桥） | |
| D6 | `pages/RunView.tsx`：追问“补充材料”加“上传新文件”（导入到本事项后自动加入本轮补勾，内核 `followup_added_document_version_ids` 已支持，`kernel/api/index.ts:1840-1860`） | |
| D7 | `lib/material-folder.ts`：新增 `visibleMaterials(docs)`（滤旧版本+已移除）与 `materialOrigin(d)`，Home/Composer/ScenarioStart/Matter 共用一份口径 | |
| D8 | `lib/labels.ts`：“已移除（律师移除）”与“已隔离（国家秘密标志）”按 `quarantine_reason` 区分（现 `Matter.tsx:494` 一律写国家秘密标志） | |

#### 测试与验收

- 内核：K1 去重（同 sha 返回原行、`supersedes` 绕过、隔离后可重新导入、跨事项不去重）；K3 移除（权限、示例事项、进行中任务拒绝、块删除、成果待处置文案、`materials.text`/`runs.estimate` 拒绝）；K2 新字段。
- 界面：`visibleMaterials/materialOrigin` 单测；真实界面走查四条：首页无事项拖文件→新建事项→材料在新事项里且已勾选；@ 空态直接上传；同一文件再传一次提示已存在；误放材料移除后 @ 与开始面板都不再出现。

### 5.4 待拍板

1. 首页默认选中第一个进行中的事项（`Home.tsx:169`）是否改为“上次使用的事项”或首次不默认——这是误放的主要来源。
2. 是否需要可选迁移 0073（来源精确持久 / 归档不擦除），还是先按规则推断来源、只做“移除”。
3. 被已签发成果用过的材料能否“移除”：建议允许，但成果标“依据材料已被移除”待处置（与隔离同一机制），不自动撤回签发。
4. 去重命中而文件名不同时：建议只提示“已在本事项（原名 X）”，不改名、不新建。
5. 事项页“材料”“成果”是否合并成“案卷”两栏（D5 可选项）。
