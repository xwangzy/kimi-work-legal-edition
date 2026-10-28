/**
 * 内核制品打包（方案 v5.0 §3：统一用打包器产出面向 Node 24 的制品）。
 * esbuild 单文件 CJS；better-sqlite3-multiple-ciphers 为 N-API 原生模块，保持 external。
 * 用法：node scripts/build-kernel.mjs [--watch]
 */
import { build, context } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keyFp, knownDevFingerprints } from "./lib/dev-content-keys.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// 内容签名公钥（第 13 批，评审 Z4 P0-3；复核 A-14/B13-O05 起按公钥指纹识别开发公钥）：正式发布经 KWL_CONTENT_SIGNING_PUB_FILE 给出生产公钥
// （私钥在签名服务/硬件模块）；未给出时随包开发公钥并写明 dev:true。指向的文件即使去掉了 dev 标记，只要公钥在开发公钥登记表里
// （仓库 content/dev-content-key-fingerprints.json ∪ 本机开发公钥）也拒绝。
// 门禁放在最前面、任何写盘之前（第 14 批第二轮复核 A 余项：原先先清空并重写了制品旁的迁移目录才判门禁），也不在下面的 try 里——
// 门禁失败必须让构建失败，不能被“未找到 lawdb 产物”的警告吞掉。
const devPubFile = `${root}content/keys/content-signing-dev.pub.json`;
const devFps = [...knownDevFingerprints(root)];
const prodPub = process.env.KWL_CONTENT_SIGNING_PUB_FILE;
let pubSrc = null;
if (prodPub) {
  pubSrc = JSON.parse(readFileSync(prodPub, "utf8"));
  if (typeof pubSrc.publicKeyPem !== "string" || !pubSrc.publicKeyPem.includes("BEGIN PUBLIC KEY")) throw new Error("KWL_CONTENT_SIGNING_PUB_FILE 缺少 publicKeyPem");
  if (pubSrc.dev || devFps.includes(keyFp(pubSrc.publicKeyPem))) throw new Error("KWL_CONTENT_SIGNING_PUB_FILE 指向的是开发公钥（标记或公钥指纹在开发公钥登记表里）");
}
if (process.argv.includes("--check-content-key")) {
  // 只核门禁、不构建（测试用：不改任何制品）
  console.log("[build-kernel] 内容签名公钥门禁通过");
  process.exit(0);
}

// 开发形态（第 28 批）：先按源文件重建签名内容包（方法模板、工具清单锁、Agent profile），再随制品复制——
// 10-28 走查发现本机演示的桌面端带的还是 10-23 的方法包（源文件已改到第 27 批）。正式发布的内容包由签名服务产出，这里不碰
if (!prodPub && existsSync(`${root}content/keys/content-signing-dev.json`)) {
  for (const s of ["content/skills/build-skills.mjs", "content/tool-manifest/build-lock.mjs", "content/agent-profile/build-profile.mjs"]) execFileSync(process.execPath, [`${root}${s}`], { stdio: "inherit", cwd: root });
}

// 迁移脚本随制品分发（CJS 制品按 __dirname/migrations 解析）。先清空目标目录：迁移改过名（如 0045 → 0050）时，
// 旧副本留在制品旁会被当成另一条迁移再执行一次
mkdirSync(`${root}apps/desktop/electron`, { recursive: true });
rmSync(`${root}apps/desktop/electron/migrations`, { recursive: true, force: true });
cpSync(`${root}packages/kernel/src/migrations`, `${root}apps/desktop/electron/migrations`, { recursive: true });

// 法规库包与内容签名公钥随制品分发（§9：签名只读 SQLite 包随客户端；须先 npm run build:lawdb）
// 内核按候选路径 <bundle>/lawdb/lawdb.sqlite 解析；开发形态回退仓库 content/lawdb/dist。
try {
  cpSync(`${root}content/lawdb/dist/lawdb.sqlite`, `${root}apps/desktop/electron/lawdb/lawdb.sqlite`, { recursive: true });
  cpSync(`${root}content/lawdb/dist/lawdb.manifest.json`, `${root}apps/desktop/electron/lawdb/lawdb.manifest.json`, { recursive: true });
  // 随包公钥；旁边写全部已知开发公钥的指纹（登记表 ∪ 构建机本机；内核据此判断 content_key 是否为 dev、正式安装包里拒载，打包脚本据此拒收正式发布）
  const bundled = pubSrc ?? { ...JSON.parse(readFileSync(devPubFile, "utf8")), dev: true };
  mkdirSync(`${root}apps/desktop/electron/lawdb`, { recursive: true });
  writeFileSync(`${root}apps/desktop/electron/lawdb/content-signing.pub.json`, JSON.stringify({ publicKeyPem: bundled.publicKeyPem, ...(bundled.dev ? { dev: true } : {}) }, null, 2));
  writeFileSync(`${root}apps/desktop/electron/lawdb/content-dev-fingerprints.json`, JSON.stringify(devFps));
  console.log("[build-kernel] lawdb 产物已随包复制（apps/desktop/electron/lawdb/）");
  // 工具清单锁文件（审查 R-08）随包分发；内核按 <bundle>/tool-manifest/ 解析
  cpSync(`${root}content/tool-manifest/dist`, `${root}apps/desktop/electron/tool-manifest`, { recursive: true });
  // 方法模板包（签名，随包分发；内核按 <bundle>/skills/skills.manifest.json 解析）
  cpSync(`${root}content/skills/dist`, `${root}apps/desktop/electron/skills`, { recursive: true });
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

// 出站闸门制品（v9 第 04 篇 §1.1：独立进程、唯一出口；产品形态为独立签名二进制，G0 桌面以 ESM bundle 由内核 fork）
// Electron 打包用法：内核以系统/随包 Node 运行（KWL_GATE_NODE）；主进程经 ZR_EGRESS_GATE_ENTRY 指向本制品
const gateOptions = {
  entryPoints: [`${root}packages/egress-gate/src/main.ts`],
  outfile: process.env.KWL_GATE_BUNDLE_OUT ?? `${root}apps/desktop/electron/egress-gate.bundle.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  external: [...NATIVE_EXTERNALS],
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
  const workerCtx = await context(parseWorkerOptions);
  const nodeCtx = await context(firmNodeOptions);
  const gateCtx = await context(gateOptions);
  await Promise.all([ctx.watch(), workerCtx.watch(), nodeCtx.watch(), gateCtx.watch()]);
  console.log("[build-kernel] watching…");
} else {
  await build(options);
  await build(parseWorkerOptions);
  await build(firmNodeOptions);
  await build(gateOptions);
  console.log("[build-kernel] done → apps/desktop/electron/kernel.bundle.cjs + parse-worker.bundle.cjs + firm-node.bundle.mjs + egress-gate.bundle.mjs");
}
