/**
 * V12 出站代理配置：只认显式的 ZR_UPSTREAM_PROXY（不隐式沿用 HTTPS_PROXY），带口令、非 http(s)、写错的按未配置；
 * 模型、检索与控制面的目的地不因代理而变。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateUpstreamsFromEnv, upstreamProxyFromEnv } from "../src/egress/kernel-gate.ts";

test("ZR_UPSTREAM_PROXY：显式配置才生效，只留协议与主机端口；口令、非 http(s)、写错一律不用", () => {
  assert.equal(upstreamProxyFromEnv({ HTTPS_PROXY: "http://127.0.0.1:3128" }), null, "不隐式沿用 HTTPS_PROXY");
  assert.deepEqual(upstreamProxyFromEnv({ ZR_UPSTREAM_PROXY: "http://127.0.0.1:3128/" }), { url: "http://127.0.0.1:3128" });
  assert.equal(upstreamProxyFromEnv({ ZR_UPSTREAM_PROXY: "http://u:p@127.0.0.1:3128" }), null);
  assert.equal(upstreamProxyFromEnv({ ZR_UPSTREAM_PROXY: "socks5://127.0.0.1:1080" }), null);
  assert.equal(upstreamProxyFromEnv({ ZR_UPSTREAM_PROXY: "不是地址" }), null);
  const dir = mkdtempSync(join(tmpdir(), "kwl-proxy-ca-"));
  writeFileSync(join(dir, "ca.pem"), "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n");
  assert.equal(upstreamProxyFromEnv({ ZR_UPSTREAM_PROXY: "http://127.0.0.1:3128", ZR_UPSTREAM_PROXY_CA_FILE: join(dir, "ca.pem") })?.caPem?.startsWith("-----BEGIN"), true);
  assert.deepEqual(upstreamProxyFromEnv({ ZR_UPSTREAM_PROXY: "http://127.0.0.1:3128", ZR_UPSTREAM_PROXY_CA_FILE: join(dir, "无此文件.pem") }), { url: "http://127.0.0.1:3128" });
});

test("配了代理，自带密钥端点的地址与型号不变", () => {
  const u = gateUpstreamsFromEnv({ ZR_UPSTREAM_PROXY: "http://127.0.0.1:3128", ZR_BYOK_BASE: "https://maas.example.cn/v1", ZR_BYOK_API_KEY: "test-key-not-real", ZR_MODEL_K3: "kimi-k3.1-pro" });
  assert.equal(u.byok?.baseUrl, "https://maas.example.cn/v1");
  assert.equal(u.byok?.models["legal/k3"], "kimi-k3.1-pro");
  assert.deepEqual(u.proxy, { url: "http://127.0.0.1:3128" });
  assert.equal(gateUpstreamsFromEnv({}).proxy, null);
});
