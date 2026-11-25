/**
 * 第 64 批：《当事人信息（律师填写）》加了委托诉讼代理人与按各项生成的“文书首部写法”。
 * 现有角色词（委托代理人、诉讼代理人、代理人、法定代表人、负责人）已能认出这些写法里的姓名，不改识别规则；这里把新写法钉住，
 * 以后改角色词或姓名规则时不会悄悄放过代理人的真名。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizeNames } from "../src/names.ts";
import { MatterTokenizer } from "../src/index.ts";

const names = (s: string) => [...recognizeNames(s)].sort();

test("委托诉讼代理人 / 委托代理人之后的姓名认出；律所名称里没有姓名", () => {
  assert.deepEqual(names("委托诉讼代理人：张三，北京某律师事务所律师"), ["张三"]);
  assert.deepEqual(names("委托诉讼代理人：张明远，北京某某律师事务所律师，联系电话13800001111。"), ["张明远"]);
  assert.deepEqual(names("委托代理人：李晓梅，上海某某律师事务所律师。"), ["李晓梅"]);
  // 材料各方之下的代理人行（带序号与身份括注）
  assert.deepEqual(names("委托诉讼代理人一：张明远（律师）"), ["张明远"]);
  assert.deepEqual(names("委托代理人二：赵敏（当事人的近亲属）"), ["赵敏"]);
  // 近亲属写法：代理人与当事人都认出
  assert.deepEqual(names("委托诉讼代理人：王小，系原告王超之子。"), ["王小", "王超"].sort());
  // 其他组织的主要负责人
  assert.deepEqual(names("主要负责人：周六一，执行事务合伙人。"), ["周六一"]);
});

test("文书首部写法整行令牌化：姓名、出生日期、公民身份号码、住址门牌、电话都换成代号；民族、律所、省市区照原文", () => {
  const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 9) });
  const text = [
    "原告：王超，男，汉族，1966年2月5日出生，公民身份号码110105196602051234，住北京市朝阳区建国路88号院2号楼1203室，联系电话13912345678。",
    "委托诉讼代理人：张明远，北京某某律师事务所律师，联系电话13800001111。",
    "被告：上海某某有限公司，统一社会信用代码91310115MA1H7K2X3Q，住所上海市浦东新区张江路1288号3幢501室，联系电话021-58881234。",
    "法定代表人：李建国，执行董事。",
  ].join("\n");
  const out = tz.tokenize(text).text;
  for (const s of ["王超", "1966年2月5日", "110105196602051234", "建国路88号院", "13912345678", "张明远", "13800001111", "91310115MA1H7K2X3Q", "张江路1288号", "李建国", "021-58881234"]) assert.equal(out.includes(s), false, `${s} 仍是明文：${out}`);
  for (const s of ["男，汉族", "北京某某律师事务所律师", "住北京市朝阳区", "住所上海市浦东新区", "执行董事"]) assert.ok(out.includes(s), `${s} 应照原文：${out}`);
});
