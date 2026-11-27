/**
 * 第 72 批（U-2，D-304）：团队成员由账号签发钥（account_ca）直接登记的电脑“事后确认”为可接收团队共享事项——成员电脑一侧。
 *
 * 团队共享事项的密钥只包给律所根签发的设备（governance.ts 目录同步跳过 account_ca 证书、member-log.ts 作者证书只认律所根）。
 * 这台电脑用**现有的**设备编号与两把公钥向云端提交申请（请求体为空：云端按设备记录取公钥），界面显示 12 位核对码（joinCheckCode，
 * 与入组同一算法）；律所根电脑上的管理员核对一致后用律所根签同编号、同公钥、同成员与角色的新证书批准；这里取回后：
 * - 只按**本机**律所身份里的根公钥核验（不信应答里的根公钥）、签发者须为律所根、编号 / 成员 / 两把公钥与本机一致、角色不高于本机证书；
 * - 一个事务里把旧证书留档（device_cert_history）并换上新证书（设备密钥不动）——事务失败旧证书原样保留；
 * - 请主进程重启内核（各组件按新证书装载，之后的设备登记带新证书）。
 *
 * 状态文件 <工作区>/share-confirm.json 只有申请编号与时间（无秘密）。待处理期间每 15 秒取一次结果。
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyDeviceCertificate, type DeviceCertificate } from "@zr-legal/keys";
import { certIssuerOf, joinCheckCode } from "@zr-legal/firm-trust";
import { DomainError } from "@zr-legal/domain";
import { slog } from "@zr-legal/safe-log";
import type { KernelDb } from "../db.ts";
import type { DeviceContext, FirmIdentityRow } from "../devices.ts";
import { archiveDeviceCert } from "../devices.ts";

type CallResult = { ok: true; status: number; json: Record<string, unknown> } | { ok: false; error: string; status?: number; message?: string };

export interface DeviceShareDeps {
  db: KernelDb;
  tenantId: string;
  userId: string;
  device: Pick<DeviceContext, "deviceId" | "cert" | "keys">;
  firm: Pick<FirmIdentityRow, "rootPublicKeyPem">;
  workspaceDir: string;
  /** 设备签名（+ 本机会话）的控制面请求。 */
  call: (method: string, path: string, body?: unknown) => Promise<CallResult>;
  /** 换上新证书后请主进程重启内核（kernel.restart_for_identity）。 */
  requestRestart: () => void;
  /** 本机审计（只记编号）。 */
  audit: (action: string, objectId: string) => void;
  pollMs?: number;
}

interface ShareConfirmFile {
  v: 1;
  request_id: string;
  requested_at: string;
}

export type ShareConfirmState = "confirmed" | "none" | "pending" | "rejected" | "expired" | "withdrawn";

const STATE_FILE = "share-confirm.json";
const ROLE_RANK: Readonly<Record<string, number>> = { assistant: 0, lawyer: 1, partner: 2, admin: 3 };
const REQUEST_ID_RE = /^jr_[A-Za-z0-9_-]{16}$/;

const ERROR_TEXT: Record<string, string> = {
  team_only: "个人工作空间没有团队共享事项",
  already_firm_root: "这台电脑已可接收团队共享事项",
  account_disabled: "你在这个团队的成员身份已停用或已移出团队",
  session_required: "请先登录",
  session_invalid: "登录已失效，请重新登录",
  too_many_pending: "团队里等待确认的申请过多，请稍后再试",
  root_not_enrolled: "团队还没有完成开通",
};

export class DeviceShareConfirm {
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<Record<string, unknown>> | null = null;
  private adopted = false;

  private readonly d: DeviceShareDeps;
  constructor(d: DeviceShareDeps) {
    this.d = d;
  }

  /** 本机证书的签发者：firm_root = 已可接收团队共享事项。 */
  issuer(): "firm_root" | "account_ca" {
    return this.adopted ? "firm_root" : certIssuerOf(this.d.device.cert);
  }

  /** 这台电脑的 12 位核对码（与管理员电脑按申请里的公钥独立算出的应一致）。 */
  checkCode(): string {
    return joinCheckCode({ tid: this.d.tenantId, deviceId: this.d.device.deviceId, signPublicKeyPem: this.d.device.keys.signPublicKeyPem, encPublicKeyPem: this.d.device.keys.encPublicKeyPem });
  }

  private path(): string {
    return join(this.d.workspaceDir, STATE_FILE);
  }
  private read(): ShareConfirmFile | null {
    try {
      const j = JSON.parse(readFileSync(this.path(), "utf8")) as ShareConfirmFile;
      return j && j.v === 1 && REQUEST_ID_RE.test(String(j.request_id)) ? j : null;
    } catch {
      return null;
    }
  }
  private write(f: ShareConfirmFile): void {
    const tmp = `${this.path()}.tmp`;
    writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
    renameSync(tmp, this.path());
  }
  private drop(): void {
    rmSync(this.path(), { force: true });
  }

  /** 启动：本机有待处理的申请就开始轮询（内核关闭时 stop）。 */
  start(): void {
    if (this.issuer() === "firm_root") {
      // 已确认（换证后重启）：清掉残留的申请记录
      if (existsSync(this.path())) this.drop();
      return;
    }
    if (this.read()) this.poll();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  private poll(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.status().catch(() => undefined), this.d.pollMs ?? 15_000);
    this.timer.unref?.();
  }

  private fail(r: { ok: false; error: string; status?: number; message?: string }): never {
    const code = r.error;
    throw new DomainError(code === "account_disabled" ? "forbidden" : "conflict", ERROR_TEXT[code] ?? r.message ?? "没有完成，请稍后重试", code === "account_disabled" ? 403 : r.status && r.status < 500 ? 409 : 502, { reason: code });
  }

  private view(state: ShareConfirmState, f: ShareConfirmFile | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { state, issuer: this.issuer(), ...(state === "pending" && f ? { request_id: f.request_id, requested_at: f.requested_at, check_code: this.checkCode() } : {}), ...extra };
  }

  /** 发起（或取回已有的待处理申请）。 */
  async request(): Promise<Record<string, unknown>> {
    if (this.issuer() === "firm_root") return this.view("confirmed", null);
    const r = await this.d.call("POST", "/v1/join-requests/upgrade", {});
    if (!r.ok) {
      if (r.error === "already_firm_root") return this.status();
      this.fail(r);
    }
    const id = String(r.json.join_request_id ?? "");
    if (!REQUEST_ID_RE.test(id)) throw new DomainError("provider_unavailable", "云端的应答格式不对，请稍后重试", 502);
    const f: ShareConfirmFile = { v: 1, request_id: id, requested_at: typeof r.json.created_at === "string" ? r.json.created_at : new Date().toISOString() };
    this.write(f);
    this.d.audit("device.share_confirm_request", this.d.device.deviceId);
    this.poll();
    return this.view("pending", f);
  }

  /** 撤回待处理的申请（云端联不上也在本机放下，云端 7 天后自行过期）。 */
  async withdraw(): Promise<Record<string, unknown>> {
    const f = this.read();
    if (!f) return this.view(this.issuer() === "firm_root" ? "confirmed" : "none", null);
    const r = await this.d.call("POST", `/v1/join-requests/${f.request_id}/withdraw`, {});
    if (r.ok && r.json.status === "approved") return this.status();
    this.drop();
    this.stop();
    this.d.audit("device.share_confirm_withdraw", this.d.device.deviceId);
    return this.view("withdrawn", null, r.ok ? {} : { offline: true });
  }

  /** 当前状态；待处理时向云端取一次结果，批准了就核验并换证（单飞）。 */
  status(): Promise<Record<string, unknown>> {
    this.inflight ??= this.doStatus().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doStatus(): Promise<Record<string, unknown>> {
    if (this.issuer() === "firm_root") return this.view("confirmed", null);
    const f = this.read();
    if (!f) return this.view("none", null);
    const r = await this.d.call("POST", `/v1/join-requests/${f.request_id}/fetch`, {});
    if (!r.ok) {
      if (r.error === "join_unknown") {
        this.drop();
        this.stop();
        return this.view("none", null);
      }
      return this.view("pending", f, { checked: false });
    }
    const st = String(r.json.status ?? "");
    if (st === "pending") return this.view("pending", f, { checked: true });
    if (st === "approved") {
      const cert = r.json.cert as DeviceCertificate | undefined;
      const why = this.adopt(cert);
      if (why) {
        // 核对不通过：不采用，保留申请记录（管理员可拒绝后重新申请）；告诉界面原因
        slog.event("KERNEL_SHARE_CONFIRM_REJECTED", { reason: why });
        return this.view("pending", f, { checked: true, problem: why });
      }
      this.drop();
      this.stop();
      return this.view("confirmed", null, { restart: true });
    }
    this.drop();
    this.stop();
    return this.view(st === "expired" ? "expired" : st === "withdrawn" ? "withdrawn" : "rejected", null);
  }

  /**
   * 核验并换上律所根签的新证书。返回 null = 已换上（随后请求重启）；否则为不采用的原因。
   * 只按本机律所身份的根公钥核验；编号、成员、两把公钥与本机一致；角色不高于本机现有证书（云端与管理员都不能借此提权）。
   */
  adopt(cert: DeviceCertificate | undefined): string | null {
    const own = this.d.device;
    if (!cert || typeof cert !== "object") return "cert_missing";
    if (certIssuerOf(cert) !== "firm_root") return "issuer_not_firm_root";
    const v = verifyDeviceCertificate(cert, this.d.firm.rootPublicKeyPem, new Date());
    if (!v.ok) return "cert_invalid";
    if (cert.deviceId !== own.deviceId || cert.memberId !== this.d.userId) return "identity_mismatch";
    if (cert.signPublicKeyPem !== own.keys.signPublicKeyPem || cert.encPublicKeyPem !== own.keys.encPublicKeyPem) return "key_mismatch";
    if ((ROLE_RANK[cert.role] ?? 99) > (ROLE_RANK[own.cert.role] ?? -1)) return "role_raised";
    const { db } = this.d;
    let rowMismatch = false;
    try {
      db.tx(() => {
        const row = db.get<{ sign_pub_pem: string; enc_pub_pem: string }>(`SELECT sign_pub_pem, enc_pub_pem FROM devices WHERE device_id = ? AND tenant_id = ?`, [own.deviceId, this.d.tenantId]);
        if (!row || row.sign_pub_pem !== own.keys.signPublicKeyPem || row.enc_pub_pem !== own.keys.encPublicKeyPem) {
          rowMismatch = true;
          throw new Error("own_row_mismatch");
        }
        // 旧证书留档：旧证书签出的历史见证、审批与回执仍要能验签（同 rekeyed）
        archiveDeviceCert(db, own.deviceId, "rekeyed");
        db.run(`UPDATE devices SET cert_json = ?, role = ? WHERE device_id = ? AND tenant_id = ?`, [JSON.stringify(cert), cert.role, own.deviceId, this.d.tenantId]);
      });
    } catch {
      slog.event("KERNEL_SHARE_CONFIRM_APPLY_FAILED", { reason: rowMismatch ? "own_row_mismatch" : "db" });
      return "apply_failed";
    }
    this.adopted = true;
    this.d.audit("device.share_confirmed", own.deviceId);
    slog.event("KERNEL_SHARE_CONFIRMED", {});
    setTimeout(() => this.d.requestRestart(), 300).unref?.();
    return null;
  }
}
