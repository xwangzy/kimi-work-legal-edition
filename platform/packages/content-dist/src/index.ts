/**
 * 内容分发格式（v9.2 §5.1 S6 法规增量包、S7 方法模板分发；Y2 §3.6–3.8）。不含联网代码：云端分发服务、发布脚本与本机内核共用。
 *
 * - 通道清单 `GET /dist/<kind>/<channel>/latest.json` = 签名信封 { manifest, kid, sig }：sig 为内容签名私钥对 canonicalJson(manifest)
 *   的 Ed25519 签名；kid = 内容签名公钥指纹（与法规库包 signer_key_id 同一算法）。内容签名域独立于控制面与发布签名（Y2 §3.6 密钥）。
 * - 清单写明“通道序号 seq”（每个内容类别、每个通道单调递增）——法规库与方法模板包自带的版本号由内容摘要派生、不可比较先后，
 *   **先后只认签名清单的 seq**；本机按 seq 防回退（高水位记在账本）。
 * - 有效期：清单带 issued_at / expires_at（≤ 90 天）；过期清单不采用（防“冻结在旧版本”）。随包分发的同格式信封（<kind>.release.json）
 *   只用来给随包内容定 seq，不看有效期。
 * - 分阶段推送：staging_percent 按（设备编号, seq）的摘要分桶；撤回：revoked_seqs 列出的序号本机不再使用。
 * - 包：法规库全量包或增量包（SQLite + sidecar 清单，包自身仍按 packages/lawdb 的签名核验），方法模板包为单文件 kwl-skills-pack/1。
 */
import { canonicalJson, sha256B64, verifyBytes } from "@zr-legal/keys";

export type ContentKind = "lawdb" | "skills";
export type DistChannel = "stable" | "beta";
export const CONTENT_KINDS: readonly ContentKind[] = Object.freeze(["lawdb", "skills"]);
export const DIST_CHANNELS: readonly DistChannel[] = Object.freeze(["stable", "beta"]);

export interface DistPackage {
  type: "full" | "incremental";
  /** 应用后的内容版本（法规库 package_version；方法模板包为内容摘要前 16 位）。 */
  version: string;
  /** 增量包的前一版本（只有当前版本等于它才能应用）。 */
  base_version?: string;
  file: string;
  size: number;
  sha256: string;
  /** 法规库包的 sidecar 清单文件（包自身的签名在其中）。 */
  manifest_file?: string;
  manifest_size?: number;
  manifest_sha256?: string;
}

export interface ChannelManifest {
  schema: "kwl-dist/1";
  kind: ContentKind;
  channel: DistChannel;
  seq: number;
  version: string;
  /** 应用后的内容摘要（法规库 computeContentSha256；方法模板包清单的 content_sha256）。 */
  content_sha256: string;
  issued_at: string;
  expires_at: string;
  staging_percent: number;
  revoked_seqs: number[];
  packages: DistPackage[];
}

export interface SignedChannelManifest {
  manifest: ChannelManifest;
  kid: string;
  sig: string;
}

/** 单个包文件上限：闸门经 IPC 以 base64 交回，取 64 MiB（与 egress-gate DIST_MAX_RESPONSE_BYTES 一致）。 */
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const MAX_MANIFEST_DAYS = 90;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SHA_RE = /^[A-Za-z0-9_-]{43}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 内容签名公钥指纹（与 @zr-legal/lawdb signerKeyId 同一算法）。 */
export function contentKeyId(publicKeyPem: string): string {
  return sha256B64(publicKeyPem).slice(0, 16);
}

/**
 * 组装签名信封。签名由调用方给出（本包不持私钥、不按私钥签名——KP-02 门禁）：离线发布脚本以内容签名私钥签，
 * 正式环境在离线签名机或 HSM 里签。
 */
export function signChannelManifest(manifest: ChannelManifest, sign: (bytes: Uint8Array) => string, publicKeyPem: string): SignedChannelManifest {
  const bad = manifestShapeProblem(manifest);
  if (bad) throw new Error(`通道清单格式不符：${bad}`);
  return { manifest, kid: contentKeyId(publicKeyPem), sig: sign(new TextEncoder().encode(canonicalJson(manifest))) };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isIso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v));

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

function packageProblem(p: unknown, kind: ContentKind): string | null {
  if (!isObj(p)) return "package";
  if (!onlyKeys(p, ["type", "version", "base_version", "file", "size", "sha256", "manifest_file", "manifest_size", "manifest_sha256"])) return "package_fields";
  if (p.type !== "full" && p.type !== "incremental") return "package_type";
  if (typeof p.version !== "string" || !VERSION_RE.test(p.version)) return "package_version";
  if (typeof p.file !== "string" || !FILE_RE.test(p.file)) return "package_file";
  if (!isInt(p.size, 1, MAX_PACKAGE_BYTES) || typeof p.sha256 !== "string" || !SHA_RE.test(p.sha256)) return "package_digest";
  if (p.type === "incremental" && (typeof p.base_version !== "string" || !VERSION_RE.test(p.base_version) || p.base_version === p.version)) return "package_base";
  if (p.type === "full" && p.base_version !== undefined) return "package_base";
  if (kind === "lawdb") {
    if (typeof p.manifest_file !== "string" || !FILE_RE.test(p.manifest_file) || p.manifest_file === p.file) return "package_manifest";
    if (!isInt(p.manifest_size, 1, 1024 * 1024) || typeof p.manifest_sha256 !== "string" || !SHA_RE.test(p.manifest_sha256)) return "package_manifest";
  } else {
    if (p.type !== "full") return "package_type";
    if (p.manifest_file !== undefined || p.manifest_size !== undefined || p.manifest_sha256 !== undefined) return "package_manifest";
  }
  return null;
}

/** 清单结构核验（不含签名与时效）；返回问题代码或 null。 */
export function manifestShapeProblem(m: unknown): string | null {
  if (!isObj(m)) return "manifest";
  if (!onlyKeys(m, ["schema", "kind", "channel", "seq", "version", "content_sha256", "issued_at", "expires_at", "staging_percent", "revoked_seqs", "packages"])) return "fields";
  if (m.schema !== "kwl-dist/1") return "schema";
  if (!CONTENT_KINDS.includes(m.kind as ContentKind)) return "kind";
  if (!DIST_CHANNELS.includes(m.channel as DistChannel)) return "channel";
  if (!isInt(m.seq, 1, 2 ** 31 - 1)) return "seq";
  if (typeof m.version !== "string" || !VERSION_RE.test(m.version)) return "version";
  if (typeof m.content_sha256 !== "string" || !SHA_RE.test(m.content_sha256)) return "content_sha256";
  if (!isIso(m.issued_at) || !isIso(m.expires_at)) return "time";
  const span = Date.parse(m.expires_at) - Date.parse(m.issued_at);
  if (span <= 0 || span > MAX_MANIFEST_DAYS * 86_400_000) return "time";
  if (!isInt(m.staging_percent, 0, 100)) return "staging";
  if (!Array.isArray(m.revoked_seqs) || m.revoked_seqs.length > 1000 || !m.revoked_seqs.every((s) => isInt(s, 1, 2 ** 31 - 1)) || m.revoked_seqs.includes(m.seq)) return "revoked";
  if (!Array.isArray(m.packages) || m.packages.length > 20) return "packages";
  const files = new Set<string>();
  for (const p of m.packages) {
    const bad = packageProblem(p, m.kind as ContentKind);
    if (bad) return bad;
    const pk = p as DistPackage;
    for (const f of [pk.file, pk.manifest_file]) {
      if (!f) continue;
      if (files.has(f)) return "package_file_dup";
      files.add(f);
    }
  }
  const fulls = (m.packages as DistPackage[]).filter((p) => p.type === "full");
  if (fulls.length > 1 || fulls.some((p) => p.version !== m.version)) return "package_full";
  return null;
}

export type VerifyResult = { ok: true; manifest: ChannelManifest; kid: string } | { ok: false; reason: string };

/**
 * 核验签名清单：结构、签名（kid 必须在本机信任表内）、类别与通道相符、时效（ignoreExpiry 只用于随包信封）。
 * 时刻容差 5 分钟（本机时钟稍快于云端）。
 */
export function verifyChannelManifest(
  raw: unknown,
  keys: ReadonlyMap<string, string>,
  o: { kind: ContentKind; channel?: DistChannel; now?: number; ignoreExpiry?: boolean },
): VerifyResult {
  if (!isObj(raw) || !onlyKeys(raw, ["manifest", "kid", "sig"])) return { ok: false, reason: "envelope" };
  if (typeof raw.kid !== "string" || !KID_RE.test(raw.kid) || typeof raw.sig !== "string") return { ok: false, reason: "envelope" };
  const pem = keys.get(raw.kid);
  if (!pem) return { ok: false, reason: "unknown_key" };
  const bad = manifestShapeProblem(raw.manifest);
  if (bad) return { ok: false, reason: `shape_${bad}` };
  const m = raw.manifest as ChannelManifest;
  if (!verifyBytes(pem, new TextEncoder().encode(canonicalJson(m)), raw.sig)) return { ok: false, reason: "signature" };
  if (m.kind !== o.kind) return { ok: false, reason: "kind_mismatch" };
  if (o.channel && m.channel !== o.channel) return { ok: false, reason: "channel_mismatch" };
  if (!o.ignoreExpiry) {
    const now = o.now ?? Date.now();
    if (Date.parse(m.issued_at) > now + 5 * 60_000) return { ok: false, reason: "not_yet_valid" };
    if (Date.parse(m.expires_at) <= now) return { ok: false, reason: "expired" };
  }
  return { ok: true, manifest: m, kid: raw.kid };
}

/** 分阶段推送分桶：0–99，由（设备编号, seq）摘要决定——同一设备对同一版本结论稳定，不同版本重新分桶。 */
export function stagingBucket(deviceId: string, seq: number): number {
  const h = sha256B64(`kwl-dist-stage\u0000${deviceId}\u0000${seq}`);
  return Buffer.from(h, "base64url").readUInt16BE(0) % 100;
}

export function inRollout(m: Pick<ChannelManifest, "staging_percent" | "seq">, deviceId: string): boolean {
  return m.staging_percent >= 100 || stagingBucket(deviceId, m.seq) < m.staging_percent;
}

export type InstallPlan = { type: "full"; packages: [DistPackage] } | { type: "incremental"; packages: DistPackage[] };

/**
 * 选包：当前版本能沿增量链到达清单版本就走增量（每步 base_version 等于上一步版本，最多 20 步），否则走全量；都不行返回 null。
 * 方法模板包只有全量。
 */
export function planInstall(m: ChannelManifest, currentVersion: string | null): InstallPlan | null {
  if (currentVersion === m.version) return null;
  if (currentVersion) {
    const chain: DistPackage[] = [];
    let cur = currentVersion;
    const seen = new Set<string>([cur]);
    while (cur !== m.version && chain.length < 20) {
      const next = m.packages.find((p) => p.type === "incremental" && p.base_version === cur);
      if (!next || seen.has(next.version)) break;
      chain.push(next);
      seen.add(next.version);
      cur = next.version;
    }
    if (cur === m.version && chain.length > 0) return { type: "incremental", packages: chain };
  }
  const full = m.packages.find((p) => p.type === "full");
  return full ? { type: "full", packages: [full] } : null;
}

/** 下载文件核对：大小与摘要都须与清单一致。 */
export function fileMatches(bytes: Uint8Array, size: number, sha256: string): boolean {
  return bytes.byteLength === size && sha256B64(bytes) === sha256;
}

// ─── 方法模板包（单文件） ───

export interface SkillsPack {
  schema: "kwl-skills-pack/1";
  /** 原样的 skills.manifest.json 文本（内核按 skills-bundle 的规则验签）。 */
  manifest: string;
  files: { path: string; data: string }[];
}

const PACK_PATH_RE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_\-一-鿿][A-Za-z0-9._\-一-鿿/]{0,199}$/;

/** 解析方法模板包；只做结构与路径检查（越界、重复、绝对路径一律拒绝），签名与逐文件摘要由内核按 skills 清单核验。 */
export function parseSkillsPack(bytes: Uint8Array): { ok: true; pack: SkillsPack } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { ok: false, reason: "pack_json" };
  }
  if (!isObj(raw) || !onlyKeys(raw, ["schema", "manifest", "files"]) || raw.schema !== "kwl-skills-pack/1" || typeof raw.manifest !== "string" || !Array.isArray(raw.files)) return { ok: false, reason: "pack_shape" };
  if (raw.files.length > 2000) return { ok: false, reason: "pack_too_many" };
  const seen = new Set<string>();
  for (const f of raw.files) {
    if (!isObj(f) || !onlyKeys(f, ["path", "data"]) || typeof f.path !== "string" || typeof f.data !== "string") return { ok: false, reason: "pack_file" };
    if (!PACK_PATH_RE.test(f.path) || f.path.includes("//") || f.path.endsWith("/")) return { ok: false, reason: "pack_path" };
    const key = f.path.toLowerCase();
    if (seen.has(key)) return { ok: false, reason: "pack_dup" };
    seen.add(key);
  }
  return { ok: true, pack: raw as unknown as SkillsPack };
}
