/**
 * Windows 子进程启动面（Kimi Code 增量核查 WR-2，2026-10-14）：产品源码里每一处 child_process 的 fork/spawn 都必须带 windowsHide
 * （直接写或经 child-env.ts 的 HIDE_WINDOW）——从无控制台的桌面进程拉起随包 node.exe 时，缺这一项 Windows 会为每个子进程弹出黑色控制台窗口。
 * 扫描全部引入 child_process 的产品源码（含 exec/execFile 系列），新增一处不带的调用即失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
/**
 * 引入 child_process 的产品源码：按目录扫描（复核 B4-A15：写死清单时新文件引入 child_process 不会被扫到）——
 * packages/*\/src、services/*\/src 下的 .ts，以及 apps/desktop/electron 下的 .cjs（不含构建产物 *.bundle.*）。
 */
function productSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(root + dir)) {
      const rel = `${dir}/${name}`;
      const st = statSync(root + rel);
      if (st.isDirectory()) {
        if (name !== "node_modules" && name !== "vendor") walk(rel);
      } else if (/\.(ts|cjs|mjs)$/.test(name) && !/\.bundle\./.test(name) && !/\.d\.ts$/.test(name)) out.push(rel);
    }
  };
  for (const top of ["packages", "services"]) {
    for (const pkg of readdirSync(root + top)) {
      try {
        if (statSync(`${root}${top}/${pkg}/src`).isDirectory()) walk(`${top}/${pkg}/src`);
      } catch {
        // 没有 src 的包
      }
    }
  }
  for (const name of readdirSync(root + "apps/desktop/electron")) if (/\.cjs$/.test(name) && !/\.bundle\./.test(name)) out.push(`apps/desktop/electron/${name}`);
  return out.filter((f) => /["']node:child_process["']|["']child_process["']/.test(readFileSync(root + f, "utf8")));
}
const FILES = productSources();

test("WR-2 子进程不弹控制台窗口：产品源码中每一处 fork/spawn 调用都带 windowsHide（或 HIDE_WINDOW）", () => {
  const missing: string[] = [];
  let calls = 0;
  for (const f of FILES) {
    const src = readFileSync(root + f, "utf8");
    for (const m of src.matchAll(/(?<![.\w])(fork|spawn|spawnSync|execFile|execFileSync|exec|execSync)\(/g)) {
      // 方法定义（private async spawn(): …）不是调用
      if (/(async|function|private|public)\s+$/.test(src.slice(Math.max(0, m.index! - 20), m.index!))) continue;
      // 取到调用的右括号为止（粗略按括号配平；不跨越下一个函数定义）
      let depth = 0;
      let end = m.index! + m[0].length - 1;
      for (; end < src.length; end++) {
        if (src[end] === "(") depth++;
        else if (src[end] === ")" && --depth === 0) break;
      }
      const call = src.slice(m.index!, end + 1);
      calls++;
      if (!/windowsHide|HIDE_WINDOW/.test(call)) missing.push(`${f}: ${call.slice(0, 80).replace(/\s+/g, " ")}…`);
    }
  }
  assert.ok(calls >= 5, `应找到至少 5 处启动调用（实际 ${calls}）`);
  assert.deepEqual(missing, [], `以下调用缺 windowsHide：\n${missing.join("\n")}`);
  // 扫描面覆盖已知的启动点（防止扫描本身失效）
  for (const f of ["packages/exec-wasm/src/host.ts", "packages/kernel/src/egress/gate-host.ts", "packages/kernel/src/executor/kap-agent-client.ts", "packages/parse-ocr/src/worker-client.ts", "apps/desktop/electron/main.cjs"]) assert.ok(FILES.includes(f), `扫描应覆盖 ${f}`);
});
