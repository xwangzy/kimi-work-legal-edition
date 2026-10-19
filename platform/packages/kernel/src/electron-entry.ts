/**
 * 内核进程入口（方案 v5.0 第 4 篇 §3：内核以 Electron utilityProcess 运行，共用 Electron
 * 内置 Node，不另外分发运行时；所内节点用同版本独立 Node 运行同一份制品）。
 *
 * 传输：Electron utilityProcess 的 process.parentPort（MessagePort）；普通 Node 子进程
 * （开发/节点形态）退化为 process.send/on('message')。协议：{id, method, params} →
 * {id, ok, result|error:{code,message,httpStatus}}；广播 {type:"kernel.event", ...}。
 *
 * 打包：esbuild 产出单文件 CJS（目标 Node 24）；better-sqlite3-multiple-ciphers
 * 为 N-API 原生模块，保持 external 随包附带。
 */
import { createKernel } from "./index.ts";
import { markRuntimeVerified } from "./executor/child-env.ts";
import { slog } from "@zr-legal/safe-log";

interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface PortLike {
  postMessage(msg: unknown): void;
  on(event: "message", cb: (data: unknown) => void): void;
}

function resolvePort(): PortLike {
  const p = process as any;
  if (p.parentPort) {
    // Electron utilityProcess：事件为 { data }
    return {
      postMessage: (msg) => p.parentPort.postMessage(msg),
      on: (_event, cb) => p.parentPort.on("message", (e: { data: unknown }) => cb(e.data)),
    };
  }
  if (typeof p.send === "function") {
    return {
      postMessage: (msg) => p.send(msg),
      on: (_event, cb) => p.on("message", cb),
    };
  }
  throw new Error("kernel entry 需要作为子进程运行（utilityProcess 或 child_process.fork）");
}

const port = resolvePort();

interface InitMessage {
  type: "kernel.init";
  dbKey?: unknown;
}

/**
 * 统一的消息处理（复核 B13-K01）：一启动就挂上，内核就绪之前到达的调用排队（至多 200 条），就绪后依次处理——
 * 首次启动要做全部迁移、生成密钥、拉起闸门，以前这段时间里到达的调用被 init 监听忽略、永远不回，界面停在空白。
 */
let kernelRef: Awaited<ReturnType<typeof createKernel>> | null = null;
const queued: RpcRequest[] = [];
let closing = false;
let initResolve: ((v: { dbKey: string | undefined }) => void) | null = null;

async function handleRpc(req: RpcRequest): Promise<void> {
  try {
    const result = await kernelRef!.invoke(req.method, req.params ?? {});
    port.postMessage({ id: req.id, ok: true, result });
  } catch (e) {
    const err = e as any;
    port.postMessage({
      id: req.id,
      ok: false,
      error: { code: err?.code ?? "internal", message: err?.message ?? String(e), httpStatus: err?.httpStatus ?? 500, detail: err?.detail },
    });
  }
}

port.on("message", async (raw) => {
  const type = (raw as { type?: unknown } | null)?.type;
  // 数据库主密钥由主进程经 safeStorage 解封后一次性交付（§5.1），只认第一条
  if (type === "kernel.init") {
    const msg = raw as InitMessage;
    const r = initResolve;
    initResolve = null;
    r?.({ dbKey: typeof msg.dbKey === "string" && msg.dbKey.length > 0 ? msg.dbKey : undefined });
    return;
  }
  // 主进程交来的日志事件（v9.2 §3.6）：按登记表重新核验，进程名由这里标注
  if (type === "log.event") {
    const m = raw as { code?: unknown; fields?: unknown };
    slog.ingest("main", m.code, m.fields);
    return;
  }
  // 随包运行时全量摘要核验通过（复核 B4-R15）：放行随包子进程的拉起
  if (type === "kernel.runtime_verified") {
    markRuntimeVerified();
    return;
  }
  // 主进程退出或安装更新前要求有序关闭（复核 B4-A13）：先关闭闸门、Agent 宿主等子进程与账本，再退出
  if (type === "kernel.shutdown") {
    if (closing) return;
    closing = true;
    if (kernelRef) await kernelRef.close().catch(() => {});
    process.exit(0);
  }
  const req = raw as RpcRequest;
  if (!req || typeof req.id !== "number" || typeof req.method !== "string") return;
  if (!kernelRef) {
    if (queued.length < 200) queued.push(req);
    else port.postMessage({ id: req.id, ok: false, error: { code: "kernel_starting", message: "后台服务正在启动，请稍候", httpStatus: 503 } });
    return;
  }
  await handleRpc(req);
});

/** 启动时先等 {type:'kernel.init', dbKey?}；超时无消息则不带 key 启动并广播提示（明文开发库形态）。 */
function waitForInit(timeoutMs: number): Promise<{ dbKey: string | undefined } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (initResolve) {
        initResolve = null;
        resolve(null);
      }
    }, timeoutMs);
    initResolve = (v) => {
      clearTimeout(timer);
      resolve(v);
    };
  });
}

async function main(): Promise<void> {
  const init = await waitForInit(10_000);
  if (!init?.dbKey) {
    port.postMessage({
      type: "kernel.event",
      event: "kernel.db_key_missing",
      message: "未收到数据库主密钥：以明文开发库启动（仅 G0 开发形态；生产由主进程 safeStorage 解封交付）",
    });
  }
  let kernel;
  try {
    kernel = await createKernel(init?.dbKey ? { dbKey: init.dbKey } : {});
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (/not a database|encrypted|cipher|file is not/i.test(msg)) {
      throw new Error(`无法用提供的密钥打开账本数据库：现有开发库可能为明文，或密钥不符。G0 开发库可删除重建（或取消 ZR_DB_KEY / 不交付 dbKey）。原始错误：${msg}`);
    }
    throw e;
  }

  kernel.onBroadcast((msg) => port.postMessage({ type: "kernel.event", ...msg }));
  kernelRef = kernel;
  if (closing) {
    await kernel.close().catch(() => {});
    process.exit(0);
  }
  // 就绪前排队的调用依次处理
  for (const req of queued.splice(0)) await handleRpc(req);

  port.postMessage({ type: "kernel.ready", localPort: kernel.localPort, workspace: kernel.config.workspaceDir, onboarding: kernel.config.onboarding });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void kernel.close().then(() => process.exit(0));
    });
  }
}

void main().catch((e) => {
  port.postMessage({ type: "kernel.fatal", message: (e as Error)?.message ?? String(e) });
  process.exit(1);
});
