/**
 * Skill 契约测试（v9.4 第 19 批 S-09；评审 S1 §6.2 第 14 项）：签名方法包里的每一个方法，都用脚本化模型在整条链路上跑一遍“黄金路径”——
 * 内核 → kap-host（方法包作可信区加载）→ 出站闸门 → 网关 v0 → 脚本化模型。每个方法：
 *   1. 带方法模板与方法参数发起任务，模型看到的说明里有“方法参数”；调用 Skill 工具拿到的是该方法的正文（标题一致）；
 *   2. 按方法声明的必需工具（kwl.tools_required）逐个发调用，参数按方法正文写明的形状——每个调用都必须成功（工具清单、锁文件、
 *      schema、事项绑定与方法写法一致）；文书类方法按 C-04 先提交论点提纲、经律师确认（与任务页同一顺序：先记决定，再答确认题）后才出文书；
 *   3. 产出落到律师能看到的地方：文书与表格登记为本任务的成果、风险卡进工作台、事实进事实标签、审阅表格子写入。
 * 这不是法律质量评测（模型是脚本），验证的是“方法写的工具与参数在真实链路上走得通”——方法或工具任一侧改了契约，这里就失败。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "skills-contract-secret-0123456789ab";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDocx } from "@zr-legal/docx-engine";
import { importBytes, importText, makeKernel, waitRunAnswering, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { decideOutline, latestOutline } from "../src/services/argument-outlines.ts";
import { TOOLS } from "../src/tools/registry.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const manifest = JSON.parse(readFileSync(repo("content/skills/dist/skills.manifest.json"), "utf8")) as { skills: { id: string; title: string; tools_required: string[]; requires_outline?: boolean }[] };
const frontArgs = (id: string): string[] => {
  const m = /^arguments:\s*\[([^\]]*)\]/m.exec(readFileSync(repo(`content/skills/${id}/SKILL.md`), "utf8"));
  return m ? m[1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
};
/** 文书类方法（C-04）：起草前须提交论点提纲并经律师确认；从方法元数据读（复核 Q2-17：新增文书方法漏标时，下面的用例会失败）。 */
const DRAFTING = new Set(manifest.skills.filter((s) => s.requires_outline).map((s) => s.id));
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CLAUSE = "8.1 买方应于验收合格后九十日内支付货款。";
const mcp = (name: string) => `mcp__legal__${name.replace(/\./g, "_")}`;
/** 工具调用失败的样子（交还给模型的结果里带错误标记或内核的拒绝说明）；反向用例证明它认得出真实的失败。 */
const TOOL_FAILED = /"isError":\s*true|工具不可用|validation|未授权|forbidden|还在等律师确认|不在本事项|不存在或无权/i;

let tk: TestKernel;
let cloud: CloudV0;
let matterId = "";
const ids = { doc: "", doc2: "", parse: "", table: "", user: "" };

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_skills-contract-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off" }, "skills-contract-firm");
  const { matter } = await tk.inv("matters.create", { title: "契约测试事项", stance: "买方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  matterId = matter.matter_id;
  const v1 = await importBytes(tk.inv, matterId, "采购合同.docx", createDocx("采购合同", [{ heading: "第八条 付款", paragraphs: [CLAUSE, "8.2 逾期付款的，按日万分之五支付违约金。"] }]), DOCX);
  const v2 = await importBytes(tk.inv, matterId, "采购合同（对方回稿）.docx", createDocx("采购合同", [{ heading: "第八条 付款", paragraphs: ["8.1 买方应于验收合格后一百二十日内支付货款。", "8.2 逾期付款的，按日万分之五支付违约金。"] }]), DOCX);
  await importText(tk.inv, matterId, "签收单.txt", "签收单：买方于 2026 年 3 月 1 日签收全部货物，签收人张三。");
  ids.doc = v1.document_version_id;
  ids.doc2 = v2.document_version_id;
  ids.parse = tk.kernel.db.get<{ parse_version_id: string }>(`SELECT parse_version_id FROM parse_versions WHERE document_version_id = ? ORDER BY created_at DESC LIMIT 1`, [ids.doc])!.parse_version_id;
  ids.table = (await tk.inv("tables.create", { matter_id: matterId, template: "contract_ledger", columns: ["contract_name", "signed_on"], document_version_ids: [ids.doc] })).table.table_id;
  ids.user = tk.kernel.db.get<{ created_by: string }>(`SELECT created_by FROM matters WHERE matter_id = ?`, [matterId])!.created_by;
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

/** 按方法正文写明的形状给每个必需工具一组参数。 */
function argsFor(tool: string, skill: string): Record<string, unknown> {
  switch (tool) {
    case "materials.list":
    case "facts.list":
    case "riskcards.list":
    case "outline.get":
      return {};
    case "materials.read_excerpt":
      return { parse_version_id: ids.parse };
    case "facts.submit":
      return { facts: [{ statement: "买方于 2026 年 3 月 1 日签收全部货物", kind: "claimed", occurred_on: "2026-03-01" }] };
    case "docx.render_report":
      return { title: `${skill}（草稿）`, sections: [{ heading: "一、说明", paragraphs: ["草稿 · 待律师复核。"] }] };
    case "xlsx.render_table":
      return { title: `${skill}-表`, sheets: [{ name: "清单", columns: ["序号", "事项"], rows: [[1, "示例"]] }] };
    case "calc.interest":
      return { principal_yuan: 100000, start_date: "2026-01-01", end_date: "2026-02-01", rate: { kind: "fixed", annual_pct: 6 } };
    case "citations.verify":
      return { text: "依据《民法典》第五百八十五条", as_of: "2026-10-01" };
    case "law.get_version":
      return { law: "民法典", as_of: "2026-10-01" };
    case "law.search":
      return { query: "违约金" };
    case "riskcards.submit":
      return { document_version_id: skill === "redraft-review" ? ids.doc2 : ids.doc, cards: [{ kind: "risk", anchor_text: skill === "redraft-review" ? "买方应于验收合格后一百二十日内支付货款。" : "买方应于验收合格后九十日内支付货款。", severity: "mid", category: "commercial", rule_source: "general", issue: `【权利义务】${skill} 示例意见`, suggestion: "买方应于验收合格后六十日内支付货款。" }] };
    case "docx.compare":
      return { baseline_document_version_id: ids.doc, current_document_version_id: ids.doc2 };
    case "docx.revise":
      return { document_version_id: ids.doc, patches: [{ anchor: "九十日内支付货款", proposed_text: "六十日内支付货款", comment: `${skill} 示例修改` }] };
    case "table.get":
      return { table_id: ids.table };
    case "table.fill":
      return { table_id: ids.table, cells: [{ document_version_id: ids.doc, column: "contract_name", value: "采购合同", quote: "采购合同" }, { document_version_id: ids.doc, column: "signed_on", status: "not_found" }] };
    case "rules.propose":
      return { title: "本所采购合同标准（草稿）", rules: [{ topic: "付款", standard: "验收合格后六十日内付款", fallback: "不超过九十日", red_line: "不接受预付全款" }] };
    case "outline.submit":
      return { doc_kind: skill, arguments: [{ claim: "被告应支付货款", basis: [{ law: "中华人民共和国民法典", article: 509, note: "全面履行" }] }] };
    default:
      throw new Error(`契约用例没有为工具 ${tool} 准备参数：新方法用到新工具时在这里补上`);
  }
}

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c ?? ""));

test("文书类方法都标了 requires_outline（起诉状、答辩状、代理词、研究备忘录；第 21 批：上诉状、仲裁申请书、财产保全、强制执行申请书；评审 S3：劳动仲裁申请书与答辩书）", () => {
  for (const id of ["pleading-draft", "defense-draft", "agency-statement", "legal-research-memo", "appeal-draft", "arbitration-application", "preservation-application", "enforcement-application", "labor-arbitration-draft"]) assert.ok(DRAFTING.has(id), id);
});

test("劳动仲裁申请书与答辩书（评审 S3）：参数先问文书类型；答辩期按工作日算的参数形状在期间工具上走得通", async () => {
  assert.ok(manifest.skills.some((s) => s.id === "labor-arbitration-draft"), "方法包里有劳动仲裁文书方法");
  assert.deepEqual(frontArgs("labor-arbitration-draft"), ["doc_kind", "side", "received_on", "claims"]);
  const body = readFileSync(repo("content/skills/labor-arbitration-draft/SKILL.md"), "utf8");
  assert.match(body, /rule = workday/, "答辩期十日按工作日（办案规则第八十条）交期间工具");
  assert.match(body, /不收费/, "劳动争议仲裁不收费，核对清单不写仲裁费");
  // 方法写的答辩期调用形状：start = 收到副本日，period = 10 个工作日，rule = workday
  const tool = TOOLS.find((t) => t.name === "calc.deadline")!;
  const r = (await tool.invoke({ start: "2026-09-28", period: { unit: "workday", n: 10 }, rule: "workday" }, {} as any)) as { deadline?: string | null };
  assert.match(String(r.deadline), /^\d{4}-\d{2}-\d{2}$/, JSON.stringify(r).slice(0, 300));
  assert.ok(String(r.deadline) >= "2026-10-12", `十个工作日不会早于按自然日算的结果：${r.deadline}`);
});

test("方法包里每个方法都有契约用例的参数准备（新增方法或工具时这里先失败）", () => {
  assert.ok(manifest.skills.length >= 22);
  for (const s of manifest.skills) for (const t of s.tools_required) assert.doesNotThrow(() => argsFor(t, s.id), `${s.id} → ${t}`);
});

for (const s of manifest.skills) {
  test(`契约：${s.id}（${s.title}）`, { timeout: 200_000 }, async () => {
    const marker = `SKC${s.id.replace(/-/g, "").toUpperCase()}`;
    const args = frontArgs(s.id);
    const skillArgs = s.id === "tabular-review" ? { table_id: ids.table } : args[0] ? { [args[0]]: "契约测试" } : undefined;
    // 文书类：Skill → 论点提纲 → 确认题 → 读确认版 → 其余必需工具（文书在最后）；其他：Skill → 必需工具
    const required = [...s.tools_required];
    const writes = required.filter((t) => t === "docx.render_report");
    const steps: { name: string; args: Record<string, unknown> }[][] = [[{ name: "Skill", args: { skill: s.id } }]];
    if (DRAFTING.has(s.id)) {
      steps.push([{ name: mcp("outline.submit"), args: argsFor("outline.submit", s.id) }]);
      steps.push([{ name: "AskUserQuestion", args: { questions: [{ question: "论点与依据已列在任务页，请确认后选择", header: "论点", options: [{ label: "已确认，按确认的论点起草", description: "" }, { label: "先不起草", description: "" }], multi_select: false }] } }]);
      steps.push([{ name: mcp("outline.get"), args: {} }]);
      if (writes.length === 0) required.push("docx.render_report");
    }
    for (const t of required.filter((t) => t !== "docx.render_report")) steps.push([{ name: mcp(t), args: argsFor(t, s.id) }]);
    for (const t of required.filter((t) => t === "docx.render_report")) steps.push([{ name: mcp(t), args: argsFor(t, s.id) }]);

    let firstUser = "";
    let skillBody = "";
    const results = new Map<string, string>();
    cloud.model.script = (body) => {
      const first = text(msgs(body).find((m) => m.role === "user")?.content);
      if (!first.includes(marker)) return null;
      firstUser ||= first;
      for (const m of msgs(body)) if (m.role === "tool" && typeof m.tool_call_id === "string") results.set(m.tool_call_id, text(m.content));
      for (let i = 0; i < steps.length; i++) {
        const pending = steps[i]!.map((c, j) => ({ id: `skc_${i}_${j}`, name: c.name, args: c.args })).filter((c) => !results.has(c.id));
        if (pending.length > 0) return { toolCalls: pending };
      }
      return { content: `${s.id} 黄金路径完成。` };
    };
    try {
      const est = await tk.inv("runs.estimate", { matter_id: matterId, scenario: "a1.agent_task", document_version_ids: [ids.doc] });
      const run = await tk.inv("runs.start", {
        matter_id: matterId,
        estimate_id: est.estimate_id,
        idempotency_key: `skc-${s.id}-${Date.now()}`,
        goal: `${marker} 按方法完成`,
        skill: s.id,
        ...(skillArgs ? { skill_args: skillArgs } : {}),
        plan_first: false,
        mode: "default",
      });
      const fin = await waitRunAnswering(
        tk.inv,
        run.run_id,
        () => ({ decision: "approve", scope: "once" }),
        180_000,
        (q) => {
          // 与任务页同一顺序：先记下律师对提纲的决定，再答确认题
          const o = latestOutline(tk.kernel.db, run.run_id);
          if (o && o.status === "proposed") decideOutline(tk.kernel.db, matterId, ids.user, { outline_id: o.outline_id, decisions: o.items.map((x) => ({ arg_id: x.arg_id, keep: true })) });
          const one = q.questions[0];
          return { [one.id]: { kind: "single", option_id: one.options[0].id } };
        },
      );
      assert.equal(fin.run.status, "succeeded", `${s.id}：${JSON.stringify(fin.events.map((e: any) => e.type))}`);
      // 1. 方法参数到达模型；Skill 工具拿到的是这个方法的正文
      if (skillArgs) assert.match(firstUser, new RegExp(`方法参数：${Object.keys(skillArgs)[0]}=`), `${s.id}：方法参数应写进模型看到的说明`);
      skillBody = results.get("skc_0_0") ?? "";
      assert.ok(skillBody.includes(s.title.split("（")[0]!.split(" ·")[0]!) || skillBody.includes(s.id), `${s.id}：Skill 工具应返回该方法正文（${skillBody.slice(0, 120)}）`);
      // 2. 每个必需工具都调用成功
      for (let i = 1; i < steps.length; i++) {
        const c = steps[i]![0]!;
        if (c.name === "AskUserQuestion") continue;
        const r = results.get(`skc_${i}_0`);
        assert.ok(r !== undefined, `${s.id} → ${c.name}：没有拿到工具结果`);
        assert.doesNotMatch(r!, TOOL_FAILED, `${s.id} → ${c.name} 失败：${r!.slice(0, 300)}`);
      }
      // 3. 产出落到律师能看到的地方
      const kinds = fin.artifacts.map((a: any) => a.kind);
      const want = (n: string) => required.filter((t) => t === n).length;
      assert.ok(kinds.filter((k: string) => k === "agent_report").length >= want("docx.render_report"), `${s.id}：文书成果`);
      assert.ok(kinds.filter((k: string) => k === "agent_table").length >= want("xlsx.render_table"), `${s.id}：表格成果`);
      if (required.includes("docx.revise")) assert.ok(kinds.includes("revision_draft") && kinds.includes("revision_clean"), `${s.id}：修订稿与清洁稿`);
      if (required.includes("riskcards.submit")) assert.ok(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM risk_cards WHERE run_id = ?`, [run.run_id])!.n >= 1, `${s.id}：风险卡进工作台`);
      if (required.includes("facts.submit")) assert.ok(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matter_facts WHERE run_id = ?`, [run.run_id])!.n >= 1, `${s.id}：事实进事实标签`);
      if (required.includes("rules.propose")) assert.ok(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matter_review_rules WHERE run_id = ? AND status = 'draft'`, [run.run_id])!.n >= 1, `${s.id}：审查要点草稿交律师审定`);
      if (required.includes("table.fill")) assert.ok(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM review_cells WHERE run_id = ?`, [run.run_id])!.n >= 1, `${s.id}：审阅表格子写入`);
      if (DRAFTING.has(s.id)) assert.equal(latestOutline(tk.kernel.db, run.run_id)?.status, "confirmed", `${s.id}：论点提纲经确认后才出文书`);
      // 走完确认的黄金路径：最终回复登记的草稿不带“论点未经确认”
      for (const a of fin.artifacts) assert.ok(!JSON.stringify(a.open_items ?? []).includes("outline_unconfirmed"), `${s.id}：${a.kind} 不应标论点未经确认`);
    } finally {
      cloud.model.script = null;
    }
  });
}

test("反向：文书类方法跳过论点确认直接出文书，会被拦下（契约用例能发现漏掉的确认步骤）", { timeout: 200_000 }, async () => {
  const marker = "SKCNOCONFIRM";
  const results = new Map<string, string>();
  const steps = [
    [{ id: "n1", name: mcp("outline.submit"), args: argsFor("outline.submit", "pleading-draft") }],
    [{ id: "n2", name: mcp("docx.render_report"), args: argsFor("docx.render_report", "pleading-draft") }],
  ];
  cloud.model.script = (body) => {
    if (!text(msgs(body).find((m) => m.role === "user")?.content).includes(marker)) return null;
    for (const m of msgs(body)) if (m.role === "tool" && typeof m.tool_call_id === "string") results.set(m.tool_call_id, text(m.content));
    for (const st of steps) {
      const pending = st.filter((c) => !results.has(c.id));
      if (pending.length) return { toolCalls: pending };
    }
    return { content: "完成。" };
  };
  try {
    const est = await tk.inv("runs.estimate", { matter_id: matterId, scenario: "a1.agent_task", document_version_ids: [ids.doc] });
    const run = await tk.inv("runs.start", { matter_id: matterId, estimate_id: est.estimate_id, idempotency_key: `skc-neg-${Date.now()}`, goal: `${marker} x`, skill: "pleading-draft", plan_first: false, mode: "default" });
    const fin = await waitRunAnswering(tk.inv, run.run_id, () => ({ decision: "approve", scope: "once" }), 180_000);
    assert.match(results.get("n2") ?? "", /还在等律师确认/);
    assert.match(results.get("n2") ?? "", TOOL_FAILED, "契约用例的失败判据认得出真实的工具失败");
    assert.doesNotMatch(results.get("n1") ?? "", TOOL_FAILED, "成功的调用不被误判");
    assert.equal(fin.artifacts.filter((a: any) => a.kind === "agent_report").length, 0);
  } finally {
    cloud.model.script = null;
  }
});

test("反向（复核 Q2-03）：文书类方法不交提纲直接出文书被拒；只写在最终回复里的文书标“论点未经确认”", { timeout: 200_000 }, async () => {
  const marker = "SKCNOOUTLINE";
  const results = new Map<string, string>();
  cloud.model.script = (body) => {
    if (!text(msgs(body).find((m) => m.role === "user")?.content).includes(marker)) return null;
    for (const m of msgs(body)) if (m.role === "tool" && typeof m.tool_call_id === "string") results.set(m.tool_call_id, text(m.content));
    if (!results.has("r1")) return { toolCalls: [{ id: "r1", name: mcp("docx.render_report"), args: argsFor("docx.render_report", "pleading-draft") }] };
    return { content: "民事起诉状（草稿）\n诉讼请求：一、判令被告支付货款。" };
  };
  try {
    const est = await tk.inv("runs.estimate", { matter_id: matterId, scenario: "a1.agent_task", document_version_ids: [ids.doc] });
    const run = await tk.inv("runs.start", { matter_id: matterId, estimate_id: est.estimate_id, idempotency_key: `skc-noo-${Date.now()}`, goal: `${marker} x`, skill: "pleading-draft", plan_first: false, mode: "default" });
    const fin = await waitRunAnswering(tk.inv, run.run_id, () => ({ decision: "approve", scope: "once" }), 180_000);
    assert.match(results.get("r1") ?? "", /先用 outline\.submit 提交论点与依据/);
    assert.equal(fin.artifacts.filter((a: any) => a.kind === "agent_report").length, 0);
    const draft = fin.artifacts.find((a: any) => a.kind === "a1_agent_draft");
    assert.ok(draft, "最终回复登记为草稿");
    const row = tk.kernel.db.get<{ open_items: string }>(`SELECT open_items FROM artifact_versions WHERE artifact_version_id = ?`, [draft.artifact_version_id])!;
    assert.match(row.open_items, /outline_unconfirmed/, "论点未经确认的标未决项，签发前须处理");
  } finally {
    cloud.model.script = null;
  }
});
