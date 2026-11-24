/**
 * 第 62 批（发布配置核对 §2）：安装包形态（主进程固定 ZR_AT_REST=required）收不到数据库主密钥时内核拒绝启动，
 * 不再“10 秒后以明文开发库启动”；数据目录里不得生成任何账本文件。开发形态（未设 required）行为不变（entry-queue.test.ts 覆盖）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/electron-entry.ts", import.meta.url));

test("安装包形态：等不到主密钥即以 78 退出并广播 db_key_missing（fatal），不建明文账本", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-dbkey-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    ZR_KERNEL_DATA_DIR: dir,
    ZR_FIRM_SLUG: "dbkey-firm",
    ZR_USER_SLUG: "lawyer",
    ZR_MODEL_PROVIDER: "mock",
    ZR_KERNEL_TCP: "off",
    ZR_BACKUP_TIMER: "off",
    ZR_AT_REST: "required",
  };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(entry, [], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const events: any[] = [];
  child.on("message", (m: any) => events.push(m));
  const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  assert.equal(code, 78);
  const ev = events.find((m) => m?.event === "kernel.db_key_missing");
  assert.ok(ev, "广播了 db_key_missing");
  assert.equal(ev.fatal, true);
  assert.ok(!events.some((m) => m?.type === "kernel.ready"), "不得就绪");
  const files = existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
  assert.ok(!files.some((f) => /ledger\.db/.test(f)), `不得建账本：${files.join(",")}`);
});
