/**
 * S8 来源 A 抽样（调研 Y5 §4.2）：从本地一批公开裁判文书纯文本中按事项类型分层抽样，生成待标注的 JSONL（spans 为空）。
 *   node packages/tokenizer/eval/sample.mjs <目录> --per-stratum 200 [--seed 20261015] [--locked-ratio 0.6] [--source public_judgment] [--out s8-a]
 * 目录结构：<目录>/<事项类型>/*.txt（UTF-8；子目录名即分层，如 劳动、婚姻家事、人身损害、借贷、买卖合同、公司、刑事）。
 * 输出：<out>-dev.jsonl（开发集：可看错例、可调规则）与 <out>-locked.jsonl（锁定集：规则作者不得接触原文，只在 CI 出汇总）。
 * 切分按 doc_id 的 SHA-256 决定（与抽样顺序无关，可复现）。不做任何预标注——用识别规则预标注会让评测与规则同源（规范 v1 §1）。
 * 本脚本不联网；文书获取由评测负责人按公开渠道的使用条款自行完成。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const VALUED = ["--per-stratum", "--seed", "--locked-ratio", "--source", "--out"];
const dir = argv.find((a, i) => !a.startsWith("--") && !VALUED.includes(argv[i - 1]));
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
if (!dir) {
  process.stderr.write("用法：node packages/tokenizer/eval/sample.mjs <目录> --per-stratum N [--seed S] [--locked-ratio R] [--source public_judgment] [--out s8-a]\n");
  process.exit(2);
}
const per = Number(opt("--per-stratum", "200"));
const seed = Number(opt("--seed", "20261015"));
const lockedRatio = Number(opt("--locked-ratio", "0.6"));
const source = opt("--source", "public_judgment");
const out = opt("--out", "s8-a");
if (!(per > 0) || !(lockedRatio >= 0 && lockedRatio <= 1)) {
  process.stderr.write("参数无效\n");
  process.exit(2);
}

function rng(s) {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(seed);
const dev = [];
const locked = [];
const summary = [];
for (const stratum of readdirSync(dir).sort()) {
  const sd = join(dir, stratum);
  if (!statSync(sd).isDirectory()) continue;
  const files = readdirSync(sd).filter((n) => n.endsWith(".txt")).sort();
  // Fisher–Yates 前 per 个
  for (let i = 0; i < Math.min(per, files.length); i++) {
    const j = i + Math.floor(r() * (files.length - i));
    [files[i], files[j]] = [files[j], files[i]];
  }
  const picked = files.slice(0, Math.min(per, files.length));
  let nDev = 0;
  let nLocked = 0;
  for (const f of picked) {
    const text = readFileSync(join(sd, f), "utf8").replace(/\r\n?/g, "\n").replace(/^﻿/, "");
    const doc_id = `${source}:${stratum}:${basename(f, ".txt")}`;
    const h = createHash("sha256").update(doc_id).digest();
    const isLocked = h.readUInt32BE(0) / 2 ** 32 < lockedRatio;
    const rec = { doc_id, source, stratum, text, known_parties: [], spans: [] };
    (isLocked ? locked : dev).push(JSON.stringify(rec));
    isLocked ? nLocked++ : nDev++;
  }
  summary.push(`${stratum}：可选 ${files.length}，抽 ${picked.length}（开发 ${nDev} / 锁定 ${nLocked}）`);
}
writeFileSync(`${out}-dev.jsonl`, dev.join("\n") + (dev.length ? "\n" : ""));
writeFileSync(`${out}-locked.jsonl`, locked.join("\n") + (locked.length ? "\n" : ""));
process.stdout.write(`[sample] ${summary.join("；")}\n[sample] → ${out}-dev.jsonl（${dev.length}）/ ${out}-locked.jsonl（${locked.length}）\n`);
