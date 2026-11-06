/**
 * 试用构建（偏离 D-160）：trial.json 的封装与解封、内核环境（白名单系统变量 + 回环网关 + 固定试用身份，不要求控制面、
 * 不下发严格传输、不叠加 release.json）、本机网关制品经进程消息起来并按席位令牌验签。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tm = require("../electron/trial-mode.cjs") as {
  sealTrialKey: (k: string, s: Buffer) => { iv: string; tag: string; ct: string };
  loadTrialConfig: (f: string, seal?: string | null) => null | { problems: string[]; config: null | { upstreamBase: string; model: string; expires: string | null; unseal: () => string } };
  trialExpired: (c: { expires: string | null }, now?: Date) => boolean;
  trialKernelEnv: (gw: { port: number; seatToken: string } | null) => Record<string, string>;
  TRIAL_TENANT: string;
};
const { kernelChildEnv } = require("../electron/release-config.cjs") as {
  kernelChildEnv: (o: Record<string, unknown>) => Record<string, string | undefined>;
};

const dir = mkdtempSync(join(tmpdir(), "kwl-trial-"));
const KEY = `sk-test-${randomBytes(12).toString("hex")}`;

test("trial.json：封装后文件里没有明文，解封密钥对才能还原；缺文件不是试用构建", () => {
  const seal = randomBytes(32);
  const f = join(dir, "trial.json");
  writeFileSync(f, JSON.stringify({ trial: true, upstream_base: "https://maas.example.com/v1/", model: "kimi-k3.1-pro", expires: "2026-12-31", sealed: tm.sealTrialKey(KEY, seal) }));
  assert.ok(!readFileSync(f, "utf8").includes(KEY));
  const r = tm.loadTrialConfig(f, seal.toString("base64"));
  assert.deepEqual(r?.problems, []);
  assert.equal(r?.config?.upstreamBase, "https://maas.example.com/v1");
  assert.equal(r?.config?.unseal(), KEY);
  assert.throws(() => tm.loadTrialConfig(f, randomBytes(32).toString("base64"))?.config?.unseal());
  assert.throws(() => tm.loadTrialConfig(f, null)?.config?.unseal(), /trial_seal_missing/);
  assert.equal(tm.loadTrialConfig(join(dir, "none.json")), null);
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ trial: true, upstream_base: "http://maas.example.com", model: "x y", sealed: {} }));
  assert.equal(tm.loadTrialConfig(join(dir, "bad.json"))?.config, null);
  assert.equal(tm.trialExpired({ expires: "2026-12-31" }, new Date(2026, 11, 31)), false);
  assert.equal(tm.trialExpired({ expires: "2026-12-31" }, new Date(2027, 0, 1)), true);
  assert.equal(tm.trialExpired({ expires: null }), false);
});

test("试用内核环境：回环网关与试用身份、不要求控制面、不下发严格传输，系统变量外的注入仍被剔除", () => {
  const paths = { dataDir: "/d", gateEntry: "/g", kapEntry: "/k" };
  const runtimeEnv = { ZR_EGRESS_GATE_ENTRY: "/rt/gate", ZR_KAP_HOST_ENTRY: "/rt/kap" };
  const evil = { PATH: "/bin", ZR_GATEWAY_BASE: "https://evil.example", NODE_OPTIONS: "--require x", ZR_MOONSHOT_API_KEY: "sk-evil" };
  const env = kernelChildEnv({
    packaged: true,
    isDev: false,
    processEnv: evil,
    release: { env: { ZR_SEARCH_BASE: "https://search.example" } },
    trialEnv: tm.trialKernelEnv({ port: 17999, seatToken: "zst1.x.y" }),
    paths,
    runtimeEnv,
  });
  assert.equal(env.ZR_GATEWAY_BASE, "http://127.0.0.1:17999/v1");
  assert.equal(env.ZR_SEAT_TOKEN, "zst1.x.y");
  assert.equal(env.ZR_FIRM_SLUG, "trial-firm");
  assert.equal(env.ZR_MODEL_PROVIDER, "upstream");
  assert.equal(env.ZR_AT_REST, "required");
  assert.equal(env.ZR_REQUIRE_CONTROL_PLANE, undefined);
  assert.equal(env.ZR_UPSTREAM_TLS, undefined);
  assert.equal(env.ZR_SEARCH_BASE, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.ZR_MOONSHOT_API_KEY, undefined);
  assert.equal(env.PATH, "/bin");
  // 网关没起来：不配置模型上游
  assert.equal(kernelChildEnv({ packaged: true, isDev: false, processEnv: {}, release: null, trialEnv: tm.trialKernelEnv(null), paths, runtimeEnv }).ZR_GATEWAY_BASE, undefined);
  // 非试用的安装包形态不变
  const formal = kernelChildEnv({ packaged: true, isDev: false, processEnv: evil, release: { env: {} }, paths, runtimeEnv });
  assert.equal(formal.ZR_REQUIRE_CONTROL_PLANE, "1");
  assert.equal(formal.ZR_UPSTREAM_TLS, "strict");
  assert.equal(formal.ZR_FIRM_SLUG, undefined);
});

test("本机试用网关：经进程消息拿到密钥，回环监听；席位令牌验签后转发上游并带上密钥，无令牌 401", async () => {
  const seen: { auth?: string; model?: unknown }[] = [];
  const upstream = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, model: JSON.parse(b).model });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", choices: [{ index: 0, message: { role: "assistant", content: "好" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;
  const child = fork(fileURLToPath(new URL("../electron/trial-gateway.mjs", import.meta.url)), [], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH } });
  try {
    const ready = await new Promise<{ type: string; port: number; seatToken: string }>((resolve, reject) => {
      child.on("message", (m) => resolve(m as { type: string; port: number; seatToken: string }));
      child.on("exit", (c) => reject(new Error(`网关退出 ${c}`)));
      child.send({
        type: "init",
        apiKey: KEY,
        upstreamBase: `http://127.0.0.1:${upPort}/v1`,
        model: "kimi-k3.1-pro",
        seatPrivateKeyPem: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
        tenant: tm.TRIAL_TENANT,
        meterFile: join(dir, "meter.jsonl"),
        port: 0,
      });
    });
    assert.equal(ready.type, "ready");
    const url = `http://127.0.0.1:${ready.port}/v1/chat/completions`;
    const body = JSON.stringify({ model: "legal/k3", messages: [{ role: "user", content: "你好" }] });
    const denied = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(denied.status, 401);
    const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ready.seatToken}`, "x-kwl-anon-matter": "am_test", "x-kwl-data-level": "L1" }, body });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(seen.at(-1)?.auth, `Bearer ${KEY}`);
    assert.equal(seen.at(-1)?.model, "kimi-k3.1-pro");
    assert.ok(!readFileSync(join(dir, "meter.jsonl"), "utf8").includes(KEY), "计量不含密钥");
  } finally {
    child.kill();
    upstream.close();
  }
});
