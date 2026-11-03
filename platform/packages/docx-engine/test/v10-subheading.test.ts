/**
 * V10 第 36 批：律所文书（意见书、备忘录、起诉状）节内“（一）……”“一、……”小标题排成二级标题（V9.6 文档工程审查 B-01）；
 * 合同等当事人文书的“（一）”是条款项目，照正文排。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createDocx, isSubHeading, readZipEntries } from "../src/index.ts";

const styleOf = (buf: Buffer, text: string) => {
  const p = readZipEntries(buf).get("word/document.xml")!.toString("utf8").match(/<w:p\b[\s\S]*?<\/w:p>/g)!.find((x) => (x.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("") === text)!;
  return /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? null;
};

test("小标题判定：短、无句读收尾、无句号；正文句子与长段不算", () => {
  assert.equal(isSubHeading("（一）钱立伟与苏州宏晟的出资责任"), true);
  assert.equal(isSubHeading("二、恒拓置业保证的效力"), true);
  assert.equal(isSubHeading("（一）恒拓建设已被终结本次执行程序，属于不能清偿到期债务。"), false);
  assert.equal(isSubHeading("（二）结论："), false);
  assert.equal(isSubHeading("（1）乙方股东会已有效批准本次增资"), false, "阿拉伯数字括号是条款项目");
});

test("意见书里的“（一）”小标题用二级标题样式；合同里的“（一）”项目照正文", () => {
  const op = createDocx("关于恒拓建设欠款追偿的法律意见书（草稿）", [
    { heading: "六、逐问分析", paragraphs: ["（一）钱立伟与苏州宏晟的出资责任", "恒拓建设经终本裁定，属于不能清偿到期债务。"] },
  ]);
  assert.equal(styleOf(op, "（一）钱立伟与苏州宏晟的出资责任"), "KwlHeading2");
  assert.equal(styleOf(op, "恒拓建设经终本裁定，属于不能清偿到期债务。"), "KwlBody");
  const ct = createDocx("股权转让协议", [{ heading: "第三条 先决条件", paragraphs: ["（一）目标公司股东会批准", "（二）取得主管部门备案"] }]);
  assert.notEqual(styleOf(ct, "（一）目标公司股东会批准"), "KwlHeading2", "合同条款项目不改成标题");
});
