/**
 * 出站闸门进程入口（第 04 篇 §1.1：独立签名进程，唯一出口；开发与测试由内核以 child_process.fork 拉起，产品形态为独立签名二进制）。
 *
 * - 只经 IPC 与内核通信，内核断开即退出；只监听内核指定的本机套接字/命名管道（无 TCP 端口）；
 * - 令牌活性、事项策略与令牌化上下文全部来自内核（authorize 调用，超时或断开即拒绝——失败关闭）；
 * - 去向记录与新令牌条目回送内核写入事项账本；闸门不落盘、不写正文日志；
 * - 环境变量不继承内核（席位凭据与上游地址经 init 下发，不进环境）。
 *
 * 协议（JSON 消息）：
 *   内核 → 闸门：{t:"init", config} | {t:"result", id, ok, result | error} | {t:"revoke", runId} | {t:"seat", token} | {t:"cp", id, req} | {t:"shutdown"}
 *   闸门 → 内核：{t:"ready"} | {t:"call", id, method:"authorize"|"approval", params} | {t:"record", rec} | {t:"tokens", matterId, entries}
 *               | {t:"cp_result", id, result} | {t:"fatal", message}
 * 控制面通道（阶段 6，cp-relay.ts）：只有内核持有 IPC，故 Agent 宿主与执行域都不能借闸门访问控制面；目的地为 init 下发的固定地址。
 */
import { rmSync } from "node:fs";
import { EgressGateServer } from "./server.ts";
import { relayControlPlane, type CpRelayRequest } from "./cp-relay.ts";
import { checkUpstream, upstreamFetch, type TransportCheck } from "./tls-policy.ts";
import type { AuthorizeResult, GateAuthority, GateEgressRecord, GatePurpose, GateUpstreams } from "./types.ts";
import type { SignedApproval } from "./approval.ts";
import type { TokenEntry } from "@zr-legal/tokenizer";

export interface GateInitConfig {
  /** 本机套接字（POSIX）或命名管道（Windows）。 */
  socketPath: string;
  upstreams: GateUpstreams;
  /** authorize 调用的超时（缺省 5 秒；超时按拒绝处理）。 */
  authorizeTimeoutMs?: number;
  /** 批准凭据验签公钥（设备 ID → PEM；W1）。 */
  approvalKeys?: Record<string, string>;
}

type Msg =
  | { t: "init"; config: GateInitConfig }
  | { t: "result"; id: number; ok: boolean; result?: unknown; error?: { message?: string } }
  | { t: "revoke"; runId: string }
  | { t: "seat"; token: string }
  | { t: "cp"; id: number; req: CpRelayRequest }
  | { t: "shutdown" };

const send = (m: unknown): void => {
  if (process.connected) process.send?.(m);
};

let nextId = 1;
/** 待内核作答的调用：authorize（结果按结构校验）与 approval（批准凭据；闸门另行验签）。 */
const pending = new Map<number, { method: "authorize" | "approval"; resolve: (v: any) => void; timer: NodeJS.Timeout }>();
let server: EgressGateServer | null = null;
let socketPath: string | null = null;
let controlPlaneBase: string | null = null;
let controlPlaneTransport: TransportCheck | undefined;
let controlPlaneFetch: typeof fetch | undefined;

function ipcAuthority(timeoutMs: number): GateAuthority {
  return {
    authorize(params: { token: string; matterId: string; purpose: GatePurpose; light?: boolean }): Promise<AuthorizeResult> {
      if (!process.connected) return Promise.resolve({ ok: false, status: 503, reason: "kernel_unreachable" });
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, status: 503, reason: "authorize_timeout" });
        }, timeoutMs);
        pending.set(id, { method: "authorize", resolve, timer });
        send({ t: "call", id, method: "authorize", params });
      });
    },
    approval(params): Promise<SignedApproval | null> {
      if (!process.connected) return Promise.resolve(null);
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(null);
        }, timeoutMs);
        pending.set(id, { method: "approval", resolve, timer });
        send({ t: "call", id, method: "approval", params });
      });
    },
    record(rec: GateEgressRecord): void {
      send({ t: "record", rec });
    },
    tokens(matterId: string, entries: TokenEntry[]): void {
      send({ t: "tokens", matterId, entries });
    },
  };
}

async function shutdown(code = 0): Promise<never> {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve(p.method === "approval" ? null : { ok: false, status: 503, reason: "gate_shutting_down" });
  }
  pending.clear();
  await server?.close().catch(() => {});
  if (socketPath && process.platform !== "win32") rmSync(socketPath, { force: true });
  process.exit(code);
}

process.on("message", (raw: unknown) => {
  const m = raw as Msg;
  if (m?.t === "init") {
    if (server) return;
    // 证书校验不得被放宽（闸门不继承内核环境；这里再核一次，防止被以其他方式注入）
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
      send({ t: "fatal", message: "闸门进程的证书校验被关闭（NODE_TLS_REJECT_UNAUTHORIZED=0），拒绝工作" });
      void shutdown(1);
      return;
    }
    socketPath = m.config.socketPath;
    controlPlaneBase = m.config.upstreams.controlPlane?.baseUrl ?? null;
    const tls = m.config.upstreams.tls ?? { allowLoopbackHttp: true, requirePins: false };
    const cpPins = m.config.upstreams.controlPlane?.pins ?? [];
    controlPlaneTransport = checkUpstream(controlPlaneBase, { allowLoopbackHttp: tls.allowLoopbackHttp, pins: cpPins, requirePins: tls.requirePins });
    controlPlaneFetch = upstreamFetch({ pins: cpPins });
    if (process.platform !== "win32") rmSync(socketPath, { force: true });
    server = new EgressGateServer({
      authority: ipcAuthority(m.config.authorizeTimeoutMs ?? 5_000),
      upstreams: m.config.upstreams,
      ...(m.config.approvalKeys ? { approvalKeys: m.config.approvalKeys } : {}),
    });
    server.listen(socketPath).then(
      () => send({ t: "ready" }),
      (e: Error) => {
        send({ t: "fatal", message: `闸门监听失败：${e.message}` });
        void shutdown(1);
      },
    );
    return;
  }
  if (m?.t === "result") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (p.method === "approval") {
      // 批准凭据：只取结构，签名与绑定字段由闸门自行核验（server.ts approved()）
      const a = m.result as SignedApproval | null | undefined;
      p.resolve(m.ok && a && typeof a === "object" && a.credential && typeof a.signature === "string" ? a : null);
      return;
    }
    // 内核的回答只按结构接受；任何异常形态都按拒绝处理
    const r = m.result as AuthorizeResult | undefined;
    if (m.ok && r && typeof r === "object" && (r.ok === true || r.ok === false)) p.resolve(r);
    else p.resolve({ ok: false, status: 403, reason: m.error?.message ? "kernel_denied" : "kernel_bad_reply" });
    return;
  }
  if (m?.t === "revoke") {
    server?.abortRun(String(m.runId));
    return;
  }
  if (m?.t === "seat") {
    if (typeof m.token === "string") server?.updateSeat(m.token);
    return;
  }
  if (m?.t === "cp") {
    const id = m.id;
    void relayControlPlane(m.req, {
      baseUrl: controlPlaneBase,
      ...(controlPlaneTransport ? { transport: controlPlaneTransport } : {}),
      ...(controlPlaneFetch ? { fetchImpl: controlPlaneFetch } : {}),
    }).then((result) => send({ t: "cp_result", id, result }));
    return;
  }
  if (m?.t === "shutdown") void shutdown(0);
});

process.on("disconnect", () => void shutdown(0));
