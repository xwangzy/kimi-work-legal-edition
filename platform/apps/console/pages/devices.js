/**
 * 电脑（第 71 批 V45：原“设备”）：所有客户登记的电脑——机队巡检（30 天没在线、低于最低版本、未登录）与按名称、编号查找。
 * 第二轮（07）：状态四态（登录中 / 已退出登录 / 待批准 / 已移除），待批准的新电脑也列出；“未移除”只作筛选；
 *   两组筛选各带标签与计数；客户筛选可输入；成员列显示姓名；没起名的电脑显示“某某的 Mac”这类派生名；“标记”列没有标记时不出现。
 * 接口：GET /v1/ops/devices?tid（account.read；应答 devices + pending）；行尾“让它退出登录”“移除这台电脑”。
 */
import * as api from "../api.js";
import { DEVICE_FLAG, deviceState, deviceTable, pageHead, pendingRow, tenantOptions, unconfirmed, versionText, wsKindOfTid } from "../domain.js";
import { clear, errorBlock, fold, h, hbars, loadingBlock, matches, searchInput, segmented } from "../ui.js";

const st = { tid: "", status: "live", flag: "", q: "", table: { sort: "state", asc: true } };
const STATUS = [
  ["live", "未移除", (d) => deviceState(d) !== "revoked"],
  ["signed_in", "登录中", (d) => deviceState(d) === "signed_in"],
  ["signed_out", "已退出登录", (d) => deviceState(d) === "signed_out"],
  ["pending", "待批准登录", (d) => deviceState(d) === "pending"],
  ["confirm", "待确认共享", (d) => unconfirmed(d) && wsKindOfTid(d.tid, d.tenant_name) === "team"],
  ["revoked", "已移除", (d) => deviceState(d) === "revoked"],
  ["", "全部", () => true],
];

export function render(page, r) {
  if (r.params.tid !== undefined) st.tid = r.params.tid;
  if (r.params.flag !== undefined) st.flag = DEVICE_FLAG[r.params.flag] ? r.params.flag : "";
  if (r.params.q !== undefined) st.q = r.params.q;
  if (r.params.status !== undefined) st.status = STATUS.some(([id]) => id === r.params.status) ? r.params.status : r.params.status === "active" ? "live" : "live";
  const tools = h("div", { class: "toolbar" });
  const tools2 = h("div", { class: "toolbar" });
  const box = h("div");
  const versionsBox = h("div");
  // 第 72 批（D-306 第 4 条）：跨客户查找入口，页头写明范围；日常操作在组织详情与用户详情里（行内“成员”进用户详情、“客户”进组织详情）
  page.append(pageHead("电脑", h("span", {}, h("b", {}, "范围：所有工作空间的电脑。"), "用来巡检和按名称、编号查是谁的电脑；日常处理在组织详情与用户详情里")), tools, tools2, box, versionsBox);
  let rows = [];
  let seq = 0;
  const fetchRows = async () => {
    const my = ++seq;
    clear(box, loadingBlock("正在读取电脑…"));
    try {
      const [res] = await Promise.all([api.get("/v1/ops/devices", { tid: st.tid }), tenantOptions().catch(() => null)]);
      if (my !== seq) return;
      rows = [...(res.devices ?? []), ...(res.pending ?? []).map((j) => pendingRow(j))];
      draw();
    } catch (e) {
      if (my === seq) clear(box, errorBlock(e, fetchRows));
    }
  };
  const draw = () => {
    const sf = STATUS.find(([id]) => id === st.status)?.[2] ?? (() => true);
    const ofStatus = rows.filter(sf);
    const list = ofStatus.filter((d) => (!st.flag || (d.flags ?? []).includes(st.flag)) && matches(st.q, d.device_id, d.name, d.member_name, d.email, d.tenant_name, d.client_version));
    clear(tools, h("span", { class: "seg-label" }, "状态"), segmented(STATUS.map(([id, label, f]) => ({ id, label, count: rows.filter(f).length })), st.status, (v) => ((st.status = v), draw()), "状态"));
    clear(tools2.querySelector(".flag-group") ?? tools2.appendChild(h("span", { class: "flag-group" })), h("span", { class: "seg-label" }, "标记"), segmented([{ id: "", label: "不限", count: ofStatus.length }, ...Object.entries(DEVICE_FLAG).filter(([f]) => f !== "suspended").map(([f, [label]]) => ({ id: f, label, count: ofStatus.filter((d) => (d.flags ?? []).includes(f)).length }))], st.flag, (v) => ((st.flag = v), draw()), "异常标记"));
    clear(box, deviceTable(list, { state: st.table, after: fetchRows, memberLabel: "用户", team: (d) => wsKindOfTid(d.tid, d.tenant_name) === "team", confirmHint: "由团队管理员在管理员电脑上确认", empty: rows.length ? "没有符合条件的电脑" : "还没有登记的电脑。律师在客户端登录后，电脑会出现在这里。" }));
    const versions = {};
    for (const d of rows) if (!["revoked", "pending"].includes(deviceState(d))) versions[versionText(d.client_version)] = (versions[versionText(d.client_version)] ?? 0) + 1;
    const vs = Object.entries(versions).sort((a, b) => b[1] - a[1]);
    // 只有一个版本时不单列一张卡，写一行即可
    clear(versionsBox, vs.length > 1 ? h("div", { class: "panel flush" }, fold("客户端版本分布", "在用电脑，前 6 个版本", hbars(vs.slice(0, 6).map(([v, n]) => ({ label: v, value: n })), { format: (v) => `${v} 台` }))) : vs.length === 1 ? h("p", { class: "muted small" }, `在用电脑都是客户端 ${vs[0][0]}（${vs[0][1]} 台）`) : null);
  };
  // 客户筛选：可输入（与账号页一致）
  const dl = h("datalist", { id: "dev-tenant-opts" });
  const tIn = h("input", { type: "search", class: "search", list: "dev-tenant-opts", placeholder: "客户：输入名称或编号", "aria-label": "按客户筛选", value: st.tid, autocomplete: "off" });
  tIn.addEventListener("change", () => {
    const v = tIn.value.trim();
    const m = /（(ten_[A-Za-z0-9_-]+)）$/.exec(v) ?? /^(ten_[A-Za-z0-9_-]+)$/.exec(v);
    st.tid = v ? (m?.[1] ?? st.tid) : "";
    fetchRows();
  });
  tenantOptions().then((opts) => clear(dl, opts.filter(([v]) => v).map(([, l]) => h("option", { value: l })))).catch(() => {});
  tools2.append(searchInput({ placeholder: "电脑名称、编号、成员、版本", value: st.q, onInput: (v) => ((st.q = v), draw()) }), tIn, dl);
  fetchRows();
}
