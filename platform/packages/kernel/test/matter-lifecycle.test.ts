/**
 * 事项数据生命周期（迁移 0021）：结案后只读、法律保全阻止删除、提前删除须写明原因、删除后全库无残留内容、
 * 删除回执可验签、签名事件链复核把按清单清除的行计为“已清除”而非篡改，清单被改动即失败。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importText, liveTaskIdentity, makeKernel, runScenario, type TestKernel } from "./helpers.ts";

const CANARY = "金丝雀KWLPURGE0001";
const TITLE = `甲乙采购合同 ${CANARY}`;

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "lifecycle-firm");
});
after(async () => {
  await tk.kernel.close();
});

/** 磁盘逐文件扫描：文件内容里出现金丝雀的路径（相对数据根）。 */
function diskScan(root: string, needle: string, skip: string[]): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (skip.includes(p)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && readFileSync(p).includes(Buffer.from(needle))) hits.push(p.slice(root.length));
    }
  };
  walk(root);
  return hits;
}

/** 全库扫描：所有表、所有列里是否还出现金丝雀。 */
function scanDb(needle: string): string[] {
  const db = tk.kernel.db;
  const hits: string[] = [];
  const tables = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`, []);
  for (const { name } of tables) {
    let rows: any[];
    try {
      rows = db.all(`SELECT * FROM "${name}"`, []);
    } catch {
      continue;
    }
    for (const r of rows) {
      for (const [k, v] of Object.entries(r)) {
        const s = typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : "";
        if (s.includes(needle)) hits.push(`${name}.${k}`);
      }
    }
  }
  return [...new Set(hits)];
}

test("结案只读 → 保全阻止删除 → 提前删除须写原因 → 删除后无残留、回执可验签、链复核通过", { timeout: 180_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: TITLE, client_name: `客户${CANARY}`, counterparty: "乙方公司", stance: "买方", consent_status: "agreed" });
  const mid = matter.matter_id;
  const doc = await importText(tk.inv, mid, `采购合同-${CANARY}.txt`, `第一条 甲方应于三十日内付款。备注：${CANARY}。\n第二条 违约金为合同总额的百分之五。`);
  // 挂载材料：路径里的目录名也带金丝雀（复核 C-A04：删除后挂载路径不得留在账本里）
  const mountDir = join(tk.dir, `客户卷宗-${CANARY}`);
  mkdirSync(mountDir, { recursive: true });
  const mountPath = join(mountDir, "补充协议.txt");
  writeFileSync(mountPath, "补充协议：付款期限延长至六十日。");
  await tk.inv("materials.mount", { matter_id: mid, path: mountPath, filename: "补充协议.txt", mime: "text/plain" });
  await runScenario(tk.inv, mid, "s1.contract_review", { document_version_ids: [doc.document_version_id] }, 120_000);
  assert.ok(scanDb(CANARY).length > 0, "前置：删除前库里确有内容");
  assert.ok(diskScan(tk.dir, CANARY, [mountDir]).length > 0, "前置：删除前磁盘上确有内容（扫描本身有效）");

  // 1. 结案：只读，不能再发起任务与导入；保留期写入
  const closed = await tk.inv("matters.close", { matter_id: mid, retention_years: 1 });
  assert.equal(closed.lifecycle.lifecycle, "closed");
  assert.ok(closed.lifecycle.retention_until > new Date().toISOString());
  await assert.rejects(importText(tk.inv, mid, "新材料.txt", "x"), (e: any) => e.code === "conflict");
  await assert.rejects(tk.inv("runs.start", { matter_id: mid, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id] }), (e: any) => e.code === "conflict");
  await assert.rejects(tk.inv("matters.close", { matter_id: mid }), (e: any) => e.code === "conflict");

  // 2. 重新打开 → 再结案（可逆）
  assert.equal((await tk.inv("matters.reopen", { matter_id: mid })).lifecycle.lifecycle, "active");
  await tk.inv("matters.close", { matter_id: mid, retention_years: 1 });

  // 3. 法律保全：须写原因；保全期间不得删除
  await assert.rejects(tk.inv("matters.hold", { matter_id: mid, on: true }), (e: any) => e.code === "validation");
  await tk.inv("matters.hold", { matter_id: mid, on: true, reason: "诉讼保全" });
  await assert.rejects(tk.inv("matters.purge", { matter_id: mid, confirm_title: TITLE, early: true, reason: "客户书面要求" }), (e: any) => e.code === "conflict");
  await tk.inv("matters.hold", { matter_id: mid, on: false });

  // 4. 删除确认：名称须一致；保留期未满须勾选提前删除并写原因
  await assert.rejects(tk.inv("matters.purge", { matter_id: mid, confirm_title: "错的名字" }), (e: any) => e.code === "validation");
  await assert.rejects(tk.inv("matters.purge", { matter_id: mid, confirm_title: TITLE }), (e: any) => e.code === "validation");
  await assert.rejects(tk.inv("matters.purge", { matter_id: mid, confirm_title: TITLE, early: true }), (e: any) => e.code === "validation");

  const purged = await tk.inv("matters.purge", { matter_id: mid, confirm_title: TITLE, early: true, reason: "客户书面要求删除" });
  assert.equal(purged.lifecycle.lifecycle, "purged");
  const rc = purged.receipt;
  assert.equal(rc.signature_valid, true, "删除回执验签通过");
  assert.equal(rc.receipt.early, true);
  assert.equal(rc.receipt.reason, "客户书面要求删除");
  assert.ok(rc.receipt.inventory.redacted_signed_rows > 0);
  assert.equal(JSON.stringify(rc).includes(CANARY), false, "回执不含名称与内容");
  assert.deepEqual(
    rc.receipt.copies.map((c: any) => c.status),
    // 第 10 批：增“中软通知服务（期限提醒）”“已送达其他设备的期限提醒”两行（本事项没有交给云端的提醒 → none）；
    // 第 11 批：增“中软共享中继”一行（个人事项不经中继 → none）
    ["deleted", "none", "none", "none", "deleted", rc.receipt.inventory.egress_sent > 0 ? "irrevocable" : "none", "none", "pending", "none", "none", "kept"],
  );

  // 5. 全库无残留；块目录已删除；密钥包裹已删除
  assert.deepEqual(scanDb(CANARY), [], "删除后任何表都不再含金丝雀");
  // 磁盘逐文件扫描（复核 C-A17）：账本主库、WAL、块存储、Agent 目录——挂载原件所在的律师文件夹除外
  assert.deepEqual(diskScan(tk.dir, CANARY, [mountDir]), [], "磁盘上任何文件都不再含金丝雀（文件名除外的内容）");
  assert.equal(existsSync(join(tk.kernel.blobs.dir, mid)), false, "块目录已删除");
  assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matter_keys WHERE matter_id = ?`, [mid])!.n, 0);

  // 6. 删除后：不可写、不可重新打开；列表默认不显示；回执可再读
  await assert.rejects(tk.inv("matters.reopen", { matter_id: mid }), (e: any) => e.code === "conflict");
  await assert.rejects(tk.inv("matters.update", { matter_id: mid, patch: { title: "复活" } }), (e: any) => e.code === "conflict");
  assert.equal((await tk.inv("matters.list")).matters.some((m: any) => m.matter_id === mid), false);
  assert.equal((await tk.inv("matters.list", { include_purged: true })).matters.find((m: any) => m.matter_id === mid)?.lifecycle, "purged");
  assert.equal((await tk.inv("matters.deletion_receipt", { matter_id: mid })).signature_valid, true);

  // 7. 签名链：按清单清除的行计为“已清除”，链整体通过
  const v = await tk.inv("audit.verifyChain");
  assert.equal(v.ok, true, JSON.stringify(v.failures?.slice(0, 3)));
  assert.equal(v.redacted, rc.receipt.inventory.redacted_signed_rows);

  // 8. 清单被改动（删去一行）→ 链复核失败；改回即恢复
  const db = tk.kernel.db;
  const one = db.get<{ kind: string; ref_id: string; matter_id: string; redacted_at: string; row_hash: string | null }>(`SELECT * FROM redacted_rows WHERE matter_id = ? LIMIT 1`, [mid])!;
  db.run(`DELETE FROM redacted_rows WHERE kind = ? AND ref_id = ?`, [one.kind, one.ref_id]);
  assert.equal((await tk.inv("audit.verifyChain")).ok, false, "清单少一行即失败");
  db.run(`INSERT INTO redacted_rows (kind, ref_id, matter_id, redacted_at, row_hash) VALUES (?,?,?,?,?)`, [one.kind, one.ref_id, one.matter_id, one.redacted_at, one.row_hash]);
  assert.equal((await tk.inv("audit.verifyChain")).ok, true, "改回即恢复");

  // 9. 别的事项的签名行被改：不在清单内，照常判篡改（清单不是通行证）
  const { matter: other } = await tk.inv("matters.create", { title: "另一事项", stance: "卖方", consent_status: "agreed" });
  const d2 = await importText(tk.inv, other.matter_id, "另一份.txt", "第一条 卖方交货。");
  await runScenario(tk.inv, other.matter_id, "s1.contract_review", { document_version_ids: [d2.document_version_id] }, 120_000);
  const ev = db.get<{ event_id: number; payload: string }>(`SELECT e.event_id, e.payload FROM run_events e JOIN runs r ON r.run_id = e.run_id WHERE r.matter_id = ? LIMIT 1`, [other.matter_id])!;
  db.run(`UPDATE run_events SET payload = '{"redacted":true}' WHERE event_id = ?`, [ev.event_id]);
  assert.equal((await tk.inv("audit.verifyChain")).ok, false, "未删除事项的行被改仍判篡改");
  db.run(`UPDATE run_events SET payload = ? WHERE event_id = ?`, [ev.payload, ev.event_id]);
  assert.equal((await tk.inv("audit.verifyChain")).ok, true);

  // 10. 复核 C-A01：清单不能用来掩盖其他行的篡改
  // (a) 把别的事项的行登记到已删除事项名下并改它，再伪造一条（无签名见证的）删除审计事件让摘要对上 → 仍失败
  db.run(`INSERT INTO redacted_rows (kind, ref_id, matter_id) VALUES ('run_event', ?, ?)`, [String(ev.event_id), mid]);
  db.run(`UPDATE run_events SET payload = '{"redacted":true}' WHERE event_id = ?`, [ev.event_id]);
  const { redactionDigest } = await import("../src/services/matter-lifecycle.ts");
  db.run(`INSERT INTO audit_events (tenant_id, actor_id, action, object_kind, object_id, detail_hash) VALUES (?,?,?,?,?,?)`, [tk.kernel.identity.tenantId, tk.kernel.identity.userId, "matter.purged", "matter", mid, redactionDigest(db, mid)]);
  assert.equal((await tk.inv("audit.verifyChain")).ok, false, "伪造的删除审计事件没有签名见证，不能背书");
  db.run(`DELETE FROM audit_events WHERE action = 'matter.purged' AND object_id = ? AND audit_event_id = (SELECT MAX(audit_event_id) FROM audit_events)`, [mid]);
  db.run(`DELETE FROM redacted_rows WHERE kind = 'run_event' AND ref_id = ?`, [String(ev.event_id)]);
  db.run(`UPDATE run_events SET payload = ? WHERE event_id = ?`, [ev.payload, ev.event_id]);
  assert.equal((await tk.inv("audit.verifyChain")).ok, true);
  // (b) 已删除事项清单内的行被改成非清除形态的内容 → 判篡改
  const listedRow = db.get<{ ref_id: string }>(`SELECT ref_id FROM redacted_rows WHERE matter_id = ? AND kind = 'run_event' LIMIT 1`, [mid])!;
  db.run(`UPDATE run_events SET payload = '{"forged":"内容"}' WHERE event_id = ?`, [Number(listedRow.ref_id)]);
  assert.equal((await tk.inv("audit.verifyChain")).ok, false, "清单内的行只能是清除形态");
  db.run(`UPDATE run_events SET payload = '{"redacted":true}' WHERE event_id = ?`, [Number(listedRow.ref_id)]);
  assert.equal((await tk.inv("audit.verifyChain")).ok, true);
  // (c) 清除后保留的元数据被改（事件类型）→ 判篡改（复核 C-A08）
  const orig = db.get<{ type: string }>(`SELECT type FROM run_events WHERE event_id = ?`, [Number(listedRow.ref_id)])!;
  db.run(`UPDATE run_events SET type = 'forged.type' WHERE event_id = ?`, [Number(listedRow.ref_id)]);
  assert.equal((await tk.inv("audit.verifyChain")).ok, false, "保留的元数据同样防篡改");
  db.run(`UPDATE run_events SET type = ? WHERE event_id = ?`, [orig.type, Number(listedRow.ref_id)]);
  assert.equal((await tk.inv("audit.verifyChain")).ok, true);
});

test("删除前提：未结案不能删除；保留期须为 1–30 年", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "进行中", stance: "原告", consent_status: "agreed" });
  await assert.rejects(tk.inv("matters.purge", { matter_id: matter.matter_id, confirm_title: "进行中" }), (e: any) => e.code === "conflict");
  const lc = await tk.inv("matters.lifecycle", { matter_id: matter.matter_id });
  assert.equal(lc.lifecycle.lifecycle, "active");
  assert.deepEqual(lc.retention_years, { min: 1, max: 30, default: 10 });
  await assert.rejects(tk.inv("matters.close", { matter_id: matter.matter_id, retention_years: 0 }), (e: any) => e.code === "validation");
  await assert.rejects(tk.inv("matters.close", { matter_id: matter.matter_id, retention_years: 31 }), (e: any) => e.code === "validation");
});

test("被移出事项：先终止该事项进行中的任务，再擦除本机 Agent 数据与工作区密钥（复核 B3-A20）", { timeout: 60_000 }, async () => {
  const db = tk.kernel.db;
  const { matter } = await tk.inv("matters.create", { title: "移出时有任务", stance: "原告", consent_status: "agreed" });
  const live = liveTaskIdentity(tk, matter.matter_id, "removed_running");
  const deviceId = db.get<{ device_id: string }>(`SELECT device_id FROM devices WHERE member_id = ? AND role <> 'node' LIMIT 1`, [tk.kernel.identity.userId])!.device_id;
  db.run(`INSERT INTO matter_ws_keys (matter_id, gen, device_id, wrapped_key) VALUES (?,?,?,?)`, [matter.matter_id, 1, deviceId, "test-wrapped"]);
  db.run(`UPDATE matter_members SET removed_at = ? WHERE matter_id = ? AND user_id = ?`, [new Date().toISOString(), matter.matter_id, tk.kernel.identity.userId]);
  const purged = await tk.kernel.purgeRevokedAgentData();
  assert.ok(purged.includes(matter.matter_id));
  const run = db.get<{ status: string; cancel_reason: string }>(`SELECT status, cancel_reason FROM runs WHERE run_id = ?`, [live.rid])!;
  assert.equal(run.status, "cancelled");
  assert.equal(run.cancel_reason, "你已被移出该事项");
  assert.ok(db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'run.cancelled_by_kernel' AND object_id = ?`, [live.rid]), "终止上签名链");
  assert.equal(db.get(`SELECT 1 AS x FROM matter_ws_keys WHERE matter_id = ?`, [matter.matter_id]), undefined);
});
