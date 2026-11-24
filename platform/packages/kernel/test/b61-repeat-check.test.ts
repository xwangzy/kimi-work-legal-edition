// 第 61 批真实复测 m25-r4：修改轮改写后原句没删，对外答辩书同一段两句重复，交付前检查与回看都没拦住
import test from "node:test";
import assert from "node:assert/strict";
import { repeatIssues, repeatNorm } from "../src/services/repeat-check.ts";
import { checkDeliverable } from "../src/services/deliverable-check.ts";

// 真实成果原文（v3-劳动仲裁答辩书.docx 第 23 段）
const REAL = "《中华人民共和国劳动法》第二十五条第（二）项及《中华人民共和国劳动合同法》第三十九条第（二）项规定，劳动者严重违反劳动纪律或者用人单位规章制度的，用人单位可以解除劳动合同。《中华人民共和国劳动法》第二十五条第（二）项规定，劳动者严重违反劳动纪律或者用人单位规章制度的，用人单位可以解除劳动合同。本案解除同时具备旷工及违反源代码保密义务的事实基础，符合上述规定，申请人要求支付违法解除赔偿金缺乏依据。";

test("同一段两句重复（改写后原句没删）报回；相邻两段重复也报", () => {
  const got = repeatIssues([{ where: "二、答辩意见第 3 段", text: REAL }]);
  assert.equal(got.length, 1);
  assert.match(got[0]!.text, /^《中华人民共和国劳动法》第二十五条第（二）项规定/);
  const adj = repeatIssues([
    { where: "第 1 段", text: "申请人于2026年8月17日至19日未经批准连续三日未到岗，公司已于8月14日发送邮件明确要求正常出勤。" },
    { where: "第 2 段", text: "如前所述，申请人于2026年8月17日至19日未经批准连续三日未到岗，构成旷工。" },
  ]);
  assert.equal(adj.length, 1);
  assert.match(adj[0]!.where, /与下一段/);
});

test("同一段两次引用同一部法律、同一条不算重复；短句不比", () => {
  const twoCites = "依照《最高人民法院关于审理劳动争议案件适用法律问题的解释（一）》第四十四条，减少劳动报酬的争议由用人单位举证；依照《最高人民法院关于审理劳动争议案件适用法律问题的解释（一）》第五十条，规章制度须经民主程序制定并公示。";
  assert.equal(repeatIssues([{ where: "第 1 段", text: twoCites }]).length, 0);
  assert.equal(repeatIssues([{ where: "第 1 段", text: "证据1：劳动合同。证据2：劳动合同。" }]).length, 0);
  assert.equal(repeatNorm("《劳动法》第二十五条第（二）项规定，"), "规定");
  // 回放真实成果的两类误报：分段计息的请求、首部地址行
  const claims = "以510,000.00元为基数，自2025年12月26日计至2026年3月9日；以310,000.00元为基数，自2026年3月10日计至实际清偿之日；";
  assert.equal(repeatIssues([{ where: "诉讼请求第 2 段", text: claims }]).length, 0);
  assert.equal(repeatIssues([{ where: "第 1 节第 1 段", text: "住所：中国（上海）自由贸易试验区张江路665号3层。通讯地址：中国（上海）自由贸易试验区张江路665号3层，联系电话：【待填】。" }]).length, 0);
});

test("交付前检查报回重复表述（kind: repeat）；表格行不比", () => {
  const c = checkDeliverable("劳动仲裁答辩书", [{ heading: "二、答辩意见", paragraphs: [REAL] }]);
  assert.equal(c.issues.filter((i) => i.kind === "repeat").length, 1);
  const t = checkDeliverable("核对清单", [{ heading: "核对", table: { columns: ["事项", "说明"], rows: [["劳动者严重违反劳动纪律或者用人单位规章制度的用人单位可以解除", "劳动者严重违反劳动纪律或者用人单位规章制度的用人单位可以解除"]] } }]);
  assert.equal(t.issues.filter((i) => i.kind === "repeat").length, 0);
});
