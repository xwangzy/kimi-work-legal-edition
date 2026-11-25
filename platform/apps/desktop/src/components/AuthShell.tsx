/**
 * 登录类页面的外壳（第 64 批，参照 Kimi 客户端登录框的版式重做）：首次启动的登录 / 注册 / 找回、凭码激活、从备份恢复、等待批准，
 * 以及已激活电脑退出登录或登录失效后的“重新登录”页，都用这一套——整窗页面（无边框窗口：页面本身可拖动窗口，卡片不可拖）
 * + 居中卡片（顶部品牌条，带细点纹）+ 正文 + 底部说明。
 *
 * 另含注册 / 登录策略的三态显示（MetaGate）：取策略期间显示占位骨架（“正在取得登录方式…”），取不到显示原因与“重试”（并按退避自动再试），
 * 取到了才渲染登录表单——不再像以前那样先按旧流程只显示邮箱登录、取到后再变出验证码登录（Windows 首启尤其明显，根因见 main.cjs 的运行时核对）。
 */
import type { ReactNode } from "react";
import { BrandLockup } from "./Brand.tsx";
import type { MetaState } from "./SmsCodeFields.tsx";
import type { RegistrationMeta } from "../lib/account.ts";
import "../styles-auth.css";

/** 整窗的登录类页面：标识这是哪一种（开通 / 重新登录），验收脚本与冒烟据此识别。 */
export function AuthPage({ kind, children, busy = false }: { kind: "activate" | "relogin" | "boot"; children: ReactNode; busy?: boolean }) {
  return (
    <div className="auth-page activate" data-auth-page={kind} aria-busy={busy || undefined}>
      {children}
    </div>
  );
}

/** 卡片：顶部品牌条 + 正文 + 页脚说明。 */
export function AuthCard({ children, foot, wide = false, brand = true }: { children: ReactNode; foot?: ReactNode; wide?: boolean; brand?: boolean }) {
  return (
    <div className={`auth-card activate-card${wide ? " wide" : ""}`}>
      {brand && (
        <div className="auth-card-head brand">
          <BrandLockup size="lg" />
        </div>
      )}
      <div className="auth-card-body">{children}</div>
      {foot && <div className="auth-card-foot">{foot}</div>}
    </div>
  );
}

/** 登录表单之前的占位骨架（与表单同高，取到策略后不跳动）。 */
export function AuthSkeleton({ label = "正在取得登录方式…" }: { label?: string }) {
  return (
    <div className="auth-skeleton" role="status" aria-live="polite">
      <div className="auth-skel-tabs">
        <span className="auth-skel-bar w-tab" />
        <span className="auth-skel-bar w-tab" />
      </div>
      <span className="auth-skel-bar w-input" />
      <span className="auth-skel-bar w-input" />
      <span className="auth-skel-bar w-btn" />
      <p className="auth-skel-label">
        <span className="auth-dot" aria-hidden="true" />
        {label}
      </p>
    </div>
  );
}

/**
 * 注册 / 登录策略三态：loading → 骨架；error → 原因 + “重试”（后台也会按退避自动再试）；ready → children(meta)。
 * 策略里“旧云端”（legacy）是云端如实答复的结果，按旧流程显示；“取不到”才是 error。
 */
export function MetaGate({ state, children }: { state: MetaState; children: (meta: RegistrationMeta) => ReactNode }) {
  if (state.status === "ready") return <>{children(state.meta)}</>;
  if (state.status === "loading") return <AuthSkeleton label={state.attempt > 0 ? "正在重新连接 Kimi Work 服务…" : "正在取得登录方式…"} />;
  return (
    <div className="auth-unavailable" role="alert">
      <div className="auth-unavailable-title">暂时取不到登录方式</div>
      <p className="auth-unavailable-text">{state.error}</p>
      <div className="auth-unavailable-actions">
        <button type="button" className="btn-primary auth-btn" onClick={state.retry}>
          重试
        </button>
        {state.nextRetryS !== null && <span className="muted">{state.nextRetryS} 秒后自动再试</span>}
      </div>
    </div>
  );
}
