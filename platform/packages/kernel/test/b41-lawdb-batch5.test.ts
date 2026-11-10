/**
 * V16 第 41 批：法规库第五批 11 部 447 条全文（采集记录 research/2026-11-10-V16产品体验精修/lawdb-collect5/）：
 * 职工带薪年休假条例、国务院注册资本登记管理制度的规定（行政法规）；企业职工带薪年休假实施办法、劳动人事争议仲裁办案规则（部门规章）；
 * 劳动法（2018 年修正）；公司法时间效力规定、民事诉讼证据规定（2019 年修正）、诉讼时效规定（2020 年修正）、民法典总则编解释、
 * 劳动争议解释（二）、民法典时间效力规定。法律、行政法规、司法解释取国家法律法规数据库官方 Word 文本，部门规章取国务院公报文本，均与第二官方来源逐条比对。
 * 法释〔2024〕15号批复没有条号：以“不分条文件”入库（第 1 条即全文，主题“__全文”标记；引用时不写条号），并在公司法时间效力规定第四条登记合读提示——
 * 真实走查 O16：库里只有时间效力规定而没有批复时，助手核验第四条第（一）项“通过”后会得出与批复相反的结论。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { CitationState } from "@zr-legal/domain";
import { citationsVerify, extractCitations } from "../src/tools/tools/citations.ts";
import { lawGetArticle } from "../src/tools/tools/law.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const pub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const AS_OF = "2026-11-10";

// 每部抽 2～3 条：[书名号简称, 条号, 条文里必须出现的原文片段]
const SAMPLES: [string, number, string][] = [
  ["职工带薪年休假条例", 3, "已满1年不满10年的，年休假5天"],
  ["年休假条例", 10, "自2008年1月1日起施行"],
  ["企业职工带薪年休假实施办法", 10, "日工资收入的300%支付未休年休假工资报酬"],
  ["年休假实施办法", 12, "按照职工当年已工作时间折算应休未休年休假天数"],
  ["劳动人事争议仲裁办案规则", 5, "劳动者一方在10人以上并有共同请求的争议"],
  ["仲裁办案规则", 49, "可以就该部分先行裁决"],
  ["公司法时间效力规定", 1, "公司法施行后的法律事实引起的民事纠纷案件，适用公司法的规定"],
  ["公司法时间效力规定", 4, "股东转让未届出资期限的股权"],
  ["注册资本登记管理规定", 2, "调整至5年内并记载于公司章程"],
  ["国务院关于实施《中华人民共和国公司法》注册资本登记管理制度的规定", 4, "20个工作日内通过国家企业信用信息公示系统向社会公示"],
  ["劳动法", 36, "平均每周工作时间不超过四十四小时"],
  ["中华人民共和国劳动法", 44, "百分之一百五十的工资报酬"],
  ["民事诉讼证据规定", 10, "当事人无须举证证明"],
  ["证据规定", 85, "运用逻辑推理和日常生活经验"],
  ["诉讼时效规定", 1, "支付存款本金及利息请求权"],
  ["最高人民法院关于审理民事案件适用诉讼时效制度若干问题的规定", 8, "权利人向义务人提出履行请求"],
  ["总则编解释", 1, "民法典第二编至第七编对民事关系有规定的"],
  ["民法典总则编解释", 35, "不适用延长的规定"],
  ["劳动争议解释（二）", 19, "无需缴纳社会保险费的，人民法院应当认定该约定或者承诺无效"],
  ["劳动争议司法解释（二）", 20, "在一审或者二审诉讼期间提出仲裁时效抗辩的，人民法院不予支持"],
  ["民法典时间效力规定", 1, "民法典施行后的法律事实引起的民事纠纷案件，适用民法典的规定"],
  ["民法典时间效力规定", 20, "民法典施行前成立的合同"],
];

test("第五批 11 部：law.get_article 取到官方文本、citations.verify 不拦截；超出条数的照常拦截", () => {
  const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: pub });
  try {
    for (const [law, article, needle] of SAMPLES) {
      const r = lawGetArticle(lawdb, { law, article, as_of: AS_OF });
      assert.equal(r.found, true, `${law} 第 ${article} 条：${JSON.stringify(r)}`);
      assert.ok(r.text!.includes(needle), `${law} 第 ${article} 条应含“${needle}”：${r.text}`);
      assert.equal(r.source_license_id, "official-text-collected-2026-11-v16");
      assert.equal(r.reliability, "official_text_collected");
    }
    const v = (text: string) => citationsVerify(lawdb, { text, as_of: AS_OF }).verdicts[0]!;
    for (const t of [
      "《职工带薪年休假条例》第三条",
      "《企业职工带薪年休假实施办法》第十条",
      "《劳动人事争议仲裁办案规则》第五条",
      "《公司法时间效力规定》第四条",
      "《注册资本登记管理规定》第二条",
      "《劳动法》第四十四条",
      "《民事诉讼证据规定》第十条",
      "《诉讼时效规定》第八条",
      "《总则编解释》第三十五条",
      "《劳动争议解释（二）》第十九条",
      "《民法典时间效力规定》第二十条",
    ]) {
      const r = v(t);
      assert.notEqual(r.state, CitationState.intercepted, `${t}：${JSON.stringify(r)}`);
    }
    assert.equal(v("《职工带薪年休假条例》第十一条").state, CitationState.intercepted, "年休假条例只有 10 条");
    assert.equal(v("《劳动法》第一百零八条").state, CitationState.intercepted, "劳动法只有 107 条");
    assert.equal(v("《劳动争议解释（二）》第二十二条").state, CitationState.intercepted, "劳动争议解释（二）只有 21 条");
    // 施行前的时点没有适用版本（不拿后来的文本冒充）
    assert.equal(lawGetArticle(lawdb, { law: "劳动争议解释（二）", article: 1, as_of: "2025-08-31" }).found, false);
    // 无条号的批复：以“不分条文件”入库，见下一条用例
  } finally {
    lawdb.close();
  }
});

test("行政法规、部门规章只认书名号形态：不带书名号的“实施办法第十条”不被认成别的法；劳动法不带书名号照常提取", () => {
  assert.equal(extractCitations("依据企业职工带薪年休假实施办法第十条").some((c) => c.article === 10), false);
  assert.equal(extractCitations("依据年休假实施办法第十条支付").some((c) => c.article === 10), false);
  assert.equal(extractCitations("依据劳动人事争议仲裁办案规则第五条").some((c) => /仲裁法/.test(c.law)), false);
  assert.ok(extractCitations("依据劳动法第四十四条").some((c) => c.law === "劳动法" && c.article === 44));
  assert.ok(extractCitations("依据《企业职工带薪年休假实施办法》第十条").some((c) => c.article === 10));
});

test("不分条的批复：按文件名或文号取到全文并注明不写条号；公司法时间效力规定第四条带合读提示，引用核验结果里写明", () => {
  const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: pub });
  try {
    for (const name of ["最高人民法院关于《中华人民共和国公司法》第八十八条第一款不溯及适用的批复", "公司法第八十八条第一款不溯及适用的批复", "法释〔2024〕15号"]) {
      const r = lawGetArticle(lawdb, { law: name, article: 1, as_of: AS_OF });
      assert.equal(r.found, true, name);
      assert.match(String(r.text), /仅适用于2024年7月1日之后发生的未届出资期限的股权转让行为/);
      assert.equal((r as any).whole_text, true);
      assert.match(String(r.note), /不分条.*不写条号/);
    }
    assert.equal(lawGetArticle(lawdb, { law: "法释〔2024〕15号", article: 2, as_of: AS_OF }).found, false, "没有第二条");
    // 批复施行前的时点：没有适用版本
    assert.equal(lawGetArticle(lawdb, { law: "法释〔2024〕15号", article: 1, as_of: "2024-12-01" }).found, false);
    const art4 = lawGetArticle(lawdb, { law: "公司法时间效力规定", article: 4, as_of: AS_OF }) as any;
    assert.equal(art4.found, true);
    assert.equal(art4.read_with.length, 1);
    assert.match(art4.read_with[0], /法释〔2024〕15号.*仅适用于2024年7月1日之后发生/);
    assert.match(art4.read_with_note, /合读/);
    assert.equal((lawGetArticle(lawdb, { law: "公司法时间效力规定", article: 1, as_of: AS_OF }) as any).read_with, undefined, "别的条没有合读提示");
    const verdict = citationsVerify(lawdb, { text: "《公司法时间效力规定》第四条", as_of: AS_OF }).verdicts[0]! as any;
    assert.equal(verdict.state, CitationState.supportPending);
    assert.ok(verdict.reasons.some((x: string) => x.startsWith("read_with:") && x.includes("法释〔2024〕15号")), JSON.stringify(verdict.reasons));
  } finally {
    lawdb.close();
  }
});
