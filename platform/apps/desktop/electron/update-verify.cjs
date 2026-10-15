/**
 * 自动更新的发布签名与传输核验（W7）。无 Electron 依赖，可单测。
 *
 * 威胁：更新源（服务器、CDN、DNS）被攻破即可向全部律师电脑投放任意程序——这是桌面产品最大的单点。因此安装前必须同时满足：
 *   1. 传输：更新地址只取随 asar 的 release.json（受完整性熔断保护），https + 证书链 SPKI 钉住（tlsPinMatch）；
 *   2. 发布签名：更新源上按渠道命名的 kwl-update-<渠道>.json 由中软发布密钥（Ed25519，私钥在发布流程的硬件模块里）签名，
 *      公钥随 release.json 分发；清单写明版本、文件名、sha512、大小与有效期（verifyReleaseManifest；过期即拒，
 *      更新源被攻破时挡住“长期冻结”与“重放旧的已签名清单”，复核 B4-A05）；
 *   3. 内容：下载到本机的安装包 sha512 与大小必须与签名清单一致，版本必须等于本次要装的版本且高于当前版本（checkDownloaded）；
 *   4. 代码签名（Authenticode）由 Windows 在运行安装包时另行核验；正式证书到位后在主进程追加发布者核对。
 * electron-updater 自身只按 latest.yml 校验 sha512——latest.yml 与安装包同在更新源上，单靠它挡不住更新源被攻破。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");

const FORMAT = "kwl-update/1";
const PRODUCT = "kimi-work-legal";
const DAY_MS = 24 * 3600 * 1000;
const MAX_VALID_MS = 90 * DAY_MS;

/** 签名清单按渠道命名（复核 B4-A05：latest 与 beta 同源时各有各的清单）。 */
function manifestNameOf(channel) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(String(channel))) throw new Error("更新渠道名不合法");
  return `kwl-update-${channel}.json`;
}

/** 取不到清单（网络、HTTP 状态）与签名或摘要不符分开报告（复核 B4-A07）：前者只是“稍后重试”，后者才是“已丢弃、联系 IT”。 */
class ManifestUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = "KWL_UPDATE_MANIFEST_UNAVAILABLE";
  }
}

/**
 * 再次取清单失败时能否回用下载前已核验的清单（复核 B4-R16）：只在“取不到”（网络、HTTP）时、同一版本、仍在有效期内回用；
 * 签名或内容不符的错误不回用。返回可用的清单或 null。
 */
function fallbackManifest(err, preVerified, version, now = Date.now()) {
  if (!(err instanceof ManifestUnavailableError) || !preVerified) return null;
  if (preVerified.version !== version) return null;
  return Date.parse(preVerified.expires_at) > now ? preVerified : null;
}

/** 更新器错误 → 界面状态（纯函数，可单测）。 */
function classifyUpdateError(e) {
  if (e && e.code === "ERR_UPDATER_INVALID_SIGNATURE") return { state: "rejected", message: "下载的更新未通过发布签名核验，已丢弃。请联系所内 IT 或客服。" };
  if (e && e.code === "KWL_UPDATE_REJECTED") return { state: "rejected", message: "更新未通过发布签名核验，未下载或已丢弃。请联系所内 IT 或客服。" };
  return { state: "error", message: "检查更新失败，稍后会自动重试。" };
}

/** 规范 JSON（键排序、无空白）：签名与核验的字节表示。 */
function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => {
      if (k === "__proto__") throw new Error("非法键");
      return `${JSON.stringify(k)}:${canonicalJson(v[k])}`;
    })
    .join(",")}}`;
}

/** Ed25519 公钥（SPKI DER base64）→ KeyObject；key_id = SPKI sha256 前 16 位十六进制。 */
function importUpdateKey(spkiB64) {
  const der = Buffer.from(String(spkiB64), "base64");
  const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("更新签名公钥必须是 Ed25519");
  return { key, keyId: crypto.createHash("sha256").update(der).digest("hex").slice(0, 16) };
}

const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
function semverGt(a, b) {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * 核验签名清单。manifestText 为 kwl-update.json 的原文；keys 为 release.json 中的公钥（SPKI base64）列表。
 * 返回 payload；任何一项不成立抛出带中文说明的 Error（失败关闭）。
 */
function verifyReleaseManifest(manifestText, keys, { channel = "latest", now = Date.now() } = {}) {
  if (typeof manifestText !== "string" || manifestText.length > 64 * 1024) throw new Error("更新清单缺失或过大");
  let doc;
  try {
    doc = JSON.parse(manifestText);
  } catch {
    throw new Error("更新清单不是合法 JSON");
  }
  const p = doc && doc.payload;
  if (!p || typeof p !== "object") throw new Error("更新清单缺少 payload");
  if (p.format !== FORMAT || p.product !== PRODUCT) throw new Error("更新清单格式或产品不符");
  if (p.channel !== channel) throw new Error(`更新清单渠道不符（${String(p.channel)}）`);
  if (typeof p.version !== "string" || !SEMVER.test(p.version)) throw new Error("更新清单版本号不合法");
  // 文件名只用 ASCII（与 electron-builder.yml 的 artifactName 约定一致）
  if (typeof p.file !== "string" || !/^[A-Za-z0-9._()-]{1,200}\.exe$/.test(p.file) || p.file.includes("..")) throw new Error("更新清单文件名不合法");
  if (typeof p.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(p.sha512)) throw new Error("更新清单摘要不合法");
  if (!Number.isSafeInteger(p.size) || p.size <= 0 || p.size > 2 * 1024 ** 3) throw new Error("更新清单大小不合法");
  // 有效期：签发时间不晚于现在（容 1 天时钟偏差）、过期时间在现在之后、有效期不超过 90 天
  const rel = typeof p.released_at === "string" ? Date.parse(p.released_at) : NaN;
  const exp = typeof p.expires_at === "string" ? Date.parse(p.expires_at) : NaN;
  if (!Number.isFinite(rel) || !Number.isFinite(exp) || exp <= rel || exp - rel > MAX_VALID_MS) throw new Error("更新清单有效期不合法");
  if (rel > now + DAY_MS) throw new Error("更新清单签发时间晚于本机时间");
  if (exp <= now) throw new Error("更新清单已过期（更新源可能停止发布或被冻结），不安装");
  const imported = (keys ?? []).map(importUpdateKey);
  if (imported.length === 0) throw new Error("未配置更新签名公钥");
  const bytes = Buffer.from(canonicalJson(p), "utf8");
  const sigs = Array.isArray(doc.signatures) ? doc.signatures : [];
  const ok = sigs.some((s) => {
    const k = imported.find((x) => x.keyId === s?.key_id);
    if (!k || typeof s.sig !== "string") return false;
    try {
      return crypto.verify(null, bytes, k.key, Buffer.from(s.sig, "base64"));
    } catch {
      return false;
    }
  });
  if (!ok) throw new Error("更新清单的发布签名无效（不是中软发布密钥签发）");
  return p;
}

/** 按发布签名清单核对已下载的安装包。返回 null 表示通过，否则返回原因（electron-updater 约定）。 */
function checkDownloaded(payload, { expectedVersion, currentVersion, file, expectedFile }) {
  if (payload.version !== expectedVersion) return `签名清单版本 ${payload.version} 与待安装版本 ${expectedVersion} 不一致`;
  // latest.yml 给出的文件名须等于签名清单里的文件名（复核 B4-A05：只核格式不比对等于没核）
  if (expectedFile !== undefined && payload.file !== expectedFile) return `签名清单文件名 ${payload.file} 与待安装文件 ${String(expectedFile).slice(0, 80)} 不一致`;
  if (!semverGt(payload.version, currentVersion)) return `不接受降级或同版本更新（当前 ${currentVersion}，清单 ${payload.version}）`;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return "下载的安装包不存在";
  }
  if (st.size !== payload.size) return `安装包大小与签名清单不符（${st.size} ≠ ${payload.size}）`;
  const h = crypto.createHash("sha512");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  if (h.digest("base64") !== payload.sha512) return "安装包摘要与签名清单不符";
  return null;
}

/** 证书链（PEM 列表，叶子在前）中任一证书的 SPKI sha256 命中钉住集即通过。 */
function tlsPinMatch(chainPems, pins) {
  const want = new Set((pins ?? []).map((p) => String(p).replace(/^sha256\//, "")));
  for (const pem of chainPems ?? []) {
    try {
      const spki = new crypto.X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
      if (want.has(crypto.createHash("sha256").update(spki).digest("base64"))) return true;
    } catch {
      /* 解析失败的证书不计 */
    }
  }
  return false;
}

/** 生成签名清单（发布流程用；私钥只在发布机/硬件模块）。 */
function signReleaseManifest(payload, privateKey) {
  const pub = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const keyId = crypto.createHash("sha256").update(pub).digest("hex").slice(0, 16);
  const full = { format: FORMAT, product: PRODUCT, ...payload };
  const sig = crypto.sign(null, Buffer.from(canonicalJson(full), "utf8"), privateKey).toString("base64");
  return { payload: full, signatures: [{ key_id: keyId, sig }] };
}

module.exports = {
  canonicalJson,
  verifyReleaseManifest,
  checkDownloaded,
  tlsPinMatch,
  signReleaseManifest,
  semverGt,
  importUpdateKey,
  manifestNameOf,
  classifyUpdateError,
  fallbackManifest,
  ManifestUnavailableError,
  FORMAT,
  PRODUCT,
};
