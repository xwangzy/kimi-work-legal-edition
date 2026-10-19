/**
 * 首次启动激活（第 13 批开通与成员入组；docs/design/开通与成员入组设计-v1.md）。
 * 这台电脑还没有激活时，整个应用只显示这一页：输入中软给律所的开通码，或律所管理员发来的邀请码。
 * 邀请码激活后要等管理员批准：显示 12 位核对码，请律师电话或当面念给管理员核对；批准后自动打开。
 * 律师层不出现“证书、密钥、签名”等词；激活只把码发给中软核对，不上传任何案件材料。
 */
import { useEffect, useRef, useState } from "react";
import { api, onboarding, recovery } from "../api.ts";

type Status = { mode: "unactivated" | "member_pending"; firm?: { name: string }; member?: { name: string | null; role: string }; check_code?: string; requested_at?: string; restarting?: boolean };

const ROLE_LABEL: Record<string, string> = { admin: "管理员", partner: "合伙人", lawyer: "律师", assistant: "助理" };

/** 输入时按 4 位一组显示（只留字母与数字，大写）。 */
function groupCode(raw: string): string {
  // 开通码 20 位；邀请码 36 位（控制面码 + 管理员本机生成的核对段，复核 A-01）
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 36);
  return s.replace(/(.{4})(?=.)/g, "$1-");
}

/** 激活完成后内核按新身份重启：等它就绪再刷新页面。 */
async function waitForActivated(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const st = await api.kernelStatus();
      if (st && !st.onboarding) {
        window.location.hash = "#/";
        window.location.reload();
        return;
      }
    } catch {
      // 重启期间内核暂不可用：继续等
    }
  }
}

export function ActivatePage({ initial, onRefresh }: { initial: Status; onRefresh: () => void }) {
  const [status, setStatus] = useState<Status>(initial);
  if (status.mode === "member_pending") return <WaitApproval status={status} onReset={async () => setStatus((await onboarding.reset()) as Status)} onRefresh={onRefresh} />;
  return <EnterCode onPending={(s) => setStatus(s)} />;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="activate">
      <div className="activate-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            K
          </span>
          <span>
            Kimi Work
            <small>法律行业发行版</small>
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

function EnterCode({ onPending }: { onPending: (s: Status) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const ready = [20, 36].includes(code.replace(/-/g, "").length);
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await onboarding.redeem(code);
      if (r.kind === "founder") {
        setDone(`已为「${r.firm?.name ?? "本所"}」激活，正在打开…`);
        void waitForActivated();
      } else {
        onPending({ mode: "member_pending", firm: r.firm, member: r.member, check_code: r.check_code, requested_at: new Date().toISOString() });
      }
    } catch (e) {
      setErr((e as Error).message || "激活没有完成，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  if (done) {
    return (
      <Frame>
        <h1 className="activate-title">{done}</h1>
        <p className="muted">第一次打开需要十几秒。</p>
      </Frame>
    );
  }
  if (restoring) return <RestoreFromBackup onBack={() => setRestoring(false)} onDone={setDone} />;
  return (
    <Frame>
      <h1 className="activate-title">欢迎使用</h1>
      <p className="activate-lead">请输入开通码或邀请码。</p>
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
        <button type="submit" className="btn-primary activate-submit" disabled={!ready || busy}>
          {busy ? "正在核对…" : "下一步"}
        </button>
      </form>
      <p id="activate-hint" className="muted activate-foot">
        开通码由中软发给律所负责人；邀请码由律所管理员发给你。码只能用一次，过期请向发码人重新获取。
        <br />
        没有码？请联系律所管理员；律所负责人还没收到开通码，请联系中软客服。
        <br />
        开通时只需联网核对一次这个码；你的案卷不会上传。
      </p>
      <p className="activate-foot">
        <button className="btn-link" onClick={() => setRestoring(true)}>
          换了新电脑？从备份恢复 →
        </button>
      </p>
    </Frame>
  );
}

/** 从备份恢复（第 14 批）：恢复包 + 备份位置 + 恢复码 → 与原来那台电脑相同的身份与数据。 */
function RestoreFromBackup({ onBack, onDone }: { onBack: () => void; onDone: (s: string) => void }) {
  const dialogs = recovery.hasDialogs();
  const [pkg, setPkg] = useState<{ handle?: string; name: string; path?: string } | null>(null);
  const [folder, setFolder] = useState<{ handle?: string; name: string; path?: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!pkg || !folder || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await onboarding.restore({
        ...(pkg.handle ? { file_handle: pkg.handle } : { file: pkg.path }),
        ...(folder.handle ? { folder_handle: folder.handle } : { dir: folder.path }),
        code,
      });
      onDone(`已恢复「${r.firm?.name ?? "本所"}」的数据（备份于 ${String(r.backup_at ?? "").slice(0, 10)}），正在打开…`);
      void waitForActivated();
    } catch (e) {
      setErr((e as Error).message || "恢复没有完成");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame>
      <h1 className="activate-title">从备份恢复</h1>
      <p className="activate-lead">需要三样东西：恢复包文件、备份所在的位置（例如 U 盘）、打印或抄下的恢复码。</p>
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
            <span>开发形态：恢复包文件路径</span>
            <input onChange={(e) => setPkg({ name: e.target.value, path: e.target.value })} />
          </label>
          <label className="field">
            <span>开发形态：备份位置路径</span>
            <input onChange={(e) => setFolder({ name: e.target.value, path: e.target.value })} />
          </label>
        </>
      )}
      <label className="field">
        <span>恢复码（含第一行 KWR1）</span>
        <textarea className="activate-code" rows={4} value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      {err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
      <div className="activate-actions">
        <button className="btn-primary" disabled={!pkg || !folder || code.trim().length < 10 || busy} onClick={() => void submit()}>
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
  const alive = useRef(true);
  const check = async (manual: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await onboarding.check();
      if (!alive.current) return;
      if (r.last_check === "approved") {
        setNote("管理员已批准，正在打开…");
        void waitForActivated();
      } else if (r.last_check === "rejected") {
        setRejected(true);
        setNote(r.message ?? "管理员没有批准这次申请");
      } else if (r.last_check === "unreachable") {
        setNote(r.message ?? "暂时连不上中软服务，稍后会自动重试");
      } else if (manual) {
        setNote("还在等管理员批准");
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
  const who = [status.member?.name, status.member?.role ? ROLE_LABEL[status.member.role] : null].filter(Boolean).join(" · ");
  return (
    <Frame>
      <h1 className="activate-title">等待管理员批准</h1>
      <p className="activate-lead">
        已向「{status.firm?.name ?? "律所"}」申请加入{who ? `（${who}）` : ""}。请打电话或当面联系管理员，把下面的核对码读给他；管理员核对一致后批准，这里会自动进入。
      </p>
      <div className="activate-checkcode" aria-label="核对码">
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
          重新输入邀请码
        </button>
      </div>
      <details className="muted activate-foot">
        <summary>为什么要核对</summary>
        确认申请加入的确实是你本人的这台电脑。核对码请通过电话或当面告知，不要截图转发。
      </details>
      <p className="muted activate-foot">批准后会自动打开，不用一直守在这里。申请 7 天内有效。</p>
    </Frame>
  );
}
