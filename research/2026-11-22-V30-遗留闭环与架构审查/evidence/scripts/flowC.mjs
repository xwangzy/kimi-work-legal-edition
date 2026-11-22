// 阶段 C：多成员用量、阈值告警、律所上限暂停与恢复、额度用完与加量（真实模型调用）
import { inv, sleep, state, ops } from "./lib.mjs";
const TID = "ten_b56-firm";
const log = (k, v) => console.log(`[C] ${k}：`, typeof v === "string" ? v : JSON.stringify(v));
const tryInv = async (...a) => { try { return { ok: true, r: await inv(...a) }; } catch (e) { return { ok: false, code: e.code, message: e.message, detail: e.detail }; } };
const st = state();
const waitFor = async (what, f, ms = 90000) => { const t0 = Date.now(); for (;;) { const v = await f().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`等不到：${what}`); await sleep(1500); } };
const QS = ["合同约定的违约金过高，怎么请求法院调减？两句话。", "借款合同没有约定利息，能主张利息吗？两句话。", "公司股东未届出资期限转让股权，谁承担出资责任？两句话。", "诉讼时效中断有哪些情形？两句话。", "格式条款无效的情形有哪些？两句话。", "定金和订金有什么区别？两句话。", "保证期间没有约定的是多久？两句话。", "申请强制执行的期限是多久？两句话。", "一审判决后多久可以申请执行？两句话。", "劳动仲裁时效是多久？两句话。", "合同解除后违约金条款还有效吗？两句话。", "买卖合同标的物风险何时转移？两句话。"];
let qi = Number(process.env.QI ?? 0);
const ask = async (who) => { const q = QS[qi++ % QS.length]; const t0 = Date.now(); const r = await tryInv(who, "chat.send", { text: q, stream_id: `c_${Date.now()}` }); const txt = r.ok ? (r.r.blocked ? `被拦 ${r.r.blocked.reason}：${r.r.blocked.message}` : (r.r.messages.at(-1)?.text ?? r.r.messages.at(-1)?.content ?? "").replace(/\s+/g, " ").slice(0, 46)) : `失败 ${r.code}：${r.message.slice(0, 150)}`; log(`${who} 问答 ${((Date.now() - t0) / 1000).toFixed(1)}s`, txt); return r; };
const view = async (who, tag) => { await sleep(9000); const q = await inv(who, "quota.status"); log(`${tag} ${who} 额度视图`, { unit: q.unit, firm: q.firm ? `${q.firm.used}/${q.firm.total} (${(q.firm.used_ratio * 100).toFixed(1)}%)` : null, cap_pct: q.firm?.cap_pct ?? null, paused: q.firm?.paused ?? null, boost: q.firm?.boost_pct ?? null, own: q.own ? { used: q.own.used, ratio: q.own.used_ratio, req: q.own.requests } : null, by_member: q.by_member?.map((m) => `${m.name}:${m.used}(${m.requests ?? "?"}次)`) ?? "（看不到）", notice: q.notice ?? q.alerts ?? null }); return q; };
const alerts = async (tag) => { const a = (await ops("operator", "GET", `/v1/ops/alerts?status=all&limit=50`)).json.alerts.filter((x) => x.tid === TID); log(`${tag} 运营告警`, a.map((x) => `${x.kind}${x.threshold ? "@" + x.threshold : ""}${x.pct ? "=" + x.pct : ""}`)); return a; };
const step = process.argv[2];
if (step === "setup") {
  const p = await ops("operator", "PUT", "/v1/ops/plans/b56-tiny", { label: "小额验收", quota_unit: "cny", seat_quota: 0.02, alert_thresholds: [50, 80, 100] });
  log("C0 建小额套餐", [p.status, p.json?.plan?.seat_quota ?? p.text.slice(0, 200)]);
  const c = await ops("operator", "POST", `/v1/ops/tenants/${TID}/plan`, { plan: "b56-tiny" });
  log("C0 换套餐", [c.status, c.json?.tenant?.plan?.id]);
  // 赵律师重新邀请并批准
  const i2 = await inv("admin", "members.invite", { name: "赵律师", role: "lawyer" });
  await tryInv("zhao", "onboarding.reset");
  const r2 = await tryInv("zhao", "account.login", { email: st.members.zhao.email, password: st.members.zhao.password });
  log("C0 赵律师登录（账号已在）", r2.ok ? JSON.stringify(r2.r).slice(0, 300) : `${r2.code} ${r2.message}`);
  const r3 = await tryInv("zhao", "onboarding.redeem", { code: i2.code });
  log("C0 赵律师输入新邀请码", r3.ok ? JSON.stringify(r3.r).slice(0, 300) : `${r3.code} ${r3.message}`);
  const p2 = await waitFor("赵的申请", async () => { const x = await inv("admin", "members.list"); return x.join_requests.find((j) => j.name === "赵律师") ?? null; });
  log("C0 赵的申请", p2);
  const ap = await tryInv("admin", "members.approve", { join_request_id: p2.id });
  log("C0 批准赵律师", ap.ok ? ap.r : `${ap.code} ${ap.message}`);
  const me = await waitFor("赵律师进入", async () => { const s = await inv("zhao", "account.me"); return s?.account ? s : null; }, 120000);
  log("C0 赵律师账号", { name: me.account.name, role: me.account.role });
  await view("admin", "C0"); await alerts("C0");
}
if (step === "usage") {
  for (const who of (process.argv[3] ?? "admin,li,zhao").split(",")) await ask(who);
  await view("admin", "C1"); await view("li", "C1"); await alerts("C1");
}
if (step === "cap") {
  const pct = process.argv[3] === "null" ? null : Number(process.argv[3]);
  const r = await tryInv("admin", "quota.set_cap", { monthly_cap_pct: pct });
  log(`C 设上限 ${pct}`, r.ok ? r.r : `${r.code} ${r.message}`);
  await view("admin", "C2");
}
if (step === "bad-cap") for (const v of [0, 101, 50.5, "abc", -1]) { const r = await tryInv("admin", "quota.set_cap", { monthly_cap_pct: v }); log(`C 非法上限 ${v}`, r.ok ? "意外成功" : `${r.code} ${r.message}`); }
if (step === "ask") { for (const who of process.argv[3].split(",")) await ask(who); await view("admin", "C3"); await alerts("C3"); }
if (step === "local") { const m = await tryInv("li", "matters.create", { title: "暂停期间本机功能验证", stance: "原告" }); log("C 暂停期间本机新建事项", m.ok ? m.r.matter.matter_id : `${m.code} ${m.message}`); const lc = await tryInv("li", "runs.estimate", {}); }
if (step === "boost") { const r = await ops("operator", "POST", `/v1/ops/tenants/${TID}/boost`, { pct: Number(process.argv[3] ?? 50) }); log("C 运营加量", [r.status, r.text.slice(0, 200)]); await view("admin", "C5"); }
if (step === "plan") { const [id, quota, th] = [process.argv[3], Number(process.argv[4]), (process.argv[5] ?? "50,80,100").split(",").map(Number)]; const p = await ops("operator", "PUT", `/v1/ops/plans/${id}`, { label: process.argv[6] ?? "验收套餐", quota_unit: "cny", seat_quota: quota, alert_thresholds: th }); log("建套餐", [p.status, p.json?.plan?.seat_quota ?? p.text.slice(0, 200)]); const c = await ops("operator", "POST", `/v1/ops/tenants/${TID}/plan`, { plan: id }); log("换套餐", [c.status, c.json?.tenant?.plan?.id]); await sleep(16000); await view("admin", "P"); }
if (step === "view") { await view("admin", "V"); await view("li", "V"); await view("zhao", "V"); await alerts("V"); }
