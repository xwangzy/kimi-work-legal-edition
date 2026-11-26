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
import { AuthCard, AuthPage, AuthPrivacy, MetaGate } from "../components/AuthShell.tsx";
import { PasswordField } from "../components/PasswordField.tsx";
import { LoginMethodTabs, SmsCodeFields, useLoginMethod, useRegistrationMetaState } from "../components/SmsCodeFields.tsx";
import { setAsideAutoOpen, setAsideNotice } from "../lib/activate-text.ts";
import { accountWho, maskPhoneTight, passwordIdOk, checkPassword, codeLengthOk, dayLabel, deviceLine, emailLooksValid, nameLooksValid, notRegisteredActions, phoneLooksValid, phoneNotRegistered, registerCodeLengthOk, registrationFields, resetNextText, roleLabel, saveLoginMethod, smsCodeLooksValid, waitApprovalLead, type AccountDevice, type LoginMethod, type RegistrationMeta } from "../lib/account.ts";
import { fmtTime } from "../lib/labels.ts";
import { DeviceLimitList } from "../components/DeviceLimitList.tsx";
import { ResetPasswordForm } from "../components/AccountPanel.tsx";
import { waitForProfileSwitch } from "../lib/account-switch.ts";
import { switchingText } from "../lib/account.ts";

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
  /** 第 68 批（V42，D-294）：这台电脑上别的账号的工作空间个数（不列姓名）；登录那个账号即打开。 */
  other_profiles?: number;
  /** 第 68 批：从上一个账号的登录页换过来、内核按那次登录继续登记这台电脑的结果（同登录答复）。 */
  handoff?: any;
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
      handoff={status.handoff ?? null}
      otherProfiles={typeof status.other_profiles === "number" ? status.other_profiles : 0}
      onPending={(s) => setStatus(s)}
      legacy={status.legacy_workspaces ?? []}
      failed={status.last_failure ? failureText(status.last_failure.code) : ""}
      setAside={status.set_aside?.[0] ?? null}
    />
  );
}

/** 第 64 批：开通页的每一步都用同一个登录类外壳（AuthShell：整窗页面 + 品牌条卡片 + 页脚说明）。 */
function Frame({ children, foot, wide = false }: { children: React.ReactNode; foot?: React.ReactNode; wide?: boolean }) {
  // 第 69 批第二轮：每一步都带同一句页脚（电脑数已满、等待批准、凭码开通等原来没有页脚，卡片底部空着）
  return (
    <AuthPage kind="activate">
      <AuthCard foot={foot ?? <AuthPrivacy />} wide={wide}>
        {children}
      </AuthCard>
    </AuthPage>
  );
}

// 第 69 批（V43）：页脚原来是两行半的披露（“只把邮箱或手机号、密码或短信验证码、开通码或邀请码发给 Kimi Work 服务核对；你的案卷不会上传”）——
// 律师真正需要确认的只有“案卷不会上传”，发给云端核对的就是表单里看得到的那几项。收成一句常驻页脚（AuthPrivacy），所有登录类卡片同一句。

type View = "login" | "register" | "forgot" | "code" | "restore";
type Blocked = { message: string; devices: AccountDevice[]; canUnbind?: boolean; canSignout?: boolean; limit?: number | null; limitKind?: "signed_in" | "registered" | null; who?: string | null };
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
      setBlocked({ message: String(r.message ?? "这台电脑暂时不能用这个账号继续，请联系客服"), devices: Array.isArray(r.devices) ? r.devices : [], canUnbind: r.can_unbind === true, canSignout: r.can_signout === true, limit: typeof r.device_limit === "number" ? r.device_limit : null, limitKind: r.limit_kind === "registered" || r.limit_kind === "signed_in" ? r.limit_kind : null, who: accountWho({ name: typeof r.account?.name === "string" ? r.account.name : null, phone: typeof r.account?.phone === "string" ? r.account.phone : null, email: typeof r.account?.email === "string" ? r.account.email : null }) });
    } else if (r?.next === "switch") {
      // 第 68 批（V42，D-294）：这台电脑上已有这个账号的工作空间——直接打开它（不重复登记）
      setDone(switchingText(r));
      // 待激活时的档案标记固定是“-|onboarding”（内核 300 毫秒后才切换，这里不取当前值，免得取到已切换后的状态而一直等）
      void waitForProfileSwitch("-|onboarding", stuck);
    } else if (r?.next === "error") {
      stuck(String(r.message ?? "没有完成，请重新登录"));
    } else {
      stuck("没有完成，请稍后重试；仍不行请联系客服");
    }
  };
}

function Entry({ onPending, legacy, failed, setAside, handoff = null, otherProfiles = 0 }: { onPending: (s: Status) => void; legacy: string[]; failed: string; setAside: string | null; handoff?: any; otherProfiles?: number }) {
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
  // 第 68 批（V42，D-294）：从上一个账号的登录页换过来——内核已按那次登录继续登记这台电脑，这里接着显示结果（等批准、要短信确认、电脑数已满等）
  const handled = useRef(false);
  useEffect(() => {
    if (!handoff || handled.current) return;
    handled.current = true;
    if (handoff.next !== "working") return outcome(handoff);
    // 还在登记：等内核给出结果（登记成功时内核会按新身份重启，界面随之重新载入）
    setDone("正在为这个账号登记这台电脑…");
    let alive = true;
    const until = Date.now() + 120_000;
    // 第 71 批（V45，根因 R1/R2）：原来只认 handoff 与“已不在待激活”——交接结果是“等批准”（内核已写待批准记录）、入组核对失败（last_failure）、
    // 内核中途重启把交接弄丢（新内核不再有 handoff、也不在重启中）这三种都只能空等 120 秒、再报“请重启应用”。现在逐一认出、立即转到对应的页面
    let lostSince: number | null = null;
    const poll = async () => {
      while (alive && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const st = await api.kernelStatus();
          if (st && !st.onboarding) {
            window.location.hash = "#/welcome";
            window.location.reload();
            return;
          }
          const o = st?.onboarding;
          if (o?.mode === "member_pending") {
            setDone(null);
            onPending(o as Status);
            return;
          }
          const h = o?.handoff;
          if (h && h.next !== "working") {
            setDone(null);
            outcome(h);
            return;
          }
          if (o?.last_failure && !o.restarting) {
            stuck(failureText(o.last_failure.code));
            return;
          }
          // 交接丢了（内核在登记中途重启）：连续 3 秒既没有交接结果也不在重启中——请律师再登录一次即可，不必重启应用
          if (!h && !o?.restarting) {
            lostSince ??= Date.now();
            if (Date.now() - lostSince > 3_000) {
              stuck("登记这台电脑的过程中断了：请再登录一次（不用重启应用）；若仍如此，请联系客服。");
              return;
            }
          } else lostSince = null;
        } catch {
          // 重启期间内核暂不可用：继续等
          lostSince = null;
        }
      }
      if (alive) stuck("登记这台电脑超过 2 分钟还没有完成：请检查网络后再登录一次（不用重启应用）；若仍如此，请联系客服。");
    };
    void poll();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff]);
  const go = (v: View) => {
    setErr("");
    setNote("");
    setView(v);
  };
  if (done) {
    return (
      <Frame>
        <div className="auth-progress" role="status" aria-live="polite">
          <span className="auth-dot" aria-hidden="true" />
          <h1 className="auth-title">{done}</h1>
          <p className="auth-lead">第一次打开需要十几秒。</p>
        </div>
      </Frame>
    );
  }
  if (blocked)
    return (
      <BlockedView
        b={blocked}
        onBack={() => setBlocked(null)}
        onUnbind={async (id) => {
          const r = await onboarding.unbindDevice(id);
          setBlocked(null);
          outcome(r);
        }}
        onSignout={async (id) => {
          const r = await onboarding.signoutDevice(id);
          setBlocked(null);
          outcome(r);
        }}
      />
    );
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
  // 其他方式（Kimi 登录框“企业 SSO 登录”的位置）：凭码激活、从备份恢复。第 69 批：两个短链接，一行
  const alt = (
    <div className="auth-alt">
      {view !== "code" && view !== "register" && (
        <button type="button" className="btn-link" onClick={() => go("code")}>
          使用开通码
        </button>
      )}
      <button type="button" className="btn-link" onClick={() => go("restore")}>
        从备份恢复
      </button>
    </div>
  );
  const foot = (
    <AuthPrivacy>
      {otherProfiles > 0 && <>这台电脑上还有 {otherProfiles} 个账号，登录对应账号即可打开，彼此不可见。</>}
      {legacy.length > 0 && <>这台电脑上有以前留下的数据（{legacy.join("、")}），不会转入也不会删除，如需处理请联系所内 IT。</>}
    </AuthPrivacy>
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
              onRegisterWithPhone={() => go("register")}
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
      {/* 第 69 批第二轮：“使用开通码 / 从备份恢复”只在登录与凭码页出现（注册、找回时用不上，也让各卡同高） */}
      {(view === "login" || view === "code") && alt}
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
  const ready = byPhone ? phoneLooksValid(p.phone) && smsCodeLooksValid(smsCode, f.codeLength) : passwordIdOk(p.email, p.meta) && pw.length > 0;
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
      // 第 71 批（V45）：这台电脑正在为另一个账号等批准——给一步“放弃那个申请，用这个账号继续”（刚才的登录在内核里留着，不必再收验证码）
      setPendingOther(((e as { detail?: { reason?: string } }).detail ?? {}).reason === "pending_other");
      p.setErr((e as Error).message || "登录没有完成，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  const [pendingOther, setPendingOther] = useState(false);
  const abandon = async () => {
    setBusy(true);
    try {
      const r = await onboarding.abandonPending();
      setPendingOther(false);
      p.setErr("");
      p.onResult(r);
    } catch (e) {
      p.setErr((e as Error).message || "没有完成，请重新登录");
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
      {/* 第 71 批（V45，独立评分区域 7-4）：每页一个标题（登录 / 注册 / 找回密码 / 登录其他账号），登录方式页签统一 14 号、在标题之下 */}
      <h1 className="auth-title">登录</h1>
      {lm.methods.phone && <LoginMethodTabs value={lm.method} onChange={switchTo} />}
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
            <span>{p.meta?.password_by_phone ? "手机号或邮箱" : "邮箱"}</span>
            <input className="auth-input" type={p.meta?.password_by_phone ? "text" : "email"} value={p.email} onChange={(e) => (lm.lock(), p.setEmail(e.target.value))} autoComplete="username" autoFocus spellCheck={false} placeholder={p.meta?.password_by_phone ? "手机号或邮箱" : "请输入邮箱"} />
          </label>
          <PasswordField label="密码" value={pw} onChange={(v) => (lm.lock(), setPw(v))} placeholder="请输入密码" />
        </>
      )}
      {p.err && (
        <p className="activate-error" role="alert">
          {p.err}
        </p>
      )}
      {pendingOther && (
        <div className="auth-unreg">
          <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => void abandon()}>
            放弃那个申请，用这个账号继续
          </button>
        </div>
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

/**
 * 注册（第 69 批，V43 重做为两步，每步与登录卡同一骨架：一个标题、至多三个输入、一个主按钮、一行链接）：
 *   ① 手机号 + 短信验证码（云端要求验证手机号时；可选时可跳过；没开短信时没有这一步）→ “下一步”
 *   ② 姓名、邮箱、设置密码 → “注册并继续”；律所名称（缺省“<姓名>的工作室”，注册后不能改）与邀请码 / 开通码收在一个可展开的链接里
 * 验证码到第②步提交时才由云端核对：核对不过（错码、过期、次数用尽）回到第①步并把原因写在那里。
 * 原来一屏七个输入框 + 复选框 + 三段说明小字（“不勾选即自助注册试用的个人工作室，本机为第一台电脑”“凭码注册时律所以码对应的为准”……），
 * 在 900 高的窗口里放不下；这些说明要么显而易见、要么在用到时才有意义，按需出现或删去。
 */
function RegisterForm(p: { meta: RegistrationMeta | null; email: string; setEmail: (v: string) => void; phone: string; setPhone: (v: string) => void; err: string; setErr: (v: string) => void; onResult: (r: any) => void; onLogin: () => void }) {
  const [pw, setPw] = useState("");
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [code, setCode] = useState("");
  // 第 63 批：手机号由开通页持有（验证码登录发现没注册时带过来）
  const { phone, setPhone } = p;
  const [smsCode, setSmsCode] = useState("");
  const [busy, setBusy] = useState(false);
  // 第 62 批：按云端注册策略显示手机号与邀请码（旧云端照旧流程）
  const f = registrationFields(p.meta);
  const phoneStep = f.phone !== "hidden";
  const [step, setStep] = useState<1 | 2>(phoneStep ? 1 : 2);
  const [skippedPhone, setSkippedPhone] = useState(false);
  // 云端要求凭码注册时码框常显；否则收在“律所名称或邀请码”里
  const [more, setMore] = useState(f.code === "required");
  const codeOn = f.code === "required" || (more && code.trim() !== "");
  const codeLen = code.replace(/[^0-9A-Z]/g, "").length;
  const phoneOn = !skippedPhone && (f.phone === "required" || (f.phone === "optional" && phone.trim() !== ""));
  // 旧云端只认 20 / 36 位；新云端另认 12 位注册邀请码（凭它开自己的试用律所，所以也要填律所名称）
  const codeOk = f.legacy ? codeLengthOk(code) : registerCodeLengthOk(code);
  const orgShown = !codeOn || (!f.legacy && codeLen <= 12);
  const step1Ready = phoneLooksValid(phone) && smsCodeLooksValid(smsCode, f.codeLength);
  const ready = emailLooksValid(p.email) && checkPassword(pw, p.email).ok && nameLooksValid(name) && (!codeOn || codeOk) && (!phoneOn || step1Ready);
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    p.setErr("");
    try {
      p.onResult(await account.register({ email: p.email.trim(), password: pw, name: name.trim(), ...(org.trim() && orgShown ? { org_name: org.trim() } : {}), ...(codeOn ? { code } : {}), ...(phoneOn ? { phone: phone.trim(), sms_code: smsCode.trim() } : {}) }));
    } catch (e) {
      const c = (e as { detail?: { reason?: string }; code?: string }).detail?.reason ?? "";
      // 验证码的问题回到第①步说（那里有“重新获取”）
      if (phoneOn && /^sms_|phone_/.test(c)) setStep(1);
      p.setErr((e as Error).message || "注册没有完成，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  const err = p.err && (
    <p className="activate-error" role="alert">
      {p.err}
    </p>
  );
  const toLogin = (
    <div className="auth-links">
      <span>
        已有账号？
        <button type="button" className="btn-link" onClick={p.onLogin}>
          登录
        </button>
      </span>
      {/* 第 71 批（V45，独立评分区域 1-2）：原“跳过”看不出去哪、少了什么——写明是“不验证手机号、用邮箱注册”，第②步再说清后果 */}
      {step === 1 && f.phone === "optional" && (
        <button
          type="button"
          className="btn-link auth-links-end"
          onClick={() => {
            p.setErr("");
            setSkippedPhone(true);
            setStep(2);
          }}
        >
          不验证手机号，用邮箱注册
        </button>
      )}
    </div>
  );
  if (step === 1)
    return (
      <form
        className="auth-form quiet"
        data-auth-step="register-phone"
        onSubmit={(e) => {
          e.preventDefault();
          if (!step1Ready) return;
          p.setErr("");
          setSkippedPhone(false);
          setStep(2);
        }}
      >
        <div className="auth-title-row">
          <h1 className="auth-title">注册</h1>
          <span className="auth-step-count">第 1 步，共 2 步</span>
        </div>
        <p className="auth-lead">先验证手机号，下一步设置姓名、邮箱和密码。</p>
        <SmsCodeFields phone={phone} setPhone={setPhone} code={smsCode} setCode={setSmsCode} purpose="register" codeLength={f.codeLength} resendSeconds={f.resendSeconds} setErr={p.setErr} autoFocus />
        {err}
        <button type="submit" className="btn-primary activate-submit" disabled={!step1Ready}>
          下一步
        </button>
        {toLogin}
      </form>
    );
  return (
    <form
      className="auth-form quiet"
      data-auth-step="register-account"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="auth-title-row">
        <h1 className="auth-title">设置账号</h1>
        {phoneStep && (
          <span className="auth-title-side">
            <span className="auth-step-count">第 2 步，共 2 步</span>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                p.setErr("");
                setStep(1);
              }}
            >
              {phoneOn ? `${maskPhoneTight(phone)} · 修改` : "返回"}
            </button>
          </span>
        )}
      </div>
      <label className="field">
        <span>姓名</span>
        <input className="auth-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={40} autoFocus placeholder="你的姓名" />
      </label>
      <label className="field">
        <span>邮箱</span>
        <input className="auth-input" type="email" value={p.email} onChange={(e) => p.setEmail(e.target.value)} autoComplete="username" spellCheck={false} placeholder="邮箱（用于登录与找回密码）" />
        {p.email && !emailLooksValid(p.email) && <span className="field-warn">邮箱格式不对</span>}
      </label>
      <PasswordField label="密码" value={pw} onChange={setPw} rules email={p.email} placeholder="设置密码" />
      {more ? (
        <>
          {orgShown && (
            <label className="field">
              <span>律所或工作室名称</span>
              <input className="auth-input" value={org} onChange={(e) => setOrg(e.target.value)} autoComplete="organization" maxLength={60} placeholder={name.trim() ? `律所或工作室名称（不填为“${name.trim()}的工作室”）` : "律所或工作室名称（可不填）"} />
            </label>
          )}
          <label className="field">
            <span>{f.code === "required" ? "邀请码或开通码" : "邀请码或开通码（可不填）"}</span>
            <input className="activate-code auth-input" value={code} onChange={(e) => setCode(groupCode(e.target.value))} placeholder={f.code === "required" ? "邀请码或开通码" : "邀请码或开通码（可不填）"} spellCheck={false} autoComplete="off" />
          </label>
        </>
      ) : null}
      {err}
      <button type="submit" className="btn-primary activate-submit" disabled={!ready || busy}>
        {busy ? "正在注册…" : "注册并继续"}
      </button>
      {skippedPhone && <p className="auth-fine">没有验证手机号：以后用邮箱和密码登录；可在“设置 → 账号”绑定手机号，之后也能用验证码登录。</p>}
      {/* 第三轮（独立评审 R2-5）：第②步不再放“已有账号？登录”（第①步已有；走到这一步的是要注册的人） */}
      {!more && (
        <div className="auth-links">
          <button type="button" className="btn-link auth-more" onClick={() => setMore(true)}>
            律所名称 / 邀请码
          </button>
        </div>
      )}
    </form>
  );
}

/** 第 71 批（V45）：找回密码与重新登录页同一条流程（ResetPasswordForm），这里预填登录框里已填的手机号或邮箱。 */
function ForgotPassword(p: { meta: RegistrationMeta | null; email: string; setEmail: (v: string) => void; onBack: () => void; onDone: () => void }) {
  return <ResetPasswordForm meta={p.meta} prefill={p.email} onBack={p.onBack} onDone={p.onDone} />;
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

function BlockedView({ b, onBack, onUnbind, onSignout }: { b: Blocked; onBack: () => void; onUnbind: (deviceId: string) => Promise<void>; onSignout: (deviceId: string) => Promise<void> }) {
  // 第 69 批（V43，D-297）：电脑数已满——整卡选择；第 71 批（D-298）：默认“让它退出登录”（可逆），移除是次要动作。其他原因（律所未开通等）照旧说明
  if (b.devices.length > 0)
    return (
      <Frame>
        <DeviceLimitList devices={b.devices} canUnbind={b.canUnbind === true} canSignout={b.canSignout === true} limit={b.limit ?? null} limitKind={b.limitKind ?? null} who={b.who ?? null} onUnbind={onUnbind} onSignout={onSignout} onBack={onBack} />
      </Frame>
    );
  return (
    <Frame>
      <h1 className="auth-title">这台电脑暂时不能继续</h1>
      <p className="auth-lead">{b.message}</p>
      <button type="button" className="btn-primary activate-submit" onClick={onBack}>
        返回登录
      </button>
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
