/**
 * 第 57 批：已废止的法律与司法解释。
 * 全量验收（经销合同进展汇报）：我方答辩依据《合同法解释（二）》第二十四条已于 2021-01-01 废止，起草、核验、独立复核都没有识别。
 * 法规库不收废止文本，原先只报“库里没有”；现在核验结果明确写“已废止”，交付前检查当场报回助手。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openLawdb } from "@zr-legal/lawdb";
import { createDocx } from "@zr-legal/docx-engine";
import { repealedInfo } from "../src/tools/tools/law-names.ts";
import { citationsVerify } from "../src/tools/tools/citations.ts";
import { checkDeliverable } from "../src/services/deliverable-check.ts";
import { LAWDB_SHIPPED } from "./helpers.ts";
import { fileURLToPath } from "node:url";

const signerPub = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/keys/content-signing-dev.pub.json", import.meta.url)), "utf8")).publicKeyPem;
const lawdb = openLawdb(LAWDB_SHIPPED, { expectedSignerPubPem: signerPub });

test("repealedInfo：九部被民法典废止的法律与四件司法解释，各种写法都认得；现行法与没列的不认", () => {
  for (const n of ["合同法", "中华人民共和国合同法", "担保法", "物权法", "侵权责任法", "民法总则", "民法通则", "婚姻法", "继承法", "收养法"]) assert.equal(repealedInfo(n)?.on, "2021-01-01", n);
  for (const n of ["合同法解释（二）", "合同法解释二", "合同法司法解释（二）", "最高人民法院关于适用《中华人民共和国合同法》若干问题的解释（二）", "最高人民法院关于适用〈中华人民共和国合同法〉若干问题的解释（一）", "担保法解释", "民通意见"]) assert.match(repealedInfo(n)?.by ?? "", /法释〔2020〕16 号/, n);
  for (const n of ["民法典", "公司法", "劳动合同法", "民法典合同编通则解释", "劳动争议调解仲裁法", "买卖合同解释"]) assert.equal(repealedInfo(n), null, n);
});

test("citations.verify：分析时点在废止之后引用已废止的规定，结果写明“已废止”；之前的不写", () => {
  const after21 = citationsVerify(lawdb, { citations: [{ law: "合同法解释（二）", article: 24 }, { law: "合同法", article: 158 }], as_of: "2026-11-09" });
  for (const v of after21.verdicts) assert.ok(v.reasons.some((r) => /^repealed:已于 2021-01-01 废止/.test(r)), JSON.stringify(v.reasons));
  const before21 = citationsVerify(lawdb, { citations: [{ law: "合同法", article: 158 }], as_of: "2020-06-01" });
  assert.equal(before21.verdicts[0]!.reasons.some((r) => r.startsWith("repealed:")), false);
});

test("交付前检查：文书引用已废止的司法解释，当场报出并写明该怎么办", () => {
  const sections = [{ heading: "三、我方答辩依据", paragraphs: ["根据《合同法解释（二）》第二十四条，鸿岫公司未在三个月异议期内提出异议，解除通知已经生效。", "另见《民法典》第五百六十五条。"] }];
  const docx = createDocx("案件进展汇报", sections);
  const c = checkDeliverable("案件进展汇报", sections, { lawdb, asOf: "2026-11-09", docx });
  const issue = c.issues.find((i) => i.kind === "citation" && /合同法解释/.test(i.text));
  assert.ok(issue, JSON.stringify(c.issues));
  assert.match(issue!.fix, /已于 2021-01-01 废止.*只有行为发生在废止之前.*改引现行规定/);
  assert.equal(c.issues.some((i) => i.kind === "citation" && /民法典/.test(i.text)), false, "现行法不报");
});
