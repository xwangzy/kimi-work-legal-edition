/**
 * V11 界面走查 D9：S2 整理案卷只认以“元 / 万元”结尾的小写金额，“¥5,100,000”“人民币 1,530,000.00”漏掉；
 * 因而“人民币伍佰零玖万元整（¥5,100,000）”这种大写与小写对不上没被发现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readZipEntries } from "@zr-legal/docx-engine";
import { amountCaseConflicts, buildS2Deliverables, extractFacts } from "../src/executor/casefile.ts";

const doc = (text: string, filename = "采购合同.docx") => ({ document_version_id: `dv_${filename}`, parse_version_id: `pv_${filename}`, filename, text });
const amounts = (text: string) => extractFacts(doc(text)).filter((f) => f.kind === "amount").map((f) => f.normalized);

test("只有币种前缀的小写金额要提取；编号、电话、条款号、百分比不当金额", () => {
  assert.deepEqual(amounts("单价 ¥1,280,000，运费另计"), ["1280000 元"]);
  assert.deepEqual(amounts("首期款人民币 1,530,000.00 应于签约后支付"), ["1530000 元"]);
  assert.deepEqual(amounts("保证金RMB200000"), ["200000 元"]);
  assert.deepEqual(amounts("首付人民币30万元"), ["300000 元"], "带“万元”的仍按原规则，不重复");
  assert.deepEqual(amounts("合同编号 QH-2026-0815，电话 13800000000，见第 3.2 条，支付 30%"), []);
});

test("大写与小写对不上：列出冲突并进补证清单；对得上的合并成一条、不报", () => {
  const bad = "合同总价款为人民币伍佰零玖万元整（¥5,100,000）。";
  const facts = extractFacts(doc(bad));
  const c = amountCaseConflicts(facts, () => bad);
  assert.equal(c.length, 1);
  assert.equal(c[0]!.upper, "5090000 元");
  assert.equal(c[0]!.lower, "5100000 元");
  const ok = "合同总价款为人民币伍佰壹拾万元整（¥5,100,000）。";
  assert.equal(amountCaseConflicts(extractFacts(doc(ok)), () => ok).length, 0);
  assert.equal(extractFacts(doc(ok)).filter((f) => f.kind === "amount").length, 1, "大写与小写相等合并为一条");
  assert.equal(amountCaseConflicts(extractFacts(doc("价款为人民币壹拾万元整（小写：¥120,000）")), () => "价款为人民币壹拾万元整（小写：¥120,000）").length, 1, "写明“小写：”的照样核");
  // 不同句里两笔不同金额不算冲突
  assert.equal(amountCaseConflicts(extractFacts(doc("预付款人民币壹拾万元整。质保金另行约定，暂定人民币 50,000 元由甲方保管。")), () => "预付款人民币壹拾万元整。质保金另行约定，暂定人民币 50,000 元由甲方保管。").length, 0);
  const built = buildS2Deliverables({
    runId: "run_0123456789abcdef-v11d9",
    matter: { title: "示例", client_name: null, counterparty: null, stance: "原告" },
    materials: [{ ...doc(bad), sha256: "a".repeat(64), chars: bad.length, quality_flags: [] }],
    issues: [],
  });
  const all = built.files.map((f) => [...readZipEntries(f.bytes).entries()].filter(([k]) => /\.xml$/.test(k)).map(([, v]) => v.toString("utf8")).join("\n")).join("\n");
  assert.match(all, /大写（5090000 元）与小写（5100000 元）不一致/, "进补证清单");
});
