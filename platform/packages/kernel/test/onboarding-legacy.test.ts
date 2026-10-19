/**
 * 存量安装升级后进入待激活（复核 B13-K06）：数据根下已有旧工作区（第 13 批之前的 demo-firm）时，
 * onboarding.status 报告其目录名（不迁移、不删除，由 IT 决定）；占位工作区不算。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "onboarding-legacy-secret-0123456789ab";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("待激活：报告本机旧工作区；激活前后都不动它", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-legacy-"));
  mkdirSync(join(dir, "demo-firm"), { recursive: true });
  writeFileSync(join(dir, "demo-firm", "ledger.db"), randomBytes(64));
  mkdirSync(join(dir, "not-a-workspace"), { recursive: true });
  const { createKernel } = await import("../src/index.ts");
  const env: Record<string, string | undefined> = { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off", ZR_BACKUP_TIMER: "off", ZR_ONBOARDING: "1" };
  delete env.ZR_FIRM_SLUG;
  delete env.ZR_USER_SLUG;
  const k = await createKernel({ dataDir: dir, dbKey: randomBytes(32).toString("base64"), env: env as NodeJS.ProcessEnv });
  try {
    const st = (await k.invoke("onboarding.status")) as any;
    assert.equal(st.mode, "unactivated");
    assert.deepEqual(st.legacy_workspaces, ["demo-firm"], "只报有账本的目录，占位工作区与其他目录不算");
    assert.ok(existsSync(join(dir, "demo-firm", "ledger.db")), "不动旧工作区");
  } finally {
    await k.close();
  }
});
