/**
 * 本所 · 概览（律所 admin 读写、partner 只读）：本期额度水位、席位、成员与电脑、待批准入组、告警、历史周期、月度上限；
 * 以及只能在管理员电脑上做的事（依赖律所根私钥、管理员设备签名或本机密钥纪元，契约 §1）。
 * 接口：GET /v1/firm/overview；PUT /v1/firm/cap {monthly_cap_pct}（与客户端设备签名 PUT /v1/quota/cap 同一字段）。
 */
import * as api from "../api.js";
import { alertList, ctx, go, pageHead, roleText, seatNote, tenantBadge } from "../domain.js";
import { badge, btn, clear, clientOnlyList, confirmAction, facts, fmt, h, icon, load, metaLine, panel, periodBars, quotaCard, stat, toast } from "../ui.js";

export const CLIENT_ONLY = [
  ["确认新电脑", "核对校验码后确认（含要接收团队共享事项的电脑）"],
  ["移除电脑", "只能在管理员电脑上做；让电脑退出登录可在网页“成员”或“电脑”里做"],
  ["策略与连接器发布", "本所策略由管理员电脑发布后才会下发"],
  ["恢复包与备份", "律所根密钥的备份与恢复只在本机完成"],
  ["离所交接", "成员离所时的事项与材料交接"],
];
export const readOnly = () => ctx.firmRole !== "admin";

export function render(page) {
  const head = h("div");
  const box = h("div", { class: "stack" });
  page.append(head, box);
  const reload = () => load(box, () => api.get("/v1/firm/overview"), (d) => draw(head, box, d, reload), "正在读取本所概览…");
  head.append(pageHead("本所概览", roleText(ctx.firmRole)));
  reload();
}

function draw(head, box, d, reload) {
  const f = d.firm ?? {};
  const q = d.quota ?? {};
  const plan = d.plan ?? {};
  const c = d.counts ?? {};
  const seats = d.seats ?? {};
  clear(head, pageHead(h("span", { class: "title-row" }, f.name ?? "本所", f.status === "pending" ? badge("待创建人在电脑上完成开通", "info", "创建人第一次在自己的电脑上登录 Kimi Work 即完成开通") : tenantBadge(f.status)), metaLine(plan.label ? `${plan.label}套餐` : null, `你是${roleText(ctx.firmRole)}`, readOnly() ? "只读" : null, f.expires_at ? `${fmt.date(f.expires_at)} 到期` : null)));
  const capPct = q.cap_pct ?? q.monthly_cap_pct ?? null;
  const editCap = async () => {
    const r = await confirmAction({
      title: "本所月度上限",
      lead: h("p", {}, "全所本期用量到这个比例后暂停调用 AI（本机流程不受影响），下一期自动恢复。"),
      fields: [{ name: "pct", label: "上限（占本期总额度的 %）", type: "number", min: 1, max: 100, value: capPct ?? "", hint: "1–100；留空 = 不设上限" }],
      validate: (v) => (v.pct !== null && !(Number.isInteger(v.pct) && v.pct >= 1 && v.pct <= 100) ? "请填 1–100 的整数，或留空" : null),
      consequences: ["立即生效：当前已用超过新上限时，全所马上暂停调用 AI；", "客户端“设置 → 管理”里的月度上限是同一个值，会同步改变。"],
      confirmLabel: "保存上限",
      run: (v) => api.put("/v1/firm/cap", { monthly_cap_pct: v.pct ?? null }),
    });
    if (r) (toast("已保存月度上限"), reload());
  };
  const pending = Number(c.pending_joins) || 0;
  const todoVal = h("span", {}, fmt.int(pending));
  const todoSub = h("span", {}, pending > 0 ? "在管理员电脑上处理" : "没有待处理的电脑");
  const todoStat = stat("电脑待处理", todoVal, todoSub, { tone: pending > 0 ? "warn" : undefined, title: "待批准登录 + 待确认共享（要接收团队共享事项的电脑）" });
  api.get("/v1/firm/devices").then((r) => {
    const n = pending + (r.devices ?? []).filter((x) => x.issuer === "account_ca" && x.state !== "revoked").length;
    clear(todoVal, fmt.int(n));
    clear(todoSub, n > 0 ? "在管理员电脑上处理" : "没有待处理的电脑");
    if (n > 0) todoStat.classList.add("tone-warn");
  }, () => {});
  const joinBanner = h("div", { class: "banner warn soft" }, icon("info"), h("span", { class: "spacer" }, `有 ${pending} 台新电脑等你批准：请在管理员电脑的“设置 → 管理”里核对校验码与本人一致后再批准。`), btn("查看成员", () => go("firm/members"), { size: "sm" }));
  const seatSub = h("span", {}, "能用 AI 的名额");
  // 评审第二轮（K14）：成员数与 7 日活跃只算当前有效成员（已移出 / 停用的不算），拿到成员清单后改写
  const memVal = h("span", {}, fmt.int(c.members));
  const memSub = h("span", {}, `近 7 日登录 ${fmt.int(c.active_7d)} 人`);
  const devVal = h("span", {}, `${fmt.int(c.devices)} 台`);
  const devSub = h("span", {}, "只有登录中的电脑占名额");
  // 姓名与未占席人数在成员接口里：拿到后补上（拿不到就保持上面的通用写法）
  api.get("/v1/firm/members").then((m) => {
    const p = m.pending_joins ?? [];
    const act = (m.members ?? []).filter((x) => x.status !== "disabled");
    const since = Date.now() - 7 * 86_400_000;
    clear(memVal, fmt.int(act.length));
    clear(memSub, `近 7 日登录 ${fmt.int(act.filter((x) => x.last_login_at && Date.parse(x.last_login_at) >= since).length)} 人`);
    if (p.length) clear(joinBanner.querySelector(".spacer"), p.map((x, i) => [i ? "、" : null, h("b", {}, `${x.member_name ?? "成员"}的新电脑`), `（申请于 ${fmt.time(x.created_at)}）`]), "等你批准：请在管理员电脑的“设置 → 管理”里核对校验码与本人一致后再批准。");
    const n = (m.members ?? []).filter((x) => x.seat_used === false).length;
    const sn = seatNote(n, seats.total, seats.used);
    // 评审（K14 第 3 条）：席位格说明缩成一行，细节放悬停
    if (sn) (clear(seatSub, sn.full ? `席位已满：${n} 人用不了 AI` : `另有 ${n} 人未占席，空席 ${sn.free}`), (seatSub.title = sn.text), sn.full && seatSub.classList.add("tone-text-warn"));
    // 第四轮（23）：电脑格写“x 台登录中 · y 台待批准”
    const on = (m.members ?? []).reduce((s, x) => s + (x.devices ?? []).filter((d) => d.state === "signed_in").length, 0);
    clear(devVal, `${on} 台登录中`);
    clear(devSub, `共 ${fmt.int(c.devices)} 台已登记`);
  }, () => {});
  clear(
    box,
    // 第三轮（23）：与“成员”页同一写法与颜色——琥珀色、写姓名“某某 的新电脑”
    pending > 0 ? joinBanner : null,
    h(
      "div",
      { class: "grid-2-1" },
      panel(
        "本期额度",
        quotaCard({
          title: "全团队额度",
          ratio: q.used_ratio,
          used: q.used,
          total: q.total,
          unit: q.unit ?? plan.unit,
          resetsAt: q.period?.resets_at ?? q.resets_at,
          capPct,
          paused: q.paused,
          extra: h("div", { class: "btn-row" }, btn(capPct ? `月度上限 ${capPct}%` : "设月度上限", editCap, { size: "sm", disabled: readOnly(), title: readOnly() ? "只有本所管理员能改" : undefined }), q.burst ? h("span", { class: "muted small", title: `近 ${q.burst.hours ?? 5} 小时内最多用本期额度的 ${q.burst.pct ?? "—"}%` }, `近 ${q.burst.hours ?? 5} 小时已用 ${fmt.pct(q.burst.used_ratio)}`) : null),
        }),
        { sub: q.period ? fmt.period(q.period) : undefined },
      ),
      h(
        "div",
        { class: "kpis kpis-2" },
        stat("成员", memVal, memSub),
        stat("席位", `已用 ${fmt.int(seats.used)} / 共 ${fmt.int(seats.total)}`, seatSub, { title: "席位：能用 AI 的名额" }),
        stat("电脑", devVal, devSub),
        // 评审（K14 第 2 条）：待处理 = 待批准登录 + 待确认共享，数字大于 0 时写去哪儿处理
        todoStat,
      ),
    ),
    ((cards) => h("div", { class: cards.length === 3 ? "grid-3" : "grid-2" }, cards))([
      (d.alerts ?? []).length ? panel("告警", alertList(d.alerts ?? [], { compact: true }), { sub: "本所未确认的告警" }) : null,
      panel(
        "订阅",
        facts([
          ["套餐", plan.label ?? plan.id ?? "—"],
          ["每人参考额度", plan.seat_quota === undefined || plan.seat_quota === null ? "—" : fmt.amount(plan.seat_quota, plan.unit)],
          ["每人同时登录", plan.device_limit ? `${plan.device_limit} 台电脑` : "—"],
          // 评审（K14 第 1 条）：还没开通时不写“开通于”
          f.status === "pending" ? ["开通", "等创建人第一次在客户端登录"] : ["开通于", fmt.date(f.created_at)],
          ["到期", fmt.date(f.expires_at)],
          ["账号登录", f.accounts_required === false ? "不要求（旧方式）" : "成员须登录账号才能用 AI"],
        ]),
      ),
      (q.history ?? []).length ? panel("历史周期", periodBars(q.history ?? []), { sub: "每期已用比例" }) : panel("历史周期", h("p", { class: "muted small" }, "从下个账期开始出现每期已用比例。")),
    ].filter(Boolean)),
    panel("在管理员电脑上完成", h("div", { class: "stack-sm" }, h("p", { class: "muted small" }, "下面这些只能在管理员电脑的“设置 → 管理”里完成；网页能查看状态。"), clientOnlyList(CLIENT_ONLY), pending > 0 ? btn(`查看待批准的 ${pending} 个申请`, () => go("firm/members"), { size: "sm" }) : null)),
  );
}
