/**
 * V14 第 39 批（基线走查 B 独立评分 21/24 的主要扣分）：律师说“修订稿要能直接发回对方”，产品交出的修订稿每处修订作者都是
 * “Kimi Work 法律助手（AI 建议，待律师确认）”并带内部理由批注；复核轮为去掉批注不写 comment 重交，修改对照表的理由全成了
 * “按律师意见修改”（联动条号也这样写）；复核人只看清洁稿，看不到修订作者与批注。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, externalRedline, readZipEntries, readZipText } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { reviewTargets } from "../src/executor/executor.ts";
import { writeZip } from "../../docx-engine/src/zip.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const AI = "Kimi Work 法律助手（AI 建议，待律师确认）";

test("externalRedline：修订痕迹保留，批注去掉，只改本产品修订的署名，对方原有修订的作者不动", () => {
  const doc = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:commentRangeStart w:id="1"/><w:del w:id="2" w:author="${AI}" w:date="2026-11-09T00:00:00Z"><w:r><w:delText>100</w:delText></w:r></w:del><w:ins w:id="3" w:author="${AI}" w:date="2026-11-09T00:00:00Z"><w:r><w:t>120</w:t></w:r></w:ins><w:ins w:id="4" w:author="枢禾信息" w:date="2026-11-06T00:00:00Z"><w:r><w:t>对方加的</w:t></w:r></w:ins><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p></w:body></w:document>`;
  const base = createDocx("x", [{ heading: "", paragraphs: ["占位"] }], { mark: false });
  const files = readZipEntries(base);
  files.set("word/document.xml", Buffer.from(doc, "utf8"));
  files.set("word/comments.xml", Buffer.from(`<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1" w:author="${AI}"><w:p><w:r><w:t>内部理由</w:t></w:r></w:p></w:comment></w:comments>`, "utf8"));
  const r = externalRedline(writeZip([...files.entries()].map(([name, data]) => ({ name, data }))), AI, "苏州衡正律师事务所");
  const x = readZipText(r.docx, "word/document.xml") ?? "";
  assert.equal(r.reauthored, 2);
  assert.equal(r.comments, 1);
  assert.match(x, /<w:del w:id="2" w:author="苏州衡正律师事务所"/);
  assert.match(x, /<w:ins w:id="3" w:author="苏州衡正律师事务所"/);
  assert.match(x, /<w:ins w:id="4" w:author="枢禾信息"/, "对方修订的作者不动");
  assert.equal(/commentReference|commentRange/.test(x), false);
  assert.equal(/内部理由/.test(readZipText(r.docx, "word/comments.xml") ?? ""), false);
});

test("externalRedline（V16 第 41 批）：对方原有的批注保留，只去掉本产品写的批注", () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const ref = (id: number) => `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`;
  const doc = `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body><w:p><w:commentRangeStart w:id="7"/><w:r><w:t>争议由甲方住所地人民法院管辖。</w:t></w:r><w:commentRangeEnd w:id="7"/>${ref(7)}</w:p><w:p><w:commentRangeStart w:id="9"/><w:ins w:id="3" w:author="${AI}" w:date="2026-11-10T00:00:00Z"><w:r><w:t>新增一句。</w:t></w:r></w:ins><w:commentRangeEnd w:id="9"/>${ref(9)}</w:p></w:body></w:document>`;
  const files = readZipEntries(createDocx("x", [{ heading: "", paragraphs: ["占位"] }], { mark: false }));
  files.set("word/document.xml", Buffer.from(doc, "utf8"));
  files.set("word/comments.xml", Buffer.from(`<?xml version="1.0"?><w:comments ${W}><w:comment w:id="7" w:author="潘越（对方法务）" w:date="2026-11-05T00:00:00Z"><w:p><w:r><w:t>我方建议改为仲裁，请考虑。</w:t></w:r></w:p></w:comment><w:comment w:id="9" w:author="${AI}" w:date="2026-11-10T00:00:00Z"><w:p><w:r><w:t>内部理由</w:t></w:r></w:p></w:comment></w:comments>`, "utf8"));
  const r = externalRedline(writeZip([...files.entries()].map(([name, data]) => ({ name, data }))), AI, "苏州衡正律师事务所");
  const x = readZipText(r.docx, "word/document.xml") ?? "";
  const c = readZipText(r.docx, "word/comments.xml") ?? "";
  assert.equal(r.comments, 1, "只去掉一条（本产品写的）");
  assert.match(x, /<w:commentRangeStart w:id="7"\/>/);
  assert.match(x, /<w:commentRangeEnd w:id="7"\/>/);
  assert.match(x, /<w:commentReference w:id="7"\/>/);
  assert.equal(/w:id="9"/.test(x), false, "本产品批注的范围与引用都去掉");
  assert.match(c, /潘越（对方法务）[\s\S]*我方建议改为仲裁/);
  assert.equal(c.includes("内部理由"), false);
});

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b39-extredline-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("docx.revise 另交《修订稿·对外版》（无批注、署名为本所设置）；对照表里联动行与未写理由的行如实标注；复核清单写出修订作者与批注条数", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  await tk.inv("doc_style.set", { redline_author: "苏州衡正律师事务所" }).catch(() => undefined);
  const { matter } = await tk.inv("matters.create", { title: "对外修订稿", stance: "委托方", consent_status: "agreed" });
  const original = createDocx("服务合同", [{ heading: "第一条 价款", paragraphs: ["1.1 服务费为人民币100万元。", "1.2 乙方应于收款后开具发票。"] }], { mark: false });
  const doc = await importBytes(tk.inv, matter.matter_id, "服务合同.docx", original, DOCX);
  const live = liveTaskIdentity(tk, matter.matter_id, "ext");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "改", document_version_ids: [doc.document_version_id] }), live.rid]);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  const res = (await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "docx.revise", arguments: { document_version_id: doc.document_version_id, patches: [{ anchor: "服务费为人民币100万元", proposed_text: "服务费为人民币120万元", comment: "按客户预算调整价款" }, { anchor: "乙方应于收款后开具发票", proposed_text: "乙方应于收款后五日内开具发票" }] } } }), dispatcher: agent }).then((x) => x.json())) as any;
  const r = res.result.structuredContent;
  assert.equal(r.status, "applied", JSON.stringify(r));
  assert.ok(r.external?.filename?.endsWith("（修订稿·对外版）.docx"), JSON.stringify(r.external));
  assert.match(r.note, /对外版/);
  const ext = tk.kernel.db.get<{ storage_uri: string; kind: string }>(`SELECT storage_uri, kind FROM artifact_versions WHERE artifact_version_id = ?`, [r.external.artifact_version_id])!;
  assert.equal(ext.kind, "revision_draft");
  const ex = tk.kernel.blobs.read(ext.storage_uri);
  const exml = readZipText(ex, "word/document.xml") ?? "";
  assert.match(exml, /<w:ins\b/);
  assert.equal(exml.includes(AI), false, "对外版里没有 AI 署名");
  assert.match(exml, /w:author="苏州衡正律师事务所"/);
  assert.equal(/commentReference/.test(exml), false);
  // 内部版照旧带批注、AI 署名
  const internal = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [r.revision.artifact_version_id])!;
  assert.match(readZipText(tk.kernel.blobs.read(internal.storage_uri), "word/document.xml") ?? "", /commentReference/);
  // 对照表：写了理由的用理由；没写的如实标注，不冒称“按律师意见修改”
  const cmp = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [r.comparison.artifact_version_id])!;
  const ct = (readZipText(tk.kernel.blobs.read(cmp.storage_uri), "word/document.xml") ?? "").replace(/<[^>]+>/g, "");
  assert.match(ct, /按客户预算调整价款/);
  assert.match(ct, /助手未注明理由，请律师核对/);
  // 复核清单：对外版不进复核正文；清单写出修订作者与批注条数
  const t = reviewTargets({ db: tk.kernel.db, blobs: tk.kernel.blobs }, live.rid, matter.matter_id, "revise")!;
  assert.equal(t.docs.some((d) => /修订稿/.test(d.filename)), false, "修订稿（含对外版）不作复核正文，正文看清洁稿");
  const inv = t.inventory.join("\n");
  assert.match(inv, /（修订稿）\.docx（修订标记 \d+ 处；修订作者：Kimi Work 法律助手（AI 建议，待律师确认）；本产品写的批注 1 条；原件原有的批注 0 条）/);
  assert.match(inv, /（修订稿·对外版）\.docx（修订标记 \d+ 处；修订作者：苏州衡正律师事务所；本产品写的批注 0 条；原件原有的批注 0 条；对外版按设计只去掉本产品写的批注，原件原有的批注保留，不算遗漏）/);
  assert.equal(r.note.includes("原件原有的批注"), false, "原件没有批注时不提条数");
});

test("V16 第 41 批：原件带对方批注走 docx.revise——对外版保留对方那条，返回说明与复核清单如实写明，不说“对外版不带批注”", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "对外修订稿带对方批注", stance: "委托方", consent_status: "agreed" });
  // 原件：第 1.2 款上有对方律师留的一条批注
  const base = readZipEntries(createDocx("服务合同", [{ heading: "第一条 价款", paragraphs: ["1.1 服务费为人民币100万元。", "1.2 乙方应于收款后开具发票。"] }], { mark: false }));
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const docXml = base.get("word/document.xml")!.toString("utf8");
  const at = docXml.indexOf("1.2 乙方");
  const runStart = docXml.lastIndexOf("<w:r>", at);
  const pEnd = docXml.indexOf("</w:p>", at);
  base.set("word/document.xml", Buffer.from(`${docXml.slice(0, runStart)}<w:commentRangeStart w:id="7"/>${docXml.slice(runStart, pEnd)}<w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r>${docXml.slice(pEnd)}`, "utf8"));
  base.set("word/comments.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}><w:comment w:id="7" w:author="对方法务" w:date="2026-11-05T00:00:00Z"><w:p><w:r><w:t>开票时间请再确认。</w:t></w:r></w:p></w:comment></w:comments>`, "utf8"));
  const original = writeZip([...base.entries()].map(([name, data]) => ({ name, data })));
  const doc = await importBytes(tk.inv, matter.matter_id, "服务合同.docx", original, DOCX);
  const live = liveTaskIdentity(tk, matter.matter_id, "ext2");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "改", document_version_ids: [doc.document_version_id] }), live.rid]);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  const res = (await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "docx.revise", arguments: { document_version_id: doc.document_version_id, patches: [{ anchor: "服务费为人民币100万元", proposed_text: "服务费为人民币120万元", comment: "按客户预算调整价款" }] } } }), dispatcher: agent }).then((x) => x.json())) as any;
  const r = res.result.structuredContent;
  assert.equal(r.status, "applied", JSON.stringify(r));
  // 返回给助手的说明：去掉的是本产品写的批注；原件原有的 1 条保留，由律师决定去留
  assert.match(r.note, /去掉的是本产品写的修改理由批注/);
  assert.match(r.note, /原件原有的批注 1 条与原有的修订痕迹原样保留/);
  assert.match(r.note, /不要替律师删/);
  assert.equal(/不带批注|发给对方前须删除批注/.test(r.note), false, r.note);
  // 对外版：对方那条批注仍在，本产品的批注不在
  const ext = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [r.external.artifact_version_id])!;
  const exBuf = tk.kernel.blobs.read(ext.storage_uri);
  const ec = readZipText(exBuf, "word/comments.xml") ?? "";
  assert.match(ec, /对方法务[\s\S]*开票时间请再确认/);
  assert.equal(ec.includes("按客户预算调整价款"), false);
  assert.match(readZipText(exBuf, "word/document.xml") ?? "", /<w:commentReference w:id="7"\/>/);
  // 复核清单：批注按作者分开数；对外版写明保留原件批注不算遗漏
  const inv = reviewTargets({ db: tk.kernel.db, blobs: tk.kernel.blobs }, live.rid, matter.matter_id, "revise")!.inventory.join("\n");
  assert.match(inv, /（修订稿）\.docx（[^\n]*本产品写的批注 1 条；原件原有的批注 1 条（作者：对方法务））/);
  assert.match(inv, /（修订稿·对外版）\.docx（[^\n]*本产品写的批注 0 条；原件原有的批注 1 条（作者：对方法务）；对外版按设计只去掉本产品写的批注，原件原有的批注保留，不算遗漏）/);
  // 给复核人的核对清单同样写明
  const { reviewMessages } = await import("../src/services/independent-review.ts");
  const m = reviewMessages({ kind: "revise", stance: "委托方", jurisdiction: "中国大陆", asOf: "2026-11-10", goal: "改", materials: [], docs: [{ filename: "服务合同（清洁稿）.docx", text: "1.1 服务费为人民币120万元。" }], inventory: [inv] });
  assert.match(m[0]!.content + m[1]!.content, /原件里原有的批注与修订[\s\S]*不算问题/);
});
