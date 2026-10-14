/**
 * 令牌化核心（第 02 篇 §8.3–§8.4；第 04 篇 §11 P6）：确定性、规范化、幂等、还原、冲突、机构保留与全部化名、出站残留检查。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatterTokenizer, findTokens, residualIdentifiers, restoreTokens, tokenCategory, TOKEN_RE, type TokenEntry } from "../src/index.ts";

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);

const SAMPLE = `原告：李华，男，1980年5月1日出生，身份证号110101198005010033，住北京市朝阳区建国路88号院3号楼1201室，电话 138 0013 8000。
被告：甲科技有限公司，统一社会信用代码91110105MA01ABCD3X，法定代表人张三丰。
委托代理人：赵六，北京某律师事务所律师。原告向被告转账至账号 6222 0212 3456 7890 128，联系邮箱 lihua@example.com，车牌京A12345。`;

test("确定性：同一事项密钥下同值同代号（跨实例、跨文本）；不同事项不同代号；代号形态与类别可解析", () => {
  const a1 = new MatterTokenizer({ matterKey: KEY_A }).tokenize(SAMPLE);
  const a2 = new MatterTokenizer({ matterKey: KEY_A }).tokenize(SAMPLE);
  const b = new MatterTokenizer({ matterKey: KEY_B }).tokenize(SAMPLE);
  assert.equal(a1.text, a2.text);
  assert.notEqual(a1.text, b.text);
  for (const tok of findTokens(a1.text)) assert.ok(tokenCategory(tok), tok);
  assert.equal(tokenCategory("〔自然人·ABC〕"), null);
  // 原文中的标识符与姓名一个都不剩
  for (const s of ["110101198005010033", "138 0013 8000", "91110105MA01ABCD3X", "6222 0212 3456 7890 128", "lihua@example.com", "京A12345", "李华", "张三丰", "赵六", "建国路88号"]) {
    assert.ok(!a1.text.includes(s), `残留：${s}`);
  }
  // 机构名称默认保留（商事主体关系推理不受影响）
  assert.ok(a1.text.includes("甲科技有限公司"));
  // 出生日期（“1980年5月1日出生”）自审计 P1-3 起默认识别
  assert.deepEqual(a1.counts, { person: 3, birth_date: 1, id_number: 1, address: 1, phone: 1, uscc: 1, account: 1, email: 1, plate: 1 });
});

test("规范化：同一标识符的不同写法得到同一代号（+86、空格、短横、全角、大小写）", () => {
  const t = new MatterTokenizer({ matterKey: KEY_A });
  const one = (s: string) => findTokens(t.tokenize(s).text);
  assert.deepEqual(one("手机13800138000"), one("手机 +86 138-0013-8000"));
  assert.deepEqual(one("手机13800138000"), one("手机０１３８００１３８０００".replace("０１", "1")));
  assert.deepEqual(one("身份证号11010119800501003x"), one("身份证号11010119800501003X"));
  assert.deepEqual(one("卡号6222021234567890128"), one("卡号 6222-0212-3456-7890-128"));
});

test("幂等：已令牌化的文本再令牌化不变；代号本身不会被识别为标识符", () => {
  const t = new MatterTokenizer({ matterKey: KEY_A });
  const once = t.tokenize(SAMPLE);
  const twice = t.tokenize(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.replaced, 0);
  assert.equal(residualIdentifiers(once.text).length, 0);
});

test("还原只经可信环节：令牌表还原出原文；未知代号保留原样并报告", () => {
  const t = new MatterTokenizer({ matterKey: KEY_A });
  const r = t.tokenize(SAMPLE);
  const back = restoreTokens(r.text, t.table());
  assert.equal(back.text, SAMPLE);
  assert.equal(back.unknown.length, 0);
  const foreign = new MatterTokenizer({ matterKey: KEY_B }).tokenize("证人：钱多多。").text;
  const partial = restoreTokens(`${r.text}\n${foreign}`, t.table());
  assert.equal(partial.unknown.length, 1);
  assert.ok(partial.text.endsWith(foreign.split("\n").pop()!));
});

test("冲突：不同值落到同一短编号时，后来者改用 10 位编号；令牌表持久化后冲突处理稳定", () => {
  const probe = new MatterTokenizer({ matterKey: KEY_A });
  const victim = probe.tokenFor("person", "周某甲");
  // 伪造一条占用该短编号的既有条目（不同的值）
  const squatter: TokenEntry = { token: victim.token, category: "person", value: "吴某乙", normalized: "吴某乙", source: "dictionary" };
  const t = new MatterTokenizer({ matterKey: KEY_A, table: [squatter] });
  const e = t.tokenFor("person", "周某甲");
  assert.notEqual(e.token, victim.token);
  assert.match(e.token, /^〔自然人·[0-9A-Z]{10}〕$/);
  const t2 = new MatterTokenizer({ matterKey: KEY_A, table: t.table() });
  assert.equal(t2.tokenFor("person", "周某甲").token, e.token);
  assert.equal(t2.tokenFor("person", "吴某乙").token, victim.token);
});

test("当事人词典：自然人姓名与别名在无上下文处也替换；机构默认保留，全部化名（L3a）时也替换", () => {
  const parties = [
    { name: "孙悦", kind: "person" as const, aliases: ["孙总"] },
    { name: "乙贸易有限公司", kind: "org" as const, aliases: ["乙公司"] },
  ];
  const text = "孙悦与乙贸易有限公司于2024年签约；孙总称乙公司未付款。";
  const def = new MatterTokenizer({ matterKey: KEY_A, parties }).tokenize(text);
  assert.ok(!def.text.includes("孙悦") && !def.text.includes("孙总"));
  assert.ok(def.text.includes("乙贸易有限公司") && def.text.includes("乙公司"));
  const full = new MatterTokenizer({ matterKey: KEY_A, parties, fullPseudonym: true }).tokenize(text);
  assert.ok(!full.text.includes("乙贸易有限公司") && !full.text.includes("乙公司"));
  assert.equal(full.counts.org, 2);
});

test("识别出的姓名进入令牌表：之后的文本里无上下文的出现也替换（跨材料、跨会话稳定）", () => {
  const t = new MatterTokenizer({ matterKey: KEY_A });
  t.tokenize("申请人：郑晓燕，女，汉族。");
  const later = t.tokenize("郑晓燕于2022年3月入职。");
  assert.ok(!later.text.includes("郑晓燕"));
  const fresh = new MatterTokenizer({ matterKey: KEY_A, table: t.table() }).tokenize("郑晓燕于2022年3月入职。");
  assert.equal(fresh.text, later.text);
});

test("不误伤：合同编号、金额、日期、法条、案号不被当作标识符", () => {
  const t = new MatterTokenizer({ matterKey: KEY_A });
  const text = "合同编号 HT-2024-000123，金额人民币1,234,567.89元，2024年5月1日签订；依据《民法典》第五百八十五条；（2024）京0105民初12345号。";
  const r = t.tokenize(text);
  assert.equal(r.text, text);
  TOKEN_RE.lastIndex = 0;
});
