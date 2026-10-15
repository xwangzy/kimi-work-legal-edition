/**
 * 检索服务 v0（第 04 篇 §5.3、§11 P4；第 02 篇 §12）：协议适配、法律站点组扇出（每组 ≤ 5）与去重、席位鉴权、不接收事项编号、查询原文不落盘。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createSearchService, LEGAL_SITE_GROUPS, MockSearchProvider, MoonshotToolsSearchProvider, type SearchMeterRecord } from "../src/index.ts";

const { privateKey, publicKey } = devSeatKeyPair();
const keys = new Map([["k1", publicKey]]);
const tok = issueSeatToken({ tid: "t1", uid: "u1", sid: "s1", dev: "d1", kid: "k1" }, privateKey);
const provider = new MockSearchProvider();
const meter: SearchMeterRecord[] = [];
let server: Server;
let url: string;

before(async () => {
  server = createSearchService({ keys, provider, meter: { append: (r) => void meter.push(r) } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/search`;
});
after(() => {
  server.close();
});

test("检索协议：{text_query} → {search_results}；法律站点组每组 ≤ 5 个扇出，合并后按 URL 去重、官方站点在前", async () => {
  for (const g of LEGAL_SITE_GROUPS) assert.ok(g.length <= 5);
  const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ text_query: "股东未实缴出资 补足责任" }) });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { search_results: { url: string }[] };
  const urls = j.search_results.map((x) => x.url);
  assert.equal(new Set(urls).size, urls.length, "去重");
  assert.ok(urls[0]!.includes("flk.npc.gov.cn"), "官方站点在前");
  assert.ok(urls.includes("https://example.org/mock"));
  const lastCalls = provider.calls.slice(-(LEGAL_SITE_GROUPS.length + 1));
  assert.equal(lastCalls.filter((c) => c.sites).length, LEGAL_SITE_GROUPS.length);
});

test("鉴权与输入：无席位令牌 401；空查询或超长 400；查询原文与事项编号都不进计量记录", async () => {
  assert.equal((await fetch(url, { method: "POST", body: JSON.stringify({ text_query: "x" }) })).status, 401);
  assert.equal((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ text_query: "" }) })).status, 400);
  assert.equal((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ text_query: "x".repeat(501) }) })).status, 400);
  const q = "某有限责任公司 违约金 调整 判例";
  await fetch(url, { method: "POST", headers: { authorization: `Bearer ${tok}`, "x-kwl-anon-matter": "anon-should-be-ignored" }, body: JSON.stringify({ text_query: q }) });
  const logged = JSON.stringify(meter);
  assert.ok(!logged.includes("违约金") && !logged.includes("anon-should-be-ignored"));
  assert.deepEqual(Object.keys(meter.at(-1)!).sort(), ["at", "latencyMs", "results", "sid", "status", "tid", "upstreamCalls"]);
});

test("S4-01 / S4-15：客户端断开即中止上游检索；被吊销的席位与设备一律 401", async () => {
  // 慢上游：观察中止信号
  let aborted = 0;
  const slow = {
    name: "slow",
    async search(_q: { query: string }, o: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5_000);
        o.signal.addEventListener("abort", () => {
          aborted += 1;
          clearTimeout(t);
          resolve();
        });
      });
      return [];
    },
  };
  const svc = createSearchService({ keys, provider: slow, meter: { append() {} }, revokedSeats: new Set(["s-revoked"]) });
  await new Promise<void>((r) => svc.listen(0, "127.0.0.1", () => r()));
  const u = `http://127.0.0.1:${(svc.address() as AddressInfo).port}/search`;
  try {
    const ac = new AbortController();
    const p = fetch(u, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ text_query: "股东出资" }), signal: ac.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await p;
    for (let i = 0; i < 40 && aborted === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(aborted >= 1, "上游检索收到中止信号");
    const revoked = issueSeatToken({ tid: "t1", uid: "u1", sid: "s-revoked", dev: "d1", kid: "k1" }, privateKey);
    const r = await fetch(u, { method: "POST", headers: { authorization: `Bearer ${revoked}`, "content-type": "application/json" }, body: JSON.stringify({ text_query: "x" }) });
    assert.equal(r.status, 401);
  } finally {
    svc.closeAllConnections();
    svc.close();
  }
});

test("月之暗面检索上游（2026-10-14 按官方文档核对）：text_query/limit/timeout_seconds，sites 与 time_window 对象走 search_pro，对账编号随机，Pro 正文片段折进摘要", async () => {
  const seen: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (u: string, init: RequestInit) => {
    seen.push({ url: u, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const pro = u.endsWith("/search_pro");
    return new Response(
      JSON.stringify({
        search_results: [
          { title: "最高法公报", url: "https://www.court.gov.cn/a", snippet: pro ? "" : "摘要", site_name: "最高人民法院", date: "2026-01-02", chunks: pro ? [{ text: "正文片段一", score: 0.9 }] : undefined },
          { title: "无链接", snippet: "丢弃" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const p = new MoonshotToolsSearchProvider({ apiKey: "sk-test", baseUrl: "https://api.moonshot.cn/v1/", fetchImpl, limit: 99, timeoutSeconds: 0 });
  const ac = new AbortController();
  const basic = await p.search({ query: "股东出资 补足责任" }, { signal: ac.signal });
  assert.equal(seen[0]!.url, "https://api.moonshot.cn/v1/tools/search");
  assert.deepEqual(seen[0]!.body, { text_query: "股东出资 补足责任", limit: 20, timeout_seconds: 1 });
  assert.match(seen[0]!.headers["x-msh-track-id"]!, /^kwl-[0-9a-f-]{36}$/);
  assert.deepEqual(basic, [{ title: "最高法公报", url: "https://www.court.gov.cn/a", snippet: "摘要", site_name: "最高人民法院", date: "2026-01-02" }]);
  const pro = await p.search({ query: "公司法 第五十条", sites: ["flk.npc.gov.cn", "bad site", "a(b)", "www.court.gov.cn", "x.cn", "y.cn", "z.cn"], timeWindow: { start: "2024-07", end: "2026" } }, { signal: ac.signal });
  assert.equal(seen[1]!.url, "https://api.moonshot.cn/v1/tools/search_pro");
  assert.deepEqual(seen[1]!.body.sites, ["flk.npc.gov.cn", "www.court.gov.cn", "x.cn", "y.cn", "z.cn"]);
  assert.deepEqual(seen[1]!.body.time_window, { start: "2024-07", end: "2026" });
  assert.equal(seen[1]!.body.query, undefined, "旧字段 query 不再发送");
  assert.equal(pro[0]!.snippet, "正文片段一");
  // 不合法的时间点不发送 time_window（无站点时回落到 Basic）
  await p.search({ query: "x", timeWindow: { start: "2024/07", end: "2026" } }, { signal: ac.signal });
  assert.equal(seen[2]!.url, "https://api.moonshot.cn/v1/tools/search");
  assert.equal(seen[2]!.body.time_window, undefined);
  assert.notEqual(seen[0]!.headers["x-msh-track-id"], seen[1]!.headers["x-msh-track-id"]);
});
