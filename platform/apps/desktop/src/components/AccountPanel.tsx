/**
 * 设置 → 账号与团队 → 账号（第 44 批，主文 §2）：账号卡、我的电脑（解绑须输入密码）、登录记录（可让别处下线）、改密码、退出登录；
 * 以及登录失效时的就地登录框（App 顶部横幅与这里共用）。第 63 批：云端开了验证码登录时登录框可选“验证码登录 | 密码登录”；
 * 账号卡显示手机号（打码）或“未绑定”，可绑定 / 更换手机号（更换另要当前密码）。
 * 律师层用语：说“账号、这台电脑、登录”，不说“令牌、证书、席位、吊销”。
 */
import { useEffect, useRef, useState } from "react";
import { account, type AccountMe, type AccountStatus } from "../api.ts";
import { checkPassword, dayLabel, deviceLine, emailLooksValid, loginRequiredText, notRegisteredActions, phoneBindForm, phoneLabel, phoneLooksValid, phoneNotRegistered, registrationFields, resetNextText, roleLabel, saveLoginMethod, sessionLine, smsCodeLooksValid, type LoginMethod, type RegistrationMeta } from "../lib/account.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { Modal } from "./Modal.tsx";
import { PasswordField } from "./PasswordField.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { MetaGate } from "./AuthShell.tsx";
import { LoginMethodTabs, SmsCodeFields, useLoginMethod, useRegistrationMeta, useRegistrationMetaState } from "./SmsCodeFields.tsx";
import { DeviceLimitList } from "./DeviceLimitList.tsx";
import { currentProfileMark, isSwitchResult, waitForProfileSwitch } from "../lib/account-switch.ts";
import { accountWho, recentLoginRows, canRenameDevices, checkDeviceName, DEVICE_NAME_MAX, deviceName, deviceState, maskPhoneTight, passwordIdOk, reloginSmsFailure, resetIdKind, switchingText, type AccountDevice } from "../lib/account.ts";

/** 账号状态变了（登录、退出）：App 顶部横幅据此立即刷新。 */
export const ACCOUNT_CHANGED = "kwl:account-changed";
export const notifyAccountChanged = () => window.dispatchEvent(new Event(ACCOUNT_CHANGED));

/**
 * 就地登录（会话失效、退出登录之后）：只登这台电脑已登记的那位成员的账号。第 63 批：云端开了验证码登录时可选两种方式，
 * 先显示上次用过的（没有记录先显示验证码登录）；手机号没有对应账号时只给“改用密码登录”（这里不能注册新账号）。
 */
export function LoginBox({ email: initialEmail = "", onDone, compact = false, page = false, subtle = false, knownPhone }: { email?: string; onDone: () => void; compact?: boolean; page?: boolean; subtle?: boolean; knownPhone?: string | null }) {
  const [email, setEmail] = useState(initialEmail);
  const [pw, setPw] = useState("");
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [unreg, setUnreg] = useState(false);
  const [forgot, setForgot] = useState(false);
  // 第 71 批（V45）：整窗重新登录、回到这台电脑原来的账号——验证码发到账号绑定的手机号（只读显示打码号），律师只填验证码；
  // 发码失败（没绑手机号、旧云端不支持等，限频除外）退回可输入手机号的原流程
  const reloginAccount = page && subtle && !!initialEmail;
  const [codeOnlyOff, setCodeOnlyOff] = useState(false);
  // 第 71 批第二轮：内核 account.status 给了这个账号的打码手机号（last_account.phone）才用“只填验证码”；明确没有（null）时直接用可输入手机号的原流程；还在取（undefined）时先按只填验证码显示
  const codeOnly = reloginAccount && !codeOnlyOff && knownPhone !== null;
  // 第 68 批（V42，D-294/295）：登录的是另一个账号 → 切到那个账号的工作空间（过渡说明）；那个账号电脑数已满 → 列出它的电脑，可就地处理一台
  const [switching, setSwitching] = useState<string | null>(null);
  const [limit, setLimit] = useState<{ devices: AccountDevice[]; canUnbind: boolean; canSignout: boolean; limit: number | null; limitKind: "signed_in" | "registered" | null; thisDevice: string | null; who: string | null } | null>(null);
  const afterLogin = async (r: unknown, before: string): Promise<boolean> => {
    if (!isSwitchResult(r)) return false;
    setLimit(null);
    setSwitching(switchingText(r));
    await waitForProfileSwitch(before, (t) => {
      setSwitching(null);
      setErr(t);
    });
    return true;
  };
  const limitOf = (e: unknown) => {
    const d = (e as { detail?: { reason?: unknown; devices?: unknown; can_unbind?: unknown; can_signout?: unknown; device_limit?: unknown; limit_kind?: unknown; this_device?: unknown; account?: { name?: unknown; phone?: unknown } } })?.detail;
    // 第 71 批（V45，D-298）：同时登录已满（这台已登记的电脑重新登录，或换到的账号）——默认“让它退出登录”，移除为次要；称呼本人用“姓名（打码手机号）”
    const acc = d?.account && typeof d.account === "object" ? d.account : null;
    const who = accountWho({ name: typeof acc?.name === "string" ? acc.name : null, phone: typeof acc?.phone === "string" ? acc.phone : byPhone && !codeOnly ? phone : null, email: email.includes("@") ? email : null });
    return d && d.reason === "device_limit" && Array.isArray(d.devices) && d.devices.length > 0
      ? { devices: d.devices as AccountDevice[], canUnbind: d.can_unbind === true, canSignout: d.can_signout === true, limit: typeof d.device_limit === "number" ? d.device_limit : null, limitKind: d.limit_kind === "registered" ? ("registered" as const) : d.limit_kind === "signed_in" ? ("signed_in" as const) : null, thisDevice: typeof d.this_device === "string" ? d.this_device : null, who }
      : null;
  };
  // 第 64 批：登录方式三态（取策略中 / 取不到 / 取到）——整窗重新登录时取到才显示表单；设置页里的小登录框取不到时按密码登录显示
  const metaState = useRegistrationMetaState();
  const meta = metaState.status === "ready" ? metaState.meta : null;
  // 第 71 批：重新登录时验证码也只要填一项（不再为了“少填一项”强制先显示密码登录），按上次用过的方式
  const lm = useLoginMethod(meta);
  const f = registrationFields(meta);
  const byPhone = lm.method === "phone";
  const ready = byPhone ? (codeOnly ? smsCodeLooksValid(smsCode, f.codeLength) : phoneLooksValid(phone) && smsCodeLooksValid(smsCode, f.codeLength)) : passwordIdOk(email, meta) && pw.length > 0;
  const switchTo = (m: LoginMethod) => {
    setErr("");
    setUnreg(false);
    lm.choose(m);
  };
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr("");
    setNotice("");
    setUnreg(false);
    setLimit(null);
    try {
      const before = await currentProfileMark();
      const r = byPhone ? (codeOnly ? await account.loginRelogin(smsCode.trim()) : await account.loginByPhone(phone.trim(), smsCode.trim())) : await account.login(email.trim(), pw);
      if (lm.methods.phone) saveLoginMethod(lm.method);
      setPw("");
      setSmsCode("");
      if (await afterLogin(r, before)) return;
      notifyAccountChanged();
      onDone();
    } catch (e) {
      setUnreg(byPhone && !codeOnly && phoneNotRegistered(e));
      setLimit(limitOf(e));
      setErr((e as Error).message || "登录没有完成，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  if (switching)
    return (
      <div className="login-box page auth-switching" role="status">
        <p className="auth-switching-title">{switching}</p>
        <p className="muted">各账号的事项、材料和成果分开保存，互不可见。</p>
      </div>
    );
  // 第 71 批（V45）：找回密码与开通页同一条流程（ResetPasswordForm），这里只是预填了这个账号的邮箱
  if (forgot)
    return (
      <ResetPasswordForm
        meta={meta}
        prefill={email}
        page={page}
        onBack={() => setForgot(false)}
        onDone={() => {
          setForgot(false);
          setPw("");
          setNotice("密码已重设，别的电脑上的登录都已退出。请用新密码登录。");
        }}
      />
    );
  // 第 69 批（V43，D-297）：电脑数已满——整卡选择，代替登录表单；“返回”回到表单
  if (limit)
    return (
      <DeviceLimitList
        devices={limit.devices}
        canUnbind={limit.canUnbind}
        canSignout={limit.canSignout}
        limit={limit.limit}
        limitKind={limit.limitKind}
        thisDevice={limit.thisDevice}
        who={limit.who}
        onBack={() => {
          setLimit(null);
          setErr("");
        }}
        onUnbind={async (id) => {
          const before = await currentProfileMark();
          const r = await account.unbindForLogin(id).catch((e) => {
            // 让出 / 移除之后又满了（别的电脑抢先登录）：云端已给新票据，列表换成最新的
            const again = limitOf(e);
            if (again) setLimit(again);
            throw e;
          });
          if (await afterLogin(r, before)) return;
          // 同一账号：已在本档案里登录（第 71 批）
          setLimit(null);
          setErr("");
          notifyAccountChanged();
          onDone();
        }}
        onSignout={async (id) => {
          const before = await currentProfileMark();
          const r = await account.signoutForLogin(id).catch((e) => {
            const again = limitOf(e);
            if (again) setLimit(again);
            throw e;
          });
          if (await afterLogin(r, before)) return;
          setLimit(null);
          setErr("");
          notifyAccountChanged();
          onDone();
        }}
      />
    );
  if (page && metaState.status !== "ready") return <MetaGate state={metaState}>{() => null}</MetaGate>;
  return (
    <form
      className={`login-box${compact ? " compact" : ""}${page ? " page" : ""}${subtle ? " subtle" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {lm.methods.phone ? <LoginMethodTabs value={lm.method} onChange={switchTo} /> : page && !subtle ? <div className="auth-method-single">账号密码登录</div> : null}
      {notice && (
        <p className="activate-notice" role="status">
          {notice}
        </p>
      )}
      {byPhone && codeOnly ? (
        <ReloginCodeFields knownPhone={knownPhone ?? null} code={smsCode} setCode={setSmsCode} codeLength={f.codeLength} resendSeconds={f.resendSeconds} setErr={setErr} onUnavailable={() => setCodeOnlyOff(true)} />
      ) : byPhone ? (
        <SmsCodeFields
          phone={phone}
          setPhone={(v) => {
            setPhone(v);
            if (unreg) {
              setUnreg(false);
              setErr("");
            }
          }}
          code={smsCode}
          setCode={setSmsCode}
          purpose="login"
          codeLength={f.codeLength}
          resendSeconds={f.resendSeconds}
          setErr={setErr}
          onSendError={(e) => setUnreg(phoneNotRegistered(e))}
        />
      ) : (
        <>
          {/* 第四轮（独立评审 R3-4）：重新登录同一个账号时上面已显示是谁，邮箱不再重复成一个输入框（保留为隐藏的用户名字段，密码管理器照常认） */}
          {subtle && initialEmail && email === initialEmail ? (
            <input type="text" className="sr-only" value={email} readOnly autoComplete="username" aria-hidden="true" tabIndex={-1} />
          ) : (
            <label className="field">
              <span>{meta?.password_by_phone ? "手机号或邮箱" : "邮箱"}</span>
              <input className="auth-input" type={meta?.password_by_phone ? "text" : "email"} value={email} onChange={(e) => (lm.lock(), setEmail(e.target.value))} autoComplete="username" spellCheck={false} placeholder={page ? (meta?.password_by_phone ? "手机号或邮箱" : "请输入邮箱") : undefined} />
            </label>
          )}
          <PasswordField label="密码" value={pw} onChange={(v) => (lm.lock(), setPw(v))} autoFocus={!!initialEmail} {...(page ? { placeholder: "请输入密码" } : {})} />
        </>
      )}
      {page && err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
      {page ? (
        <>
          <button type="submit" className="btn-primary activate-submit" disabled={!ready || busy}>
            {busy ? "正在登录…" : "登录"}
          </button>
          {!byPhone && (
            <div className="auth-links">
              <button type="button" className="btn-link auth-links-end" onClick={() => setForgot(true)}>
                忘记密码？
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="login-box-actions">
          <button type="submit" className="btn-primary btn-sm" disabled={!ready || busy}>
            {busy ? "正在登录…" : "登录"}
          </button>
          {!byPhone && (
            <button type="button" className="btn-link" onClick={() => setForgot(true)}>
              忘记密码？
            </button>
          )}
        </div>
      )}
      {!page && err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
      {unreg && (
        <div className="auth-unreg">
          {notRegisteredActions("relogin").map((a) => (
            <button key={a} type="button" className="btn-ghost btn-sm" onClick={() => switchTo("password")}>
              改用密码登录
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

/**
 * 第 71 批（V45）：这台已登记的电脑上重新登录——验证码发到账号绑定的手机号。手机号一栏只读（发出后显示云端回的打码号），律师只填验证码。
 * 发码失败：限频照常倒计时并说明；其余（没绑手机号、旧云端不支持）调 onUnavailable 退回可输入手机号的原流程，不把原因甩给律师。
 */
function ReloginCodeFields(p: { knownPhone: string | null; code: string; setCode: (v: string) => void; codeLength: number; resendSeconds: number; setErr: (v: string) => void; onUnavailable: () => void }) {
  const [wait, setWait] = useState(0);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  // 发码前就显示内核给的打码号；发出后以云端这次回的为准
  const masked = sent ?? (p.knownPhone ? maskPhoneTight(p.knownPhone) : null);
  const [hint, setHint] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const canSend = !sending && wait <= 0;
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    p.setErr("");
    setHint("");
    try {
      const r = await account.smsSendRelogin();
      if (r.phone) setSent(maskPhoneTight(r.phone));
      setWait(r.resend_after_s || p.resendSeconds);
      setHint(r.dry_run && r.debug_code ? `测试环境：验证码是 ${r.debug_code}（正式环境会发到手机）` : `验证码已发送，${Math.round((r.expires_in_s || 600) / 60)} 分钟内有效`);
      codeRef.current?.focus();
    } catch (e) {
      if (reloginSmsFailure(e) === "fallback") return p.onUnavailable();
      const d = (e as { detail?: { retry_after_s?: number } }).detail;
      if (d && Number.isSafeInteger(d.retry_after_s) && (d.retry_after_s as number) > 0) setWait(Math.min(600, d.retry_after_s as number));
      p.setErr((e as Error).message || "验证码发得太频繁，请稍后再试");
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      <div className="field auth-readonly-field">
        <span>手机号</span>
        <span className="auth-input-group is-readonly" aria-label={masked ? `验证码发到 ${masked}` : "验证码发到这个账号绑定的手机号"}>
          <span className="auth-prefix" aria-hidden="true">
            +86
          </span>
          <span className={`auth-readonly${masked ? "" : " is-pending"}`}>{masked ?? "这个账号绑定的手机号"}</span>
        </span>
      </div>
      <label className="field">
        <span>短信验证码</span>
        <span className="sms-row">
          <input
            ref={codeRef}
            className="auth-input"
            value={p.code}
            onChange={(e) => p.setCode(e.target.value.replace(/\D/g, "").slice(0, p.codeLength))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && p.code.length < p.codeLength) e.preventDefault();
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={p.codeLength}
            placeholder={`请输入 ${p.codeLength} 位验证码`}
            aria-label="短信验证码"
            spellCheck={false}
          />
          <button type="button" className="btn-ghost sms-send" disabled={!canSend} onClick={() => void send()}>
            {sending ? "正在发送…" : wait > 0 ? `${wait} 秒后重新获取` : sent ? "重新获取" : "获取验证码"}
          </button>
        </span>
        {hint && <span className="muted sms-hint">{hint}</span>}
      </label>
    </>
  );
}

/**
 * 找回密码（第 71 批 V45 合并为一条流程：开通页“忘记密码？”与重新登录页“忘记密码？”同一张表，两个入口只在预填不同）。
 * 一个“手机号或邮箱”框（云端没开手机号找回时只收邮箱）→ 验证码框内嵌“获取验证码”→ 新密码 →“重设密码”。
 * - 填手机号：短信验证码（account.smsSend(…, "reset")），用 resetConfirmByPhone 重设；
 * - 填邮箱：开通了邮件的发到邮箱，没开通的提示向律所管理员或客服要重置码（管理员给的重置码、设置码不用先点“获取验证码”，直接填）。
 */
export function ResetPasswordForm({ meta, prefill = "", page = true, onBack, onDone }: { meta: RegistrationMeta | null; prefill?: string; page?: boolean; onBack: () => void; onDone: () => void }) {
  const f = registrationFields(meta);
  const [id, setId] = useState(prefill);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [wait, setWait] = useState(0);
  const [hint, setHint] = useState("");
  const [err, setErr] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const kind = resetIdKind(id, f.phoneReset);
  const pwOk = checkPassword(pw, kind === "email" ? id.trim() : "").ok;
  const codeOk = kind === "phone" ? smsCodeLooksValid(code, f.codeLength) : code.trim().length >= 4;
  const ready = kind !== null && codeOk && pwOk;
  const send = async () => {
    if (!kind || sending || wait > 0) return;
    setSending(true);
    setErr("");
    setHint("");
    try {
      if (kind === "phone") {
        const r = await account.smsSend(id.trim(), "reset");
        setWait(r.resend_after_s || f.resendSeconds);
        setHint(r.dry_run && r.debug_code ? `测试环境：验证码是 ${r.debug_code}（正式环境会发到手机）` : `验证码已发送到 ${r.phone ? maskPhoneTight(r.phone) : "你的手机"}，${Math.round((r.expires_in_s || 600) / 60)} 分钟内有效`);
      } else {
        const r = await account.resetRequest(id.trim());
        setWait(60);
        setHint(r.channel === "admin" && f.phoneReset && !r.message ? "这个邮箱没有开通邮件验证码：可改填注册时验证过的手机号，或向律所管理员、客服要一个重置码填在下面。" : resetNextText(r));
      }
      codeRef.current?.focus();
    } catch (e) {
      const d = (e as { detail?: { retry_after_s?: number } }).detail;
      if (d && Number.isSafeInteger(d.retry_after_s) && (d.retry_after_s as number) > 0) setWait(Math.min(600, d.retry_after_s as number));
      setErr((e as Error).message || "没有发出，请稍后重试");
    } finally {
      setSending(false);
    }
  };
  const submit = async () => {
    if (!ready || busy || !kind) return;
    setBusy(true);
    setErr("");
    try {
      if (kind === "phone") await account.resetConfirmByPhone(id.trim(), code.trim(), pw);
      else await account.resetConfirm(id.trim(), code.trim(), pw);
      onDone();
    } catch (e) {
      setErr((e as Error).message || "没有重设成功，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  const idLabel = f.phoneReset ? "手机号或邮箱" : "邮箱";
  return (
    <form
      className={`auth-form quiet${page ? "" : " login-box"}`}
      data-auth-step="forgot"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="auth-title-row">
        <h1 className="auth-title">找回密码</h1>
        <button type="button" className="btn-link" onClick={onBack}>
          返回
        </button>
      </div>
      <label className="field">
        <span>{idLabel}</span>
        <input
          className="auth-input"
          type="text"
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setHint("");
          }}
          autoComplete="username"
          autoFocus={!prefill}
          spellCheck={false}
          inputMode={f.phoneReset ? "text" : "email"}
          placeholder={f.phoneReset ? "注册时的手机号或邮箱" : "注册时的邮箱"}
        />
        {id.trim() && kind === null && <span className="field-warn">{f.phoneReset ? "请填 11 位手机号或邮箱" : "邮箱格式不对"}</span>}
      </label>
      <label className="field">
        <span>{kind === "phone" ? "短信验证码" : "验证码或重置码"}</span>
        <span className="sms-row">
          <input
            ref={codeRef}
            className="auth-input"
            value={code}
            onChange={(e) => setCode(kind === "phone" ? e.target.value.replace(/\D/g, "").slice(0, f.codeLength) : e.target.value.replace(/\s+/g, ""))}
            autoComplete="one-time-code"
            autoFocus={!!prefill}
            spellCheck={false}
            placeholder={kind === "phone" ? `请输入 ${f.codeLength} 位验证码` : "验证码或重置码"}
          />
          <button type="button" className="btn-ghost sms-send" disabled={!kind || sending || wait > 0} onClick={() => void send()}>
            {sending ? "正在发送…" : wait > 0 ? `${wait} 秒后重新获取` : "获取验证码"}
          </button>
        </span>
        {hint && <span className="muted sms-hint">{hint}</span>}
      </label>
      <PasswordField label="新密码" value={pw} onChange={setPw} rules email={kind === "email" ? id.trim() : ""} placeholder="设置新密码" />
      {err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
      <button type="submit" className="btn-primary activate-submit" disabled={!ready || busy}>
        {busy ? "正在重设…" : "重设密码"}
      </button>
      <p className="auth-fine">重设后，所有电脑上的登录都会退出。</p>
    </form>
  );
}

/**
 * 第 70 批（V44）：电脑改名的一行编辑框（设置 · 账号 › 登录过的电脑）。回车保存、Esc 取消；空 = 去掉名字；
 * 口径与云端同一（最多 20 个字，不含换行等控制字符）。只上传这一串，不读主机名。
 */
function DeviceNameEditor({ initial, onSave, onCancel }: { initial: string; onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const chk = checkDeviceName(v);
  const save = async () => {
    if (!chk.ok || busy) return;
    if (chk.name === initial) return onCancel();
    setBusy(true);
    setErr("");
    try {
      await onSave(chk.name);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const count = [...v.replace(/\s+/g, " ").trim()].length;
  const bad = !chk.ok || !!err;
  return (
    <div className={`account-rename${bad ? " bad" : ""}`}>
      <div className="account-rename-row">
        <span className="account-rename-input">
          <input
            type="text"
            aria-label="电脑名字"
            aria-invalid={bad || undefined}
            value={v}
            maxLength={DEVICE_NAME_MAX + 8}
            placeholder="例如：办公室 iMac、家里的 ThinkPad"
            autoFocus
            onChange={(e) => {
              setV(e.target.value);
              setErr("");
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") void save();
              if (e.key === "Escape") onCancel();
            }}
          />
          <span className={`account-rename-count${count > DEVICE_NAME_MAX ? " over" : ""}`} aria-hidden="true">
            {count}/{DEVICE_NAME_MAX}
          </span>
        </span>
        <button type="button" className="btn-primary btn-sm" disabled={busy || !chk.ok} onClick={() => void save()}>
          {busy ? "正在保存…" : "保存"}
        </button>
        <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
      <div className={bad ? "account-rename-note is-bad" : "account-rename-note"} role={bad ? "alert" : undefined}>
        {!chk.ok ? chk.why : err || "留空即去掉名字。名字保存到云端，在你登录的各台电脑上显示；回车保存，Esc 取消。"}
      </div>
    </div>
  );
}

/**
 * 移除一台电脑（第 66 批 V40：原“解绑”）：须输入密码（自绘对话框，不用浏览器确认框）。= 让那台电脑的登录失效并停用它在云端的登记；
 * 那台电脑上已有的资料不删。个人账号要再用那台电脑，重新登录即可（不用别的电脑批准）；多人律所的成员仍要管理员批准。
 */
function UnbindDialog({ title, personal, onClose, onDone }: { title: string; personal: boolean; onClose: () => void; onDone: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <Modal title={`移除${title}？`} onClose={onClose}>
      <p className="confirm-dialog-q">
        {personal
          ? "移除后，那台电脑上的登录立即失效，不能再用你的账号使用 AI；它上面已有的资料不会被删除。以后要再用那台电脑，重新登录即可。"
          : "移除后，那台电脑上的登录立即失效，不能再用你的账号使用 AI，也收不到团队共享的事项；它上面已有的资料不会被删除。要再用，在那台电脑上重新登录即可。"}
      </p>
      <PasswordField label="请输入你的密码确认" value={pw} onChange={setPw} autoFocus />
      {err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn-ghost btn-sm" onClick={onClose}>
          取消
        </button>
        <button
          className="btn-danger-solid btn-sm"
          disabled={!pw || busy}
          onClick={() => {
            setBusy(true);
            setErr("");
            onDone(pw)
              .then(onClose)
              .catch((e) => setErr((e as Error).message || "没有移除成功"))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "正在移除…" : "确定移除"}
        </button>
      </div>
    </Modal>
  );
}

/** 绑定 / 更换手机号（第 63 批）：手机号 + 短信验证码；更换另要当前密码。 */
function BindPhoneDialog({ current, meta, onClose, onDone }: { current: string | null; meta: RegistrationMeta | null; onClose: () => void; onDone: (msg: string) => void }) {
  const form = phoneBindForm(current, meta?.phone_login === true);
  const f = registrationFields(meta);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ready = phoneLooksValid(phone) && smsCodeLooksValid(code, f.codeLength) && (!form.needPassword || pw.length > 0);
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr("");
    try {
      await account.bindPhone({ phone: phone.trim(), sms_code: code.trim(), ...(form.needPassword ? { password: pw } : {}) });
      onDone(form.done);
    } catch (e) {
      setErr((e as Error).message || (form.change ? "没有更换成功，请稍后重试" : "没有绑定成功，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={form.title} onClose={onClose}>
      <form
        className="auth-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="confirm-dialog-q">{form.lead}</p>
        <SmsCodeFields phone={phone} setPhone={setPhone} code={code} setCode={setCode} purpose="bind" codeLength={f.codeLength} resendSeconds={f.resendSeconds} setErr={setErr} phoneLabel={form.phoneField} autoFocus />
        {form.needPassword && <PasswordField label="当前密码" value={pw} onChange={setPw} />}
        {err && (
          <p className="activate-error" role="alert">
            {err}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn-primary btn-sm" disabled={!ready || busy}>
            {busy ? (form.change ? "正在更换…" : "正在绑定…") : form.change ? "确认更换" : "确认绑定"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 账号卡上的手机号一行：打码的号码或“未绑定”；云端允许时有“绑定手机号 / 更换手机号”。 */
function PhoneLine({ phone, onDone }: { phone: string | null; onDone: (msg: string) => void }) {
  const meta = useRegistrationMeta();
  const [open, setOpen] = useState(false);
  const bindable = !!meta && !meta.legacy && meta.phone_bind === true;
  return (
    <div className="muted account-phone">
      手机号：{phoneLabel(phone)}
      {bindable && (
        <button className="btn-link" onClick={() => setOpen(true)}>
          {phoneBindForm(phone).title}
        </button>
      )}
      {open && (
        <BindPhoneDialog
          current={phone}
          meta={meta}
          onClose={() => setOpen(false)}
          onDone={(m) => {
            setOpen(false);
            onDone(m);
          }}
        />
      )}
    </div>
  );
}

function ChangePassword({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  if (!open)
    return (
      <div>
        <button className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
          修改密码
        </button>
        {msg && <span className="muted"> {msg}</span>}
      </div>
    );
  const ok = cur.length > 0 && checkPassword(next, email).ok && next !== cur;
  return (
    <form
      className="login-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok || busy) return;
        setBusy(true);
        setErr("");
        account
          .changePassword(cur, next)
          .then((r) => {
            setMsg(r.other_sessions_revoked > 0 ? `密码已修改；别处的 ${r.other_sessions_revoked} 个登录已退出。` : "密码已修改。");
            setCur("");
            setNext("");
            setOpen(false);
          })
          .catch((e2) => setErr((e2 as Error).message || "没有修改成功"))
          .finally(() => setBusy(false));
      }}
    >
      <PasswordField label="现在的密码" value={cur} onChange={setCur} autoFocus />
      <PasswordField label="新密码" value={next} onChange={setNext} rules email={email} />
      {next && next === cur && <span className="field-warn">新密码不能和现在的一样</span>}
      <div className="login-box-actions">
        <button type="submit" className="btn-primary btn-sm" disabled={!ok || busy}>
          {busy ? "正在修改…" : "确认修改"}
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
      <p className="muted">修改后，别的电脑和网页上的登录都会退出，这台电脑保持登录。</p>
      {err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
    </form>
  );
}

/** 账号与团队页的“账号”一节。firm = 本机激活信息里的律所名。 */
export function AccountSection({ firm }: { firm: string | null }) {
  const [st, setSt] = useState<AccountStatus | null>(null);
  const [me, setMe] = useState<AccountMe | null>(null);
  const [meErr, setMeErr] = useState("");
  const [msg, setMsg] = useState("");
  const [unbind, setUnbind] = useState<{ id: string; title: string } | null>(null);
  // 第 71 批：设备操作的就地反馈与进行中
  const [note, setNote] = useState<{ id: string; text: string; undo?: string; tone?: "bad" } | null>(null);
  // 就地反馈几秒后淡出（可撤销的留久一点）
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote((n) => (n === note ? null : n)), note.undo !== undefined || note.tone === "bad" ? 9000 : 4000);
    return () => clearTimeout(t);
  }, [note]);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  // 第 70 批（V44）：正在改名的那台电脑
  const [renaming, setRenaming] = useState<string | null>(null);
  const load = () => {
    setMeErr("");
    account
      .status()
      .then((s) => {
        setSt(s);
        if (s.mode === "control_plane" && s.logged_in) account.me().then(setMe).catch((e) => (setMe(null), setMeErr((e as Error).message)));
        else setMe(null);
      })
      .catch((e) => setMeErr((e as Error).message));
  };
  useEffect(() => {
    load();
    // 别处（顶部横幅）登录或退出：上一条提示作废
    const onChanged = () => {
      setMsg("");
      load();
    };
    window.addEventListener(ACCOUNT_CHANGED, onChanged);
    return () => window.removeEventListener(ACCOUNT_CHANGED, onChanged);
  }, []);
  const act = async (f: () => Promise<unknown>, ok: string) => {
    setMsg("");
    try {
      await f();
      setMsg(ok);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  if (!st) return <SettingRow label="账号">{meErr ? <span className="activate-error">{meErr}</span> : <span className="muted">读取中…</span>}</SettingRow>;
  if (st.mode !== "control_plane") return <SettingRow label="账号"><span className="muted">{st.edition === "trial" ? "试用版：不需要登录账号。" : "开发形态：不使用账号登录。"}</span></SettingRow>;
  if (!st.logged_in) {
    return (
      <SettingRow label="账号" hint={st.login_required ? loginRequiredText(st.reason) : "这台电脑还没有登录账号。登录后才能使用 AI；本机的事项和文件照常可用。"}>
        <LoginBox email={st.account?.email ?? ""} onDone={load} />
      </SettingRow>
    );
  }
  const a = me?.account;
  const devices = me?.devices ?? [];
  const sessions = me?.sessions ?? [];
  const activeDevices = devices.filter((d) => !d.revoked_at);
  // 第 71 批（V45，D-298）：名额按“登录中”的电脑算；已退出登录的电脑资料还在、回去重新登录即可
  const signedIn = devices.filter((d) => deviceState(d) === "signed_in").length;
  const deviceLimit = typeof (me?.account as { device_limit?: unknown } | undefined)?.device_limit === "number" ? (me!.account as { device_limit: number }).device_limit : null;
  const renamable = canRenameDevices(devices);
  const canSignout = devices.some((d) => typeof d.state === "string");
  return (
    <>
      {msg && <div className="banner">{msg}</div>}
      <SettingRow label="账号">
        <div className="account-card">
          <span className="account-avatar" aria-hidden="true">
            {(a?.name ?? st.account?.name ?? "?").slice(0, 1)}
          </span>
          <div className="account-card-main">
            <div>
              <b>{a?.name ?? st.account?.name}</b>
              {/* 第 72 批：个人工作室里你就是唯一的成员，不写“管理员” */}
              {!me?.personal && <span className="pill pill-gray">{roleLabel(a?.role ?? st.account?.role)}</span>}
              <span className="pill pill-green">登录中</span>
            </div>
            <div className="muted">{a?.email ?? st.account?.email}</div>
            {/* 第 63 批：手机号（打码）或“未绑定”；账号详情取到了才显示 */}
            {me && (
              <PhoneLine
                phone={me.account.phone ?? null}
                onDone={(m) => {
                  setMsg(m);
                  load();
                }}
              />
            )}
            <div className="muted">
              {a?.org?.name ?? firm ?? "本所"}
              {me?.session ? ` · 本次登录 ${dayLabel(me.session.created_at)}起，不使用到 ${dayLabel(me.session.idle_expires_at)}会自动退出` : ""}
            </div>
          </div>
        </div>
        {meErr && <div className="muted">暂时取不到账号详情（{meErr}）。</div>}
      </SettingRow>
      {me && (
        <SettingRow
          label="登录过的电脑"
          hint={
            me.personal
              ? `同时登录 ${canSignout ? signedIn : activeDevices.length}${deviceLimit ? ` / ${deviceLimit}` : ""} 台。新电脑直接登录即可；满额时在登录页选一台让它退出。各台电脑上的事项与文件各自独立。`
              : `同时登录 ${canSignout ? signedIn : activeDevices.length}${deviceLimit ? ` / ${deviceLimit}` : ""} 台（上限由团队与云端设定）。新电脑直接登录即可（团队设了“须管理员确认”时要等管理员确认）；不再用的电脑请移除。`
          }
        >
          <ul className="account-list account-devices">
            {devices.map((d) => {
              const l = deviceLine(d);
              const editing = renaming === d.device_id;
              const mine = note?.id === d.device_id ? note : null;
              return (
                <li key={d.device_id} className={`${d.revoked_at ? "off" : ""}${editing ? " is-editing" : ""}`}>
                  <div className="account-list-main">
                    <div className="account-device-title">
                      <b>{l.title}</b>
                      {d.current && <span className="tag tag-this">这台电脑</span>}
                      <span className={`tag tag-${l.state.tone === "ok" ? "ok" : l.state.tone === "bad" ? "bad" : "gray"}`}>{l.state.text}</span>
                      {/* 第 71 批（V45）：操作结果就地显示在电脑名旁边，几秒后淡出，不推动布局；去掉名字可撤销 */}
                      {mine && (
                        <span className={`account-inline-note${mine.tone === "bad" ? " is-bad" : ""}`} role="status">
                          {mine.text}
                          {mine.undo !== undefined && (
                            <button
                              type="button"
                              className="btn-link"
                              onClick={() => {
                                const back = mine.undo!;
                                setNote(null);
                                void account
                                  .renameDevice(d.device_id, back)
                                  .then(() => (setNote({ id: d.device_id, text: `已恢复为“${back}”` }), load()))
                                  .catch((e) => setNote({ id: d.device_id, text: (e as Error).message || "没有恢复成功", tone: "bad" }));
                              }}
                            >
                              撤销
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                    {editing ? (
                      <DeviceNameEditor
                        initial={deviceName(d) ?? ""}
                        onCancel={() => setRenaming(null)}
                        onSave={async (name) => {
                          const prev = deviceName(d) ?? "";
                          await account.renameDevice(d.device_id, name);
                          setRenaming(null);
                          setNote(name ? { id: d.device_id, text: "✓ 已保存" } : { id: d.device_id, text: "已去掉名字", ...(prev ? { undo: prev } : {}) });
                          load();
                        }}
                      />
                    ) : (
                      <>
                        <div className="muted">{l.meta}</div>
                        {/* 第 70 批（V44）：这台电脑还没有名字时提示起一个——满额要选一台让它退出、或移除时，靠名字认出是哪一台 */}
                        {renamable && d.current && !d.revoked_at && !deviceName(d) && <div className="account-name-hint muted">起个名字（例如“办公室 iMac”），满额选择或移除时好认。只上传你填的名字。</div>}
                      </>
                    )}
                  </div>
                  {!editing && (
                    <div className="account-list-actions">
                      {renamable && !d.revoked_at && (
                        <button type="button" className="btn-ghost btn-sm" onClick={() => (setNote(null), setRenaming(d.device_id))}>
                          {deviceName(d) ? "改名" : "起名"}
                        </button>
                      )}
                      {/* 第 71 批（D-298）：别的电脑登录中时可让它退出登录（可逆，那台电脑上的资料保留） */}
                      {canSignout && !d.current && deviceState(d) === "signed_in" && (
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          disabled={signingOut === d.device_id}
                          onClick={() => {
                            setSigningOut(d.device_id);
                            void account
                              .signoutDevice(d.device_id)
                              .then(() => {
                                setNote({ id: d.device_id, text: "✓ 已让它退出登录，资料仍在那台电脑上" });
                                load();
                              })
                              .catch((e) => setNote({ id: d.device_id, text: (e as Error).message || "没有让它退出登录，请稍后重试", tone: "bad" }))
                              .finally(() => setSigningOut(null));
                          }}
                        >
                          {signingOut === d.device_id ? "正在退出…" : "让它退出登录"}
                        </button>
                      )}
                      {!d.revoked_at && !d.current && (
                        <button type="button" className="btn-ghost btn-danger btn-sm" onClick={() => setUnbind({ id: d.device_id, title: l.title })}>
                          移除
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </SettingRow>
      )}
      {/* 第 66 批（V40）：最近 5 次登录与新电脑登记（时刻、哪台电脑、平台、粗粒度网段）——不认识的马上移除那台电脑并改密码 */}
      {me && (me.recent_logins?.length ?? 0) > 0 && (
        <SettingRow label="最近登录" hint="最近几次登录与新电脑登记。位置只到网段（不精确到地址）；不认识的请移除对应电脑并修改密码。">
          <ul className="account-list">
            {recentLoginRows(me.recent_logins!, devices).map((l, i) => {
              return (
                <li key={`${l.meta}-${i}`}>
                  <div className="account-list-main">
                    <b>{l.title}</b>
                    <div className="muted">{l.meta}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </SettingRow>
      )}
      {me && (
        <SettingRow label="仍有效的登录" hint="这些电脑和网页现在仍处于登录状态。不认识的请马上下线，并修改密码。">
          <ul className="account-list">
            {sessions.map((s) => {
              const l = sessionLine(s, Date.now(), devices);
              return (
                <li key={s.sid}>
                  <div className="account-list-main">
                    <b>{l.title}</b>
                    <div className="muted">{l.meta}</div>
                  </div>
                  {!s.current && <ConfirmButton label="下线" question="让这处登录退出？" confirmLabel="下线" onConfirm={() => act(() => account.revokeSession(s.sid), "已让那处登录退出。")} />}
                </li>
              );
            })}
          </ul>
        </SettingRow>
      )}
      <SettingRow label="密码">
        <ChangePassword email={a?.email ?? st.account?.email ?? ""} />
      </SettingRow>
      <SettingRow label="退出登录" hint="退出后这台电脑的 AI 处理暂停，直到重新登录；本机的事项、文件和成果照常保留、照常可用。">
        <ConfirmButton
          label="退出登录"
          question="退出后这台电脑的 AI 处理会暂停，直到你重新登录；本机的事项、文件和成果照常保留、照常可用。"
          confirmLabel="退出登录"
          onConfirm={() =>
            act(async () => {
              await account.logout();
              notifyAccountChanged();
            }, "已退出登录。")
          }
        />
      </SettingRow>
      {unbind && (
        <UnbindDialog
          title={unbind.title}
          personal={me?.personal === true}
          onClose={() => setUnbind(null)}
          onDone={async (pw) => {
            await account.unbindDevice(unbind.id, pw);
            setNote({ id: unbind.id, text: "✓ 已移除，那台电脑上的登录已失效" });
            load();
          }}
        />
      )}
    </>
  );
}
