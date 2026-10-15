/**
 * 网关内容安全（v9.2 R11）：Aho-Corasick 多模式匹配（NFKC、零宽、大小写折叠）；按类别 record / block；
 * 请求命中拦截类别 → 422 且不到达上游；流式输出命中 → 以错误事件结束；非流式输出命中 → 422 不发出原文；
 * 计量只记“类别:次数”，不记命中的文字。缺省（未配置或空词库）行为不变。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { ContentSafety, createLegalGateway, DEFAULT_ROUTES, fileMeter, MockProvider, OutputTextTap, foldForSafety } from "../src/index.ts";

// 测试用词库（占位词，不是生产词库；生产词库由内容安全团队签名下发）
const POLICY = {
  version: "test-1",
  categories: [
    { id: "test-block", action: "block" as const, terms: ["禁词甲乙", "BlockMe"] },
    { id: "test-record", action: "record" as const, terms: ["记录词", "丙丁"] },
  ],
};

test("匹配器：多模式、重叠、跨折叠（全角、零宽、大小写）；只返回类别与次数", () => {
  const cs = new ContentSafety(POLICY);
  assert.deepEqual(cs.check(["这里没有"]), { hits: {}, blocked: null });
  assert.deepEqual(cs.check(["记录词 与 记录词，丙丁"]), { hits: { "test-record": 3 }, blocked: null });
  assert.deepEqual(cs.check(["含 禁​词甲乙 与 ＢＬＯＣＫｍｅ"]), { hits: { "test-block": 2 }, blocked: "test-block" });
  assert.equal(foldForSafety("ＡＢｃ­"), "abc");
  assert.throws(() => new ContentSafety({ version: "x", categories: [{ id: "Bad Id", action: "block", terms: [] }] }), /编号不合法/);
  assert.throws(() => new ContentSafety({ version: "x", categories: [{ id: "a", action: "drop" as never, terms: [] }] }), /动作/);
  assert.equal(new ContentSafety({ version: "e", categories: [] }).empty, true);
  // 流式 SSE 片段：行跨块拼接
  const tap = new OutputTextTap();
  assert.equal(tap.feed('data: {"choices":[{"delta":{"content":"禁词'), "");
  assert.equal(tap.feed('甲乙"}}]}\n\ndata: [DONE]\n'), "禁词甲乙");
});

let server: Server;
let base: string;
let meterPath: string;
const provider = new MockProvider();
const { privateKey, publicKey } = devSeatKeyPair();
const token = issueSeatToken({ tid: "t1", uid: "u1", sid: "s1", dev: "d1", kid: "k1" }, privateKey);
before(async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-gw-cs-")));
  meterPath = join(dir, "meter.jsonl");
  server = createLegalGateway({ keys: new Map([["k1", publicKey]]), provider, routes: DEFAULT_ROUTES, meter: fileMeter(meterPath), budgets: new Map([["t1", 1_000_000]]), contentSafety: new ContentSafety(POLICY) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  provider.script = null;
  server.close();
});
const chat = (body: unknown) =>
  fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-kwl-anon-matter": "anon-1", "x-kwl-data-level": "L2" }, body: JSON.stringify(body) });

test("网关：请求命中拦截类别 → 422 不到达上游；命中记录类别照常放行；计量只有类别与次数", async () => {
  const n = provider.seen.length;
  const r1 = await chat({ model: "legal/k3", messages: [{ role: "user", content: [{ type: "text", text: "请写 禁词甲乙 的内容" }] }] });
  assert.equal(r1.status, 422);
  assert.equal(((await r1.json()) as any).error.code, "content_blocked_input");
  assert.equal(provider.seen.length, n, "不到达上游");
  const r2 = await chat({ model: "legal/k3", messages: [{ role: "user", content: "合同里的记录词条款" }] });
  assert.equal(r2.status, 200);
  await r2.text();
  const lines = readFileSync(meterPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.kind === "reject" && l.reason === "content_blocked_input" && l.safety === "in:test-block:1"));
  assert.ok(lines.some((l) => l.kind === "settle" && l.safety === "in:test-record:1"));
  const raw = readFileSync(meterPath, "utf8");
  for (const s of ["禁词甲乙", "记录词", "合同里"]) assert.ok(!raw.includes(s), `计量不得含命中文字或正文：${s}`);
});

test("网关：流式输出命中拦截类别 → 以错误事件结束（之后的上游内容不再发出）；非流式输出命中 → 422 不发出原文", async () => {
  provider.script = () => ({ content: "前文正常，后面出现 BlockMe 和更多内容" });
  const r = await chat({ model: "legal/k3", stream: true, messages: [{ role: "user", content: "写一段" }] });
  const text = await r.text();
  assert.match(text, /content_blocked_output/);
  assert.ok(!text.includes('"finish_reason":"stop"'), "命中后不再转发上游后续块");
  const r2 = await chat({ model: "legal/k3", messages: [{ role: "user", content: "写一段" }] });
  assert.equal(r2.status, 422);
  const body2 = await r2.text();
  assert.match(body2, /content_blocked_output/);
  assert.ok(!body2.includes("BlockMe"), "非流式命中时不发出原文");
  provider.script = () => ({ content: "一切正常 丙丁" });
  const r3 = await chat({ model: "legal/k3", stream: true, messages: [{ role: "user", content: "写一段" }] });
  assert.equal(r3.status, 200);
  assert.match(await r3.text(), /丙丁/);
  const lines = readFileSync(meterPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.kind === "settle" && String(l.reason).startsWith("content_blocked_output:test-block")));
  assert.ok(lines.some((l) => l.kind === "settle" && l.safety === "out:test-record:1"));
  provider.script = null;
});

test("输出通道（复核 B4-R05）：正文、推理文字、工具调用参数分通道取出；工具参数跨块拼出的词能命中；只用 \\r 的行尾能解析；超长一行置失败关闭", async () => {
  const { completionTexts } = await import("../src/content-safety.ts");
  const cs = new ContentSafety(POLICY);
  const sse = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}`;
  // 推理文字与工具参数
  const tap = new OutputTextTap();
  const pieces = tap.feedChannels(`${sse({ reasoning_content: "先想想禁词甲乙" })}\n\n${sse({ tool_calls: [{ index: 0, function: { arguments: '{"text":"Blo' } }] })}\n\n`);
  assert.deepEqual(pieces.map((p) => p.channel), ["reasoning", "tool:0"]);
  assert.equal(cs.check([pieces[0]!.text]).blocked, "test-block", "推理文字被检查");
  // 工具参数跨三块拼出拦截词：按通道累积的窗口能命中
  let win = pieces[1]!.text;
  for (const part of ["ckM", 'e"}']) {
    for (const p of tap.feedChannels(`${sse({ tool_calls: [{ index: 0, function: { arguments: part } }] })}\n\n`)) win += p.text;
  }
  assert.equal(cs.check([win]).blocked, "test-block", "工具参数跨块命中");
  // 只用 \r 的行尾；块末尾的单个 \r 留到下一块判定
  const crTap = new OutputTextTap();
  const a = crTap.feedChannels(`${sse({ content: "禁词" })}\r`);
  const b = crTap.feedChannels(`\n${sse({ content: "甲乙" })}\r\r`);
  assert.equal([...a, ...b].map((p) => p.text).join(""), "禁词甲乙");
  // 超长一行：不跳过，置 overflow
  const big = new OutputTextTap();
  big.feedChannels(`data: ${"x".repeat(1_100_000)}`);
  assert.equal(big.overflow, true);
  // 非流式：工具调用参数与推理文字同样取出
  const texts = completionTexts(JSON.stringify({ choices: [{ message: { content: "好", reasoning_content: "想", tool_calls: [{ function: { arguments: '{"a":"BlockMe"}' } }] } }] }));
  assert.equal(cs.check(texts).blocked, "test-block");
});

test("不可见字符（复核 B4-R13）：插在词中间的格式字符、变体选择符、标签字符、组合连接符与韩文填充字符都折叠掉", () => {
  const cs = new ContentSafety(POLICY);
  for (const ch of ["͏", "᠎", "‮", "⁦", "️", "\u{E0041}", "­", "ㅤ", "\u{E0101}"]) {
    assert.equal(cs.check([`禁词${ch}甲乙`]).blocked, "test-block", `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`);
  }
  assert.equal(foldForSafety("A​b"), "ab");
});

test("告知联动（复核 B4-R06）：计量落盘字段含内容安全时，《中软看得到什么》必须写明", () => {
  const meter = readFileSync(new URL("../src/meter-file.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../../../apps/desktop/src/pages/Connections.tsx", import.meta.url), "utf8");
  if (/"safety"/.test(meter)) assert.match(page, /内容安全检查命中的类别编号与次数/);
});
