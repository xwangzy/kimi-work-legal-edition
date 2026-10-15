/**
 * 令牌还原的审计与限量（隐私安全审查 P1-5）：还原按（成员, 事项）每分钟合并记一条事项内容审计（只记条数，不记代号与原文）；
 * 调用次数与还原条数超过上限即拒绝（429），界面正常浏览远低于上限。
 */
import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { MatterTokenStore } from "../src/egress/matter-tokens.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "restore-audit-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("还原记审计（按分钟合并、不含原文）并限量", { timeout: 120_000 }, async () => {
  const store = new MatterTokenStore(tk.kernel.db);
  const { matter } = await tk.inv("matters.create", { title: "还原审计", stance: "原告", consent_status: "agreed" });
  const tz = store.tokenizer(matter.matter_id);
  const e = tz.tokenFor("phone", "13912345678");
  store.persist(matter.matter_id, [e]);
  const countAudit = () => tk.kernel.db.all<any>(`SELECT * FROM audit_events WHERE action = 'matter.tokens_restored' AND object_id = ?`, [matter.matter_id]);

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const r = await tk.inv("matters.tokens.restore", { matter_id: matter.matter_id, text: `电话 ${e.token}` });
    assert.equal(r.text, "电话 13912345678");
    for (let i = 0; i < 9; i++) await tk.inv("matters.tokens.restore", { matter_id: matter.matter_id, text: `电话 ${e.token}` });
    assert.equal(countAudit().length, 0, "窗口内不逐次记账");
    mock.timers.tick(60_000);
    const rows = countAudit();
    assert.equal(rows.length, 1, "一分钟合并为一条");
    assert.equal(JSON.stringify(rows).includes("13912345678"), false, "审计不含原文");
    assert.equal(JSON.stringify(rows).includes(e.token), false, "审计不含代号");

    // 限量：同一分钟内超过调用上限即 429
    let limited: any = null;
    for (let i = 0; i < 700 && !limited; i++) {
      await tk.inv("matters.tokens.restore", { matter_id: matter.matter_id, text: "无代号" }).catch((x: any) => {
        limited = x;
      });
    }
    assert.equal(limited?.code, "rate_limited");
    mock.timers.tick(60_000);
  } finally {
    mock.timers.reset();
  }
});

test("限流本身记审计；单次调用超出条数上限即拒绝（复核 B3-A15 / B3-A16）", { timeout: 120_000 }, async () => {
  const store = new MatterTokenStore(tk.kernel.db);
  const { matter } = await tk.inv("matters.create", { title: "单次上限", stance: "原告", consent_status: "agreed" });
  const e = store.tokenizer(matter.matter_id).tokenFor("phone", "13700001111");
  store.persist(matter.matter_id, [e]);
  // 一次传入 6 万个代号：超出每分钟 5 万条 → 429，且没有还原任何内容
  const huge = Array.from({ length: 60_000 }, () => e.token).join(" ");
  await assert.rejects(tk.inv("matters.tokens.restore", { matter_id: matter.matter_id, text: huge }), (x: any) => x.code === "rate_limited");
  const throttled = tk.kernel.db.all<any>(`SELECT * FROM audit_events WHERE action = 'matter.tokens_restore_throttled' AND object_id = ?`, [matter.matter_id]);
  assert.equal(throttled.length, 1, "限流记一条审计");
  // 预写：窗口内第一次成功还原即记“开始还原”
  await tk.inv("matters.tokens.restore", { matter_id: matter.matter_id, text: `电话 ${e.token}` });
  assert.equal(tk.kernel.db.all<any>(`SELECT * FROM audit_events WHERE action = 'matter.tokens_restore_started' AND object_id = ?`, [matter.matter_id]).length, 1);
});

test("内核关闭时冲刷未到期的还原审计：重启后可查（复核 B3-A15）", { timeout: 120_000 }, async () => {
  const k1 = await makeKernel({}, "restore-flush-firm");
  const store = new MatterTokenStore(k1.kernel.db);
  const { matter } = await k1.inv("matters.create", { title: "关闭冲刷", stance: "原告", consent_status: "agreed" });
  const e = store.tokenizer(matter.matter_id).tokenFor("phone", "13600002222");
  store.persist(matter.matter_id, [e]);
  await k1.inv("matters.tokens.restore", { matter_id: matter.matter_id, text: `电话 ${e.token}` });
  await k1.kernel.close();
  const { createKernel } = await import("../src/index.ts");
  const k2 = await createKernel({ dataDir: k1.dir, firmSlug: "restore-flush-firm", userSlug: "test-lawyer", env: { ...process.env, ZR_MODEL_PROVIDER: "mock" } });
  try {
    const rows = k2.db.all<any>(`SELECT * FROM audit_events WHERE action = 'matter.tokens_restored' AND object_id = ?`, [matter.matter_id]);
    assert.equal(rows.length, 1, "关闭前已补记条数");
  } finally {
    await k2.close();
  }
});
