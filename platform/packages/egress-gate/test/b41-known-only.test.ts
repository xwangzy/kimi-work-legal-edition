/**
 * V16 第 41 批：内核自己发起的请求只替换已知名单。
 * - 独立复核请求（令牌带 model:known_only）整段只换已知名单：文书里的“被告应予返还”“由卖方经办人曾根据指示办理”不被认成新姓名；
 * - 交回修改那一轮的提示由内核担保：逐字出现的那一段只换已知名单，同一条消息里宿主加的其他文字照常识别；
 * - 出文书、出表、改文书、改表、在原件上修订这五个工具的结果只换已知名单。
 * 标识符（电话、证件号等）与表里已有的真名照常替换，发送前二次检测照常计数。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MatterTokenizer } from "@zr-legal/tokenizer";
import { processChatPayload } from "../src/chat-payload.ts";
import { READBACK_MODEL_FIELDS, readbackToolOf } from "../src/readback-fields.ts";

const KEY = randomBytes(32);
const PARTIES = [{ name: "孙悦", kind: "person" as const }];
const persons = (t: MatterTokenizer) => t.table().filter((e) => e.category === "person").map((e) => e.value).sort();
const DOC = "被告应予返还押金；由卖方经办人曾根据指示办理的人员对接；被申请人应发工资、员工公式成立等内容与本合同无关。";

test("knownOnly：整个请求（含 system、user）只替换已知名单——普通词不学成姓名，表里的真名与电话照常替换，二次检测照常计数", () => {
  const full = new MatterTokenizer({ matterKey: KEY, parties: PARTIES });
  processChatPayload({ model: "legal/k3", messages: [{ role: "user", content: DOC }] }, full);
  assert.ok(persons(full).length > 0, "对照：照常识别时会从这段文字里认出“姓名”（本用例的前提）");

  const t = new MatterTokenizer({ matterKey: KEY, parties: PARTIES });
  const user = `【交付件】\n${DOC}\n买方联系人孙悦，电话13812345678。`;
  const r = processChatPayload({ model: "legal/k3", messages: [{ role: "system", content: "你是复核人。" }, { role: "user", content: user }] }, t, { knownOnly: true });
  const out = String((r.body as any).messages[1].content);
  assert.ok(out.includes(DOC), "助手写的文字原样");
  assert.equal(out.includes("孙悦"), false, "词典里的真名照常替换");
  assert.equal(out.includes("13812345678"), false, "电话照常替换");
  assert.deepEqual(persons(t).filter((v) => v !== "孙悦"), [], "不学新姓名（表里只有词典里的孙悦）");
  const s = processChatPayload({ model: "legal/k3", messages: [{ role: "user", content: "尚文琳和汪英波在餐厅见面。" }] }, new MatterTokenizer({ matterKey: KEY, parties: PARTIES }), { knownOnly: true });
  assert.ok(s.suspects.high + s.suspects.medium >= 1, "表里没有的姓名不替换，但发送前二次检测照常报出");
});

test("knownOnlyTexts：逐字出现的内核担保文字只替换已知名单，同一条消息里其余文字照常识别；对不上（被改动过、太短）的整段照常识别", () => {
  const vouched = `【独立复核】请逐条处理：\n【1】第二条｜${DOC}｜必须改`;
  const t = new MatterTokenizer({ matterKey: KEY, parties: PARTIES });
  const r = processChatPayload({ model: "legal/k3", messages: [{ role: "user", content: `${vouched}\n\n【本事项材料】对方联系人：赵立新，男。` }] }, t, { knownOnlyTexts: [vouched] });
  const out = String((r.body as any).messages[0].content);
  assert.ok(out.startsWith(vouched), "担保的一段原样");
  assert.equal(out.includes("赵立新"), false, "宿主加的文字里的新姓名照常识别");
  assert.deepEqual(persons(t), ["赵立新"], "只学到宿主文字里的新姓名");

  const t2 = new MatterTokenizer({ matterKey: KEY, parties: PARTIES });
  processChatPayload({ model: "legal/k3", messages: [{ role: "user", content: vouched.replace("请逐条处理", "请逐条核对") }] }, t2, { knownOnlyTexts: [vouched] });
  assert.ok(persons(t2).length > 0, "文字被改动过就对不上，照常识别（偏向多遮）");
  const t3 = new MatterTokenizer({ matterKey: KEY, parties: PARTIES });
  processChatPayload({ model: "legal/k3", messages: [{ role: "user", content: DOC }] }, t3, { knownOnlyTexts: ["曾根据"] });
  assert.ok(persons(t3).length > 0, "太短的担保文字不生效");
});

test("出文书、出表、改文书、改表、在原件上修订的结果只替换已知名单：交付前检查摘出的原句、改前改后的整段不学成姓名", () => {
  for (const tool of ["docx.render_report", "docx.edit_draft", "docx.revise", "xlsx.render_table", "xlsx.edit_cells"]) {
    assert.ok(READBACK_MODEL_FIELDS[tool], tool);
    assert.equal(readbackToolOf(`mcp__legal__${tool.replace(".", "_")}`), tool);
  }
  const t = new MatterTokenizer({ matterKey: KEY, parties: PARTIES });
  const result = JSON.stringify({ status: "applied", changes: [{ before: DOC, after: DOC.replace("押金", "保证金") }], quality_check: { issues: [{ text: "被申请人应发工资" }] } }, null, 2);
  const r = processChatPayload(
    {
      model: "legal/k3",
      messages: [
        { role: "user", content: "改正。" },
        { role: "assistant", content: null, tool_calls: [{ id: "e1", type: "function", function: { name: "mcp__legal__docx_edit_draft", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "e1", content: result },
        { role: "user", content: "继续。" },
      ],
    },
    t,
  );
  assert.equal((r.body as any).messages[2].content, result);
  assert.deepEqual(persons(t), []);
});

test("在原件上修订的结果按字段：改前改后的整段只替换已知名单；页眉页脚的文字照常识别", () => {
  const t = new MatterTokenizer({ matterKey: KEY, parties: PARTIES });
  const result = JSON.stringify({ status: "applied", changes: [{ before: DOC, after: DOC.replace("押金", "保证金") }], header_footer_changes: [{ part: "页眉", before: "承办律师：赵立新，男", after: "承办律师：赵立新，男" }] }, null, 2);
  const r = processChatPayload(
    {
      model: "legal/k3",
      messages: [
        { role: "user", content: "改正。" },
        { role: "assistant", content: null, tool_calls: [{ id: "v1", type: "function", function: { name: "mcp__legal__docx_revise", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "v1", content: result },
        { role: "user", content: "继续。" },
      ],
    },
    t,
  );
  const out = String((r.body as any).messages[2].content);
  assert.ok(out.includes(DOC), "改前的整段原样");
  assert.equal(out.includes("赵立新"), false, "页眉里的姓名照常识别");
  assert.deepEqual(persons(t).filter((v) => v !== "孙悦"), ["赵立新"]);
});
