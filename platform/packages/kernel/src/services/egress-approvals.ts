/**
 * 出站批准凭据的内核侧（v9 第 02 篇 §9.5；第 04 篇 §3.3 approvals {decision, object_hash, scope, device_signature}；收敛偏离 D-16）：
 *
 * - issue：律师在可信界面确认跨边界动作后签发——以本机设备签名密钥签名（批准人来自可信界面，不来自模型参数）；
 *   绑定主体（租户、用户、设备、渠道）、事项、运行、用途、出站内容摘要、目的地、变体、范围、nonce 与截止时间；
 * - take：闸门在原本要拒绝的那一刻按（运行、用途、摘要、目的地）来取：“本次”凭据原子地一次用尽；“本任务内”只在本运行内、
 *   同一用途与目的地有效（检索的“本任务内”只能是改写后放行——第 02 篇 §8.3）；图像凭据在首次使用时绑定载荷摘要并**重新签名**
 *   （引擎会按模型限制压缩或裁剪图片，无法事先按原文件摘要绑定——如实残余；复核 S5-B05：绑定值在签名之内），之后同一运行重发同一图像按摘要放行；
 * - 凭据带签发时事项的审批策略指纹：密级、同意状态、四项依据、端点、全部化名、协作范围变化后旧凭据在闸门失效（复核 S5-B02/B18），事项更新时另行作废；
 *   当事人词典的增改不使凭据失效（闸门出站时按当前词典重筛）；
 * - revokeRun / revoke / revokeMatter：运行进入终态、宿主拒收决定、事项策略变化时作废。
 *
 * 残余（如实）：设备签名私钥仍在内核进程（方案第 04 篇 §1.1 设备密钥在主进程 TPM/DPAPI，属 W9）；闸门对内核取到的凭据独立验签与核对绑定字段，
 * 但内核本身是闸门的信任根——伪造凭据须同时攻破内核。
 */
import { randomBytes } from "node:crypto";
import { canonicalCredential, type ApprovalCredential, type ApprovalPurpose, type SignedApproval } from "@zr-legal/egress-gate";
import { newId } from "@zr-legal/domain";
import type { SessionSigner } from "@zr-legal/keys";
import type { KernelDb } from "../db.ts";

export interface ApprovalSigner {
  deviceId: string;
  /** 出站批准凭据在同步路径签名（会话签名密钥的落点，TPM 设计 v1 §4.2）。 */
  signer: SessionSigner;
}

interface Row {
  approval_id: string;
  digest: string | null;
  destination: string;
  scope: "once" | "task";
  uses: number;
  credential: string;
  signature: string;
}

/**
 * “本次”检索与抓取凭据的有效期（律师确认后到闸门实际出站之间）、“本任务内”的上限；
 * 图像凭据按本运行的总时长签发（绑定后同一运行重发同一图像不再确认——复核 S5-B07）。
 */
export const APPROVAL_TTL_ONCE_MS = 15 * 60_000;
export const APPROVAL_TTL_TASK_MS = 8 * 60 * 60_000;
export const APPROVAL_TTL_MEDIA_MS = APPROVAL_TTL_TASK_MS;

export class EgressApprovalStore {
  private readonly db: KernelDb;
  private readonly signer: ApprovalSigner;

  constructor(db: KernelDb, signer: ApprovalSigner) {
    this.db = db;
    this.signer = signer;
  }

  /** 闸门验签用的公钥表（设备 → 公钥）。 */
  publicKeys(): Record<string, string> {
    return { [this.signer.deviceId]: this.signer.signer.publicKeyPem };
  }

  issue(input: {
    approvalId: string;
    tenantId: string;
    matterId: string;
    runId: string;
    userId: string;
    channel: string;
    purpose: ApprovalPurpose;
    reason: string;
    digest: string | null;
    dest: string;
    variant: "original" | "generalized" | null;
    scope: "once" | "task";
    /** 签发时事项的审批策略指纹（approvalPolicyOf；闸门与当前指纹比对）。 */
    policy: string;
    ttlMs?: number;
  }): SignedApproval {
    if (input.purpose === "media" && (input.scope !== "once" || input.digest !== null)) throw new Error("图像批准只能逐次、按首次使用绑定");
    if (input.scope === "once" && input.purpose !== "media" && !input.digest) throw new Error("“本次允许”须绑定出站内容摘要");
    if (input.scope === "task" && input.digest !== null) throw new Error("“本任务内允许”不绑定单次内容");
    if (input.purpose === "search" && input.scope === "task" && input.variant !== "generalized") throw new Error("检索的“本任务内允许”只能是改写后放行");
    const ttl = input.ttlMs ?? (input.purpose === "media" ? APPROVAL_TTL_MEDIA_MS : input.scope === "once" ? APPROVAL_TTL_ONCE_MS : APPROVAL_TTL_TASK_MS);
    const exp = new Date(Date.now() + ttl).toISOString();
    const credential: ApprovalCredential = {
      v: 1,
      approval_id: input.approvalId || newId("approval"),
      tid: input.tenantId,
      uid: input.userId,
      mid: input.matterId,
      rid: input.runId,
      dev: this.signer.deviceId,
      channel: input.channel,
      purpose: input.purpose,
      digest: input.digest,
      dest: input.dest,
      variant: input.variant,
      scope: input.scope,
      nonce: randomBytes(16).toString("hex"),
      exp,
      pol: input.policy,
    };
    const signature = this.sign(credential);
    this.db.run(
      `INSERT INTO egress_approvals (approval_id, tenant_id, matter_id, run_id, user_id, device_id, channel, purpose, reason, digest, destination, variant, scope, nonce, expires_at, credential, signature)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        credential.approval_id,
        credential.tid,
        credential.mid,
        credential.rid,
        credential.uid,
        credential.dev,
        credential.channel,
        credential.purpose,
        input.reason,
        credential.digest,
        credential.dest,
        credential.variant,
        credential.scope,
        credential.nonce,
        credential.exp,
        JSON.stringify(credential),
        signature,
      ],
    );
    return { credential, signature };
  }

  private sign(c: ApprovalCredential): string {
    return this.signer.signer.signSync(new TextEncoder().encode(canonicalCredential(c)));
  }

  /**
   * 闸门取凭据（原子）。只返回仍有效、属于这一运行与用途、目的地一致的凭据；“本次”的检索与抓取须摘要一致且未用过——取到即用尽。
   * 图像：先找已绑定该载荷的凭据；否则把本运行内最早一张未使用的图像凭据绑定到该载荷（写入摘要、重新签名）。
   */
  take(q: { tenantId: string; matterId: string; runId: string; purpose: ApprovalPurpose; digest: string; dest: string }): SignedApproval | null {
    const now = new Date().toISOString();
    return this.db.tx(() => {
      const rows = this.db.all<Row>(
        `SELECT approval_id, digest, destination, scope, uses, credential, signature FROM egress_approvals
          WHERE tenant_id = ? AND matter_id = ? AND run_id = ? AND purpose = ? AND destination = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY created_at`,
        [q.tenantId, q.matterId, q.runId, q.purpose, q.dest, now],
      );
      const out = (r: Row): SignedApproval => ({ credential: JSON.parse(r.credential) as ApprovalCredential, signature: r.signature });
      if (q.purpose === "media") {
        for (const r of rows) {
          if (r.digest === q.digest) return out(r);
        }
        for (const r of rows) {
          if (r.uses !== 0 || r.digest !== null) continue;
          const bound: ApprovalCredential = { ...(JSON.parse(r.credential) as ApprovalCredential), digest: q.digest };
          const signature = this.sign(bound);
          const changed = this.db.run(
            `UPDATE egress_approvals SET uses = 1, digest = ?, bound_digests = ?, credential = ?, signature = ? WHERE approval_id = ? AND uses = 0 AND digest IS NULL`,
            [q.digest, JSON.stringify([q.digest]), JSON.stringify(bound), signature, r.approval_id],
          ).changes;
          if (changed === 1) return { credential: bound, signature };
        }
        return null;
      }
      for (const r of rows) {
        if (r.scope === "once" && r.digest === q.digest && r.uses === 0) {
          const changed = this.db.run(`UPDATE egress_approvals SET uses = 1 WHERE approval_id = ? AND uses = 0`, [r.approval_id]).changes;
          if (changed === 1) return out(r);
        }
      }
      for (const r of rows) {
        if (r.scope === "task" && r.digest === null) {
          this.db.run(`UPDATE egress_approvals SET uses = uses + 1 WHERE approval_id = ?`, [r.approval_id]);
          return out(r);
        }
      }
      return null;
    });
  }

  /** 运行进入终态：作废其全部凭据。 */
  revokeRun(runId: string): number {
    return this.db.run(`UPDATE egress_approvals SET revoked_at = ? WHERE run_id = ? AND revoked_at IS NULL`, [new Date().toISOString(), runId]).changes;
  }

  /** 作废一张凭据（宿主拒收律师的决定时——复核 S5-B06）。 */
  revoke(approvalId: string): number {
    return this.db.run(`UPDATE egress_approvals SET revoked_at = ? WHERE approval_id = ? AND revoked_at IS NULL`, [new Date().toISOString(), approvalId]).changes;
  }

  /** 事项策略变化（密级、四项依据、端点、全部化名等）：作废该事项全部未作废的凭据，进行中的运行须重新确认（复核 S5-B02）。 */
  revokeMatter(matterId: string): number {
    return this.db.run(`UPDATE egress_approvals SET revoked_at = ? WHERE matter_id = ? AND revoked_at IS NULL`, [new Date().toISOString(), matterId]).changes;
  }
}
