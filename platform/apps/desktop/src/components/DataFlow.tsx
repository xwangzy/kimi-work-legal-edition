/**
 * 数据去向卡（第 03 篇 §8.4）：一句话汇总本任务向哪里发了什么（文档、段落、字数、代号数；检索条数与改写；抓取页数与域名；
 * 执行域运行次数），可展开到逐条记录——查询原文只在本机显示；请求 ID 可对账。
 */
import { useEffect, useState } from "react";
import { api, type EgressRecord, type EgressSummary } from "../api.ts";
import { DEST_LABELS, fmtShortTime } from "../lib/labels.ts";
import { tokens as renderTokens } from "./Markdown.tsx";

export function DataFlowCard({ runId, tokenMap, refreshKey }: { runId: string; tokenMap?: Map<string, string | null>; refreshKey?: unknown }) {
  const [sum, setSum] = useState<EgressSummary | null>(null);
  const [records, setRecords] = useState<EgressRecord[] | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.egressSummary(runId).then(setSum).catch((e) => setErr(e.message));
    if (open) api.egressRecords({ runId }).then((r) => setRecords(r.records)).catch(() => {});
  }, [runId, open, refreshKey]);
  if (err) return <p className="muted">{err}</p>;
  if (!sum) return <p className="muted">载入中…</p>;
  return (
    <div className="dataflow">
      <p className="df-sentence">{sum.sentence}</p>
      <div className="df-grid">
        <Stat k="模型请求" v={sum.model.requests} sub={`${sum.model.chars.toLocaleString()} 字（含系统指令与工具定义）`} />
        <Stat k="出站代号" v={Object.values(sum.model.tokens_present).reduce((a, b) => a + b, 0)} sub="证件、账户、联系方式与自然人姓名" />
        <Stat k="检索" v={sum.search.sent} sub={`改写 ${sum.search.generalized} · 原文（经你确认）${sum.search.confirmed_original} · 拦截 ${sum.search.blocked}`} />
        <Stat k="抓取" v={sum.fetch.pages} sub={`${sum.fetch.domains.length} 个域名 · 拦截 ${sum.fetch.blocked}`} />
        <Stat k="执行域运行" v={sum.exec.runs} sub="无网络" />
      </div>
      {sum.blocked.length > 0 && (
        <div className="df-blocked">
          闸门拦截 {sum.blocked.length} 次（未发出）：{[...new Set(sum.blocked.map((b) => reasonLabel(b.reason)))].join("、")}
        </div>
      )}
      <button className="btn-link" onClick={() => setOpen(!open)}>{open ? "收起逐条记录" : "展开逐条记录"}</button>
      {open && records && (
        <div className="df-records">
          {records.length === 0 && <p className="muted">本任务没有出站记录。</p>}
          {records.map((r) => {
            const note = parseNote(r.note);
            return (
              <div key={r.record_id} className={`df-rec df-${r.outcome ?? "sent"}`}>
                <div className="df-rec-head">
                  <b>{DEST_LABELS[r.destination_kind] ?? r.destination_kind}</b>
                  <span className="muted">{fmtShortTime(r.created_at)} · {outcomeLabel(r.outcome)}</span>
                </div>
                {note.purpose === "model" && (
                  <div className="df-line">{r.segments} 个文本片段 · {r.chars.toLocaleString()} 字 · 代号 {Object.values(r.pseudonym_counts ?? {}).reduce((a: number, b: any) => a + Number(b), 0)} 处{note.model ? ` · ${note.model}` : ""}</div>
                )}
                {note.query && (
                  <div className="df-line">
                    查询原文（只在本机）：<span className="mono">{renderTokens(String(note.query.original ?? ""), tokenMap)}</span>
                    {note.query.sent && note.query.sent !== note.query.original ? <> → 发出：<span className="mono">{note.query.sent}</span></> : null}
                  </div>
                )}
                {note.url && <div className="df-line mono">{note.url.requested}{note.url.final && note.url.final !== note.url.requested ? ` → ${note.url.final}` : ""}</div>}
                {note.reason && r.outcome !== "sent" && <div className="df-line">原因：{reasonLabel(note.reason)}</div>}
                {note.approval_id && <div className="df-line">依据：你的确认（{String(note.approval_id).slice(0, 12)}…）</div>}
                {note.usage_note && <div className="df-line muted">{note.usage_note}</div>}
                <div className="df-line mono muted">请求 {(r.request_id ?? "—").slice(0, 24)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: number; sub: string }) {
  return (
    <div className="df-stat">
      <div className="df-k">{k}</div>
      <div className="df-v">{v}</div>
      <div className="df-sub">{sub}</div>
    </div>
  );
}

function parseNote(n: string | null): Record<string, any> {
  try {
    return JSON.parse(n ?? "{}");
  } catch {
    return {};
  }
}

function outcomeLabel(o: string | undefined): string {
  return ({ sent: "已发出", blocked: "已拦截（未发出）", failed: "失败", unknown: "结果不明（待对账）", mock: "本机模拟" } as Record<string, string>)[o ?? "sent"] ?? o ?? "";
}

export function reasonLabel(r: string): string {
  const map: Record<string, string> = {
    search_entity_requires_confirmation: "检索式含当事人（须确认或改写）",
    search_l3a_each_query: "敏感事项检索须逐条确认",
    search_forbidden_l3b: "当事人限制事项禁止检索",
    person_name_in_url: "网址含自然人姓名",
    party_entity_in_url: "网址含当事人",
    token_in_url: "网址含事项代号",
    identifier_in_url: "网址含证件或账号",
    fetch_domain_not_allowlisted: "新域名未经确认",
    redirect_domain_not_allowlisted: "跳转到未经确认的域名",
    address_not_public: "目标不是公网地址",
    basis_pending_no_egress: "依据待确认",
    media_requires_approval: "图像原样送模型须确认",
    unknown_content_block: "未知内容类型",
    aborted: "已中止",
  };
  return map[r] ?? r;
}
