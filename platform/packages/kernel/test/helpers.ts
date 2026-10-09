/** 内核测试辅助：每文件一个临时工作区；mock 提供方（离线可跑）。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kernel } from "../src/index.ts";

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
    env: { ...process.env, ZR_MODEL_PROVIDER: "mock", ...env },
  });
  return { kernel, dir, inv: (m, p) => kernel.invoke(m, p) };
}

export async function waitRun(inv: TestKernel["inv"], runId: string, timeoutMs = 60_000): Promise<{ run: any; artifacts: any[]; events: any[] }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await inv("runs.get", { run_id: runId });
    if (["succeeded", "failed", "cancelled"].includes(d.run.status)) {
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
