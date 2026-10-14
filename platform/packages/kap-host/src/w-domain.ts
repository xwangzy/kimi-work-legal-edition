/**
 * W-core 执行域工厂（v9 第 04 篇 §4.1：W 执行域默认、所有设备）：每个事项一个 W 监督进程，挂载本事项工作区（读写，快照提交）
 * 与材料快照、可信区（只读）。拉起或自检失败即抛错，事项引擎保持“执行域不可用”（Bash 不可见、宿主策略拒绝）。
 *
 * W 用随包 Node 26 运行（`nodePath`）；Electron 内置 Node 不用于此——在 Electron 中未配置 nodePath 即不可用。
 */
import { totalmem } from "node:os";
import { join } from "node:path";
import { W_CORE_LABEL, WCoreDomain, WUnavailableError } from "@zr-legal/exec-wasm";
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
      const nodePath = o.nodePath ?? (process.versions.electron ? null : process.execPath);
      if (!nodePath) throw new WUnavailableError("未配置随包 Node 26（Electron 内置 Node 不用于执行域）");
      const maxConcurrent = o.maxConcurrent ?? defaultWConcurrency();
      const d = await WCoreDomain.start({
        broker: ctx.broker,
        work: { zone: ctx.workZone, root: ctx.workDir },
        readOnlyRoots: ctx.readOnlyRoots,
        ...(ctx.sealed ? { sealed: ctx.sealed } : {}),
        pathClass: ctx.pathClass,
        tmpDir: join(ctx.homeDir, "w-tmp"),
        supervisor: {
          nodePath,
          maxConcurrent,
          ...(o.rssLimitMb ? { rssLimitMb: o.rssLimitMb } : {}),
          ...(o.runtimeDir ? { runtimeDir: o.runtimeDir } : {}),
          ...(o.nodeSha256 ? { nodeSha256: o.nodeSha256 } : {}),
          ...(o.nodeVersion ? { expectedNodeVersion: o.nodeVersion } : {}),
        },
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
