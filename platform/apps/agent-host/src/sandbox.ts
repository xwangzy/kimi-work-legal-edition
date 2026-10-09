/**
 * 沙箱种子（方案 v5.0 第 4 篇 §4.2 第四、五道约束；补丁 ZP-5/ZP-6 的宿主侧）：
 *
 * - ZP-5 拒绝式进程服务：任何进程启动请求都失败。引擎为系统提示调用 git 取上下文，
 *   拒绝后按上游设计降级为「不可用」（gitContext/profiles 双层 try/catch，探针 1 验证）。
 *   注意：环境探测等只读路径直连 node:child_process（不经本服务）——真正的进程封锁
 *   边界是 OS 降权（受限令牌 + 作业对象，Windows 部署形态），本服务是纵深一层。
 * - ZP-6 受限文件系统：homeDir（每任务，含会话状态与计划文件）与每任务临时目录可读写；
 *   快照目录与签发技能目录只读；其余路径拒绝——读类抛 ENOENT 形错误（引擎大量 pathExists
 *   探测特判该形），写类抛 EPERM 形错误。持久化层与技能发现直连 node:fs（不经本服务），
 *   签发目录只读最终由 OS 权限保证。
 */
import { constants } from "node:fs";
import { access, appendFile, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { IHostFileSystem, IHostProcessService } from "../vendor/kimi-code-sdk/index.mjs";
import type { ScopeSeed } from "../vendor/kimi-code-sdk/index.mjs";

export interface SandboxSpec {
  homeDir: string; // 每任务 homeDir（可读写：会话状态、计划文件、config.toml）
  workDir: string; // 快照目录（只读：本次任务允许读取的派生文本）
  skillDirs: string[]; // 签发方法包目录（只读）
  tmpDir?: string; // 每任务临时目录（可读写；默认 homeDir/tmp）
}

function enoent(path: string): Error & { code?: string } {
  const e = new Error(`ENOENT: no such file or directory: ${path}`) as Error & { code?: string };
  e.code = "ENOENT";
  return e;
}

function eperm(path: string): Error & { code?: string } {
  const e = new Error(`EPERM: operation not permitted (ZP-6 restricted): ${path}`) as Error & { code?: string };
  e.code = "EPERM";
  return e;
}

function normalize(p: string): string {
  return resolve(isAbsolute(p) ? p : join(process.cwd(), p));
}

class PathPolicy {
  private readonly rwRoots: string[];
  private readonly roRoots: string[];

  constructor(spec: SandboxSpec) {
    this.rwRoots = [normalize(spec.homeDir), normalize(spec.tmpDir ?? join(spec.homeDir, "tmp"))];
    this.roRoots = [normalize(spec.workDir), ...spec.skillDirs.map(normalize)];
  }

  private under(root: string, p: string): boolean {
    return p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
  }

  assertRead(p: string): string {
    const n = normalize(p);
    if (this.rwRoots.some((r) => this.under(r, n)) || this.roRoots.some((r) => this.under(r, n))) return n;
    throw enoent(p);
  }

  assertWrite(p: string): string {
    const n = normalize(p);
    if (this.rwRoots.some((r) => this.under(r, n))) return n;
    if (this.roRoots.some((r) => this.under(r, n))) throw eperm(p);
    throw enoent(p);
  }
}

/** ZP-6：受限 IHostFileSystem。 */
export function createRestrictedFileSystem(spec: SandboxSpec): object {
  const policy = new PathPolicy(spec);

  async function statLike(p: string, follow: boolean) {
    const n = policy.assertRead(p);
    const s = follow ? await stat(n) : await lstat(n);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink(), size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
  }

  return {
    _serviceBrand: undefined,
    async readText(path: string, _options?: { encoding?: BufferEncoding; errors?: unknown }): Promise<string> {
      return readFile(policy.assertRead(path), "utf8");
    },
    async writeText(path: string, data: string): Promise<void> {
      await writeFile(policy.assertWrite(path), data, "utf8");
    },
    async appendText(path: string, data: string): Promise<void> {
      await appendFile(policy.assertWrite(path), data, "utf8");
    },
    async readBytes(path: string, n?: number, offset?: number): Promise<Uint8Array> {
      const buf = await readFile(policy.assertRead(path));
      const start = offset ?? 0;
      const end = n === undefined ? buf.length : start + n;
      return new Uint8Array(buf.subarray(start, Math.min(end, buf.length)));
    },
    async writeBytes(path: string, data: Uint8Array): Promise<void> {
      await writeFile(policy.assertWrite(path), data);
    },
    async *readLines(path: string, _options?: { encoding?: BufferEncoding; errors?: unknown }): AsyncGenerator<string> {
      const text = await readFile(policy.assertRead(path), "utf8");
      for (const line of text.split(/\r?\n/)) yield line;
    },
    async createExclusive(path: string, data: Uint8Array): Promise<boolean> {
      const n = policy.assertWrite(path);
      try {
        await writeFile(n, data, { flag: "wx" });
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
      }
    },
    stat: (path: string) => statLike(path, true),
    lstat: (path: string) => statLike(path, false),
    async readdir(path: string) {
      const n = policy.assertRead(path);
      const entries = await readdir(n, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink() }));
    },
    async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
      await mkdir(policy.assertWrite(path), { recursive: options?.recursive ?? false });
    },
    async remove(path: string): Promise<void> {
      await rm(policy.assertWrite(path), { recursive: true, force: true });
    },
    async realpath(path: string): Promise<string> {
      const n = policy.assertRead(path);
      return realpath(n);
    },
  };
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

/** 断言沙箱目录就绪（供宿主启动前调用）。 */
export async function ensureSandboxDirs(spec: SandboxSpec): Promise<void> {
  await mkdir(spec.homeDir, { recursive: true });
  await mkdir(spec.tmpDir ?? join(spec.homeDir, "tmp"), { recursive: true });
  await access(spec.workDir, constants.R_OK);
  for (const d of spec.skillDirs) await access(d, constants.R_OK);
}
