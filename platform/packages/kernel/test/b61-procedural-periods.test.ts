/**
 * 第 61 批（V35，D-260）calc.deadline 程序期间目录：期间长度、起算事实与依据条号由目录给出，模型只给起算日与变体。
 * 起因：外部评估 R4（庭审排期与期限监控）——产品“新案受理”参考表的答辩期、上诉期、申请执行期间、诉前保全起诉期写着“条号待核”，
 * 没有保全续行（届满七日前）、再审、涉外三十日；期间长度一直由模型自己填。目录条文 2026-11-24 逐条对照法规库原文。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { calcDeadline, proceduralPeriod, PROCEDURAL_PERIOD_TYPES } from "../src/tools/tools/deadline.ts";
import { lawGetArticle } from "../src/tools/tools/law.ts";
import { LAWDB_SHIPPED } from "./helpers.ts";

const signerPub = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/keys/content-signing-dev.pub.json", import.meta.url)), "utf8")).publicKeyPem;
const lawdb = openLawdb(LAWDB_SHIPPED, { expectedSignerPubPem: signerPub });

test("判决上诉期：2026-11-04 电子送达 → 2026-11-19（验收材料 L1b 的一审判决）；境内无住所 30 日", () => {
  const r = calcDeadline({ start: "2026-11-04", type: "appeal_judgment" });
  assert.equal(r.deadline, "2026-11-19");
  assert.equal(r.procedural?.basis[0]?.article, "第一百七十一条第一款");
  assert.match(r.procedural?.start_means ?? "", /判决书送达之日/);
  const f = calcDeadline({ start: "2026-11-04", type: "appeal_judgment", foreign_domicile: true });
  assert.equal(f.period.n, 30);
  assert.equal(f.procedural?.basis[0]?.article, "第二百八十六条");
});

test("裁定上诉期 10 日；一审答辩 15 日（简易程序提示）；劳动仲裁答辩 10 日", () => {
  assert.equal(calcDeadline({ start: "2026-11-04", type: "appeal_ruling" }).period.n, 10);
  const d = calcDeadline({ start: "2026-11-04", type: "defense_first_instance" });
  assert.equal(d.period.n, 15);
  assert.ok(d.warnings.some((w) => /简易程序/.test(w)));
  const l = calcDeadline({ start: "2026-11-04", type: "labor_arbitration_defense" });
  assert.equal(l.period.n, 10);
  assert.equal(l.deadline, "2026-11-16", "日历日十日：11-14 是周六，顺延到 11-16");
  assert.equal(l.alt_deadline?.deadline, "2026-11-18", "办案规则第八十条：10 日指工作日");
  assert.ok(l.alt_deadline?.basis.some((b) => b.article === "第八十条"));
});

test("申请撤销仲裁裁决：新仲裁法（2026-03-01 起）三个月，之前收到的按修订前六个月并提示", () => {
  const n = calcDeadline({ start: "2026-04-10", type: "arbitration_award_setaside" });
  assert.deepEqual(n.period, { unit: "month", n: 3 });
  assert.equal(n.deadline, "2026-07-10");
  const o = calcDeadline({ start: "2026-01-20", type: "arbitration_award_setaside" });
  assert.deepEqual(o.period, { unit: "month", n: 6 });
  assert.ok(o.warnings.some((w) => /新法施行之前/.test(w)));
});

test("保全：冻结存款按一年推算届满日并给续行截止（届满七日前）；按法院告知的届满日算续行截止", () => {
  const e = calcDeadline({ start: "2026-03-10", type: "preservation_expiry", asset: "deposit" });
  assert.equal(e.renewal_deadline, "2027-03-02");
  assert.ok(e.steps.some((s) => s.includes("2027-03-09")), e.steps.join("\n"));
  const r = calcDeadline({ start: "2027-03-09", type: "preservation_renewal" });
  assert.equal(r.deadline, "2027-03-02");
  assert.equal(r.renewal_deadline, "2027-03-02");
  assert.throws(() => calcDeadline({ start: "2026-03-10", type: "preservation_expiry" }), /asset/);
});

test("申请执行期间二年、再审六个月、诉前保全后三十日起诉", () => {
  assert.deepEqual(calcDeadline({ start: "2026-11-30", type: "enforcement_application" }).period, { unit: "year", n: 2 });
  assert.deepEqual(calcDeadline({ start: "2026-11-30", type: "retrial_application" }).period, { unit: "month", n: 6 });
  assert.equal(calcDeadline({ start: "2026-11-30", type: "pre_action_preservation_suit" }).period.n, 30);
});

test("写了 type 又写与目录不同的 period 拒绝；不写 type 的通用计算不变", () => {
  assert.throws(() => calcDeadline({ start: "2026-11-04", type: "appeal_judgment", period: { unit: "day", n: 10 } }), /由目录给出/);
  assert.equal(calcDeadline({ start: "2026-11-04", type: "appeal_judgment", period: { unit: "day", n: 15 } }).deadline, "2026-11-19");
  assert.equal(calcDeadline({ start: "2026-11-04", period: { unit: "day", n: 15 }, rule: "civil" }).deadline, "2026-11-19");
});

test("目录条文与法规库一致：每一条现行法规的依据都能取到原文，且原文含目录写的期间", () => {
  const PERIOD_WORD: Record<number, string> = { 7: "七日", 10: "十日", 15: "十五日", 30: "三十日", 1: "一年", 2: "二年", 3: "三年", 6: "六个月" };
  for (const t of PROCEDURAL_PERIOD_TYPES) {
    const spec = proceduralPeriod(t, { start: "2026-11-24", asset: "movable" })!;
    const b = spec.basis[0]!;
    const no = /^第([一二三四五六七八九十百零]+)条/.exec(b.article)?.[1];
    assert.ok(no, `${t} 条号`);
    const a = lawGetArticle(lawdb, { law: b.law, article: `第${no}条`, as_of: "2026-11-24" });
    assert.equal(a.found, true, `${t}：${b.law}${b.article} 应在法规库里`);
    const n = spec.period.n;
    const word = t === "arbitration_award_setaside" ? "三个月" : t === "preservation_expiry" ? "两年" : t === "labor_award_setaside_employer" ? "三十日" : PERIOD_WORD[n];
    assert.ok(a.text!.includes(word!), `${t}：原文应含“${word}”——${a.text!.slice(0, 80)}`);
  }
});
