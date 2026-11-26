/**
 * 成果行（V18 A2；第 48 批改为卡片里的列表行；第 49 批改为单行）：事项“成果”页与全局“成果”页共用。
 * 第 67 批（V41 工作线 D）改为文档工作区的两行文件行：
 * - 第一行：文件类型图形（W / X / PDF / 文）+ 短名（“修订稿”“审查意见书（内部稿）”，见 lib/deliverables.ts taskTitles）+ 右侧状态（色点 + 文字）；
 * - 第二行：针对的文件（各行不同时才写）· 第 N 版 · 给谁 · 时间，12px 次要色；
 * - 操作（提交复核、下载、更多）悬停或键盘聚焦时浮在行尾，盖住状态，不占常驻宽度；整行点开就是预览。
 * 行与行之间不画分隔线（改前分隔线与选中色块总是错位），靠留白与悬停、选中的圆角色块分开。
 * 每个任务末尾一行可展开的“过程文件 n 份”（答复摘要、独立复核意见）。旧版与过程文件不给“提交复核”。
 * 只改显示：提交复核、预览、下载都对着具体那一个版本（最新版或展开后的那一版）。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { downloadPlan } from "../lib/download.ts";
import { fileTypeLabel, whenText, type DocTitle, type FileEntry } from "../lib/deliverables.ts";
import { ARTIFACT_STATUS_LABELS, AUDIENCE_LABELS, fmtTime, fmtWhen } from "../lib/labels.ts";
import { Icon } from "./Icons.tsx";
import "../styles-deliverables.css";
import "../styles-motion.css";

const STATUS_TONE: Record<string, string> = { draft: "pill-gray", pending_review: "pill-orange", approved: "pill-green", rejected: "pill-red", superseded: "pill-gray" };

/** 复核状态的一句话（悬停提示）：这一段是什么意思、下一步是什么。 */
export const STATUS_HINT: Record<string, string> = {
  draft: "AI 生成的草稿，还没复核。提交复核后在复核页核对引用与事实，再签发",
  pending_review: "已提交复核，等你核对后签发",
  rejected: "复核时退回了，改好后再提交",
  approved: "已签发，可以对外使用",
  superseded: "已被更新的版本替代",
};

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

/** 复核状态（第 51 批）：带色点的文字（成果列表与预览头用；胶囊 StatusPill 仍用于别处）。 */
export function StatusText({ status }: { status: string }) {
  return (
    <span className={`dl-state dl-state-${status}`} title={STATUS_HINT[status]}>
      {ARTIFACT_STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** 行首的文件类型（Word / Excel / 文本）：执行页完成区用的文字标签。 */
export function FileTypeTag({ filename }: { filename: string }) {
  const t = fileTypeLabel(filename);
  return <span className={`dl-ftype dl-ftype-${t === "Word" ? "word" : t === "Excel" ? "excel" : "other"}`}>{t}</span>;
}

/** 成果列表的文件类型方块（第 48 批）：W / X / 文，颜色区分 Word、Excel、其他；读屏读出类型全称。@ 材料弹层也用它（样式不变）。 */
export function FileTypeIcon({ filename }: { filename: string }) {
  const t = fileTypeLabel(filename);
  const kind = t === "Word" ? "word" : t === "Excel" ? "excel" : "other";
  return (
    <span className={`dl-ficon dl-ficon-${kind}`} role="img" aria-label={t}>
      {kind === "word" ? "W" : kind === "excel" ? "X" : "文"}
    </span>
  );
}

/**
 * 成果工作区的文件图形（第 67 批）：一张折角的小纸片，字母标类型（W 蓝、X 绿、PDF 红、文 灰）。
 * 和“纸”的隐喻一致，比圆角方块更像文件；读屏读出类型全称。
 */
export function FileGlyph({ filename, size = "md" }: { filename: string; size?: "md" | "lg" }) {
  const t = fileTypeLabel(filename);
  const kind = t === "Word" ? "word" : t === "Excel" ? "excel" : t === "PDF" ? "pdf" : "other";
  return (
    <span className={`dl-glyph dl-glyph-${kind}${size === "lg" ? " dl-glyph-lg" : ""}`} role="img" aria-label={t}>
      {kind === "word" ? "W" : kind === "excel" ? "X" : kind === "pdf" ? "PDF" : "文"}
    </span>
  );
}

/** 下载按钮：图标按钮，提示文字按下载下来的文件类型（Markdown 文本下载时转成 Word，见 download.ts）。 */
export function DownloadButton({ r, onDownload, busy = false }: { r: ListRow; onDownload: (r: ListRow) => void; busy?: boolean }) {
  const plan = downloadPlan(r.filename);
  const title = /\.(md|markdown)$/i.test(r.filename) ? `${plan.label}（这份是文本，下载时转成 Word）` : plan.label;
  // 下载要先还原代号、再写下载留痕：进行中换成小圆环并禁用，防止连点存出多份、记多条（第 51 批）
  return (
    <button className="icon-btn dl-dl" title={busy ? "正在下载…" : title} aria-label={`${plan.label}：${r.display}`} aria-busy={busy} disabled={busy} onClick={() => onDownload(r)}>
      {busy ? <span className="kwl-spin" aria-hidden="true" /> : Icon.download()}
    </button>
  );
}

/** 菜单里的一项。checked：当前选中的那项（版本切换用）；hint：右侧的次要说明。 */
export interface MenuItem {
  label: string;
  onSelect: () => void;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
}

/**
 * 小菜单（第 67 批）：成果行与预览头的“更多”、预览头的版本切换共用。
 * 浮层 140ms 出现；点外面、Esc 关闭并回到触发按钮；上下键在菜单项之间移动；离窗口底部不够时向上展开。
 */
export function MenuButton({ label, items, children, className = "", title, align = "right" }: { label: string; items: MenuItem[]; children: ReactNode; className?: string; title?: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    // 打开后焦点进第一项（或当前选中项）
    const first = wrap.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"], [role="menuitem"]:not(:disabled), [role="menuitemradio"]');
    first?.focus();
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const toggle = () => {
    if (!open && trigger.current) {
      const r = trigger.current.getBoundingClientRect();
      setUp(window.innerHeight - r.bottom < items.length * 36 + 24 && r.top > window.innerHeight - r.bottom);
    }
    setOpen((v) => !v);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    e.stopPropagation();
    const all = [...(wrap.current?.querySelectorAll<HTMLButtonElement>(".dl-menu-item:not(:disabled)") ?? [])];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
  };
  const radio = items.some((it) => it.checked !== undefined);
  return (
    <span className="dl-menu-wrap" ref={wrap} onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
      <button ref={trigger} type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={title ?? label} onClick={toggle}>
        {children}
      </button>
      {open && (
        <div className={`dl-menu${up ? " up" : ""}${align === "left" ? " left" : ""}${radio ? " radio" : ""}`} role="menu" aria-label={label}>
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              role={radio ? "menuitemradio" : "menuitem"}
              aria-checked={radio ? !!it.checked : undefined}
              className={`dl-menu-item${it.checked ? " on" : ""}`}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              <span className="dl-menu-check" aria-hidden="true">{it.checked ? Icon.check() : null}</span>
              <span className="dl-menu-label">{it.label}</span>
              {it.hint && <span className="dl-menu-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

const openOnKey = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

/** 第二行的元信息：各段之间一个间隔点，空段不写。 */
function Meta({ children }: { children: ReactNode[] }) {
  const parts = children.filter((c) => c !== null && c !== undefined && c !== false && c !== "");
  return (
    <span className="dl-row-meta">
      {parts.map((p, i) => (
        <span key={i} className="dl-meta-part">
          {p}
        </span>
      ))}
    </span>
  );
}

/**
 * 一份文件：最新版一行 + 可展开的旧版。showStatus：是否显示状态列（全局页按某一状态筛选时省掉，都一样）。
 * name：短名与针对的文件（第 67 批，见 taskTitles）；不给时按 parts 淡化同族前缀（第 49 批的写法）。
 * versionsInline：旧版是否在列表里展开（宽窗口有右侧预览时由预览头切换版本，列表只写“第 N 版”）。
 * menu：行尾“更多”菜单的项（打开复核页、看这次任务……），不给就没有“更多”。
 */
export function FileRows<T extends ListRow>({
  entry,
  showStatus,
  onOpen,
  onDownload,
  onSubmit,
  busyId,
  downloadingId,
  parts,
  primary = false,
  selectedId = null,
  name,
  versionsInline = true,
  menu,
}: {
  entry: FileEntry<T>;
  showStatus: boolean;
  onOpen: (r: T) => void;
  onDownload: (r: ListRow) => void;
  onSubmit?: (r: T) => void;
  busyId?: string | null;
  downloadingId?: string | null;
  parts?: { head: string; tail: string } | undefined;
  primary?: boolean;
  /** 第 66 批：成果页右侧预览中的那一版（行高亮）。 */
  selectedId?: string | null;
  name?: DocTitle;
  versionsInline?: boolean;
  menu?: (r: T) => MenuItem[];
}) {
  const [open, setOpen] = useState(() => versionsInline && !!selectedId && entry.older.some((o) => o.artifact_version_id === selectedId));
  const r = entry.latest;
  const head = parts?.head ?? "";
  const tail = parts ? parts.tail : r.display;
  // 宽窗口里预览头切到旧版时，这份文件那一行仍是选中的
  const selected = selectedId === r.artifact_version_id || (!versionsInline && entry.older.some((o) => o.artifact_version_id === selectedId));
  const ver =
    versionsInline && entry.older.length > 0 ? (
      <button
        className="dl-ver" aria-expanded={open}
        title={`展开旧版本（${entry.older.length}）`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        第 {r.version} 版
        <span className="dl-ver-chev" aria-hidden="true">{Icon.down()}</span>
      </button>
    ) : r.version > 1 ? (
      <span title={entry.older.length > 0 ? `共 ${entry.older.length + 1} 个版本，在预览里切换` : undefined}>第 {r.version} 版</span>
    ) : null;
  return (
    <>
      <div
        className={`dl-row${primary ? " is-primary" : ""}${selected ? " is-selected" : ""}`}
        role="listitem"
        tabIndex={0}
        data-dl-nav=""
        aria-current={selected ? "true" : undefined}
        title={r.display}
        onClick={() => onOpen(r)}
        onKeyDown={openOnKey(() => onOpen(r))}
      >
        <FileGlyph filename={r.filename} />
        <div className="dl-row-main">
          <span className="dl-row-title">
            {name ? (
              name.title
            ) : (
              <>
                {head && <span className="dl-name-head">{head}</span>}
                {tail}
              </>
            )}
          </span>
          <Meta>
            {[
              name?.subject ? <span className="dl-subject">{name.subject}</span> : null,
              ver,
              r.audience && r.audience !== "internal" ? <span className="dl-aud">给{AUDIENCE_LABELS[r.audience] ?? r.audience}</span> : null,
              <span className="dl-when" title={fmtTime(r.created_at)}>{whenText(fmtWhen(r.created_at))}</span>,
              entry.replaced ? <span className="dl-row-note">后面的任务里有更新的版本</span> : null,
            ]}
          </Meta>
        </div>
        {/* 状态列（第 51 批）：按流程某一段筛选时整列省掉（都一样），“全部”与事项页里显示 */}
        {showStatus && (
          <span className="dl-row-state">
            <StatusText status={r.status} />
          </span>
        )}
        <div className="dl-row-acts dl-hover-action" onClick={(e) => e.stopPropagation()}>
          {onSubmit && r.status === "draft" && !entry.replaced && (
            <button className="btn-ghost btn-sm dl-submit" disabled={busyId === r.artifact_version_id} aria-busy={busyId === r.artifact_version_id} onClick={() => onSubmit(r)}>
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
          {menu && (
            <MenuButton label={`更多操作：${r.display}`} title="更多" className="icon-btn dl-more" items={menu(r)}>
              {Icon.more()}
            </MenuButton>
          )}
        </div>
      </div>
      {open &&
        entry.older.map((o) => (
          <div key={o.artifact_version_id} className={`dl-row dl-row-sub${selectedId === o.artifact_version_id ? " is-selected" : ""}`} role="listitem" tabIndex={0} data-dl-nav="" title={o.display} onClick={() => onOpen(o)} onKeyDown={openOnKey(() => onOpen(o))}>
            <span className="dl-sub-mark" aria-hidden="true" />
            <div className="dl-row-main">
              <span className="dl-row-meta">
                <span className="dl-meta-part">第 {o.version} 版</span>
                <span className="dl-meta-part">{ARTIFACT_STATUS_LABELS[o.status] ?? o.status}</span>
                <span className="dl-meta-part" title={fmtTime(o.created_at)}>{whenText(fmtWhen(o.created_at))}</span>
              </span>
            </div>
            <div className="dl-row-acts dl-hover-action" onClick={(e) => e.stopPropagation()}>
              <DownloadButton r={o} onDownload={onDownload} busy={downloadingId === o.artifact_version_id} />
            </div>
          </div>
        ))}
    </>
  );
}

/**
 * 任务末尾的“过程文件 n 份”：答复摘要、独立复核意见，默认收起；展开后能预览（给了 onOpen 时）与下载。
 * earlier：同样的收起行用来列“上一次运行的文件 n 份”——重新运行前那一次留下、已被这一次取代的文件（第 44 批）。
 */
export function ProcessRows<T extends ListRow>({ entries, onDownload, earlier = false, onOpen, selectedId = null, downloadingId = null }: { entries: FileEntry<T>[]; onDownload: (r: ListRow) => void; earlier?: boolean; onOpen?: (r: T) => void; selectedId?: string | null; downloadingId?: string | null }) {
  const [open, setOpen] = useState(() => !!selectedId && entries.some((e) => e.latest.artifact_version_id === selectedId));
  if (entries.length === 0) return null;
  const note = earlier ? "重新运行前那一次留下的，已被这一次取代，不算这次的成果" : "答复摘要与复核意见，留作记录，不用交出去";
  return (
    <div className={`dl-proc${open ? " open" : ""}`}>
      <button className="dl-proc-toggle" aria-expanded={open} title={note} onClick={() => setOpen((v) => !v)}>
        <span className="dl-proc-chev" aria-hidden="true">{Icon.chevron()}</span>
        {earlier ? "上一次运行的文件" : "过程文件"} {entries.length} 份
        {open && <span className="dl-proc-note">{note}</span>}
      </button>
      {open && (
        <div role="list">
          {entries.map((e) => {
            const r = e.latest;
            const sel = selectedId === r.artifact_version_id;
            return (
              <div
                key={r.artifact_version_id}
                className={`dl-row dl-row-proc${sel ? " is-selected" : ""}${onOpen ? "" : " no-open"}`}
                role="listitem"
                tabIndex={onOpen ? 0 : undefined}
                data-dl-nav={onOpen ? "" : undefined}
                aria-current={sel ? "true" : undefined}
                title={r.display}
                onClick={onOpen ? () => onOpen(r) : undefined}
                onKeyDown={onOpen ? openOnKey(() => onOpen(r)) : undefined}
              >
                <FileGlyph filename={r.filename} />
                <div className="dl-row-main">
                  <span className="dl-row-title">{r.display}</span>
                  <Meta>{[<span className="dl-when" title={fmtTime(r.created_at)}>{whenText(fmtWhen(r.created_at))}</span>]}</Meta>
                </div>
                <div className="dl-row-acts dl-hover-action" onClick={(ev) => ev.stopPropagation()}>
                  <DownloadButton r={r} onDownload={onDownload} busy={downloadingId === r.artifact_version_id} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
