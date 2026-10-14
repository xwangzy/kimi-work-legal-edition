/**
 * 事项账本存储（方案 v5.0 第 4 篇 §5.1/§5.2）：SQLite + 页级加密。
 *
 * - 驱动：better-sqlite3-multiple-ciphers（N-API，SQLCipher v4 格式；V3 一手核验）。
 *   页级加密已接线：数据库主密钥由 Electron safeStorage 异步 API 解封后一次性交付内核
 *   （§5.1；开发可用 ZR_DB_KEY，README 注明仅开发用）。
 * - 同步 API：内核是单进程，同步驱动省去连接池；事务只包同步代码段。
 * - 事件表 + 投影视图：业务事实追加写入 run_events / audit_events / egress_records；
 *   matters/runs/artifact_versions 等为投影视图（§5.2 事件溯源的 v0 落点）。
 *   签名与 hash 链已接入：signed_events 见证表对业务行逐条签名成链（0002 迁移；
 *   run_events 预留的 prev_hash/event_hash 两列不再使用，链以 signed_events 为准）。
 *   egress_records 的信封口径排除生命周期列（request_id/outcome/note，插入后可变）。
 */
import Database from "better-sqlite3-multiple-ciphers";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class KernelDb {
  readonly db: InstanceType<typeof Database>;

  constructor(file: string, opts: { key?: string | undefined } = {}) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    if (opts.key) {
      // G0 第 3–4 周启用：页级加密（SQLCipher v4）；key 由 safeStorage 解封后传入
      this.db.pragma(`key = '${opts.key.replace(/'/g, "''")}'`);
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    // 删除即覆写空闲页（审计 S3：撤权删除的工作区密钥包裹行、令牌表等不在空闲页残留）
    this.db.pragma("secure_delete = ON");
  }

  migrate(migrationsDir?: string): void {
    // ESM 直跑（Node ≥ 26 类型剥离）取包内目录；CJS 制品（esbuild）取制品旁目录
    const here = typeof __dirname !== "undefined" ? __dirname : fileURLToPath(new URL(".", import.meta.url));
    const dir = migrationsDir ?? join(here, "migrations");
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at text NOT NULL)`);
    const applied = new Set(this.all<{ name: string }>(`SELECT name FROM schema_migrations`, []).map((r) => r.name));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(dir, f), "utf8");
      if (sql.includes("-- kwl:managed-transaction")) {
        // 迁移器管理事务（复审 R-16）：重建表类迁移需临时关闭外键；外键完整性检查在 COMMIT 之前执行，
        // 有违例即回滚——迁移与登记都不生效，下次启动会重新尝试并再次检查
        this.db.pragma("foreign_keys = OFF");
        try {
          this.db.exec("BEGIN");
          try {
            this.db.exec(sql);
            const violations = this.db.pragma("foreign_key_check") as unknown[];
            if (violations.length > 0) {
              throw new Error(`迁移 ${f} 产生 ${violations.length} 处外键违例，已回滚：${JSON.stringify(violations.slice(0, 3))}`);
            }
            this.run(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`, [f, new Date().toISOString()]);
            this.db.exec("COMMIT");
          } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
          }
        } finally {
          this.db.pragma("foreign_keys = ON");
        }
        continue;
      }
      // 早期迁移脚本自带 BEGIN/COMMIT（不重建表、不关外键）
      this.db.exec(sql);
      this.run(`INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)`, [f, new Date().toISOString()]);
    }
    // 每次启动都检查外键完整性（复审 R-16）：有违例即拒绝启动，不带着坏数据运行
    const violations = this.db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(`数据库外键检查发现 ${violations.length} 处违例，拒绝启动：${JSON.stringify(violations.slice(0, 3))}`);
    }
  }

  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...(params as any[]));
  }

  get<T = any>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...(params as any[])) as T | undefined;
  }

  all<T = any>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as any[])) as T[];
  }

  /** 事务：只包同步代码段（模型调用等异步动作不得放在事务内）。 */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * 把 WAL 里的页写回主库并截断 WAL（删除后调用；复核 C-A17）：WAL 保留着删除前的页面映像，checkpoint 之前磁盘上仍有旧内容；
   * 主库空闲页由 secure_delete 清零。
   */
  checkpointTruncate(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    this.db.close();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
