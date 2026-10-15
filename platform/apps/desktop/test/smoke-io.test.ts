/**
 * 安装后冒烟的入口与结果写出（第 4 批复核 B4-A08）：须同时设置 KWL_SMOKE=1；结果文件只能是本地绝对路径下的新 .json 文件；
 * UNC 与设备路径、已存在的文件一律拒绝；结果只写登记的错误代码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const s = require("../electron/smoke-io.cjs") as {
  parseSmokeArg(argv: string[], env: Record<string, string | undefined>, platform?: string, exists?: (p: string) => boolean): { requested: boolean; out: string | null; problem: string | null };
  writeSmokeResult(file: string, result: Record<string, unknown>): void;
};
const ON = { KWL_SMOKE: "1" };
const none = () => false;

test("冒烟入口：没带参数不进入；带了参数须 KWL_SMOKE=1、本地绝对路径、.json、文件不存在，否则拒绝（调用方以 3 退出）", () => {
  assert.deepEqual(s.parseSmokeArg(["app.exe"], ON, "win32", none), { requested: false, out: null, problem: null });
  assert.equal(s.parseSmokeArg(["app.exe", "--kwl-smoke=C:\\t\\r.json"], ON, "win32", none).out, "C:\\t\\r.json");
  for (const [arg, env, why] of [
    ["--kwl-smoke=C:\\t\\r.json", {}, /KWL_SMOKE/],
    ["--kwl-smoke=\\\\host\\share\\r.json", ON, /网络路径/],
    ["--kwl-smoke=//host/share/r.json", ON, /网络路径/],
    ["--kwl-smoke=\\\\?\\C:\\r.json", ON, /网络路径或设备路径/],
    ["--kwl-smoke=r.json", ON, /盘符/],
    ["--kwl-smoke=C:\\t\\r.txt", ON, /\.json/],
    ["--kwl-smoke=", ON, /为空/],
  ] as const) {
    const r = s.parseSmokeArg(["app.exe", arg], env, "win32", none);
    assert.equal(r.requested, true, arg);
    assert.equal(r.out, null, arg);
    assert.match(r.problem ?? "", why, arg);
  }
  assert.match(s.parseSmokeArg(["app.exe", "--kwl-smoke=C:\\t\\r.json"], ON, "win32", () => true).problem ?? "", /已存在/);
  assert.equal(s.parseSmokeArg(["app", "--kwl-smoke=/tmp/r.json"], ON, "linux", none).out, "/tmp/r.json");
  assert.match(s.parseSmokeArg(["app", "--kwl-smoke=tmp/r.json"], ON, "linux", none).problem ?? "", /绝对路径/);
});

test("冒烟结果：不覆盖已存在的文件；错误只保留登记的代码", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-smoke-"));
  const f = join(dir, "r.json");
  s.writeSmokeResult(f, { ok: false, error: "D:\\案件\\张三诉李四\\材料.pdf 打不开" });
  assert.equal(JSON.parse(readFileSync(f, "utf8")).error, "internal", "原始消息不写入结果");
  writeFileSync(f, "{}");
  assert.throws(() => s.writeSmokeResult(f, { ok: true }), /EEXIST/);
  assert.equal(readFileSync(f, "utf8"), "{}");
  const g = join(dir, "g.json");
  s.writeSmokeResult(g, { ok: false, error: "renderer_not_mounted" });
  assert.equal(JSON.parse(readFileSync(g, "utf8")).error, "renderer_not_mounted");
});
