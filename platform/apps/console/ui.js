/**
 * 统一云端控制台 · 界面小件（第 44 批起；第 46 批加环形水位、额度卡、二维码、验证码输入、无权限空状态）。
 *
 * - h() / svg() 生成 DOM，**不拼 HTML 字符串**（不用 innerHTML 一类接口）：服务端回来的任何字段都只作为文本节点或属性值进入页面；
 * - CSP 为 style-src 'self'：不写 style 属性。动态宽度、位置一律经 cssVars() 写 el.style.cssText 的自定义属性（--w、--l），
 *   由 console.css 取用；值只收数字 + 单位，防止拼进别的样式；
 * - 确认框、抽屉、toast 都是自绘的 <dialog> / 区块，不用浏览器自带的确认、提示、输入框；
 * - 图表手写 SVG（不引外部库），颜色走 console.css 的类名（令牌），深浅主题随 tokens.css 的 data-theme 切换。
 */

const SVGNS = "http://www.w3.org/2000/svg";
const TZ = "Asia/Shanghai";

// ─── DOM ────────────────────────────────────────────────────────────
function setAttrs(el, attrs, isSvg) {
  let value;
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "style") throw new Error("不许 style 属性：动态样式用 cssVars()");
    if (/^on/i.test(k) && typeof v !== "function") throw new Error(`事件属性 ${k} 只收函数`);
    if (k === "class") el.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : String(v));
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (!isSvg && k === "value") value = v;
    else if (!isSvg && (k === "checked" || k === "selected" || k === "indeterminate")) el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  return value;
}
function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
/** h("div", {class, onclick, …}, …子节点)：字符串一律当文本。 */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  const value = setAttrs(el, attrs, false);
  append(el, kids);
  if (value !== undefined) el.value = String(value);
  return el;
}
export function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  setAttrs(el, attrs, true);
  append(el, kids);
  return el;
}
/** 只写自定义属性（--w: 42%），经 el.style.cssText；值必须是数字（可带 % / px）。 */
export function cssVars(el, vars) {
  const parts = [];
  for (const [k, v] of Object.entries(vars)) {
    const s = typeof v === "number" ? (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : "0") : String(v);
    if (!/^--[a-z][a-z0-9-]*$/.test(k) || !/^-?[0-9.]+(%|px)?$/.test(s)) throw new Error(`cssVars 只收数字：${k}`);
    parts.push(`${k}:${s}`);
  }
  el.style.cssText = parts.join(";");
  return el;
}
export const $ = (s, el = document) => el.querySelector(s);
export const clear = (el, ...kids) => (el.replaceChildren(), append(el, kids), el);
/** 追加子节点：跳过 null / undefined / 布尔（原生 el.append(null) 会把“null”当文本写进页面） */
export const add = (el, ...kids) => (append(el, kids), el);

// ─── 格式 ───────────────────────────────────────────────────────────
const isNum = (n) => n !== null && n !== undefined && n !== "" && Number.isFinite(Number(n));
export const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const dtf = (o) => new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, hour12: false, ...o });
const F_DATE = dtf({ year: "numeric", month: "2-digit", day: "2-digit" });
const F_TIME = dtf({ month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const F_FULL = dtf({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const F_CLOCK = dtf({ hour: "2-digit", minute: "2-digit", second: "2-digit" });
const parts = (f, t) => Object.fromEntries(f.formatToParts(t).map((p) => [p.type, p.value]));
const validTime = (iso) => {
  if (!iso) return null;
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export const fmt = {
  /** 整数 / 带千分位；缺 = “—” */
  int: (n) => (isNum(n) ? Math.round(Number(n)).toLocaleString("zh-CN") : "—"),
  num: (n, d = 2) => (isNum(n) ? Number(n).toLocaleString("zh-CN", { maximumFractionDigits: d }) : "—"),
  /** token 数：万 / 亿缩写（精确值放在 title 里） */
  tokens(n) {
    if (!isNum(n)) return "—";
    const v = Number(n);
    const a = Math.abs(v);
    if (a >= 1e8) return `${(v / 1e8).toFixed(a >= 1e10 ? 0 : 2).replace(/\.?0+$/, "")} 亿`;
    if (a >= 1e4) return `${(v / 1e4).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, "")} 万`;
    return Math.round(v).toLocaleString("zh-CN");
  },
  /** 金额（元）：null = 未定价（契约：不显示 0）；undefined = 没给 */
  cny(v, d = 2) {
    if (v === null) return "未定价";
    if (!isNum(v)) return "—";
    return `¥${Number(v).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  },
  /** 单价（元 / 百万 token） */
  price: (v) => (v === null ? "未定价" : isNum(v) ? `¥${Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 4 })}` : "—"),
  /** 比例 → 百分比：<0.1% 不写 0；10% 以下一位小数 */
  pct(r) {
    if (!isNum(r)) return "—";
    const p = Number(r) * 100;
    if (p > 0 && p < 0.1) return "<0.1%";
    return `${p < 10 ? (Math.round(p * 10) / 10).toFixed(1).replace(/\.0$/, "") : Math.round(p)}%`;
  },
  /**
   * 剩余比例 → 百分比（第 47 批，与客户端 fmtLeft 同一规则）：往下取，已经用了一点就不写“剩余 100%”（原来 99.7% 四舍五入成 100%，与“已用 0.3%”自相矛盾）
   */
  left(r) {
    if (!isNum(r)) return "—";
    // 先按千分之一个百分点规整（0.58 × 100 = 57.999…，直接往下取会成 57%）
    const p = Math.round(Number(r) * 1e5) / 1e3;
    if (p >= 100) return "100%";
    if (p > 0 && p < 0.1) return "<0.1%";
    return `${p < 10 ? (Math.floor(p * 10) / 10).toFixed(1).replace(/\.0$/, "") : Math.floor(p)}%`;
  },
  /** 额度单位下的量：tokens = 整数 token；cny = 元 */
  amount(v, unit) {
    if (!isNum(v)) return "—";
    return unit === "cny" ? fmt.cny(v) : `${fmt.tokens(v)} token`;
  },
  unit: (u) => (u === "cny" ? "金额（元）" : u === "tokens" ? "token" : "—"),
  date(iso) {
    const t = validTime(iso);
    if (t === null) return "—";
    const p = parts(F_DATE, t);
    return `${p.year}-${p.month}-${p.day}`;
  },
  time(iso) {
    const t = validTime(iso);
    if (t === null) return "—";
    const p = parts(F_TIME, t);
    return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
  },
  full(iso) {
    const t = validTime(iso);
    if (t === null) return "—";
    const p = parts(F_FULL, t);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  },
  clock: (t) => F_CLOCK.format(t ?? Date.now()),
  /** 相对时间（最近报到、最近登录） */
  ago(iso, now = Date.now()) {
    // 只精确到日的字段（如设备“最近报到”为北京时间日期 2026-11-19）：按日说，不按零点折算成“几小时前”
    if (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const today = parts(F_FULL, now);
      const d0 = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day));
      const [y, m, d] = iso.split("-").map(Number);
      const days = Math.round((d0 - Date.UTC(y, m - 1, d)) / 86400000);
      return days <= 0 ? "今天" : days === 1 ? "昨天" : days < 45 ? `${days} 天前` : iso;
    }
    const t = validTime(iso);
    if (t === null) return "—";
    const s = Math.round((now - t) / 1000);
    if (s < 0) return fmt.time(iso);
    if (s < 60) return "刚刚";
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    if (s < 86400 * 45) return `${Math.floor(s / 86400)} 天前`;
    return fmt.date(iso);
  },
  /** “12 月 1 日 0:00”（北京时间；时不补零，与客户端 firm-usage.ts 的 atLabel 同一写法） */
  resets(iso) {
    const t = validTime(iso);
    if (t === null) return null;
    const p = parts(F_TIME, t);
    return `${Number(p.month)} 月 ${Number(p.day)} 日 ${Number(p.hour) % 24}:${p.minute}`;
  },
  /** 周期 {key:"2026-11", start, resets_at} → “2026 年 11 月（11 月 1 日 – 11 月 30 日）”（客户端 periodLabel + periodRange 的写法） */
  period(p) {
    if (!p) return null;
    const m = /^(\d{4})-(\d{2})$/.exec(p.key ?? "");
    const label = m ? `${m[1]} 年 ${Number(m[2])} 月` : p.kind === "week" ? "本周" : "本期";
    const s = validTime(p.start);
    const e = validTime(p.resets_at);
    if (s === null || e === null) return label;
    const a = parts(F_DATE, s);
    const b = parts(F_DATE, e - 1);
    return `${label}（${Number(a.month)} 月 ${Number(a.day)} 日 – ${Number(b.month)} 月 ${Number(b.day)} 日）`;
  },
  /** 重置时刻 → “将于 12 月 1 日 0:00 重置”（客户端 resetLabel 的写法；缺 = “每期开始时重置”） */
  resetLine: (iso) => (validTime(iso) === null ? "每期开始时重置" : `将于 ${fmt.resets(iso)} 重置`),
  ms: (n) => (isNum(n) ? (Number(n) >= 1000 ? `${(Number(n) / 1000).toFixed(1)} s` : `${Math.round(Number(n))} ms`) : "—"),
};
/** 北京时间的“今天”“本月”等（YYYY-MM-DD / YYYY-MM） */
export function bjDay(t = Date.now()) {
  const p = parts(F_DATE, t);
  return `${p.year}-${p.month}-${p.day}`;
}
export const bjMonth = (t = Date.now()) => bjDay(t).slice(0, 7);
export function monthShift(key, n) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ─── 小件：徽标、按钮、提示块 ───────────────────────────────────────
/** tone: ok | warn | danger | info | neutral | accent */
export const badge = (text, tone = "neutral", title) => h("span", { class: `badge tone-${tone}`, title }, text);
export const dot = (tone) => h("span", { class: `dot tone-${tone}`, "aria-hidden": "true" });
export function btn(label, onclick, o = {}) {
  const b = h("button", { type: o.type ?? "button", class: ["btn", o.kind, o.size, o.class], title: o.title, disabled: o.disabled, onclick, "aria-label": o.aria }, o.icon ?? null, label);
  return b;
}
/** 点击时禁用按钮直到完成；出错弹 toast。 */
export async function busy(b, fn) {
  if (b) b.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(errText(e), "error");
    return undefined;
  } finally {
    if (b) b.disabled = false;
  }
}
// 5xx 带上控制面的错误码便于报障；没有错误码（本页按 HTTP 状态合成的 http_500）时不再重复写一遍
export const errText = (e) => (e?.code && !["network", "not_ready", "reauth_cancelled"].includes(e.code) && !/^http_\d+$/.test(e.code) && e.status >= 500 ? `${e.message}（${e.code}）` : String(e?.message ?? e));
export const mono = (text, title) => h("span", { class: "mono", title: title ?? (typeof text === "string" ? text : undefined) }, text ?? "—");

export function loadingBlock(text = "正在读取…") {
  return h("div", { class: "state state-loading", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), text);
}
export function emptyBlock(text, hint) {
  return h("div", { class: "state state-empty" }, h("b", {}, text), hint ? h("p", {}, hint) : null);
}
/** 错误块：404 + not_found = 接口未就绪；403 = 没有权限（空状态，不是报错）；其余如实显示服务端说明。 */
export function errorBlock(e, retry) {
  const notReady = e?.code === "not_ready";
  if (e?.status === 403)
    return h(
      "div",
      { class: "state state-noperm", role: "status" },
      h("span", { class: "state-icon", "aria-hidden": "true" }, icon("lock")),
      h("b", {}, "没有权限查看"),
      // 控制面的说明已经指了去找谁（“请联系系统管理员”“只有本所管理员…”）时不再重复补一句
      h("p", {}, ((m) => (/管理员/.test(m) ? `${m}。` : `${m}。需要的话请找系统管理员调整角色。`))(String(e.message || "你的角色没有这项权限").replace(/[。.]+$/, ""))),
    );
  const title = notReady ? "接口未就绪" : e?.code === "network" ? "连不上控制面" : "读取失败";
  const detail = notReady
    ? `控制面还没有提供 ${e.method ?? "GET"} ${e.pathOnly ?? ""}（HTTP 404）。服务端接口就绪后点“重试”；本页不显示任何替代数据。`
    : errText(e);
  return h(
    "div",
    { class: ["state", notReady ? "state-notready" : "state-error"], role: "alert" },
    h("b", {}, title),
    h("p", {}, detail),
    retry ? btn("重试", retry, { size: "sm" }) : null,
  );
}
/**
 * 读数据并渲染到容器：先显示“正在读取”，成功调 render(data)，失败显示错误块（带重试）。
 * 返回 render 的结果（或 undefined）。
 */
export async function load(box, fetcher, render, text) {
  clear(box, loadingBlock(text));
  try {
    const data = await fetcher();
    if (!box.isConnected && box.dataset.detached !== "keep") return undefined;
    clear(box);
    return render(data);
  } catch (e) {
    clear(box, errorBlock(e, () => load(box, fetcher, render, text)));
    return undefined;
  }
}

// ─── toast ─────────────────────────────────────────────────────────
export function toast(msg, tone = "ok") {
  const region = $("#toasts");
  if (!region) return;
  const t = h("div", { class: `toast tone-${tone}`, role: tone === "error" ? "alert" : "status" }, msg);
  region.append(t);
  setTimeout(() => t.classList.add("leaving"), tone === "error" ? 6000 : 3200);
  setTimeout(() => t.remove(), tone === "error" ? 6400 : 3600);
}

export function copyBtn(text, label = "复制") {
  return btn(label, async (ev) => {
    try {
      await navigator.clipboard.writeText(String(text));
      toast("已复制");
    } catch {
      toast("浏览器不允许写剪贴板：请手动选中复制", "error");
    }
    ev.stopPropagation();
  }, { size: "sm" });
}

// ─── 进度条（百分比四件套：进度条 + 已用/剩余 + 单位 + 重置时间） ────────
/**
 * @param {{ratio?:number|null, used?:number|null, total?:number|null, unit?:string, resetsAt?:string|null, inflight?:number|null,
 *          capPct?:number|null, paused?:string|null, compact?:boolean, label?:string, denominator?:string}} o
 */
export function meter(o) {
  const r = isNum(o.ratio) ? Number(o.ratio) : isNum(o.used) && isNum(o.total) && Number(o.total) > 0 ? Number(o.used) / Number(o.total) : null;
  const limit = isNum(o.capPct) && o.capPct > 0 ? o.capPct / 100 : 1;
  const tone = r === null ? "none" : o.paused || r >= limit ? "full" : r >= limit * 0.8 ? "high" : "ok";
  const bar = h("div", { class: `meter-bar tone-${tone}`, role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": r === null ? undefined : String(Math.round(r * 100)), "aria-label": o.label ?? "已用比例" });
  if (r !== null) bar.append(cssVars(h("span", { class: "meter-fill" }), { "--w": `${clamp01(r) * 100}%` }));
  if (r !== null && isNum(o.inflight) && o.inflight > 0) bar.append(cssVars(h("span", { class: "meter-flight", title: `网关在途 ${fmt.pct(o.inflight)}` }), { "--l": `${clamp01(r) * 100}%`, "--w": `${clamp01(o.inflight) * 100}%` }));
  if (isNum(o.capPct) && o.capPct > 0 && o.capPct < 100) bar.append(cssVars(h("span", { class: "meter-cap", title: `上限 ${o.capPct}%` }), { "--l": `${o.capPct}%` }));
  const unit = o.unit === "cny" ? "元" : o.unit === "tokens" ? "token" : "";
  const amounts = isNum(o.used) ? (isNum(o.total) ? `${fmt.amount(o.used, o.unit)} / ${fmt.amount(o.total, o.unit)}` : `${fmt.amount(o.used, o.unit)} · 不设上限`) : unit ? `单位 ${unit}` : null;
  const resets = o.resetText ? null : fmt.resets(o.resetsAt);
  const remain = r === null ? null : Math.max(0, 1 - r);
  const pausedText = o.paused ? { cap: "已到上限", allowance: "额度用完", burst: "5 小时频率限制已满", seat: "个人额度用完" }[o.paused] ?? "已暂停" : null;
  if (o.compact) {
    const short = isNum(o.used) && isNum(o.total) ? `${o.unit === "cny" ? fmt.cny(o.used, 0) : fmt.tokens(o.used)} / ${o.unit === "cny" ? fmt.cny(o.total, 0) : `${fmt.tokens(o.total)} token`}` : amounts;
    const rs = validTime(o.resetsAt) === null ? null : `${fmt.date(o.resetsAt).slice(5)} 重置`;
    return h(
      "div",
      { class: "meter compact", title: [amounts, resets ? fmt.resetLine(o.resetsAt) : null].filter(Boolean).join(" · ") },
      h("div", { class: "meter-line" }, h("b", { class: `meter-pct tone-${tone}` }, r === null ? "—" : fmt.pct(r)), bar),
      h("div", { class: "meter-sub" }, [pausedText ?? (remain === null ? null : `剩 ${fmt.left(remain)}`), short, rs].filter(Boolean).join(" · ")),
    );
  }
  return h(
    "div",
    { class: "meter" },
    h("div", { class: "meter-head" }, h("span", {}, o.label ?? "已用"), h("b", { class: `meter-pct tone-${tone}` }, r === null ? "—" : fmt.pct(r)), pausedText ? badge(pausedText, "danger") : null, h("span", { class: "meter-remain" }, remain === null ? "" : `剩余 ${fmt.left(remain)}`)),
    bar,
    h("div", { class: "meter-sub" }, [amounts, o.denominator ?? null, o.resetText ?? fmt.resetLine(o.resetsAt)].filter(Boolean).join(" · ")),
  );
}

// ─── 表格：13 号字、数字等宽右对齐、可排序 ─────────────────────────────
/**
 * @param {{columns: {key:string,label:string,num?:boolean,value?:(r:any)=>any,render?:(r:any)=>any,sortable?:boolean,title?:string,class?:string}[],
 *          rows:any[], state?:{sort?:string,asc?:boolean}, onRow?:(r:any)=>void, empty?:string, footer?:any, rowClass?:(r:any)=>string, caption?:string}} o
 */
export function dataTable(o) {
  const st = o.state ?? {};
  const wrap = h("div", { class: "table-wrap" });
  const val = (c, r) => (c.value ? c.value(r) : r?.[c.key]);
  const draw = () => {
    const col = o.columns.find((c) => c.key === st.sort);
    let rows = [...(o.rows ?? [])];
    if (col) {
      const dir = st.asc ? 1 : -1;
      rows.sort((a, b) => {
        const x = val(col, a);
        const y = val(col, b);
        if (x === y) return 0;
        if (x === null || x === undefined || x === "") return 1;
        if (y === null || y === undefined || y === "") return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "zh-CN")) * dir;
      });
    }
    const head = h(
      "tr",
      {},
      o.columns.map((c) => {
        const sortable = c.sortable !== false && !!(c.value || c.key);
        const active = st.sort === c.key;
        const th = h("th", { class: [c.num && "num", c.class], scope: "col", title: c.title, "aria-sort": active ? (st.asc ? "ascending" : "descending") : undefined });
        if (!sortable) th.append(c.label);
        else
          th.append(
            h("button", {
              type: "button",
              class: ["th-sort", active && "active"],
              onclick: () => {
                if (st.sort === c.key) st.asc = !st.asc;
                else Object.assign(st, { sort: c.key, asc: !c.num });
                draw();
              },
            }, c.label, h("span", { class: "sort-mark", "aria-hidden": "true" }, active ? (st.asc ? "↑" : "↓") : "")),
          );
        return th;
      }),
    );
    const body = h("tbody");
    if (!rows.length) body.append(h("tr", { class: "empty-row" }, h("td", { colspan: String(o.columns.length) }, o.empty ?? "没有记录")));
    for (const r of rows) {
      const tr = h("tr", { class: [o.rowClass?.(r), o.onRow && "clickable"], tabindex: o.onRow ? "0" : undefined });
      if (o.onRow) {
        tr.addEventListener("click", (ev) => {
          if (ev.target instanceof Element && ev.target.closest("button, a, input, select, label")) return;
          o.onRow(r);
        });
        tr.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" && ev.target === tr) o.onRow(r);
        });
      }
      for (const c of o.columns) {
        const v = c.render ? c.render(r) : val(c, r);
        tr.append(h("td", { class: [c.num && "num", c.class] }, v === null || v === undefined || v === "" ? "—" : v));
      }
      body.append(tr);
    }
    const foot = o.footer ? h("tfoot", {}, h("tr", {}, o.columns.map((c, i) => h("td", { class: [c.num && "num", c.class] }, o.footer[c.key] ?? (i === 0 ? "合计" : ""))))) : null;
    wrap.replaceChildren(h("table", { class: "tbl" }, o.caption ? h("caption", { class: "sr-only" }, o.caption) : null, h("thead", {}, head), body, foot));
  };
  draw();
  return wrap;
}

/** 过滤：按若干字段做包含匹配（不区分大小写） */
export function matches(q, ...fields) {
  const s = String(q ?? "").trim().toLowerCase();
  if (!s) return true;
  return fields.some((f) => f !== null && f !== undefined && String(f).toLowerCase().includes(s));
}

// ─── 工具条与表单件 ─────────────────────────────────────────────────
export function searchInput({ placeholder, value = "", onInput, delay = 180, aria }) {
  let t = 0;
  const i = h("input", { type: "search", class: "search", placeholder, value, "aria-label": aria ?? placeholder, autocomplete: "off", spellcheck: "false" });
  i.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => onInput(i.value), delay);
  });
  return i;
}
/** 胶囊式分段选择 */
export function segmented(items, active, onChange, aria) {
  const box = h("div", { class: "segmented", role: "radiogroup", "aria-label": aria });
  for (const it of items) {
    box.append(
      h("button", {
        type: "button",
        role: "radio",
        "aria-checked": it.id === active ? "true" : "false",
        class: ["seg", it.id === active && "active"],
        onclick: () => onChange(it.id),
      }, it.label, it.count !== undefined && it.count !== null ? h("span", { class: "seg-count" }, String(it.count)) : null),
    );
  }
  return box;
}
export function selectEl(options, value, onChange, attrs = {}) {
  const s = h("select", { ...attrs, onchange: onChange ? () => onChange(s.value) : undefined }, options.map(([v, label]) => h("option", { value: v }, label)));
  s.value = value ?? "";
  return s;
}
/** 页内分页签（详情页、模型与路由） */
export function tabBar(items, active, onChange) {
  return h(
    "div",
    { class: "tabbar", role: "tablist" },
    items.map((it) => h("button", { type: "button", role: "tab", class: ["tab", it.id === active && "active"], "aria-selected": it.id === active ? "true" : "false", onclick: () => onChange(it.id) }, it.label, it.count ? h("span", { class: "tab-count" }, String(it.count)) : null)),
  );
}

/**
 * 字段：{name, label, type: text|number|select|textarea|checkbox|password|radio|date, value, options, required, min, max, step,
 *        placeholder, hint, pattern, disabled, autocomplete, maxlength}
 */
export function field(f) {
  const id = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
  let input;
  if (f.type === "select") input = selectEl(f.options ?? [], f.value, null, { id, name: f.name, required: f.required, disabled: f.disabled });
  else if (f.type === "textarea") input = h("textarea", { id, name: f.name, rows: f.rows ?? 3, required: f.required, placeholder: f.placeholder, maxlength: f.maxlength, disabled: f.disabled, value: f.value ?? "" });
  else if (f.type === "checkbox")
    return h("label", { class: ["field", "field-check", f.class] }, h("input", { type: "checkbox", name: f.name, checked: !!f.value, disabled: f.disabled }), h("span", {}, f.label, f.hint ? h("small", {}, f.hint) : null));
  else if (f.type === "radio")
    return h(
      "fieldset",
      { class: ["field", "field-radio", f.class] },
      h("legend", {}, f.label),
      (f.options ?? []).map(([v, label, note]) => h("label", { class: "radio" }, h("input", { type: "radio", name: f.name, value: v, checked: String(f.value) === String(v), disabled: f.disabled }), h("span", {}, label, note ? h("small", {}, note) : null))),
      f.hint ? h("small", { class: "hint" }, f.hint) : null,
    );
  else
    input = h("input", {
      id,
      name: f.name,
      type: f.type ?? "text",
      value: f.value ?? "",
      required: f.required,
      min: f.min,
      max: f.max,
      step: f.step,
      placeholder: f.placeholder,
      pattern: f.pattern,
      disabled: f.disabled,
      maxlength: f.maxlength,
      inputmode: f.inputmode,
      autocomplete: f.autocomplete ?? "off",
      spellcheck: "false",
    });
  return h("div", { class: ["field", f.class] }, h("label", { for: id }, f.label, f.suffix ? h("span", { class: "field-suffix" }, f.suffix) : null), input, f.hint ? h("small", { class: "hint" }, f.hint) : null);
}
/** 读表单里的字段值（number → 数字或 null；checkbox → 布尔） */
export function readForm(form, specs) {
  const out = {};
  for (const f of specs) {
    if (f.type === "radio") {
      out[f.name] = form.querySelector(`input[name="${f.name}"]:checked`)?.value ?? null;
      continue;
    }
    const el = form.elements.namedItem(f.name);
    if (!el) continue;
    if (f.type === "checkbox") out[f.name] = !!el.checked;
    else if (f.type === "number") out[f.name] = el.value.trim() === "" ? null : Number(el.value);
    else out[f.name] = el.value.trim();
  }
  return out;
}

// ─── 抽屉（右侧详情） ───────────────────────────────────────────────
let drawerClose = null;
export function openDrawer({ title, subtitle, body, actions, wide, onClose }) {
  const d = $("#drawer");
  const content = h("div", { class: "drawer-body" });
  const close = () => d.open && d.close();
  d.className = ["drawer", wide && "wide"].filter(Boolean).join(" ");
  clear(
    d,
    h(
      "header",
      { class: "drawer-head" },
      h("div", { class: "drawer-titles" }, h("h2", {}, title), subtitle ? h("div", { class: "drawer-sub" }, subtitle) : null),
      h("div", { class: "drawer-actions" }, actions ?? null, h("button", { type: "button", class: "icon-btn", "aria-label": "关闭", title: "关闭（Esc）", onclick: close }, icon("close"))),
    ),
    content,
  );
  if (body) append(content, [body]);
  drawerClose?.();
  drawerClose = onClose ?? null;
  d.onclose = () => {
    const f = drawerClose;
    drawerClose = null;
    f?.();
  };
  if (!d.open) d.showModal();
  return { el: d, body: content, close, setTitle: (t) => (d.querySelector(".drawer-titles h2").textContent = t) };
}
export const closeDrawer = () => $("#drawer")?.open && $("#drawer").close();

// ─── 确认框（危险操作写清后果；需要时再输入一次目标名） ──────────────────
/**
 * @param {{title:string, lead?:any, consequences?:string[], confirmLabel?:string, danger?:boolean, typeToConfirm?:string, typeLabel?:string,
 *          fields?:any[], note?:string, validate?:(v:any)=>string|null, run?:(v:any)=>Promise<any>, cancelLabel?:string, wide?:boolean}} o
 * @returns {Promise<any>} run 的结果（无 run 时为字段值）；取消为 null
 */
export function confirmAction(o) {
  const d = $("#modal");
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      if (d.open) d.close();
    };
    const err = h("p", { class: "form-error", role: "alert" });
    const typeInput = o.typeToConfirm
      ? h("input", { type: "text", class: "type-confirm", autocomplete: "off", spellcheck: "false", "aria-label": `输入 ${o.typeToConfirm} 以确认` })
      : null;
    const ok = h("button", { type: "submit", class: ["btn", o.danger ? "danger-solid" : "primary"] }, o.confirmLabel ?? "确认");
    const cancel = h("button", { type: "button", class: "btn", onclick: () => finish(null) }, o.cancelLabel ?? "取消");
    const form = h(
      "form",
      { class: "modal-form", method: "dialog", novalidate: true },
      h("h2", { class: ["modal-title", o.danger && "danger"] }, o.danger ? icon("alert") : null, o.title),
      o.lead ? h("div", { class: "modal-lead" }, o.lead) : null,
      o.consequences?.length ? h("div", { class: ["consequences", o.danger && "danger"] }, h("b", {}, o.danger ? "执行后：" : "将会："), h("ul", {}, o.consequences.map((c) => h("li", {}, c)))) : null,
      o.fields?.length ? h("div", { class: "modal-fields" }, o.fields.map(field)) : null,
      typeInput ? h("label", { class: "type-confirm-label" }, h("span", {}, o.typeLabel ?? "再输入一次目标以确认：", h("code", {}, o.typeToConfirm)), typeInput) : null,
      o.note ? h("p", { class: "modal-note" }, o.note) : null,
      err,
      h("div", { class: "modal-actions" }, cancel, ok),
    );
    const sync = () => (ok.disabled = !!typeInput && typeInput.value.trim() !== o.typeToConfirm);
    typeInput?.addEventListener("input", sync);
    sync();
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      err.textContent = "";
      if (typeInput && typeInput.value.trim() !== o.typeToConfirm) return;
      const values = o.fields?.length ? readForm(form, o.fields) : {};
      for (const f of o.fields ?? []) {
        if (f.required && (values[f.name] === null || values[f.name] === "")) return void (err.textContent = `请填写“${f.label}”`);
      }
      const bad = o.validate?.(values);
      if (bad) return void (err.textContent = bad);
      if (!o.run) return finish(values);
      ok.disabled = true;
      cancel.disabled = true;
      try {
        const r = await o.run(values);
        finish(r ?? true);
      } catch (e) {
        err.textContent = errText(e);
        ok.disabled = false;
        cancel.disabled = false;
        sync();
      }
    });
    d.className = ["modal", o.wide && "wide"].filter(Boolean).join(" ");
    clear(d, form);
    d.onclose = () => finish(null);
    d.oncancel = (ev) => {
      if (cancel.disabled) ev.preventDefault();
    };
    d.showModal();
    (typeInput && o.fields?.length === undefined ? typeInput : form.querySelector("input:not([type=checkbox]):not([type=radio]), select, textarea") ?? cancel)?.focus();
  });
}

/** 只显示一次的码（开通码、设置密码码、重置码） */
export function showSecret(o) {
  const { title, secret, note, expiresAt } = o;
  const d = $("#modal");
  return new Promise((resolve) => {
    const close = () => d.open && d.close();
    d.className = "modal";
    clear(
      d,
      h(
        "div",
        { class: "modal-form" },
        h("h2", { class: "modal-title" }, title),
        h("div", { class: "secret-box" }, h("code", { class: "secret" }, secret), copyBtn(secret)),
        h("p", { class: "modal-note warn" }, o.warn ?? "只显示这一次：关掉后无法再查看。请当面或经安全渠道交给本人。"),
        note ? h("p", { class: "modal-note" }, note) : null,
        expiresAt ? h("p", { class: "modal-note" }, `有效期至 ${fmt.full(expiresAt)}（北京时间）`) : null,
        h("div", { class: "modal-actions" }, h("button", { type: "button", class: "btn primary", onclick: close }, "我已记下")),
      ),
    );
    d.onclose = () => resolve(true);
    d.oncancel = null;
    d.showModal();
  });
}

// ─── 图表（手写 SVG） ───────────────────────────────────────────────
/** 随容器宽度重画（不拉伸文字） */
function responsive(draw, cls = "chart") {
  const box = h("div", { class: cls });
  let w = 0;
  const ro = new ResizeObserver((ents) => {
    if (!box.isConnected) return;
    const nw = Math.floor(ents[0].contentRect.width);
    if (nw > 0 && Math.abs(nw - w) > 2) {
      w = nw;
      box.replaceChildren(draw(nw));
    }
  });
  ro.observe(box);
  return box;
}
const niceMax = (v) => {
  if (!(v > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / e;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * e;
};
/**
 * 趋势图：若干柱 + 若干折线共用 y 轴。
 * @param {{labels:string[], series:{name:string, values:(number|null)[], kind:"bar"|"line", cls?:string}[], format:(v:number)=>string, height?:number, tick?:(label:string)=>string}} o
 */
export function trendChart(o) {
  const height = o.height ?? 180;
  if (!o.series.some((s) => s.values.some((v) => Number.isFinite(v) && v !== 0))) return emptyBlock(o.empty ?? "这段时间没有用量", `${o.labels[0] ?? ""} 至 ${o.labels.at(-1) ?? ""} 全为 0`);
  const legend = h("div", { class: "legend" }, o.series.map((s, i) => h("span", { class: "legend-item" }, h("span", { class: `swatch ${s.cls ?? `s${i + 1}`} ${s.kind}` }), s.name)));
  const chart = responsive((W) => {
    const padL = 56;
    const padR = 8;
    const padT = 8;
    const padB = 22;
    const n = o.labels.length;
    const all = o.series.flatMap((s) => s.values.filter((v) => Number.isFinite(v)));
    const max = niceMax(Math.max(0, ...all));
    const iw = Math.max(10, W - padL - padR);
    const ih = height - padT - padB;
    const x0 = (i) => padL + (iw * i) / Math.max(1, n);
    const bw = iw / Math.max(1, n);
    const y = (v) => padT + ih - (ih * Math.max(0, v)) / max;
    const root = svg("svg", { width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": o.aria ?? o.series.map((s) => s.name).join("、") });
    const seen = new Set();
    for (const f of [0, 0.5, 1]) {
      const gy = padT + ih - ih * f;
      root.append(svg("line", { class: "grid", x1: padL, x2: W - padR, y1: gy, y2: gy }));
      const label = o.format(max * f);
      if (!seen.has(label)) root.append(svg("text", { class: "axis", x: padL - 6, y: gy + 4, "text-anchor": "end" }, label));
      seen.add(label);
    }
    const bars = o.series.filter((s) => s.kind === "bar");
    const gap = Math.min(4, bw * 0.2);
    bars.forEach((s, si) => {
      const w = Math.max(1, (bw - gap) / bars.length);
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v) || v <= 0) return;
        const yy = y(v);
        root.append(svg("rect", { class: `bar ${s.cls ?? `s${o.series.indexOf(s) + 1}`}`, x: x0(i) + gap / 2 + si * w, y: yy, width: Math.max(1, w - (bars.length > 1 ? 1 : 0)), height: Math.max(1, padT + ih - yy), rx: Math.min(2, w / 3) }));
      });
    });
    for (const s of o.series.filter((x) => x.kind === "line")) {
      const pts = s.values.map((v, i) => (Number.isFinite(v) ? `${(x0(i) + bw / 2).toFixed(1)},${y(v).toFixed(1)}` : null)).filter(Boolean);
      if (pts.length > 1) root.append(svg("polyline", { class: `line ${s.cls ?? `s${o.series.indexOf(s) + 1}`}`, points: pts.join(" ") }));
      if (pts.length === 1) {
        const [cx, cy] = pts[0].split(",");
        root.append(svg("circle", { class: `line-dot ${s.cls ?? ""}`, cx, cy, r: 2.5 }));
      }
    }
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 64))));
    o.labels.forEach((l, i) => {
      if (i % every !== 0 && i !== n - 1) return;
      if (i !== n - 1 && n - 1 - i < every && i % every === 0 && i !== 0) return;
      root.append(svg("text", { class: "axis", x: x0(i) + bw / 2, y: height - 6, "text-anchor": "middle" }, o.tick ? o.tick(l) : l));
    });
    // 悬停：每列一个透明热区，原生 <title> 提示
    o.labels.forEach((l, i) => {
      const tip = [l, ...o.series.map((s) => `${s.name}：${Number.isFinite(s.values[i]) ? o.format(s.values[i]) : "—"}`)].join("\n");
      root.append(svg("rect", { class: "hot", x: x0(i), y: padT, width: bw, height: ih }, svg("title", {}, tip)));
    });
    return root;
  });
  return h("div", { class: "trend" }, chart, legend);
}
/** 横向占比条（按模型、按律所） */
export function hbars(rows, { format = (v) => String(v), empty = "暂无数据" } = {}) {
  if (!rows.length) return emptyBlock(empty);
  const max = Math.max(...rows.map((r) => Number(r.value) || 0), 0) || 1;
  return h(
    "div",
    { class: "hbars" },
    rows.map((r) =>
      h(
        "div",
        { class: "hbar", title: r.title },
        h("span", { class: "hbar-label" }, r.label),
        h("span", { class: "hbar-track" }, cssVars(h("span", { class: `hbar-fill ${r.cls ?? ""}` }), { "--w": `${clamp01((Number(r.value) || 0) / max) * 100}%` })),
        h("span", { class: "hbar-value num" }, format(r.value, r)),
        r.note ? h("span", { class: "hbar-note" }, r.note) : null,
      ),
    ),
  );
}
/** 迷你折线（表格里的走势） */
export function sparkline(values, { width = 88, height = 24, cls = "" } = {}) {
  const v = values.map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0));
  const root = svg("svg", { class: `spark ${cls}`, width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" });
  if (v.length < 2) return root;
  const max = Math.max(...v, 1e-9);
  const pts = v.map((x, i) => `${((width - 2) * i) / (v.length - 1) + 1},${(height - 2 - ((height - 4) * x) / max).toFixed(1)}`);
  root.append(svg("polyline", { class: "spark-line", points: pts.join(" ") }));
  return root;
}
/** 历史比例柱（每期一根，旧计量另标） */
export function periodBars(history) {
  if (!history?.length) return emptyBlock("还没有历史周期");
  return h(
    "div",
    { class: "period-bars" },
    history.map((p) =>
      h(
        "div",
        { class: ["pb", p.legacy && "legacy"], title: `${p.period}：${fmt.pct(p.used_ratio)}${p.legacy ? "（旧计量，只保留比例）" : ""}` },
        h("span", { class: "pb-track" }, cssVars(h("span", { class: `pb-fill ${Number(p.used_ratio) >= 1 ? "full" : Number(p.used_ratio) >= 0.8 ? "high" : ""}` }), { "--h": `${clamp01(p.used_ratio) * 100}%` })),
        h("span", { class: "pb-val num" }, fmt.pct(p.used_ratio)),
        h("span", { class: "pb-label" }, String(p.period ?? "").slice(2)),
      ),
    ),
  );
}

// ─── 图标（线性，24 网格） ──────────────────────────────────────────
const ICONS = {
  home: ["M4 11l8-7 8 7", "M6 10v10h12V10", "M10 20v-5h4v5"],
  shield: ["M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z", "M9 12l2 2 4-4"],
  members: ["M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M2.5 20c1-3.5 3.6-5 6.5-5s5.5 1.5 6.5 5", "M16 4.5a3.5 3.5 0 0 1 0 6.5", "M18 15c2 .6 3.2 2.2 3.5 5"],
  staff: ["M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21c1.2-3.6 4.3-5.5 8-5.5", "M17 14l1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.8 2.6-.4z"],
  lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  chevron: ["M9 6l6 6-6 6"],
  sun: ["M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M12 2v2", "M12 20v2", "M4.9 4.9l1.4 1.4", "M17.7 17.7l1.4 1.4", "M2 12h2", "M20 12h2", "M4.9 19.1l1.4-1.4", "M17.7 6.3l1.4-1.4"],
  monitor: ["M3 5h18v11H3z", "M8 20h8", "M12 16v4"],
  laptop: ["M5 6h14v9H5z", "M3 18h18"],
  building: ["M5 21V4h9v17", "M14 9h5v12", "M8 8h3", "M8 12h3", "M8 16h3", "M3 21h18"],
  overview: ["M4 13h6V4H4z", "M14 20h6v-9h-6z", "M4 20h6v-3H4z", "M14 7h6V4h-6z"],
  tenants: ["M4 20V8l8-4 8 4v12", "M9 20v-6h6v6", "M3 20h18"],
  accounts: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"],
  devices: ["M4 5h16v10H4z", "M9 19h6", "M12 15v4"],
  routing: ["M5 6h4l6 12h4", "M5 18h4l2-4", "M15 6h4", "M13 10l2-4"],
  usage: ["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"],
  plans: ["M5 4h14v16H5z", "M9 8h6", "M9 12h6", "M9 16h3"],
  billing: ["M4 6h16v12H4z", "M4 10h16", "M8 15h3"],
  system: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19 12l2-1-1-3-2 .2-1.3-1.5.4-2-3-1-1 1.8h-2L9.1 3.7l-3 1 .4 2L5 8.2 3 8l-1 3 2 1v1l-2 1 1 3 2-.2 1.3 1.5-.4 2 3 1 1-1.8h2l1 1.8 3-1-.4-2 1.5-1.3 2 .2 1-3-2-1z"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"],
  refresh: ["M20 11a8 8 0 0 0-14.5-4.5L4 8", "M4 4v4h4", "M4 13a8 8 0 0 0 14.5 4.5L20 16", "M20 20v-4h-4"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  alert: ["M12 4l9 16H3z", "M12 10v4", "M12 17v.5"],
  theme: ["M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"],
  logout: ["M15 4h4v16h-4", "M10 8l-4 4 4 4", "M6 12h10"],
  key: ["M8 15a4 4 0 1 1 3.5-6", "M11 11h9v3", "M17 11v3"],
  plus: ["M12 5v14", "M5 12h14"],
  download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
  back: ["M15 6l-6 6 6 6"],
  file: ["M6 3h8l4 4v14H6z", "M14 3v4h4"],
};
export function icon(name, cls = "icon") {
  return svg("svg", { class: cls, viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true" }, (ICONS[name] ?? []).map((d) => svg("path", { d })));
}

// ─── 定义列表（详情里的“键：值”） ─────────────────────────────────────
export function facts(pairs) {
  return h(
    "dl",
    { class: "facts" },
    pairs.filter(Boolean).map(([k, v, title]) => [h("dt", {}, k), h("dd", { title }, v === null || v === undefined || v === "" ? "—" : v)]),
  );
}
export function stat(label, value, sub, o = {}) {
  return h("div", { class: ["stat", o.tone && `tone-${o.tone}`], title: o.title }, h("div", { class: "stat-label" }, label), h("div", { class: "stat-value num" }, value), sub ? h("div", { class: "stat-sub" }, sub) : null);
}
export function panel(title, body, o = {}) {
  return h("section", { class: ["panel", o.class] }, title ? h("header", { class: "panel-head" }, h("h3", {}, title), o.sub ? h("span", { class: "panel-sub" }, o.sub) : null, o.actions ? h("div", { class: "panel-actions" }, o.actions) : null) : null, body);
}

// ─── 第 46 批：环形水位、额度卡（百分比四件套）、二维码、验证码输入 ───────────────
/** 环形进度：ratio 0–1；tone 随阈值（≥80% 注意，≥100% 或暂停 = 满） */
export function ring(o) {
  const size = o.size ?? 88;
  const sw = o.stroke ?? 8;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const ratio = isNum(o.ratio) ? clamp01(o.ratio) : null;
  const limit = isNum(o.capPct) && o.capPct > 0 ? o.capPct / 100 : 1;
  const tone = ratio === null ? "none" : o.paused || ratio >= limit ? "full" : ratio >= limit * 0.8 ? "high" : "ok";
  const root = svg("svg", { class: `ring tone-${tone}`, width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": `${o.label ?? "已用"} ${ratio === null ? "未知" : fmt.pct(ratio)}` });
  root.append(svg("circle", { class: "ring-track", cx: size / 2, cy: size / 2, r, "stroke-width": sw }));
  if (ratio !== null && ratio > 0)
    root.append(svg("circle", { class: "ring-fill", cx: size / 2, cy: size / 2, r, "stroke-width": sw, "stroke-dasharray": `${(c * ratio).toFixed(2)} ${c.toFixed(2)}`, transform: `rotate(-90 ${size / 2} ${size / 2})` }));
  if (isNum(o.capPct) && o.capPct > 0 && o.capPct < 100) {
    const a = (o.capPct / 100) * 2 * Math.PI - Math.PI / 2;
    const x1 = size / 2 + (r - sw / 2 - 1) * Math.cos(a);
    const y1 = size / 2 + (r - sw / 2 - 1) * Math.sin(a);
    const x2 = size / 2 + (r + sw / 2 + 1) * Math.cos(a);
    const y2 = size / 2 + (r + sw / 2 + 1) * Math.sin(a);
    root.append(svg("line", { class: "ring-cap", x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2) }, svg("title", {}, `上限 ${o.capPct}%`)));
  }
  root.append(svg("text", { class: "ring-pct", x: size / 2, y: size / 2 + 5, "text-anchor": "middle" }, ratio === null ? "—" : fmt.pct(ratio)));
  return root;
}

/**
 * 额度卡：环 + 四件套（剩余、已用/总量与单位、重置时间、说明）。数字类型不互相换算：
 * 配额百分比（ratio）、实际消耗（token）、计费金额（元）各写各的。
 * @param {{title:string, ratio?:number|null, used?:number|null, total?:number|null, unit?:string, resetsAt?:string|null, capPct?:number|null,
 *          paused?:string|null, note?:any, extra?:any, compact?:boolean}} o
 */
export function quotaCard(o) {
  const r = isNum(o.ratio) ? Number(o.ratio) : isNum(o.used) && isNum(o.total) && Number(o.total) > 0 ? Number(o.used) / Number(o.total) : null;
  const remain = r === null ? null : Math.max(0, 1 - r);
  const unitText = o.unit === "cny" ? "元" : o.unit === "tokens" ? "token" : o.unit ? String(o.unit) : "—";
  const pausedText = o.paused ? { cap: "已到本所上限", allowance: "本期额度用完", burst: "5 小时频率限制已满", seat: "个人额度用完" }[o.paused] ?? "已暂停" : null;
  return h(
    "div",
    { class: ["quota", o.compact && "compact"] },
    ring({ ratio: r, capPct: o.capPct, paused: o.paused, size: o.compact ? 64 : 88, stroke: o.compact ? 6 : 8, label: o.title }),
    h(
      "div",
      { class: "quota-body" },
      h("div", { class: "quota-title" }, h("b", {}, o.title), pausedText ? badge(pausedText, "danger") : null),
      h(
        "dl",
        { class: "quota-facts" },
        h("dt", {}, "剩余"),
        h("dd", { class: "num" }, remain === null ? "—" : fmt.left(remain)),
        h("dt", {}, "已用"),
        h("dd", { class: "num" }, isNum(o.used) ? (isNum(o.total) ? `${fmt.amount(o.used, o.unit)} / ${fmt.amount(o.total, o.unit)}` : `${fmt.amount(o.used, o.unit)}（不设上限）`) : r === null ? "—" : fmt.pct(r)),
        h("dt", {}, "本期"),
        h("dd", {}, fmt.resetLine(o.resetsAt)),
        h("dt", {}, "单位"),
        h("dd", {}, o.capPct && o.capPct < 100 ? `${unitText} · 本所上限 ${o.capPct}%` : unitText),
      ),
      o.note ? h("p", { class: "quota-note" }, o.note) : null,
      o.extra ?? null,
    ),
  );
}

/** 二维码（DOM 构造 SVG，不拼 HTML）；固定浅底深码（纸面令牌，深色模式也不反色） */
export function qrElement(qr, { border = 4, label = "二维码" } = {}, pathOf) {
  const n = qr.size + border * 2;
  return svg("svg", { class: "qr", viewBox: `0 0 ${n} ${n}`, "shape-rendering": "crispEdges", role: "img", "aria-label": label }, svg("rect", { class: "qr-bg", width: n, height: n }), svg("path", { class: "qr-dots", d: pathOf(qr, border) }));
}

/** 6 位验证码输入（或恢复码）：数字键盘、一次性码自动填充、满 6 位回调 */
export function otpInput({ name = "code", recovery = false, onFull } = {}) {
  const i = h("input", {
    name,
    class: ["otp", recovery && "otp-recovery"],
    type: "text",
    inputmode: recovery ? "text" : "numeric",
    autocomplete: recovery ? "off" : "one-time-code",
    maxlength: recovery ? 24 : 6,
    placeholder: recovery ? "xxxx-xxxx-xxxx" : "000000",
    spellcheck: "false",
    autocapitalize: "off",
    "aria-label": recovery ? "恢复码" : "6 位验证码",
  });
  i.addEventListener("input", () => {
    if (!recovery) i.value = i.value.replace(/\D+/g, "").slice(0, 6);
    if (!recovery && i.value.length === 6) onFull?.(i.value);
  });
  return i;
}
/** 归一验证码：6 位数字照用；恢复码去空白与连字符、转小写 */
export const normCode = (v, recovery) => (recovery ? String(v).replace(/[\s-]+/g, "").toLowerCase() : String(v).replace(/\D+/g, ""));

/** 小节标题（页面内分组） */
export const sectionTitle = (t, sub) => h("div", { class: "section-title" }, h("h2", {}, t), sub ? h("p", {}, sub) : null);
/** “在管理员电脑上完成”的事项清单 */
export function clientOnlyList(items) {
  return h("ul", { class: "client-only" }, items.map(([t, d]) => h("li", {}, h("span", { class: "co-icon", "aria-hidden": "true" }, icon("laptop")), h("div", {}, h("b", {}, t), d ? h("small", {}, d) : null))));
}
