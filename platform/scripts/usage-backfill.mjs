#!/usr/bin/env node
/**
 * 历史用量补录（第 44 批，主文 §4.6）：把升级前（第 43 批及以前）网关预写日志 meter.jsonl 里的 settle 行补进控制面的逐请求用量账本。
 * 旧行里的 token 数是上游当时给的真实值；金额按补录时控制台的价目表算（账本行标 backfill）。按请求编号去重：多个网关实例的文件可一起给、重复跑无害。
 * --clear-legacy：运营确认已交齐全部网关实例本期的日志后，清掉该律所本期“旧口径冻结比例”，改按补录的真实用量计。
 *
 * 用法（运营人员电脑，须在运维网段；私钥同 ops-cli）：
 *   node scripts/usage-backfill.mjs <meter.jsonl> [更多…] --url https://cp.kwl.example.com --deployment prod --id op_0001 --kid k1 \
 *        --key ~/.kwl-ops/op_0001.k1.key.pem [--month 2026-11] [--tid ten_x] [--clear-legacy] [--dry-run] [--passphrase-env KWL_OPS_PASS]
 * 输出：每家律所一行 JSON（补录条数、重复、跳过、是否清掉旧口径比例）。
 */
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const oa = await import(join(root, "packages/ops-auth/src/index.ts"));
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
const valued = new Set(["url", "deployment", "id", "kid", "key", "month", "tid", "passphrase-env"]);
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
const pem = readFileSync(flag("key") ?? fail("缺少 --key"), "utf8");
const pass = flag("passphrase-env") ? process.env[flag("passphrase-env")] : undefined;
const privateKey = createPrivateKey(pass ? { key: pem, passphrase: pass } : pem);
const call = async (body) => {
  const raw = JSON.stringify(body);
  const path = "/v1/ops/usage/backfill";
  const headers = oa.signOpsRequest({ deployment: flag("deployment") ?? fail("缺少 --deployment"), audience: "control-plane", method: "POST", path, body: raw, operator: flag("id") ?? fail("缺少 --id"), kid: flag("kid") ?? fail("缺少 --kid"), privateKey });
  const r = await fetch(new URL(path, url), { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: raw });
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
