/**
 * 第 70 批（V44）：“套餐与用量”最近记录在本机对回“哪件事项的哪个任务”（services/usage-where.ts）。
 * - 云端带回请求编号（1.5.1 起）：按本机去向记录的 request_id 精确对上，换成卡片名 + 事项名；问答换成会话标题；
 * - 旧云端没有编号：按“同一类 + 读入与写出 token 都相同 + 本机记录在这一行之前 45 分钟内开始”对，取最近的一条、每条只对一行；估算 / 中断的行不猜；
 * - this_device = false → elsewhere；不是本人的事项（不是成员 / 已删除）与别人的问答会话不显示；迁移 0075 建了 request_id 索引。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelDb } from "../src/db.ts";
import { usageWhereOf, withUsageWhere } from "../src/services/usage-where.ts";

const T = "ten_x";
const ME = "usr_x_me";
const OTHER = "usr_x_other";

function setup() {
  const db = new KernelDb(join(mkdtempSync(join(tmpdir(), "kwl-b70-uw-")), "l.db"));
  db.migrate();
  db.db.pragma("foreign_keys = OFF");
  const matter = (id: string, title: string, member: string | null, lifecycle = "active") => {
    db.run(`INSERT INTO matters (matter_id, tenant_id, title, stance, created_by, lifecycle) VALUES (?,?,?,?,?,?)`, [id, T, title, "原告", ME, lifecycle]);
    if (member) db.run(`INSERT INTO matter_members (matter_id, user_id, matter_role, added_by) VALUES (?,?,?,?)`, [id, member, "owner", ME]);
  };
  const run = (id: string, mid: string, snap: Record<string, unknown>) =>
    db.run(`INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, created_by, input_snapshot) VALUES (?,?,?,?,?,?,?,?,?)`, [id, T, mid, "a1.agent_task", "1", "succeeded", `k-${id}`, ME, JSON.stringify(snap)]);
  let n = 0;
  const egress = (requestId: string, matterId: string, runId: string, at: string, usage: { input: number; output: number } | null, purpose = "model") =>
    db.run(`INSERT INTO egress_records (record_id, tenant_id, matter_id, run_id, destination_kind, destination_host, request_id, note, outcome, created_at, completed) VALUES (?,?,?,?,?,?,?,?,?,?,1)`, [
      `egr_${++n}`,
      T,
      matterId,
      runId,
      "legal_gateway",
      "gw.example",
      requestId,
      JSON.stringify({ purpose, ...(usage ? { usage: { ...usage, cached: 0, cacheWrite: 0, reasoning: 0 } } : {}) }),
      "sent",
      at,
    ]);
  matter("mat_a", "锐川诉禾丰设备买卖合同纠纷", ME);
  matter("mat_b", "别人的事项", OTHER);
  matter("mat_c", "已删除的事项", ME, "purged");
  run("run_a", "mat_a", { title: "诉讼成本与回收测算", skill: "litigation-budget" });
  run("run_free", "mat_a", { goal: "请帮我把这份合同的违约条款逐条整理一下并给出意见" });
  run("run_b", "mat_b", { title: "起草起诉状" });
  run("run_c", "mat_c", { title: "合同审查" });
  db.run(`INSERT INTO qa_conversations (conversation_id, tenant_id, user_id, title, token_key_b64) VALUES (?,?,?,?,?)`, ["qa_1", T, ME, "买卖合同纠纷的诉讼时效从什么时候起算？", "k"]);
  db.run(`INSERT INTO qa_conversations (conversation_id, tenant_id, user_id, title, token_key_b64) VALUES (?,?,?,?,?)`, ["qa_2", T, OTHER, "别人的问答", "k"]);
  return { db, egress };
}

const at = (base: number, min: number) => new Date(base + min * 60_000).toISOString();
const BASE = Date.parse("2026-11-26T06:00:00Z");

test("按编号精确对上：任务 → 卡片名 + 事项名；问答 → 会话标题；自由描述的任务取说明开头；别人的、已删除的、别人的问答不显示", () => {
  const { db, egress } = setup();
  egress("kwlg_aaaaaaaa-0001", "mat_a", "run_a", at(BASE, 0), { input: 1000, output: 100 });
  egress("kwlg_aaaaaaaa-0002", "mat_a", "run_free", at(BASE, 1), { input: 2000, output: 200 });
  egress("kwlg_aaaaaaaa-0003", "qa_1", "qa_1", at(BASE, 2), { input: 300, output: 30 }, "qa");
  egress("kwlg_aaaaaaaa-0004", "mat_b", "run_b", at(BASE, 3), { input: 400, output: 40 });
  egress("kwlg_aaaaaaaa-0005", "mat_c", "run_c", at(BASE, 4), { input: 500, output: 50 });
  egress("kwlg_aaaaaaaa-0006", "qa_2", "qa_2", at(BASE, 5), { input: 600, output: 60 }, "qa");
  const rows = [
    { at: at(BASE, 1), kind: "task" as const, client_request_id: "kwlg_aaaaaaaa-0001", this_device: true },
    { at: at(BASE, 2), kind: "task" as const, client_request_id: "kwlg_aaaaaaaa-0002", this_device: true },
    { at: at(BASE, 3), kind: "qa" as const, client_request_id: "kwlg_aaaaaaaa-0003", this_device: true },
    { at: at(BASE, 4), kind: "task" as const, client_request_id: "kwlg_aaaaaaaa-0004", this_device: true },
    { at: at(BASE, 5), kind: "task" as const, client_request_id: "kwlg_aaaaaaaa-0005", this_device: true },
    { at: at(BASE, 6), kind: "qa" as const, client_request_id: "kwlg_aaaaaaaa-0006", this_device: true },
    { at: at(BASE, 7), kind: "task" as const, client_request_id: "kwlg_bbbbbbbb-0009", this_device: false },
    { at: at(BASE, 8), kind: "task" as const, client_request_id: "kwlg_not-in-local", this_device: true },
  ];
  const w = usageWhereOf(db, { tenantId: T, userId: ME }, rows);
  assert.deepEqual(w[0], { task: "诉讼成本与回收测算", matter: "锐川诉禾丰设备买卖合同纠纷", matter_id: "mat_a", run_id: "run_a", conversation_id: null, how: "id" });
  assert.equal((w[1] as any).task, "请帮我把这份合同的违约条款逐…", "自由描述的任务取说明开头 14 个字");
  assert.deepEqual(w[2], { task: "问答", matter: "买卖合同纠纷的诉讼时效从什么时候起算？", matter_id: null, run_id: null, conversation_id: "qa_1", how: "id" });
  assert.equal(w[3], null, "不是本人是成员的事项不显示");
  assert.equal(w[4], null, "已删除的事项不显示");
  assert.equal(w[5], null, "别人的问答会话不显示");
  assert.deepEqual(w[6], { elsewhere: true });
  assert.equal(w[7], null, "本机没有这条记录（例如重装过）");
  // withUsageWhere：不改原数组，对不上的行不加 where
  const out = withUsageWhere(db, { tenantId: T, userId: ME }, rows)!;
  assert.ok(!("where" in rows[0]!));
  assert.ok("where" in out[0]! && !("where" in out[3]!));
});

test("旧云端没有编号：按同一类 + 读入写出 token 相同 + 时刻对上，取最近、每条本机记录只对一行；估算与中断的行不猜", () => {
  const { db, egress } = setup();
  // 两条本机记录 token 相同（同一任务连着两次调用），一条问答 token 也相同但类别不同
  egress("kwlg_cccccccc-0001", "mat_a", "run_a", at(BASE, 0), { input: 12_345, output: 678 });
  egress("kwlg_cccccccc-0002", "mat_a", "run_a", at(BASE, 10), { input: 12_345, output: 678 });
  egress("kwlg_cccccccc-0003", "qa_1", "qa_1", at(BASE, 11), { input: 12_345, output: 678 }, "qa");
  egress("kwlg_cccccccc-0004", "mat_a", "run_free", at(BASE, -120), { input: 999, output: 9 });
  const rows = [
    { at: at(BASE, 11), kind: "task" as const, tokens_in: 12_345, tokens_out: 678 },
    { at: at(BASE, 1), kind: "task" as const, tokens_in: 12_345, tokens_out: 678 },
    { at: at(BASE, 12), kind: "qa" as const, tokens_in: 12_345, tokens_out: 678 },
    { at: at(BASE, 0), kind: "task" as const, tokens_in: 999, tokens_out: 9 },
    { at: at(BASE, 2), kind: "task" as const, tokens_in: 12_345, tokens_out: 678, estimated: true },
    { at: at(BASE, 3), kind: "task" as const, tokens_in: 555, tokens_out: 5 },
  ];
  const w = usageWhereOf(db, { tenantId: T, userId: ME }, rows) as any[];
  assert.equal(w[0].run_id, "run_a");
  assert.equal(w[0].how, "match");
  assert.equal(w[1].run_id, "run_a", "第二条同 token 的行对到另一条本机记录");
  assert.equal(w[2].conversation_id, "qa_1", "问答只对问答");
  assert.equal(w[3], null, "本机记录比这一行早 2 小时：超出 45 分钟窗口不对");
  assert.equal(w[4], null, "估算的行不猜");
  assert.equal(w[5], null, "token 对不上的不猜");
  // 编号为 null（新云端但这一行没有编号，例如旧网关）同样按 token 对
  const w2 = usageWhereOf(db, { tenantId: T, userId: ME }, [{ at: at(BASE, 11), kind: "task", client_request_id: null, tokens_in: 12_345, tokens_out: 678 }]) as any[];
  assert.equal(w2[0].run_id, "run_a");
});

test("查不了本机账本时不影响用量页（照旧只写任务 / 问答）", () => {
  const broken = { all: () => { throw new Error("db closed"); } } as unknown as KernelDb;
  const rows = [{ at: at(BASE, 0), kind: "task" as const, client_request_id: "kwlg_dddddddd-0001" }];
  assert.deepEqual(withUsageWhere(broken, { tenantId: T, userId: ME }, rows), [{ ...rows[0] }]);
  assert.equal(withUsageWhere(broken, { tenantId: T, userId: ME }, undefined), undefined);
});
