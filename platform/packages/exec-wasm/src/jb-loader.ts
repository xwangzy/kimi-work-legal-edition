/**
 * just-bash 3.6.0 装载器（在 W worker 内运行）：按锁定摘要校验随包代码，并应用自维护补丁 KJ-1..3（流式输出）。
 *
 * v9 第 04 篇 §4.1：just-bash `exec()` 只给聚合结果——须实现流式回调（对上游提需求，或自维护补丁）。
 * 补丁只增加一个回调，不改变解释器语义：
 * - KJ-1：解释器上下文携带 `onOutput`（构造函数显式拷贝字段，需补一项）；
 * - KJ-2：只有顶层 exec（深度 0）拿到 `onOutput`——`bash -c`、xargs 等嵌套执行拿不到；
 * - KJ-3：最外层 `executeScript` 把自己的输出累加器标记为根并挂上回调；同一解释器内的嵌套脚本（命令替换、子 shell、
 *   source、eval）用各自的累加器，不被标记——命令替换捕获的输出因此不会被流出；
 * - 累加器类（chunk-J2OBOJ64 导出）的 `append` 在成功入账后对根累加器回调（输出超限抛错时不回调）。
 * 粒度：顶层语句（及其错误输出）结束即流出；单个命令（例如一次 python3）内部的输出在该命令结束时一次给出。
 *
 * - KJ-4（审查 S3-14）：just-bash 的 python3 经一块固定 8 MiB 的共享缓冲与宿主虚拟文件系统交换数据（打开时整读、关闭时整写），
 *   超过 8 MiB 的文件读入报“文件不存在”、写出报 I/O 错误或挂起。把 python3 块与其 worker 两侧的缓冲常量同时放大到 64 MiB
 *   （与 maxStringLength 对齐：单个文件经 python3 或 awk 读入的上限都是 64 MiB）。python3 块与 worker 都按锁定摘要校验，
 *   以 data: URL 装载（worker 内的相对路径解析仍指向原文件位置）。同一补丁修正 worker 的错误码表：just-bash 把 EFBIG 写成 27，
 *   而 Emscripten 的 27 是 EINTR（EFBIG 是 22）——CPython 把“文件过大”当作被中断的写入无限重试，表现为挂起（复核 S3-20）；
 *   超过缓冲的读入不再报“文件不存在”，改报 EFBIG；两处都经保留路径 `/.kwl-limit/<类别>` 的 stat 向宿主报告“执行域上限”。
 * - 结构化上限信号（复核 S3-18）：just-bash 的各类执行上限都构造 `ExecutionLimitError`，时限超出构造 `ExecutionAbortedError`；
 *   装载后在两者的原型链上插入记录器（不改打包产物），worker 据此判定“命令因执行域上限结束”，不再匹配用户可见的 stderr 文本。
 *
 * 不修改 node_modules：补丁在内存中应用后以 data: URL 装载，块文件以绝对 file: URL 引用（与原包同一模块实例）。
 * 摘要不符即失败关闭（执行域不可用），升级 just-bash 须重新核对补丁锚点与摘要。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const JB_VERSION = "3.6.0";
/** dist/bundle/index.js 的原始摘要。 */
export const JB_INDEX_SHA256 = "d769656d8dd94d595c8268c89ab6f447db0515266092304993ed3888838cf137";
/** 输出累加器所在块（导出 a = ExecutionOutputAccumulator）。 */
export const JB_ACC_CHUNK = "chunks/chunk-J2OBOJ64.js";
export const JB_ACC_CHUNK_SHA256 = "b62747dc35ddaba6076217d2081378133085eb37566d5004f41f7eb0c0207d6c";
/** python3 命令块与其 CPython worker（KJ-4）。 */
export const JB_PY_CHUNK = "chunks/python3-SDFCGIU4.js";
export const JB_PY_CHUNK_SHA256 = "aaaff389a6e24f1d8b096f6aca37d8464ec963388bea60e6188f8b1c82b5fb32";
export const JB_PY_WORKER = "chunks/worker.js";
export const JB_PY_WORKER_SHA256 = "275994d6da112b39026c92eaffb0990211ea3858269f1dc0d76244d4baf50247";
/** KJ-4 之后 python3 与宿主虚拟文件系统之间单次传输的上限。 */
export const PY_BRIDGE_BYTES = 64 * 1024 * 1024;
/** 解释器错误类所在块（导出 l = ExecutionLimitError、m = ExecutionAbortedError）。 */
export const JB_ERR_CHUNK = "chunks/chunk-EFORKKSH.js";
export const JB_ERR_CHUNK_SHA256 = "cb672598615f6f4cf5fbb99e83fe7c90298e8715193883714f7e1d827b8c0be2";
/**
 * 虚拟路径规范化函数所在块（导出 a = normalizePath；OverlayFs 以它作内存层与删除集合的键）。落盘加密读层（worker.ts）判断“这次读取来自
 * 内存层还是盘上”时必须用同一个函数（同一模块实例），否则会把内存层的明文当密文解、或把盘上密文当明文交给命令（审计 S3 第 2 步）。
 */
export const JB_PATH_CHUNK = "chunks/chunk-YUSFCOM7.js";
export const JB_PATH_CHUNK_SHA256 = "1f00b49cf5a44929f02af974fbc9f14f9cccc39df309bd86b040b89d4d7a4c33";
/** python3 的执行域上限经 stat 这一保留路径向宿主报告（worker.ts 拦截）。 */
export const LIMIT_PROBE_PREFIX = "/.kwl-limit/";

const PATCHES: readonly { id: string; find: string; replace: string }[] = [
  {
    id: "KJ-1",
    find: "jsBootstrapCode:t.jsBootstrapCode,invokeTool:t.invokeTool}}",
    replace: "jsBootstrapCode:t.jsBootstrapCode,invokeTool:t.invokeTool,onOutput:t.onOutput}}",
  },
  {
    id: "KJ-2",
    find: "invokeTool:this.invokeToolFn},N=await new Nr(k,m).executeScript(b)",
    replace: "invokeTool:this.invokeToolFn,onOutput:s===0?n?.onOutput:void 0},N=await new Nr(k,m).executeScript(b)",
  },
  {
    id: "KJ-3",
    find: 'let n=0,r=new Qt(this.ctx.executionScope,"script");for(let s of t.statements)',
    replace:
      'let n=0,r=new Qt(this.ctx.executionScope,"script");this.ctx.onOutput&&!this.ctx.__kwlRoot&&(this.ctx.__kwlRoot=r,r.__kwlEmit=this.ctx.onOutput);for(let s of t.statements)',
  },
];

const ACC_IMPORT_ANCHOR = 'import{a as Qt}from"./chunks/chunk-J2OBOJ64.js"';

export type OutputCallback = (stream: "stdout" | "stderr", chunk: string) => void;

/** 执行域上限的观察者：kind 为上限类别或消息（例如 "output size limit exceeded (…)"、"deadline: …"）。 */
export type LimitObserver = (kind: string) => void;

/**
 * 在 ExecutionLimitError / ExecutionAbortedError 的原型链上插入记录器（只装一次；同一 worker 内的全部块共用这两个类）。
 * `isOwnAbort()` 为真时（宿主的 SIGTERM 协作停止），ExecutionAbortedError 不计为上限。
 */
async function installLimitRecorders(bundleDir: string, observer: () => { onLimit: LimitObserver; isOwnAbort: () => boolean } | null): Promise<void> {
  const path = join(bundleDir, JB_ERR_CHUNK);
  if (sha256(readFileSync(path)) !== JB_ERR_CHUNK_SHA256) throw new Error("just-bash 错误类块摘要不符：执行域失败关闭");
  const mod = (await import(pathToFileURL(path).href)) as { l?: unknown; m?: unknown };
  type Ctor = (new (...a: unknown[]) => Error) & { EXIT_CODE?: number; __kwlRecorded?: boolean };
  const limitErr = mod.l as Ctor | undefined;
  const abortErr = mod.m as Ctor | undefined;
  if (typeof limitErr !== "function" || limitErr.EXIT_CODE !== 126 || typeof abortErr !== "function") throw new Error("just-bash 错误类结构不符：执行域失败关闭");
  const interpose = (cls: Ctor, onConstruct: (args: unknown[]) => void) => {
    if (cls.__kwlRecorded) return;
    const parent = Object.getPrototypeOf(cls) as new (...a: unknown[]) => Error;
    const Recorder = class extends parent {
      constructor(...args: unknown[]) {
        super(...args);
        try {
          onConstruct(args);
        } catch {
          // 观察者失败不影响解释器
        }
      }
    };
    Object.setPrototypeOf(cls, Recorder);
    Object.setPrototypeOf(cls.prototype, Recorder.prototype);
    cls.__kwlRecorded = true;
  };
  interpose(limitErr, (args) => observer()?.onLimit(String(args[0] ?? "limit")));
  interpose(abortErr, (args) => {
    const o = observer();
    if (o && !o.isOwnAbort()) o.onLimit(`deadline: ${String(args[1] ?? args[0] ?? "")}`.trim());
  });
  const probe = new limitErr("probe", "output_size");
  if (probe.name !== "ExecutionLimitError" || !(probe instanceof limitErr)) throw new Error("just-bash 错误类插桩失败：执行域失败关闭");
}

let limitObserver: { onLimit: LimitObserver; isOwnAbort: () => boolean } | null = null;
/** worker 设置本次执行的上限观察者（每个 worker 只执行一次）。 */
export function setLimitObserver(o: { onLimit: LimitObserver; isOwnAbort: () => boolean } | null): void {
  limitObserver = o;
}

export interface JustBashModule {
  Bash: new (o: Record<string, unknown>) => {
    exec(script: string, o: Record<string, unknown>): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  OverlayFs: new (o: Record<string, unknown>) => unknown;
  MountableFs: new (o: Record<string, unknown>) => unknown;
  InMemoryFs: new (initialFiles?: unknown, options?: { maxTotalBytes?: number }) => unknown;
  defineCommand: (name: string, execute: (args: string[], ctx: any) => Promise<{ stdout: string; stderr: string; exitCode: number }>) => unknown;
  /** OverlayFs 的虚拟路径规范化（JB_PATH_CHUNK 导出 a；与解释器同一模块实例）。 */
  normalizePath: (p: string) => string;
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const PY_TOTAL = 32 + 4096 + PY_BRIDGE_BYTES;

/** KJ-4：校验并修补 python3 的 CPython worker，返回 data: URL（worker 内 import.meta.url 换成原文件 URL，相对路径解析不变）。 */
function pythonWorkerDataUrl(bundleDir: string): string {
  const path = join(bundleDir, JB_PY_WORKER);
  const src = readFileSync(path, "utf8");
  if (sha256(src) !== JB_PY_WORKER_SHA256) throw new Error("just-bash python3 worker 摘要不符：执行域失败关闭");
  let out = src;
  for (const [find, replace] of [
    ["DATA_BUFFER: 8388608,", `DATA_BUFFER: ${PY_BRIDGE_BYTES},`],
    ["TOTAL: 8392736", `TOTAL: ${PY_TOTAL}`],
    // Emscripten 的错误码：EFBIG = 22（27 是 EINTR，CPython 会无限重试）
    ["      EFBIG: 27,", "      EFBIG: 22,"],
    // 执行域上限的结构化报告：stat 保留路径（宿主侧拦截并记录，返回 ENOENT）
    ["  function realPath(node) {", `  const kwlLimit = (kind) => { try { backend.stat(${JSON.stringify(LIMIT_PROBE_PREFIX)} + kind); } catch {} };\n  function realPath(node) {`],
    // 超过缓冲的读入：报 EFBIG（不再是“文件不存在”）
    ["        } catch (_e) {\n          if (isCreate && isWrite) {", "        } catch (_e) {\n          if (String(_e && _e.message || _e).includes(\"too large\")) { kwlLimit(\"python_read_too_large\"); throw new FS.ErrnoError(ERRNO_CODES.EFBIG); }\n          if (isCreate && isWrite) {"],
  ] as const) {
    if (countOf(out, find) !== 1) throw new Error(`just-bash 补丁锚点不唯一或缺失：KJ-4 worker（${find.slice(0, 40)}）`);
    out = out.replace(find, replace);
  }
  const efbig = "throw new FS.ErrnoError(ERRNO_CODES.EFBIG);";
  if (countOf(out, efbig) !== 4) throw new Error("just-bash 补丁锚点不符：KJ-4 worker（EFBIG 抛出点）");
  out = out.split(efbig).join('throw (kwlLimit("python_file_too_large"), new FS.ErrnoError(ERRNO_CODES.EFBIG));');
  if (countOf(out, "import.meta.url") !== 2) throw new Error("just-bash 补丁锚点缺失：KJ-4 worker（import.meta.url）");
  out = out.split("import.meta.url").join(JSON.stringify(pathToFileURL(path).href));
  return `data:text/javascript;base64,${Buffer.from(out, "utf8").toString("base64")}`;
}

/** KJ-4：校验并修补 python3 命令块（缓冲常量、worker 指向修补后的 data: URL、相对导入改为绝对），返回 data: URL。 */
function pythonChunkDataUrl(bundleDir: string, base: string): string {
  const path = join(bundleDir, JB_PY_CHUNK);
  const src = readFileSync(path, "utf8");
  if (sha256(src) !== JB_PY_CHUNK_SHA256) throw new Error("just-bash python3 块摘要不符：执行域失败关闭");
  let out = src;
  const workerExpr = 'X(new URL("./worker.js",import.meta.url))';
  for (const [find, replace] of [
    ["DATA_BUFFER:8388608,TOTAL:8392736", `DATA_BUFFER:${PY_BRIDGE_BYTES},TOTAL:${PY_TOTAL}`],
    [workerExpr, `new URL(${JSON.stringify(pythonWorkerDataUrl(bundleDir))})`],
  ] as const) {
    if (countOf(out, find) !== 1) throw new Error(`just-bash 补丁锚点不唯一或缺失：KJ-4 python3 块（${find.slice(0, 40)}）`);
    out = out.replace(find, replace);
  }
  out = out.split('"./chunk-').join(`"${base}chunks/chunk-`);
  if (out.includes('"./')) throw new Error("just-bash 补丁锚点缺失：KJ-4 python3 块（残留相对导入）");
  if (countOf(out, "import.meta.url") !== 1) throw new Error("just-bash 补丁锚点缺失：KJ-4 python3 块（import.meta.url）");
  out = out.replace("import.meta.url", JSON.stringify(pathToFileURL(path).href));
  return `data:text/javascript;base64,${Buffer.from(out, "utf8").toString("base64")}`;
}

/** 校验并装载（只在 worker 内调用一次）。 */
export async function loadJustBash(indexPath: string): Promise<JustBashModule> {
  const bundleDir = dirname(indexPath);
  const src = readFileSync(indexPath, "utf8");
  if (sha256(src) !== JB_INDEX_SHA256) throw new Error(`just-bash 随包代码摘要不符（期望 ${JB_VERSION} 锁定版本）：执行域失败关闭`);
  const accPath = join(bundleDir, JB_ACC_CHUNK);
  if (sha256(readFileSync(accPath)) !== JB_ACC_CHUNK_SHA256) throw new Error("just-bash 输出累加器块摘要不符：执行域失败关闭");
  if (countOf(src, ACC_IMPORT_ANCHOR) !== 1) throw new Error("just-bash 补丁锚点缺失（累加器导入）");
  let patched = src;
  for (const p of PATCHES) {
    if (countOf(patched, p.find) !== 1) throw new Error(`just-bash 补丁锚点不唯一或缺失：${p.id}`);
    patched = patched.replace(p.find, p.replace);
  }
  const base = pathToFileURL(`${bundleDir}/`).href;
  patched = patched.split('"./chunks/').join(`"${base}chunks/`);
  if (countOf(patched, "import.meta.url") !== 1) throw new Error("just-bash 补丁锚点缺失（import.meta.url）");
  patched = patched.replace("import.meta.url", JSON.stringify(pathToFileURL(indexPath).href));
  // KJ-4：python3 块与其 worker 的数据缓冲放大（两侧常量必须一致）
  const pyChunkUrl = pythonChunkDataUrl(bundleDir, base);
  const pyRef = `"${base}${JB_PY_CHUNK}"`;
  if (countOf(patched, pyRef) !== 2) throw new Error("just-bash 补丁锚点缺失（python3 块引用）");
  patched = patched.split(pyRef).join(JSON.stringify(pyChunkUrl));

  // 累加器回调：先入账（可能因输出超限抛错），成功后才回调；只有被 KJ-3 标记的根累加器带 __kwlEmit
  const accMod = (await import(pathToFileURL(accPath).href)) as { a: { prototype: Record<string, unknown> } };
  const proto = accMod.a.prototype as {
    append: (this: { __kwlEmit?: OutputCallback }, stream: "stdout" | "stderr", chunk: string, ...rest: unknown[]) => unknown;
    appendResult?: unknown;
    __kwlPatched?: boolean;
  };
  if (typeof proto.append !== "function" || typeof proto.appendResult !== "function") throw new Error("just-bash 输出累加器结构不符");
  if (!proto.__kwlPatched) {
    const orig = proto.append;
    proto.append = function (this: { __kwlEmit?: OutputCallback }, stream, chunk, ...rest) {
      const r = orig.call(this, stream, chunk, ...rest);
      const emit = this.__kwlEmit;
      if (emit && typeof chunk === "string" && chunk.length > 0) {
        try {
          emit(stream, chunk);
        } catch {
          // 回调失败不影响执行（最终结果仍含全部输出）
        }
      }
      return r;
    };
    proto.__kwlPatched = true;
  }
  const url = `data:text/javascript;base64,${Buffer.from(patched, "utf8").toString("base64")}`;
  const jb = { ...((await import(url)) as Omit<JustBashModule, "normalizePath">) } as JustBashModule;
  // 路径规范化：与 OverlayFs 同一模块实例（修补后的入口以同一绝对 URL 引用该块）
  const pathChunk = join(bundleDir, JB_PATH_CHUNK);
  if (sha256(readFileSync(pathChunk)) !== JB_PATH_CHUNK_SHA256) throw new Error("just-bash 路径块摘要不符：执行域失败关闭");
  if (countOf(patched, `"${base}${JB_PATH_CHUNK}"`) !== 1) throw new Error("just-bash 补丁锚点缺失（路径块引用）");
  const normalizePath = ((await import(pathToFileURL(pathChunk).href)) as { a?: unknown }).a;
  if (typeof normalizePath !== "function" || normalizePath("/a/./b/../c/") !== "/a/c" || normalizePath("x") !== "/x") throw new Error("just-bash 路径规范化结构不符：执行域失败关闭");
  jb.normalizePath = normalizePath as (p: string) => string;
  // 结构化上限信号：插桩须在装载之后（同一模块实例），且在任何命令执行之前
  await installLimitRecorders(bundleDir, () => limitObserver);
  return jb;
}
