/**
 * 事项页 · 事实（v9.3 复核 R15B-01）：整理案卷（第一段）与 Agent 提交的事实都在这里，律师逐条确认或驳回。
 * 只有确认过的事实会被“争点与证据分析”、起诉状等文书采用；驳回的不再出现在文书里，可以撤销。
 */
import { useEffect, useState } from "react";
import { api, type FactRow } from "../api.ts";
import { factCounts, factSourceText } from "../lib/facts.ts";

export function FactsPanel({ matterId, docs, readOnly }: { matterId: string; docs: { document_version_id: string; filename: string }[]; readOnly: boolean }) {
  const [facts, setFacts] = useState<FactRow[] | null>(null);
  const [show, setShow] = useState<"proposed" | "confirmed" | "rejected">("proposed");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = () =>
    api
      .facts(matterId)
      .then((r) => setFacts(r.facts))
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
  if (!facts) return <p className="muted">{msg || "正在读取…"}</p>;
  const n = factCounts(facts);
  const fileOf = new Map(docs.map((d) => [d.document_version_id, d.filename]));
  const list = facts.filter((f) => f.status === show);
  return (
    <section>
      <p className="muted">
        这里的事实来自“整理案卷”和 AI 任务，都是“材料里这么写”的记载，不是认定。只有你确认过的，才会被“争点与证据分析”、起诉状等文书采用。
      </p>
      <div className="settings-choice" role="radiogroup" aria-label="事实状态">
        {(
          [
            ["proposed", `待确认（${n.proposed}）`],
            ["confirmed", `已确认（${n.confirmed}）`],
            ["rejected", `已驳回（${n.rejected}）`],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="radio" aria-checked={show === k} className={`q-option${show === k ? " on" : ""}`} onClick={() => setShow(k)}>
            {l}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="muted">{show === "proposed" ? (facts.length === 0 ? "还没有事实。先在首页做一次“整理案卷”，抽出的日期、金额与主体会放到这里。" : "没有待确认的事实。") : "没有。"}</p>
      ) : (
        <table className="members-table">
          <thead>
            <tr>
              <th>日期</th>
              <th>事实（材料原文）</th>
              <th>出处</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((f) => (
              <tr key={f.fact_id}>
                <td>{f.occurred_on ?? "—"}</td>
                <td>
                  {f.statement}
                  {f.amount_yuan !== null && <div className="muted">金额：{f.amount_yuan.toLocaleString()} 元</div>}
                </td>
                <td className="muted">{factSourceText(f, fileOf)}</td>
                <td>
                  {!readOnly && (
                    <span className="settings-choice">
                      {f.status !== "confirmed" && (
                        <button className="btn-ghost btn-sm" disabled={busy !== null} onClick={() => void decide(f, "confirm")}>
                          确认
                        </button>
                      )}
                      {f.status === "proposed" && (
                        <button className="btn-ghost btn-sm" disabled={busy !== null} onClick={() => void decide(f, "reject")}>
                          驳回
                        </button>
                      )}
                      {f.status !== "proposed" && (
                        <button className="btn-link" disabled={busy !== null} onClick={() => void decide(f, "reset")}>
                          撤销
                        </button>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && (
        <p className="muted" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
