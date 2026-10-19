/**
 * 整机恢复包（第 14 批；设计 docs/design/恢复与备份设计-v1.md）：电脑坏了、被偷了、换新电脑时，凭“恢复包 + 恢复码 + 备份”恢复到
 * 与原机相同的身份与数据。现有 recovery.export_device 只导出设备私钥、且假设原账本还在本机——新电脑上没有数据库主密钥（DPAPI 绑定旧
 * Windows 账户），什么备份都打不开。
 *
 * - 恢复码：系统生成 256 bit 随机秘密，按 KWR1（keys/share-codec.ts，行校验，抄错指出哪一行）显示；只显示一次，内核与磁盘都不保存；
 * - 包裹：AES-256-GCM，密钥 = HKDF-SHA256(秘密, "kwl-recovery-package/3")（秘密已有 256 bit，不需要口令拉伸）；附加数据 = 外层明文规范化 JSON；
 * - 包内：激活信息、数据库主密钥、设备两把私钥与证书、恢复托管公钥；创始设备另含律所根私钥文件与 5 份恢复份额（过渡，最终走离线分持 C6）；
 * - 外层明文只用于识别（律所显示名、设备编号、创建时刻、恢复码集编号），不作为信任依据。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, decodeTeamRecoveryCode, encodeTeamRecoveryCode, shareFromText, shareToText, type DeviceCertificate, type DeviceKeys } from "@zr-legal/keys";
import { DomainError } from "@zr-legal/domain";
import { readSecretFile } from "../devices.ts";
import type { ActivationFile } from "../config.ts";

export const RECOVERY_PACKAGE_KIND = "kwl-recovery-package";

export interface RecoveryContent {
  v: 3;
  tid: string;
  firm_slug: string;
  member_slug: string;
  activation: ActivationFile | null;
  db_master_key: string | null;
  device: { device_id: string; cert: DeviceCertificate; keys: DeviceKeys };
  recovery_public_key_pem: string;
  root_public_key_pem: string;
  firm_root: { publicKeyPem: string; privateKeyPem: string; recoveryCode: string } | null;
  recovery_shares: { file: string; content: unknown }[];
  /** 生成时本机最近一次成功备份（复核 R2A-12：恢复时备份比它旧即要求确认）；没有备份为 null。旧包没有这个字段。 */
  backup?: { seq: number; at: string | null } | null;
  created_at: string;
}

interface Outer {
  kind: typeof RECOVERY_PACKAGE_KIND;
  v: 3;
  firm_name: string;
  device_id: string;
  set_id: string;
  created_at: string;
}

interface PackageFile extends Outer {
  iv: string;
  tag: string;
  ct: string;
}

function keyOf(secret: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.from("kwl"), Buffer.from("kwl-recovery-package/3"), 32));
}

/** 收集本机能恢复的全部秘密（只读；秘密文件经主密钥解封读取）。 */
export function collectRecoveryContent(o: {
  keysDir: string;
  activation: ActivationFile | null;
  tenantId: string;
  firmSlug: string;
  userSlug: string;
  dbKey: string | undefined;
  device: { deviceId: string; cert: DeviceCertificate };
  firm: { rootPublicKeyPem: string; recoveryPublicKeyPem: string };
  backup?: { seq: number; at: string | null } | null;
}): RecoveryContent {
  const keys = readSecretFile<DeviceKeys>(join(o.keysDir, "device.json"));
  if (!keys.signPrivateKeyPem?.includes("PRIVATE KEY") || !keys.encPrivateKeyPem?.includes("PRIVATE KEY")) throw new DomainError("internal", "读不到本机设备私钥，没有生成恢复包", 500);
  const rootFile = join(o.keysDir, "firm-root.json");
  const firmRoot = existsSync(rootFile) ? readSecretFile<{ publicKeyPem: string; privateKeyPem: string; recoveryCode: string }>(rootFile) : null;
  const sharesDir = join(o.keysDir, "recovery-shares");
  const shares = existsSync(sharesDir)
    ? readdirSync(sharesDir)
        .filter((f) => /^share-\d+\.json$/.test(f))
        .sort()
        .map((f) => ({ file: f, content: readSecretFile<unknown>(join(sharesDir, f)) }))
    : [];
  return {
    v: 3,
    tid: o.tenantId,
    firm_slug: o.firmSlug,
    member_slug: o.userSlug,
    activation: o.activation,
    db_master_key: o.dbKey ?? null,
    device: { device_id: o.device.deviceId, cert: o.device.cert, keys },
    recovery_public_key_pem: o.firm.recoveryPublicKeyPem,
    root_public_key_pem: o.firm.rootPublicKeyPem,
    firm_root: firmRoot ? { publicKeyPem: firmRoot.publicKeyPem, privateKeyPem: firmRoot.privateKeyPem, recoveryCode: firmRoot.recoveryCode } : null,
    recovery_shares: shares,
    backup: o.backup ?? null,
    created_at: new Date().toISOString(),
  };
}

/** 生成恢复包：返回文件字节与恢复码文字（恢复码只此一次）。 */
export function sealRecoveryPackage(content: RecoveryContent, firmName: string): { bytes: Buffer; codeText: string; setId: string } {
  const secret = randomBytes(32);
  const encoded = encodeTeamRecoveryCode(secret);
  const { setId } = decodeTeamRecoveryCode(encoded);
  const outer: Outer = { kind: RECOVERY_PACKAGE_KIND, v: 3, firm_name: firmName, device_id: content.device.device_id, set_id: Buffer.from(setId).toString("hex"), created_at: content.created_at };
  const iv = randomBytes(12);
  const key = keyOf(secret);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(canonicalJson(outer), "utf8"));
  const ct = Buffer.concat([c.update(JSON.stringify(content), "utf8"), c.final()]);
  const file: PackageFile = { ...outer, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  const codeText = shareToText(encoded);
  secret.fill(0);
  key.fill(0);
  return { bytes: Buffer.from(JSON.stringify(file, null, 2), "utf8"), codeText, setId: outer.set_id };
}

/** 读外层明文（识别用，不作信任依据）。 */
export function peekRecoveryPackage(bytes: Buffer): Outer {
  let f: PackageFile;
  try {
    f = JSON.parse(bytes.toString("utf8")) as PackageFile;
  } catch {
    throw new DomainError("validation", "这不是恢复包文件", 400);
  }
  if (f?.kind !== RECOVERY_PACKAGE_KIND || f.v !== 3) throw new DomainError("validation", "这不是恢复包文件（或版本不认识）", 400);
  return { kind: f.kind, v: f.v, firm_name: String(f.firm_name), device_id: String(f.device_id), set_id: String(f.set_id), created_at: String(f.created_at) };
}

/** 用恢复码打开恢复包；恢复码抄错时报出是第几行（share-codec 的行校验）。 */
export function openRecoveryPackage(bytes: Buffer, codeText: string): RecoveryContent {
  const outer = peekRecoveryPackage(bytes);
  const f = JSON.parse(bytes.toString("utf8")) as PackageFile;
  let encoded: Uint8Array;
  try {
    encoded = shareFromText(String(codeText ?? ""));
  } catch (e) {
    throw new DomainError("validation", `恢复码没有核对通过：${(e as Error).message}`, 400);
  }
  let secret: Uint8Array;
  let setId: Uint8Array;
  try {
    ({ fms: secret, setId } = decodeTeamRecoveryCode(encoded));
  } catch {
    throw new DomainError("validation", "这不是恢复码（可能是别的码），请核对", 400);
  }
  if (Buffer.from(setId).toString("hex") !== outer.set_id) throw new DomainError("validation", "这串恢复码不是这份恢复包的（每次生成恢复包都会换一串新码）", 400);
  const key = keyOf(secret);
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(f.iv, "base64"));
    d.setAAD(Buffer.from(canonicalJson(outer), "utf8"));
    d.setAuthTag(Buffer.from(f.tag, "base64"));
    const plain = Buffer.concat([d.update(Buffer.from(f.ct, "base64")), d.final()]).toString("utf8");
    const c = JSON.parse(plain) as RecoveryContent;
    if (c.v !== 3 || c.device?.device_id !== outer.device_id) throw new Error("mismatch");
    return c;
  } catch {
    throw new DomainError("validation", "恢复包打不开：文件被改动过，或恢复码不对", 400);
  } finally {
    secret.fill(0);
    key.fill(0);
  }
}
