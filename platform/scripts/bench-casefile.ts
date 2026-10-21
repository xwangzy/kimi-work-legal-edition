/**
 * 大案卷基准（v9.3 §5.3 P2/P3 性能项）：合成 N 份材料（默认 300 份、约 150 万字）→ 逐份导入（加密入库 + 解析）→
 * 本机“整理案卷”（确定性流程）→ 事项页、事实表、交付件列表与全局搜索取数的耗时；记录进程峰值 rss。
 *
 * ⚠️ 口径如实标注：macOS arm64 开发机、合成文本材料（不含 OCR，扫描件见 bench-ocr.mjs），**非 Windows 目标机验收数据**；
 * 真实大案卷（扫描件为主、表格与附件多）须在 Windows 参考机上复测。
 * 用法：node scripts/bench-casefile.ts [份数]（须先 npm run pretest 备好法规库与模板）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeKernel, waitRun } from "../packages/kernel/test/helpers.ts";

const N = Number(process.argv[2] ?? process.env.BENCH_DOCS ?? 300);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let peakRss = 0;
let atPeak: NodeJS.MemoryUsage | null = null;
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  if (m.rss > peakRss) {
    peakRss = m.rss;
    atPeak = m;
  }
}, 50);
sampler.unref();

function material(i: number): string {
  const y = 2023 + (i % 3);
  const m = (i % 12) + 1;
  const lines = [`证据材料第 ${i + 1} 号（合成，内容虚构）`];
  for (let k = 0; k < 60; k++) {
    const d = (k % 27) + 1;
    lines.push(`${y}年${m}月${d}日，丁贸易有限公司（示例）向戊制造有限公司（示例）交付第 ${i + 1}-${k + 1} 批货物，金额人民币${(10_000 + i * 37 + k * 11).toLocaleString("en-US")}元，签收人为仓储部收货专用章（示例）。双方对数量无异议，质量问题另行协商。`);
  }
  return lines.join("\n");
}

const time = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const r = await f();
  return [r, Math.round(performance.now() - t)];
};

const tk = await makeKernel({}, "bench-firm");
try {
  const { matter } = await tk.inv("matters.create", { title: "大案卷基准（合成）", stance: "原告", client_name: "丁贸易有限公司（示例）", counterparty: "戊制造有限公司（示例）", consent_status: "not_required" });
  const mid = matter.matter_id as string;
  let chars = 0;
  const ids: string[] = [];
  const perDoc: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const text = material(i);
    chars += text.length;
    const [r, ms] = await time(() => tk.inv("materials.import", { matter_id: mid, filename: `证据-${String(i + 1).padStart(4, "0")}.txt`, data_base64: Buffer.from(text, "utf8").toString("base64"), mime: "text/plain" }));
    ids.push(r.document_version_id);
    perDoc.push(ms);
  }
  const importMs = Math.round(performance.now() - t0);
  const rssAfterImport = Math.round(Math.max(peakRss, process.memoryUsage().rss) / 1048576);
  perDoc.sort((a, b) => a - b);

  const [est, estimateMs] = await time(() => tk.inv("runs.estimate", { matter_id: mid, scenario: "s2.case_file", document_version_ids: ids, issues: ["货款是否已付清", "质量异议是否成立"] }));
  let casefile: Record<string, unknown> = { skipped: est.estimate_id ? null : JSON.stringify(est).slice(0, 300) };
  if (est.estimate_id) {
    const t1 = performance.now();
    const run = await tk.inv("runs.start", { matter_id: mid, estimate_id: est.estimate_id, idempotency_key: `bench-${Date.now()}` });
    const done = await waitRun(tk.inv, run.run_id, 30 * 60_000);
    const fx = done.events.find((e: any) => e.type === "facts.extracted");
    casefile = { status: done.run.status, ms: Math.round(performance.now() - t1), artifacts: done.artifacts.length, facts_extracted: fx?.payload ?? null, artifact_bytes: done.artifacts.reduce((n: number, a: any) => n + (a.size_bytes ?? 0), 0) };
  }

  const [got, matterGetMs] = await time(() => tk.inv("matters.get", { matter_id: mid }));
  const [facts, factsMs] = await time(() => tk.inv("facts.list", { matter_id: mid }));
  const [arts, artifactsMs] = await time(() => tk.inv("artifacts.list", { matter_id: mid }));
  // 全局搜索取数（SearchPalette 打开时的三类调用）
  const [, searchLoadMs] = await time(() => Promise.all([tk.inv("matters.list", {}), tk.inv("runs.list_recent", { limit: 100 }), tk.inv("artifacts.list", { matter_id: mid })]));

  const result = {
    benchmark: "large-casefile-synthetic",
    caveat: "macOS arm64 开发机、合成文本材料（不含 OCR），非 Windows 目标机验收数据；真实大案卷须在 Windows 参考机复测",
    machine: { platform: process.platform, arch: process.arch, node: process.version },
    documents: N,
    characters: chars,
    import: { total_ms: importMs, per_doc_p50_ms: perDoc[Math.floor(N * 0.5)], per_doc_p95_ms: perDoc[Math.floor(N * 0.95)], per_doc_max_ms: perDoc[N - 1] },
    estimate_ms: estimateMs,
    casefile,
    reads: { matters_get_ms: matterGetMs, documents_listed: got.documents.length, facts_list_ms: factsMs, facts: (facts.facts ?? facts.items ?? []).length, artifacts_list_ms: artifactsMs, artifacts: (arts.artifacts ?? []).length, search_palette_load_ms: searchLoadMs },
    peak_rss_mb: Math.round(peakRss / 1048576),
    peak_rss_after_import_mb: rssAfterImport,
    // 峰值时刻的构成（MB）：堆内（JS 对象）、堆外（Buffer 等）；rss 减去两者为 SQLite、代码与其余本机内存
    at_peak_mb: atPeak ? { heap_used: Math.round(atPeak.heapUsed / 1048576), heap_total: Math.round(atPeak.heapTotal / 1048576), external: Math.round(atPeak.external / 1048576), array_buffers: Math.round(atPeak.arrayBuffers / 1048576) } : null,
    at: new Date().toISOString(),
  };
  const outDir = join(root, "output");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `bench-casefile-${N}-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  console.log(`[bench-casefile] 已写入 ${outFile}`);
} finally {
  await tk.kernel.close();
}
