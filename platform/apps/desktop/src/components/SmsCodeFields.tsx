/**
 * 手机号 + 短信验证码（第 62 批注册、找回；第 63 批加验证码登录、绑定 / 更换手机号）。开通页（还没激活）与“设置 → 账号”、
 * 登录失效时的就地登录框共用这一份：
 * - “获取验证码”后按云端给的间隔倒计时（缺省 60 秒；频控时按云端回的 retry_after_s），发出后光标移到验证码框；
 * - 验证码填满位数后按回车即提交（没填满按回车不提交）；不会自动提交；
 * - 测试环境（云端不真发短信）写明“测试环境：验证码是 …”。
 * 另含注册策略的读取（取不到按旧流程）与“验证码登录 | 密码登录”切换。律师层不出现“令牌、HMAC”等词。
 */
import { useEffect, useRef, useState } from "react";
import { account } from "../api.ts";
import { initialLoginMethod, loginMethods, phoneLooksValid, rememberedLoginMethod, type LoginMethod, type RegistrationMeta, type SmsPurpose } from "../lib/account.ts";

/**
 * 注册 / 登录策略的三态（第 64 批）：loading（取策略中）/ ready（取到：新云端的策略，或云端如实答复的旧流程 legacy）/
 * error（取不到：连不上、超时、证书不符——如实显示原因与“重试”，并按 5、10、20、40、60 秒退避自动再试）。
 * 此前取到之前（null）与取不到都按旧流程显示：Windows 首启先只有邮箱登录、几十秒后才变出验证码登录；网络一抖还会整次打开都只剩邮箱登录。
 */
export type MetaState =
  | { status: "loading"; attempt: number }
  | { status: "ready"; meta: RegistrationMeta }
  | { status: "error"; error: string; retry: () => void; nextRetryS: number | null; attempt: number };

const META_BACKOFF_S = [5, 10, 20, 40, 60];

export function useRegistrationMetaState({ autoRetry = true }: { autoRetry?: boolean } = {}): MetaState {
  const [st, setSt] = useState<{ status: "loading" | "ready" | "error"; meta?: RegistrationMeta; error?: string; attempt: number; retryAt: number | null }>({ status: "loading", attempt: 0, retryAt: null });
  const [, tick] = useState(0);
  const live = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = (attempt: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setSt({ status: "loading", attempt, retryAt: null });
    account
      .registrationMeta()
      .then((m) => live.current && setSt({ status: "ready", meta: m && typeof m === "object" ? m : { legacy: true }, attempt, retryAt: null }))
      .catch((e) => {
        if (!live.current) return;
        const wait = META_BACKOFF_S[Math.min(attempt, META_BACKOFF_S.length - 1)]!;
        setSt({ status: "error", error: (e as Error).message || "暂时连不上 Kimi Work 服务，请检查网络后重试。", attempt, retryAt: autoRetry ? Date.now() + wait * 1000 : null });
        // 可有可无的入口（账号卡上的“绑定手机号”）不自动再试：离线时不定期发请求
        if (autoRetry) timer.current = setTimeout(() => live.current && load(attempt + 1), wait * 1000);
      });
  };
  useEffect(() => {
    live.current = true;
    load(0);
    return () => {
      live.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  // 自动再试的倒计时每秒刷新一次
  useEffect(() => {
    if (st.status !== "error") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [st.status]);
  if (st.status === "ready") return { status: "ready", meta: st.meta! };
  if (st.status === "loading") return { status: "loading", attempt: st.attempt };
  return { status: "error", error: st.error!, attempt: st.attempt, retry: () => load(st.attempt + 1), nextRetryS: st.retryAt === null ? null : Math.max(0, Math.ceil((st.retryAt - Date.now()) / 1000)) };
}

/**
 * 只要“取到的策略”（取策略中、取不到都为 null）：账号卡上“绑定手机号”按钮这类可有可无的入口用它（取不到就先不显示）。
 */
export function useRegistrationMeta(): RegistrationMeta | null {
  const s = useRegistrationMetaState({ autoRetry: false });
  return s.status === "ready" ? s.meta : null;
}

/**
 * 登录方式（第 63 批）：云端开了验证码登录才有两种，先显示上次用过的（没有记录先显示验证码登录）；否则只有密码登录。
 * 策略还没取到时先按密码登录显示；律师在这期间已经开始填邮箱或密码（lock），取到后也不再切走。
 */
export function useLoginMethod(meta: RegistrationMeta | null) {
  const methods = loginMethods(meta);
  const [remembered] = useState(() => rememberedLoginMethod());
  const [chosen, setChosen] = useState<LoginMethod | null>(null);
  const method: LoginMethod = methods.phone ? (chosen ?? initialLoginMethod(methods, remembered)) : "password";
  return {
    methods,
    method,
    choose: (m: LoginMethod) => setChosen(m),
    /** 策略还没取到、律师已经在填密码登录：定在密码登录。 */
    lock: () => {
      if (meta === null && chosen === null) setChosen("password");
    },
  };
}

/** “验证码登录 | 密码登录”：比外层“登录 | 注册”轻一档（文字加下划线），一眼分得清主次。 */
export function LoginMethodTabs({ value, onChange }: { value: LoginMethod; onChange: (m: LoginMethod) => void }) {
  return (
    <div className="auth-method" role="tablist" aria-label="登录方式">
      <button type="button" role="tab" aria-selected={value === "phone"} className={value === "phone" ? "on" : ""} onClick={() => onChange("phone")}>
        验证码登录
      </button>
      <button type="button" role="tab" aria-selected={value === "password"} className={value === "password" ? "on" : ""} onClick={() => onChange("password")}>
        密码登录
      </button>
    </div>
  );
}

/** 手机号 + 短信验证码：发送失败把原因写在表单的错误行（setErr）；需要按原因做别的（例如手机号没注册）用 onSendError。 */
export function SmsCodeFields(p: {
  phone: string;
  setPhone: (v: string) => void;
  code: string;
  setCode: (v: string) => void;
  purpose: SmsPurpose;
  codeLength: number;
  resendSeconds: number;
  optional?: boolean;
  setErr: (v: string) => void;
  onSendError?: (e: unknown) => void;
  autoFocus?: boolean;
  /** 手机号一栏的标题（缺省“手机号”；更换手机号时为“新手机号”）。 */
  phoneLabel?: string;
}) {
  const [wait, setWait] = useState(0);
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const canSend = phoneLooksValid(p.phone) && !sending && wait <= 0;
  const sendCode = async () => {
    if (!canSend) return;
    setSending(true);
    p.setErr("");
    setHint("");
    try {
      const r = await account.smsSend(p.phone.trim(), p.purpose);
      setWait(r.resend_after_s || p.resendSeconds);
      // 测试环境（云端开了 dry-run）不发短信，把验证码直接给出；正式环境不会有这一项
      setHint(r.dry_run && r.debug_code ? `测试环境：验证码是 ${r.debug_code}（正式环境会发到手机）` : `验证码已发送到 ${r.phone ?? "你的手机"}，${Math.round((r.expires_in_s || 600) / 60)} 分钟内有效`);
      // 发出后直接把光标放到验证码框
      codeRef.current?.focus();
    } catch (e) {
      const d = (e as { detail?: { retry_after_s?: number } }).detail;
      if (d && Number.isSafeInteger(d.retry_after_s) && (d.retry_after_s as number) > 0) setWait(Math.min(600, d.retry_after_s as number));
      p.setErr((e as Error).message || "验证码没有发出，请稍后重试");
      p.onSendError?.(e);
    } finally {
      setSending(false);
    }
  };
  const codeShown = !p.optional || p.phone.trim() !== "";
  return (
    <>
      <label className="field">
        <span>{p.optional ? (p.phoneLabel ?? "手机号（可不填，填了可用手机号找回密码）") : (p.phoneLabel ?? "手机号")}</span>
        {/* 第 64 批：“+86”前缀与输入框是一个整体（只收中国大陆手机号） */}
        <span className="auth-input-group">
        <span className="auth-prefix" aria-hidden="true">
          +86
        </span>
        <input
          className="auth-input"
          type="tel"
          value={p.phone}
          onChange={(e) => p.setPhone(e.target.value)}
          onKeyDown={(e) => {
            // 手机号填好、还没有验证码时按回车 = 获取验证码（不去提交表单）
            if (e.key === "Enter" && codeShown && !p.code && canSend) {
              e.preventDefault();
              void sendCode();
            }
          }}
          autoComplete="tel"
          inputMode="tel"
          maxLength={20}
          placeholder={p.optional ? "11 位手机号（可不填）" : "请输入手机号"}
          aria-label={p.phoneLabel ?? "手机号"}
          autoFocus={p.autoFocus}
        />
        </span>
        {p.phone.trim() && !phoneLooksValid(p.phone) && <span className="field-warn">手机号格式不对</span>}
      </label>
      {codeShown && (
        <label className="field">
          <span>短信验证码</span>
          <span className="sms-row">
            <input
              ref={codeRef}
              className="auth-input"
              value={p.code}
              onChange={(e) => p.setCode(e.target.value.replace(/\D/g, "").slice(0, p.codeLength))}
              onKeyDown={(e) => {
                // 填满位数才按回车提交；没填满按回车不提交（避免半截的码被拿去核对、白白用掉一次尝试）
                if (e.key === "Enter" && p.code.length < p.codeLength) e.preventDefault();
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={p.codeLength}
              placeholder={`请输入 ${p.codeLength} 位验证码`}
              aria-label="短信验证码"
              spellCheck={false}
            />
            <button type="button" className="btn-ghost sms-send" disabled={!canSend} onClick={() => void sendCode()}>
              {sending ? "正在发送…" : wait > 0 ? `${wait} 秒后重新获取` : "获取验证码"}
            </button>
          </span>
          {hint && <span className="muted sms-hint">{hint}</span>}
        </label>
      )}
    </>
  );
}
