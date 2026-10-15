/**
 * 子进程（Agent 宿主、出站闸门、解析进程）的最小环境与启动选项（Windows 交付，2026-10-14）。
 *
 * - Windows 上 Node 的套接字、DNS 解析与系统随机数依赖 SystemRoot/windir：环境里只给 PATH 时，闸门的上游连接会失败；
 *   这里只补这两项系统目录，不带任何用户配置、令牌或代理设置（各调用方的“不继承内核环境”纪律不变）；
 * - windowsHide：从无控制台的桌面进程拉起控制台程序（随包 node.exe）时，不加这一项 Windows 会为每个子进程弹出黑色控制台窗口。
 *   @types/node 的 ForkOptions 未声明该字段，但 fork 原样交给 spawn，运行时生效。
 */
import type { ChildProcess } from "node:child_process";

export function windowsSystemEnv(): Record<string, string> {
  if (process.platform !== "win32") return {};
  const out: Record<string, string> = {};
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir ?? process.env.WINDIR;
  if (root) {
    out.SystemRoot = root;
    out.windir = root;
  }
  return out;
}

/** 合入 fork/spawn 选项：Windows 不弹控制台窗口。 */
export const HIDE_WINDOW = { windowsHide: true } as {};

/**
 * 父进程心跳（第 4 批复核 B4-A13）：Windows 上父进程退出后子进程的 ppid 不变、PID 复用很快，子进程无法用 kill(pid,0) 判断父进程存活；
 * 父进程每 2 秒经 IPC 发 {t:"hb"}，子进程（闸门、Agent 宿主、W 监督进程）在环境变量 KWL_PARENT_HEARTBEAT_MS 存在时据此判断。
 */
export const PARENT_HEARTBEAT_MS = 2_000;
export const parentHeartbeatEnv = (): Record<string, string> => ({ KWL_PARENT_HEARTBEAT_MS: String(PARENT_HEARTBEAT_MS) });
export function startParentHeartbeat(child: ChildProcess): void {
  const t = setInterval(() => {
    // 带回调发送：通道已关时错误交给回调，不在子进程对象上抛 error
    if (child.connected) child.send({ t: "hb" }, () => {});
  }, PARENT_HEARTBEAT_MS);
  t.unref();
  child.once("exit", () => clearInterval(t));
}

/**
 * 随包运行时全量摘要核验的闸口（第 4 批复核 B4-R15）：安装包形态主进程先同步核对入口摘要与全部文件的存在和大小即拉起内核，
 * 全部文件的内容摘要在后台核对——同样大小的被改依赖（解析库、原生 DLL、wasm）可能在核对完成前就被子进程装载。
 * 主进程以环境变量 KWL_RUNTIME_VERIFY_PENDING=1 告知内核“核对未完成”：内核拉起任何随包子进程（闸门、Agent 宿主、解析进程）之前
 * 先等主进程发来 kernel.runtime_verified；核对不通过时主进程直接有序关闭内核。开发形态与测试不设该变量，不等待。
 */
let verifiedResolve: (() => void) | null = null;
const verified: Promise<void> =
  process.env.KWL_RUNTIME_VERIFY_PENDING === "1" ? new Promise<void>((resolve) => (verifiedResolve = resolve)) : Promise.resolve();
export function runtimeReady(): Promise<void> {
  return verified;
}
export function markRuntimeVerified(): void {
  verifiedResolve?.();
  verifiedResolve = null;
}
