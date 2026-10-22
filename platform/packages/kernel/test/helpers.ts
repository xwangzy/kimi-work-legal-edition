/** 内核测试辅助：每文件一个临时工作区；mock 提供方（离线可跑）。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kernel } from "../src/index.ts";

/**
 * 测试夹具法规库（v9.4 第 19 批 S-07）：随包种子 + 虚构的《律师法》2026 修正本与 38→41 条号迁移，只用来测“改号拦截与改引建议”。
 * 随包法规库（content/lawdb/dist）不再含虚构版本；内核用例缺省用夹具，测随包内容的用例显式指 dist。
 */
export const LAWDB_FIXTURE = fileURLToPath(new URL("../../../content/lawdb/test-fixtures/lawdb-renumber-demo.sqlite", import.meta.url));
export const LAWDB_SHIPPED = fileURLToPath(new URL("../../../content/lawdb/dist/lawdb.sqlite", import.meta.url));

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "kwl-test-secret-0123456789abcdef";

export interface TestKernel {
  kernel: Kernel;
  dir: string;
  inv: (method: string, params?: Record<string, unknown>) => Promise<any>;
}

export async function makeKernel(env: Record<string, string> = {}, slug = "test-firm"): Promise<TestKernel> {
  const dir = mkdtempSync(join(tmpdir(), "kwl-test-"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({
    dataDir: dir,
    firmSlug: slug,
    userSlug: "test-lawyer",
    // 唯一引擎是 kap-host（K9-1：SDK 宿主已退役）；须跑通模型请求的用例另起云端 v0（cloud-v0.ts）并传其环境
    env: { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_LAWDB_FILE: process.env.ZR_LAWDB_FILE ?? LAWDB_FIXTURE, ...env },
  });
  return { kernel, dir, inv: (m, p) => kernel.invoke(m, p) };
}

export async function waitRun(inv: TestKernel["inv"], runId: string, timeoutMs = 60_000): Promise<{ run: any; artifacts: any[]; events: any[] }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await inv("runs.get", { run_id: runId });
    if (["succeeded", "partial", "failed", "cancelled", "timed_out", "expired", "reconciling"].includes(d.run.status)) {
      const ev = await inv("runs.events", { run_id: runId, limit: 500 });
      return { run: d.run, artifacts: d.artifacts, events: ev.events };
    }
    if (Date.now() > deadline) throw new Error(`任务 ${runId} 超时`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function importText(inv: TestKernel["inv"], matterId: string, filename: string, text: string): Promise<any> {
  const r = await inv("materials.import", { matter_id: matterId, filename, data_base64: Buffer.from(text, "utf8").toString("base64"), mime: "text/plain" });
  if (!r.document_version_id) throw new Error(JSON.stringify(r));
  return r;
}

export async function importBytes(inv: TestKernel["inv"], matterId: string, filename: string, buf: Buffer, mime: string): Promise<any> {
  const r = await inv("materials.import", { matter_id: matterId, filename, data_base64: buf.toString("base64"), mime });
  if (!r.document_version_id) throw new Error(JSON.stringify(r));
  return r;
}

export async function runScenario(inv: TestKernel["inv"], matterId: string, scenario: string, extra: Record<string, unknown>, timeoutMs = 60_000): Promise<{ run: any; artifacts: any[]; events: any[] }> {
  const est = await inv("runs.estimate", { matter_id: matterId, scenario, document_version_ids: [], ...extra });
  if (!est.estimate_id) throw new Error(`估价失败: ${JSON.stringify(est)}`);
  const run = await inv("runs.start", {
    matter_id: matterId,
    estimate_id: est.estimate_id,
    idempotency_key: `${scenario}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  if (!run.run_id) throw new Error(`起任务失败: ${JSON.stringify(run)}`);
  return waitRun(inv, run.run_id, timeoutMs);
}

export async function downloadArtifact(inv: TestKernel["inv"], artifactVersionId: string): Promise<Buffer> {
  const r = await inv("artifacts.download", { artifact_version_id: artifactVersionId });
  return Buffer.from(r.data_base64, "base64");
}

export const DEMO_CONTRACT = [
  "股权转让协议（示例文本）",
  "第七条 保密",
  "7.1 乙方应当遵守《律师法》第三十八条规定的保密义务，不得泄露在履行本协议过程中知悉的甲方商业秘密。",
  "7.2 双方其他权利义务适用《民法典》第五百零九条。",
  "联系人：张律师，手机 13800138000（示例）。",
].join("\n");

/**
 * 种一个“执行中”的任务与尝试（v9 第 04 篇 §8：模型/工具令牌必须绑定活动尝试与纪元，端点逐次复核）。
 * 直接驱动 Agent 宿主或端点的测试用它取得真实可用的身份，而不是凭空编造 rid/aid。
 */
export function liveTaskIdentity(
  tk: TestKernel,
  matterId: string,
  label: string,
  scenario = "a1.agent_task",
): { tid: string; uid: string; mid: string; rid: string; aid: string; fence: number } {
  const db = tk.kernel.db;
  const rid = `run_${label}_${Math.random().toString(36).slice(2, 8)}`;
  const aid = `att_${label}_${Math.random().toString(36).slice(2, 8)}`;
  db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [rid, tk.kernel.identity.tenantId, matterId, scenario, "test", "running", `idem-${rid}`, tk.kernel.identity.userId],
  );
  db.run(`INSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES (?,?,1,'running',1)`, [aid, rid]);
  return { tid: tk.kernel.identity.tenantId, uid: tk.kernel.identity.userId, mid: matterId, rid, aid, fence: 1 };
}

/**
 * 等任务结束，期间按 decide 回答确认卡与提问卡（W1：测试扮演律师；不回答的卡片会一直等待，直到有效期过期按拒绝处理）。
 * decide 返回 null = 本轮不处理该卡（例如等另一张卡）；answer 不给出时提问一律跳过。
 */
export async function waitRunAnswering(
  inv: TestKernel["inv"],
  runId: string,
  decide: (card: any) => { decision: "approve" | "reject"; scope?: "once" | "task"; variant?: "original" | "generalized"; feedback?: string } | null,
  timeoutMs = 120_000,
  answer?: (q: any) => Record<string, unknown>,
): Promise<{ run: any; artifacts: any[]; events: any[]; cards: any[] }> {
  const deadline = Date.now() + timeoutMs;
  const cards: any[] = [];
  const seen = new Set<string>();
  for (;;) {
    const d = await inv("runs.get", { run_id: runId });
    if (["succeeded", "partial", "failed", "cancelled", "timed_out", "expired", "reconciling"].includes(d.run.status)) {
      const ev = await inv("runs.events", { run_id: runId, limit: 500 });
      return { run: d.run, artifacts: d.artifacts, events: ev.events, cards };
    }
    const it = await inv("runs.interactions", { run_id: runId }).catch(() => ({ approvals: [], questions: [] }));
    for (const c of it.approvals) {
      if (seen.has(c.approval_id)) continue;
      const r = decide(c);
      if (!r) continue;
      seen.add(c.approval_id);
      cards.push(c);
      await inv("runs.approve", { run_id: runId, approval_id: c.approval_id, object_hash: c.object_hash, nonce: c.nonce, ...r });
    }
    for (const q of it.questions) {
      if (seen.has(q.question_id)) continue;
      seen.add(q.question_id);
      const answers = answer ? answer(q) : Object.fromEntries(q.questions.map((x: any) => [x.id, { kind: "skipped" }]));
      await inv("runs.answer", { run_id: runId, question_id: q.question_id, answers });
    }
    if (Date.now() > deadline) throw new Error(`任务 ${runId} 超时`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
