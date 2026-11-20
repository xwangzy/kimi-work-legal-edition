/**
 * 子进程（Agent 宿主、出站闸门、解析进程）的最小环境与启动选项（Windows 交付，2026-10-14）。
 *
 * - Windows 上 Node 的套接字、DNS 解析与系统随机数依赖 SystemRoot/windir：环境里只给 PATH 时，闸门的上游连接会失败；
 *   这里只补这两项系统目录，不带任何用户配置、令牌或代理设置（各调用方的“不继承内核环境”纪律不变）；
 * - windowsHide：从无控制台的桌面进程拉起控制台程序（随包 node.exe）时，不加这一项 Windows 会为每个子进程弹出黑色控制台窗口。
 *   @types/node 的 ForkOptions 未声明该字段，但 fork 原样交给 spawn，运行时生效。
 */
import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";

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

/**
 * 以 IPC 通道拉起 Node 子进程——等价于 child_process.fork(entry, args, o)（偏离 D-215）。
 *
 * 安装包关闭了 Electron 的 runAsNode 熔断（复核 B3-A02），Electron 44 因此在应用内一律拒绝 child_process.fork()
 * （“not supported when the runAsNode fuse is disabled”）：安装包里出站闸门、Agent 宿主、W 执行域、隔离解析进程全部拉不起来，
 * 模型调用一律失败（第 50 批 DMG 走查发现；开发形态的 Electron 熔断未关，所以一直没暴露）。
 * Node 的 fork 本身就是“以 execPath 运行 execArgv + 入口 + 参数，再在 stdio 里开 'ipc'”；直接 spawn 不受该熔断限制（已在同版本 Electron、
 * 同样熔断的安装包里实测：fork 抛错，spawn + ipc 正常往返消息）。
 * 用 Electron 自身当 Node（开发形态未指定随包 Node）时，fork 会自动带 ELECTRON_RUN_AS_NODE=1，这里照做。
 */
export function spawnNodeChild(entry: string, args: readonly string[], o: SpawnOptions & { execPath?: string; execArgv?: readonly string[] }): ChildProcess {
  const { execPath = process.execPath, execArgv = [], ...rest } = o;
  const stdio = (rest.stdio ?? ["pipe", "pipe", "pipe", "ipc"]) as StdioOptions;
  if (!Array.isArray(stdio) || !stdio.includes("ipc")) throw new Error("spawnNodeChild 须带 IPC 通道（stdio 里的 'ipc'）");
  const env: NodeJS.ProcessEnv = { ...(rest.env ?? process.env) };
  if (execPath === process.execPath && (process.versions as { electron?: string }).electron) env.ELECTRON_RUN_AS_NODE = "1";
  // windowsHide：从无控制台的桌面进程拉起随包 node.exe 不弹黑色控制台窗口（WR-2）
  return spawn(execPath, [...execArgv, entry, ...args], { ...rest, env, stdio, windowsHide: true });
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
