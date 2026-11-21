/**
 * 第 55 批 K5（审计 B 6.1）：本机 npm test 先跑“产物齐全”自检，缺了 1 分钟内失败并写明缺什么、怎么补；
 * 用例与 CI 同一套时限（逐文件运行器 + 单用例 300 秒）。CI 不经 npm test，行为不变。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { missingPrereqs } from "./helpers.ts";

const PLATFORM = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(PLATFORM, "scripts", "check-test-prereqs.mjs");
// 脚本是 .mjs、没有类型声明：按地址动态加载
const { TEST_PREREQS, missingTestPrereqs } = (await import(pathToFileURL(SCRIPT).href)) as {
  TEST_PREREQS: [string, string, string][];
  missingTestPrereqs: (root?: string, exists?: (p: string) => boolean) => { rel: string; what: string; fix: string }[];
};

test("清单覆盖内核用例的构建产物，并补上内容签名密钥与 OCR 模型", () => {
  const rels = TEST_PREREQS.map(([r]) => r);
  // helpers.ts 里内核用例自己查的那几项都在清单里
  const helperRels = missingPrereqs(() => false).map((s) => s.replace(/（.*$/, ""));
  for (const r of helperRels) assert.ok(rels.includes(r), r);
  assert.ok(rels.some((r) => r.startsWith("content/keys/")));
  assert.ok(rels.some((r) => r.startsWith("content/ocr-models/")));
  // 什么都没有时逐项报出，每项都有“怎么补”
  const all = missingTestPrereqs("/nonexistent", () => false);
  assert.equal(all.length, rels.length);
  for (const m of all) assert.ok(m.fix.length > 0 && m.what.length > 0, m.rel);
});

test("缺产物时脚本很快以 1 退出并写明缺什么；本 worktree 产物齐全时以 0 退出", () => {
  const ok = spawnSync(process.execPath, [SCRIPT], { cwd: PLATFORM, encoding: "utf8", timeout: 60_000 });
  assert.equal(ok.status, 0, ok.stderr);
  // 在空目录里跑同一份脚本（复制到空目录，ROOT 即指向那里）
  const dir = mkdtempSync(join(tmpdir(), "kwl-prereq-"));
  const copy = join(dir, "scripts", "check-test-prereqs.mjs");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, copy);
  const t0 = Date.now();
  const bad = spawnSync(process.execPath, [copy], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  assert.ok(Date.now() - t0 < 60_000);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /content\/ocr-models\/ch_PP-OCRv5_det_mobile\.onnx（OCR 检测模型）：npm run fetch:ocr-models/);
  assert.match(bad.stderr, /content\/lawdb\/dist\/lawdb\.sqlite（随包法规库）：npm run build:lawdb/);
  assert.match(bad.stderr, /npm install/);
});

test("npm test 先跑自检，再用逐文件运行器，单用例时限与 CI 相同", () => {
  const pkg = JSON.parse(readFileSync(join(PLATFORM, "package.json"), "utf8"));
  const t = String(pkg.scripts.test);
  assert.match(t, /^node scripts\/check-test-prereqs\.mjs && node scripts\/run-tests-watchdog\.mjs /);
  assert.match(t, /--test-timeout-ms=300000/);
  assert.match(t, /--file-timeout-min=\d+/);
  for (const g of ["packages/*/test/*.test.ts", "services/*/test/*.test.ts", "apps/desktop/test/*.test.ts"]) assert.ok(t.includes(g), g);
  assert.match(String(pkg.scripts["test:single-process"]), /--test-timeout=300000/);
});
