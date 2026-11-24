/**
 * V19 第 44 批：网关动态路由（主文 §3）与逐请求计量（§4.1–4.2）。
 * 上游密钥封解；路由订阅验签、原子替换、取不到沿用、白名单；多上游切换（503 / 连接拒绝 / 429 → 下一个，记 attempts）；
 * 已写出字节后不切换；跨供应商不切换；熔断与半开放；全部 429 回 Retry-After；其他 4xx 不切换；非 2xx 体规范化；
 * 断开后读不到 usage 按已转发估算；tokens 与 cny 两种单位；价未配 503；暂停设备 401；健康回报与主动探测；
 * 上游密钥不出现在任何日志、记录、指标、快照、回报与错误里。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { sealEnvelope, type GatewayFeedView } from "@zr-legal/firm-trust";
import { createLegalGateway, DEFAULT_ROUTES, fileMeter, MapQuota, RoutingFeedSubscriber, routingKeyId, sealUpstreamKey, unsealUpstreamKey, UpstreamHealth, type GatewayFeed, type UsageRecord } from "../src/index.ts";

const KEY = "sk-KWLTEST-7f3a9c-DO-NOT-LEAK";
const LOCAL_KEY = "sk-KWLLOCAL-51e2b8-DO-NOT-LEAK";
const SECRET = "svc-secret-for-routing-test";

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
};

type Mode = "ok" | "503" | "429" | "400" | "cut" | "slow" | "leak401";
interface Up {
  name: string;
  url: string;
  mode: Mode;
  hits: number;
  probes: number;
  auths: string[];
  retryAfter: string;
  usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number } };
  server: Server;
}

async function upstream(name: string): Promise<Up> {
  const u = { name, mode: "ok" as Mode, hits: 0, probes: 0, auths: [] as string[], retryAfter: "5", usage: { prompt_tokens: 20, completion_tokens: 10 } } as Up;
  u.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    u.auths.push(String(req.headers.authorization ?? ""));
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      u.probes += 1;
      res.writeHead(u.mode === "503" ? 503 : 200, { "content-type": "application/json" });
      res.end('{"data":[]}');
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      u.hits += 1;
      const body = JSON.parse(raw) as { stream?: boolean; model?: string };
      if (u.mode === "503") return void (res.writeHead(503, { "content-type": "application/json" }), res.end('{"error":{"message":"overloaded"}}'));
      if (u.mode === "429") return void (res.writeHead(429, { "content-type": "application/json", "retry-after": u.retryAfter }), res.end('{"error":{"message":"rate limited"}}'));
      if (u.mode === "400") return void (res.writeHead(400, { "content-type": "application/json" }), res.end('{"error":{"message":"bad request"}}'));
      // new-api 的报错文字可能带令牌片段：网关不得透传
      if (u.mode === "leak401") return void (res.writeHead(401, { "content-type": "application/json" }), res.end(JSON.stringify({ error: { message: `无效的令牌 ${String(req.headers.authorization).slice(7)}` } })));
      const id = `up-${name}-${u.hits}`;
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "x-oneapi-request-id": `oneapi-${name}-${u.hits}` });
        const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (u.mode === "cut") {
          chunk({ id, choices: [{ index: 0, delta: { content: "前半段" } }] });
          setTimeout(() => res.destroy(), 30);
          return;
        }
        if (u.mode === "slow") {
          let i = 0;
          const t = setInterval(() => {
            if (res.destroyed || i >= 30) return clearInterval(t);
            chunk({ id, choices: [{ index: 0, delta: { content: "慢慢写来" } }] });
            i += 1;
          }, 60);
          return;
        }
        chunk({ id, model: body.model, choices: [{ index: 0, delta: { content: `来自 ${name}` } }] });
        chunk({ id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: u.usage });
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: `来自 ${name}` }, finish_reason: "stop" }], usage: u.usage }));
    });
  });
  u.url = `http://127.0.0.1:${await listen(u.server)}/v1`;
  return u;
}

describe("网关动态路由与逐请求计量", () => {
  const routingPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = routingPair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const cpSign = generateKeyPairSync("ed25519");
  const cpKey = { kid: "cp-test-1", privateKey: cpSign.privateKey };
  const cpKeys = new Map<string, KeyObject>([["cp-test-1", cpSign.publicKey]]);
  const seatKeys = devSeatKeyPair();
  const seat = (dev = "d1", tid = "t1") => issueSeatToken({ tid, uid: "u-routing", sid: `s-${tid}-${dev}`, dev, kid: "k1" }, seatKeys.privateKey);
  const ups: Record<string, Up> = {};
  let deadUrl = "";
  let feedBody: Record<string, unknown> = {};
  let feedMode: "ok" | "500" | "badsig" = "ok";
  let feedAuth = "";
  let feedServer: Server;
  let healthBodies: string[] = [];
  let cp = "";
  let sub: RoutingFeedSubscriber;
  const health = new UpstreamHealth({ breaker: true, openMs: 300 });
  const budgets = new Map<string, number>([["t1", 1_000_000_000]]);
  const cnyBudgets = new Map<string, number>([["tc", 1_000_000_000]]);
  const suspended = new Set<string>();
  let meterPath = "";
  let base = "";
  let cnyBase = "";
  const gws: Server[] = [];
  const responses: string[] = [];

  const prov = (id: string, url: string, o: { vendor?: string; enabled?: boolean; sealed?: unknown; local?: boolean; probe?: string | null } = {}) => ({
    id,
    label: `上游 ${id}`,
    vendor: o.vendor ?? "va",
    base_url: url,
    enabled: o.enabled ?? true,
    key_sealed: o.sealed === undefined ? sealUpstreamKey(KEY, id, spki) : o.sealed,
    key_hint: "…LEAK",
    use_local_key: o.local ?? false,
    max_concurrency: 8,
    header_timeout_ms: null,
    idle_timeout_ms: null,
    probe_requested_at: o.probe ?? null,
  });
  const model = (alias: string, targets: string[], o: { cross?: boolean; isDefault?: boolean } = {}) => ({
    alias,
    label: `模型 ${alias}`,
    enabled: true,
    is_default: o.isDefault ?? false,
    targets: targets.map((p, i) => ({ provider: p, model: `m-${p}`, priority: (i + 1) * 10 })),
    allow_cross_vendor: o.cross ?? false,
    default_max_tokens: 1000,
  });

  before(async () => {
    for (const n of ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "pk"]) ups[n] = await upstream(n);
    const dead = createServer();
    deadUrl = `http://127.0.0.1:${await listen(dead)}/v1`;
    dead.close();
    feedServer = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/feed/routing-health") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          healthBodies.push(raw);
          res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        });
        return;
      }
      feedAuth = String(req.headers.authorization ?? "");
      if (feedMode === "500") return void res.writeHead(500).end("{}");
      const key = feedMode === "badsig" ? { kid: "cp-test-1", privateKey: generateKeyPairSync("ed25519").privateKey } : cpKey;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(sealEnvelope("kwl-routing-feed", feedBody, key)));
    });
    cp = `http://127.0.0.1:${await listen(feedServer)}`;
    sub = new RoutingFeedSubscriber({
      url: `${cp}/v1/feed/routing`,
      serviceSecret: SECRET,
      keys: cpKeys,
      routingKey: routingPair.privateKey,
      allowHosts: ["127.0.0.1"],
      fallback: { baseUrl: ups.p8!.url, apiKey: LOCAL_KEY, routes: DEFAULT_ROUTES },
      allowHttp: true,
      minRefreshMs: 0,
    });
    meterPath = join(realpathSync(mkdtempSync(join(tmpdir(), "kwl-gw-rt-"))), "meter.jsonl");
    const feed: GatewayFeed = {
      ready: () => true,
      revokedDevice: () => false,
      revokedSeat: () => false,
      matter: () => null,
      l3aStandardAllowed: () => false,
      refresh: async () => {},
      suspendedDevice: (tid, dev) => suspended.has(`${tid}|${dev}`),
    } satisfies GatewayFeedView & { suspendedDevice(tid: string, dev: string): boolean };
    const common = { keys: new Map([["k1", seatKeys.publicKey]]), routing: sub, health, meter: fileMeter(meterPath), feed, tenantConcurrency: 16, drainMs: 250 };
    const gw = createLegalGateway({ ...common, quota: new MapQuota(budgets) });
    const gwc = createLegalGateway({ ...common, quota: new MapQuota(cnyBudgets, "cny") });
    base = `http://127.0.0.1:${await listen(gw)}`;
    cnyBase = `http://127.0.0.1:${await listen(gwc)}`;
    gws.push(gw, gwc);
  });
  after(() => {
    for (const g of gws) g.close();
    for (const u of Object.values(ups)) u.server.close();
    feedServer.close();
    sub.stop();
    health.stop();
  });

  const chat = async (alias: string, o: { stream?: boolean; token?: string; gw?: string } = {}) => {
    const r = await fetch(`${o.gw ?? base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${o.token ?? seat()}`, "x-kwl-anon-matter": "anon-rt", "x-kwl-data-level": "L2" },
      body: JSON.stringify({ model: alias, stream: o.stream ?? false, max_tokens: 100, messages: [{ role: "user", content: "路由测试" }] }),
    });
    const text = await r.text().catch(() => "<interrupted>");
    responses.push(text, JSON.stringify([...r.headers]));
    return { status: r.status, text, headers: r.headers };
  };
  const settles = (): { reason: string | null; record: UsageRecord; holder: unknown }[] =>
    readFileSync(meterPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((x) => x.kind === "settle");

  test("上游密钥封解：Node 封、Node 解；换 provider id（aad / HKDF info）、改密文、换密钥编号都解不开；编号 = 公钥 SHA-256 前 16 位", () => {
    const s = sealUpstreamKey(KEY, "maas-a", spki);
    assert.equal(s.alg, "ECDH-P256+HKDF-SHA256+A256GCM");
    assert.equal(Buffer.from(s.epk, "base64url").length, 65);
    assert.equal(Buffer.from(s.iv, "base64url").length, 12);
    assert.equal(Buffer.from(s.ct, "base64url").length, Buffer.byteLength(KEY) + 16);
    assert.equal(s.kid, routingKeyId(spki));
    assert.equal(s.kid, routingKeyId(routingPair.privateKey));
    assert.match(s.kid, /^[0-9a-f]{16}$/);
    assert.deepEqual(unsealUpstreamKey(s, "maas-a", routingPair.privateKey, s.kid), { ok: true, key: KEY });
    assert.equal(unsealUpstreamKey(s, "maas-b", routingPair.privateKey).ok, false, "换 provider id 解不开");
    const ct = Buffer.from(s.ct, "base64url");
    ct[0]! ^= 1;
    assert.equal(unsealUpstreamKey({ ...s, ct: ct.toString("base64url") }, "maas-a", routingPair.privateKey).ok, false, "改密文解不开");
    assert.deepEqual(unsealUpstreamKey(s, "maas-a", routingPair.privateKey, "0000000000000000"), { ok: false, reason: "kid_mismatch" });
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    assert.equal(unsealUpstreamKey(s, "maas-a", other.privateKey).ok, false, "别的私钥解不开");
    assert.equal(unsealUpstreamKey({ ...s, alg: "A128GCM" }, "maas-a", routingPair.privateKey).ok, false);
    const bad = unsealUpstreamKey(s, "maas-b", routingPair.privateKey);
    assert.ok(!JSON.stringify(bad).includes(KEY));
  });

  test("路由订阅：从未取到用本机兜底；验签通过才换表（整表原子替换）；验签不过、取不到、版本回退一律沿用；白名单外 blocked、解不开 key_unusable、use_local_key 用本机密钥", async () => {
    assert.equal(sub.current().source, "fallback");
    assert.deepEqual([...sub.current().models.keys()], ["legal/k3", "legal/k2.6"]);
    const fb = await chat("legal/k3");
    assert.equal(fb.status, 200);
    assert.match(fb.text, /来自 p8/, "兜底上游");
    assert.equal(ups.p8!.auths.at(-1), `Bearer ${LOCAL_KEY}`);
    feedBody = {
      version: 3,
      issued_at: new Date().toISOString(),
      providers: [
        prov("p1", ups.p1!.url),
        prov("p2", ups.p2!.url, { sealed: null, local: true }),
        prov("p3", ups.p3!.url, { vendor: "vb" }),
        prov("p4", ups.p4!.url),
        prov("p5", ups.p5!.url),
        prov("p6", ups.p6!.url),
        prov("p7", ups.p7!.url),
        prov("p0", deadUrl),
        prov("pk", ups.pk!.url),
        prov("blk", ups.p1!.url.replace("127.0.0.1", "localhost")),
        prov("wrong", ups.p1!.url, { sealed: sealUpstreamKey(KEY, "someone-else", spki) }),
        prov("off", ups.p1!.url, { enabled: false }),
        prov("nokey", ups.p1!.url, { sealed: null }),
      ],
      models: [
        model("legal/k3", ["p1", "p2"], { isDefault: true }),
        model("legal/k2.6", ["p2"]),
        model("legal/dead", ["p0", "p2"]),
        model("legal/cut", ["p3", "p2"]),
        model("legal/cv", ["p1", "p3"]),
        model("legal/cv2", ["p1", "p3"], { cross: true }),
        model("legal/solo", ["p4"]),
        model("legal/rl", ["p5", "p6"]),
        model("legal/bad", ["p7", "p2"]),
        model("legal/blk", ["blk"]),
        model("legal/leak", ["pk"]),
      ],
      prices: { version: 7, effective_at: new Date().toISOString(), items: { "legal/k3": { input: 4, cached_input: 1, output: 16, cost_input: 2, cost_cached_input: 0.5, cost_output: 8 } } },
    };
    await sub.refresh();
    assert.equal(feedAuth, `Bearer ${SECRET}`);
    const s1 = sub.current();
    assert.equal(s1.source, "feed");
    assert.equal(s1.version, 3);
    const st = (id: string) => s1.providers.get(id)?.state;
    assert.equal(st("p1"), "ok");
    assert.equal(st("p2"), "ok", "use_local_key：用本机密钥");
    assert.equal(st("blk"), "blocked_by_allowlist");
    assert.equal(st("wrong"), "key_unusable");
    assert.equal(st("nokey"), "key_unusable");
    assert.equal(st("off"), "disabled");
    assert.equal(s1.prices?.version, 7);
    assert.ok(!JSON.stringify([...s1.providers.values()]).includes(KEY), "快照里没有明文密钥");
    // 验签不过 / 取不到 / 版本回退：沿用
    const good = feedBody;
    feedMode = "badsig";
    feedBody = { ...good, version: 4, models: [] };
    await sub.refresh();
    assert.equal(sub.current(), s1);
    feedMode = "500";
    await sub.refresh();
    assert.equal(sub.current(), s1);
    feedMode = "ok";
    feedBody = { ...good, version: 2, models: [] };
    await sub.refresh();
    assert.equal(sub.current(), s1, "旧版本回放不能把流量改回去");
    assert.ok(sub.stats.rejected >= 2 && sub.stats.failed >= 1);
    feedBody = good;
    // 白名单外的上游：不用
    const blk = await chat("legal/blk");
    assert.equal(blk.status, 503);
    assert.equal(JSON.parse(blk.text).error.code, "upstream_unavailable");
    // /v1/models 按当前表
    const models = (await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${seat()}` } })).json()) as { data: { id: string; is_default: boolean }[] };
    assert.equal(models.data.find((m) => m.is_default)?.id, "legal/k3");
    assert.ok(models.data.some((m) => m.id === "legal/rl"));
  });

  test("切换：第一个 503 / 连接拒绝 / 429 → 第二个成功，记 attempts；其他 4xx 不切换", async () => {
    ups.p1!.mode = "503";
    const h2 = ups.p2!.hits;
    const r = await chat("legal/k3");
    assert.equal(r.status, 200);
    assert.match(r.text, /来自 p2/);
    const rec = settles().at(-1)!.record;
    assert.deepEqual(rec.attempts.map((a) => [a.provider, a.status, a.error]), [["p1", 503, "upstream_503"], ["p2", 200, null]]);
    assert.equal(rec.provider, "p2");
    assert.equal(rec.upstream_model, "m-p2");
    assert.equal(ups.p2!.hits, h2 + 1);
    assert.equal(ups.p2!.auths.at(-1), `Bearer ${LOCAL_KEY}`);
    // 连接拒绝
    const d = await chat("legal/dead", { stream: true });
    assert.equal(d.status, 200);
    assert.deepEqual(settles().at(-1)!.record.attempts.map((a) => [a.provider, a.error]), [["p0", "connect"], ["p2", null]]);
    assert.equal(settles().at(-1)!.record.upstream_request_id, `oneapi-p2-${ups.p2!.hits}`, "上游编号优先取 x-oneapi-request-id");
    // 429
    ups.p1!.mode = "429";
    const r2 = await chat("legal/k3");
    assert.equal(r2.status, 200);
    assert.deepEqual(settles().at(-1)!.record.attempts.map((a) => a.status), [429, 200]);
    ups.p1!.mode = "ok";
    // 400：不切换，规范化后回
    ups.p7!.mode = "400";
    const h = ups.p2!.hits;
    const b = await chat("legal/bad");
    assert.equal(b.status, 400);
    assert.deepEqual(JSON.parse(b.text), { error: { type: "kwl_gateway", code: "upstream_400", message: "模型服务返回 400" } });
    assert.ok(!b.text.includes("bad request"), "不透传上游原文");
    assert.equal(ups.p2!.hits, h, "4xx 不切换");
    assert.equal(settles().at(-1)!.record.charge_units, 0);
  });

  test("已给客户端写出字节后不切换：流到一半上游断开，客户端看到中断，第二个上游不被调用、不扣", async () => {
    ups.p3!.mode = "cut";
    const h = ups.p2!.hits;
    const r = await chat("legal/cut", { stream: true });
    assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(ups.p2!.hits, h);
    const rec = settles().at(-1)!.record;
    assert.equal(rec.attempts.length, 1);
    assert.equal(rec.outcome, "upstream_error");
    // 第 46 批（D-194）：已转发了部分内容——带估算 usage 与 partial（控制面只记成本），仍不扣律师额度
    assert.equal(rec.usage_source, "estimated");
    assert.equal(rec.partial, true);
    assert.equal(rec.charge_units, 0);
    ups.p3!.mode = "ok";
  });

  test("跨供应商：别名不允许时不切到另一供应商（503 规范化）；允许时切过去", async () => {
    ups.p1!.mode = "503";
    const h3 = ups.p3!.hits;
    const r = await chat("legal/cv");
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.text).error.code, "upstream_503");
    assert.equal(ups.p3!.hits, h3, "没有静默跨供应商");
    const r2 = await chat("legal/cv2");
    assert.equal(r2.status, 200);
    assert.match(r2.text, /来自 p3/);
    ups.p1!.mode = "ok";
  });

  test("熔断：连续 3 次失败即打开（不再发往该上游），30 秒（用例 300 毫秒）后半开放放 1 个，成功即关闭", async () => {
    ups.p4!.mode = "503";
    for (let i = 0; i < 3; i++) assert.equal((await chat("legal/solo")).status, 503);
    const hits = ups.p4!.hits;
    assert.equal(health.report(sub.current()).p4!.state, "down");
    const r = await chat("legal/solo");
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.text).error.code, "upstream_unavailable");
    assert.equal(ups.p4!.hits, hits, "熔断打开：不发往上游");
    await new Promise((res) => setTimeout(res, 350));
    ups.p4!.mode = "ok";
    assert.equal((await chat("legal/solo")).status, 200, "半开放放行一个");
    const rep = health.report(sub.current()).p4!;
    assert.equal(rep.state, "up");
    assert.equal(rep.consecutive_failures, 0);
    assert.ok(rep.last_ok_at);
  });

  test("全部 429：回 429 并带上游 Retry-After（取最短的）", async () => {
    ups.p5!.mode = "429";
    ups.p5!.retryAfter = "7";
    ups.p6!.mode = "429";
    ups.p6!.retryAfter = "3";
    const r = await chat("legal/rl");
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "3");
    assert.equal(JSON.parse(r.text).error.code, "upstream_429");
    assert.deepEqual(settles().at(-1)!.record.attempts.map((a) => a.status), [429, 429]);
    // 第 56 批（云端审计 6-A）：限流不计入熔断——连续 4 次 429 之后，这两个上游每次仍被尝试（没有被“熔断 30 秒”），限流一解除立即可用
    const before = [ups.p5!.hits, ups.p6!.hits];
    for (let i = 0; i < 4; i++) assert.equal((await chat("legal/rl")).status, 429);
    assert.deepEqual([ups.p5!.hits - before[0]!, ups.p6!.hits - before[1]!], [4, 4], "每次都真的发到了上游");
    assert.notEqual(health.report(sub.current()).p5!.state, "down", "限流不是“上游坏了”");
    ups.p5!.mode = "ok";
    ups.p6!.mode = "ok";
    assert.equal((await chat("legal/rl")).status, 200, "限流解除后立即可用（改前：熔断打开，30 秒内 503 upstream_unavailable）");
  });

  test("客户端断开后读不到 usage（读满时限）：按已转发的输出字符数 / 2 + 输入估算记 estimated；第 62 批起估算不当作实测、不扣额度（交控制面待对账）", async () => {
    ups.p1!.mode = "slow";
    const url = new URL(`${base}/v1/chat/completions`);
    await new Promise<void>((resolve, reject) => {
      const data = JSON.stringify({ model: "legal/k3", stream: true, max_tokens: 100, messages: [{ role: "user", content: "慢" }] });
      const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${seat()}`, "x-kwl-anon-matter": "anon-rt", "x-kwl-data-level": "L2", "content-length": Buffer.byteLength(data) } }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => {});
      req.end(data);
      setTimeout(() => reject(new Error("no first chunk")), 5_000);
    });
    let rec: UsageRecord | undefined;
    for (let i = 0; i < 80 && !(rec = settles().find((s) => s.record.outcome === "client_gone" && s.record.usage_source === "estimated")?.record); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(rec, "断开后照常结算");
    const input = Math.ceil(JSON.stringify({ messages: [{ role: "user", content: "慢" }] }).length / 2);
    assert.equal(rec.usage!.input, input);
    assert.equal(rec.usage!.output, Math.ceil("慢慢写来".length / 2), "只转发了第一块");
    assert.equal(rec.charge_units, 0, "估算不扣额度（第 62 批：缺真实 usage 时估算只作待对账）");
    ups.p1!.mode = "ok";
  });

  test("计量单位：cny 租户按路由订阅里的售价算微元（未缓存输入、缓存输入、输出分开）；未定价的别名 503 price_unconfigured 且不到达上游", async () => {
    ups.p1!.usage = { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } };
    const before = cnyBudgets.get("tc")!;
    const r = await chat("legal/k3", { gw: cnyBase, token: seat("d1", "tc") });
    assert.equal(r.status, 200);
    const rec = settles().at(-1)!.record;
    // (1000 − 200) × 4 + 200 × 1 + 500 × 16 = 11400 微元
    assert.equal(rec.charge_units, 11_400);
    assert.deepEqual(rec.usage, { input: 1000, cached: 200, output: 500, reasoning: 0 });
    assert.equal(cnyBudgets.get("tc"), before - 11_400);
    const n = ups.p2!.hits;
    const np = await chat("legal/k2.6", { gw: cnyBase, token: seat("d1", "tc") });
    assert.equal(np.status, 503);
    assert.equal(JSON.parse(np.text).error.code, "price_unconfigured");
    assert.equal(ups.p2!.hits, n);
    // 同一别名对 tokens 租户：输入 + 输出
    const t = await chat("legal/k3");
    assert.equal(t.status, 200);
    assert.equal(settles().at(-1)!.record.charge_units, 1500);
    ups.p1!.usage = { prompt_tokens: 20, completion_tokens: 10 };
  });

  test("账号闸：订阅里暂停的设备 401 seat_session_inactive（重新登录移出后恢复）", async () => {
    suspended.add("t1|d-out");
    const r = await chat("legal/k3", { token: seat("d-out") });
    assert.equal(r.status, 401);
    assert.equal(JSON.parse(r.text).error.code, "seat_session_inactive");
    suspended.delete("t1|d-out");
    assert.equal((await chat("legal/k3", { token: seat("d-out") })).status, 200);
  });

  test("健康回报与主动探测：探测带密钥 GET /models；probe_requested_at 更新即立即探；回报体只有状态与短代码", async () => {
    const p = ups.p2!.probes;
    await Promise.all(health.probeDue(sub.current(), 60_000));
    assert.ok(ups.p2!.probes > p, "到期即探测");
    assert.equal(ups.p1!.auths.filter((a) => a === `Bearer ${KEY}`).length > 0, true);
    const p2 = ups.p2!.probes;
    await Promise.all(health.probeDue(sub.current(), 60_000));
    assert.equal(ups.p2!.probes, p2, "未到期不探");
    feedBody = { ...feedBody, version: 5, providers: (feedBody.providers as ReturnType<typeof prov>[]).map((x) => (x.id === "p2" ? { ...x, probe_requested_at: new Date(Date.now() + 1000).toISOString() } : x)) };
    await sub.refresh();
    await Promise.all(health.probeDue(sub.current(), 60_000));
    assert.equal(ups.p2!.probes, p2 + 1, "运营点了测试连接：立即探");
    healthBodies = [];
    assert.equal(await health.reportOnce({ url: `${cp}/v1/feed/routing-health`, serviceSecret: SECRET, holder: "gw-test-1-abcdef", view: sub }), true);
    const rep = JSON.parse(healthBodies[0]!) as { holder: string; providers: Record<string, { state: string }> };
    assert.equal(rep.holder, "gw-test-1-abcdef");
    assert.equal(rep.providers.blk!.state, "blocked_by_allowlist");
    assert.equal(rep.providers.wrong!.state, "key_unusable");
    assert.equal(rep.providers.off!.state, "disabled");
    assert.equal(rep.providers.p2!.state, "up");
  });

  test("上游密钥不出现在任何日志、记录、指标、快照、回报与错误里（上游 401 报错带令牌片段也不透传）", async () => {
    ups.pk!.mode = "leak401";
    const r = await chat("legal/leak");
    assert.equal(r.status, 401);
    assert.equal(JSON.parse(r.text).error.code, "upstream_401");
    const everything = [readFileSync(meterPath, "utf8"), ...responses, ...healthBodies, JSON.stringify(health.report(sub.current())), JSON.stringify(sub.stats), JSON.stringify((gws[0] as unknown as { metrics(): unknown }).metrics()), JSON.stringify([...sub.current().providers.values()])].join("\n");
    for (const k of [KEY, LOCAL_KEY, KEY.slice(3, 20), LOCAL_KEY.slice(3, 20)]) assert.ok(!everything.includes(k), `出现了密钥片段 ${k.slice(0, 6)}…`);
    assert.ok(ups.pk!.auths.includes(`Bearer ${KEY}`), "密钥确实用在了上游请求头里");
  });
});
