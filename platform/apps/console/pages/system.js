/**
 * 系统：部署信息、身份与安全策略（注册方式、客户端最低版本）、平台访问记录、客户端版本分布、邮件通道状态。
 * 接口：GET /v1/ops/system（system.read）、GET /v1/ops/settings（mail、clients.min_version）。
 * 第 46 批：运营名册不再用于控制台登录（统一账号，契约 §2.4），本页不再列名册；人员在“人员与权限”管理。
 */
import * as api from "../api.js";
import { can, go, isMe, pageHead } from "../domain.js";
import { badge, btn, clear, dataTable, facts, fmt, h, hbars, load, matches, mono, panel, searchInput } from "../ui.js";

const st = { q: "", log: { sort: "at", asc: false } };

export function render(page) {
  const box = h("div", { class: "stack" });
  page.append(pageHead("系统", "部署、身份与安全策略、平台访问记录（只读）"), box);
  load(
    box,
    async () => {
      const [s, set] = await Promise.allSettled([api.get("/v1/ops/system"), api.get("/v1/ops/settings")]);
      if (s.status === "rejected") throw s.reason;
      return { s: s.value, set: set.status === "fulfilled" ? set.value : undefined, mail: set.status === "fulfilled" ? set.value.mail ?? null : undefined };
    },
    ({ s, set, mail }) => draw(box, s, mail, set),
    "正在读取系统信息…",
  );
}

function draw(box, s, mail, set) {
  const cfg = api.config();
  const versions = Object.entries(s.client_versions ?? {}).sort((a, b) => b[1] - a[1]);
  const logBox = h("div");
  const drawLog = () =>
    clear(
      logBox,
      dataTable({
        state: st.log,
        rows: (s.access_log ?? []).filter((x) => matches(st.q, x.action, x.operator, x.tid, x.target, x.result)),
        empty: "没有访问记录",
        columns: [
          { key: "at", label: "时间", render: (x) => fmt.full(x.at) },
          { key: "operator", label: "人员", render: (x) => h("span", { class: "cell-2" }, h("span", {}, x.operator_email ?? x.email ?? mono(x.operator), isMe(x.operator) || isMe(x.operator_email) ? badge("我", "accent") : null), x.operator_email || x.email ? mono(x.operator) : null) },
          { key: "action", label: "动作", render: (x) => mono(x.action) },
          { key: "tid", label: "律所", render: (x) => mono(x.tid ?? "—") },
          { key: "target", label: "对象", render: (x) => mono(x.target ?? "—") },
          { key: "result", label: "结果", render: (x) => badge(String(x.result ?? "—"), x.result === "ok" ? "ok" : x.result === "denied" ? "danger" : "warn") },
        ],
      }),
    );
  drawLog();
  clear(
    box,
    h(
      "div",
      { class: "grid-3" },
      panel(
        "部署",
        facts([
          ["部署标识", mono(s.deployment ?? "—")],
          ["控制面版本", mono(s.server_version ?? "—")],
          ["启动于", fmt.full(s.started_at)],
          ["控制面地址", mono(cfg.control_plane_base)],
          ["控制台配置", `${cfg.label || "—"} · ${cfg.deployment}`],
          ["账本", s.usage_book ? `已载入 ${fmt.int(s.usage_book.rows_loaded)} 行${s.usage_book.load_errors ? `，${fmt.int(s.usage_book.load_errors)} 行读不出` : ""}` : "—"],
          ["网关路由公钥", can("route.read") ? h("button", { type: "button", class: "link", onclick: () => go("ops/routing") }, "在“模型与路由”核对指纹") : "由控制面下发（需查看路由权限）"],
        ]),
      ),
      panel(
        "身份与安全",
        set === undefined
          ? h("p", { class: "muted small" }, "设置接口未就绪或无权查看，读不到策略。")
          : facts([
              ["注册方式", { open: badge("开放自助注册", "warn"), code: badge("凭码注册", "ok"), closed: badge("关闭", "neutral") }[set.registration] ?? "—"],
              ["客户端最低版本", mono(set.clients?.min_version ?? set.min_client_version ?? "不限")],
            ]),
        { sub: "改动在“套餐与额度 → 注册设置”", actions: can("staff.manage") ? btn("人员与权限", () => go("ops/staff"), { size: "sm" }) : null },
      ),
      panel(
        "邮件通道",
        mail === undefined
          ? h("p", { class: "muted small" }, "注册设置接口未就绪，读不到邮件通道状态。")
          : facts([["状态", mail?.configured ? badge("已配置", "ok") : badge("未配置", "warn")], ["发件地址", mail?.from ?? "—"]]),
        { sub: "未配置时忘记密码不真发码" },
      ),
    ),
    h(
      "div",
      { class: "grid-2" },
      h("div", { class: "stack" }, panel("客户端版本分布", hbars(versions.map(([v, n]) => ({ label: v, value: n })), { format: (v) => `${fmt.int(v)} 台`, empty: "还没有设备报到" })), s.quota_counters ? panel("额度计数", hbars(Object.entries(s.quota_counters).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ label: k, value: n })), { format: (v) => fmt.int(v), empty: "还没有计数" }), { sub: "进程启动以来的租约与回报次数" }) : null),
    ),
    panel("平台访问记录", logBox, { sub: "最近 100 条；先记审计再执行", actions: searchInput({ placeholder: "筛选动作、人员、律所", value: st.q, onInput: (v) => ((st.q = v), drawLog()) }) }),
  );
}
