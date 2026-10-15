/**
 * 桌面安装包构建（W4）：暂存应用目录 → 主进程打包 → electron-builder（Windows NSIS，按用户安装）。
 *
 * 为什么暂存：内核、前端与 Agent 宿主都是单文件制品，安装包里只需要一个原生模块（better-sqlite3-multiple-ciphers，
 * N-API 预编译）；直接让 electron-builder 分析 npm 工作区会把整个仓库的依赖树打进去。暂存目录只放运行所需文件，
 * 依赖清单只有那一个原生模块，并且只保留目标平台的预编译二进制。
 *
 * 步骤：
 *   1. 内容构建（法规库、Agent 配置、工具清单、方法模板）与内核制品、前端（vite）
 *   2. 随包运行时 scripts/build-runtime.mjs --target <目标>（Windows 先运行 scripts/fetch-win-runtime.mjs）
 *   3. 暂存 apps/desktop/.stage/app：package.json（只列原生模块）、dist/、electron/（主进程经 esbuild 打包含 electron-updater）
 *   4. electron-builder（配置 apps/desktop/electron-builder.yml，directories.app 指向暂存目录）
 *
 * 签名（--sign）：
 *   dev  用 scripts/dev-codesign.mjs 生成的**仅供测试**的自签名证书（.cache/dev-codesign/，不入库）；
 *   env  用 CSC_LINK / CSC_KEY_PASSWORD（正式证书，由发布流程注入）；
 *   none 不签名（缺省；SmartScreen 会拦截，只用于本机检查）。
 *
 * 用法：node scripts/package-desktop.mjs [--target win32-x64] [--sign dev|env|none] [--skip-build] [--dir]
 *   --dir 只产出未打包目录（release/win-unpacked），便于检查内容。
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const desktop = join(root, "apps/desktop");
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const target = arg("--target", "win32-x64");
const sign = arg("--sign", "none");
const skipBuild = argv.includes("--skip-build");
const dirOnly = argv.includes("--dir");
const [platform, arch] = target.split("-");
const log = (m) => console.log(`[package-desktop] ${m}`);
// node 直接以本进程的可执行文件运行（不经 shell）；只有 npm/npx 在 Windows 上是 .cmd，须经 shell——此时逐个参数加引号，
// 路径含空格（例如仓库根目录 “Kimi Work Legal”）时不被拆开（复核 B4-A18；DEP0190）
const quoteWin = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);
const run = (cmd, args, opts = {}) => {
  if (cmd === "node") return execFileSync(process.execPath, args, { stdio: "inherit", cwd: root, ...opts });
  if (process.platform === "win32") return execFileSync([cmd, ...args.map(quoteWin)].join(" "), [], { stdio: "inherit", cwd: root, shell: true, ...opts });
  return execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
};

// 暂只支持 win32-x64（复核 B4-A02）：锁文件只有 x64 的 Node 与原生包，electron-builder.yml 也写死 x64
if (target !== "win32-x64") throw new Error(`暂只支持 win32-x64 安装包（得到 ${target}）`);

// ── 1. 内容与制品 ───────────────────────────────────────────────────────
if (!skipBuild) {
  for (const s of ["build:lawdb", "build:agent-profile", "build:tool-manifest", "build:skills"]) run("npm", ["run", s]);
  run("npm", ["run", "build", "-w", "@zr-legal/desktop"]);
}
if (!existsSync(join(desktop, "dist/index.html"))) throw new Error("缺少前端产物 apps/desktop/dist：先去掉 --skip-build 构建");

// ── 2. 随包运行时 ──────────────────────────────────────────────────────
const lock = JSON.parse(readFileSync(join(root, "scripts/win-runtime.lock.json"), "utf8"));
// 随包 Node 或锁定的原生包 tarball 不在缓存里即重新获取（build-runtime 每次按锁文件复核 tarball 并重新解出，复核 B4-R15）
const tarballMissing = Object.entries(lock.npm ?? {}).some(([name, ent]) => !existsSync(join(root, ".cache/win-runtime/npm", `${name.replace(/^@/, "").replace(/\//g, "-")}-${ent.version}.tgz`)));
if (!existsSync(join(root, ".cache/win-runtime", `node-${lock.node.version}-${target}`, "node.exe")) || tarballMissing) run("node", ["scripts/fetch-win-runtime.mjs"]);
run("node", ["scripts/build-runtime.mjs", "--target", target, "--out", join(desktop, "runtime")]);

// ── 3. 暂存应用目录 ────────────────────────────────────────────────────
const stage = join(desktop, ".stage/app");
rmSync(join(desktop, ".stage"), { recursive: true, force: true });
mkdirSync(join(stage, "electron"), { recursive: true });
const desktopPkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const sqlitePkgDir = join(root, "node_modules/better-sqlite3-multiple-ciphers");
const sqlitePkg = JSON.parse(readFileSync(join(sqlitePkgDir, "package.json"), "utf8"));
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "kimi-work-legal",
      productName: "Kimi Work 法律版",
      version: desktopPkg.version,
      description: "Kimi Work 法律行业发行版",
      author: "中国软件国际",
      main: "electron/main.cjs",
      // 内核制品唯一的外部依赖（N-API 预编译）；其余全部打进单文件制品
      dependencies: { "better-sqlite3-multiple-ciphers": sqlitePkg.version },
    },
    null,
    2,
  ),
);
// 原生模块：只留 lib 与目标平台预编译二进制（node-addon-api 只在源码编译时用，运行时不需要）
const sqliteDest = join(stage, "node_modules/better-sqlite3-multiple-ciphers");
mkdirSync(join(sqliteDest, "prebuilds"), { recursive: true });
cpSync(join(sqlitePkgDir, "lib"), join(sqliteDest, "lib"), { recursive: true });
cpSync(join(sqlitePkgDir, "LICENSE"), join(sqliteDest, "LICENSE"));
cpSync(join(sqlitePkgDir, "prebuilds", `${target}.node`), join(sqliteDest, "prebuilds", `${target}.node`));
writeFileSync(join(sqliteDest, "package.json"), JSON.stringify({ ...sqlitePkg, dependencies: {}, devDependencies: {}, scripts: {} }, null, 2));

cpSync(join(desktop, "dist"), join(stage, "dist"), { recursive: true });
// 主进程：入口与本地模块、electron-updater 打成一个文件（electron 与原生模块 external）
await build({
  entryPoints: [join(desktop, "electron/main.cjs")],
  outfile: join(stage, "electron/main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  sourcemap: false,
  logLevel: "warning",
  legalComments: "none",
});
for (const f of ["preload.cjs", "kernel.bundle.cjs"]) cpSync(join(desktop, "electron", f), join(stage, "electron", f));
// 随包运行时的期望摘要放进 asar（主进程按它核对 resources/runtime，见 runtime-paths.cjs trustedManifestFile）；
// 另记 asar.unpacked 里原生模块的摘要（内核进程装载它，asar 完整性不覆盖 unpacked；复核 B4-A01）
{
  const rm = JSON.parse(readFileSync(join(desktop, "runtime/runtime-manifest.json"), "utf8"));
  const rel = `node_modules/better-sqlite3-multiple-ciphers/prebuilds/${target}.node`;
  rm.unpacked = [{ path: rel, sha256: createHash("sha256").update(readFileSync(join(stage, rel))).digest("hex") }];
  writeFileSync(join(stage, "electron/runtime-manifest.json"), JSON.stringify(rm, null, 2));
}
for (const d of ["migrations", "lawdb", "tool-manifest", "skills"]) {
  if (!existsSync(join(desktop, "electron", d))) throw new Error(`缺少 electron/${d}：先运行内容构建`);
  cpSync(join(desktop, "electron", d), join(stage, "electron", d), { recursive: true });
}
// 安装包上游与钉住集（审计 S5）：发布流程放置 electron/release.json；缺失时安装包只有本机能力（控制面缺失即退出模式）
if (existsSync(join(desktop, "electron/release.json"))) cpSync(join(desktop, "electron/release.json"), join(stage, "electron/release.json"));
else log("提示：未找到 electron/release.json——安装包不含中软云上游（只能用本机能力），正式发布必须提供");
log(`暂存完成 → ${stage}`);

// ── 4. electron-builder ────────────────────────────────────────────────
const env = { ...process.env };
if (sign === "dev") {
  const dir = join(root, ".cache/dev-codesign");
  if (!existsSync(join(dir, "dev-codesign.pfx"))) run("node", ["scripts/dev-codesign.mjs"]);
  env.CSC_LINK = join(dir, "dev-codesign.pfx");
  env.CSC_KEY_PASSWORD = readFileSync(join(dir, "password.txt"), "utf8").trim();
  log("使用仅供测试的自签名证书签名（不能用于对外发布）");
} else if (sign === "none") {
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
} else if (sign === "env") {
  if (!env.CSC_LINK && !env.WIN_CSC_LINK) throw new Error("--sign env 需要 CSC_LINK（或 WIN_CSC_LINK）与 CSC_KEY_PASSWORD");
} else throw new Error(`未知的 --sign ${sign}`);

const builderArgs = ["electron-builder", "--win", `--${arch}`, "--config", "electron-builder.yml", "--publish", "never"];
if (dirOnly) builderArgs.push("--dir");
run("npx", builderArgs, { cwd: desktop, env });
log(`完成 → ${join(desktop, "release")}`);
