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
 * 启动时先等一条 {type:'kernel.init', dbKey?} 消息（§5.1：数据库主密钥由主进程经 safeStorage
 * 解封后一次性交付内核，主进程随即清除）；超时无消息则不带 key 启动并广播提示（明文开发库形态）。
 */
function waitForInit(timeoutMs: number): Promise<{ dbKey: string | undefined } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    port.on("message", (raw) => {
      const msg = raw as InitMessage;
      if (msg && msg.type === "kernel.init" && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ dbKey: typeof msg.dbKey === "string" && msg.dbKey.length > 0 ? msg.dbKey : undefined });
      }
    });
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

  let closing = false;
  port.on("message", async (raw) => {
    // 主进程退出或安装更新前要求有序关闭（复核 B4-A13）：先关闭闸门、Agent 宿主等子进程与账本，再退出——
    // 强制终止会留下仍占用安装目录文件的子进程，静默更新随之失败
    // 随包运行时全量摘要核验通过（复核 B4-R15）：放行随包子进程的拉起
    // 主进程交来的日志事件（v9.2 §3.6）：按登记表重新核验，进程名由这里标注
    if ((raw as { type?: unknown } | null)?.type === "log.event") {
      const m = raw as { code?: unknown; fields?: unknown };
      slog.ingest("main", m.code, m.fields);
      return;
    }
    if ((raw as { type?: unknown } | null)?.type === "kernel.runtime_verified") {
      markRuntimeVerified();
      return;
    }
    if ((raw as { type?: unknown } | null)?.type === "kernel.shutdown") {
      if (closing) return;
      closing = true;
      await kernel.close().catch(() => {});
      process.exit(0);
    }
    const req = raw as RpcRequest;
    if (!req || typeof req.id !== "number" || typeof req.method !== "string") return;
    try {
      const result = await kernel.invoke(req.method, req.params ?? {});
      port.postMessage({ id: req.id, ok: true, result });
    } catch (e) {
      const err = e as any;
      port.postMessage({
        id: req.id,
        ok: false,
        error: { code: err?.code ?? "internal", message: err?.message ?? String(e), httpStatus: err?.httpStatus ?? 500, detail: err?.detail },
      });
    }
  });

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
