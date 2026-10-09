/**
 * better-sqlite3-multiple-ciphers 的最小类型声明（包内 index.d.ts 未随 exports 暴露）。
 * 只覆盖内核用到的 API 面；与 better-sqlite3 主线上游 API 一致。
 */
declare module "better-sqlite3-multiple-ciphers" {
  namespace Database {
    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }
    interface Statement {
      run(...params: unknown[]): RunResult;
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    }
    interface Options {
      readonly?: boolean;
      fileMustExist?: boolean;
    }
  }
  class Database {
    constructor(filename: string, options?: Database.Options);
    pragma(sql: string): unknown;
    prepare(sql: string): Database.Statement;
    exec(sql: string): this;
    transaction<F extends (...args: never[]) => unknown>(fn: F): F;
    close(): this;
  }
  export = Database;
}
