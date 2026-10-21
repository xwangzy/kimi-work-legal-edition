/**
 * 账本页级加密算法（v9.3 国密套件评估实测更正）：实际是 SQLite3MultipleCiphers 的 ChaCha20-Poly1305，不是早先注释写的 SQLCipher v4。
 * 现显式钉住 chacha20：驱动升级改了缺省值也不会让已有账本打不开；用驱动缺省值建的旧账本照常能开；密钥不对打不开。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelDb } from "../src/db.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3-multiple-ciphers");

test("账本加密算法是 chacha20；不设算法（驱动缺省）建的旧账本照常能开；密钥不对打不开；文件里没有明文", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-cipher-"));
  // 旧账本：只设 key、不设算法（第 16 批之前的写法）
  const legacy = join(dir, "legacy.db");
  const raw = new Database(legacy);
  raw.pragma("key = 'k-legacy'");
  raw.exec("CREATE TABLE t (x text); INSERT INTO t VALUES ('案卷内容明文样本')");
  assert.equal(raw.pragma("cipher", { simple: true }), "chacha20", "驱动缺省就是 chacha20");
  raw.close();
  assert.ok(!readFileSync(legacy).includes(Buffer.from("案卷内容明文样本")), "文件里没有明文");
  const db = new KernelDb(legacy, { key: "k-legacy" });
  assert.equal((db as any).db.pragma("cipher", { simple: true }), "chacha20");
  assert.equal(db.get<{ x: string }>("SELECT x FROM t")!.x, "案卷内容明文样本", "旧账本照常能开");
  db.close();
  assert.throws(() => new KernelDb(legacy, { key: "wrong" }).get("SELECT x FROM t"), "密钥不对打不开");
});
