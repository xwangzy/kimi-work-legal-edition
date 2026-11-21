/**
 * 全局搜索面板（Z3 评审 §8.2 #31）：Ctrl + F（macOS 为 ⌘ + F；第 47 批 ⌘K 改为新建任务）或侧栏顶部的搜索按钮打开，在本人能看到的全部事项、任务、成果里按标题找；↑↓ 选、回车打开、Esc 关闭。
 * 匹配在内核里做（search.titles），只返回命中的几条；不联网。输入法组字时的回车与方向键不当作选择（余项续复核 RC-B-08）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { nav } from "../App.tsx";
import { ListSkeleton, LoadError } from "./Loading.tsx";
import { searchGroups, searchLabels, SEARCH_KIND_LABEL, type SearchItem, setMatterFocus } from "../lib/search.ts";

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.searchTitles>> | null>(null);
  const [loading, setLoading] = useState(false);
  // 搜索失败（第 51 批）：原来失败后结果区什么都不显示，像是“没有”；现在说清楚没搜到并给重试
  const [err, setErr] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const labels = useMemo(() => searchLabels(), []);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    if (!q.trim()) {
      setRes(null);
      setErr(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setErr(null);
    // 打字停 200 毫秒再查
    const t = setTimeout(() => {
      api
        .searchTitles(q, labels)
        .then((r) => alive && setRes(r))
        .catch((e) => {
          if (!alive) return;
          setRes(null);
          setErr((e as Error).message ?? "");
        })
        .finally(() => alive && setLoading(false));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, labels, retry]);
  const groups = useMemo(() => (res ? searchGroups(res) : []), [res]);
  const flat = groups.flatMap((g) => g.items);
  useEffect(() => setSel(0), [res]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const open = (it: SearchItem | undefined) => {
    if (!it) return;
    onClose();
    // 材料：交给事项页切到“材料”并筛出这份（只在内存里交接）
    if (it.focus) setMatterFocus(it.focus);
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
          placeholder="搜索事项、任务、成果"
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
          {q.trim() && !loading && err !== null && <LoadError what="搜索结果" message={err} onRetry={() => setRetry((n) => n + 1)} />}
          {loading && q.trim() && !res && <ListSkeleton rows={3} label="正在搜索" />}
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="section-title">{SEARCH_KIND_LABEL[g.kind]}</div>
              {g.items.map((it) => {
                const i = flat.indexOf(it);
                return (
                  <button key={`${it.kind}${it.href}${it.title}`} data-i={i} className={`search-row${i === sel ? " active" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => open(it)}>
                    <b>{it.title}</b>
                    {it.sub && <span className="muted"> · {it.sub}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {res && (res.truncated.runs || res.truncated.deliverables || res.truncated.materials) && <p className="muted">任务、成果或材料太多，只在最近的 3,000 个任务、5,000 份成果、5,000 份材料里找。</p>}
        </div>
      </div>
    </div>
  );
}
