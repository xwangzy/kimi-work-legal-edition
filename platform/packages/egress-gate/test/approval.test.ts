/**
 * W1 批准凭据在闸门的独立核验（v9 第 02 篇 §9.5“批准绑定主体、事项、动作、参数 hash、目的地、期限与 nonce；执行前重验”，
 * §9.2“每处独立强制，不相信别处的已批准”；收敛偏离 D-16；复核 S5-B01/B02/B05/B12）：
 * - 抓取新域名：没有凭据即拒绝且不连接；“本次”凭据只放行这一个 URL（跳转到同一主机的其他页面也须另行确认）；“本任务内”放行该主机、跳转到其他主机仍拒绝；
 * - 图像原样送模型：凭据须带已签名绑定的载荷摘要；未绑定、绑定别的图像、外链图像、敏感事项一律拒绝；
 * - 检索：含当事人须确认；“本任务内”只接受改写后放行；L3a 只接受“本次”；
 * - 签名、设备、批准人、渠道、运行、用途、目的地、期限、策略版本任一不符即拒绝；同一张“本次”凭据闸门只放行一次（失败关闭）。
 * 全部在本机：抓取目标是回环上的测试站点（测试钩子把域名解析到 127.0.0.1），检索与模型上游是回环替身，不接触任何真实外部主机。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressGateServer } from "../src/server.ts";
import { canonicalCredential, egressDigest, type ApprovalCredential, type SignedApproval } from "../src/approval.ts";
import { isPublicAddress } from "../src/url-guard.ts";
import type { AuthorizeResult, GateAuthority, GateEgressRecord, MatterEgressContext } from "../src/types.ts";

const KEY = Buffer.alloc(32, 9).toString("base64");
const devA = generateKeyPairSync("ed25519");
const devB = generateKeyPairSync("ed25519");

function ctx(o: Partial<MatterEgressContext> = {}): MatterEgressContext {
  return {
    tenantId: "t1",
    matterId: "m1",
    runId: "r1",
    userId: "u1",
    anonMatterId: "anon-1",
    dataLevel: "L2",
    basisComplete: true,
    modelEndpoint: "standard",
    preauth: { searchGeneralized: false, images: false },
    l3aStandardAllowed: false,
    fetchAllowlist: ["npc.gov.cn"],
    policyVersion: 1,
    approvalPolicy: "pol-1",
    tokenizer: { keyB64: KEY, parties: [{ name: "孙悦", kind: "person" }, { name: "甲科技有限公司", kind: "org" }], table: [], fullPseudonym: false, tableVersion: 1 },
    ...o,
  };
}

let nonceSeq = 0;
function cred(o: Partial<ApprovalCredential>): ApprovalCredential {
  nonceSeq += 1;
  return {
    v: 1,
    approval_id: `apv_test_${nonceSeq}`,
    tid: "t1",
    uid: "u1",
    mid: "m1",
    rid: "r1",
    dev: "dev_a",
    channel: "desktop",
    purpose: "fetch",
    digest: null,
    dest: "new.example",
    variant: null,
    scope: "once",
    nonce: `nonce-${nonceSeq}`,
    exp: new Date(Date.now() + 60_000).toISOString(),
    pol: "pol-1",
    ...o,
  };
}

function signed(c: ApprovalCredential, key: KeyObject = devA.privateKey): SignedApproval {
  return { credential: c, signature: cryptoSign(null, Buffer.from(canonicalCredential(c), "utf8"), key).toString("base64url") };
}

class FakeAuthority implements GateAuthority {
  current: MatterEgressContext = ctx();
  /** 内核按（运行、用途、摘要、目的地）取凭据：测试直接给出要返回的凭据，闸门须独立核验。 */
  next: SignedApproval | null = null;
  readonly asked: { purpose: string; digest: string; dest: string }[] = [];
  readonly records: GateEgressRecord[] = [];
  async authorize(req: { token: string; matterId: string }): Promise<AuthorizeResult> {
    if (req.token !== "task-token-ok") return { ok: false, status: 401, reason: "token_invalid" };
    return { ok: true, ctx: { ...this.current } };
  }
  async approval(req: { token: string; matterId: string; purpose: "search" | "fetch" | "media"; digest: string; dest: string }): Promise<SignedApproval | null> {
    this.asked.push({ purpose: req.purpose, digest: req.digest, dest: req.dest });
    return this.next;
  }
  record(rec: GateEgressRecord): void {
    this.records.push(rec);
  }
  tokens(): void {}
}

function call(socket: string, path: string, body: unknown): Promise<{ status: number; text: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ socketPath: socket, path, method: "POST", headers: { "content-type": "application/json", authorization: "Bearer task-token-ok", "content-length": Buffer.byteLength(data) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

describe("闸门独立核验批准凭据（W1）", () => {
  let dir: string;
  let socket: string;
  let gate: EgressGateServer;
  let authority: FakeAuthority;
  let site: Server;
  let sitePort = 0;
  const siteHits: string[] = [];
  let model: Server;
  const modelBodies: string[] = [];
  let search: Server;
  const searchBodies: string[] = [];

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-gate-apv-")));
    socket = join(dir, "gate.sock");
    authority = new FakeAuthority();
    site = createServer((req, res) => {
      siteHits.push(`${req.headers.host}${req.url}`);
      if (req.url === "/jump") {
        res.writeHead(302, { location: `http://other.example:${sitePort}/x` });
        res.end();
        return;
      }
      if (req.url === "/jump-same") {
        res.writeHead(302, { location: `http://new.example:${sitePort}/elsewhere` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body><p>公开页面：股东出资期限的规定。</p></body></html>");
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    sitePort = (site.address() as AddressInfo).port;
    model = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        modelBodies.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "已看图。" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => model.listen(0, "127.0.0.1", () => r()));
    search = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        searchBodies.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ search_results: [] }));
      });
    });
    await new Promise<void>((r) => search.listen(0, "127.0.0.1", () => r()));
    gate = new EgressGateServer({
      authority,
      upstreams: {
        model: { baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`, seatToken: "seat" },
        search: { baseUrl: `http://127.0.0.1:${(search.address() as AddressInfo).port}/search`, seatToken: "seat" },
        fetch: "local",
      },
      // 测试钩子：任何域名都解析到回环上的测试站点（不接触真实外部主机）
      fetchOptions: { allowedPorts: [sitePort], resolver: async () => [{ address: "127.0.0.1", family: 4 as const }], addressPolicy: (ip) => ip === "127.0.0.1" || isPublicAddress(ip) },
      approvalKeys: { dev_a: devA.publicKey.export({ type: "spki", format: "pem" }).toString() },
    });
    await gate.listen(socket);
  });

  after(async () => {
    await gate.close();
    site.close();
    model.close();
    search.close();
  });

  const url = (host: string, path = "/page") => `http://${host}:${sitePort}${path}`;

  test("抓取新域名：没有凭据即拒绝且不连接；“本次”凭据只放行这个 URL；签名、设备、批准人、渠道、运行、目的地、期限、策略版本任一不符即拒绝；同一张“本次”凭据只放行一次", async () => {
    authority.current = ctx();
    const target = url("new.example");
    const digest = egressDigest("FetchURL", target);

    authority.next = null;
    let r = await call(socket, "/m/m1/fetch", { url: target });
    assert.equal(r.status, 403);
    assert.match(r.text, /fetch_domain_not_allowlisted/);
    assert.equal(siteHits.length, 0, "未经批准不得连接");
    assert.deepEqual(authority.asked.at(-1), { purpose: "fetch", digest, dest: "new.example" }, "闸门按实际 URL 摘要与首跳主机向内核取凭据");

    const bad: [string, SignedApproval][] = [
      ["别的 URL 的“本次”凭据", signed(cred({ digest: egressDigest("FetchURL", url("new.example", "/other")) }))],
      ["别的主机", signed(cred({ digest, dest: "evil.example" }))],
      ["别的运行", signed(cred({ digest, rid: "r2" }))],
      ["别的事项", signed(cred({ digest, mid: "m2" }))],
      ["别的租户", signed(cred({ digest, tid: "t2" }))],
      ["批准人不是发起人", signed(cred({ digest, uid: "u2" }))],
      ["不受理的渠道", signed(cred({ digest, channel: "mobile" }))],
      ["审批策略已变化（密级、依据、端点等）", signed(cred({ digest, pol: "pol-0" }))],
      ["用途不符（检索凭据）", signed(cred({ digest, purpose: "search" }))],
      ["已过期", signed(cred({ digest, exp: new Date(Date.now() - 1000).toISOString() }))],
      ["签名不是该设备的密钥", signed(cred({ digest }), devB.privateKey)],
      ["未登记的设备", signed(cred({ digest, dev: "dev_x" }))],
      ["签名后改了字段", { ...signed(cred({ digest, dest: "evil.example" })), credential: cred({ digest }) }],
    ];
    for (const [label, s] of bad) {
      authority.next = s;
      r = await call(socket, "/m/m1/fetch", { url: target });
      assert.equal(r.status, 403, label);
      assert.equal(siteHits.length, 0, `${label}：不得连接`);
    }

    const once = signed(cred({ digest, approval_id: "apv_once" }));
    authority.next = once;
    r = await call(socket, "/m/m1/fetch", { url: target });
    assert.equal(r.status, 200, r.text);
    assert.match(r.text, /不可信外部内容/);
    assert.equal(siteHits.length, 1);
    const rec = authority.records.at(-1)!;
    assert.equal(rec.outcome, "sent");
    assert.equal(rec.approvalId, "apv_once", "去向记录写明所依据的批准");
    // 同一张“本次”凭据再次出示（例如内核侧被重放）：闸门自己记账，拒绝
    r = await call(socket, "/m/m1/fetch", { url: target });
    assert.equal(r.status, 403, "“本次”凭据只放行一次");
    assert.equal(siteHits.length, 1);
  });

  test("抓取新域名：“本任务内”凭据放行该主机的其他页面，跳转到未经批准的主机仍拒绝；“本次”凭据下同一主机的跳转也须另行确认", async () => {
    authority.current = ctx({ runId: "r1" });
    const before = siteHits.length;
    authority.next = signed(cred({ scope: "task", digest: null, approval_id: "apv_task" }));
    let r = await call(socket, "/m/m1/fetch", { url: url("new.example", "/a") });
    assert.equal(r.status, 200, r.text);
    r = await call(socket, "/m/m1/fetch", { url: url("new.example", "/b") });
    assert.equal(r.status, 200);
    assert.equal(siteHits.length, before + 2);
    r = await call(socket, "/m/m1/fetch", { url: url("new.example", "/jump") });
    assert.equal(r.status, 403);
    assert.match(r.text, /redirect_domain_not_allowlisted/);
    assert.equal(siteHits.length, before + 3, "跳转目标未连接");
    // “本任务内”凭据带了摘要 = 形态不符
    authority.next = signed(cred({ scope: "task", digest: egressDigest("FetchURL", url("new.example", "/a")) }));
    r = await call(socket, "/m/m1/fetch", { url: url("new.example", "/a") });
    assert.equal(r.status, 403);
    // “本次” = 这个 URL：跳到同一主机的其他页面，不连接跳转目标
    const jump = url("new.example", "/jump-same");
    authority.next = signed(cred({ digest: egressDigest("FetchURL", jump) }));
    const hits0 = siteHits.length;
    r = await call(socket, "/m/m1/fetch", { url: jump });
    assert.equal(r.status, 403, r.text);
    assert.match(r.text, /redirect_domain_not_allowlisted/);
    assert.equal(siteHits.length, hits0 + 1, "只连接了批准的那个 URL，跳转目标没有连接");
  });

  test("图像原样送模型：凭据须带已签名绑定的载荷摘要；未绑定、绑定别的图像、“本任务内”、目的地不符、外链图像、敏感事项一律拒绝", async () => {
    authority.current = ctx();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const digest = createHash("sha256").update(png).digest("hex");
    const body = (u: string) => ({ model: "kimi-k3", messages: [{ role: "user", content: [{ type: "text", text: "请看这张收据" }, { type: "image_url", image_url: { url: u } }] }] });

    authority.next = null;
    let r = await call(socket, "/m/m1/v1/chat/completions", body(dataUrl));
    assert.equal(r.status, 403);
    assert.match(r.text, /media_requires_confirmation/);
    assert.equal(modelBodies.length, 0, "未经批准不得发给模型");
    assert.deepEqual(authority.asked.at(-1), { purpose: "media", digest, dest: "model" }, "按解码后字节的摘要取凭据");

    for (const [label, s] of [
      ["绑定的是别的图像", signed(cred({ purpose: "media", dest: "model", digest: "0".repeat(64) }))],
      ["没有绑定任何图像", signed(cred({ purpose: "media", dest: "model", digest: null }))],
      ["“本任务内”的图像凭据", signed(cred({ purpose: "media", dest: "model", scope: "task", digest }))],
      ["目的地不是模型", signed(cred({ purpose: "media", dest: "search_service", digest }))],
      ["绑定值不在签名内（签名后改摘要）", { ...signed(cred({ purpose: "media", dest: "model", digest: "1".repeat(64) })), credential: cred({ purpose: "media", dest: "model", digest }) }],
    ] as [string, SignedApproval][]) {
      authority.next = s;
      r = await call(socket, "/m/m1/v1/chat/completions", body(dataUrl));
      assert.equal(r.status, 403, label);
    }
    assert.equal(modelBodies.length, 0);

    authority.next = signed(cred({ purpose: "media", dest: "model", approval_id: "apv_img", digest }));
    r = await call(socket, "/m/m1/v1/chat/completions", body(dataUrl));
    assert.equal(r.status, 200, r.text);
    assert.equal(modelBodies.length, 1);
    assert.ok(modelBodies[0]!.includes(png.toString("base64")), "批准后图像按原样送达");
    assert.equal(authority.records.at(-1)!.approvalId, "apv_img");
    // 同一运行重发同一张图片：同一张已绑定凭据可再次放行（图像不按“本次”一次性记账）
    r = await call(socket, "/m/m1/v1/chat/completions", body(dataUrl));
    assert.equal(r.status, 200, "绑定的同一图像本运行内可重发");

    // 外部链接图像：没有内联数据，不能绑定摘要
    r = await call(socket, "/m/m1/v1/chat/completions", body("https://img.example/x.png"));
    assert.equal(r.status, 403);
    // 敏感事项：不受理图像原样送模型（不论凭据）
    authority.current = ctx({ dataLevel: "L3a", l3aStandardAllowed: true, tokenizer: { keyB64: KEY, parties: [], table: [], fullPseudonym: true, tableVersion: 1 } });
    r = await call(socket, "/m/m1/v1/chat/completions", body(dataUrl));
    assert.equal(r.status, 403);
    assert.match(r.text, /l3_media_forbidden/);
    assert.equal(modelBodies.length, 2);
  });

  test("检索：含当事人须确认；“本次”可按原文（只保留机构名称）发出；“本任务内”只接受改写后放行；L3a 只接受“本次”（复核 S5-B01/B02）", async () => {
    authority.current = ctx({ runId: "r-search" });
    const q = "甲科技有限公司 孙悦 股东未实缴出资";
    const digest = egressDigest("WebSearch", q);
    const sent = () => (JSON.parse(searchBodies.at(-1) ?? "{}") as { text_query?: string }).text_query ?? "";

    authority.next = null;
    let r = await call(socket, "/m/m1/search", { text_query: q });
    assert.equal(r.status, 403);
    assert.match(r.text, /search_entity_requires_confirmation/);
    const n0 = searchBodies.length;

    // “本任务内” + 原文：签名有效也拒绝（任务级授权只有“本任务泛化后放行”）
    authority.next = signed(cred({ purpose: "search", dest: "search_service", scope: "task", digest: null, variant: "original", rid: "r-search" }));
    r = await call(socket, "/m/m1/search", { text_query: q });
    assert.equal(r.status, 403, "task + original 不受理");
    assert.equal(searchBodies.length, n0);

    // “本任务内” + 改写后：放行改写后的一般性查询
    authority.next = signed(cred({ purpose: "search", dest: "search_service", scope: "task", digest: null, variant: "generalized", rid: "r-search" }));
    r = await call(socket, "/m/m1/search", { text_query: q });
    assert.equal(r.status, 200, r.text);
    assert.ok(!sent().includes("甲科技") && !sent().includes("孙悦"), sent());

    // “本次” + 原文：机构名称保留、自然人改为“某人”
    authority.next = signed(cred({ purpose: "search", dest: "search_service", digest, variant: "original", rid: "r-search" }));
    r = await call(socket, "/m/m1/search", { text_query: q });
    assert.equal(r.status, 200, r.text);
    assert.ok(sent().includes("甲科技有限公司") && !sent().includes("孙悦"), sent());

    // L3a：只接受“本次”，且只按改写后发出
    authority.current = ctx({ runId: "r-l3a", dataLevel: "L3a", l3aStandardAllowed: true, tokenizer: { keyB64: KEY, parties: [{ name: "孙悦", kind: "person" }, { name: "甲科技有限公司", kind: "org" }], table: [], fullPseudonym: true, tableVersion: 1 } });
    authority.next = signed(cred({ purpose: "search", dest: "search_service", scope: "task", digest: null, variant: "generalized", rid: "r-l3a" }));
    const n1 = searchBodies.length;
    r = await call(socket, "/m/m1/search", { text_query: q });
    assert.equal(r.status, 403, "L3a 不受理“本任务内”");
    assert.equal(searchBodies.length, n1);
    authority.next = signed(cred({ purpose: "search", dest: "search_service", digest, variant: "original", rid: "r-l3a" }));
    r = await call(socket, "/m/m1/search", { text_query: q });
    assert.equal(r.status, 200, r.text);
    assert.ok(!sent().includes("甲科技") && !sent().includes("孙悦"), `L3a 原文凭据也只按改写后发出：${sent()}`);
  });
});
