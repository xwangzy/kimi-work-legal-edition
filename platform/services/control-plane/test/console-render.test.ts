/**
 * 控制台渲染用例（第 72 批评审第二轮）：用一个极简 DOM 垫片把页面模块真的渲染一遍，抓“变量未定义”这类只在渲染时才暴露的错误。
 *   - 本所 · 电脑：待确认共享的电脑（issuer = account_ca）能出来，状态写“待管理员确认”与下一步，筛选有“待确认共享 1”，不出现读取失败；
 *   - 读取失败不把原始异常（ReferenceError 等）给客户看：写人话 + 错误编号。
 * 本文件单独一个进程跑（node --test 每个文件一个进程），垫片挂在 globalThis 上不影响别的用例。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const mod = async (rel: string): Promise<any> => import(pathToFileURL(join(root, rel)).href);

// ─── 极简 DOM 垫片：够 ui.js 的 h / clear / dataTable / segmented / rowMenu 用即可 ───
class FakeNode {
  parentNode: any = null;
  childNodes: any[] = [];
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
}
class FakeText extends FakeNode {
  data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
  override get textContent(): string {
    return this.data;
  }
}
const matchOne = (el: any, sel: string): boolean => {
  const m = /^([a-z0-9-]*)((?:[.#][\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel.trim());
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toLowerCase()) return false;
  for (const part of (m[2] ?? "").match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === "." && !el.classList.contains(part.slice(1))) return false;
    if (part[0] === "#" && el.getAttribute("id") !== part.slice(1)) return false;
  }
  for (const a of (m[3] ?? "").match(/\[[^\]]+\]/g) ?? []) {
    const [k, v] = a.slice(1, -1).split("=");
    if (!el.hasAttribute(k)) return false;
    if (v !== undefined && el.getAttribute(k) !== v.replace(/^["']|["']$/g, "")) return false;
  }
  return true;
};
class FakeEl extends FakeNode {
  tagName: string;
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = { cssText: "" };
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  [k: string]: any;
  constructor(tag: string) {
    super();
    this.tagName = tag.toLowerCase();
  }
  get classList() {
    const get = () => new Set((this.attrs.get("class") ?? "").split(/\s+/).filter(Boolean));
    const set = (s: Set<string>) => this.attrs.set("class", [...s].join(" "));
    return {
      add: (...c: string[]) => set(new Set([...get(), ...c])),
      remove: (...c: string[]) => set(new Set([...get()].filter((x) => !c.includes(x)))),
      toggle: (c: string, on?: boolean) => {
        const s = get();
        const want = on ?? !s.has(c);
        if (want) s.add(c);
        else s.delete(c);
        set(s);
        return want;
      },
      contains: (c: string) => get().has(c),
    };
  }
  get children() {
    return this.childNodes.filter((c) => c instanceof FakeEl);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get firstElementChild(): any {
    return this.children[0] ?? null;
  }
  get isConnected() {
    return true;
  }
  get innerText() {
    return this.textContent;
  }
  get offsetWidth() {
    return 0;
  }
  append(...nodes: any[]) {
    for (const n of nodes) {
      const x = n instanceof FakeNode ? n : new FakeText(String(n));
      if (x.parentNode) x.parentNode.childNodes = x.parentNode.childNodes.filter((c: unknown) => c !== x);
      x.parentNode = this;
      this.childNodes.push(x);
    }
  }
  appendChild(n: any) {
    this.append(n);
    return n;
  }
  prepend(...nodes: any[]) {
    const old = this.childNodes;
    this.childNodes = [];
    this.append(...nodes);
    this.childNodes.push(...old);
  }
  insertBefore(n: any, ref: any) {
    this.append(n);
    if (ref) {
      this.childNodes.pop();
      this.childNodes.splice(Math.max(0, this.childNodes.indexOf(ref)), 0, n);
    }
    return n;
  }
  replaceChildren(...nodes: any[]) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  replaceWith(...nodes: any[]) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    p.childNodes.splice(i, 1);
    const tmp = new FakeEl("x");
    tmp.append(...nodes);
    p.childNodes.splice(i, 0, ...tmp.childNodes.map((c: any) => ((c.parentNode = p), c)));
  }
  remove() {
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((c: unknown) => c !== this);
    this.parentNode = null;
  }
  setAttribute(k: string, v: unknown) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  toggleAttribute(k: string, on?: boolean) {
    if (on ?? !this.attrs.has(k)) this.attrs.set(k, "");
    else this.attrs.delete(k);
  }
  addEventListener(t: string, f: (ev: unknown) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }
  querySelectorAll(sel: string): any[] {
    const out: any[] = [];
    const walk = (n: any) => {
      for (const c of n.children) {
        if (sel.split(",").some((s) => matchOne(c, s))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  closest(sel: string) {
    let n: any = this;
    while (n instanceof FakeEl) {
      if (matchOne(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  focus() {}
  blur() {}
  scrollIntoView() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}
const body = new FakeEl("body");
for (const id of ["modal", "drawer", "toasts", "reauth"]) {
  const d = new FakeEl(id === "toasts" ? "div" : "dialog");
  d.setAttribute("id", id);
  body.append(d);
}
const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
};
const g = globalThis as any;
g.window = g;
g.addEventListener ??= () => {};
g.removeEventListener ??= () => {};
Object.assign(g, {
  Node: FakeNode,
  HTMLElement: FakeEl,
  HTMLInputElement: class {},
  HTMLTextAreaElement: class {},
  HTMLSelectElement: class {},
  document: {
    createElement: (t: string) => new FakeEl(t),
    createElementNS: (_ns: string, t: string) => new FakeEl(t),
    createTextNode: (s: string) => new FakeText(s),
    createDocumentFragment: () => new FakeEl("#fragment"),
    body,
    documentElement: new FakeEl("html"),
    querySelector: (s: string) => body.querySelector(s),
    querySelectorAll: (s: string) => body.querySelectorAll(s),
    addEventListener() {},
    activeElement: null,
  },
  location: { hash: "#/firm/devices", href: "http://console.test/#/firm/devices", origin: "http://console.test" },
  history: { replaceState() {} },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  sessionStorage: store(),
  localStorage: store(),
});

const DEVICES = [
  { device_id: "dev_t_chen", name: null, member: "陈律师", aid: "acc_cccccccccccccccc", role: "lawyer", platform: "darwin", version: null, last_seen_at: "2026-11-27", last_active_at: new Date().toISOString(), registered_at: "2026-11-27T04:00:00Z", revoked: false, state: "signed_in", flags: ["old_client"], issuer: "account_ca" },
  { device_id: "dev_t_liu", name: null, member: "刘律师", aid: "acc_llllllllllllllll", role: "admin", platform: "darwin", version: "0.11.0", last_seen_at: "2026-11-27", last_active_at: null, registered_at: "2026-11-27T04:00:00Z", revoked: false, state: "signed_out", flags: [], issuer: "firm_root" },
];
g.fetch = async (url: string) => {
  const u = String(url);
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (u.endsWith("config.json")) return json({ control_plane_base: "https://cp.test", deployment: "test", label: "测试" });
  if (u.includes("/v1/firm/devices")) return json({ devices: DEVICES });
  if (u.includes("/v1/firm/members")) return json({ members: [], pending_joins: [] });
  return new Response(JSON.stringify({ error: { code: "not_found", message: "没有这条路由" } }), { status: 404 });
};
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
};

test("本所 · 电脑：待确认共享的电脑能渲染出来（状态“待确认共享”+ 下一步），筛选有“待确认共享 1”，不出现读取失败", async () => {
  const api = await mod("apps/console/api.js");
  await api.loadConfig();
  api.saveSession("kws1.test", { kind: "web" });
  const { ctx } = await mod("apps/console/domain.js");
  Object.assign(ctx, { kind: "member", firmRole: "admin", me: { kind: "member", workspace: { kind: "team", member_device_policy: "auto" } }, perms: new Set() });
  const page = new FakeEl("div");
  (await mod("apps/console/pages/firm-devices.js")).render(page, { section: "firm", page: "devices", params: {} });
  await settle();
  const text = page.textContent;
  assert.doesNotMatch(text, /读不出来|读取失败|is not defined/, "整页不应是错误块");
  assert.match(text, /陈律师的 Mac · 第 1 台/, "派生名带“第 N 台”（编号没有 _D<n> 时第 1 台）");
  assert.match(text, /陈律师的 Mac · 第 1 台陈律师macOS未上报版本刚刚待确认共享/, "账号签发钥登记的团队电脑：状态与筛选同一个说法“待确认共享”");
  assert.match(text, /设置 → 团队 → 电脑待确认/, "状态次行写清去哪确认（与律师端路径一致）");
  assert.match(text, /待确认共享\s*1/, "筛选计数");
  assert.doesNotMatch(text, /dev_t_chen/, "设备编号不进主列");
  assert.doesNotMatch(text, /版本未知/, "没上报版本时不在标记列重复说版本（客户端列已写“未上报版本”）");
  assert.match(text, /低于最低版本\s*0/, "没上报版本的不计入“低于最低版本”筛选");
});

test("读取失败不把原始异常给客户看：前端代码错误写人话 + 错误编号；控制面给的中文说明照常显示", async () => {
  const { errorBlock } = await mod("apps/console/ui.js");
  const origErr = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    const js = errorBlock(new ReferenceError("CONFIRM_TIP is not defined"), () => {});
    assert.doesNotMatch(js.textContent, /CONFIRM_TIP|is not defined/);
    assert.match(js.textContent, /暂时读不出来.*错误编号 W[0-9A-Z]+/);
    assert.equal(logged.length, 1, "原始错误连同编号进控制台日志");
    const srv = errorBlock(Object.assign(new Error("账本暂时不可用"), { status: 503, code: "ledger_down" }), () => {});
    assert.match(srv.textContent, /账本暂时不可用/);
  } finally {
    console.error = origErr;
  }
});
