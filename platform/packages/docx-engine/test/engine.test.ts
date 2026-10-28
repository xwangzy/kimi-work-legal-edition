import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "@zr-legal/domain";
import {
  applyRevisionsToDocx,
  compareDocx,
  createDocx,
  extractParagraphs,
  mapParagraphs,
  readZipText,
  sanitizeDocx,
  type RevisionOp,
} from "../src/index.ts";

function contractDocx(): Buffer {
  return createDocx("股权转让协议", [
    {
      heading: "第七条 保密",
      paragraphs: [
        "7.1 乙方应当遵守《律师法》第三十八条规定的保密义务，不得泄露在履行本协议过程中知悉的甲方商业秘密。",
        "7.2 双方其他权利义务适用《民法典》第五百零九条。",
      ],
    },
    { heading: "第八条 违约责任", paragraphs: ["8.1 任何一方违约，应赔偿对方由此遭受的全部损失。"] },
  ]);
}

interface OpSpec {
  opId?: string;
  originalText: string;
  newText?: string;
  comment?: string;
  ruleId?: string;
  riskLevel?: "high" | "mid" | "low";
  author?: string;
  occurrence?: number;
  paragraphHint?: string;
}

function op(spec: OpSpec): RevisionOp {
  return {
    opId: spec.opId ?? "op-1",
    anchor: { originalText: spec.originalText, occurrence: spec.occurrence, paragraphHint: spec.paragraphHint },
    originalHash: sha256Hex(spec.originalText),
    newText: spec.newText ?? "",
    comment: spec.comment,
    ruleId: spec.ruleId,
    riskLevel: spec.riskLevel,
    author: spec.author ?? "Kimi Work 法律发行版（AI 建议）",
  };
}

test("engine: 修订写入生成原生 w:del/w:ins 与批注", () => {
  const base = contractDocx();
  const r = applyRevisionsToDocx(base, {
    baselineHash: sha256Hex(base),
    ops: [
      op({
        originalText: "《律师法》第三十八条",
        newText: "《中华人民共和国律师法》第四十一条",
        comment: "原引用条号系 2018-01-01 施行版本；2026-09-01 起施行的修正本中保密义务为第四十一条（规则 CITE-RENUMBER-001）",
        ruleId: "CITE-RENUMBER-001",
        riskLevel: "high",
      }),
    ],
  });
  assert.equal(r.applied.length, 1);
  const xml = readZipText(r.docx, "word/document.xml")!;
  assert.match(xml, /<w:del\b[^>]*w:author="Kimi Work 法律发行版（AI 建议）"/);
  // 第 28 批：只标改动的字（相同的开头“《”、结尾“条”照原样保留）
  assert.match(xml, /<w:delText[^>]*>律师法》第三十八<\/w:delText>/);
  assert.match(xml, /<w:ins\b[^>]*>[\s\S]*?中华人民共和国律师法》第四十一/);
  assert.match(xml, /<w:commentReference/);
  const comments = readZipText(r.docx, "word/comments.xml")!;
  assert.match(comments, /第四十一条/);
  // 其余文本不受影响
  const paras = extractParagraphs(r.docx);
  assert.ok(paras.some((p) => p.text.includes("《民法典》第五百零九条")));
});

test("engine: 基线 hash 不符拒绝写入（stale_baseline）", () => {
  const base = contractDocx();
  assert.throws(
    () => applyRevisionsToDocx(base, { baselineHash: "0".repeat(64), ops: [op({ originalText: "《律师法》第三十八条", newText: "x" })] }),
    (e: any) => e.code === "stale_baseline",
  );
});

test("engine: 原文 hash 不符与锚点缺失均停止（不覆盖原件）", () => {
  const base = contractDocx();
  assert.throws(
    () =>
      applyRevisionsToDocx(base, {
        baselineHash: sha256Hex(base),
        ops: [op({ originalText: "《律师法》第三十八条", newText: "x", opId: "bad-hash" })].map((o) => ({ ...o, originalHash: "f".repeat(64) })),
      }),
    (e: any) => e.code === "anchor_mismatch",
  );
  assert.throws(
    () =>
      applyRevisionsToDocx(base, { baselineHash: sha256Hex(base), ops: [op({ originalText: "不存在的文本", newText: "x" })] }),
    (e: any) => e.code === "anchor_mismatch",
  );
});

test("engine: 比对检出静默改动；有修订覆盖的改动不算静默", () => {
  const base = contractDocx();
  // 对方直接改文（未开修订）→ 全部静默
  const edited = createDocx("股权转让协议", [
    {
      heading: "第七条 保密",
      paragraphs: [
        "7.1 乙方应当遵守《律师法》第三十八条规定的保密义务，不得泄露在履行本协议过程中知悉的甲方商业秘密。",
        "7.2 双方其他权利义务适用《民法典》第五百零九条。",
      ],
    },
    { heading: "第八条 违约责任", paragraphs: ["8.1 任何一方违约，应赔偿对方由此遭受的直接损失（不含间接损失）。"] },
    { heading: "第九条 争议解决", paragraphs: ["9.1 本协议适用内地法律，提交北京仲裁委员会仲裁。"] },
  ]);
  const r1 = compareDocx(base, edited);
  assert.equal(r1.stats.modified, 1);
  assert.equal(r1.stats.added, 2); // 新增第九条标题与条文两段
  assert.equal(r1.stats.silent, 3, "未开修订的改动应全部判为静默");
  assert.equal(r1.curHasTrackedChanges, false);

  // 我方修订稿（带 w:ins/w:del）→ 覆盖到的改动非静默
  const revised = applyRevisionsToDocx(base, {
    baselineHash: sha256Hex(base),
    ops: [op({ originalText: "全部损失", newText: "直接损失" })],
  });
  const r2 = compareDocx(base, revised.docx);
  assert.equal(r2.curHasTrackedChanges, true);
  assert.equal(r2.stats.silent, 0, "修订覆盖的改动不应判为静默");
});

test("engine: 受众净化——接受修订、清除批注与作者属性、保留生成标识", () => {
  const base = contractDocx();
  const revised = applyRevisionsToDocx(base, {
    baselineHash: sha256Hex(base),
    ops: [op({ originalText: "《律师法》第三十八条", newText: "《律师法》第四十一条", comment: "改引" })],
  });
  const clean = sanitizeDocx(revised.docx);
  const xml = readZipText(clean.docx, "word/document.xml")!;
  assert.ok(!/<w:del\b/.test(xml), "不得残留 w:del");
  assert.ok(!/<w:ins\b/.test(xml), "不得残留 w:ins");
  assert.ok(!/commentReference/.test(xml), "不得残留批注引用");
  const finalText = extractParagraphs(clean.docx).map((p) => p.text).join("\n");
  assert.ok(finalText.includes("《律师法》第四十一条"), "定稿文本保留插入内容");
  assert.ok(!finalText.includes("第三十八条"), "被删的原文不在定稿里");
  assert.ok(!xml.includes("第三十八条规定的保密义务") || xml.includes("第四十一条"), "删除文本不得作为定稿");
  const core = readZipText(clean.docx, "docProps/core.xml")!;
  assert.match(core, /Kimi Work 法律行业发行版/); // 生成标识保留
  assert.equal(clean.removed.comments, 1);
});

test("engine: createDocx 产物可被回读（zip 与段落完整）", () => {
  const buf = contractDocx();
  const paras = extractParagraphs(buf);
  assert.equal(paras[0]!.text, "股权转让协议");
  assert.ok(paras.some((p) => p.text.startsWith("7.1 乙方应当遵守")));
});

test("可见文字口径（复核 C-B03）：w:moveFrom 视同删除；段落标记被删的自闭合 w:del 不把整段当成已删除", () => {
  const xml =
    '<w:document xmlns:w="w"><w:body>' +
    '<w:p><w:r><w:t>第一条 付款期限为三十日。</w:t></w:r></w:p>' +
    '<w:p><w:moveFrom w:id="1" w:author="a"><w:r><w:t>被移走的条款。</w:t></w:r></w:moveFrom><w:r><w:t>留下的文字。</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:rPr><w:del w:id="2" w:author="a"/></w:rPr></w:pPr><w:r><w:t>段落标记被删但文字仍在。</w:t></w:r></w:p>' +
    '<w:p><w:moveTo w:id="3" w:author="a"><w:r><w:t>被移走的条款。</w:t></w:r></w:moveTo></w:p>' +
    "</w:body></w:document>";
  const paras = mapParagraphs(xml).map((p) => p.text);
  assert.deepEqual(paras, ["第一条 付款期限为三十日。", "留下的文字。", "段落标记被删但文字仍在。", "被移走的条款。"]);
  // 被移动的条款在视图中只出现一次（移到的新位置）
  assert.equal(paras.join("\n").split("被移走的条款。").length - 1, 1);
});

// ─── v9.4 第 19 批 C-02：缺失条款的段后插入 ───

test("engine: 段后插入——新段落在锚点段落之后，段落标记与文字都是插入修订，锚点段落不动", () => {
  const base = contractDocx();
  const r = applyRevisionsToDocx(base, {
    baselineHash: sha256Hex(base),
    ops: [{ ...op({ originalText: "7.2 双方其他权利义务适用", newText: "7.3 本条约定的保密义务在本协议终止后继续有效。\n7.4 违反保密义务的，按第八条承担责任。", comment: "【缺失】未约定保密期限" }), insertAfter: true }],
  });
  assert.equal(r.applied.length, 1);
  const texts = extractParagraphs(r.docx).map((p) => p.text);
  const at = texts.findIndex((t) => t.startsWith("7.2 "));
  assert.equal(texts[at], "7.2 双方其他权利义务适用《民法典》第五百零九条。", "锚点段落原样保留");
  assert.equal(texts[at + 1], "7.3 本条约定的保密义务在本协议终止后继续有效。");
  assert.equal(texts[at + 2], "7.4 违反保密义务的，按第八条承担责任。");
  assert.ok(texts[at + 3]!.includes("第八条 违约责任"), "插在下一条之前");
  const xml = readZipText(r.docx, "word/document.xml")!;
  assert.equal(xml.match(/<w:rPr><w:ins w:id="\d+"[^>]*\/><\/w:rPr><\/w:pPr>/g)?.length, 2, "两个新段落的段落标记都标为插入");
  assert.doesNotMatch(xml, /<w:delText/, "插入不删除任何原文");
  assert.match(readZipText(r.docx, "word/comments.xml")!, /【缺失】未约定保密期限/);
  // 净化（接受全部修订）：段落标记与文字都保留，XML 仍成对
  const clean = sanitizeDocx(r.docx);
  const cleanXml = readZipText(clean.docx, "word/document.xml")!;
  assert.doesNotMatch(cleanXml, /<w:ins\b|<\/w:ins>/);
  assert.equal((cleanXml.match(/<w:p\b/g) ?? []).length, (cleanXml.match(/<\/w:p>/g) ?? []).length);
  assert.ok(extractParagraphs(clean.docx).some((p) => p.text === "7.4 违反保密义务的，按第八条承担责任。"));
});

test("engine: 段后插入与同段替换可同时写；空条款拒绝", () => {
  const base = contractDocx();
  const r = applyRevisionsToDocx(base, {
    baselineHash: sha256Hex(base),
    ops: [
      op({ opId: "a", originalText: "全部损失", newText: "直接损失" }),
      { ...op({ opId: "b", originalText: "8.1 任何一方违约", newText: "8.2 违约金以合同总价为限。" }), insertAfter: true },
    ],
  });
  const texts = extractParagraphs(r.docx).map((p) => p.text);
  assert.ok(texts.includes("8.1 任何一方违约，应赔偿对方由此遭受的直接损失。"));
  assert.equal(texts.at(-1), "8.2 违约金以合同总价为限。");
  assert.throws(() => applyRevisionsToDocx(base, { baselineHash: sha256Hex(base), ops: [{ ...op({ originalText: "8.1 任何一方违约", newText: " \n " }), insertAfter: true }] }), /插入的条款为空/);
});

test("engine: 净化器先处理自闭合的段落修订标记（否则会吞掉后面的修订、写坏 XML）", () => {
  const base = contractDocx();
  const ins = applyRevisionsToDocx(base, { baselineHash: sha256Hex(base), ops: [{ ...op({ opId: "x", originalText: "7.1 乙方", newText: "7.1A 新增一款。" }), insertAfter: true }] });
  const both = applyRevisionsToDocx(ins.docx, { baselineHash: sha256Hex(ins.docx), ops: [op({ opId: "y", originalText: "全部损失", newText: "直接损失" })] });
  const clean = sanitizeDocx(both.docx);
  const texts = extractParagraphs(clean.docx).map((p) => p.text);
  assert.ok(texts.includes("7.1A 新增一款。"));
  assert.ok(texts.includes("8.1 任何一方违约，应赔偿对方由此遭受的直接损失。"), "后面的成对修订照常接受");
  assert.ok(!texts.some((t) => t.includes("全部损失")));
});

test("净化：段落标记被删的段落与下一段合并（复核 Q2-15）；整段删除不留空段；连续几段依次并入；插入的段落标记照常保留段落", async () => {
  const { mergeDeletedParagraphMarks, sanitizeDocx } = await import("../src/sanitize.ts");
  const { readZipEntries, writeZip } = await import("../src/zip.ts");
  const { extractParagraphs } = await import("../src/compare.ts");
  const delMark = `<w:pPr><w:rPr><w:del w:id="9" w:author="对方" w:date="2026-10-01T00:00:00Z"/></w:rPr></w:pPr>`;
  const insMark = `<w:pPr><w:rPr><w:ins w:id="8" w:author="对方" w:date="2026-10-01T00:00:00Z"/></w:rPr></w:pPr>`;
  const r = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const bodyXml = [
    `<w:p>${delMark}${r("甲")}</w:p>`,
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${r("乙")}</w:p>`,
    `<w:p>${delMark}<w:del w:id="1" w:author="对方"><w:r><w:delText>整段删掉</w:delText></w:r></w:del></w:p>`,
    `<w:p>${delMark}${r("丙")}</w:p>`,
    `<w:p>${r("丁")}</w:p>`,
    `<w:p>${insMark}<w:ins w:id="2" w:author="对方">${r("新增段")}</w:ins></w:p>`,
  ].join("");
  const m = mergeDeletedParagraphMarks(bodyXml);
  assert.equal(m.merged, 3);
  assert.equal((m.xml.match(/<w:p\b/g) ?? []).length, 3, "6 段 → 甲乙一段、（删掉）丙丁一段、新增段");
  assert.ok(m.xml.includes('<w:jc w:val="center"/>'), "合并后用下一段的段落属性");
  // 走完整的净化：与“接受全部修订”一致
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
  const base = readZipEntries(createDocx("x", [{ heading: "", paragraphs: ["占位"] }]));
  base.set("word/document.xml", Buffer.from(doc, "utf8"));
  const out = sanitizeDocx(writeZip([...base].map(([name, data]) => ({ name, data }))));
  assert.deepEqual(extractParagraphs(out.docx).map((p) => p.text), ["甲乙", "丙丁", "新增段"]);
  assert.equal(mergeDeletedParagraphMarks(`<w:p>${delMark}${r("末段")}</w:p>`).merged, 0, "后面没有段落：不合并");
});
