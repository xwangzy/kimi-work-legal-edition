/**
 * 签名法律 Agent profile 失败关闭（方案 §4.3/探针 1）：
 * 验签失败（篡改内容/manifest 不符/文件缺失）→ A1 任务直接失败 agent_profile_invalid，
 * 不静默用引擎默认 agent；宿主侧 spec 缺 agentFile → 拒绝启动退出（双层失败关闭）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeKernel, waitRun, type TestKernel } from "./helpers.ts";

const HOST_ENTRY = fileURLToPath(new URL("../../../apps/agent-host/src/host.ts", import.meta.url));
const PROFILE_DIST = fileURLToPath(new URL("../../../content/agent-profile/dist/legal-agent.md", import.meta.url));

let kernels: TestKernel[] = [];
after(async () => {
  for (const tk of kernels) await tk.kernel.close();
});

function tamperedProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), "kwl-profile-tamper-"));
  const dst = join(dir, "legal-agent.md");
  const content = readFileSync(PROFILE_DIST, "utf8");
  writeFileSync(dst, content.replace("计划先行", "计划后行"), "utf8"); // 篡改一字（manifest 不动 → hash 必不符）
  copyFileSync(PROFILE_DIST.replace(/\.md$/, ".manifest.json"), dst.replace(/\.md$/, ".manifest.json"));
  return dst;
}

async function startA1AndExpectInvalid(tk: TestKernel): Promise<void> {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "profile 失败关闭", stance: "受让方", consent_status: "not_required" });
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
  const run = await inv("runs.start", {
    matter_id: matter.matter_id,
    estimate_id: est.estimate_id,
    idempotency_key: `a1-profile-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    goal: "读取材料并简述。",
  });
  const done = await waitRun(inv, run.run_id, 60_000);
  assert.equal(done.run.status, "failed", "验签失败须使任务失败（失败关闭）");
  const errEv = done.events.find((e: any) => e.type === "agent.error");
  assert.ok(errEv, "应有 agent.error 事件");
  assert.match(String(errEv.payload.message ?? ""), /agent_profile_invalid/);
  assert.ok(!done.events.some((e: any) => e.type === "agent.ready"), "宿主不得启动（未到达引擎）");
}

test("profile 验签失败（篡改一字）→ A1 任务失败 agent_profile_invalid", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({ ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off", ZR_AGENT_PROFILE_FILE: tamperedProfile() }, "profile-bad-firm");
  kernels.push(tk);
  await startA1AndExpectInvalid(tk);
});

test("profile 文件缺失 → A1 任务失败 agent_profile_invalid", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({ ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off", ZR_AGENT_PROFILE_FILE: join(tmpdir(), "kwl-no-such-profile.md") }, "profile-missing-firm");
  kernels.push(tk);
  await startA1AndExpectInvalid(tk);
});

test("宿主双层失败关闭：spec 缺 agentFile → 报错退出（不启动引擎）", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-host-nospec-"));
  const spec = { taskId: "t_nofile", homeDir: join(dir, "home"), workDir: join(dir, "snap"), skillDirs: [], goal: "x", pipePath: "/tmp/kwl-none.sock" };
  const child = spawn(process.execPath, [HOST_ENTRY], { env: { ...process.env, ZR_TASK_SPEC: JSON.stringify(spec) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let code: number | null = null;
  child.stdout!.on("data", (c: Buffer) => (out += c.toString("utf8")));
  code = await new Promise((r) => child.on("exit", (c) => r(c)));
  assert.equal(code, 2, `spec 缺 agentFile 须以 code 2 拒绝启动，实际 ${code}；输出：${out}`);
  assert.match(out, /agent_profile_invalid/);
});
