/**
 * 第 67 批（V41 工作线 A）论点确认卡重排的守护用例：每条论点一句结论信号（绿 / 橙 / 红）、卡顶一行汇总与底部同一口径、
 * 要件里的事实按现状显示、同一事实在一条论点里只列一次、核对声明缺省不勾、决定的数据结构不变、底部操作区真的贴得住。
 * 样例数据沿用第 66 批 b66-ux.test.ts 的那份（替代其中 outlineAttention / attentionDigest 两条用例）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  argFacts,
  argRiskCount,
  argVerdict,
  basisShort,
  decisionsOf,
  elementEvidence,
  emptyDraft,
  liveFactState,
  outlineOverview,
  pendingFactUses,
  sharedPendingFacts,
  unconfirmedFactsOf,
  type OutlineView,
} from "../src/lib/outline.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

const outline: OutlineView = {
  outline_id: "o1",
  run_id: "r1",
  doc_kind: "民事起诉状",
  title: null,
  status: "proposed",
  decisions: null,
  lawyer_note: null,
  items: [
    {
      arg_id: "a1",
      claim: "被告应支付货款",
      counter: "被告可能抗辩已付款",
      facts: [{ fact_id: "f1", statement: "双方签订合同", confirmed: false }],
      basis: [
        {
          law: "中华人民共和国民法典",
          matched: "中华人民共和国民法典",
          article: 626,
          note: "支付价款",
          check: "version_verified",
          article_text: "买受人应当按照约定的数额和支付方式支付价款。",
          demo: false,
          exceptions: "约定不明时依第五百一十条确定",
          elements: [
            { element: "存在有效合同", status: "to_prove", facts: [] },
            { element: "已到期", status: "to_prove", facts: [] },
            { element: "尚欠价款", status: "fact", facts: [{ fact_id: "f2", statement: "欠 31 万", confirmed: false }] },
            { element: "合同成立", status: "fact", facts: [{ fact_id: "f1", statement: "双方签订合同", confirmed: false }] },
          ],
        },
        { law: "某地方条例", matched: null, article: 3, note: null, check: "intercepted", article_text: null, demo: false },
      ],
    },
    { arg_id: "a2", claim: "支付违约金", counter: null, facts: [{ fact_id: "f1", statement: "双方签订合同", confirmed: false }], basis: [{ law: "民法典", matched: "中华人民共和国民法典", article: 585, note: null, check: "source_verified", article_text: "x", demo: false, mode: "analogy" }] },
  ],
};
const a1 = outline.items[0]!;
const a2 = outline.items[1]!;

test("结论信号：核对不过 / 法规库未收录是红；只说最要紧的一件事，其余用简称接在后面", () => {
  const v = argVerdict(a1, emptyDraft(), liveFactState(outline));
  assert.equal(v.tone, "risk");
  assert.equal(v.label, "依据有问题");
  assert.equal(v.issue, "《某地方条例》第 3 条法规库未收录");
  assert.equal(v.more, "另有 2 个要件缺证据、2 条待确认事实", "f1 在论点与要件里各挂一次，只算一条");
  assert.deepEqual([v.basis, v.elements, v.missing, v.basisRisk, v.pendingFacts], [2, 4, 2, 1, 2]);
});

test("结论信号：去掉有问题的依据后降为橙，写出第一个缺证据的要件名；类推单独是橙", () => {
  const v = argVerdict(a1, { ...emptyDraft(), dropBasis: { a1: [1] } }, liveFactState(outline));
  assert.equal(v.tone, "warn");
  assert.equal(v.label, "有疑点");
  assert.equal(v.issue, "2 个要件缺证据，如「存在有效合同」");
  assert.equal(v.more, "另有 2 条待确认事实");
  const w = argVerdict(a2, emptyDraft(), liveFactState(outline));
  assert.equal(w.tone, "warn");
  assert.equal(w.issue, "《中华人民共和国民法典》第 585 条为类推适用，无直接依据");
});

test("结论信号：条文都核过、要件都有已确认的事实才是绿", () => {
  const ok: OutlineView = {
    ...outline,
    items: [{ ...a1, facts: [{ fact_id: "f1", statement: "双方签订合同", confirmed: true }], basis: [{ ...a1.basis[0]!, elements: [{ element: "合同成立", status: "fact", facts: [{ fact_id: "f1", statement: "双方签订合同", confirmed: false }] }, { element: "无争议", status: "undisputed", facts: [] }] }] }],
  };
  const v = argVerdict(ok.items[0]!, emptyDraft(), liveFactState(ok));
  assert.deepEqual([v.tone, v.label, v.issue, v.more], ["ok", "依据已核", "条文已核，要件都有事实", null], "要件里的 f1 是提交时的快照（未确认），以论点上的现状（已确认）为准");
});

test("事实依据：同一事实在一条论点里只列一次并编号；要件行按编号引用；缺证据、待你确认、无争议分开写", () => {
  const live = liveFactState(outline);
  const facts = argFacts(a1, emptyDraft(), live);
  assert.deepEqual(facts.map((f) => [f.n, f.fact_id]), [[1, "f1"], [2, "f2"]]);
  const els = a1.basis[0]!.elements!;
  assert.deepEqual(elementEvidence(els[0]!, facts, live), { tone: "warn", text: "缺证据", refs: [] });
  assert.deepEqual(elementEvidence(els[2]!, facts, live), { tone: "warn", text: "待你确认", refs: [2] });
  assert.deepEqual(elementEvidence(els[3]!, facts, live), { tone: "warn", text: "待你确认", refs: [1] });
  assert.equal(elementEvidence({ element: "x", status: "fact", facts: [] }, facts, live).text, "缺证据（标了有事实，但没挂上）");
  assert.equal(elementEvidence({ element: "x", status: "opponent_burden", facts: [] }, facts, live).tone, "gray");
  // 律师在别处确认了 f1：论点上的事实被内核刷新，要件里的快照没刷新——卡上按现状显示“已确认”
  const after: OutlineView = { ...outline, items: [{ ...a1, facts: [{ fact_id: "f1", statement: "双方签订合同", confirmed: true }] }, a2] };
  const live2 = liveFactState(after);
  assert.deepEqual(elementEvidence(els[3]!, argFacts(after.items[0]!, emptyDraft(), live2), live2), { tone: "ok", text: "已确认", refs: [1] });
});

test("卡顶汇总与底部同一口径：事实数 = 底部可一并确认的数；去掉的论点与依据不算", () => {
  const live = liveFactState(outline);
  const ov = outlineOverview(outline, emptyDraft(), live);
  assert.deepEqual(ov.map((o) => [o.key, o.text, o.args]), [
    ["risk", "1 条依据有问题", ["a1"]],
    ["basis", "1 条依据需核对", ["a2"]],
    ["missing", "1 条论点有要件缺证据", ["a1"]],
    ["facts", "共 1 条事实待你确认（论点之间共用的只算一次）", []],
  ]);
  assert.equal(unconfirmedFactsOf(outline, emptyDraft()).length, 1, "f2 只挂在要件里、没有挂在论点上，内核 confirm_facts 不会确认它，底部也不计");
  const dropped = outlineOverview(outline, { ...emptyDraft(), drop: { a2: true }, dropBasis: { a1: [1] } }, live);
  assert.deepEqual(dropped.map((o) => o.key), ["missing", "facts"]);
  assert.deepEqual(pendingFactUses(outline, emptyDraft()), [{ fact_id: "f1", statement: "双方签订合同", args: [1, 2] }]);
  assert.deepEqual(pendingFactUses(outline, { ...emptyDraft(), drop: { a1: true } }), [{ fact_id: "f1", statement: "双方签订合同", args: [2] }]);
});

test("短称：去掉“中华人民共和国”，司法解释写成“××法解释”", () => {
  assert.equal(basisShort({ law: "中华人民共和国民法典", matched: "中华人民共和国民法典", article: 626 }), "民法典第 626 条");
  assert.equal(basisShort({ law: "x", matched: "最高人民法院关于适用《中华人民共和国民事诉讼法》的解释", article: 18 }), "民事诉讼法解释第 18 条");
  assert.equal(basisShort({ law: "诉讼费用交纳办法", matched: null, article: null }), "诉讼费用交纳办法");
});

test("决定的数据结构不变：改写后再点“采用”（删掉改写）不传 claim；“不用”只传 keep=false", () => {
  const plain = (s: string) => s;
  const { a1: _x, ...rest } = { a1: "改过的论点" };
  assert.deepEqual(decisionsOf(outline, { ...emptyDraft(), claim: rest }, plain), [
    { arg_id: "a1", keep: true },
    { arg_id: "a2", keep: true },
  ]);
  assert.deepEqual(decisionsOf(outline, { drop: { a2: true }, claim: { a1: "改过的论点" }, dropBasis: { a1: [1] } }, plain), [
    { arg_id: "a1", keep: true, claim: "改过的论点", basis_keep: [0] },
    { arg_id: "a2", keep: false },
  ]);
});

test("卡片结构：三选一、规则收进弹出说明、核对声明缺省不勾且文字仍含“同时确认”、主按钮前缀不变、没有橙色“需要你判断”整块", () => {
  const card = src("components/OutlineConfirm.tsx");
  assert.match(card, /const \[withFacts, setWithFacts\] = useState\(false\)/, "“我已对照材料核过”是律师本人的声明，缺省不勾");
  assert.match(card, /同时确认这 \{pendingFacts\.length\} 条事实（我已对照材料核过）/, "评测驱动按“同时确认”找这个复选框（eval/driver.js、e2e ui.mjs）");
  assert.match(card, /确认并开始起草（\{kept\} 条论点）/, "评测驱动按这个按钮前缀点");
  assert.match(card, /role="radiogroup"/);
  assert.match(card, /\{ v: "keep", label: "采用"[\s\S]*\{ v: "edit", label: "改写"[\s\S]*\{ v: "drop", label: "不用"/);
  assert.match(card, /function RulesTip\(\)[\s\S]*签发时须写明不确认的理由/);
  assert.match(card, /法律依据[\s\S]*事实依据[\s\S]*风险与对方抗辩/, "展开后固定顺序");
  assert.doesNotMatch(card, /oc-attn|需要你判断<\/div>|助手只按你采用的论点与依据起草。系统核对/, "旧的橙色清单与卡头三行规则不再出现");
  const css = src("styles-outline.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /\.card-confirm\.oc \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.doesNotMatch(rule, /overflow:\s*hidden/, "overflow:hidden 会让底部操作区的 sticky 失效（第 66 批主按钮不在首屏的根因）");
  assert.match(css, /\.oc-foot \{ position: sticky; bottom: calc\(-1 \* var\(--sp-6\)\);/);
});

test("提问卡里的论点确认题（与别的题同卡）：收成一行状态，卡头只数其余的题；作答内容照旧（确认后自动选上“已确认”）", () => {
  const c = src("components/Cards.tsx");
  assert.match(c, /const others = outlineLock \? card\.questions\.filter\(\(q\) => q\.id !== outlineLock\.qid\) : card\.questions;/);
  assert.match(c, /还要你定 \$\{others\.length\} 件事/);
  assert.match(c, /className=\{`q-lock\$\{outlineLock\.confirmed \? " is-done" : ""\}`\} role="status"/);
  assert.match(c, /lockQ\.options\.find\(\(o\) => \/\^先不起草\/\.test\(o\.label\.trim\(\)\)\) \?\? lockQ\.options\.find\(\(o\) => o\.id !== outlineLock!\.confirm\)/, "“已确认……”不在提问卡上选，只能在论点卡确认后自动选上；“先不起草”仍可选");
  assert.match(c, /if \(lockQid && lockConfirm && lockConfirmed\) setDraft/, "确认后自动选上（第 31 批）不变");
  assert.match(c, /onAnswer\(buildAnswers\(card\.questions, draft\)\)/, "作答仍覆盖全部题目，形状不变");
  assert.doesNotMatch(c, /要按论点起草，请先在上面的论点卡确认/);
});

test("第二轮：各行写明与其他论点共用几条，卡顶 = 底部 = 去重后的条数", () => {
  const live = liveFactState(outline);
  const shared = sharedPendingFacts(outline, emptyDraft(), live);
  assert.deepEqual([...shared], ["f1"], "f1 被两条论点引用");
  const v = argVerdict(a2, { ...emptyDraft(), dropBasis: { a2: [0] } }, live, (s) => s, shared);
  assert.equal(v.issue, "引用 1 条待确认事实，其中 1 条与其他论点共用");
  assert.equal(argVerdict(a1, { ...emptyDraft(), dropBasis: { a1: [1] } }, live, (s) => s, shared).pendingShared, 1);
  assert.equal(sharedPendingFacts(outline, { ...emptyDraft(), drop: { a2: true } }, live).size, 0, "去掉的论点不算共用");
  const ov = outlineOverview(outline, emptyDraft(), live).find((o) => o.key === "facts")!;
  assert.match(ov.text, new RegExp(`^共 ${unconfirmedFactsOf(outline, emptyDraft()).length} 条事实待你确认`));
  const card = src("components/OutlineConfirm.tsx");
  assert.match(card, /className="oc-el-fact" title=\{backing\}/, "要件下面就地写事实原文，悬停看全文");
  assert.match(card, /助手没有列出但书或对方可能的反驳——请自行判断。/, "没有风险提示也要写明");
  const css = src("styles-outline.css");
  assert.match(css, /\.oc-seg-btn\[aria-checked="true"\] \{[^}]*border-color: var\(--border-strong\);[^}]*font-weight: 600;/);
  assert.match(css, /\.oc-dropped \.oc-claim-text \{ color: var\(--text-label\); text-decoration: line-through;/, "“不用”整行变浅并划掉（不用 opacity：门禁只给禁用态）");
  assert.match(css, /\.card-question\.has-outline-lock \.q-option\.on[^{]*\{ border: 1px solid var\(--text-primary\);/);
  assert.match(css, /\.card-question\.has-outline-lock \.cc-actions \{ flex-direction: row-reverse;/);
});

test("第三轮：折叠行就能看到风险条数；先不起草在按钮区、作答形状不变；提示与卡头单复数一致；操作栏贴底时读作页面操作栏", () => {
  assert.equal(argRiskCount(a1, emptyDraft()), 2, "第 626 条的但书 + 对方可能的反驳");
  assert.equal(argRiskCount(a1, { ...emptyDraft(), dropBasis: { a1: [0] } }), 1, "去掉的依据里的但书不算");
  assert.equal(argRiskCount(a2, emptyDraft()), 0);
  const card = src("components/OutlineConfirm.tsx");
  assert.match(card, /\{risks > 0 \? `\$\{risks\} 个风险` : "无风险提示"\}/);
  assert.match(card, /className=\{`oc-foot\$\{stuck \? " is-stuck" : ""\}`\}/);
  const c = src("components/Cards.tsx");
  assert.match(c, /onClick=\{\(\) => onAnswer\(buildAnswers\(card\.questions, pickOption\(draft, lockQ, stopOpt\.id\)\)\)\}/, "先不起草 = 论点题选该项 + 其余按已选（没选的 skipped），与原来选项后点确定同一形状");
  assert.match(c, /"已选好；在上方确认论点后点确定。"/);
  assert.doesNotMatch(c, /这几件已选好|q-lock-alt/);
  const css = src("styles-outline.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.oc-foot\.is-stuck \{ border-radius: 0; box-shadow:/);
});
