#!/usr/bin/env node
/**
 * 历史用量补录（第 44 批，主文 §4.6）：把升级前（第 43 批及以前）网关预写日志 meter.jsonl 里的 settle 行补进控制面的逐请求用量账本。
 * 旧行里的 token 数是上游当时给的真实值；金额按补录时控制台的价目表算（账本行标 backfill）。按请求编号去重：多个网关实例的文件可一起给、重复跑无害。
 * --clear-legacy：运营确认已交齐全部网关实例本期的日志后，清掉该律所本期“旧口径冻结比例”，改按补录的真实用量计。
 *
 * 用法（运营人员电脑，须在运维网段；第 46 批起用控制台账号登录，须有“客户运营”角色）：
 *   KWL_PASSWORD=… node scripts/usage-backfill.mjs <meter.jsonl> [更多…] --url https://cp.kwl.example.com --email ops@csi.example.com [--code 123456] \
 *        [--password-env KWL_PASSWORD] [--month 2026-11] [--tid ten_x] [--clear-legacy] [--dry-run]
 *   或用控制台里已登录的会话：KWL_SESSION=kws1.… node scripts/usage-backfill.mjs … --url … --session-env KWL_SESSION
 * 输出：每家律所一行 JSON（补录条数、重复、跳过、是否清掉旧口径比例）。
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (k) => argv.includes(`--${k}`);
const fail = (m) => {
  console.error(`[usage-backfill] ${m}`);
  process.exit(2);
};
const valued = new Set(["url", "email", "code", "password-env", "session-env", "month", "tid"]);
const files = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && valued.has(argv[i - 1].slice(2))));
if (!files.length) fail("缺少 meter.jsonl 文件");
const month = flag("month");
const onlyTid = flag("tid");
const byTid = new Map();
let bad = 0;
for (const f of files)
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (r.kind !== "settle" || r.record || typeof r.tid !== "string") continue;
    if (onlyTid && r.tid !== onlyTid) continue;
    if (month && new Date(Date.parse(r.at) + 8 * 3600_000).toISOString().slice(0, 7) !== month) continue;
    if (!byTid.has(r.tid)) byTid.set(r.tid, new Map());
    byTid.get(r.tid).set(r.requestId, r);
  }
if (bad) console.error(`[usage-backfill] 跳过 ${bad} 行无法解析`);
if (has("dry-run")) {
  for (const [tid, m] of byTid) console.log(JSON.stringify({ tid, rows: m.size }));
  process.exit(0);
}
const url = flag("url") ?? fail("缺少 --url");
const post = async (path, body, token) => {
  const r = await fetch(new URL(path, url), { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, ok: r.ok, json: await r.json().catch(() => null) };
};
// 会话：控制台里复制来的（--session-env），或用邮箱 + 密码（+ 两步验证码）登录；用完退出（只退出自己登录的）
let session = flag("session-env") ? process.env[flag("session-env")] : undefined;
let ownSession = false;
if (!session) {
  const email = flag("email") ?? fail("缺少 --email（或用 --session-env 给控制台会话）");
  const password = process.env[flag("password-env") ?? "KWL_PASSWORD"] ?? fail(`缺少密码：放进环境变量 ${flag("password-env") ?? "KWL_PASSWORD"}`);
  let r = await post("/v1/auth/login", { email, password, client: { platform: "web" } });
  if (r.ok && r.json?.mfa_required) r = await post("/v1/auth/mfa/verify", { mfa_token: r.json.mfa_token, code: flag("code") ?? fail("这个账号启用了两步验证：加 --code <6 位动态码>") });
  if (!r.ok || !r.json?.session_token) fail(`登录失败：${r.status} ${r.json?.error?.message ?? ""}`);
  session = r.json.session_token;
  ownSession = true;
}
const call = async (body) => {
  const path = "/v1/ops/usage/backfill";
  const r = await fetch(new URL(path, url), { method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) fail(`${body.tid}：${r.status} ${j?.error?.code ?? ""} ${j?.error?.message ?? ""}`);
  return j;
};
for (const [tid, m] of byTid) {
  const rows = [...m.values()];
  let accepted = 0;
  let duplicates = 0;
  let skipped = 0;
  let cleared = false;
  for (let i = 0; i < rows.length; i += 2000) {
    const last = i + 2000 >= rows.length;
    const j = await call({ tid, rows: rows.slice(i, i + 2000), ...(last && has("clear-legacy") ? { clear_legacy: true } : {}) });
    accepted += j.accepted;
    duplicates += j.duplicates;
    skipped += j.skipped;
    cleared = cleared || j.legacy_cleared;
  }
  console.log(JSON.stringify({ tid, rows: rows.length, accepted, duplicates, skipped, legacy_cleared: cleared }));
}
if (ownSession) await post("/v1/auth/logout", {}, session).catch(() => {});
