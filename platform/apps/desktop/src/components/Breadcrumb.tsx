/**
 * 顶部面包屑（Z3 §8.2 #31 前半，10-13《UIUX 评审》遗留；余项续复核 RC-B-18）：事项页、任务页、交付件详情页标出“在哪里”，
 * 前几级可点回去；过长的名称截断，悬停看全称。
 */
import { nav } from "../App.tsx";
import { clipTitle } from "../lib/labels.ts";

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="breadcrumb" aria-label="位置">
      {items.map((it, i) => (
        <span key={i} className="crumb">
          {i > 0 && <span className="crumb-sep" aria-hidden="true">›</span>}
          {it.href && i < items.length - 1 ? (
            <button className="btn-link" title={it.label} onClick={() => nav(it.href!)}>
              {clipTitle(it.label, 20)}
            </button>
          ) : (
            <span title={it.label} aria-current={i === items.length - 1 ? "page" : undefined}>
              {clipTitle(it.label, 20)}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
