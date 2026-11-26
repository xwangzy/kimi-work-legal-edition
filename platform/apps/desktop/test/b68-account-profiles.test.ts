/**
 * 第 68 批（V42，D-294/D-295）：同一台电脑多个账号——主进程侧的密钥格、解封失败只移当前档案、切换账号的界面辅助函数与文案。
 * 内核与云端的端到端见 packages/kernel/test/b68-account-switch.test.ts、services/control-plane/test/b66-personal-devices.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSwitchResult, profileMark } from "../src/lib/account-switch.ts";
import { scopedKey, setProfileScope } from "../src/lib/profile-scope.ts";
import { reloginView, switchingText } from "../src/lib/account.ts";

const require = createRequire(import.meta.url);
const { planKeySlot, quarantineScope, validHandoffShape } = require("../electron/key-slots.cjs") as {
  planKeySlot: (o: { dataDir: string; userDataDir: string; now?: number }) => { kind: string; slot: string; file: string; workspace: string | null; adopted: boolean; freshPending: boolean };
  quarantineScope: (plan: { kind: string; workspace: string | null }, dataDir: string) => string[] | null;
  validHandoffShape: (h: unknown) => boolean;
};
const { quarantineUnreadable } = require("../electron/unreadable-data.cjs") as {
  quarantineUnreadable: (o: { dataDir: string; keyFile: string; now?: number; only?: string[] | null }) => { ok: boolean; moved: string[] };
};

const act = (o: Record<string, unknown> = {}) => ({ v: 1, tid: "ten_firma", firm_slug: "firma", firm_name: "甲所", member_slug: "zhang", member_name: "张", role: "lawyer", kind: "member", activated_at: "2026-11-26T00:00:00Z", ...o });
function roots() {
  const dataDir = mkdtempSync(join(tmpdir(), "kwl-b68-data-"));
  const userDataDir = mkdtempSync(join(tmpdir(), "kwl-b68-ud-"));
  return { dataDir, userDataDir };
}
const ws = (dataDir: string, name: string, o: { ledger?: boolean; profile?: Record<string, unknown> } = {}) => {
  mkdirSync(join(dataDir, name), { recursive: true });
  if (o.ledger) writeFileSync(join(dataDir, name, "ledger.db"), "x");
  if (o.profile) writeFileSync(join(dataDir, name, "profile.json"), JSON.stringify(o.profile));
};

test("密钥格：第一个档案与升级前沿用 ledger-key；已有别的档案时待激活另起 ledger-key.pending；新档案激活后把它改名归自己", () => {
  const { dataDir, userDataDir } = roots();
  // 全新：待激活用 legacy
  assert.deepEqual(planKeySlot({ dataDir, userDataDir }).kind, "legacy");
  // 升级前的单档案：激活记录没有 key_slot → legacy
  writeFileSync(join(dataDir, "activation.json"), JSON.stringify(act()));
  ws(dataDir, "firma", { ledger: true });
  const p0 = planKeySlot({ dataDir, userDataDir });
  assert.deepEqual([p0.kind, p0.slot, p0.file.endsWith("ledger-key"), p0.workspace], ["legacy", "legacy", true, "firma"]);
  // 换账号登记新设备：激活记录移走 → 有别的工作区 → pending（新起的一把）
  const { rmSync } = require("node:fs") as typeof import("node:fs");
  rmSync(join(dataDir, "activation.json"));
  const p1 = planKeySlot({ dataDir, userDataDir });
  assert.deepEqual([p1.kind, p1.freshPending], ["pending", true]);
  writeFileSync(join(userDataDir, "ledger-key.pending"), "sealed-pending");
  assert.equal(planKeySlot({ dataDir, userDataDir }).freshPending, false);
  // 新档案开通：激活记录带 key_slot = 目录名 → 待激活那把改名归它
  writeFileSync(join(dataDir, "activation.json"), JSON.stringify(act({ tid: "ten_firmb", firm_slug: "firmb", key_slot: "firmb" })));
  const p2 = planKeySlot({ dataDir, userDataDir });
  assert.deepEqual([p2.kind, p2.slot, p2.adopted], ["profile", "p:firmb", true]);
  assert.equal(readFileSync(join(userDataDir, "ledger-key.p.firmb"), "utf8"), "sealed-pending");
  assert.ok(!existsSync(join(userDataDir, "ledger-key.pending")));
  // 已有账本的档案：自己的密钥在就用自己的，别的待激活尝试留下的 pending 不动
  ws(dataDir, "firmb", { ledger: true });
  writeFileSync(join(userDataDir, "ledger-key.pending"), "other-attempt");
  const p3 = planKeySlot({ dataDir, userDataDir });
  assert.deepEqual([p3.slot, p3.adopted], ["p:firmb", false]);
  assert.equal(readFileSync(join(userDataDir, "ledger-key.p.firmb"), "utf8"), "sealed-pending");
  // 同名残留密钥、工作区还没有账本（从未按这个档案启动过）→ 归 pending，残留留档
  writeFileSync(join(dataDir, "activation.json"), JSON.stringify(act({ tid: "ten_firmc", firm_slug: "firmc", key_slot: "firmc" })));
  writeFileSync(join(userDataDir, "ledger-key.p.firmc"), "stale");
  const p4 = planKeySlot({ dataDir, userDataDir, now: Date.parse("2026-11-26T01:02:03Z") });
  assert.deepEqual([p4.slot, p4.adopted], ["p:firmc", true]);
  assert.equal(readFileSync(join(userDataDir, "ledger-key.p.firmc"), "utf8"), "other-attempt");
  assert.ok(existsSync(join(userDataDir, "ledger-key.p.firmc.stale-2026-11-26T01-02-03-000Z")));
  // 不合规的激活记录按“没有”处理（与内核一致）
  writeFileSync(join(dataDir, "activation.json"), JSON.stringify(act({ workspace: "../evil" })));
  assert.equal(planKeySlot({ dataDir, userDataDir }).kind, "pending");
});

test("安全复核 K-1：律所标识恰好叫 legacy / pending 时，档案的密钥文件不与两把保留的重名", () => {
  const { dataDir, userDataDir } = roots();
  ws(dataDir, "firma", { ledger: true, profile: act() });
  writeFileSync(join(userDataDir, "ledger-key"), "A-key");
  for (const name of ["legacy", "pending"]) {
    writeFileSync(join(userDataDir, "ledger-key.pending"), `pending-for-${name}`);
    writeFileSync(join(dataDir, "activation.json"), JSON.stringify(act({ tid: `ten_${name}`, firm_slug: name, key_slot: name })));
    const p = planKeySlot({ dataDir, userDataDir });
    assert.deepEqual([p.kind, p.slot, p.adopted], ["profile", `p:${name}`, true], name);
    assert.ok(p.file.endsWith(`ledger-key.p.${name}`), p.file);
    assert.equal(readFileSync(p.file, "utf8"), `pending-for-${name}`);
    assert.equal(readFileSync(join(userDataDir, "ledger-key"), "utf8"), "A-key", "第一个档案的密钥不被交出去");
    ws(dataDir, name, { ledger: true });
  }
});

test("解封失败只移当前档案：别的账号的工作区不动；没有别的档案时与以前相同（全部移走）", () => {
  const { dataDir, userDataDir } = roots();
  ws(dataDir, "firma", { ledger: true, profile: act() });
  ws(dataDir, "firma.li", { ledger: true, profile: act({ member_slug: "li", workspace: "firma.li", key_slot: "firma.li" }) });
  writeFileSync(join(dataDir, "activation.json"), JSON.stringify(act({ member_slug: "li", workspace: "firma.li", key_slot: "firma.li" })));
  writeFileSync(join(userDataDir, "ledger-key.p.firma.li"), "k");
  const plan = planKeySlot({ dataDir, userDataDir });
  const only = quarantineScope(plan, dataDir);
  assert.deepEqual(only, ["firma.li"]);
  writeFileSync(join(dataDir, "onboarding.json"), "{}"); // 另一个账号等批准的记录（属于待激活那条登记）
  const r = quarantineUnreadable({ dataDir, keyFile: plan.file, only });
  assert.ok(existsSync(join(dataDir, "onboarding.json")), "安全复核 K-2：别的登记的中间记录不随当前档案移走");
  assert.equal(r.ok, true);
  assert.ok(r.moved.includes("firma.li") && r.moved.includes("activation.json") && r.moved.includes("ledger-key.p.firma.li"));
  assert.ok(existsSync(join(dataDir, "firma", "ledger.db")), "别的账号的数据不动");
  assert.ok(!r.moved.includes("pending-activation"));
  // 单档案：null = 以前的做法
  const solo = roots();
  ws(solo.dataDir, "firma", { ledger: true });
  writeFileSync(join(solo.dataDir, "activation.json"), JSON.stringify(act()));
  assert.equal(quarantineScope(planKeySlot(solo), solo.dataDir), null);
});

test("切换账号的界面辅助：档案标记、切换答复识别、按档案分键、文案不再说“只能用那位成员”", () => {
  assert.equal(profileMark({ profile: { id: "0123456789abcdef" }, onboarding: null }), "0123456789abcdef|active");
  assert.equal(profileMark({ onboarding: { mode: "unactivated" } }), "-|onboarding");
  assert.ok(isSwitchResult({ ok: true, switched: true }));
  assert.ok(isSwitchResult({ next: "switch" }));
  assert.ok(!isSwitchResult({ ok: true, account: {} }));
  assert.equal(validHandoffShape({ v: 1, kind: "session" }), true);
  assert.equal(validHandoffShape({ v: 1, kind: "x" }), false);
  setProfileScope(null);
  assert.equal(scopedKey("kwl.home.lastMatter"), "kwl.home.lastMatter");
  setProfileScope("0123456789abcdef");
  assert.equal(scopedKey("kwl.home.lastMatter"), "kwl.home.lastMatter@0123456789abcdef");
  setProfileScope("not-an-id");
  assert.equal(scopedKey("kwl.home.lastMatter"), "kwl.home.lastMatter");
  assert.match(switchingText({ switched: true, account: { name: "乙律师" } } as any), /「乙律师」的工作空间/);
  assert.match(switchingText({ switched: true, enrolling: true, account: { email: "b@x.cn" } } as any), /登记这台电脑/);
  assert.match(reloginView("session_required").lead, /换一个账号登录/);
  const src = readFileSync(join(import.meta.dirname, "../src/pages/Relogin.tsx"), "utf8");
  assert.doesNotMatch(src, /只有这台电脑登记的成员可以在这里登录/);
  assert.match(src, /各账号的事项、材料和成果互不可见/);
});
