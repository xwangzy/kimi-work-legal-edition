/**
 * 命名管道名加随机盐（第 4 批复核 B4-A14）：用户名与数据目录对同机其他账户可推算，RDS 上可被抢先占名；
 * 每个数据目录首次运行生成一份盐（只有本账户可读），同一目录稳定、不同目录不同、损坏即重建，管道名随之不可推算。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeSalt, pipeSuffix } from "../src/config.ts";

test("管道盐：同一数据目录稳定、不同目录不同、文件损坏重建；加盐后的后缀与不加盐不同", () => {
  const a = mkdtempSync(join(tmpdir(), "kwl-salt-a-"));
  const b = mkdtempSync(join(tmpdir(), "kwl-salt-b-"));
  const sa = pipeSalt(a);
  assert.match(sa, /^[0-9a-f]{32}$/);
  assert.equal(pipeSalt(a), sa, "同一目录稳定");
  assert.notEqual(pipeSalt(b), sa, "不同目录不同");
  if (process.platform !== "win32") assert.equal(statSync(join(a, ".pipe-salt")).mode & 0o077, 0, "只有本账户可读");
  writeFileSync(join(a, ".pipe-salt"), "坏了");
  const rebuilt = pipeSalt(a);
  assert.match(rebuilt, /^[0-9a-f]{32}$/);
  assert.equal(readFileSync(join(a, ".pipe-salt"), "utf8"), rebuilt);
  const dir = "C:\\Users\\zhang\\AppData\\Local\\KimiWorkLegal\\demo-firm";
  assert.notEqual(pipeSuffix(dir, "zhang", sa), pipeSuffix(dir, "zhang"), "盐参与摘要");
  assert.equal(pipeSuffix(dir, "zhang", sa), pipeSuffix(dir.toLowerCase(), "zhang", sa));
});
