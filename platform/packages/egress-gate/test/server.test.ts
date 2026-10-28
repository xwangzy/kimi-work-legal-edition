/**
 * 出站闸门本机服务（第 04 篇 §5.1）：只监听本机套接字；/v1 令牌化后转发、响应流原样返回；/search 去标识/泛化/拒绝且不带事项编号；
 * /fetch 的 URL 检查；每一次出网（含被拦截的）都有去向记录；依据、数据级别、端点与图像载荷按事项上下文裁决。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressGateServer } from "../src/server.ts";
import type { AuthorizeResult, GateAuthority, GateEgressRecord, MatterEgressContext } from "../src/types.ts";
import type { TokenEntry } from "@zr-legal/tokenizer";

const KEY = Buffer.alloc(32, 7).toString("base64");

function ctx(o: Partial<MatterEgressContext> = {}): MatterEgressContext {
  return {
    tenantId: "t1",
    matterId: "m1",
    runId: "r1",
    userId: "u1",
    anonMatterId: "anon-7f3a",
    dataLevel: "L2",
    basisComplete: true,
    modelEndpoint: "standard",
    preauth: { searchGeneralized: false, images: false },
    l3aStandardAllowed: false,
    fetchAllowlist: ["court.gov.cn", "npc.gov.cn"],
    policyVersion: 3,
    tokenizer: { keyB64: KEY, parties: [{ name: "孙悦", kind: "person" }, { name: "甲科技有限公司", kind: "org" }], table: [], fullPseudonym: false, tableVersion: 1 },
    ...o,
  };
}

class FakeAuthority implements GateAuthority {
  current: MatterEgressContext | null = ctx();
  readonly records: GateEgressRecord[] = [];
  readonly newTokens: TokenEntry[] = [];
  async authorize(req: { token: string; matterId: string }): Promise<AuthorizeResult> {
    if (req.token !== "task-token-ok") return { ok: false, status: 401, reason: "token_invalid" };
    if (!this.current) return { ok: false, status: 403, reason: "run_not_live" };
    return { ok: true, ctx: { ...this.current, matterId: req.matterId === "m1" ? "m1" : this.current.matterId } };
  }
  record(rec: GateEgressRecord): void {
    this.records.push(rec);
  }
  tokens(_m: string, entries: TokenEntry[]): void {
    this.newTokens.push(...entries);
  }
}

interface Upstream {
  server: Server;
  url: string;
  bodies: { path: string; headers: IncomingMessage["headers"]; body: string }[];
}

async function upstream(handler: (path: string, body: string, res: import("node:http").ServerResponse) => void): Promise<Upstream> {
  const bodies: Upstream["bodies"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push({ path: req.url ?? "", headers: req.headers, body });
      handler(req.url ?? "", body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

function call(socket: string, path: string, body: unknown, token = "task-token-ok"): Promise<{ status: number; headers: IncomingMessage["headers"]; text: string }> {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = request({ socketPath: socket, path, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(data) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

const SSE = 'data: {"choices":[{"delta":{"content":"〔自然人·ABCDEF〕的借款"}}]}\n\ndata: {"choices":[{"delta":{"content":"已核对。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

describe("出站闸门服务", () => {
  let dir: string;
  let socket: string;
  let gate: EgressGateServer;
  let authority: FakeAuthority;
  let model: Upstream;
  let search: Upstream;

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-gate-")));
    socket = join(dir, "gate.sock");
    authority = new FakeAuthority();
    model = await upstream((_p, _b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "up-1" });
      res.end(SSE);
    });
    search = await upstream((_p, _b, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ search_results: [{ title: "公司法第四十九条释义", url: "https://flk.npc.gov.cn/x", snippet: "股东应当按期足额缴纳" }] }));
    });
    gate = new EgressGateServer({
      authority,
      upstreams: { model: { baseUrl: `${model.url}/v1`, seatToken: "seat-xyz" }, search: { baseUrl: `${search.url}/search`, seatToken: "seat-xyz" }, fetch: "local" },
    });
    await gate.listen(socket);
  });

  after(async () => {
    await gate.close();
    model.server.close();
    search.server.close();
  });

  test("/v1：请求体令牌化后转发（自然人姓名、手机号替换为代号，机构名称保留），带匿名事项编号与席位凭据；响应流逐字节原样返回", async () => {
    authority.current = ctx();
    const body = {
      model: "kimi-k3",
      stream: true,
      prompt_cache_key: "sess-1",
      messages: [
        { role: "system", content: "你是律师助手。" },
        { role: "user", content: "孙悦（手机13800138000）向甲科技有限公司借款五万元，请核对。" },
      ],
    };
    const r = await call(socket, "/m/m1/v1/chat/completions", body);
    assert.equal(r.status, 200);
    assert.equal(r.text, SSE, "响应流不还原、不改写");
    assert.ok(r.headers["x-kwl-gate-request-id"]);
    const sent = model.bodies.at(-1)!;
    assert.equal(sent.path, "/v1/chat/completions");
    assert.ok(!sent.body.includes("孙悦") && !sent.body.includes("13800138000"), sent.body);
    assert.ok(sent.body.includes("甲科技有限公司"));
    assert.equal(sent.headers.authorization, "Bearer seat-xyz");
    assert.equal(sent.headers["x-kwl-anon-matter"], "anon-7f3a");
    assert.equal(sent.headers["x-kwl-data-level"], "L2");
    const rec = authority.records.at(-1)!;
    assert.equal(rec.purpose, "model");
    assert.equal(rec.outcome, "sent");
    assert.equal(rec.destination, "legal_gateway");
    assert.equal(rec.tokenized.person, 1);
    assert.equal(rec.tokenized.phone, 1);
    // 同一请求再发一次（下一轮引擎回传同样的历史）：发往上游的正文完全相同（确定性令牌，前缀缓存不破）
    await call(socket, "/m/m1/v1/chat/completions", body);
    assert.equal(model.bodies.at(-1)!.body, sent.body);
  });

  test("/v1：出站去向矩阵——不使用模型、L4、L3b 标准端点、L3a 未开全部化名、依据未齐备一律拒绝并记录；图像载荷 L2 未预授权与 L3 拦截", async () => {
    const cases: [Partial<MatterEgressContext>, string][] = [
      [{ modelEndpoint: "none" }, "model_disabled_for_matter"],
      [{ dataLevel: "L4" }, "l4_no_egress"],
      [{ dataLevel: "L3b" }, "l3b_no_standard_endpoint"],
      [{ dataLevel: "L3a" }, "l3a_requires_full_pseudonym"],
      [{ dataLevel: "L3a", tokenizer: { ...ctx().tokenizer, fullPseudonym: true } }, "l3a_standard_not_enabled"],
      [{ modelEndpoint: "byok" }, "model_upstream_unavailable"],
      [{ basisComplete: false }, "basis_pending_no_egress"],
    ];
    const n = model.bodies.length;
    for (const [o, reason] of cases) {
      authority.current = ctx(o);
      const r = await call(socket, "/m/m1/v1/chat/completions", { model: "kimi-k3", messages: [{ role: "user", content: "你好" }] });
      assert.equal(r.status, reason === "model_upstream_unavailable" ? 503 : 403, reason);
      assert.equal(JSON.parse(r.text).error.code, reason);
      assert.equal(authority.records.at(-1)!.outcome, "blocked");
    }
    const img = { model: "kimi-k3", messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] };
    authority.current = ctx();
    assert.equal(JSON.parse((await call(socket, "/m/m1/v1/chat/completions", img)).text).error.code, "media_requires_confirmation");
    authority.current = ctx({ dataLevel: "L3a", l3aStandardAllowed: true, tokenizer: { ...ctx().tokenizer, fullPseudonym: true } });
    assert.equal(JSON.parse((await call(socket, "/m/m1/v1/chat/completions", img)).text).error.code, "l3_media_forbidden");
    authority.current = ctx({ preauth: { searchGeneralized: false, images: true } });
    assert.equal((await call(socket, "/m/m1/v1/chat/completions", img)).status, 200);
    assert.equal(model.bodies.length, n + 1, "被拒绝的请求一个都没有到达上游");
  });

  test("令牌与授权：无令牌 401；内核拒绝（运行已结束）即拒绝；路由以外 404；只允许 POST", async () => {
    authority.current = ctx();
    assert.equal((await call(socket, "/m/m1/v1/chat/completions", { messages: [] }, "bad")).status, 401);
    authority.current = null;
    assert.equal((await call(socket, "/m/m1/v1/chat/completions", { messages: [] })).status, 403);
    authority.current = ctx();
    assert.equal((await call(socket, "/m/m1/admin", {})).status, 404);
  });

  test("/search：一般性查询放行且不带事项编号；含当事人实体在 L2 未预授权时拒绝（提示改写），预授权时泛化后放行；查询原文与发出的查询只记在本机去向记录", async () => {
    authority.current = ctx();
    const ok = await call(socket, "/m/m1/search", { text_query: "股东未实缴出资 补足责任 判例" });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).search_results.length, 1);
    const sent = search.bodies.at(-1)!;
    assert.equal(sent.headers["x-kwl-anon-matter"], undefined, "检索调用不携带事项编号");
    assert.ok(!sent.body.includes("m1") && !JSON.stringify(sent.headers).includes("anon-7f3a"));
    const n = search.bodies.length;
    const denied = await call(socket, "/m/m1/search", { text_query: "甲科技有限公司 股东未实缴出资" });
    assert.equal(denied.status, 403);
    assert.match(JSON.parse(denied.text).error.message, /改写/);
    assert.equal(search.bodies.length, n);
    authority.current = ctx({ preauth: { searchGeneralized: true, images: false } });
    const gen = await call(socket, "/m/m1/search", { text_query: "甲科技有限公司 股东未实缴出资" });
    assert.equal(gen.status, 200);
    assert.equal(gen.headers["x-kwl-search-decision"], "generalized");
    assert.equal(JSON.parse(search.bodies.at(-1)!.body).text_query, "某公司 股东未实缴出资");
    const rec = authority.records.at(-1)!;
    assert.deepEqual(rec.query, { original: "甲科技有限公司 股东未实缴出资", sent: "某公司 股东未实缴出资", decision: "generalized" });
  });

  test("/fetch：URL 携带当事人信息、私网与元数据地址、非 http(s) 一律拒绝并记录；L4 事项禁止抓取", async () => {
    authority.current = ctx();
    for (const [url, reason] of [
      [`https://example.com/q?who=${encodeURIComponent("孙悦")}`, "person_name_in_url"],
      ["http://169.254.169.254/latest/meta-data/", "address_not_public"],
      ["file:///etc/passwd", "scheme_not_allowed"],
    ] as const) {
      const r = await call(socket, "/m/m1/fetch", { url });
      assert.equal(r.status, 403, url);
      assert.equal(JSON.parse(r.text).error.code, reason);
      assert.equal(authority.records.at(-1)!.outcome, "blocked");
    }
    authority.current = ctx({ dataLevel: "L4" });
    assert.equal(JSON.parse((await call(socket, "/m/m1/fetch", { url: "https://www.court.gov.cn/" })).text).error.code, "l4_no_egress");
  });

  test("新识别出的人名回写内核令牌表（界面还原需要）；令牌表版本变化时闸门重建令牌化器", async () => {
    authority.current = ctx();
    const before = authority.newTokens.length;
    await call(socket, "/m/m1/v1/chat/completions", { model: "kimi-k3", messages: [{ role: "user", content: "证人：欧阳娜娜，当庭作证。" }] });
    const fresh = authority.newTokens.slice(before);
    assert.ok(fresh.some((e) => e.category === "person" && e.value === "欧阳娜娜"));
    // 内核持久化后令牌表版本 +1：闸门按新表重建，同一人名得到同一代号
    authority.current = ctx({ tokenizer: { ...ctx().tokenizer, table: fresh, tableVersion: 2 } });
    await call(socket, "/m/m1/v1/chat/completions", { model: "kimi-k3", messages: [{ role: "user", content: "欧阳娜娜补充陈述。" }] });
    const tok = fresh.find((e) => e.value === "欧阳娜娜")!.token;
    assert.ok(model.bodies.at(-1)!.body.includes(tok));
  });

  test("D-157：assistant 消息里的助手意见不回写内核令牌表（只有工具结果里的新姓名回写）；按新表重建后合同原文原样到达模型", async () => {
    authority.current = ctx({ tokenizer: { ...ctx().tokenizer, tableVersion: 30 } });
    const before = authority.newTokens.length;
    const args = JSON.stringify({ cards: [{ anchor_text: "甲方向乙方支付货款", issue: "问题：先收款后开票使甲方付款时无法核验发票合规性。", suggestion: "该条款对买方明显不利。" }] });
    await call(socket, "/m/m1/v1/chat/completions", {
      model: "kimi-k3",
      messages: [
        { role: "user", content: "审查采购合同。" },
        { role: "assistant", content: "被告向原告支付违约金的请求缺乏依据；任何一方违约的，应承担责任。", tool_calls: [{ id: "c1", type: "function", function: { name: "riskcards_submit", arguments: args } }] },
        { role: "tool", tool_call_id: "c1", content: "证人：李明辉，当庭作证。" },
        { role: "user", content: "继续。" },
      ],
    });
    const fresh = authority.newTokens.slice(before);
    assert.deepEqual(fresh.filter((e) => e.category === "person").map((e) => e.value), ["李明辉"]);
    authority.current = ctx({ tokenizer: { ...ctx().tokenizer, table: fresh, tableVersion: 31 } });
    const contract = "3.1 乙方收到付款后五日内开具发票；如违约金明显过高，可请求调整。";
    await call(socket, "/m/m1/v1/chat/completions", { model: "kimi-k3", messages: [{ role: "user", content: "逐字引用第3.1条。" }, { role: "tool", tool_call_id: "c2", content: contract }] });
    assert.ok(model.bodies.at(-1)!.body.includes(contract), model.bodies.at(-1)!.body);
  });
});
