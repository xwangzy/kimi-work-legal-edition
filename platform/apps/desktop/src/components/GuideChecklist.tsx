/**
 * 首页“上手清单”卡片（第 46 批，主文 §5-5）：建事项 → 加材料 → 发起第一个任务 → 查看成果。
 * 每项有“去做”直达对应界面，做完按真实数据自动打勾（内核 guide.progress）；全部完成后显示完成态，可收起。
 * “看看界面”打开原有的聚光讲解（App 里的 GuideTour）。收起状态按律所 + 成员分键记在本机（lib/guide-checklist.ts）。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { nav, OPEN_GUIDE, safeStorage } from "../App.tsx";
import { onDataChanged } from "../lib/events.ts";
import { checklistAction, checklistCounter, checklistItems, checklistKey, checklistState, checklistVisibility, setChecklistState, type ChecklistKey, type GuideProgress } from "../lib/guide-checklist.ts";
import { Icon } from "./Icons.tsx";

export function GuideChecklist({ onNewMatter }: { onNewMatter: () => void }) {
  const [p, setP] = useState<(GuideProgress & { firm: string | null; user: string | null }) | null>(null);
  const [state, setState] = useState<"shown" | "hidden" | null>(null);
  const key = p ? checklistKey(p.firm, p.user) : null;
  const load = useCallback(() => {
    void api
      .guideProgress()
      .then((r) => {
        setP(r);
        setState(checklistState(safeStorage(), checklistKey(r.firm, r.user)));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    // 建事项、导入材料、发起任务后界面会发数据变更通知；从别的页面回到首页时组件重新挂载也会再取一次
    const off = onDataChanged(load);
    const onVis = () => (document.visibilityState === "visible" ? load() : undefined);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);
  const vis = checklistVisibility(state, p);
  useEffect(() => {
    if (!key) return;
    // 第一次见到时：老用户（四项都已完成）悄悄记为收起；新用户记为“显示过”
    if (vis === "retire") {
      setChecklistState(safeStorage(), key, "hidden");
      setState("hidden");
    } else if (vis === "show" && state === null) {
      setChecklistState(safeStorage(), key, "shown");
      setState("shown");
    }
  }, [vis, key, state]);
  if (vis !== "show" || !p || !key) return null;
  const items = checklistItems(p);
  const allDone = items.every((i) => i.done);
  const firstOpen = items.find((i) => !i.done)?.key ?? null;
  const hide = () => {
    setChecklistState(safeStorage(), key, "hidden");
    setState("hidden");
  };
  const go = (k: ChecklistKey) => {
    const a = checklistAction(k, p);
    if (a.kind === "new_matter") onNewMatter();
    else if (a.kind === "nav") nav(a.path);
    else {
      const box = document.querySelector<HTMLElement>('[data-tour="composer"] textarea');
      box?.scrollIntoView({ block: "center" });
      box?.focus();
    }
  };
  return (
    <section className={`guide-checklist${allDone ? " guide-checklist-done" : ""}`} aria-label="上手清单">
      <div className="guide-checklist-head">
        <h2 className="guide-checklist-title">{allDone ? "上手完成" : "上手清单"}</h2>
        <span className="muted guide-checklist-count">{checklistCounter(items)}</span>
        <span className="spacer" />
        <button className="btn-link" onClick={() => window.dispatchEvent(new Event(OPEN_GUIDE))}>
          看看界面
        </button>
        <button className="btn-link" onClick={hide} aria-label="收起上手清单">
          收起
        </button>
      </div>
      {allDone ? (
        <p className="guide-checklist-lead">四步都做过了：以后每个案件照这个顺序来——建事项、加材料、发起任务、复核成果。</p>
      ) : (
        <ol className="guide-checklist-items">
          {items.map((i, n) => (
            <li key={i.key} className={`guide-checklist-item${i.done ? " is-done" : ""}`}>
              <span className="guide-checklist-mark" aria-hidden="true">
                {i.done ? Icon.check() : n + 1}
              </span>
              <span className="guide-checklist-text">
                <span className="guide-checklist-item-title">{i.title}</span>
                <span className="muted guide-checklist-item-body">{i.body}</span>
              </span>
              {i.done ? (
                <span className="guide-checklist-state">已完成</span>
              ) : (
                <button className={i.key === firstOpen ? "btn-primary btn-sm" : "btn-ghost btn-sm"} onClick={() => go(i.key)}>
                  {i.cta}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
