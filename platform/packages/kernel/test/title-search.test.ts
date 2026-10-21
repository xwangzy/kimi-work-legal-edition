/**
 * 全局搜索在内核里匹配（余项续复核 RC-A-05、RC-B-06/07/09）：
 * - 不跨“标题 + 副标题”边界命中；连着输入的中文按“字都在、按顺序”宽松匹配，排在后面；
 * - 本人能看到的全部事项都搜（不只最近 100 件），已删除的、别人的事项不出现；
 * - 代号只在内核里还原用于匹配，命中的才返回；还原记一条 search.titles_restored，不记按事项的“取原文”。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { rankTitles, scoreTitle } from "../src/services/title-search.ts";

test("匹配口径：分词、不跨边界、宽松匹配排后", () => {
  const c = (title: string, sub = "", extra = "") => ({ title, sub, extra });
  assert.equal(scoreTitle("甲公司", c("甲公司股权转让")), 3);
  assert.equal(scoreTitle("转让 甲", c("甲公司股权转让")), 2);
  assert.equal(scoreTitle("修订 买卖", c("修订稿", "买卖合同纠纷")), 1, "每个词都要整个出现在某一处");
  assert.equal(scoreTitle("让乙", c("甲公司股权转让", "乙投资")), 0, "不跨标题与副标题的边界（复核复现的例子）");
  assert.equal(scoreTitle("股权转让修订稿", c("甲公司股权转让（修订稿）")), 0.5, "连着输入：字都在且按顺序");
  assert.equal(scoreTitle("审合同", c("核验起诉状引用", "", "审合同")), 2, "场景名也能搜");
  const ranked = rankTitles("合同", [
    { kind: "matter", title: "买卖合同纠纷", sub: "", at: "2026-10-01", ref: { id: 1 } },
    { kind: "matter", title: "合同审查", sub: "", at: "2026-01-01", ref: { id: 2 } },
    { kind: "matter", title: "股权转让", sub: "合同", at: "2026-12-01", ref: { id: 3 } },
  ]);
  assert.deepEqual(ranked.matter.map((x) => x.ref.id), [2, 1, 3]);
});

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "title-search-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("search.titles：全部事项都搜、已删除的不出现、命中才返回、审计不按事项记取原文", { timeout: 60_000 }, async () => {
  for (let i = 0; i < 105; i++) await tk.inv("matters.create", { title: `顾问事项 ${String(i).padStart(3, "0")}`, stance: "委托人一方", consent_status: "agreed" });
  // 最早建的那件（第 0 件）在“最近 100 件”之外，也要搜得到
  const r = await tk.inv("search.titles", { q: "顾问事项 000", labels: {} });
  assert.deepEqual(r.matters.map((m: any) => m.title), ["顾问事项 000"]);
  const many = await tk.inv("search.titles", { q: "顾问事项", labels: {} });
  assert.equal(many.matters.length, 6, "每类至多 6 条");
  assert.deepEqual(await tk.inv("search.titles", { q: "   " }), { matters: [], runs: [], deliverables: [], truncated: { runs: false, deliverables: false } });
  // 已删除的事项不出现
  const { matter } = await tk.inv("matters.create", { title: "将被删除的事项", stance: "委托人一方", consent_status: "agreed" });
  tk.kernel.db.run(`UPDATE matters SET lifecycle = 'purged' WHERE matter_id = ?`, [matter.matter_id]);
  assert.equal((await tk.inv("search.titles", { q: "将被删除" })).matters.length, 0);
  // 不写按事项的“取原文”审计
  const n = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action LIKE 'matter.tokens_restore%'`)!.n;
  assert.equal(n, 0);
});
