/**
 * 应用内预览（UIUX P0-3）：DOCX 修订显示为插入/删除、批注列在文末；XLSX 渲染为表格；输出文字一律转义、不带外部资源。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "@zr-legal/domain";
import { applyRevisionsToDocx, createDocx, createXlsx, readZipEntries, renderDocxHtml, renderXlsxHtml, writeRawZip } from "../src/index.ts";

test("DOCX：标题、段落、修订（插入/删除）与批注", () => {
  const base = createDocx("买卖合同", [{ heading: "第一条", paragraphs: ["货款于交货后九十日内支付。", "<script>alert(1)</script> & 其他"] }]);
  const original = "九十日";
  const { docx } = applyRevisionsToDocx(base, {
    baselineHash: sha256Hex(base),
    ops: [{ opId: "1", anchor: { originalText: original }, originalHash: sha256Hex(original), newText: "三十日", comment: "账期过长", author: "律师审定" }],
  });
  const r = renderDocxHtml(docx);
  assert.match(r.html, /<del title="律师审定">九十日<\/del>/);
  assert.match(r.html, /<ins title="律师审定">三十日<\/ins>/);
  assert.match(r.html, /<li value="1"><strong>律师审定<\/strong>：账期过长<\/li>/);
  assert.match(r.html, /<sup class="kwl-cmt">\[1\]<\/sup>/);
  assert.equal(r.html.includes("<script>"), false);
  assert.match(r.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; 其他/);
  assert.ok(r.revisions >= 2);
  assert.equal(r.comments, 1);
});

test("XLSX：表头与数据行、转义、行数上限说明", () => {
  const rows: (string | number | null)[][] = [["条款", "问题", "金额"], ["7.1", "违约金<过低>", 100], ...Array.from({ length: 600 }, (_, i) => [`r${i}`, "x", i])];
  const r = renderXlsxHtml(createXlsx([{ name: "问题清单", rows }]));
  assert.match(r.html, /<h3>问题清单<\/h3>/);
  assert.match(r.html, /<th>条款<\/th><th>问题<\/th><th>金额<\/th>/);
  assert.match(r.html, /<td>违约金&lt;过低&gt;<\/td><td>100<\/td>/);
  assert.equal(r.truncated, true);
});

test("XLSX 预览只解压表格本身（复核 B13-O01 余项）：图片条目声明 10 字节、实际解压出 1 MB（全部解压会按压缩炸弹拒收）——预览照常", () => {
  const base = createXlsx([{ name: "附图", rows: [["说明"], ["见图一"]] }]);
  const entries = [...readZipEntries(base)].map(([name, data]) => ({ name, data }));
  const big = Buffer.alloc(1024 * 1024, 7);
  const zip = writeRawZip([...entries, { name: "xl/media/image1.png", data: big }]);
  // 把图片条目在中央目录里声明的解压后大小改成 10（偏移 24）
  const nameBuf = Buffer.from("xl/media/image1.png");
  let cd = zip.indexOf(Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02])]));
  while (cd >= 0 && !zip.subarray(cd + 46, cd + 46 + nameBuf.length).equals(nameBuf)) cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cd + 4);
  assert.ok(cd >= 0, "找到图片条目的中央目录记录");
  zip.writeUInt32LE(10, cd + 24);
  assert.throws(() => readZipEntries(zip), /压缩炸弹/, "对照：全部解压会拒收");
  const r = renderXlsxHtml(zip);
  assert.match(r.html, /见图一/);
});
