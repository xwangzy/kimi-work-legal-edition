/**
 * 第 54 批：内核原始输出的取证通道（KWL_DIAG_KERNEL_LOG）只对测试包开放。
 * Windows 安装包真实联调中，入组批准后按新身份重启内核反复崩溃；本机日志由内核写，内核死了日志里什么都没有，
 * 原有的取证通道只在冒烟形态（KWL_SMOKE）可用。现在测试包（release.json test_build）可由 IT / CI 用环境变量指定位置；
 * 正式包、开发形态、指向数据目录的路径一律不写（错误文本可能含安装路径与用户名）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { loadReleaseConfig } = require("../electron/release-config.cjs");

test("release-config：testBuild 如实反映 test_build（正式包为 false）", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-b54-diag-"));
  const f = (name: string, body: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(body));
    return p;
  };
  assert.equal(loadReleaseConfig(f("t.json", { test_build: true })).testBuild, true);
  assert.equal(loadReleaseConfig(f("p.json", {})).testBuild, false);
  assert.equal(loadReleaseConfig(f("s.json", { test_build: "true" })).testBuild, false, "只认布尔 true");
});

test("主进程：取证文件只在冒烟或测试包 + 绝对路径 + 不在数据目录时启用；dump 与 kernel.fatal 都走它", () => {
  const src = readFileSync(join(import.meta.dirname, "../electron/main.cjs"), "utf8");
  const body = /function kernelDiagFile\(\) \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
  assert.match(body, /if \(smoke\.out\) return `\$\{smoke\.out\}\.kernel\.log`;/);
  assert.match(body, /process\.env\.KWL_DIAG_KERNEL_LOG/);
  assert.match(body, /!path\.isAbsolute\(f\) \|\| !app\.isPackaged/);
  assert.match(body, /rel\.testBuild !== true\) return null/);
  assert.match(body, /insideAppData\(f, \[DATA_DIR, app\.getPath\("userData"\)\]\)\) return null/);
  assert.match(src, /const f = kernelDiagFile\(\);\n\s*if \(!f \|\| kernelOutRing\.length === 0\) return;/);
  assert.match(src, /appendFileSync\(kernelDiagFile\(\), `kernel\.fatal: \$\{msg\.message\}\\n`\)/);
});
