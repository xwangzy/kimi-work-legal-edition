/**
 * 运营控制台的请求签名（第 37 批）：在浏览器里用运营人员**自己的**私钥签运营请求，与 packages/ops-auth 的 signOpsRequest 逐字节同一格式
 * （域串 kwl-ops-request-v2 + 规范化 JSON {a,m,p,b,o,k,ts,n}，Ed25519，签名 base64url）。
 *
 * - 私钥只在本页内存：导入为不可导出的 CryptoKey，不写 localStorage / IndexedDB，不发往任何服务；关页或点“退出”即丢弃；
 * - 收 ops-cli keygen 生成的两种私钥文件：PKCS#8 明文（BEGIN PRIVATE KEY）与口令加密（BEGIN ENCRYPTED PRIVATE KEY，
 *   PBES2 = PBKDF2-HMAC-SHA256 + AES-256-CBC，即 Node 的 cipher: "aes-256-cbc"）；
 * - 只用 WebCrypto（Chrome 137+、Edge 137+、Firefox 129+、Safari 17+ 支持 Ed25519），无第三方依赖；同一文件在 Node 24 里可直接导入（单测）。
 */

const REQ_DOMAIN = "kwl-ops-request-v2\n";
const enc = new TextEncoder();
const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("本页不在安全上下文里（须 https 打开），浏览器不提供签名接口");
  return s;
};

export function b64url(bytes) {
  let s = "";
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 与 @zr-legal/keys canonicalJson 同一规则：对象键按 UTF-16 码元排序、undefined 跳过、不收 NaN/Infinity 与 __proto__。 */
export function canonicalJson(v) {
  const sort = (x) => {
    if (x === null || typeof x === "string" || typeof x === "boolean") return x;
    if (typeof x === "number") {
      if (!Number.isFinite(x)) throw new Error("canonicalJson 不支持 NaN/Infinity");
      return x;
    }
    if (Array.isArray(x)) return x.map((y) => (y === undefined ? null : sort(y)));
    if (typeof x === "object") {
      const out = {};
      for (const k of Object.keys(x).sort()) {
        if (k === "__proto__") throw new Error("canonicalJson 不接受名为 __proto__ 的键");
        if (x[k] === undefined) continue;
        out[k] = sort(x[k]);
      }
      return out;
    }
    throw new Error(`canonicalJson 只支持 JSON 值，收到 ${typeof x}`);
  };
  return JSON.stringify(sort(v));
}

// ─── PEM 与最小 DER 读取（只为解开 PKCS#8 / PBES2 结构） ───────────────
function pemBody(pem, label) {
  const m = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(pem);
  if (!m) return null;
  const bin = atob(m[1].replace(/[^A-Za-z0-9+/=]/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readTlv(buf, at) {
  if (at + 2 > buf.length) throw new Error("私钥文件结构不完整");
  const tag = buf[at];
  let len = buf[at + 1];
  let off = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || off + n > buf.length) throw new Error("私钥文件结构不合法");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + i];
    off += n;
  }
  if (off + len > buf.length) throw new Error("私钥文件结构不完整");
  return { tag, start: off, end: off + len, next: off + len, value: buf.subarray(off, off + len) };
}

function children(buf, tlv) {
  const out = [];
  let at = tlv.start;
  while (at < tlv.end) {
    const c = readTlv(buf, at);
    out.push(c);
    at = c.next;
  }
  return out;
}

function oid(bytes) {
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let v = 0;
  for (let i = 1; i < bytes.length; i++) {
    v = v * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

function intOf(bytes) {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

const OID = {
  pbes2: "1.2.840.113549.1.5.13",
  pbkdf2: "1.2.840.113549.1.5.12",
  hmacSha1: "1.2.840.113549.2.7",
  hmacSha256: "1.2.840.113549.2.9",
  aes256cbc: "2.16.840.1.101.3.4.1.42",
  aes128cbc: "2.16.840.1.101.3.4.1.2",
};

async function decryptPkcs8(der, passphrase) {
  const top = readTlv(der, 0);
  const [algId, encData] = children(der, top);
  const [algOid, params] = children(der, algId);
  if (oid(algOid.value) !== OID.pbes2) throw new Error("只支持 PBES2 加密的私钥（ops-cli keygen --passphrase-env 生成的格式）");
  const [kdf, scheme] = children(der, params);
  const [kdfOid, kdfParams] = children(der, kdf);
  if (oid(kdfOid.value) !== OID.pbkdf2) throw new Error("只支持 PBKDF2 派生的私钥口令");
  const kp = children(der, kdfParams);
  const salt = kp[0].value;
  const iterations = intOf(kp[1].value);
  let hash = "SHA-1";
  for (const x of kp.slice(2)) {
    if (x.tag === 0x30) {
      const p = oid(children(der, x)[0].value);
      if (p === OID.hmacSha256) hash = "SHA-256";
      else if (p !== OID.hmacSha1) throw new Error("不支持的口令派生摘要算法");
    }
  }
  const [encOid, iv] = children(der, scheme);
  const eo = oid(encOid.value);
  const keyLen = eo === OID.aes256cbc ? 256 : eo === OID.aes128cbc ? 128 : 0;
  if (!keyLen) throw new Error("只支持 AES-CBC 加密的私钥");
  if (iterations < 1 || iterations > 10_000_000) throw new Error("口令派生迭代次数不合理");
  const s = subtle();
  const base = await s.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const aes = await s.deriveKey({ name: "PBKDF2", salt, iterations, hash }, base, { name: "AES-CBC", length: keyLen }, false, ["decrypt"]);
  try {
    return new Uint8Array(await s.decrypt({ name: "AES-CBC", iv: iv.value }, aes, encData.value));
  } catch {
    throw new Error("口令不对（或私钥文件已损坏）");
  }
}

/**
 * 导入运营私钥 → 不可导出的 Ed25519 CryptoKey。
 * 公钥文件、证书、P-256 私钥一律拒绝（运营命令行只生成 Ed25519；名册里登记的是同一把的公钥）。
 */
export async function importOpsKey(pemText, passphrase = "") {
  const text = String(pemText ?? "");
  if (/BEGIN PUBLIC KEY/.test(text) && !/PRIVATE KEY/.test(text)) throw new Error("这是公钥文件：请选本人的私钥文件（ops-cli keygen 生成的 .key / private.pem）");
  let der = pemBody(text, "PRIVATE KEY");
  if (!der) {
    const encDer = pemBody(text, "ENCRYPTED PRIVATE KEY");
    if (!encDer) throw new Error("不是 PKCS#8 私钥文件");
    if (!passphrase) throw new Error("私钥有口令保护：请输入口令");
    der = await decryptPkcs8(encDer, passphrase);
  }
  try {
    return await subtle().importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  } catch {
    throw new Error("私钥不是 Ed25519（或浏览器版本过旧，不支持 Ed25519：请用 Chrome / Edge 137 以上）");
  }
}

function randomNonce() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return b64url(b);
}

/**
 * 签一个运营请求，返回五个请求头。path 须与实际发出的请求行原样一致（控制面按原样路径核对，不带查询串）。
 * @param {{deployment:string, audience:string, operator:string, kid:string, key:CryptoKey, method:string, path:string, body?:string, now?:number, nonce?:string}} p
 */
export async function signOpsRequest(p) {
  const s = subtle();
  const body = p.body ?? "";
  const ts = String(p.now ?? Date.now());
  const nonce = p.nonce ?? randomNonce();
  const digest = b64url(await s.digest("SHA-256", enc.encode(body)));
  const msg = REQ_DOMAIN + canonicalJson({ a: `${p.deployment}/${p.audience}`, m: String(p.method).toUpperCase(), p: p.path, b: digest, o: p.operator, k: p.kid, ts, n: nonce });
  const sig = b64url(await s.sign({ name: "Ed25519" }, p.key, enc.encode(msg)));
  return { "x-kwl-op": p.operator, "x-kwl-op-key": p.kid, "x-kwl-op-ts": ts, "x-kwl-op-nonce": nonce, "x-kwl-op-sig": sig };
}

export const OPERATOR_ID_RE = /^op_[0-9]{4,12}$/;
export const OPS_KEY_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
