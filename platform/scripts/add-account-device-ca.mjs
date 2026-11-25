#!/usr/bin/env node
/**
 * 给已部署的签名服务补“账号设备签发钥”（第 66 批 V40，D-292）。幂等：配置里已有 keys.account_device_ca 就什么都不做。
 * 新部署由 scripts/cloud-init-secrets.mjs 一并生成；第 66 批之前部署的环境升级时由 deploy/scripts/upgrade.sh 调用本脚本。
 *
 * 用法：node scripts/add-account-device-ca.mjs --config /etc/kwl/<签名服务>.json --secrets /etc/kwl/secrets [--kid acct-ca-prod-e1]
 *   - 只处理 keys 段里有 envelope 的那份配置（签名服务）；其他角色的配置原样不动并退出 0。
 *   - 私钥写到 <secrets>/account-device-ca.pem（0600，已存在则拒绝覆盖）；配置文件先备份为 .bak-<时间戳> 再改写。
 *   - 不打印任何私钥内容；只打印 kid。
 */
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const cfgFile = arg("config");
const secrets = arg("secrets");
if (!cfgFile || !secrets) {
  console.error("用法：node scripts/add-account-device-ca.mjs --config <签名服务配置.json> --secrets <密钥目录>");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
if (!cfg.keys || !cfg.keys.envelope) {
  console.log(`[add-account-device-ca] ${cfgFile} 不是签名服务配置（没有 keys.envelope），跳过`);
  process.exit(0);
}
if (cfg.keys.account_device_ca) {
  console.log(`[add-account-device-ca] 已有账号设备签发钥 ${cfg.keys.account_device_ca.kid}，不改`);
  process.exit(0);
}
const keyFile = join(secrets, "account-device-ca.pem");
if (existsSync(keyFile)) {
  console.error(`[add-account-device-ca] ${keyFile} 已存在但配置里没有引用：请人工核对后再处理（不覆盖已有私钥）`);
  process.exit(1);
}
// kid 与信封钥同一环境与编号：cp-<环境>-<编号> → acct-ca-<环境>-<编号>
const m = /^cp-(.+)$/.exec(String(cfg.keys.envelope.kid ?? ""));
const kid = arg("kid") ?? (m ? `acct-ca-${m[1]}` : `acct-ca-${Date.now()}`);
const { privateKey } = generateKeyPairSync("ed25519");
writeFileSync(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600, flag: "wx" });
copyFileSync(cfgFile, `${cfgFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
cfg.keys.account_device_ca = { kid, private_key_file: keyFile };
writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o640 });
console.log(`[add-account-device-ca] 已生成账号设备签发钥 ${kid} → ${keyFile}，并写入 ${cfgFile} 的 keys.account_device_ca`);
