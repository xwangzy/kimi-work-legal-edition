/**
 * 第 52 批（第 50 批 IP 部署虚机演练后补）：证书被换时律师只看到“AI 服务暂时不可用”。
 * - 问答真实路径复现：模型经闸门 provider → 闸门钉住不符 502 → qaErrorMessage → qaFailureText，原来落到通用说法，现在说“证书校验未通过”；
 * - 任务（agentFailureText）、账号与激活（accountErrorText / controlPlaneErrorText）、界面时间线各自的映射；额度、登录等原有映射不变；
 * - 连接检测：内核拉起真实闸门进程，经 IPC 检测 127.0.0.1 上的本机 TLS 服务，正确的服务器得 ok、钉住不符得 tls_pin_mismatch，结论一句话。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttps, type Server as HttpsServer } from "node:https";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EgressGateServer, spkiPin, type AuthorizeResult, type GateAuthority, type GateUpstreams, type MatterEgressContext, type ProbeItem } from "@zr-legal/egress-gate";
import { createGateProvider } from "../../model-broker/src/providers/gate.ts";
import type { RouteDef } from "../../model-broker/src/config.ts";
import { qaErrorMessage, qaFailureText } from "../src/services/qa-chat.ts";
import { agentFailureText } from "../src/executor/executor.ts";
import { accountErrorText, accountFailure, controlPlaneErrorText } from "../src/account-session.ts";
import { CLOUD_BUILD_TEXT, CLOUD_CERT_TEXT, cloudFailureKind, cloudFailureText, diagnoseView, probeClassLabel } from "../src/services/cloud-connection.ts";
import { startEgressGate } from "../src/egress/gate-host.ts";
import { ipcPath } from "../../egress-gate/test/ipc-path.ts";

const fx = (n: string) => readFileSync(fileURLToPath(new URL(`../../egress-gate/test/fixtures/${n}`, import.meta.url)), "utf8");
const der = (pem: string) => Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
const DEMO_CA = fx("demo-ca.pem");
const LEAF_IP = fx("demo-leaf-ip.pem");
const LEAF_IP_PIN = spkiPin(der(LEAF_IP));
const SELF_PIN = spkiPin(der(fx("tls-test-cert.pem")));
const BACKUP_PIN = `sha256/${Buffer.alloc(32, 5).toString("base64")}`;
const strict = { allowLoopbackHttp: false, requirePins: true };

describe("失败说明映射（纯函数）", () => {
  test("证书类、安装包配置类、连不上、超时按代码分类；只认代码，不按中文猜", () => {
    for (const c of ["tls_pin_mismatch", "tls_verify_failed", "tls_name_mismatch", "cp_tls_pin_mismatch", "relay_tls_verify_failed", "x [kwl:tls_pin_mismatch]"]) assert.equal(cloudFailureKind(c), "cert", c);
    for (const c of ["upstream_tls_required", "upstream_pins_missing", "cp_upstream_pins_missing", "upstream_pins_malformed"]) assert.equal(cloudFailureKind(c), "build", c);
    for (const c of ["upstream_unreachable", "cp_unreachable", "search_upstream_unreachable", "gate_unavailable"]) assert.equal(cloudFailureKind(c), "unreachable", c);
    for (const c of ["first_byte_timeout", "cp_timeout"]) assert.equal(cloudFailureKind(c), "timeout", c);
    for (const c of ["quota_exhausted", "seat_unavailable", "upstream_unavailable", "queue_timeout", "证书校验未通过", null, ""]) assert.equal(cloudFailureKind(c), null, String(c));
    assert.equal(cloudFailureText("cp_tls_pin_mismatch"), CLOUD_CERT_TEXT);
    assert.equal(cloudFailureText("upstream_pins_missing"), CLOUD_BUILD_TEXT);
    assert.equal(cloudFailureText("cp_unreachable"), null);
    assert.match(CLOUD_CERT_TEXT, /^连接云端的证书校验未通过，已中断、未发出任何内容：请联系律所 IT 或管理员（设置 → 备份与安全 → 检测连接 可查看详情）$/);
  });

  test("问答：证书类与连不上分开；额度、登录、模型不可用的原有说法不变", () => {
    // 演练原样：闸门 502 → provider 说明“模型通道 502（…）”，代码在 detail.code（qaErrorMessage 补在末尾）
    const viaProvider = "模型通道 502（模型通道的证书校验未通过（可能存在网络拦截），请求已中断、未发出内容 [kwl:tls_pin_mismatch]；交编排层有界退避，不切换端点）";
    assert.equal(qaFailureText(viaProvider), CLOUD_CERT_TEXT);
    assert.equal(qaFailureText("模型通道 502（x） [kwl:tls_verify_failed]"), CLOUD_CERT_TEXT);
    assert.equal(qaFailureText("模型通道 503（x） [kwl:upstream_pins_missing]"), CLOUD_BUILD_TEXT);
    assert.match(qaFailureText("模型通道 502（模型通道不可达（已排队或稍后重试）；交编排层有界退避，不切换端点） [kwl:upstream_unreachable]"), /^连不上云端 AI 服务/);
    assert.doesNotMatch(qaFailureText("x [kwl:upstream_unreachable]"), /证书/);
    assert.match(qaFailureText("402 本所本期 AI 额度不足（预占失败） [kwl:quota_exhausted]"), /^本所 AI 额度暂时用到限制/);
    assert.match(qaFailureText("401 登录已失效，请重新登录 [kwl:seat_session_inactive]"), /^登录已失效或这台电脑暂时没有取得 AI 使用授权/);
    assert.equal(qaFailureText("x [kwl:upstream_unavailable]", "legal/k3"), "K3 这个模型暂不可用，这次没有取得回答：请稍后再问，或联系律所管理员");
    assert.equal(qaFailureText("模型通道错误 500：Internal Server Error"), "AI 服务暂时不可用，这次没有取得回答：请稍后再问");
  });

  test("任务：证书类不再说成“AI 服务暂时连不上”；连不上与额度的说法不变", () => {
    const cert = agentFailureText("host_reported_failure", "502 模型通道的证书校验未通过（可能存在网络拦截），请求已中断、未发出内容 [kwl:tls_pin_mismatch]");
    assert.match(cert, /^任务没有完成：连接云端的证书校验未通过/);
    assert.doesNotMatch(cert, /连不上/);
    assert.match(agentFailureText("host_reported_failure", "503 x [kwl:upstream_pins_missing]"), /安装包连接云端的加密设置不完整/);
    assert.match(agentFailureText("host_reported_failure", "502 模型通道不可达（已排队或稍后重试）"), /AI 服务暂时连不上/);
    assert.match(agentFailureText("host_reported_failure", "402 x [kwl:quota_exhausted]"), /本所本期 AI 额度已用完/);
  });

  test("账号、激活与控制面：证书类单独说；连不上、超时说“连不上中软服务”；其余照旧", () => {
    assert.equal(accountErrorText("cp_tls_pin_mismatch"), CLOUD_CERT_TEXT);
    assert.equal(accountErrorText("cp_upstream_pins_missing"), CLOUD_BUILD_TEXT);
    assert.equal(accountErrorText("cp_unreachable"), "连不上中软服务，请检查网络后重试");
    assert.equal(accountErrorText("cp_timeout"), "连不上中软服务，请检查网络后重试");
    assert.equal(accountErrorText("auth_invalid"), "邮箱或密码不正确");
    const f = accountFailure("cp_tls_verify_failed");
    assert.equal(f.status, 502);
    assert.equal(f.text, CLOUD_CERT_TEXT);
    assert.equal(controlPlaneErrorText("cp_tls_name_mismatch"), CLOUD_CERT_TEXT);
    assert.equal(controlPlaneErrorText("no_seat"), "你还没有席位：请律所管理员先分配席位");
  });

  test("连接检测结论：按证书 > 连不上 > 部分异常 > 正常排序；不出现全量钉住值", () => {
    const item = (upstream: ProbeItem["upstream"], cls: ProbeItem["class"], extra: Partial<ProbeItem> = {}): ProbeItem => ({ upstream, class: cls, host: "203.0.113.9", port: 443, elapsed_ms: 12, detail: null, pins: ["sha256/AAAAAAAAAAAA…"], cloud_ca: false, presented: [], ...extra });
    const nc = (u: ProbeItem["upstream"]) => item(u, "not_configured", { host: null, port: null });
    const ok = diagnoseView({ ok: true, items: [item("control_plane", "ok"), item("model", "ok"), nc("search")] });
    assert.equal(ok.tone, "ok");
    assert.match(ok.conclusion, /^连接正常/);
    const pin = diagnoseView({ ok: true, items: [item("control_plane", "ok"), item("model", "tls_pin_mismatch", { presented: ["sha256/BBBBBBBBBBBB…"] })] });
    assert.equal(pin.tone, "error");
    assert.match(pin.conclusion, /证书校验未通过（AI 服务）：服务器 203\.0\.113\.9:443 出示的证书公钥与安装包内置的不符/);
    assert.match(diagnoseView({ ok: true, items: [item("model", "tls_name_mismatch")] }).conclusion, /证书上没有这个地址——服务器地址可能变了/);
    assert.match(diagnoseView({ ok: true, items: [item("model", "tls_verify_failed")] }).conclusion, /测试证书或自签证书/);
    assert.match(diagnoseView({ ok: true, items: [item("model", "config_invalid", { detail: "upstream_pins_missing" })] }).conclusion, /安装包的连接配置不完整/);
    assert.match(diagnoseView({ ok: true, items: [item("model", "unreachable"), item("control_plane", "timeout")] }).conclusion, /^连不上云端：请检查网络、代理或防火墙是否放行 203\.0\.113\.9:443/);
    assert.match(diagnoseView({ ok: true, items: [item("model", "ok"), item("search", "http_503")] }).conclusion, /^部分服务不正常（联网检索：能连上，服务回应异常（HTTP 503））/);
    assert.equal(diagnoseView({ ok: false, reason: "gate_unavailable" }).gate, "unavailable");
    assert.equal(probeClassLabel("config_invalid", "upstream_tls_required"), "安装包的连接配置不完整（upstream_tls_required）");
  });
});

describe("真实路径：闸门 provider → 闸门钉住不符 → 问答说明", () => {
  let srv: HttpsServer;
  let hits = 0;
  let base = "";
  before(async () => {
    srv = createHttps({ cert: LEAF_IP, key: fx("demo-leaf-ip.key.pem") }, (req, res) => {
      hits++;
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    base = `https://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  });
  after(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
  });

  test("问答：证书换了私钥（同一 CA、同一 IP）——律师看到“连接云端的证书校验未通过”，服务端收不到请求", async () => {
    const ctx = {
      tenantId: "t1",
      matterId: "c1",
      runId: "r1",
      userId: "u1",
      anonMatterId: "anon-7f3a",
      dataLevel: "L1",
      basisComplete: true,
      modelEndpoint: "standard",
      preauth: { searchGeneralized: false, images: false },
      l3aStandardAllowed: false,
      fetchAllowlist: [],
      policyVersion: 1,
      qa: true,
      tokenizer: { keyB64: Buffer.alloc(32, 7).toString("base64"), parties: [], table: [], fullPseudonym: false, tableVersion: 1 },
    } as unknown as MatterEgressContext;
    const authority: GateAuthority = { authorize: async (): Promise<AuthorizeResult> => ({ ok: true, ctx }), record: () => {}, tokens: () => {} };
    const seat = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
    const sock = ipcPath(realpathSync(mkdtempSync(join(tmpdir(), "kwl-b50k-"))), "g.sock");
    const g = new EgressGateServer({ authority, upstreams: { model: { baseUrl: base, seatToken: seat, pins: [SELF_PIN, BACKUP_PIN] }, search: null, fetch: "disabled", tls: strict, cloudCaPem: DEMO_CA } });
    await g.listen(sock);
    try {
      const provider = createGateProvider({ socket: async () => sock, token: () => "gate-token" });
      const route: RouteDef = { alias: "legal/k3", provider: "upstream", providerModel: "kimi-k3", supportsEffort: false, defaultEffort: null, allowedEfforts: [], temperature: 1, priceKey: "k3" };
      const before = hits;
      const e = await provider
        .chatStream(route, { model: "legal/k3", messages: [{ role: "user", content: "合同解除的条件" }] }, { nonce: "n", clientIdempotencyId: "qa_1", task: { tid: "t1", uid: "u1", mid: "qa", rid: "c1" }, routePrefix: "/q/c1" } as any)
        .then(() => null, (x: unknown) => x);
      assert.ok(e, "应当失败");
      assert.equal((e as any).detail?.code, "tls_pin_mismatch");
      assert.equal(qaFailureText(qaErrorMessage(e), "legal/k3"), CLOUD_CERT_TEXT);
      assert.equal(hits, before, "握手阶段断开，服务端收不到请求");
    } finally {
      await g.close();
    }
  });
});

describe("连接检测：内核经 IPC 让真实闸门进程检测", () => {
  let srv: HttpsServer;
  let base = "";
  const paths: string[] = [];
  before(async () => {
    srv = createHttps({ cert: LEAF_IP, key: fx("demo-leaf-ip.key.pem") }, (req, res) => {
      paths.push(`${req.method} ${req.url} ${req.headers.authorization ? "auth" : "noauth"}`);
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    base = `https://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
  });

  test("正确的服务器 ok、钉住不符 tls_pin_mismatch；结论一句话；不带凭据、只 GET /healthz", { timeout: 60_000 }, async () => {
    const upstreams: GateUpstreams = {
      model: { baseUrl: `${base}/v1`, seatToken: "x.eyJleHAiOjF9.y", pins: [LEAF_IP_PIN, BACKUP_PIN] },
      search: null,
      fetch: "disabled",
      controlPlane: { baseUrl: base, pins: [LEAF_IP_PIN, BACKUP_PIN] },
      relay: { baseUrl: base, pins: [SELF_PIN, BACKUP_PIN] },
      tls: strict,
      cloudCaPem: DEMO_CA,
    };
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-b50p-")));
    const h = await startEgressGate({
      entryPath: fileURLToPath(new URL("../../egress-gate/src/main.ts", import.meta.url)),
      socketPath: ipcPath(dir, "gate.sock"),
      upstreams,
      authorize: () => ({ ok: false, status: 403, reason: "test" }),
      onRecord: () => {},
      onTokens: () => {},
    });
    try {
      const r = await h.probe();
      assert.ok(r.ok, JSON.stringify(r));
      const by = Object.fromEntries(r.items.map((x) => [x.upstream, x]));
      assert.equal(by.control_plane!.class, "ok");
      assert.equal(by.model!.class, "ok");
      assert.equal(by.relay!.class, "tls_pin_mismatch");
      assert.equal(by.search!.class, "not_configured");
      assert.ok(paths.length >= 2 && paths.every((p) => p === "GET /healthz noauth"), paths.join("|"));
      const v = diagnoseView(r);
      assert.equal(v.gate, "running");
      assert.equal(v.tone, "error");
      assert.match(v.conclusion, /证书校验未通过（同事之间同步）/);
      assert.ok(!JSON.stringify(v).includes(LEAF_IP_PIN) && !JSON.stringify(v).includes(SELF_PIN), "不出现全量钉住值");
      assert.equal(v.rows.find((x) => x.upstream === "control_plane")!.label, "正常");

      // 只有正确的服务器时结论为“连接正常”
      const ok = diagnoseView({ ok: true, items: r.items.filter((x) => x.upstream !== "relay") });
      assert.equal(ok.tone, "ok");
      assert.match(ok.conclusion, /^连接正常/);
    } finally {
      await h.close();
    }
  });
});
