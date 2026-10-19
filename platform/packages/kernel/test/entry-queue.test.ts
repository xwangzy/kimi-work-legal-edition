/**
 * 内核入口的启动排队（复核 B13-K01）：内核就绪之前到达的调用不丢——排队，就绪后依次应答；
 * 以前这段时间里的调用被 init 监听忽略、永远不回，安装包首启时激活门禁的第一个 kernel.status 因此挂起、界面空白。
 * 以 child_process.fork 运行同一入口（开发/节点形态的同一传输），不需要 Electron。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/electron-entry.ts", import.meta.url));

test("就绪前发出的调用排队、就绪后得到应答；kernel.ready 带待激活标记", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-entry-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    ZR_KERNEL_DATA_DIR: dir,
    ZR_FIRM_SLUG: "entry-firm",
    ZR_USER_SLUG: "lawyer",
    ZR_MODEL_PROVIDER: "mock",
    ZR_KERNEL_TCP: "off",
    ZR_BACKUP_TIMER: "off",
    ZR_INTERNAL_SECRET: process.env.ZR_INTERNAL_SECRET ?? "entry-queue-secret-0123456789abcdef",
  };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(entry, [], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const got = new Map<number, any>();
  let ready: any = null;
  child.on("message", (m: any) => {
    if (typeof m?.id === "number") got.set(m.id, m);
    if (m?.type === "kernel.ready") ready = m;
  });
  try {
    // 内核还在等主密钥（尚未 createKernel）：先发两个调用
    child.send({ id: 1, method: "kernel.status", params: {} });
    child.send({ id: 2, method: "matters.list", params: {} });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(got.size, 0, "就绪前不应答（也不丢）");
    child.send({ type: "kernel.init", dbKey: randomBytes(32).toString("base64") });
    const until = Date.now() + 90_000;
    while ((!ready || got.size < 2) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    assert.ok(ready, "收到 kernel.ready");
    assert.equal(ready.onboarding, false);
    assert.equal(got.get(1)?.ok, true, JSON.stringify(got.get(1)?.error ?? null));
    assert.equal(got.get(1).result.firm, "entry-firm");
    assert.equal(got.get(2)?.ok, true);
  } finally {
    child.send({ type: "kernel.shutdown" });
    await new Promise((r) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        r(null);
      }, 15_000);
      child.once("exit", () => {
        clearTimeout(t);
        r(null);
      });
    });
  }
});
