/**
 * 第 68 批（V42，D-294）：账号档案的目录与记录（纯文件判断）。
 * - 第一个档案沿用 `<律所>`；同一律所的另一位成员 `<律所>.<成员>`；已有档案沿用；有账本而无档案记录的目录不复用；
 * - 激活记录的 workspace 只许本律所的、key_slot 须与目录名相同；
 * - 交接只认两种形状；档案标识不含可读身份。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validActivation, type ActivationFile } from "../src/config.ts";
import { allocateWorkspace, findProfile, hasOtherWorkspaces, listProfiles, profileScopeId, validHandoff, writeProfile } from "../src/profiles.ts";

const act = (o: Partial<ActivationFile> = {}): ActivationFile => ({ v: 1, tid: "ten_firma", firm_slug: "firma", firm_name: "甲所", member_slug: "zhang", member_name: "张律师", role: "lawyer", kind: "member", activated_at: new Date().toISOString(), ...o });

test("工作区分配：第一个档案用律所标识；同所另一位成员用 <律所>.<成员>；已有档案沿用；有账本无记录的目录不复用", () => {
  const root = mkdtempSync(join(tmpdir(), "kwl-b68p-"));
  assert.equal(allocateWorkspace(root, "ten_firma", "firma", "zhang"), "firma");
  writeProfile(root, act());
  writeFileSync(join(root, "activation.json"), JSON.stringify(act()));
  assert.equal(allocateWorkspace(root, "ten_firma", "firma", "zhang"), "firma", "同一账号沿用");
  assert.equal(allocateWorkspace(root, "ten_firma", "firma", "li"), "firma.li", "同所另一位成员");
  // 同名目录里是别人留下的账本（没有档案记录）→ 跳过
  mkdirSync(join(root, "firma.wang"), { recursive: true });
  writeFileSync(join(root, "firma.wang", "ledger.db"), "x");
  assert.equal(allocateWorkspace(root, "ten_firma", "firma", "wang"), "firma.wang-2");
  // 别的律所的第一个档案仍用自己的律所标识
  assert.equal(allocateWorkspace(root, "ten_firmb", "firmb", "zhang"), "firmb");
  writeProfile(root, act({ tid: "ten_firma", member_slug: "li", member_name: "李律师", workspace: "firma.li", key_slot: "firma.li" }));
  assert.equal(listProfiles(root).length, 2);
  assert.equal(findProfile(root, "ten_firma", "li")?.workspace, "firma.li");
  assert.equal(findProfile(root, "ten_firmb", "zhang"), null);
  assert.equal(hasOtherWorkspaces(root), true);
  assert.equal(hasOtherWorkspaces(mkdtempSync(join(tmpdir(), "kwl-b68e-"))), false);
});

test("激活记录：workspace 只许本律所的目录、key_slot 须与目录名相同；档案标识是摘要", () => {
  assert.ok(validActivation(act({ workspace: "firma.li", key_slot: "firma.li" })));
  assert.ok(validActivation(act({ key_slot: "firma" })));
  assert.equal(validActivation(act({ workspace: "firmb.li" })), null, "别的律所的目录");
  assert.equal(validActivation(act({ workspace: "../x" })), null);
  assert.equal(validActivation(act({ workspace: "pending-activation" })), null);
  assert.equal(validActivation(act({ workspace: "firma.li", key_slot: "firma" })), null, "密钥格与目录不一致");
  const id = profileScopeId(act());
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.notEqual(id, profileScopeId(act({ member_slug: "li" })));
  assert.ok(!id.includes("zhang"));
});

test("交接只认 session / auth 两种形状", () => {
  const session = { token: "kws1.ses_AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", aid: "acc_1", email: "a@x.cn", name: "张", tid: "ten_firma", role: "lawyer" };
  assert.ok(validHandoff({ v: 1, kind: "session", tid: "ten_firma", member_slug: "zhang", session }));
  // 安全复核 P-3：auth 型交接绑定那次登录的账号——与登录答复里的账号一致才认
  const auth = { session_token: "x", account: { tid: "ten_firmb", member_slug: "li" } };
  assert.ok(validHandoff({ v: 1, kind: "auth", tid: "ten_firmb", member_slug: "li", auth }));
  assert.equal(validHandoff({ v: 1, kind: "auth", tid: "ten_firmb", member_slug: "wang", auth }), null);
  assert.equal(validHandoff({ v: 1, kind: "auth", auth }), null);
  assert.equal(validHandoff({ v: 2, kind: "session", tid: "t", member_slug: "m", session }), null);
  assert.equal(validHandoff({ v: 1, kind: "session", tid: "ten_firma", member_slug: "zhang", session: { ...session, token: 5 } }), null);
  assert.equal(validHandoff({ v: 1, kind: "auth", auth: {} }), null);
  assert.equal(validHandoff({ v: 1, kind: "other" }), null);
  assert.equal(validHandoff(null), null);
});
