#!/usr/bin/env node
/**
 * 核对本仓库与 SOURCE.json 记录的导出内容是否一致（第 46 批）。
 *
 * 本仓库由 monorepo 的 platform/desktop-repo/export.mjs 导出；其中 firm-trust、seat-token、keys、design-tokens 是
 * 桌面客户端与云端共用的契约包，以 monorepo 为单一来源——在这里直接改它们会让两端漂移。
 *
 *   node scripts/verify-source.mjs            共享契约包与导出时不一致即失败（CI 用）；其余文件的差异只列出
 *   node scripts/verify-source.mjs --strict   任何文件与导出时不一致都失败
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const doc = JSON.parse(readFileSync(join(root, "SOURCE.json"), "utf8"));
const shared = (doc.shared_contract_packages ?? []).map((p) => `packages/${p}/`);
const drift = [];
for (const [f, want] of Object.entries(doc.files)) {
  const p = join(root, f);
  const got = existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
  if (got !== want) drift.push({ f, shared: shared.some((s) => f.startsWith(s)), missing: got === null });
}
const bad = drift.filter((d) => strict || d.shared);
console.log(`导出来源：monorepo ${doc.monorepo?.commit?.slice(0, 12) ?? "?"}${doc.monorepo?.dirty ? "（含未提交改动）" : ""}，接口 ${doc.api}，共 ${Object.keys(doc.files).length} 个文件`);
for (const d of drift) console.log(`${d.shared ? "✖ 共享契约包" : "· 本地改动"} ${d.missing ? "缺失" : "不一致"}：${d.f}`);
if (bad.length) {
  console.error(`\n${bad.length} 个文件与导出时不一致${strict ? "" : "（共享契约包须在 monorepo 改，再重新导出）"}。`);
  process.exit(1);
}
console.log(drift.length ? `\n共享契约包一致；另有 ${drift.length} 个本地改动（回到 monorepo 合并后重新导出）。` : "\n与导出时完全一致。");
