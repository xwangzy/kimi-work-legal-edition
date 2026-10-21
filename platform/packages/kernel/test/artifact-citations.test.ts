/**
 * 成果文件的引用核验与签发门禁（第 13 批；评审 Z1 P0-5）：Agent 任务成果里的引用按成果文字离线核验——
 * 定性错误与离线案号不得签发；本机法规库未收录的法源须律师勾选“已逐条人工核对”；取不到文字的成果不核验。
 * 再走一遍内核签发链：成果含法规库外的引用 → 未勾选被拒、勾选后签发成功；含错误条号 → 勾选也不行。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { createDocx } from "@zr-legal/docx-engine";
import { artifactCitationBlock, checkArtifactCitations, CITATIONS_CASES_CHECK_KEY, CITATIONS_MANUAL_CHECK_KEY, CITATIONS_UNVERIFIABLE_CHECK_KEY } from "../src/services/artifact-citations.ts";
import { makeKernel, type TestKernel } from "./helpers.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const signerPub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: signerPub });

test("分类：已收录且条号正确为已核；条号超范围为错误；法规库未收录须人工核对；案号离线未核实", () => {
  const text = [
    "依据《民法典》第五百八十五条，违约金可以调整。",
    "《民法典》第一千三百条规定……",
    "《公司法》第一百八十八条规定董事的忠实义务。",
    "参见（2023）最高法民终123号判决。",
  ].join("\n");
  const c = checkArtifactCitations(lawdb, "研究备忘录.md", Buffer.from(text), "2026-10-01");
  assert.equal(c.checked, true);
  assert.equal(c.verified, 1);
  assert.equal(c.wrong, 1, "民法典只有 1260 条");
  assert.equal(c.outside_registry, 1, "公司法不在演示法规库");
  assert.equal(c.unverified_offline, 1);
  assert.equal(artifactCitationBlock(c, {})?.code, "wrong");
  // docx 取可见文字
  const docx = createDocx("备忘录", [{ heading: "结论", paragraphs: ["《公司法》第一百八十八条"] }]);
  const d = checkArtifactCitations(lawdb, "备忘录.docx", docx, "2026-10-01");
  assert.equal(d.outside_registry, 1);
  assert.equal(artifactCitationBlock(d, {})?.code, "outside");
  assert.equal(artifactCitationBlock(d, { [CITATIONS_MANUAL_CHECK_KEY]: true }), null);
  assert.equal(artifactCitationBlock(d, { [CITATIONS_MANUAL_CHECK_KEY]: "yes" })?.code, "outside", "只认布尔 true");
  // 案号：逐个核对并勾选后可签发（复核 B13-U01）
  const k = checkArtifactCitations(lawdb, "上诉状.md", Buffer.from("不服（2024）京0105民初1234号判决。"), "2026-10-01");
  assert.equal(artifactCitationBlock(k, {})?.code, "case");
  assert.equal(artifactCitationBlock(k, { [CITATIONS_CASES_CHECK_KEY]: true }), null);
  // 读不出文字的成果（格式不认识、读取出错）不再静默放行（复核 B13-U02）：须勾选“已人工核对”
  for (const [name, bytes] of [["意见.pdf", Buffer.from("%PDF-1.7")], ["损坏.docx", Buffer.from("PK broken")], ["损坏.xlsx", Buffer.from("PK")]] as const) {
    const x = checkArtifactCitations(lawdb, name, bytes, "2026-10-01");
    assert.equal(x.checked, false, name);
    assert.equal(artifactCitationBlock(x, {})?.code, "unchecked", name);
    assert.equal(artifactCitationBlock(x, { [CITATIONS_UNVERIFIABLE_CHECK_KEY]: true }), null, name);
  }
});

let tk: TestKernel | null = null;
after(async () => {
  await tk?.kernel.close().catch(() => {});
});

test("签发链：成果含法规库外的引用须勾选人工核对；含错误条号勾选也不能签发；复核页列出阻断理由", { timeout: 120_000 }, async () => {
  tk = await makeKernel({}, "artcite-firm");
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "引用门禁", stance: "原告", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  // 直接登记成果（模拟 Agent 任务产出：块存储 + 成果表），只测签发门禁
  const { randomUUID } = await import("node:crypto");
  const ident = (kernel as any).identity as { tenantId: string; userId: string };
  const reg = (filename: string, text: string) => {
    const bytes = createDocx("成果", [{ heading: "正文", paragraphs: [text] }]);
    const { sha256, storage_uri } = kernel.blobs.put(bytes, matter.matter_id);
    const id = `artv_${randomUUID()}`;
    kernel.db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'pending_review', ?)`,
      [id, ident.tenantId, matter.matter_id, null, `test_${filename}`, "internal", 1, filename, sha256, storage_uri, ident.userId],
    );
    return { artifact_version_id: id, sha256 };
  };
  {
    const outside = reg("备忘录.docx", "依据《公司法》第一百八十八条，董事负有忠实义务。");
    const comp = await inv("review.completeness", { artifact_version_id: outside.artifact_version_id });
    assert.equal(comp.completeness.artifact_citations.outside_registry, 1);
    assert.ok(comp.blockers.some((b: string) => b.includes("不在本机法规库")));
    await assert.rejects(
      () => inv("review.approve", { artifact_version_id: outside.artifact_version_id, decision: "approved", expected_sha256: outside.sha256, checklist: {} }),
      (e: any) => e.code === "unverified_citations" && /人工核对/.test(e.message),
    );
    const ok = await inv("review.approve", { artifact_version_id: outside.artifact_version_id, decision: "approved", expected_sha256: outside.sha256, checklist: { [CITATIONS_MANUAL_CHECK_KEY]: true } });
    assert.ok(ok);
    // 复核 A-12：签发记录里签进的是内核自己算的核验计数
    const signed = kernel.db.get<{ signed_payload: string }>(`SELECT signed_payload FROM approvals WHERE artifact_version_id = ? AND decision = 'approved'`, [outside.artifact_version_id])!;
    const cc = JSON.parse(signed.signed_payload).citation_check;
    assert.equal(cc.checked, true);
    assert.ok(cc.outside_registry >= 1, "法规库以外的引用计数签进了签发记录");
    assert.equal(cc.wrong, 0);

    const wrong = reg("起诉状.docx", "根据《民法典》第一千三百条，被告应当赔偿。");
    await assert.rejects(
      () => inv("review.approve", { artifact_version_id: wrong.artifact_version_id, decision: "approved", expected_sha256: wrong.sha256, checklist: { [CITATIONS_MANUAL_CHECK_KEY]: true } }),
      (e: any) => e.code === "unverified_citations" && /核对不通过/.test(e.message),
    );
  }
});

test("DOCX 的脚注与页眉也核验（复核 A-12）；XLSX 成果取单元格文字核验", async () => {
  const { createDocx, readZipEntries, writeZip, createXlsx } = await import("@zr-legal/docx-engine");
  const base = createDocx("成果", [{ heading: "正文", paragraphs: ["正文没有引用。"] }]);
  const files = readZipEntries(base);
  files.set("word/footnotes.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>见《民法典》第一千三百条。</w:t></w:r></w:p></w:footnote></w:footnotes>`));
  const withFootnote = writeZip([...files].map(([name, data]) => ({ name, data })));
  const c = checkArtifactCitations(lawdb, "备忘录.docx", withFootnote, "2026-10-01");
  assert.equal(c.wrong, 1, "脚注里的错误条号被核出");
  const x = checkArtifactCitations(lawdb, "矩阵.xlsx", createXlsx([{ name: "争点", rows: [["争点", "依据"], ["违约金", "《民法典》第五百八十五条"]] }]), "2026-10-01");
  assert.equal(x.checked, true);
  assert.equal(x.verified, 1);
});

test("材料缺口（Astra M-2）：任务有没读到的材料时，签发须勾选“缺口已告知客户”并写进签发记录；复核页给出缺口数与复核人", { timeout: 120_000 }, async () => {
  const { liveTaskIdentity } = await import("./helpers.ts");
  const t2 = await makeKernel({}, "gaps-firm");
  try {
    const { inv, kernel } = t2;
    const { matter } = await inv("matters.create", { title: "材料缺口", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
    const live = liveTaskIdentity(t2, matter.matter_id, "gaps");
    kernel.db.run(`INSERT INTO run_events (run_id, seq, type, payload) VALUES (?, 1, 'materials.loaded', ?)`, [live.rid, JSON.stringify({ loaded: 2, requested: 3, failed: 1, missing: [{ document_version_id: "dv_x", filename: "附件三-资产清单.pdf" }] })]);
    const { randomUUID } = await import("node:crypto");
    const bytes = createDocx("意见", [{ heading: "正文", paragraphs: ["没有引用的审查意见。"] }]);
    const { sha256, storage_uri } = kernel.blobs.put(bytes, matter.matter_id);
    const id = `artv_${randomUUID()}`;
    kernel.db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'pending_review', ?)`,
      [id, kernel.identity.tenantId, matter.matter_id, live.rid, "test_gaps", "internal", 1, "意见.docx", sha256, storage_uri, kernel.identity.userId],
    );
    const comp = await inv("review.completeness", { artifact_version_id: id });
    assert.equal(comp.material_gaps, 1);
    assert.deepEqual(comp.material_gap_files, ["附件三-资产清单.pdf"], "签发页列出没读到的文件（复核 RB16B-07）");
    assert.equal(comp.latest_artifact_version_id, id);
    assert.deepEqual(comp.partial_pages, [], "快照里没有材料：没有页级读不清");
    // 快照里有一份材料、第 2、3 页识别不清：复核页列出（只列、不要求勾选）
    const { importBytes } = await import("./helpers.ts");
    const doc = await importBytes(inv, matter.matter_id, "扫描合同.docx", createDocx("合同", [{ heading: "一", paragraphs: ["正文"] }]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const pv = kernel.db.get<{ parse_version_id: string }>(`SELECT parse_version_id FROM parse_versions WHERE document_version_id = ? ORDER BY created_at DESC LIMIT 1`, [doc.document_version_id])!;
    kernel.db.run(`DELETE FROM parse_pages WHERE parse_version_id = ?`, [pv.parse_version_id]);
    for (const [n, q] of [[1, "ok"], [2, "low"], [3, "unreadable"]] as const) kernel.db.run(`INSERT INTO parse_pages (parse_version_id, page_no, kind, quality) VALUES (?, ?, 'scanned', ?)`, [pv.parse_version_id, n, q]);
    kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ document_version_ids: [doc.document_version_id] }), live.rid]);
    const comp2 = await inv("review.completeness", { artifact_version_id: id });
    assert.deepEqual(comp2.partial_pages, [{ filename: "扫描合同.docx", pages: [2, 3], total: 2, blank: 0 }]);
    // 余项续复核 RC-B-04：几乎没有文字的页（OCR 空文本、文本层不足 20 字）单独计数，不算“读不清”
    kernel.db.run(`INSERT INTO parse_pages (parse_version_id, page_no, kind, quality, note) VALUES (?, 4, 'scanned', 'low', 'OCR 空文本（可能为空白页、印章页或识别失败）')`, [pv.parse_version_id]);
    kernel.db.run(`INSERT INTO parse_pages (parse_version_id, page_no, kind, quality, note) VALUES (?, 5, 'text', 'low', '文本层仅 3 字符')`, [pv.parse_version_id]);
    assert.deepEqual((await inv("review.completeness", { artifact_version_id: id })).partial_pages, [{ filename: "扫描合同.docx", pages: [2, 3], total: 2, blank: 2 }]);
    // RC-B-05：按任务当时读的那一版解析结果；之后重新解析出的新版本不影响
    kernel.db.run(`INSERT INTO parse_versions (parse_version_id, document_version_id, parser, parser_version, text_uri, created_at) VALUES ('pv_newer', ?, 'test', '1', 'x', '2999-01-01T00:00:00.000Z')`, [doc.document_version_id]);
    kernel.db.run(`INSERT INTO parse_pages (parse_version_id, page_no, kind, quality) VALUES ('pv_newer', 1, 'scanned', 'ok')`);
    assert.equal((await inv("review.completeness", { artifact_version_id: id })).partial_pages.length, 0, "老任务没有记录版本：退回最新一版（全部清楚）");
    kernel.db.run(`INSERT INTO run_events (run_id, seq, type, payload) VALUES (?, 2, 'materials.loaded', ?)`, [live.rid, JSON.stringify({ loaded: 1, requested: 1, failed: 0, parse_versions: [{ document_version_id: doc.document_version_id, parse_version_id: pv.parse_version_id }], truncated: ["扫描合同.docx"] })]);
    const comp3 = await inv("review.completeness", { artifact_version_id: id });
    assert.deepEqual(comp3.partial_pages, [{ filename: "扫描合同.docx", pages: [2, 3], total: 2, blank: 2 }], "按任务记下的版本列页");
    assert.deepEqual(comp3.read_truncated, ["扫描合同.docx"]);
    // 已隔离的材料不列
    kernel.db.run(`UPDATE document_versions SET quarantined_at = '2026-10-21T00:00:00Z' WHERE document_version_id = ?`, [doc.document_version_id]);
    assert.deepEqual((await inv("review.completeness", { artifact_version_id: id })).partial_pages, []);
    kernel.db.run(`UPDATE document_versions SET quarantined_at = NULL WHERE document_version_id = ?`, [doc.document_version_id]);
    kernel.db.run(`DELETE FROM run_events WHERE run_id = ? AND seq = 2`, [live.rid]);
    assert.ok("name" in comp.reviewer, "复核人（本机本人）");
    assert.equal(comp.approved_by, null);
    await assert.rejects(
      () => inv("review.approve", { artifact_version_id: id, decision: "approved", expected_sha256: sha256, checklist: {} }),
      (e: any) => e.code === "material_gaps_undisclosed" && /1 份材料没有读到/.test(e.message),
    );
    await assert.rejects(() => inv("review.approve", { artifact_version_id: id, decision: "approved", expected_sha256: sha256, checklist: { gaps_disclosed: "yes" } }), (e: any) => e.code === "material_gaps_undisclosed", "只认布尔 true");
    await inv("review.approve", { artifact_version_id: id, decision: "approved", expected_sha256: sha256, checklist: { gaps_disclosed: true, material_gaps: 1 } });
    const rec = kernel.db.get<{ checklist: string }>(`SELECT checklist FROM approvals WHERE artifact_version_id = ? AND decision = 'approved'`, [id])!;
    assert.equal(JSON.parse(rec.checklist).gaps_disclosed, true, "缺口确认写进签发记录");
    const after = await inv("review.completeness", { artifact_version_id: id });
    assert.ok(after.approved_by && typeof after.approved_by.at === "string", "签发后显示签发人与时刻");
    assert.notEqual(after.approved_by.name, kernel.identity.userId, "姓名不认识时为 null，不回落成成员编号（复核 RB16B-06）");
  } finally {
    await t2.kernel.close();
  }
});
