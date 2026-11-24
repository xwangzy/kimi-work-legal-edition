/**
 * 第 62 批：网关的用量采集与计价（契约 platform/docs/contract-b62-pricing.md §4）。
 *
 * usage 的形状按 2026-11-24 对中软 MaaS（https://maas.jointpilot.com/v1，kimi-k3.1-pro / -highspeed / kimi-k2.6）真实调用取得：
 * - 非流式：顶层 usage；首次 prompt_tokens_details.cache_write_tokens（无 cached_tokens），之后 cached_tokens 顶层与 prompt_tokens_details 各一份；
 * - 流式：带 finish_reason 的那块在 choices[0].usage 给一次，随后一块 choices 为空、顶层 usage 再给一次；
 * - 响应头 Msh-Usage-Cache-Write-Tokens-5m / -1h（流式也有）；prompt_cache_options.ttl = "1h" 时写入全记 1 小时；
 * - prompt_tokens 含命中与写入（三者之和 = 总输入）；completion_tokens 含推理。
 * MaaS 账单核查的教训：只看末块顶层 usage、或尾部窗口会漏；缺真实 usage 时估算只作待对账（不扣）。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { cacheWriteHeaders, createLegalGateway, extractUsage, fileMeter, MapQuota, requestedCacheTtl, reserveRatesFor, saleRatesFor, staticRouting, unitsOf, UsageTap, type PriceTable, type UsageRecord } from "../src/index.ts";
import type { ChatProvider, UpstreamResponse } from "../src/providers.ts";

const enc = new TextEncoder();
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

// 真实形状（MaaS kimi-k3.1-pro 流式第 2 次：命中 8960）
const REAL_USAGE = { prompt_tokens: 9114, completion_tokens: 116, total_tokens: 9230, cached_tokens: 8960, completion_tokens_details: { reasoning_tokens: 77 }, prompt_tokens_details: { cached_tokens: 8960, cache_write_tokens: 0 } };
const realStream = (usage: Record<string, unknown> = REAL_USAGE) => [
  sse({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "kimi-k3.1-pro", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
  sse({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "依约支付价款。" } }] }),
  sse({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop", usage }] }),
  sse({ id: "chatcmpl-1", choices: [], usage }),
  "data: [DONE]\n\n",
];

test("extractUsage：真实流式（choices[0].usage + 顶层）、真实非流式（首次只有写入）；prompt_tokens 含命中与写入；推理单列", () => {
  assert.deepEqual(extractUsage(realStream().join("")), { input: 9114, output: 116, cached: 8960, reasoning: 77 });
  // 只有 choices[].usage（没有顶层那一块）也认
  assert.deepEqual(extractUsage(realStream().slice(0, 3).join("")), { input: 9114, output: 116, cached: 8960, reasoning: 77 });
  const first = JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "好" }, finish_reason: "stop" }], usage: { prompt_tokens: 9114, completion_tokens: 125, total_tokens: 9239, completion_tokens_details: { reasoning_tokens: 86 }, prompt_tokens_details: { cache_write_tokens: 8960 } } });
  assert.deepEqual(extractUsage(first), { input: 9114, output: 125, cached: 0, reasoning: 86, cache_write: 8960 });
  // K2.6：顶层 cached_tokens，没有写入字段
  assert.deepEqual(extractUsage(JSON.stringify({ usage: { prompt_tokens: 9029, completion_tokens: 141, cached_tokens: 8192, prompt_tokens_details: { cached_tokens: 8192 } } })), { input: 9029, output: 141, cached: 8192, reasoning: 0 });
});

test("非流式大响应（> 64 KiB）只留尾部：开头被截断也按括号配对取到 usage（改前退回估算）", () => {
  const big = JSON.stringify({ id: "x", choices: [{ index: 0, message: { role: "assistant", content: "长".repeat(80_000) }, finish_reason: "stop" }], usage: { prompt_tokens: 50_000, completion_tokens: 30_000, prompt_tokens_details: { cached_tokens: 40_000 } } });
  const tail = big.slice(-65_536);
  assert.ok(!tail.trim().startsWith("{\"id\""));
  assert.deepEqual(extractUsage(tail), { input: 50_000, output: 30_000, cached: 40_000, reasoning: 0 });
  // 正文里出现 "usage" 字样不误认
  const tricky = JSON.stringify({ choices: [{ message: { content: '说明："usage": {不是 JSON' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }).slice(5);
  assert.deepEqual(extractUsage(tricky), { input: 7, output: 3, cached: 0, reasoning: 0 });
});

test("UsageTap：全流逐行取 usage——块边界切在行中间、usage 之后还有 > 64 KiB、超长行跳过、末行无换行都对", () => {
  const text = realStream().join("") + Array.from({ length: 400 }, () => sse({ choices: [{ delta: { content: "尾".repeat(300) } }] })).join("");
  assert.ok(text.length - text.indexOf('"usage"') > 65_536, "usage 之后超过 64 KiB");
  assert.equal(extractUsage(text.slice(-65_536)), null, "只看尾部窗口会漏（改前的做法）");
  const tap = new UsageTap();
  for (let i = 0; i < text.length; i += 7) tap.feed(text.slice(i, i + 7));
  assert.deepEqual(tap.end(), { input: 9114, output: 116, cached: 8960, reasoning: 77 });
  assert.equal(tap.seen, 2, "choices[].usage 与顶层各一次");
  const t2 = new UsageTap();
  t2.feed(`data: {"choices":[{"delta":{"content":"${"x".repeat(1_100_000)}"}}]}\n`);
  t2.feed(`data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}`);
  assert.deepEqual(t2.end(), { input: 5, output: 1, cached: 0, reasoning: 0 }, "超长行丢弃、末行无换行仍解析");
});

test("缓存写入按 TTL：响应头优先，缺头按请求 prompt_cache_options.ttl（缺省 5 分钟）；计价五档", () => {
  assert.deepEqual(cacheWriteHeaders({ "msh-usage-cache-write-tokens-1h": "7168", "msh-usage-cache-write-tokens-5m": "0" }), { w5m: 0, w1h: 7168 });
  assert.equal(cacheWriteHeaders({}), null);
  assert.equal(cacheWriteHeaders({ "msh-usage-cache-write-tokens-1h": "abc" }), null);
  assert.equal(requestedCacheTtl({ prompt_cache_options: { mode: "implicit", ttl: "1h" } }), "1h");
  assert.equal(requestedCacheTtl({}), "5m");
  const k31 = { input: 13, cached_input: 1.3, cache_write: 13, cache_write_1h: 26, output: 68 };
  assert.equal(unitsOf("cny", { input: 9114, cached: 0, output: 125, cache_write: 8960 }, k31), 126_982);
  assert.equal(unitsOf("cny", { input: 7317, cached: 0, output: 103, cache_write: 7168, cache_write_1h: 7168 }, k31), 195_309);
  assert.equal(unitsOf("tokens", { input: 7317, cached: 7000, output: 103, cache_write: 100 }, k31), 7317 + 103, "tokens 单位：输入 + 输出");
  // 旧格式（按别名）仍可用
  assert.equal(unitsOf("cny", { input: 1000, cached: 200, output: 500 }, { input: 4, cached_input: 1, output: 16, cost_input: null, cost_cached_input: null, cost_output: null }), 11_400);
  // 预占：候选型号逐项取大；有候选没价 = null；旧格式按别名
  const prices: PriceTable = { version: 7, effective_at: null, items: {}, basis: "model", models: { a: { sale: { input: 13, cached_input: 1.3, cache_write: 13, cache_write_1h: 26, output: 68 }, cost: k31 }, b: { sale: { input: 26, cached_input: 1.3, cache_write: 26, cache_write_1h: 52, output: 136 }, cost: k31 } } };
  assert.deepEqual(reserveRatesFor(prices, "legal/k3", ["a", "b"]), { input: 26, cached_input: 1.3, cache_write: 26, cache_write_1h: 52, output: 136 });
  assert.equal(reserveRatesFor(prices, "legal/k3", ["a", "nope"]), null);
  assert.equal(saleRatesFor(prices, "legal/k3", "nope"), null, "按型号计价时不回退到别名");
  assert.equal(saleRatesFor({ version: 1, effective_at: null, items: { "legal/k3": { input: 4, cached_input: null, output: 16, cost_input: null, cost_cached_input: null, cost_output: null } } }, "legal/k3", "whatever")!.input, 4);
});

/** 可编排的上游：按队列逐次回应（200 流式 / 非流式、503、429、中途断开、无 usage、带写入头）。 */
type Plan = { status?: number; chunks?: string[]; json?: unknown; headers?: Record<string, string>; breakAfter?: number };
class ScriptedProvider implements ChatProvider {
  readonly name: string;
  queue: Plan[] = [];
  bodies: Record<string, unknown>[] = [];
  constructor(name: string) {
    this.name = name;
  }
  async chat(body: Record<string, unknown>): Promise<UpstreamResponse> {
    this.bodies.push(body);
    const p = this.queue.shift() ?? { chunks: realStream() };
    const status = p.status ?? 200;
    if (status !== 200) return { status, headers: { "content-type": "application/json", ...(p.headers ?? {}) }, body: (async function* () { yield enc.encode('{"error":{"message":"x"}}'); })() };
    if (p.json !== undefined) return { status, headers: { "content-type": "application/json", ...(p.headers ?? {}) }, body: (async function* () { yield enc.encode(JSON.stringify(p.json)); })() };
    const chunks = p.chunks ?? [];
    return {
      status,
      headers: { "content-type": "text/event-stream", ...(p.headers ?? {}) },
      body: (async function* () {
        for (const [i, c] of chunks.entries()) {
          if (p.breakAfter !== undefined && i >= p.breakAfter) throw new Error("upstream reset");
          yield enc.encode(c);
        }
      })(),
    };
  }
}

describe("网关按上游型号计价（静态路由 + 金额租户）", () => {
  const { privateKey, publicKey } = devSeatKeyPair();
  const token = issueSeatToken({ tid: "tc", uid: "u1", sid: "s-tc", dev: "d1", kid: "k1" }, privateKey);
  const a = new ScriptedProvider("a");
  const b = new ScriptedProvider("b");
  const K31 = { input: 13, cached_input: 1.3, cache_write: 13, cache_write_1h: 26, output: 68 };
  const HS = { input: 26, cached_input: 1.3, cache_write: 26, cache_write_1h: 52, output: 136 };
  const prices: PriceTable = { version: 9, effective_at: null, items: { "legal/k3": { input: 999, cached_input: 999, output: 999, cost_input: null, cost_cached_input: null, cost_output: null } }, basis: "model", models: { "kimi-k3.1-pro": { sale: K31, cost: K31 }, "kimi-k3.1-pro-highspeed": { sale: HS, cost: HS } } };
  const budgets = new Map<string, number>([["tc", 10_000_000_000]]);
  let meterPath = "";
  let server: ReturnType<typeof createLegalGateway>;
  let base = "";
  before(async () => {
    meterPath = join(realpathSync(mkdtempSync(join(tmpdir(), "kwl-gw-b62-"))), "meter.jsonl");
    const routing = staticRouting({
      providers: { a: { client: a, vendor: "csi-maas" }, b: { client: b, vendor: "csi-maas" } },
      routes: { "legal/k3": { label: "K3", enabled: true, isDefault: true, targets: [{ provider: "a", model: "kimi-k3.1-pro", priority: 1 }, { provider: "b", model: "kimi-k3.1-pro-highspeed", priority: 2 }], allowCrossVendor: false, defaultMaxTokens: 1000 } },
      prices,
    });
    server = createLegalGateway({ keys: new Map([["k1", publicKey]]), routing, meter: fileMeter(meterPath), quota: new MapQuota(budgets, "cny"), drainMs: 200 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  const chat = async (o: { stream?: boolean; extra?: Record<string, unknown> } = {}) => {
    // 流中途断开时网关断掉客户端连接：fetch 可能直接失败（记 -1）
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-kwl-anon-matter": "anon-b62", "x-kwl-data-level": "L2" }, body: JSON.stringify({ model: "legal/k3", stream: o.stream ?? true, max_tokens: 100, messages: [{ role: "user", content: "价款何时支付？" }], ...(o.extra ?? {}) }) }).catch(() => null);
    if (!r) return -1;
    await r.text().catch(() => "");
    return r.status;
  };
  const settles = (): UsageRecord[] => {
    let raw = "";
    try {
      raw = readFileSync(meterPath, "utf8");
    } catch {
      return [];
    }
    return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.kind === "settle").map((x) => x.record as UsageRecord);
  };
  const settleCount = () => settles().length;
  /** 发一次请求，等它的结算行落盘（结算在应答发完之后）。 */
  let seen = 0;
  const last = async (): Promise<UsageRecord> => {
    for (let i = 0; i < 80; i++) {
      const xs = settles();
      if (xs.length > seen) {
        seen = xs.length;
        return xs.at(-1)!;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no settle");
  };

  test("首选 503 → 切到备用（highspeed）：一条记录、两次尝试；按实际服务的型号计价（不按别名、不按首选）", async () => {
    a.queue.push({ status: 503 });
    b.queue.push({ chunks: realStream() });
    const n = settleCount();
    assert.equal(await chat(), 200);
    const r = await last();
    assert.equal(settleCount(), n + 1, "切换不产生第二条计费记录");
    assert.deepEqual([r.upstream_model, r.attempts.map((x) => x.status), r.usage_source], ["kimi-k3.1-pro-highspeed", [503, 200], "upstream"]);
    assert.equal(r.charge_units, Math.round(154 * 26 + 8960 * 1.3 + 116 * 136));
    // 预占按两个候选里最贵的（highspeed）
    assert.ok(r.reserved_units >= Math.ceil(JSON.stringify({ messages: [{ role: "user", content: "价款何时支付？" }] }).length / 2) * 26 + 100 * 136);
  });

  test("usage 之后还有 > 64 KiB 的块：全流逐行取到真实 usage（改前退回估算并按估算扣）", async () => {
    a.queue.push({ chunks: [...realStream().slice(0, 4), ...Array.from({ length: 400 }, () => sse({ choices: [{ delta: { content: "尾".repeat(300) } }] })), "data: [DONE]\n\n"] });
    assert.equal(await chat(), 200);
    const r = await last();
    assert.deepEqual([r.usage_source, r.usage, r.charge_units], ["upstream", { input: 9114, cached: 8960, output: 116, reasoning: 77 }, Math.round(154 * 13 + 8960 * 1.3 + 116 * 68)]);
  });

  test("缓存写入：响应头 1h 拆分按 1 小时价；没有头但请求 ttl=1h 全记 1 小时；缺省 5 分钟", async () => {
    const u = { prompt_tokens: 7317, completion_tokens: 103, prompt_tokens_details: { cache_write_tokens: 7168 } };
    a.queue.push({ chunks: realStream(u), headers: { "msh-usage-cache-write-tokens-1h": "7168", "msh-usage-cache-write-tokens-5m": "0" } });
    assert.equal(await chat(), 200);
    let r = await last();
    assert.deepEqual(r.usage, { input: 7317, cached: 0, output: 103, reasoning: 0, cache_write: 7168, cache_write_1h: 7168 });
    assert.equal(r.charge_units, 149 * 13 + 7168 * 26 + 103 * 68);
    a.queue.push({ json: { choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: u } });
    assert.equal(await chat({ stream: false, extra: { prompt_cache_options: { mode: "implicit", ttl: "1h" } } }), 200);
    r = await last();
    assert.equal(r.usage!.cache_write_1h, 7168, "没有头：按请求的 ttl");
    a.queue.push({ json: { choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: u } });
    assert.equal(await chat({ stream: false }), 200);
    r = await last();
    assert.deepEqual([r.usage!.cache_write, r.usage!.cache_write_1h, r.charge_units], [7168, undefined, 149 * 13 + 7168 * 13 + 103 * 68], "缺省 5 分钟 = 输入价");
  });

  test("上游一直不给 usage：按估算记 estimated，不扣（待对账）；全部 429：不计、不扣", async () => {
    a.queue.push({ chunks: [sse({ choices: [{ delta: { content: "没有用量" } }] }), sse({ choices: [{ delta: {}, finish_reason: "stop" }] }), "data: [DONE]\n\n"] });
    const before0 = budgets.get("tc")!;
    assert.equal(await chat(), 200);
    let r = await last();
    assert.deepEqual([r.usage_source, r.charge_units, r.outcome], ["estimated", 0, "ok"]);
    assert.ok(r.usage && r.usage.output > 0, "估算交控制面（另记、待对账）");
    assert.equal(budgets.get("tc"), before0, "估算不扣额度");
    a.queue.push({ status: 429, headers: { "retry-after": "3" } });
    b.queue.push({ status: 429 });
    assert.equal(await chat(), 429);
    r = await last();
    assert.deepEqual([r.usage, r.charge_units, r.outcome, r.attempts.map((x) => x.status)], [null, 0, "upstream_error", [429, 429]]);
    assert.equal(budgets.get("tc"), before0, "429 不扣");
  });

  test("流中途断开但已收到 usage：partial、usage 为真实（交控制面只记成本）、不扣；没收到 usage 才估算", async () => {
    a.queue.push({ chunks: [...realStream().slice(0, 4), sse({ choices: [{ delta: { content: "多出的一块" } }] }), "data: [DONE]\n\n"], breakAfter: 4 });
    const before0 = budgets.get("tc")!;
    await chat();
    let r = await last();
    assert.deepEqual([r.partial, r.usage_source, r.usage?.input, r.charge_units, r.outcome], [true, "upstream", 9114, 0, "upstream_error"]);
    a.queue.push({ chunks: realStream(), breakAfter: 2 });
    await chat();
    r = await last();
    // 只写出了首块（空内容）与第二块正文后即断：有正文 → partial + 估算
    assert.deepEqual([r.partial, r.usage_source, r.charge_units], [true, "estimated", 0]);
    assert.equal(budgets.get("tc"), before0);
  });
});
