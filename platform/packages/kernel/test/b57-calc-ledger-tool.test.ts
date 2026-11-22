/**
 * calc.ledger 经本机端点真实调用（第 57 批，D-228）：登记与锁文件、几个口径一次算完、直接成表并登记为成果、
 * 表里的数字与返回值相同且带公式、算出来的工作表不能逐格改（只许换说法）、改参数重调成为同名新版本。
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
  tk = await makeKernel({}, "calc-ledger-firm");
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
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r).slice(0, 800)}`);
    return r.result.structuredContent;
  };
  return { live, raw, call, close: () => agent.close() };
}

function sheetsOf(artifactVersionId: string) {
  const row = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [artifactVersionId]);
  assert.ok(row, "成果在");
  const s = readCreatedXlsx(tk.kernel.blobs.read(row!.storage_uri));
  assert.ok(s, "能读回");
  return s!;
}

const DEBTS = [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }];
const PAYS = [
  { date: "2025-12-26", amount_yuan: 300_000, note: "银行回单" },
  { date: "2026-03-10", amount_yuan: 200_000 },
];
const RATE = { kind: "daily", per_10k: 5 };
const TWO = [
  { name: "口径一：付款冲本金", as_of: "2026-11-30", debts: DEBTS, payments: PAYS, rate: RATE, allocation: "principal_only" },
  { name: "口径二：先冲违约金", as_of: "2026-11-30", debts: DEBTS, payments: PAYS, rate: RATE },
];

test("calc.ledger 已登记、锁文件一致、对 Agent 开放", () => {
  assert.ok((LEGAL_MCP_TOOLS as readonly string[]).includes("calc.ledger"));
  assert.ok(findTool("calc.ledger"));
  assert.equal(legalToolLockProblems().has("calc.ledger"), false, String(legalToolLockProblems().get("calc.ledger")));
});

test("不给 title：只算不成表；两个口径各自的合计与手算一致", async () => {
  const { matter: m } = await tk.inv("matters.create", { title: "台账只算", stance: "原告", consent_status: "agreed" });
  const a = await agentFor(m.matter_id, "ledger-pure");
  try {
    const r = await a.call("calc.ledger", { scenarios: TWO });
    assert.equal(r.workbook, undefined);
    assert.deepEqual(r.scenarios.map((s: any) => s.totals.total_outstanding_yuan), [379_010, 383_078.26]);
    assert.match(r.scenarios[1].summary, /本金余额 338,109\.67 元.*未付 44,968\.59 元.*合计 383,078\.26 元/);
    // 参数错：按口径指出是第几个
    const bad = await a.raw("calc.ledger", { scenarios: [TWO[0], { ...TWO[1], debts: [{ label: "验收款", amount_yuan: 810_000 }] }] });
    assert.equal(bad.result?.isError, true);
    assert.match(JSON.stringify(bad), /第 2 个口径/);
  } finally {
    await a.close();
  }
});

test("给 title：直接成表登记为成果；表里的数与返回值相同、带公式；算出来的表不能逐格改；重调成为新版本", async () => {
  const { matter: m } = await tk.inv("matters.create", { title: "台账成表", stance: "原告", consent_status: "agreed" });
  const a = await agentFor(m.matter_id, "ledger-book");
  try {
    const r = await a.call("calc.ledger", {
      title: "计算明细-锐川诉禾丰-截至2026-11-30",
      scenarios: TWO,
      notes: [{ item: "违约金比例", value: "日万分之五", source: "《设备买卖合同》第 9.2 条", status: "【待确认】" }],
      extra_sheets: [{ name: "诉讼费预估", columns: ["项目", "金额（元）"], rows: [["案件受理费（全额）", 6_985.15]] }],
    });
    const wb = r.workbook;
    assert.ok(wb?.artifact_version_id, JSON.stringify(r).slice(0, 400));
    assert.equal(wb.filename, "计算明细-锐川诉禾丰-截至2026-11-30.xlsx");
    assert.equal(wb.quality_check?.ok ?? wb.quality_check?.issues?.length === 0, true, JSON.stringify(wb.quality_check));
    const sheets = sheetsOf(wb.artifact_version_id);
    assert.deepEqual(sheets.map((s) => s.name), ["汇总", "分段计算1", "付款与抵扣1", "分段计算2", "付款与抵扣2", "参数与假设", "诉讼费预估"]);
    const sum = sheets[0]!;
    const row = (label: string) => sum.rows.find((x) => x[0] === label)!;
    assert.deepEqual(row("未清偿合计（元）").slice(1), [379_010, 383_078.26]);
    assert.deepEqual(row("利息（违约金）未付（元）").slice(1), [69_010, 44_968.59]);
    assert.ok(Object.values(sum.formulas ?? {}).length >= 4, "汇总带公式");
    const seg2 = sheets[3]!;
    assert.deepEqual(seg2.rows.slice(1).map((x) => x[9]), [8_910, 19_199.67, 44_968.59, 73_078.26]);
    assert.equal(seg2.formulas?.J5, "SUM(J2:J4)");
    assert.equal(seg2.formulas?.J3, "ROUND(G3*H3*F3,2)");
    assert.ok(sheets[5]!.rows.some((x) => x[1] === "违约金比例" && x[4] === "【待确认】"), "模型写的出处进了参数与假设");

    // 算出来的工作表逐格改被退回；自己写的附表可以改；换说法可以
    const edit = await a.raw("xlsx.edit_cells", { artifact_version_id: wb.artifact_version_id, edits: [{ sheet: "汇总", row: 9, column: "口径二：先冲违约金", value: 411_187.93 }] });
    assert.match(JSON.stringify(edit), /calc\.ledger 算出来的工作表/);
    const ok = await a.call("xlsx.edit_cells", { artifact_version_id: wb.artifact_version_id, edits: [{ sheet: "诉讼费预估", row: 1, column: "金额（元）", value: 7_435.15 }], replace: [{ find: "银行回单", with: "银行回单（尾号 1234）" }] });
    const after = sheetsOf(ok.artifact_version_id);
    assert.equal(after[6]!.rows[1]![1], 7_435.15);
    assert.equal(after[3]!.formulas?.J5, "SUM(J2:J4)", "改别的表不丢公式");
    assert.deepEqual(after[0]!.rows.find((x) => x[0] === "未清偿合计（元）")!.slice(1), [379_010, 383_078.26]);

    // 改参数重调：同名新版本
    const again = await a.call("calc.ledger", { title: "计算明细-锐川诉禾丰-截至2026-11-30", scenarios: [{ ...TWO[0], as_of: "2026-11-09" }] });
    assert.equal(again.workbook.filename, wb.filename);
    const versions = tk.kernel.db.all<{ version: number }>(`SELECT version FROM artifact_versions WHERE run_id = ? AND filename = ? ORDER BY version`, [a.live.rid, wb.filename]);
    assert.deepEqual(versions.map((v) => v.version), [1, 2, 3], "成表、逐格改、改参数重调：同一份文件的三个版本");
    assert.equal(again.scenarios[0].totals.interest_accrued_yuan, 65_755);
  } finally {
    await a.close();
  }
});
