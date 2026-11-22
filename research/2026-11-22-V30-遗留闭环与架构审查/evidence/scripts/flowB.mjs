// 阶段 B：律所策略 起草 → 签名 → 发布 → 成员电脑生效（含异常）
import { inv, sleep } from "./lib.mjs";
const log = (k, v) => console.log(`[B] ${k}：`, typeof v === "string" ? v : JSON.stringify(v));
const tryInv = async (...a) => { try { return { ok: true, r: await inv(...a) }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } };
const pol = (s) => ({ version: s?.policy?.version ?? s?.policy_version ?? null, max_mode: s?.policy?.max_mode ?? null, fetch_extra: s?.policy?.fetch_allowlist_extra ?? null, raw: Object.keys(s ?? {}).slice(0, 14) });
const s0 = await inv("admin", "control_plane.status");
log("B0 管理员当前策略", JSON.stringify(s0).slice(0, 500));
const l0 = await inv("li", "control_plane.status");
log("B0 李律师当前策略", JSON.stringify(l0.policy ?? l0).slice(0, 300));
// B1 起草（放宽项：多允许一个网站）
const d = await tryInv("admin", "firm_policy.create_draft", { kind: "policy", body: { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: ["www.court.gov.cn"], l3a_standard_model: "deny" }, ttl_days: 30 });
if (!d.ok) { log("B1 起草失败", d); process.exit(1); }
const draft = d.r.draft;
log("B1 草稿", { id: draft.draft_id, version: draft.doc.version, relaxations: draft.relaxations, expires_at: draft.doc.expires_at, signed_by: draft.signed_by.length, valid: draft.valid, problem: draft.problem });
// B2 异常：没签名就发布
const early = await tryInv("admin", "firm_policy.publish", { draft_id: draft.draft_id });
log("B2 未签名发布", early.ok ? "意外成功" : `${early.code} ${early.message}`);
// B3 异常：签名时交回的摘要与所见不一致
const wrong = await tryInv("admin", "firm_policy.sign", { draft_id: draft.draft_id, expected_digest: "0".repeat(64) });
log("B3 摘要不符的签名", wrong.ok ? "意外成功" : `${wrong.code} ${wrong.message}`);
// B4 签名（所见即所签）
const sg = await tryInv("admin", "firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
log("B4 签名", sg.ok ? { signed_by: sg.r.draft.signed_by.map((x) => x.member_id), signed_by_me: sg.r.draft.signed_by_me } : `${sg.code} ${sg.message}`);
// B5 发布
const pb = await tryInv("admin", "firm_policy.publish", { draft_id: draft.draft_id });
log("B5 发布", pb.ok ? JSON.stringify(pb.r.status?.policy ?? pb.r.status).slice(0, 300) : `${pb.code} ${pb.message}`);
// B6 成员电脑同步后生效（本机独立核验签名）
const sy = await tryInv("li", "control_plane.sync");
log("B6 李律师同步", sy.ok ? sy.r.report?.steps : `${sy.code} ${sy.message}`);
const l1 = await inv("li", "control_plane.status");
log("B6 李律师生效策略", JSON.stringify(l1.policy ?? l1).slice(0, 400));
// B7 边界：重复发布同一草稿；过期/陈旧草稿
const dup = await tryInv("admin", "firm_policy.publish", { draft_id: draft.draft_id });
log("B7 重复发布", dup.ok ? "成功（幂等）" : `${dup.code} ${dup.message}`);
// B8 再起两份草稿，先发布第二份，再签第一份（陈旧）
const d1 = (await inv("admin", "firm_policy.create_draft", { kind: "policy", body: { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny" }, ttl_days: 7 })).draft;
const d2 = (await inv("admin", "firm_policy.create_draft", { kind: "policy", body: { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: ["flk.npc.gov.cn"], l3a_standard_model: "deny" }, ttl_days: 7 })).draft;
await inv("admin", "firm_policy.sign", { draft_id: d2.draft_id, expected_digest: d2.digest });
const p2 = await tryInv("admin", "firm_policy.publish", { draft_id: d2.draft_id });
log("B8 发布第二份", p2.ok ? "成功" : `${p2.code} ${p2.message}`);
const stale = await tryInv("admin", "firm_policy.sign", { draft_id: d1.draft_id, expected_digest: d1.digest });
const stalePub = stale.ok ? await tryInv("admin", "firm_policy.publish", { draft_id: d1.draft_id }) : stale;
log("B8 陈旧草稿再签/发布", stalePub.ok ? "意外成功" : `${stalePub.code} ${stalePub.message}`);
const au = await inv("admin", "control_plane.audit", { limit: 12 });
log("B9 操作记录（最近）", au.records.slice(0, 10).map((r) => `${r.action}:${r.result}`));
