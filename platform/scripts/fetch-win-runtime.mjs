/**
 * 下载并核验 Windows 随包运行时（node.exe 与解析/OCR 进程的 Windows 原生包）到 .cache/win-runtime/，供 build-runtime.mjs --target win32-x64 使用。
 * （审计 S3 第 2 步起不再随包原生 ripgrep：Grep/Glob 由 Agent 宿主内检索完成。）
 *
 * 核验：压缩包 sha256 必须与官方发布的校验和一致（同版本 SHASUMS256.txt），
 * 且与 scripts/win-runtime.lock.json 中已记录的摘要一致；锁文件摘要为空时写入（首次信任，提交前须评审）。
 * 解压：tgz 用系统 tar（GNU/bsdtar 均可）；node 的 zip 在 Windows 用 PowerShell Expand-Archive
 * （GitHub windows-2025 镜像没有 System32 bsdtar，PATH 上的 tar 是 Git 自带 GNU tar、不认 zip；macOS 自带 bsdtar 认 zip）。
 * 只访问锁文件中的官方地址。
 *
 * 用法：node scripts/fetch-win-runtime.mjs
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const lockPath = join(root, "scripts/win-runtime.lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const cache = join(root, ".cache/win-runtime");
mkdirSync(cache, { recursive: true });


const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function get(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function findFile(dir, name) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      const r = findFile(p, name);
      if (r) return r;
    } else if (e.toLowerCase() === name) return p;
  }
  return null;
}

async function fetchOne(key, exeName, officialSha) {
  const ent = lock[key];
  const zip = await get(ent.zipUrl);
  const zipSha = sha256(zip);
  const official = officialSha(await get(ent.shasumsUrl), ent.zipUrl.split("/").pop());
  if (!official || official !== zipSha) throw new Error(`${key}：压缩包摘要与官方校验和不符（官方 ${official ?? "缺失"}，实得 ${zipSha}）`);
  if (ent.zipSha256 && ent.zipSha256 !== zipSha) throw new Error(`${key}：压缩包摘要与锁文件不符`);
  const tmp = mkdtempSync(join(cache, `${key}-`));
  try {
    const zipFile = join(tmp, "a.zip");
    writeFileSync(zipFile, zip);
    // zip 解压：Windows 一律 PowerShell Expand-Archive（windows-2025 镜像无 System32 bsdtar，PATH 上的 GNU tar 不认 zip）；
    // macOS 自带 bsdtar 认 zip。操作数相对 + cwd（GNU tar 会把绝对路径的 "D:" 前缀解析成远程主机）。
    if (process.platform === "win32") {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath a.zip -DestinationPath ."], { cwd: tmp });
    } else {
      execFileSync("tar", ["-xf", "a.zip"], { cwd: tmp });
    }
    const exe = findFile(tmp, exeName);
    if (!exe) throw new Error(`${key}：压缩包内没有 ${exeName}`);
    const exeSha = sha256(readFileSync(exe));
    if (ent.exeSha256 && ent.exeSha256 !== exeSha) throw new Error(`${key}：${exeName} 摘要与锁文件不符`);
    const destDir = join(cache, `${key}-${ent.version}-win32-x64`);
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    cpSync(exe, join(destDir, exeName));
    ent.zipSha256 = zipSha;
    ent.exeSha256 = exeSha;
    console.log(`[fetch-win-runtime] ${key} ${ent.version}：${exeName} sha256=${exeSha}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

await fetchOne("node", "node.exe", (buf, file) => {
  const line = buf.toString("utf8").split("\n").find((l) => l.trim().endsWith(`  ${file}`));
  return line ? line.split(/\s+/)[0] : null;
});

/**
 * 解析/OCR 进程的 Windows 原生包（W6）：npm 只为当前平台安装可选原生依赖，Windows 二进制须单独取得。
 * 用 npm pack 从官方源取 tarball（npm 按登记的 integrity 校验），再与锁文件中的 integrity 核对（首次信任写入），解到缓存。
 */
const npmCache = join(cache, "npm");
/** 缓存里 tarball 的确定文件名（build-runtime.mjs 同一规则）。 */
const tarballName = (name, version) => `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
mkdirSync(npmCache, { recursive: true });
lock.npm ??= {};
for (const [name, ent] of Object.entries(lock.npm)) {
  const spec = `${name}@${ent.version}`;
  const out = execFileSync("npm", ["pack", spec, "--json", "--pack-destination", npmCache], { encoding: "utf8", shell: process.platform === "win32" });
  const info = JSON.parse(out)[0];
  if (!info || typeof info.integrity !== "string" || !info.filename) throw new Error(`${spec}：npm pack 未返回 integrity`);
  if (ent.integrity && ent.integrity !== info.integrity) throw new Error(`${spec}：integrity 与锁文件不符（锁 ${ent.integrity}，实得 ${info.integrity}）`);
  const tgz = join(npmCache, info.filename);
  const tgzSri = "sha512-" + createHash("sha512").update(readFileSync(tgz)).digest("base64");
  if (tgzSri !== info.integrity) throw new Error(`${spec}：下载文件摘要与 integrity 不符`);
  const dest = join(npmCache, "node_modules", ...name.split("/"));
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  // tgz：GNU/bsdtar 均可解。不给 tar 传任何绝对路径——-C 的盘符/反斜杠会被 GNU tar 弄坏（run 38676717086）；
  // cwd 到目标目录，归档参数用相对正斜杠路径
  execFileSync("tar", ["-xzf", relative(dest, tgz).split("\\").join("/"), "--strip-components=1"], { cwd: dest });
  // 保留 tarball（复核 B4-R15）：build-runtime 交叉构建时按锁文件 integrity 复核它、并从它重新解出，不信任缓存里解好的目录
  renameSync(tgz, join(npmCache, tarballName(name, ent.version)));
  ent.integrity = info.integrity;
  console.log(`[fetch-win-runtime] ${spec}：${info.integrity.slice(0, 24)}…`);
}
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
console.log("[fetch-win-runtime] 完成；锁文件已更新（若新增摘要请评审后提交）");
if (!existsSync(join(cache, `node-${lock.node.version}-win32-x64`, "node.exe"))) process.exit(1);
