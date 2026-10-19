/**
 * 首次启动激活（第 13 批开通与成员入组；docs/design/开通与成员入组设计-v1.md）。
 * 这台电脑还没有激活时，整个应用只显示这一页：输入中软给律所的开通码，或律所管理员发来的邀请码。
 * 邀请码激活后要等管理员批准：显示 12 位核对码，请律师电话或当面念给管理员核对；批准后自动打开。
 * 律师层不出现“证书、密钥、签名”等词；激活只把码发给中软核对，不上传任何案件材料。
 */
import { useEffect, useRef, useState } from "react";
import { api, onboarding } from "../api.ts";

type Status = { mode: "unactivated" | "member_pending"; firm?: { name: string }; member?: { name: string | null; role: string }; check_code?: string; requested_at?: string; restarting?: boolean };

const ROLE_LABEL: Record<string, string> = { admin: "管理员", partner: "合伙人", lawyer: "律师", assistant: "助理" };

/** 输入时按 4 位一组显示（只留字母与数字，大写）。 */
function groupCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 20);
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
  const ready = code.replace(/-/g, "").length === 20;
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
  return (
    <Frame>
      <h1 className="activate-title">激活这台电脑</h1>
      <p className="activate-lead">输入中软交给律所的开通码，或律所管理员发给你的邀请码。</p>
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
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
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
          {busy ? "正在核对…" : "激活"}
        </button>
      </form>
      <p id="activate-hint" className="muted activate-foot">
        激活只把这串码发给中软核对，不会上传任何案件材料。码只能用一次，过期请向发码人重新获取。
      </p>
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
      <h1 className="activate-title">等待律所管理员批准</h1>
      <p className="activate-lead">
        你以{who ? `「${who}」` : "成员"}的身份申请加入「{status.firm?.name ?? "律所"}」。请把下面这串数字念给管理员，两边屏幕上的数字一致，管理员再点“批准”。
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
      <p className="muted activate-foot">批准后会自动打开，不用一直守在这里。申请 7 天内有效。</p>
    </Frame>
  );
}
