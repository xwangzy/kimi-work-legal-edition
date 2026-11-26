/**
 * 成果页右侧预览（第 66 批 V40 P0-3）：选中一份文件就地看内容，不必先跳到复核页。
 * 第 67 批（V41 工作线 D）重做头部，只留两行：
 * - 第一行：文件图形 + 完整名称 | 一个主操作（按状态：草稿“提交复核”、待复核 / 退回“去复核签发”、已签发“下载”）+ 下载图标 + 更多；
 * - 第二行：状态（色点 + 文字，含义在悬停提示）· 版本切换（第 N 版 ▾）· 给谁 · 时间 · 几处【待填】· 事项 › 任务（可点）。
 * 改前头部四行：状态、归属、一句长说明、三个同样重的按钮，再加一排版本页签；说明收进状态的悬停提示，“打开复核页”“看这次任务”“打开事项”进“更多”。
 * 预览与复核页同一条路：Office 成果由内核渲染白名单 HTML、文本取令牌形态原文，代号只在本机界面还原（SafePreview 隔离框架）。
 */
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { nav } from "../App.tsx";
import { ARTIFACT_STATUS_LABELS, AUDIENCE_LABELS, fmtTime, fmtWhen } from "../lib/labels.ts";
import { isEarlierRun, pendingFillCount, PROCESS_KINDS, whenText } from "../lib/deliverables.ts";
import { restoreTokens } from "../lib/tokens.ts";
import { DownloadButton, FileGlyph, MenuButton, StatusText, type ListRow, type MenuItem } from "./ArtifactRow.tsx";
import { Icon } from "./Icons.tsx";
import { BusyLabel, KimiPulse } from "./Loading.tsx";
import { PreviewError, SafePreview } from "./SafePreview.tsx";

export interface PreviewRow extends ListRow {
  matter_id: string;
  matter_title?: string;
  run_id?: string | null;
  save_name?: string;
}

export function DeliverablePreview({ row, versions, taskLabel, onDownload, onSubmit, busy, downloading }: {
  row: PreviewRow;
  /** 同一份文件的各版本（新的在前），用于切换。 */
  versions: PreviewRow[];
  taskLabel?: string | null;
  onDownload: (r: PreviewRow) => void;
  onSubmit: (r: PreviewRow) => void;
  busy: boolean;
  downloading: boolean;
  /** 第 66 批的关闭按钮（第 67 批起预览是常驻的一栏，不再关闭；保留参数以兼容）。 */
  onClose?: () => void;
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

  const latest = versions[0] ?? cur;
  const isLatest = versions.length === 0 || latest.artifact_version_id === cur.artifact_version_id;
  const st = cur.status;
  const toReview = () => nav(`/review/${cur.artifact_version_id}`);
  // 和列表同一口径：过程文件（答复摘要、复核意见）、重新运行前的文件、已被后面任务取代的版本不能提交复核
  const record = PROCESS_KINDS.has(cur.kind) || isEarlierRun(cur) || cur.is_latest === false;
  // 一个主操作（黑底，全视图唯一）；看旧版时不给主操作，给“回到最新版”
  const primary = !isLatest ? (
    <button className="btn-ghost btn-sm" onClick={() => setCur(latest)}>
      回到第 {latest.version} 版（最新）
    </button>
  ) : record ? null : st === "draft" ? (
    <button className="btn-primary btn-sm" disabled={busy} aria-busy={busy} title={STATUS_NEXT.draft} onClick={() => onSubmit(cur)}>
      <BusyLabel busy={busy} busyText="正在提交…">提交复核</BusyLabel>
    </button>
  ) : st === "pending_review" || st === "rejected" ? (
    <button className="btn-primary btn-sm" onClick={toReview}>去复核</button>
  ) : st === "approved" ? (
    <button className="btn-primary btn-sm" disabled={downloading} aria-busy={downloading} onClick={() => onDownload(cur)}>
      <BusyLabel busy={downloading} busyText="正在下载…">下载</BusyLabel>
    </button>
  ) : null;
  // 复核页入口不藏进“更多”（第三轮，独立评审 #5）：待复核 / 退回时主按钮就是“去复核”；草稿在主按钮旁露一个文字按钮“复核页”，已签发露“签发记录”
  const reviewText = isLatest && !record && (st === "draft" || st === "approved") ? (
    <button className="dlp-text-btn" title={st === "approved" ? "看签发前检查与签发记录" : "核对引用与事实，再签发"} onClick={toReview}>
      {st === "approved" ? "签发记录" : "复核页"}
    </button>
  ) : null;
  const reviewShown = isLatest && !record && st !== "superseded";
  const more: MenuItem[] = [
    ...(reviewShown ? [] : [{ label: "打开复核页", hint: "核对引用与事实", onSelect: toReview }]),
    ...(cur.run_id ? [{ label: "看这次任务", hint: taskName(taskLabel), onSelect: () => nav(`/run/${cur.run_id}/${cur.matter_id}`) }] : []),
    { label: "打开事项", hint: cur.matter_title, onSelect: () => nav(`/matter/${cur.matter_id}`) },
  ];
  const fills = preview && !preview.error ? pendingFillCount(preview.text) : 0;
  const task = taskName(taskLabel);

  return (
    <aside className="dlp" aria-label={`预览：${cur.display}`}>
      <header className="dlp-head">
        <div className="dlp-title-row">
          <FileGlyph filename={cur.filename} size="lg" />
          <h2 className="dlp-title" title={cur.display}>{cur.display}</h2>
          <div className="dlp-actions">
            {primary}
            {reviewText}
            {/* 已签发时主操作就是下载，不再重复下载图标 */}
            {!(isLatest && st === "approved") && <DownloadButton r={cur} onDownload={(r) => onDownload(r as PreviewRow)} busy={downloading} />}
            <MenuButton label="更多操作" title="更多" className="icon-btn dl-more" items={more}>
              {Icon.more()}
            </MenuButton>
          </div>
        </div>
        <div className="dlp-meta">
          <span className="dlp-meta-part">
            <StatusText status={st} />
          </span>
          {versions.length > 1 ? (
            <span className="dlp-meta-part">
              <MenuButton
                label="切换版本"
                title={`共 ${versions.length} 个版本`}
                className="dlp-ver-btn"
                align="left"
                items={versions.map((v, i) => ({
                  label: `第 ${v.version} 版${i === 0 ? "（最新）" : ""}`,
                  hint: `${ARTIFACT_STATUS_LABELS[v.status] ?? v.status} · ${whenText(fmtWhen(v.created_at))}`,
                  checked: v.artifact_version_id === cur.artifact_version_id,
                  onSelect: () => setCur(v),
                }))}
              >
                第 {cur.version} 版{isLatest ? "" : "（旧版）"}
                <span className="dl-ver-chev" aria-hidden="true">{Icon.down()}</span>
              </MenuButton>
            </span>
          ) : cur.version > 1 ? (
            <span className="dlp-meta-part">第 {cur.version} 版</span>
          ) : null}
          {cur.audience && cur.audience !== "internal" && <span className="dlp-meta-part">给{AUDIENCE_LABELS[cur.audience] ?? cur.audience}</span>}
          <span className="dlp-meta-part" title={fmtTime(cur.created_at)}>{whenText(fmtWhen(cur.created_at))}</span>
          {fills > 0 && (
            <span className="dlp-meta-part dlp-fills" title={`文中有 ${fills} 处“【待填】”，签发前要补上`}>
              {fills} 处待填
            </span>
          )}
          <span className="dlp-where">
            {cur.matter_title && (
              <button className="dlp-crumb" title="打开这个事项" onClick={() => nav(`/matter/${cur.matter_id}`)}>
                {cur.matter_title}
              </button>
            )}
            {cur.run_id && task && (
              <>
                <span className="dlp-crumb-sep" aria-hidden="true">{Icon.right()}</span>
                <button className="dlp-crumb dlp-crumb-task" title="看这次任务" onClick={() => nav(`/run/${cur.run_id}/${cur.matter_id}`)}>
                  {task}
                </button>
              </>
            )}
          </span>
        </div>
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

/** 宽窗口里没有选中文件时（搜索没有结果、筛选为空）右栏的占位：说清为什么空，不留一块白。 */
export function DeliverablePreviewEmpty({ text }: { text: string }) {
  return (
    <aside className="dlp dlp-placeholder" aria-label="预览">
      <span className="dlp-placeholder-icon" aria-hidden="true">{Icon.eye()}</span>
      <p>{text}</p>
    </aside>
  );
}

const STATUS_NEXT: Record<string, string> = {
  draft: "提交后在复核页核对引用与事实，再签发",
};

/** taskGroupLabel 形如“审合同 · 33 分钟前”：预览头只要任务名。 */
function taskName(label: string | null | undefined): string {
  if (!label) return "";
  const i = label.lastIndexOf(" · ");
  return i > 0 ? label.slice(0, i) : label;
}
