/**
 * 第 54 批（Windows 安装包连 116 演示云端真实联调）：入组批准后按新身份重启内核，内核启动时删除待激活占位工作区。
 * 原来是裸 rmSync：Windows 上占位区里有文件仍被占用就抛 EBUSY / EPERM，内核每次启动都在这里失败。
 * 第 72 批（Windows 实机运行 45955267514）：第 54 批的“短暂重试”是同步的，占位区删不掉时每次打开应用都在启动路径上白等约 4.2 秒。
 * 现在启动路径上只改名挪开（一次、不重试），删除在后台异步做；删不掉记 KERNEL_PENDING_WORKSPACE_LEFT（带步骤与文件类别），不挡启动。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING_WORKSPACE_SLUG } from "../src/config.ts";
import { PENDING_TRASH_PREFIX, removePendingWorkspace, sweepPendingTrash, type PendingCleanupOps } from "../src/services/onboarding.ts";

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "kwl-b54-pending-"));
  mkdirSync(join(r, PENDING_WORKSPACE_SLUG, "logs"), { recursive: true });
  writeFileSync(join(r, PENDING_WORKSPACE_SLUG, "ledger.db"), "x");
  writeFileSync(join(r, PENDING_WORKSPACE_SLUG, "logs", "kwl-20261121.jsonl"), "{}\n");
  return r;
}
const real: PendingCleanupOps = { rename: renameSync, rm: (p, o) => rm(p, o), list: (d) => readdirSync(d) };
const trashOf = (r: string) => readdirSync(r).filter((n) => n.startsWith(PENDING_TRASH_PREFIX));

test("能删时：启动路径上只改名挪开（同步返回 true），后台随后删干净", async () => {
  const r = root();
  let rmOpts: unknown = null;
  const ok = removePendingWorkspace(r, { ...real, rm: (p, o) => ((rmOpts = o), rm(p, o)) });
  assert.equal(ok, true);
  assert.equal(existsSync(join(r, PENDING_WORKSPACE_SLUG)), false, "占位区已挪走");
  await sweepPendingTrash(r, real);
  assert.deepEqual(trashOf(r), [], "待删目录已删");
  assert.deepEqual(rmOpts, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("启动路径不等删除：删除很慢（或一直失败）时 removePendingWorkspace 立即返回", async () => {
  const r = root();
  let release!: () => void;
  const slow = new Promise<void>((res) => (release = res));
  const t0 = Date.now();
  const ok = removePendingWorkspace(r, { ...real, rm: async () => { await slow; throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } });
  assert.equal(ok, true);
  assert.ok(Date.now() - t0 < 200, "同步部分只做改名");
  release();
  // 后台删不掉：待删目录留着，下次启动再删（不抛错）
  assert.equal(await sweepPendingTrash(r, { ...real, rm: async () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } }), 1);
  assert.equal(trashOf(r).length, 1);
  assert.equal(await sweepPendingTrash(r, real), 0);
  assert.deepEqual(trashOf(r), []);
});

test("Windows 上占位区被占用、连改名都不行（EBUSY / EPERM / EACCES / 其他）：不抛错、返回 false，占位区原地留着", () => {
  for (const code of ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]) {
    const r = root();
    const ok = removePendingWorkspace(r, { ...real, rename: () => { throw Object.assign(new Error(`${code}: resource busy or locked`), { code }); } });
    assert.equal(ok, false, code);
    assert.equal(existsSync(join(r, PENDING_WORKSPACE_SLUG)), true);
  }
});

test("后台删除期间又开始新的待激活：新占位区不会被误删（名字不同）", async () => {
  const r = root();
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  removePendingWorkspace(r, { ...real, rm: async (p, o) => { await gate; await rm(p, o); } });
  mkdirSync(join(r, PENDING_WORKSPACE_SLUG, "logs"), { recursive: true });
  writeFileSync(join(r, PENDING_WORKSPACE_SLUG, "ledger.db"), "new");
  release();
  await sweepPendingTrash(r, real);
  assert.equal(existsSync(join(r, PENDING_WORKSPACE_SLUG, "ledger.db")), true, "新的占位区还在");
});

test("没有占位区：照常返回 true", () => {
  const r = mkdtempSync(join(tmpdir(), "kwl-b54-pending-none-"));
  assert.equal(removePendingWorkspace(r, real), true);
});
