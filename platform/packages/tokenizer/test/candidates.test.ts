/**
 * 发送前二次检测（v9.2 R7；Y5 §4.3 ②③）：令牌化之后仍像自然人姓名的原文，按上下文分高、中两档提名（只提名、不替换）；
 * 表头写法（“王明，男”“王明（身份证号……）”“王明，电话……”）同时并入规则识别、直接替换。
 * 误报口径：中档须“像名字”；本仓库 430 万字中文研发文档上实测 7 处（其中 3 处是文档里举例的人名）——数字只作回归参考，不对外引用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatterTokenizer, suspectCounts, suspectedNames } from "../src/index.ts";

const tz = () => new MatterTokenizer({ matterKey: Buffer.alloc(32, 9), parties: [{ name: "陈建国", kind: "person" }], table: [] });
const names = (t: string) => suspectedNames(t).map((s) => `${s.value}:${s.confidence}:${s.cue}`);

test("二次检测：五类依据各自提名，位置与档位正确；同一值只报一次、取较高档", () => {
  assert.deepEqual(names("〔自然人·N2WQV4〕与李华共同签署了补充协议。"), ["李华:medium:beside_person_token"]);
  assert.deepEqual(names("张伟、〔自然人·N2WQV4〕两人到场。"), ["张伟:medium:beside_person_token"]);
  assert.deepEqual(names("赵敏，女，〔出生日期·R6RZH2〕出生，汉族。"), ["赵敏:high:gender_header"]);
  assert.deepEqual(names("刘洋（身份证号〔证件号·7YS502〕）"), ["刘洋:high:id_header"]);
  assert.deepEqual(names("孙丽，电话〔电话·PZJT42〕，住址〔地址·BWJ1H6〕。"), ["孙丽:high:contact_token"]);
  assert.deepEqual(names("据告郑秀英称当晚并未离开。"), ["郑秀英:medium:speech_verb"]);
  assert.deepEqual(names("尚文琳和汪英波在餐厅见面并签署了协议。"), ["尚文琳:medium:paired_names", "汪英波:medium:paired_names"]);
  const both = suspectedNames("张伟、〔自然人·N2WQV4〕到场。后张伟，男，1980年生。");
  assert.equal(both.length, 1);
  assert.equal(both[0]!.confidence, "high");
  assert.deepEqual(suspectCounts("张伟、〔自然人·N2WQV4〕到场；尚文琳和汪英波在餐厅见面。"), { high: 0, medium: 3 });
});

test("二次检测：代号内部、机构名、普通法律文书句子与名词并列不提名", () => {
  for (const t of [
    "本协议第七条约定的保密义务适用《民法典》第五百零九条。",
    "公司高级管理人员应当遵守诚实信用原则，金额以银行流水为准。",
    "双方确认，甲方已于2024年支付首期款，乙方表示同意。",
    "王府井门店的高峰期客流统计表明，方案可行。",
    "华为和小米在市场上竞争。",
    "原告与被告于2024年签订合同。",
    "成本和收益均已核算。",
    "〔自然人·N2WQV4〕、成果、解析与计量均已完成。",
    "〔自然人·N2WQV4〕与张伟律师事务所签订委托协议。",
    "律师逐条确认派生查询；边界确认放第一条。",
  ]) assert.deepEqual(names(t), [], t);
  assert.deepEqual(suspectedNames(""), []);
  assert.deepEqual(suspectedNames("no chinese here"), []);
});

test("表头写法并入规则识别：直接替换为代号，二次检测随之无需提名；起点不清的不替换（交给二次检测提示）", () => {
  const t = tz();
  for (const raw of ["赵敏，女，1985年3月出生，汉族。", "宋骞，女，汉族。", "刘洋（身份证号110101199003071234）", "孙丽，电话13912345678。"]) {
    const out = t.tokenize(raw).text;
    assert.match(out, /^〔自然人·/, `${raw} → ${out}`);
    assert.deepEqual(suspectedNames(out), [], out);
  }
  const unclear = t.tokenize("其中李明，男，1990年生。").text;
  assert.equal(unclear.includes("李明"), true, "起点不清：规则不替换");
  assert.equal(suspectedNames(unclear).length > 0, true, "但二次检测会提示");
  assert.equal(t.tokenize("本公司（男装部）负责").text, "本公司（男装部）负责");
});
