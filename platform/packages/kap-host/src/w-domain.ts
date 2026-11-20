/**
 * W-core 执行域工厂（v9 第 04 篇 §4.1：W 执行域默认、所有设备）：每个事项一个 W 监督进程，挂载本事项工作区（读写，快照提交）
 * 与材料快照、可信区（只读）。拉起或自检失败即抛错，事项引擎保持“执行域不可用”（Bash 不可见、宿主策略拒绝）。
 *
 * W 用随包 Node 26 运行（`nodePath`）；Electron 内置 Node 不用于此——在 Electron 中未配置 nodePath 即不可用。
 */
import { mkdirSync, rmSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { W_CORE_LABEL, WCoreDomain, WSupervisor, WUnavailableError, type WSupervisorOptions } from "@zr-legal/exec-wasm";
import type { ExecDomainFactory } from "./exec-router.ts";

export interface WCoreFactoryOptions {
  /** 随包 Node 26 的路径；缺省：非 Electron 环境用当前 Node。 */
  nodePath?: string | null;
  /** 同一事项的并发 worker 数（默认 2，可设 3；总内存 ≤ 8 GB 的设备默认 1——看门狗上限 1 GB，两条 python3 并发即超：复核 S3-20）。 */
  maxConcurrent?: number;
  rssLimitMb?: number;
  /** 每次调用的硬上限（默认 60 分钟 = 后台命令上限）。 */
  maxExecutionTimeMs?: number;
  /** 执行域运行中不可用后的恢复探测首次退避（缺省 30 秒；第二轮复核 S3-28）。 */
  recoveryRetryMs?: number;
  /** 随包 W 运行时目录（安装包形态；缺省开发形态）。 */
  runtimeDir?: string;
  /** 随包 Node 的 sha256 与锁定版本（安装包形态由构建清单给出）。 */
  nodeSha256?: string;
  nodeVersion?: string;
}

export function wCoreFactory(o: WCoreFactoryOptions = {}): ExecDomainFactory {
  return {
    id: "W-core",
    label: W_CORE_LABEL,
    async create(ctx) {
      const base = wSupervisorBase(o);
      const maxConcurrent = o.maxConcurrent ?? defaultWConcurrency();
      const d = await WCoreDomain.start({
        broker: ctx.broker,
        work: { zone: ctx.workZone, root: ctx.workDir },
        readOnlyRoots: ctx.readOnlyRoots,
        ...(ctx.sealed ? { sealed: ctx.sealed } : {}),
        pathClass: ctx.pathClass,
        tmpDir: join(ctx.homeDir, "w-tmp"),
        supervisor: { ...base, maxConcurrent },
        ...(o.maxExecutionTimeMs ? { limits: { maxExecutionTimeMs: o.maxExecutionTimeMs } } : {}),
        ...(o.recoveryRetryMs ? { recoveryRetryMs: o.recoveryRetryMs } : {}),
        ...(ctx.onEvent ? { onEvent: (e) => ctx.onEvent!({ ...e }) } : {}),
      });
      return Object.assign(d, { concurrency: maxConcurrent });
    },
  };
}

/** 同一事项的默认并发命令数：总内存 ≤ 8 GB 的设备 1，其余 2（复核 S3-20）。 */
export function defaultWConcurrency(): number {
  return totalmem() <= 8 * 1024 ** 3 ? 1 : 2;
}

/** W 监督进程的运行时选项（执行域工厂与安装冒烟自检同一口径）：随包 Node、W 运行时目录、摘要与锁定版本。 */
function wSupervisorBase(o: WCoreFactoryOptions): Pick<WSupervisorOptions, "nodePath" | "rssLimitMb" | "runtimeDir" | "nodeSha256" | "expectedNodeVersion"> {
  const nodePath = o.nodePath ?? (process.versions.electron ? null : process.execPath);
  if (!nodePath) throw new WUnavailableError("未配置随包 Node 26（Electron 内置 Node 不用于执行域）");
  return {
    nodePath,
    ...(o.rssLimitMb ? { rssLimitMb: o.rssLimitMb } : {}),
    ...(o.runtimeDir ? { runtimeDir: o.runtimeDir } : {}),
    ...(o.nodeSha256 ? { nodeSha256: o.nodeSha256 } : {}),
    ...(o.nodeVersion ? { expectedNodeVersion: o.nodeVersion } : {}),
  };
}

/** 执行域自检的结果码（封闭枚举；只进冒烟结果与日志，不带路径与报错原文）。 */
export type WSelftestCode = "ok" | "node_unavailable" | "node_digest" | "runtime_incomplete" | "start_failed" | "start_timeout" | "selftest_failed" | "roundtrip_failed" | "other";

/** 执行域拉不起来的原因码（按 WSupervisor 的固定报错归类）。 */
export function wSelftestFailure(e: unknown): Exclude<WSelftestCode, "ok"> {
  const msg = String((e as Error)?.message ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  if (msg.includes("未配置随包 Node") || msg.includes("随包 Node 不可用")) return "node_unavailable";
  if (msg.includes("摘要不符")) return "node_digest";
  if (msg.includes("运行时不完整") || code === "ENOENT") return "runtime_incomplete";
  if (msg.includes("启动超时")) return "start_timeout";
  if (msg.includes("启动失败")) return "start_failed";
  if (msg.includes("worker 往返失败")) return "roundtrip_failed";
  if (msg.includes("自检未通过")) return "selftest_failed";
  return "other";
}

/**
 * 安装冒烟的执行域自检（第 52 批；偏离 D-215 的验证缺口）：按执行域工厂同一口径拉起一个 W 监督进程，跑完它自带的启动自检——
 * 权限模型生效、DNS 不可用、一次真实 worker 往返（装载 just-bash、跑 echo 与 python3）——随即关闭并删除临时目录。
 * 不读写任何事项数据；只返回结果码。
 */
export async function wSelftest(o: WCoreFactoryOptions, dir: string, startTimeoutMs = 30_000): Promise<WSelftestCode> {
  let sup: WSupervisor | null = null;
  try {
    rmSync(dir, { recursive: true, force: true });
    // 往返时以只读加密挂载一个空目录（核对解密读层的安装；见 WSupervisor.roundTrip）
    mkdirSync(join(dir, "data"), { recursive: true });
    sup = new WSupervisor({ ...wSupervisorBase(o), dataDirs: [join(dir, "data")], tmpDir: join(dir, "w-tmp"), maxConcurrent: 1, startTimeoutMs });
    await sup.ensure();
    return "ok";
  } catch (e) {
    return wSelftestFailure(e);
  } finally {
    await sup?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
