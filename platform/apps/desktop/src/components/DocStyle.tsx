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
  const [confirmClear, setConfirmClear] = useState(false);
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
  const body = { letterhead: draft.letterhead, letterhead_name: draft.letterhead_name, letterhead_lines: draft.letterhead_lines, body: draft.body, page_numbers: draft.page_numbers };
  // 有没保存的改动时在标题旁标“未保存”（第 26 批，评审 U2-02：原来改了不点保存就静默丢失）
  const dirty =
    draft.letterhead !== v.letterhead ||
    (draft.letterhead_name ?? "") !== (v.letterhead_name ?? "") ||
    lines[0] !== (v.letterhead_lines[0] ?? "") ||
    lines[1] !== (v.letterhead_lines[1] ?? "") ||
    draft.body !== v.body ||
    draft.page_numbers !== v.page_numbers ||
    (draft.redline_author ?? "") !== (v.redline_author ?? "");
  const pickTemplate = () => (window.zrKernel?.pickFiles ? void run(() => api.setDocTemplate(), "已用律所模板") : fileRef.current?.click());
  // 第 26 批（评审 U2-01）：一张“标签 | 控件”网格，标签与控件同一条中线；分段控件一种样子；页码用开关；律所模板是“版式来源”的一个选项，不和“保存”并排
  return (
    <div className="device-row" id="doc-style">
      <div className="device-k">
        文书版式
        {dirty && <span className="pill pill-orange unsaved">未保存</span>}
      </div>
      <div>
        <div className="muted">下载的意见书、报告、备忘录按这里排版；原件和对方合同不受影响。</div>
        <div className="settings-grid">
          <span className="sg-k">版式来源</span>
          <div className="sg-v">
            <div className="seg seg-lg" role="radiogroup" aria-label="版式来源">
              <button role="radio" aria-checked={!v.template} className={`seg-btn${!v.template ? " on" : ""}`} disabled={busy} onClick={() => v.template && setConfirmClear(true)}>
                按下面的设置
              </button>
              <button role="radio" aria-checked={!!v.template} className={`seg-btn${v.template ? " on" : ""}`} disabled={busy} onClick={() => !v.template && pickTemplate()}>
                用律所 Word 模板
              </button>
            </div>
            {v.template && (
              <span className="sg-help">
                正在用「{v.template.name}」（{fmtTime(v.template.updated_at)} 上传）：页眉页脚、徽标、字体和页面都取自模板。
                <button className="btn-link" disabled={busy} onClick={pickTemplate}>
                  换一个模板
                </button>
              </span>
            )}
            {v.template && (v.template.header_text || v.template.footer_text) && (
              <span className="sg-help">
                模板页眉：{v.template.header_text || "（无文字）"}；页脚：{v.template.footer_text || "（无文字）"}
              </span>
            )}
            {v.template?.looks_case_specific && (
              <p className="banner banner-orange">模板的页眉页脚里像是有具体案件的信息（案号、“诉”或文件名）。这些文字会印到之后每一份下载的 Word 上，包括别的客户的文书——请换一份干净的模板。</p>
            )}
            {confirmClear && (
              <span className="sg-confirm">
                不用律所模板，改按下面的设置？
                <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => api.clearDocTemplate(), "已移除律所模板，改按下面的设置").then(() => setConfirmClear(false))}>
                  不用模板
                </button>
                <button className="btn-ghost btn-sm" onClick={() => setConfirmClear(false)}>
                  取消
                </button>
              </span>
            )}
          </div>

          <span className={`sg-k${v.template ? " sg-off" : ""}`}>函头</span>
          <div className={`sg-v${v.template ? " sg-off" : ""}`}>
            <div className="seg seg-lg" role="radiogroup" aria-label="函头">
              {(
                [
                  ["auto", v.effective_letterhead && v.letterhead === "auto" ? `本所名称（${v.effective_letterhead}）` : "本所名称"],
                  ["custom", "自定义"],
                  ["none", "不加"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} role="radio" aria-checked={draft.letterhead === k} disabled={!!v.template} className={`seg-btn${draft.letterhead === k ? " on" : ""}`} onClick={() => set({ letterhead: k })}>
                  {l}
                </button>
              ))}
            </div>
            {v.template && <span className="sg-help">用律所模板时，函头与正文字体按模板，这两行不生效。</span>}
          </div>

          {draft.letterhead === "custom" && !v.template && (
            <>
              <span className="sg-k">函头名称</span>
              <div className="sg-v">
                <input aria-label="函头上的名称" value={draft.letterhead_name ?? ""} maxLength={40} onChange={(e) => set({ letterhead_name: e.target.value })} placeholder="例如：衡序律师事务所" />
              </div>
            </>
          )}
          {draft.letterhead !== "none" && !v.template && (
            <>
              <span className="sg-k sg-top">地址电话</span>
              <div className="sg-v">
                <input aria-label="函头下第一行" value={lines[0]} maxLength={60} onChange={(e) => set({ letterhead_lines: [e.target.value, lines[1]!] })} placeholder="地址：北京市朝阳区某路 1 号" />
                <input aria-label="函头下第二行" value={lines[1]} maxLength={60} onChange={(e) => set({ letterhead_lines: [lines[0]!, e.target.value] })} placeholder="电话：010-12345678" />
                <span className="sg-help">印在函头下面，可空，至多两行。</span>
              </div>
            </>
          )}

          <span className={`sg-k${v.template ? " sg-off" : ""}`}>正文字体</span>
          <div className={`sg-v${v.template ? " sg-off" : ""}`}>
            <div className="seg seg-lg" role="radiogroup" aria-label="正文字体">
              {(
                [
                  ["song-xiaosi", "宋体小四"],
                  ["fangsong-san", "仿宋三号"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} role="radio" aria-checked={draft.body === k} disabled={!!v.template} className={`seg-btn${draft.body === k ? " on" : ""}`} onClick={() => set({ body: k })}>
                  {l}
                </button>
              ))}
            </div>
            <span className="sg-help">意见书、备忘录常用宋体小四；起诉状、律师函常用仿宋三号。</span>
          </div>

          <span className="sg-k">页码</span>
          <div className="sg-v">
            <span className="switch-row">
              <button role="switch" aria-checked={draft.page_numbers} aria-label="页码" className="switch" onClick={() => set({ page_numbers: !draft.page_numbers })} />
              <span>页脚写“第 X 页 共 Y 页”</span>
            </span>
          </div>

          {/* 修订署名（v9.4 第 22 批，C1 #4）：Word 修订里显示的作者名；对外版修订稿发出前请再看一遍 */}
          <span className="sg-k sg-top">修订署名</span>
          <div className="sg-v">
            <input value={draft.redline_author ?? ""} maxLength={30} placeholder="律师审定（Kimi Work 辅助起草）" onChange={(e) => set({ redline_author: e.target.value || null })} aria-label="修订署名" />
            <span className="sg-help">{draft.redline_author ? "Word 修订里显示的作者。对外版和内部版都用这个署名，对方打开对外版修订稿能看到。" : v?.firm_name ? `Word 修订里显示的作者。不填时：对外版用本所名称“${v.firm_name}”，内部版用框里的缺省写法。` : "Word 修订里显示的作者。不填用框里的缺省写法；写本所名称或律师姓名时，对方打开修订稿能看到。"}</span>
          </div>
        </div>
        <div className="settings-actions">
          <button className="btn-primary btn-sm" disabled={busy || !dirty} onClick={() => void run(() => api.setDocStyle({ ...body, redline_author: draft.redline_author ?? "" }), "已保存")}>
            保存
          </button>
          <button className="btn-link" disabled={busy} onClick={() => void run(() => api.downloadDocStyleSample(body), "样张已保存（按面板上现在的选项），打开看看")}>
            下载样张看效果
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
