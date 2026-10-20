/**
 * 设置 → 通用 → 文书版式（v9.3 第 15 批 B-4）：下载的 Word 用什么函头、字体字号、要不要页码，或者直接用律所自己的 Word 模板。
 * 只影响这台电脑导出的 Word（本产品生成的意见书、报告与 Markdown 备忘录）；律师上传的原件、对方合同的修订稿不动。
 */
import { useEffect, useRef, useState } from "react";
import { api, type DocStyleView } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";

export function DocStyle() {
  const [v, setV] = useState<DocStyleView | null>(null);
  const [draft, setDraft] = useState<DocStyleView | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void api
      .docStyle()
      .then((x) => {
        setV(x);
        setDraft(x);
      })
      .catch(() => setV(null));
  }, []);
  if (!v || !draft) return null;
  const run = async (fn: () => Promise<DocStyleView | null | boolean>, ok: string) => {
    setBusy(true);
    setMsg("");
    try {
      const r = await fn();
      if (r && typeof r === "object") {
        setV(r);
        setDraft(r);
      }
      if (r) setMsg(ok);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const lines = [draft.letterhead_lines[0] ?? "", draft.letterhead_lines[1] ?? ""];
  const set = (patch: Partial<DocStyleView>) => setDraft({ ...draft, ...patch });
  return (
    <div className="device-row" id="doc-style">
      <div className="device-k">文书版式</div>
      <div>
        <div className="muted">下载的 Word（意见书、报告、备忘录）按这里的版式排好：A4、标题居中、正文首行缩进、页码、落款右对齐。只影响这台电脑下载的文件；你上传的原件和对方合同的修订稿不动。</div>
        {v.template ? (
          <div className="card">
            正在用律所模板「{v.template.name}」（{fmtTime(v.template.updated_at)} 上传）：页眉页脚、徽标、字体和页面设置都取自模板，下面的函头与正文字体设置不再使用。
            {(v.template.header_text || v.template.footer_text) && (
              <div className="muted">
                模板页眉：{v.template.header_text || "（无文字）"}；页脚：{v.template.footer_text || "（无文字）"}
              </div>
            )}
            {v.template.looks_case_specific && (
              <p className="banner banner-orange">模板的页眉页脚里像是有具体案件的信息（案号、“诉”或文件名）。这些文字会印到之后每一份下载的 Word 上，包括别的客户的文书——请换一份干净的模板。</p>
            )}
            <div className="card-actions">
              <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => api.clearDocTemplate(), "已移除律所模板")}>
                移除模板
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="settings-choice" role="radiogroup" aria-label="函头">
              <span>函头</span>
              {(
                [
                  ["auto", v.effective_letterhead && v.letterhead === "auto" ? `本所名称（${v.effective_letterhead}）` : "本所名称"],
                  ["custom", "自定义"],
                  ["none", "不加"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} role="radio" aria-checked={draft.letterhead === k} className={`q-option${draft.letterhead === k ? " on" : ""}`} onClick={() => set({ letterhead: k })}>
                  {l}
                </button>
              ))}
            </div>
            {draft.letterhead === "custom" && (
              <label className="field">
                <span>函头上的名称</span>
                <input value={draft.letterhead_name ?? ""} maxLength={40} onChange={(e) => set({ letterhead_name: e.target.value })} placeholder="例如：衡序律师事务所" />
              </label>
            )}
            {draft.letterhead !== "none" && (
              <label className="field">
                <span>函头下的地址、电话（可空，至多两行）</span>
                <input value={lines[0]} maxLength={60} onChange={(e) => set({ letterhead_lines: [e.target.value, lines[1]!] })} placeholder="地址：北京市朝阳区某路 1 号" />
                <input value={lines[1]} maxLength={60} onChange={(e) => set({ letterhead_lines: [lines[0]!, e.target.value] })} placeholder="电话：010-12345678" />
              </label>
            )}
          </>
        )}
        {!v.template && <div className="settings-choice" role="radiogroup" aria-label="正文字体">
          <span>正文</span>
          {(
            [
              ["song-xiaosi", "宋体小四（意见书、备忘录）"],
              ["fangsong-san", "仿宋三号（起诉状、律师函）"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} role="radio" aria-checked={draft.body === k} className={`q-option${draft.body === k ? " on" : ""}`} onClick={() => set({ body: k })}>
              {l}
            </button>
          ))}
        </div>}
        <label>
          <input type="checkbox" checked={draft.page_numbers} onChange={(e) => set({ page_numbers: e.target.checked })} /> 页脚加“第 X 页 共 Y 页”
        </label>
        <div className="settings-choice">
          <button className="btn-primary btn-sm" disabled={busy} onClick={() => void run(() => api.setDocStyle({ letterhead: draft.letterhead, letterhead_name: draft.letterhead_name, letterhead_lines: draft.letterhead_lines, body: draft.body, page_numbers: draft.page_numbers }), "已保存")}>
            保存
          </button>
          <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => api.downloadDocStyleSample({ letterhead: draft.letterhead, letterhead_name: draft.letterhead_name, letterhead_lines: draft.letterhead_lines, body: draft.body, page_numbers: draft.page_numbers }), "样张已保存（按面板上现在的选项），打开看看")}>
            下载样张
          </button>
          <button className="btn-ghost btn-sm" disabled={busy} onClick={() => (window.zrKernel?.pickFiles ? void run(() => api.setDocTemplate(), "已用律所模板") : fileRef.current?.click())}>
            {v.template ? "换一个律所模板" : "用律所 Word 模板…"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".dotx,.docx"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void run(() => api.setDocTemplate(f), "已用律所模板");
            }}
          />
        </div>
        {msg && (
          <p className="muted" role="status">
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
