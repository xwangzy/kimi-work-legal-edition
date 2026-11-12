// 把已到终态、还没取回的任务成果取到 <输出目录>/<标签>/：run.json（运行与成果清单）、events.json（全过程事件）、各版本成果文件（v<n>-文件名），
// 并用 LibreOffice 实际打开每个 docx / xlsx 转 PDF（open.json 记是否打开与页数）。评分只认这里取到的文件。
// 用法：node eval/grab.mjs <输出目录> [--stack <栈名>]　soffice 路径用 KWL_SOFFICE 指定（缺省在 PATH 里找）
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TERMINAL, inv, runsOf, stacks } from "./lib.mjs";

const args = process.argv.slice(2);
const OUT = resolve(args[0] ?? "");
if (!args[0]) throw new Error("用法：node eval/grab.mjs <输出目录> [--stack <栈名>]");
const only = args.includes("--stack") ? args[args.indexOf("--stack") + 1] : null;
const SOFFICE = process.env.KWL_SOFFICE ?? "soffice";
mkdirSync(OUT, { recursive: true });

for (const w of stacks()) {
  if (only && w.name !== only) continue;
  for (const [tag, run] of runsOf(w)) {
    const dir = join(OUT, tag);
    if (existsSync(join(dir, "open.json"))) continue;
    let g;
    try {
      g = await inv(w, "runs.get", { run_id: run });
    } catch (e) {
      console.log(tag, "读不到", String(e).slice(0, 120));
      continue;
    }
    if (!TERMINAL.test(g.run.status)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify(g, null, 1));
    const all = [];
    for (let cursor = 0; ; ) {
      const e = await inv(w, "runs.events", { run_id: run, cursor, limit: 500 });
      all.push(...e.events);
      if (!e.events.length || e.next_cursor === cursor) break;
      cursor = e.next_cursor;
    }
    writeFileSync(join(dir, "events.json"), JSON.stringify(all, null, 1));
    for (const a of g.artifacts) {
      const d = await inv(w, "artifacts.download", { artifact_version_id: a.artifact_version_id });
      writeFileSync(join(dir, `v${a.version ?? 1}-${String(d.filename).replace(/[/\\]/g, "_")}`), Buffer.from(d.data_base64, "base64"));
    }
    const open = {};
    for (const f of readdirSync(dir).filter((x) => /\.(docx|xlsx)$/.test(x))) {
      try {
        execFileSync(SOFFICE, [`-env:UserInstallation=file://${join(tmpdir(), "kwl-eval-lo")}`, "--headless", "--convert-to", "pdf", "--outdir", join(dir, "pdf"), join(dir, f)], { encoding: "utf8", timeout: 180000, stdio: "pipe" });
        const pdf = join(dir, "pdf", f.replace(/\.(docx|xlsx)$/, ".pdf"));
        const pages = existsSync(pdf) ? (readFileSync(pdf, "latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length : 0;
        open[f] = pages > 0 ? { opened: true, pages } : { opened: false };
      } catch (e) {
        open[f] = { opened: false, error: String(e).slice(0, 120) };
      }
    }
    writeFileSync(join(dir, "open.json"), JSON.stringify({ stack: w.name, model: w.model ?? null, tag, run, status: g.run.status, open }, null, 1));
    console.log(w.name, tag, g.run.status, Object.entries(open).map(([k, v]) => `${k}:${v.opened ? v.pages + "页" : "打不开"}`).join(" | "));
  }
}
