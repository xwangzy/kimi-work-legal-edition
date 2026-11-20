/**
 * 在本事项材料里搜索（第 48 批，事项页“材料”标签）：输入即按文件名筛选下面的列表；回车（或停顿片刻、至少两个字）
 * 再到材料的文字里找，命中处标出前后文。只在这台电脑上搜，不发给 AI。
 * 列表本身由调用方渲染（children 拿到当前搜索词，按文件名筛选）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type MaterialSearchHit } from "../api.ts";
import { highlightParts, queryTerms, relDir, shouldAutoSearch } from "../lib/material-folder.ts";
import { Icon } from "./Icons.tsx";

const DEBOUNCE_MS = 300;

export function MaterialSearch(p: { matterId: string; children: (q: string) => ReactNode }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ q: string; items: MaterialSearchHit[]; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    const t = text.trim();
    const my = ++seq.current;
    if (!t) {
      setHits(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr("");
    api
      .searchMaterials(p.matterId, t)
      .then((r) => {
        if (my === seq.current) setHits({ q: t, items: r.hits.filter((h) => h.snippet), truncated: r.truncated });
      })
      .catch((e) => {
        if (my === seq.current) setErr((e as Error).message);
      })
      .finally(() => {
        if (my === seq.current) setLoading(false);
      });
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  // 换事项时清空
  useEffect(() => {
    seq.current++;
    setQ("");
    setHits(null);
    setErr("");
  }, [p.matterId]);

  const onChange = (v: string) => {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    if (shouldAutoSearch(v)) timer.current = setTimeout(() => search(v), DEBOUNCE_MS);
    else {
      seq.current++;
      setHits(null);
      setLoading(false);
    }
  };
  const clear = () => onChange("");
  const terms = hits ? queryTerms(hits.q) : [];

  return (
    <>
      <div className="ms-box" role="search">
        <Icon.search />
        <input
          className="ms-input"
          type="search"
          value={q}
          placeholder="在本事项材料里搜索"
          aria-label="在本事项材料里搜索（文件名与文字）"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") search(q);
            if (e.key === "Escape" && q) clear();
          }}
        />
        {q && (
          <button className="btn-icon ms-clear" aria-label="清除搜索" title="清除搜索" onClick={clear}>
            <Icon.x />
          </button>
        )}
      </div>
      {loading && <p className="ms-status">正在材料的文字里搜索…</p>}
      {err && (
        <p className="mf-error" role="alert">
          {err}
        </p>
      )}
      {!loading && hits && q.trim() === hits.q && (
        <div className="ms-hits" role="status">
          <p className="ms-status">
            {hits.items.length === 0 ? `材料的文字里没有找到“${hits.q}”` : `文字里找到 ${hits.items.length}${hits.truncated ? "+" : ""} 份`}
          </p>
          {hits.items.length > 0 && (
            <ul className="ms-list">
              {hits.items.map((h) => (
                <li key={h.document_version_id}>
                  <div className="ms-head">
                    <span className="ms-file">{h.filename}</span>
                    {relDir(h.rel_path) && <span className="ms-dir">{relDir(h.rel_path)}</span>}
                    <span className="ms-count">{h.hits} 处</span>
                  </div>
                  <p className="ms-snippet">
                    {highlightParts(h.snippet ?? "", terms).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {p.children(q)}
    </>
  );
}
