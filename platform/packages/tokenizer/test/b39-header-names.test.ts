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

test("“当事人一方明确表示”“合同当事人一方明知”里没有姓名（民法典第 563 条原文不再被换成代号）；带序号的角色词后的真名照常认出", () => {
  assert.deepEqual(names("（二）在履行期限届满前，当事人一方明确表示或者以自己的行为表明不履行主要债务；"), []);
  assert.deepEqual(names("合同当事人一方明知对方不具备履约能力"), []);
  assert.deepEqual(names("被告一张晓明，男，1985年出生"), ["张晓明"]);
  assert.deepEqual(names("证人二：方明，男"), ["方明"], "冒号后的“方明”是真名");
  const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 5) });
  const law = "当事人一方明确表示或者以自己的行为表明不履行主要债务";
  assert.equal(tz.tokenize(law).text, law, "法条原文原样发出");
});

test("角色词后直接接常用词、副词“都”、指代词不读姓名（访谈纪要“其他股东都缴齐了”“祁总那边”；法条“被监护人利益”“当事人都违反合同”）；有分隔与诉讼文书里的真名照常", () => {
  for (const s of ["其他股东都缴齐了，就祁总还差一点。", "其他股东都缴齐。", "祁总那边说下周给材料。", "监护人除为维护被监护人利益外，不得处分被监护人的财产。", "为维护被监护人利益。", "当事人都违反合同的，应当各自承担相应的责任。", "债务人明知接受履行的受让人不是债权人", "出借人明显不具备出借能力"]) {
    assert.equal(names(s).filter((n) => n !== "祁总").length, 0, `${s} → ${names(s).join("、")}`);
  }
  assert.deepEqual(names("证人：都明，男"), ["都明"]);
  assert.deepEqual(names("被告都晓峰辩称"), ["都晓峰"]);
  assert.deepEqual(names("股东：利益民"), ["利益民"]);
  assert.deepEqual(names("被告利晓峰辩称"), ["利晓峰"]);
});

test("姓名后紧跟“当日、当天、当场、当时”：两字名不吞下“当”（L2 劳动答辩：“部门负责人王磊当日点击同意”认成“王磊当”，同一人两个代号，另几处真名外发）", () => {
  assert.deepEqual(names("部门负责人王磊当日18:22点击“同意”"), ["王磊"]);
  assert.deepEqual(names("经理张伟当天签字"), ["张伟"]);
  assert.deepEqual(names("联系人李娜当场确认"), ["李娜"]);
  const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 3) });
  const out = tz.tokenize("部门负责人王磊当日18:22点击“同意”；申请人称系王磊让其在家准备客户演示，应王磊要求上传。").text;
  assert.equal(out.includes("王磊"), false, out);
  assert.equal(new Set(out.match(/〔自然人·[0-9A-Z]{6}〕/g)).size, 1, "同一人一个代号");
});

test("表格的人名列：表头是“客户签字”“姓名”“联系人”等，其下各行同列的姓名认出（Excel 制表符分格、Word 表格“| 格 |”）；机构、常用词、占位符不认", () => {
  const xl = "【3号机服务记录】\n序号\t报修/服务日期\t故障现象\t结果\t客户签字\n1\t2025-11-12\t验收遗留\t已修复\t李国栋\n2\t2025-11-20\t卡纸\t当日恢复\t李国栋";
  assert.deepEqual(names(xl), ["李国栋"]);
  const dx = "| 序号 | 姓名 | 职务 | 联系方式 |\n| 1 | 程野 | 研发总监 | 待补 |\n| 2 | 待定 | — | — |\n| 3 | 技术部 | 部门 | — |";
  assert.deepEqual(names(dx), ["程野"]);
  assert.deepEqual(names("序号\t项目\t负责人\n1\t实施\t乙方\n2\t运维\t甲方项目组"), []);
  const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 4) });
  assert.equal(tz.tokenize(xl).text.includes("李国栋"), false, "表格里的姓名发出前换成代号");
});

test("“董事、监事”不是姓名（临时股东会文件：董事会文件名成了“临时〔自然人〕会”）；“董事：董明，”照常认出", () => {
  assert.deepEqual(names("公司章程对公司、股东、董事、监事、高级管理人员具有约束力"), []);
  assert.deepEqual(names("股东：董事会"), []);
  assert.deepEqual(names("联系人：董事长秘书"), []);
  assert.deepEqual(names("董事：董明，男"), ["董明"]);
});

test("“被申请人应依约支付”“申请人原数相差”里没有姓名（劳动仲裁申请书复核误报）；“被告应晓明于……”照常认出", () => {
  assert.deepEqual(names("被申请人应依约支付竞业限制补偿"), []);
  assert.deepEqual(names("申请人原数相差较大"), []);
  assert.deepEqual(names("被告应晓明于2025年3月借款"), ["应晓明"]);
});
