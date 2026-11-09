/**
 * V14 第 39 批：法规库条文交回助手前只替换已知名单，不从条文里学新名字。
 * 真实走查 A（独家经销协议）：民法典第五百六十三条“当事人一方明确表示”被规则认出“方明”，学进事项令牌表；助手写进起草说明的
 * “卖方明知”在回读里成了代号、修改轮 9 次定位不到。法规库 3,513 条全文扫描：V13 规则在 78 条里误认 47 个值（利益、利害关、查阅、肖像……）。
 * 本机法律工具端点与出站闸门共用 READBACK_MODEL_FIELDS：法律检索类工具的整份结果按“已知名单”处理。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MatterTokenizer } from "@zr-legal/tokenizer";
import { READBACK_MODEL_FIELDS, readbackToolOf } from "@zr-legal/egress-gate";
import { tokenizeToolResult } from "../src/local-server.ts";

const ARTICLES = [
  "（二）在履行期限届满前，当事人一方明确表示或者以自己的行为表明不履行主要债务；",
  "监护人除为维护被监护人利益外，不得处分被监护人的财产。",
  "当事人、利害关系人认为执行行为违反法律规定的，可以向负责执行的人民法院提出书面异议。",
  "股东可以要求查阅公司会计账簿、会计凭证。",
];

test("law.get_article / law.search / citations.verify 的结果：条文原样交回，令牌表不新增自然人；已知的当事人照常替换", () => {
  for (const tool of ["law.get_article", "law.search", "law.get_version", "citations.verify"]) {
    const t = new MatterTokenizer({ matterKey: randomBytes(32), parties: [{ name: "程思远", kind: "person" }] });
    const raw = { law_name: "中华人民共和国民法典", items: ARTICLES.map((text, i) => ({ article_no: 563 + i, text })), note: "程思远一案引用" };
    const out = tokenizeToolResult(raw, (s, knownOnly) => t.tokenize(s, knownOnly ? { knownOnly: true } : {}).text, READBACK_MODEL_FIELDS[tool] ?? null) as typeof raw;
    assert.deepEqual(out.items.map((x) => x.text), ARTICLES, tool);
    assert.equal(t.table().filter((e) => e.category === "person" && e.value !== "程思远").length, 0, `${tool} 没学进新名字：${JSON.stringify(t.table())}`);
    assert.equal(out.note.includes("程思远"), false, "当事人词典里的真名照常换成代号");
    assert.equal(readbackToolOf(`mcp__legal__${tool.replace(".", "_")}`), tool, "出站闸门按同一张表认出这类工具结果");
  }
  // 对照：同一段带姓名格式的文字，法律检索类工具的结果里不学；没有读回规则（材料类工具）时照常识别、学进令牌表
  const NAMED = "联系人：王磊，男";
  const t1 = new MatterTokenizer({ matterKey: randomBytes(32) });
  tokenizeToolResult({ items: [{ text: NAMED }] }, (s, knownOnly) => t1.tokenize(s, knownOnly ? { knownOnly: true } : {}).text, READBACK_MODEL_FIELDS["law.get_article"] ?? null);
  assert.equal(t1.table().filter((e) => e.category === "person").length, 0);
  const t2 = new MatterTokenizer({ matterKey: randomBytes(32) });
  tokenizeToolResult({ text: NAMED }, (s, knownOnly) => t2.tokenize(s, knownOnly ? { knownOnly: true } : {}).text, null);
  assert.deepEqual(t2.table().filter((e) => e.category === "person").map((e) => e.value), ["王磊"]);
});
