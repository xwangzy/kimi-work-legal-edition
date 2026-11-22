import { inv, sleep, state, ops } from "./lib.mjs";
const log = (k, v) => console.log(`[A] ${k}：`, typeof v === "string" ? v : JSON.stringify(v));
const tryInv = async (...a) => { try { return { ok: true, r: await inv(...a) }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } };
const st = state();
const waitFor = async (what, f, ms = 60000) => { const t0 = Date.now(); for (;;) { const v = await f().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`等不到：${what}`); await sleep(1500); } };
const code = process.argv[2];
// A4 异常：已被认领的邀请码再用一次
const reuse = await tryInv("zhao", "account.register", { email: st.members.zhao.email, password: st.members.zhao.password, name: "赵律师", code });
log("A4 邀请码重复使用", reuse.ok ? "意外成功 " + JSON.stringify(reuse.r).slice(0, 200) : `${reuse.code} ${reuse.message}`);
// A5 异常：批准一个不存在的申请
const ghost = await tryInv("admin", "members.approve", { join_request_id: "jr_AAAAAAAAAAAAAAAA" });
log("A5 批准不存在的申请", ghost.ok ? "意外成功" : `${ghost.code} ${ghost.message}`);
// A6 管理员批准
const l = await inv("admin", "members.list");
const jr = l.join_requests.find((j) => j.name === "李律师");
log("A6 待批准", { id: jr.id, verified: jr.verified, check_code: jr.check_code });
const ap = await tryInv("admin", "members.approve", { join_request_id: jr.id });
log("A6 管理员批准", ap.ok ? JSON.stringify(ap.r).slice(0, 300) : `${ap.code} ${ap.message}`);
// A6b 边界：重复批准同一申请
const again = await tryInv("admin", "members.approve", { join_request_id: jr.id });
log("A6b 重复批准", again.ok ? "成功（幂等）" + JSON.stringify(again.r).slice(0, 120) : `${again.code} ${again.message}`);
const me = await waitFor("李律师进入应用", async () => { const s = await inv("li", "account.me"); return s?.account ? s : null; }, 120000);
log("A7 李律师账号", { name: me.account?.name, email: me.account?.email, role: me.account?.role, devices: me.devices?.length });
const q = await tryInv("li", "quota.status");
log("A7 李律师额度视图", q.ok ? { unit: q.r.unit, own: q.r.own?.used, firm_ratio: q.r.firm?.used_ratio, sees_by_member: !!q.r.by_member } : q);
const roster = await inv("admin", "members.roster");
log("A7 名册", roster.members.map((m) => ({ name: m.name, role: m.role, me: m.is_me, devices: (m.devices ?? []).length })));
// A8 成员权限边界：李律师不能邀请、不能设上限、不能起草策略
for (const [m, p] of [["members.invite", { name: "某人", role: "lawyer" }], ["quota.set_cap", { monthly_cap_pct: 50 }], ["firm_policy.create_draft", { kind: "policy", body: { max_mode: "default" }, ttl_days: 30 }], ["control_plane.audit", {}]]) { const r = await tryInv("li", m, p); log(`A8 普通成员调 ${m}`, r.ok ? "意外成功" : `${r.code} ${r.message.slice(0, 80)}`); }
// A9 再邀请赵律师：先拒绝一次，再重新邀请并批准
const i2 = await inv("admin", "members.invite", { name: "赵律师", role: "lawyer" });
const r2 = await tryInv("zhao", "account.register", { email: st.members.zhao.email, password: st.members.zhao.password, name: "赵律师", code: i2.code });
log("A9 赵律师注册", r2.ok ? { state: r2.r.state, check_code: r2.r.check_code } : `${r2.code} ${r2.message}`);
const p2 = await waitFor("赵的申请", async () => { const x = await inv("admin", "members.list"); return x.join_requests.find((j) => j.name === "赵律师") ?? null; });
const rej = await tryInv("admin", "members.reject", { join_request_id: p2.id });
log("A9 管理员拒绝", rej.ok ? JSON.stringify(rej.r).slice(0, 200) : `${rej.code} ${rej.message}`);
await sleep(3000);
const zs = await tryInv("zhao", "onboarding.status");
log("A9 被拒后申请人侧", JSON.stringify(zs.ok ? zs.r : zs).slice(0, 400));
