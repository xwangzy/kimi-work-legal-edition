/**
 * 第 52 批：上游密钥经 stdio 第 3 路（socketpair）交给云端进程（stack-local / 云端仓库 CI 冒烟的做法）。
 * Linux 上按路径打开 /dev/fd/3 报 ENXIO，子进程读不到密钥退出、父进程 ECONNRESET 崩溃（云端仓库 CI run 44758604304）；
 * scripts/lib/secret-file.mjs 按描述符读。本用例用真实子进程走同一条路，在 Linux CI 上就是回归门禁。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// @ts-expect-error 纯 JS 模块（生产入口的辅助库）
import { fdOf, readSecretFile } from "../../../scripts/lib/secret-file.mjs";

const lib = pathToFileURL(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../scripts/lib/secret-file.mjs")).href;

/** 起一个子进程：第 3 路是管道，父进程写入 secret 后 end()；子进程用 readSecretFile 读两次（第二次走缓存），把长度与是否一致打印出来。 */
function childReads(secret: string, path: string): Promise<{ code: number | null; out: string; pipeError: string | null }> {
  const code = `import { readSecretFile } from ${JSON.stringify(lib)};
try { const a = readSecretFile(${JSON.stringify(path)}); const b = readSecretFile(${JSON.stringify(path)}); console.log(JSON.stringify({ len: a.length, same: a === b, sk: a.startsWith("sk-") })); }
catch (e) { console.log(JSON.stringify({ err: e.code ?? e.message })); process.exit(1); }`;
  return new Promise((done) => {
    const k = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let out = "";
    let pipeError: string | null = null;
    k.stdout!.on("data", (d) => (out += d));
    k.stderr!.on("data", (d) => (out += d));
    const p = k.stdio[3] as NodeJS.WritableStream & { on(ev: "error", fn: (e: NodeJS.ErrnoException) => void): unknown };
    p.on("error", (e) => (pipeError = e.code ?? "error"));
    p.end(`${secret}\n`);
    k.on("exit", (c) => done({ code: c, out: out.trim(), pipeError }));
  });
}

test("经 stdio 第 3 路传入的密钥：/dev/fd/3 按描述符读出（Linux 上按路径打开会 ENXIO）", async () => {
  const secret = `sk-test${"x".repeat(40)}`;
  const r = await childReads(secret, "/dev/fd/3");
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(r.out), { len: secret.length, same: true, sk: true });
  assert.equal(r.pipeError, null);
});

test("/proc/self/fd/3 写法同样按描述符读", async () => {
  const secret = `sk-test${"y".repeat(32)}`;
  const r = await childReads(secret, "/proc/self/fd/3");
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(r.out).len, secret.length);
});

test("标准输入输出（0～2）不能当密钥来源；普通文件照常按路径读", () => {
  assert.equal(fdOf("/dev/fd/0"), -1);
  assert.equal(fdOf("/dev/fd/2"), -1);
  assert.equal(fdOf("/dev/fd/3"), 3);
  assert.equal(fdOf("/etc/kwl/secrets/maas.key"), null);
  assert.throws(() => readSecretFile("/dev/fd/1"), /0～2/);
  const dir = mkdtempSync(join(tmpdir(), "kwl-secret-fd-"));
  writeFileSync(join(dir, "k"), "  sk-file-abc  \n");
  assert.equal(readSecretFile(join(dir, "k")), "sk-file-abc");
});
