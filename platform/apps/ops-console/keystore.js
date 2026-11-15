/**
 * “本标签页内记住 8 小时”（第 44 批，可选）：只把**不可导出**的 Ed25519 CryptoKey 对象存进 IndexedDB（浏览器按结构化克隆保存，
 * 取回仍不可导出），**不存私钥字节、不存口令**。
 *
 * - 记录按“标签页编号”分开：编号放 sessionStorage（每个标签页各一份，关掉标签页即失效），别的标签页拿不到这条记录；
 * - 8 小时到期、点“退出”、凭据被控制面拒绝时都删除；每次打开都顺手清掉过期记录；
 * - 浏览器禁用 IndexedDB / sessionStorage（隐私窗口、清站点数据）时静默不记，照常要求载入私钥。
 */
const DB = "kwl-ops-console";
const STORE = "keys";
const TTL_MS = 8 * 3600_000;
const TAB = "kwl-ops-tab";

function tabId(create) {
  try {
    let id = sessionStorage.getItem(TAB);
    if (!id && create) {
      const b = new Uint8Array(12);
      crypto.getRandomValues(b);
      id = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      sessionStorage.setItem(TAB, id);
    }
    return id;
  } catch {
    return null;
  }
}

function open() {
  return new Promise((ok, no) => {
    let req;
    try {
      req = indexedDB.open(DB, 1);
    } catch (e) {
      return no(e);
    }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => ok(req.result);
    req.onerror = () => no(req.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((ok, no) => {
      const t = db.transaction(STORE, mode);
      const s = t.objectStore(STORE);
      const r = fn(s);
      t.oncomplete = () => ok(r?.result);
      t.onerror = () => no(t.error);
      t.onabort = () => no(t.error);
    });
  } finally {
    db.close();
  }
}

/** 记住当前标签页的运营私钥（只收不可导出的 Ed25519 CryptoKey）。 */
export async function rememberKey({ operator, kid, key, deployment, base }) {
  if (!(key instanceof CryptoKey) || key.extractable !== false || key.algorithm?.name !== "Ed25519" || key.type !== "private") throw new Error("只能记住不可导出的 Ed25519 私钥对象");
  const id = tabId(true);
  if (!id) return false;
  try {
    await tx("readwrite", (s) => s.put({ id, operator, kid, key, deployment, base, expires_at: Date.now() + TTL_MS }));
    return true;
  } catch {
    return false;
  }
}

/** 取回本标签页记住的私钥（过期或不符即删除）。 */
export async function recallKey({ deployment, base }) {
  const id = tabId(false);
  if (!id) return null;
  try {
    const all = await tx("readonly", (s) => s.getAll());
    const now = Date.now();
    const stale = (all ?? []).filter((r) => !(r.expires_at > now));
    if (stale.length) await tx("readwrite", (s) => stale.forEach((r) => s.delete(r.id)));
    const hit = (all ?? []).find((r) => r.id === id && r.expires_at > now);
    if (!hit) return null;
    if (hit.deployment !== deployment || hit.base !== base || !(hit.key instanceof CryptoKey) || hit.key.extractable !== false) {
      await forgetKey();
      return null;
    }
    return { operator: hit.operator, kid: hit.kid, key: hit.key, expires_at: hit.expires_at };
  } catch {
    return null;
  }
}

export async function forgetKey() {
  const id = tabId(false);
  if (!id) return;
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* 浏览器不给 IndexedDB：本来就没记 */
  }
}
