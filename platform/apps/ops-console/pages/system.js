/**
 * 系统：部署信息、运营名册（只读）、运营访问记录、客户端版本分布、邮件通道状态。
 * 接口：GET /v1/ops/system（契约 §9）、GET /v1/ops/settings 的 mail（契约 §8）。
 */
import * as api from "../api.js";
import { ctx, pageHead } from "../domain.js";
import { badge, clear, dataTable, facts, fmt, h, hbars, load, matches, mono, panel, searchInput } from "../ui.js";

const st = { q: "", log: { sort: "at", asc: false }, roster: { sort: "id", asc: true } };

export function render(page) {
  const box = h("div", { class: "stack" });
  page.append(pageHead("系统", "部署、运营名册与访问记录（只读）"), box);
  load(
    box,
    async () => {
      const [s, set] = await Promise.allSettled([api.get("/v1/ops/system"), api.get("/v1/ops/settings")]);
      if (s.status === "rejected") throw s.reason;
      return { s: s.value, mail: set.status === "fulfilled" ? set.value.mail ?? null : undefined };
    },
    ({ s, mail }) => draw(box, s, mail),
    "正在读取系统信息…",
  );
}

function draw(box, s, mail) {
  const cfg = api.config();
  const roster = s.roster ?? {};
  const expDays = roster.expires_at ? Math.floor((Date.parse(roster.expires_at) - Date.now()) / 86_400_000) : null;
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
          { key: "operator", label: "运营", render: (x) => h("span", {}, mono(x.operator), x.operator === ctx.operatorId ? badge("我", "accent") : null) },
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
          ["网关路由公钥", cfg.routing_public_key ? h("span", {}, badge("已配", "ok"), " ", mono(cfg.routing_key_id ?? "缺编号")) : badge("未配：上游密钥不能提交", "warn")],
        ]),
      ),
      panel(
        "运营名册",
        facts([
          ["版本", mono(String(roster.version ?? "—"))],
          ["到期", h("span", {}, fmt.full(roster.expires_at), expDays !== null && expDays < 30 ? badge(expDays < 0 ? "已过期" : `${expDays} 天后到期`, expDays < 7 ? "danger" : "warn") : null)],
          ["人数", fmt.int((roster.operators ?? []).length)],
        ]),
        { sub: "由安全管理员签名；本页只读" },
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
      { class: "grid-2-1" },
      panel(
        "运营人员",
        dataTable({
          state: st.roster,
          rows: roster.operators ?? [],
          empty: "名册为空",
          columns: [
            { key: "id", label: "运营编号", render: (o) => h("span", {}, mono(o.id), o.id === ctx.operatorId ? badge("我", "accent") : null) },
            { key: "perms", label: "权限", sortable: false, render: (o) => h("span", { class: "badges wrap" }, (o.perms ?? []).map((p) => mono(p))) },
            { key: "keys", label: "密钥", sortable: false, render: (o) => (Array.isArray(o.keys) ? h("span", { class: "badges" }, o.keys.map((k) => mono(typeof k === "string" ? k : k.kid ?? JSON.stringify(k)))) : fmt.int(o.keys)) },
          ],
        }),
      ),
      h("div", { class: "stack" }, panel("客户端版本分布", hbars(versions.map(([v, n]) => ({ label: v, value: n })), { format: (v) => `${fmt.int(v)} 台`, empty: "还没有设备报到" })), s.quota_counters ? panel("额度计数", hbars(Object.entries(s.quota_counters).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ label: k, value: n })), { format: (v) => fmt.int(v), empty: "还没有计数" }), { sub: "进程启动以来的租约与回报次数" }) : null),
    ),
    panel("运营访问记录", logBox, { sub: "最近 100 条；先记审计再执行", actions: searchInput({ placeholder: "筛选动作、运营、律所", value: st.q, onInput: (v) => ((st.q = v), drawLog()) }) }),
  );
}
