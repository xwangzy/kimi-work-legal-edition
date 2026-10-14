/**
 * 运行档位的独立强制（复核 B3-B01 / B3-B09）：
 * - 问答档（chat）的任务：本机端点按任务记录里的档位独立拒绝写类工具（即使令牌声明了 write_draft），不留 outbox 行；
 * - 追问沿用上一轮档位：上一轮是问答档，追问不带档位 → 新一轮仍是问答档；要提高档位须明确确认，并留审计。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "run-mode-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("问答档任务：端点独立拒绝写类工具，读类照常；不留 outbox 行", { timeout: 60_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "问答档只读", stance: "原告", consent_status: "agreed" });
  const live = liveTaskIdentity(tk, matter.matter_id, "chat_mode");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "问答", run_options: { mode: "chat", plan_first: false, preauthorized: [] } }), live.rid]);
  // 令牌声明了 write_draft（模拟宿主出缺陷或被绕过）：端点不采信，按任务记录派生
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) =>
    (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;

  const read = await call("materials.list", {});
  assert.equal(read.result?.isError, false, JSON.stringify(read));
  for (const [name, args] of [
    ["riskcards.submit", { cards: [{ anchor_text: "x", severity: "low", issue: "示例" }] }],
    ["facts.submit", { facts: [{ statement: "示例事实" }] }],
    ["xlsx.render_table", { title: "表", columns: ["a"], rows: [["1"]] }],
  ] as const) {
    const r = await call(name, args);
    assert.equal(r.result?.isError, true, `${name} 应被拒绝：${JSON.stringify(r)}`);
    assert.match(r.result.content[0].text, /未授予副作用类别 write_draft/);
  }
  const ops = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tool_operations WHERE run_id = ? AND tool <> 'materials.list'`, [live.rid])!.n;
  assert.equal(ops, 0, "被拒绝的写类调用不留 outbox 行");
  assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM risk_cards WHERE run_id = ?`, [live.rid])!.n, 0);
  await agent.close();
});

test("追问沿用上一轮档位：问答档追问仍为问答档；提高档位须明确确认并留痕", { timeout: 60_000 }, async () => {
  const db = tk.kernel.db;
  const { matter } = await tk.inv("matters.create", { title: "追问档位", stance: "原告", consent_status: "agreed" });
  // 上一轮：本人发起、已完成的问答档 Agent 任务，有可继续的会话
  const prev = liveTaskIdentity(tk, matter.matter_id, "prev_chat");
  db.run(`UPDATE runs SET status = 'succeeded', input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "问答", run_options: { mode: "chat", plan_first: false, preauthorized: [] } }), prev.rid]);
  db.run(`UPDATE attempts SET status = 'succeeded' WHERE attempt_id = ?`, [prev.aid]);
  db.run(`INSERT INTO run_events (run_id, attempt_id, seq, type, payload) VALUES (?,?,?,?,?)`, [prev.rid, prev.aid, 1, "agent.started", JSON.stringify({ session_id: "sess_prev_chat_1" })]);

  const start = async (extra: Record<string, unknown>) => {
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [], goal: "再问一句" });
    return tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `idem-${Math.random().toString(36).slice(2)}-0001`, goal: "再问一句", plan_first: false, followup_of: prev.rid, ...extra });
  };
  const snapshotOf = (runId: string) => JSON.parse(db.get<{ input_snapshot: string }>(`SELECT input_snapshot FROM runs WHERE run_id = ?`, [runId])!.input_snapshot);

  // 不带档位：沿用问答档
  const r1 = await start({});
  assert.equal(snapshotOf(r1.run_id).run_options.mode, "chat");
  assert.equal(snapshotOf(r1.run_id).continue_session_id, "sess_prev_chat_1");
  await tk.inv("runs.cancel", { run_id: r1.run_id, expected_version: db.get<{ status_version: number }>(`SELECT status_version FROM runs WHERE run_id = ?`, [r1.run_id])!.status_version, reason: "测试" }).catch(() => {});

  // mode: null 与未给出同义（复核 C-B01）：仍沿用问答档，不静默升档
  const rNull = await start({ mode: null });
  assert.equal(snapshotOf(rNull.run_id).run_options.mode, "chat");
  await tk.inv("runs.cancel", { run_id: rNull.run_id, expected_version: db.get<{ status_version: number }>(`SELECT status_version FROM runs WHERE run_id = ?`, [rNull.run_id])!.status_version, reason: "测试" }).catch(() => {});
  // 要求更高档位但未确认：拒绝
  await assert.rejects(start({ mode: "default" }), (e: any) => e.code === "validation" && e.detail?.previous_mode === "chat");
  // 明确确认：允许，并留审计
  const r2 = await start({ mode: "default", mode_raise_confirmed: true });
  assert.equal(snapshotOf(r2.run_id).run_options.mode, "default");
  const ev = db.all<any>(`SELECT * FROM audit_events WHERE action = 'run.followup_mode_raised' AND object_id = ?`, [r2.run_id]);
  assert.equal(ev.length, 1);
  await tk.inv("runs.cancel", { run_id: r2.run_id, expected_version: db.get<{ status_version: number }>(`SELECT status_version FROM runs WHERE run_id = ?`, [r2.run_id])!.status_version, reason: "测试" }).catch(() => {});
});

test("追问的拒绝条件：上一轮仍在运行、他人发起的任务（复核 B3-B11）", { timeout: 60_000 }, async () => {
  const db = tk.kernel.db;
  const { matter } = await tk.inv("matters.create", { title: "追问条件", stance: "原告", consent_status: "agreed" });
  const start = async (prevRunId: string) => {
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [], goal: "追问" });
    return tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `idem-${Math.random().toString(36).slice(2)}-0002`, goal: "追问", followup_of: prevRunId });
  };
  // 上一轮仍在运行
  const running = liveTaskIdentity(tk, matter.matter_id, "still_running");
  db.run(`INSERT INTO run_events (run_id, attempt_id, seq, type, payload) VALUES (?,?,?,?,?)`, [running.rid, running.aid, 1, "agent.started", JSON.stringify({ session_id: "sess_running_1" })]);
  await assert.rejects(start(running.rid), (e: any) => e.code === "validation" && /已完成/.test(e.message));
  // 他人发起（同事项另一成员）
  const other = liveTaskIdentity(tk, matter.matter_id, "other_member");
  db.run(`UPDATE runs SET status = 'succeeded', created_by = 'usr_someone_else' WHERE run_id = ?`, [other.rid]);
  db.run(`INSERT INTO run_events (run_id, attempt_id, seq, type, payload) VALUES (?,?,?,?,?)`, [other.rid, other.aid, 1, "agent.started", JSON.stringify({ session_id: "sess_other_1" })]);
  await assert.rejects(start(other.rid), (e: any) => e.code === "forbidden");
  // 上一轮没有可继续的会话
  const nosess = liveTaskIdentity(tk, matter.matter_id, "no_session");
  db.run(`UPDATE runs SET status = 'succeeded' WHERE run_id = ?`, [nosess.rid]);
  await assert.rejects(start(nosess.rid), (e: any) => e.code === "validation" && /对话记录/.test(e.message));
});

