/**
 * 设置 → 备份与安全 → 恢复与备份（第 14 批；设计 docs/design/恢复与备份设计-v1.md）。
 * 律师要做的只有三件事：生成恢复包（抄下或打印恢复码）、试一次、选一个备份位置。之后每天自动备份。
 * 电脑坏了：在新电脑的激活页点“从备份恢复”。律师层不出现“主密钥、DPAPI、证书”等词。
 * 第二轮复核处置：恢复码逐行编号、打印带抬头与配对编号（R2B-18、R2B-21）；保存后提醒把恢复包放到别处、自动展开“试一下”（R2B-17）；
 * 以前生成的恢复包仍然有效（R2A-01）；开通律所的电脑的恢复包另有提示（R2A-02）；备份进行中显示进度（R2B-19）。
 *
 * 第 56 批：逻辑收进 useRecoveryBackup，两种呈现共用——
 * - RecoveryBackup：首次使用引导里的三格（Welcome 页，原样）；
 * - BackupTrack：设置 → 备份与安全的“页首一条状态 + 纵向三步”（轨道语言：左侧细线 + 节点；当前一步展开，做完的收成一行，没轮到的置灰写原因）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { recovery } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";
import { backupPlan, type StepState } from "../lib/device-status.ts";
import { WaitBlock } from "./Loading.tsx";
import { Icon } from "./Icons.tsx";
import { countProgress } from "../lib/waiting.ts";

interface Created {
  code: string;
  setId: string;
  firmName: string;
  createdAt: string;
  founder: boolean;
}

/** 恢复码逐行编号：第一行 KWR1 是抬头，不编号（内核报错按“KWR1 下面的第 N 行”）。 */
export function numberedCodeLines(code: string): { no: number | null; text: string }[] {
  const rows = code.split("\n").filter(Boolean);
  return rows.map((text, i) => ({ no: i === 0 ? null : i, text }));
}

function useRecoveryBackup(onChanged?: () => void) {
  const [st, setSt] = useState<any | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyByButton, setVerifyByButton] = useState(false);
  const [devPath, setDevPath] = useState("");
  const [syncNote, setSyncNote] = useState(false);
  const [placeNote, setPlaceNote] = useState<"" | "local" | "sync">("");
  const dialogs = recovery.hasDialogs();
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const load = () => recovery.backupStatus().then(setSt).catch(() => setSt(null));
  useEffect(() => {
    void load();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg("");
    // 备份可能要很久：进行中每 2 秒刷新一次进度
    poll.current = setInterval(() => void load(), 2000);
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      if (poll.current) clearInterval(poll.current);
      poll.current = null;
      setBusy(false);
      void load();
      onChanged?.();
    }
  };

  const create = () =>
    run(async () => {
      const target = dialogs ? await recovery.pickPackageSave() : null;
      if (dialogs && !target) throw new Error("没有选择保存位置");
      const path = dialogs ? devPath : askDevPath("恢复包保存到哪个文件（完整路径）", devPath, setDevPath);
      const r = await recovery.createPackage(target ? { save_handle: target.handle } : { path });
      setCreated({ code: r.code_text, setId: String(r.set_id ?? ""), firmName: String(r.firm_name ?? ""), createdAt: String(r.created_at ?? ""), founder: !!r.includes_firm_root });
      setCopied(false);
      setPlaceNote(target?.risk === "onedrive" || target?.risk === "cloud" ? "sync" : "local");
      setVerifyOpen(true);
    }, "恢复包已保存。请马上抄下或打印下面的恢复码——离开这一页就再也看不到了。然后在下面“试一下”。");

  const verify = () =>
    run(async () => {
      const f = dialogs ? await recovery.pickPackageFile() : null;
      if (dialogs && !f) throw new Error("没有选择恢复包");
      const r = await recovery.verifyPackage(f ? { file_handle: f.handle, code: verifyCode } : { file: dialogs ? devPath : askDevPath("恢复包文件（完整路径）", devPath, setDevPath), code: verifyCode });
      if (!r.same_device) throw new Error("这份恢复包能打开，但不是这台电脑的");
    }, "试过了：恢复包和恢复码都能用。");

  const chooseFolder = () =>
    run(async () => {
      const f = dialogs ? await recovery.pickFolder() : null;
      if (dialogs && !f) throw new Error("没有选择备份位置");
      await recovery.configureBackup(f ? { folder_handle: f.handle } : { dir: dialogs ? devPath : askDevPath("备份文件夹（完整路径）", devPath, setDevPath) });
      await recovery.runBackup();
      // 同步盘、网络位置：内容与文件名都是加密的，网盘服务商只看得到文件数量、大小与时间——如实告知
      if (f?.risk === "onedrive" || f?.risk === "cloud" || f?.risk === "network") setSyncNote(true);
    }, "备份位置已设好，并已完成第一次备份。之后每天自动备份一次。");

  const runNow = () => run(() => recovery.runBackup(), "已备份");

  return { st, created, setCreated, copied, setCopied, msg, busy, verifyCode, setVerifyCode, verifyOpen, setVerifyOpen, verifyByButton, setVerifyByButton, devPath, setDevPath, syncNote, placeNote, dialogs, create, verify, chooseFolder, runNow };
}
type Rb = ReturnType<typeof useRecoveryBackup>;

/**
 * 网页开发形态没有系统对话框（第 71 批，区域 1）：原先在三张步骤卡下面常驻一个“文件位置（恢复包文件或备份文件夹）”输入框，
 * 与卡片脱节、正式包里也没有；改成点按钮时问一次路径（记住上次填的）。正式客户端走系统对话框，不经这里。
 */
function askDevPath(question: string, last: string, remember: (v: string) => void): string {
  // 设置页的备份卡在网页形态有自己的路径输入框（BackupTrack）：填过就用它，不再问
  if (last.trim()) return last.trim();
  const v = typeof window !== "undefined" && typeof window.prompt === "function" ? window.prompt(`${question}（网页开发形态没有系统对话框）`, last) : last;
  if (!v || !v.trim()) throw new Error("没有选择位置");
  remember(v.trim());
  return v.trim();
}

/** 刚生成的恢复码（只显示这一次）：可打印；勾“我已抄下或打印好”才能收起。 */
function CreatedCard({ rb }: { rb: Rb }) {
  const { created, placeNote, copied, setCopied, setCreated } = rb;
  if (!created) return null;
  return (
    <div className="card recovery-print" role="status">
      <div className="recovery-print-head">
        Kimi Work 恢复码 · {created.firmName} · 生成于 {fmtTime(created.createdAt)} · 配对编号 {created.setId.slice(0, 8)}
      </div>
      <div className="no-print">恢复码（只显示这一次；请手抄或打印，不要复制粘贴、拍照或发微信）：</div>
      <ol className="members-code recovery-code" aria-label="恢复码">
        {numberedCodeLines(created.code).map((l, i) => (
          <li key={i} className="recovery-line">
            <span className="recovery-no">{l.no === null ? "" : `${l.no}.`}</span> {l.text}
          </li>
        ))}
      </ol>
      {created.founder && (
        <p className="banner banner-orange">
          这台是开通律所的电脑：这份恢复包里还有律所的管理钥匙（能以管理员身份加人、解开全所托管的事项），丢失的后果不止这台电脑——请按律所公章同等保管。
        </p>
      )}
      {placeNote === "local" && <p className="muted no-print">恢复包如果存在这台电脑上（例如“文档”），电脑坏了它也会一起丢：请把它复制到 U 盘，或交给律所负责人保管。</p>}
      {placeNote === "sync" && <p className="muted no-print">恢复包会同步到网盘（是加密的，网盘看不到内容）；恢复码就更不要放在网盘里了。</p>}
      <div className="settings-choice no-print">
        <button className="btn-ghost btn-sm" onClick={() => window.print()}>
          打印
        </button>
        <label>
          <input type="checkbox" checked={copied} onChange={(e) => setCopied(e.target.checked)} /> 我已抄下或打印好
        </label>
        <button className="btn-ghost btn-sm" disabled={!copied} onClick={() => setCreated(null)}>
          收起
        </button>
      </div>
    </div>
  );
}

/** 试一下：输入恢复码，选恢复包打开一次。 */
function VerifyPanel({ rb, bare = false }: { rb: Rb; bare?: boolean }) {
  const { busy, verifyCode, setVerifyCode, verifyByButton, setVerifyOpen, setVerifyByButton, verify } = rb;
  return (
    <section className={bare ? "recovery-verify bk-verify" : "panel recovery-verify"} aria-label="试一下恢复包">
      <label className="field">
        <span>恢复码（打印纸上的全部内容，含第一行）</span>
        <textarea rows={4} value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} spellCheck={false} placeholder="KWR1-…" autoFocus={verifyByButton} />
      </label>
      <div className="settings-choice">
        <button className="btn-primary btn-sm" disabled={busy || verifyCode.trim().length < 10} onClick={() => void verify()}>
          选择恢复包，打开试试
        </button>
        {!bare && (
          <button className="btn-ghost btn-sm" onClick={() => { setVerifyOpen(false); setVerifyByButton(false); }}>
            收起
          </button>
        )}
      </div>
    </section>
  );
}

function Running({ st }: { st: any }) {
  const running = st?.running as { done: number; total: number } | null | undefined;
  if (!running) return null;
  /* 备份进行中（第 51 批统一等待块）：有总数才写“已处理 n/m 个文件”，没有就写“正在准备”，不画假进度 */
  return <WaitBlock title={countProgress(running.done, running.total) ? `正在备份：已处理 ${countProgress(running.done, running.total)!.text} 个文件` : "正在准备备份…"} hint="可以继续工作，请不要拔出备份用的移动硬盘。" />;
}

/** 首次使用引导（Welcome）里的三格呈现（原样保留）。 */
export function RecoveryBackup({ onChanged, footer }: { onChanged?: () => void; footer?: ReactNode } = {}) {
  const rb = useRecoveryBackup(onChanged);
  const { st, busy, msg, syncNote, verifyOpen, setVerifyOpen, setVerifyByButton, create, chooseFolder, runNow } = rb;
  const days = typeof st?.stale_days === "number" ? st.stale_days : null;
  const step1 = !!st?.packages_created;
  const step2 = !!st?.packages_verified;
  const step3 = !!st?.configured && !!st?.last_ok_at;
  return (
    <div className="recovery" id="recovery-backup">
      {/* v9.4：三步走（生成恢复包 → 试一下 → 每天自动备份），每步一句话说明，做完打勾；长说明收成一句提示 */}
      {st?.revoked && <div className="banner banner-red">这台电脑已从账号移除：不能再备份或生成恢复包。</div>}
      <ol className="steps3">
        <li className={step1 ? "done" : ""}>
          <div className="steps3-head">
            <span className="steps3-no" aria-hidden="true">{step1 ? "✓" : "1"}</span>
            <b>生成恢复包</b>
          </div>
          <p className="muted">电脑坏了或丢了，用它在新电脑上找回全部案卷。{step1 ? `已生成 ${st.packages_created} 次。` : ""}</p>
          <button className={step1 ? "btn-ghost btn-sm" : "btn-primary btn-sm"} disabled={busy || st?.revoked} onClick={() => void create()}>
            {step1 ? "再生成一份" : "生成恢复包"}
          </button>
        </li>
        <li className={step2 ? "done" : ""}>
          <div className="steps3-head">
            <span className="steps3-no" aria-hidden="true">{step2 ? "✓" : "2"}</span>
            <b>试一下</b>
          </div>
          <p className="muted">
            用恢复码打开一次恢复包，确认真的能用。{step2 ? `已试过 ${st.packages_verified} 次。` : ""}
            {/* 禁用要说原因（U2 §1.4）；第 71 批：写在说明里，按钮与另两张卡一样贴卡底 */}
            {!step1 && <span className="steps3-why">生成恢复包后才能试。</span>}
          </p>
          {/* 复核 Q8-10：只有律师点这个按钮打开时才把焦点放进输入框；生成恢复包后自动展开时不抢焦点（不越过只显示一次的恢复码与警告） */}
          <button className="btn-ghost btn-sm" disabled={busy || !step1} onClick={() => { setVerifyByButton(true); setVerifyOpen(true); }}>
            试一下
          </button>
        </li>
        <li className={step3 ? "done" : ""}>
          <div className="steps3-head">
            <span className="steps3-no" aria-hidden="true">{step3 ? "✓" : "3"}</span>
            <b>每天自动备份</b>
          </div>
          <p className="muted">
            {st?.configured
              ? st.last_ok_at
                ? `最近一次 ${fmtTime(st.last_ok_at)}${days !== null && days >= 3 ? `（已 ${days} 天没有成功）` : ""}`
                : "还没有成功过"
              : "备份到移动硬盘或所内共享盘，内容加密。"}
            {st?.last_error === "location_changed" ? "备份盘不是原来那块：请插回原来的备份盘，或重新选择。" : st?.last_error ? "上次没有成功，请检查备份位置是否插好、空间是否够。" : ""}
          </p>
          <div className="settings-choice">
            <button className={st?.configured || !step1 ? "btn-ghost btn-sm" : "btn-primary btn-sm"} disabled={busy || st?.revoked} onClick={() => void chooseFolder()}>
              {st?.configured ? "更换位置…" : "选择位置…"}
            </button>
            {st?.configured && (
              <button className="btn-ghost btn-sm" disabled={busy || st?.revoked} onClick={() => void runNow()}>
                立即备份
              </button>
            )}
          </div>
        </li>
      </ol>
      <Running st={st} />
      <p className="muted recovery-tip">恢复包和恢复码要分开放：例如恢复包放 U 盘，恢复码打印后锁进柜子。第一次备份要复制全部案卷，可能较慢。</p>
      {(st?.recent_packages?.length ?? 0) > 1 && (
        <p className="muted">
          以前生成的恢复包仍然有效（最近几次：{(st.recent_packages as string[]).map((t) => fmtTime(t)).join("、")}）。不用的那份请销毁；丢了请告诉所内 IT。
        </p>
      )}
      <CreatedCard rb={rb} />
      {/* 只留一个“试一下”入口（第 27 批，评审 U3-34）：第 2 步的按钮点开这里；原来下方还常驻一个同名折叠，展开是空文本框 */}
      {verifyOpen && <VerifyPanel rb={rb} />}
      {msg && <p className="muted" role="status">{msg}</p>}
      {syncNote && <p className="muted">提示：这个备份位置会同步到网盘或网络存储。备份的内容与文件名都是加密的，对方只看得到文件数量、大小与备份时间。</p>}
      {footer}
    </div>
  );
}

const TONE_DOT: Record<string, string> = { ok: "sdot-ok", warn: "sdot-warn", bad: "sdot-bad", info: "sdot-idle" };

/**
 * 设置 → 备份与安全（第 56 批）：页首一条状态（结论 + 后果 | 唯一的下一步按钮）+ 一行安静的案卷保护说明 + 纵向三步。
 * 页首按钮与该步里的按钮做同一件事。浏览器形态（没有系统对话框）时，“文件位置”输入框只出现在需要它的那一步里。
 */
export function BackupTrack({ safe, onChanged }: { safe: { tone: "ok" | "warn" | "info"; line: string }; onChanged?: () => void }) {
  const rb = useRecoveryBackup(onChanged);
  const { st, busy, msg, devPath, setDevPath, syncNote, dialogs, create, chooseFolder, runNow, setVerifyOpen, setVerifyByButton } = rb;
  const plan = backupPlan(st);
  const [open, setOpen] = useState<"create" | "verify" | "auto" | null>(null);
  const pathRef = useRef<HTMLInputElement | null>(null);
  const revoked = !!st?.revoked;
  // 浏览器形态要先填文件位置：空着点按钮时把焦点放进输入框，不发一个必然失败的请求
  const needPath = (key: "create" | "verify" | "auto") => {
    if (dialogs || devPath.trim()) return false;
    setOpen(key);
    window.setTimeout(() => pathRef.current?.focus(), 0);
    return true;
  };
  const doAction = (kind: "create" | "verify" | "folder" | "run") => {
    if (kind === "create") return needPath("create") || void create();
    if (kind === "verify") {
      setOpen("verify");
      setVerifyByButton(true);
      setVerifyOpen(true);
      return;
    }
    if (kind === "folder") return needPath("auto") || void chooseFolder();
    return void runNow();
  };
  const isOpen = (key: "create" | "verify" | "auto", state: StepState) => state === "now" || open === key;
  const pathField = (hint: string) =>
    dialogs ? null : (
      <label className="field bk-path">
        <span>{hint}</span>
        <input ref={pathRef} value={devPath} onChange={(e) => setDevPath(e.target.value)} placeholder="例如 /Volumes/U盘/Kimi Work" />
      </label>
    );
  const [s1, s2, s3] = plan.steps.length ? plan.steps : [null, null, null];
  return (
    <div className="bk" id="recovery-backup">
      <section className={`bk-status bk-status-${plan.tone}`} aria-live="polite">
        <div className="bk-status-text">
          <div className="bk-status-h">
            <span className={`sdot ${TONE_DOT[plan.tone]}`} aria-hidden="true" />
            {plan.headline}
          </div>
          {plan.consequence && <p className="bk-status-why">{plan.consequence}</p>}
        </div>
        {plan.action && (
          <button className="btn-primary" disabled={busy || revoked} onClick={() => doAction(plan.action!.kind)}>
            {plan.action.label}
          </button>
        )}
      </section>
      <p className="bk-safe">
        <span className={`sdot ${safe.tone === "ok" ? "sdot-ok" : safe.tone === "warn" ? "sdot-warn" : "sdot-idle"}`} aria-hidden="true" />
        {safe.line}
      </p>

      <Running st={st} />
      {/* 刚生成的恢复码只显示这一次：紧跟在状态下面，不让它落到页底被错过 */}
      {msg && (
        <p className="bk-msg" role="status">
          {msg}
        </p>
      )}
      <CreatedCard rb={rb} />

      {s1 && s2 && s3 && (
        <ol className="bk-track" aria-label="备份三步">
          <TrackStep
            no={1}
            title="生成恢复包"
            state={s1.state}
            summary={s1.summary}
            open={isOpen("create", s1.state)}
            onReopen={() => setOpen(open === "create" ? null : "create")}
            reopenLabel="重新生成"
          >
            <p>电脑坏了或丢了，用恢复包和恢复码在新电脑上找回全部案卷。</p>
            <p className="bk-note">恢复包和恢复码要分开放：例如恢复包放 U 盘，恢复码打印后锁进柜子。</p>
            {pathField("恢复包保存到哪里（文件路径）")}
            <div className="bk-actions">
              <button className={s1.state === "done" ? "btn-ghost btn-sm" : "btn-primary btn-sm"} disabled={busy || revoked} onClick={() => doAction("create")}>
                {s1.state === "done" ? "再生成一份" : "生成恢复包"}
              </button>
            </div>
            {(st?.recent_packages?.length ?? 0) > 1 && (
              <p className="bk-note">以前生成的恢复包仍然有效（最近几次：{(st.recent_packages as string[]).map((t) => fmtTime(t)).join("、")}）。不用的那份请销毁；丢了请告诉所内 IT。</p>
            )}
          </TrackStep>
          <TrackStep no={2} title="试着恢复一次" state={s2.state} summary={s2.summary} why="先完成上一步" open={isOpen("verify", s2.state) || rb.verifyOpen} onReopen={() => setOpen(open === "verify" ? null : "verify")} reopenLabel="再试一次">
            <p>用恢复码打开一次恢复包，确认真的能用——不会改动这台电脑上的任何东西。</p>
            {pathField("恢复包文件在哪里（文件路径）")}
            <VerifyPanel rb={rb} bare />
          </TrackStep>
          <TrackStep no={3} title="每天自动备份" state={s3.state} summary={s3.summary} why="先完成上一步" open={isOpen("auto", s3.state)} onReopen={() => setOpen(open === "auto" ? null : "auto")} reopenLabel="修改">
            <p>每天把案卷加密备份到移动硬盘或所内共享盘。第一次要复制全部案卷，可能较慢。</p>
            {pathField("备份到哪个文件夹（文件夹路径）")}
            <div className="bk-actions">
              <button className={st?.configured ? "btn-ghost btn-sm" : "btn-primary btn-sm"} disabled={busy || revoked} onClick={() => doAction("folder")}>
                {st?.configured ? "更换位置" : "选择备份位置"}
              </button>
              {st?.configured && (
                <button className="btn-ghost btn-sm" disabled={busy || revoked} onClick={() => void runNow()}>
                  立即备份
                </button>
              )}
            </div>
          </TrackStep>
        </ol>
      )}
      {syncNote && <p className="bk-note">提示：这个备份位置会同步到网盘或网络存储。备份的内容与文件名都是加密的，对方只看得到文件数量、大小与备份时间。</p>}
    </div>
  );
}

/** 轨道上的一步：节点（做完打勾 / 当前醒目 / 没轮到空心）+ 标题；当前一步展开，做完的收成一行可再展开，没轮到的置灰写原因。 */
function TrackStep(props: { no: number; title: string; state: StepState; summary: string; why?: string; open: boolean; onReopen: () => void; reopenLabel: string; children: ReactNode }) {
  const { no, title, state, summary, why, open, onReopen, reopenLabel, children } = props;
  const expanded = state !== "todo" && open;
  return (
    <li className={`bk-step bk-${state}${expanded ? " is-open" : ""}`} aria-current={state === "now" ? "step" : undefined}>
      <span className="bk-node" aria-hidden="true">
        {state === "done" ? <Icon.check /> : no}
      </span>
      <div className="bk-step-body">
        <div className="bk-step-head">
          <span className="bk-step-title">{title}</span>
          {state === "done" && summary && <span className="bk-step-sum">{summary}</span>}
          {state === "now" && summary && <span className="bk-step-sum bk-step-sum-warn">{summary}</span>}
          {state === "todo" && <span className="bk-step-sum">{why ?? "先完成上一步"}</span>}
          {state === "done" && (
            <button className="btn-link bk-step-toggle" aria-expanded={expanded} onClick={onReopen}>
              {expanded ? "收起" : reopenLabel}
            </button>
          )}
        </div>
        {expanded && <div className="bk-step-detail">{children}</div>}
      </div>
    </li>
  );
}
