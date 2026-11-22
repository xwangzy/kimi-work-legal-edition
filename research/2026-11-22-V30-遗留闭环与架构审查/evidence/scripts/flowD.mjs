// 阶段 D：阈值告警、额度不足提示、耗尽暂停、运营加量恢复（真实调用；通过调整套餐规模让真实用量跨过阈值）
import { inv, sleep, ops } from "./lib.mjs";
const TID = "ten_b56-firm";
const log = (k, v) => console.log(`[D] ${k}：`, typeof v === "string" ? v : JSON.stringify(v));
const ask = async (who, q) => { const t0 = Date.now(); try { const r = await inv(who, "chat.send", { text: q, stream_id: `d_${Date.now()}` }); const m = r.messages.at(-1); log(`${who} 问答 ${((Date.now() - t0) / 1000).toFixed(1)}s`, r.blocked ? `被拦 ${r.blocked.reason}` : (m?.text ?? m?.content ?? "").replace(/\s+/g, " ").slice(0, 70)); } catch (e) { log(`${who} 问答失败`, `${e.code} ${e.message.slice(0, 140)}`); } };
const plan = async (quota, th) => { const p = await ops("operator", "PUT", "/v1/ops/plans/b56-task", { label: "任务验收", quota_unit: "cny", seat_quota: quota, alert_thresholds: th }); const c = await ops("operator", "POST", `/v1/ops/tenants/${TID}/plan`, { plan: "b56-task" }); log(`套餐 每席位 ${quota} 元 阈值 ${th}`, [p.status, c.status]); await sleep(1500); };
const view = async (tag) => { await sleep(9000); for (const who of ["admin", "li"]) { const q = await inv(who, "quota.status"); log(`${tag} ${who} 视图`, { used_ratio: q.firm.used_ratio, remaining_ratio: q.firm.remaining_ratio, paused: q.firm.paused, boost: q.firm.boost_pct, used: q.firm.used, total: q.firm.total }); } const a = (await ops("operator", "GET", `/v1/ops/alerts?status=all&limit=100`)).json.alerts.filter((x) => x.tid === TID); log(`${tag} 运营告警`, a.map((x) => `${x.kind}/${x.level}/${x.pct ?? ""}：${(x.message ?? "").slice(0, 40)}`)); const fa = await inv("admin", "quota.status"); log(`${tag} 律所侧提醒字段`, Object.keys(fa).filter((k) => /alert|notice|warn/i.test(k)).map((k) => [k, JSON.stringify(fa[k]).slice(0, 200)])); };
const step = process.argv[2];
if (step === "1") { await plan(1.2, [1, 2, 100]); await ask("li", "股东知情权的范围是什么？两句话。"); await view("D1 跨过 1%"); }
if (step === "2") { await plan(0.04, [50, 80, 100]); await view("D2 套餐缩到 0.20 元（约 3 成已用）"); await ask("li", "表见代理的构成要件？两句话。"); await ask("zhao", "一般保证和连带保证的区别？两句话。"); await view("D2 之后"); }
if (step === "3") { await plan(0.014, [50, 80, 100]); await view("D3 套餐缩到 0.07 元（已用约 9 成）"); await ask("li", "建设工程价款优先受偿权的期限？两句话。"); await view("D3 请求被拒后"); }
if (step === "4") { const r = await ops("operator", "POST", `/v1/ops/tenants/${TID}/boost`, { pct: 300 }); log("运营加量 300%", [r.status, r.json?.tenant?.boost_pct ?? r.text.slice(0, 160)]); await view("D4 加量后"); await ask("li", "建设工程价款优先受偿权的期限？两句话。"); await ask("zhao", "抵押权未登记的效力？两句话。"); await view("D4 恢复后"); }
if (step === "5") { await plan(0.002, [50, 80, 100]); await view("D5 套餐缩到低于已用（耗尽）"); await ask("admin", "任意一问"); await view("D5 耗尽后"); }
if (step === "6") { await plan(1.2, [50, 80, 100]); await view("D6 恢复到任务验收规模"); }
