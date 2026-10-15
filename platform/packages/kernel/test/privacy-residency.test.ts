/**
 * 数据驻留面清单门禁（v9.2 §3.2 / R1；调研 Y5 §1.4、P1-3）：
 * 1. 机读清单 docs/privacy/residency.json 每行字段齐全；强制点（文件 + 符号）存在；所列测试文件存在；
 * 2. 写盘面：生产源码里经 node:fs 调用写盘接口（写入、追加、改名、复制、链接、截断、以写方式打开、建临时目录）的文件与接口，
 *    必须与清单 write_points 逐一相符——新增一处未登记的写盘点即失败，删掉一处也要同步清单；
 * 3. 渲染进程浏览器存储只用登记的键（localStorage），不用 sessionStorage / indexedDB / cookie / Cache Storage。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_ROOT, fsWriteCalls, productionSources, stripComments } from "../../../scripts/lib/source-scan.mjs";

interface Row {
  id: number;
  data: string;
  memory: string;
  disk: string;
  local_channels: string;
  network: string;
  logs_dumps: string;
  form: string[];
  enforcement: { file: string; symbol: string }[];
  enforcement_note?: string;
  tests: string[];
  residual: string;
  owner: string;
}
interface Residency {
  format: string;
  forms: Record<string, string>;
  rows: Row[];
  write_points: Record<string, { apis: string[]; rows: number[]; reason: string }>;
  renderer_storage: { apis: string[]; keys: Record<string, string>; files: string[] };
  out_of_scope: Record<string, string>;
}

const residency = JSON.parse(readFileSync(join(PLATFORM_ROOT, "docs/privacy/residency.json"), "utf8")) as Residency;
const read = (rel: string) => readFileSync(join(PLATFORM_ROOT, rel), "utf8");

test("驻留面清单：每行字段齐全、形态已定义、强制点符号存在、测试文件存在", () => {
  assert.equal(residency.format, "kwl-residency/1");
  const ids = residency.rows.map((r) => r.id);
  assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b), "编号唯一且有序");
  assert.ok(residency.rows.length >= 20, "至少覆盖 Y5 主表的 20 类数据");
  const problems: string[] = [];
  for (const r of residency.rows) {
    for (const k of ["data", "memory", "disk", "local_channels", "network", "logs_dumps", "residual", "owner"] as const) {
      if (typeof r[k] !== "string" || !r[k].trim()) problems.push(`#${r.id} 缺 ${k}`);
    }
    if (!Array.isArray(r.form) || r.form.length === 0) problems.push(`#${r.id} 缺 form`);
    for (const f of r.form ?? []) if (!(f in residency.forms)) problems.push(`#${r.id} 形态 ${f} 未定义`);
    if (r.enforcement.length === 0 && !r.enforcement_note) problems.push(`#${r.id} 没有强制点也没有说明`);
    for (const e of r.enforcement) {
      if (!existsSync(join(PLATFORM_ROOT, e.file))) {
        problems.push(`#${r.id} 强制点文件不存在：${e.file}`);
        continue;
      }
      const src = stripComments(read(e.file));
      if (!new RegExp(`\\b${e.symbol}\\b`).test(src)) problems.push(`#${r.id} 强制点 ${e.file} 中没有 ${e.symbol}`);
    }
    for (const t of r.tests) {
      if (!existsSync(join(PLATFORM_ROOT, t))) problems.push(`#${r.id} 测试文件不存在：${t}`);
      else if (!/\btest\(/.test(read(t))) problems.push(`#${r.id} 测试文件没有用例：${t}`);
    }
    if (r.enforcement.length > 0 && r.tests.length === 0) problems.push(`#${r.id} 有强制点但没有测试`);
  }
  assert.deepEqual(problems, [], problems.join("；"));
});

test("写盘面：生产源码的写盘点与清单 write_points 逐一相符（新增未登记的写盘点即失败）", () => {
  const scanned = new Map<string, string[]>();
  for (const f of productionSources({ outOfScope: Object.keys(residency.out_of_scope) })) {
    const apis = fsWriteCalls(f.text);
    if (apis.length) scanned.set(f.rel, apis);
  }
  const problems: string[] = [];
  for (const [rel, apis] of scanned) {
    const wp = residency.write_points[rel];
    if (!wp) problems.push(`未登记的写盘点：${rel}（${apis.join("、")}）`);
    else if (JSON.stringify([...wp.apis].sort()) !== JSON.stringify(apis)) problems.push(`${rel} 的写盘接口变了：清单 ${wp.apis.join("、")}，源码 ${apis.join("、")}`);
  }
  for (const rel of Object.keys(residency.write_points)) if (!scanned.has(rel)) problems.push(`清单里的写盘点已不存在（请同步清单）：${rel}`);
  const ids = new Set(residency.rows.map((r) => r.id));
  for (const [rel, wp] of Object.entries(residency.write_points)) {
    if (!wp.reason?.trim()) problems.push(`${rel} 缺 reason`);
    for (const id of wp.rows) if (!ids.has(id)) problems.push(`${rel} 指向不存在的数据类 #${id}`);
  }
  assert.deepEqual(problems, [], problems.join("；"));
});

test("渲染存储：只用 localStorage 的登记键，且只在登记的文件；不用 sessionStorage / indexedDB / cookie / Cache Storage", () => {
  const renderer = productionSources().filter((f) => f.rel.startsWith("apps/desktop/src/"));
  assert.ok(renderer.length > 10);
  const problems: string[] = [];
  const users: string[] = [];
  for (const f of renderer) {
    if (/\b(?:sessionStorage|indexedDB|document\s*\.\s*cookie|caches\s*\.)/.test(f.text)) problems.push(`${f.rel} 使用了未登记的浏览器存储`);
    if (!/\blocalStorage\b/.test(f.text)) continue;
    users.push(f.rel);
    // 键只能是登记的字面量（经常量或直接写），不能拼接
    for (const m of f.text.matchAll(/localStorage\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*([^,)]+)/g)) {
      const arg = m[1]!.trim();
      const literal = /^["']([^"']+)["']$/.exec(arg)?.[1];
      const viaConst = /^[A-Za-z_$][\w$]*$/.test(arg) ? new RegExp(`\\b${arg}\\s*=\\s*["']([^"']+)["']`).exec(f.text)?.[1] : undefined;
      const keyParam = /^key$/.test(arg); // 通用读写函数：调用处另行核对
      if (keyParam) continue;
      const key = literal ?? viaConst;
      if (!key) problems.push(`${f.rel}：键不是登记的字面量（${arg}）`);
      else if (!(key in residency.renderer_storage.keys)) problems.push(`${f.rel}：未登记的键 ${key}`);
    }
    for (const m of f.text.matchAll(/(?<!function\s+)\b(?:remembered|remember)\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
      const key = new RegExp(`\\b${m[1]}\\s*=\\s*["']([^"']+)["']`).exec(f.text)?.[1];
      if (!key || !(key in residency.renderer_storage.keys)) problems.push(`${f.rel}：通用读写函数用了未登记的键（${m[1]}）`);
    }
  }
  assert.deepEqual(users.sort(), [...residency.renderer_storage.files].sort(), "使用 localStorage 的文件与清单相符");
  assert.deepEqual(problems, [], problems.join("；"));
});

test("写盘面扫描自身：能识别具名导入、命名空间、require 与解构；同名变量与只读打开不算", () => {
  assert.deepEqual(fsWriteCalls(stripComments(`import { writeFileSync as w } from "node:fs"; w("a", "b");`)), ["writeFileSync"]);
  assert.deepEqual(fsWriteCalls(stripComments(`import * as fs from "node:fs/promises"; await fs.appendFile("a", "b");`)), ["appendFile"]);
  assert.deepEqual(fsWriteCalls(stripComments(`const fs = require("node:fs"); fs.renameSync(a, b);`)), ["renameSync"]);
  assert.deepEqual(fsWriteCalls(stripComments(`const { copyFileSync } = require("fs"); copyFileSync(a, b);`)), ["copyFileSync"]);
  assert.deepEqual(fsWriteCalls(stripComments(`require("node:fs").promises.writeFile(a, b);`)), ["writeFile"]);
  assert.deepEqual(fsWriteCalls(stripComments(`import { promises as fsp } from "node:fs"; await fsp.cp(a, b);`)), ["cp"]);
  assert.deepEqual(fsWriteCalls(stripComments(`const cp = fork(x); cp.send(1); codec.open(b);`)), []);
  assert.deepEqual(fsWriteCalls(stripComments(`import { openSync } from "node:fs"; openSync(f, "r");`)), []);
  assert.deepEqual(fsWriteCalls(stripComments(`import { openSync } from "node:fs"; openSync(f, "w");`)), ["openSync"]);
  assert.deepEqual(fsWriteCalls(stripComments(`// fs.writeFileSync(a) 只是注释\nimport * as fs from "node:fs";`)), []);
});
