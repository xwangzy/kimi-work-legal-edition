#!/usr/bin/env node
/**
 * 国密算法可用性探测（v9.3 P3 国密套件评估；docs/design/国密套件评估-v1.md）：在当前 Node / Electron 上逐项试 SM2、SM3、SM4 与 TLS 国密套件，
 * 只输出“能 / 不能”与版本号，不联网、不写文件。用法：
 *   node scripts/gm-probe.mjs                         # 随包与服务端 Node（OpenSSL）
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/gm-probe.mjs   # Electron 主进程 / 内核（BoringSSL）
 */
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, getCiphers, getHashes, sign, verify } from "node:crypto";
import { getCiphers as tlsCiphers } from "node:tls";

const out = { runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`, openssl: process.versions.openssl, checks: {} };
const tryIt = (name, fn) => {
  try {
    out.checks[name] = fn();
  } catch (e) {
    out.checks[name] = `不能（${String(e?.message ?? e).slice(0, 60)}）`;
  }
};
// GB/T 32905 示例 1："abc" 的 SM3
tryIt("sm3", () => (getHashes().includes("sm3") && createHash("sm3").update("abc").digest("hex") === "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0" ? "能（标准示例一致）" : "不能"));
tryIt("sm4-cbc", () => {
  const key = Buffer.alloc(16, 1);
  const iv = Buffer.alloc(16, 2);
  const c = createCipheriv("sm4-cbc", key, iv);
  const ct = Buffer.concat([c.update("国密"), c.final()]);
  const d = createDecipheriv("sm4-cbc", key, iv);
  return Buffer.concat([d.update(ct), d.final()]).toString() === "国密" ? "能" : "不能";
});
tryIt("sm4-gcm", () => (createCipheriv("sm4-gcm", Buffer.alloc(16), Buffer.alloc(12)), "能"));
tryIt("sm2-sign", () => {
  const k = generateKeyPairSync("ec", { namedCurve: "SM2" });
  const s = sign("sm3", Buffer.from("kwl"), k.privateKey);
  return verify("sm3", Buffer.from("kwl"), k.publicKey, s) ? "能（本机自签自验；与其他实现互通、区分标识 ID 待 PoC）" : "不能";
});
tryIt("tls-sm-suites", () => {
  const s = tlsCiphers().filter((x) => /sm/i.test(x));
  return s.length ? `有：${s.join(",")}` : "没有（不支持 TLCP 与 RFC 8998 套件）";
});
out.checks.cipher_list_sm4 = getCiphers().filter((x) => x.startsWith("sm4")).join(",") || "无";
console.log(JSON.stringify(out, null, 2));
