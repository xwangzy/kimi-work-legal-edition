/**
 * 上游密钥在浏览器里加密（第 44 批，主文 §3.2）：控制面只存密文与尾号，看不到明文；只有持网关路由私钥的网关能解开。
 *
 *   shared = ECDH(临时私钥, 网关路由公钥)                         // P-256，32 字节
 *   key    = HKDF-SHA256(ikm = shared, salt = "kwl-upstream-key/1", info = provider.id, 32 字节)
 *   ct     = AES-256-GCM(key, iv(12 字节随机), utf8(明文), aad = "kwl-upstream-key/1\n" + provider.id)   // ct = 密文 + 16 字节标签
 *   SealedKey = { alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid, epk: b64u(65 字节未压缩公钥), iv: b64u, ct: b64u }
 *
 * 第 46 批：公钥不再读静态 config.json（谁能改静态站点谁就能换公钥，审计 cloud §9-5），改从 GET /v1/ops/routing 的
 * routing_key {kid, spki_b64, fingerprint} 取；界面显示本页按 SPKI 字节算出的 SHA-256 指纹供运营与部署记录核对，
 * 控制面给的指纹与本页算的不一致时禁用密钥输入。
 * 只用 WebCrypto；同一文件在 Node 24+ 里可直接导入（单测用 node:crypto 解开核对）。临时私钥不可导出、用完即丢。
 */

export const SEAL_ALG = "ECDH-P256+HKDF-SHA256+A256GCM";
const DOMAIN = "kwl-upstream-key/1";
const enc = new TextEncoder();

/** base64url（无填充） */
export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64decode(s) {
  const t = String(s).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 导入网关路由公钥（SPKI DER 的 base64）；不是 P-256 即抛错。 */
export async function importRoutingKey(spkiB64) {
  let der;
  try {
    der = b64decode(spkiB64);
  } catch {
    throw new Error("路由公钥不是 base64");
  }
  try {
    return await crypto.subtle.importKey("spki", der, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    throw new Error("路由公钥不是 P-256 公钥（SPKI）");
  }
}

/** 公钥指纹：SHA-256(SPKI DER) 的十六进制（64 位小写） */
export async function spkiFingerprint(spkiB64) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b64decode(spkiB64)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** 显示用：每 4 位一组，前 8 组（32 位）+ “…” + 末 2 组；完整值放 title */
export const fingerprintText = (hex) => {
  const g = String(hex).match(/.{1,4}/g) ?? [];
  return g.length > 10 ? `${g.slice(0, 8).join(" ")} … ${g.slice(-2).join(" ")}` : g.join(" ");
};
/** 控制面给的指纹（十六进制，可带冒号、空格，或是 sha256: 前缀、base64）与本页算的是否一致 */
export function sameFingerprint(given, computedHex) {
  if (!given) return null;
  let g = String(given).trim().replace(/^sha256[:/]/i, "");
  if (!/^[0-9a-f:\s]+$/i.test(g)) {
    try {
      g = [...b64decode(g)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return false;
    }
  }
  g = g.replace(/[^0-9a-f]/gi, "").toLowerCase();
  return g.length >= 16 && computedHex.startsWith(g);
}

/**
 * 核对 GET /v1/ops/routing 给的 routing_key：返回 { ok, key?, kid?, fingerprint?, reason? }（不抛错）
 * @param {{kid?:string, spki_b64?:string, fingerprint?:string}|null|undefined} rk
 */
export async function checkRoutingKey(rk) {
  if (!rk || typeof rk !== "object" || !rk.spki_b64) return { ok: false, reason: "控制面没有给出网关路由公钥（routing_key）：不能在浏览器里加密上游密钥，密钥输入已禁用。请运维核对控制面 routing.public_key_file。" };
  if (!rk.kid || !/^[A-Za-z0-9._-]{1,64}$/.test(String(rk.kid))) return { ok: false, reason: "控制面给的路由公钥缺编号（kid）：网关无法判断用哪把私钥解开，密钥输入已禁用。" };
  let key;
  let fp;
  try {
    key = await importRoutingKey(rk.spki_b64);
    fp = await spkiFingerprint(rk.spki_b64);
  } catch (e) {
    return { ok: false, reason: `控制面给的路由公钥不可用：${e.message}。密钥输入已禁用。` };
  }
  const same = sameFingerprint(rk.fingerprint, fp);
  if (same === false) return { ok: false, kid: rk.kid, fingerprint: fp, reason: `控制面登记的指纹（${rk.fingerprint}）与本页按公钥算出的（${fingerprintText(fp)}）不一致：公钥可能被替换，密钥输入已禁用。请运维核对。` };
  return { ok: true, key, kid: String(rk.kid), fingerprint: fp, declared: rk.fingerprint ?? null };
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
  if (!p.kid) throw new Error("缺路由密钥编号（kid）");
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
