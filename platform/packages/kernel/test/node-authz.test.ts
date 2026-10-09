/**
 * 节点逐事项授权（§5.3 服务成员；v0 同机节点设备形态）：
 * strict 拒绝授权；authorize → 节点设备可解当前纪元；revoke → 节点不再能解新内容。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { unwrapMatterKey } from "@zr-legal/keys";
import { getDeviceKeys, getNodeDeviceKeys, keysDirOf } from "../src/index.ts";
import { join } from "node:path";
import { makeKernel, type TestKernel } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "node-firm");
});

after(async () => {
  await tk.kernel.close();
});

function hostUnwrap(matterId: string, epoch: number): Uint8Array {
  const row = tk.kernel.db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [
    matterId,
    epoch,
    `dev_node-firm_test-lawyer`,
  ])!;
  return unwrapMatterKey(row.wrapped_key, getDeviceKeys(keysDirOf(join(tk.dir, "node-firm"))).encPrivateKeyPem);
}

test("strict 事项拒绝节点授权", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "高敏事项", stance: "受让方", consent_status: "not_required", confidentiality: "strict" });
  await assert.rejects(() => inv("matters.node_authorize", { matter_id: matter.matter_id }), (e: any) => e.code === "forbidden" || /strict/.test(e.message));
  const m = tk.kernel.db.get<any>(`SELECT node_allowed FROM matters WHERE matter_id = ?`, [matter.matter_id]);
  assert.equal(m.node_allowed, 0);
});

test("authorize → 节点设备解得开；revoke → 新内容解不开", async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "节点授权事项", stance: "受让方", consent_status: "not_required" });
  const az = await inv("matters.node_authorize", { matter_id: matter.matter_id });
  const nodeDeviceId = az.node_device_id;
  assert.match(nodeDeviceId, /^node_/);

  // 节点设备可解当前纪元事项密钥（与宿主设备同一把）
  const keysDir = keysDirOf(join(tk.dir, "node-firm"));
  const nodeKeys = getNodeDeviceKeys(keysDir);
  const wrap = kernel.db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = 1 AND wrapped_for = ?`, [matter.matter_id, nodeDeviceId])!;
  const kNode = unwrapMatterKey(wrap.wrapped_key, nodeKeys.encPrivateKeyPem);
  assert.deepEqual(kNode, hostUnwrap(matter.matter_id, 1), "节点与宿主应解出同一把事项密钥");
  assert.equal(kernel.db.get<any>(`SELECT node_allowed FROM matters WHERE matter_id = ?`, [matter.matter_id]).node_allowed, 1);

  // revoke：包裹行删除、node_allowed 复位
  await inv("matters.node_revoke", { matter_id: matter.matter_id });
  assert.equal(kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND epoch = 1 AND wrapped_for = ?`, [matter.matter_id, nodeDeviceId]), undefined);
  assert.equal(kernel.db.get<any>(`SELECT node_allowed FROM matters WHERE matter_id = ?`, [matter.matter_id]).node_allowed, 0);

  // 再轮换（移入移出成员后新纪元）后节点无新纪元包裹行
  assert.equal(kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [matter.matter_id, nodeDeviceId]), undefined);
});
