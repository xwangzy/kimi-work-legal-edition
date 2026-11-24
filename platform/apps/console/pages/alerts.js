/**
 * 告警（第 62 批从“套餐与额度”的第三个分页签提成一级页面，侧栏带未确认数）：未确认 / 全部（最近 500 条）、按类型筛、就地确认。
 * 接口：GET /v1/ops/alerts?status=open|all&limit、POST /v1/ops/alerts/{id}/ack（契约 §8；读要 tenant.read）。
 */
import * as api from "../api.js";
import { ALERT_KIND, ALERT_LEVEL, alertList, ctx, pageHead } from "../domain.js";
import { clear, h, load, note, segmented } from "../ui.js";

const st = { status: "open", kind: "", level: "" };

export function render(page, r) {
  if (r.params.status === "all" || r.params.status === "open") st.status = r.params.status;
  if (r.params.kind !== undefined) st.kind = r.params.kind;
  const tools = h("div", { class: "toolbar" });
  const list = h("div");
  page.append(
    pageHead("告警", "跨过额度阈值、到上限、用完、用量异常、上游不可用、设备异常"),
    tools,
    list,
    note("告警由控制面在入账与健康回报时生成；确认只表示“已有人看过”，不改变律所状态。处理办法在各律所详情与“模型与路由”里。"),
  );
  let rows = [];
  const drawTools = () => {
    const kinds = new Map();
    for (const a of rows) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
    clear(
      tools,
      segmented([{ id: "open", label: "未确认" }, { id: "all", label: "全部（最近 500 条）" }], st.status, (v) => ((st.status = v), reload()), "范围"),
      segmented([{ id: "", label: "全部类型", count: rows.length }, ...Object.entries(ALERT_KIND).map(([id, label]) => ({ id, label, count: kinds.get(id) ?? 0 }))], st.kind, (v) => ((st.kind = v), drawTools(), drawList()), "类型"),
      segmented([{ id: "", label: "全部级别" }, ...Object.entries(ALERT_LEVEL).map(([id, [label]]) => ({ id, label }))], st.level, (v) => ((st.level = v), drawTools(), drawList()), "级别"),
    );
  };
  const drawList = () => clear(list, alertList(rows.filter((a) => (!st.kind || a.kind === st.kind) && (!st.level || a.level === st.level)), { onAck: reload }));
  const reload = () =>
    load(
      list,
      () => api.get("/v1/ops/alerts", { status: st.status, limit: st.status === "all" ? 500 : 100 }),
      (d) => {
        rows = d.alerts ?? [];
        if (st.status === "open") ctx.setNavBadge?.("alerts", rows.length);
        drawTools();
        drawList();
      },
      "正在读取告警…",
    );
  drawTools();
  reload();
}
