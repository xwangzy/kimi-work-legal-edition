/**
 * 数据去向卡（v9 第 03 篇 §8.4）：按任务汇总本机事项账本里的去向记录与执行域事件，给出一句话与分项计数——
 * “本任务向 Kimi 模型（经中软网关）发送了 3 份文档的 42 个段落、共 18,240 字，其中证件、账户、联系方式与自然人姓名替换为代号 11 处；
 *   向中软检索服务发送 6 条令牌化查询（1 条经你确认后改写）；本机抓取 4 个公开网页（2 个域名）；在本机执行域中运行代码 9 次（无网络）……”
 * 只读，查询原文只在本机显示（逐条记录由 egress.records 提供）。
 */
import type { KernelDb } from "../db.ts";

export interface EgressSummary {
  run_id: string;
  model: { requests: number; documents: number; segments: number; chars: number; tokens_present: Record<string, number>; replaced_at_gate: number; destinations: string[] };
  /** confirmed_original：经律师逐条确认按原文发出（含机构当事人名称）的条数——单列，不计为“令牌化查询”（复核 S5-A01）。 */
  search: { sent: number; generalized: number; confirmed: number; confirmed_original: number; blocked: number };
  fetch: { pages: number; domains: string[]; blocked: number };
  exec: { runs: number };
  blocked: { purpose: string; reason: string; at: string }[];
  unresolved: number;
  sentence: string;
}

interface RecordRow {
  destination_kind: string;
  destination_host: string;
  chars: number;
  segments: number;
  pseudonym_counts: string;
  doc_refs: string;
  note: string | null;
  outcome: string;
  created_at: string;
}

const MODEL_DEST: Record<string, string> = {
  legal_gateway: "Kimi 模型（经中软网关）",
  maas_model: "Kimi 模型（经中软网关）",
  byok_model: "Kimi 模型（律所自带密钥，不经中软）",
  private_model: "律所私有模型",
};

function json<T>(s: string | null | undefined, d: T): T {
  try {
    return (JSON.parse(s ?? "") as T) ?? d;
  } catch {
    return d;
  }
}

export function summarizeEgress(db: KernelDb, runId: string): EgressSummary {
  const rows = db.all<RecordRow>(
    `SELECT destination_kind, destination_host, chars, segments, pseudonym_counts, doc_refs, note, outcome, created_at FROM egress_records WHERE run_id = ? ORDER BY created_at`,
    [runId],
  );
  const s: EgressSummary = {
    run_id: runId,
    model: { requests: 0, documents: 0, segments: 0, chars: 0, tokens_present: {}, replaced_at_gate: 0, destinations: [] },
    search: { sent: 0, generalized: 0, confirmed: 0, confirmed_original: 0, blocked: 0 },
    fetch: { pages: 0, domains: [], blocked: 0 },
    exec: { runs: 0 },
    blocked: [],
    unresolved: 0,
    sentence: "",
  };
  const docs = new Set<string>();
  const domains = new Set<string>();
  const modelDests = new Set<string>();
  for (const r of rows) {
    const note = json<Record<string, any>>(r.note, {});
    const purpose = String(note.purpose ?? (r.destination_kind in MODEL_DEST ? "model" : ""));
    if (r.outcome === "unknown") s.unresolved += 1;
    if (r.outcome === "blocked") {
      s.blocked.push({ purpose, reason: String(note.reason ?? ""), at: r.created_at });
      if (purpose === "search") s.search.blocked += 1;
      if (purpose === "fetch") s.fetch.blocked += 1;
      continue;
    }
    if (r.outcome !== "sent" && r.outcome !== "unknown") continue;
    if (purpose === "model") {
      s.model.requests += 1;
      s.model.segments += r.segments;
      s.model.chars += r.chars;
      modelDests.add(r.destination_kind);
      for (const d of json<{ document_version_id?: string }[]>(r.doc_refs, [])) if (d?.document_version_id) docs.add(d.document_version_id);
      for (const [k, v] of Object.entries(json<Record<string, number>>(r.pseudonym_counts, {}))) s.model.tokens_present[k] = (s.model.tokens_present[k] ?? 0) + Number(v || 0);
      for (const v of Object.values((note.replaced_at_gate ?? {}) as Record<string, number>)) s.model.replaced_at_gate += Number(v || 0);
    } else if (purpose === "search") {
      s.search.sent += 1;
      if (note.query?.decision === "generalized") s.search.generalized += 1;
      if (note.query?.decision === "confirmed_original") s.search.confirmed_original += 1;
      if (note.approval_id) s.search.confirmed += 1;
    } else if (purpose === "fetch") {
      s.fetch.pages += 1;
      const u = String(note.url?.final ?? note.url?.requested ?? "");
      try {
        if (u) domains.add(new URL(u).hostname);
      } catch {
        // 记录里的 URL 不规范：不计域名
      }
    }
  }
  s.model.documents = docs.size;
  s.model.destinations = [...modelDests];
  s.fetch.domains = [...domains];
  s.exec.runs = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'agent.exec.finished'`, [runId])?.n ?? 0;
  s.sentence = sentence(s);
  return s;
}

function sentence(s: EgressSummary): string {
  const parts: string[] = [];
  if (s.model.requests > 0) {
    const dest = s.model.destinations.map((d) => MODEL_DEST[d] ?? d).filter((v, i, a) => a.indexOf(v) === i).join("、");
    const tokens = Object.values(s.model.tokens_present).reduce((a, b) => a + b, 0);
    parts.push(
      `本任务向${dest}发送了 ${s.model.requests} 次请求${s.model.documents ? `，涉及 ${s.model.documents} 份文档` : ""}，共 ${s.model.chars.toLocaleString("zh-CN")} 字` +
        `（含 Agent 的系统指令与工具定义，每次请求都会重复发送），其中证件、账户、联系方式与自然人姓名以代号出现 ${tokens} 处`,
    );
  }
  if (s.search.sent > 0) {
    const general = s.search.sent - s.search.generalized - s.search.confirmed_original;
    const items = [
      general > 0 ? `${general} 条一般性查询（令牌化、去除已知当事人名称）` : "",
      s.search.generalized ? `${s.search.generalized} 条改写后发出` : "",
      s.search.confirmed_original ? `${s.search.confirmed_original} 条经你逐条确认按原文发出（含机构当事人名称）` : "",
    ].filter(Boolean);
    parts.push(`向中软检索服务发送 ${s.search.sent} 条查询（${items.join("，")}）`);
  }
  if (s.fetch.pages > 0) parts.push(`本机抓取 ${s.fetch.pages} 个公开网页（${s.fetch.domains.length} 个域名）`);
  if (s.exec.runs > 0) parts.push(`在本机执行域中运行代码 ${s.exec.runs} 次（无网络）`);
  const blocked = s.blocked.length ? `出站闸门拦截 ${s.blocked.length} 次（未发出）。` : "";
  const unresolved = s.unresolved ? `${s.unresolved} 次出站结果不明，已进入对账。` : "";
  if (parts.length === 0) return `本任务没有向这台电脑之外发送任何内容。${blocked}${unresolved}`;
  return `${parts.join("；")}；原件与成果的其余副本未离开律所侧。${blocked}${unresolved}`;
}
