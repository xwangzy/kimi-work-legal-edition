/**
 * 全局搜索面板（Z3 评审 §8.2 #31）：Ctrl + K（macOS 为 ⌘ + K）打开，在本人能看到的全部事项、任务、交付件里按标题找；↑↓ 选、回车打开、Esc 关闭。
 * 匹配在内核里做（search.titles），只返回命中的几条；不联网。输入法组字时的回车与方向键不当作选择（余项续复核 RC-B-08）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { nav } from "../App.tsx";
import { searchGroups, searchLabels, SEARCH_KIND_LABEL, type SearchItem } from "../lib/search.ts";

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.searchTitles>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const labels = useMemo(() => searchLabels(), []);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    if (!q.trim()) {
      setRes(null);
      return;
    }
    let alive = true;
    setLoading(true);
    // 打字停 200 毫秒再查
    const t = setTimeout(() => {
      api
        .searchTitles(q, labels)
        .then((r) => alive && setRes(r))
        .catch(() => alive && setRes(null))
        .finally(() => alive && setLoading(false));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, labels]);
  const groups = useMemo(() => (res ? searchGroups(res) : []), [res]);
  const flat = groups.flatMap((g) => g.items);
  useEffect(() => setSel(0), [res]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const open = (it: SearchItem | undefined) => {
    if (!it) return;
    onClose();
    nav(it.href);
  };
  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div
        className="modal search-palette"
        role="dialog"
        aria-modal="true"
        aria-label="搜索"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Esc 挂在面板上（焦点在结果行时也有效），不连带关掉底下的对话框
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <input
          ref={inputRef}
          className="search-input"
          placeholder="搜索事项、任务、交付件"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, Math.max(flat.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") open(flat[sel]);
          }}
          aria-label="搜索"
        />
        <div className="search-results" ref={listRef}>
          {q.trim() && !loading && res && flat.length === 0 && <p className="muted">没有找到。</p>}
          {loading && q.trim() && !res && <p className="muted">正在找…</p>}
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="section-title">{SEARCH_KIND_LABEL[g.kind]}</div>
              {g.items.map((it) => {
                const i = flat.indexOf(it);
                return (
                  <button key={`${it.kind}${it.href}`} data-i={i} className={`search-row${i === sel ? " active" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => open(it)}>
                    <b>{it.title}</b>
                    {it.sub && <span className="muted"> · {it.sub}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {res && (res.truncated.runs || res.truncated.deliverables) && <p className="muted">任务或交付件太多，只在最近的 3,000 个任务、5,000 份交付件里找。</p>}
        </div>
      </div>
    </div>
  );
}
