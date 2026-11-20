/**
 * 签名的云端地址配置（偏离 D-213）：不重装客户端就把云端从一个地址迁到另一个地址（例如 公网 IP → 正式域名、换证书钉住）。
 *
 * 客户端规则见 apps/desktop/electron/release-config.cjs 的 applyEndpointProfile：安装包的 release.json 带 endpoint_profile（部署标识 +
 * 验签公钥）才启用；本机数据目录下的 cloud-endpoints.json 必须由对应私钥签名、部署标识一致、控制面/网关/检索三项齐全、每项至少两把钉住；
 * 只能改地址、钉住与（测试构建的）私有 CA，信任锚（控制面签名公钥、席位公钥、更新与内容公钥）只随安装包。
 *
 * 用法：
 *   node scripts/endpoint-profile.mjs gen-key --dir <离线目录> [--kid ep-1]
 *       生成 Ed25519 密钥对：<kid>.key.pem（私钥，0600，离线保管、不入库、不上服务器）与 <kid>.pub.pem（写进发行说明文件 endpoint_profile_key_file）。
 *   node scripts/endpoint-profile.mjs sign --spec <地址说明.json> --key <kid>.key.pem --kid ep-1 --deployment demo-ip --seq 2 --out cloud-endpoints.json [--offline]
 *       地址说明的格式同 make-release-config 的说明文件（*_base、pins、backup_pins、cloud_ca_file；"cloud_ca": null 表示改回只认公共根）。
 *       在线模式连上每个地址取当前钉住值（按给定 CA 或公共根完整校验证书）。
 *   node scripts/endpoint-profile.mjs verify --release apps/desktop/electron/release.json --profile cloud-endpoints.json
 *       用客户端同一份代码核验并打印生效后的地址。
 *
 * 放到律师电脑上：macOS  ~/Library/Application Support/KimiWorkLegal/cloud-endpoints.json
 *                Windows %LOCALAPPDATA%\KimiWorkLegal\cloud-endpoints.json        —— 然后重启应用。
 */
import { createPrivateKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPins, readCaBundle, UPSTREAMS } from "./lib/release-pins.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const { loadReleaseConfig, applyEndpointProfile } = require(join(root, "apps/desktop/electron/release-config.cjs"));
const [cmd, ...argv] = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const fail = (m) => {
  console.error(`[endpoint-profile] ${m}`);
  process.exit(1);
};
const KID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

if (cmd === "gen-key") {
  const dir = opt("--dir") ?? fail("缺 --dir");
  const kid = opt("--kid", "ep-1");
  if (!KID_RE.test(kid)) fail("kid 只许字母数字与 _.-");
  const priv = join(dir, `${kid}.key.pem`);
  const pub = join(dir, `${kid}.pub.pem`);
  if (existsSync(priv) || existsSync(pub)) fail(`${priv} 或 ${pub} 已存在，不覆盖`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }));
  console.log(`[endpoint-profile] 已生成 ${pub}（写进发行说明 endpoint_profile_key_file）；私钥 ${priv} 离线保管，不入库、不上服务器`);
} else if (cmd === "sign") {
  const spec = JSON.parse(readFileSync(opt("--spec") ?? fail("缺 --spec"), "utf8"));
  const keyFile = opt("--key") ?? fail("缺 --key");
  const kid = opt("--kid", "ep-1");
  const deployment = opt("--deployment") ?? fail("缺 --deployment（与 release.json 的 endpoint_profile.deployment 一致）");
  const seq = Number(opt("--seq") ?? fail("缺 --seq（正整数，每次签发递增）"));
  const out = opt("--out") ?? fail("缺 --out");
  if (!KID_RE.test(kid)) fail("kid 只许字母数字与 _.-");
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(deployment)) fail("deployment 只许小写字母数字与连字符");
  if (!Number.isInteger(seq) || seq < 1) fail("seq 须为正整数");
  const caFile = spec.cloud_ca_file;
  const caPem = caFile ? readCaBundle(caFile, fail) : undefined;
  const got = await collectPins(spec, { names: UPSTREAMS, offline: argv.includes("--offline"), caPem, fail, log: (m) => console.log(`[endpoint-profile] ${m}`) });
  for (const k of ["control_plane", "gateway", "search"]) if (!got[k]) fail(`缺少 ${k}_base（控制面、网关、检索三项必填）`);
  const payload = { kind: "kwl-endpoints", deployment, seq, issued_at: new Date().toISOString() };
  for (const [name, { base, pins }] of Object.entries(got)) {
    payload[`${name}_base`] = base;
    payload[`${name}_pins`] = pins;
  }
  if (caPem) payload.cloud_ca_pem = caPem;
  else if (spec.cloud_ca === null) payload.cloud_ca_pem = null;
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const sig = edSign(null, body, createPrivateKey(readFileSync(keyFile, "utf8")));
  writeFileSync(out, `${JSON.stringify({ v: 1, kid, payload: body.toString("base64"), sig: sig.toString("base64") }, null, 2)}\n`);
  console.log(`[endpoint-profile] 已写 ${out}（部署 ${deployment}，序号 ${seq}，${Object.keys(got).length} 个上游${caPem ? "，含私有 CA" : ""}）`);
} else if (cmd === "verify") {
  const rel = loadReleaseConfig(opt("--release") ?? fail("缺 --release"));
  if (rel.problems.length) fail(`release.json 本身有问题：${rel.problems.join("；")}`);
  if (!rel.endpointProfile) fail("这份 release.json 没有 endpoint_profile：客户端不会读地址配置");
  const r = applyEndpointProfile(rel, opt("--profile") ?? fail("缺 --profile"));
  if (!r.applied) fail(r.problems.length ? r.problems.join("；") : "没有读到地址配置");
  console.log(`[endpoint-profile] 核验通过：部署 ${r.applied.deployment}，序号 ${r.applied.seq}`);
  for (const k of ["ZR_CONTROL_PLANE_BASE", "ZR_GATEWAY_BASE", "ZR_SEARCH_BASE", "ZR_DIST_BASE", "ZR_SUPPORT_BASE", "ZR_NOTIFY_BASE", "ZR_RELAY_BASE"]) {
    if (r.release.env[k]) console.log(`  ${k} = ${r.release.env[k]}`);
  }
  console.log(`  私有 CA：${r.release.env.ZR_CLOUD_CA_PEM ? "有（只对中软上游生效）" : "无（只认公共根）"}`);
} else {
  console.error("用法：node scripts/endpoint-profile.mjs gen-key|sign|verify …（见文件头）");
  process.exit(2);
}
