/**
 * 本所 · 电脑。第 71 批第二轮（11）：与平台电脑页、我的电脑同一套样式与说法——
 *   状态四态（登录中 / 已退出登录 / 待批准 / 已移除），“未移除”只作筛选；待批准的新电脑也列出；
 *   本所管理员可在网页上“让它退出登录”（POST /v1/firm/members/{aid}/devices/{id}/signout）；移除与批准仍在管理员电脑上完成（行菜单里写明）；
 *   异常标记与平台口径一致；只有一个版本时不单列版本卡。
 * 接口：GET /v1/firm/devices、GET /v1/firm/members（pending_joins）。
 * 第 72 批（D-304、契约 §3.5）：账号签发钥签的电脑（issuer: account_ca）能登录、用 AI、处理自己的事项，但还不能接收团队共享事项——
 *   标“待确认（可接收团队共享事项前）”，确认沿用入组批准，在管理员电脑上完成。控制面的电脑行带 issuer 时才显示（见 03 契约变更记录 W-1）。
 */
import * as api from "../api.js";
import { CONFIRM_TIP, deviceCell, deviceState, deviceStateCell, FIRM_DEVICE_FLAG, firmFlagBadge, pageHead, pendingRow, platformText, unconfirmed, versionText } from "../domain.js";
import { badge } from "../ui.js";
import { readOnly } from "./firm-overview.js";
import { clear, confirmAction, dataTable, fmt, h, hbars, load, matches, mono, panel, rowMenu, searchInput, segmented, toast } from "../ui.js";

const st = { q: "", flag: "", status: "live", table: { sort: "state", asc: true } };
const STATUS = [
  ["live", "未移除", (d) => deviceState(d) !== "revoked"],
  ["signed_in", "登录中", (d) => deviceState(d) === "signed_in"],
  ["signed_out", "已退出登录", (d) => deviceState(d) === "signed_out"],
  ["pending", "待批准", (d) => deviceState(d) === "pending"],
  ["confirm", "待确认", (d) => unconfirmed(d)],
  ["revoked", "已移除", (d) => deviceState(d) === "revoked"],
  ["", "全部", () => true],
];


export function render(page) {
  const tools = h("div", { class: "toolbar" });
  const tools2 = h("div", { class: "toolbar" });
  const box = h("div", { class: "stack" });
  page.append(pageHead("电脑", "本团队成员登录过的电脑。让电脑退出登录可在这里做；移除、确认新电脑在管理员电脑的“设置 → 管理”里完成"), tools, tools2, box);
  let rows = [];
  const signout = async (d, reload) => {
    const r = await confirmAction({
      title: "让这台电脑退出登录",
      lead: h("p", {}, h("b", {}, d.name || "这台电脑"), h("span", { class: "muted" }, ` · ${d.member ?? ""} · `, mono(d.device_id))),
      consequences: ["这台电脑上的登录立即失效，腾出一个“同时登录”的名额；", "电脑上的资料保留，本人之后在那台电脑上重新登录即可继续用；", "不移除这台电脑。"],
      confirmLabel: "退出登录",
      run: async () => {
        try {
          return await api.post(`${api.M(d.aid)}/devices/${api.seg(d.device_id)}/signout`);
        } catch (e) {
          if (e?.code === "not_ready") throw new Error("云端版本过旧：还不支持在网页上让电脑退出登录，请在管理员电脑上操作");
          throw e;
        }
      },
    });
    if (r) (toast("已退出登录"), reload());
  };
  const draw = (reload) => {
    const sf = STATUS.find(([id]) => id === st.status)?.[2] ?? (() => true);
    const ofStatus = rows.filter(sf);
    const list = ofStatus.filter((d) => (!st.flag || (d.flags ?? []).includes(st.flag)) && matches(st.q, d.device_id, d.name, d.member, d.version, d.platform));
    clear(tools, h("span", { class: "seg-label" }, "状态"), segmented(STATUS.map(([id, label, f]) => ({ id, label, count: rows.filter(f).length })), st.status, (v) => ((st.status = v), draw(reload)), "状态"));
    clear(tools2, searchInput({ placeholder: "电脑名称、成员、版本", value: st.q, onInput: (v) => ((st.q = v), draw(reload)) }), h("span", { class: "seg-label" }, "标记"), segmented([{ id: "", label: "不限", count: ofStatus.length }, ...Object.entries(FIRM_DEVICE_FLAG).filter(([f]) => f !== "rejected_after_logout").map(([f, [label]]) => ({ id: f, label, count: ofStatus.filter((d) => (d.flags ?? []).includes(f)).length }))], st.flag, (v) => ((st.flag = v), draw(reload)), "异常标记"));
    const versions = {};
    for (const d of rows) if (!["revoked", "pending"].includes(deviceState(d))) versions[versionText(d.version)] = (versions[versionText(d.version)] ?? 0) + 1;
    const vs = Object.entries(versions).sort((a, b) => b[1] - a[1]);
    const anyFlag = list.some((d) => (d.flags ?? []).length);
    clear(
      box,
      dataTable({
        rows: list,
        state: st.table,
        empty: rows.length ? "没有符合条件的电脑" : "还没有登记电脑",
        rowClass: (d) => (deviceState(d) === "revoked" ? "dim" : d.pending ? "pending-row" : ""),
        caption: "电脑",
        columns: [
          { key: "name", label: "电脑", value: (d) => d.name || d.member || "", render: (d) => deviceCell(d) },
          { key: "member", label: "成员", value: (d) => d.member ?? "" },
          { key: "platform", label: "系统", value: (d) => platformText(d.platform) },
          { key: "version", label: "客户端", render: (d) => (d.pending ? h("span", { class: "muted" }, "—") : d.version && d.version !== "legacy" ? mono(d.version) : h("span", { class: "muted" }, versionText(d.version))) },
          { key: "last_seen_at", label: "最近在线", value: (d) => d.last_seen_at ?? "", render: (d) => (d.pending ? h("span", { class: "muted" }, "—") : d.last_active_at ? h("span", { title: fmt.full(d.last_active_at) }, fmt.ago(d.last_active_at)) : h("span", { title: fmt.full(d.last_seen_at) }, d.last_seen_at ? fmt.ago(d.last_seen_at) : "从未在线")) },
          { key: "state", label: "状态", value: (d) => ({ pending: 0, signed_in: 1, signed_out: 2, revoked: 3 })[deviceState(d)] - (unconfirmed(d) ? 0.5 : 0), render: (d) => (unconfirmed(d) ? h("span", { class: "cell-2" }, deviceStateCell(d), h("small", {}, badge("待确认（可接收团队共享事项前）", "warn", CONFIRM_TIP))) : deviceStateCell(d)) },
          anyFlag ? { key: "flags", label: "标记", value: (d) => (d.flags ?? []).length, render: (d) => ((d.flags ?? []).length ? h("span", { class: "badges" }, d.flags.map(firmFlagBadge)) : "") } : null,
          {
            key: "_act",
            label: "",
            sortable: false,
            class: "act",
            render: (d) =>
              deviceState(d) === "revoked"
                ? null
                : d.pending
                  ? rowMenu([{ label: "在管理员电脑上核对校验码后批准", disabled: true, title: "批准只能在管理员电脑上完成" }])
                  : rowMenu([
                      unconfirmed(d) ? { label: "在管理员电脑上确认（接收团队共享事项）", disabled: true, title: CONFIRM_TIP } : null,
                      deviceState(d) === "signed_in" ? { label: "让它退出登录…", onClick: () => signout(d, reload), disabled: readOnly() || !d.aid, title: readOnly() ? "只有本所管理员能操作" : undefined } : null,
                      { label: "移除（在管理员电脑上完成）", disabled: true, title: "移除只能在管理员电脑的“设置 → 管理”里完成" },
                    ], { aria: `操作：${d.name || d.member || d.device_id}` }),
          },
        ].filter(Boolean),
      }),
      vs.length > 1 ? panel("客户端版本（在用）", hbars(vs.slice(0, 6).map(([v, n]) => ({ label: v, value: n })), { format: (v) => `${v} 台` })) : vs.length === 1 ? h("p", { class: "muted small" }, `在用电脑都是客户端 ${vs[0][0]}（${vs[0][1]} 台）`) : null,
    );
  };
  const reload = () =>
    load(
      box,
      () => Promise.all([api.get("/v1/firm/devices"), api.get("/v1/firm/members").catch(() => ({ pending_joins: [] }))]),
      ([r, m]) => {
        const devs = Array.isArray(r) ? r : r.devices ?? [];
        rows = [...devs.map((d) => ({ ...d, member_name: d.member, client_version: d.version, flags: (d.flags ?? []).filter((f) => f !== "rejected_after_logout") })), ...(m.pending_joins ?? []).map((p) => pendingRow({ ...p, member_name: p.member_name }, { member: p.member_name }))];
        draw(reload);
      },
      "正在读取电脑…",
    );
  reload();
}
