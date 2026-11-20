/**
 * 成果行（V18 A2；第 48 批改为卡片里的列表行；第 49 批改为单行）：事项“成果”页与全局“成果”页共用。
 * 每份文件一行（最新版）：类型方块 + 名称 + 状态 | 第 N 版（可展开旧版）· 给谁 · 时间；
 * 提交复核与下载放在行尾，下载常显为图标按钮，提交复核在悬停或键盘聚焦时出现（整行点开就是预览与签发前检查，提交复核不是唯一入口）。
 * 每个任务卡片末尾一行可展开的“过程文件（n）”（答复摘要、独立复核意见）。旧版与过程文件不给“提交复核”。
 * 只改显示：提交复核、预览、下载都对着具体那一个版本（最新版或展开后的那一版）。
 */
import { useState, type KeyboardEvent } from "react";
import { downloadPlan } from "../lib/download.ts";
import { fileTypeLabel, type FileEntry } from "../lib/deliverables.ts";
import { ARTIFACT_STATUS_LABELS, AUDIENCE_LABELS, fmtTime, fmtWhen } from "../lib/labels.ts";
import { Icon } from "./Icons.tsx";
import "../styles-deliverables.css";
import "../styles-motion.css";

const STATUS_TONE: Record<string, string> = { draft: "pill-gray", pending_review: "pill-orange", approved: "pill-green", rejected: "pill-red", superseded: "pill-gray" };

export interface ListRow {
  artifact_version_id: string;
  kind: string;
  filename: string;
  status: string;
  version: number;
  audience?: string | null;
  created_at: string;
  is_latest?: boolean;
  /** 列表里显示的名称（已还原代号）。 */
  display: string;
}

/** 状态胶囊（v9.4 U1 #15）：第 2 版起才写版数，受众放悬停提示。 */
export function StatusPill({ r, withVersion = true }: { r: { status: string; version: number; audience?: string | null }; withVersion?: boolean }) {
  return (
    <span className={`pill ${STATUS_TONE[r.status] ?? "pill-gray"}`} title={r.audience ? `受众：${AUDIENCE_LABELS[r.audience] ?? r.audience}` : undefined}>
      {ARTIFACT_STATUS_LABELS[r.status] ?? r.status}
      {withVersion && r.version > 1 ? ` · 第 ${r.version} 版` : ""}
    </span>
  );
}

/** 复核状态（第 51 批）：带色点的文字，放在对齐的状态列里（成果列表用；胶囊 StatusPill 仍用于别处）。 */
export function StatusText({ status }: { status: string }) {
  return <span className={`dl-state dl-state-${status}`}>{ARTIFACT_STATUS_LABELS[status] ?? status}</span>;
}

/** 行首的文件类型（Word / Excel / 文本）：执行页完成区用的文字标签。 */
export function FileTypeTag({ filename }: { filename: string }) {
  const t = fileTypeLabel(filename);
  return <span className={`dl-ftype dl-ftype-${t === "Word" ? "word" : t === "Excel" ? "excel" : "other"}`}>{t}</span>;
}

/** 成果列表的文件类型方块（第 48 批）：W / X / 文，颜色区分 Word、Excel、其他；读屏读出类型全称。 */
export function FileTypeIcon({ filename }: { filename: string }) {
  const t = fileTypeLabel(filename);
  const kind = t === "Word" ? "word" : t === "Excel" ? "excel" : "other";
  return (
    <span className={`dl-ficon dl-ficon-${kind}`} role="img" aria-label={t}>
      {kind === "word" ? "W" : kind === "excel" ? "X" : "文"}
    </span>
  );
}

/** 下载按钮：图标按钮，提示文字按下载下来的文件类型（Markdown 文本下载时转成 Word，见 download.ts）。 */
function DownloadButton({ r, onDownload, busy = false }: { r: ListRow; onDownload: (r: ListRow) => void; busy?: boolean }) {
  const plan = downloadPlan(r.filename);
  const title = /\.(md|markdown)$/i.test(r.filename) ? `${plan.label}（这份是文本，下载时转成 Word）` : plan.label;
  // 下载要先还原代号、再写下载留痕：进行中换成小圆环并禁用，防止连点存出多份、记多条（第 51 批）
  return (
    <button className="icon-btn dl-dl" title={busy ? "正在下载…" : title} aria-label={`${plan.label}：${r.display}`} aria-busy={busy} disabled={busy} onClick={() => onDownload(r)}>
      {busy ? <span className="kwl-spin" aria-hidden="true" /> : Icon.download()}
    </button>
  );
}

const openOnKey = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

/**
 * 一份文件：最新版一行 + 可展开的旧版。showStatus：是否在名称后显示状态胶囊（全局页按状态筛选时不显示）。
 * 第 49 批：改为单行——左边类型方块 + 名称（同族文件的共同前缀淡化、差异加粗，见 nameParts）+ 状态；右边“第 N 版”（有旧版时可展开）、
 * 给谁、时间、悬停出现的“提交复核”、下载。原来的第二行说明与“版本记录（n）”合并进“第 N 版”，一份文件只占一行。
 */
export function FileRows<T extends ListRow>({ entry, showStatus, onOpen, onDownload, onSubmit, busyId, downloadingId, parts, primary = false }: { entry: FileEntry<T>; showStatus: boolean; onOpen: (r: T) => void; onDownload: (r: ListRow) => void; onSubmit?: (r: T) => void; busyId?: string | null; downloadingId?: string | null; parts?: { head: string; tail: string } | undefined; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const r = entry.latest;
  const head = parts?.head ?? "";
  const tail = parts ? parts.tail : r.display;
  return (
    <>
      <div className={`dl-row${primary ? " is-primary" : ""}`} role="listitem" tabIndex={0} title={r.filename} onClick={() => onOpen(r)} onKeyDown={openOnKey(() => onOpen(r))}>
        <FileTypeIcon filename={r.filename} />
        <div className="dl-row-main">
          <span className="dl-row-title">
            {head && <span className="dl-name-head">{head}</span>}
            {tail}
          </span>
          {entry.replaced && <span className="dl-row-note">后面的任务里有更新的版本</span>}
        </div>
        {/* 状态列（第 51 批）：按流程某一段筛选时整列省掉（都一样），“全部”与事项页里显示 */}
        {showStatus && (
          <span className="dl-row-state">
            <StatusText status={r.status} />
          </span>
        )}
        <div className="dl-row-side" onClick={(e) => e.stopPropagation()}>
          {entry.older.length > 0 ? (
            <button className="dl-ver" aria-expanded={open} title={`展开旧版本（${entry.older.length}）`} onClick={() => setOpen((v) => !v)}>
              第 {r.version} 版
              <span className="dl-ver-chev" aria-hidden="true">{Icon.down()}</span>
            </button>
          ) : r.version > 1 ? (
            <span className="dl-ver-static">第 {r.version} 版</span>
          ) : null}
          {r.audience && r.audience !== "internal" && <span className="dl-aud">给{AUDIENCE_LABELS[r.audience] ?? r.audience}</span>}
          <span className="dl-when" title={fmtTime(r.created_at)}>{fmtWhen(r.created_at)}</span>
          {onSubmit && r.status === "draft" && !entry.replaced && (
            <button className="btn-ghost btn-sm dl-hover-action" disabled={busyId === r.artifact_version_id} aria-busy={busyId === r.artifact_version_id} onClick={() => onSubmit(r)}>
              {busyId === r.artifact_version_id ? (
                <span className="btn-busy">
                  <span className="kwl-spin" aria-hidden="true" />
                  正在提交…
                </span>
              ) : (
                "提交复核"
              )}
            </button>
          )}
          <DownloadButton r={r} onDownload={onDownload} busy={downloadingId === r.artifact_version_id} />
        </div>
      </div>
      {open &&
        entry.older.map((o) => (
          <div key={o.artifact_version_id} className="dl-row dl-row-sub" role="listitem" title={o.filename}>
            <span className="dl-sub-mark" aria-hidden="true" />
            <div className="dl-row-main">
              <span className="dl-row-meta">
                第 {o.version} 版 · {ARTIFACT_STATUS_LABELS[o.status] ?? o.status}
              </span>
            </div>
            <div className="dl-row-side">
              <span className="dl-when" title={fmtTime(o.created_at)}>{fmtWhen(o.created_at)}</span>
              <DownloadButton r={o} onDownload={onDownload} busy={downloadingId === o.artifact_version_id} />
            </div>
          </div>
        ))}
    </>
  );
}

/**
 * 任务卡片末尾的“过程文件（n）”：答复摘要、独立复核意见，默认收起；里面只有下载。
 * earlier：同样的收起行用来列“上一次运行的文件（n）”——重新运行前那一次留下、已被这一次取代的文件（第 44 批）。
 */
export function ProcessRows<T extends ListRow>({ entries, onDownload, earlier = false }: { entries: FileEntry<T>[]; onDownload: (r: ListRow) => void; earlier?: boolean }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <div className="dl-proc">
      <button className="dl-proc-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="dl-proc-chev" aria-hidden="true">{Icon.chevron()}</span>
        {earlier ? "上一次运行的文件" : "过程文件"} {entries.length} 份
        <span className="dl-proc-note">{earlier ? "重新运行前那一次留下的，已被这一次取代，不算这次的成果" : "答复摘要与复核意见，留作记录，不用交出去"}</span>
      </button>
      {open && (
        <div role="list">
          {entries.map((e) => (
            <div key={e.latest.artifact_version_id} className="dl-row dl-row-sub" role="listitem" title={e.latest.filename}>
              <FileTypeIcon filename={e.latest.filename} />
              <div className="dl-row-main">
                <span className="dl-row-title">{e.latest.display}</span>
              </div>
              <div className="dl-row-side">
                <span className="dl-when" title={fmtTime(e.latest.created_at)}>{fmtWhen(e.latest.created_at)}</span>
                <DownloadButton r={e.latest} onDownload={onDownload} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
