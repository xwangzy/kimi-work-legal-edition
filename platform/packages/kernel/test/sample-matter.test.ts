/**
 * 示例事项（v9.2 §4.4；Y4 §5 D-6、#24）：一次性放入虚构的股权转让事项（合成 DOCX + 三张示例风险卡，锚点全部定位），
 * 不调用模型、不联网（无去向记录）；列表标“示例”；移除走结案与删除流程、留墓碑，之后不再自动放入。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKernel } from "./helpers.ts";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "sample-matter-secret-0123456789";

test("示例事项：放入一次、卡片定位、无出站；标为示例；移除后不再放入", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({}, "sample-firm");
  try {
    assert.deepEqual(await tk.inv("samples.status", {}), { installed: false, removed: false, matter_id: null });
    const r = await tk.inv("samples.install", {});
    assert.equal(r.installed, true);
    const again = await tk.inv("samples.install", {});
    assert.equal(again.installed, false, "只放入一次");
    assert.equal(again.matter_id, r.matter_id);
    const list = await tk.inv("matters.list", {});
    const m = list.matters.find((x: any) => x.matter_id === r.matter_id);
    assert.equal(m.is_sample, true);
    const got = await tk.inv("matters.get", { matter_id: r.matter_id });
    assert.equal(got.matter.is_sample, true);
    assert.equal(got.documents.length, 1);
    const cards = tk.kernel.db.all<{ anchor_status: string; severity: string }>(`SELECT anchor_status, severity FROM risk_cards WHERE matter_id = ? ORDER BY seq`, [r.matter_id]);
    assert.deepEqual(cards.map((c) => c.severity), ["high", "mid", "low"]);
    assert.ok(cards.every((c) => c.anchor_status === "located"), JSON.stringify(cards));
    assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM egress_records WHERE matter_id = ?`, [r.matter_id])!.n, 0, "示例事项不联网");
    await tk.inv("samples.remove", { matter_id: r.matter_id });
    assert.deepEqual(await tk.inv("samples.status", {}), { installed: false, removed: true, matter_id: null });
    const after = await tk.inv("samples.install", {});
    assert.equal(after.installed, false, "移除后不再自动放入");
    assert.equal(after.matter_id, null);
    await assert.rejects(() => tk.inv("samples.remove", { matter_id: "mat_x" }), (e: any) => e.code === "validation");
  } finally {
    await tk.kernel.close();
  }
});
