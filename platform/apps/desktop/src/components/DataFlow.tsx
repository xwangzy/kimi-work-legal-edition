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
  // 结果不明（待核对）的记录数（复核 S6B-02：对账要在任务的“数据去向”里就能做，不只在管理员的诊断页）
  const [unknownCount, setUnknownCount] = useState(0);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.egressSummary(runId).then(setSum).catch((e) => setErr(e.message));
    if (open) api.egressRecords({ runId }).then((r) => setRecords(r.records)).catch(() => {});
    api
      .egressUnresolved()
      .then((r) => setUnknownCount(r.records.filter((x: any) => x.run_id === runId && x.reconcile !== "done").length))
      .catch(() => setUnknownCount(0));
  }, [runId, open, refreshKey, tick]);
  const reconcile = async (recordId: string, resolution: "confirmed_sent" | "not_sent" | "unknown") => {
    setBusy(true);
    try {
      await api.egressReconcile(recordId, resolution);
      setTick((n) => n + 1);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (err) return <p className="muted">{err}</p>;
  if (!sum) return <p className="muted">载入中…</p>;
  return (
    <div className="dataflow">
      <p className="df-sentence">{sum.sentence}</p>
      <div className="df-grid">
        {/* 律师语言（v9.2 §4.4；Y4 #19 / 10-13 P1-12）：说“发给谁、换掉了什么、有没有没发出去的”，不出现系统术语 */}
        <Stat k="发给 AI 模型（次）" v={sum.model.requests} sub={`共约 ${sum.model.chars.toLocaleString()} 字（含给 AI 的工作说明）`} />
        <Stat k="换成代号（处）" v={Object.values(sum.model.tokens_present).reduce((a, b) => a + b, 0)} sub="姓名、证件号、账号、联系方式等" />
        <Stat k="联网查资料（次）" v={sum.search.sent} sub={`去掉当事人名称 ${sum.search.generalized} · 经你确认按原文 ${sum.search.confirmed_original} · 没有发出 ${sum.search.blocked}`} />
        <Stat k="打开网页（页）" v={sum.fetch.pages} sub={`${sum.fetch.domains.length} 个网站 · 没有打开 ${sum.fetch.blocked}`} />
        <Stat k="本机计算（次）" v={sum.exec.runs} sub="在你的电脑上运行，不联网" />
      </div>
      {sum.blocked.length > 0 && (
        <div className="df-blocked">
          有 {sum.blocked.length} 次没有发出（软件在发出前拦下）：{[...new Set(sum.blocked.map((b) => reasonLabel(b.reason)))].join("、")}
        </div>
      )}
      {unknownCount > 0 && (
        <div className="df-blocked">
          有 {unknownCount} 条记录不能确定是否已发出（发送途中软件中断）。请展开逐条记录，按你的判断逐条登记“已发出 / 没有发出 / 无法确定”（只登记结论，不会重发）。
        </div>
      )}
      <button className="btn-link" onClick={() => setOpen(!open)}>{open ? "收起逐条记录" : "展开逐条记录"}</button>
      {open && records && (
        <div className="df-records">
          {records.length === 0 && <p className="muted">本任务没有内容离开这台电脑。</p>}
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
                {note.purpose === "model" && note.suspected_names && Number(note.suspected_names.high) + Number(note.suspected_names.medium) > 0 && (
                  <div className="df-line df-warn">
                    发送前复查：另有 {Number(note.suspected_names.high) + Number(note.suspected_names.medium)} 处像姓名的原文没有替换为代号，已随这次请求发出。
                    在事项的“当事人”里补上这些人，之后的发送会自动替换。
                  </div>
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
                {r.outcome === "unknown" && note.reconcile === "done" && (
                  <div className="df-line muted">已登记：{note.resolution === "confirmed_sent" ? "已发出" : note.resolution === "not_sent" ? "没有发出" : "无法确定"}</div>
                )}
                {r.outcome === "unknown" && note.reconcile !== "done" && (
                  <div className="df-line">
                    这条是否已发出：
                    {(["confirmed_sent", "not_sent", "unknown"] as const).map((res) => (
                      <button key={res} className="btn-link" disabled={busy} onClick={() => void reconcile(r.record_id, res)}>
                        {res === "confirmed_sent" ? "已发出" : res === "not_sent" ? "没有发出" : "无法确定"}
                      </button>
                    ))}
                  </div>
                )}
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
    seat_unavailable: "席位未取得或已失效",
    search_upstream_unavailable: "检索服务暂不可用",
    query_empty_after_generalization: "去掉当事人信息后查询为空",
  };
  // 未登记的原因不把内部代码直接给律师看（代码仍在逐条记录的请求编号里可对账）
  return map[r] ?? "其他原因";
}
