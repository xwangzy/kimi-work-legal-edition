/**
 * 案卷文件夹（第 48 批，事项页“材料”标签）：关联本机的一个案卷文件夹，手动“同步”导入新增、改过的文件；取消关联不删材料。
 * 不监听文件夹、不后台同步。文件夹的位置只在这台电脑上。
 */
import { useState } from "react";
import { api, type FolderSyncResult, type MatterFolder } from "../api.ts";
import { fmtTime, fmtWhen } from "../lib/labels.ts";
import { syncResultText } from "../lib/material-folder.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { Icon } from "./Icons.tsx";
import { BusyLabel, WaitBlock } from "./Loading.tsx";

export function MaterialFolderBar(p: { matterId: string; folder: MatterFolder | null; readOnly: boolean; disabled?: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<"link" | "sync" | "unlink" | null>(null);
  // 同步开始的时刻（第 51 批）：整卷复制、加密、抽字可能要几分钟，内核不报逐份进度，所以给真实的已用时间，不画假进度
  const [since, setSince] = useState<number | null>(null);
  const [result, setResult] = useState<FolderSyncResult | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const [devPath, setDevPath] = useState("");
  const dialogs = api.hasFolderDialog();

  // 已结案且没关联：不显示（结案后只读，不能再关联）
  if (p.readOnly && !p.folder) return null;

  const run = async (kind: "link" | "sync" | "unlink", fn: () => Promise<FolderSyncResult | null | { folder: null }>) => {
    setBusy(kind);
    setSince(Date.now());
    setErr("");
    try {
      const r = await fn();
      if (r && "added" in r) {
        setResult(r);
        setOpen(false);
      } else if (kind === "unlink") setResult(null);
      if (r) p.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      setSince(null);
    }
  };
  const link = () => void run("link", () => api.linkFolder(p.matterId, devPath));
  const sync = () => void run("sync", () => api.syncFolder(p.matterId));
  const unlink = () => void run("unlink", () => api.unlinkFolder(p.matterId));
  const off = !!busy || !!p.disabled;
  const details = result ? result.skipped.length + result.missing_on_disk.length : 0;

  return (
    <div className="mf">
      <div className="mf-bar">
        {p.folder ? (
          <>
            <span className="mf-name" title={p.folder.root}>
              <Icon.folder />
              <span className="mf-name-text">{p.folder.name}</span>
            </span>
            <span className="mf-when" title={p.folder.synced_at ? fmtTime(p.folder.synced_at) : undefined}>
              {p.folder.synced_at ? `上次同步 ${fmtWhen(p.folder.synced_at)}` : "还没有同步"}
            </span>
            {!p.readOnly && (
              <button className="btn-ghost btn-sm" disabled={off} aria-busy={busy === "sync"} onClick={sync}>
                <BusyLabel busy={busy === "sync"} busyText="正在同步…">同步</BusyLabel>
              </button>
            )}
            <ConfirmButton label="取消关联" question="材料都会留在事项里" confirmLabel="取消关联" keepLabel="不了" danger={false} className="btn-link mf-unlink" disabled={off} onConfirm={unlink} />
          </>
        ) : (
          <>
            {!dialogs && (
              <label className="mf-dev">
                <span>文件夹位置（开发调试）</span>
                <input value={devPath} onChange={(e) => setDevPath(e.target.value)} placeholder="完整路径" />
              </label>
            )}
            <button className="btn-ghost btn-sm" disabled={off} aria-busy={busy === "link"} onClick={link}>
              <BusyLabel busy={busy === "link"} busyText="正在关联并同步…">
                <Icon.folder />
                关联案卷文件夹
              </BusyLabel>
            </button>
          </>
        )}
      </div>
      {(busy === "sync" || busy === "link") && (
        <WaitBlock
          title={busy === "link" ? "正在关联并同步案卷文件夹…" : "正在同步案卷文件夹…"}
          hint="复制、加密新增和改过的文件，并读出其中的文字。"
          since={since}
          longHint="文件多或有扫描件时会久一些；同步完会在这里列出结果。"
        />
      )}
      <p className="mf-note">文件夹里的文件会复制并加密保存在这台电脑上；只有任务用到的内容才会替换代号后发给 AI。</p>
      {err && (
        <p className="mf-error" role="alert">
          {err}
        </p>
      )}
      {result && (
        <div className="mf-result" role="status">
          <span>{syncResultText(result)}</span>
          {details > 0 && (
            <button className="btn-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? "收起" : "查看明细"}
            </button>
          )}
          {open && details > 0 && (
            <ul className="mf-list">
              {result.skipped.map((s) => (
                <li key={`s:${s.rel_path}`}>
                  <span className="mf-path">{s.rel_path}</span>
                  <span className="mf-why">{s.reason}</span>
                </li>
              ))}
              {result.missing_on_disk.map((m) => (
                <li key={`m:${m}`}>
                  <span className="mf-path">{m}</span>
                  <span className="mf-why">文件夹里找不到了（事项里的材料还在）</span>
                </li>
              ))}
              {result.skipped_total > result.skipped.length && <li className="mf-why">另有 {result.skipped_total - result.skipped.length} 份跳过的文件没有列出</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
