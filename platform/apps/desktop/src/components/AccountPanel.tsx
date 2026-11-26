/**
 * 设置 → 账号与团队 → 账号（第 44 批，主文 §2）：账号卡、我的电脑（解绑须输入密码）、登录记录（可让别处下线）、改密码、退出登录；
 * 以及登录失效时的就地登录框（App 顶部横幅与这里共用）。第 63 批：云端开了验证码登录时登录框可选“验证码登录 | 密码登录”；
 * 账号卡显示手机号（打码）或“未绑定”，可绑定 / 更换手机号（更换另要当前密码）。
 * 律师层用语：说“账号、这台电脑、登录”，不说“令牌、证书、席位、吊销”。
 */
import { useEffect, useState } from "react";
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
import { canRenameDevices, checkDeviceName, DEVICE_NAME_MAX, deviceName, maskPhone, passwordIdOk, switchingText, type AccountDevice } from "../lib/account.ts";

/** 账号状态变了（登录、退出）：App 顶部横幅据此立即刷新。 */
export const ACCOUNT_CHANGED = "kwl:account-changed";
export const notifyAccountChanged = () => window.dispatchEvent(new Event(ACCOUNT_CHANGED));

/**
 * 就地登录（会话失效、退出登录之后）：只登这台电脑已登记的那位成员的账号。第 63 批：云端开了验证码登录时可选两种方式，
 * 先显示上次用过的（没有记录先显示验证码登录）；手机号没有对应账号时只给“改用密码登录”（这里不能注册新账号）。
 */
export function LoginBox({ email: initialEmail = "", onDone, compact = false, page = false, subtle = false }: { email?: string; onDone: () => void; compact?: boolean; page?: boolean; subtle?: boolean }) {
  const [email, setEmail] = useState(initialEmail);
  const [pw, setPw] = useState("");
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [unreg, setUnreg] = useState(false);
  const [forgot, setForgot] = useState(false);
  // 第 68 批（V42，D-294/295）：登录的是另一个账号 → 切到那个账号的工作空间（过渡说明）；那个账号电脑数已满 → 列出它的电脑，可就地移除一台
  const [switching, setSwitching] = useState<string | null>(null);
  const [limit, setLimit] = useState<{ devices: AccountDevice[]; canUnbind: boolean; limit: number | null } | null>(null);
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
    const d = (e as { detail?: { reason?: unknown; devices?: unknown; can_unbind?: unknown; device_limit?: unknown } })?.detail;
    return d && d.reason === "device_limit" && Array.isArray(d.devices) && d.devices.length > 0 ? { devices: d.devices as AccountDevice[], canUnbind: d.can_unbind === true, limit: typeof d.device_limit === "number" ? d.device_limit : null } : null;
  };
  // 第 64 批：登录方式三态（取策略中 / 取不到 / 取到）——整页重新登录时取到才显示表单；设置页里的小登录框取不到时按密码登录显示
  const metaState = useRegistrationMetaState();
  const meta = metaState.status === "ready" ? metaState.meta : null;
  const lm = useLoginMethod(meta, subtle && initialEmail ? "password" : undefined);
  const f = registrationFields(meta);
  const byPhone = lm.method === "phone";
  const ready = byPhone ? phoneLooksValid(phone) && smsCodeLooksValid(smsCode, f.codeLength) : passwordIdOk(email, meta) && pw.length > 0;
  const switchTo = (m: LoginMethod) => {
    setErr("");
    setUnreg(false);
    lm.choose(m);
  };
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr("");
    setUnreg(false);
    setLimit(null);
    try {
      const before = await currentProfileMark();
      const r = byPhone ? await account.loginByPhone(phone.trim(), smsCode.trim()) : await account.login(email.trim(), pw);
      if (lm.methods.phone) saveLoginMethod(lm.method);
      setPw("");
      setSmsCode("");
      if (await afterLogin(r, before)) return;
      notifyAccountChanged();
      onDone();
    } catch (e) {
      setUnreg(byPhone && phoneNotRegistered(e));
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
  if (forgot) return <ResetBox email={email} onBack={() => setForgot(false)} page={page} />;
  // 第 69 批（V43，D-297）：电脑数已满——整卡“选一台移除”（默认预选最久没用的一台），代替登录表单；“返回登录”回到表单
  if (limit)
    return (
      <DeviceLimitList
        devices={limit.devices}
        canUnbind={limit.canUnbind}
        limit={limit.limit}
        who={byPhone ? maskPhone(phone) : email.includes("@") ? email : maskPhone(email)}
        onBack={() => {
          setLimit(null);
          setErr("");
        }}
        onUnbind={async (id) => {
          const before = await currentProfileMark();
          const r = await account.unbindForLogin(id);
          if (!(await afterLogin(r, before))) {
            setLimit(null);
            setErr("");
          }
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
      {byPhone ? (
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
              <span>邮箱</span>
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

/** 找回密码（已激活的电脑上）：发验证码或用管理员给的重置码 → 新密码。 */
function ResetBox({ email: initialEmail, onBack, page = false }: { email: string; onBack: () => void; page?: boolean }) {
  const [email, setEmail] = useState(initialEmail);
  const [hint, setHint] = useState("");
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message || "没有完成，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  if (done)
    return (
      <div className={`login-box${page ? " page" : ""}`}>
        <p className="muted">密码已重设，别的电脑上的登录都已退出。请用新密码登录。</p>
        <button className="btn-primary btn-sm" onClick={onBack}>
          去登录
        </button>
      </div>
    );
  return (
    <div className={`login-box${page ? " page" : ""}`}>
      {page && <div className="auth-method-single">找回密码</div>}
      <label className="field">
        <span>邮箱</span>
        <input className="auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" spellCheck={false} placeholder={page ? "注册时的邮箱" : undefined} />
      </label>
      {hint ? (
        <>
          <p className="muted">{hint}</p>
          <label className="field">
            <span>验证码、重置码或设置码</span>
            <input className="auth-input" value={code} onChange={(e) => setCode(e.target.value.replace(/\s+/g, ""))} autoComplete="one-time-code" spellCheck={false} />
          </label>
          <PasswordField label="新密码" value={pw} onChange={setPw} rules email={email} />
        </>
      ) : (
        <p className="muted">开通了邮件的会把验证码发到邮箱；没有邮件的，请向律所管理员或客服要一个重置码。</p>
      )}
      <div className="login-box-actions">
        {hint ? (
          <button className="btn-primary btn-sm" disabled={busy || !code || !checkPassword(pw, email).ok} onClick={() => void run(async () => (await account.resetConfirm(email.trim(), code, pw), setDone(true)))}>
            {busy ? "正在重设…" : "重设密码"}
          </button>
        ) : (
          <button className="btn-primary btn-sm" disabled={busy || !emailLooksValid(email)} onClick={() => void run(async () => setHint(resetNextText(await account.resetRequest(email.trim()))))}>
            {busy ? "正在发送…" : "下一步"}
          </button>
        )}
        <button className="btn-ghost btn-sm" onClick={onBack}>
          返回登录
        </button>
      </div>
      {err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/**
 * 第 70 批（V44）：电脑改名的一行编辑框（设置 · 账号 › 登录过的电脑）。回车保存、Esc 取消；空 = 去掉名字；
 * 口径与云端同一（最多 20 个字，不含换行等控制字符）。只上传这一串，不读主机名。
 */
function DeviceNameEditor({ initial, current, onSave, onCancel }: { initial: string; current: boolean; onSave: (name: string) => Promise<void>; onCancel: () => void }) {
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
  return (
    <div className="account-rename">
      <label className="account-rename-row">
        <span className="account-rename-label">{current ? "这台电脑的名字" : "电脑名字"}</span>
        <input
          type="text"
          aria-label="电脑名字"
          value={v}
          maxLength={DEVICE_NAME_MAX + 8}
          placeholder="例如：办公室 iMac、家里的 ThinkPad"
          autoFocus
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onCancel();
          }}
        />
        <button type="button" className="btn-primary btn-sm" disabled={busy || !chk.ok} onClick={() => void save()}>
          {busy ? "正在保存…" : "保存"}
        </button>
        <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </label>
      <div className={!chk.ok || err ? "account-rename-note activate-error" : "account-rename-note muted"}>{!chk.ok ? chk.why : err || `最多 ${DEVICE_NAME_MAX} 个字；留空即去掉名字。名字会保存到云端，在你登录的各台电脑上显示。`}</div>
    </div>
  );
}

/** 第 66 批（V40）：“最近登录”一行——哪台电脑、登录还是新电脑登记、平台、时刻与粗粒度网段。 */
function recentLoginLine(x: NonNullable<AccountMe["recent_logins"]>[number], devices: AccountMe["devices"]): { title: string; meta: string } {
  const d = x.device_id ? devices.find((y) => y.device_id === x.device_id) : undefined;
  const who = d ? deviceLine(d).title : x.device_id ? "一台新电脑" : x.platform === "web" ? "网页" : "还没登记的电脑";
  const platform = x.platform === "win32" ? "Windows" : x.platform === "darwin" ? "macOS" : x.platform === "web" ? "浏览器" : x.platform === "linux" ? "Linux" : "";
  const at = Number.isFinite(Date.parse(x.at)) ? new Date(Date.parse(x.at)).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  return { title: `${who}${x.kind === "enroll" ? " · 新电脑登记" : " · 登录"}`, meta: [at, platform, x.net && x.net !== "未知" ? `网段 ${x.net}` : ""].filter(Boolean).join(" · ") };
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
          : "移除后，那台电脑上的登录立即失效，不能再用你的账号使用 AI，也收不到本所的共享；它上面已有的资料不会被删除。要再用，需重新登录并由管理员批准。"}
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
  const renamable = canRenameDevices(devices);
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
              <span className="pill pill-gray">{roleLabel(a?.role ?? st.account?.role)}</span>
              <span className="pill pill-green">已登录</span>
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
              ? `用这个账号登录过的电脑（在用 ${activeDevices.length}${typeof (me.account as { device_limit?: unknown })?.device_limit === "number" ? ` / ${(me.account as { device_limit: number }).device_limit}` : ""} 台，上限由云端设定）。换电脑直接登录即可，不需要别的电脑批准；各台电脑上的事项与文件各自独立、不互相同步。不认识的电脑请马上移除并修改密码。`
              : `用这个账号登录过的电脑（在用 ${activeDevices.length} 台）。不再用的电脑请移除；新电脑登录需律所管理员批准。`
          }
        >
          <ul className="account-list">
            {devices.map((d) => {
              const l = deviceLine(d);
              if (renaming === d.device_id)
                return (
                  <li key={d.device_id}>
                    <DeviceNameEditor
                      initial={deviceName(d) ?? ""}
                      current={!!d.current}
                      onCancel={() => setRenaming(null)}
                      onSave={async (name) => {
                        await account.renameDevice(d.device_id, name);
                        setRenaming(null);
                        setMsg(name ? `已改名为“${name}”。` : "已去掉这台电脑的名字。");
                        load();
                      }}
                    />
                  </li>
                );
              return (
                <li key={d.device_id} className={d.revoked_at ? "off" : ""}>
                  <div className="account-list-main">
                    <b>{l.title}</b> <span className={`tag tag-${l.state.tone === "ok" ? "ok" : l.state.tone === "bad" ? "bad" : "gray"}`}>{l.state.text}</span>
                    <div className="muted">{l.meta}</div>
                    {/* 第 70 批（V44）：这台电脑还没有名字时提示起一个——换电脑、电脑数已满要移除一台时，靠名字认出是哪一台 */}
                    {renamable && d.current && !d.revoked_at && !deviceName(d) && <div className="account-name-hint muted">给这台电脑起个名字（例如“办公室 iMac”），换电脑或移除时好认。只上传你填的名字。</div>}
                  </div>
                  {renamable && !d.revoked_at && (
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setRenaming(d.device_id)}>
                      {deviceName(d) ? "改名" : "起名"}
                    </button>
                  )}
                  {!d.revoked_at &&
                    (d.current ? (
                      <span className="muted">{me.personal ? "要停用这台，退出登录即可" : "要停用这台，请退出登录或请管理员处理"}</span>
                    ) : (
                      <button className="btn-ghost btn-danger btn-sm" onClick={() => setUnbind({ id: d.device_id, title: l.title })}>
                        移除这台电脑
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>
        </SettingRow>
      )}
      {/* 第 66 批（V40）：最近 5 次登录与新电脑登记（时刻、哪台电脑、平台、粗粒度网段）——不认识的马上移除那台电脑并改密码 */}
      {me && (me.recent_logins?.length ?? 0) > 0 && (
        <SettingRow label="最近登录" hint="最近 5 次。位置只到网段（不精确到地址）；不认识的登录请移除对应电脑并修改密码。">
          <ul className="account-list">
            {me.recent_logins!.map((x, i) => {
              const l = recentLoginLine(x, devices);
              return (
                <li key={`${x.at}-${i}`}>
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
        <SettingRow label="登录记录" hint="仍有效的登录。不认识的登录请马上下线，并修改密码。">
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
            setMsg(`已移除${unbind.title}：那台电脑上的登录已失效。`);
            load();
          }}
        />
      )}
    </>
  );
}
