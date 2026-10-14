/**
 * 沙箱种子（ZP-5/ZP-6 的宿主侧；v9 第 04 篇 §4.4 文件 broker、§9 F2 修复）：
 *
 * - ZP-5 拒绝式进程服务：任何进程启动请求都失败。引擎为系统提示调用 git 取上下文，
 *   拒绝后按上游设计降级为「不可用」。注意：锁版中仍有直接调用 node:child_process 的路径
 *   （环境探测等，seeds 拦不到）——在 v9 由 ZP-17 补丁封闭（kap-host 形态），本 SDK 宿主不开放任何执行类工具。
 * - ZP-6 文件系统经文件 broker（F2）：旧实现用字符串前缀 + 固定 `/` 判断根归属，符号链接可逃逸、Windows 合法
 *   子路径被误拒。现在按区域登记：
 *     home（每任务 homeDir：会话状态、计划文件）读写，其中 config.toml / mcp.json 为只读文件；
 *     snapshot（派生文本快照）只读；skills（签发方法包）只读；trusted（签名 profile）只读；
 *   区域之外读为 ENOENT（引擎 pathExists 探测特判该形）、写为 ENOENT；只读区域写为 EPERM；
 *   路径上任何符号链接 / junction / 硬链接投毒一律拒绝（ELOOP / EMLINK）。
 *   持久化层与技能发现直连 node:fs（不经本服务）——签发目录只读最终由 OS 权限保证（如实残余）。
 */
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { FileBroker, type ZoneSpec } from "@zr-legal/file-broker";
import { IHostFileSystem, IHostProcessService } from "../vendor/kimi-code-sdk/index.mjs";
import type { ScopeSeed } from "../vendor/kimi-code-sdk/index.mjs";

export interface SandboxSpec {
  homeDir: string; // 每任务 homeDir（可读写：会话状态、计划文件、mcp.json）
  workDir: string; // 快照目录（只读：本次任务允许读取的派生文本）
  skillDirs: string[]; // 签发方法包目录（只读）
  trustedDir?: string | undefined; // F7：只读可信目录（签名 profile），与可写 homeDir 分区
  outDir?: string | undefined; // F5：成果目录（只由宿主写入，不对引擎开放）
  /** F7：homeDir 内对引擎只读的文件（config.toml、mcp.json——上游只从 homeDir 读取，无法移出）。 */
  readOnlyFiles?: readonly string[] | undefined;
}

/** 由任务规格生成 broker 区域表（区域不得重叠，由 FileBroker 构造时检查）。 */
export function sandboxZones(spec: SandboxSpec): ZoneSpec[] {
  const zones: ZoneSpec[] = [
    { name: "home", root: spec.homeDir, access: "rw" },
    { name: "snapshot", root: spec.workDir, access: "ro" },
    ...spec.skillDirs.map((d, i) => ({ name: `skills${i}`, root: d, access: "ro" as const })),
  ];
  if (spec.trustedDir) zones.push({ name: "trusted", root: spec.trustedDir, access: "ro" });
  return zones;
}

/** ZP-6：受限 IHostFileSystem（文件 broker 实现）。 */
export function createRestrictedFileSystem(spec: SandboxSpec): Record<string, unknown> {
  return new FileBroker(sandboxZones(spec), { readOnlyFiles: spec.readOnlyFiles ?? [] }).asHostFileSystem();
}

/** ZP-5：拒绝式 IHostProcessService——任何进程启动请求都失败（引擎 git 上下文等降级为「不可用」）。 */
export function createDenyAllProcessService(): object {
  return {
    _serviceBrand: undefined,
    async spawn(command: string): Promise<never> {
      const e = new Error(`spawn denied (ZP-5): ${command}`) as Error & { code?: string };
      e.code = "spawnDenied";
      throw e;
    },
  };
}

/** 组装 bootstrap 追加种子（ZP-5/6）。 */
export function legalSandboxSeeds(spec: SandboxSpec): ScopeSeed {
  return [
    [IHostProcessService, createDenyAllProcessService()],
    [IHostFileSystem, createRestrictedFileSystem(spec)],
  ];
}

/** 断言沙箱目录就绪（供宿主启动前调用）：可写目录按需创建，只读目录必须已存在且可读。 */
export async function ensureSandboxDirs(spec: SandboxSpec): Promise<void> {
  await mkdir(spec.homeDir, { recursive: true });
  if (spec.outDir) await mkdir(spec.outDir, { recursive: true });
  await access(spec.workDir, constants.R_OK);
  for (const d of spec.skillDirs) await access(d, constants.R_OK);
  if (spec.trustedDir) await access(spec.trustedDir, constants.R_OK);
}
