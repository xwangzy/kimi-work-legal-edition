/**
 * v9.4 第 26 批（精修）内核：任务名（场景卡名）写进快照并在列表、待办、搜索、“还有任务在进行”的提示里使用；
 * 开始前确认的要点带性质（界面按它用不同记号，要点原文不变）；给律所看的本机功能一览不含研发台账内容。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { importText, makeKernel, waitRun, type TestKernel } from "./helpers.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b26-firm");
});
after(async () => {
  await tk.kernel.close();
});

async function matterWithDoc(title: string) {
  const { matter } = await tk.inv("matters.create", { title, stance: "原告", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(tk.inv, matter.matter_id, "签收单.txt", "签收单：买方于 2026 年 3 月 1 日签收全部货物。");
  return { matter, doc };
}

test("任务名：发起时给的卡名写进快照，任务详情、事项任务列表、最近任务、待办与搜索都用它；不给时没有 title", async () => {
  const { matter, doc } = await matterWithDoc("任务名测试（原告）");
  const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s2.case_file", document_version_ids: [doc.document_version_id] });
  const run = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b26-title-${Date.now()}`, title: "  整理案卷\n（本机）  " });
  const done = await waitRun(tk.inv, run.run_id);
  assert.equal(done.run.input_snapshot.title, "整理案卷 （本机）", "空白压成一个空格、两端去掉");

  const m = await tk.inv("matters.get", { matter_id: matter.matter_id });
  assert.equal(m.runs.find((r: any) => r.run_id === run.run_id)?.title, "整理案卷 （本机）");
  const recent = await tk.inv("runs.list_recent", { limit: 20 });
  assert.equal(recent.runs.find((r: any) => r.run_id === run.run_id)?.title, "整理案卷 （本机）");
  const found = await tk.inv("search.titles", { q: "整理案卷", labels: {} });
  assert.equal(found.runs.find((r: any) => r.run_id === run.run_id)?.title, "整理案卷 （本机）", "搜索按任务名命中");

  // 超长截到 40 字；没给 title 的任务快照里没有这个键
  const est2 = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s2.case_file", document_version_ids: [doc.document_version_id] });
  const long = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est2.estimate_id, idempotency_key: `b26-long-${Date.now()}`, title: "一".repeat(60) });
  assert.equal([...(await waitRun(tk.inv, long.run_id)).run.input_snapshot.title].length, 40);
  const est3 = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s2.case_file", document_version_ids: [doc.document_version_id] });
  const plain = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est3.estimate_id, idempotency_key: `b26-plain-${Date.now()}` });
  assert.equal("title" in (await waitRun(tk.inv, plain.run_id)).run.input_snapshot, false);
});

test("开始前确认的要点带性质：与要点一一对应；按原文发送的那句是 plain、换代号的是 protect、经谁转发是 route", async () => {
  const { matter } = await tk.inv("matters.create", {
    title: "要点性质测试（原告）",
    stance: "原告",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
  });
  const doc = await importText(tk.inv, matter.matter_id, "签收单.txt", "签收单：买方于 2026 年 3 月 1 日签收全部货物。");
  const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id], goal: "整理时间线" });
  const { bullets, bullet_kinds } = est.data_where;
  assert.equal(bullet_kinds.length, bullets.length, "每句要点都有性质");
  assert.deepEqual(bullet_kinds, ["route", "protect", "plain", "search", "keep"]);
  assert.match(bullets[bullet_kinds.indexOf("plain")], /按原文/);
  assert.match(bullets[bullet_kinds.indexOf("protect")], /换成代号/);
  assert.match(bullets[bullet_kinds.indexOf("route")], /经中软转发/, "经谁转发仍写明（复核 Q1-11）");
  const local = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s2.case_file", document_version_ids: [doc.document_version_id] });
  assert.deepEqual(local.data_where.bullet_kinds, ["local"]);
  assert.equal(local.data_where.bullets.length, 1);
});

test("本机功能一览：几行律师话，状态只有可用 / 未开启 / 本版本没有 / 未知这几种；不含阶段代号、复核与偏离编号、内部实体名", async () => {
  const caps = await tk.inv("kernel.capabilities", {});
  assert.ok(Array.isArray(caps.customer_rows) && caps.customer_rows.length >= 5 && caps.customer_rows.length <= 10);
  const DEV = /\b[A-Z]{1,3}\d?-\d+\b|\bP[0-3]\b|\bG[0-2]\b|偏离|复核 ?[A-Z]|待实现|销售口径|kap-|[A-Za-z]+\(|_URL|执行域|端点/;
  for (const r of caps.customer_rows) {
    assert.ok(["可用", "未开启", "暂不可用", "这台电脑未开启", "本版本没有", "未知"].includes(r.status), r.status);
    assert.doesNotMatch(`${r.feature}${r.note}`, DEV, r.feature);
    assert.ok([...r.note].length <= 25, `说明 ≤ 25 字：${r.note}`);
  }
  assert.doesNotMatch(caps.execution_domain.status, /P2|正式验收|杀软矩阵/, "执行域状态不写研发验收进度");
});
