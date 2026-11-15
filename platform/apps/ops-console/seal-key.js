/**
 * 上游密钥在浏览器里加密（第 44 批，主文 §3.2）：控制面只存密文与尾号，看不到明文；只有持网关路由私钥的网关能解开。
 *
 *   shared = ECDH(临时私钥, 网关路由公钥)                         // P-256，32 字节
 *   key    = HKDF-SHA256(ikm = shared, salt = "kwl-upstream-key/1", info = provider.id, 32 字节)
 *   ct     = AES-256-GCM(key, iv(12 字节随机), utf8(明文), aad = "kwl-upstream-key/1\n" + provider.id)   // ct = 密文 + 16 字节标签
 *   SealedKey = { alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid, epk: b64u(65 字节未压缩公钥), iv: b64u, ct: b64u }
 *
 * 只用 WebCrypto；同一文件在 Node 24 里可直接导入（单测用 node:crypto 解开核对）。临时私钥不可导出、用完即丢。
 */
import { b64url } from "./ops-sign.js";

export const SEAL_ALG = "ECDH-P256+HKDF-SHA256+A256GCM";
const DOMAIN = "kwl-upstream-key/1";
const enc = new TextEncoder();

function b64decode(s) {
  const bin = atob(String(s).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 导入网关路由公钥（config.json 的 routing_public_key：SPKI DER 的 base64）；不是 P-256 即抛错。 */
export async function importRoutingKey(spkiB64) {
  let der;
  try {
    der = b64decode(spkiB64);
  } catch {
    throw new Error("routing_public_key 不是 base64");
  }
  try {
    return await crypto.subtle.importKey("spki", der, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    throw new Error("routing_public_key 不是 P-256 公钥（SPKI）");
  }
}

/** 密钥尾号：“…”+ 末 4 位（只给运营核对是哪一把） */
export const keyHint = (plain) => `…${String(plain).slice(-4)}`;

/**
 * @param {{publicKey: CryptoKey | string, kid: string, providerId: string, plaintext: string}} p
 * @returns {Promise<{alg:string, kid:string, epk:string, iv:string, ct:string}>}
 */
export async function sealUpstreamKey(p) {
  const s = crypto.subtle;
  const plain = String(p.plaintext ?? "");
  if (plain.length < 8) throw new Error("密钥太短（少于 8 位）");
  if (plain.length > 4096) throw new Error("密钥太长");
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(String(p.providerId))) throw new Error("上游编号不合法");
  if (!p.kid) throw new Error("缺路由密钥编号（routing_key_id）");
  const pub = typeof p.publicKey === "string" ? await importRoutingKey(p.publicKey) : p.publicKey;
  const eph = await s.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const epk = new Uint8Array(await s.exportKey("raw", eph.publicKey));
  const shared = await s.deriveBits({ name: "ECDH", public: pub }, eph.privateKey, 256);
  const ikm = await s.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aes = await s.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode(DOMAIN), info: enc.encode(p.providerId) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await s.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`${DOMAIN}\n${p.providerId}`), tagLength: 128 }, aes, enc.encode(plain)));
  return { alg: SEAL_ALG, kid: p.kid, epk: b64url(epk), iv: b64url(iv), ct: b64url(ct) };
}
