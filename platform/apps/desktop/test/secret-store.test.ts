/**
 * 主进程数据库主密钥（隐私安全审查 P0-2）与崩溃转储清理（P0-4）：safeStorage 以模拟对象注入。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { loadOrCreateDbKey, purgeOldDumps } = require("../electron/secret-store.cjs") as {
  loadOrCreateDbKey: (o: { safeStorage: any; file: string; packaged: boolean }) => Promise<any>;
  purgeOldDumps: (dir: string, days?: number, now?: number) => number;
};

/** 模拟 safeStorage：密文 = "SEALED:" + 明文（足以区分封装与否）；可模拟不可用、解封失败、需再包裹。 */
function fakeSafeStorage(o: { available?: boolean; failDecrypt?: boolean; reencrypt?: boolean } = {}) {
  return {
    isAsyncEncryptionAvailable: async () => o.available ?? true,
    encryptStringAsync: async (s: string) => Buffer.from(`SEALED:${s}`),
    decryptStringAsync: async (b: Buffer) => {
      if (o.failDecrypt) throw new Error("DPAPI 解封失败");
      const t = b.toString();
      if (!t.startsWith("SEALED:")) throw new Error("格式不符");
      return { result: t.slice(7), shouldReEncrypt: !!o.reencrypt };
    },
  };
}

const dir = () => mkdtempSync(join(tmpdir(), "kwl-key-"));

test("首跑生成并封装落盘；再次启动解封得到同一密钥；落盘内容不是明文密钥", async () => {
  const file = join(dir(), "ledger-key");
  const a = await loadOrCreateDbKey({ safeStorage: fakeSafeStorage(), file, packaged: true });
  assert.equal(a.ok, true);
  assert.equal(a.created, true);
  assert.ok(readFileSync(file, "utf8").startsWith("SEALED:"));
  const b = await loadOrCreateDbKey({ safeStorage: fakeSafeStorage(), file, packaged: true });
  assert.equal(b.ok, true);
  assert.equal(b.created, false);
  assert.equal(b.key, a.key);
});

test("解封失败：不覆盖密钥文件、不生成新密钥，返回 unseal_failed", async () => {
  const file = join(dir(), "ledger-key");
  writeFileSync(file, "SEALED:原有密钥原有密钥原有密钥原有密钥原有密钥");
  const before = readFileSync(file);
  const r = await loadOrCreateDbKey({ safeStorage: fakeSafeStorage({ failDecrypt: true }), file, packaged: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, "unseal_failed");
  assert.deepEqual(readFileSync(file), before);
});

test("安装包形态 safeStorage 不可用即拒绝（不以明文库启动）；开发形态允许并告警", async () => {
  const file = join(dir(), "ledger-key");
  const p = await loadOrCreateDbKey({ safeStorage: fakeSafeStorage({ available: false }), file, packaged: true });
  assert.equal(p.ok, false);
  assert.equal(p.code, "unavailable");
  assert.equal(existsSync(file), false);
  const d = await loadOrCreateDbKey({ safeStorage: fakeSafeStorage({ available: false }), file, packaged: false });
  assert.equal(d.ok, true);
  assert.equal(d.key, null);
  assert.ok(d.warning);
});

test("需要再包裹时原子改写，密钥不变", async () => {
  const file = join(dir(), "ledger-key");
  const a = await loadOrCreateDbKey({ safeStorage: fakeSafeStorage(), file, packaged: true });
  const b = await loadOrCreateDbKey({ safeStorage: fakeSafeStorage({ reencrypt: true }), file, packaged: true });
  assert.equal(b.key, a.key);
  assert.ok(readFileSync(file, "utf8").startsWith("SEALED:"));
});

test("崩溃转储：只删除超过保留天数的文件", () => {
  const d = dir();
  mkdirSync(join(d, "reports"), { recursive: true });
  const oldF = join(d, "reports", "old.dmp");
  const newF = join(d, "new.dmp");
  writeFileSync(oldF, "x");
  writeFileSync(newF, "y");
  const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
  utimesSync(oldF, tenDaysAgo, tenDaysAgo);
  assert.equal(purgeOldDumps(d, 3), 1);
  assert.equal(existsSync(oldF), false);
  assert.equal(existsSync(newF), true);
});
