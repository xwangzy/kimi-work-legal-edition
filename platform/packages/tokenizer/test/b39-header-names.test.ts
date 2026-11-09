/**
 * V14 第 39 批真实走查 A（独家经销协议起草，K3.1-Pro）：客户邮件与会谈纪要里的 5 个自然人（发件人、抄送、参会人、记录人）
 * 没有被识别，以真名发给了模型；邮件主题“麻烦沈律师起草一下”反而被截成“麻烦沈”换成代号。
 * 根因：①函件与纪要的表头词（发件人、抄送、参会、记录……）不是角色词；②角色词后只读第一个姓名，“、”列举的后几个不读；
 * ③没有“姓名（职务）”这一强证据；④名字里的“以”“书”在 STOP 字表，“周以宁”“叶书禾”在任何分支都过不了名字检查；
 * ⑤称谓分支把“麻烦沈”当三字名（“麻”是姓）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizeNames } from "../src/names.ts";
import { MatterTokenizer } from "../src/index.ts";

const names = (s: string) => [...recognizeNames(s)].sort();

test("函件与纪要表头：发件人、抄送、参会、记录之后的姓名都认出，顿号列举的每一位都认出", () => {
  assert.deepEqual(names("发件人：钟启衡（苏州檀屿医疗器械有限公司 董事长）"), ["钟启衡"]);
  assert.deepEqual(names("抄送：周以宁（檀屿 销售总监）"), ["周以宁"]);
  assert.deepEqual(names("檀屿参会：周以宁（销售总监）、韩策（财务经理）、顾言（质量负责人）"), ["周以宁", "韩策", "顾言"]);
  assert.deepEqual(names("禾湾参会：庞立川（总经理）、叶书禾（采购负责人）"), ["叶书禾", "庞立川"].sort());
  assert.deepEqual(names("记录：周以宁（11月4日整理）"), ["周以宁"]);
  assert.deepEqual(names("被告：张三、李四"), ["张三", "李四"]);
});

test("表头词作普通词用时不读姓名；顿号列举到下一个角色词即停", () => {
  assert.deepEqual(names("系统记录显示该笔货款已于三月支付"), []);
  assert.deepEqual(names("会议由总经理主持召开"), []);
  assert.deepEqual(names("抄送：财务部、法务部"), []);
  assert.deepEqual(names("原告：张三、被告：李四"), ["张三", "李四"]);
});

test("姓名（职务）：括注以职务词收尾才算；部门、机构不算", () => {
  assert.deepEqual(names("现场由何静（仓库主管）签收"), ["何静"]);
  assert.deepEqual(names("董事会（董事长主持）决议如下"), []);
  assert.deepEqual(names("甲方（买方）应于收货后付款"), []);
});

test("称谓前的“麻烦沈律师”是“麻烦”+称呼，不是三字名；江苏楷岳律师事务所里没有姓名", () => {
  assert.deepEqual(names("主题：禾湾独家经销合同，麻烦沈律师起草一下"), []);
  assert.deepEqual(names("受让方律师（江苏楷岳律师事务所）出具"), []);
  assert.deepEqual(names("收件人：沈知微律师"), ["沈知微"]);
});

test("令牌化：邮件表头与纪要里的自然人全部换成代号，发给模型的文字里没有真名", () => {
  const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 9) });
  const text = [
    "发件人：钟启衡（苏州檀屿医疗器械有限公司 董事长）",
    "抄送：周以宁（檀屿 销售总监）",
    "檀屿参会：周以宁（销售总监）、韩策（财务经理）、顾言（质量负责人）",
    "禾湾参会：庞立川（总经理）、叶书禾（采购负责人）",
  ].join("\n");
  const out = tz.tokenize(text).text;
  for (const n of ["钟启衡", "周以宁", "韩策", "顾言", "庞立川", "叶书禾"]) assert.equal(out.includes(n), false, `${n} 仍是明文：${out}`);
  assert.match(out, /苏州檀屿医疗器械有限公司 董事长/, "职务与机构照原样");
});
