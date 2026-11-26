/**
 * 我的 · 我的电脑（成员账号）。第 71 批（V45）与第二轮（12 / 13）：
 *   - 顶部一张“同时登录”计量卡：登录中 x / 上限 n，满了标橙并直接提示“要在新电脑登录，先让一台退出登录”（满了时“让一台退出登录”是主按钮）；
 *   - 换电脑的说法与律师端一致：个人账号直接登录、满额时自己选让哪台退出；律所成员新电脑需律所管理员批准；
 *   - 电脑表与平台、本所同一样式：名称（没起名时“我的 Mac”这类派生名）+ 编号，系统按上报显示，版本没上报写“未上报版本”；
 *     状态四态：登录中 / 已退出登录 / 待批准 / 已移除；行尾“…”：退出登录（不是本机时）、改名、移除（危险确认，要输密码）。
 * 接口：GET /v1/auth/me（devices、personal）；POST /v1/auth/devices/{id}/signout；PUT /v1/auth/devices/{id}/name；POST /v1/auth/devices/{id}/unbind {password}。
 */
import * as api from "../api.js";
import { ctx, deviceCell, deviceLabel, deviceState, deviceStateCell, pageHead, platformText, versionText } from "../domain.js";
import { btn, confirmAction, dataTable, fmt, h, load, mono, panel, rowMenu, toast } from "../ui.js";

export function render(page) {
  page.append(pageHead("我的电脑", "用本账号登录过的电脑"));
  const box = h("div", { class: "stack" });
  page.append(box);
  const reload = () => load(box, () => api.auth.me(), (me) => ((ctx.me = { ...ctx.me, ...me }), draw(box, me, reload)), "正在读取电脑…");
  reload();
}

function draw(box, me, reload) {
  // 第五轮：“最近在线”用这台电脑上桌面登录的最近活动时刻（精确到分钟）；没有登录会话时退回按日报到
  const lastActive = (id) => (me.sessions ?? []).filter((s) => s.device_id === id && s.last_seen_at).map((s) => s.last_seen_at).sort().at(-1) ?? null;
  const rows = (me.devices ?? []).map((d) => ({ ...d, member_name: "我", last_active_at: d.last_active_at ?? lastActive(d.device_id) ?? d.signed_out_at ?? null }));
  const live = rows.filter((d) => deviceState(d) !== "revoked");
  const on = live.filter((d) => deviceState(d) === "signed_in");
  const limit = Number(me.account?.device_limit) || 0;
  const full = limit > 0 && on.length >= limit;
  const personal = me.personal === true;
  const signout = async (d) => {
    const r = await confirmAction({
      title: "让这台电脑退出登录",
      lead: h("p", {}, h("b", {}, deviceLabel(d)), h("span", { class: "muted" }, " · ", mono(d.device_id))),
      consequences: ["这台电脑上的登录立即失效，腾出一个“同时登录”的名额；", "电脑上的资料保留，之后在那台电脑上重新登录即可继续用；", "不移除这台电脑。"],
      confirmLabel: "退出登录",
      run: () => api.post(`/v1/auth/devices/${api.seg(d.device_id)}/signout`),
    });
    if (r) (toast("已退出登录"), reload());
  };
  const rename = async (d) => {
    const r = await confirmAction({
      title: "给电脑起个名字",
      fields: [{ name: "name", label: "名称", value: d.name ?? "", maxlength: 24, placeholder: "如：办公室笔记本", hint: "换电脑、电脑数满了要选一台时，靠名字认出是哪一台；留空 = 不起名" }],
      confirmLabel: "保存",
      run: (v) => api.put(`/v1/auth/devices/${api.seg(d.device_id)}/name`, { name: (v.name ?? "").trim() }),
    });
    if (r) (toast("已保存"), reload());
  };
  const unbind = async (d) => {
    const r = await confirmAction({
      title: "移除这台电脑",
      danger: true,
      lead: h("p", {}, h("b", {}, deviceLabel(d)), h("span", { class: "muted" }, " · ", mono(d.device_id))),
      consequences: [
        "这台电脑立即不能再用本账号调用 AI，上面的登录一并退出；",
        "电脑上的本地事项与材料不会被删除；",
        personal ? "不可撤销：要再用这台电脑，重新登录即可，会作为一台新电脑登记。" : "不可撤销：要再用这台电脑，须重新登录并由律所管理员批准。",
        "只想腾出名额、以后还要用，请选“退出登录”。",
      ],
      fields: [{ name: "password", label: "输入你的密码以确认", type: "password", required: true, autocomplete: "current-password" }],
      confirmLabel: "移除这台电脑",
      run: (v) => api.auth.unbindDevice(d.device_id, v.password),
    });
    if (r) (toast("已移除"), reload());
  };
  const others = on.filter((d) => !d.current);
  const pickSignout = async () => {
    if (others.length === 1) return signout(others[0]);
    const v = await confirmAction({ title: "让哪台电脑退出登录？", fields: [{ name: "id", label: "电脑", type: "radio", options: others.map((d) => [d.device_id, deviceLabel(d), `${platformText(d.platform)} · 最近在线 ${d.last_seen_on ? fmt.ago(d.last_seen_on) : "从未在线"}`]), value: others[0]?.device_id }], confirmLabel: "下一步" });
    const d = v && others.find((x) => x.device_id === v.id);
    if (d) signout(d);
  };
  box.append(
    // 顶部计量卡：数字、是否满、换电脑怎么做，放在一张卡里（第二轮 12 / 13）
    h(
      "section",
      { class: ["panel", "seat-card", full && "tone-warn"] },
      h(
        "div",
        { class: "seat-card-main" },
        h("div", { class: "seat-card-num" }, h("span", { class: "stat-label" }, "同时登录的电脑"), h("span", { class: "stat-value num" }, `${on.length} / ${limit || "—"}`, full ? h("span", { class: "badge tone-warn full-tag" }, "已满") : null), h("span", { class: "stat-sub" }, `已登记 ${live.length} 台。只有登录中的电脑占名额；退出登录后名额立即空出`)),
        h(
          "div",
          { class: "seat-card-text" },
          full ? h("b", { class: "tone-text-warn" }, "要在新电脑上登录，先让一台退出登录。") : null,
          h("p", { class: "muted small" }, personal ? "换电脑：在新电脑上直接登录即可；同时登录的电脑数达到上限时，由你选择让哪台退出登录。不再使用或丢失的电脑请移除。" : me.account?.role === "admin" || ctx.firmRole === "admin" ? "换电脑：在新电脑上登录提交申请 → 回到这台电脑批准 → 新电脑打开时会请你选择让哪台退出登录。不再使用或丢失的电脑请移除。" : "换电脑：在新电脑上登录后，需律所管理员批准才能使用。不再使用或丢失的电脑请移除。"),
        ),
        full && others.length ? btn(others.length === 1 ? `让「${deviceLabel(others[0])}」退出登录…` : "让一台退出登录…", pickSignout, { kind: "primary" }) : null,
      ),
    ),
    panel(
      null,
      dataTable({
        rows,
        state: { sort: "state", asc: true },
        empty: "还没有登记电脑：在客户端用本账号登录后出现在这里",
        rowClass: (d) => (deviceState(d) === "revoked" ? "dim" : ""),
        caption: "我的电脑",
        columns: [
          { key: "name", label: "电脑", class: "col-device", value: (d) => deviceLabel(d), render: (d) => h("div", { class: "cell-row" }, deviceCell({ ...d, member_name: "我" }), d.current ? h("span", { class: "kind-tag" }, "本机") : null) },
          { key: "platform", label: "系统", class: "col-sys", value: (d) => platformText(d.platform) },
          { key: "client_version", label: "客户端", class: "col-ver", render: (d) => (d.client_version && d.client_version !== "legacy" ? mono(d.client_version) : h("span", { class: "muted" }, versionText(d.client_version))) },
          { key: "last_seen_on", label: "最近在线", class: "col-time", value: (d) => d.last_seen_on ?? "", render: (d) => (d.last_active_at ? h("span", { title: fmt.full(d.last_active_at) }, fmt.ago(d.last_active_at)) : h("span", { title: fmt.full(d.last_seen_on) }, d.last_seen_on ? fmt.ago(d.last_seen_on) : "从未在线")) },
          { key: "registered_at", label: "登记于", class: "col-time", value: (d) => d.registered_at ?? "", render: (d) => fmt.date(d.registered_at) },
          { key: "state", label: "状态", class: "col-state", value: (d) => ({ signed_in: 0, pending: 1, signed_out: 2, revoked: 3 })[deviceState(d)], render: (d) => deviceStateCell(d) },
          {
            key: "_act",
            label: "",
            sortable: false,
            class: "act",
            render: (d) =>
              deviceState(d) === "revoked"
                ? null
                : rowMenu([
                    deviceState(d) === "signed_in" && !d.current ? { label: "退出登录…", onClick: () => signout(d) } : null,
                    { label: d.name ? "改名…" : "起个名字…", onClick: () => rename(d) },
                    { label: "移除这台电脑…", danger: true, onClick: () => unbind(d) },
                  ], { aria: `操作：${deviceLabel(d)}` }),
          },
        ],
      }),
      { flush: true },
    ),
  );
}
