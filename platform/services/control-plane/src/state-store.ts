/**
 * 控制面状态持久化（试点形态；调研 Y1 §5.2：v0 重启即丢失全部租户与吊销集，不能承载付费与撤权）。
 *
 * - 整份状态序列化为 JSON，**在每个改变状态的响应发出之前**写盘：吊销、席位、策略发布等一旦回复成功即已持久；启动时读回。
 *   内容只是元数据（设备证书公钥、席位、策略、匿名事项摘要、租户盐、防重放 nonce），不含任何案卷内容；
 * - **两代交替文件**（复核 B4-R04）：`<路径>.1` 与 `<路径>.2` 轮流写，每份带单调序号与校验（封装形态为 AES-256-GCM 标签，
 *   明文形态为 sha256）；写的永远是较旧的那一份，写入后 fsync。读取时取序号最大且校验通过的一份——写到一半掉电，
 *   坏的那份校验不过，回退到上一代。不依赖改名（Windows 上改名的元数据不是直写），首次创建文件时另对目录 fsync（POSIX）；
 * - 可选 AES-256-GCM 封装（附加数据为格式名 + 序号）：租户盐等不应明文躺在磁盘上；生产由 KMS 下发数据密钥；
 *   `requireKey`（生产形态）没有密钥即拒绝构造（复核 B4-R14）；
 * - 残余：两份文件被同时整体换成更旧的版本（回滚吊销）在本层挡不住——须与设备侧记下的最大目录版本比对（客户端拒收回退的目录）；
 * - 这是单实例试点的做法。生产形态按调研 Y2 §7.1 改为 PostgreSQL（行级隔离）+ Redis（nonce），接口不变；
 *   控制面签名密钥不在本存储内（生产在签名服务/KMS）。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface StateStore {
  /** 读回上次保存的 JSON；没有即 null。 */
  load(): string | null;
  save(json: string): void;
}

const FORMAT = "kwl-cp-state/1";

interface Generation {
  format: string;
  seq: number;
  sealed: boolean;
  iv?: string;
  tag?: string;
  sha256?: string;
  data: string;
}

/** 文件系统适配（测试注入，用于断言写入与 fsync 的顺序、模拟写坏）。 */
export interface StateFs {
  readFileSync(path: string, enc: "utf8"): string;
  existsSync(path: string): boolean;
  mkdirSync(path: string, o: { recursive: true; mode: number }): void;
  openSync(path: string, flags: string, mode?: number): number;
  writeSync(fd: number, data: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
}
const realFs: StateFs = { readFileSync, existsSync, mkdirSync: (p, o) => void mkdirSync(p, o), openSync, writeSync, fsyncSync, closeSync };

export function fileStateStore(path: string, o: { key?: Uint8Array; requireKey?: boolean; fs?: StateFs } = {}): StateStore {
  if (o.key && o.key.byteLength !== 32) throw new Error("控制面状态封装密钥须为 32 字节");
  if (o.requireKey && !o.key) throw new Error("生产形态的控制面状态必须封装：未配置封装密钥，拒绝启动");
  const key = o.key ? Buffer.from(o.key) : null;
  const fs = o.fs ?? realFs;
  const files = [`${path}.1`, `${path}.2`] as const;
  const aad = (seq: number) => Buffer.from(`${FORMAT}\u0000${seq}`);

  /** 读一份；不存在 null；校验不过返回 "bad"（掉电写坏的那一份）。 */
  const readGen = (file: string): { seq: number; json: string } | "bad" | null => {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    let doc: Generation;
    try {
      doc = JSON.parse(raw) as Generation;
    } catch {
      return "bad";
    }
    if (doc.format !== FORMAT || typeof doc.data !== "string" || !Number.isSafeInteger(doc.seq) || doc.seq < 1) return "bad";
    if (!doc.sealed) {
      if (key) throw new Error("控制面状态文件是明文，但本次启动配置了封装密钥：拒绝读取（先做迁移）");
      return createHash("sha256").update(doc.data).digest("hex") === doc.sha256 ? { seq: doc.seq, json: doc.data } : "bad";
    }
    if (!key) throw new Error("控制面状态文件已封装，本次启动没有封装密钥");
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(doc.iv!, "base64"));
      d.setAAD(aad(doc.seq));
      d.setAuthTag(Buffer.from(doc.tag!, "base64"));
      return { seq: doc.seq, json: Buffer.concat([d.update(Buffer.from(doc.data, "base64")), d.final()]).toString("utf8") };
    } catch {
      return "bad";
    }
  };

  let lastSeq = 0;
  let lastFile = -1;
  return {
    load() {
      const gens = files.map(readGen);
      const good = gens.map((g, i) => (g && g !== "bad" ? { ...g, i } : null)).filter((g): g is { seq: number; json: string; i: number } => g !== null);
      if (good.length === 0) {
        // 两份都坏：不静默从空状态开始（那等于撤销全部吊销）
        if (gens.some((g) => g === "bad")) throw new Error("控制面状态文件两代都无法校验（文件损坏或密钥不符），拒绝启动");
        return null;
      }
      const best = good.reduce((a, b) => (b.seq > a.seq ? b : a));
      lastSeq = best.seq;
      lastFile = best.i;
      return best.json;
    },
    save(json) {
      const seq = lastSeq + 1;
      let doc: Generation;
      if (key) {
        const iv = randomBytes(12);
        const c = createCipheriv("aes-256-gcm", key, iv);
        c.setAAD(aad(seq));
        const ct = Buffer.concat([c.update(json, "utf8"), c.final()]);
        doc = { format: FORMAT, seq, sealed: true, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: ct.toString("base64") };
      } else doc = { format: FORMAT, seq, sealed: false, sha256: createHash("sha256").update(json).digest("hex"), data: json };
      // 写较旧（或尚未写过）的那一份；最新一代保持不动
      const target = lastFile === 0 ? 1 : 0;
      const file = files[target];
      const created = !fs.existsSync(file);
      fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(file, "w", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(doc));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // 新建文件：目录项也要落盘（POSIX；Windows 上打开目录会失败，忽略）
      if (created) {
        try {
          const dfd = fs.openSync(dirname(path), "r");
          try {
            fs.fsyncSync(dfd);
          } finally {
            fs.closeSync(dfd);
          }
        } catch {
          // Windows：NTFS 元数据日志保证新建文件的目录项
        }
      }
      lastSeq = seq;
      lastFile = target;
    },
  };
}

/** 内存实现（测试：模拟“重启”只需用同一个存储再建一次控制面）。可设 `failNext` 模拟写盘失败。 */
export function memoryStateStore(): StateStore & { saves: number; failNext: number } {
  let data: string | null = null;
  const s = {
    saves: 0,
    failNext: 0,
    load: () => data,
    save(json: string) {
      if (s.failNext > 0) {
        s.failNext -= 1;
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      data = json;
      s.saves += 1;
    },
  };
  return s;
}
