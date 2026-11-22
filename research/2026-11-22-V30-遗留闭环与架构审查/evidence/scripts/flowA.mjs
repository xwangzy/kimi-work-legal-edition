// 阶段 A：邀请同事入组 → 管理员审批（正常 + 异常 + 边界）。经与界面相同的内核方法。
import { inv, sleep, state, ops } from "./lib.mjs";
const log = (k, v) => console.log(`[A] ${k}：`, typeof v === "string" ? v : JSON.stringify(v));
const tryInv = async (...a) => { try { return { ok: true, r: await inv(...a) }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } };
const st = state();
const waitFor = async (what, f, ms = 60000) => { const t0 = Date.now(); for (;;) { const v = await f().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`等不到：${what}`); await sleep(1500); } };

// A1 异常：错的邀请码
const bad = await tryInv("li", "account.register", { email: st.members.li.email, password: st.members.li.password, name: "李律师", code: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH-JJJJ" });
log("A1 错码注册", bad.ok ? "意外成功" : `${bad.code} ${bad.message}`);
// A2 正常：凭邀请码注册（自填的名字与邀请不同：应以邀请名为准，第 54 批缺陷 B）
const list0 = await inv("admin", "members.list");
let invite = list0.invitations.find((x) => x.name === "李律师" && x.status === "open");
const code = process.argv[2];
const reg = await tryInv("li", "account.register", { email: st.members.li.email, password: st.members.li.password, name: "李四（自填）", code });
log("A2 李律师注册", reg.ok ? Object.keys(reg.r) : `${reg.code} ${reg.message}`);
if (reg.ok) log("A2 注册返回", JSON.stringify(reg.r).slice(0, 500));
// A3 管理员看到待批准申请；双方核对码
const pending = await waitFor("入组申请", async () => { const l = await inv("admin", "members.list"); return l.join_requests?.length ? l : null; });
log("A3 管理员侧申请", pending.join_requests.map((j) => ({ id: j.join_request_id, name: j.name, role: j.role, check_code: j.check_code, status: j.status, tampered: j.tampered ?? j.problem ?? null })));
const liStatus = await tryInv("li", "account.status");
log("A3 申请人侧状态", JSON.stringify(liStatus.ok ? liStatus.r : liStatus).slice(0, 500));
// A4 异常：同一邀请码再用一次（赵律师）
const reuse = await tryInv("zhao", "account.register", { email: st.members.zhao.email, password: st.members.zhao.password, name: "赵律师", code });
log("A4 邀请码重复使用", reuse.ok ? "意外成功 " + JSON.stringify(reuse.r).slice(0, 200) : `${reuse.code} ${reuse.message}`);
// A5 异常：普通成员（未入组）调批准 → 拒绝
const jr = pending.join_requests[0];
const notAdmin = await tryInv("li", "members.approve", { join_request_id: jr.join_request_id });
log("A5 非管理员批准", notAdmin.ok ? "意外成功" : `${notAdmin.code} ${notAdmin.message}`);
// A6 管理员批准
const ap = await tryInv("admin", "members.approve", { join_request_id: jr.join_request_id });
log("A6 管理员批准", ap.ok ? JSON.stringify(ap.r).slice(0, 300) : `${ap.code} ${ap.message}`);
// A7 成员侧取回证书、进入；看到自己的名字与席位
const me = await waitFor("李律师进入应用", async () => { const s = await inv("li", "account.me"); return s?.account ? s : null; }, 90000);
log("A7 李律师账号", { name: me.account?.name, email: me.account?.email, role: me.member?.role ?? me.account?.role, devices: me.devices?.length });
const q = await tryInv("li", "quota.status");
log("A7 李律师额度视图", q.ok ? { unit: q.r.unit, own: q.r.own?.used, firm_ratio: q.r.firm?.used_ratio, sees_by_member: !!q.r.by_member } : q);
const roster = await inv("admin", "members.roster");
log("A7 名册", roster.members.map((m) => ({ name: m.name, role: m.role, devices: m.devices?.length ?? m.active_devices, seat: m.seat ?? m.has_seat })));
const t = (await ops("operator", "GET", "/v1/ops/tenants/ten_b56-firm")).json.tenant;
log("A7 控制面席位", { seats: t.seats, seats_used: t.seats_used ?? t.seats_assigned, members: t.members ?? t.accounts });
