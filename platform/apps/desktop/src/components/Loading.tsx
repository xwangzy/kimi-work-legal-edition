/**
 * 统一的等待反馈（第 51 批）。四个部件，对应四级等待（规则见 lib/waiting.ts、样式见 styles-motion.css）：
 *  - <KimiPulse>：Kimi 蓝点呼吸，表示“AI 正在处理”（取官方 Logomark 的气泡点）；
 *  - <BusyLabel>：按钮内的小圆环 + “正在…”，按钮同时禁用，防止连点（签发、导出、开始、保存）；
 *  - <ListSkeleton>：取数时的骨架，形状接近真实列表，延迟 160ms 才出现；
 *  - <WaitBlock>：中长等待——蓝点 + 在做什么 + 已用时间（真实计时），等久了在同一块里补一句说明；
 *  - <LoadError>：取数失败（不显示成空状态），带“重试”。
 * 读屏：等待块与骨架带 role="status"，忙碌的按钮带 aria-busy。
 */
import { useEffect, useState, type ReactNode } from "react";
import { fmtWait, waitLevel } from "../lib/waiting.ts";
import { KimiMark } from "./Brand.tsx";
import "../styles-motion.css";

/**
 * 整页等待的标识（第 55 批）：官方 Logomark，右上角的蓝点在呼吸、带一圈淡出的光晕——冷启动、整页载入这种“第一眼”用它，
 * 比一个 8px 的小蓝点更像这个产品自己在准备。只动蓝点（位移与透明度），标识本身不变形；减少动效时静止。
 */
export function KimiMarkLoader() {
  return (
    <span className="kwl-mark-loader" aria-hidden="true">
      <KimiMark />
      <span className="kwl-mark-halo" />
    </span>
  );
}

export function KimiPulse({ size = "sm", idle = false, label }: { size?: "sm" | "md" | "lg"; idle?: boolean; label?: string }) {
  return <span className={`kwl-pulse${size === "sm" ? "" : ` ${size}`}${idle ? " idle" : ""}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

/** 按钮文字：忙时换成小圆环 + busyText（例如“正在签发…”）。按钮本身仍要设 disabled 与 aria-busy。 */
export function BusyLabel({ busy, children, busyText }: { busy: boolean; children: ReactNode; busyText?: ReactNode }) {
  if (!busy) return <>{children}</>;
  return (
    <span className="btn-busy">
      <span className="kwl-spin" aria-hidden="true" />
      {busyText ?? children}
    </span>
  );
}

/** 列表骨架：rows 行（类型方块 + 一行字）；cards > 1 时分成几张卡片，带一行标题占位。 */
export function ListSkeleton({ rows = 4, cards = 1, label = "正在载入" }: { rows?: number; cards?: number; label?: string }) {
  const widths = ["46%", "62%", "38%", "54%", "70%", "42%"];
  return (
    <div className="kwl-skel" role="status" aria-label={label}>
      {Array.from({ length: cards }, (_, c) => (
        <div key={c}>
          {cards > 1 && <div className="kwl-skel-line kwl-skel-head" />}
          <div className="kwl-skel-card">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="kwl-skel-row">
                <span className="kwl-skel-box" />
                <span className="kwl-skel-line" style={{ width: widths[(i + c) % widths.length] }} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 从 since（毫秒时间戳）起每秒刷新的已用时间；since 为空时为 0。 */
export function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, now - since);
}

/**
 * 中长等待块：蓝点 + 标题 +（3 秒后）已用时间；超过 30 秒显示 longHint（为什么慢、可以离开、怎么停）。
 * variant：card（浅底块）/ inline（行内，无底）/ page（整页居中）。
 */
export function WaitBlock({ title, hint, longHint, since, variant = "card", children }: { title: ReactNode; hint?: ReactNode; longHint?: ReactNode; since?: number | null; variant?: "card" | "inline" | "page"; children?: ReactNode }) {
  const elapsed = useElapsed(since ?? null);
  const level = waitLevel(elapsed);
  return (
    <div className={`kwl-wait${variant === "card" ? "" : ` ${variant}`}`} role="status" aria-live="polite">
      {variant === "page" ? <KimiMarkLoader /> : <KimiPulse />}
      <div className="kwl-wait-main">
        <span className="kwl-wait-title">{title}</span>
        {hint && <span className="kwl-wait-hint">{hint}</span>}
        {level === "long" && longHint && <span className="kwl-wait-hint">{longHint}</span>}
        {children}
      </div>
      {since != null && (level === "medium" || level === "long") && <span className="kwl-wait-time">{fmtWait(elapsed)}</span>}
    </div>
  );
}

/** 取数失败：说清楚没读到（不是“没有”），给重试。 */
export function LoadError({ what, message, onRetry }: { what: string; message?: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-orange" role="alert">
      没有读到{what}{message ? `：${message}` : ""}。这不代表没有内容。
      {onRetry && (
        <div className="banner-actions">
          <button className="btn-ghost btn-sm" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
    </div>
  );
}
