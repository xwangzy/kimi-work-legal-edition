/**
 * 第 65 批（V39，D-289）保全数额的构成：民事诉讼法第一百零五条“保全限于请求的范围”。
 * 用例取自真实成果：V32 m11、V35 m11-sim、V39 m11 三份申请书都只写“以 41 万元为限、未超过对账确认的未付款”（报出）；
 * V32、V35 的 m06 写了“310,000＋69,010＋30,000＝409,010”或“其中……合计 409,010”（不报）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { preservationAmountIssues } from "../src/services/preservation-check.ts";

const P = (texts: string[]) => texts.map((text, i) => ({ where: `第 ${i + 1} 段`, text }));

test("只写限额、没写构成的报出（V39 m11 原句）", () => {
  const r = preservationAmountIssues("财产保全申请书", P([
    "请求事项",
    "请求依法查封、扣押、冻结被申请人嘉兴禾丰包装科技有限公司名下价值人民币410,000元（大写：肆拾壹万元整）的财产。",
    "事实与理由",
    "本申请以人民币410,000元为限，未超过被申请人对账确认的未付合同款金额，保全对象及方式符合上述规定。",
  ]));
  assert.equal(r.length, 1);
  assert.match(r[0]!.fix, /第一百零五条/);
  assert.match(r[0]!.text, /41 万元/);
});

test("写了算式或“其中……合计”的不报（V32、V35 m06 原句）", () => {
  assert.equal(preservationAmountIssues("财产保全申请书", P([
    "请求事项：请求依法查封、扣押、冻结被申请人名下价值409,010.00元的财产。",
    "事实与理由",
    "起诉状第1至3项请求金额暂合计为：到期货款310,000.00元＋截至2026年11月30日的违约金69,010.00元＋律师费30,000.00元＝409,010.00元。",
  ])).length, 0);
  assert.equal(preservationAmountIssues("财产保全申请书", P([
    "请求事项",
    "请求依法冻结被申请人名下银行存款409,010.00元，或查封、扣押其名下其他等值财产。",
    "事实与理由",
    "申请人已就到期验收款、逾期付款违约金及实现债权费用提起诉讼，其中验收款310,000.00元、违约金暂计69,010.00元，律师费请求为30,000.00元，诉讼标的额合计409,010.00元。",
  ])).length, 0);
});

test("不是保全申请书、或说明与核对类文件不查；没有请求事项不报", () => {
  assert.equal(preservationAmountIssues("民事起诉状", P(["请求事项", "判令被告支付410,000元"])).length, 0);
  assert.equal(preservationAmountIssues("保全申请书核对清单", P(["请求事项", "冻结410,000元"])).length, 0);
  assert.equal(preservationAmountIssues("财产保全申请书", P(["申请人：某公司", "冻结410,000元"])).length, 0);
});

test("万元写法也认：41 万元由 31 万＋6.9 万＋3 万组成的不报", () => {
  assert.equal(preservationAmountIssues("诉前财产保全申请书", P([
    "请求事项：请求冻结被申请人名下价值41万元的财产。",
    "事实与理由",
    "上述41万元由到期货款31万元、违约金暂计6.9万元、律师费3万元组成，拟在起诉时一并主张。",
  ])).length, 0);
});
