/**
 * 随包运行时构建（安装包形态；收敛偏离 D-05、D-23）。
 *
 * 输出目录（缺省 apps/desktop/runtime/，安装包以 extraResources 放到 resources/runtime/，不进 asar）：
 *   node/            随包 Node 26（Windows：node.exe；本机验证：当前平台的 node）
 *   （不再随包原生 ripgrep：审计 S3 第 2 步起 Grep/Glob 由 Agent 宿主内检索完成，工作区是密文、原生 rg 读不了）
 *   w/               W 执行域：supervisor.mjs、worker.mjs（esbuild 单文件）+ node_modules/just-bash 及其依赖闭包
 *   kap-host/        Agent 宿主（kap-server 私有嵌入）main.mjs + 宿主内检索 worker search-worker.mjs（与 main.mjs 同目录，宿主按此定位）
 *   egress-gate/     出站闸门 main.mjs
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
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
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

/** 复制 just-bash 及其运行时依赖闭包（按 Node 解析规则：先嵌套 node_modules，再上层）。 */
function copyClosure(pkgName, fromDir, destNodeModules, seen = new Set()) {
  let dir = fromDir;
  let pkgDir = null;
  for (;;) {
    const cand = join(dir, "node_modules", pkgName);
    if (existsSync(join(cand, "package.json"))) {
      pkgDir = cand;
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (!pkgDir) return false;
  if (seen.has(pkgDir)) return true;
  seen.add(pkgDir);
  const rel = relative(join(root, "node_modules"), pkgDir);
  const dest = rel.startsWith("..") ? join(destNodeModules, pkgName) : join(destNodeModules, rel);
  cpSync(pkgDir, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => !/[\\/](test|tests|__tests__|docs|\.github)([\\/]|$)/.test(src.slice(pkgDir.length)) && !src.endsWith(".map"),
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

// ── 清单 ───────────────────────────────────────────────────────────────
const entry = (abs) => ({ path: relative(out, abs).split("\\").join("/"), sha256: sha256(abs), size: statSync(abs).size });
const manifest = {
  format: "kwl-runtime/1",
  target,
  builtAt: new Date().toISOString(),
  nodeVersion,
  wDir: "w",
  files: {
    node: entry(nodeDest),
    kapHost: entry(join(out, "kap-host/main.mjs")),
    kapSearchWorker: entry(join(out, "kap-host/search-worker.mjs")),
    gate: entry(join(out, "egress-gate/main.mjs")),
    wSupervisor: entry(join(wDir, "supervisor.mjs")),
    wWorker: entry(join(wDir, "worker.mjs")),
    jbEntry: entry(join(wDir, "node_modules/just-bash/dist/bundle/index.js")),
  },
};
writeFileSync(join(out, "runtime-manifest.json"), JSON.stringify(manifest, null, 2));
log(`完成 → ${out}（${target}，Node ${nodeVersion}）`);
