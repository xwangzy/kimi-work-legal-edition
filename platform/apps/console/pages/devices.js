/**
 * 设备：跨律所设备表（版本、最近报到、状态、标记的异常），吊销。
 * 接口：GET /v1/ops/devices?tid&status&flag；吊销 POST /v1/ops/tenants/{tid}/devices/{dev}/revoke（device.revoke）。
 * 异常标记由控制面给（stale = 最近报到超过 30 天、outdated = 客户端版本过旧、suspended = 暂停后仍有请求），本页不另算。
 */
import * as api from "../api.js";
import { DEVICE_FLAG, deviceTable, pageHead, tenantOptions } from "../domain.js";
import { badge, clear, errorBlock, h, hbars, loadingBlock, matches, panel, searchInput, segmented, selectEl } from "../ui.js";

const st = { tid: "", status: "active", flag: "", q: "", table: { sort: "last_seen_on", asc: false } };

export function render(page, r) {
  if (r.params.tid !== undefined) st.tid = r.params.tid;
  if (r.params.flag !== undefined) st.flag = r.params.flag;
  const tools = h("div", { class: "toolbar" });
  const summary = h("div");
  const box = h("div");
  page.append(pageHead("设备", "律所根签发的设备证书；同一账号第 2～9 台为 dev_<律所>_<成员>_D<n>"), tools, summary, box);
  let rows = [];
  let seq = 0;
  const fetchRows = async () => {
    const my = ++seq;
    clear(box, loadingBlock("正在读取设备…"));
    clear(summary);
    try {
      const res = await api.get("/v1/ops/devices", { tid: st.tid, status: st.status, flag: st.flag });
      if (my !== seq) return;
      rows = res.devices ?? [];
      draw();
    } catch (e) {
      if (my === seq) clear(box, errorBlock(e, fetchRows));
    }
  };
  const draw = () => {
    const list = rows.filter((d) => matches(st.q, d.device_id, d.email, d.uid, d.tenant_name, d.client_version));
    const versions = {};
    for (const d of rows) if (!d.revoked_at) versions[d.client_version ?? "未知"] = (versions[d.client_version ?? "未知"] ?? 0) + 1;
    const flagCount = Object.fromEntries(Object.keys(DEVICE_FLAG).map((f) => [f, rows.filter((d) => (d.flags ?? []).includes(f)).length]));
    clear(
      summary,
      h(
        "div",
        { class: "grid-2" },
        panel(
          "标记的异常",
          h(
            "div",
            { class: "flag-sum" },
            Object.entries(DEVICE_FLAG).map(([f, [label, tone]]) => h("button", { type: "button", class: ["flag-chip", st.flag === f && "active"], onclick: () => ((st.flag = st.flag === f ? "" : f), drawTools(), fetchRows()) }, badge(String(flagCount[f]), flagCount[f] ? tone : "neutral"), label)),
          ),
          { sub: "点一项只看这一类" },
        ),
        panel("客户端版本（在用设备）", hbars(Object.entries(versions).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v, n]) => ({ label: v, value: n })), { format: (v) => `${v} 台`, empty: "没有在用设备" })),
      ),
    );
    clear(box, deviceTable(list, { state: st.table, after: fetchRows, empty: rows.length ? "没有符合条件的设备" : "还没有设备" }));
  };
  const tSel = selectEl([["", "全部律所"]], st.tid, (v) => ((st.tid = v), fetchRows()), { "aria-label": "律所" });
  tenantOptions().then((opts) => {
    clear(tSel, opts.map(([v, l]) => h("option", { value: v }, l)));
    tSel.value = st.tid;
  });
  const segs = h("span", { class: "toolbar-group" });
  const drawTools = () =>
    clear(
      segs,
      segmented([{ id: "active", label: "在用" }, { id: "revoked", label: "已吊销" }, { id: "", label: "全部" }], st.status, (v) => ((st.status = v), drawTools(), fetchRows()), "状态"),
      segmented([{ id: "", label: "全部标记" }, ...Object.entries(DEVICE_FLAG).map(([id, [label]]) => ({ id, label }))], st.flag, (v) => ((st.flag = v), drawTools(), fetchRows()), "异常标记"),
    );
  drawTools();
  tools.append(segs, tSel, searchInput({ placeholder: "设备编号、邮箱、版本", value: st.q, onInput: (v) => ((st.q = v), draw()) }));
  fetchRows();
}
