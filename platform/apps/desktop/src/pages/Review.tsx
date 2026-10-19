import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { nav } from "../App.tsx";
import { SafePreview } from "../components/SafePreview.tsx";
import { restoredPlain, restoreTokens } from "../lib/tokens.ts";
import { artifactName } from "../lib/labels.ts";
import { citationChecklist, citationNeeds, citationsAllowSign, type CitationTicks } from "../lib/citation-review.ts";

/** 成果状态 → 律师称呼。 */
const STATUS_TEXT: Record<string, string> = {
  draft: "草稿",
  pending_review: "待你复核",
  approved: "已签发",
  rejected: "已退回",
  superseded: "已有新版本",
};

/** 未决项 → 一句话（不展示内部结构）。 */
function openItemText(it: any): string {
  if (it && typeof it === "object") {
    if (it.kind === "citation_intercepted") return `有 ${Number(it.count ?? 0)} 条引用被拦下（查不到或已失效），请核对正文里是否还在使用`;
    if (it.kind === "quarantined_source") return "本成果用到的材料带国家秘密标志、已隔离：请按涉密载体规定核查，确认前不得交付";
    if (typeof it.note === "string") return it.note;
  }
  return typeof it === "string" ? it : "有一项需要你确认的事项";
}

type Check = { label: string; ok: boolean | null; text: string };

/** 系统已核对的事实（来自内核完整性单；只陈述结果）。 */
function systemChecks(c: any, latest: boolean): Check[] {
  const out: Check[] = [];
  const m = c.materials ?? {};
  if (m.requested !== undefined) out.push({ label: "材料读取", ok: Number(m.failed ?? 0) === 0 && Number(m.loaded) === Number(m.requested), text: `已读 ${m.loaded}/${m.requested} 份${Number(m.failed ?? 0) > 0 ? `，${m.failed} 份没有读到` : ""}` });
  else out.push({ label: "材料读取", ok: null, text: "不是任务产出（无材料读取记录）" });
  const ct = c.citations ?? {};
  if (ct.total !== undefined) {
    const bad = Number(ct.intercepted ?? 0) + Number(ct.unverified_offline ?? 0);
    out.push({
      label: "引用核验",
      ok: bad === 0,
      text: `共 ${ct.total} 条${Number(ct.intercepted ?? 0) > 0 ? `，${ct.intercepted} 条被拦下` : ""}${Number(ct.unverified_offline ?? 0) > 0 ? `，${ct.unverified_offline} 条离线未能核实` : ""}${ct.as_of ? `（法规版本截至 ${ct.as_of}）` : ""}`,
    });
  } else out.push({ label: "引用核验", ok: null, text: "本成果没有引用核验记录" });
  out.push({ label: "文件未被改动", ok: c.file_integrity === "ok", text: c.file_integrity === "ok" ? "与生成时一致" : "与生成时不一致，不能签发" });
  out.push({ label: "版本", ok: latest, text: latest ? "这是最新版本" : "已有更新版本，本版不能签发" });
  out.push({ label: "受众", ok: null, text: c.audience_check });
  out.push({ label: "AI 辅助标识", ok: null, text: "文档属性中已标明 AI 辅助起草" });
  if (c.egress?.note) out.push({ label: "数据去向", ok: null, text: c.egress.note });
  return out;
}

/**
 * 交付件详情 / 复核签发页（§5.4 签发页线框；v9.2 §4.4 / Y4 #18、§5 D-3；Z3 评审 #2）：左预览，右“签发前检查”——系统已核对与你来核对分开。
 * 任何状态的成果都进这一页：草稿也能看到检查清单，主动作是“提交复核”；待复核的是“确认签发”。右上角始终可下载。
 */
export function ReviewPage({ artifactId }: { artifactId: string }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<{ text: string; office: boolean } | null>(null);
  const [tokenMap, setTokenMap] = useState<Map<string, string | null>>(new Map());
  // 律师看得懂的标题（内容标题在本机还原代号；取不到时用固定名称）
  const [title, setTitle] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.completeness(artifactId).then(setData).catch((e) => setErr(e.message));
  }, [artifactId]);
  useEffect(reload, [reload]);
  useEffect(() => {
    if (!data?.matter_id) return;
    api
      .listArtifacts(data.matter_id)
      .then(async (r) => {
        const a = r.artifacts.find((x: any) => x.artifact_version_id === data.artifact_version_id);
        if (!a) return;
        const map = String(a.title ?? "").includes("〔") ? await restoreTokens(data.matter_id, String(a.title)) : new Map<string, string | null>();
        setTitle(artifactName(a, (t) => restoredPlain(t, map)));
      })
      .catch(() => {});
  }, [data?.artifact_version_id, data?.matter_id]);
  const download = () =>
    void api
      .downloadArtifact(data.artifact_version_id, data.filename)
      .then((saved) => {
        if (!saved) return;
        setNote("已保存（真实名称已还原）。下载已留痕。");
        return api.deliver({ artifact_version_id: data.artifact_version_id, action: "download" });
      })
      .catch((e) => setErr(e.message));
  const submitForReview = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.submitReview(data.artifact_version_id);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 预览：Office 成果由内核渲染为白名单 HTML；文本成果取令牌形态原文；代号只在本机界面还原显示
  useEffect(() => {
    if (!data) return;
    const office = /\.(docx|xlsx)$/i.test(data.filename);
    const load = office
      ? api.artifactHtml(artifactId).then((r) => r.html)
      : /\.(md|txt|markdown|csv|json)$/i.test(data.filename)
        ? api.artifactText(artifactId).then((r) => new TextDecoder().decode(Uint8Array.from(atob(r.data_base64), (c) => c.charCodeAt(0))))
        : Promise.resolve("");
    load
      .then(async (text) => {
        setPreview({ text, office });
        if (text.includes("〔") && data.matter_id) setTokenMap(await restoreTokens(data.matter_id, text));
      })
      .catch(() => setPreview({ text: "", office }));
  }, [data?.artifact_version_id]);

  const items: string[] = data?.lawyer_checklist?.items ?? [];
  // 成果里不在本机法规库的引用（第 13 批）：系统核对不了，律师逐条人工核对后勾选才能签发
  // 成果的引用核对（第 13 批复核 B13-U01/U02/U03）：分组列出、逐类勾选、勾选不齐不能签发
  const cneeds = citationNeeds(data?.completeness?.artifact_citations);
  const [cticks, setCticks] = useState<CitationTicks>({ cases: false, outside: false, unchecked: false });
  const act = useCallback(
    async (decision: "approved" | "rejected") => {
      setBusy(true);
      setErr("");
      try {
        await api.approve(artifactId, {
          decision,
          expected_sha256: data.sha256,
          // 人工核对的勾选只作留痕（不代表系统验证）
          checklist: {
            reviewed_open_items: ack,
            lawyer_checked: [...checked].sort((a, b) => a - b),
            lawyer_items: items.length,
            skill: data.lawyer_checklist?.skill ?? null,
            ...citationChecklist(cneeds, cticks),
            at: new Date().toISOString(),
          },
        });
        reload();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [artifactId, data, ack, checked, items.length, reload, cneeds, cticks],
  );

  const latest = !!data?.is_latest_version;
  const pending = data?.status === "pending_review";
  const draft = data?.status === "draft";
  const openItems: unknown[] = data?.completeness?.open_items ?? [];
  return (
    <main className="main">
      <div className="review-page">
        <button className="btn-link back" onClick={() => nav("/deliverables")}>← 交付件</button>
        <div className="page-head">
          <h1 className="page-title" title={data?.filename ?? ""}>{title ?? data?.filename ?? "…"}</h1>
          {data && (
            <button className="btn-ghost" onClick={download}>
              {/\.docx$/i.test(data.filename) ? "下载 Word" : /\.xlsx$/i.test(data.filename) ? "下载 Excel" : "下载"}
            </button>
          )}
        </div>
        {data && (
          <p className="muted">
            第 {data.version} 版 · {STATUS_TEXT[data.status] ?? "状态未知"}
            {draft ? " · 这是草稿：提交复核后才能签发" : ""}
          </p>
        )}
        {err && <div className="banner banner-red">{err}</div>}
        {data && (
          <div className="review-cols">
            <section className="review-preview" aria-label="成果预览">
              {preview === null ? (
                <div className="muted">正在加载预览…</div>
              ) : preview.text ? (
                <SafePreview filename={data.filename} text={preview.text} tokenMap={tokenMap} office={preview.office} />
              ) : (
                <div className="muted">这种文件不能在应用内预览，请下载后打开。</div>
              )}
            </section>
            <aside className="review-checks" aria-label="签发前检查">
              <div className="section-title">系统已核对</div>
              <ul className="check-list">
                {systemChecks(data.completeness, latest).map((c) => (
                  <li key={c.label} className={c.ok === false ? "check-bad" : c.ok ? "check-ok" : "check-info"}>
                    <span className="check-mark" aria-hidden="true">{c.ok === false ? "✕" : c.ok ? "✓" : "·"}</span>
                    <span>
                      <b>{c.label}</b>：{c.text}
                    </span>
                  </li>
                ))}
              </ul>
              {openItems.length > 0 && (
                <div className="banner banner-orange">
                  需要你确认的事项：
                  <ul>
                    {openItems.map((it, i) => (
                      <li key={i}>{openItemText(it)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {data.blockers.length > 0 && <div className="banner banner-orange">签发前须处理：{data.blockers.join("；")}</div>}

              {cneeds.wrong.length > 0 && (
                <div className="banner banner-red">
                  这些引用核对不通过，要先改正再签发：
                  <ul>
                    {cneeds.wrong.slice(0, 20).map((c, i) => (
                      <li key={i}>
                        {c.raw}
                        {c.reason ? `（${c.reason}）` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {cneeds.cases.length > 0 && (
                <div className="banner banner-orange">
                  这些案号系统离线核对不了，请逐个在裁判文书网等官方来源核对：
                  <ul>
                    {cneeds.cases.slice(0, 20).map((c, i) => (
                      <li key={i}>{c.raw}</li>
                    ))}
                  </ul>
                  <label>
                    <input type="checkbox" checked={cticks.cases} onChange={(e) => setCticks((t) => ({ ...t, cases: e.target.checked }))} /> 已逐个核对上面的案号
                  </label>
                </div>
              )}
              {cneeds.outside.length > 0 && (
                <div className="banner banner-orange">
                  这些引用不在本机法规库里，系统没法自动核对，请逐条查原文核对：
                  <ul>
                    {cneeds.outside.slice(0, 20).map((c, i) => (
                      <li key={i}>{c.raw}</li>
                    ))}
                  </ul>
                  {cneeds.outside.length > 20 && <div className="muted">另有 {cneeds.outside.length - 20} 条，见成果原文。</div>}
                  <label>
                    <input type="checkbox" checked={cticks.outside} onChange={(e) => setCticks((t) => ({ ...t, outside: e.target.checked }))} /> 已逐条人工核对上面的引用
                  </label>
                </div>
              )}
              {cneeds.unchecked && (
                <div className="banner banner-orange">
                  这份文件的引用系统没有核对（格式不认识或读取出错），请人工核对文中的法条与案号。
                  <label>
                    <input type="checkbox" checked={cticks.unchecked} onChange={(e) => setCticks((t) => ({ ...t, unchecked: e.target.checked }))} /> 这份文件的引用已人工核对
                  </label>
                </div>
              )}

              <div className="section-title">你来核对</div>
              {items.length > 0 ? (
                <>
                  <p className="muted">取自本次所用方法模板的质量自检。勾选只记录你的人工核对，不代表系统验证。</p>
                  <ul className="lawyer-checks">
                    {items.map((t, i) => (
                      <li key={i}>
                        <label>
                          <input
                            type="checkbox"
                            checked={checked.has(i)}
                            onChange={(e) =>
                              setChecked((s) => {
                                const n = new Set(s);
                                if (e.target.checked) n.add(i);
                                else n.delete(i);
                                return n;
                              })
                            }
                          />
                          {t}
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted">本成果没有对应的方法模板自检清单。请按所内质量要求核对。</p>
              )}
              <label className="review-ack">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                我已实质复核全部内容{openItems.length > 0 ? "与需要确认的事项" : ""}（点选不等于复核，系统会记录这次确认）
              </label>
              <div className="review-actions">
                <button className="btn-ghost" disabled={busy || !pending} onClick={() => void act("rejected")}>
                  退回
                </button>
                {draft ? (
                  <button className="btn-primary" disabled={busy || !latest} onClick={() => void submitForReview()}>
                    提交复核
                  </button>
                ) : (
                  <button className="btn-primary" disabled={busy || !pending || !ack || !latest || !citationsAllowSign(cneeds, cticks)} onClick={() => void act("approved")}>
                    确认签发
                  </button>
                )}
                <span className="spacer" />
                <button className="btn-ghost" onClick={download}>
                  下载（留痕）
                </button>
              </div>
              {note && <p className="muted">{note}</p>}
              {!pending && !draft && <p className="muted">只有“待你复核”的成果可以签发或退回。</p>}
              <details className="review-proof">
                <summary className="muted">签发凭证</summary>
                <p className="muted">签发的就是这一份文件；之后再改会生成新版本，需要重新签发。对外发送、导出与改权限只能由你在这台电脑上操作。内部稿不得外发。</p>
                <p className="muted mono">文件指纹 {data.sha256.slice(0, 16)}…（第三方可据此核对文件是否被改过）</p>
              </details>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
