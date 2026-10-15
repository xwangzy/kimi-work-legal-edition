/**
 * 二次检测误报回归（研发自用；只输出计数与上下文片段，不对外引用）：把一组中文 Markdown 文档按段令牌化后跑 suspectedNames，
 * 统计提名个数。研发文档几乎不含真实自然人姓名，提名多即说明规则把普通词当成了姓名。
 *   node packages/tokenizer/eval/suspects-fp.ts ../research docs
 * 2026-10-14 基线：171 个文件、约 430 万字，提名 7 处（其中 3 处是文档里举例的人名“王平、高峰、文静”）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MatterTokenizer, suspectedNames } from "../src/index.ts";

const files: string[] = [];
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) {
      if (!/node_modules|ui-shots|\.git/.test(n)) walk(p);
    } else if (p.endsWith(".md")) files.push(p);
  }
};
for (const r of process.argv.slice(2)) walk(r);
const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 7), parties: [], table: [] });
let chars = 0;
const hits = new Map<string, { n: number; confidence: string; cue: string; ctx: string }>();
for (const f of files) {
  for (const para of readFileSync(f, "utf8").split(/\n+/)) {
    if (!/[一-龥]/.test(para)) continue;
    const t = tz.tokenize(para).text;
    chars += t.length;
    for (const s of suspectedNames(t)) {
      const h = hits.get(s.value) ?? { n: 0, confidence: s.confidence, cue: s.cue, ctx: t.slice(Math.max(0, s.index - 8), s.index + s.value.length + 8) };
      h.n += 1;
      hits.set(s.value, h);
    }
  }
}
const list = [...hits].sort((a, b) => b[1].n - a[1].n);
console.log(`文件 ${files.length} 个，约 ${chars} 字；提名 ${list.reduce((a, [, h]) => a + h.n, 0)} 处（${list.length} 个不同的值）`);
for (const [v, h] of list.slice(0, 40)) console.log(h.n, v, h.confidence, h.cue, "|", h.ctx.replace(/\s+/g, " "));
