/**
 * 第 61 批（V35，D-261 续）引用提取的两处漏洞：真实验收 v35-L1b-ruling 的独立复核把“依该办法第十六条”“……第六十七条第三款……；第一百七十七条”
 * 判为“无法规库原文支撑”——不是条文不存在，是提取没认出来，复核拿不到原文，引用核验与签发核对也都没覆盖到这两条。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractCitations } from "../src/tools/tools/citations.ts";
import { lawRefsIn } from "../src/services/independent-review.ts";

const pairs = (t: string) => extractCitations(t).map((c) => [c.law, c.article]);

test("“依该办法第十六条”回指最近提到的办法；“该解释”回指最近的解释，不被中间的法律抢走", () => {
  assert.deepEqual(pairs("依《诉讼费用交纳办法》第十三条第（一）项计算；本案适用简易程序，依该办法第十六条减半。"), [["诉讼费用交纳办法", 13], ["诉讼费用交纳办法", 16]]);
  const t = "《最高人民法院关于适用〈中华人民共和国民法典〉合同编通则若干问题的解释》第六十五条规定了调整标准，《中华人民共和国民法典》第五百八十五条为请求权基础，该解释第六十四条另有规定。";
  assert.ok(pairs(t).some(([law, a]) => String(law).endsWith("解释") && a === 64), JSON.stringify(pairs(t)));
  assert.deepEqual(pairs("依该法第一百七十一条上诉。").length, 0, "前面没有提到任何法，不回指");
  assert.deepEqual(pairs("《中华人民共和国民事诉讼法》第一百七十一条规定了上诉期；依该法第一百七十四条，对方十五日内答辩。").map((x) => x[1]), [171, 174]);
  // 反向：法名里含“同法”（劳动合同法）、合同条款“合同规定第5条”不被当作回指
  assert.deepEqual(pairs("劳动合同法第四十七条规定的经济补偿").length, 1);
  assert.deepEqual(pairs("《诉讼费用交纳办法》第十三条；合同规定第五条另有约定。").map((x) => x[1]), [13]);
});

test("同一句里分号后续写的“第X条”归前一处引用的那部法；隔了句号或另一部法的不归", () => {
  assert.deepEqual(pairs("《中华人民共和国民事诉讼法》第六十七条第三款要求法院全面审查证据；第一百七十七条第一款第二、三项规定二审的处理方式。").map((x) => x[1]), [67, 177]);
  assert.deepEqual(pairs("《中华人民共和国民事诉讼法》第六十七条规定举证责任。第一百七十七条另行讨论。").map((x) => x[1]), [67], "隔了句号不归");
  assert.deepEqual(lawRefsIn(["《中华人民共和国民事诉讼法》第六十七条第三款要求法院全面审查证据；第一百七十七条第一款第二、三项规定二审的处理方式。"]).map((r) => r.article), [67, 177], "独立复核取原文用的提取同样认出");
});
