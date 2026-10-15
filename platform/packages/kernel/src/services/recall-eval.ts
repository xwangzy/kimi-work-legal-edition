/**
 * 进所评测（S8 来源 B；v9.2 §3.3；调研 Y5 §4.2“带评测器进所、不带数据出所”；标注规范 v1 §8）。
 *
 * 律所人员在本机打开文书、标注、一致性、裁决、评测，全部在这台电脑上完成：
 * - 打开：只读系统对话框选定的文件（符号链接不跟随），不进块存储、不进账本、不建事项；
 * - 一致性、裁决、评测：纯计算，复用 packages/tokenizer/eval（与命令行同一套口径），每次用新的随机事项密钥；
 * - 保存标注（含原文）：只写到系统对话框选定的位置（不得写进数据根）；
 * - 导出报告：**由内核按固定格式重新计算并生成**，只含按类别的计数、比例与区间——界面不能往报告里放任何文字。
 * 审计只记动作与文书份数，不记文书名与内容。
 */
import { lstatSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { DomainError } from "@zr-legal/domain";
import { MatterTokenizer, type PartyEntry } from "@zr-legal/tokenizer";
import { aggregateBySource, evaluateDoc, reportMarkdown, validateGold, type EvalReport, type GoldDoc } from "@zr-legal/tokenizer/eval/evaluate";
import { adjudicate, compareAnnotations, type Decision } from "@zr-legal/tokenizer/eval/agreement";

/** 单个文件上限（标注 JSONL 或待标注文书）。 */
export const EVAL_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 一次评测的正文总字数上限（UTF-16 码元）。 */
export const EVAL_MAX_CHARS = 20_000_000;
const MAX_DOCS = 5000;
/** 每份文书的标注上限（防止异常文件拖垮计算）。 */
const MAX_SPANS_PER_DOC = 20_000;
/**
 * 来源只认登记的取值（复核 S6A-01）：来源会出现在报告标题与机读 JSON 的键里，若放任自由文字，界面就能把任意内容带进“只含计数”的报告。
 */
export const EVAL_SOURCES = Object.freeze(["firm_onsite", "public_judgment", "independent_synthetic", "hard_cases", "synthetic"] as const);

const bad = (m: string) => new DomainError("validation", m, 422);

export interface RecallEvalDeps {
  /** 解析 DOCX/PDF/TXT 为文本（与材料导入同一解析通道）。 */
  parse: (bytes: Buffer, filename: string, mime: string) => Promise<{ text: string }>;
}

const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
};

/** 把界面传来的文书清单规整为金标准文书并校验（只取已知字段；不合格即拒绝，不做“尽量修复”）。 */
export function normalizeDocs(raw: unknown, what = "文书"): GoldDoc[] {
  if (!Array.isArray(raw)) throw bad(`缺少${what}`);
  if (raw.length > MAX_DOCS) throw bad(`${what}超过 ${MAX_DOCS} 份，请分批`);
  let chars = 0;
  const docs = raw.map((d: any): GoldDoc => {
    const doc: GoldDoc = {
      doc_id: String(d?.doc_id ?? ""),
      source: (EVAL_SOURCES as readonly string[]).includes(String(d?.source ?? "firm_onsite")) ? String(d?.source ?? "firm_onsite") : "\u0000invalid",
      text: typeof d?.text === "string" ? d.text : "",
      known_parties: Array.isArray(d?.known_parties)
        ? d.known_parties
            .filter((p: any) => typeof p?.name === "string" && p.name.trim() && (p.kind === "person" || p.kind === "org"))
            .map((p: any): PartyEntry => ({ name: String(p.name), kind: p.kind }))
        : [],
      spans: Array.isArray(d?.spans)
        ? d.spans.map((s: any) => ({ start: Number(s?.start), end: Number(s?.end), category: s?.category, ...(typeof s?.person_id === "string" && s.person_id ? { person_id: s.person_id } : {}) }))
        : [],
    };
    chars += doc.text.length;
    return doc;
  });
  if (chars > EVAL_MAX_CHARS) throw bad(`正文合计超过 ${EVAL_MAX_CHARS} 字，请分批`);
  const ids = new Set<string>();
  const problems: string[] = [];
  for (const d of docs) {
    if (ids.has(d.doc_id)) problems.push("文书编号重复");
    if (d.source === "\u0000invalid") problems.push(`来源只能是 ${EVAL_SOURCES.join(" / ")}`);
    if (d.spans.length > MAX_SPANS_PER_DOC) problems.push(`单份文书的标注超过 ${MAX_SPANS_PER_DOC} 处`);
    ids.add(d.doc_id);
    problems.push(...validateGold(d));
  }
  // 问题描述只含位置与类别，不含原文
  if (problems.length) throw bad(`${what}不合格（${problems.length} 处）：${problems.slice(0, 5).join("；")}`);
  return docs;
}

/** 解析 JSONL（每行一份文书）；坏行报行号。 */
function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      throw bad(`第 ${i + 1} 行不是有效的 JSON`);
    }
  }
  return out;
}

export async function openEvalFile(path: string, deps: RecallEvalDeps): Promise<{ kind: "annotations" | "text"; docs: GoldDoc[] }> {
  if (typeof path !== "string" || !path) throw bad("请先选择文件");
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw bad("文件不存在，请重新选择");
  }
  if (st.isSymbolicLink()) throw bad("不打开快捷方式或链接，请选择文件本身");
  if (!st.isFile()) throw bad("请选择文件");
  if (st.size === 0 || st.size > EVAL_MAX_FILE_BYTES) throw bad(`文件为空或超过 ${EVAL_MAX_FILE_BYTES / 1024 / 1024} MB`);
  return openEvalBytes(readFileSync(path), basename(path), deps);
}

/** 按文件名后缀解读字节：.jsonl 为标注文件，其余为待标注文书（web 开发形态由界面直接传字节）。 */
export async function openEvalBytes(bytes: Buffer, filename: string, deps: RecallEvalDeps): Promise<{ kind: "annotations" | "text"; docs: GoldDoc[] }> {
  if (bytes.length === 0 || bytes.length > EVAL_MAX_FILE_BYTES) throw bad(`文件为空或超过 ${EVAL_MAX_FILE_BYTES / 1024 / 1024} MB`);
  const name = basename(String(filename || "未命名"));
  const ext = extname(name).toLowerCase();
  if (ext === ".jsonl") return { kind: "annotations", docs: normalizeDocs(parseJsonl(bytes.toString("utf8")), "标注文件") };
  const mime = MIME[ext];
  if (!mime) throw bad("只支持 .jsonl（标注文件）与 .txt / .md / .docx / .pdf（待标注文书）");
  const parsed = await deps.parse(bytes, name, mime);
  const text = parsed.text.replace(/\r\n?/g, "\n");
  if (!text.trim()) throw bad("没有读出文字（扫描件请先在材料里识别）");
  return { kind: "text", docs: [{ doc_id: basename(name, extname(name)), source: "firm_onsite", text, known_parties: [], spans: [] }] };
}

export interface RecallReport {
  format: "kwl-s8-report/1";
  docs: number;
  options: { full_pseudonym: boolean; case_numbers: boolean };
  with_dictionary: Record<string, EvalReport>;
  rules_only: Record<string, EvalReport>;
}

/** 评测：同时给“有当事人词典”与“只靠规则”，按来源分节。每次用新的随机事项密钥（代号不跨次复用）。 */
export function runRecallEval(docs: GoldDoc[], o: { fullPseudonym?: boolean; caseNumbers?: boolean } = {}): { report: RecallReport; markdown: string } {
  const key = randomBytes(32);
  const fullPseudonym = o.fullPseudonym === true;
  const caseNumbers = o.caseNumbers === true;
  const make = (useDict: boolean) => (parties: PartyEntry[]) => new MatterTokenizer({ matterKey: key, parties: useDict ? parties : [], fullPseudonym, caseNumbers });
  const withDict = aggregateBySource(docs.map((d) => evaluateDoc(d, make(true))));
  const rulesOnly = aggregateBySource(docs.map((d) => evaluateDoc(d, make(false))));
  key.fill(0);
  const md: string[] = [];
  for (const src of Object.keys(withDict)) {
    md.push(reportMarkdown(`令牌化召回评测 · ${src}（有当事人词典）`, withDict[src]!), "", reportMarkdown(`令牌化召回评测 · ${src}（只靠规则）`, rulesOnly[src]!), "");
  }
  return { report: { format: "kwl-s8-report/1", docs: docs.length, options: { full_pseudonym: fullPseudonym, case_numbers: caseNumbers }, with_dictionary: withDict, rules_only: rulesOnly }, markdown: md.join("\n") };
}

/** 导出给律所之外的报告文件：Markdown 正文 + 机读计数（JSON）；全部由 runRecallEval 的结果生成。 */
export function reportFileText(r: { report: RecallReport; markdown: string }, generatedAt = new Date()): string {
  return [
    "<!-- Kimi Work 进所评测报告：只含计数、比例与区间，不含文书原文、文书名或标注内容 -->",
    r.markdown,
    "",
    `生成时间：${generatedAt.toISOString()}；文书 ${r.report.docs} 份。`,
    "",
    "## 机读数据",
    "",
    "```json",
    JSON.stringify(r.report, null, 2),
    "```",
    "",
  ].join("\n");
}

export function workFileText(docs: GoldDoc[]): string {
  return docs.map((d) => JSON.stringify(d)).join("\n") + "\n";
}

export function parseDecisions(raw: unknown): Map<number, Decision> {
  const m = new Map<number, Decision>();
  if (!Array.isArray(raw)) return m;
  for (const x of raw as any[]) {
    const g = Number(x?.group);
    if (!Number.isInteger(g) || g < 0) continue;
    const d = x?.decision;
    if (d === "a" || d === "b" || d === "none") m.set(g, d);
    else if (d && Array.isArray(d.spans)) m.set(g, { spans: d.spans.map((s: any) => ({ start: Number(s?.start), end: Number(s?.end), category: s?.category, ...(typeof s?.person_id === "string" && s.person_id ? { person_id: s.person_id } : {}) })) });
  }
  return m;
}

export { adjudicate, compareAnnotations };
