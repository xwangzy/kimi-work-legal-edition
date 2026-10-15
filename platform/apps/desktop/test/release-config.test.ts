/**
 * 安装包内置上游（审计 S5）：release.json 只接受 https + 至少两把钉住值；安装包形态剔除环境变量里的上游配置、强制严格传输与真实上游。
 */
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { loadReleaseConfig, packagedKernelEnv, kernelChildEnv } = require("../electron/release-config.cjs") as {
  loadReleaseConfig: (file: string) => { env: Record<string, string>; problems: string[] };
  packagedKernelEnv: (env: Record<string, string | undefined>, r: { env: Record<string, string> }) => Record<string, string | undefined>;
  kernelChildEnv: (o: {
    packaged: boolean;
    isDev: boolean;
    processEnv: Record<string, string | undefined>;
    release: { env: Record<string, string> } | null;
    paths: { dataDir: string; gateEntry: string; kapEntry: string };
    runtimeEnv?: Record<string, string>;
  }) => Record<string, string | undefined>;
};

const P1 = `sha256/${Buffer.alloc(32, 1).toString("base64")}`;
const P2 = `sha256/${Buffer.alloc(32, 2).toString("base64")}`;
const dir = mkdtempSync(join(tmpdir(), "kwl-release-"));
const write = (name: string, v: unknown) => {
  const f = join(dir, name);
  writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
  return f;
};

const edPem = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const CP_KEYS = { "cp-1": edPem(), "cp-2": edPem() };
const SEAT_KEYS = { "seat-1": edPem() };

test("合法配置：地址与钉住集进入内核环境；控制面签名公钥表与席位公钥表随控制面一同进入", () => {
  const r = loadReleaseConfig(write("ok.json", { gateway_base: "https://gw.example.cn/v1/", gateway_pins: [P1, P2], control_plane_base: "https://cp.example.cn", control_plane_pins: [P2, P1], control_plane_keys: CP_KEYS, seat_keys: SEAT_KEYS }));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(JSON.parse(r.env.ZR_CONTROL_PLANE_KEYS!), CP_KEYS);
  assert.deepEqual(JSON.parse(r.env.ZR_SEAT_KEYS!), SEAT_KEYS);
  assert.equal(r.env.ZR_GATEWAY_BASE, "https://gw.example.cn/v1");
  assert.equal(r.env.ZR_GATEWAY_PINS, `${P1},${P2}`);
  assert.equal(r.env.ZR_CONTROL_PLANE_BASE, "https://cp.example.cn");
  assert.equal(r.env.ZR_SEARCH_BASE, undefined);
});

test("控制面缺公钥表、公钥不是 Ed25519 或 kid 不合法：整组控制面配置不生效并报告（云端持久化与 KMS 设计 v1：安装包曾因公钥表为空而拒收一切控制面文档）", () => {
  const base = { control_plane_base: "https://cp.example.cn", control_plane_pins: [P1, P2] };
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const edPriv = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  for (const extra of [{}, { control_plane_keys: CP_KEYS }, { control_plane_keys: { "cp-1": edPriv, "cp-2": edPem() }, seat_keys: SEAT_KEYS }, { control_plane_keys: { "cp-1": rsa, "cp-2": edPem() }, seat_keys: SEAT_KEYS }, { control_plane_keys: { "bad kid": edPem(), "cp-2": edPem() }, seat_keys: SEAT_KEYS }, { control_plane_keys: { "cp-1": edPem() }, seat_keys: SEAT_KEYS }, { control_plane_keys: {}, seat_keys: SEAT_KEYS }]) {
    const r = loadReleaseConfig(write("cpk.json", { ...base, ...extra }));
    assert.equal(r.problems.length, 1, JSON.stringify(Object.keys(extra)));
    assert.equal(r.env.ZR_CONTROL_PLANE_BASE, undefined);
    assert.equal(r.env.ZR_CONTROL_PLANE_KEYS, undefined);
  }
});

test("不合法：http 地址、只有一把钉住、钉住形态错误都不进入环境", () => {
  const r = loadReleaseConfig(write("bad.json", {
    gateway_base: "http://gw.example.cn/v1",
    gateway_pins: [P1, P2],
    search_base: "https://s.example.cn",
    search_pins: [P1],
    control_plane_base: "https://cp.example.cn",
    control_plane_pins: [P1, "sha256/short"],
  }));
  assert.equal(r.problems.length, 3);
  assert.deepEqual(r.env, {});
  assert.deepEqual(loadReleaseConfig(join(dir, "missing.json")), { env: {}, problems: [], update: null });
  assert.deepEqual(loadReleaseConfig(write("garbage.json", "{")).problems, ["release.json 无法解析"]);
});

test("安装包形态：环境变量里的上游、席位令牌、自带密钥与模拟提供方一律剔除；强制严格传输与真实上游", () => {
  const env = packagedKernelEnv(
    {
      PATH: "/bin",
      Path: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      NODE_OPTIONS: "--require C:\\evil.js",
      NODE_PATH: "C:\\evil",
      ELECTRON_RUN_AS_NODE: "1",
      HTTPS_PROXY: "http://proxy.evil:8080",
      NODE_EXTRA_CA_CERTS: "C:\\evil-ca.pem",
      ZR_AGENT_HOST_ENTRY: "C:\\evil-host.mjs",
      KWL_MOCK_SCRIPT: "x",
      ZR_KERNEL_DATA_DIR: "/data",
      ZR_GATEWAY_BASE: "http://evil.example/v1",
      ZR_GATEWAY_PINS: "",
      ZR_SEAT_TOKEN: "x",
      ZR_BYOK_API_KEY: "k",
      ZR_PRIVATE_BASE: "http://10.0.0.1",
      ZR_UPSTREAM_TLS: "lax",
      ZR_MODEL_PROVIDER: "mock",
      ZR_CONTROL_PLANE_BASE: "http://evil-cp",
    },
    { env: { ZR_GATEWAY_BASE: "https://gw.example.cn/v1", ZR_GATEWAY_PINS: `${P1},${P2}` } },
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.Path, "C:\\Windows", "Windows 变量名大小写不敏感");
  assert.equal(env.SystemRoot, "C:\\Windows");
  // 白名单（复核 B3-A02）：运行时注入、代理与 CA、入口与数据目录、任何 ZR_*/KWL_* 都不从进程环境进入内核
  for (const k of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "ZR_AGENT_HOST_ENTRY", "ZR_KERNEL_DATA_DIR", "KWL_MOCK_SCRIPT"]) assert.equal(env[k], undefined, k);
  assert.equal(env.ZR_GATEWAY_BASE, "https://gw.example.cn/v1");
  assert.equal(env.ZR_UPSTREAM_TLS, "strict");
  assert.equal(env.ZR_MODEL_PROVIDER, "upstream");
  for (const k of ["ZR_SEAT_TOKEN", "ZR_BYOK_API_KEY", "ZR_PRIVATE_BASE", "ZR_CONTROL_PLANE_BASE"]) assert.equal(env[k], undefined, k);
});

test("内核子进程环境（复核 C-A15）：安装包形态数据目录与入口写定、强制控制面与落盘加密；开发形态允许覆盖", () => {
  const paths = { dataDir: "/app/KimiWorkLegal", gateEntry: "/app/gate.mjs", kapEntry: "/app/kap.mjs" };
  const evil = { PATH: "/bin", ZR_KERNEL_DATA_DIR: "/tmp/evil", ZR_AGENT_HOST_ENTRY: "/tmp/evil.mjs", ZR_EGRESS_GATE_ENTRY: "/tmp/evil-gate.mjs", ZR_KAP_HOST_ENTRY: "/tmp/evil-kap.mjs", NODE_OPTIONS: "--require /tmp/x.js", ZR_AT_REST: "off" };
  const runtimeEnv = { ZR_NODE_RUNTIME: "/app/node", ZR_EGRESS_GATE_ENTRY: "/res/runtime/gate/main.mjs", ZR_KAP_HOST_ENTRY: "/res/runtime/kap/main.mjs" };
  const packaged = kernelChildEnv({ packaged: true, isDev: false, processEnv: evil, release: { env: {} }, paths, runtimeEnv });
  assert.equal(packaged.ZR_KERNEL_DATA_DIR, paths.dataDir);
  // 入口只来自随包运行时（复核 B4-A20）：不用 asar 内的缺省路径；v5 SDK 宿主已退役（K9-1），任何形态都不下发它的入口
  assert.equal(packaged.ZR_AGENT_HOST_ENTRY, undefined);
  assert.equal(packaged.ZR_EGRESS_GATE_ENTRY, runtimeEnv.ZR_EGRESS_GATE_ENTRY);
  assert.equal(packaged.ZR_KAP_HOST_ENTRY, runtimeEnv.ZR_KAP_HOST_ENTRY);
  assert.throws(() => kernelChildEnv({ packaged: true, isDev: false, processEnv: evil, release: { env: {} }, paths, runtimeEnv: { ZR_NODE_RUNTIME: "/app/node" } }), /随包运行时缺少/);
  assert.equal(packaged.NODE_OPTIONS, undefined);
  assert.equal(packaged.ZR_AT_REST, "required");
  assert.equal(packaged.ZR_REQUIRE_CONTROL_PLANE, "1");
  assert.equal(packaged.ZR_KERNEL_TCP, "off");
  assert.equal(packaged.ZR_NODE_RUNTIME, "/app/node", "随包运行时最后叠加");
  const dev = kernelChildEnv({ packaged: false, isDev: true, processEnv: evil, release: null, paths });
  assert.equal(dev.ZR_AGENT_HOST_ENTRY, "/tmp/evil.mjs", "开发形态进程环境原样（内核已不读取它）");
  assert.equal(dev.ZR_KERNEL_DATA_DIR, "/tmp/evil", "开发形态允许覆盖");
  assert.equal(dev.ZR_KERNEL_TCP, undefined);
});


test("内容分发（第 8 批 S6/S7）：dist_base 须 https + 两把钉住；通道只收 stable/beta；content_keys 只收 1–8 把 Ed25519 公钥；安装包形态剔除环境里的分发配置", () => {
  const ok = loadReleaseConfig(write("dist-ok.json", { dist_base: "https://dl.example.cn/", dist_pins: [P1, P2], dist_channel: "beta", content_keys: [edPem()] }));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.env.ZR_DIST_BASE, "https://dl.example.cn");
  assert.equal(ok.env.ZR_DIST_PINS, `${P1},${P2}`);
  assert.equal(ok.env.ZR_DIST_CHANNEL, "beta");
  assert.equal(JSON.parse(ok.env.ZR_CONTENT_KEYS!).length, 1);
  const noPins = loadReleaseConfig(write("dist-nopin.json", { dist_base: "https://dl.example.cn", dist_pins: [P1] }));
  assert.equal(noPins.env.ZR_DIST_BASE, undefined);
  assert.equal(noPins.problems.length, 1);
  const badChannel = loadReleaseConfig(write("dist-ch.json", { dist_base: "https://dl.example.cn", dist_pins: [P1, P2], dist_channel: "nightly" }));
  assert.equal(badChannel.env.ZR_DIST_CHANNEL, undefined);
  assert.match(badChannel.problems.join(""), /dist_channel/);
  const priv = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const badKeys = loadReleaseConfig(write("dist-keys.json", { dist_base: "https://dl.example.cn", dist_pins: [P1, P2], content_keys: [priv] }));
  assert.equal(badKeys.env.ZR_CONTENT_KEYS, undefined, "私钥不收");
  assert.match(badKeys.problems.join(""), /content_keys/);
  const rv = loadReleaseConfig(write("dist-rv.json", { dist_base: "https://dl.example.cn", dist_pins: [P1, P2], content_keys_revoked: ["ABCDEFGHIJKLMNOP"] }));
  assert.equal(rv.env.ZR_CONTENT_KEYS_REVOKED, '["ABCDEFGHIJKLMNOP"]');
  assert.match(loadReleaseConfig(write("dist-rv-bad.json", { dist_base: "https://dl.example.cn", dist_pins: [P1, P2], content_keys_revoked: ["x"] })).problems.join(""), /content_keys_revoked/);
  const packaged = packagedKernelEnv({ ZR_DIST_BASE: "http://evil.example", ZR_CONTENT_KEYS: "[]", ZR_CONTENT_KEYS_REVOKED: "[]", ZR_DIST_CHANNEL: "beta", PATH: "/bin" }, { env: {} });
  assert.equal(packaged.ZR_CONTENT_KEYS_REVOKED, undefined);
  assert.equal(packaged.ZR_DIST_BASE, undefined);
  assert.equal(packaged.ZR_CONTENT_KEYS, undefined);
  assert.equal(packaged.ZR_DIST_CHANNEL, undefined);
});

test("支持服务（第 9 批 S13）：support_base 须 https + 两把钉住；安装包形态剔除环境里的支持服务配置", () => {
  const ok = loadReleaseConfig(write("support-ok.json", { support_base: "https://support.example.cn/", support_pins: [P1, P2] }));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.env.ZR_SUPPORT_BASE, "https://support.example.cn");
  assert.equal(ok.env.ZR_SUPPORT_PINS, `${P1},${P2}`);
  const http = loadReleaseConfig(write("support-http.json", { support_base: "http://support.example.cn", support_pins: [P1, P2] }));
  assert.equal(http.env.ZR_SUPPORT_BASE, undefined);
  assert.equal(http.problems.length, 1);
  const noPins = loadReleaseConfig(write("support-nopin.json", { support_base: "https://support.example.cn", support_pins: [P1] }));
  assert.equal(noPins.env.ZR_SUPPORT_BASE, undefined);
  const packaged = packagedKernelEnv({ ZR_SUPPORT_BASE: "http://evil.example", ZR_SUPPORT_PINS: "x", PATH: "/bin" }, { env: {} });
  assert.equal(packaged.ZR_SUPPORT_BASE, undefined);
  assert.equal(packaged.ZR_SUPPORT_PINS, undefined);
});

test("通知服务（第 10 批 S9）：notify_base 须 https + 两把钉住；安装包形态剔除环境里的通知服务配置", () => {
  const ok = loadReleaseConfig(write("notify-ok.json", { notify_base: "https://notify.example.cn/", notify_pins: [P1, P2] }));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.env.ZR_NOTIFY_BASE, "https://notify.example.cn");
  assert.equal(ok.env.ZR_NOTIFY_PINS, `${P1},${P2}`);
  const http = loadReleaseConfig(write("notify-http.json", { notify_base: "http://notify.example.cn", notify_pins: [P1, P2] }));
  assert.equal(http.env.ZR_NOTIFY_BASE, undefined);
  assert.equal(http.problems.length, 1);
  const packaged = packagedKernelEnv({ ZR_NOTIFY_BASE: "http://evil.example", ZR_NOTIFY_PINS: "x", PATH: "/bin" }, { env: {} });
  assert.equal(packaged.ZR_NOTIFY_BASE, undefined);
  assert.equal(packaged.ZR_NOTIFY_PINS, undefined);
});
