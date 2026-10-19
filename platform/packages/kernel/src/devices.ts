/**
 * 首次启动引导：律所身份与本机设备（方案 v5.0 第 4 篇 §5.3/§5.4）。
 *
 * **G0 开发形态（如实声明，非生产形态）**：
 * - 律所根私钥以 0600 文件存于 `<workspace>/keys/firm-root.json`——生产形态为离线恢复码
 *   抄写 + 可选多名合伙人分持，根私钥不应常驻任何联机设备；本文件仅为 G0 单机开发便利。
 * - 恢复托管私钥 Shamir 3-of-5 分持，份额以 0600 文件存于 `<workspace>/keys/recovery-shares/`——
 *   生产形态由合伙人各自离线保管，份额不应同机落盘；完整托管私钥用后即弃，绝不持久化。
 * - 根私钥/托管私钥/份额不出 `<workspace>/keys/` 目录；数据库 firm_identity 只存公钥。
 * - 首跑且该 tenant 仅 1 个 membership 时将其角色提升为 firm_admin（G0 单机开发形态；
 *   生产由管理控制台分配角色）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createCipheriv, createDecipheriv, createPublicKey, hkdfSync, randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  b64urlEncode,
  firmRootFromRecoveryCode,
  generateDeviceKeys,
  generateFirmRoot,
  generateRecoveryEscrow,
  issueDeviceCertificate,
  SoftwareSigner,
  splitRecoveryPrivateKey,
  unwrapMatterKey,
  verifyDeviceCertificate,
  wrapMatterKey,
  type DeviceCertificate,
  type DeviceKeys,
  type DeviceRole,
} from "@zr-legal/keys";
import type { KernelDb } from "./db.ts";
import type { Identity } from "./identity.ts";
import type { LedgerSigner } from "./ledger-signer.ts";

export interface FirmIdentityRow {
  rootPublicKeyPem: string;
  recoveryPublicKeyPem: string;
}

export interface KernelKeyContext {
  signer: LedgerSigner;
  device: DeviceContext;
  firm: FirmIdentityRow;
  keysDir: string;
}

/** 设备密钥去掉签名私钥后的部分。 */
export type DeviceEncKeys = Omit<DeviceKeys, "signPrivateKeyPem">;

/** 由完整密钥构造设备上下文的两部分：签名私钥只交给签名者。 */
function splitKeys(k: DeviceKeys): { keys: DeviceEncKeys; signer: SoftwareSigner } {
  const { signPrivateKeyPem, ...rest } = k;
  return { keys: rest, signer: new SoftwareSigner(signPrivateKeyPem) };
}

export interface DeviceContext {
  deviceId: string;
  memberId: string;
  cert: DeviceCertificate;
  /** 设备公钥与加密私钥（事项密钥包裹）；签名私钥不常驻于此，只在 signer 内（复核 S7A-02，KP-02）。 */
  keys: DeviceEncKeys;
  /** 设备签名者（TPM 设计 v1 §4.3：今天是软件密钥；装上 TPM 后由主进程经 IPC 签名）。 */
  signer: SoftwareSigner;
}

export function keysDirOf(workspaceDir: string): string {
  return join(workspaceDir, "keys");
}

/**
 * 密钥文件封装（隐私安全审查 P0-1）：设备私钥、律所根私钥、恢复份额落盘前用 AES-256-GCM 封装，
 * 封装密钥 = HKDF-SHA256(数据库主密钥, "kwl-secret-files/1")——数据库主密钥由主进程经 safeStorage（Windows DPAPI）解封后
 * 一次性交付内核，因此拷走工作区目录（备份、同步盘、被盗硬盘）不能直接得到私钥。附加数据为文件名（防止文件互换）。
 * 未配置数据库主密钥（开发与测试形态）时按明文开发形态读写；配置后读到明文旧文件即就地改写为封装形态。
 * 残余（如实）：同一 Windows 用户下运行的恶意程序可调用 DPAPI 解封——须 TPM 不可导出密钥（G1，见审查 P1-10）。
 */
const sealKeys = new Map<string, Buffer>();

/** 由内核启动时按工作区登记（keysDir → 封装密钥）；dbKey 为空即不封装。 */
export function configureSecretSealing(keysDir: string, dbKey: string | undefined): void {
  if (!dbKey) {
    sealKeys.delete(keysDir);
    return;
  }
  sealKeys.set(keysDir, Buffer.from(hkdfSync("sha256", Buffer.from(dbKey, "utf8"), Buffer.from("kwl"), Buffer.from("kwl-secret-files/1"), 32)));
}

function sealKeyFor(path: string): Buffer | undefined {
  let d = dirname(path);
  for (let i = 0; i < 3; i++) {
    const k = sealKeys.get(d);
    if (k) return k;
    d = dirname(d);
  }
  return undefined;
}

interface SealedFile {
  format: "kwl-sealed/1";
  iv: string;
  tag: string;
  ct: string;
}

function writeSecret0600(path: string, content: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const key = sealKeyFor(path);
  const plain = JSON.stringify(content, null, 2);
  let out = plain;
  if (key) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(basename(path), "utf8"));
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    const sealed: SealedFile = { format: "kwl-sealed/1", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
    out = JSON.stringify(sealed);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, out, { mode: 0o600 });
  renameSync(tmp, path);
}

/** 读取密钥文件：封装形态解封（失败即抛错，不回落）；配置了封装密钥而读到明文旧文件 → 就地改写为封装形态。 */
export function readSecretFile<T>(path: string): T {
  const raw = JSON.parse(readFileSync(path, "utf8")) as T | SealedFile;
  const key = sealKeyFor(path);
  if (raw && typeof raw === "object" && (raw as SealedFile).format === "kwl-sealed/1") {
    if (!key) throw new Error(`${basename(path)} 已加密封装，但本次启动没有数据库主密钥，无法解封`);
    const f = raw as SealedFile;
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(f.iv, "base64"));
    d.setAAD(Buffer.from(basename(path), "utf8"));
    d.setAuthTag(Buffer.from(f.tag, "base64"));
    let plain: string;
    try {
      plain = Buffer.concat([d.update(Buffer.from(f.ct, "base64")), d.final()]).toString("utf8");
    } catch {
      throw new Error(`${basename(path)} 解封失败（密钥不符或文件被改动），已拒用`);
    }
    return JSON.parse(plain) as T;
  }
  if (key) writeSecret0600(path, raw);
  return raw as T;
}

/** 首跑生成律所根密钥与恢复托管（分持落盘为开发形态）；之后只读公钥。
 * 若 db 无记录但 firm-root.json 已存在（工作区库重建/新引导同律所第二台机器），复用既有根密钥——
 * 同一律所多设备共用同一根（证书链一致的前提）；恢复托管公钥无法从文件恢复（份额仍在），
 * 以占位空串登记并如实注释（M-of-N 恢复流程不依赖库内该公钥，仅用份额）。 */
export function ensureFirmIdentity(db: KernelDb, keysDir: string, tenantId: string): FirmIdentityRow {
  const existing = db.get<{ root_public_key_pem: string; recovery_public_key_pem: string }>(
    `SELECT root_public_key_pem, recovery_public_key_pem FROM firm_identity WHERE tenant_id = ?`,
    [tenantId],
  );
  if (existing) return { rootPublicKeyPem: existing.root_public_key_pem, recoveryPublicKeyPem: existing.recovery_public_key_pem };

  const rootFile = join(keysDir, "firm-root.json");
  if (existsSync(rootFile)) {
    const root = getFirmRootPrivateKey(keysDir); // 自检恢复码一致性
    // 本工作区没有创始时的托管私钥（份额在创始处）——生成独立托管对（开发形态如实注明：
    // 本工作区的 recovery 包裹只能由本份额恢复；创始工作区事项的 recovery 包裹用其原份额）。
    const escrow = generateRecoveryEscrow();
    const { shares, privateKeyHash } = splitRecoveryPrivateKey(escrow.privateKeyPem, 5, 3);
    for (const share of shares) {
      writeSecret0600(join(keysDir, "recovery-shares", `share-${share.x}.json`), {
        _comment: "G0 开发形态：本工作区恢复托管私钥的 Shamir 份额（3-of-5）；与创始工作区的份额不同，勿混用。",
        x: share.x,
        y: b64urlEncode(share.y),
        privateKeyHash,
      });
    }
    db.run(`INSERT INTO firm_identity (tenant_id, root_public_key_pem, recovery_public_key_pem) VALUES (?,?,?)`, [tenantId, root.publicKeyPem, escrow.publicKeyPem]);
    return { rootPublicKeyPem: root.publicKeyPem, recoveryPublicKeyPem: escrow.publicKeyPem };
  }

  const root = generateFirmRoot();
  const escrow = generateRecoveryEscrow();
  const { shares, privateKeyHash } = splitRecoveryPrivateKey(escrow.privateKeyPem, 5, 3);
  // 完整托管私钥到此为止：只落份额，不持久化私钥本体
  db.tx(() => {
    db.run(`INSERT INTO firm_identity (tenant_id, root_public_key_pem, recovery_public_key_pem) VALUES (?,?,?)`, [
      tenantId,
      root.publicKeyPem,
      escrow.publicKeyPem,
    ]);
  });
  writeSecret0600(join(keysDir, "firm-root.json"), {
    _comment:
      "G0 开发形态：生产形态为离线恢复码抄写+合伙人分持，根私钥不应常驻联机设备；本文件仅用于签发设备证书，切勿提交或外传。中软不托管任何密钥。",
    publicKeyPem: root.publicKeyPem,
    privateKeyPem: root.privateKeyPem,
    recoveryCode: root.recoveryCode,
  });
  for (const share of shares) {
    writeSecret0600(join(keysDir, "recovery-shares", `share-${share.x}.json`), {
      _comment: "G0 开发形态：恢复托管私钥的 Shamir 份额（3-of-5）；生产由合伙人各自离线保管，不应同机落盘。",
      x: share.x,
      y: b64urlEncode(share.y),
      privateKeyHash,
    });
  }
  return { rootPublicKeyPem: root.publicKeyPem, recoveryPublicKeyPem: escrow.publicKeyPem };
}

/** 仅签发设备证书时读取根私钥（G0 开发形态，见文件头声明）。 */
export function getFirmRootPrivateKey(keysDir: string): { publicKeyPem: string; privateKeyPem: string; recoveryCode: string } {
  const raw = readSecretFile<{ publicKeyPem: string; privateKeyPem: string; recoveryCode: string }>(join(keysDir, "firm-root.json"));
  // 自检：文件内私钥与恢复码应派生同一公钥（发现被改/混放即拒用）
  const derived = firmRootFromRecoveryCode(raw.recoveryCode);
  if (derived.publicKeyPem !== raw.publicKeyPem || derived.privateKeyPem !== raw.privateKeyPem) {
    throw new Error("firm-root.json 内容与恢复码不一致（文件可能被改动），已拒用");
  }
  return raw;
}

export function getDeviceKeys(keysDir: string): DeviceKeys {
  return readSecretFile<DeviceKeys>(join(keysDir, "device.json"));
}

/**
 * 写回设备密钥文件（设备恢复导入用）：与其他密钥文件同一封装（配置了封装密钥即 AES-256-GCM 封装、临时文件改名、0600）。
 * 隐私安全增量评审 F2：恢复导入曾直接写明文 PEM 到 device.json。
 */
export function writeDeviceKeys(keysDir: string, keys: DeviceKeys): void {
  writeSecret0600(join(keysDir, "device.json"), keys);
}

/** 成员入组时本机新生成的设备密钥（第 13 批）：私钥只交给签名者（签名者表面门禁 KP-02），整套密钥另经封装暂存。 */
export function generateJoinDeviceKeys(): { keys: DeviceKeys; signer: SoftwareSigner } {
  const keys = generateDeviceKeys();
  return { keys, signer: splitKeys(keys).signer };
}

/** 开通与入组的暂存秘密（认领凭据、入组设备密钥与取回的证书；第 13 批）：与其他密钥文件同一封装。 */
export function writeStagedSecret(path: string, content: unknown): void {
  writeSecret0600(path, content);
}

/** 成员入组取回证书后暂存的内容（keys/join-approved.json），下次按真实身份启动时在任何组件装载设备密钥之前生效。 */
export interface StagedJoin {
  cert: DeviceCertificate;
  root_public_key_pem: string;
  recovery_public_key_pem: string;
  keys: DeviceKeys;
}

/**
 * 应用暂存的入组结果（第 13 批）：成员设备不持律所根——律所身份只登记根公钥与（经律所根签名核验过的）恢复托管公钥，
 * 设备行与 device.json 用管理员签发的证书和入组时生成的设备密钥。证书须由该根签发、编号与成员是本机身份、公钥与暂存的私钥配对。
 * 账本先提交、再写密钥文件、最后删暂存（写密钥失败下次启动重做；幂等）。
 */
export function applyStagedJoin(db: KernelDb, keysDir: string, identity: Identity, slugs: { firmSlug: string; userSlug: string }): { applied: boolean; rejected?: string } {
  const path = join(keysDir, "join-approved.json");
  if (!existsSync(path)) return { applied: false };
  const st = readSecretFile<StagedJoin>(path);
  const deviceId = `dev_${slugs.firmSlug}_${slugs.userSlug}`;
  const vr = verifyDeviceCertificate(st.cert, st.root_public_key_pem);
  if (!vr.ok) return { applied: false, rejected: "cert_invalid" };
  if (st.cert.deviceId !== deviceId || st.cert.memberId !== identity.userId) return { applied: false, rejected: "identity_mismatch" };
  if (st.cert.signPublicKeyPem !== st.keys.signPublicKeyPem || st.cert.encPublicKeyPem !== st.keys.encPublicKeyPem) return { applied: false, rejected: "key_mismatch" };
  const existing = db.get<{ root_public_key_pem: string }>(`SELECT root_public_key_pem FROM firm_identity WHERE tenant_id = ?`, [identity.tenantId]);
  if (existing && existing.root_public_key_pem !== st.root_public_key_pem) return { applied: false, rejected: "root_mismatch" };
  const roleOf: Record<string, string> = { admin: "firm_admin", partner: "partner", assistant: "paralegal", lawyer: "lawyer" };
  db.tx(() => {
    if (!existing) db.run(`INSERT INTO firm_identity (tenant_id, root_public_key_pem, recovery_public_key_pem) VALUES (?,?,?)`, [identity.tenantId, st.root_public_key_pem, st.recovery_public_key_pem]);
    db.run(`UPDATE memberships SET role = ? WHERE tenant_id = ? AND user_id = ?`, [roleOf[st.cert.role] ?? "lawyer", identity.tenantId, identity.userId]);
    db.run(
      `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue)
       VALUES (?,?,?,?,?,?,?, 'active', ?)
       ON CONFLICT(device_id) DO UPDATE SET cert_json = excluded.cert_json, sign_pub_pem = excluded.sign_pub_pem, enc_pub_pem = excluded.enc_pub_pem`,
      [deviceId, identity.tenantId, identity.userId, st.cert.role, st.keys.signPublicKeyPem, st.keys.encPublicKeyPem, JSON.stringify(st.cert), currentTenantEpoch(db, identity.tenantId)],
    );
  });
  writeDeviceKeys(keysDir, st.keys);
  rmSync(path, { force: true });
  return { applied: true };
}

/**
 * 换证前把该设备当前证书留档（迁移 0024；复核 B4-A11）：同一设备编号下旧证书签出的见证行、审批与回执仍要能验签。
 * 同一证书只留一次；当前没有登记或证书不可解析即不留。
 */
export function archiveDeviceCert(db: KernelDb, deviceId: string, reason: "rekeyed" | "recovered"): void {
  const row = db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ?`, [deviceId]);
  if (!row) return;
  let certId: unknown;
  try {
    certId = (JSON.parse(row.cert_json) as DeviceCertificate).certId;
  } catch {
    return;
  }
  if (typeof certId !== "string" || !certId) return;
  // 有效上界（复核 B4-R10，迁移 0025）：此刻签名事件链的最大序号；同一证书再次留档取较大者
  const seq = db.get<{ s: number | null }>(`SELECT MAX(seq) AS s FROM signed_events`, [])?.s ?? 0;
  db.run(
    `INSERT INTO device_cert_history (device_id, cert_id, cert_json, reason, superseded_seq) VALUES (?,?,?,?,?)
     ON CONFLICT(device_id, cert_id) DO UPDATE SET superseded_seq = MAX(superseded_seq, excluded.superseded_seq)`,
    [deviceId, certId, row.cert_json, reason, seq],
  );
}

/** 暂存的设备恢复（复核 B4-R09）：导入时只核验并封装保存，下次启动、任何组件装载设备密钥之前再生效。 */
export interface StagedRecovery {
  device_id: string;
  cert: DeviceCertificate;
  signPrivateKeyPem: string;
  encPrivateKeyPem: string;
  staged_at: string;
}
const STAGED_RECOVERY = "recovery-staged.json";

export function stageDeviceRecovery(keysDir: string, staged: StagedRecovery): void {
  writeSecret0600(join(keysDir, STAGED_RECOVERY), staged);
}

export function hasStagedRecovery(keysDir: string): boolean {
  return existsSync(join(keysDir, STAGED_RECOVERY));
}

export interface AppliedRecovery {
  applied: boolean;
  rewrapped: number;
  unreadable: number;
  /** 暂存文件未通过复核（已改名留存，不生效）的原因。 */
  rejected?: string;
}

/**
 * 启动时应用暂存的设备恢复（复核 B4-R09）：在 ensureDevice、内核各组件与 Agent 宿主装载设备密钥之前执行——
 * 这时没有任何组件持有临时密钥，不会再有事项或工作区密钥被包裹给即将作废的临时公钥。
 * 1. 复核：编号是本机、证书由律所根签发且公钥与私钥推导结果一致、设备未被吊销（期间可能已被吊销）；不通过即改名留存、不生效；
 * 2. 同一事务：临时密钥包裹、备份私钥解不开的 matter_keys 与 matter_ws_keys 改包裹给备份公钥；临时证书留档；devices 行换回；
 * 3. 账本提交之后写 device.json（写失败时下次启动重做，幂等），最后删除暂存文件。
 */
export function applyStagedRecovery(db: KernelDb, keysDir: string, slugs: { firmSlug: string; userSlug: string }, rootPublicKeyPem: string): AppliedRecovery {
  const path = join(keysDir, STAGED_RECOVERY);
  if (!existsSync(path)) return { applied: false, rewrapped: 0, unreadable: 0 };
  const deviceId = `dev_${slugs.firmSlug}_${slugs.userSlug}`;
  const reject = (reason: string): AppliedRecovery => {
    try {
      renameSync(path, join(keysDir, `recovery-staged.rejected-${Date.now()}.json`));
    } catch {
      rmSync(path, { force: true });
    }
    return { applied: false, rewrapped: 0, unreadable: 0, rejected: reason };
  };
  let st: StagedRecovery;
  try {
    st = readSecretFile<StagedRecovery>(path);
  } catch {
    return reject("暂存的恢复文件无法读取");
  }
  if (st.device_id !== deviceId || st.cert?.deviceId !== deviceId) return reject("暂存的恢复属于另一台设备");
  const vr = verifyDeviceCertificate(st.cert, rootPublicKeyPem);
  if (!vr.ok) return reject(`证书无效：${vr.reason}`);
  let signPub: string;
  let encPub: string;
  try {
    signPub = createPublicKey(st.signPrivateKeyPem).export({ format: "pem", type: "spki" }).toString();
    encPub = createPublicKey(st.encPrivateKeyPem).export({ format: "pem", type: "spki" }).toString();
  } catch {
    return reject("私钥不完整");
  }
  if (st.cert.signPublicKeyPem.trim() !== signPub.trim() || st.cert.encPublicKeyPem.trim() !== encPub.trim()) return reject("私钥与证书不符");
  const row = db.get<{ status: string }>(`SELECT status FROM devices WHERE device_id = ?`, [deviceId]);
  if (!row) return reject("本机没有这台设备的登记");
  let tomb = false;
  try {
    tomb = !!db.get(`SELECT 1 AS x FROM cp_revoked_devices WHERE device_id = ?`, [deviceId]);
  } catch {
    tomb = false;
  }
  if (row.status === "revoked" || tomb) return reject("设备已被律所吊销");

  const deviceFile = join(keysDir, "device.json");
  const cur = existsSync(deviceFile) ? readSecretFile<DeviceKeys>(deviceFile) : null;
  let rewrapped = 0;
  let unreadable = 0;
  const rewrap = (wrapped: string): string | null => {
    try {
      unwrapMatterKey(wrapped, st.encPrivateKeyPem).fill(0);
      return null; // 备份私钥本来就能解
    } catch {
      // 继续试临时私钥
    }
    if (!cur) {
      unreadable++;
      return null;
    }
    let k: Uint8Array;
    try {
      k = unwrapMatterKey(wrapped, cur.encPrivateKeyPem);
    } catch {
      unreadable++;
      return null;
    }
    try {
      rewrapped++;
      return wrapMatterKey(k, encPub);
    } finally {
      k.fill(0);
    }
  };
  db.tx(() => {
    for (const r of db.all<{ matter_id: string; epoch: number; wrapped_key: string }>(`SELECT matter_id, epoch, wrapped_key FROM matter_keys WHERE wrapped_for = ?`, [deviceId])) {
      const w = rewrap(r.wrapped_key);
      if (w) db.run(`UPDATE matter_keys SET wrapped_key = ? WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [w, r.matter_id, r.epoch, deviceId]);
    }
    for (const r of db.all<{ matter_id: string; gen: number; wrapped_key: string }>(`SELECT matter_id, gen, wrapped_key FROM matter_ws_keys WHERE device_id = ?`, [deviceId])) {
      const w = rewrap(r.wrapped_key);
      if (w) db.run(`UPDATE matter_ws_keys SET wrapped_key = ? WHERE matter_id = ? AND gen = ? AND device_id = ?`, [w, r.matter_id, r.gen, deviceId]);
    }
    const now = db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ?`, [deviceId]);
    if (now && now.cert_json !== JSON.stringify(st.cert)) archiveDeviceCert(db, deviceId, "recovered");
    db.run(`UPDATE devices SET cert_json = ?, sign_pub_pem = ?, enc_pub_pem = ? WHERE device_id = ?`, [JSON.stringify(st.cert), signPub, encPub, deviceId]);
  });
  // 账本先提交、再写密钥文件：写文件失败时下次启动重做（改包裹幂等），反过来会让临时密钥建的事项永久丢失
  writeDeviceKeys(keysDir, { signPublicKeyPem: signPub, signPrivateKeyPem: st.signPrivateKeyPem, encPublicKeyPem: encPub, encPrivateKeyPem: st.encPrivateKeyPem });
  rmSync(path, { force: true });
  return { applied: true, rewrapped, unreadable };
}

/** membership 角色 → 证书角色（G0 映射；生产由管理控制台按席位分配）。
 * userSlug === 'node' 的工作区是所内节点服务身份（§5.3 服务成员，firm-node 形态）——角色恒为 node。 */
function certRoleOf(membershipRole: string | undefined, userSlug?: string): DeviceRole {
  if (userSlug === "node") return "node";
  switch (membershipRole) {
    case "firm_admin":
      return "admin";
    case "partner":
      return "partner";
    case "paralegal":
      return "assistant";
    default:
      return "lawyer";
  }
}

/**
 * 当前主机设备（v0 确定性 device_id = dev_<firmSlug>_<userSlug>；一人一台设备）：
 * 首跑生成设备密钥（0600）→ 根私钥签发 1 年期设备证书 → devices upsert；之后直接装载。
 */
export function ensureDevice(db: KernelDb, keysDir: string, identity: Identity, slugs: { firmSlug: string; userSlug: string }, opts: { promoteSole?: boolean } = {}): DeviceContext {
  const deviceId = `dev_${slugs.firmSlug}_${slugs.userSlug}`;

  // G0 单机开发形态：首跑且仅 1 个 membership 时提升为 firm_admin（生产由管理控制台分配）
  // 经开通码激活的设备（第 13 批）不做此提升：角色只来自开通码 / 邀请码与管理员签发的证书
  const ms = db.all<{ membership_id: string; role: string }>(`SELECT membership_id, role FROM memberships WHERE tenant_id = ?`, [identity.tenantId]);
  if (opts.promoteSole !== false && ms.length === 1 && ms[0]!.role === "lawyer") {
    db.run(`UPDATE memberships SET role = 'firm_admin' WHERE membership_id = ?`, [ms[0]!.membership_id]);
  }
  const membershipRole = db.get<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`, [identity.tenantId, identity.userId])?.role;

  const deviceFile = join(keysDir, "device.json");
  const row = db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ?`, [deviceId]);
  if (row && existsSync(deviceFile)) {
    const keys = getDeviceKeys(keysDir);
    return { deviceId, memberId: identity.userId, cert: JSON.parse(row.cert_json) as DeviceCertificate, ...splitKeys(keys) };
  }

  // 已登记但 device.json 不在（丢失或损坏后重开）：换新密钥前把旧证书留档，旧密钥签出的历史仍可验签；旧密钥本身可用恢复文件导回
  if (row) archiveDeviceCert(db, deviceId, "rekeyed");
  const root = getFirmRootPrivateKey(keysDir);
  const keys = generateDeviceKeys();
  const now = Date.now();
  const epoch = currentTenantEpoch(db, identity.tenantId);
  const cert = issueDeviceCertificate(root.privateKeyPem, {
    certId: `cert_${deviceId}_${now.toString(36)}`,
    memberId: identity.userId,
    deviceId,
    role: certRoleOf(membershipRole, slugs.userSlug),
    signPublicKeyPem: keys.signPublicKeyPem,
    encPublicKeyPem: keys.encPublicKeyPem,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 365 * 24 * 3600 * 1000).toISOString(),
  });
  db.run(
    `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue)
     VALUES (?,?,?,?,?,?,?, 'active', ?)
     ON CONFLICT(device_id) DO UPDATE SET cert_json = excluded.cert_json, sign_pub_pem = excluded.sign_pub_pem,
       enc_pub_pem = excluded.enc_pub_pem, key_epoch_at_issue = excluded.key_epoch_at_issue`,
    [deviceId, identity.tenantId, identity.userId, cert.role, keys.signPublicKeyPem, keys.encPublicKeyPem, JSON.stringify(cert), epoch],
  );
  writeSecret0600(deviceFile, {
    _comment: "G0 开发形态：本机设备私钥（生产由 safeStorage/TPM 包裹保存，§5.3）；切勿提交或外传。",
    ...keys,
  });
  return { deviceId, memberId: identity.userId, cert, ...splitKeys(keys) };
}

/** 当前 tenant 密钥纪元（无记录为 1）。 */
export function currentTenantEpoch(db: KernelDb, tenantId: string): number {
  const r = db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM key_epochs WHERE scope = 'tenant' AND scope_id = ?`, [tenantId]);
  return r?.e ?? 1;
}

/**
 * 节点设备（§5.3 服务成员，v0 简化形态：与桌面同机引导、同一律所根下独立 node-device.json）。
 * 真实所内节点是另一台机器/进程——跨机器节点加入流程（证书导入与密钥包裹下发）列入 G1 缺口，
 * v0 用于验证「逐事项授权 → 包裹给节点设备 → 节点可解 / 撤销后不可解」的完整密钥路径。
 */
export function ensureNodeDevice(db: KernelDb, keysDir: string, identity: Identity, slugs: { firmSlug: string }): DeviceContext {
  const deviceId = `node_${slugs.firmSlug}`;
  const deviceFile = join(keysDir, "node-device.json");
  const row = db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ?`, [deviceId]);
  if (row && existsSync(deviceFile)) {
    const keys = readSecretFile<DeviceKeys>(deviceFile);
    return { deviceId, memberId: "node_service", cert: JSON.parse(row.cert_json) as DeviceCertificate, ...splitKeys(keys) };
  }
  if (row) archiveDeviceCert(db, deviceId, "rekeyed");
  const root = getFirmRootPrivateKey(keysDir);
  const keys = generateDeviceKeys();
  const now = Date.now();
  const cert = issueDeviceCertificate(root.privateKeyPem, {
    certId: `cert_${deviceId}_${now.toString(36)}`,
    memberId: "node_service",
    deviceId,
    role: "node",
    signPublicKeyPem: keys.signPublicKeyPem,
    encPublicKeyPem: keys.encPublicKeyPem,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 365 * 24 * 3600 * 1000).toISOString(),
  });
  db.run(
    `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue)
     VALUES (?,?,?,?,?,?,?, 'active', ?)
     ON CONFLICT(device_id) DO UPDATE SET cert_json = excluded.cert_json, sign_pub_pem = excluded.sign_pub_pem, enc_pub_pem = excluded.enc_pub_pem`,
    [deviceId, identity.tenantId, "node_service", "node", keys.signPublicKeyPem, keys.encPublicKeyPem, JSON.stringify(cert), currentTenantEpoch(db, identity.tenantId)],
  );
  writeSecret0600(deviceFile, {
    _comment: "G0 开发形态：节点设备私钥（生产为所内节点 TPM/硬件封存，导出受控并写入审计，§5.3）；切勿提交或外传。",
    ...keys,
  });
  return { deviceId, memberId: "node_service", cert, ...splitKeys(keys) };
}

export function getNodeDeviceKeys(keysDir: string): DeviceKeys {
  return readSecretFile<DeviceKeys>(join(keysDir, "node-device.json"));
}
