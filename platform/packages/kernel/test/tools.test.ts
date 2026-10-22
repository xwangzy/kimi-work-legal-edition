/** 法律工具单测（由 tool-gateway 测试平移；引用核验/中文数字/法源版本/利息计算/直接标识符扫描）。
 * 法源数据来自签名法规库测试夹具（content/lawdb/test-fixtures：随包种子 + 虚构的《律师法》2026 修正本，只测改号机制；npm test 的 pretest 会先行构建）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { citationsVerify, extractCitations, extractCaseNumbers } from "../src/tools/tools/citations.ts";
import { cnToInt, intToCn } from "../src/tools/tools/cn-numerals.ts";
import { lawGetVersion } from "../src/tools/tools/law.ts";
import { calcInterest, LPR_1Y } from "../src/tools/tools/calc.ts";
import { redactScan, idCardValid, luhnValid } from "../src/tools/tools/redact.ts";
import { CitationState } from "@zr-legal/domain";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const signerPub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const lawdb = openLawdb(repo("content/lawdb/test-fixtures/lawdb-renumber-demo.sqlite"), { expectedSignerPubPem: signerPub });

test("cn-numerals: 基础转换", () => {
  assert.equal(cnToInt("三十八"), 38);
  assert.equal(cnToInt("四十一"), 41);
  assert.equal(cnToInt("十"), 10);
  assert.equal(cnToInt("十五"), 15);
  assert.equal(cnToInt("一百二十六"), 126);
  assert.equal(cnToInt("一千二百六十"), 1260);
  assert.equal(cnToInt("五百八十五"), 585);
  assert.equal(intToCn(38), "三十八");
  assert.equal(intToCn(41), "四十一");
  assert.equal(intToCn(585), "五百八十五");
  assert.equal(intToCn(1260), "一千二百六十");
});

test("citations: 标准演示用例——《律师法》第三十八条在 2026-10-01 被拦截并提示改引第四十一条", () => {
  const text = "乙方应当遵守《律师法》第三十八条规定的保密义务，对在履行过程中知悉的甲方商业秘密承担保密责任。";
  const r = citationsVerify(lawdb, { text, as_of: "2026-10-01", topic_hint: "保密义务" });
  assert.equal(r.summary.total, 1);
  assert.equal(r.summary.intercepted, 1);
  const v = r.intercepted[0]!;
  assert.equal(v.state, CitationState.intercepted);
  assert.equal(v.matched_law_name, "中华人民共和国律师法");
  assert.equal(v.lsv_id, "lsv_lawyers_2026");
  assert.match(v.suggestion!, /第四十一条/);
  assert.match(v.historical_note!, /2018-01-01/);
  assert.match(v.reasons[0]!, /renumbered/);
});

test("citations: 同一引用在修正施行前（2026-08-31）适用旧版，核验通过", () => {
  const r = citationsVerify(lawdb, { text: "依据《律师法》第三十八条", as_of: "2026-08-31", topic_hint: "保密义务" });
  assert.equal(r.summary.intercepted, 0);
  const v = r.verdicts[0]!;
  assert.equal(v.lsv_id, "lsv_lawyers_2017");
  assert.equal(v.state, CitationState.supportPending);
  assert.equal(v.effectiveness, "amended");
});

test("citations: 已改引第四十一条在新法下通过核验", () => {
  const r = citationsVerify(lawdb, { text: "依据《律师法》第四十一条", as_of: "2026-10-01", topic_hint: "保密义务" });
  assert.equal(r.summary.intercepted, 0);
  assert.equal(r.verdicts[0]!.state, CitationState.supportPending);
});

test("citations: 未知法源拦截且不伪造", () => {
  const r = citationsVerify(lawdb, { text: "依据《宇宙条约》第一条", as_of: "2026-10-01" });
  assert.equal(r.summary.intercepted, 1);
  assert.match(r.intercepted[0]!.reasons[0]!, /unknown_source/);
});

test("citations: 条号超范围拦截", () => {
  const r = citationsVerify(lawdb, { citations: [{ law: "律师法", article: 999 }], as_of: "2026-10-01" });
  assert.equal(r.summary.intercepted, 1);
  assert.match(r.intercepted[0]!.reasons[0]!, /article_out_of_range/);
});

test("citations: 永不返回“律师已确认”（生成器无权标记）", () => {
  const r = citationsVerify(lawdb, { text: "依据《民法典》第五百八十五条", as_of: "2026-10-01" });
  for (const v of r.verdicts) assert.notEqual(v.state, CitationState.lawyerConfirmed);
});

test("citations: 提取多条引用", () => {
  const text = "根据《民法典》第五百零九条与《民法典》第五百八十五条，并结合《律师法》第四十一条……";
  const raws = extractCitations(text);
  assert.equal(raws.length, 3);
  assert.deepEqual(raws.map((x) => x.article), [509, 585, 41]);
});

test("citations: 案号离线一律「未核实（离线）」，且提取边界如实", () => {
  const text = "参见（2023）最高法民终123号判决与(2024)京01民终1234号裁定；另见《民法典》第五百零九条。";
  assert.deepEqual(extractCaseNumbers(text), ["（2023）最高法民终123号", "(2024)京01民终1234号"]);
  const r = citationsVerify(lawdb, { text, as_of: "2026-10-01" });
  assert.equal(r.summary.unverified_offline, 2);
  const cases = r.verdicts.filter((v) => v.kind === "case");
  assert.equal(cases.length, 2);
  for (const v of cases) {
    assert.equal(v.state, CitationState.unverifiedOffline);
    assert.match(v.reasons[0]!, /case_offline_unverified/);
  }
  // 法条引用不受案号影响，照常核验
  assert.equal(r.verdicts.filter((v) => v.kind === "statute").length, 1);
});

test("law.get_version: 时点取版本，现行与历史分开", () => {
  const before = lawGetVersion(lawdb, { law: "律师法", as_of: "2026-01-15" });
  assert.equal(before.version!.lsv_id, "lsv_lawyers_2017");
  const after = lawGetVersion(lawdb, { law: "律师法", as_of: "2026-10-01" });
  assert.equal(after.version!.lsv_id, "lsv_lawyers_2026");
  assert.equal(after.topic_article, undefined);
  const withTopic = lawGetVersion(lawdb, { law: "中华人民共和国律师法", as_of: "2026-10-01", topic: "保密义务" });
  assert.equal(withTopic.topic_article, 41);
  const unknown = lawGetVersion(lawdb, { law: "不存在的法", as_of: "2026-10-01" });
  assert.equal(unknown.found, false);
});

test("calc.interest: 固定利率单段", () => {
  const r = calcInterest({ principal_yuan: 100000, start_date: "2026-01-01", end_date: "2026-02-01", rate: { kind: "fixed", annual_pct: 6 } });
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0]!.days, 31);
  assert.equal(r.total_interest_yuan, 509.59);
  assert.equal(r.total_yuan, 100509.59);
  assert.ok(r.assumptions.length >= 4);
});

test("calc.interest: LPR 分段跨年切换", () => {
  const r = calcInterest({ principal_yuan: 1000000, start_date: "2025-01-01", end_date: "2025-07-01", rate: { kind: "lpr_plus", lpr_term: "1Y", plus_bp: 0 } });
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0]!.annual_pct, 3.1);
  assert.equal(r.segments[0]!.to, "2025-05-20");
  assert.equal(r.segments[1]!.annual_pct, 3.0);
  const days0 = r.segments[0]!.days;
  const days1 = r.segments[1]!.days;
  assert.equal(days0 + days1, 181);
  const expect0 = Math.round((1000000 * 0.031 * days0) / 365 * 100) / 100;
  const expect1 = Math.round((1000000 * 0.03 * days1) / 365 * 100) / 100;
  assert.equal(r.total_interest_yuan, Math.round((expect0 + expect1) * 100) / 100);
});

test("calc.interest: 参数校验", () => {
  assert.throws(() => calcInterest({ principal_yuan: -1, start_date: "2026-01-01", end_date: "2026-02-01", rate: { kind: "fixed", annual_pct: 6 } }));
  assert.throws(() => calcInterest({ principal_yuan: 1, start_date: "2026-02-01", end_date: "2026-01-01", rate: { kind: "fixed", annual_pct: 6 } }));
  assert.throws(() => calcInterest({ principal_yuan: 1, start_date: "2010-01-01", end_date: "2010-02-01", rate: { kind: "lpr_plus", lpr_term: "1Y", plus_bp: 0 } }));
});

test("calc.interest: LPR 种子单调且已知锚点正确", () => {
  for (let i = 1; i < LPR_1Y.length; i++) assert.ok(LPR_1Y[i]!.effective > LPR_1Y[i - 1]!.effective);
  assert.equal(LPR_1Y.at(-1)!.pct, 3.0);
});

test("redact.scan: 身份证校验位与掩码", () => {
  assert.equal(idCardValid("11010519491231002X"), true);
  assert.equal(idCardValid("110105194912310021"), false);
  const r = redactScan({ text: "当事人身份证号 11010519491231002X，手机 13800138000。" });
  assert.equal(r.counts["id_card"], 1);
  assert.equal(r.counts["mobile"], 1);
  const idF = r.findings.find((f) => f.type === "id_card")!;
  assert.equal(idF.valid, true);
  assert.equal(idF.masked, "110105********002X");
  assert.ok(!r.findings.some((f) => f.masked.includes("11010519491231002X")));
});

test("redact.scan: 银行卡 Luhn 与 USCC、邮箱", () => {
  assert.equal(luhnValid("6222020200112233"), false);
  const r = redactScan({ text: "统一社会信用代码 91110108MA01C8Y87K，邮箱 zhang.san@example.com。" });
  assert.equal(r.counts["uscc"], 1);
  assert.equal(r.counts["email"], 1);
});

test("redact.scan: 如实声明未覆盖类别", () => {
  const r = redactScan({ text: "普通文本" });
  assert.ok(r.coverage_notes.some((n) => n.includes("未覆盖")));
});
