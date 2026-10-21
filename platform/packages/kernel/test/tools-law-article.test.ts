/**
 * law.get_article（v9.4 评审 S1 §6.2 第 4 项验收）：库内条文返回原文且版本与 law.get_version 一致；
 * 库外 100% found:false 且不给文本；条号数字、中文写法都能解析；as_of 选版本正确；来源授权不足即停。
 * 法源数据来自签名法规库包（content/lawdb/dist，npm test 的 pretest 会先行构建）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb, type Lawdb } from "@zr-legal/lawdb";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";
import { lawGetArticle, lawGetVersion, parseArticleNo } from "../src/tools/tools/law.ts";
import { findTool, legalToolLockProblems, legalToolManifests, validateParams } from "../src/tools/registry.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const signerPub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: signerPub });

test("law.get_article: 库内条文返回原文，版本与 law.get_version 一致", () => {
  const asOf = "2026-10-01";
  const r = lawGetArticle(lawdb, { law: "民法典", article: 585, as_of: asOf });
  const v = lawGetVersion(lawdb, { law: "民法典", as_of: asOf });
  assert.equal(r.found, true);
  assert.equal(r.law_name, "中华人民共和国民法典");
  assert.equal(r.lsv_id, v.version!.lsv_id);
  assert.equal(r.effective, v.version!.effective);
  assert.equal(r.effectiveness, v.version!.effectiveness);
  assert.equal(r.article_no, 585);
  assert.equal(r.text, lawdb.getArticle("lsv_civil_code_2020", 585), "逐字返回法规库采集文本");
  assert.match(r.text!, /^当事人可以约定一方违约时/);
  assert.equal(r.source_license_id, "official-gazette-selfbuilt");
  // 演示库的可信度标记原样返回，界面与方法据此提示“演示数据，不得引用”
  assert.equal(r.reliability, "demo_seed");
  assert.match(r.note, /演示数据/);
});

test("law.get_article: 条号写法——整数、数字串、第585条、第五百八十五条、带款项都解析到同一条", () => {
  const forms: (number | string)[] = [585, "585", "第585条", "第五百八十五条", "五百八十五", "第５８５条", "第五百八十五条第二款"];
  const texts = forms.map((a) => lawGetArticle(lawdb, { law: "中华人民共和国民法典", article: a, as_of: "2026-10-01" }));
  for (const [i, r] of texts.entries()) {
    assert.equal(r.found, true, String(forms[i]));
    assert.equal(r.article_no, 585, String(forms[i]));
    assert.equal(r.text, texts[0]!.text);
  }
  assert.equal(parseArticleNo("第三十八条"), 38);
  assert.equal(parseArticleNo("第一千二百六十条"), 1260);
  assert.equal(parseArticleNo("第二〇条"), null, "“二〇”不是规范条号写法，不猜");
  assert.equal(parseArticleNo("第两百条"), 200);
  for (const bad of [0, -1, 1.5, "", "第条", "第X条", "585条之一", true, null]) assert.equal(parseArticleNo(bad as any), null, String(bad));
});

test("law.get_article: 法名归一——书名号、简称、全称都能命中", () => {
  for (const law of ["《中华人民共和国劳动合同法》", "劳动合同法", "中华人民共和国劳动合同法"]) {
    const r = lawGetArticle(lawdb, { law, article: "第二十三条", as_of: "2026-10-01" });
    assert.equal(r.found, true, law);
    assert.equal(r.lsv_id, "lsv_labor_contract_2012");
    assert.match(r.text!, /保守用人单位的商业秘密/);
  }
});

test("law.get_article: as_of 选版本（律师法 2026 修正施行日 2026-09-01 前后）", () => {
  const old = lawGetArticle(lawdb, { law: "律师法", article: "第三十八条", as_of: "2026-08-31" });
  assert.equal(old.found, true);
  assert.equal(old.lsv_id, "lsv_lawyers_2017");
  assert.equal(old.lsv_id, lawGetVersion(lawdb, { law: "律师法", as_of: "2026-08-31" }).version!.lsv_id);
  assert.equal(old.effectiveness, "amended");
  assert.equal(old.superseded, "2026-09-01");
  const neu = lawGetArticle(lawdb, { law: "律师法", article: 41, as_of: "2026-09-01" });
  assert.equal(neu.found, true);
  assert.equal(neu.lsv_id, "lsv_lawyers_2026");
  assert.equal(neu.lsv_id, lawGetVersion(lawdb, { law: "律师法", as_of: "2026-09-01" }).version!.lsv_id);
  // 新版第三十八条条号存在（共 68 条）但正文未采集：found=false，不拿旧版第三十八条顶替
  const gap = lawGetArticle(lawdb, { law: "律师法", article: 38, as_of: "2026-10-01" });
  assert.equal(gap.found, false);
  assert.equal(gap.reason, "text_not_collected");
  assert.equal(gap.lsv_id, "lsv_lawyers_2026");
  assert.equal(gap.text, undefined);
  // 缺省 as_of 为今天：与按今天取版本一致
  const today = lawGetArticle(lawdb, { law: "民法典", article: 509 });
  assert.match(today.as_of, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(today.found, true);
});

test("law.get_article: 库外、无适用版本、条号不存在——一律 found:false，不给文本", () => {
  const cases = [
    { p: { law: "中华人民共和国公司法", article: 20, as_of: "2026-10-01" }, reason: "law_not_in_lawdb" },
    { p: { law: "民诉法", article: "第八十五条", as_of: "2026-10-01" }, reason: "law_not_in_lawdb" },
    { p: { law: "某某不存在法", article: 1, as_of: "2026-10-01" }, reason: "law_not_in_lawdb" },
    { p: { law: "民法典", article: 585, as_of: "2020-06-01" }, reason: "no_applicable_version" },
    { p: { law: "民法典", article: 1261, as_of: "2026-10-01" }, reason: "article_not_exist" },
    { p: { law: "民法典", article: 1, as_of: "2026-10-01" }, reason: "text_not_collected" },
  ] as const;
  for (const c of cases) {
    const r = lawGetArticle(lawdb, c.p);
    assert.equal(r.found, false, JSON.stringify(c.p));
    assert.equal(r.reason, c.reason, JSON.stringify(c.p));
    assert.equal(r.text, undefined, "不补文本");
    assert.ok(!("text" in r));
  }
});

test("law.get_article: 来源未授权“引用原文 / 送入模型”即停（Source Registry §2.2）", () => {
  const row = lawdb.findLawVersions("民法典")[0]!;
  const fake = (allowed: string[]): Lawdb =>
    ({
      findLawVersions: () => [{ ...row, source_license_id: "seed-x" }],
      getArticle: () => "条文",
      getSource: () => ({ reliability: "demo_seed" }),
      licenseNoteOf: () => "",
      assertAction: (_src: string, action: string) => {
        if (!allowed.includes(action)) throw Object.assign(new Error(`未授权动作「${action}」`), { code: "source_action_denied" });
      },
    }) as unknown as Lawdb;
  assert.throws(() => lawGetArticle(fake(["display", "model"]), { law: "民法典", article: 585, as_of: "2026-10-01" }), /未授权动作「quote」/);
  assert.throws(() => lawGetArticle(fake(["display", "quote"]), { law: "民法典", article: 585, as_of: "2026-10-01" }), /未授权动作「model」/);
  assert.equal(lawGetArticle(fake(["quote", "model"]), { law: "民法典", article: 585, as_of: "2026-10-01" }).text, "条文");
});

test("law.get_article: 参数校验与 schema", () => {
  assert.throws(() => lawGetArticle(lawdb, { law: "", article: 1 }), (e: any) => e.code === "validation");
  assert.throws(() => lawGetArticle(lawdb, { law: "民法典", article: "第X条" }), (e: any) => e.code === "validation");
  assert.throws(() => lawGetArticle(lawdb, { law: "民法典", article: 0 }), (e: any) => e.code === "validation");
  assert.throws(() => lawGetArticle(lawdb, { law: "民法典", article: 585, as_of: "2026/10/01" }), (e: any) => e.code === "validation");
  const schema = findTool("law.get_article")!.inputSchema;
  validateParams(schema, { law: "民法典", article: 585, as_of: "2026-10-01" });
  validateParams(schema, { law: "民法典", article: "第五百八十五条" });
  assert.throws(() => validateParams(schema, { law: "民法典", article: true }), /不匹配任一允许形态/);
  assert.throws(() => validateParams(schema, { law: "民法典", article: 0 }), /不匹配任一允许形态/);
  assert.throws(() => validateParams(schema, { law: "民法典" }), /article 缺失/);
  assert.throws(() => validateParams(schema, { law: "民法典", article: 1, topic: "x" }), /不在 schema/);
});

test("law.get_article 与 calc.deadline 已登记在签名锁文件里并对 Agent 暴露", () => {
  for (const name of ["law.get_article", "calc.deadline"]) {
    assert.ok((LEGAL_MCP_TOOLS as readonly string[]).includes(name), `${name} 在 LEGAL_MCP_TOOLS`);
    assert.ok(legalToolManifests().list().some((m) => m.name === name), `${name} 在验签后的清单注册表`);
    assert.equal(legalToolLockProblems().has(name), false);
  }
  const t = findTool("law.get_article")!;
  assert.equal(t.sideEffect, "read");
  assert.equal(t.resource, "lawdb");
  assert.equal(t.version, "1");
});
