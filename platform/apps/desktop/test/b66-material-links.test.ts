/**
 * 第 66 批（V40）事项—材料—成果关联（界面一侧）：材料列表统一口径（visibleMaterials）、来源推断（materialOrigin）、
 * 导入结果一句话（去重命中只提示原名）、“已移除”与“已隔离”分开写；MaterialPicker 接进事项页与追问“补充材料”。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { importResultText, MATERIAL_ORIGIN_LABELS, materialOrigin, visibleMaterials } from "../src/lib/material-folder.ts";
import { materialStateLabel } from "../src/lib/labels.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

test("visibleMaterials：去掉已移除与已隔离的；当事人信息只留最新；案卷文件夹同位置旧版照旧列出（hideOldVersions 才去掉）", () => {
  const docs = [
    { document_version_id: "p1", filename: "当事人信息（律师填写）.txt" },
    { document_version_id: "p2", filename: "当事人信息（律师填写）.txt", supersedes: "p1" },
    { document_version_id: "f1", filename: "合同.docx", rel_path: "合同.docx" },
    { document_version_id: "f2", filename: "合同.docx", rel_path: "合同.docx", supersedes: "f1" },
    { document_version_id: "r1", filename: "错放.pdf", quarantined_at: "2026-11-26T00:00:00Z", quarantine_reason: "removed_by_lawyer" },
    { document_version_id: "s1", filename: "通知.docx", quarantined_at: "2026-11-26T00:00:00Z", quarantine_reason: "state_secret_marking" },
  ];
  assert.deepEqual(visibleMaterials(docs).map((d) => d.document_version_id), ["p2", "f1", "f2"]);
  assert.deepEqual(visibleMaterials(docs, { hideOldVersions: true }).map((d) => d.document_version_id), ["p2", "f2"]);
});

test("materialOrigin：案卷文件夹 / 引用原文件 / 律师填写 / 由成果转入 / 上传", () => {
  assert.equal(materialOrigin({ filename: "证据一.pdf", rel_path: "证据/证据一.pdf", storage_mode: "import" }), "folder");
  assert.equal(materialOrigin({ filename: "原件.docx", storage_mode: "mount" }), "mount");
  assert.equal(materialOrigin({ filename: "当事人信息（律师填写）.txt", storage_mode: "import" }), "lawyer");
  assert.equal(materialOrigin({ filename: "案情说明（律师口述）2026-11-26.txt", storage_mode: "import" }), "lawyer");
  assert.equal(materialOrigin({ filename: "股权转让协议（第2轮修改后）.docx", storage_mode: "import" }), "artifact");
  assert.equal(materialOrigin({ filename: "借款合同.docx", storage_mode: "import" }), "upload");
  assert.equal(MATERIAL_ORIGIN_LABELS.artifact, "由成果转入");
});

test("导入结果一句话：去重命中只提示“已在本事项（原名 X）”，不新建、不改名", () => {
  assert.equal(importResultText("借款合同（副本）.docx", { duplicate: true, filename: "借款合同.docx" }), "已在本事项（原名《借款合同.docx》），未重复保存");
  assert.equal(importResultText("借款合同.docx", { duplicate: true, filename: "借款合同.docx" }), "已在本事项，未重复保存");
  assert.equal(importResultText("借款合同.docx", { chars: 1234 }), "已添加，1,234 字");
  assert.match(importResultText("纪要.docx", { chars: 10, marking_notice: "文件带有“工作秘密”标志" }), /工作秘密/);
});

test("“已移除（律师移除）”与“已隔离（国家秘密标志）”分开写；原因未知按国家秘密标志口径", () => {
  assert.equal(materialStateLabel({ quarantined_at: null }), null);
  assert.equal(materialStateLabel({ quarantined_at: "x", quarantine_reason: "removed_by_lawyer" }), "已移除（律师移除）");
  assert.equal(materialStateLabel({ quarantined_at: "x", quarantine_reason: "state_secret_marking" }), "已隔离（国家秘密标志）");
  assert.equal(materialStateLabel({ quarantined_at: "x" }), "已隔离（国家秘密标志）");
});

test("api：materials.usage / materials.remove 两个调用；importMaterial 的结果类型带 duplicate 与原名", () => {
  const api = src("api.ts");
  assert.match(api, /materialUsage: \(matterId: string\) => invoke<MaterialUsage>\("materials\.usage", \{ matter_id: matterId \}\)/);
  assert.match(api, /removeMaterial: \(documentVersionId: string\) => invoke<MaterialRemoveResult>\("materials\.remove", \{ document_version_id: documentVersionId \}\)/);
  assert.match(api, /export interface MaterialImportResult \{[\s\S]{0,400}duplicate\?: boolean;[\s\S]{0,40}filename\?: string;/);
});

test("MaterialPicker：勾选列表 + 选择文件 + 拖放 + 逐份结果；导入成功的自动勾上；样式只在自己的文件里", () => {
  const mp = src("components/MaterialPicker.tsx");
  assert.match(mp, /onDrop=\{/);
  assert.match(mp, /pickMaterials\(fileRef\.current/);
  assert.match(mp, /importResultText\(f\.name, r\)/, "结果一句话含去重提示");
  assert.match(mp, /p\.onToggle\(r\.document_version_id, true\)/, "导入后自动勾选");
  assert.match(mp, /p\.documents\.filter\(\(d\) => !d\.quarantined_at\)/, "已移除、已隔离的不列");
  assert.match(mp, /import "\.\.\/styles-materials-picker\.css";/);
});

test("事项页：材料区用 MaterialPicker 添加；行内预览、用于 n 次任务、来源标签、移除二次确认；旧版本与已移除的默认折叠；输入框导入后自动勾选", () => {
  const m = src("pages/Matter.tsx");
  assert.match(m, /<MaterialPicker[\s\S]{0,200}showList=\{false\}/);
  assert.match(m, /api\s*\.materialText\(d\.document_version_id\)/);
  assert.match(m, /<SafePreview filename="预览\.txt" text=\{preview\.text\} \/>/);
  assert.match(m, /用于 \{usage\.get\(d\.document_version_id\)!\.used_by\.length\} 次任务/);
  assert.match(m, /nav\(`\/run\/\$\{r\.run_id\}\/\$\{matterId\}`\)/);
  assert.match(m, /MATERIAL_ORIGIN_LABELS\[materialOrigin\(d\)\]/);
  assert.match(m, /<ConfirmButton[\s\S]{0,120}label="移除"[\s\S]{0,600}原文件不动，留审计记录/);
  assert.match(m, /api\.removeMaterial\(d\.document_version_id\)/);
  assert.match(m, /const \[showOld, setShowOld\] = useState\(false\)/, "旧版本默认折叠");
  assert.match(m, /onImport=\{\(f\) => void upload\(f, "import", true\)\}/, "输入框导入后自动勾选");
  assert.match(m, /documents=\{visibleMaterials\(docs\)\}/);
  assert.match(m, /materialStateLabel\(d\)/);
  assert.doesNotMatch(m, /已隔离（国家秘密标志）<\/span>/, "不再一律写国家秘密标志");
});

test("追问“补充材料”：用 MaterialPicker，可上传新文件（存入本事项后自动勾上）；可补的按统一口径", () => {
  const rv = src("pages/RunView.tsx");
  assert.match(rv, /return visibleMaterials\(docs\)\.filter\(\(d\) => !had\.has\(d\.document_version_id\)\)/);
  assert.match(rv, /<MaterialPicker[\s\S]{0,200}selected=\{followAdd\}[\s\S]{0,600}onImport=\{\(f\) => api\.importMaterial\(matterId, f\)/);
  // 有上一轮勾选（有边界）时才出现；没有可补的旧材料也能上传新的
  assert.match(rv, /\{inputDocs\.length > 0 && \(\s*<div className="followup-mats">/);
});

test("成果复核页：依据材料被律师移除与国家秘密标志隔离分开说明", () => {
  const rv = src("pages/Review.tsx");
  assert.match(rv, /it\.reason === "removed_by_lawyer"\) return "本成果依据的材料已被律师移除/);
});
