/**
 * 内核制品打包（方案 v5.0 §3：统一用打包器产出面向 Node 24 的制品）。
 * esbuild 单文件 CJS；better-sqlite3-multiple-ciphers 为 N-API 原生模块，保持 external。
 * 用法：node scripts/build-kernel.mjs [--watch]
 */
import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// 迁移脚本随制品分发（CJS 制品按 __dirname/migrations 解析）
mkdirSync(`${root}apps/desktop/electron`, { recursive: true });
cpSync(`${root}packages/kernel/src/migrations`, `${root}apps/desktop/electron/migrations`, { recursive: true });

// 法规库包与内容签名公钥随制品分发（§9：签名只读 SQLite 包随客户端；须先 npm run build:lawdb）
// 内核按候选路径 <bundle>/lawdb/lawdb.sqlite 解析；开发形态回退仓库 content/lawdb/dist。
try {
  cpSync(`${root}content/lawdb/dist/lawdb.sqlite`, `${root}apps/desktop/electron/lawdb/lawdb.sqlite`, { recursive: true });
  cpSync(`${root}content/lawdb/dist/lawdb.manifest.json`, `${root}apps/desktop/electron/lawdb/lawdb.manifest.json`, { recursive: true });
  cpSync(`${root}content/keys/content-signing-dev.pub.json`, `${root}apps/desktop/electron/lawdb/content-signing.pub.json`, { recursive: true });
  console.log("[build-kernel] lawdb 产物已随包复制（apps/desktop/electron/lawdb/）");
} catch {
  console.warn("[build-kernel] 警告：未找到 lawdb 产物，内核启动将报错——请先运行 npm run build:lawdb");
}

const NATIVE_EXTERNALS = [
  "better-sqlite3-multiple-ciphers",
  // 解析/OCR 原生与重资源依赖（N-API/WASM/模型运行时），保持 external 随包附带
  "onnxruntime-node",
  "@napi-rs/canvas",
  "@hyzyla/pdfium",
  "pdfjs-dist",
  "ppu-paddle-ocr",
  "ppu-ocv",
];

const options = {
  entryPoints: [`${root}packages/kernel/src/electron-entry.ts`],
  outfile: `${root}apps/desktop/electron/kernel.bundle.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: false,
  external: NATIVE_EXTERNALS,
  logLevel: "info",
};

// 隔离解析进程（§8.1：每批次一个；制品旁独立入口）
const parseWorkerOptions = {
  entryPoints: [`${root}packages/parse-ocr/src/parse-worker.ts`],
  outfile: `${root}apps/desktop/electron/parse-worker.bundle.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: false,
  external: NATIVE_EXTERNALS,
  logLevel: "info",
};

// Agent 宿主制品：ESM bundle（top-level await 合法；vendor SDK 打入；目标 node24）
// Electron 打包用法：utilityProcess fork .mjs；dev 默认仍跑 src/host.ts，ZR_AGENT_HOST_ENTRY 可指制品
const hostOptions = {
  entryPoints: [`${root}apps/agent-host/src/host.ts`],
  outfile: `${root}apps/desktop/electron/agent-host.bundle.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  external: [...NATIVE_EXTERNALS, "undici"],
  // ESM 中承载 CJS 依赖（vendor SDK 等含 dynamic require）的 shim（别名避开 SDK 内的同名声明）
  banner: { js: "import { createRequire as __kwlCreateRequire } from 'node:module'; const require = __kwlCreateRequire(import.meta.url);" },
  logLevel: "info",
};

// 所内节点制品：同一内核的 headless 形态（ESM；ZR_NODE_CONFIG 指定配置）
const firmNodeOptions = {
  entryPoints: [`${root}apps/firm-node/src/index.ts`],
  outfile: `${root}apps/desktop/electron/firm-node.bundle.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  external: [...NATIVE_EXTERNALS, "undici"],
  banner: { js: "import { createRequire as __kwlCreateRequire } from 'node:module'; const require = __kwlCreateRequire(import.meta.url);" },
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  const hostCtx = await context(hostOptions);
  const workerCtx = await context(parseWorkerOptions);
  const nodeCtx = await context(firmNodeOptions);
  await Promise.all([ctx.watch(), hostCtx.watch(), workerCtx.watch(), nodeCtx.watch()]);
  console.log("[build-kernel] watching…");
} else {
  await build(options);
  await build(parseWorkerOptions);
  await build(hostOptions);
  await build(firmNodeOptions);
  console.log("[build-kernel] done → apps/desktop/electron/kernel.bundle.cjs + parse-worker.bundle.cjs + agent-host.bundle.mjs + firm-node.bundle.mjs");
}
