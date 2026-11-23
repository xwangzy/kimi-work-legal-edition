/**
 * 生产签名内容包（第 60 批安全加固 H2）：在持有生产内容签名私钥的机器上构建并签名四类随包内容，打成一个 tar.gz 交给 Windows CI。
 *
 * 为什么：正式安装包只认生产内容签名公钥（开发公钥在正式包里拒载）。Windows 安装包在 GitHub 运行器上原生构建，
 * 私钥不能上传 CI——所以在本机签好内容、只把签好的产物（不含任何秘密）与公钥按摘要交给 CI（预发布附件 + 工作流输入里的 sha256）。
 *
 * 用法（platform/ 下）：
 *   KWL_CONTENT_SIGNING_KEY_FILE=<私钥 JSON> node scripts/pack-signed-content.mjs --out <文件.tar.gz>
 * 产物内容（相对 platform/）：content/lawdb/dist/lawdb.sqlite 与 lawdb.manifest.json、content/skills/dist/**、
 *   content/tool-manifest/dist/**、content/agent-profile/dist/**、content-signing.pub.json（公钥）、signed-content.json（逐文件 sha256 与签名者）。
 * CI 侧：核对 tar.gz 的 sha256 → 解到仓库根 → KWL_CONTENT_SIGNING_PUB_FILE=content-signing.pub.json
 *   node scripts/package-desktop.mjs --prebuilt-content …（演示增量样例 dist/incr 不打包：它不得用生产密钥签名）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { keyFp, releaseContentSigningKey } from "./lib/dev-content-keys.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : undefined;
if (!out || !out.endsWith(".tar.gz")) {
  console.error("用法：KWL_CONTENT_SIGNING_KEY_FILE=<私钥 JSON> node scripts/pack-signed-content.mjs --out <文件.tar.gz>");
  process.exit(2);
}
const key = releaseContentSigningKey(root);
if (!key) {
  console.error("[pack-signed-content] 须设 KWL_CONTENT_SIGNING_KEY_FILE（生产内容签名私钥）");
  process.exit(2);
}
const run = (s) => execFileSync("npm", ["run", s], { cwd: root, stdio: "inherit", env: process.env });
for (const s of ["build:lawdb", "build:agent-profile", "build:tool-manifest", "build:skills"]) run(s);

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = [
  join(root, "content/lawdb/dist/lawdb.sqlite"),
  join(root, "content/lawdb/dist/lawdb.manifest.json"),
  ...walk(join(root, "content/skills/dist")),
  ...walk(join(root, "content/tool-manifest/dist")),
  ...walk(join(root, "content/agent-profile/dist")),
].map((f) => relative(root, f).split("\\").join("/"));
for (const f of files) if (!existsSync(join(root, f))) throw new Error(`缺少 ${f}`);

// 每个签名清单的签名者都必须是这把生产公钥（防止把旧的开发签名产物混进来）
const signer = keyFp(key.publicKeyPem);
const { signerKeyId } = await import("@zr-legal/lawdb");
const wantKid = signerKeyId(key.publicKeyPem);
for (const f of files.filter((x) => /manifest\.json$/.test(x))) {
  const m = JSON.parse(readFileSync(join(root, f), "utf8"));
  const kid = m.signer_key_id ?? m.signerKeyId;
  if (kid !== undefined && kid !== wantKid) throw new Error(`${f} 的签名者 ${kid} 不是生产内容签名密钥 ${wantKid}`);
}

writeFileSync(join(root, "content-signing.pub.json"), JSON.stringify({ _comment: "生产内容签名公钥（第 60 批 H2；随包内置）", publicKeyPem: key.publicKeyPem }, null, 2));
const index = {
  format: "kwl-signed-content/1",
  built_at: new Date().toISOString(),
  signer_fp_sha256: signer,
  signer_key_id: wantKid,
  files: Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(join(root, f))).digest("hex")])),
};
writeFileSync(join(root, "signed-content.json"), `${JSON.stringify(index, null, 2)}\n`);
const listFile = join(mkdtempSync(join(tmpdir(), "kwl-pack-")), "files.txt");
writeFileSync(listFile, ["content-signing.pub.json", "signed-content.json", ...files].join("\n"));
execFileSync("tar", ["-czf", out, "-C", root, "-T", listFile], { stdio: "inherit" });
rmSync(join(root, "content-signing.pub.json"));
rmSync(join(root, "signed-content.json"));
const sha = createHash("sha256").update(readFileSync(out)).digest("hex");
console.log(`[pack-signed-content] ${files.length} 个文件，签名者 ${wantKid} → ${out}\n  sha256 ${sha}`);
