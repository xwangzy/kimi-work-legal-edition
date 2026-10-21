/**
 * 全局搜索面板（Z3 评审 §8.2 #31）：Ctrl / ⌘ + K 打开，在事项、最近任务、交付件里按标题找；↑↓ 选、回车打开、Esc 关闭。
 * 只用本机内核已有的列表（交付件标题在本机还原代号），不联网。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { nav } from "../App.tsx";
import { artifactName, SCENARIO_LABELS } from "../lib/labels.ts";
import { scenarioOfRun } from "../lib/scenarios.ts";
import { searchItems, SEARCH_KIND_LABEL, type SearchItem } from "../lib/search.ts";
import { restoredPlain, restoreTokens } from "../lib/tokens.ts";

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    let alive = true;
    void (async () => {
      const out: SearchItem[] = [];
      const { matters } = await api.listMatters().catch(() => ({ matters: [] as any[] }));
      for (const m of matters) out.push({ kind: "matter", title: m.title, sub: [m.client_name, m.counterparty].filter(Boolean).join(" / "), href: `/matter/${m.matter_id}`, at: (m as any).updated_at ?? null });
      const recent = await api.recentRuns(100).catch(() => ({ runs: [] as any[] }));
      for (const r of recent.runs) {
        const card = scenarioOfRun({ scenario: r.scenario, input_snapshot: { skill: r.skill ?? null } });
        out.push({ kind: "run", title: card?.title ?? SCENARIO_LABELS[r.scenario] ?? "任务", sub: r.matter_title, href: `/run/${r.run_id}/${r.matter_id}`, at: r.updated_at });
      }
      for (const m of matters.slice(0, 50)) {
        const a = await api.listArtifacts(m.matter_id).catch(() => ({ artifacts: [] as any[] }));
        const titles = a.artifacts.map((x: any) => String(x.title ?? "")).join("\n");
        const map = titles.includes("〔") ? await restoreTokens(m.matter_id, titles).catch(() => new Map<string, string | null>()) : new Map<string, string | null>();
        for (const x of a.artifacts) out.push({ kind: "deliverable", title: artifactName(x, (t) => restoredPlain(t, map)), sub: m.title, href: `/review/${x.artifact_version_id}`, at: x.created_at });
      }
      if (alive) {
        setItems(out);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const groups = useMemo(() => searchItems(q, items), [q, items]);
  const flat = groups.flatMap((g) => g.items);
  useEffect(() => setSel(0), [q]);
  const open = (it: SearchItem | undefined) => {
    if (!it) return;
    onClose();
    nav(it.href);
  };
  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal search-palette" role="dialog" aria-label="搜索" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="search-input"
          placeholder="搜索事项、任务、交付件"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, Math.max(flat.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") open(flat[sel]);
          }}
          aria-label="搜索"
        />
        <div className="search-results">
          {q.trim() && !loading && flat.length === 0 && <p className="muted">没有找到。</p>}
          {loading && q.trim() && <p className="muted">正在载入…</p>}
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="section-title">{SEARCH_KIND_LABEL[g.kind]}</div>
              {g.items.map((it) => {
                const i = flat.indexOf(it);
                return (
                  <button key={`${it.kind}${it.href}`} className={`search-row${i === sel ? " active" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => open(it)}>
                    <b>{it.title}</b>
                    {it.sub && <span className="muted"> · {it.sub}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
