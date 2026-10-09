/**
 * 页级加密接线（方案 v5.0 第 4 篇 §5.1：SQLite + 页级加密，SQLCipher v4 格式）：
 * ZR_DB_KEY（仅开发用）建库 → 原始字节无明文；同 key 重开正常；错 key 打开如实报错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "db-cipher-test-secret-0123456789";

function rawBytesOf(dir: string): Buffer {
  const chunks: Buffer[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === "ledger.db" || f.startsWith("ledger.db-")) chunks.push(readFileSync(p)); // 只取账本文件（含 WAL/SHM）
  }
  return Buffer.concat(chunks);
}

test("页级加密：密文落盘、同 key 重开、错 key 报错", { timeout: 120_000 }, async () => {
  const { createKernel } = await import("../src/index.ts");
  const key = "db-cipher-test-key-2026";
  const dir = mkdtempSync(join(tmpdir(), "kwl-cipher-"));
  const env = { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_DB_KEY: key };

  // 加密建库并写入业务数据
  const k1 = await createKernel({ dataDir: dir, firmSlug: "cipher-firm", userSlug: "lawyer", env });
  await k1.invoke("matters.create", { title: "加密库测试事项-机密代号XY", stance: "受让方", consent_status: "not_required" });
  await k1.close();

  // 原始字节不含明文（表名与业务字符串都不可见；SQLite 明文头也不在）
  const raw = rawBytesOf(join(dir, "cipher-firm"));
  assert.equal(raw.includes("matters"), false, "加密库不应出现明文表名");
  assert.equal(raw.includes("机密代号XY"), false, "加密库不应出现明文业务数据");
  assert.equal(raw.includes("SQLite format 3"), false, "加密库不应有 SQLite 明文文件头");

  // 对照：明文开发库确实含明文（证明上述断言有效）
  const dirPlain = mkdtempSync(join(tmpdir(), "kwl-plain-"));
  const kp = await createKernel({ dataDir: dirPlain, firmSlug: "plain-firm", userSlug: "lawyer", env: { ...process.env, ZR_MODEL_PROVIDER: "mock" } });
  await kp.invoke("matters.create", { title: "明文库测试事项", stance: "受让方", consent_status: "not_required" });
  await kp.close();
  assert.equal(rawBytesOf(join(dirPlain, "plain-firm")).includes("matters"), true, "明文库应含明文表名（对照）");

  // 同 key 重开正常
  const k2 = await createKernel({ dataDir: dir, firmSlug: "cipher-firm", userSlug: "lawyer", env });
  const st = (await k2.invoke("kernel.status")) as any;
  assert.equal(st.firm, "cipher-firm");
  const list = (await k2.invoke("matters.list")) as any;
  assert.equal(list.matters.length, 1, "加密库数据同 key 可读");
  await k2.close();

  // 错 key 打开 → 报错（SQLCipher 无法解密）
  await assert.rejects(
    () => createKernel({ dataDir: dir, firmSlug: "cipher-firm", userSlug: "lawyer", env: { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_DB_KEY: "wrong-key" } }),
    /not a database|加密|密钥|cipher/i,
  );
});
