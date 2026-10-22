/**
 * v9.4 第 21 批 C-03 残余（评审 C1 §4.3）：成果里的事实角标——文中日期按事项事实行对：对上律师已确认的显示“已确认”，
 * 只对上 AI 提交未确认的显示“未确认”；驳回的不参与；日期写法变体都认；前后紧挨数字的不算。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDocx } from "@zr-legal/docx-engine";
import { importText, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { artifactFactMarks, dateForms } from "../src/services/artifact-facts.ts";
import { submitFacts } from "../src/services/review-cards.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "artifact-facts-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("dateForms：常见中文写法，长的在前", () => {
  const f = dateForms("2026-03-01");
  assert.deepEqual(f.slice(0, 2), ["2026 年 03 月 01 日", "2026 年 3 月 1 日"]);
  assert.ok(f.includes("2026年3月1日") && f.includes("2026-03-01") && f.includes("2026.3.1"));
  assert.deepEqual(dateForms("2026-03"), []);
});

test("事实角标：已确认 / 未确认 / 驳回不参与；artifacts.citations 一并返回", { timeout: 60_000 }, async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "事实角标", stance: "原告", consent_status: "agreed" });
  const m = matter.matter_id;
  const doc = await importText(inv, m, "签收单.txt", "买方于 2026 年 3 月 1 日签收全部货物。2026 年 4 月 2 日卖方催款。2026 年 5 月 3 日买方回函。");
  const live = liveTaskIdentity(tk, m, "facts");
  submitFacts({ db: kernel.db, blobs: kernel.blobs }, { tenantId: live.tid, matterId: m, runId: live.rid }, {
    facts: [
      { statement: "买方签收全部货物", kind: "claimed", occurred_on: "2026-03-01", document_version_id: doc.document_version_id, quote: "买方于 2026 年 3 月 1 日签收全部货物。" },
      { statement: "卖方催款", kind: "claimed", occurred_on: "2026-04-02" },
      { statement: "买方回函", kind: "claimed", occurred_on: "2026-05-03" },
    ],
  });
  const facts = (await inv("facts.list", { matter_id: m })).facts as any[];
  await inv("facts.decide", { matter_id: m, fact_id: facts.find((f) => f.statement === "买方签收全部货物").fact_id, decision: "confirm" });
  await inv("facts.decide", { matter_id: m, fact_id: facts.find((f) => f.statement === "买方回函").fact_id, decision: "reject" });

  const text = "一、事实\n2026年3月1日，买方签收货物。2026 年 4 月 2 日卖方催款。2026 年 5 月 3 日买方回函。再如 2026-03-01 签收单载明。合同编号 12026-03-011 无关。";
  const marks = artifactFactMarks(kernel.db, m, text);
  assert.deepEqual(
    marks.map((x) => [x.raw, x.nth, x.status]),
    [["2026年3月1日", 1, "confirmed"], ["2026 年 4 月 2 日", 1, "proposed"], ["2026-03-01", 1, "confirmed"]],
    "驳回的 5 月 3 日不标；紧挨数字的不算",
  );
  assert.equal(marks[0]!.facts[0]!.filename, "签收单.txt");
  assert.match(marks[0]!.facts[0]!.quote ?? "", /签收全部货物/);

  const bytes = createDocx("起诉状", [{ heading: "事实与理由", paragraphs: ["2026 年 3 月 1 日，被告签收全部货物。"] }]);
  const { sha256, storage_uri } = kernel.blobs.put(bytes, m);
  const id = `artv_${randomUUID()}`;
  kernel.db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', ?)`,
    [id, kernel.identity.tenantId, m, null, "test_facts", "internal", 1, "起诉状.docx", sha256, storage_uri, kernel.identity.userId],
  );
  const r = await inv("artifacts.citations", { artifact_version_id: id });
  assert.deepEqual(r.facts.map((x: any) => [x.raw, x.status]), [["2026 年 3 月 1 日", "confirmed"]]);
});

test("编号与界面一致（复核 Q3-04）：“2026.3.15”在前、“2026.3.1”在后——界面按内核给的第几次加角标，落在真正那一处", { timeout: 60_000 }, async () => {
  const { scanMarks } = await import("../../../apps/desktop/src/lib/cite-scan.ts");
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "角标编号", stance: "原告", consent_status: "agreed" });
  const m = matter.matter_id;
  const live = liveTaskIdentity(tk, m, "nth");
  submitFacts({ db: kernel.db, blobs: kernel.blobs }, { tenantId: live.tid, matterId: m, runId: live.rid }, { facts: [{ statement: "签收", kind: "claimed", occurred_on: "2026-03-01" }] });
  const text = "2026.3.15 发货。`2026.3.1` 见附件。2026.3.1 签收，2026年3月1日 再确认。";
  const marks = artifactFactMarks(kernel.db, m, text);
  // 界面：只知道内核给的写法，逐处扫描，按（写法，第几次）对上才加角标
  const raws = [...new Set(marks.map((x) => x.raw))];
  const seen = new Map<string, number>();
  const placed = scanMarks(text, raws, seen).filter((h) => marks.some((x) => x.raw === h.raw && x.nth === h.nth));
  assert.deepEqual(
    placed.map((h) => text.slice(h.start, h.end + 3)),
    ["2026.3.1` 见", "2026.3.1 签收", "2026年3月1日 再确"],
    "“2026.3.15”里的那处计数、不加角标；其余各处按（写法，第几次）对上（Markdown 里代码段照样计数、只是不显示角标）",
  );
  assert.deepEqual(marks.map((x) => [x.raw, x.nth]), [["2026.3.1", 2], ["2026.3.1", 3], ["2026年3月1日", 1]]);
});
