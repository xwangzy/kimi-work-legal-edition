/**
 * 迁移 0017（v9 阶段 6 复核 S6-C08、S6-C17）：此前已吊销的设备回补吊销墓碑（来源按本机吊销记，进入控制面形态时补建待同步动作），
 * 之后共享文件夹同步与事件验收对它们同样一律拒收。另起迁移：已执行过 0016 的工作区同样回补。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KernelDb } from "../src/db.ts";

const MIGRATIONS = fileURLToPath(new URL("../src/migrations/", import.meta.url));

test("迁移 0017：已执行到 0016 的工作区，已吊销的设备回补墓碑；有效设备不受影响", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-mig-"));
  // 先只迁到 0016（模拟已执行过第二轮 0016 的工作区）
  const upTo16 = join(dir, "m16");
  mkdirSync(upTo16);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < "0017")) copyFileSync(join(MIGRATIONS, f), join(upTo16, f));
  const db = new KernelDb(join(dir, "ledger.db"));
  try {
    db.migrate(upTo16);
    db.run(`INSERT INTO tenants (tenant_id, name) VALUES ('ten_mig', 'mig')`, []);
    const row = (id: string, status: string) =>
      db.run(
        `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue, revoked_at) VALUES (?, 'ten_mig', 'usr_m', 'lawyer', 'x', 'x', '{}', ?, 1, ?)`,
        [id, status, status === "revoked" ? "2026-10-01T00:00:00.000Z" : null],
      );
    row("dev_mig_old", "revoked");
    row("dev_mig_live", "active");
    db.migrate();
    const tombs = db.all<{ device_id: string; source: string; revoked_at: string }>(`SELECT device_id, source, revoked_at FROM cp_revoked_devices WHERE tenant_id = 'ten_mig'`, []);
    assert.deepEqual(tombs, [{ device_id: "dev_mig_old", source: "local", revoked_at: "2026-10-01T00:00:00.000Z" }]);
  } finally {
    db.close();
  }
});
