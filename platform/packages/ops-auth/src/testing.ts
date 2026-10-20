/**
 * 仅测试与开发（`@zr-legal/ops-auth/testing`；生产入口与服务不引用）：一份签好的名册（每人一把 Ed25519 密钥，密钥编号 k1）、
 * 名册签名公钥表，以及按人签请求的函数；fileOpsGuard 把名册写进目录并返回守卫（随机数、版本记录、换版记录落在同一目录）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import {
  createOpsGuard,
  fileNonceStore,
  fileRosterSource,
  generateOpsKeyPair,
  OPS_ROSTER_FORMAT,
  signOpsRequest,
  signOpsRoster,
  type OpsAudience,
  type OpsGuard,
  type OpsOperator,
  type OpsPermission,
  type OpsRejectRecord,
  type OpsRequestParts,
  type OpsRosterBody,
  type SignedOpsRoster,
} from "./index.ts";

export type DevOperator = { id: string; perms: OpsPermission[]; status?: OpsOperator["status"]; second_factor?: string };

export function devOpsRoster(operators: DevOperator[], o: { version?: number; deployment?: string; issuedAt?: number; ttlMs?: number } = {}) {
  const deployment = o.deployment ?? "test";
  const signerKey = generateOpsKeyPair();
  const signer = { kid: "sec-dev", privateKey: signerKey.privateKeyPem };
  const issued = o.issuedAt ?? Date.now();
  const personal = new Map(operators.map((x) => [x.id, generateOpsKeyPair()]));
  const body = (v: number, ops: DevOperator[] = operators, extra: { issuedAt?: number; ttlMs?: number; deployment?: string } = {}): OpsRosterBody => {
    const at = extra.issuedAt ?? issued;
    return {
      format: OPS_ROSTER_FORMAT,
      deployment: extra.deployment ?? deployment,
      version: v,
      issued_at: new Date(at).toISOString(),
      expires_at: new Date(at + (extra.ttlMs ?? o.ttlMs ?? 30 * 24 * 3600_000)).toISOString(),
      operators: ops.map((x) => {
        if (!personal.has(x.id)) personal.set(x.id, generateOpsKeyPair());
        return {
          id: x.id,
          status: x.status ?? "active",
          perms: [...x.perms],
          keys: [{ kid: "k1", public_key_pem: personal.get(x.id)!.publicKeyPem, added_at: new Date(at).toISOString() }],
          second_factor: x.second_factor ?? "none",
          ...(x.status === "revoked" ? { revoked_at: new Date(at).toISOString() } : {}),
        };
      }),
    };
  };
  return {
    deployment,
    roster: signOpsRoster(body(o.version ?? 1), signer),
    rosterKeys: new Map([[signer.kid, signerKey.publicKeyPem]]) as ReadonlyMap<string, string>,
    rosterSigner: signer,
    body,
    /** 用同一名册签名密钥重签一份（版本与人员可改；用于吊销与回滚用例）。 */
    resign: (v: number, ops: DevOperator[] = operators, extra: { issuedAt?: number; ttlMs?: number; deployment?: string } = {}) => signOpsRoster(body(v, ops, extra), signer),
    keyOf: (id: string) => ({ kid: "k1", privateKeyPem: personal.get(id)!.privateKeyPem, publicKeyPem: personal.get(id)!.publicKeyPem }),
    sign: (id: string, audience: OpsAudience, req: OpsRequestParts, now?: number, dep = deployment) =>
      signOpsRequest({ ...req, deployment: dep, audience, operator: id, kid: "k1", privateKey: personal.get(id)!.privateKeyPem, ...(now !== undefined ? { now } : {}) }),
  };
}

export function fileOpsGuard(o: { dir: string; audience: OpsAudience; roster: SignedOpsRoster; rosterKeys: ReadonlyMap<string, string | KeyObject>; deployment?: string; now?: () => number; onReject?: (r: OpsRejectRecord) => void }): OpsGuard {
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${o.dir}/roster.json`, JSON.stringify(o.roster), { mode: 0o600 });
  return createOpsGuard({
    audience: o.audience,
    roster: fileRosterSource({ file: `${o.dir}/roster.json`, keys: o.rosterKeys, deployment: o.deployment ?? o.roster.body.deployment, seenFile: `${o.dir}/roster-seen.json`, historyFile: `${o.dir}/roster-history.jsonl`, ...(o.now ? { now: o.now } : {}) }),
    nonces: fileNonceStore(`${o.dir}/nonces.jsonl`),
    ...(o.now ? { now: o.now } : {}),
    ...(o.onReject ? { onReject: o.onReject } : {}),
  });
}
