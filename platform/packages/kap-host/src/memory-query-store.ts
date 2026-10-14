/**
 * 内存查询库（审计 S3 第 1 步 1-6）：替换引擎的 minidb 查询库（`IQueryStore`）。minidb 把会话索引的读模型（会话标题、提示词片段等）
 * 以明文 WAL 与分代文件写在 `home/cache/query-store`；它本是可重建的“结构化读模型”——宿主进程内存持有即可，宿主重启后由会话索引
 * 投影器从（已加密的）会话存储全量重建（上游 sessionIndexService：无检查点即全量投影）。
 *
 * 过滤语义直接复用 minidb 的纯函数（`match`、`getPath`，经 kap-embed 制品导出），与原实现一致；值按 JSON 语义存取（存入与取出都复制）。
 */
import { minidbGetPath, minidbMatch, QueryStoreRebuiltError } from "../vendor/kap-embed/kap-embed.mjs";

type Row = { value: unknown; columns: Record<string, number> | undefined };
type Bounds = { gt?: number; gte?: number; lt?: number; lte?: number };

const CHECKPOINT = "__checkpoint__";
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function inBounds(v: number | undefined, b: Bounds): boolean {
  if (typeof v !== "number") return false;
  if (b.gt !== undefined && !(v > b.gt)) return false;
  if (b.gte !== undefined && !(v >= b.gte)) return false;
  if (b.lt !== undefined && !(v < b.lt)) return false;
  if (b.lte !== undefined && !(v <= b.lte)) return false;
  return true;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

export class MemoryQueryStore {
  declare readonly _serviceBrand: undefined;
  private readonly data = new Map<string, Map<string, Row>>();

  private coll(name: string): Map<string, Row> {
    let c = this.data.get(name);
    if (!c) {
      c = new Map();
      this.data.set(name, c);
    }
    return c;
  }

  async put<T>(collection: string, key: string, value: T, options?: { columns?: Record<string, number> }): Promise<void> {
    this.coll(collection).set(key, { value: clone(value), columns: options?.columns ? { ...options.columns } : undefined });
  }

  async batch(ops: readonly ({ kind: "put"; collection: string; key: string; value: unknown; columns?: Record<string, number> } | { kind: "delete"; collection: string; key: string })[]): Promise<void> {
    for (const op of ops) {
      if (op.kind === "put") await this.put(op.collection, op.key, op.value, op.columns ? { columns: op.columns } : undefined);
      else await this.delete(op.collection, op.key);
    }
  }

  async delete(collection: string, key: string): Promise<void> {
    this.data.get(collection)?.delete(key);
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    return clone(this.data.get(collection)?.get(key)?.value as T | undefined);
  }

  async getMany<T>(collection: string, keys: readonly string[]): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    const c = this.data.get(collection);
    for (const k of keys) {
      const r = c?.get(k);
      if (r) out.set(k, clone(r.value as T));
    }
    return out;
  }

  query<T>(collection: string): MemoryQuery<T> {
    return new MemoryQuery<T>(() => [...(this.data.get(collection)?.values() ?? [])]);
  }

  async pageByColumn<T>(collection: string, q: { column: string; dir?: "asc" | "desc"; bounds?: Bounds; filter?: Record<string, unknown>; limit: number }): Promise<{ items: readonly T[] }> {
    const dir = q.dir ?? "asc";
    const rows = [...(this.data.get(collection)?.values() ?? [])]
      .filter((r) => inBounds(r.columns?.[q.column], q.bounds ?? {}))
      .filter((r) => !q.filter || minidbMatch(r.value, q.filter))
      .sort((a, b) => (dir === "desc" ? -1 : 1) * compare(a.columns?.[q.column], b.columns?.[q.column]));
    return { items: rows.slice(0, q.limit).map((r) => clone(r.value as T)) };
  }

  async ensureIndex(collection: string, def: { kind: string; name: string }): Promise<void> {
    if (def.kind === "text") {
      throw new Error(`query-store is a structural read model: text index "${def.name}" on collection "${collection}" is rejected`);
    }
  }

  async listKeys(collection: string): Promise<readonly string[]> {
    return [...(this.data.get(collection)?.keys() ?? [])];
  }

  async dropCollection(collection: string): Promise<void> {
    this.data.delete(collection);
  }

  async getCheckpoint(source: string): Promise<{ seq: number } | undefined> {
    return this.get(CHECKPOINT, source);
  }

  async setCheckpoint(source: string, checkpoint: { seq: number }, expectedStoreEpoch?: number): Promise<void> {
    if (expectedStoreEpoch !== undefined && expectedStoreEpoch !== 0) throw new QueryStoreRebuiltError();
    await this.put(CHECKPOINT, source, checkpoint);
  }

  storeEpoch(): number {
    return 0;
  }

  async close(): Promise<void> {
    this.data.clear();
  }
}

class MemoryQuery<T> {
  private filter: Record<string, unknown> = {};
  private column?: { name: string; bounds: Bounds };
  private sortField?: string;
  private sortDir: "asc" | "desc" = "asc";
  private lim?: number;
  private skip = 0;

  private readonly rows: () => Row[];

  constructor(rows: () => Row[]) {
    this.rows = rows;
  }

  where(filter: Record<string, unknown>): this {
    this.filter = { ...this.filter, ...filter };
    return this;
  }

  whereColumn(column: string, bounds: Bounds): this {
    this.column = { name: column, bounds };
    return this;
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): this {
    this.sortField = field;
    this.sortDir = dir;
    return this;
  }

  limit(n: number): this {
    this.lim = n;
    return this;
  }

  cursor(cursor: string | undefined): this {
    this.skip = cursor !== undefined && cursor.length > 0 ? Number(cursor) : 0;
    return this;
  }

  async execute(): Promise<{ items: readonly T[]; nextCursor?: string }> {
    let rows = this.rows();
    if (Object.keys(this.filter).length > 0) rows = rows.filter((r) => minidbMatch(r.value, this.filter));
    if (this.column) rows = rows.filter((r) => inBounds(r.columns?.[this.column!.name], this.column!.bounds));
    if (this.sortField !== undefined) {
      const f = this.sortField;
      const s = this.sortDir === "desc" ? -1 : 1;
      rows = rows.sort((a, b) => s * compare(minidbGetPath(a.value, f), minidbGetPath(b.value, f)));
    }
    rows = rows.slice(this.skip);
    let nextCursor: string | undefined;
    if (this.lim !== undefined && rows.length > this.lim) {
      rows = rows.slice(0, this.lim);
      nextCursor = String(this.skip + this.lim);
    }
    return { items: rows.map((r) => clone(r.value as T)), ...(nextCursor ? { nextCursor } : {}) };
  }
}
