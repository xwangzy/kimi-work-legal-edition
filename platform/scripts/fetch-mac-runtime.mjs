/**
 * 下载并核验 macOS 随包 Node（官方 node-<版本>-darwin-<架构>.tar.gz 里的 bin/node）到 .cache/mac-runtime/，
 * 供 build-runtime.mjs --target darwin-arm64 使用（DMG 安装包）。
 *
 * 为什么不直接用构建机当前的 node：构建机的 node 可能来自 Homebrew（动态链接 Homebrew 的 libuv/OpenSSL/ICU，拷到律师电脑上起不来）
 * 或任何未经核对的来源；与 Windows 的 node.exe 一样，只认 nodejs.org 官方发布、按官方校验和与本仓库锁文件双重核验的二进制。
 * 官方 darwin 二进制带 OpenJS 基金会的 Developer ID 签名（含 hardened runtime 与 disable-library-validation 权限，
 * 可装载随包原生模块）；打包时 electron-builder 不重签它（electron-builder.yml mac.signIgnore），摘要因此与运行时清单一致。
 *
 * 核验：tarball sha256 必须与同版本官方 SHASUMS256.txt 一致，且与 scripts/mac-runtime.lock.json 已记录的摘要一致；
 * 解出的 bin/node 摘要同样锁定（为空时写入，首次信任，提交前须评审）；并用 codesign 核对签名有效、团队标识为 OpenJS 基金会。
 * Node 版本须与 scripts/win-runtime.lock.json 相同（两个平台的随包运行时同一版本）。只访问锁文件中的官方地址。
 *
 * 用法：node scripts/fetch-mac-runtime.mjs [--target darwin-arm64]
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const lockPath = join(root, "scripts/mac-runtime.lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const winLock = JSON.parse(readFileSync(join(root, "scripts/win-runtime.lock.json"), "utf8"));
const i = process.argv.indexOf("--target");
const target = i >= 0 ? process.argv[i + 1] : "darwin-arm64";
const cache = join(root, ".cache/mac-runtime");
/** OpenJS 基金会的 Apple 开发者团队标识（官方 macOS 安装包与二进制的签名者）。 */
const OPENJS_TEAM_ID = "HX7739G8FX";

if (lock.node.version !== winLock.node.version) throw new Error(`mac-runtime.lock.json 的 Node 版本 ${lock.node.version} 与 win-runtime.lock.json 的 ${winLock.node.version} 不一致`);
const ent = lock.node[target];
if (!ent || !ent.tarUrl) throw new Error(`mac-runtime.lock.json 没有 ${target}`);
if (!ent.tarUrl.startsWith(`https://nodejs.org/dist/${lock.node.version}/`) || !lock.node.shasumsUrl.startsWith(`https://nodejs.org/dist/${lock.node.version}/`)) {
  throw new Error("mac-runtime.lock.json 只允许 nodejs.org 官方同版本地址");
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
async function get(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const tarName = ent.tarUrl.split("/").pop();
const tar = await get(ent.tarUrl);
const tarSha = sha256(tar);
const line = (await get(lock.node.shasumsUrl)).toString("utf8").split("\n").find((l) => l.trim().endsWith(`  ${tarName}`));
const official = line ? line.split(/\s+/)[0] : null;
if (!official || official !== tarSha) throw new Error(`${tarName}：摘要与官方校验和不符（官方 ${official ?? "缺失"}，实得 ${tarSha}）`);
if (ent.tarSha256 && ent.tarSha256 !== tarSha) throw new Error(`${tarName}：摘要与锁文件不符`);

mkdirSync(cache, { recursive: true });
const tmp = mkdtempSync(join(cache, "node-"));
try {
  writeFileSync(join(tmp, "a.tgz"), tar);
  // 只解出 bin/node（操作数相对 + cwd，同 fetch-win-runtime.mjs）
  const member = `${tarName.replace(/\.tar\.gz$/, "")}/bin/node`;
  execFileSync("tar", ["-xzf", "a.tgz", member], { cwd: tmp });
  const bin = join(tmp, member);
  const binSha = sha256(readFileSync(bin));
  if (ent.binSha256 && ent.binSha256 !== binSha) throw new Error(`${target}：bin/node 摘要与锁文件不符`);
  // 签名核对（只在 macOS 上能做）：签名有效且是 OpenJS 基金会的——随包后不重签，律师电脑上按这份签名装载
  if (process.platform === "darwin") {
    execFileSync("codesign", ["--verify", "--strict", bin], { stdio: "pipe" });
    // codesign -dv 的详情写在 stderr
    const detail = spawnSync("codesign", ["-dv", bin], { encoding: "utf8" }).stderr ?? "";
    if (!detail.includes(`TeamIdentifier=${OPENJS_TEAM_ID}`)) throw new Error(`${target}：bin/node 不是 OpenJS 基金会签名（期望团队 ${OPENJS_TEAM_ID}）`);
  }
  const destDir = join(cache, `node-${lock.node.version}-${target}`);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  cpSync(bin, join(destDir, "node"));
  chmodSync(join(destDir, "node"), 0o755);
  ent.tarSha256 = tarSha;
  ent.binSha256 = binSha;
  console.log(`[fetch-mac-runtime] node ${lock.node.version} ${target}：bin/node sha256=${binSha}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
console.log("[fetch-mac-runtime] 完成；锁文件已更新（若新增摘要请评审后提交）");
