/**
 * 迁移改号的兼容（第 14 批第二轮复核 R2B-33）：member_invitations 的迁移曾以 0045_v93_member_invitations.sql 出现在集成分支构建里，
 * 改号为 0050 后，已执行过旧名字（表已在）的账本再跑迁移不得报“表已存在”，并补登记新名字。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelDb } from "../src/db.ts";

test("已执行过旧名字 0045 的账本：0050 幂等，不报错并补登记", () => {
  const db = new KernelDb(join(mkdtempSync(join(tmpdir(), "kwl-mig-")), "ledger.db"));
  db.migrate();
  // 模拟“旧构建”：表在、登记的是旧名字、新名字未登记
  db.run(`DELETE FROM schema_migrations WHERE name = '0050_v93_member_invitations.sql'`, []);
  db.run(`INSERT INTO schema_migrations (name, applied_at) VALUES ('0045_v93_member_invitations.sql', '2026-10-19T00:00:00Z')`, []);
  assert.doesNotThrow(() => db.migrate());
  assert.ok(db.get(`SELECT 1 AS x FROM schema_migrations WHERE name = '0050_v93_member_invitations.sql'`, []));
  db.close();
});
