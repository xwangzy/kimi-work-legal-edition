/**
 * 首次启动（第 13 批开通与成员入组；第 44 批改为登录 / 注册，主文 §2）。
 * 这台电脑还没有激活时，整个应用只显示这一页：缺省“登录”，可切“注册”“忘记密码”；
 * 原来的“输入开通码或邀请码”“从备份恢复”保留为次要入口。
 * 登录或注册后按中软的答复走：创始开通 → 等后台按新身份重启；成员入组（凭邀请码，或多人律所同一账号的新电脑）→ 等批准并核对 12 位核对码；
 * 第 66 批（V40，D-292）：个人账号的新电脑由云端直接登记——登录后自动完成，不等别的电脑批准；短时间内多台新电脑登录时暂停，用短信验证码确认是本人；
 * 不能继续（设备已满、这台电脑属于别的成员、律所还没开通）→ 写明原因与已登记的电脑。
 * 律师层不出现“证书、密钥、签名、令牌”等词；登录只把邮箱和密码（第 63 批起也可以是手机号和短信验证码）发给中软核对，不上传任何案件材料。
 */
import { useEffect, useRef, useState } from "react";
import { account, api, onboarding, recovery } from "../api.ts";
import { AuthCard, AuthPage, MetaGate } from "../components/AuthShell.tsx";
import { PasswordField } from "../components/PasswordField.tsx";
import { LoginMethodTabs, SmsCodeFields, useLoginMethod, useRegistrationMetaState } from "../components/SmsCodeFields.tsx";
import { setAsideAutoOpen, setAsideNotice } from "../lib/activate-text.ts";
import { checkPassword, codeLengthOk, dayLabel, deviceLine, emailLooksValid, nameLooksValid, notRegisteredActions, phoneLooksValid, phoneNotRegistered, registerCodeLengthOk, registrationFields, resetNextText, roleLabel, saveLoginMethod, smsCodeLooksValid, waitApprovalLead, type AccountDevice, type LoginMethod, type RegistrationMeta } from "../lib/account.ts";
import { fmtTime } from "../lib/labels.ts";

/** 律师在恢复页点过“返回”的那个目录（每个查看者本机记一下；读写失败按没点过）。 */
const DISMISS_KEY = "kwl.setAside.dismissed";
const readDismissed = (): string | null => {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
};

type Status = {
  mode: "unactivated" | "member_pending";
  firm?: { name: string };
  member?: { name: string | null; role: string };
  check_code?: string;
  requested_at?: string;
  restarting?: boolean;
  legacy_workspaces?: string[];
  last_failure?: { code: string; at: string };
  /** 主密钥解封失败后移到一边的目录名（新的在前；v9.3 主文 §9 第 7 项）。 */
  set_aside?: string[];
  /** 第 44 批：同一账号的新电脑（没有邀请可对，由已登录的另一台电脑或律所管理员人工核对）。 */
  via_account?: boolean;
};

const JOIN_FAILED_TEXT = "入组没有完成：管理员批准的结果在这台电脑上核对不通过。请向管理员重新要一个邀请码，再输入一次；若反复出现，请联系所内 IT。";
const RESTORE_FAILED_TEXT = "从备份恢复没有完成（这台电脑没能保存恢复出来的密钥，或恢复中途被打断）。恢复出来的内容已清掉，备份本身没有变：请再恢复一次；若仍不行，请联系所内 IT。";
/** 内核回到待激活时报的原因代码 → 律师看得懂的一句话。 */
const failureText = (code: string | undefined) => (code === "restore_incomplete" ? RESTORE_FAILED_TEXT : JOIN_FAILED_TEXT);

/** 输入时按 4 位一组显示（只留字母与数字，大写）。 */
function groupCode(raw: string): string {
  // 开通码 20 位；邀请码 36 位（控制面码 + 管理员本机生成的核对段，复核 A-01）
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 36);
  return s.replace(/(.{4})(?=.)/g, "$1-");
}

/**
 * 激活完成后内核按新身份重启：等它就绪再刷新页面。复核 B13-K02：入组在本机没有生效（内核回到待激活并报 last_failure）
 * 或 2 分钟还没打开，都告诉律师怎么办（onStuck），不再一直显示“正在打开…”。
 */
async function waitForActivated(onStuck: (text: string) => void, landing = "#/"): Promise<void> {
  // 按经过的时间判断（复核 R2B-25：内核不在时每次查询可能要等很久，按轮数会拖到几十分钟）
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const st = await api.kernelStatus();
      if (st && !st.onboarding) {
        window.location.hash = landing;
        window.location.reload();
        return;
      }
      if (st?.onboarding?.last_failure && !st.onboarding.restarting) {
        onStuck(failureText(st.onboarding.last_failure.code));
        return;
      }
    } catch {
      // 重启期间内核暂不可用：继续等
    }
  }
  onStuck("还没有打开成功。请关闭并重新打开应用；若仍如此，请联系所内 IT。");
}

export function ActivatePage({ initial, onRefresh, notice = "" }: { initial: Status; onRefresh: () => void; notice?: string }) {
  const [status, setStatus] = useState<Status>(initial);
  // 主进程报“后台服务已停止”（拉起失败、多次异常退出）：激活页直接说明，不再让律师空等（复核 R2B-25）
  if (notice) {
    return (
      <Frame>
        <p className="activate-error" role="alert">
          {notice}
        </p>
        <button className="btn-primary" onClick={() => window.location.reload()}>
          重试
        </button>
      </Frame>
    );
  }
  if (status.mode === "member_pending") return <WaitApproval status={status} onReset={async () => setStatus((await onboarding.reset()) as Status)} onRefresh={onRefresh} />;
  return (
    <Entry
      onPending={(s) => setStatus(s)}
      legacy={status.legacy_workspaces ?? []}
      failed={status.last_failure ? failureText(status.last_failure.code) : ""}
      setAside={status.set_aside?.[0] ?? null}
    />
  );
}

/** 第 64 批：开通页的每一步都用同一个登录类外壳（AuthShell：整窗页面 + 品牌条卡片 + 页脚说明）。 */
function Frame({ children, foot, wide = false }: { children: React.ReactNode; foot?: React.ReactNode; wide?: boolean }) {
  return (
    <AuthPage kind="activate">
      <AuthCard foot={foot} wide={wide}>
        {children}
      </AuthCard>
    </AuthPage>
  );
}

/** 页脚：登录与开通发给云端的只有这些（第 63 批原文，不改）。 */
const FOOT_TEXT = "登录与开通只把邮箱或手机号、密码或短信验证码、开通码或邀请码发给 Kimi Work 服务核对；你的案卷不会上传。";

type View = "login" | "register" | "forgot" | "code" | "restore";
type Blocked = { message: string; devices: AccountDevice[] };
/** 第 66 批：个人账号新电脑自动登记被风控暂停（要短信验证码确认是本人；没绑手机号或短信不可用时只说明原因）。 */
type SmsHold = { message: string; sms_available: boolean; phone_masked: string | null };

/** 登录 / 注册之后按中软的答复走下一步（创始开通、入组等待、不能继续）。 */
function authOutcome(onPending: (s: Status) => void, setDone: (t: string) => void, setBlocked: (b: Blocked) => void, stuck: (t: string) => void, setHold?: (h: SmsHold) => void) {
  return (r: any) => {
    if (r?.next === "restart") {
      // 第 66 批：个人账号的新电脑已由云端直接登记（auto）——不是“开通”，这台电脑的事项与文件与别的电脑各自独立
      setDone(r.auto ? "这台电脑已登记为你的电脑，正在打开…" : `已为「${r.firm?.name ?? "本所"}」开通，正在打开…`);
      // 开通向导：激活后先到“开通的最后一步”（恢复包、试一下、备份位置），再进首页
      void waitForActivated(stuck, "#/welcome");
    } else if (r?.next === "wait") {
      onPending({ mode: "member_pending", firm: r.firm, member: r.member ?? { name: r.account?.name ?? null, role: r.account?.role ?? "" }, check_code: r.check_code, requested_at: new Date().toISOString(), ...(r.via_account ? { via_account: true } : {}) });
    } else if (r?.next === "sms_confirm" && setHold) {
      setHold({ message: String(r.message ?? "为安全起见已暂停自动登记这台电脑：请用账号绑定的手机号接收验证码确认是本人"), sms_available: r.sms_available === true, phone_masked: typeof r.phone_masked === "string" ? r.phone_masked : null });
    } else if (r?.next === "blocked") {
      setBlocked({ message: String(r.message ?? "这台电脑暂时不能用这个账号继续，请联系客服"), devices: Array.isArray(r.devices) ? r.devices : [] });
    } else {
      stuck("没有完成，请稍后重试；仍不行请联系客服");
    }
  };
}

function Entry({ onPending, legacy, failed, setAside }: { onPending: (s: Status) => void; legacy: string[]; failed: string; setAside: string | null }) {
  // 刚把打不开的数据移到一边（主进程对话框里选了“用恢复包恢复”）：直接打开从备份恢复
  const [view, setView] = useState<View>(setAside !== null && !failed && setAsideAutoOpen(setAside, Date.now(), readDismissed()) ? "restore" : "login");
  const [email, setEmail] = useState("");
  // 第 63 批：手机号在登录与注册之间共用（验证码登录发现没注册 → “用这个手机号注册”直接带过去）
  const [phone, setPhone] = useState("");
  // 注册 / 登录策略整页只取一次，登录、注册、找回密码共用。第 64 批：三态——取策略中显示骨架、取不到显示原因与“重试”，
  // 取到才渲染表单（不再先按旧流程只显示邮箱登录、取到后再变出验证码登录）
  const metaState = useRegistrationMetaState();
  const [err, setErr] = useState(failed);
  const [note, setNote] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [hold, setHold] = useState<SmsHold | null>(null);
  const stuck = (t: string) => {
    setDone(null);
    if (view === "restore") setView("login");
    setErr(t);
  };
  const outcome = authOutcome(onPending, setDone, setBlocked, stuck, setHold);
  const go = (v: View) => {
    setErr("");
    setNote("");
    setView(v);
  };
  if (done) {
    return (
      <Frame>
        <h1 className="activate-title">{done}</h1>
        <p className="muted">第一次打开需要十几秒。</p>
      </Frame>
    );
  }
  if (blocked) return <BlockedView b={blocked} onBack={() => setBlocked(null)} />;
  if (hold) return <AutoEnrollConfirm hold={hold} onBack={() => setHold(null)} onResult={outcome} />;
  if (view === "restore")
    return (
      <RestoreFromBackup
        onBack={() => {
          // 点过“返回”就不再自动带回恢复页（复核 RB16B-20）
          if (setAside) {
            try {
              localStorage.setItem(DISMISS_KEY, setAside);
            } catch {
              // 存不下：下次仍会自动打开，不影响使用
            }
          }
          go("login");
        }}
        onDone={setDone}
        onStuck={stuck}
        notice={setAside ? setAsideNotice(setAside) : ""}
      />
    );
  // 其他方式（Kimi 登录框“企业 SSO 登录”的位置）：凭码激活、从备份恢复
  const alt = (
    <div className="auth-alt">
      {view !== "code" && (
        <button type="button" className="btn-link" onClick={() => go("code")}>
          有开通码或邀请码
        </button>
      )}
      <button type="button" className="btn-link" onClick={() => go("restore")}>
        换了新电脑？从备份恢复
      </button>
    </div>
  );
  const foot = (
    <>
      {FOOT_TEXT}
      {legacy.length > 0 && (
        <span className="auth-foot-note" role="note">
          这台电脑上还有以前留下的数据（{legacy.join("、")}，例如旧版本试用或没有完成的入组）。激活后不会自动转入，也不会删除；如需保留或清理，请联系所内 IT。
        </span>
      )}
    </>
  );
  return (
    <Frame foot={foot}>
      {note && (
        <p className="activate-notice" role="status">
          {note}
        </p>
      )}
      {view === "login" && (
        <MetaGate state={metaState}>
          {(meta) => (
            <LoginForm
              meta={meta}
              email={email}
              setEmail={setEmail}
              phone={phone}
              setPhone={setPhone}
              err={err}
              setErr={setErr}
              onResult={outcome}
              onForgot={() => go("forgot")}
              onRegister={() => go("register")}
              onRegisterWithPhone={() => {
                go("register");
                setNote(`已带上手机号 ${phone.trim()}。请补全邮箱、密码和姓名，再获取验证码完成注册；之后就可以用这个手机号登录。`);
              }}
            />
          )}
        </MetaGate>
      )}
      {view === "register" && (
        <MetaGate state={metaState}>{(meta) => <RegisterForm meta={meta} email={email} setEmail={setEmail} phone={phone} setPhone={setPhone} err={err} setErr={setErr} onResult={outcome} onLogin={() => go("login")} />}</MetaGate>
      )}
      {view === "forgot" && (
        <MetaGate state={metaState}>
          {(meta) => (
            <ForgotPassword
              meta={meta}
              email={email}
              setEmail={setEmail}
              onBack={() => go("login")}
              onDone={() => {
                go("login");
                setNote("密码已重设。请用新密码登录（别的电脑上的登录都已退出）。");
              }}
            />
          )}
        </MetaGate>
      )}
      {view === "code" && <EnterCode onPending={onPending} onFounder={(t) => {
            setDone(t);
            void waitForActivated(stuck, "#/welcome");
          }} failed={err} onBack={() => go("login")} />}
      {view !== "forgot" && alt}
    </Frame>
  );
}

/**
 * 登录（第 44 批邮箱 + 密码；第 63 批云端开了验证码登录时另有“验证码登录”，先显示上次用过的方式，没有记录先显示验证码登录）。
 * 两种方式的结果一样，都交给 onResult（创始开通、入组等待、不能继续）。
 */
function LoginForm(p: {
  meta: RegistrationMeta | null;
  email: string;
  setEmail: (v: string) => void;
  phone: string;
  setPhone: (v: string) => void;
  err: string;
  setErr: (v: string) => void;
  onResult: (r: any) => void;
  onForgot: () => void;
  onRegister: () => void;
  onRegisterWithPhone: () => void;
}) {
  const [pw, setPw] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [busy, setBusy] = useState(false);
  // 验证码登录时手机号没有对应的账号：在表单里给“用这个手机号注册 / 改用密码登录”
  const [unreg, setUnreg] = useState(false);
  const lm = useLoginMethod(p.meta);
  const f = registrationFields(p.meta);
  const byPhone = lm.method === "phone";
  const ready = byPhone ? phoneLooksValid(p.phone) && smsCodeLooksValid(smsCode, f.codeLength) : emailLooksValid(p.email) && pw.length > 0;
  const switchTo = (m: LoginMethod) => {
    p.setErr("");
    setUnreg(false);
    lm.choose(m);
  };
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    p.setErr("");
    setUnreg(false);
    try {
      const r = byPhone ? await account.loginByPhone(p.phone.trim(), smsCode.trim()) : await account.login(p.email.trim(), pw);
      if (lm.methods.phone) saveLoginMethod(lm.method);
      p.onResult(r);
    } catch (e) {
      setUnreg(byPhone && phoneNotRegistered(e));
      p.setErr((e as Error).message || "登录没有完成，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="auth-form quiet"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {/* 第 64 批：登录方式页签就是卡片的标题行（Kimi 登录框“手机号码登录”的位置）；云端只开了密码登录时只有一个标题 */}
      {lm.methods.phone ? <LoginMethodTabs value={lm.method} onChange={switchTo} /> : <h1 className="auth-method-single">账号密码登录</h1>}
      {byPhone ? (
        <SmsCodeFields
          phone={p.phone}
          setPhone={(v) => {
            p.setPhone(v);
            if (unreg) {
              setUnreg(false);
              p.setErr("");
            }
          }}
          code={smsCode}
          setCode={setSmsCode}
          purpose="login"
          codeLength={f.codeLength}
          resendSeconds={f.resendSeconds}
          setErr={p.setErr}
          onSendError={(e) => setUnreg(phoneNotRegistered(e))}
          autoFocus
        />
      ) : (
        <>
          <label className="field">
            <span>邮箱</span>
            <input className="auth-input" type="email" value={p.email} onChange={(e) => (lm.lock(), p.setEmail(e.target.value))} autoComplete="username" autoFocus spellCheck={false} placeholder="请输入邮箱" />
          </label>
          <PasswordField label="密码" value={pw} onChange={(v) => (lm.lock(), setPw(v))} placeholder="请输入密码" />
        </>
      )}
      {p.err && (
        <p className="activate-error" role="alert">
          {p.err}
        </p>
      )}
      {unreg && (
        <div className="auth-unreg">
          {notRegisteredActions("activate").map((a) =>
            a === "register" ? (
              <button key={a} type="button" className="btn-ghost btn-sm" onClick={p.onRegisterWithPhone}>
                用这个手机号注册
              </button>
            ) : (
              <button key={a} type="button" className="btn-ghost btn-sm" onClick={() => switchTo("password")}>
                改用密码登录
              </button>
            ),
          )}
        </div>
      )}
      <button type="submit" className="btn-primary activate-submit" disabled={!ready || busy}>
        {busy ? "正在登录…" : "登录"}
      </button>
      <div className="auth-links">
        <span>
          还没有账号？
          <button type="button" className="btn-link" onClick={p.onRegister}>
            注册
          </button>
        </span>
        {!byPhone && (
          <button type="button" className="btn-link auth-links-end" onClick={p.onForgot}>
            忘记密码？
          </button>
        )}
      </div>
    </form>
  );
}

function RegisterForm(p: { meta: RegistrationMeta | null; email: string; setEmail: (v: string) => void; phone: string; setPhone: (v: string) => void; err: string; setErr: (v: string) => void; onResult: (r: any) => void; onLogin: () => void }) {
  const [pw, setPw] = useState("");
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [hasCode, setHasCode] = useState(false);
  const [code, setCode] = useState("");
  // 第 63 批：手机号由开通页持有（验证码登录发现没注册时带过来）
  const { phone, setPhone } = p;
  const [smsCode, setSmsCode] = useState("");
  const [busy, setBusy] = useState(false);
  // 第 62 批：按云端注册策略显示手机号与邀请码（旧云端照旧流程）
  const f = registrationFields(p.meta);
  const codeOn = f.code === "required" || hasCode;
  const codeLen = code.replace(/[^0-9A-Z]/g, "").length;
  const phoneOn = f.phone === "required" || (f.phone === "optional" && phone.trim() !== "");
  // 旧云端只认 20 / 36 位；新云端另认 12 位注册邀请码（凭它开自己的试用律所，所以也要填律所名称）
  const codeOk = f.legacy ? codeLengthOk(code) : registerCodeLengthOk(code);
  const orgShown = !codeOn || (!f.legacy && codeLen <= 12);
  const ready = emailLooksValid(p.email) && checkPassword(pw, p.email).ok && nameLooksValid(name) && (!codeOn || codeOk) && (!phoneOn || (phoneLooksValid(phone) && smsCodeLooksValid(smsCode, f.codeLength)));
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    p.setErr("");
    try {
      p.onResult(await account.register({ email: p.email.trim(), password: pw, name: name.trim(), ...(org.trim() && orgShown ? { org_name: org.trim() } : {}), ...(codeOn ? { code } : {}), ...(phoneOn ? { phone: phone.trim(), sms_code: smsCode.trim() } : {}) }));
    } catch (e) {
      p.setErr((e as Error).message || "注册没有完成，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="auth-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="auth-title-row">
        <h1 className="activate-title">注册账号</h1>
        <span className="muted">
          已有账号？
          <button type="button" className="btn-link" onClick={p.onLogin}>
            登录
          </button>
        </span>
      </div>
      <p className="activate-lead">{f.code === "required" ? "注册后这台电脑就是你的第一台电脑。现在凭邀请码注册：请填入收到的邀请码（律所负责人填开通码，同事填律所发的邀请码）。" : "注册后这台电脑就是你的第一台电脑。律所负责人收到的开通码、同事收到的邀请码，请在下面勾选后填入。"}</p>
      <label className="field">
        <span>邮箱</span>
        <input className="auth-input" type="email" value={p.email} onChange={(e) => p.setEmail(e.target.value)} autoComplete="username" autoFocus spellCheck={false} />
        {p.email && !emailLooksValid(p.email) && <span className="field-warn">邮箱格式不对</span>}
      </label>
      <PasswordField label="密码" value={pw} onChange={setPw} rules email={p.email} />
      <label className="field">
        <span>姓名</span>
        <input className="auth-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={40} placeholder="同事和客户看到的名字" />
        {/* 第 56 批：凭邀请码（36 位）加入的，本所里显示的是管理员写在邀请上的姓名 */}
        {codeOn && codeLen > 20 && <span className="muted">凭邀请码加入时，在本所显示的是管理员写在邀请上的姓名。</span>}
      </label>
      {f.phone !== "hidden" && <SmsCodeFields phone={phone} setPhone={setPhone} code={smsCode} setCode={setSmsCode} purpose="register" codeLength={f.codeLength} resendSeconds={f.resendSeconds} optional={f.phone === "optional"} setErr={p.setErr} {...(f.phone === "optional" && p.meta?.phone_login ? { phoneLabel: "手机号（可不填；填了以后可用手机号验证码登录、找回密码）" } : {})} />}
      {orgShown && (
        <label className="field">
          <span>律所或工作室名称（可不填）</span>
          <input className="auth-input" value={org} onChange={(e) => setOrg(e.target.value)} autoComplete="organization" maxLength={60} placeholder="不填则用你的姓名" />
        </label>
      )}
      {f.code === "checkbox" && (
        <label className="auth-check">
          <input type="checkbox" checked={hasCode} onChange={(e) => setHasCode(e.target.checked)} /> {f.legacy ? "我有开通码或邀请码" : "我有邀请码或开通码"}
        </label>
      )}
      {codeOn && (
        <label className="field">
          <span>{f.legacy ? "开通码或邀请码" : f.code === "required" ? "邀请码或开通码（必填）" : "邀请码或开通码"}</span>
          <input className="activate-code" value={code} onChange={(e) => setCode(groupCode(e.target.value))} placeholder={f.legacy ? "开通码 20 位，邀请码 36 位" : "注册邀请码 12 位，开通码 20 位，同事邀请码 36 位"} spellCheck={false} autoComplete="off" />
          <span className="muted">{f.legacy ? "凭码注册时，律所以码对应的为准。" : "凭开通码或同事邀请码注册时，律所以码对应的为准。"}</span>
        </label>
      )}
      {p.err && (
        <p className="activate-error" role="alert">
          {p.err}
        </p>
      )}
      <button type="submit" className="btn-primary activate-submit" disabled={!ready || busy}>
        {busy ? "正在注册…" : "注册并继续"}
      </button>
      {!codeOn && <p className="muted activate-foot">不填码即自助注册：为你开通一个试用的个人工作室，之后可以邀请同事加入。</p>}
    </form>
  );
}

function ForgotPassword(p: { meta: RegistrationMeta | null; email: string; setEmail: (v: string) => void; onBack: () => void; onDone: () => void }) {
  const [step, setStep] = useState<"ask" | "set">("ask");
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [hint, setHint] = useState("");
  // 第 62 批：云端短信可用时可改用手机号找回（旧云端没有这个选项）
  const f = registrationFields(p.meta);
  const [by, setBy] = useState<"email" | "phone">("email");
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const send = async () => {
    if (!emailLooksValid(p.email) || busy) return;
    setBusy(true);
    setErr("");
    try {
      setHint(resetNextText(await account.resetRequest(p.email.trim())));
      setStep("set");
    } catch (e) {
      setErr((e as Error).message || "没有发出，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!code.trim() || !checkPassword(pw, p.email).ok || busy) return;
    setBusy(true);
    setErr("");
    try {
      await account.resetConfirm(p.email.trim(), code.trim(), pw);
      p.onDone();
    } catch (e) {
      setErr((e as Error).message || "没有重设成功，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  const phoneReady = phoneLooksValid(phone) && smsCodeLooksValid(smsCode, f.codeLength) && checkPassword(pw).ok;
  const confirmByPhone = async () => {
    if (!phoneReady || busy) return;
    setBusy(true);
    setErr("");
    try {
      await account.resetConfirmByPhone(phone.trim(), smsCode.trim(), pw);
      p.onDone();
    } catch (e) {
      setErr((e as Error).message || "没有重设成功，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  const usePhone = f.phoneReset && by === "phone";
  return (
    <form
      className="auth-form"
      onSubmit={(e) => {
        e.preventDefault();
        void (usePhone ? confirmByPhone() : step === "ask" ? send() : confirm());
      }}
    >
      <h1 className="activate-title">找回密码</h1>
      {f.phoneReset && (
        <div className="auth-seg" role="tablist" aria-label="用邮箱或手机号找回">
          <button type="button" role="tab" aria-selected={by === "email"} className={by === "email" ? "on" : ""} onClick={() => (setBy("email"), setErr(""))}>
            用邮箱
          </button>
          <button type="button" role="tab" aria-selected={by === "phone"} className={by === "phone" ? "on" : ""} onClick={() => (setBy("phone"), setErr(""))}>
            用手机号
          </button>
        </div>
      )}
      {usePhone ? (
        <>
          <p className="activate-lead">填写注册时验证过的手机号，获取短信验证码后设置新密码。</p>
          <SmsCodeFields phone={phone} setPhone={setPhone} code={smsCode} setCode={setSmsCode} purpose="reset" codeLength={f.codeLength} resendSeconds={f.resendSeconds} setErr={setErr} autoFocus />
          <PasswordField label="新密码" value={pw} onChange={setPw} rules />
        </>
      ) : step === "ask" ? (
        <>
          <p className="activate-lead">填写注册时的邮箱。开通了邮件的会把验证码发到邮箱；没有邮件的，请向律所管理员或客服要一个重置码。</p>
          <label className="field">
            <span>邮箱</span>
            <input className="auth-input" type="email" value={p.email} onChange={(e) => p.setEmail(e.target.value)} autoComplete="username" autoFocus spellCheck={false} />
          </label>
        </>
      ) : (
        <>
          <p className="activate-notice" role="status">
            {hint}
          </p>
          <label className="field">
            <span>验证码、重置码或设置码</span>
            <input className="activate-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\s+/g, ""))} autoFocus spellCheck={false} autoComplete="one-time-code" />
          </label>
          <PasswordField label="新密码" value={pw} onChange={setPw} rules email={p.email} />
        </>
      )}
      {err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
      <div className="activate-actions">
        {usePhone ? (
          <button type="submit" className="btn-primary" disabled={!phoneReady || busy}>
            {busy ? "正在重设…" : "重设密码"}
          </button>
        ) : step === "ask" ? (
          <button type="submit" className="btn-primary" disabled={!emailLooksValid(p.email) || busy}>
            {busy ? "正在发送…" : "下一步"}
          </button>
        ) : (
          <button type="submit" className="btn-primary" disabled={!code.trim() || !checkPassword(pw, p.email).ok || busy}>
            {busy ? "正在重设…" : "重设密码"}
          </button>
        )}
        {!usePhone && step === "set" && (
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void send()}>
            重新发送
          </button>
        )}
        <button type="button" className="btn-ghost" onClick={p.onBack}>
          返回登录
        </button>
      </div>
      <p className="muted activate-foot">重设后，这个账号在所有电脑上的登录都会退出，需要用新密码重新登录。</p>
    </form>
  );
}

/**
 * 第 66 批（V40，D-292）：个人账号新电脑自动登记被暂停（24 小时内已有 3 台新电脑、或短时间多处登录）——用账号绑定手机号的验证码确认是本人后继续。
 * 没绑手机号或短信暂不可用：只说明原因与办法（在已登录的电脑上移除不认识的电脑并改密码，过后再试）。
 */
function AutoEnrollConfirm({ hold, onBack, onResult }: { hold: SmsHold; onBack: () => void; onResult: (r: any) => void }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Frame>
      <h1 className="activate-title">确认是你本人在登录</h1>
      <p className="activate-notice" role="status">
        {hold.message}
      </p>
      {hold.sms_available ? (
        <>
          {hold.phone_masked && <p className="muted">账号绑定的手机号：{hold.phone_masked}</p>}
          <SmsCodeFields phone={phone} setPhone={setPhone} code={code} setCode={setCode} purpose="login" codeLength={6} resendSeconds={60} setErr={setErr} autoFocus />
          {err && (
            <p className="activate-error" role="alert">
              {err}
            </p>
          )}
          <button
            className="btn-primary activate-submit"
            disabled={busy || !phoneLooksValid(phone) || !smsCodeLooksValid(code, 6)}
            onClick={() => {
              setBusy(true);
              setErr("");
              onboarding
                .deviceConfirm(phone, code)
                .then(onResult)
                .catch((e) => setErr((e as Error).message || "没有确认成功，请稍后重试"))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "正在确认…" : "确认并登记这台电脑"}
          </button>
        </>
      ) : null}
      <button type="button" className="btn-link" onClick={onBack}>
        返回登录
      </button>
    </Frame>
  );
}

function BlockedView({ b, onBack }: { b: Blocked; onBack: () => void }) {
  return (
    <Frame>
      <h1 className="activate-title">这台电脑暂时不能继续</h1>
      <p className="activate-error" role="alert">
        {b.message}
      </p>
      {b.devices.length > 0 && (
        <>
          <div className="section-title">这个账号已登记的电脑</div>
          <ul className="auth-devices">
            {b.devices.map((d) => {
              const l = deviceLine(d);
              return (
                <li key={d.device_id}>
                  <b>{l.title}</b>
                  <span className="muted">{l.meta || `${dayLabel(d.registered_at)}登记`}</span>
                </li>
              );
            })}
          </ul>
          <p className="muted">移除旧电脑：在那台电脑上打开“设置 → 账号与团队 → 登录过的电脑”；那台电脑已经不在手边的，请律所管理员或客服处理。</p>
        </>
      )}
      <div className="activate-actions">
        <button className="btn-primary" onClick={onBack}>
          返回登录
        </button>
      </div>
    </Frame>
  );
}

/** 直接输入开通码或邀请码（第 13 批原流程，第 44 批起为次要入口）。 */
function EnterCode({ onPending, onFounder, failed, onBack }: { onPending: (s: Status) => void; onFounder: (t: string) => void; failed: string; onBack: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(failed);
  const ready = codeLengthOk(code);
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await onboarding.redeem(code);
      if (r.kind === "founder") onFounder(`已为「${r.firm?.name ?? "本所"}」激活，正在打开…`);
      else onPending({ mode: "member_pending", firm: r.firm, member: r.member, check_code: r.check_code, requested_at: new Date().toISOString() });
    } catch (e) {
      setErr((e as Error).message || "激活没有完成，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h1 className="activate-title">输入开通码或邀请码</h1>
      <p className="activate-lead">不注册账号、直接用码激活这台电脑（之后可以在“设置 → 账号与团队”里登录账号）。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>开通码或邀请码</span>
          <input
            className="activate-code"
            value={code}
            onChange={(e) => setCode(groupCode(e.target.value))}
            placeholder="开通码 20 位，邀请码 36 位"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            inputMode="text"
            aria-describedby="activate-hint"
          />
        </label>
        {err && (
          <p className="activate-error" role="alert">
            {err}
          </p>
        )}
        <div className="activate-actions">
          <button type="submit" className="btn-primary" disabled={!ready || busy}>
            {busy ? "正在核对…" : "下一步"}
          </button>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回登录
          </button>
        </div>
      </form>
      <p id="activate-hint" className="muted activate-foot">
        开通码由 Kimi Work 发给律所负责人；邀请码由律所管理员发给你。码只能用一次，过期请向发码人重新获取。
      </p>
    </>
  );
}

/** 从备份恢复（第 14 批）：恢复包 + 备份位置 + 恢复码 → 与原来那台电脑相同的身份与数据。 */
function RestoreFromBackup({ onBack, onDone, onStuck, notice = "" }: { onBack: () => void; onDone: (s: string) => void; onStuck: (t: string) => void; notice?: string }) {
  const dialogs = recovery.hasDialogs();
  const [pkg, setPkg] = useState<{ handle?: string; name: string; path?: string } | null>(null);
  const [folder, setFolder] = useState<{ handle?: string; name: string; path?: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 需要律师确认的两种情形（复核 R2A-05、R2A-12）：本机有以前留下的数据；备份比恢复包还旧
  const [needAck, setNeedAck] = useState<{ legacy?: boolean; older?: boolean }>({});
  const [ack, setAck] = useState<{ legacy: boolean; older: boolean }>({ legacy: false, older: false });
  const submit = async () => {
    if (!pkg || !folder || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await onboarding.restore({
        ...(pkg.handle ? { file_handle: pkg.handle } : { file: pkg.path }),
        ...(folder.handle ? { folder_handle: folder.handle } : { dir: folder.path }),
        code,
        ...(ack.legacy ? { legacy_ack: true } : {}),
        ...(ack.older ? { older_ack: true } : {}),
      });
      // 按本机时间显示到分钟，并说明这之后的工作不在备份里（复核 R2B-22）
      const at = r.backup_at ? fmtTime(String(r.backup_at)) : "";
      onDone(`已恢复「${r.firm?.name ?? "本所"}」的数据（备份于 ${at}；这之后在原电脑上做的工作没有恢复${r.skipped_newer ? "，较新的几份备份不完整，用的是能用的最近一份" : ""}），正在打开…`);
      void waitForActivated(onStuck);
    } catch (e) {
      const why = ((e as { detail?: { code?: string } }).detail ?? {}).code;
      if (why === "legacy_present") setNeedAck((n) => ({ ...n, legacy: true }));
      if (why === "backup_older") setNeedAck((n) => ({ ...n, older: true }));
      // 安装包形态下选好的文件与文件夹是一次性的（用过即失效）：失败后清空，请律师重新选（复核 R2B-07）
      if (dialogs) {
        setPkg(null);
        setFolder(null);
      }
      setErr(`${(e as Error).message || "恢复没有完成"}${dialogs ? "（请重新选择恢复包和备份位置后再点“恢复”）" : ""}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame>
      <h1 className="activate-title">从备份恢复</h1>
      {notice && (
        <p className="activate-notice" role="note">
          {notice}
        </p>
      )}
      <p className="activate-lead">需要三样东西：恢复包文件、备份所在的位置（选 U 盘或文件夹本身即可，里面有一个 KimiWorkLegal-backup 文件夹）、打印或抄下的恢复码。恢复期间请不要关闭应用或拔出 U 盘。</p>
      {dialogs ? (
        <div className="activate-actions">
          <button className="btn-ghost" onClick={() => void recovery.pickPackageFile().then((f) => f && setPkg({ handle: f.handle, name: f.name }))}>
            {pkg ? `恢复包：${pkg.name}` : "选择恢复包"}
          </button>
          <button className="btn-ghost" onClick={() => void recovery.pickFolder().then((f) => f && setFolder({ handle: f.handle, name: f.name }))}>
            {folder ? `备份位置：${folder.name}` : "选择备份位置"}
          </button>
        </div>
      ) : (
        <>
          <label className="field">
            <span>恢复包文件位置</span>
            <input onChange={(e) => setPkg({ name: e.target.value, path: e.target.value })} />
          </label>
          <label className="field">
            <span>备份文件夹位置</span>
            <input onChange={(e) => setFolder({ name: e.target.value, path: e.target.value })} />
          </label>
        </>
      )}
      <label className="field">
        <span>恢复码（第一行 KWR1 也照抄）</span>
        <textarea className="activate-code" rows={4} value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      {err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
      {needAck.legacy && (
        <label className="activate-foot">
          <input type="checkbox" checked={ack.legacy} onChange={(e) => setAck((a) => ({ ...a, legacy: e.target.checked }))} /> 我知道以前留下的数据恢复后在本应用里打不开（不会删除）
        </label>
      )}
      {needAck.older && (
        <label className="activate-foot">
          <input type="checkbox" checked={ack.older} onChange={(e) => setAck((a) => ({ ...a, older: e.target.checked }))} /> 仍用这份备份恢复（之后的内容会丢失）
        </label>
      )}
      <div className="activate-actions">
        <button className="btn-primary" disabled={!pkg || !folder || code.trim().length < 10 || busy || (needAck.legacy && !ack.legacy) || (needAck.older && !ack.older)} onClick={() => void submit()}>
          {busy ? "正在核对与恢复…" : "恢复"}
        </button>
        <button className="btn-ghost" onClick={onBack}>
          返回
        </button>
      </div>
      <p className="muted activate-foot">恢复只在这台电脑上进行，不经过网络；恢复包和备份都会先核对，被改动过的不会采用。</p>
    </Frame>
  );
}

function WaitApproval({ status, onReset, onRefresh }: { status: Status; onReset: () => void; onRefresh: () => void }) {
  const [note, setNote] = useState("");
  const [rejected, setRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  // 账号新电脑批准后（D-186）：先请律师把本所识别码和旧电脑上的比对，再打开
  const [firmCode, setFirmCode] = useState<string | null>(null);
  const alive = useRef(true);
  const viaAccount = !!status.via_account;
  const opened = (t: string) => {
    if (!alive.current) return;
    setRejected(true);
    setNote(t);
  };
  const check = async (manual: boolean) => {
    if (busy || firmCode) return;
    setBusy(true);
    try {
      const r = await onboarding.check();
      if (!alive.current) return;
      if (r.last_check === "approved") {
        if (viaAccount && typeof r.firm_check_code === "string") {
          setFirmCode(r.firm_check_code);
          setNote("");
        } else {
          setNote("管理员已批准，正在打开…");
          void waitForActivated(opened, "#/welcome");
        }
      } else if (r.last_check === "rejected") {
        setRejected(true);
        setNote(r.message ?? "管理员没有批准这次申请");
      } else if (r.last_check === "unreachable") {
        setNote(r.message ?? "暂时连不上 Kimi Work 服务，稍后自动再试");
      } else if (manual) {
        setNote("还在等批准");
      }
    } catch (e) {
      if (alive.current) setNote((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    const t = setInterval(() => void check(false), 10_000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, []);
  const who = [status.member?.name, status.member?.role ? roleLabel(status.member.role) : null].filter(Boolean).join(" · ");
  if (firmCode) {
    return (
      <Frame>
        <h1 className="activate-title">已批准，请再核对一次</h1>
        <p className="activate-lead">请在你原来那台电脑上打开“设置 → 账号与团队 → 本所识别码”，与下面这串数字逐位比对。一致，说明这台电脑加入的确实是本所。</p>
        <div className="activate-checkcode" aria-label="本所识别码">
          {firmCode}
        </div>
        {note && (
          <p className="muted" role="status">
            {note}
          </p>
        )}
        <div className="activate-actions">
          <button
            className="btn-primary"
            onClick={() => {
              setNote("正在打开…（第一次打开需要十几秒）");
              void waitForActivated(opened, "#/welcome");
            }}
          >
            一致，打开
          </button>
        </div>
        <p className="muted activate-foot">对不上：请不要在这台电脑上继续使用，马上联系律所管理员；你也可以在原来那台电脑的“设置 → 账号与团队 → 我的电脑”里解绑这台电脑。</p>
      </Frame>
    );
  }
  return (
    <Frame>
      <h1 className="activate-title">{viaAccount ? "等待批准这台电脑" : "等待管理员批准"}</h1>
      <p className="activate-lead">{waitApprovalLead({ firm: status.firm?.name ?? "律所", who, viaAccount, admin: status.member?.role === "admin" })}</p>
      <div className="activate-checkcode" aria-label="入组核对码">
        {status.check_code}
      </div>
      {note && (
        <p className={rejected ? "activate-error" : "muted"} role="status">
          {note}
        </p>
      )}
      <div className="activate-actions">
        {!rejected && (
          <button className="btn-primary" disabled={busy} onClick={() => void check(true)}>
            {busy ? "正在查询…" : "现在查一下"}
          </button>
        )}
        <button
          className="btn-ghost"
          onClick={() => {
            onReset();
            onRefresh();
          }}
        >
          {viaAccount ? "改用别的账号" : "重新输入邀请码"}
        </button>
      </div>
      <details className="muted activate-foot">
        <summary>为什么要核对</summary>
        确认申请加入的确实是你本人的这台电脑。入组核对码请通过电话或当面告知，不要截图转发。
      </details>
      <p className="muted activate-foot">批准后会自动打开，不用一直守在这里。申请 7 天内有效。</p>
    </Frame>
  );
}
