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
  assert.match(xml, /<w:delText[^>]*>《律师法》第三十八条<\/w:delText>/);
  assert.match(xml, /<w:ins\b[^>]*>[\s\S]*?《中华人民共和国律师法》第四十一条/);
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
  assert.ok(xml.includes("《律师法》第四十一条"), "定稿文本保留插入内容");
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
