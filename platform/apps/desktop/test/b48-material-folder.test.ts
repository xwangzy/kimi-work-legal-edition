/**
 * 第 48 批 案卷文件夹（界面一侧）：同步结果的一句话、文件夹位置的目录部分、按文件名即时筛选、命中词高亮切分；
 * 主进程只把对话框选定的文件夹句柄换成 path（页面自带的 path 一律剥掉）；事项页“材料”标签接上文件夹条与搜索框。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { filterDocsByName, highlightParts, queryTerms, relDir, shouldAutoSearch, supersededIds, syncResultText } from "../src/lib/material-folder.ts";

const require = createRequire(import.meta.url);
const fd = require("../electron/file-dialogs.cjs") as {
  createHandleStore(): { issue(kind: string, p: string): string };
  resolveFileParams(method: string, params: unknown, store: unknown): { params?: Record<string, unknown>; error?: { code: string } };
};
const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

test("同步结果一句话：新增、更新、跳过、找不到、超量依次写；没有变化另说", () => {
  const base = { added: 0, updated: 0, unchanged: 5, skipped_total: 0, missing_on_disk: [] as string[], capped: false, cap: 500 };
  assert.equal(syncResultText({ ...base, added: 3, updated: 1, skipped_total: 2 }), "新增 3 份、更新 1 份；跳过 2 份");
  assert.equal(syncResultText(base), "没有新增或改动的文件");
  assert.equal(syncResultText({ ...base, updated: 1 }), "更新 1 份");
  assert.equal(
    syncResultText({ ...base, added: 1, missing_on_disk: ["a.docx", "b.docx"], capped: true }),
    "新增 1 份；2 份在文件夹里找不到了（事项里的材料还在）；可导入的文件超过 500 份，只处理了前 500 份（请改为关联只放本事项材料的子文件夹）",
  );
});

test("文件夹位置的目录部分；按文件名（含文件夹位置）即时筛选，多个词须同时出现、不分大小写", () => {
  assert.equal(relDir("证据/合同/补充协议.docx"), "证据/合同");
  assert.equal(relDir("起诉状.docx"), null);
  assert.equal(relDir(null), null);
  const docs = [
    { filename: "补充协议.docx", rel_path: "证据/合同/补充协议.docx" },
    { filename: "Contract.PDF", rel_path: null },
    { filename: "起诉状.docx", rel_path: "起诉状.docx" },
  ];
  assert.deepEqual(filterDocsByName(docs, "").length, 3);
  assert.deepEqual(filterDocsByName(docs, "证据 协议").map((d) => d.filename), ["补充协议.docx"]);
  assert.deepEqual(filterDocsByName(docs, "contract pdf").map((d) => d.filename), ["Contract.PDF"]);
  assert.deepEqual(filterDocsByName(docs, "起诉 不存在"), []);
  assert.deepEqual(queryTerms(" 违约金\u3000Penalty  penalty "), ["违约金", "Penalty"]);
  assert.equal(shouldAutoSearch("违"), false);
  assert.equal(shouldAutoSearch(" 违约 "), true);
  assert.equal(shouldAutoSearch("𠮷"), false, "按字符计");
  assert.deepEqual([...supersededIds([{ supersedes: "a" }, { supersedes: null }, {}])], ["a"]);
});

test("命中词高亮切分：不分大小写、长词优先、无命中原样", () => {
  assert.deepEqual(highlightParts("…按日万分之五支付违约金（Penalty）…", ["违约金", "penalty"]), [
    { text: "…按日万分之五支付", hit: false },
    { text: "违约金", hit: true },
    { text: "（", hit: false },
    { text: "Penalty", hit: true },
    { text: "）…", hit: false },
  ]);
  assert.deepEqual(highlightParts("违约金条款", ["违约", "违约金"]), [{ text: "违约金", hit: true }, { text: "条款", hit: false }]);
  assert.deepEqual(highlightParts("没有命中", ["甲"]), [{ text: "没有命中", hit: false }]);
  assert.deepEqual(highlightParts("a.b", ["."]), [{ text: "a", hit: false }, { text: ".", hit: true }, { text: "b", hit: false }], "正则特殊字符按字面");
  assert.deepEqual(highlightParts("", ["甲"]), []);
});

test("关联案卷文件夹：主进程只认文件夹句柄、换成 path；页面自带的 path 一律剥掉；文件句柄冒充被拒", () => {
  const store = fd.createHandleStore();
  const folder = store.issue("folder", "D:\\案卷\\张三诉李四");
  assert.deepEqual(fd.resolveFileParams("materials.link_folder", { matter_id: "m1", folder_handle: folder, path: "C:\\Windows" }, store).params, { matter_id: "m1", path: "D:\\案卷\\张三诉李四" });
  assert.deepEqual(fd.resolveFileParams("materials.link_folder", { matter_id: "m1", path: "/etc" }, store).params, { matter_id: "m1" }, "没有句柄时页面给的路径不转发");
  assert.equal(fd.resolveFileParams("materials.link_folder", { matter_id: "m1", folder_handle: store.issue("open", "/tmp/x.docx") }, store).error?.code, "validation");
  // 同步只带事项编号：页面给的路径同样剥掉
  assert.deepEqual(fd.resolveFileParams("materials.sync_folder", { matter_id: "m1", path: "/etc" }, store).params, { matter_id: "m1" });
});

test("事项页“材料”标签：文件夹条、搜索框、文件夹位置第二行；样式放在独立文件", () => {
  const m = src("pages/Matter.tsx");
  assert.match(m, /<MaterialFolderBar matterId=\{matter\.matter_id\} folder=\{matter\.folder \?\? null\}/);
  assert.match(m, /<MaterialSearch matterId=\{matter\.matter_id\}>/);
  assert.match(m, /filterDocsByName\(docs, q\)/);
  assert.match(m, /<span className="mat-dir">\{relDir\(d\.rel_path\)\}<\/span>/);
  assert.match(m, /import "\.\.\/styles-materials\.css";/);
  const bar = src("components/MaterialFolderBar.tsx");
  assert.ok(bar.includes("文件夹里的文件会复制并加密保存在这台电脑上；只有任务用到的内容才会替换代号后发给 AI。"));
  assert.ok(bar.includes("关联案卷文件夹") && bar.includes("取消关联") && bar.includes("上次同步"));
  const search = src("components/MaterialSearch.tsx");
  assert.ok(search.includes('placeholder="在本事项材料里搜索"'));
  assert.match(search, /<mark key=\{i\}>/);
});
