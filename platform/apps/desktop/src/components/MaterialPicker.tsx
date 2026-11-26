/**
 * 材料勾选与添加（第 66 批 D1）：一个事项的材料清单（可勾选或只列）+ 选择文件 + 拖放 + 逐份进度与逐条结果。
 * 首页“@ 材料”、开始面板、事项页、追问“补充材料”用同一个组件，外观与开始面板的材料清单一致（styles-materials-picker.css）。
 *
 * 用法（调用方负责真正导入，组件只管交互）：
 *   <MaterialPicker
 *     matterTitle={matter.title}
 *     documents={visibleMaterials(docs)}                     // 建议先按统一口径过滤；组件内部再去掉已移除/已隔离的
 *     selected={ids} onToggle={(id, on) => ...}            // 可选：不传则只列不勾
 *     onImport={(f) => api.importMaterial(matterId, f)}    // 可选：逐份调用，返回 materials.import 的结果（含 duplicate）；抛错即这份失败
 *     onImported={(outcomes) => reload()}                  // 一批处理完：刷新材料列表
 *   />
 * 有 onToggle 时，导入成功（含“已在本事项，未重复保存”）的那份自动勾上（autoSelect={false} 可关）。
 * onMount（可选）：多一个“只引用、不复制”入口（事项页用）。showList={false}：只要添加区与结果，不列清单。
 */
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { MATERIAL_ACCEPT, pickMaterials, type MaterialFile, type MaterialImportResult } from "../api.ts";
import { Icon } from "./Icons.tsx";
import { FileTypeIcon } from "./ArtifactRow.tsx";
import { importFailText } from "../lib/errors.ts";
import { importResultText, materialOrigin, MATERIAL_ORIGIN_LABELS, supersededIds, type MaterialLike } from "../lib/material-folder.ts";
import { countProgress } from "../lib/waiting.ts";
import "../styles-materials-picker.css";

const ROLE_TEXT: Record<string, string> = { ours: "我方", theirs: "对方", reference: "参考" };

export interface PickerDoc extends MaterialLike {
  role?: string | null;
  created_at?: string;
}

/** 一份文件的处理结果：ok 为 false 时 text 是说明原因的一句话。 */
export interface ImportOutcome {
  name: string;
  ok: boolean;
  duplicate?: boolean;
  text: string;
  result?: MaterialImportResult;
}

export interface MaterialPickerProps {
  /** 目标事项名：写在添加区与空态里，律师知道文件进哪个事项。 */
  matterTitle: string;
  documents: PickerDoc[];
  selected?: string[];
  onToggle?: (documentVersionId: string, on: boolean) => void;
  /** 逐份导入（组件按顺序一份一份调）。返回值用于结果一句话与自动勾选。 */
  onImport?: (file: MaterialFile) => Promise<MaterialImportResult>;
  /** 只引用、不复制（materials.mount）。 */
  onMount?: (file: MaterialFile) => Promise<MaterialImportResult>;
  /** 一批处理完（不论成败）。 */
  onImported?: (outcomes: ImportOutcome[]) => void;
  autoSelect?: boolean;
  /** 紧凑：清单矮一些、添加区只留一行（弹层与追问里用）。 */
  compact?: boolean;
  showList?: boolean;
  disabled?: boolean;
  /** 清单下方的一句说明（例如勾选范围）。 */
  hint?: ReactNode;
  /** 每行右侧的附加内容（例如用途标签）。 */
  rowExtra?: (d: PickerDoc) => ReactNode;
  /**
   * 第 67 批（首页上传菜单）：dropZone="root" 时整个组件都接拖放（拖入时整块高亮），有材料时不再显示虚线添加框——
   * 上传入口由调用方放在标题栏（经 openRef 打开本组件的选择文件，进度与结果仍在本组件里显示）。缺省 "box" 与原来相同。
   */
  dropZone?: "box" | "root";
  openRef?: MutableRefObject<(() => void) | null>;
}

export function MaterialPicker(p: MaterialPickerProps) {
  const docs = p.documents.filter((d) => !d.quarantined_at);
  const old = supersededIds(p.documents);
  const selected = p.selected ?? [];
  const showList = p.showList ?? true;
  const fileRef = useRef<HTMLInputElement>(null);
  const mountRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<{ i: number; total: number; name: string } | null>(null);
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([]);
  const disabled = !!p.disabled || !!busy;
  // 第 66 批第二轮（独立评审 R2-5）：材料多于 8 份时给一个筛选框（按文件名；勾过的总是留在列表里）
  const [q, setQ] = useState("");
  const qq = q.trim().toLowerCase();
  const listed = qq ? docs.filter((d) => d.filename.toLowerCase().includes(qq) || selected.includes(d.document_version_id)) : docs;

  const run = async (files: FileList | MaterialFile[] | null, mode: "import" | "mount") => {
    const fn = mode === "import" ? p.onImport : p.onMount;
    if (!fn || !files || files.length === 0 || busy) return;
    const list = Array.from(files);
    const out: ImportOutcome[] = [];
    const picked = new Set(selected);
    setOutcomes([]);
    try {
      for (const [i, f] of list.entries()) {
        setBusy({ i: i + 1, total: list.length, name: f.name });
        try {
          const r = await fn(f);
          const text = mode === "mount" ? `已关联（只读引用原文件，不复制），${Number(r.chars ?? 0).toLocaleString()} 字` : importResultText(f.name, r);
          out.push({ name: f.name, ok: true, duplicate: !!r.duplicate, text, result: r });
          if (p.onToggle && (p.autoSelect ?? true) && r.document_version_id && !picked.has(r.document_version_id)) {
            picked.add(r.document_version_id);
            p.onToggle(r.document_version_id, true);
          }
        } catch (e) {
          out.push({ name: f.name, ok: false, text: importFailText(f.name, (e as Error).message) });
        }
        setOutcomes([...out]);
      }
    } finally {
      setBusy(null);
      p.onImported?.(out);
    }
  };

  const rootDrop = p.dropZone === "root";
  useEffect(() => {
    if (!p.openRef) return;
    p.openRef.current = p.onImport && !disabled ? () => void pickMaterials(fileRef.current, (f) => run(f, "import")) : null;
    return () => {
      if (p.openRef) p.openRef.current = null;
    };
  });
  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) setOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      if (!disabled && e.dataTransfer.files.length > 0) void run(e.dataTransfer.files, p.onImport ? "import" : "mount");
    },
  };
  const showBox = !rootDrop || !!busy || (showList && docs.length === 0);
  return (
    <div className={`mp${p.compact ? " mp-compact" : ""}${rootDrop ? " mp-rootdrop" : ""}${rootDrop && over ? " over" : ""}`} {...(rootDrop ? dropHandlers : {})}>
      {rootDrop && over && (
        <div className="mp-over" aria-hidden="true">
          <Icon.upload /> 松手即存入「{p.matterTitle}」
        </div>
      )}
      {showList && docs.length > 8 && (
        <input className="mp-filter" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`在 ${docs.length} 份材料里找`} aria-label="按文件名筛选材料" />
      )}
      {showList && docs.length > 0 && (
        <div className="mp-list" role="group" aria-label={`「${p.matterTitle}」的材料`}>
          {qq && listed.length === 0 && <div className="mp-none">没有文件名含“{q.trim()}”的材料</div>}
          {listed.map((d) => {
            const on = selected.includes(d.document_version_id);
            const origin = materialOrigin(d);
            const body = (
              <>
                <span className="mp-ico" aria-hidden="true"><FileTypeIcon filename={d.filename} /></span>
                <span className="mp-name" title={d.rel_path ?? d.filename}>{d.filename}</span>
              </>
            );
            return (
              <div key={d.document_version_id} className={`mp-row${on ? " on" : ""}`}>
                {p.onToggle ? (
                  <label className="mp-doc">
                    <input type="checkbox" aria-label={d.filename} checked={on} disabled={!!p.disabled} onChange={() => p.onToggle!(d.document_version_id, !on)} />
                    {body}
                  </label>
                ) : (
                  <span className="mp-doc">{body}</span>
                )}
                {origin !== "upload" && <span className="tag tag-gray mp-tag">{MATERIAL_ORIGIN_LABELS[origin]}</span>}
                {old.has(d.document_version_id) && <span className="tag tag-gray mp-tag" title="同一位置的文件已更新，这是之前的版本">旧版本</span>}
                {d.role && ROLE_TEXT[d.role] && !p.rowExtra && <span className="tag tag-gray mp-tag">{ROLE_TEXT[d.role]}</span>}
                {p.rowExtra?.(d)}
              </div>
            );
          })}
        </div>
      )}
      {p.hint}
      {(p.onImport || p.onMount) && (
        <div
          className={`mp-drop${over && !rootDrop ? " over" : ""}${showList && docs.length === 0 ? " mp-drop-empty" : ""}${showBox ? "" : " mp-drop-hidden"}`}
          {...(rootDrop ? {} : { ...dropHandlers, onDragLeave: () => setOver(false) })}
        >
          <span className="mp-drop-icon" aria-hidden="true"><Icon.attach /></span>
          {busy ? (
            <span role="status" className="mp-busy">
              {busy.total > 1 ? `正在添加第 ${countProgress(busy.i, busy.total)?.text ?? `${busy.i}/${busy.total}`} 份：` : "正在添加："}
              {busy.name}
            </span>
          ) : (
            <span className="mp-drop-text">
              {showList && docs.length === 0 ? `「${p.matterTitle}」还没有材料：拖到这里，或` : "拖到这里，或"}
              {p.onImport && (
                <button type="button" className="btn-link mp-add" disabled={disabled} onClick={() => void pickMaterials(fileRef.current, (f) => run(f, "import"))}>选择文件</button>
              )}
              {p.onMount && (
                <>
                  {p.onImport ? "；也可以" : ""}
                  <button type="button" className="btn-link mp-add" disabled={disabled} onClick={() => void pickMaterials(mountRef.current, (f) => run(f, "mount"))}>只引用、不复制</button>
                </>
              )}
              {!p.compact && <span className="mp-drop-note">存入「{p.matterTitle}」，加密保存一份副本，原文件不改动</span>}
            </span>
          )}
          <input ref={fileRef} type="file" multiple hidden accept={MATERIAL_ACCEPT} onChange={(e) => void run(e.target.files, "import")} />
          <input ref={mountRef} type="file" multiple hidden accept={MATERIAL_ACCEPT} onChange={(e) => void run(e.target.files, "mount")} />
        </div>
      )}
      {outcomes.length > 0 && (
        <ul className="mp-results" aria-live="polite">
          {outcomes.map((o, i) => (
            <li key={`${o.name}-${i}`} className={o.ok ? (o.duplicate ? "mp-dup" : "mp-ok") : "mp-fail"}>
              {o.ok ? `${o.name}：${o.text}` : o.text}
            </li>
          ))}
          {!busy && (
            <li className="mp-results-close">
              <button type="button" className="btn-link" onClick={() => setOutcomes([])}>收起</button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
