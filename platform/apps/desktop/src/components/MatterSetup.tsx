/**
 * 事项概览里的“推荐的方法”与“审查要点”（v9.4 第 22 批；评审 C1 §1 #20、#21、#22）。
 * - 推荐的方法：新建事项时选了事项类型的，按模板列出常用的方法卡，点了直接打开开始面板；
 * - 审查要点：本事项的客户或本所审查标准（条款、我方标准、可退让、不可谈）。审合同、回稿重审、起草合同的任务按在用的那一版；
 *   AI 从范本起草的只是草稿——律师在这里审定、启用后才用于审查。
 */
import { useCallback, useEffect, useState } from "react";
import { api, type Matter, type MatterTemplate, type ReviewRule, type RuleSet, type RuleSets } from "../api.ts";
import { nav } from "../App.tsx";
import { matterLine, SCENARIOS } from "../lib/scenarios.ts";
import { notifyDataChanged } from "../lib/events.ts";
import { Modal } from "./Modal.tsx";
import { restoredPlain, restoreTokens } from "../lib/tokens.ts";
import { stripDraftMark } from "../lib/rules-title.ts";

let templatesCache: Promise<MatterTemplate[]> | null = null;
/** 模板清单（内核给，同一会话只取一次）。 */
export function loadTemplates(): Promise<MatterTemplate[]> {
  templatesCache ??= api
    .matterTemplates()
    .then((r) => r.templates)
    .catch((e) => {
      templatesCache = null;
      throw e;
    });
  return templatesCache;
}

export function TemplateMethods({ matter, readOnly }: { matter: Matter; readOnly: boolean }) {
  const [t, setT] = useState<MatterTemplate | null>(null);
  useEffect(() => {
    if (!matter.template_id) return setT(null);
    let live = true;
    void loadTemplates()
      .then((list) => live && setT(list.find((x) => x.id === matter.template_id) ?? null))
      .catch(() => live && setT(null));
    return () => {
      live = false;
    };
  }, [matter.template_id]);
  if (!t) return null;
  const cards = t.scenarios.map((id) => SCENARIOS.find((c) => c.id === id)).filter((c): c is (typeof SCENARIOS)[number] => !!c);
  return (
    <div className="tpl-methods">
      <span className="muted">按“{t.title}”常用：</span>
      {cards.map((c) => (
        <button key={c.id} className="chip" disabled={readOnly} onClick={() => nav(`/start/${c.id}/${matter.matter_id}`)}>
          {c.title}
        </button>
      ))}
    </div>
  );
}

type Row = Omit<ReviewRule, "no">;
const blankRow = (): Row => ({ topic: "", standard: "", fallback: null, red_line: null });

export function ReviewRulesWidget({ matter, readOnly }: { matter: Matter; readOnly: boolean }) {
  const [sets, setSets] = useState<RuleSets | null>(null);
  const [failed, setFailed] = useState(false);
  const [edit, setEdit] = useState<{ from: RuleSet | null; draft: RuleSet | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  // AI 草稿是令牌形态（复核 Q4-06）：显示前经同一受审计通道还原代号，律师核对的是原文；审定启用时存的也是还原后的原文
  const [map, setMap] = useState<Map<string, string | null>>(new Map());
  const plain = (t: string | null | undefined) => (t ? restoredPlain(t, map) : "");
  const restoreAll = useCallback(
    (r: RuleSets) => {
      const all = [r.active, ...r.drafts, ...r.history].flatMap((x) => (x ? [x.title, ...x.rules.flatMap((y) => [y.topic, y.standard, y.fallback ?? "", y.red_line ?? ""])] : [])).join("\n");
      if (all.includes("〔")) void restoreTokens(matter.matter_id, all).then((m) => setMap((m0) => new Map([...m0, ...m]))).catch(() => {});
    },
    [matter.matter_id],
  );
  const reload = useCallback(() => {
    api
      .reviewRules(matter.matter_id)
      .then((r) => {
        setSets(r);
        restoreAll(r);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [matter.matter_id, restoreAll]);
  useEffect(reload, [reload]);
  if (failed) return <p className="muted">审查要点没有读出来，请稍后再试。</p>;
  if (!sets) return <p className="muted">载入中…</p>;
  const act = async (f: () => Promise<RuleSets>) => {
    setErr("");
    try {
      const r = await f();
      setSets(r);
      restoreAll(r);
      notifyDataChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const a = sets.active;
  return (
    <div className="rules-w">
      {a ? (
        <>
          <div className="w-row">
            <span>
              「{plain(a.title)}」第 {a.version} 版 · {a.rules.length} 条
            </span>
            <button className="btn-link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? "收起" : "看要点"}
            </button>
          </div>
          {open && (
            <ol className="rules-list">
              {a.rules.map((r) => (
                <li key={r.no}>
                  <b>{plain(r.topic)}</b>：{plain(r.standard)}
                  {r.fallback && <span className="muted">；可退让：{plain(r.fallback)}</span>}
                  {r.red_line && <span className="rules-red">；不可谈：{plain(r.red_line)}</span>}
                </li>
              ))}
            </ol>
          )}
          <p className="muted">审合同、回稿重审、起草合同时按这一版；开始面板里可以本次不用。</p>
        </>
      ) : (
        <p className="muted">还没有。写下客户或本所的审查标准（条款、我方标准、可退让、不可谈），以后审这个事项的合同就按它判“偏离”。</p>
      )}
      {sets.drafts.map((d) => (
        <div key={d.rule_set_id} className="w-row rules-draft">
          <span>
            AI 起草的「{plain(d.title)}」· {d.rules.length} 条 <span className="tag tag-gray">草稿，还没启用</span>
          </span>
          {!readOnly && (
            <span>
              <button className="btn-link" onClick={() => setEdit({ from: d, draft: d })}>审定</button>{" "}
              <button className="btn-link" onClick={() => void act(() => api.discardRulesDraft(matter.matter_id, d.rule_set_id))}>删除</button>
            </span>
          )}
        </div>
      ))}
      {!readOnly && (
        <div className="w-actions">
          <button className="btn btn-sm" onClick={() => setEdit({ from: a, draft: null })}>{a ? "修改" : "写审查要点"}</button>
          <button className="btn-link" onClick={() => nav(`/start/${matterLine(matter) === "inhouse" ? "rules-from-template-inhouse" : "rules-from-template"}/${matter.matter_id}`)}>
            从范本整理
          </button>
          {a && (
            <button className="btn-link" onClick={() => void act(() => api.retireReviewRules(matter.matter_id, a.version))}>
              停用
            </button>
          )}
        </div>
      )}
      {sets.history.length > 0 && <p className="muted">以前的版本：{sets.history.map((h) => `第 ${h.version} 版${h.status === "retired" ? "（停用）" : ""}`).join("、")}</p>}
      {err && <div className="banner banner-red">{err}</div>}
      {edit && (
        <RulesEditor
          matterId={matter.matter_id}
          base={edit.from}
          draft={edit.draft}
          plain={plain}
          activeVersion={a?.version ?? null}
          onClose={() => setEdit(null)}
          onSaved={(r) => {
            setSets(r);
            setEdit(null);
            notifyDataChanged();
          }}
        />
      )}
    </div>
  );
}

/** 编辑审查要点：逐条改、加、删、上移；保存为新的一版（审定草稿时草稿随之去掉）。 */
export function RulesEditor({ matterId, base, draft, activeVersion, plain = (t) => t ?? "", onClose, onSaved }: { matterId: string; base: RuleSet | null; draft: RuleSet | null; activeVersion: number | null; plain?: (t: string | null | undefined) => string; onClose: () => void; onSaved: (r: RuleSets) => void }) {
  const [title, setTitle] = useState(draft ? stripDraftMark(plain(draft.title)) : plain(base?.title));
  const [rows, setRows] = useState<Row[]>(() => (base?.rules.length ? base.rules.map((r) => ({ topic: plain(r.topic), standard: plain(r.standard), fallback: r.fallback ? plain(r.fallback) : null, red_line: r.red_line ? plain(r.red_line) : null })) : [blankRow()]));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (i: number, k: keyof Row, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: k === "fallback" || k === "red_line" ? v || null : v } : r)));
  const move = (i: number) => setRows((rs) => (i <= 0 ? rs : [...rs.slice(0, i - 1), rs[i]!, rs[i - 1]!, ...rs.slice(i + 1)]));
  const save = async () => {
    const list = rows.filter((r) => r.topic.trim() || r.standard.trim());
    if (!title.trim()) return setErr("请写审查要点的名称，例如：客户甲采购标准");
    if (list.length === 0) return setErr("至少写一条");
    const bad = list.findIndex((r) => !r.topic.trim() || !r.standard.trim());
    if (bad >= 0) return setErr(`第 ${bad + 1} 条要写条款和我方标准`);
    setBusy(true);
    setErr("");
    try {
      onSaved(await api.saveReviewRules(matterId, { title: title.trim(), rules: list, base_version: activeVersion, ...(draft ? { from_draft: draft.rule_set_id } : {}) }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={draft ? "审定 AI 起草的审查要点" : base ? `修改审查要点（保存为第 ${(activeVersion ?? 0) + 1} 版）` : "写审查要点"} onClose={onClose} wide>
      {draft && <p className="banner banner-orange">这是 AI 从范本整理的草稿：逐条核对出处与数字，删掉不对的，再启用。启用之前不会用于任何审查。</p>}
      <label className="field field-wide">
        <span>名称</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} placeholder="例如：客户甲采购标准" aria-label="审查要点名称" />
      </label>
      {/* 每条一张卡（复核 Q4 建议 2：原来是 760px 弹窗里的 6 列表格，每列约 150px，4～5 条后“启用 / 保存”要滚动才看得到） */}
      <ol className="rules-cards">
        {rows.map((r, i) => (
          <li key={i} className="rule-card">
            <div className="rule-card-head">
              <span className="rule-no">第 {i + 1} 条</span>
              <input aria-label={`第 ${i + 1} 条条款`} value={r.topic} onChange={(e) => set(i, "topic", e.target.value)} maxLength={40} placeholder="条款，如：付款期限" />
              <span className="nowrap">
                <button className="btn-link" disabled={i === 0} onClick={() => move(i)} aria-label={`第 ${i + 1} 条上移`}>上移</button>{" "}
                <button className="btn-link" onClick={() => setRows((rs) => (rs.length <= 1 ? [blankRow()] : rs.filter((_, j) => j !== i)))} aria-label={`删除第 ${i + 1} 条`}>删除</button>
              </span>
            </div>
            <label className="field">
              <span>我方标准</span>
              <textarea aria-label={`第 ${i + 1} 条我方标准`} value={r.standard} onChange={(e) => set(i, "standard", e.target.value)} maxLength={300} rows={2} placeholder="验收合格后 60 日内付款" />
            </label>
            <div className="rule-card-pair">
              <label className="field">
                <span>可退让（可空）</span>
                <textarea aria-label={`第 ${i + 1} 条可退让`} value={r.fallback ?? ""} onChange={(e) => set(i, "fallback", e.target.value)} maxLength={300} rows={2} />
              </label>
              <label className="field">
                <span>不可谈（可空）</span>
                <textarea aria-label={`第 ${i + 1} 条不可谈`} value={r.red_line ?? ""} onChange={(e) => set(i, "red_line", e.target.value)} maxLength={300} rows={2} />
              </label>
            </div>
          </li>
        ))}
      </ol>
      <button className="btn-link" disabled={rows.length >= 40} onClick={() => setRows((rs) => [...rs, blankRow()])}>＋ 加一条</button>
      {/* 底部按钮固定：条数多时不用滚到底才能启用或保存 */}
      <div className="modal-actions modal-actions-sticky">
        {err && <div className="banner banner-red">{err}</div>}
        <button className="btn-ghost" onClick={onClose}>取消</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>{draft ? "启用" : "保存"}</button>
      </div>
    </Modal>
  );
}
