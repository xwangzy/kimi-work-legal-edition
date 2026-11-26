/**
 * 本所 · 概览（律所 admin 读写、partner 只读）：本期额度水位、席位、成员与电脑、待批准入组、告警、历史周期、月度上限；
 * 以及只能在管理员电脑上做的事（依赖律所根私钥、管理员设备签名或本机密钥纪元，契约 §1）。
 * 接口：GET /v1/firm/overview；PUT /v1/firm/cap {monthly_cap_pct}（与客户端设备签名 PUT /v1/quota/cap 同一字段）。
 */
import * as api from "../api.js";
import { alertList, ctx, go, pageHead, roleText, tenantBadge } from "../domain.js";
import { btn, clear, clientOnlyList, confirmAction, facts, fmt, h, icon, load, metaLine, panel, periodBars, quotaCard, stat, toast } from "../ui.js";

export const CLIENT_ONLY = [
  ["批准入组", "新成员或换电脑的成员提交申请后，在管理员电脑上核对校验码并批准"],
  ["生成邀请码", "邀请码的本机核对段只在管理员电脑上生成"],
  ["移除电脑", "只能在管理员电脑上做；让电脑退出登录可在网页“成员”里做"],
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
  clear(head, pageHead(h("span", { class: "title-row" }, f.name ?? "本所", tenantBadge(f.status)), metaLine(plan.label ? `${plan.label}套餐` : null, `你是${roleText(ctx.firmRole)}`, readOnly() ? "只读" : null, f.expires_at ? `${fmt.date(f.expires_at)} 到期` : null)));
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
  const joinBanner = h("div", { class: "banner warn soft" }, icon("info"), h("span", { class: "spacer" }, `有 ${pending} 台新电脑等你批准：请在管理员电脑的“设置 → 管理”里核对校验码与本人一致后再批准。`), btn("查看成员", () => go("firm/members"), { size: "sm" }));
  const seatSub = h("span", {}, "成员名额");
  const devVal = h("span", {}, `${fmt.int(c.devices)} 台`);
  const devSub = h("span", {}, "只有登录中的电脑占名额");
  // 姓名与未占席人数在成员接口里：拿到后补上（拿不到就保持上面的通用写法）
  api.get("/v1/firm/members").then((m) => {
    const p = m.pending_joins ?? [];
    if (p.length) clear(joinBanner.querySelector(".spacer"), p.map((x, i) => [i ? "、" : null, h("b", {}, `${x.member_name ?? "成员"}的新电脑`), `（申请于 ${fmt.time(x.created_at)}）`]), "等你批准：请在管理员电脑的“设置 → 管理”里核对校验码与本人一致后再批准。");
    const n = (m.members ?? []).filter((x) => x.seat_used === false).length;
    if (n) (clear(seatSub, `另有 ${n} 个账号未占席：这些成员能登录，但用不了 AI`), seatSub.classList.add("tone-text-warn"), (seatSub.title = "成员在电脑上第一次用 AI 时自动占席；席位不够时请平台改套餐或席位"));
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
          title: "全所额度",
          ratio: q.used_ratio,
          used: q.used,
          total: q.total,
          unit: q.unit ?? plan.unit,
          resetsAt: q.period?.resets_at ?? q.resets_at,
          capPct,
          paused: q.paused,
          extra: h("div", { class: "btn-row" }, btn(capPct ? `月度上限 ${capPct}%` : "设月度上限", editCap, { size: "sm", disabled: readOnly(), title: readOnly() ? "只有本所管理员能改" : undefined }), q.burst ? h("span", { class: "muted small", title: `任意 ${q.burst.hours ?? 5} 小时内最多用本期额度的 ${q.burst.pct ?? "—"}%` }, `任意 ${q.burst.hours ?? 5} 小时窗口已用 ${fmt.pct(q.burst.used_ratio)}`) : null),
        }),
        { sub: q.period ? fmt.period(q.period) : undefined },
      ),
      h(
        "div",
        { class: "kpis kpis-2" },
        stat("成员", fmt.int(c.members), `7 日活跃 ${fmt.int(c.active_7d)}`),
        stat("席位", `已用 ${fmt.int(seats.used)} / 共 ${fmt.int(seats.total)}`, seatSub, { title: "席位 = 律所可同时使用 AI 的成员名额" }),
        stat("电脑", devVal, devSub),
        stat("电脑待批准", fmt.int(c.pending_joins), Number(c.pending_joins) > 0 ? "在管理员电脑上核对校验码后批准" : "没有待批准的电脑", { tone: Number(c.pending_joins) > 0 ? "warn" : undefined }),
      ),
    ),
    h(
      "div",
      { class: "grid-3" },
      panel("告警", alertList(d.alerts ?? [], { compact: true }), { sub: "本所未确认的告警" }),
      panel(
        "订阅",
        facts([
          ["律所编号", h("span", { class: "mono" }, f.tid ?? "—")],
          ["套餐", plan.label ?? plan.id ?? "—"],
          ["额度单位", plan.unit === "cny" ? "金额（元）" : plan.unit === "tokens" ? "按用量" : "—"],
          ["每人额度（每席位）", plan.seat_quota === undefined || plan.seat_quota === null ? "—" : fmt.amount(plan.seat_quota, plan.unit)],
          ["每账号电脑数", plan.device_limit ? `${plan.device_limit} 台` : "—"],
          ["开通于", fmt.date(f.created_at)],
          ["到期", fmt.date(f.expires_at)],
          ["要求账号登录", f.accounts_required === false ? "否" : "是"],
        ]),
      ),
      panel("历史周期", periodBars(q.history ?? []), { sub: "每期已用比例" }),
    ),
    panel("在管理员电脑上完成", h("div", { class: "stack-sm" }, h("p", { class: "muted small" }, "下面这些只能在管理员电脑的“设置 → 管理”里完成；网页能查看状态。"), clientOnlyList(CLIENT_ONLY), pending > 0 ? btn(`查看待批准的 ${pending} 个申请`, () => go("firm/members"), { size: "sm" }) : null)),
  );
}
