/**
 * 中软侧操作记录（第 9 批 S14）：中软云端对本所做过的每个写操作（谁、何时、做了什么、结果）；本机验过控制面签名与哈希链后留存，云端改写已给出的历史即告警。
 * 第 68 批：原“用量与上限”面板（UsagePanel：本所额度、律所上限、按成员、按模型、本期加量、最近几期）已从客户端移除——
 * 客户端只展示当前登录者本人的用量（pages/PersonalUsage.tsx），团队用量与上限统一在云端控制台（本所 · 概览 / 用量 / 成员）管理。
 * 律师层文案门禁只查到 CpAuditPanel 之前。
 */
import { useEffect, useState } from "react";
import { api, type CpAuditRow } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";
import { auditDetailLabel, auditFetchErrorText, auditFilter, auditResultShort, auditSentence, auditTime, type AuditFilter } from "../lib/firm-usage.ts";
import { BusyLabel, ListSkeleton } from "../components/Loading.tsx";

export function CpAuditPanel() {
  const [rows, setRows] = useState<CpAuditRow[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [withheld, setWithheld] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => {
    setBusy(true);
    api
      .cpAudit({ limit: 200 })
      .then((r) => {
        setRows(r.records);
        setFetchError(r.fetch_error);
        setWithheld(!!r.fetched?.withheld);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };
  useEffect(load, []);
  const exportAll = async () => {
    setMsg("");
    try {
      const r = await api.cpAuditExport();
      if (r) setMsg(`已导出 ${r.count} 条（${r.filename}）：原记录含哈希链，收件人可自行核验。`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  // 第 56 批：默认只看“重要改动”（日常的凭据签发、摘要更新另一档“全部”）；失败或被拒绝的两档都列
  const [filter, setFilter] = useState<AuditFilter>("important");
  const [open, setOpen] = useState<number | null>(null);
  if (err) return <div className="banner banner-red">{err}</div>;
  const view = rows ? auditFilter(rows, filter) : null;
  return (
    <div className="audit-page">
      <p className="lead-note">本所规则、成员、电脑的每一次改动（含 Kimi Work 运营人员的操作）：谁、何时、做了什么。记录不能被事后篡改，不含任何案件内容。</p>
      {fetchError && <div className={`banner ${fetchError.startsWith("cp_audit_") ? "banner-red" : "banner-gray"}`}>{auditFetchErrorText(fetchError)}</div>}
      {withheld && <div className="banner banner-red">中软那边的记录可能没给全，请联系中软核对。</div>}
      {msg && <div className="banner">{msg}</div>}
      <div className="audit-bar">
        <div className="seg" role="tablist" aria-label="筛选操作记录">
          {(
            [
              ["important", "重要改动"],
              ["all", "全部"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={`seg-btn${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>
              {label}
              {view && <span className="audit-n">{view.counts[k]}</span>}
            </button>
          ))}
        </div>
        <div className="audit-bar-actions">
          <button className="btn-ghost btn-sm" disabled={busy} aria-busy={busy} onClick={load}>
            <BusyLabel busy={busy} busyText="正在取回…">取回最新</BusyLabel>
          </button>
          <button className="btn-ghost btn-sm" disabled={busy || !rows?.length} onClick={() => void exportAll()}>
            导出全部
          </button>
        </div>
      </div>
      {rows === null || !view ? (
        <ListSkeleton rows={4} label="正在载入操作记录" />
      ) : rows.length === 0 ? (
        <p className="muted">本机还没有留存的记录。</p>
      ) : view.rows.length === 0 ? (
        <p className="muted">没有重要改动；日常的凭据签发等在“全部”里。</p>
      ) : (
        <div className="audit-list" role="table" aria-label="操作记录">
          <div className="audit-row audit-head" role="row">
            <span role="columnheader">时间</span>
            <span role="columnheader">谁</span>
            <span role="columnheader">做了什么</span>
            <span role="columnheader">结果</span>
            <span aria-hidden="true" />
          </div>
          {view.rows.map((r) => {
            const res = auditResultShort(r.result);
            const s = auditSentence(r);
            const isOpen = open === r.seq;
            return (
              <div key={r.seq} className={`audit-item${isOpen ? " is-open" : ""}`} role="rowgroup">
                <div className="audit-row" role="row">
                  <span className="audit-at" role="cell">{auditTime(r.at)}</span>
                  <span className="audit-who" role="cell">{s.who}</span>
                  <span className="audit-what" role="cell">
                    {s.what}
                    {res.why && <span className="audit-why">{res.why}</span>}
                  </span>
                  <span className={`audit-res audit-res-${res.tone}`} role="cell">
                    <span className={`sdot ${res.tone === "ok" ? "sdot-ok" : res.tone === "warn" ? "sdot-warn" : "sdot-bad"}`} aria-hidden="true" />
                    {res.text}
                  </span>
                  <button className="btn-link audit-more" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.seq)}>
                    {isOpen ? "收起" : "详情"}
                  </button>
                </div>
                {isOpen && (
                  // 给 IT 核对用：原始操作代码、对象编号、执行设备编号、序号（与导出文件同一份记录）
                  <dl className="audit-detail mono">
                    <dt>操作代码</dt>
                    <dd>{r.action}</dd>
                    <dt>对象编号</dt>
                    <dd>{r.target ?? "—"}</dd>
                    <dt>{r.actor.kind === "device" ? "设备编号" : "执行者编号"}</dt>
                    <dd>
                      {r.actor.kind}:{r.actor.id}
                    </dd>
                    {r.detail && (
                      <>
                        <dt>数值</dt>
                        <dd>{auditDetailLabel(r.detail) || JSON.stringify(r.detail)}</dd>
                      </>
                    )}
                    {r.result !== "ok" && (
                      <>
                        <dt>结果代码</dt>
                        <dd>{r.result}</dd>
                      </>
                    )}
                    <dt>序号</dt>
                    <dd>{r.seq}</dd>
                    <dt>时间</dt>
                    <dd>{fmtTime(r.at)}</dd>
                  </dl>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
