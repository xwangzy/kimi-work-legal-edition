/**
 * 内容发布（离线签名，v9.2 §5.1 S6/S7）：把法规库包或方法模板包放进分发存储，并签发通道清单 latest.json。
 *
 * 用法：
 *   法规库：node scripts/dist-publish.mjs --dir <存储根> --kind lawdb --channel stable --seq <N> [--full <lawdb.sqlite>] [--incr <增量.sqlite> …]
 *   方法模板：node scripts/dist-publish.mjs --dir <存储根> --kind skills --channel stable --seq <N> --skills <content/skills/dist>
 *   公共选项：[--staging 0–100（缺省 100）] [--days 有效天数（缺省 30，≤ 90）] [--revoke 3,4] [--key <内容签名私钥 JSON>]
 *            [--bundled-out <路径>]（另写一份同格式的随包信封 <kind>.release.json，供安装包给随包内容定 seq）
 *
 * - 包自身的签名不变（法规库 sidecar 清单、方法模板清单）；通道清单另由内容签名私钥签名（同一内容签名域，kid = 公钥指纹）。
 * - 存储里旧版本的包文件保留（增量链要用）；同名文件内容不同即拒绝覆盖（包文件按名不可变）。
 * - seq 必须大于存储里现有清单的 seq、单次跳幅 ≤ 1000（复核 S8A-04：同一 seq 只对应一份内容，误发超大 seq 会永久锁死通道）；
 *   确需重发时显式 --force-reseq。撤回序号从现有清单继承并合并（S8A-15：撤回必须在之后每一份清单里持续列出）。
 * - 发布前用内容签名公钥核验每个包自身的签名（S8A-15：错包不推到线上才发现）。
 * - 开发形态缺省用 content/keys/content-signing-dev.json；正式私钥在离线签名机或 HSM，不进仓库（Y2 §3.6）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { sha256B64, signBytes, verifyBytes } = await import("../packages/keys/src/index.ts");
const { signChannelManifest, manifestShapeProblem, skillsVersionOf, contentKeyId, MAX_MANIFEST_DAYS } = await import("../packages/content-dist/src/index.ts");

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
  options: {
    dir: { type: "string" },
    kind: { type: "string" },
    channel: { type: "string", default: "stable" },
    seq: { type: "string" },
    full: { type: "string" },
    incr: { type: "string", multiple: true, default: [] },
    skills: { type: "string" },
    staging: { type: "string", default: "100" },
    days: { type: "string", default: "30" },
    revoke: { type: "string", default: "" },
    "force-reseq": { type: "boolean", default: false },
    key: { type: "string" },
    "bundled-out": { type: "string" },
    now: { type: "string" },
  },
});

function fail(msg) {
  console.error(`[dist-publish] ${msg}`);
  process.exit(2);
}
if (!a.dir || !a.kind || !a.seq) fail("须给出 --dir、--kind、--seq");
if (!["lawdb", "skills"].includes(a.kind)) fail("--kind 须为 lawdb 或 skills");
const seq = Number(a.seq);
const days = Number(a.days);
if (!(days > 0 && days <= MAX_MANIFEST_DAYS)) fail(`--days 须在 1–${MAX_MANIFEST_DAYS}`);
const keyFile = a.key ?? join(here, "..", "content", "keys", "content-signing-dev.json");
const key = JSON.parse(readFileSync(keyFile, "utf8"));
if (!key.privateKeyPem || !key.publicKeyPem) fail("签名私钥文件须含 privateKeyPem 与 publicKeyPem");

const channelDir = join(a.dir, a.kind, a.channel);
const previous = existsSync(join(channelDir, "latest.json")) ? JSON.parse(readFileSync(join(channelDir, "latest.json"), "utf8")).manifest : null;
if (!Number.isInteger(seq) || seq < 1) fail("--seq 须为正整数");
if (previous && !a["force-reseq"]) {
  if (seq <= previous.seq) fail(`--seq ${seq} 不大于现有清单的 ${previous.seq}（同一 seq 只能对应一份内容；确需重发用 --force-reseq）`);
  if (seq - previous.seq > 1000) fail(`--seq 跳幅 ${seq - previous.seq} 超过 1000（误发超大 seq 会永久锁死通道）`);
}
/** 包自身签名核验（法规库 sidecar 与方法模板清单都签 content_sha256）。 */
function checkPackageSignature(m, what) {
  if (m.signer_key_id !== contentKeyId(key.publicKeyPem) || !verifyBytes(key.publicKeyPem, new TextEncoder().encode(m.content_sha256), m.signature)) fail(`${what} 的签名与本次发布的内容签名公钥不符`);
}
const filesDir = join(channelDir, "files");
mkdirSync(filesDir, { recursive: true });

/** 放进存储：同名同内容复用，同名不同内容拒绝（包文件按名不可变）。 */
function put(name, bytes) {
  const to = join(filesDir, name);
  if (existsSync(to)) {
    if (sha256B64(readFileSync(to)) !== sha256B64(bytes)) fail(`存储里已有同名但内容不同的文件：${name}`);
  } else writeFileSync(to, bytes);
  return { file: name, size: bytes.byteLength, sha256: sha256B64(bytes) };
}

const sidecar = (f) => (f.endsWith(".sqlite") ? `${f.slice(0, -".sqlite".length)}.manifest.json` : `${f}.manifest.json`);
const safe = (v) => String(v).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);

let version;
let contentSha;
const packages = [];
if (a.kind === "lawdb") {
  if (!a.full && a.incr.length === 0) fail("法规库须给出 --full 或 --incr");
  const add = (file, type) => {
    const mf = JSON.parse(readFileSync(sidecar(file), "utf8"));
    if (mf.kind !== type) fail(`${file} 的清单 kind 是 ${mf.kind}，不是 ${type}`);
    checkPackageSignature(mf, file);
    const v = safe(mf.package_version);
    const name = type === "full" ? `lawdb-${v}` : `lawdb-incr-${safe(mf.base_version)}-${v}`;
    const db = put(`${name}.sqlite`, readFileSync(file));
    const man = put(`${name}.manifest.json`, readFileSync(sidecar(file)));
    packages.push({
      type,
      version: mf.package_version,
      ...(type === "incremental" ? { base_version: mf.base_version } : {}),
      ...db,
      manifest_file: man.file,
      manifest_size: man.size,
      manifest_sha256: man.sha256,
    });
    return mf;
  };
  let last = null;
  for (const f of a.incr) last = add(f, "incremental");
  if (a.full) last = add(a.full, "full");
  version = last.package_version;
  contentSha = last.content_sha256;
} else {
  if (!a.skills) fail("方法模板须给出 --skills <content/skills/dist>");
  const manifestText = readFileSync(join(a.skills, "skills.manifest.json"), "utf8");
  const m = JSON.parse(manifestText);
  const root = join(a.skills, "trusted");
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(root, p).split(sep).join("/"), data: readFileSync(p).toString("base64") });
    }
  };
  walk(root);
  checkPackageSignature(m, "方法模板清单");
  contentSha = m.content_sha256;
  version = skillsVersionOf(contentSha);
  const pack = Buffer.from(JSON.stringify({ schema: "kwl-skills-pack/1", manifest: manifestText, files }));
  packages.push({ type: "full", version, ...put(`skills-${version}.json`, pack) });
}

const now = a.now ? Date.parse(a.now) : Date.now();
const manifest = {
  schema: "kwl-dist/1",
  kind: a.kind,
  channel: a.channel,
  seq,
  version,
  content_sha256: contentSha,
  issued_at: new Date(now).toISOString(),
  expires_at: new Date(now + days * 86_400_000).toISOString(),
  staging_percent: Number(a.staging),
  revoked_seqs: [...new Set([...(previous?.revoked_seqs ?? []), ...(a.revoke ? a.revoke.split(",").map((x) => Number(x.trim())).filter((x) => x > 0) : [])])].filter((x) => x !== seq).sort((x, y) => x - y),
  packages,
};
const bad = manifestShapeProblem(manifest);
if (bad) fail(`通道清单不合格：${bad}`);
const envelope = signChannelManifest(manifest, (bytes) => signBytes(key.privateKeyPem, bytes), key.publicKeyPem);
writeFileSync(join(channelDir, "latest.json"), JSON.stringify(envelope, null, 2) + "\n");
if (a["bundled-out"]) writeFileSync(a["bundled-out"], JSON.stringify(envelope, null, 2) + "\n");
console.log(`[dist-publish] ${a.kind}/${a.channel} seq=${seq} version=${version} 包 ${packages.length} 个 → ${relative(process.cwd(), channelDir) || channelDir}`);
