/**
 * 内核解析/OCR 集成（方案 §8.1/§4.5，mock OCR 引擎）：
 * PDF 解禁（文本层+页码映射 \f → 锚点 file_page）、扫描页隔离进程解析、页质量落库与 S2 报告接入、
 * materials.reparse 生成新解析版本、原件 hash 不变、图片内容零外发、互斥锁串行证据。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { testingPdf } from "@zr-legal/parse-ocr";
import { AsyncMutex } from "../src/mutex.ts";
import { makeKernel, runScenario, importText, type TestKernel } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({ ZR_PARSE_OCR_MOCK: "1" }, "ocr-firm");
});

after(async () => {
  await tk.kernel.close();
});

function grayImage(w: number, h: number): { width: number; height: number; rgb: Buffer } {
  return { width: w, height: h, rgb: Buffer.alloc(w * h * 3, 240) };
}

test("PDF 解禁：文本层抽取 + 页码映射（锚点 file_page）", async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "PDF 解析测试", stance: "受让方", consent_status: "not_required" });
  const pdf = testingPdf.makeTextPdf(["Signed on 2024-03-15 by both parties", "Second page date 2024-04-02 noted"]);
  const doc = await inv("materials.import", { matter_id: matter.matter_id, filename: "协议.pdf", data_base64: pdf.toString("base64"), mime: "application/pdf" });
  assert.ok(doc.document_version_id, JSON.stringify(doc));
  assert.ok(doc.quality_flags.includes("pdf_pipeline"));

  // 页落库
  const pages = kernel.db.all(`SELECT * FROM parse_pages WHERE parse_version_id = ?`, [doc.parse_version_id]);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((p: any) => p.kind), ["text", "text"]);

  // S2 → 锚点带 file_page
  const d = await runScenario(inv, matter.matter_id, "s2.case_file", { document_version_ids: [doc.document_version_id] }, 90_000);
  assert.equal(d.run.status, "succeeded");
  const anchors = kernel.db.all(
    `SELECT ea.* FROM evidence_anchors ea JOIN parse_versions pv ON pv.parse_version_id = ea.parse_version_id
     WHERE pv.document_version_id = ? ORDER BY ea.file_page`,
    [doc.document_version_id],
  );
  assert.ok(anchors.length >= 2, `anchors=${anchors.length}`);
  assert.deepEqual([...new Set(anchors.map((a: any) => a.file_page))].sort(), [1, 2], "两页各一个日期锚点（file_page 1/2）");
});

test("扫描页：隔离进程解析 + 页质量落库 + S2 报告 + 零图片外发 + reparse + 原件不变", { timeout: 180_000 }, async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "扫描件测试", stance: "原告", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const scannedPdf = testingPdf.makeImagePdf([grayImage(400, 300), grayImage(400, 300)]);
  const doc = await inv("materials.import", { matter_id: matter.matter_id, filename: "扫描件.pdf", data_base64: scannedPdf.toString("base64"), mime: "application/pdf" });
  assert.ok(doc.quality_flags.some((f: string) => f.startsWith("scanned_pages:")), JSON.stringify(doc.quality_flags));

  // 页质量：mock 引擎 → scanned/ok
  const pages = kernel.db.all(`SELECT * FROM parse_pages WHERE parse_version_id = ? ORDER BY page_no`, [doc.parse_version_id]);
  assert.equal(pages.length, 2);
  for (const p of pages as any[]) {
    assert.equal(p.kind, "scanned");
    assert.equal(p.quality, "ok");
  }
  // 扫描文本并入解析版本（\f 分隔）
  const pt = kernel.db.get<{ content: string }>(`SELECT content FROM parse_texts WHERE parse_version_id = ?`, [doc.parse_version_id])!;
  assert.ok(pt.content.includes("\f"), "多页以 \\f 分隔");
  assert.match(pt.content, /模拟OCR文本/);

  const txt = await importText(inv, matter.matter_id, "付款凭证.txt", "付款凭证\n2024-04-02 甲公司向乙公司支付预付款 150000 元。");
  const d = await runScenario(inv, matter.matter_id, "s2.case_file", { document_version_ids: [doc.document_version_id, txt.document_version_id] }, 120_000);
  assert.equal(d.run.status, "succeeded");
  const kinds = d.artifacts.map((a: any) => a.kind);
  assert.ok(kinds.includes("s2_quality_report"), "质量报告产出");

  // 数据去向硬断言：S2 为确定性流程（无模型步骤）——egress 记录总数应为 0；含扫描件的事项
  // 全程本机，任何非 mock 目的地记录数必须为 0（图片/原件内容零外发）。
  // 注：若未来 S2 引入模型步骤，本断言应改写为「记录中无图片/原件内容外发」并同步注释。
  const egress = await inv("egress.records", { run_id: d.run.run_id });
  assert.equal(egress.records.length, 0, `S2 确定性流程不应产生 egress 记录：${JSON.stringify(egress.records)}`);
  assert.equal(egress.records.filter((r: any) => r.destination_kind !== "mock_local").length, 0, "图片/原件内容零外发");

  // 原件语义（只读约束 + §5.1 加密落盘）：raw 落盘为 KWB1 密文；解密后明文 hash 与登记一致（内容未被修改）
  const dv = kernel.db.get<any>(`SELECT storage_uri, sha256 FROM document_versions WHERE document_version_id = ?`, [doc.document_version_id]);
  const { isSealedBlob } = await import("../src/blobs.ts");
  assert.equal(isSealedBlob(readFileSync(kernel.blobs.pathOf(dv.storage_uri))), true, "落盘应为密文块");
  const plain = kernel.blobs.read(dv.storage_uri);
  assert.equal(createHash("sha256").update(plain).digest("hex"), dv.sha256, "解密后明文与登记 hash 一致（原件内容未被修改）");

  // reparse：生成新解析版本（旧版本保留），原件 hash 一致
  const rp = await inv("materials.reparse", { document_version_id: doc.document_version_id });
  assert.ok(rp.parse_version_id && rp.parse_version_id !== doc.parse_version_id);
  const psvCount = kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM parse_versions WHERE document_version_id = ?`, [doc.document_version_id])!;
  assert.equal(psvCount.n, 2, "旧解析版本保留 + 新解析版本");
  const pages2 = kernel.db.all(`SELECT * FROM parse_pages WHERE parse_version_id = ?`, [rp.parse_version_id]);
  assert.equal(pages2.length, 2);
});

test("互斥锁（§4.5）：并发 acquire 串行证据", async () => {
  const m = new AsyncMutex();
  const order: string[] = [];
  const a = (async () => {
    const rel = await m.acquire();
    order.push("a1");
    await new Promise((r) => setTimeout(r, 60));
    order.push("a2");
    rel();
  })();
  const b = (async () => {
    const rel = await m.acquire();
    order.push("b1");
    rel();
  })();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a1", "a2", "b1"], "第二把锁须等第一把释放");
});
