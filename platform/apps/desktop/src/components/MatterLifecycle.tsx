/**
 * 事项数据生命周期（结案 → 保留期 → 删除；法律保全）。事项页“结案与删除”标签与已删除事项页共用。
 * 动作均由事项负责人执行，内核再核对一次；删除不可恢复，出具本机签名的删除回执。
 */
import { useEffect, useState } from "react";
import { api, type DeletionReceiptView, type Matter, type MatterLifecycle } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";
import { notifyDataChanged } from "../lib/events.ts";

const YEAR_CHOICES = [1, 3, 5, 10, 15, 20, 30];
const COPY_STATUS: Record<string, string> = { deleted: "已删除", pending: "待处理", irrevocable: "不可撤回", kept: "保留（未删除）", none: "不涉及" };
const INVENTORY_LABELS: Record<string, string> = {
  document_versions_imported: "导入的材料副本",
  document_versions_mounted: "挂载的原件（未删除）",
  parse_texts: "解析文本",
  artifacts: "成果",
  tokens: "代号对照",
  risk_cards: "风险卡",
  facts: "事实行",
  key_wrappings: "密钥包裹",
  egress_records: "数据去向记录（保留元数据）",
  egress_sent: "已发出的请求",
  redacted_signed_rows: "签名记录中清除内容的行",
};

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "—");

export function MatterLifecyclePanel({ matter, onChanged }: { matter: Matter; onChanged: () => void }) {
  const [lc, setLc] = useState<MatterLifecycle | null>(null);
  const [receipt, setReceipt] = useState<DeletionReceiptView | null>(null);
  const [years, setYears] = useState(10);
  const [holdReason, setHoldReason] = useState("");
  const [confirmTitle, setConfirmTitle] = useState("");
  const [early, setEarly] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const owner = matter.my_role === "owner";
  const [archived, setArchived] = useState<string | null>(null);

  /** 结案归档（开放格式 ZIP：清单签名、原件、成果、风险卡与事实、签名事件链）；保存位置由律师决定。 */
  const exportArchive = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.archiveMatter(matter.matter_id);
      const bin = Uint8Array.from(atob(r.data_base64), (ch) => ch.charCodeAt(0));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bin], { type: "application/zip" }));
      a.download = r.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      const miss = r.missing.length ? `；${r.missing.length} 份未收入（${r.missing.map((m) => `${m.filename}：${m.reason}`).join("；")}）` : "";
      setArchived(`已导出《${r.filename}》：${r.counts.materials ?? 0} 份原件、${r.counts.artifacts ?? 0} 份成果、${r.counts.signed_events ?? 0} 条签名事件${miss}。sha256 ${r.sha256.slice(0, 16)}…（留痕）`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const load = () =>
    api
      .matterLifecycle(matter.matter_id)
      .then((r) => {
        setLc(r.lifecycle);
        setReceipt(r.receipt);
        setYears(r.retention_years.default);
      })
      .catch((e) => setMsg((e as Error).message));
  useEffect(() => {
    void load();
  }, [matter.matter_id]);

  const act = async (fn: () => Promise<unknown>, note: string) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
      setMsg(note);
      await load();
      onChanged();
      notifyDataChanged();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!lc) return <p className="muted">{msg || "载入中…"}</p>;
  if (lc.lifecycle === "purged") return receipt ? <DeletionReceipt view={receipt} /> : <p className="muted">事项数据已删除。</p>;

  const beforeRetention = !!lc.retention_until && lc.retention_until > new Date().toISOString();
  return (
    <section className="lifecycle">
      {!owner && <div className="banner banner-orange">结案、法律保全与删除只能由事项负责人操作。</div>}
      <div className="lifecycle-status">
        <b>{lc.lifecycle === "active" ? "进行中" : "已结案（只读）"}</b>
        {lc.lifecycle === "closed" && <span className="muted">结案于 {day(lc.closed_at)}，保留至 {day(lc.retention_until)}</span>}
        {lc.legal_hold && <span className="tag tag-warn">法律保全：{lc.legal_hold_reason}</span>}
      </div>

      {lc.lifecycle === "active" && (
        <div className="card lifecycle-card">
          <h3>结案</h3>
          <p className="muted">
            结案后本事项只读：不能再发起任务或添加材料；这台电脑上的 Agent 会话、工作区与材料快照会清理，材料、成果与记录保留。
            保留期满后可以删除本事项数据；需要继续工作时可以重新打开。
          </p>
          <label className="field">
            <span>保留期</span>
            <select aria-label="保留期" value={years} onChange={(e) => setYears(Number(e.target.value))} disabled={!owner || busy}>
              {YEAR_CHOICES.map((y) => (
                <option key={y} value={y}>{y} 年</option>
              ))}
            </select>
          </label>
          <div className="modal-actions">
            <button className="btn-primary" disabled={!owner || busy} onClick={() => void act(() => api.closeMatter(matter.matter_id, years), `已结案，保留 ${years} 年（留痕）`)}>结案</button>
          </div>
        </div>
      )}

      <div className="card lifecycle-card">
        <h3>导出结案归档</h3>
        <p className="muted">
          一个 ZIP：导入的原件、成果（代号已还原）、风险卡与事实、签名事件链与签名清单，第三方不依赖本产品即可核对。归档含案卷原文与当事人信息，请保存到律所档案位置；导出会留痕，并写进日后的删除回执。
        </p>
        <div className="modal-actions">
          <button className="btn-ghost" disabled={!owner || busy} onClick={() => void exportArchive()}>导出归档（ZIP）</button>
        </div>
        {archived && <p className="muted">{archived}</p>}
      </div>

      {lc.lifecycle === "closed" && (
        <div className="card lifecycle-card">
          <h3>重新打开</h3>
          <p className="muted">重新打开后可以继续发起任务和添加材料，保留期作废，下次结案时重新设定。</p>
          <div className="modal-actions">
            <button className="btn-ghost" disabled={!owner || busy} onClick={() => void act(() => api.reopenMatter(matter.matter_id), "已重新打开（留痕）")}>重新打开</button>
          </div>
        </div>
      )}

      <div className="card lifecycle-card">
        <h3>法律保全</h3>
        <p className="muted">诉讼保全、监管调查或客户要求保存期间，设置法律保全：保全解除前本事项数据不能删除。</p>
        {lc.legal_hold ? (
          <div className="modal-actions">
            <button className="btn-ghost" disabled={!owner || busy} onClick={() => void act(() => api.setLegalHold(matter.matter_id, false), "已解除法律保全（留痕）")}>解除保全</button>
          </div>
        ) : (
          <>
            <label className="field">
              <span>保全原因</span>
              <input aria-label="保全原因" value={holdReason} maxLength={300} placeholder="例如：（2026）京 01 民初 123 号诉讼保全" onChange={(e) => setHoldReason(e.target.value)} disabled={!owner || busy} />
            </label>
            <div className="modal-actions">
              <button className="btn-ghost" disabled={!owner || busy || !holdReason.trim()} onClick={() => void act(() => api.setLegalHold(matter.matter_id, true, holdReason.trim()), "已设置法律保全（留痕）")}>设置保全</button>
            </div>
          </>
        )}
      </div>

      {lc.lifecycle === "closed" && !lc.legal_hold && (
        <div className="card lifecycle-card lifecycle-danger">
          <h3>删除本事项数据</h3>
          {!archived && <div className="banner banner-orange">删除前建议先“导出结案归档”，按律所档案制度保存。</div>}
          <p>删除后不可恢复。会删除：本机的事项密钥（残留的加密数据从此无法解开）、导入的材料副本、解析文本、代号对照、风险卡、事实、成果正文，以及记录里的文件名、任务目标与检索原文。</p>
          <p className="muted">
            不会删除：挂载的原件（在你自己的文件夹里）。审计与签名记录保留“做过什么”的元数据（时间、去向、字数），不再含内容。
            已发给模型或检索服务的内容（均为代号化后的文字）无法撤回；团队事项在其他成员电脑上的副本须等对方上线后处理，回执会如实写明。
          </p>
          {beforeRetention && (
            <>
              <label className="lifecycle-check">
                <input type="checkbox" aria-label="保留期未届满，仍要提前删除" checked={early} onChange={(e) => setEarly(e.target.checked)} disabled={!owner || busy} />
                保留期至 {day(lc.retention_until)} 尚未届满，仍要提前删除
              </label>
              {early && (
                <label className="field">
                  <span>提前删除原因（写进删除回执）</span>
                  <input aria-label="提前删除原因" value={reason} maxLength={300} placeholder="例如：客户书面要求删除（2026-10-12 函）" onChange={(e) => setReason(e.target.value)} disabled={!owner || busy} />
                </label>
              )}
            </>
          )}
          <label className="field">
            <span>输入事项名称“{matter.title}”以确认</span>
            <input aria-label="输入事项名称以确认删除" value={confirmTitle} onChange={(e) => setConfirmTitle(e.target.value)} disabled={!owner || busy} />
          </label>
          <div className="modal-actions">
            <button
              className="btn-ghost btn-danger"
              disabled={!owner || busy || confirmTitle !== matter.title || (beforeRetention && (!early || !reason.trim()))}
              onClick={() => void act(() => api.purgeMatter(matter.matter_id, { confirm_title: confirmTitle, early: beforeRetention && early, reason: reason.trim() }), "已删除本事项数据，删除回执已生成")}
            >
              删除本事项数据
            </button>
          </div>
        </div>
      )}
      {msg && <p className="muted" style={{ whiteSpace: "pre-line" }}>{msg}</p>}
    </section>
  );
}

export function DeletionReceipt({ view }: { view: DeletionReceiptView }) {
  const r = view.receipt;
  const download = () => {
    const blob = new Blob([JSON.stringify({ receipt: r, signature: view.signature, signer_cert: view.signer_cert }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `删除回执-${r.receipt_id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <section className="lifecycle">
      <div className="lifecycle-status">
        <b>事项数据已删除</b>
        <span className="muted">删除于 {fmtTime(r.purged_at)}{r.early ? `（提前删除：${r.reason ?? ""}）` : ""}</span>
        <span className={`tag ${view.signature_valid ? "tag-ok" : "tag-warn"}`}>{view.signature_valid ? "回执签名有效" : "回执签名无法核验"}</span>
      </div>
      <table className="data">
        <thead><tr><th>副本所在</th><th>状态</th><th>说明</th></tr></thead>
        <tbody>
          {r.copies.map((c) => (
            <tr key={c.where}>
              <td>{c.where}</td>
              <td>{COPY_STATUS[c.status] ?? c.status}</td>
              <td className="muted">{c.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary>删除清单</summary>
        <ul className="plain-list">
          {Object.entries(r.inventory).map(([k, n]) => (
            <li key={k}>{INVENTORY_LABELS[k] ?? k}：{n}</li>
          ))}
        </ul>
      </details>
      <div className="modal-actions">
        <button className="btn-ghost" onClick={download}>保存删除回执（可离线验签）</button>
      </div>
    </section>
  );
}
