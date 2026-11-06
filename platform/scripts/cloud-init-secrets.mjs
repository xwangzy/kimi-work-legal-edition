/**
 * 云端首次部署的密钥与口令文件（第 37 批，配合 docs/部署-云端控制台与桌面端对接.md）。
 *
 * 一次生成云端各服务要读的全部密钥文件，格式与 scripts/cloud-serve.mjs 的核对口径一致（随机 32 字节十六进制、Ed25519 PKCS#8、
 * 按用途与环境命名的密钥编号 cp-<环境>-<编号> / seat-<环境>-<编号> / seat-support|notify|relay-<环境>-<编号>）：
 *
 *   secrets/   —— 私密，权限 0600，只挂到需要的服务（见输出的“放到哪里”）
 *     service-secret            服务间凭据（控制面、网关、检索、分发、支持、通知、中继共用）
 *     cp-state.key              控制面状态封装密钥
 *     cp-code-pepper.key        开通码 HMAC 胡椒
 *     support-meter.key         支持服务计量密钥
 *     metrics-token             指标监听令牌（监听在回环以外时用）
 *     cp-envelope.pem           控制面文档签名私钥（只给签名服务）
 *     cp-envelope-next.pem      预置的下一把（轮换用；离线保管，不部署）
 *     seat.pem / seat-support.pem / seat-notify.pem / seat-relay.pem   席位令牌签名私钥（只给签名服务）
 *   public/    —— 公开，可随配置分发
 *     cp-public-keys.json       { kid: PEM }，控制面文档签名公钥（当前 + 下一把）：各服务 control_plane.keys_file、release.json control_plane_keys
 *     seat-public-keys.json     通用席位公钥：网关、检索、分发的 seat_keys_file，release.json seat_keys
 *     seat-support|notify|relay-public-keys.json   各受众的席位公钥：支持、通知、中继的 seat_keys_file
 *     signer-keys.json          签名服务配置 keys 段（kid 与私钥文件路径，路径按 --mount 改写）
 *
 * 用法：node scripts/cloud-init-secrets.mjs --env prod --out /secure/kwl-prod [--id 2611a] [--mount /run/secrets]
 * 已存在的目录不覆盖。生成后请把 secrets/ 放进密钥管理（KMS / 密钥管理服务挂载为只读文件），本机副本按公司规定销毁或离线保管。
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const env = opt("--env");
const outDir = opt("--out");
const now = new Date();
const id = opt("--id", `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}a`);
const mount = opt("--mount", "/run/secrets");
if (!/^(prod|stg|dev|test)$/.test(env ?? "") || !outDir || !/^[0-9a-z]{1,16}$/.test(id)) {
  console.error("用法：node scripts/cloud-init-secrets.mjs --env prod|stg|dev|test --out <目录> [--id 2611a] [--mount /run/secrets]");
  process.exit(2);
}
if (existsSync(outDir)) {
  console.error(`[cloud-init-secrets] ${outDir} 已存在：不覆盖（换一个目录，或先确认旧密钥已不再使用）`);
  process.exit(1);
}
const sec = join(outDir, "secrets");
const pub = join(outDir, "public");
mkdirSync(sec, { recursive: true, mode: 0o700 });
mkdirSync(pub, { recursive: true, mode: 0o755 });
const secret = (name, content) => writeFileSync(join(sec, name), content, { mode: 0o600, flag: "wx" });
const pubFile = (name, obj) => writeFileSync(join(pub, name), `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o644, flag: "wx" });
const hex32 = () => `${randomBytes(32).toString("hex")}\n`;

for (const f of ["service-secret", "cp-state.key", "cp-code-pepper.key", "support-meter.key", "metrics-token"]) secret(f, hex32());

const ed = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), pub: publicKey.export({ format: "pem", type: "spki" }).toString() };
};
const next = id.replace(/[0-9a-z]$/, (c) => (c === "z" ? "0" : c === "9" ? "a" : String.fromCharCode(c.charCodeAt(0) + 1)));
const env_ = ed();
const envNext = ed();
const seat = ed();
const aud = { support: ed(), notify: ed(), relay: ed() };
secret("cp-envelope.pem", env_.priv);
secret("cp-envelope-next.pem", envNext.priv);
secret("seat.pem", seat.priv);
for (const [k, v] of Object.entries(aud)) secret(`seat-${k}.pem`, v.priv);

const kid = { envelope: `cp-${env}-${id}`, envelopeNext: `cp-${env}-${next}`, seat: `seat-${env}-${id}` };
pubFile("cp-public-keys.json", { [kid.envelope]: env_.pub, [kid.envelopeNext]: envNext.pub });
pubFile("seat-public-keys.json", { [kid.seat]: seat.pub });
for (const [k, v] of Object.entries(aud)) pubFile(`seat-${k}-public-keys.json`, { [`seat-${k}-${env}-${id}`]: v.pub });
pubFile("signer-keys.json", {
  envelope: { kid: kid.envelope, private_key_file: `${mount}/cp-envelope.pem` },
  seat: { kid: kid.seat, private_key_file: `${mount}/seat.pem` },
  seat_audiences: Object.fromEntries(Object.keys(aud).map((k) => [k, { kid: `seat-${k}-${env}-${id}`, private_key_file: `${mount}/seat-${k}.pem` }])),
});

console.log(`[cloud-init-secrets] 已生成 → ${outDir}（环境 ${env}，密钥编号后缀 ${id}；下一把控制面密钥 ${kid.envelopeNext} 离线保管）
放到哪里：
  签名服务 cp-signer   secrets/cp-envelope.pem、seat*.pem（keys 段见 public/signer-keys.json）
  控制面 control-plane secrets/service-secret、cp-state.key、cp-code-pepper.key
  网关 / 检索 / 分发   secrets/service-secret；public/cp-public-keys.json、seat-public-keys.json
  支持 support         secrets/service-secret、support-meter.key；public/cp-public-keys.json、seat-support-public-keys.json
  通知 / 中继          secrets/service-secret；public/cp-public-keys.json、seat-notify|relay-public-keys.json
  桌面端 release.json  public/cp-public-keys.json（control_plane_keys）、seat-public-keys.json（seat_keys）——scripts/make-release-config.mjs 读取
不要把 secrets/ 提交进仓库或发到聊天工具。`);
