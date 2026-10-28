/**
 * 只替换已知名单（v9.4 第 30 批，D-157）：出站闸门对模型自己写的内容（assistant 消息）用 `tokenize(text, { knownOnly: true })`——
 * 标识符、当事人词典与令牌表里未退役的姓名照常替换；不做规则识别、不产生新的自然人条目。
 * 第 29 批真实走查：助手意见里的“应全额、任何、向乙、由双”被认成姓名、学进事项令牌表，回过头把合同原文换成代号。
 * 下面的助手话术取自第 29 批样例意见书与律师函（虚构数据），按第 29 批之后的规则用默认档仍会认出“付款、明显、应免费、和分包、和邮箱、向贵”。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MatterTokenizer, restoreTokens } from "../src/index.ts";

const KEY = randomBytes(32);
const persons = (t: MatterTokenizer) => t.table().filter((e) => e.category === "person").map((e) => e.value).sort();

/** 助手写的审查意见（不含任何自然人姓名）。 */
const OPINION = [
  "问题：先收款后开票使甲方付款时无法核验发票合规性。",
  "该条款对买方明显不利，建议由卖方承担运费。",
  "被告向原告支付违约金的请求缺乏依据；任何一方违约的，甲方向乙方支付违约金。",
  "乙方应全额退还已付款项，付清全部转让款后办理变更登记。",
  "乙方应免费整改并重新提交。",
  "员工和分包方同等受约束；联系人和邮箱未约定。",
  "委托人向贵司交付上述货物。",
];

test("knownOnly：助手意见里的常用词不认作姓名、不进令牌表；之后合同原文的“付款”“明显”不被换成代号", () => {
  const t = new MatterTokenizer({ matterKey: KEY });
  for (const s of OPINION) assert.equal(t.tokenize(s, { knownOnly: true }).text, s, s);
  assert.deepEqual(persons(t), []);
  // 闸门按新表重建后，材料照常（默认档）令牌化：合同原文到达模型时不缺字
  const next = new MatterTokenizer({ matterKey: KEY, table: t.table() });
  for (const s of ["乙方收到付款后五日内开具发票。", "如违约金明显过高，可请求调整。", "任何一方不得擅自变更；甲方向乙方支付货款。", "被告向原告支付货款735800元。"]) {
    assert.equal(next.tokenize(s).text, s, s);
  }
});

test("knownOnly：表里没有的姓名有上下文也不识别、不学；令牌表与词典里已有的真名、昵称写法照常替换，标识符照常替换", () => {
  const parties = [{ name: "孙悦", kind: "person" as const }];
  const old = new MatterTokenizer({ matterKey: KEY, parties });
  // 之前从材料里认出、存进令牌表的真名与昵称写法
  const li = old.tokenFor("person", "李明辉", "recognizer");
  const wang = old.tokenFor("person", "王总", "recognizer");
  const t = new MatterTokenizer({ matterKey: KEY, parties, table: old.table() });
  const before = new Set(t.table().map((e) => e.token));
  const text = "孙悦与李明辉已对账，王总确认。证人王建业另行说明。孙悦手机 13800138000，身份证号 110101199003077777。";
  const r = t.tokenize(text, { knownOnly: true });
  for (const v of ["孙悦", "李明辉", "王总", "13800138000", "110101199003077777"]) assert.ok(!r.text.includes(v), `${v} → ${r.text}`);
  assert.ok(r.text.includes(li.token) && r.text.includes(wang.token), r.text);
  assert.ok(r.text.includes("证人王建业另行说明"), r.text);
  // 新条目只有词典里的当事人（首次出现）与标识符，没有规则认出的自然人
  const fresh = t.table().filter((e) => !before.has(e.token));
  assert.deepEqual(fresh.filter((e) => e.source === "recognizer"), []);
  assert.deepEqual(fresh.map((e) => `${e.category}:${e.source}`).sort(), ["id_number:pattern", "person:dictionary", "phone:pattern"]);
  assert.equal(restoreTokens(r.text, t.table()).text, text, "还原无损");
  // 同一段按默认档（材料、工具结果、律师输入）照常识别并学进表
  const d = new MatterTokenizer({ matterKey: KEY, parties, table: old.table() });
  assert.ok(!d.tokenize(text).text.includes("王建业"));
  assert.ok(persons(d).includes("王建业"));
});

test("knownOnly：不按已知姓氏派生新的昵称写法（“老王”“王经理”不在表里就不换）；退役的误认值不再匹配", () => {
  const old = new MatterTokenizer({ matterKey: KEY });
  const real = old.tokenFor("person", "王建国", "recognizer");
  old.tokenFor("person", "向乙", "recognizer"); // 第 29 批之前学进令牌表的误认值（已退役）
  const t = new MatterTokenizer({ matterKey: KEY, table: old.table() });
  const r = t.tokenize("王建国到场。老王表示同意；王经理随后确认。甲方向乙方支付货款。", { knownOnly: true });
  assert.equal(r.text, `${real.token}到场。老王表示同意；王经理随后确认。甲方向乙方支付货款。`);
  assert.deepEqual(persons(t), ["向乙", "王建国"], "没有新条目");
  // 默认档照旧：已知姓氏的昵称照常认出（材料里的“老王”）
  const d = new MatterTokenizer({ matterKey: KEY, table: old.table() });
  assert.ok(!d.tokenize("王建国到场。老王表示同意。").text.includes("老王"));
});
