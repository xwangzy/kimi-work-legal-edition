/**
 * 首次上手指南（2026-11）：五步聚光引导，逐步框出侧栏、输入框与场景区等真实位置，说明卡放在旁边。
 * 步骤内容在 lib/guide-steps.ts；键盘：Esc 跳过、← → 上一步 / 下一步、Enter 下一步。
 * 指南期间整页加一层半透明遮罩（只框出当前位置），不能误点到下面的界面；结束时由调用方记“看过了”。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GUIDE_STEPS, placeCard, stepCounter, unionRect } from "../lib/guide-steps.ts";

type Rect = { left: number; top: number; width: number; height: number };

const PAD = 6;
const CARD_W = 340;

function anchorRect(anchors: string[]): Rect | null {
  const rects: Rect[] = [];
  for (const a of anchors) {
    const el = document.querySelector<HTMLElement>(`[data-tour="${a}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    rects.push({ left: r.left, top: r.top, width: r.width, height: r.height });
  }
  const u = unionRect(rects);
  return u ? { left: u.left - PAD, top: u.top - PAD, width: u.width + PAD * 2, height: u.height + PAD * 2 } : null;
}

export function GuideTour({ onFinish, hasMatters, onNewMatter }: { onFinish: (how: "done" | "skipped") => void; hasMatters: boolean; onNewMatter: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardH, setCardH] = useState(190);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const step = GUIDE_STEPS[i]!;
  const last = i === GUIDE_STEPS.length - 1;

  const measure = useCallback(() => setRect(step.anchors.length ? anchorRect(step.anchors) : null), [step]);
  useLayoutEffect(() => {
    measure();
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [measure, i]);
  useEffect(() => {
    const on = () => measure();
    window.addEventListener("resize", on);
    // 首页内容（事项、期限）异步载入会让输入框位置变动：短时间内再量一次
    const t = setTimeout(on, 250);
    return () => {
      window.removeEventListener("resize", on);
      clearTimeout(t);
    };
  }, [measure]);
  useEffect(() => {
    primaryRef.current?.focus();
  }, [i]);

  const next = () => (last ? onFinish("done") : setI((x) => x + 1));
  const prev = () => setI((x) => Math.max(0, x - 1));
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onFinish("skipped");
      } else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const view = { width: window.innerWidth, height: window.innerHeight };
  const pos = placeCard(rect, view, { width: CARD_W, height: cardH });
  return (
    <div className="guide-layer" role="dialog" aria-modal="true" aria-labelledby="guide-title" aria-describedby="guide-body">
      {rect ? (
        <div className="guide-spot" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} aria-hidden="true" />
      ) : (
        <div className="guide-dim" aria-hidden="true" />
      )}
      <div ref={cardRef} className={`guide-card guide-${pos.side}`} style={{ left: pos.left, top: pos.top, width: CARD_W }}>
        <div className="guide-meta">
          <span className="guide-count">{stepCounter(i)}</span>
          <span className="guide-dots" aria-hidden="true">
            {GUIDE_STEPS.map((s, k) => (
              <span key={s.key} className={`guide-dot${k === i ? " on" : ""}`} />
            ))}
          </span>
        </div>
        <h2 id="guide-title" className="guide-title">
          {step.title}
        </h2>
        <p id="guide-body" className="guide-body">
          {step.body}
        </p>
        <div className="guide-actions">
          {!last && (
            <button className="btn-link guide-skip" onClick={() => onFinish("skipped")}>
              跳过
            </button>
          )}
          <span className="spacer" />
          {i > 0 && (
            <button className="btn-ghost btn-sm" onClick={prev}>
              上一步
            </button>
          )}
          {last && !hasMatters ? (
            <>
              <button className="btn-ghost btn-sm" onClick={() => onFinish("done")}>
                先看看
              </button>
              <button
                ref={primaryRef}
                className="btn-primary btn-sm"
                onClick={() => {
                  onFinish("done");
                  onNewMatter();
                }}
              >
                新建第一个事项
              </button>
            </>
          ) : (
            <button ref={primaryRef} className="btn-primary btn-sm" onClick={next}>
              {i === 0 ? "开始" : last ? "开始使用" : "下一步"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
