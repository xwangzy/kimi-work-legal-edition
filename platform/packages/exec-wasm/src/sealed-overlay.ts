/**
 * W 执行域读层解密（审计 S3 第 2 步；设计 docs/audit-2026-10-13/设计-工作区与会话落盘加密.md §4.4）。
 *
 * 工作区与材料快照在盘上是 KWE1 密文（文件 broker 写入时封装）。W 的 OverlayFs 直接读盘：在 worker 内对每个加密挂载的 OverlayFs
 * **实例**包装三个方法——
 * - readFileBuffer：这次读取若来自盘上（不在内存层、不在删除集合），读出的密文按本挂载的区密钥解封；内存层（命令写入的明文）原样返回；
 * - stat / lstat：来自盘上的普通文件报告明文长度（只读 64 字节文件头，按盘上长度闭式算出）；
 * 其余方法（cp、mv、appendFile、chmod、link……）在 OverlayFs 内部都经 `this.readFileBuffer` / `this.stat` 取内容与大小，随之解密。
 * “来自内存层还是盘上”用 OverlayFs 自己的路径规范化函数（同一模块实例，jb-loader 按摘要装载）在调用原方法之前同步判定——
 * 原方法在第一个 await 之前就完成同样的判定，两者看到的是同一个状态。
 *
 * 写入不变：命令的写入留在内存层（明文、只在 W 内存里），结束时作为改动集交宿主，经文件 broker 提交时封装。
 * 与设计 D1（just-bash 运行时补丁 KJ-5）的差别：不改打包产物，只在实例上包装（与既有的上限记录器同法）；依赖的内部成员
 * （memory、deleted、toRealPath、resolveRealPath_、resolveRealPathParent_）缺失即拒绝运行（失败关闭），just-bash 版本另由锁定摘要约束。
 *
 * 读不出（明文被外部植入、密文损坏或用错密钥、格式不是分块）时抛 EIO，并经 onRefused 报告给 worker（复核 S3B-B01）：just-bash 的
 * `>>` 追加（OverlayFs.appendFile）与 python3 的 'a' 模式会吞掉读错误、把文件当空文件，随后提交会用“只剩追加内容”的文件覆盖原文件——
 * worker 据此把整次改动视为不写回（与执行域上限同一处理）。
 *
 * 如实的残余：区密钥（只有本挂载用途的一把）进入 W 进程内存——W 内运行的是模拟 bash 与零 JS 桥 CPython，模型代码拿不到 JS 堆；
 * 若发生解释器逃逸，逃逸者本就能经已授予的读权限 + 本读层读到这些区的明文，且 W 无网络（设计 §4.4、§8 第 6 条）。
 */
import { closeSync, constants as FS, openSync, readSync } from "node:fs";
import { HEADER_BYTES, isChunkedHeader, isSealed, isValidChunkedSize, plainSizeOf, ZoneCodec, type ZoneKeysOfPurpose } from "@zr-legal/at-rest";

interface OverlayInternals {
  memory: Map<string, unknown>;
  deleted: Set<string>;
  readFileBuffer(path: string, seen?: Set<string>): Promise<Uint8Array>;
  stat(path: string, seen?: Set<string>): Promise<{ isFile?: boolean; size?: number } & Record<string, unknown>>;
  lstat(path: string): Promise<{ isFile?: boolean; size?: number } & Record<string, unknown>>;
  toRealPath(p: string): string | null;
  resolveRealPath_(p: string | null): string | null;
  resolveRealPathParent_(p: string | null): string | null;
}

const O_NOFOLLOW = (FS as Record<string, number>).O_NOFOLLOW ?? 0;

export interface SealedOverlayOptions {
  keys: ZoneKeysOfPurpose;
  strict: boolean;
  /** OverlayFs 的路径规范化（jb-loader 的 normalizePath）。 */
  normalize: (p: string) => string;
  /** 盘上文件读不出时的结构化报告（worker 据此整次不写回）。 */
  onRefused?: (kind: string) => void;
}

/** 在 OverlayFs 实例上安装解密读层；返回该挂载的编解码器（worker 结束时清零）。 */
export function sealOverlay(target: object, o: SealedOverlayOptions): ZoneCodec {
  const t = target as OverlayInternals;
  if (!(t.memory instanceof Map) || !(t.deleted instanceof Set)) throw new Error("执行域自检失败：just-bash OverlayFs 结构不符（内存层）");
  for (const m of ["readFileBuffer", "stat", "lstat", "toRealPath", "resolveRealPath_", "resolveRealPathParent_"] as const) {
    if (typeof t[m] !== "function") throw new Error(`执行域自检失败：just-bash OverlayFs 缺少 ${m}（无法安装解密读层）`);
  }
  const codec = ZoneCodec.fromWire(o.keys);
  const keyOf = (p: unknown): string | null => (typeof p === "string" && !p.includes("\0") ? o.normalize(p) : null);
  const fromDisk = (key: string | null): boolean => key !== null && !t.memory.has(key) && !t.deleted.has(key);

  const refuse = (kind: string, msg: string): never => {
    try {
      o.onRefused?.(kind);
    } catch {
      // 报告失败不影响拒读
    }
    throw new Error(msg);
  };
  const decode = (path: string, bytes: Uint8Array): Uint8Array => {
    if (isSealed(bytes)) {
      // 工作区与材料快照只有分块格式（复核 S3B-A04：追加日志格式无需密钥即可伪造成“空文件”）
      if (!isChunkedHeader(bytes)) return refuse("sealed_read_refused_format", `EIO: file in an encrypted workspace has an unexpected format (refused), read '${path}'`);
      try {
        return new Uint8Array(codec.open(bytes));
      } catch (e) {
        return refuse("sealed_read_refused_auth", `EIO: encrypted file could not be decrypted (${(e as Error).message}), read '${path}'`);
      }
    }
    if (o.strict && bytes.length > 0) return refuse("sealed_read_refused_plaintext", `EIO: file in an encrypted workspace is not encrypted (refused), read '${path}'`);
    return bytes;
  };

  /** 盘上普通文件的明文长度：只读文件头（分块格式闭式算出；追加日志整读扫描；明文旧文件报告盘上长度）。 */
  const plainSizeAt = (real: string, diskSize: number): number => {
    let fd: number;
    try {
      fd = openSync(real, FS.O_RDONLY | O_NOFOLLOW);
    } catch {
      return diskSize;
    }
    try {
      const h = Buffer.alloc(HEADER_BYTES);
      const n = readSync(fd, h, 0, HEADER_BYTES, 0);
      // 分块格式且结构合法：闭式算出明文长度；截断的、日志格式的、明文的：报告盘上长度（读取会如实拒绝）
      if (n === HEADER_BYTES && isChunkedHeader(h) && isValidChunkedSize(diskSize)) return plainSizeOf(diskSize);
      return diskSize;
    } finally {
      closeSync(fd);
    }
  };

  const fixSize = <S extends { isFile?: boolean; size?: number }>(key: string, st: S, parentOnly: boolean): S => {
    if (!st || !st.isFile || typeof st.size !== "number") return st;
    const rp = t.toRealPath(key);
    const real = parentOnly ? t.resolveRealPathParent_(rp) : t.resolveRealPath_(rp);
    if (!real) return st;
    return { ...st, size: plainSizeAt(real, st.size) };
  };

  const origRead = t.readFileBuffer;
  const origStat = t.stat;
  const origLstat = t.lstat;
  // 原方法在第一个 await 之前完成“内存层/删除集合/盘上”的判定：这里在同一同步段内先判定、再调用原方法
  t.readFileBuffer = function (path: string, seen?: Set<string>) {
    const disk = fromDisk(keyOf(path));
    const p = origRead.call(t, path, seen);
    return disk ? p.then((bytes) => decode(path, bytes)) : p;
  };
  t.stat = function (path: string, seen?: Set<string>) {
    const key = keyOf(path);
    const disk = fromDisk(key);
    const p = origStat.call(t, path, seen);
    return disk ? p.then((st) => fixSize(key!, st, false)) : p;
  };
  t.lstat = function (path: string) {
    const key = keyOf(path);
    const disk = fromDisk(key);
    const p = origLstat.call(t, path);
    return disk ? p.then((st) => fixSize(key!, st, true)) : p;
  };
  return codec;
}
