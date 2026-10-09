/**
 * agent-host ESM 制品冒烟（§4.2/阶段 4：apps/desktop/electron/agent-host.bundle.mjs）：
 * 以制品作为 ZR_AGENT_HOST_ENTRY 跑一个最小 A1 任务（真实引擎经制品启动）。
 * 制品不存在则跳过并提示先运行 npm run build:kernel。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeKernel, importText, waitRun, type TestKernel } from "./helpers.ts";

const BUNDLE = fileURLToPath(new URL("../../../apps/desktop/electron/agent-host.bundle.mjs", import.meta.url));
const HAS_BUNDLE = existsSync(BUNDLE);

let tk: TestKernel;

before(async () => {
  if (!HAS_BUNDLE) {
    console.warn("[a1-bundle] 制品缺失，跳过（先运行 npm run build:kernel）");
    return;
  }
  tk = await makeKernel({ ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off", ZR_AGENT_HOST_ENTRY: BUNDLE }, "a1-bundle-firm");
});

after(async () => {
  await tk?.kernel.close();
});

test("agent-host ESM 制品冒烟：A1 任务经制品宿主完成", { timeout: 300_000, skip: !HAS_BUNDLE && "制品缺失（npm run build:kernel）" }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "制品冒烟事项", stance: "受让方", consent_status: "not_required" });
  const doc = await importText(inv, matter.matter_id, "协议.txt", "股权转让协议\n第七条 乙方应当遵守保密义务。");
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
  const run = await inv("runs.start", {
    matter_id: matter.matter_id,
    estimate_id: est.estimate_id,
    idempotency_key: `a1-bundle-${Date.now()}`,
    goal: "读取材料并简述内容。",
  });
  const done = await waitRun(inv, run.run_id, 240_000);
  assert.equal(done.run.status, "succeeded", `制品宿主应完成任务，实际 ${done.run.status}`);
  const types = done.events.map((e: any) => e.type);
  assert.ok(types.includes("agent.ready"), "制品宿主引擎启动成功");
  const draft = done.artifacts.find((a: any) => a.kind === "a1_agent_draft");
  assert.ok(draft && draft.status === "draft", "产物仍为草稿");
});
