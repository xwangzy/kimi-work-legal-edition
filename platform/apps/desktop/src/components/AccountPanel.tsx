/**
 * 设置 → 账号与团队 → 账号（第 44 批，主文 §2）：账号卡、我的电脑（解绑须输入密码）、登录记录（可让别处下线）、改密码、退出登录；
 * 以及登录失效时的就地登录框（App 顶部横幅与这里共用）。
 * 律师层用语：说“账号、这台电脑、登录”，不说“令牌、证书、席位、吊销”。
 */
import { useEffect, useState } from "react";
import { account, type AccountMe, type AccountStatus } from "../api.ts";
import { checkPassword, dayLabel, deviceLine, emailLooksValid, loginRequiredText, resetNextText, roleLabel, sessionLine } from "../lib/account.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { Modal } from "./Modal.tsx";
import { PasswordField } from "./PasswordField.tsx";
import { SettingRow } from "./SettingRow.tsx";

/** 账号状态变了（登录、退出）：App 顶部横幅据此立即刷新。 */
export const ACCOUNT_CHANGED = "kwl:account-changed";
export const notifyAccountChanged = () => window.dispatchEvent(new Event(ACCOUNT_CHANGED));

/** 就地登录（会话失效、退出登录之后）：只登这台电脑已登记的那位成员的账号。 */
export function LoginBox({ email: initialEmail = "", onDone, compact = false }: { email?: string; onDone: () => void; compact?: boolean }) {
  const [email, setEmail] = useState(initialEmail);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [forgot, setForgot] = useState(false);
  const ready = emailLooksValid(email) && pw.length > 0;
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr("");
    try {
      await account.login(email.trim(), pw);
      setPw("");
      notifyAccountChanged();
      onDone();
    } catch (e) {
      setErr((e as Error).message || "登录没有完成，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  if (forgot) return <ResetBox email={email} onBack={() => setForgot(false)} />;
  return (
    <form
      className={`login-box${compact ? " compact" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        <span>邮箱</span>
        <input className="auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" spellCheck={false} />
      </label>
      <PasswordField label="密码" value={pw} onChange={setPw} autoFocus={!!initialEmail} />
      <div className="login-box-actions">
        <button type="submit" className="btn-primary btn-sm" disabled={!ready || busy}>
          {busy ? "正在登录…" : "登录"}
        </button>
        <button type="button" className="btn-link" onClick={() => setForgot(true)}>
          忘记密码？
        </button>
      </div>
      {err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
    </form>
  );
}

/** 找回密码（已激活的电脑上）：发验证码或用管理员给的重置码 → 新密码。 */
function ResetBox({ email: initialEmail, onBack }: { email: string; onBack: () => void }) {
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
      <div className="login-box">
        <p className="muted">密码已重设，别的电脑上的登录都已退出。请用新密码登录。</p>
        <button className="btn-primary btn-sm" onClick={onBack}>
          去登录
        </button>
      </div>
    );
  return (
    <div className="login-box">
      <label className="field">
        <span>邮箱</span>
        <input className="auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" spellCheck={false} />
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

/** 解绑一台电脑：须输入密码（自绘对话框，不用浏览器确认框）。 */
function UnbindDialog({ title, onClose, onDone }: { title: string; onClose: () => void; onDone: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <Modal title={`解绑${title}？`} onClose={onClose}>
      <p className="confirm-dialog-q">解绑后，那台电脑不能再用你的账号使用 AI，也收不到本所的共享；它上面已有的资料不会被删除。要再用，需重新登录并由管理员批准。</p>
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
              .catch((e) => setErr((e as Error).message || "没有解绑成功"))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "正在解绑…" : "确定解绑"}
        </button>
      </div>
    </Modal>
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
            <div className="muted">
              {a?.org?.name ?? firm ?? "本所"}
              {me?.session ? ` · 本次登录 ${dayLabel(me.session.created_at)}起，不使用到 ${dayLabel(me.session.idle_expires_at)}会自动退出` : ""}
            </div>
          </div>
        </div>
        {meErr && <div className="muted">暂时取不到账号详情（{meErr}）。</div>}
      </SettingRow>
      {me && (
        <SettingRow label="我的电脑" hint={`已登记 ${activeDevices.length} 台，最多 ${a?.device_limit ?? "—"} 台。不再用的电脑请解绑。`}>
          <ul className="account-list">
            {devices.map((d) => {
              const l = deviceLine(d);
              return (
                <li key={d.device_id} className={d.revoked_at ? "off" : ""}>
                  <div className="account-list-main">
                    <b>{l.title}</b> <span className={`tag tag-${l.state.tone === "ok" ? "ok" : l.state.tone === "bad" ? "bad" : "gray"}`}>{l.state.text}</span>
                    <div className="muted">{l.meta}</div>
                  </div>
                  {!d.revoked_at &&
                    (d.current ? (
                      <span className="muted">要停用这台，请退出登录或请管理员处理</span>
                    ) : (
                      <button className="btn-ghost btn-danger btn-sm" onClick={() => setUnbind({ id: d.device_id, title: l.title })}>
                        解绑
                      </button>
                    ))}
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
              const l = sessionLine(s);
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
          onClose={() => setUnbind(null)}
          onDone={async (pw) => {
            await account.unbindDevice(unbind.id, pw);
            setMsg(`已解绑${unbind.title}。`);
            load();
          }}
        />
      )}
    </>
  );
}
