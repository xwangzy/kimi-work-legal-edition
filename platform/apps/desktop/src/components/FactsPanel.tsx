/**
 * 事项页 · 事实（v9.3 复核 R15B-01；第 55 批重做版式）：整理案卷（第一段）与 Agent 提交的事实都在这里，律师逐条确认或驳回。
 * 只有确认过的事实会被“争点与证据分析”、起诉状等文书采用；驳回的不再出现在文书里，可以撤销。
 *
 * 原先是一张五列表格：日期列太窄被折成两行（“2025-03-” / “10”），每行右侧上下叠着“确认”“驳回”两个同样大小的按钮，
 * 出处也被挤成两行——八条事实占满一屏，看不出先后。现在是一条按日期排的时间线：
 *  - 左边日期（等宽数字、不折行）+ 时间线圆点，中间事实原文，下面一行小字写金额、出处、序号；
 *  - 右边“确认”是主动作（一个按钮），“驳回”退为文字按钮；处理过的换成状态 +“撤销”；
 *  - 页首一行：三段筛选（带数量）+“全部确认”（两步确认，逐条提交）。
 */
import { useEffect, useState } from "react";
import { api, type FactRow } from "../api.ts";
import { factCounts, factRef, factSourceText, sortFactsByDate } from "../lib/facts.ts";
import { restoreTokens } from "../lib/tokens.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { Icon } from "./Icons.tsx";
import { BusyLabel, ListSkeleton } from "./Loading.tsx";
import { tokens } from "./Markdown.tsx";

type Show = "proposed" | "confirmed" | "rejected";
const TABS: readonly [Show, string][] = [
  ["proposed", "待确认"],
  ["confirmed", "已确认"],
  ["rejected", "已驳回"],
];

export function FactsPanel({ matterId, docs, readOnly }: { matterId: string; docs: { document_version_id: string; filename: string }[]; readOnly: boolean }) {
  const [facts, setFacts] = useState<FactRow[] | null>(null);
  const [show, setShow] = useState<Show>("proposed");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  /** 全部确认的进度（已提交几条 / 共几条）。 */
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  // 事实是 Agent 写的（代号形态）：与审查工作台、表格复核一样先还原再显示（V13 第 38 批真实走查 W5：“〔自然人·YDCE9A〕内部说明称……”原样显示，
  // 律师在这页看不出是谁说的；整理案卷撞时限没交出时间线文件时，这页就是唯一的时间线）。还原只在渲染进程内存里
  const [map, setMap] = useState<Map<string, string | null>>(new Map());
  const load = () =>
    api
      .facts(matterId)
      .then((r) => {
        setFacts(r.facts);
        const all = r.facts.map((f) => `${f.statement}\n${f.party ?? ""}`).join("\n");
        if (all.includes("〔")) void restoreTokens(matterId, all).then(setMap).catch(() => {});
      })
      .catch((e: Error) => setMsg(e.message));
  useEffect(() => {
    void load();
  }, [matterId]);
  const decide = async (f: FactRow, decision: "confirm" | "reject" | "reset") => {
    setBusy(f.fact_id);
    setMsg("");
    try {
      await api.decideFact(matterId, f.fact_id, decision);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  /** 全部确认：逐条提交（内核逐条留痕）；中途出错停下，已确认的保留。 */
  const confirmAll = async (list: FactRow[]) => {
    setMsg("");
    setBulk({ done: 0, total: list.length });
    try {
      for (let i = 0; i < list.length; i++) {
        await api.decideFact(matterId, list[i]!.fact_id, "confirm");
        setBulk({ done: i + 1, total: list.length });
      }
    } catch (e) {
      setMsg(`有一条没有确认成功，已停下：${(e as Error).message}`);
    } finally {
      setBulk(null);
      await load();
    }
  };
  if (!facts) return msg ? <p className="muted">{msg}</p> : <ListSkeleton rows={4} label="正在读取事实" />;
  const n = factCounts(facts);
  const fileOf = new Map(docs.map((d) => [d.document_version_id, d.filename]));
  const list = sortFactsByDate(facts.filter((f) => f.status === show));
  const locked = busy !== null || bulk !== null;
  return (
    <section className="facts">
      <div className="facts-head">
        <div className="facts-tabs" role="radiogroup" aria-label="事实状态">
          {TABS.map(([k, l]) => (
            <button key={k} role="radio" aria-checked={show === k} className={`facts-tab${show === k ? " on" : ""}`} onClick={() => setShow(k)}>
              {l}
              <span className="facts-tab-n">{n[k]}</span>
            </button>
          ))}
        </div>
        {!readOnly && show === "proposed" && list.length > 1 && (
          <span className="facts-bulk">
            {bulk ? (
              <span className="muted" role="status">
                <BusyLabel busy>正在确认 {bulk.done} / {bulk.total}…</BusyLabel>
              </span>
            ) : (
              <ConfirmButton label={`全部确认（${list.length}）`} question="逐条看过原文了吗？确认后文书会直接采用。" confirmLabel="都看过了，确认" danger={false} className="btn-ghost btn-sm" disabled={locked} onConfirm={() => confirmAll(list)} />
            )}
          </span>
        )}
      </div>
      <p className="facts-note muted">都是“材料里这么写”的记载，不是认定。只有你确认过的，才会被“争点与证据分析”、起诉状等文书采用。</p>
      {list.length === 0 ? (
        <div className="facts-empty muted">
          {show === "proposed" ? (facts.length === 0 ? "还没有事实。先在首页做一次“整理案卷”，抽出的日期、金额与主体会放到这里。" : "没有待确认的事实。") : show === "confirmed" ? "还没有确认过的事实。" : "没有驳回的事实。"}
        </div>
      ) : (
        <ol className="facts-line" aria-label={`${TABS.find(([k]) => k === show)![1]}的事实，按日期排列`}>
          {list.map((f) => (
            <li key={f.fact_id} className={`fact-row fact-${f.status}`}>
              <time className="fact-date" dateTime={f.occurred_on ?? undefined}>{f.occurred_on ?? "日期不明"}</time>
              <span className="fact-dot" aria-hidden="true" />
              <div className="fact-body">
                <div className="fact-text">{tokens(f.statement, map)}</div>
                <div className="fact-meta">
                  {f.amount_yuan !== null && <span className="fact-amount">{f.amount_yuan.toLocaleString()} 元</span>}
                  <span>{factSourceText(f, fileOf)}</span>
                  {/* 序号（V16 第 41 批）：交付件里的“事实 12”就是这一条 */}
                  {factRef(f) && <span className="fact-no">{factRef(f)}</span>}
                </div>
              </div>
              {!readOnly && (
                <div className="fact-actions">
                  {f.status === "proposed" ? (
                    <>
                      <button className="btn-ghost btn-sm fact-confirm" disabled={locked} aria-busy={busy === f.fact_id} onClick={() => void decide(f, "confirm")}>
                        <Icon.check /> 确认
                      </button>
                      <button className="btn-link fact-reject" disabled={locked} onClick={() => void decide(f, "reject")}>
                        驳回
                      </button>
                    </>
                  ) : (
                    <>
                      {f.status === "rejected" && (
                        <button className="btn-ghost btn-sm" disabled={locked} onClick={() => void decide(f, "confirm")}>
                          改为确认
                        </button>
                      )}
                      <button className="btn-link" disabled={locked} onClick={() => void decide(f, "reset")}>
                        撤销
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {msg && (
        <p className="muted" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
