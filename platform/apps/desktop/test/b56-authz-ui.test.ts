/**
 * D-225 界面：逐项记录同样要出处；早期记录“待补记”；授权一行只读与历史；设置里各事项授权记录总览与导出；问答的常驻范围提示。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

test("授权状态与一行只读：有效写出处、日期与记录人；早期记录待补记；清单更新待重新确认；不上云单列", async () => {
  const { authorizationStatus, authorizationRecordLine, authorizationLine, detailReady, detailSource, BASIS_REF_MAX } = await import("../src/lib/authorization.ts");
  assert.equal(authorizationStatus({ basis_state: "valid" }).label, "有效");
  assert.equal(authorizationStatus({ basis_state: "needs_ref", basis_complete: true }).label, "待补记");
  assert.equal(authorizationStatus({ basis_state: "reconfirm", basis_complete: true }).label, "次处理者清单已更新，待重新确认");
  assert.equal(authorizationStatus({ basis_state: "pending" }).label, "尚未记录");
  assert.equal(authorizationStatus({ consent_status: "refused", basis_state: "pending" }).label, "客户要求不上云");
  const at = new Date(2026, 10, 22, 10, 0).toISOString();
  assert.equal(authorizationRecordLine({ basis_state: "valid", basis_ref: "委托合同第 12 条", basis_recorded_at: at, basis_recorded_by: "王主任" }), "客户授权：委托合同第 12 条 · 11 月 22 日 王主任记录");
  assert.equal(authorizationRecordLine({ basis_state: "needs_ref", basis_complete: true }), "客户授权：待补记");
  assert.equal(authorizationLine({ basis_complete: true, basis_state: "needs_ref" }), "待补记 · 早期记录缺少出处");
  // 逐项记录：出处必填、不超长；类型沿用律师选的或原来的，否则记为逐项记录
  assert.equal(detailReady("  "), false);
  assert.equal(detailReady("x".repeat(BASIS_REF_MAX + 1)), false);
  assert.equal(detailReady("委托合同第 12 条"), true);
  assert.equal(detailSource({ kind: null, ref: "", sensitive: false }, { basis_source: "separate_consent" }), "separate_consent");
  assert.equal(detailSource({ kind: null, ref: "", sensitive: false }, { basis_source: null }), "confirmed");
});

test("各事项授权记录：只用事项列表字段、去掉示例事项；导出 CSV 带 BOM、加引号、防公式", async () => {
  const { authorizationRows, authorizationCsv } = await import("../src/lib/authorization.ts");
  const rows = authorizationRows([
    { matter_id: "m1", title: "甲诉乙", basis_state: "valid", basis_source: "engagement_terms", basis_ref: "委托合同第 12 条", basis_recorded_at: "2026-11-22T02:00:00Z", basis_recorded_by: "王主任" },
    { matter_id: "m2", title: "=HYPERLINK(1)", basis_state: "needs_ref", basis_complete: true, basis_source: "engagement_terms", basis_ref: null },
    { matter_id: "m3", title: "示例", is_sample: true, basis_state: "valid" },
  ]);
  assert.deepEqual(rows.map((r) => [r.title, r.basis, r.status]), [["甲诉乙", "委托合同中的 AI 条款", "有效"], ["=HYPERLINK(1)", "委托合同中的 AI 条款", "待补记"]]);
  const csv = authorizationCsv(rows);
  assert.ok(csv.startsWith("﻿\"事项\",\"依据\",\"出处\",\"记录时间\",\"记录人\",\"状态\""));
  assert.match(csv, /"'=HYPERLINK\(1\)"/);
});

test("界面接线：逐项编辑器下要求出处；开始前确认两条路径都带类型与出处；签发页与事项页一行只读；设置总览；问答常驻提示", () => {
  const consent = src("components/Consent.tsx");
  assert.match(consent, /<BasisEditor basis=\{detail\}[\s\S]{0,500}授权依据的出处/);
  assert.match(consent, /这是早期记录，缺少出处，请补记一次/);
  const sheet = src("components/RunSheet.tsx");
  assert.match(sheet, /detail \? detailReady\(record\.ref\)/);
  assert.match(sheet, /basis_source: detail \? detailSource\(record, matter\) : record\.kind, basis_ref: record\.ref\.trim\(\)/);
  assert.match(src("pages/Review.tsx"), /<AuthorizationTrail matter=\{authzMatter\} \/>/);
  assert.match(src("components/MatterHeader.tsx"), /<AuthorizationTrail matter=\{matter\} \/>/);
  const conn = src("pages/Connections.tsx");
  assert.match(conn, /<AuthorizationOverview \/>/);
  assert.match(conn, /用常用条款预填/);
  assert.match(conn, /每个事项仍需你确认一次/);
  assert.match(src("pages/Chat.tsx"), /一般法律问题在这里问；涉及具体案件的材料与当事人，请在事项里发起/ /* 第 72 批（D-303）：移到框外一行、压成一句 */);
  // 样式：不超过 600 字重、字号只用令牌
  const css = src("styles-authz.css");
  assert.ok(!/font-weight:\s*(700|800|900|bold)/.test(css));
  for (const m of css.matchAll(/font-size:\s*([^;]+);/g)) assert.match(m[1]!, /^var\(--fs-[a-z0-9]+\)$/, m[1]);
});
