/**
 * 随包运行时构建（安装包形态；收敛偏离 D-05、D-23）。
 *
 * 输出目录（缺省 apps/desktop/runtime/，安装包以 extraResources 放到 resources/runtime/，不进 asar）：
 *   node/            随包 Node 26（Windows：node.exe；本机验证：当前平台的 node）
 *   （不再随包原生 ripgrep：审计 S3 第 2 步起 Grep/Glob 由 Agent 宿主内检索完成，工作区是密文、原生 rg 读不了）
 *   w/               W 执行域：supervisor.mjs、worker.mjs（esbuild 单文件）+ node_modules/just-bash 及其依赖闭包
 *   kap-host/        Agent 宿主（kap-server 私有嵌入）main.mjs + 宿主内检索 worker search-worker.mjs（与 main.mjs 同目录，宿主按此定位）
 *   egress-gate/     出站闸门 main.mjs
 *   parse/           隔离解析进程（W6）：parse-worker.cjs + 解析/OCR 依赖闭包（pdfjs-dist、pdfium、@napi-rs/canvas 与目标平台原生包、onnxruntime-node 只留目标平台二进制、ppu-paddle-ocr/ppu-ocv）
 *   ocr-models/      PP-OCRv5 mobile 检测/识别模型与字典（本机 OCR，零外发）
 *   runtime-manifest.json  各文件相对路径、sha256、锁定 Node 版本（主进程 runtime-paths.cjs 启动时核验）
 *
 * 用法：
 *   node scripts/build-runtime.mjs                       # 本机验证：用当前 node
 *   node scripts/build-runtime.mjs --target win32-x64    # 安装包：node 取 scripts/fetch-win-runtime.mjs 的下载缓存（已核验摘要）
 *   选项：--out <dir>
 *
 * 不联网：Windows 的 node.exe 由 fetch-win-runtime.mjs 单独下载并按官方校验和与本仓库锁文件核验。
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Windows 上 PATH 里的 tar 可能是 Git 自带 GNU tar（把盘符当远程主机）；用 System32 bsdtar（同 fetch-win-runtime.mjs）
const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const tarBin = process.platform === "win32" && existsSync(system32) ? system32 : "tar";
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const target = arg("--target") ?? `${process.platform}-${process.arch}`;
const out = resolve(arg("--out") ?? join(root, "apps/desktop/runtime"));
const isWin = target.startsWith("win32");
const exe = (n) => (isWin ? `${n}.exe` : n);

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const log = (m) => console.log(`[build-runtime] ${m}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const ESM_BANNER = { js: "import { createRequire as __kwlRtCreateRequire } from 'node:module'; const require = __kwlRtCreateRequire(import.meta.url);" };
const common = { bundle: true, platform: "node", format: "esm", target: "node26", sourcemap: false, logLevel: "warning", banner: ESM_BANNER };

// ── W 执行域 ─────────────────────────────────────────────────────────────
const wDir = join(out, "w");
await build({ ...common, entryPoints: [join(root, "packages/exec-wasm/src/supervisor.ts")], outfile: join(wDir, "supervisor.mjs"), external: ["just-bash"] });
await build({ ...common, entryPoints: [join(root, "packages/exec-wasm/src/worker.ts")], outfile: join(wDir, "worker.mjs"), external: ["just-bash"] });

/**
 * 目标平台过滤（W6 交叉构建）：npm 只为构建机平台安装可选原生包——其他平台的同名包不复制，目标平台的从
 * fetch-win-runtime.mjs 的缓存（.cache/win-runtime/npm，已按锁文件 integrity 核验）取。
 */
const [targetPlatform, targetArch] = target.split("-");
const NATIVE_TRIPLES = { "win32-x64": "win32-x64-msvc", "win32-arm64": "win32-arm64-msvc", "darwin-arm64": "darwin-arm64", "darwin-x64": "darwin-x64", "linux-x64": "linux-x64-gnu", "linux-arm64": "linux-arm64-gnu" };
const nativeTriple = NATIVE_TRIPLES[target];
const crossNpmCache = join(root, ".cache/win-runtime/npm");
function platformPackageWanted(pkgName) {
  const m = /^@napi-rs\/canvas-(.+)$/.exec(pkgName);
  if (!m) return true;
  return m[1] === nativeTriple;
}
const crossBuild = target !== `${process.platform}-${process.arch}`;
const winLock = existsSync(join(root, "scripts/win-runtime.lock.json")) ? JSON.parse(readFileSync(join(root, "scripts/win-runtime.lock.json"), "utf8")) : { npm: {} };
/**
 * 交叉构建时目标平台的原生包只取锁定缓存（fetch-win-runtime.mjs 按锁文件 integrity 核验过），不取仓库 node_modules——
 * 后者可能是任何人用 npm i --os/--cpu 装进来的、未经锁文件核对的版本（复核 B4-A02）；且版本须等于 @napi-rs/canvas 声明的版本。
 */
const crossNativeCache = new Map();
function crossNativeDir(pkgName) {
  if (!crossNativeCache.has(pkgName)) crossNativeCache.set(pkgName, crossNativeDirFresh(pkgName));
  return crossNativeCache.get(pkgName);
}
function crossNativeDirFresh(pkgName) {
  const want = winLock.npm?.[pkgName]?.version;
  const declared = JSON.parse(readFileSync(join(root, "node_modules/@napi-rs/canvas/package.json"), "utf8")).optionalDependencies?.[pkgName];
  if (!want) throw new Error(`锁文件没有 ${pkgName}：交叉构建不能取未锁定的原生包`);
  if (declared && declared !== want) throw new Error(`${pkgName} 锁定版本 ${want} 与 @napi-rs/canvas 声明的 ${declared} 不一致：先更新 scripts/win-runtime.lock.json`);
  // 只认锁定的 tarball（复核 B4-R15）：按锁文件 integrity 复核，再解到本次构建的临时目录——缓存里解好的目录可能已被改动
  const integrity = winLock.npm?.[pkgName]?.integrity;
  const tgz = join(crossNpmCache, `${pkgName.replace(/^@/, "").replace(/\//g, "-")}-${want}.tgz`);
  if (!integrity || !existsSync(tgz)) throw new Error(`缺少锁定的 ${pkgName} tarball：先运行 node scripts/fetch-win-runtime.mjs`);
  const sri = "sha512-" + createHash("sha512").update(readFileSync(tgz)).digest("base64");
  if (sri !== integrity) throw new Error(`${pkgName} tarball 与锁文件 integrity 不符：拒绝构建`);
  const fresh = join(crossNpmCache, "verified", `${pkgName.replace(/^@/, "").replace(/\//g, "-")}-${want}`);
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh, { recursive: true });
  // 归档操作数相对 + cwd：GNU tar 会把 "D:\..." 的盘符冒号当远程主机（同 fetch-win-runtime.mjs）
  execFileSync(tarBin, ["-xzf", basename(tgz), "-C", fresh, "--strip-components=1"], { cwd: crossNpmCache });
  if (JSON.parse(readFileSync(join(fresh, "package.json"), "utf8")).version !== want) throw new Error(`锁定的 ${pkgName} tarball 版本不是 ${want}`);
  return fresh;
}
function findPackageDir(pkgName, fromDir) {
  if (crossBuild && /^@napi-rs\/canvas-/.test(pkgName)) return crossNativeDir(pkgName);
  let dir = fromDir;
  for (;;) {
    const cand = join(dir, "node_modules", pkgName);
    if (existsSync(join(cand, "package.json"))) return cand;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const cached = join(crossNpmCache, "node_modules", pkgName);
  if (target !== `${process.platform}-${process.arch}` && existsSync(join(cached, "package.json"))) return cached;
  return null;
}
/** 包内只留目标平台二进制的目录（onnxruntime-node 自带全部平台，约 290 MB）。 */
function pathWanted(pkgName, relInPkg) {
  if (pkgName === "onnxruntime-node") {
    const m = /^[\\/]bin[\\/]napi-v\d+[\\/]([^\\/]+)(?:[\\/]([^\\/]+))?/.exec(relInPkg);
    if (m && (m[1] !== targetPlatform || (m[2] !== undefined && m[2] !== targetArch))) return false;
  }
  return true;
}

/** 复制 just-bash 及其运行时依赖闭包（按 Node 解析规则：先嵌套 node_modules，再上层）。 */
function copyClosure(pkgName, fromDir, destNodeModules, seen = new Set()) {
  if (!platformPackageWanted(pkgName)) return true;
  const pkgDir = findPackageDir(pkgName, fromDir);
  if (!pkgDir) return false;
  if (seen.has(pkgDir)) return true;
  seen.add(pkgDir);
  const rel = relative(join(root, "node_modules"), pkgDir);
  const dest = rel.startsWith("..") ? join(destNodeModules, pkgName) : join(destNodeModules, rel);
  cpSync(pkgDir, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const inPkg = src.slice(pkgDir.length);
      return !/[\\/](test|tests|__tests__|docs|\.github)([\\/]|$)/.test(inPkg) && !src.endsWith(".map") && pathWanted(pkgName, inPkg);
    },
  });
  const pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  for (const d of Object.keys(pj.dependencies ?? {})) {
    if (!copyClosure(d, pkgDir, destNodeModules, seen)) throw new Error(`依赖缺失：${pkgName} → ${d}`);
  }
  for (const d of Object.keys(pj.optionalDependencies ?? {})) copyClosure(d, pkgDir, destNodeModules, seen);
  return true;
}
const seen = new Set();
copyClosure("just-bash", join(root, "packages/exec-wasm"), join(wDir, "node_modules"), seen);
log(`W 运行时：just-bash 依赖闭包 ${seen.size} 个包`);

// ── Agent 宿主与出站闸门 ───────────────────────────────────────────────────
// 终端（node-pty）在嵌入形态不注册、宿主种子一律拒绝；制品里换成必定失败的桩，杜绝随包或系统里的 node-pty 被装载
const noPty = {
  name: "kwl-no-pty",
  setup(b) {
    b.onResolve({ filter: /^node-pty$/ }, () => ({ path: "node-pty", namespace: "kwl-stub" }));
    b.onLoad({ filter: /.*/, namespace: "kwl-stub" }, () => ({ contents: 'export function spawn(){ throw new Error("终端在本产品中不可用"); }', loader: "js" }));
  },
};
// 宿主内检索用 re2js（MIT，纯 JS）：随宿主一起打包进 main.mjs
await build({ ...common, entryPoints: [join(root, "packages/kap-host/src/main.ts")], outfile: join(out, "kap-host/main.mjs"), external: ["just-bash"], plugins: [noPty] });
await build({ ...common, entryPoints: [join(root, "packages/kap-host/src/search/search-worker.ts")], outfile: join(out, "kap-host/search-worker.mjs") });
await build({ ...common, entryPoints: [join(root, "packages/egress-gate/src/main.ts")], outfile: join(out, "egress-gate/main.mjs"), external: ["better-sqlite3-multiple-ciphers"] });

// ── 隔离解析进程（W6）──────────────────────────────────────────────────────
// 安装包关闭 RunAsNode 熔断后，内核不能再以 Electron 自身 fork 解析进程：改由随包 Node 运行 parse/parse-worker.cjs。
// 原生与重资源依赖保持 external，按目标平台复制依赖闭包（交叉构建时其他平台的原生包不复制）。
const parseDir = join(out, "parse");
const PARSE_EXTERNALS = ["onnxruntime-node", "@napi-rs/canvas", "@hyzyla/pdfium", "pdfjs-dist", "ppu-paddle-ocr", "ppu-ocv"];
await build({
  entryPoints: [join(root, "packages/parse-ocr/src/parse-worker.ts")],
  outfile: join(parseDir, "parse-worker.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node26",
  sourcemap: false,
  logLevel: "warning",
  external: PARSE_EXTERNALS,
});
const parseSeen = new Set();
for (const dep of ["pdfjs-dist", "@hyzyla/pdfium", "@napi-rs/canvas", "onnxruntime-node", "ppu-paddle-ocr", "ppu-ocv"]) {
  if (!copyClosure(dep, join(root, "packages/parse-ocr"), join(parseDir, "node_modules"), parseSeen)) throw new Error(`解析依赖缺失：${dep}`);
}
// 目标平台的 canvas 原生包必须在（否则扫描件与图片解析在律师电脑上必然失败）
if (nativeTriple && !existsSync(join(parseDir, "node_modules/@napi-rs", `canvas-${nativeTriple}`, "package.json"))) {
  throw new Error(`缺少 @napi-rs/canvas-${nativeTriple}：交叉构建先运行 node scripts/fetch-win-runtime.mjs`);
}
const ortBin = join(parseDir, "node_modules/onnxruntime-node/bin/napi-v6", targetPlatform, targetArch, "onnxruntime_binding.node");
if (!existsSync(ortBin)) throw new Error(`onnxruntime-node 缺少 ${target} 二进制`);
log(`解析进程：依赖闭包 ${parseSeen.size} 个包`);

// OCR 模型（只取管线实际装载的三个文件）
const ocrSrc = join(root, "content/ocr-models");
const ocrDir = join(out, "ocr-models");
const OCR_FILES = { ocrDet: "ch_PP-OCRv5_det_mobile.onnx", ocrRec: "ch_PP-OCRv5_rec_mobile.onnx", ocrDict: "ppocrv5_dict.txt" };
mkdirSync(ocrDir, { recursive: true });
for (const f of Object.values(OCR_FILES)) {
  if (!existsSync(join(ocrSrc, f))) throw new Error(`缺少 OCR 模型 ${f}：先运行 npm run fetch:ocr-models`);
  cpSync(join(ocrSrc, f), join(ocrDir, f));
}

// ── 随包 Node ─────────────────────────────────────────────────────────────
let nodeSrc;
let nodeVersion;
if (isWin) {
  const cache = join(root, ".cache/win-runtime");
  const lock = JSON.parse(readFileSync(join(root, "scripts/win-runtime.lock.json"), "utf8"));
  nodeSrc = join(cache, `node-${lock.node.version}-${target}`, "node.exe");
  nodeVersion = lock.node.version;
  if (!existsSync(nodeSrc)) throw new Error(`缺少 ${nodeSrc}：先运行 node scripts/fetch-win-runtime.mjs`);
  if (lock.node.exeSha256 && sha256(nodeSrc) !== lock.node.exeSha256) throw new Error(`摘要与锁文件不符：${nodeSrc}`);
} else {
  nodeSrc = process.env.KWL_RUNTIME_NODE ?? process.execPath;
  nodeVersion = execFileSync(nodeSrc, ["--version"], { encoding: "utf8" }).trim();
}
if (!/^v26\.\d+\.\d+$/.test(nodeVersion)) throw new Error(`随包 Node 必须是 26.x（得到 ${nodeVersion}）`);
const nodeDest = join(out, "node", exe("node"));
mkdirSync(dirname(nodeDest), { recursive: true });
cpSync(nodeSrc, nodeDest, { dereference: true });
if (!isWin) chmodSync(nodeDest, 0o755);
// 子进程独立文件名（v9.2 §3.7、§3.8 S-0；调研 Y5 P1-5、F4）：闸门、Agent 宿主与解析进程各用一份同字节的随包 Node——
// 任务管理器与律所防火墙规则可按程序名区分，安装程序按文件名把它们登记为 WER 排除项（build/installer.nsh）。三份与 node 同一摘要
const ROLE_NODES = { nodeEgress: "kwl-egress", nodeHost: "kwl-host", nodeParse: "kwl-parse" };
for (const name of Object.values(ROLE_NODES)) {
  const d = join(out, "node", exe(name));
  cpSync(nodeDest, d);
  if (!isWin) chmodSync(d, 0o755);
}

// ── 清单 ───────────────────────────────────────────────────────────────
const entry = (abs) => ({ path: relative(out, abs).split("\\").join("/"), sha256: sha256(abs), size: statSync(abs).size });
const manifest = {
  format: "kwl-runtime/1",
  target,
  builtAt: new Date().toISOString(),
  nodeVersion,
  wDir: "w",
  ocrModelDir: "ocr-models",
  files: {
    node: entry(nodeDest),
    ...Object.fromEntries(Object.entries(ROLE_NODES).map(([k, n]) => [k, entry(join(out, "node", exe(n)))])),
    kapHost: entry(join(out, "kap-host/main.mjs")),
    kapSearchWorker: entry(join(out, "kap-host/search-worker.mjs")),
    gate: entry(join(out, "egress-gate/main.mjs")),
    wSupervisor: entry(join(wDir, "supervisor.mjs")),
    wWorker: entry(join(wDir, "worker.mjs")),
    jbEntry: entry(join(wDir, "node_modules/just-bash/dist/bundle/index.js")),
    parseWorker: entry(join(parseDir, "parse-worker.cjs")),
    ortBinding: entry(ortBin),
    ...Object.fromEntries(Object.entries(OCR_FILES).map(([k, f]) => [k, entry(join(ocrDir, f))])),
  },
  // 全部文件（复核 B4-A01）：依赖闭包里的 JS、原生模块与 DLL、wasm、模型都在内——改动其中任何一个都判运行时损坏；
  // 清单外多出的文件同样判损坏（防止在依赖目录里塞入被加载的模块）
  all: (function walk(dir) {
    const out2 = [];
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) out2.push(...walk(abs));
      else if (st.isFile() && abs !== join(out, "runtime-manifest.json")) out2.push(entry(abs));
    }
    return out2;
  })(out),
};
writeFileSync(join(out, "runtime-manifest.json"), JSON.stringify(manifest, null, 2));
log(`完成 → ${out}（${target}，Node ${nodeVersion}）`);
