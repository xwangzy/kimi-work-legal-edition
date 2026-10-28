/**
 * 模型自己写的内容只替换已知名单（v9.4 第 30 批，D-157）：assistant 消息的正文、思考、工具调用参数不做姓名识别、不学新姓名，
 * 标识符与当事人词典、令牌表里的真名照常替换；system、user、tool 消息照常识别并学进令牌表。
 * 场景同第 29 批真实走查 run_344072ad / run_c6c28273：助手意见出站时被认出的常用词学进令牌表，之后合同原文被换成代号。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { findTokens, MatterTokenizer } from "@zr-legal/tokenizer";
import { processChatPayload } from "../src/chat-payload.ts";

const KEY = randomBytes(32);
const PARTIES = [{ name: "孙悦", kind: "person" as const }];
const persons = (t: MatterTokenizer) => t.table().filter((e) => e.category === "person").map((e) => e.value).sort();

test("assistant 消息（正文、思考、工具调用参数）里的“向乙方、被告向原告、任何一方”与助手意见不进令牌表；下一次请求里的合同原文不被换掉", () => {
  const t1 = new MatterTokenizer({ matterKey: KEY, parties: PARTIES });
  const args = {
    cards: [
      { anchor_text: "甲方向乙方支付货款", issue: "问题：先收款后开票使甲方付款时无法核验发票合规性。", suggestion: "该条款对买方明显不利，建议由卖方承担运费。" },
    ],
  };
  const said = "被告向原告支付违约金的请求缺乏依据；任何一方违约的，甲方向乙方支付违约金。";
  const thought = "乙方应免费整改；员工和分包方同等受约束；联系人和邮箱未约定。";
  const r1 = processChatPayload(
    {
      model: "legal/k3",
      messages: [
        { role: "system", content: "你是律师助手。" },
        { role: "user", content: "审查采购合同。" },
        { role: "assistant", content: said, reasoning_content: thought, tool_calls: [{ id: "c1", type: "function", function: { name: "riskcards_submit", arguments: JSON.stringify(args) } }] },
        { role: "tool", tool_call_id: "c1", content: "已提交 1 张风险卡。" },
        { role: "user", content: "继续。" },
      ],
    },
    t1,
  );
  const m = (r1.body as any).messages[2];
  assert.equal(m.content, said);
  assert.equal(m.reasoning_content, thought);
  assert.equal(m.tool_calls[0].function.arguments, JSON.stringify(args), "参数原样（没有替换就不重新序列化）");
  assert.deepEqual(persons(t1), []);
  assert.deepEqual(r1.counts, {});
  // 内核写回后闸门按新表重建：合同原文（工具结果，照常识别）到达模型时不缺字
  const t2 = new MatterTokenizer({ matterKey: KEY, parties: PARTIES, table: t1.table() });
  const contract = "3.1 乙方收到付款后五日内开具发票。任何一方违约的，甲方向乙方支付违约金；如违约金明显过高，可请求调整。被告向原告支付货款。";
  const r2 = processChatPayload({ model: "legal/k3", messages: [{ role: "user", content: "逐字引用第3.1条。" }, { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "Read", arguments: "{\"path\":\"materials/001.txt\"}" } }] }, { role: "tool", tool_call_id: "c2", content: contract }, { role: "user", content: "继续。" }] }, t2);
  assert.equal((r2.body as any).messages[2].content, contract);
});

test("assistant 消息里令牌表与词典已有的真名照常替换、标识符照常替换，表里没有的姓名不学；同一请求里工具结果与律师输入的新姓名照常识别并学进表", () => {
  const old = new MatterTokenizer({ matterKey: KEY, parties: PARTIES });
  const wang = old.tokenFor("person", "王总", "recognizer");
  const t = new MatterTokenizer({ matterKey: KEY, parties: PARTIES, table: old.table() });
  const r = processChatPayload(
    {
      model: "legal/k3",
      messages: [
        { role: "user", content: "联系人：赵立新，电话另告。" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: "{\"path\":\"materials/001.txt\"}" } }] },
        { role: "tool", tool_call_id: "c1", content: "证人：李明辉，当庭作证。" },
        {
          role: "assistant",
          content: "孙悦与李明辉、赵立新已对账，王总确认；证人王建业另行说明。",
          tool_calls: [{ id: "c2", type: "function", function: { name: "facts_submit", arguments: JSON.stringify({ text: "孙悦手机13800138000，身份证号110101199003077777" }) } }],
        },
        { role: "tool", tool_call_id: "c2", content: "已提交。" },
        { role: "user", content: "继续。" },
      ],
    },
    t,
  );
  const msgs = (r.body as any).messages;
  const said = msgs[3].content as string;
  for (const v of ["孙悦", "李明辉", "赵立新", "王总"]) assert.ok(!said.includes(v), `${v} → ${said}`);
  assert.ok(said.includes(wang.token));
  assert.ok(said.includes("证人王建业另行说明"), said);
  const args = JSON.parse(msgs[3].tool_calls[0].function.arguments) as { text: string };
  assert.ok(!args.text.includes("孙悦") && !args.text.includes("13800138000") && !args.text.includes("110101199003077777"), args.text);
  // 律师输入与工具结果里的新姓名照常识别、学进令牌表，且与 assistant 消息里的写法是同一代号
  assert.deepEqual(persons(t), ["孙悦", "李明辉", "王总", "赵立新"].sort());
  for (const i of [0, 2]) for (const tok of findTokens(msgs[i].content)) assert.ok(said.includes(tok), `${tok} 在 assistant 消息里是同一代号`);
});

test("本机写入的 assistant 预填（partial / prefix 标记、位于末尾）不是模型写的：照常识别；Anthropic 形态的 tool_use 只替换已知名单，tool_result 照常识别", () => {
  const t = new MatterTokenizer({ matterKey: KEY });
  const r = processChatPayload(
    {
      model: "legal/k3",
      messages: [
        { role: "user", content: "审查。" },
        { role: "assistant", content: "证人赵立新的证言与书证相互印证。" },
        { role: "assistant", content: "证人钱志远出庭。", prefix: true },
        { role: "user", content: "继续。" },
        { role: "assistant", content: "证人王建业称", partial: true },
      ],
    },
    t,
  );
  const msgs = (r.body as any).messages;
  assert.equal(msgs[1].content, "证人赵立新的证言与书证相互印证。", "模型写的：不识别");
  assert.ok(!msgs[2].content.includes("钱志远") && !msgs[4].content.includes("王建业"), "预填：照常识别");
  assert.deepEqual(persons(t), ["王建业", "钱志远"].sort());
  // 末尾的 assistant 消息（Anthropic 形态的预填，不带标记）同样照常识别
  const t2 = new MatterTokenizer({ matterKey: KEY });
  const tail = processChatPayload({ model: "legal/k3", messages: [{ role: "user", content: "审查。" }, { role: "assistant", content: "证人王建业称" }] }, t2);
  assert.ok(!JSON.stringify(tail.body).includes("王建业"));
  // Anthropic 形态：assistant 的 text / tool_use 只替换已知名单；user 消息里的 tool_result 照常识别
  const t3 = new MatterTokenizer({ matterKey: KEY });
  const a = processChatPayload(
    {
      model: "legal/k3",
      messages: [
        { role: "user", content: [{ type: "text", text: "审查采购合同。" }] },
        { role: "assistant", content: [{ type: "text", text: "该条款对买方明显不利。" }, { type: "tool_use", id: "toolu_1", name: "Search", input: { issue: "先收款后开票使甲方付款时无法核验" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "证人：李明辉，当庭作证。" }] }] },
      ],
    },
    t3,
  );
  const am = (a.body as any).messages;
  assert.equal(am[1].content[0].text, "该条款对买方明显不利。");
  assert.equal(am[1].content[1].input.issue, "先收款后开票使甲方付款时无法核验");
  assert.ok(!JSON.stringify(am[2]).includes("李明辉"));
  assert.deepEqual(persons(t3), ["李明辉"]);
});

// ── 第二步：读回工具的结果按字段（第 30 批真实复测：riskcards.list 交回的卡片建议学进“应开具、应完整、应完成”）──

const call = (id: string, name: string) => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] });
/** 引擎交给模型的 MCP 结果：一行“Wall time”，再是内核的 JSON（第 30 批真实复测所见）。 */
const result = (id: string, body: unknown) => ({ role: "tool", tool_call_id: id, content: `Wall time: 0.025 seconds\n${JSON.stringify(body, null, 2)}` });
const body = (s: string) => JSON.parse(s.slice(s.indexOf("\n{") + 1));

test("读回工具的 tool 消息按字段：卡片建议、未确认的事实、AI 填的格子、未改写的论点只替换已知名单；律师写的字段照常识别并学进令牌表", () => {
  const t = new MatterTokenizer({ matterKey: KEY, parties: PARTIES });
  const cards = {
    progress: { total: 2 },
    cards: [
      { card_id: "rc_1", clause_ref: "3.3", anchor_text: "乙方收到款项后十五个工作日内向甲方开具等额增值税专用发票。", issue: "先收款后开票。", suggestion: "每期付款前，乙方应开具等额合法有效的增值税专用发票。", fallback: "乙方应完整交付源代码、文档及相关资料。", lawyer_text: null },
      { card_id: "rc_2", clause_ref: "7.1", issue: "合同解除或终止后，乙方应完成工作、源代码、文档及数据的交接。", lawyer_text: "合同解除后十日内，乙方向甲方移交全部资料，由证人王建业签收。" },
    ],
  };
  const facts = {
    facts: [
      { fact_id: "f1", statement: "乙方应开具发票而未开具。", party: "乙方", quote: "向甲方开具等额增值税专用发票", lawyer_status: "proposed" },
      { fact_id: "f2", statement: "证人赵立新确认已收到全部资料。", lawyer_status: "confirmed" },
    ],
  };
  const table = { table_id: "t1", title: "合同台账", cells: [{ column: "c1", state: "ai", value: "乙方应完整交付源代码", quote: "交付源代码" }, { column: "c2", state: "edited", value: "联系人：钱志远，电话另告" }] };
  const outline = { status: "confirmed", confirmed_arguments: [{ arg_id: "a1", claim: "被告应开具发票", lawyer_edited: false, counter: "对方或称已开具" }, { arg_id: "a2", claim: "证人孙志强可证明交付事实", lawyer_edited: true }], lawyer_note: "联系人周文涛另行核实" };
  const r = processChatPayload(
    {
      model: "legal/k3",
      messages: [
        { role: "user", content: "审查。" },
        call("c1", "mcp__legal__riskcards_list"),
        result("c1", cards),
        call("c2", "mcp__legal__facts_list"),
        result("c2", facts),
        call("c3", "mcp__legal__table_get"),
        result("c3", table),
        call("c4", "mcp__legal__outline_get"),
        result("c4", outline),
        { role: "user", content: "继续。" },
      ],
    },
    t,
  );
  assert.deepEqual(persons(t), ["孙志强", "周文涛", "王建业", "赵立新", "钱志远"].sort(), "只学进律师写的字段里的姓名");
  const msgs = (r.body as any).messages;
  const c = body(msgs[2].content);
  assert.equal(c.cards[0].suggestion, cards.cards[0]!.suggestion);
  assert.equal(c.cards[0].fallback, cards.cards[0]!.fallback);
  assert.equal(c.cards[1].issue, cards.cards[1]!.issue);
  assert.ok(!c.cards[1].lawyer_text.includes("王建业"), c.cards[1].lawyer_text);
  const f = body(msgs[4].content);
  assert.equal(f.facts[0].statement, facts.facts[0]!.statement);
  assert.ok(!f.facts[1].statement.includes("赵立新"));
  const tb = body(msgs[6].content);
  assert.equal(tb.cells[0].value, table.cells[0]!.value);
  assert.ok(!tb.cells[1].value.includes("钱志远"));
  const o = body(msgs[8].content);
  assert.equal(o.confirmed_arguments[0].claim, "被告应开具发票");
  assert.ok(!o.confirmed_arguments[1].claim.includes("孙志强") && !o.lawyer_note.includes("周文涛"));
});

test("读回规则只认本请求里 assistant 调用的这四个工具：别的工具结果、没有对应调用的照常识别；读回结果解析不了（引擎截断）的只替换已知名单；Anthropic 形态同样按字段", () => {
  const t = new MatterTokenizer({ matterKey: KEY });
  const prose = "每期付款前，乙方应开具等额合法有效的增值税专用发票。";
  const r = processChatPayload(
    {
      model: "legal/k3",
      messages: [
        { role: "user", content: "审查。" },
        call("c1", "mcp__legal__materials_read_excerpt"),
        result("c1", { text: "证人王建业出庭作证。" }),
        call("c2", "mcp__legal__riskcards_list"),
        // 超长被引擎截断：JSON 不完整、后面接存放说明（律师写的字段内核交回前已换成代号，这里只替换已知名单）
        { role: "tool", tool_call_id: "c2", content: `Wall time: 0.031 seconds\n{\n  "cards": [\n    {\n      "suggestion": "${prose}"\n[...truncated]\n证人赵立新称已保存` },
        { role: "tool", tool_call_id: "c9", content: JSON.stringify({ cards: [{ suggestion: "由证人钱志远签收" }] }) },
        { role: "user", content: "继续。" },
      ],
    },
    t,
  );
  // 材料摘录（非读回工具）、没有对应调用的 tool 消息：照常识别；截断的读回结果不学
  assert.deepEqual(persons(t), ["王建业", "钱志远"].sort());
  assert.ok((r.body as any).messages[4].content.includes(prose), "截断的读回结果里模型写的文字原样");
  assert.ok(!JSON.stringify(r.body).includes("王建业"));
  // Anthropic 形态
  const t2 = new MatterTokenizer({ matterKey: KEY });
  const a = processChatPayload(
    {
      model: "legal/k3",
      messages: [
        { role: "user", content: [{ type: "text", text: "审查。" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__legal__riskcards_list", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: JSON.stringify({ cards: [{ suggestion: prose, lawyer_text: "由证人钱志远签收" }] }, null, 2) }] }] },
      ],
    },
    t2,
  );
  assert.deepEqual(persons(t2), ["钱志远"]);
  const back = JSON.parse((a.body as any).messages[2].content[0].content[0].text);
  assert.equal(back.cards[0].suggestion, prose);
});
