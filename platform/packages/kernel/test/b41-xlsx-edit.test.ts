/**
 * V16 第 41 批：xlsx.edit_cells——在本任务已生成的表格上逐格修改；事实有了律师看得懂的序号（事实 N）。
 * 真实走查（争点与证据分析，方法 issue-evidence-matrix）：5 张工作表、97 行的表格，交付前检查报出“事实编号”列里的 fct_… 内部编号与几处用语，
 * 只能整份重出（每次约 1.5 万 token、4～5 分钟），前后 4 次撞上 40 分钟时限只交出半成品。
 * - 经本机端点真实调用：逐格改、替换、追加、删除各一例，读回新版本文件核对；定位不到的逐条退回、其余照改；全部定位不到不登记新版本；
 * - 别的任务、别的事项的成果拒绝；改完是同名新版本、旧版本仍在；把 fct_… 替换成“事实 N”后交付前检查由不通过变通过；
 * - facts.list 的 no / ref 稳定：新增、驳回事实后旧序号不变。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";
import { readCreatedXlsx } from "@zr-legal/docx-engine";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { findTool, legalToolLockProblems } from "../src/tools/registry.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "xlsx-edit-firm");
});
after(async () => {
  await tk.kernel.close();
});

async function agentFor(matterId: string, label: string) {
  const { Agent, fetch } = await import("undici");
  const live = liveTaskIdentity(tk, matterId, label);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const raw = async (name: string, args: unknown) =>
    (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
  const call = async (name: string, args: unknown) => {
    const r = await raw(name, args);
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r).slice(0, 600)}`);
    return r.result.structuredContent;
  };
  return { live, raw, call, close: () => agent.close() };
}

/** 读回某个成果版本的表格文件（直接读本机存储，不经导出还原）。 */
function sheetsOf(artifactVersionId: string) {
  const row = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [artifactVersionId]);
  assert.ok(row, "成果在");
  const s = readCreatedXlsx(tk.kernel.blobs.read(row!.storage_uri));
  assert.ok(s, "能读回");
  return s!;
}

const MATRIX = {
  title: "争点—证据矩阵",
  sheets: [
    {
      name: "要件矩阵",
      columns: ["序号", "要件", "事实编号", "证据（材料名称·位置）", "覆盖评估"],
      rows: [
        [1, "买卖合同成立", "fct_23fc2eb2-7a1c-4d2e-9b10-5c6d7e8f9a0b", "《购销合同》第 1 页", "已有"],
        [2, "已交付货物", "fct_23fc2eb2-7a1c-4d2e-9b10-5c6d7e8f9a0b", "《送货单》第 2 页", "已有"],
        [3, "欠付货款金额", "事实 3", "《对账函》第 1 页", "薄弱"],
      ],
    },
    { name: "补证清单", columns: ["序号", "补证事项", "建议责任人"], rows: [[1, "调取付款回单原件", "承办律师"]] },
  ],
};

test("xlsx.edit_cells 已登记、锁文件一致、对 Agent 开放", () => {
  assert.ok((LEGAL_MCP_TOOLS as readonly string[]).includes("xlsx.edit_cells"));
  assert.ok(findTool("xlsx.edit_cells"));
  assert.equal(legalToolLockProblems().has("xlsx.edit_cells"), false, String(legalToolLockProblems().get("xlsx.edit_cells")));
  assert.equal(legalToolLockProblems().has("xlsx.render_table"), false, "表格生成工具的锁不受影响");
});

test("逐格改、替换、删行、追加：同名新版本、旧版本仍在；fct_ 内部编号替换后交付前检查由不通过变通过", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "买卖合同纠纷", stance: "原告", consent_status: "agreed" });
  const a = await agentFor(matter.matter_id, "edit");
  try {
    const t1 = await a.call("xlsx.render_table", MATRIX);
    assert.equal(t1.quality_check?.ok, false, "真实走查的情形：事实编号列写了内部编号");
    assert.ok(t1.quality_check.issues.some((i: any) => /要件矩阵表格第 1 行/.test(i.where) && /内部编号/.test(i.fix)), JSON.stringify(t1.quality_check.issues));

    // 替换：一次改完两格里的同一个内部编号
    const r1 = await a.call("xlsx.edit_cells", { artifact_version_id: t1.artifact_version_id, replace: [{ find: "fct_23fc2eb2-7a1c-4d2e-9b10-5c6d7e8f9a0b", with: "事实 1" }] });
    assert.equal(r1.status, "applied");
    assert.equal(r1.applied, 1);
    assert.deepEqual(r1.replaced, [{ index: 0, find: "fct_23fc2eb2-7a1c-4d2e-9b10-5c6d7e8f9a0b", count: 2 }]);
    assert.equal(r1.quality_check?.ok, true, JSON.stringify(r1.quality_check));
    assert.equal(r1.filename, "争点—证据矩阵.xlsx", "同名文件");
    assert.notEqual(r1.artifact_version_id, t1.artifact_version_id, "新版本");
    assert.equal(sheetsOf(r1.artifact_version_id)[0]!.rows[1]![2], "事实 1");
    assert.equal(sheetsOf(t1.artifact_version_id)[0]!.rows[1]![2], "fct_23fc2eb2-7a1c-4d2e-9b10-5c6d7e8f9a0b", "旧版本仍在、未改");
    const versions = tk.kernel.db.all<{ version: number }>(`SELECT version FROM artifact_versions WHERE run_id = ? AND filename = ? ORDER BY version`, [a.live.rid, "争点—证据矩阵.xlsx"]);
    assert.deepEqual(versions.map((v) => v.version), [1, 2]);

    // 逐格改：行号是数据行号（不含表头），与交付前检查的“第 N 行”一致
    const r2 = await a.call("xlsx.edit_cells", { artifact_version_id: r1.artifact_version_id, edits: [{ sheet: "要件矩阵", row: 2, column: "事实编号", value: "事实 2" }, { sheet: "要件矩阵", row: 3, column: "覆盖评估", value: "已有" }, { sheet: "补证清单", row: 1, column: "序号", value: 7 }] });
    assert.equal(r2.status, "applied");
    assert.equal(r2.applied, 3);
    let s = sheetsOf(r2.artifact_version_id);
    assert.deepEqual(s[0]!.rows[2], [2, "已交付货物", "事实 2", "《送货单》第 2 页", "已有"]);
    assert.equal(s[0]!.rows[3]![4], "已有");
    assert.equal(s[1]!.rows[1]![0], 7);
    assert.deepEqual(s[0]!.rows[0], MATRIX.sheets[0]!.columns, "表头不动");

    // 删行与追加：行号按修改前的表格；先删后追加
    const r3 = await a.call("xlsx.edit_cells", {
      artifact_version_id: r2.artifact_version_id,
      delete_rows: [{ sheet: "要件矩阵", rows: [1] }],
      append_rows: [{ sheet: "补证清单", rows: [[2, "向银行调取转账流水", "委托人"], [3, "补充送货签收人身份说明"]] }],
    });
    assert.equal(r3.status, "applied");
    assert.equal(r3.applied, 3);
    s = sheetsOf(r3.artifact_version_id);
    assert.equal(s[0]!.rows.length, 3, "表头 + 2 行");
    assert.equal(s[0]!.rows[1]![1], "已交付货物");
    assert.equal(s[1]!.rows.length, 4);
    assert.deepEqual(s[1]!.rows[3]!.slice(0, 2), [3, "补充送货签收人身份说明"]);
  } finally {
    await a.close();
  }
});

test("定位不到的逐条退回、其余照改；全部定位不到不登记新版本；别的任务与别的事项的成果拒绝", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "买卖合同纠纷二", stance: "原告", consent_status: "agreed" });
  const { matter: other } = await tk.inv("matters.create", { title: "另一事项", stance: "被告", consent_status: "agreed" });
  const a = await agentFor(matter.matter_id, "partial");
  const b = await agentFor(matter.matter_id, "another-run");
  const c = await agentFor(other.matter_id, "other-matter");
  try {
    const t1 = await a.call("xlsx.render_table", MATRIX);
    const r = await a.call("xlsx.edit_cells", {
      artifact_version_id: t1.artifact_version_id,
      edits: [
        { sheet: "要件矩阵", row: 1, column: "覆盖评估", value: "薄弱" },
        { sheet: "要件表", row: 1, column: "覆盖评估", value: "x" },
        { sheet: "要件矩阵", row: 9, column: "覆盖评估", value: "x" },
        { sheet: "要件矩阵", row: 1, column: "评估", value: "x" },
      ],
      replace: [{ find: "没有这句话", with: "x" }, { find: "甲", with: "乙" }],
    });
    assert.equal(r.status, "partial");
    assert.equal(r.applied, 1);
    assert.equal(r.rejected.length, 5);
    const why = r.rejected.map((x: any) => x.reason).join("\n");
    assert.match(why, /没有名为“要件表”的工作表；这份表格的工作表：“要件矩阵”、“补证清单”/);
    assert.match(why, /“要件矩阵”共 3 行数据/);
    assert.match(why, /该表的列：“序号”、“要件”、“事实编号”/);
    assert.match(why, /没有找到“没有这句话”/);
    assert.match(why, /至少 2 个字/);
    assert.equal(sheetsOf(r.artifact_version_id)[0]!.rows[1]![4], "薄弱", "能定位的照改");

    const before = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifact_versions WHERE run_id = ?`, [a.live.rid])!.n;
    const none = await a.call("xlsx.edit_cells", { artifact_version_id: r.artifact_version_id, edits: [{ sheet: "要件矩阵", row: 0, column: "要件", value: "x" }] });
    assert.equal(none.status, "not_applied");
    assert.equal(none.artifact_version_id, undefined);
    assert.equal(none.rejected.length, 1);
    assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifact_versions WHERE run_id = ?`, [a.live.rid])!.n, before, "不登记新版本");

    const otherRun = await b.raw("xlsx.edit_cells", { artifact_version_id: t1.artifact_version_id, edits: [{ sheet: "要件矩阵", row: 1, column: "要件", value: "x" }] });
    assert.equal(otherRun.result?.isError, true);
    assert.match(JSON.stringify(otherRun), /只能修改本任务（含它所追问的此前各轮）里生成的表格/);
    const otherMatter = await c.raw("xlsx.edit_cells", { artifact_version_id: t1.artifact_version_id, edits: [{ sheet: "要件矩阵", row: 1, column: "要件", value: "x" }] });
    assert.equal(otherMatter.result?.isError, true);
    assert.match(JSON.stringify(otherMatter), /not_found/, "别的事项的成果按不存在处理（端点不透露是否存在）");
    const empty = await a.raw("xlsx.edit_cells", { artifact_version_id: t1.artifact_version_id });
    assert.equal(empty.result?.isError, true, "四类操作至少给一类");
    const doc = await a.call("docx.render_report", { title: "证据分析", sections: [{ heading: "一、结论", paragraphs: ["货款已交付。"] }] });
    const notTable = await a.raw("xlsx.edit_cells", { artifact_version_id: doc.artifact_version_id, edits: [{ sheet: "要件矩阵", row: 1, column: "要件", value: "x" }] });
    assert.equal(notTable.result?.isError, true, "Word 文书不能用表格工具改");
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});

test("facts.list 的事实序号（no / ref）稳定：新增、驳回事实后旧序号不变；facts.submit 顺带给出 ref", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "事实序号", stance: "原告", consent_status: "agreed" });
  const a = await agentFor(matter.matter_id, "facts");
  try {
    const sub = await a.call("facts.submit", {
      facts: [
        { statement: "双方于2026年3月1日签订购销合同", kind: "claimed", occurred_on: "2026-03-01" },
        { statement: "原告于2026年3月15日交付货物", kind: "claimed", occurred_on: "2026-03-15" },
        { statement: "被告于2026年2月20日发出询价函", kind: "claimed", occurred_on: "2026-02-20" },
      ],
    });
    assert.deepEqual(sub.facts.map((f: any) => f.ref), ["事实 1", "事实 2", "事实 3"]);
    const l1 = await a.call("facts.list", {});
    const refOf = (l: any, st: RegExp) => l.facts.find((f: any) => st.test(f.statement))?.ref;
    assert.equal(refOf(l1, /签订购销合同/), "事实 1");
    assert.equal(refOf(l1, /询价函/), "事实 3", "按写入先后编号，不按日期");
    assert.match(l1.note, /交付件里引用事实写 ref/);

    const delivered = l1.facts.find((f: any) => /交付货物/.test(f.statement));
    await tk.inv("facts.decide", { matter_id: matter.matter_id, fact_id: delivered.fact_id, decision: "reject" });
    await a.call("facts.submit", { facts: [{ statement: "被告于2026年4月1日部分付款", kind: "claimed", occurred_on: "2026-04-01" }] });
    const l2 = await a.call("facts.list", {});
    assert.equal(refOf(l2, /签订购销合同/), "事实 1");
    assert.equal(refOf(l2, /询价函/), "事实 3", "驳回别的事实后序号不变");
    assert.equal(refOf(l2, /部分付款/), "事实 4", "新事实接着编，驳回的那条仍占号");
    assert.equal(refOf(l2, /交付货物/), undefined, "驳回的不再列给助手");
    const all = await tk.inv("facts.list", { matter_id: matter.matter_id });
    assert.equal(all.facts.find((f: any) => f.fact_id === delivered.fact_id)?.no, 2, "事实页看得到同一序号");
  } finally {
    await a.close();
  }
});

test("表格最多 12 张工作表（V16 第 41 批：“管辖与时效核查”要 6 张，上限 5 张时助手改用脚本自己拼 xlsx）：12 张照常生成、改第 12 张、预览全部显示；13 张退回", { timeout: 120_000 }, async () => {
  const { renderXlsxHtml } = await import("@zr-legal/docx-engine");
  const { matter } = await tk.inv("matters.create", { title: "管辖与时效核查", stance: "原告", consent_status: "agreed" });
  const a = await agentFor(matter.matter_id, "sheets12");
  try {
    const sheets = Array.from({ length: 12 }, (_, i) => ({ name: `第${i + 1}表`, columns: ["序号", "事项"], rows: [[1, `第${i + 1}张表的内容`]] }));
    const t = await a.call("xlsx.render_table", { title: "管辖与时效核查表", sheets });
    assert.ok(t.artifact_version_id, JSON.stringify(t).slice(0, 400));
    assert.equal(sheetsOf(t.artifact_version_id).length, 12);
    const e = await a.call("xlsx.edit_cells", { artifact_version_id: t.artifact_version_id, edits: [{ sheet: "第12表", row: 1, column: "事项", value: "改过的第12张" }] });
    assert.equal(e.status, "applied", JSON.stringify(e));
    const back = sheetsOf(e.artifact_version_id);
    assert.equal(back.length, 12);
    assert.ok(JSON.stringify(back[11]).includes("改过的第12张"), JSON.stringify(back[11]));
    const row = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [e.artifact_version_id])!;
    const prev = renderXlsxHtml(tk.kernel.blobs.read(row.storage_uri));
    assert.equal(prev.sheets, 12);
    assert.match(prev.html, /改过的第12张/);
    const over = await a.raw("xlsx.render_table", { title: "过多", sheets: [...sheets, { name: "第13表", columns: ["序号"], rows: [[1]] }] });
    assert.match(JSON.stringify(over), /1–12/);
  } finally {
    await a.close();
  }
});
