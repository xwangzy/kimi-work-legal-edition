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

test("成员入组在本机没有生效（复核 B13-K02）：暂存损坏 → 内核报错但清掉激活记录并记原因；再启动回到待激活且报 last_failure；重新输入即清除", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-joinfail-"));
  writeFileSync(
    join(dir, "activation.json"),
    JSON.stringify({ v: 1, tid: "ten_jf-firm", firm_slug: "jf-firm", firm_name: "某律所", member_slug: "m-0011223344", member_name: "张律师", role: "lawyer", kind: "member", activated_at: new Date().toISOString() }),
  );
  mkdirSync(join(dir, "jf-firm", "keys"), { recursive: true });
  writeFileSync(join(dir, "jf-firm", "keys", "join-approved.json"), "{not json");
  const { createKernel } = await import("../src/index.ts");
  const env: Record<string, string | undefined> = { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off", ZR_BACKUP_TIMER: "off", ZR_ONBOARDING: "1" };
  delete env.ZR_FIRM_SLUG;
  delete env.ZR_USER_SLUG;
  const dbKey = randomBytes(32).toString("base64");
  await assert.rejects(createKernel({ dataDir: dir, dbKey, env: env as NodeJS.ProcessEnv }), (e: any) => e.code === "conflict" && /入组没有完成/.test(e.message));
  assert.equal(existsSync(join(dir, "activation.json")), false, "激活记录已清掉");
  assert.equal(existsSync(join(dir, "jf-firm", "keys", "join-approved.json")), false, "暂存已清掉");
  const k = await createKernel({ dataDir: dir, dbKey, env: env as NodeJS.ProcessEnv });
  try {
    const st = (await k.invoke("onboarding.status")) as any;
    assert.equal(st.mode, "unactivated");
    assert.equal(st.last_failure.code, "unreadable");
    const after = (await k.invoke("onboarding.reset")) as any;
    assert.equal(after.last_failure, undefined, "重新输入即清除");
  } finally {
    await k.close();
  }
});
