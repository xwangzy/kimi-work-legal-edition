/**
 * Windows：执行域里的 python3 进不了磁盘上已存在的子目录（src/dir-mode.ts；Windows CI run 43465749822，w-legal-tasks 06～08）。
 *
 * 在任何平台上都能复现：把挂载层报出的真实目录权限位改成 Windows 的样子（0o666，没有执行位），python3 经 HOSTFS 进子目录即被拒；
 * 再包上 makeDirsTraversable，python3 读文件与 glob 都恢复。worker 只在 Windows 上包这一层（POSIX 的权限位是实情）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bash, InMemoryFs, MountableFs, OverlayFs } from "just-bash";
import { makeDirsTraversable } from "../src/dir-mode.ts";

type StatFn = (path: string, ...rest: unknown[]) => Promise<Record<string, unknown>>;

/** 模拟 Windows：真实目录（stat 带 dev 的）权限位报成 0o666。 */
function windowsDirModes(fs: { stat: StatFn; lstat: StatFn }): void {
  for (const m of ["stat", "lstat"] as const) {
    const orig = fs[m].bind(fs);
    fs[m] = async (path, ...rest) => {
      const r = await orig(path, ...rest);
      return r.isDirectory === true && r.dev !== undefined && typeof r.mode === "number" ? { ...r, mode: (r.mode & ~0o777) | 0o666 } : r;
    };
  }
}

async function shell(fix: boolean) {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "kwl-dirmode-")));
  mkdirSync(join(real, "materials", "文书"), { recursive: true });
  mkdirSync(join(real, "work"), { recursive: true });
  writeFileSync(join(real, "materials", "文书", "起诉状.txt"), "原告：北京甲科技有限公司\n");
  const ro = new OverlayFs({ root: join(real, "materials"), mountPoint: "/", readOnly: true, allowSymlinks: false });
  const rw = new OverlayFs({ root: join(real, "work"), mountPoint: "/", readOnly: false, allowSymlinks: false });
  for (const o of [ro, rw]) {
    const fs = o as unknown as { stat: StatFn; lstat: StatFn };
    windowsDirModes(fs);
    if (fix) makeDirsTraversable(fs);
  }
  const base = new InMemoryFs();
  await base.mkdir("/tmp", { recursive: true });
  // 挂载点取 Windows 的 shell 形式（/c/…），与产品在 Windows 上一致
  const fs = new MountableFs({ base, mounts: [{ mountPoint: "/c/m/materials", filesystem: ro }, { mountPoint: "/c/m/work", filesystem: rw }] });
  return new Bash({ fs, cwd: "/c/m/work", python: true });
}

const READ = `python3 -c "print(open('/c/m/materials/文书/起诉状.txt', encoding='utf-8').read().strip())" 2>&1 | tail -1`;
const GLOB = `python3 -c "import glob; print(len(glob.glob('/c/m/materials/文书/*.txt')))"`;

test("前置：目录权限位没有执行位时，python3 进不了子目录（Bash 不受影响）——复现 Windows 上的失败", { timeout: 120_000 }, async () => {
  const bash = await shell(false);
  assert.equal((await bash.exec("cat '/c/m/materials/文书/起诉状.txt'")).stdout, "原告：北京甲科技有限公司\n");
  assert.match((await bash.exec(READ)).stdout, /PermissionError/);
  assert.equal((await bash.exec(GLOB)).stdout.trim(), "0");
});

test("makeDirsTraversable：目录补上执行位后，python3 读子目录里的材料与 glob 都恢复；文件的权限位不动", { timeout: 120_000 }, async () => {
  const bash = await shell(true);
  assert.equal((await bash.exec(READ)).stdout, "原告：北京甲科技有限公司\n");
  assert.equal((await bash.exec(GLOB)).stdout.trim(), "1");
  // 只读挂载照旧不能写
  const w = await bash.exec(`python3 -c "open('/c/m/materials/文书/新.txt', 'w').write('x')" 2>&1 | tail -1`);
  assert.match(w.stdout, /Error/);
  const file = { isDirectory: false, isFile: true, mode: 0o100444 };
  const fs = { stat: async () => file, lstat: async () => file } as unknown as { stat: StatFn; lstat: StatFn };
  makeDirsTraversable(fs);
  assert.equal((await fs.stat("/x")).mode, 0o100444);
});
