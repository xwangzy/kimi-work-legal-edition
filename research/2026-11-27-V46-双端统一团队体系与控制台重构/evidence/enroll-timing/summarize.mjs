// 汇总 results.jsonl：逐轮表、中位数对比表、过渡页文字序列、成功率。node summarize.mjs [--include-warm]
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const rows = readFileSync(join(here, process.argv.includes("--prod") ? "results-prod.jsonl" : "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const latArg = process.argv.indexOf("--lat") >= 0 ? Number(process.argv[process.argv.indexOf("--lat") + 1]) : null;
const runs = rows.filter((r) => (process.argv.includes("--include-warm") || !/^(w\d|seed)/.test(r.tag)) && (latArg === null || r.lat === latArg));
const med = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return null; return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const sec = (ms) => (ms == null ? "—" : (ms / 1000).toFixed(2));
const short = (t) => { const x = t.replace(/^Kimi Work 法律版 /, "").replace(/登录只核对账号信息.*$/, "").trim(); if (!x) return "（空白）"; if (/新建任务/.test(x)) return "工作区"; return x.slice(0, 34); };
const seqOf = (p) => (p?.seq ?? []).map(([ms, t]) => `${sec(ms)}s ${short(t)}`).join(" → ");
const ver = { b71: "改前", b72: "改后" };
console.log("| 轮 | 版本 | 往返 | A 首屏 秒 | A 无“正在…” 秒 | A 整页重载 | B 首屏 秒 | B 无“正在…” 秒 | B 整页重载 | 退出登录 秒 | 错误文案 | 电脑数上限 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|");
for (const r of runs) {
  const errs = [...(r.A?.errors ?? []), ...(r.B?.errors ?? [])];
  console.log(`| ${r.tag} | ${ver[r.ver]} | ${r.lat} ms | ${r.A?.ok ? sec(r.A.ms) : "失败"} | ${sec(r.A?.settled_ms)} | ${r.A?.reloads?.length ?? "—"} | ${r.B ? (r.B.ok ? sec(r.B.ms) : "失败") : "—"} | ${sec(r.B?.settled_ms)} | ${r.B?.reloads?.length ?? "—"} | ${sec(r.logout_ms)} | ${errs.join("、") || (r.error ? "驱动异常：" + r.error.slice(0, 40) : "无")} | ${r.A?.deviceLimit || r.B?.deviceLimit ? "出现" : "无"} |`);
}
console.log("\n| 路径 | 往返 | 改前中位数 秒（3 轮） | 改后中位数 秒（3 轮） | 差 | 改前范围 | 改后范围 |\n|---|---:|---:|---:|---:|---|---|");
for (const p of ["A", "B"]) for (const lat of (latArg === null ? [0, 300] : [latArg])) {
  const pick = (v) => runs.filter((r) => r.ver === v && r.lat === lat && r[p]?.ok).map((r) => r[p].ms);
  const a = pick("b71"), b = pick("b72");
  const ma = med(a), mb = med(b);
  const rng = (xs) => (xs.length ? `${sec(Math.min(...xs))}～${sec(Math.max(...xs))}（n=${xs.length}）` : "—");
  console.log(`| ${p} | ${lat} ms | ${sec(ma)} | ${sec(mb)} | ${ma != null && mb != null ? ((mb - ma) / 1000).toFixed(2) + `（${(((mb - ma) / ma) * 100).toFixed(0)}%）` : "—"} | ${rng(a)} | ${rng(b)} |`);
}
console.log("\n过渡页文字序列（时刻为点击后秒数）：");
for (const r of runs) for (const p of ["A", "B"]) if (r[p]) console.log(`- ${r.tag} ${p}：${seqOf(r[p])}；整页重载 @ ${(r[p].reloads ?? []).map(sec).join(", ") || "无"}`);
const all = runs.flatMap((r) => ["A", "B"].filter((p) => r[p] || (p === "A")).map((p) => ({ v: r.ver, lat: r.lat, ok: !!r[p]?.ok, err: (r[p]?.errors ?? []).length > 0 || !!r.error })));
console.log("\n成功率：");
for (const v of ["b71", "b72"]) for (const lat of (latArg === null ? [0, 300] : [latArg])) { const xs = all.filter((x) => x.v === v && x.lat === lat); console.log(`- ${ver[v]} ${lat} ms：${xs.filter((x) => x.ok && !x.err).length}/${xs.length}`); }
