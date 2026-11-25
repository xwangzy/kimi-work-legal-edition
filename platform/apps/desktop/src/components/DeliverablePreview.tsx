/**
 * 成果页右侧预览（第 66 批 V40 P0-3）：选中一份文件就地看内容，不必先跳到复核页。
 * 头部：类型 + 名称；一行状态（复核状态 · 第 N 版 · 给谁 · 时间）与归属（事项 · 任务）；版本切换；主操作按状态给一个
 * （草稿：提交复核；待复核 / 退回：去复核签发；已签发：下载），其余收为次要按钮。
 * 预览与复核页同一条路：Office 成果由内核渲染白名单 HTML、文本取令牌形态原文，代号只在本机界面还原（SafePreview 隔离框架）。
 */
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { nav } from "../App.tsx";
import { ARTIFACT_STATUS_LABELS, AUDIENCE_LABELS, fmtTime, fmtWhen } from "../lib/labels.ts";
import { restoreTokens } from "../lib/tokens.ts";
import { FileTypeIcon, type ListRow } from "./ArtifactRow.tsx";
import { Icon } from "./Icons.tsx";
import { BusyLabel, KimiPulse } from "./Loading.tsx";
import { PreviewError, SafePreview } from "./SafePreview.tsx";

export interface PreviewRow extends ListRow {
  matter_id: string;
  matter_title?: string;
  run_id?: string | null;
  save_name?: string;
}

const STATUS_NEXT: Record<string, string> = {
  draft: "AI 生成的草稿，还没复核。提交复核后在复核页核对引用与事实，再签发。",
  pending_review: "已提交，等你在复核页核对后签发。",
  rejected: "复核时退回了，改好后再提交。",
  approved: "已签发，可以对外使用。",
  superseded: "后面有更新的版本。",
};

export function DeliverablePreview({ row, versions, taskLabel, onDownload, onSubmit, busy, downloading, onClose }: {
  row: PreviewRow;
  /** 同一份文件的各版本（新的在前），用于切换。 */
  versions: PreviewRow[];
  taskLabel?: string | null;
  onDownload: (r: PreviewRow) => void;
  onSubmit: (r: PreviewRow) => void;
  busy: boolean;
  downloading: boolean;
  onClose: () => void;
}) {
  const [cur, setCur] = useState<PreviewRow>(row);
  useEffect(() => setCur(row), [row.artifact_version_id]);
  const [preview, setPreview] = useState<{ id: string; text: string; office: boolean; error?: string } | null>(null);
  const [tokenMap, setTokenMap] = useState<Map<string, string | null>>(new Map());
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setPreview(null);
    const id = cur.artifact_version_id;
    const office = /\.(docx|xlsx)$/i.test(cur.filename);
    const text = /\.(md|txt|markdown|csv|json)$/i.test(cur.filename);
    const load = office
      ? api.artifactHtml(id).then((r) => r.html)
      : text
        ? api.artifactText(id).then((r) => new TextDecoder().decode(Uint8Array.from(atob(r.data_base64), (c) => c.charCodeAt(0))))
        : Promise.resolve("");
    load
      .then(async (t) => {
        if (!live) return;
        setPreview({ id, text: t, office });
        if (t.includes("〔")) {
          const m = await restoreTokens(cur.matter_id, t).catch(() => new Map<string, string | null>());
          if (live) setTokenMap(m);
        }
      })
      .catch((e) => live && setPreview({ id, text: "", office, error: String((e as Error)?.message ?? "") || "没有给出具体原因" }));
    return () => {
      live = false;
    };
  }, [cur.artifact_version_id, cur.filename, cur.matter_id, nonce]);

  const isLatest = versions.length === 0 || versions[0]!.artifact_version_id === cur.artifact_version_id;
  const st = cur.status;
  const primary =
    st === "draft" && isLatest ? (
      <button className="btn-primary btn-sm" disabled={busy} aria-busy={busy} onClick={() => onSubmit(cur)}>
        <BusyLabel busy={busy} busyText="正在提交…">提交复核</BusyLabel>
      </button>
    ) : st === "pending_review" || st === "rejected" ? (
      <button className="btn-primary btn-sm" onClick={() => nav(`/review/${cur.artifact_version_id}`)}>去复核签发</button>
    ) : st === "approved" ? (
      <button className="btn-primary btn-sm" disabled={downloading} aria-busy={downloading} onClick={() => onDownload(cur)}>
        <BusyLabel busy={downloading} busyText="正在下载…">下载</BusyLabel>
      </button>
    ) : null;

  return (
    <aside className="dlp" aria-label={`预览：${cur.display}`}>
      <header className="dlp-head">
        <div className="dlp-title-row">
          <FileTypeIcon filename={cur.filename} />
          <h2 className="dlp-title" title={cur.filename}>{cur.display}</h2>
          <button className="icon-btn dlp-close" aria-label="关闭预览" onClick={onClose}>{Icon.x()}</button>
        </div>
        <div className="dlp-meta">
          <span className={`dl-state dl-state-${st}`}>{ARTIFACT_STATUS_LABELS[st] ?? st}</span>
          {cur.version > 1 || versions.length > 1 ? <span>第 {cur.version} 版</span> : null}
          {cur.audience && cur.audience !== "internal" && <span>给{AUDIENCE_LABELS[cur.audience] ?? cur.audience}</span>}
          {!cur.run_id && <span title={fmtTime(cur.created_at)}>{fmtWhen(cur.created_at)}</span>}
        </div>
        <div className="dlp-where">
          {cur.matter_title && (
            <button className="btn-link" onClick={() => nav(`/matter/${cur.matter_id}`)}>
              <Icon.folder /> {cur.matter_title}
            </button>
          )}
          {cur.run_id && (
            <button className="btn-link" onClick={() => nav(`/run/${cur.run_id}/${cur.matter_id}`)}>
              <Icon.task /> {taskLabel || "这次任务"}
            </button>
          )}
        </div>
        <p className="dlp-next">{STATUS_NEXT[st] ?? ""}</p>
        <div className="dlp-actions">
          {primary}
          {st !== "approved" && (
            <button className="btn-ghost btn-sm" disabled={downloading} aria-busy={downloading} onClick={() => onDownload(cur)}>
              <BusyLabel busy={downloading} busyText="正在下载…">下载</BusyLabel>
            </button>
          )}
          {st !== "pending_review" && st !== "rejected" && (
            <button className="btn-ghost btn-sm" onClick={() => nav(`/review/${cur.artifact_version_id}`)}>
              {st === "approved" ? "查看签发记录" : "打开复核页"}
            </button>
          )}
        </div>
        {versions.length > 1 && (
          <div className="dlp-versions" role="tablist" aria-label="版本">
            {versions.map((v) => (
              <button key={v.artifact_version_id} role="tab" aria-selected={v.artifact_version_id === cur.artifact_version_id} className={`dlp-ver${v.artifact_version_id === cur.artifact_version_id ? " on" : ""}`} onClick={() => setCur(v)} title={`${ARTIFACT_STATUS_LABELS[v.status] ?? v.status} · ${fmtTime(v.created_at)}`}>
                第 {v.version} 版{v === versions[0] ? "（最新）" : ""}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="dlp-body">
        {preview === null ? (
          <div className="dlp-loading" role="status">
            <KimiPulse />
            <span>正在生成预览…</span>
          </div>
        ) : preview.error ? (
          <PreviewError message={preview.error} onRetry={() => setNonce((n) => n + 1)} />
        ) : preview.text ? (
          <SafePreview filename={cur.filename} text={preview.text} tokenMap={tokenMap} office={preview.office} compactNote />
        ) : (
          <div className="dlp-empty">这类文件不能在这里预览，可以下载后打开。</div>
        )}
      </div>
    </aside>
  );
}
