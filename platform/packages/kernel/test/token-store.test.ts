/**
 * 事项令牌存储（v9 第 02 篇 §8.4；阶段 4 审查 S4-08）：
 * 闸门（缓存的令牌化器）与内核各自首次为两个不同的值分配到同一 6 位短编号时，内核按事项密钥重算发现分叉——
 * 该代号登记为冲突，此后一律不还原（宁可不还原，也不还原成另一个值），并递增策略版本让闸门重建。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { MatterTokenizer } from "@zr-legal/tokenizer";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { MatterTokenStore } from "../src/egress/matter-tokens.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "token-store-firm");
});

after(async () => {
  await tk.kernel.close();
});

test("S4-08 短编号分叉：内核登记冲突代号，还原时不还原成另一个值；策略版本递增", { timeout: 120_000 }, async () => {
  const store = new MatterTokenStore(tk.kernel.db);
  const { matter } = await tk.inv("matters.create", { title: "碰撞", stance: "原告", consent_status: "agreed" });
  const key = store.keyFor(matter.matter_id);
  // 同一令牌化器内，碰撞的后来者会延长到 10 位：借此找到一对 30 位碰撞的账号 X、Y
  const probe = new MatterTokenizer({ matterKey: key });
  let x = "";
  let y = "";
  for (let i = 0; i < 400_000 && !x; i++) {
    const v = `62220000${String(i).padStart(8, "0")}`;
    const e = probe.tokenFor("account", v);
    if (e.token.length > "〔账号·XXXXXX〕".length) {
      const short = `〔账号·${e.token.slice(4, 10)}〕`;
      const other = probe.table().find((t) => t.token === short);
      if (other) {
        x = v;
        y = other.value;
      }
    }
  }
  assert.ok(x && y, "找到一对碰撞账号");
  // 内核先登记 Y
  const kernelTz = store.tokenizer(matter.matter_id);
  const ey = kernelTz.tokenFor("account", y);
  assert.equal(store.persist(matter.matter_id, [ey]), 1);
  const before = tk.kernel.db.get<{ policy_version: number }>(`SELECT policy_version FROM matters WHERE matter_id = ?`, [matter.matter_id])!.policy_version;
  // 闸门的令牌化器缓存早于 Y 入表：为 X 分得同一 6 位代号并回报
  const gateTz = new MatterTokenizer({ matterKey: key });
  const ex = gateTz.tokenFor("account", x);
  assert.equal(ex.token, ey.token, "两侧分叉：同一代号指向不同的值");
  assert.equal(store.persist(matter.matter_id, [ex]), 0, "内核按密钥重算拒收");
  assert.ok(store.conflicts(matter.matter_id).has(ex.token), "登记为冲突代号");
  const after = tk.kernel.db.get<{ policy_version: number }>(`SELECT policy_version FROM matters WHERE matter_id = ?`, [matter.matter_id])!.policy_version;
  assert.equal(after, before + 1, "策略版本递增（闸门重建令牌化器）");
  // 还原：冲突代号不还原（不会变成 Y 的账号），按未知报告
  const r = store.restore(matter.matter_id, `收款账号 ${ex.token}`);
  assert.equal(r.text, `收款账号 ${ex.token}`);
  assert.ok(!r.text.includes(y));
  assert.deepEqual(r.unknown, [ex.token]);
});
