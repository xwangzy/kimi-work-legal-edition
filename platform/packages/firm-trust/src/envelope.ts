/**
 * 控制面签名信封（v9 第 02 篇 §7.1 #2–#4、§10；第 04 篇 §10）。
 *
 * 控制面用自己的 Ed25519 密钥签署它下发的每一份文档（许可、设备目录、租户盐、律所策略与连接器目录的外层、网关订阅）。
 * **控制面签名只证明“出自中软控制面”**：对收紧类内容（吊销、最严模板、许可期限）足够；放宽类策略、连接器登记与成员公钥
 * 另须律所侧校验锚（管理员设备签名、律所根公钥），控制面签名不能代替——这是“控制面被攻破”时律所侧仍能拒绝的前提。
 * 控制面公钥随客户端与网关构建固定（G0 开发形态经本机配置给出）。
 */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson } from "@zr-legal/keys";

export interface CpEnvelope<T = unknown> {
  kind: string;
  kid: string;
  body: T;
  sig: string;
}

export interface CpSigningKey {
  kid: string;
  privateKey: KeyObject;
}

/** 域分隔前缀：同一把密钥签署的其他格式（席位令牌等）不会被当作信封接受。 */
const DOMAIN = "kwl-control-plane-envelope-v1\n";

export function envelopeBytes(kind: string, kid: string, body: unknown): Buffer {
  return Buffer.from(DOMAIN + canonicalJson({ kind, kid, body }), "utf8");
}

export function sealEnvelope<T>(kind: string, body: T, key: CpSigningKey): CpEnvelope<T> {
  return { kind, kid: key.kid, body, sig: sign(null, envelopeBytes(kind, key.kid, body), key.privateKey).toString("base64url") };
}

export type OpenResult<T> = { ok: true; body: T; kid: string } | { ok: false; reason: string };

/** 验信封：种类相符、kid 在固定的公钥表里、签名有效；任何异常形态都按无效处理（不抛）。 */
export function openEnvelope<T>(envelope: unknown, kind: string, keys: ReadonlyMap<string, KeyObject>): OpenResult<T> {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { ok: false, reason: "envelope_malformed" };
  const e = envelope as Partial<CpEnvelope<T>>;
  if (e.kind !== kind) return { ok: false, reason: "envelope_kind_mismatch" };
  if (typeof e.kid !== "string" || typeof e.sig !== "string" || !("body" in e)) return { ok: false, reason: "envelope_malformed" };
  const key = keys.get(e.kid);
  if (!key) return { ok: false, reason: "envelope_unknown_key" };
  let ok = false;
  try {
    ok = verify(null, envelopeBytes(kind, e.kid, e.body), key, Buffer.from(e.sig, "base64url"));
  } catch {
    ok = false;
  }
  return ok ? { ok: true, body: e.body as T, kid: e.kid } : { ok: false, reason: "envelope_signature_invalid" };
}

/** 公钥表（kid → PEM）→ KeyObject 表；格式不对的条目跳过（调用方据表是否为空判断配置是否可用）。 */
export function publicKeyMap(pems: Readonly<Record<string, string>>): Map<string, KeyObject> {
  const out = new Map<string, KeyObject>();
  for (const [kid, pem] of Object.entries(pems)) {
    try {
      out.set(kid, createPublicKey(pem));
    } catch {
      // 跳过
    }
  }
  return out;
}

/** 解析本机配置中的公钥表（JSON：{"kid":"PEM"}）；无效即空表。 */
export function parsePublicKeyMap(json: string | undefined | null): Map<string, KeyObject> {
  if (!json) return new Map();
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return new Map();
    const pems: Record<string, string> = {};
    for (const [k, p] of Object.entries(v as Record<string, unknown>)) if (typeof p === "string") pems[k] = p;
    return publicKeyMap(pems);
  } catch {
    return new Map();
  }
}
