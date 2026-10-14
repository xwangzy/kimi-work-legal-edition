/**
 * 当事人词典（第 02 篇 §8.3：自然人姓名识别靠当事人词典 + 实体识别，L3a 事项须人工核对词典；阶段 4 复核 S4-20）：
 * 确认的别名、从材料“以下简称”学得的待确认别名（照常参与匹配，请确认或驳回）、机构名称自动派生的字号（可停用）、已停用的写法（可撤销）。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";

interface PartyView {
  name: string;
  kind: "person" | "org";
  aliases: string[];
  learned: string[];
  derived: string[];
  excluded: string[];
  role: string | null;
  source: "matter_header" | "dictionary";
}

export function PartiesPanel({ matterId, onChanged, readOnly = false }: { matterId: string; onChanged?: () => void; readOnly?: boolean }) {
  const [parties, setParties] = useState<PartyView[] | null>(null);
  const [fullPseudonym, setFullPseudonym] = useState(false);
  const [draft, setDraft] = useState({ name: "", kind: "person" as "person" | "org", aliases: "" });
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api
      .parties(matterId)
      .then((r: any) => {
        setParties(r.parties as PartyView[]);
        setFullPseudonym(!!r.full_pseudonym);
      })
      .catch((e) => setErr(e.message));
  }, [matterId]);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setErr("");
    try {
      await fn();
      load();
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const alias = (name: string, a: string, action: "confirm" | "reject" | "restore") => act(() => api.partyAlias(matterId, name, a, action));
  return (
    // 结案事项只读（复核 C-B11）：fieldset disabled 让其中所有按钮与输入不可用
    <fieldset className="parties fieldset-plain" disabled={readOnly}>
      <p className="muted">
        词典里的名称与别名在发给模型、检索与抓取前替换为代号或被拦截（自然人默认替换；机构名称{fullPseudonym ? "在本事项也替换（全部化名）" : "默认保留"}）。
        漏识别的姓名仍会出站——请核对词典，尤其是敏感事项。
      </p>
      {err && <div className="banner banner-red">{err}</div>}
      <table className="data">
        <thead><tr><th>名称</th><th>类型</th><th>别名</th><th>待确认（学得）</th><th>自动派生字号</th><th>已停用</th><th /></tr></thead>
        <tbody>
          {(parties ?? []).map((p) => (
            <tr key={p.name}>
              <td><b>{p.name}</b>{p.source === "matter_header" ? <small className="muted">（事项头）</small> : null}</td>
              <td>{p.kind === "person" ? "自然人" : "机构"}</td>
              <td>{p.aliases.join("、") || "—"}</td>
              <td>
                {p.learned.length === 0 ? "—" : p.learned.map((a) => (
                  <span key={a} className="alias-chip alias-pending">
                    {a}
                    <button onClick={() => void alias(p.name, a, "confirm")}>确认</button>
                    <button onClick={() => void alias(p.name, a, "reject")}>驳回</button>
                  </span>
                ))}
              </td>
              <td>
                {p.derived.length === 0 ? "—" : p.derived.map((a) => (
                  <span key={a} className="alias-chip">
                    {a}
                    <button title="常用词形态的字号会误拒一般性检索时停用" onClick={() => void alias(p.name, a, "reject")}>停用</button>
                  </span>
                ))}
              </td>
              <td>
                {p.excluded.length === 0 ? "—" : p.excluded.map((a) => (
                  <span key={a} className="alias-chip alias-off">
                    {a}
                    <button onClick={() => void alias(p.name, a, "restore")}>撤销</button>
                  </span>
                ))}
              </td>
              <td>
                {p.source === "dictionary" && (
                  <button className="btn-link" onClick={() => void act(() => api.removeParty(matterId, p.name))}>删除</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="party-add">
        <input placeholder="名称（关联方、证人、员工等）" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as "person" | "org" })}>
          <option value="person">自然人</option>
          <option value="org">机构</option>
        </select>
        <input placeholder="别名（顿号分隔，可空）" value={draft.aliases} onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} />
        <button
          className="btn-ghost"
          disabled={draft.name.trim().length < 2}
          onClick={() =>
            void act(async () => {
              await api.upsertParty(matterId, { name: draft.name.trim(), kind: draft.kind, aliases: draft.aliases.split(/[、,，;；\s]+/).map((s) => s.trim()).filter(Boolean) });
              setDraft({ name: "", kind: "person", aliases: "" });
            })
          }
        >
          加入词典
        </button>
      </div>
    </fieldset>
  );
}

