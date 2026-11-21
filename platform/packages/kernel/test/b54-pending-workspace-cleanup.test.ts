/**
 * 第 54 批（Windows 安装包连 116 演示云端真实联调）：入组批准后按新身份重启内核，内核启动时删除待激活占位工作区。
 * 原来是裸 rmSync：Windows 上占位区里有文件仍被占用（刚关闭的账本被杀毒软件扫描、残留句柄等）就抛 EBUSY / EPERM，
 * 内核每次启动都在这里失败——界面“后台服务多次异常退出，已停止自动重启”，控制面上这台电脑始终没有登记。
 * 现在清理失败不挡启动：短暂重试，仍删不掉记 KERNEL_PENDING_WORKSPACE_LEFT，下次启动再删。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING_WORKSPACE_SLUG } from "../src/config.ts";
import { removePendingWorkspace } from "../src/services/onboarding.ts";

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "kwl-b54-pending-"));
  mkdirSync(join(r, PENDING_WORKSPACE_SLUG, "logs"), { recursive: true });
  writeFileSync(join(r, PENDING_WORKSPACE_SLUG, "ledger.db"), "x");
  writeFileSync(join(r, PENDING_WORKSPACE_SLUG, "logs", "kwl-20261121.jsonl"), "{}\n");
  return r;
}

test("能删时删干净，返回 true；重试参数交给 rmSync", () => {
  const r = root();
  let opts: Record<string, unknown> | null = null;
  const ok = removePendingWorkspace(r, ((p: string, o: Record<string, unknown>) => {
    opts = o;
    rmSync(p, o);
  }) as typeof rmSync);
  assert.equal(ok, true);
  assert.equal(existsSync(join(r, PENDING_WORKSPACE_SLUG)), false);
  assert.deepEqual(opts, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("Windows 上文件被占用（EBUSY / EPERM / 其他）：不抛错、返回 false，占位区留到下次启动", () => {
  for (const code of ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]) {
    const r = root();
    const ok = removePendingWorkspace(r, (() => {
      throw Object.assign(new Error(`${code}: resource busy or locked`), { code });
    }) as typeof rmSync);
    assert.equal(ok, false, code);
    assert.equal(existsSync(join(r, PENDING_WORKSPACE_SLUG)), true);
  }
});

test("没有占位区：照常返回 true（force）", () => {
  const r = mkdtempSync(join(tmpdir(), "kwl-b54-pending-none-"));
  assert.equal(removePendingWorkspace(r), true);
});
