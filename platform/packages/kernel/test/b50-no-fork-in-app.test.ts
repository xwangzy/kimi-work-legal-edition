/**
 * 安装包里不许用 child_process.fork（偏离 D-215，第 50 批 DMG 走查）：安装包关闭了 Electron 的 runAsNode 熔断，Electron 44 在应用内一律拒绝
 * child_process.fork()——出站闸门、Agent 宿主、W 执行域、隔离解析进程曾因此在安装包里全部拉不起来、模型调用一律失败，而开发形态（熔断未关）
 * 一直正常，没有用例暴露。随包子进程一律经 spawnNodeChild（spawn + stdio 'ipc'）拉起。
 *
 * 扫描范围同 child-process-surface：packages/*\/src、apps/desktop/electron 下的产品源码（不含构建产物）；utilityProcess.fork 是主进程 API，不受限。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnNodeChild } from "../src/executor/child-env.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function productSources(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(root + rel)) {
      const r = `${rel}/${name}`;
      if (statSync(root + r).isDirectory()) {
        if (name !== "node_modules" && name !== "vendor") walk(r);
      } else if (/\.(ts|cjs|mjs)$/.test(name) && !/\.bundle\./.test(name) && !/\.d\.ts$/.test(name)) out.push(r);
    }
  };
  for (const top of ["packages", "services"].filter((t) => existsSync(root + t))) {
    for (const pkg of readdirSync(root + top)) if (existsSync(`${root}${top}/${pkg}/src`)) walk(`${top}/${pkg}/src`);
  }
  for (const name of readdirSync(root + "apps/desktop/electron")) if (/\.cjs$/.test(name) && !/\.bundle\./.test(name)) out.push(`apps/desktop/electron/${name}`);
  return out;
}

test("产品源码不调用 child_process.fork（安装包里会被 Electron 拒绝）", () => {
  const hits: string[] = [];
  for (const f of productSources()) {
    const src = readFileSync(root + f, "utf8");
    if (!/["'](?:node:)?child_process["']/.test(src)) continue;
    // 只看代码：去掉行注释与块注释（注释里讲到 fork 不算）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    if (/(?<![.\w])fork\s*\(/.test(code) || /\{[^}]*\bfork\b[^}]*\}\s*from\s*["'](?:node:)?child_process["']/.test(code)) hits.push(f);
  }
  assert.deepEqual(hits, [], `这些文件仍用 child_process.fork：${hits.join("、")}`);
});

test("spawnNodeChild 与 fork 等价：IPC 往返、退出码", async () => {
  const child = spawnNodeChild("-e", [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH ?? "" } });
  // 入口用 -e 时脚本作为下一个参数：这里直接改走带脚本的调用
  child.kill();
  const c2 = spawnNodeChild("--input-type=module", ["-e", "process.on('message', (m) => { process.send({ echo: m }); process.exit(7); });"], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { PATH: process.env.PATH ?? "" },
  });
  const got = await new Promise<{ msg: unknown; code: number | null }>((resolve) => {
    let msg: unknown = null;
    c2.on("message", (m) => (msg = m));
    c2.on("exit", (code) => resolve({ msg, code }));
    c2.send({ hi: 1 });
  });
  assert.deepEqual(got.msg, { echo: { hi: 1 } });
  assert.equal(got.code, 7);
});

test("spawnNodeChild 没带 IPC 通道即拒绝（防止误用成无控制通道的子进程）", () => {
  assert.throws(() => spawnNodeChild("x.mjs", [], { stdio: ["ignore", "ignore", "pipe"] }), /IPC/);
});
