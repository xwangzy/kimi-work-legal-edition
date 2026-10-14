/**
 * kap-embed 制品（v9 第 04 篇 §3.2：kap-server 无端口私有嵌入）。
 * 输入：third_party/kimi-code（锁版 f67e6398f + 中软补丁 ZP-1～19，见 third_party/PATCHES.md）。
 * 输出：packages/kap-host/vendor/kap-embed/kap-embed.mjs + inputs.json（ZP-17 静态检查用：制品中每个输入文件
 * 及其对 child_process / worker_threads 的导入）+ BUILD.json（上游提交、补丁摘要、输入数）。
 * 用法：node scripts/build-kap-embed.mjs
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const KC = resolve(root, "third_party/kimi-code");
const outDir = resolve(root, "packages/kap-host/vendor/kap-embed");
mkdirSync(outDir, { recursive: true });

const rawText = {
  name: "raw-text",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.replace(/\?raw$/, "")), namespace: "raw" }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, "utf8"))};`, loader: "js" }));
  },
};

// 只重定向入口文件自己的两条导入；kimi-code 内部（含子路径导入）按其自身 pnpm node_modules 正常解析
const entryFile = resolve(root, "packages/kap-host/vendor-entry/kap-embed-entry.ts");
const entryImports = {
  name: "entry-imports",
  setup(b) {
    const map = {
      "@moonshot-ai/kap-server/embed": resolve(KC, "packages/kap-server/src/embed.ts"),
      "@moonshot-ai/agent-core-v2": resolve(KC, "packages/agent-core-v2/src/index.ts"),
      // 落盘加密（审计 S3）：存储与查询库的 DI 标识、minidb 过滤函数、事件日志 I/O 类型（与引擎同一源文件，打包后同一模块实例）
      "@moonshot-ai/agent-core-v2/storage": resolve(KC, "packages/agent-core-v2/src/persistence/interface/storage.ts"),
      "@moonshot-ai/agent-core-v2/query-store": resolve(KC, "packages/agent-core-v2/src/persistence/interface/queryStore.ts"),
      "@moonshot-ai/minidb/query": resolve(KC, "packages/minidb/src/query.ts"),
      "@moonshot-ai/kap-server/journal": resolve(KC, "packages/kap-server/src/transport/ws/v1/sessionEventJournal.ts"),
    };
    b.onResolve({ filter: /^@moonshot-ai\/(kap-server\/embed|kap-server\/journal|agent-core-v2|agent-core-v2\/storage|agent-core-v2\/query-store|minidb\/query)$/ }, (a) => (a.importer === entryFile ? { path: map[a.path] } : undefined));
    b.onResolve({ filter: /^google-auth-library$/ }, () => ({ path: resolve(root, "scripts/stubs/google-auth-library.mjs") }));
  },
};

const result = await build({
  entryPoints: [entryFile],
  outfile: resolve(outDir, "kap-embed.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  legalComments: "eof",
  metafile: true,
  logLevel: "warning",
  plugins: [rawText, entryImports],
  external: ["node-pty", "fsevents"],
  banner: {
    js: [
      "import { createRequire as __kwlCreateRequire } from 'node:module';",
      "import { fileURLToPath as __kwlFileURLToPath } from 'node:url';",
      "import { dirname as __kwlDirname } from 'node:path';",
      "const require = __kwlCreateRequire(import.meta.url);",
      "const __filename = __kwlFileURLToPath(import.meta.url);",
      "const __dirname = __kwlDirname(__filename);",
    ].join("\n"),
  },
});

const PROCESS_MODULES = /^(node:)?(child_process|worker_threads|cluster)$/;
// 出网面（第 04 篇 §5.1 第②级“CI 扫描出网面”，审查 R-14）：直接导入底层网络模块的输入文件
const NETWORK_MODULES = /^(node:)?(net|tls|dgram|dns|dns\/promises|http|https|http2)$/;
const inputs = Object.entries(result.metafile.inputs).map(([file, info]) => ({
  file: relative(root, resolve(root, file)).replaceAll("\\", "/"),
  processImports: info.imports.filter((i) => PROCESS_MODULES.test(i.path)).map((i) => i.path),
  networkImports: info.imports.filter((i) => NETWORK_MODULES.test(i.path)).map((i) => i.path),
}));
writeFileSync(resolve(outDir, "inputs.json"), JSON.stringify(inputs, null, 1));

let upstream = "unknown";
try {
  upstream = execFileSync("git", ["-C", KC, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  // 无 git（离线制品）
}
let patchDigest = "unknown";
try {
  const diff = execFileSync("git", ["-C", KC, "diff", "HEAD"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const untracked = execFileSync("git", ["-C", KC, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts") && f.includes("/src/"))
    .map((f) => `${f}\n${readFileSync(resolve(KC, f), "utf8")}`)
    .join("\n");
  patchDigest = createHash("sha256").update(diff).update(untracked).digest("hex");
} catch {
  // 同上
}
const bundle = readFileSync(resolve(outDir, "kap-embed.mjs"));
writeFileSync(
  resolve(outDir, "BUILD.json"),
  JSON.stringify(
    {
      upstream_commit: upstream,
      patch_digest_sha256: patchDigest,
      bundle_sha256: createHash("sha256").update(bundle).digest("hex"),
      inputs: inputs.length,
      built_at: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(`[build-kap-embed] ${inputs.length} inputs → ${relative(root, resolve(outDir, "kap-embed.mjs"))} (${(bundle.length / 1e6).toFixed(1)} MB)`);
