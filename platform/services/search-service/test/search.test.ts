/**
 * 检索服务 v0（第 04 篇 §5.3、§11 P4；第 02 篇 §12）：协议适配、法律站点组扇出（每组 ≤ 5）与去重、席位鉴权、不接收事项编号、查询原文不落盘。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createSearchService, LEGAL_SITE_GROUPS, MockSearchProvider, type SearchMeterRecord } from "../src/index.ts";

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
