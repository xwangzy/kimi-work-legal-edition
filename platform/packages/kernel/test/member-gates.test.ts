/**
 * viewer 最小权限（应当-5）：viewer 调事项级写方法一律 403；只读方法可用；
 * 节点身份豁免（firm-node e2e 已覆盖执行路径）——requireMatterWriter 的三条语义。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeKernel, type TestKernel } from "./helpers.ts";

let host: TestKernel;
let viewer: { kernel: any; inv: (m: string, p?: any) => Promise<any> };
const kernels: { close(): Promise<void> }[] = [];

before(async () => {
  host = await makeKernel({}, "gate-firm");
  kernels.push(host.kernel);
  const wsV = mkdtempSync(join(tmpdir(), "kwl-wsV-"));
  mkdirSync(join(wsV, "gate-firm", "keys"), { recursive: true });
  copyFileSync(join(host.dir, "gate-firm", "keys", "firm-root.json"), join(wsV, "gate-firm", "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kv = await createKernel({ dataDir: wsV, firmSlug: "gate-firm", userSlug: "viewer", env: { ...process.env, ZR_MODEL_PROVIDER: "mock" } });
  viewer = { kernel: kv, inv: (m, p) => kv.invoke(m, p) };
  kernels.push(kv);
  // host 登记 viewer 设备并加为 viewer 成员
  const vDev = kv.db.get<any>(`SELECT * FROM devices WHERE device_id = 'dev_gate-firm_viewer'`);
  host.kernel.db.run(
    `INSERT OR IGNORE INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue) VALUES (?,?,?,?,?,?,?, 'active', 1)`,
    [vDev.device_id, vDev.tenant_id, vDev.member_id, vDev.role, vDev.sign_pub_pem, vDev.enc_pub_pem, vDev.cert_json],
  );
});

after(async () => {
  for (const k of kernels) await k.close();
});

test("viewer 写方法一律 403，只读可用；owner 不受影响", async () => {
  const { matter } = await host.inv("matters.create", { title: "权限门事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await host.inv("matters.members.add", { matter_id: matter.matter_id, user_id: "usr_gate-firm_viewer", matter_role: "viewer" });
  // viewer 的工作区经同步获得事项（团队事项 + 其设备包裹）
  const shareDir = mkdtempSync(join(tmpdir(), "kwl-gate-share-"));
  await host.inv("sync.export", { share_dir: shareDir });
  await viewer.inv("sync.import", { share_dir: shareDir });

  // 只读可用
  const got = await viewer.inv("matters.get", { matter_id: matter.matter_id });
  assert.equal(got.matter.matter_id, matter.matter_id, "viewer 可读事项");

  // 写方法 403
  await assert.rejects(
    () => viewer.inv("materials.import", { matter_id: matter.matter_id, filename: "x.txt", data_base64: Buffer.from("x").toString("base64"), mime: "text/plain" }),
    (e: any) => e.code === "forbidden" && /viewer/.test(e.message),
  );
  await assert.rejects(
    () => viewer.inv("matters.update", { matter_id: matter.matter_id, patch: { title: "篡改" } }),
    (e: any) => e.code === "forbidden",
  );
  await assert.rejects(
    () => viewer.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [] }),
    (e: any) => e.code === "forbidden",
  );
  // viewer 调 materials.reparse（真实文档）：精确 403 forbidden（最小权限门，不接受 not_found 兜底）
  const realDoc = await host.inv("materials.import", { matter_id: matter.matter_id, filename: "给viewer的文档.txt", data_base64: Buffer.from("内容").toString("base64"), mime: "text/plain" });
  await host.inv("sync.export", { share_dir: shareDir });
  await viewer.inv("sync.import", { share_dir: shareDir });
  await assert.rejects(
    () => viewer.inv("materials.reparse", { document_version_id: realDoc.document_version_id }),
    (e: any) => e.code === "forbidden" && /viewer/.test(e.message),
  );

  // owner 写不受影响（对照）
  const doc = await host.inv("materials.import", { matter_id: matter.matter_id, filename: "ok.txt", data_base64: Buffer.from("ok").toString("base64"), mime: "text/plain" });
  assert.ok(doc.document_version_id, "owner 写正常");
  await host.inv("matters.update", { matter_id: matter.matter_id, patch: { title: "权限门事项（改）" } });
});

test("墓碑过滤：被移出成员的所有访问失效（含只读）", async () => {
  const { matter } = await host.inv("matters.create", { title: "移出测试事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await host.inv("matters.members.add", { matter_id: matter.matter_id, user_id: "usr_gate-firm_viewer", matter_role: "editor" });
  await host.inv("matters.members.remove", { matter_id: matter.matter_id, user_id: "usr_gate-firm_viewer" });
  // viewer 的库经同步收到墓碑（需先把 viewer 的 wrap 留着——墓碑随 body 传播给仍持钥者；viewer 在移出后无新纪元密钥，但行级访问在本机库即时生效的前提是收到墓碑。
  // 这里直接验证 host 侧语义：requireMatterAccess 以 removed_at IS NULL 过滤）
  assert.equal(
    host.kernel.db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matter.matter_id, "usr_gate-firm_viewer"]),
    undefined,
    "墓碑后成员行不再有效",
  );
  // host 侧拒绝对被移出成员的重复移除
  await assert.rejects(() => host.inv("matters.members.remove", { matter_id: matter.matter_id, user_id: "usr_gate-firm_viewer" }), (e: any) => e.code === "not_found");
  // 显式再授权可复活（清除墓碑）
  await host.inv("matters.members.add", { matter_id: matter.matter_id, user_id: "usr_gate-firm_viewer", matter_role: "viewer" });
  assert.ok(
    host.kernel.db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matter.matter_id, "usr_gate-firm_viewer"]),
    "显式 add 可复活成员行",
  );
});
