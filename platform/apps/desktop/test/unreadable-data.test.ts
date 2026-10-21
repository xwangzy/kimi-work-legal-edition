/**
 * 主密钥解封失败时把打不开的数据移到一边（v9.3 主文 §9 第 7 项，复核 R2B-10）：只改名不删除；主密钥文件最后移；
 * 中途失败时主密钥文件还在，再来一次移剩下的。内核与激活页一侧见 packages/kernel/test/onboarding-legacy.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAsideNotice } from "../src/lib/activate-text.ts";

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

test("中途失败：已移的留在新目录，主密钥文件还在（下次启动仍走同一对话框）；修好后再来一次移剩下的", { skip: process.getuid?.() === 0 ? "root 不受目录权限限制" : false }, () => {
  const { dataDir, keyFile } = layout();
  // 目录改名到另一个父目录要改它的“..”：去掉写权限即改名失败
  chmodSync(join(dataDir, "sa-firm"), 0o555);
  try {
    const r = quarantineUnreadable({ dataDir, keyFile, now: Date.parse("2026-10-21T09:00:00Z") });
    assert.equal(r.ok, false);
    assert.equal(r.code, "move_failed");
    assert.ok(r.moved.includes("activation.json"), "记录文件先移");
    assert.ok(!r.moved.includes("ledger-key"));
    assert.ok(existsSync(keyFile), "主密钥文件没动：不会出现“新主密钥 + 旧工作区”");
  } finally {
    chmodSync(join(dataDir, "sa-firm"), 0o755);
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
