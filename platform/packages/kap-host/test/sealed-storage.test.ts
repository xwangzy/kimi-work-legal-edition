/**
 * 引擎持久化的落盘加密（审计 S3）：中段损坏的追加日志另存隔离副本、不截断其后的有效记录（复核 B3-A17）；
 * 严格形态下引擎目录里出现的明文文件拒绝读取与沿用（复核 B3-A18）；开发与迁移形态仍兼容旧明文。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveZoneKey, HEADER_BYTES, isSealed, ZoneCodec } from "@zr-legal/at-rest";
import { SealedLogFiles } from "../src/sealed-storage.ts";

const codec = () => new ZoneCodec("engine_journal", new Map([[1, deriveZoneKey(randomBytes(32), "engine_journal")]]), 1);

test("中段损坏：追加时整份另存隔离副本，新记录写入新文件；不静默截断", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-sealed-"));
  const c = codec();
  const files = new SealedLogFiles(c, { strict: true });
  const p = join(dir, "events.jsonl");
  for (let i = 0; i < 5; i++) await files.append(p, Buffer.from(`{"n":${i}}\n`));
  assert.equal((await files.read(p))!.toString(), [0, 1, 2, 3, 4].map((n) => `{"n":${n}}\n`).join(""));
  // 第 2 条记录密文翻一位（外部损坏）；换一个写入器（无缓存）再追加
  const disk = readFileSync(p);
  const at = HEADER_BYTES + (4 + 28 + Buffer.byteLength('{"n":0}\n')) + 4 + 2;
  disk[at]! ^= 1;
  writeFileSync(p, disk);
  const fresh = new SealedLogFiles(c, { strict: true });
  await assert.rejects(fresh.read(p), (e: any) => e.code === "corrupt", "读：中段损坏如实报错");
  await fresh.append(p, Buffer.from('{"n":5}\n'));
  const names = readdirSync(dir);
  const q = names.find((n) => n.startsWith("events.jsonl.kwl-corrupt-"));
  assert.ok(q, `原文件另存为隔离副本：${names.join(",")}`);
  assert.equal(readFileSync(join(dir, q!)).length, disk.length, "隔离副本完整保留（未截断）");
  assert.equal((await fresh.read(p))!.toString(), '{"n":5}\n');
});

test("严格形态：明文文件拒绝读取与沿用；非严格（迁移兼容）照常读出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-sealed-"));
  const p = join(dir, "state.json");
  writeFileSync(p, '{"planted":true}');
  const strict = new SealedLogFiles(codec(), { strict: true });
  await assert.rejects(strict.read(p), (e: any) => e.code === "not_sealed");
  await assert.rejects(strict.plainSize(p), (e: any) => e.code === "not_sealed");
  await assert.rejects(strict.append(p, Buffer.from("x")), (e: any) => e.code === "not_sealed");
  const lax = new SealedLogFiles(codec());
  assert.equal((await lax.read(p))!.toString(), '{"planted":true}');
  // 非严格追加：旧明文整体改写为密文后追加
  await lax.append(p, Buffer.from("\n"));
  assert.ok(isSealed(readFileSync(p)));
});
