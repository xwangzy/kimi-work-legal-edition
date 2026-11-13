/**
 * 主密钥解封失败时把打不开的数据移到一边（v9.3 主文 §9 第 7 项，复核 R2B-10）：只改名不删除；主密钥文件最后移；
 * 中途失败时主密钥文件还在，再来一次移剩下的。内核与激活页一侧见 packages/kernel/test/onboarding-legacy.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAsideAutoOpen, setAsideNotice } from "../src/lib/activate-text.ts";

const require = createRequire(import.meta.url);
const { quarantineUnreadable, listSetAside } = require("../electron/unreadable-data.cjs") as {
  quarantineUnreadable: (o: { dataDir: string; keyFile: string; now?: number }) => { ok: boolean; dir?: string; code?: string; moved: string[] };
  listSetAside: (dataDir: string) => string[];
};

function layout() {
  const root = mkdtempSync(join(tmpdir(), "kwl-unreadable-"));
  const dataDir = join(root, "KimiWorkLegal");
  const userData = join(dataDir, ".electron");
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, "ledger-key"), "SEALED:旧主密钥");
  writeFileSync(join(userData, "ledger-key.prev-1"), "SEALED:更早的主密钥");
  writeFileSync(join(dataDir, "activation.json"), "{}");
  writeFileSync(join(dataDir, "onboarding-failed.json"), "{}");
  writeFileSync(join(dataDir, "onboarding.json"), "{}");
  // 只有入组暂存密钥、没有账本的成员工作区（按旧主密钥封装，复核 RB16A-14）
  mkdirSync(join(dataDir, "member-firm", "keys"), { recursive: true });
  writeFileSync(join(dataDir, "member-firm", "keys", "join-pending.json"), "{}");
  for (const ws of ["sa-firm", "demo-firm"]) {
    mkdirSync(join(dataDir, ws, "keys"), { recursive: true });
    writeFileSync(join(dataDir, ws, "ledger.db"), "密文");
  }
  mkdirSync(join(dataDir, "not-a-workspace"));
  return { dataDir, keyFile: join(userData, "ledger-key") };
}

test("移到一边：激活记录、入组记录、每个有账本的工作区、主密钥文件改名到 .unreadable-<时刻>/；其余不动；写一份说明", () => {
  const { dataDir, keyFile } = layout();
  const now = Date.parse("2026-10-21T08:30:05.123Z");
  const r = quarantineUnreadable({ dataDir, keyFile, now });
  assert.equal(r.ok, true);
  assert.equal(r.dir, join(dataDir, ".unreadable-2026-10-21T08-30-05Z"), "文件名里没有冒号（Windows）");
  assert.deepEqual(r.moved.slice().sort(), ["activation.json", "demo-firm", "ledger-key", "member-firm", "onboarding-failed.json", "onboarding.json", "sa-firm"].sort());
  assert.equal(r.moved.at(-1), "ledger-key", "主密钥文件最后移");
  for (const gone of ["activation.json", "onboarding-failed.json", "sa-firm", "demo-firm"]) assert.equal(existsSync(join(dataDir, gone)), false, gone);
  assert.equal(existsSync(keyFile), false, "主密钥文件移走：下次启动生成新的");
  assert.equal(readFileSync(join(r.dir!, "sa-firm", "ledger.db"), "utf8"), "密文", "内容原样、没有删除");
  assert.ok(existsSync(join(dataDir, "not-a-workspace")), "没有账本的目录不动");
  assert.ok(existsSync(join(dataDir, ".electron", "ledger-key.prev-1")), "以前留档的包裹文件不动");
  assert.match(readFileSync(join(r.dir!, "说明.txt"), "utf8"), /没有删除[\s\S]*激活记录[\s\S]*是明文[\s\S]*所内 IT/);
  assert.deepEqual(listSetAside(dataDir), [".unreadable-2026-10-21T08-30-05Z"]);
  // 同一秒再来一次：目录已存在即停，不往已有目录里混
  const again = quarantineUnreadable({ dataDir, keyFile, now });
  assert.equal(again.ok, false);
  assert.equal(again.code, "exists");
});

test("中途失败：已移的留在新目录，主密钥文件还在（下次启动仍走同一对话框）；修好后再来一次移剩下的", (t) => {
  const { dataDir, keyFile } = layout();
  // 让 sa-firm 这一次改名失败。原先用 chmod 0o555 去掉写权限，只在 POSIX 上有效（root 还得跳过）：Windows 上 chmod 挡不住目录改名，
  // 目录照样被移走（CI run 43435998778）。改为在改名这一步注入失败，各平台一致
  const saFirm = join(dataDir, "sa-firm");
  const realRename = fs.renameSync;
  const rename = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === saFirm) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${saFirm}'`), { code: "EPERM" });
    return realRename(from, to);
  });
  try {
    const r = quarantineUnreadable({ dataDir, keyFile, now: Date.parse("2026-10-21T09:00:00Z") });
    assert.ok(rename.mock.calls.some((c) => String(c.arguments[0]) === saFirm), "注入的失败确实发生在 sa-firm 的改名上");
    assert.equal(r.ok, false);
    assert.equal(r.code, "move_failed");
    assert.ok(r.moved.includes("activation.json"), "记录文件先移");
    assert.ok(!r.moved.includes("sa-firm"));
    assert.ok(!r.moved.includes("ledger-key"));
    assert.ok(existsSync(saFirm), "改名失败的工作区还在原处");
    assert.ok(existsSync(keyFile), "主密钥文件没动：不会出现“新主密钥 + 旧工作区”");
  } finally {
    rename.mock.restore();
  }
  const r2 = quarantineUnreadable({ dataDir, keyFile, now: Date.parse("2026-10-21T09:00:01Z") });
  assert.equal(r2.ok, true);
  assert.ok(r2.moved.includes("sa-firm") && r2.moved.at(-1) === "ledger-key");
  assert.equal(listSetAside(dataDir).length, 2, "两次移动各一个目录，新的在前");
  assert.equal(listSetAside(dataDir)[0], ".unreadable-2026-10-21T09-00-01Z");
  assert.deepEqual(readdirSync(dataDir).filter((n) => !n.startsWith(".")), ["not-a-workspace"]);
});

test("激活页的说明：说清原来的数据在哪、没有删除、下一步做什么（不出现工程用语）", () => {
  const t = setAsideNotice(".unreadable-2026-10-21T08-30-05Z");
  assert.match(t, /\.unreadable-2026-10-21T08-30-05Z/);
  assert.match(t, /没有删除/);
  assert.match(t, /恢复包/);
  assert.doesNotMatch(t, /DPAPI|密钥|主密钥|ledger/);
});

test("激活页只在刚移走（24 小时内）且没点过“返回”时自动打开从备份恢复；唯一管理员的指引（复核 RB16B-20/21）", () => {
  const dir = ".unreadable-2026-10-21T08-30-05Z";
  const t = Date.parse("2026-10-21T08:30:05Z");
  assert.equal(setAsideAutoOpen(dir, t + 3600_000, null), true);
  assert.equal(setAsideAutoOpen(dir, t + 25 * 3600_000, null), false, "超过 24 小时不再自动打开");
  assert.equal(setAsideAutoOpen(dir, t + 3600_000, dir), false, "点过返回的不再自动打开");
  assert.equal(setAsideAutoOpen(".unreadable-bad", t, null), false);
  assert.match(setAsideNotice(dir), /唯一的管理员/);
});
