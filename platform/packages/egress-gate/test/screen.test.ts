/**
 * 闸门的检索查询检查与模型请求体令牌化（第 02 篇 §8.2–§8.4、§11.2；第 04 篇 §5.1；第 06 篇 T07、T20）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatterTokenizer, findTokens } from "@zr-legal/tokenizer";
import { screenSearchQuery, type SearchContext } from "../src/search-guard.ts";
import { processChatPayload } from "../src/chat-payload.ts";

const parties = [
  { name: "甲科技有限公司", kind: "org" as const, aliases: ["甲公司"] },
  { name: "孙悦", kind: "person" as const },
];
const tz = () => new MatterTokenizer({ matterKey: Buffer.alloc(32, 5), parties });
const ctx = (o: Partial<SearchContext> = {}): SearchContext => ({ dataLevel: "L2", basisComplete: true, preauthorizedGeneralize: false, tokenizer: tz(), ...o });

test("检索：不含当事人与人名的一般性查询放行；标识符一律去除（不发代号）", () => {
  const ok = screenSearchQuery("股权转让 未实缴出资 股东补足责任 上海 判例", ctx());
  assert.equal(ok.decision, "pass");
  const ids = screenSearchQuery("手机13800138000 机主 借贷纠纷", ctx());
  assert.ok(ids.decision === "pass" && !ids.sent.includes("13800138000") && !ids.sent.includes("〔"));
});

test("检索（第 02 篇 §11.2）：含当事人实体——L2 未预授权即拒绝并给出改写提示；预授权“泛化后放行”则泛化（机构 → 某公司，自然人 → 某人）", () => {
  const q = "甲科技有限公司 股东未实缴出资 补足责任";
  const denied = screenSearchQuery(q, ctx());
  assert.equal(denied.decision, "deny");
  assert.equal(denied.decision === "deny" && denied.reason, "search_entity_requires_confirmation");
  const gen = screenSearchQuery(q, ctx({ preauthorizedGeneralize: true }));
  assert.ok(gen.decision === "generalized" && gen.sent.startsWith("某公司") && !gen.sent.includes("甲科技"));
  const person = screenSearchQuery("孙悦 民间借贷 利息", ctx({ preauthorizedGeneralize: true }));
  assert.ok(person.decision === "generalized" && person.sent.includes("某人") && !person.sent.includes("孙悦"));
  // 别名同样命中
  assert.equal(screenSearchQuery("甲公司 违约金", ctx()).decision, "deny");
  // 规则识别出的人名（不在词典）同样命中
  assert.equal(screenSearchQuery("被告李建国 借款合同纠纷", ctx()).decision, "deny");
});

test("检索：L3a 逐条确认（G0 通道不受理确认 → 一律拒绝，审查 S4-05）；L3b、L4 禁止；依据未齐备不出站", () => {
  assert.equal(screenSearchQuery("甲科技有限公司 处罚", ctx({ dataLevel: "L3a", preauthorizedGeneralize: true })).decision, "deny");
  const l3a = screenSearchQuery("一般性法律问题", ctx({ dataLevel: "L3a" }));
  assert.equal(l3a.decision, "deny");
  assert.equal((l3a as { reason: string }).reason, "search_l3a_each_query");
  assert.equal(screenSearchQuery("一般性法律问题", ctx({ dataLevel: "L3b" })).decision, "deny");
  assert.equal(screenSearchQuery("一般性法律问题", ctx({ dataLevel: "L4" })).decision, "deny");
  assert.equal(screenSearchQuery("一般性法律问题", ctx({ basisComplete: false })).decision, "deny");
  assert.equal(screenSearchQuery("一般性法律问题", ctx({ dataLevel: "L0", basisComplete: false })).decision, "pass");
});

test("模型请求体：各文本字段（含 reasoning_content、工具参数）同一令牌化；确定性令牌化幂等——已令牌化的历史原样；图像等非文本载荷被列出", () => {
  const t = tz();
  const body = {
    model: "kimi-k3",
    prompt_cache_key: "sess-1",
    messages: [
      { role: "system", content: "你是律师助手。" },
      { role: "user", content: "审查孙悦与甲科技有限公司的借款合同，孙悦手机13800138000。" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "需要核对孙悦的还款记录。",
        tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "grep 13800138000 流水.csv" }) } }],
      },
      { role: "tool", tool_call_id: "c1", content: "2024-01-01,孙悦,5000" },
      { role: "user", content: [{ type: "text", text: "见附图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ],
  };
  const r = processChatPayload(body, t);
  const s = JSON.stringify(r.body);
  assert.ok(!s.includes("孙悦") && !s.includes("13800138000"), s);
  assert.ok(s.includes("甲科技有限公司"), "机构名称默认保留");
  assert.equal(r.media.length, 1);
  assert.equal(r.media[0]!.kind, "image_url");
  // 工具参数仍是合法 JSON，且同一手机号在各处是同一代号
  const args = JSON.parse(((r.body.messages as any[])[2].tool_calls[0].function.arguments) as string) as { command: string };
  const phoneTok = findTokens(args.command)[0]!;
  assert.ok(s.split(phoneTok).length - 1 >= 2);
  // 再处理一次（下一轮引擎回传同样的历史）：完全不变
  const again = processChatPayload(r.body, t);
  assert.equal(JSON.stringify(again.body), s);
  assert.equal(again.replaced, 0);
  // 原请求对象未被修改
  assert.ok(JSON.stringify(body).includes("孙悦"));
});

test("S4-06 模型请求体：整个请求体的文本值都令牌化（数组形态 system、messages[].name、thinking/refusal 块、旧式 function_call、工具描述与参数 schema、response_format、转义写法的工具参数）；结构字段原样；未知与文档类内容块列为非文本载荷", () => {
  const t = tz();
  const esc = JSON.stringify({ query: "孙悦" }).replace("孙悦", "\\u5b59\\u60a6");
  const body = {
    model: "legal/k3",
    prompt_cache_key: "sess-孙悦-不改",
    system: [{ type: "text", text: "当事人孙悦。" }],
    messages: [
      { role: "user", name: "孙悦", content: [{ type: "text", text: "孙悦的借款" }, { type: "thinking", thinking: "考虑孙悦" }, { type: "refusal", refusal: "不便回答孙悦" }] },
      { role: "assistant", content: null, function_call: { name: "WebSearch", arguments: JSON.stringify({ query: "孙悦" }) } },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "WebSearch", arguments: esc } }] },
      { role: "user", content: [{ type: "document", source: { data: "孙悦" } }] },
      { role: "user", content: [{ type: "x-custom", payload: "孙悦" }] },
    ],
    // 参数名为 content/system 的 schema 属性不是内容块（Write 工具的 content 参数）
    tools: [{ type: "function", function: { name: "查询孙悦案件", description: "查询孙悦的案件", parameters: { type: "object", properties: { who: { type: "string", description: "默认孙悦", default: "孙悦" }, content: { type: "string", description: "写给孙悦的内容" }, system: { type: "string" } } } } }],
    response_format: { type: "json_schema", json_schema: { name: "r", schema: { type: "object", description: "关于孙悦" } } },
  };
  const r = processChatPayload(body, t);
  const out = r.body as any;
  const textOnly = JSON.stringify({ ...out, prompt_cache_key: "", messages: out.messages.slice(0, 3), tools: out.tools.map((x: any) => ({ ...x, function: { ...x.function, name: "" } })) });
  assert.ok(!textOnly.includes("孙悦"), textOnly);
  assert.ok(!JSON.parse(out.messages[2].tool_calls[0].function.arguments).query.includes("孙悦"), "转义写法同样替换");
  // 结构字段原样：会话键、模型、工具名（函数名）
  assert.equal(out.prompt_cache_key, "sess-孙悦-不改");
  assert.equal(out.model, "legal/k3");
  assert.equal(out.tools[0].function.name, "查询孙悦案件");
  assert.equal(out.messages[1].function_call.name, "WebSearch");
  // 文档块与未知类型：列为非文本载荷（闸门据此拒绝），内容不改
  assert.deepEqual(r.media.map((m) => m.kind).sort(), ["document", "unknown:x-custom"]);
});
