/**
 * 示例事项（v9.2 §4.4；Y4 §5 D-6、#24）：一次性放入虚构的股权转让事项（合成 DOCX + 三张示例风险卡，锚点全部定位），
 * 不调用模型、不联网（无去向记录）；列表标“示例”；移除走结案与删除流程、留墓碑，之后不再自动放入。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, waitRun } from "./helpers.ts";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "sample-matter-secret-0123456789";

test("示例事项：放入一次、卡片定位、无出站；标为示例；移除后不再放入", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({}, "sample-firm");
  try {
    assert.deepEqual(await tk.inv("samples.status", {}), { installed: false, removed: false, matter_id: null, matter_ids: [], litigation_offered: false });
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

    // 诉讼线示例（Z3 #27）：四份材料 + 本机整理案卷（证据目录、事实时间轴、争点框架），同样不联网
    assert.equal(r.matter_ids.length, 2);
    const litId = r.matter_ids[1];
    const lit = await tk.inv("matters.get", { matter_id: litId });
    assert.equal(lit.matter.title, "示例 · 买卖合同纠纷（原告）");
    assert.equal(lit.matter.is_sample, true);
    assert.equal(lit.documents.length, 4);
    assert.equal(lit.runs.length, 1);
    assert.equal(lit.runs[0].scenario, "s2.case_file");
    const done = await waitRun(tk.inv, lit.runs[0].run_id, 90_000);
    assert.equal(done.run.status, "succeeded", JSON.stringify(done.events.map((e: any) => e.type)));
    const kinds = done.artifacts.map((a: any) => a.kind);
    for (const k of ["s2_evidence_catalog", "s2_timeline", "s2_matrix"]) assert.ok(kinds.includes(k), k);
    const fx = done.events.find((e: any) => e.type === "facts.extracted");
    assert.ok(fx.payload.dates >= 5 && fx.payload.amounts >= 3, JSON.stringify(fx.payload));
    assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM egress_records WHERE matter_id = ?`, [litId])!.n, 0, "诉讼示例不联网");
    assert.deepEqual((await tk.inv("samples.status", {})).matter_ids, [r.matter_id, litId]);

    await tk.inv("samples.remove", { matter_id: r.matter_id });
    const half = await tk.inv("samples.status", {});
    assert.deepEqual([half.installed, half.removed, half.matter_id], [true, true, litId], "移除一件，另一件还在");
    await tk.inv("samples.remove", { matter_id: litId });
    assert.deepEqual(await tk.inv("samples.status", {}), { installed: false, removed: true, matter_id: null, matter_ids: [], litigation_offered: true });
    const after = await tk.inv("samples.install", {});
    assert.equal(after.installed, false, "移除后不再自动放入");
    assert.equal(after.matter_id, null);
    await assert.rejects(() => tk.inv("samples.remove", { matter_id: "mat_x" }), (e: any) => e.code === "validation");
  } finally {
    await tk.kernel.close();
  }
});

test("只放诉讼示例（余项续复核 RC-B-13）：已放过非诉示例的电脑可补放一次；放过后不再提示", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({}, "sample-lit-firm");
  try {
    // 模拟诉讼示例上线前的老电脑：只有非诉示例
    const { matter } = await tk.inv("matters.create", { title: "甲公司股权转让（示例）", stance: "受让方", consent_status: "not_required" });
    tk.kernel.db.run(`INSERT INTO sample_matters (matter_id) VALUES (?)`, [matter.matter_id]);
    assert.equal((await tk.inv("samples.status", {})).litigation_offered, false);
    assert.equal((await tk.inv("samples.install", {})).installed, false, "整套示例不再放入");
    const r = await tk.inv("samples.install", { kind: "litigation" });
    assert.equal(r.installed, true);
    assert.equal(r.matter_ids.length, 1);
    const st = await tk.inv("samples.status", {});
    assert.equal(st.litigation_offered, true);
    assert.equal(st.matter_ids.length, 2);
    assert.equal((await tk.inv("samples.install", { kind: "litigation" })).installed, false, "只补放一次");
    const lit = await tk.inv("matters.get", { matter_id: r.matter_id });
    assert.equal(lit.documents.length, 4);
    assert.equal((await waitRun(tk.inv, lit.runs[0].run_id, 90_000)).run.status, "succeeded");
  } finally {
    await tk.kernel.close();
  }
});
