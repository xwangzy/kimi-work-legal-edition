/**
 * 制品静态面检查（v9 第 04 篇 ZP-17“`node:child_process` 只允许出现在白名单文件”的 CI 静态检查；
 * §5.1 第②级“CI 扫描出网面”，覆盖 vendor 与依赖——审查 R-14）。
 *
 * 白名单是**精确集合**：上游升级或依赖变化引入新的进程/网络入口时测试失败，须经评审更新本表与补丁台账。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VENDOR = fileURLToPath(new URL("../vendor/kap-embed/", import.meta.url));
const inputs = JSON.parse(readFileSync(`${VENDOR}inputs.json`, "utf8")) as { file: string; processImports: string[]; networkImports: string[] }[];
const bundle = readFileSync(`${VENDOR}kap-embed.mjs`, "utf8");
const build = JSON.parse(readFileSync(`${VENDOR}BUILD.json`, "utf8")) as { upstream_commit: string; inputs: number };

const strip = (f: string) => f.replace(/^third_party\/kimi-code\//, "").replace(/node_modules\/\.pnpm\/[^/]+\/node_modules\//, "npm:");

test("制品锁定上游提交 f67e6398f（2.1.1）", () => {
  assert.match(build.upstream_commit, /^f67e6398f/);
  assert.equal(build.inputs, inputs.length);
});

test("ZP-17：node:child_process 只出现在默认进程服务（由种子替换为执行域路由）", () => {
  const importers = inputs.filter((i) => i.processImports.some((m) => /child_process$/.test(m))).map((i) => strip(i.file));
  assert.deepEqual(importers, ["packages/agent-core-v2/src/os/backends/node-local/hostProcessService.ts"]);
  // 文本层：只有这一处 import，没有经 createRequire / process.binding 的旁路
  assert.equal(bundle.match(/child_process/g)?.length, 1);
  assert.doesNotMatch(bundle, /process\.binding\(|spawn_sync|process\.dlopen\(/);
});

test("worker_threads / cluster 导入者为固定集合（库内部用途，不运行模型代码）", () => {
  const importers = inputs
    .filter((i) => i.processImports.some((m) => /(worker_threads|cluster)$/.test(m)))
    .map((i) => strip(i.file))
    .sort();
  assert.deepEqual(importers, [
    "npm:pino/lib/tools.js",
    "npm:thread-stream/index.js",
    "npm:undici/lib/util/runtime-features.js",
    "npm:undici/lib/web/webidl/index.js",
    "packages/minidb/src/worker/text-build.ts",
  ]);
});

test("出网面：第一方源码不直接导入任何网络模块；第三方网络入口为固定集合", () => {
  const firstParty = inputs.filter((i) => i.networkImports.length > 0 && !i.file.includes("node_modules")).map((i) => strip(i.file));
  assert.deepEqual(firstParty, [], "第一方源码出现直接网络导入（例如本机直连抓取、OAuth 回调监听）——须经评审");
  const thirdParty = inputs
    .filter((i) => i.networkImports.length > 0 && i.file.includes("node_modules"))
    .map((i) => strip(i.file))
    .sort();
  assert.deepEqual(thirdParty, [
    "npm:fastify/fastify.js",
    "npm:fastify/lib/error-handler.js",
    "npm:fastify/lib/server.js",
    "npm:light-my-request/lib/response.js",
    "npm:socks/build/client/socksclient.js",
    "npm:socks/build/common/helpers.js",
    "npm:undici/lib/core/connect.js",
    "npm:undici/lib/core/socks5-utils.js",
    "npm:undici/lib/core/util.js",
    "npm:undici/lib/dispatcher/client-h2.js",
    "npm:undici/lib/dispatcher/client.js",
    "npm:undici/lib/dispatcher/socks5-proxy-agent.js",
    "npm:undici/lib/interceptor/dns.js",
    "npm:undici/lib/mock/mock-utils.js",
    "npm:undici/lib/web/fetch/index.js",
    "npm:ws/lib/websocket-server.js",
    "npm:ws/lib/websocket.js",
  ]);
});

test("已删除的直连路径不在制品中：ripgrep CDN 下载（ZP-20）、本机直连抓取（ZP-11）、MCP OAuth 回调监听（ZP-21）", () => {
  assert.doesNotMatch(bundle, /downloadAndInstallRg|downloadRgWithLock/);
  assert.doesNotMatch(bundle, /LocalFetchURLProvider/);
  assert.match(bundle, /MCP OAuth is disabled in this distribution/);
  assert.match(bundle, /trusted ripgrep is not configured/);
});

test("ZP-4b：前置钩子的 allow() 不再短路其余监听者（权限闸门/宿主策略总会裁决）；ZP-22：拒绝按本机路径附件", () => {
  assert.doesNotMatch(bundle, /if \(event\.finalAllowed\)/, "发射器不得因 allow() 提前返回");
  assert.match(bundle, /attachment by local path is disabled in this distribution/);
});

test("复核 B4-B08：强制取消只经内核 IPC 可达——kap-host 源码不监听端口，forceCancel 只在运行时定义与 main.ts 方法表；方法分派只认方法表自有键；内核只有 kap 适配器调用它", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(src).filter((f) => f.endsWith(".ts"));
  assert.deepEqual(files.filter((f) => readFileSync(join(src, f), "utf8").includes("forceCancel")).sort(), ["main.ts", "runtime.ts"]);
  for (const f of files) assert.doesNotMatch(readFileSync(join(src, f), "utf8"), /\bcreateServer\s*\(|\.listen\s*\(/, `${f} 不得监听端口`);
  const main = readFileSync(join(src, "main.ts"), "utf8");
  const table = main.slice(main.indexOf("const methods"), main.indexOf('process.on("message"'));
  assert.match(table, /async forceCancel\(p: \{ run_id: string; reason\?: string \}\)/, "forceCancel 在 IPC 方法表内");
  assert.equal(main.match(/forceCancel/g)?.length, 2, "main.ts 只在方法表里出现（方法名与对运行时的调用）");
  assert.match(main, /Object\.hasOwn\(methods, msg\.method\)/, "分派只认方法表自有键（不认原型键）");
  // 内核侧：只有 kap 适配器调用 forceCancel；内核 API 与其余模块不出现（没有透传宿主方法名的入口）
  const kernel = fileURLToPath(new URL("../../kernel/src/", import.meta.url));
  const users: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(n) && readFileSync(p, "utf8").includes("forceCancel")) users.push(p.slice(kernel.length).split("\\").join("/"));
    }
  };
  walk(kernel);
  assert.deepEqual(users, ["executor/kap-agent-client.ts"]);
});
