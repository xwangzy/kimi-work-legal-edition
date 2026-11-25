# 实施记录 B：事项—材料—成果关联（第 66 批 V40，方案 B）

- 依据：`audit-B-事项材料成果.md` 第 5.3 节；主会话拍板：方案 B，事项为唯一归属单元，**不做迁移 0073**，来源按规则推断；被已签发成果用过的材料允许移除（成果标“依据材料已被移除”待处置，不撤回签发）；去重命中而文件名不同只提示“已在本事项（原名 X）”。
- 范围：K1～K3（内核）、D1/D4/D6/D7/D8（桌面端）。未提交、未 stash、未切分支。

## 1. 改动文件

| 文件 | 改动 |
|---|---|
| `platform/packages/kernel/src/api/index.ts` | K1 `materials.import` 去重；K2 新方法 `materials.usage`；K3 新方法 `materials.remove`；`quarantineDocument` 加 `opts`（onlyThis / keepAgentData / keepRules / auditAction）并返回受影响数；新函数 `quarantineText(reason)`，`runs.estimate`、`materials.text` 的拒绝文案与成果待处置说明按原因参数化；`matters.get` 的 documents 多带 `quarantine_reason`；案卷文件夹同步内部调用 `materials.import` 时传 `dedupe:false` |
| `platform/packages/kernel/src/services/pending-checks.ts` | 未决项一句话：`quarantined_source` 且 `reason = removed_by_lawyer` 时写“依据材料已被移除”（原“来源材料已隔离”照旧） |
| `platform/packages/domain/src/errors.ts` | `FaultCode` 加 `materialInUse: "material_in_use"`（只追加） |
| `platform/packages/kernel/test/b66-material-links.test.ts` | 新增，8 条 |
| `platform/packages/kernel/test/b41-revise-amend.test.ts`、`v94-b25.test.ts` | 受 K1 影响的既有用例（见第 4 节） |
| `platform/apps/desktop/src/api.ts` | 只追加：`api.materialUsage`、`api.removeMaterial`；类型 `MaterialImportResult`、`MaterialUsage`、`MaterialUsageRun`、`MaterialRemoveResult` |
| `platform/apps/desktop/src/lib/material-folder.ts` | D7：`visibleMaterials`、`materialOrigin`、`MATERIAL_ORIGIN_LABELS`、`importResultText`、类型 `MaterialLike`/`MaterialOrigin`/`ImportResultLike` |
| `platform/apps/desktop/src/lib/labels.ts` | D8：`materialStateLabel(d)` |
| `platform/apps/desktop/src/components/MaterialPicker.tsx` | 新增（D1） |
| `platform/apps/desktop/src/styles-materials-picker.css` | 新增（只用设计令牌；含事项页材料行的几条 `.mat-*` 样式） |
| `platform/apps/desktop/src/pages/Matter.tsx` | D4：添加区换成 MaterialPicker（含“只引用、不复制”）；行内“预览 / 用于 n 次任务 / 移除”、来源标签、旧版本与已移除折叠、输入框导入后自动勾选、输入框材料按统一口径、“读取”列按原因写 |
| `platform/apps/desktop/src/pages/RunView.tsx` | D6：追问“补充材料”换成 MaterialPicker，可上传新文件（存入本事项后自动补勾）；可补材料按统一口径（原先已隔离的也会列出） |
| `platform/apps/desktop/src/pages/Review.tsx` | 未决项说明：律师移除的与国家秘密标志隔离分开写（两行） |
| `platform/apps/desktop/test/b66-material-links.test.ts` | 新增，9 条 |

未动：Composer、Home、ScenarioStart、OutlineConfirm、Deliverables、Sidebar、Connections、FirmUsage、styles-start.css、styles-outline.css、`platform/services/`、`kernel/src/services/matter-folder.ts`、主进程与 preload（无方法白名单需要补：`file-dialogs.cjs` 只登记带路径的 `materials.import/mount`；内核没有另行的方法注册表，待激活模式按 `ONBOARDING_METHODS` 默认拒绝，新方法自动在内）。

## 2. 接口说明（给主会话接 Composer“@ 材料”与首页）

### 2.1 内核

**`materials.import`（K1 去重）**
- 同事项、同 sha256、`storage_mode='import'`、未隔离/未移除、未被新版本取代的那份存在时：不新建登记、不改名，返回
  `{ document_version_id: 已有那份, duplicate: true, filename: 原名, parse_version_id, quality_flags, chars, marking_notice: null, sha256, note }`，审计 `materials.import_duplicate`。
- 不去重的情形：带 `supersedes`（D-224 新版本）；`materials.mount`；跨事项（块按事项密钥加密）；已隔离/已移除的同内容（可重新导入）；只有挂载行同内容时（副本与引用语义不同）；`dedupe:false`（仅供文件夹同步内部用，它自己按内容比对并要给新登记写位置）。

**`materials.usage({ matter_id })`（K2，只读，`requireMatterAccess`）**
```
{
  documents: [{ document_version_id, used_by: [{ run_id, title, goal, scenario, status, created_at, artifact_count }], readable_by_unrestricted }],
  runs: [{ run_id, scenario, status, created_at, title, goal, followup_of, scope: "selected"|"all", document_version_ids, artifact_count }],
  unrestricted_runs
}
```
- `used_by` 只算勾选过它的任务（追问的快照含上一轮 + 补勾）；没勾材料的任务（D-183 可读全部）不进 `used_by`，总数 `unrestricted_runs`，每份材料另给 `readable_by_unrestricted`（它导入之后发起的不限材料任务数）。
- `artifact_count` 不含已被替代（superseded）的成果。`title/goal` 是代号形态，界面照常还原。最多看最近 500 个任务。

**`materials.remove({ document_version_id })`（K3）**
- 守卫：`requireMatterAccess` + `requireMatterWriter`（viewer 403、已结案只读）；示例事项 `validation`（“示例事项只用来看效果，不能移除材料”）；进行中的任务（非终态）勾了它、或没限定材料且在它导入之后发起 → `material_in_use`（409，`detail.run_ids`，说明带任务名：“有 n 个进行中的任务正在用这份材料（“…”）：请等任务结束或先取消任务，再移除”）。已移除/已隔离的再调一次返回 `{ already: true }`（幂等）。
- 动作：`quarantineDocument(doc, "removed_by_lawyer", { onlyThis, keepAgentData, keepRules, auditAction: "materials.removed" })`——删这一条登记的解析文字、页面、锚点、风险卡、审阅表格子、事实（含论点提纲里抄过去的文字、别的卡上的跨文件引文）；导入副本块在没有其他有效登记引用时删除；挂载只解除引用，原文件不动；登记行留着（`quarantined_at`、`quarantine_reason='removed_by_lawyer'`）。
- 成果：勾过它的任务的全部成果 `open_items` 追加 `{ kind: "quarantined_source", reason: "removed_by_lawyer", note: "本成果依据的材料已被律师移除：请核对本成果是否仍可使用，确认前不得交付" }`，**状态不变**（已签发不撤回）。
- 返回 `{ document_version_id, removed: true, reason, storage_mode, affected_artifacts, note }`。
- 与国家秘密标志隔离的差别（有意）：只移除这一条（不连带同内容的其他登记）；不清本事项的 Agent 会话（会让此前所有任务都不能再追问）；不动据此起草的审查要点（律师审定过）。国家秘密标志路径完全照旧（文案逐字不变，有回归用例）。

**按原因参数化的文案**（`quarantineText`）：`removed_by_lawyer` → 估价“所选材料中有已移除的材料，不能用于任务：请刷新后重新勾选”、预览“该材料已被移除，不能预览”；其余/未知按国家秘密标志原文。两处 409 的 `detail.reason` 带原因。

### 2.2 桌面端

```ts
import { visibleMaterials, materialOrigin, MATERIAL_ORIGIN_LABELS, importResultText } from "../lib/material-folder.ts";
import { materialStateLabel } from "../lib/labels.ts";
import { MaterialPicker, type ImportOutcome } from "../components/MaterialPicker.tsx";
import { api, type MaterialImportResult } from "../api.ts";
```
- `visibleMaterials(docs, { hideOldVersions? })`：去掉已移除/已隔离；当事人信息只留最新；案卷文件夹同位置旧版照旧列出（与开始面板原规则一致）；`hideOldVersions: true` 时凡被取代的都不列。**首页 `Home.docs`（`Home.tsx:211`）与 Composer @ 弹层请改用它**（ScenarioStart:63 的口径与它等价，可替换）。
- `materialOrigin(d)` → `"folder" | "mount" | "lawyer" | "artifact" | "upload"`，`MATERIAL_ORIGIN_LABELS` 为“案卷文件夹 / 引用原文件 / 律师填写 / 由成果转入 / 上传”。
- `importResultText(name, r)`：“已添加，1,234 字” / “已在本事项（原名《X》），未重复保存” / “已在本事项，未重复保存”。首页导入提示可直接用（`api.importMaterial` 的返回按 `MaterialImportResult` 读：`r.duplicate`、`r.filename`）。
- `materialStateLabel(d)`：“已移除（律师移除）” / “已隔离（国家秘密标志）” / null（需要 `matters.get` 新带的 `quarantine_reason`）。
- `MaterialPicker` props：`matterTitle`（必填，写进添加区与空态）、`documents`、`selected?`/`onToggle?(id, on)`（不传只列不勾）、`onImport?(file) => Promise<MaterialImportResult>`（**逐份调用**，组件负责进度“正在添加第 i/n 份：文件名”与逐条结果；抛错即该份失败，错误经 `importFailText` 显示）、`onMount?`（多一个“只引用、不复制”）、`onImported?(outcomes)`（一批结束，刷新列表用）、`autoSelect?`（缺省 true：有 onToggle 时导入成功的、含去重命中的那份自动勾上）、`compact?`、`showList?`（缺省 true）、`disabled?`、`hint?`（清单下方一句话）、`rowExtra?(d)`（行右侧附加，例如用途标签）。组件内部再滤一次已移除/隔离的。
- Composer @ 弹层建议接法：
```tsx
<MaterialPicker compact matterTitle={matter.title} documents={visibleMaterials(docs)}
  selected={value.documentIds}
  onToggle={(id, on) => onChange({ ...value, documentIds: on ? [...value.documentIds, id] : value.documentIds.filter((x) => x !== id) })}
  onImport={(f) => api.importMaterial(matterId, f) as Promise<MaterialImportResult>}
  onImported={() => { reloadDocs(); notifyDataChanged(); }} />
```
  注意 `onToggle` 在一批导入里可能连续调用多次，父组件请用函数式更新（`setValue((v) => …)`），否则后一次会覆盖前一次。
- `api.materialUsage(matterId)`、`api.removeMaterial(documentVersionId)`（错误 `code === "material_in_use"` 时 `detail.run_ids`）。

## 3. 同步引擎对已移除/已隔离行的处理（只核查，未改）

结论：**同事电脑上的副本与解析文字不会随之擦除**，且多数情况下连“已移除”标记都不会传过去。
1. 导出按 `created_at > 水位` 收行（`sync-engine.ts:187`，`collectRows` 的 `w = since ?? "0000"`）：材料登记行的 `created_at` 不随隔离/移除改变，已同步过的材料再被移除，增量段里不会再带这一行；只有全量导出（since 为空）才会带上。
2. 即便行到了对端，`applyRow` 对 `document_versions` 只做行级 UPDATE（`sync-engine.ts:640-672`）：会写入 `quarantined_at/quarantine_reason`，但**不调用隔离流程**——对端的 `parse_texts`、风险卡、事实、导入副本块都还在（`parse_texts` 是只插入不删的表，`sync-engine.ts:610`）。对端读取材料的入口（`materials.text`、`runs.estimate`、工具）看 `quarantined_at`，所以标记到了就读不到，但数据仍在盘上（按事项密钥加密）。
3. 行级归属：移除人的电脑不是这份材料的导入设备时，导入设备收到的行记 `origin_conflict`、保留本机行（`sync-engine.ts:656-661`），移除不回传给导入人。本机已隔离的不会被对端改回（`keepLocalQuarantine`，`:667`）。
4. 这一点对国家秘密标志隔离同样成立（既有问题，不是本批引入）。要做到“团队范围擦除”，需要同步引擎在收到 `quarantined_at` 由空变有时在本机跑一遍 `quarantineDocument`，并让隔离更新进入增量段（例如另立隔离事件或按 `quarantined_at > 水位` 收行），留作后续。

## 4. 用例结果（原文摘要）

- 新增内核用例 `node --test test/b66-material-links.test.ts`：`# pass 8  # fail 0`。
- K1 受影响面：静态扫描 267 个内核用例文件中“同事项多次导入同一内容”的调用，候选 37 个文件一起跑：`# tests 240 # pass 238 # fail 2`。两条失败都是用例本身把同一内容导入两次当成两份合同：
  - `b41-revise-amend.test.ts`“补交：没有上一次清单时报错；另一个任务、另一份文件的清单不串…”：第二份合同 `purchaseContract()` 与第一份字节相同 → 去重后两份是同一份，“另一份文件没有清单”的断言不成立。改为 `purchaseContract("附：第二份合同。")`（`purchaseContract` 加可选末段参数），原意（另一份文件的清单不串）不变。
  - `v94-b25.test.ts`“审查工作台导出的意见表按所审合同分开…”：两份合同正文相同 → 去重成一份。正文首行加各自文件名，锚点文字不变，原意不变。
  - 修后两文件重跑：`# pass 14 # fail 0`。
- 收尾重跑（含最后的 `matters.get` 字段与 FaultCode 改动）：b66、matters、classified-marking、pending-checks、b48-matter-folder、b39-artifact-to-material、sample-matter 共 7 个文件 `# pass 40 # fail 0`。
- 桌面端新增 `test/b66-material-links.test.ts`：`# pass 9 # fail 0`；桌面端全部 `node --test test/*.test.ts`：`# tests 564 # pass 564 # fail 0`（含样式门禁 style-tokens）。
- 类型检查：`npx tsc -p apps/desktop/tsconfig.json --noEmit` 无输出（通过）；`npx tsc -p tsconfig.check.json --noEmit`（内核与各包）只剩 1 条、与本批无关：`packages/kernel/src/index.ts(804,5): 'modelCatalog' does not exist in type 'ApiDeps'`——是并行会话正在改的 `kernel/src/index.ts`（模型目录），它还没在 `api/index.ts` 的 `ApiDeps` 里加字段；本批自己的 `material_in_use` 类型错误已通过 FaultCode 追加修好。
- 未跑：内核全量用例（按要求）；真实界面走查（四条：首页无事项拖文件→新建事项；@ 空态直接上传；同一文件再传提示已存在；误放材料移除后 @ 与开始面板不再出现——前两条依赖主会话的 Composer/Home 改动）。

## 5. 未做 / 风险

1. **案卷文件夹同步对“已移除”的提示写错**：`kernel/src/services/matter-folder.ts:299` 对同内容已隔离的文件一律说“此前因带国家秘密标志已被隔离，不再导入”。行为对（律师移除过的文件夹文件不会在下次同步时又进来），说明不对；该文件不在本批改动范围，建议主会话或下一批把查询带上 `quarantine_reason`，移除的写“此前已从本事项移除，不再导入（要用请改名或改动后再放进文件夹）”。
2. 其他仍写死“国家秘密标志”的拒绝文案：`kernel/src/services/review-tables.ts:167`（表格审阅勾了已移除材料）与 Agent 工具里读取已隔离材料的报错（未逐一核）。正常界面已按 `visibleMaterials` 不列已移除的，触发面小。
3. 律师移除**不清本事项的 Agent 会话**：此前任务会话里若有该材料的摘录，仍在本机工作区（按事项密钥加密），随结案删除一并擦除。理由是清会话会让本事项所有任务都不能再追问。若要求“移除即清摘录”，需改为只清引用过该材料的会话（kap-host 侧能力），本批未做。
4. `materials.remove` 对“没限定材料的进行中任务”也拒绝（它可能正在读）；若这类任务长时间停在“等你回答/等你批准”，律师需先处理或取消任务。
5. 去重以内核复算的 sha256 为准：内容相同、文件名不同的两份律师确实想分开（例如同一模板两个用途）时只能保留一份——这是拍板口径。挂载行与导入副本互不去重。
6. 事项页 `MaterialSearch` 的结果里已移除的行进入折叠组（“旧版本与已移除的材料（n）”），不再出现在主列表；“材料（n）”标签计数改为不含已移除/已隔离。
7. 同步引擎：见第 3 节，同事电脑上的副本不擦除（既有问题）。
8. 并行改动风险：`kernel/src/api/index.ts` 有其他会话在改同一内核（`modelCatalog`）；本批对该文件的改动都在材料段与 `quarantineDocument`，未碰 `ApiDeps`。
