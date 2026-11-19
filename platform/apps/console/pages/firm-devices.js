/**
 * 本所 · 电脑：全所登记的电脑、成员、客户端版本、最近报到与异常标记（30 天未报到、版本过旧、退出后仍有请求被拒）。只读。
 * 停用电脑要递增本机密钥纪元，须在管理员电脑上完成（契约 §1）。
 * 接口：GET /v1/firm/devices。
 */
import * as api from "../api.js";
import { FIRM_DEVICE_FLAG, firmFlagBadge, pageHead } from "../domain.js";
import { badge, clear, dataTable, fmt, h, hbars, load, matches, mono, panel, searchInput, segmented } from "../ui.js";

const st = { q: "", flag: "", status: "active", table: { sort: "last_seen_at", asc: false } };

export function render(page) {
  const tools = h("div", { class: "toolbar" });
  const box = h("div", { class: "stack" });
  page.append(pageHead("电脑", "停用电脑请在管理员电脑的“设置 → 管理”里完成"), tools, box);
  let rows = [];
  const draw = () => {
    const list = rows.filter((d) => (st.status === "active" ? !d.revoked : st.status === "revoked" ? d.revoked : true) && (!st.flag || (d.flags ?? []).includes(st.flag)) && matches(st.q, d.device_id, d.member, d.version, d.platform));
    const versions = {};
    for (const d of rows) if (!d.revoked) versions[d.version ?? "未知"] = (versions[d.version ?? "未知"] ?? 0) + 1;
    clear(
      box,
      h(
        "div",
        { class: "grid-2" },
        panel("异常标记", h("div", { class: "flag-sum" }, Object.entries(FIRM_DEVICE_FLAG).map(([f, [label, tone]]) => {
          const n = rows.filter((d) => (d.flags ?? []).includes(f)).length;
          return h("button", { type: "button", class: ["flag-chip", st.flag === f && "active"], onclick: () => ((st.flag = st.flag === f ? "" : f), draw()) }, badge(String(n), n ? tone : "neutral"), label);
        })), { sub: "点一项只看这一类" }),
        panel("客户端版本（在用）", hbars(Object.entries(versions).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v, n]) => ({ label: v, value: n })), { format: (v) => `${v} 台`, empty: "没有在用电脑" })),
      ),
      dataTable({
        rows: list,
        state: st.table,
        empty: rows.length ? "没有符合条件的电脑" : "还没有登记电脑",
        rowClass: (d) => (d.revoked ? "dim" : (d.flags ?? []).length ? "flagged" : ""),
        columns: [
          { key: "device_id", label: "电脑编号", render: (d) => mono(d.device_id) },
          { key: "member", label: "成员", value: (d) => d.member ?? d.aid ?? "" },
          { key: "platform", label: "系统", value: (d) => d.platform ?? "—" },
          { key: "version", label: "客户端", render: (d) => mono(d.version ?? "—") },
          { key: "last_seen_at", label: "最近报到", value: (d) => d.last_seen_at ?? "", render: (d) => h("span", { title: fmt.full(d.last_seen_at) }, fmt.ago(d.last_seen_at)) },
          { key: "flags", label: "标记", value: (d) => (d.flags ?? []).length, render: (d) => ((d.flags ?? []).length ? h("span", { class: "badges" }, d.flags.map(firmFlagBadge)) : "") },
          { key: "revoked", label: "状态", value: (d) => (d.revoked ? 1 : 0), render: (d) => (d.revoked ? badge("已停用", "neutral") : badge("在用", "ok")) },
        ],
      }),
    );
  };
  const segs = h("span");
  const drawSegs = () => clear(segs, segmented([{ id: "active", label: "在用" }, { id: "revoked", label: "已停用" }, { id: "", label: "全部" }], st.status, (v) => ((st.status = v), drawSegs(), draw()), "状态"));
  drawSegs();
  tools.append(segs, searchInput({ placeholder: "电脑编号、成员、版本", value: st.q, onInput: (v) => ((st.q = v), draw()) }));
  load(box, () => api.get("/v1/firm/devices"), (r) => ((rows = Array.isArray(r) ? r : r.devices ?? []), draw()), "正在读取电脑…");
}
