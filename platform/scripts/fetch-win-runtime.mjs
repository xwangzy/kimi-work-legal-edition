/**
 * 下载并核验 Windows 随包运行时（node.exe）到 .cache/win-runtime/，供 build-runtime.mjs --target win32-x64 使用。
 * （审计 S3 第 2 步起不再随包原生 ripgrep：Grep/Glob 由 Agent 宿主内检索完成。）
 *
 * 核验：压缩包 sha256 必须与官方发布的校验和一致（同版本 SHASUMS256.txt），
 * 且与 scripts/win-runtime.lock.json 中已记录的摘要一致；锁文件摘要为空时写入（首次信任，提交前须评审）。
 * 解压用系统 tar（Windows 10+ 与 macOS 自带，支持 zip）。只访问锁文件中的官方地址。
 *
 * 用法：node scripts/fetch-win-runtime.mjs
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    execFileSync("tar", ["-xf", zipFile, "-C", tmp]);
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
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
console.log("[fetch-win-runtime] 完成；锁文件已更新（若新增摘要请评审后提交）");
if (!existsSync(join(cache, `node-${lock.node.version}-win32-x64`, "node.exe"))) process.exit(1);
