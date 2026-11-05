/**
 * V12 R-2 / R-3：主交付物按律师的请求核对。
 * 真实复现：“起草一份起诉状及证据目录”“起草采购合同，附违约金计算方式”被建议成表格类方法；自由描述的任务没加载方法时不核对，
 * 只交 Excel 也记“已完成”；只交《起草说明与待定事项》（方法标“附件”）也算交出了合同；修改原件的任务整份重出也算交出修订稿。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { deliverableRuleOf, goalPrimary, primaryDeliverableMissing, methodPromptLine, agentGoalPrompt } from "../src/executor/executor.ts";
import { goalDeliverable, GOAL_WORD_PRIMARY } from "../src/executor/deliverable-intent.ts";

test("律师的请求要什么：文书 → word；点名表格 → sheet；问答、测算、整理 → null", () => {
  assert.equal(goalDeliverable("帮我起草一份民事起诉状及证据目录。基本事实：违约金分段计算。"), "word");
  assert.equal(goalDeliverable("请起草采购合同，附违约金计算方式"), "word");
  assert.equal(goalDeliverable("请以委托方立场起草一份《软件开发合同》，可直接作为首稿"), "word");
  assert.equal(goalDeliverable("按我的意见修改这份租赁合同第三条"), "word");
  assert.equal(goalDeliverable("出具一份法律意见书，分析违法解除风险"), "word");
  assert.equal(goalDeliverable("帮我把证据整理成 Excel 证据目录"), "sheet");
  assert.equal(goalDeliverable("请测算截至 2027 年 3 月 1 日的逾期利息"), null);
  assert.equal(goalDeliverable("整理案卷，列出事实时间线"), null);
  assert.equal(goalDeliverable("违约金上限一般是多少？"), null);
  // 案情里的文书名不是请求（“对方的起诉状称……”）
  assert.equal(goalDeliverable("对方的起诉状称我方逾期交货。帮我算一下违约金"), null);
});

test("律师要文书：表格类或没有声明的主交付物一律改按 Word 核对；已是 Word 的照用", () => {
  assert.equal(goalPrimary("计算明细.xlsx", "word"), GOAL_WORD_PRIMARY);
  assert.equal(goalPrimary(null, "word"), GOAL_WORD_PRIMARY);
  assert.equal(goalPrimary("合同草稿.docx", "word"), "合同草稿.docx");
  assert.equal(goalPrimary("计算明细.xlsx", null), "计算明细.xlsx");
  assert.equal(goalPrimary(null, "sheet"), null);
});

test("提示词：表格类方法遇到文书请求时写明 Word 为主、表格作附件；自由描述的文书任务写明交付形态", () => {
  const line = methodPromptLine("amount-calc", null, "计算明细.xlsx", "word");
  assert.match(line, /律师本次要的是一份文书/);
  assert.doesNotMatch(line, /主交付物是 Excel 表/);
  assert.match(methodPromptLine("amount-calc", null, "计算明细.xlsx", null), /主交付物是 Excel 表/);
  const p = agentGoalPrompt({ stance: "委托方", jurisdiction: "中国大陆", asOf: "2027-01-01", facts: "", goal: "起草合同", methodLine: "", rulesBlock: "", prefsLine: "", goalKind: "word" });
  assert.match(p, /【交付】律师本次要的是一份文书/);
  assert.doesNotMatch(agentGoalPrompt({ stance: "委托方", jurisdiction: "中国大陆", asOf: "2027-01-01", facts: "", goal: "违约金上限是多少", methodLine: "", rulesBlock: "", prefsLine: "" }), /【交付】/);
});

test("核对口径：附件 Word 不算主交付物；修订稿方法要原件修订", () => {
  const outs: Record<string, string[]> = {
    "contract-draft": ["合同草稿.docx", "起草说明与待定事项.docx（附件）"],
    "doc-revise": ["修订稿.docx", "清洁稿.docx", "修改对照表.docx（附件，系统按实际写入的修改自动生成）"],
  };
  assert.deepEqual(deliverableRuleOf(["contract-draft"], (s) => outs[s]), { attachments: ["起草说明与待定事项"] });
  assert.deepEqual(deliverableRuleOf(["doc-revise"], (s) => outs[s]), { attachments: ["修改对照表"], requireRevision: true });
  assert.deepEqual(deliverableRuleOf(["contract-draft"], undefined), {});
});

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "v12-goal-deliverable-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("结算核对：只交表格 / 只交附件 / 修改原件却整份重出 → 报缺失；交出正文或修订稿 → 通过", async () => {
  const { matter } = await tk.inv("matters.create", { title: "V12 主交付物核对", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2027-01-01" } });
  const db = tk.kernel.db;
  let ver = 0;
  const art = (live: { tid: string; rid: string; uid: string }, kind: string, filename: string) =>
    db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by) VALUES (?,?,?,?,?,?,'internal','draft',?,?,?,'[]','{}',?)`,
      [`art_${Math.random().toString(36).slice(2, 10)}`, live.tid, matter.matter_id, live.rid, kind, ++ver, filename, "x".repeat(64), "blob://x", live.uid],
    );
  // 自由描述的文书请求、没加载方法、只交了 Excel：原先 primary=null 不核对 → 现按“你要求的文书”核对
  const a = liveTaskIdentity(tk, matter.matter_id, "v12-a");
  art(a, "agent_table", "证据目录.xlsx");
  assert.equal(primaryDeliverableMissing(db, a.rid, null), null, "旧口径：不核对");
  const miss = primaryDeliverableMissing(db, a.rid, goalPrimary(null, "word"));
  assert.equal(miss?.cause, "no_word_output");
  assert.match(miss!.note, /没有交出《你要求的文书》/);

  // 起草合同只交了起草说明（附件）
  const rule = { attachments: ["起草说明与待定事项"] };
  const b = liveTaskIdentity(tk, matter.matter_id, "v12-b");
  art(b, "agent_report", "起草说明与待定事项.docx");
  assert.equal(primaryDeliverableMissing(db, b.rid, "合同草稿.docx"), null, "旧口径：任一 Word 都算");
  assert.equal(primaryDeliverableMissing(db, b.rid, "合同草稿.docx", rule)?.cause, "attachment_only");
  art(b, "agent_report", "MES系统定制开发与实施合同.docx");
  assert.equal(primaryDeliverableMissing(db, b.rid, "合同草稿.docx", rule), null);

  // 修改原件：只整份重出
  const c = liveTaskIdentity(tk, matter.matter_id, "v12-c");
  art(c, "agent_report", "设备租赁合同.docx");
  assert.equal(primaryDeliverableMissing(db, c.rid, "修订稿.docx", { requireRevision: true })?.cause, "no_revision_on_original");
  art(c, "revision_draft", "设备租赁合同-修订稿.docx");
  assert.equal(primaryDeliverableMissing(db, c.rid, "修订稿.docx", { requireRevision: true }), null);
});
