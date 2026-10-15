/**
 * 安装包内置上游（审计 S5）：release.json 只接受 https + 至少两把钉住值；安装包形态剔除环境变量里的上游配置、强制严格传输与真实上游。
 */
import { test } from "node:test";
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
    paths: { dataDir: string; agentHostEntry: string; gateEntry: string; kapEntry: string };
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

test("合法配置：地址与钉住集进入内核环境", () => {
  const r = loadReleaseConfig(write("ok.json", { gateway_base: "https://gw.example.cn/v1/", gateway_pins: [P1, P2], control_plane_base: "https://cp.example.cn", control_plane_pins: [P2, P1] }));
  assert.deepEqual(r.problems, []);
  assert.equal(r.env.ZR_GATEWAY_BASE, "https://gw.example.cn/v1");
  assert.equal(r.env.ZR_GATEWAY_PINS, `${P1},${P2}`);
  assert.equal(r.env.ZR_CONTROL_PLANE_BASE, "https://cp.example.cn");
  assert.equal(r.env.ZR_SEARCH_BASE, undefined);
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
  const paths = { dataDir: "/app/KimiWorkLegal", agentHostEntry: "/app/agent-host.mjs", gateEntry: "/app/gate.mjs", kapEntry: "/app/kap.mjs" };
  const evil = { PATH: "/bin", ZR_KERNEL_DATA_DIR: "/tmp/evil", ZR_AGENT_HOST_ENTRY: "/tmp/evil.mjs", ZR_EGRESS_GATE_ENTRY: "/tmp/evil-gate.mjs", ZR_KAP_HOST_ENTRY: "/tmp/evil-kap.mjs", NODE_OPTIONS: "--require /tmp/x.js", ZR_AT_REST: "off" };
  const runtimeEnv = { ZR_NODE_RUNTIME: "/app/node", ZR_EGRESS_GATE_ENTRY: "/res/runtime/gate/main.mjs", ZR_KAP_HOST_ENTRY: "/res/runtime/kap/main.mjs" };
  const packaged = kernelChildEnv({ packaged: true, isDev: false, processEnv: evil, release: { env: {} }, paths, runtimeEnv });
  assert.equal(packaged.ZR_KERNEL_DATA_DIR, paths.dataDir);
  // 入口只来自随包运行时（复核 B4-A20）：不下发 SDK 宿主入口，也不用 asar 内的缺省路径
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
  assert.equal(dev.ZR_KERNEL_DATA_DIR, "/tmp/evil", "开发形态允许覆盖");
  assert.equal(dev.ZR_KERNEL_TCP, undefined);
});

