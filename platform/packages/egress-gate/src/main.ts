/**
 * 出站闸门进程入口（第 04 篇 §1.1：独立签名进程，唯一出口；开发与测试由内核以 child_process.fork 拉起，产品形态为独立签名二进制）。
 *
 * - 只经 IPC 与内核通信，内核断开即退出；只监听内核指定的本机套接字/命名管道（无 TCP 端口）；
 * - 令牌活性、事项策略与令牌化上下文全部来自内核（authorize 调用，超时或断开即拒绝——失败关闭）；
 * - 去向记录与新令牌条目回送内核写入事项账本；闸门不落盘、不写正文日志；
 * - 环境变量不继承内核（席位凭据与上游地址经 init 下发，不进环境）。
 *
 * 协议（JSON 消息）：
 *   内核 → 闸门：{t:"init", config} | {t:"result", id, ok, result | error} | {t:"revoke", runId} | {t:"seat", token} | {t:"cp", id, req}
 *               | {t:"dist", id, path} | {t:"support", id, req} | {t:"notify", id, req} | {t:"shutdown"}
 *   闸门 → 内核：{t:"ready"} | {t:"call", id, method:"authorize"|"approval", params} | {t:"record", rec} | {t:"tokens", matterId, entries}
 *               | {t:"cp_result", id, result} | {t:"dist_result", id, result} | {t:"support_result", id, result} | {t:"notify_result", id, result} | {t:"fatal", message}
 * 控制面通道（阶段 6，cp-relay.ts）：只有内核持有 IPC，故 Agent 宿主与执行域都不能借闸门访问控制面；目的地为 init 下发的固定地址。
 * 内容分发通道（第 8 批，dist-relay.ts）：同上，只许 GET 白名单路径，席位令牌由闸门附上。
 * 支持通道（第 9 批，support-relay.ts）：同上，只有“申请工单”与“上传诊断包”两种固定请求，摘要由闸门重算。
 * 通知通道（第 10 批，notify-relay.ts）：同上，只有登记、撤销、取到时提醒、确认收到四种固定请求；云端只收触发时刻、设备编号与密文。
 */
import { rmSync } from "node:fs";
import { slog } from "@zr-legal/safe-log";
import { EgressGateServer, seatUsable } from "./server.ts";
import { relayControlPlane, type CpRelayRequest } from "./cp-relay.ts";
import { relayDist } from "./dist-relay.ts";
import { relaySupport, type SupportRelayRequest } from "./support-relay.ts";
import { relayNotify, type NotifyRelayRequest } from "./notify-relay.ts";
import { checkUpstream, upstreamFetch, type TransportCheck } from "./tls-policy.ts";
import type { AuthorizeResult, GateAuthority, GateEgressRecord, GatePurpose, GateUpstreams } from "./types.ts";
import type { SignedApproval } from "./approval.ts";
import type { TokenEntry } from "@zr-legal/tokenizer";

// 统一脱敏日志（v9.2 §3.6）：本进程的事件经 stderr 交内核
slog.useStderr("gate");

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
  | { t: "dist"; id: number; path: string }
  | { t: "support"; id: number; req: SupportRelayRequest }
  | { t: "notify"; id: number; req: NotifyRelayRequest }
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
let distBase: string | null = null;
let distTransport: TransportCheck | undefined;
let distFetch: typeof fetch | undefined;
let supportBase: string | null = null;
let supportTransport: TransportCheck | undefined;
let supportFetch: typeof fetch | undefined;
let notifyBase: string | null = null;
let notifyTransport: TransportCheck | undefined;
let notifyFetch: typeof fetch | undefined;
/** 当前席位令牌（与模型、检索同一张；内核续期后经 {t:"seat"} 更新）。 */
let seatToken: string | null = null;

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
    distBase = m.config.upstreams.dist?.baseUrl ?? null;
    const distPins = m.config.upstreams.dist?.pins ?? [];
    distTransport = checkUpstream(distBase, { allowLoopbackHttp: tls.allowLoopbackHttp, pins: distPins, requirePins: tls.requirePins });
    distFetch = upstreamFetch({ pins: distPins });
    supportBase = m.config.upstreams.support?.baseUrl ?? null;
    const supportPins = m.config.upstreams.support?.pins ?? [];
    supportTransport = checkUpstream(supportBase, { allowLoopbackHttp: tls.allowLoopbackHttp, pins: supportPins, requirePins: tls.requirePins });
    supportFetch = upstreamFetch({ pins: supportPins });
    notifyBase = m.config.upstreams.notify?.baseUrl ?? null;
    const notifyPins = m.config.upstreams.notify?.pins ?? [];
    notifyTransport = checkUpstream(notifyBase, { allowLoopbackHttp: tls.allowLoopbackHttp, pins: notifyPins, requirePins: tls.requirePins });
    notifyFetch = upstreamFetch({ pins: notifyPins });
    seatToken = m.config.upstreams.dist?.seatToken || m.config.upstreams.model?.seatToken || m.config.upstreams.search?.seatToken || null;
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
    if (typeof m.token === "string") {
      server?.updateSeat(m.token);
      seatToken = m.token || null;
    }
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
  if (m?.t === "dist") {
    const id = m.id;
    void relayDist(String(m.path), {
      baseUrl: distBase,
      seatToken: seatUsable(seatToken) ? seatToken : null,
      ...(distTransport ? { transport: distTransport } : {}),
      ...(distFetch ? { fetchImpl: distFetch } : {}),
    }).then((result) => send({ t: "dist_result", id, result }));
    return;
  }
  if (m?.t === "support") {
    const id = m.id;
    void relaySupport(m.req, {
      baseUrl: supportBase,
      ...(supportTransport ? { transport: supportTransport } : {}),
      ...(supportFetch ? { fetchImpl: supportFetch } : {}),
    }).then((result) => send({ t: "support_result", id, result }));
    return;
  }
  if (m?.t === "notify") {
    const id = m.id;
    void relayNotify(m.req, {
      baseUrl: notifyBase,
      ...(notifyTransport ? { transport: notifyTransport } : {}),
      ...(notifyFetch ? { fetchImpl: notifyFetch } : {}),
    }).then((result) => send({ t: "notify_result", id, result }));
    return;
  }
  if (m?.t === "shutdown") void shutdown(0);
});

process.on("disconnect", () => void shutdown(0));
// 父进程看门狗（Kimi Code 增量核查 WR-3；第 4 批复核 B4-A13）：IPC 断开事件是主信号；看门狗只补“断开事件永远不来”的情形
// （例如管道句柄被子孙进程继承而保持打开）。父进程按 KWL_PARENT_HEARTBEAT_MS 每隔一段发 {t:"hb"}：
// - Windows：ppid 不随父进程退出而变、PID 复用很快，kill(pid,0) 判不了存活——改看心跳，30 秒（至少 5 个周期）没收到即退出；
// - 其他平台：父进程退出后 ppid 变为 1，沿用 ppid 判断（有心跳时同样检查心跳）；
// - 本进程事件循环自身卡顿（本次检查比预期晚 4 秒以上）时跳过一次：先让排队的心跳消息被处理，避免主线程忙时误判父进程已退出。
{
  const parentPid = process.ppid;
  const hbEvery = Number(process.env.KWL_PARENT_HEARTBEAT_MS ?? 0);
  const hbLimit = hbEvery > 0 ? Math.max(30_000, hbEvery * 5) : 0;
  let lastHb = Date.now();
  let lastTick = Date.now();
  process.on("message", (m: unknown) => {
    if ((m as { t?: unknown } | null)?.t === "hb") lastHb = Date.now();
  });
  const parentWatch = setInterval(() => {
    const now = Date.now();
    const lagged = now - lastTick > 6_000;
    lastTick = now;
    if (lagged) return;
    let alive = hbLimit > 0 ? now - lastHb <= hbLimit : true;
    if (alive && process.platform !== "win32" && process.ppid !== parentPid) alive = false;
    if (alive && hbLimit === 0) {
      try {
        process.kill(parentPid, 0);
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (!alive) {
      clearInterval(parentWatch);
      void shutdown(0);
    }
  }, 2_000);
  parentWatch.unref();
}

