/**
 * 第 73 批（v1.8.0，契约 1.2，D-309）：共享中继纳入标准部署——配置样例、relay-config.mjs（relay-setup.sh 调用）、ip-config.mjs、交给客户端的说明文件样例。
 * 在临时目录里按真实脚本走一遍（不需要 root、不起服务）；monorepo（cloud-repo/template/deploy）与独立云端仓库（deploy/）两种目录布局都能跑。
 *
 * D1 样例：relay.example.json 端口 8446、证书与控制面样例同一张、只信中继受众席位公钥；client-release-spec 样例的 relay_base 与控制面同主机、备用钉住相同；
 * D2 relay-config：从控制面 / 网关 / 签名服务配置生成 relay.json（证书、服务间凭据、数据目录取控制面的，控制面地址与 connect_address 取网关的），
 *    从签名服务配置的 seat_audiences.relay 私钥导出只含公钥的中继席位公钥表；幂等；--port 只改端口；最后一行打印 relay_base；
 * D3 relay-config 拒绝：签名服务没有中继受众的密钥（退出 3，写明怎么补）、公钥表里混了别的受众（退出 2）、端口与控制面相同（退出 2）；
 * D4 ip-config：纯公网 IP 部署同时写 relay.json 的控制面地址与 connect_address（不在时从样例新建）；
 * D5 部署脚本语法（bash -n）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const deploy = existsSync(join(root, "deploy/scripts/relay-config.mjs")) ? join(root, "deploy") : join(root, "cloud-repo/template/deploy");
const IP = "203.0.113.20";
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));

/** 假的 /opt/kwl/app（只放样例配置）与 /etc/kwl（控制面、网关、签名服务配置；签名服务的中继受众私钥放在临时 secrets 里）。 */
function fixture(o: { relayAudience?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kwl-b73relay-"));
  const app = join(dir, "app");
  mkdirSync(join(app, "deploy"), { recursive: true });
  cpSync(join(deploy, "config"), join(app, "deploy/config"), { recursive: true });
  const etc = join(dir, "etc");
  mkdirSync(join(etc, "public"), { recursive: true });
  mkdirSync(join(etc, "secrets"), { recursive: true });
  const cp = json(join(deploy, "config/control-plane.example.json"));
  writeFileSync(join(etc, "control-plane.json"), JSON.stringify(cp));
  const gw = json(join(deploy, "config/gateway.example.json"));
  gw.control_plane.url = `https://${IP}:8443`;
  gw.control_plane.connect_address = "127.0.0.1";
  writeFileSync(join(etc, "gateway.json"), JSON.stringify(gw));
  const k = generateKeyPairSync("ed25519");
  const priv = join(etc, "secrets/seat-relay.pem");
  writeFileSync(priv, k.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600 });
  const keys: Record<string, unknown> = { envelope: { kid: "cp-stg-2611a", private_key_file: "/x" }, seat: { kid: "seat-stg-2611a", private_key_file: "/x" } };
  if (o.relayAudience !== false) keys.seat_audiences = { relay: { kid: "seat-relay-stg-2611a", private_key_file: priv } };
  writeFileSync(join(etc, "cp-signer.json"), JSON.stringify({ role: "cp-signer", keys }));
  return { dir, app, etc, cp, gw, pub: k.publicKey.export({ format: "pem", type: "spki" }).toString() };
}
const relayConfig = (f: ReturnType<typeof fixture>, ...extra: string[]) => spawnSync(process.execPath, [join(deploy, "scripts/relay-config.mjs"), "--app", f.app, "--etc", f.etc, ...extra], { encoding: "utf8" });

test("D1：样例——中继 8446、与控制面同一张证书、只信中继受众席位公钥；客户端说明文件样例带 relay_base（与控制面同主机）与相同的备用钉住", () => {
  const r = json(join(deploy, "config/relay.example.json"));
  const cp = json(join(deploy, "config/control-plane.example.json"));
  const gw = json(join(deploy, "config/gateway.example.json"));
  assert.equal(r.role, "relay");
  assert.equal(r.listen.port, 8446);
  assert.deepEqual(r.tls, cp.tls, "证书复用控制面");
  assert.equal(r.service_secret_file, cp.service_secret_file);
  assert.equal(r.data_dir, cp.data_dir);
  assert.deepEqual(r.control_plane, gw.control_plane, "控制面订阅与网关一致");
  assert.match(r.seat_keys_file, /seat-relay-public-keys\.json$/);
  const spec = json(join(deploy, "client-release-spec.example.json"));
  assert.equal(new URL(spec.relay_base).hostname, new URL(spec.control_plane_base).hostname);
  assert.equal(new URL(spec.relay_base).port, "8446");
  assert.deepEqual(spec.relay_backup_pins, spec.control_plane_backup_pins);
});

test("D2：relay-config 从控制面 / 网关 / 签名服务配置生成 relay.json 与中继席位公钥表；幂等；--port 只改端口", () => {
  const f = fixture();
  const r = relayConfig(f);
  assert.equal(r.status, 0, r.stderr);
  const relay = json(join(f.etc, "relay.json"));
  assert.equal(relay.role, "relay");
  assert.deepEqual(relay.listen, { host: "0.0.0.0", port: 8446 });
  assert.deepEqual(relay.tls, { cert_file: f.cp.tls.cert_file, key_file: f.cp.tls.key_file });
  assert.equal(relay.service_secret_file, f.cp.service_secret_file);
  assert.equal(relay.data_dir, f.cp.data_dir);
  assert.deepEqual(relay.control_plane, { url: `https://${IP}:8443`, keys_file: f.gw.control_plane.keys_file, connect_address: "127.0.0.1" });
  assert.equal(relay.seat_keys_file, join(f.etc, "public/seat-relay-public-keys.json"));
  const seat = json(relay.seat_keys_file);
  assert.deepEqual(Object.keys(seat), ["seat-relay-stg-2611a"]);
  assert.equal(createPublicKey(seat["seat-relay-stg-2611a"]).export({ format: "pem", type: "spki" }).toString(), f.pub);
  assert.doesNotMatch(readFileSync(relay.seat_keys_file, "utf8"), /PRIVATE KEY/);
  assert.equal(r.stdout.trim().split("\n").at(-1), `relay_base=https://${IP}:8446`);
  // 再跑一次：内容不变
  const before = readFileSync(join(f.etc, "relay.json"), "utf8");
  const again = relayConfig(f);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(f.etc, "relay.json"), "utf8"), before);
  assert.match(again.stdout, /已有配置/);
  // --port：只改端口，别的保留（运维手改过的 ops 段也留着）
  writeFileSync(join(f.etc, "relay.json"), JSON.stringify({ ...relay, ops: { deployment: "stg" } }));
  const p = relayConfig(f, "--port", "9446");
  assert.equal(p.status, 0, p.stderr);
  const after = json(join(f.etc, "relay.json"));
  assert.equal(after.listen.port, 9446);
  assert.deepEqual(after.ops, { deployment: "stg" });
  assert.deepEqual(after.tls, relay.tls);
  assert.equal(p.stdout.trim().split("\n").at(-1), `relay_base=https://${IP}:9446`);
});

test("D3：拒绝——签名服务没有中继受众的密钥（退出 3）、公钥表混了别的受众、端口与控制面相同；不知道控制面地址", () => {
  const f = fixture({ relayAudience: false });
  const r = relayConfig(f);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stderr, /seat_audiences\.relay/);
  assert.ok(!existsSync(join(f.etc, "relay.json")), "失败时不写半份配置");
  // 公钥表里放了通用席位公钥
  const g = fixture();
  writeFileSync(join(g.etc, "public/seat-relay-public-keys.json"), JSON.stringify({ "seat-stg-2611a": g.pub }));
  const r2 = relayConfig(g);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /seat-relay-/);
  // 端口与控制面相同
  const h = fixture();
  const r3 = relayConfig(h, "--port", "8443");
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /与控制面相同/);
  // 网关配置还是样例地址、又没给 --cp-url
  const i = fixture();
  writeFileSync(join(i.etc, "gateway.json"), JSON.stringify(json(join(deploy, "config/gateway.example.json"))));
  const r4 = relayConfig(i);
  assert.equal(r4.status, 2);
  assert.match(r4.stderr, /--cp-url/);
  const r5 = relayConfig(i, "--cp-url", "https://cp.firm.example.cn:8443");
  assert.equal(r5.status, 0, r5.stderr);
  assert.equal(r5.stdout.trim().split("\n").at(-1), "relay_base=https://cp.firm.example.cn:8446");
});

test("D4：ip-config 纯公网 IP 部署同时写 relay.json（不在时从样例新建；--no-connect-address 去掉连接地址）", () => {
  const f = fixture();
  const run = (...extra: string[]) => spawnSync(process.execPath, [join(deploy, "scripts/ip-config.mjs"), "--app", f.app, "--etc", f.etc, "--public-ip", IP, ...extra], { encoding: "utf8" });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const relay = json(join(f.etc, "relay.json"));
  assert.equal(relay.control_plane.url, `https://${IP}:8443`);
  assert.equal(relay.control_plane.connect_address, "127.0.0.1");
  assert.equal(relay.listen.port, 8446);
  assert.deepEqual(relay.tls, json(join(deploy, "config/relay.example.json")).tls);
  const r2 = run("--no-connect-address");
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(json(join(f.etc, "relay.json")).control_plane.connect_address, undefined);
  // 之后 relay-config 接着用（地址取网关的，不改证书）。样例里的路径是真实的 /etc/kwl/…：用例把公钥表路径指到临时目录（生产上 --etc 就是 /etc/kwl）
  writeFileSync(join(f.etc, "relay.json"), JSON.stringify({ ...json(join(f.etc, "relay.json")), seat_keys_file: join(f.etc, "public/seat-relay-public-keys.json") }));
  const rc = relayConfig(f);
  assert.equal(rc.status, 0, rc.stderr);
  // --no-connect-address 同时去掉了网关的：中继跟网关走
  assert.equal(json(join(f.etc, "gateway.json")).control_plane.connect_address, undefined);
  assert.equal(json(join(f.etc, "relay.json")).control_plane.connect_address, undefined, "跟网关的 connect_address 走");
  assert.equal(json(join(f.etc, "relay.json")).control_plane.url, `https://${IP}:8443`);
});

test("D5：部署脚本语法（bash -n）", () => {
  for (const s of ["relay-setup.sh", "verify-capabilities.sh", "upgrade.sh", "rollback.sh", "healthcheck.sh", "install.sh", "tls-ip.sh", "backup.sh"]) {
    const r = spawnSync("bash", ["-n", join(deploy, "scripts", s)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${s}: ${r.stderr}`);
  }
  const v = readFileSync(join(deploy, "scripts/verify-capabilities.sh"), "utf8");
  assert.match(v, /team_roster/);
  assert.match(v, /kwl@relay/);
});
