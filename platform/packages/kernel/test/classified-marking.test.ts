/**
 * 国家秘密标志拦截（v9 第 02 篇 §8.1 L4；审计 S6）：密级标志命中即拒绝导入且不留副本、审计只记类别与 hash；
 * “内部★”“工作秘密”照常导入并提示；日常法律文本里的“商业秘密”“机密信息”“保密期限三年”不误拦。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeZip } from "../../docx-engine/src/zip.ts";
import { detectClassifiedMarking } from "../src/services/classified-marking.ts";
import { makeKernel, type TestKernel } from "./helpers.ts";

const secret = (text: string, filename = "材料.txt", headerFooter?: string[]) =>
  detectClassifiedMarking({ filename, text, ...(headerFooter ? { headerFooter } : {}) }).filter((f) => f.kind === "state_secret");

describe("检测规则", () => {
  test("命中：星形标志的各种写法（全角、空格、竖排、OCR 换星号）与行首期限写法", () => {
    for (const t of [
      "机密★1年\n关于某某事项的通知",
      "绝密★启用前",
      "秘密★6个月",
      "秘密 ★ 长期",
      "机 密 ★ 一 年",
      "机\n密\n★\n１\n年",
      "绝密*启用前",
      "抄送：……\n\n秘密＊",
      "正文……\n秘密 三年\n",
      "绝密 长期",
    ]) {
      assert.equal(secret(t).length, 1, t);
    }
    assert.equal(secret("正文", "机密★关于某项目的请示.pdf")[0]?.where, "filename");
    assert.equal(secret("正文", "x.docx", ["秘密★1年"])[0]?.where, "header_footer");
    // 长文末尾或中间的附件首页
    assert.equal(secret(`${"甲".repeat(40_000)}\n附件：\n机密★2年\n${"乙".repeat(40_000)}`).length, 1);
    // 复核 B3-A07：零宽字符、软连字符、分散对齐的多个空格、全角兼容字形
    for (const t of ["机\u200b密★1年", "机\u00ad密★1年", "机    密★", "\ufeff绝密★启用前", "秘密*1年", "（附件）\n秘密*"]) assert.equal(secret(t).length, 1, JSON.stringify(t));
  });

  test("不误拦：日常法律文本", () => {
    for (const t of [
      "乙方应对甲方的商业秘密承担保密义务，保密期限三年。",
      "本协议所称机密信息，包括但不限于技术秘密和经营秘密。",
      "商业秘密 3年",
      "第十二条 保密条款：双方对本协议内容保密，期限 5 年。",
      "《中华人民共和国保守国家秘密法》第十三条规定了国家秘密的密级。",
      "被告侵犯原告商业秘密一案",
      "★★★ 重点条款 ★★★",
      "秘密协议的效力问题",
      "秘密：无",
      // 复核 B3-A06：Markdown 粗体、脚注星号与全角星号
      "**商业秘密**的认定标准",
      "被告构成侵犯商业秘密*",
      "技术秘密＊的范围见附件",
      "## **秘密**协议的效力",
    ]) {
      assert.deepEqual(secret(t), [], t);
    }
    assert.deepEqual(secret("正文", "机密.txt"), []);
  });

  test("内部标志：提示不拦截", () => {
    const f = detectClassifiedMarking({ filename: "通知.docx", text: "内部★\n关于印发……的通知" });
    assert.deepEqual(f, [{ kind: "internal", level: "内部", where: "text" }]);
    assert.equal(detectClassifiedMarking({ filename: "a.txt", text: "工作秘密\n会议纪要" })[0]?.level, "工作秘密");
    assert.deepEqual(detectClassifiedMarking({ filename: "a.txt", text: "本所内部流程说明" }), []);
  });
});

describe("导入入口", () => {
  let tk: TestKernel;
  before(async () => {
    tk = await makeKernel({}, "classified-firm");
  });
  after(async () => {
    await tk.kernel.close();
  });

  const blobCount = () => {
    let n = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (!e.startsWith(".")) n++;
      }
    };
    walk(tk.kernel.blobs.dir);
    return n;
  };

  test("正文带密级标志：拒绝、不留副本、审计只记类别与 hash", async () => {
    const { inv } = tk;
    const { matter } = await inv("matters.create", { title: "密级拦截", stance: "原告", consent_status: "not_required" });
    const before = blobCount();
    const text = "机密★1年\n关于某工程项目的情况报告\n唯一金丝雀串KWL-CLASSIFIED-7731";
    await assert.rejects(
      () => inv("materials.import", { matter_id: matter.matter_id, filename: "报告.txt", data_base64: Buffer.from(text).toString("base64"), mime: "text/plain" }),
      (e: any) => e.code === "classified_material" && /国家秘密标志/.test(e.message),
    );
    assert.equal(blobCount(), before, "块存储没有新增任何副本");
    const docs = tk.kernel.db.all<any>(`SELECT * FROM document_versions WHERE matter_id = ?`, [matter.matter_id]);
    assert.equal(docs.length, 0);
    const ev = tk.kernel.db.all<any>(`SELECT * FROM audit_events WHERE action = 'materials.classified_refused'`);
    assert.equal(ev.length, 1);
    assert.equal(JSON.stringify(ev).includes("KWL-CLASSIFIED-7731"), false, "审计不记正文");
  });

  test("DOCX 页眉的密级标志同样拦截；内部标志照常导入并提示", async () => {
    const { inv } = tk;
    const { matter } = await inv("matters.create", { title: "页眉密级", stance: "原告", consent_status: "not_required" });
    const doc = (header: string) =>
      writeZip([
        { name: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
        { name: "word/document.xml", data: Buffer.from('<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>合同正文</w:t></w:r></w:p></w:body></w:document>') },
        { name: "word/header1.xml", data: Buffer.from(`<w:hdr xmlns:w="w"><w:p><w:r><w:t>${header}</w:t></w:r></w:p></w:hdr>`) },
      ]);
    const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await assert.rejects(
      () => inv("materials.import", { matter_id: matter.matter_id, filename: "合同.docx", data_base64: doc("秘密★6个月").toString("base64"), mime }),
      (e: any) => e.code === "classified_material",
    );
    const ok = await inv("materials.import", { matter_id: matter.matter_id, filename: "合同.docx", data_base64: doc("内部★").toString("base64"), mime });
    assert.ok(ok.document_version_id);
    assert.match(String(ok.marking_notice), /内部/);
    const plain = await inv("materials.import", { matter_id: matter.matter_id, filename: "协议.txt", data_base64: Buffer.from("乙方对甲方的商业秘密负有保密义务").toString("base64"), mime: "text/plain" });
    assert.equal(plain.marking_notice, null);
  });

  test("重新解析才发现密级标志：隔离——副本块、解析文本与派生的风险卡删除，不能再用于任务与预览（复核 B3-A05）", async () => {
    const { inv } = tk;
    const db = tk.kernel.db;
    const { matter } = await inv("matters.create", { title: "重解析密级", stance: "原告", consent_status: "not_required" });
    const ok = await inv("materials.import", { matter_id: matter.matter_id, filename: "扫描件.txt", data_base64: Buffer.from("第一条 付款。").toString("base64"), mime: "text/plain" });
    const docId = ok.document_version_id as string;
    // 模拟“解析能力提升后（例如 OCR 就绪）才看到标志”：登记行改指一份带标志的副本（同一事项的块存储）
    const marked = Buffer.from("机密★1年\n扫描件识别出的正文 金丝雀KWL-REPARSE-5521");
    const put = tk.kernel.blobs.put(marked, matter.matter_id);
    db.run(`UPDATE document_versions SET sha256 = ?, storage_uri = ? WHERE document_version_id = ?`, [put.sha256, put.storage_uri, docId]);
    db.run(
      `INSERT INTO risk_cards (card_id, tenant_id, matter_id, run_id, document_version_id, seq, clause_ref, anchor_text, anchor_status, severity, category, issue, status)
       VALUES ('rkc_test', ?, ?, NULL, ?, 1, '第一条', '付款', 'located', 'high', 'commercial', '付款期限不明', 'proposed')`,
      [matter.tenant_id ?? db.get<any>(`SELECT tenant_id FROM matters WHERE matter_id = ?`, [matter.matter_id]).tenant_id, matter.matter_id, docId],
    );
    await assert.rejects(
      () => inv("materials.reparse", { document_version_id: docId }),
      (e: any) => e.code === "classified_material" && e.detail?.quarantined === true && /已隔离/.test(e.message),
    );
    const row = db.get<any>(`SELECT * FROM document_versions WHERE document_version_id = ?`, [docId]);
    assert.ok(row.quarantined_at, "登记行标为已隔离");
    assert.equal(db.get<any>(`SELECT COUNT(*) AS n FROM parse_texts WHERE parse_version_id IN (SELECT parse_version_id FROM parse_versions WHERE document_version_id = ?)`, [docId]).n, 0, "解析文本已删除");
    assert.equal(db.get<any>(`SELECT COUNT(*) AS n FROM risk_cards WHERE document_version_id = ?`, [docId]).n, 0, "派生的风险卡已删除");
    assert.throws(() => tk.kernel.blobs.read(put.storage_uri), "副本块已删除");
    await assert.rejects(() => inv("materials.text", { document_version_id: docId }), (e: any) => e.code === "conflict");
    await assert.rejects(() => inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [docId] }), (e: any) => e.code === "conflict");
    await assert.rejects(() => inv("materials.reparse", { document_version_id: docId }), (e: any) => e.code === "conflict" || e.code === "not_found");
    assert.equal(db.all<any>(`SELECT * FROM audit_events WHERE action = 'materials.quarantined' AND object_id = ?`, [docId]).length, 1);
  });

  test("GB18030 编码的纯文本：按 GB18030 解码后照样检测（复核 B3-A07）", async () => {
    const { inv } = tk;
    const { matter } = await inv("matters.create", { title: "编码检测", stance: "原告", consent_status: "not_required" });
    const gbk = Buffer.from("bbfac3dca1ef31c4ea0ab9d8d3dac4b3b9a4b3ccb5c4c7e9bff6b1a8b8e6", "hex"); // “机密★1年\n关于某工程的情况报告”
    await assert.rejects(
      () => inv("materials.import", { matter_id: matter.matter_id, filename: "报告.txt", data_base64: gbk.toString("base64"), mime: "text/plain" }),
      (e: any) => e.code === "classified_material",
    );
    const clean = Buffer.from("b9d8d3dac4b3b9a4b3ccb5c4c7e9bff6b1a8b8e6", "hex"); // “关于某工程的情况报告”
    const ok = await inv("materials.import", { matter_id: matter.matter_id, filename: "报告2.txt", data_base64: clean.toString("base64"), mime: "text/plain" });
    const text = tk.kernel.db.get<any>(`SELECT pt.content FROM parse_versions pv JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id WHERE pv.document_version_id = ?`, [ok.document_version_id]).content;
    assert.equal(text, "关于某工程的情况报告", "按 GB18030 解码");
  });
});
