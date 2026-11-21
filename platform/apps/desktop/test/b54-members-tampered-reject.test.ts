/**
 * 第 54 批（Windows 安装包真实联调）：入组申请核对不通过（“在传送中被改动过”）时，提示叫管理员“请拒绝并重新发邀请”，
 * 原来这一行却没有“拒绝”按钮。现在与正常申请一样有“拒绝”（需再确认），不提供“批准”。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("成员页：被判改动过的入组申请有“拒绝”、没有“批准”", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/components/MembersAdmin.tsx"), "utf8");
  const start = src.indexOf("r.local_invite && r.verified === false ? (");
  const end = src.indexOf(") : r.local_invite ? (", start);
  assert.ok(start > 0 && end > start, "核对不通过的分支在");
  const branch = src.slice(start, end);
  assert.match(branch, /这份申请在传送中被改动过，不要批准/);
  assert.match(branch, /<ConfirmButton label="拒绝"[^>]*onConfirm=\{\(\) => act\(\(\) => members\.reject\(r\.id\), "已拒绝"\)\}/);
  assert.doesNotMatch(branch, /label="批准"|members\.approve/);
});
