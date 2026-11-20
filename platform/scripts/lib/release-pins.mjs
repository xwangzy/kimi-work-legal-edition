/**
 * 发行配置的钉住值工具（make-release-config.mjs 与 endpoint-profile.mjs 共用）。
 *
 * 钉住值 = 证书 SubjectPublicKeyInfo（DER）的 sha256，形如 `sha256/<base64>`（与 HPKP pin-sha256、curl --pinnedpubkey、
 * 客户端 packages/egress-gate/src/tls-check.ts 的 spkiPin 相同）。
 *
 * 注意（IP 部署修复）：Node 证书对象的 `pubkey` 对 EC 密钥是裸公钥点而不是 SPKI DER——旧版 make-release-config 直接拿它算摘要，
 * ECDSA 证书（certbot 2.x、lego、acme.sh 的缺省）算出的“当前”钉住值永远对不上；这里一律从证书原文 `raw` 经 X509Certificate 导出 SPKI。
 */
import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { connect } from "node:tls";

export const PIN_RE = /^sha256\/[A-Za-z0-9+/]{43}=$/;

export const pinOfDer = (der) => `sha256/${createHash("sha256").update(der).digest("base64")}`;

/** 证书 DER → SPKI 钉住值。 */
export const pinOfCertDer = (der) => pinOfDer(new X509Certificate(der).publicKey.export({ type: "spki", format: "der" }));

/** 钉住值来源：sha256/… 原样；文件可以是公钥 PEM、证书 PEM（取其公钥）。给了私钥直接报错（备份钉住只要公钥）。 */
export function pinOf(x, fail = (m) => { throw new Error(m); }) {
  if (PIN_RE.test(x)) return x;
  const text = readFileSync(x, "utf8");
  if (/PRIVATE KEY/.test(text)) fail(`${x} 是私钥：备份钉住只要公钥（openssl pkey -in key.pem -pubout）`);
  const key = /BEGIN CERTIFICATE/.test(text) ? new X509Certificate(text).publicKey : createPublicKey(text);
  return pinOfDer(key.export({ type: "spki", format: "der" }));
}

/**
 * 连上服务取叶子证书的钉住值。证书按给定 CA（缺省 Node 内置公共根）完整校验、主机名或 IP 照常核对；
 * IP 地址不发 SNI（RFC 6066 不允许，Node 会告警），IPv6 去掉方括号。
 */
export function leafPin(base, { caPem } = {}) {
  const u = new URL(base);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  return new Promise((ok, no) => {
    const s = connect(
      { host, port: Number(u.port || 443), ...(isIP(host) ? {} : { servername: host }), ...(caPem ? { ca: caPem } : {}), minVersion: "TLSv1.2", timeout: 10_000 },
      () => {
        const cert = s.getPeerCertificate(false);
        s.end();
        if (!cert?.raw) return no(new Error("没有拿到证书"));
        ok({ pin: pinOfCertDer(cert.raw), subject: cert.subject?.CN ?? "", san: cert.subjectaltname ?? "", until: cert.valid_to });
      },
    );
    s.on("error", (e) => no(e));
    s.on("timeout", () => (s.destroy(), no(new Error("连接超时"))));
  });
}

/** 私有 CA 文件（演示/测试部署，偏离 D-212）：只收 CA 证书 PEM，不收私钥。 */
export function readCaBundle(file, fail = (m) => { throw new Error(m); }) {
  const text = readFileSync(file, "utf8");
  if (/PRIVATE KEY/.test(text)) fail(`${file} 含私钥：客户端只要 CA 证书（公钥）`);
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) fail(`${file} 里没有证书`);
  for (const b of blocks) if (new X509Certificate(b).ca !== true) fail(`${file} 里有一张不是 CA 证书（basicConstraints CA:TRUE）`);
  return `${blocks.join("\n")}\n`;
}

/** 中软上游名（release.json 与云端地址配置共用；update 只在 release.json 里）。 */
export const UPSTREAMS = ["control_plane", "gateway", "search", "dist", "support", "notify", "relay"];

/**
 * 按说明文件收集每个上游的地址与钉住集：在线模式连上服务取当前钉住，再加说明文件里的按主机钉住与备份钉住；每个上游至少两把。
 * 返回 { [name]: { base, pins } }。
 */
export async function collectPins(spec, { names, offline, caPem, fail, log = () => {} }) {
  const out = {};
  for (const name of names) {
    const base = spec[`${name}_base`];
    if (base === undefined) continue;
    if (typeof base !== "string" || !base.startsWith("https://")) fail(`${name}_base 必须是 https 地址`);
    const pins = new Set((spec.pins?.[name] ?? []).map((x) => pinOf(x, fail)));
    if (!offline) {
      try {
        const r = await leafPin(base, { caPem });
        pins.add(r.pin);
        log(`${name}：${new URL(base).host} 证书 CN=${r.subject} ${r.san}，到 ${r.until}，钉住 ${r.pin}`);
      } catch (e) {
        fail(`${name}：连不上 ${base}（${e.message}）。服务还没上线可用 --offline，并在 pins.${name} 里给出钉住值`);
      }
    }
    for (const b of [...(spec.backup_pins ?? []), ...(spec[`${name}_backup_pins`] ?? [])]) pins.add(pinOf(b, fail));
    if (pins.size < 2) fail(`${name} 只有 ${pins.size} 个钉住值：至少要当前 + 备份两把（备份密钥对离线生成，证书续期时换用，见部署文档“证书与钉住”）`);
    out[name] = { base: base.replace(/\/+$/, ""), pins: [...pins] };
  }
  return out;
}
