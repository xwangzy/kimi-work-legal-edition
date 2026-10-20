/**
 * 设备恢复完整场景（第 4 批复核 B4-A11/A12）：真实恢复发生在 device.json 丢失或损坏后——重开时本机已换新（临时）密钥，
 * 期间建的事项、签出的见证与审批都属于临时密钥。导入恢复文件必须：
 *  - 写回一致的四元组（公钥由备份私钥推导），devices 行公钥同步；
 *  - 把临时密钥包裹的事项密钥与工作区密钥改包裹给备份公钥（否则重启后永久解不开）；
 *  - 旧证书、临时证书签出的历史在重启后仍能验签（证书留档，迁移 0024）；
 *  - 证书须律所根签发、编号与成员是本机、公钥与私钥一致；明文字段被改、已吊销设备一律拒绝，且不改设备状态；
 *  - 导入后到重启前，其余操作拒绝（本进程各组件仍持有旧密钥）。
 */
import { SoftwareSigner } from "@zr-legal/keys";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_CONTRACT, importText, runScenario } from "./helpers.ts";
import * as forgedHelpers from "../src/ledger-signer.ts";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "device-recovery-test-secret-0123456789";

const KEY = "device-recovery-test-key-2026-0123456789";
const PW = "恢复口令-完整场景-0123";
const env = () => ({ ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_DB_KEY: KEY });
const spki = (privatePem: string) => createPublicKey(privatePem).export({ format: "pem", type: "spki" }).toString();

async function workspace(firm: string) {
  const { createKernel } = await import("../src/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "kwl-recover-"));
  return {
    dir,
    keysDir: join(dir, firm, "keys"),
    open: () => createKernel({ dataDir: dir, firmSlug: firm, userSlug: "lawyer", env: env() }),
  };
}

const newMatter = async (inv: (m: string, p?: unknown) => Promise<any>, title: string) =>
  (await inv("matters.create", { title, stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } })).matter;
const readable = async (inv: (m: string, p?: unknown) => Promise<any>, docId: string) => {
  await inv("materials.reparse", { document_version_id: docId });
  return true;
};

test("设备恢复完整场景：丢失 device.json → 临时密钥期间建事项与签发 → 导入 → 重开后新旧事项都可读、四元组一致、见证链与审批验签通过", { timeout: 300_000 }, async () => {
  const { getDeviceKeys, configureSecretSealing } = await import("../src/devices.ts");
  const ws = await workspace("rcv-firm");
  let k = await ws.open();
  const inv = (m: string, p?: unknown) => k.invoke(m, p) as Promise<any>;
  try {
    // 1. 原设备：事项甲 + 导出恢复文件
    const A = await newMatter(inv, "恢复场景-事项甲");
    const docA = await importText(inv, A.matter_id, "甲.txt", "甲方材料：第一条 定义。");
    const backup = join(ws.dir, "backup", "device.kwlrec");
    const deviceId: string = (await inv("recovery.export_device", { password: PW, path: backup })).device_id;
    const original = getDeviceKeys(ws.keysDir);
    await k.close();

    // 2. device.json 丢失后重开：本机换了临时密钥；事项甲暂时打不开（不是静默成功）
    rmSync(join(ws.keysDir, "device.json"));
    k = await ws.open();
    const temp = getDeviceKeys(ws.keysDir);
    assert.notEqual(temp.encPublicKeyPem, original.encPublicKeyPem, "丢失后应已换新密钥");
    await assert.rejects(() => readable(inv, docA.document_version_id), /原件不可读/);
    // 临时密钥期间：事项乙 + 一份设备签名签发
    const B = await newMatter(inv, "恢复场景-事项乙");
    const docB = await importText(inv, B.matter_id, "乙.txt", DEMO_CONTRACT);
    const d = await runScenario(inv, B.matter_id, "s1.contract_review", { document_version_ids: [docB.document_version_id], topic_hint: "保密义务" }, 120_000);
    const art = d.artifacts.find((a: any) => a.kind === "s1_opinion");
    assert.ok(art, "临时密钥期间应产出成果");
    await inv("review.submit", { artifact_version_id: art.artifact_version_id });
    const ap = await inv("review.approve", {
      artifact_version_id: art.artifact_version_id,
      decision: "approved",
      expected_sha256: art.sha256,
      checklist: { reviewed_open_items: true, audience_confirmed: true },
    });
    assert.equal((await inv("approvals.verify", { approval_id: ap.approval_id })).overall, "valid");

    // 3. 导入：只核验并暂存（复核 B4-R09），本进程继续用临时密钥工作——导入之后、重启之前新建的事项丁同样要在重启后可读
    const im = await inv("recovery.import_device", { file: backup, password: PW });
    assert.equal(im.restart_required, true);
    assert.equal(im.staged, true);
    assert.equal(getDeviceKeys(ws.keysDir).encPublicKeyPem, temp.encPublicKeyPem, "重启前 device.json 不变");
    const D = await newMatter(inv, "恢复场景-事项丁（导入后、重启前）");
    const docD = await importText(inv, D.matter_id, "丁.txt", "丁方材料");
    await k.close();

    // 4. 重开：四元组一致且等于原设备；devices 行公钥等于推导结果
    k = await ws.open();
    const restored = getDeviceKeys(ws.keysDir);
    assert.equal(restored.signPublicKeyPem, original.signPublicKeyPem);
    assert.equal(restored.encPublicKeyPem, original.encPublicKeyPem);
    assert.equal(spki(restored.signPrivateKeyPem), restored.signPublicKeyPem, "签名私钥与公钥成对");
    assert.equal(spki(restored.encPrivateKeyPem), restored.encPublicKeyPem, "加密私钥与公钥成对");
    const row = k.db.get<{ sign_pub_pem: string; enc_pub_pem: string; status: string; cert_json: string }>(`SELECT sign_pub_pem, enc_pub_pem, status, cert_json FROM devices WHERE device_id = ?`, [deviceId]);
    assert.ok(row);
    assert.equal(row.sign_pub_pem.trim(), restored.signPublicKeyPem.trim());
    assert.equal(row.enc_pub_pem.trim(), restored.encPublicKeyPem.trim());
    assert.equal(JSON.parse(row.cert_json).signPublicKeyPem.trim(), restored.signPublicKeyPem.trim());
    assert.equal(row.status, "active");
    // 新旧事项都可读，新建事项丙也可读
    assert.ok(await readable(inv, docA.document_version_id), "事项甲（原密钥）");
    assert.ok(await readable(inv, docB.document_version_id), "事项乙（临时密钥期间建）");
    assert.ok(await readable(inv, docD.document_version_id), "事项丁（导入后、重启前建）");
    assert.ok(k.db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'recovery.applied'`), "恢复生效记审计");
    const C = await newMatter(inv, "恢复场景-事项丙");
    const docC = await importText(inv, C.matter_id, "丙.txt", "丙方材料");
    assert.ok(await readable(inv, docC.document_version_id), "事项丙（恢复后建）");
    // 见证链：原密钥、临时密钥、恢复后三段签名都验签通过
    const chain = await inv("audit.verifyChain", {});
    assert.equal(chain.ok, true, JSON.stringify(chain.failures?.slice(0, 3)));
    assert.equal(chain.checkpoints.every((c: any) => c.ok), true);
    // 临时密钥期间的签发仍验签通过，证明包给出实际签名的那张证书
    const v = await inv("approvals.verify", { approval_id: ap.approval_id });
    assert.equal(v.overall, "valid", JSON.stringify(v));
    assert.equal(JSON.parse(v.proof.cert_json).signPublicKeyPem.trim(), temp.signPublicKeyPem.trim());
    // 同一份文件再导入一次：密钥相同，无需改动
    const again = await inv("recovery.import_device", { file: backup, password: PW });
    assert.equal(again.staged, false);
    assert.equal(again.restart_required, false);
    // 被替换下来的临时私钥（复核 B4-R10）：恢复之后用它签出的新见证行不得被判有效
    const { createLedgerSigner } = await import("../src/ledger-signer.ts");
    const tenantId = k.db.get<{ tenant_id: string }>(`SELECT tenant_id FROM devices WHERE device_id = ?`, [deviceId])!.tenant_id;
    const forged = createLedgerSigner({ db: k.db, deviceId, signer: new SoftwareSigner(temp.signPrivateKeyPem), tenantId });
    k.db.tx(() => {
      const r = k.db.run(`INSERT INTO audit_events (tenant_id, actor_id, action, object_kind, object_id, detail_hash) VALUES (?,?,?,?,?,?)`, [tenantId, "forger", "forged.event", "device", deviceId, null]);
      const { rowPayloadHash } = forgedHelpers;
      const row = k.db.get<Record<string, unknown>>(`SELECT * FROM audit_events WHERE audit_event_id = ?`, [Number(r.lastInsertRowid)]);
      forged.append({ kind: "audit_event", refId: String(r.lastInsertRowid), matterId: null, type: "forged.event", payloadHash: rowPayloadHash(row ?? {}) });
    });
    const after = await inv("audit.verifyChain", {});
    assert.equal(after.ok, false, "旧私钥签出的新见证行必须验签失败");
    const lastSeq = k.db.get<{ s: number }>(`SELECT MAX(seq) AS s FROM signed_events`, [])!.s;
    assert.deepEqual(after.failures.map((f: any) => f.seq), [lastSeq], "只有伪造的那一行失败，历史行仍通过");
  } finally {
    await k.close();
    configureSecretSealing(ws.keysDir, undefined);
  }
});

test("设备恢复负例：明文字段改成本机编号、证书被改、私钥与证书不符、已吊销设备——一律拒绝，且不改 device.json 与设备状态", { timeout: 180_000 }, async () => {
  const { getDeviceKeys, configureSecretSealing } = await import("../src/devices.ts");
  const { generateDeviceKeys, wrapPrivateKeyScrypt, unwrapPrivateKeyScrypt } = await import("@zr-legal/keys");
  const ws = await workspace("rcv-neg");
  const k = await ws.open();
  const inv = (m: string, p?: unknown) => k.invoke(m, p) as Promise<any>;
  try {
    const out = join(ws.dir, "backup", "device.kwlrec");
    const ex = await inv("recovery.export_device", { password: PW, path: out });
    const doc = JSON.parse(readFileSync(out, "utf8"));
    const inner = JSON.parse(unwrapPrivateKeyScrypt(doc.wrapped, PW));
    assert.equal(inner.v, 2);
    assert.equal(inner.device_id, ex.device_id, "设备编号在口令包裹里");
    const before = readFileSync(join(ws.keysDir, "device.json"), "utf8");
    const write = (name: string, d: unknown) => {
      const f = join(ws.dir, "backup", name);
      writeFileSync(f, JSON.stringify(d));
      return f;
    };

    // ① 别的设备的恢复文件，把外层明文编号改成本机：包裹内编号不符 → 拒绝
    const foreignInner = { ...inner, device_id: "dev_other_lawyer" };
    const foreign = write("foreign.kwlrec", { ...doc, wrapped: wrapPrivateKeyScrypt(JSON.stringify(foreignInner), PW) });
    await assert.rejects(() => inv("recovery.import_device", { file: foreign, password: PW }), /另一台设备/);
    // ② 证书被改（角色）：摘要不符 → 拒绝
    const roleTampered = write("role.kwlrec", { ...doc, cert: { ...doc.cert, role: doc.cert.role === "lawyer" ? "partner" : "lawyer" } });
    await assert.rejects(() => inv("recovery.import_device", { file: roleTampered, password: PW }), /改动过/);
    // ③ v1 形态（无包裹内绑定）+ 证书被改：律所根验签不过 → 拒绝
    const v1Inner = { signPrivateKeyPem: inner.signPrivateKeyPem, encPrivateKeyPem: inner.encPrivateKeyPem };
    const v1Tampered = write("v1-role.kwlrec", { ...doc, v: 1, wrapped: wrapPrivateKeyScrypt(JSON.stringify(v1Inner), PW), cert: { ...doc.cert, role: doc.cert.role === "lawyer" ? "partner" : "lawyer" } });
    await assert.rejects(() => inv("recovery.import_device", { file: v1Tampered, password: PW }), /证书无效/);
    // ④ 私钥换成别的密钥、证书仍是本机的：私钥与证书不符 → 拒绝
    const stranger = generateDeviceKeys();
    const mismatch = write("mismatch.kwlrec", { ...doc, v: 1, wrapped: wrapPrivateKeyScrypt(JSON.stringify({ signPrivateKeyPem: stranger.signPrivateKeyPem, encPrivateKeyPem: stranger.encPrivateKeyPem }), PW) });
    await assert.rejects(() => inv("recovery.import_device", { file: mismatch, password: PW }), /私钥与证书不符/);
    assert.equal(readFileSync(join(ws.keysDir, "device.json"), "utf8"), before, "拒绝时不改 device.json");

    // ⑤ 已吊销设备：拒绝，状态仍为吊销
    await inv("devices.revoke", { device_id: ex.device_id, reason: "测试：设备丢失", self: true });
    await assert.rejects(() => inv("recovery.import_device", { file: out, password: PW }), (e: any) => e.code === "conflict" && /已被律所吊销/.test(e.message));
    const row = k.db.get<{ status: string; revoked_at: string | null }>(`SELECT status, revoked_at FROM devices WHERE device_id = ?`, [ex.device_id]);
    assert.equal(row?.status, "revoked");
    assert.ok(row?.revoked_at);
    assert.equal(getDeviceKeys(ws.keysDir).signPrivateKeyPem, inner.signPrivateKeyPem);
  } finally {
    await k.close();
    configureSecretSealing(ws.keysDir, undefined);
  }
});

test("暂存后到重启前设备被吊销（复核 B4-R09）：重启时复核不通过，恢复不生效、改名留存、记审计，device.json 与设备状态不变", { timeout: 180_000 }, async () => {
  const { getDeviceKeys, configureSecretSealing } = await import("../src/devices.ts");
  const { existsSync, readdirSync } = await import("node:fs");
  const ws = await workspace("rcv-late");
  let k = await ws.open();
  const inv = (m: string, p?: unknown) => k.invoke(m, p) as Promise<any>;
  try {
    const backup = join(ws.dir, "backup", "device.kwlrec");
    const deviceId: string = (await inv("recovery.export_device", { password: PW, path: backup })).device_id;
    await k.close();
    rmSync(join(ws.keysDir, "device.json"));
    k = await ws.open();
    const temp = getDeviceKeys(ws.keysDir);
    assert.equal((await inv("recovery.import_device", { file: backup, password: PW })).staged, true);
    await inv("devices.revoke", { device_id: deviceId, reason: "测试：暂存后吊销", self: true });
    await k.close();
    k = await ws.open();
    assert.equal(getDeviceKeys(ws.keysDir).encPublicKeyPem, temp.encPublicKeyPem, "恢复未生效");
    assert.equal(existsSync(join(ws.keysDir, "recovery-staged.json")), false);
    assert.ok(readdirSync(ws.keysDir).some((f) => f.startsWith("recovery-staged.rejected-")), "改名留存");
    assert.ok(k.db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'recovery.rejected'`));
    assert.equal(k.db.get<{ status: string }>(`SELECT status FROM devices WHERE device_id = ?`, [deviceId])?.status, "revoked");
  } finally {
    await k.close();
    configureSecretSealing(ws.keysDir, undefined);
  }
});
