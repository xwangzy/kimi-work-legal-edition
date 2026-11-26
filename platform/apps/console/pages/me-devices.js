/**
 * 我的 · 我的电脑（成员账号）：本账号登记的电脑、客户端版本、最近报到、是否在线；解绑（要再输一次密码）。
 * 接口：GET /v1/auth/me 的 devices；POST /v1/auth/devices/{id}/unbind {password}（契约 §3.1）。
 */
import * as api from "../api.js";
import { ctx, pageHead } from "../domain.js";
import { badge, btn, confirmAction, dataTable, fmt, h, load, mono, panel, toast } from "../ui.js";

export function render(page) {
  page.append(pageHead("我的电脑", "用本账号登录并完成入组的 Windows 电脑"));
  const box = h("div", { class: "stack" });
  page.append(box);
  const reload = () => load(box, () => api.auth.me(), (me) => ((ctx.me = { ...ctx.me, ...me }), draw(box, me, reload)), "正在读取电脑…");
  reload();
}

function draw(box, me, reload) {
  const rows = me.devices ?? [];
  const live = rows.filter((d) => !d.revoked_at);
  const limit = me.account?.device_limit;
  const unbind = async (d) => {
    const r = await confirmAction({
      title: "解绑这台电脑",
      danger: true,
      lead: h("p", {}, mono(d.device_id)),
      consequences: [
        "这台电脑立即停用：不能再用本账号调用 AI，绑在它上面的登录一并退出；",
        "电脑上的本地事项与材料不会被删除；",
        "不可撤销：要再用这台电脑，须重新登录并由律所管理员在其电脑上批准入组。",
      ],
      fields: [{ name: "password", label: "输入你的密码以确认", type: "password", required: true, autocomplete: "current-password" }],
      confirmLabel: "解绑",
      run: (v) => api.auth.unbindDevice(d.device_id, v.password),
    });
    if (r) (toast("已解绑"), reload());
  };
  box.append(
    h("p", { class: "period-line" }, `在用 ${live.length} 台${limit ? `，本账号至多 ${limit} 台` : ""}。换电脑：先在新电脑上登录提交入组申请，由律所管理员批准；不再使用的电脑请解绑。`),
    panel(
      null,
      dataTable({
        rows,
        state: { sort: "last_seen_on", asc: false },
        empty: "还没有登记电脑：在 Windows 客户端用本账号登录并完成入组后出现在这里",
        rowClass: (d) => (d.revoked_at ? "dim" : ""),
        columns: [
          { key: "device_id", label: "电脑编号", render: (d) => h("span", { class: "badges" }, d.name ? h("b", {}, d.name) : null, mono(d.device_id), d.current ? badge("本次登录所用", "accent") : null) },
          { key: "client_version", label: "客户端", render: (d) => mono(d.client_version ?? "—") },
          { key: "last_seen_on", label: "最近报到", render: (d) => h("span", { title: fmt.full(d.last_seen_on) }, fmt.ago(d.last_seen_on)) },
          { key: "registered_at", label: "登记于", render: (d) => fmt.date(d.registered_at) },
          { key: "session", label: "登录", render: (d) => (d.session === "active" || d.session === true ? badge("在线", "ok") : badge("无登录", "neutral")) },
          { key: "revoked_at", label: "状态", value: (d) => (d.revoked_at ? 1 : 0), render: (d) => (d.revoked_at ? badge(`已停用 ${fmt.date(d.revoked_at)}`, "neutral") : badge("在用", "ok")) },
          { key: "_act", label: "", sortable: false, class: "act", render: (d) => (d.revoked_at ? null : btn("解绑", () => unbind(d), { size: "sm", kind: "danger" })) },
        ],
      }),
    ),
  );
}
