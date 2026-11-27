// 各阶段埋点（measure-enroll.mjs --file 逐轮出表 + 各段中位数）：node phases.mjs <版本 b71|b72> <延迟 0|300> <路径 A|B>
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const [ver, lat, p] = process.argv.slice(2);
const M = "/Users/wangzeyu/Documents/Coding/Kimi Work Legal/.claude/worktrees/kimi-legal-b72/platform/scripts/measure-enroll.mjs";
const files = readdirSync(join(here, "raw")).filter((f) => new RegExp(`^${ver}-${lat}-r\\d-${p}\\.jsonl$`).test(f)).sort().map((f) => join(here, "raw", f));
spawnSync(process.execPath, [M, ...files.flatMap((f) => ["--file", f])], { stdio: "inherit" });
