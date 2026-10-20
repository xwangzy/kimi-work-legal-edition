/**
 * 开发内容签名公钥的识别（第 13 批复核 A-14；第 14 批第二轮复核 A 余项）。
 * 指纹 = SPKI DER 的 sha256（与 PEM 换行、注释无关）。已知开发公钥 = 仓库登记表 `content/dev-content-key-fingerprints.json`
 * ∪ 本机 `content/keys/content-signing-dev.pub.json`。登记表随代码提交、只增不删：别的开发机或旧开发密钥签的内容，
 * 换一台构建机也认得出来（原先只认构建机本机那一把）。构建、打包按此拒收正式发布；内核按随包写下的同一份清单报 dev，正式安装包里拒载。
 */
import { createHash, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEV_FP_TABLE = "content/dev-content-key-fingerprints.json";
const FP = /^[0-9a-f]{64}$/;

export function keyFp(pem) {
  return createHash("sha256").update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("hex");
}

/** 仓库登记表里的指纹（文件缺失或格式不对即抛错：门禁不能因为表坏了而静默放行）。 */
export function readDevFpTable(platformRoot) {
  const file = join(platformRoot, DEV_FP_TABLE);
  const t = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(t.fingerprints)) throw new Error(`${DEV_FP_TABLE} 缺少 fingerprints 数组`);
  return t.fingerprints.map((e) => {
    if (!e || !FP.test(e.fp)) throw new Error(`${DEV_FP_TABLE} 有不合格的指纹：${JSON.stringify(e).slice(0, 80)}`);
    return e.fp;
  });
}

/** 本机开发公钥的指纹（没有本机开发公钥时 null）。 */
export function localDevFp(platformRoot) {
  const f = join(platformRoot, "content/keys/content-signing-dev.pub.json");
  return existsSync(f) ? keyFp(JSON.parse(readFileSync(f, "utf8")).publicKeyPem) : null;
}

/** 构建与打包用：登记表 ∪ 本机开发公钥。 */
export function knownDevFingerprints(platformRoot) {
  const out = new Set(readDevFpTable(platformRoot));
  const local = localDevFp(platformRoot);
  if (local) out.add(local);
  return out;
}

/**
 * 把一把开发公钥登记进仓库表（build:lawdb 生成或首次用到本机开发密钥时调用）；已登记返回 false。
 * 新登记会让仓库出现改动——请随代码提交（CI 每次新生成的临时开发密钥只登记在 CI 的检出里，不必提交）。
 */
export function registerDevFingerprint(platformRoot, publicKeyPem, note) {
  const file = join(platformRoot, DEV_FP_TABLE);
  const t = JSON.parse(readFileSync(file, "utf8"));
  const fp = keyFp(publicKeyPem);
  if (t.fingerprints.some((e) => e.fp === fp)) return false;
  t.fingerprints.push({ fp, added: new Date().toISOString().slice(0, 10), ...(note ? { note } : {}) });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(t, null, 2)}\n`);
  renameSync(tmp, file);
  return true;
}
