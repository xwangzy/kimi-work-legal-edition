#!/usr/bin/env node
/**
 * 共享中继（同事之间同步，第 73 批 v1.8.0，D-309）的配置：按已在运行的控制面、网关配置写 /etc/kwl/relay.json，
 * 并按签名服务配置补出中继受众的席位公钥表。relay-setup.sh 调用；可重复执行（幂等）。
 *
 *   node deploy/scripts/relay-config.mjs --app /opt/kwl/app --etc /etc/kwl [--port 8446] [--cp-url https://cp.kwl.example.com:8443]
 *
 * relay.json 不在时从 deploy/config/relay.example.json 起，填：
 * - tls：与控制面同一张证书（control-plane.json 的 tls.cert_file / key_file）——同一主机名、钉住集相同，客户端 relay_pins = 控制面的钉住集；
 * - service_secret_file、data_dir：与控制面相同（中继数据在 <data_dir>/relay）；
 * - control_plane：取 gateway.json 的 control_plane（url、keys_file、connect_address），没有网关配置时用 --cp-url；
 * - listen.port：--port，缺省 8446。
 * relay.json 已在时只改与地址有关的两项（control_plane.url、connect_address，与 ip-config.mjs 同一口径）和给了的 --port，别的保留现值。
 * 中继受众席位公钥表（seat_keys_file，缺省 <etc>/public/seat-relay-public-keys.json）不在时，从 cp-signer.json 的
 * keys.seat_audiences.relay（密钥编号 + 私钥文件）导出公钥写出（只写公钥）；签名服务不在本机、或没有中继受众的密钥时停下并写明怎么补。
 * 最后一行打印 relay_base=<客户端 release.json 的中继地址>，供 relay-setup.sh 读取。
 */
import { chownSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { join } from "node:path";

const args = process.argv.slice(2);
const one = (n) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? null : (args[i + 1] ?? "");
};
const die = (m, code = 2) => {
  console.error(`[relay-config] ✖ ${m}`);
  process.exit(code);
};
const say = (m) => console.log(`[relay-config] ${m}`);
const app = one("app") ?? "/opt/kwl/app";
const etc = one("etc") ?? "/etc/kwl";
const portArg = one("port");
const cpUrlArg = one("cp-url");
if (portArg !== null && !/^\d{1,5}$/.test(portArg)) die("--port 须为端口号");
const port = portArg === null ? null : Number(portArg);
if (port !== null && (port < 1 || port > 65535)) die("--port 须为 1～65535");
if (cpUrlArg !== null && !/^https:\/\/[^/\s]+$/.test(cpUrlArg)) die("--cp-url 须为 https://<主机>[:端口]（不带路径）");

const readJson = (f, what) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    die(`${what}（${f}）读不出或不是 JSON`);
  }
};
const save = (file, obj, mode) => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode });
  // 沿用原文件的属主与属组（root:kwl）：写临时文件再改名会变成 root:root，服务用户 kwl 读不到配置（同 ip-config.mjs）
  if (existsSync(file)) {
    const st = statSync(file);
    try {
      chownSync(tmp, st.uid, st.gid);
    } catch {}
  }
  renameSync(tmp, file);
};

// 控制面配置是底稿：没有它说明这台机器还没部署控制面（多机时在控制面那台执行，或给全参数后手改）
const cpFile = join(etc, "control-plane.json");
if (!existsSync(cpFile)) die(`${cpFile} 不在：先按部署手册第 6 节写好控制面配置，再开通中继`);
const cp = readJson(cpFile, "控制面配置");
const gwFile = join(etc, "gateway.json");
const gw = existsSync(gwFile) ? readJson(gwFile, "网关配置") : null;

const relayFile = join(etc, "relay.json");
const fresh = !existsSync(relayFile);
const relay = fresh ? readJson(join(app, "deploy/config/relay.example.json"), "中继配置样例") : readJson(relayFile, "中继配置");
if (relay.role !== "relay") die(`${relayFile} 的 role 不是 relay`);

const cpUrl = cpUrlArg ?? gw?.control_plane?.url ?? (fresh ? null : relay.control_plane?.url);
if (!cpUrl || /kwl\.example\.com/.test(cpUrl)) die("不知道控制面地址：网关配置里没有 control_plane.url，请加 --cp-url https://<控制面主机>:8443");
relay.listen = { host: relay.listen?.host ?? "0.0.0.0", port: port ?? (fresh ? 8446 : (relay.listen?.port ?? 8446)) };
relay.control_plane = { ...(relay.control_plane ?? {}), url: cpUrl, keys_file: gw?.control_plane?.keys_file ?? relay.control_plane?.keys_file ?? join(etc, "public/cp-public-keys.json") };
if (gw?.control_plane?.connect_address) relay.control_plane.connect_address = gw.control_plane.connect_address;
else if (gw) delete relay.control_plane.connect_address;
if (fresh) {
  // 证书复用控制面：同一主机名、同一把私钥，客户端的中继钉住集与控制面相同（续期、热换跟控制面一起走）
  if (!cp.tls?.cert_file || !cp.tls?.key_file) die("控制面配置没有 tls.cert_file / key_file（生产入口只接受 HTTPS）");
  relay.tls = { cert_file: cp.tls.cert_file, key_file: cp.tls.key_file };
  if (cp.service_secret_file) relay.service_secret_file = cp.service_secret_file;
  if (cp.data_dir) relay.data_dir = cp.data_dir;
  relay.seat_keys_file = join(etc, "public/seat-relay-public-keys.json");
}
if (relay.listen.port === Number(cp.listen?.port ?? 8443)) die(`中继端口 ${relay.listen.port} 与控制面相同：换一个（标准为 8446）`);

// 中继受众的席位公钥表：只放 seat-relay-* 的公钥（生产入口拒绝别的受众的密钥）
const seatFile = String(relay.seat_keys_file ?? "");
if (!seatFile) die("中继配置缺 seat_keys_file");
if (existsSync(seatFile)) {
  const m = readJson(seatFile, "中继席位公钥表");
  const kids = Object.keys(m ?? {});
  if (kids.length === 0 || kids.some((k) => !/^seat-relay-/.test(k))) die(`${seatFile} 里须只有 seat-relay-… 的公钥（现有：${kids.join("、") || "空"}）`);
  say(`中继席位公钥表已在：${seatFile}（${kids.join("、")}）`);
} else {
  const sFile = join(etc, "cp-signer.json");
  const hint = `把 cloud-init-secrets 输出的 public/seat-relay-public-keys.json 拷到 ${seatFile}（0644）后重跑`;
  if (!existsSync(sFile)) die(`签名服务配置 ${sFile} 不在本机，导不出中继席位公钥：${hint}`, 3);
  const rk = readJson(sFile, "签名服务配置").keys?.seat_audiences?.relay;
  if (!rk?.kid || !rk?.private_key_file) die(`签名服务配置没有中继受众的席位密钥（keys.seat_audiences.relay）：中继凭据会退回通用席位密钥签发、中继不认。按部署手册第 5 节装 seat-relay.pem 并把 signer-keys.json 的 seat_audiences.relay 写进 ${sFile}，重启 kwl@cp-signer 后重跑`, 3);
  if (!/^seat-relay-/.test(rk.kid)) die(`中继受众的密钥编号 ${rk.kid} 不是 seat-relay-… 形式`, 3);
  let pem;
  try {
    pem = createPublicKey(readFileSync(rk.private_key_file, "utf8")).export({ format: "pem", type: "spki" }).toString();
  } catch {
    die(`读不出 ${rk.private_key_file}（中继受众的席位私钥）：${hint}`, 3);
  }
  save(seatFile, { [rk.kid]: pem }, 0o644);
  say(`已从签名服务配置导出中继席位公钥：${seatFile}（${rk.kid}；只含公钥）`);
}

save(relayFile, relay, 0o640);
say(`${relayFile}：端口 ${relay.listen.port}，证书 ${relay.tls?.cert_file}，控制面 ${relay.control_plane.url}${relay.control_plane.connect_address ? `（连 ${relay.control_plane.connect_address}）` : ""}${fresh ? "（新建）" : "（已有配置，只改地址与端口）"}`);
// 中继地址与控制面同一主机名（证书复用），端口换成中继的
console.log(`relay_base=https://${new URL(relay.control_plane.url).hostname}:${relay.listen.port}`);
