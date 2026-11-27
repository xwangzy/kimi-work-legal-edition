/**
 * 第 72 批（V46，D-305，契约 02 §3.1、§3.3、§3.4）：律师层的工作空间与团队界面。
 * - WorkspaceSection（设置 · 账号）：当前工作空间；个人空间“把工作室升级为团队”（二次确认写清后果、不可撤回）；“加入团队”（输入邀请码）。
 * - TeamHeader（设置 · 团队，所有成员）：团队名称、我的角色、AI 使用名额与用量摘要（只读）、“事项内容只在成员电脑”。
 * - LeaveTeam（设置 · 团队，所有成员）：“退出团队”先引导到离所交接（Offboarding），再确认；结果交给切换流程（切回个人空间或另一工作空间）。
 * 四个动作分清：退出登录（这台电脑暂停用 AI）/ 移除电脑 / 移出团队（管理员做）/ 退出团队（自己做）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, members, workspaces, type QuotaStatus } from "../api.ts";
import { nav } from "../App.tsx";
import { fmtPct } from "../lib/firm-usage.ts";
import { offboardingSummary } from "../lib/offboarding.ts";
import { personalView } from "../lib/personal-usage.ts";
import { formatInviteCode, inviteCodeComplete, KIND_LABEL, leaveLines, teamErrorText, teamNameOk, upgradeLines, workspaceRoleTag, WS_ROLE_LABEL } from "../lib/workspace.ts";
import { Icon } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { notifyWorkspaceChanged, useSwitchFlow, type WorkspaceState } from "./WorkspaceSwitch.tsx";

/** 侧栏菜单“加入团队…”：到设置 · 账号并把光标放进邀请码框。 */
const JOIN_EVENT = "kwl:join-team";
let joinPending = false;
export function openJoinTeam(): void {
  joinPending = true;
  nav("/connections/account");
  window.dispatchEvent(new Event(JOIN_EVENT));
}
/** 退出团队前“去交接”：展开离所交接（Offboarding 监听这个事件）。 */
export const OPEN_OFFBOARDING = "kwl:open-offboarding";

/** 工作空间名牌：方形首字 + 名称 + 类型 + （团队）角色。 */
export function WorkspacePlate({ name, kind, role, sub }: { name: string; kind: "personal" | "team"; role?: string | null; sub?: ReactNode }) {
  return (
    <div className="ws-plate">
      <span className={`ws-mark ws-mark-${kind}`} aria-hidden="true">
        {kind === "team" ? Icon.users() : (name.trim() || "我").slice(0, 1)}
      </span>
      <span className="ws-plate-text">
        <span className="ws-plate-name">
          <b>{name}</b>
          <span className={`ws-kind ws-kind-${kind}`}>{KIND_LABEL[kind]}</span>
          {role && <span className="ws-role">{role}</span>}
        </span>
        {sub && <small>{sub}</small>}
      </span>
    </div>
  );
}

/** 设置 · 账号 · 工作空间。云端不支持（旧云端、闸门未放行）时不显示。 */
export function WorkspaceSection({ ws }: { ws: WorkspaceState }) {
  const [upgrading, setUpgrading] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const cur = ws.list?.current ?? null;
  if (!ws.list?.supported || !cur) return null;
  const others = (ws.list.workspaces ?? []).filter((w) => !w.current && w.status === "active");
  return (
    <section className="panel device-section ws-section" aria-labelledby="sec-ws">
      <h2 className="section-h h-section" id="sec-ws">
        工作空间
      </h2>
      {done && (
        <div className="ws-done" role="status">
          {Icon.check()}
          <span>{done}</span>
          <button className="btn-link" onClick={() => nav("/connections/team")}>
            去邀请同事 →
          </button>
        </div>
      )}
      <SettingRow label="当前">
        <WorkspacePlate
          name={cur.name}
          kind={cur.kind}
          role={workspaceRoleTag(cur)}
          sub={cur.kind === "personal" ? "只有你一个人；事项、材料和成果都在你的电脑上。" : "团队空间：事项内容只在成员各自的电脑上。"}
        />
        {others.length > 0 && <div className="muted">你还在另外 {others.length} 个工作空间里：点侧栏底部你的名字即可切换。</div>}
      </SettingRow>
      {ws.features.upgrade && (
        <SettingRow label="升级为团队" hint="同事要和你一起办案时，把这间工作室升级为团队，再邀请他们加入。">
          <div>
            <button className="btn-ghost btn-sm" onClick={() => setUpgrading(true)}>
              {Icon.users()} 把工作室升级为团队…
            </button>
          </div>
        </SettingRow>
      )}
      <SettingRow label="加入团队" hint="向团队管理员要 16 位邀请码。加入后你会多一个团队空间；现在这个空间里的事项不会带过去，团队也看不到。">
        <JoinTeam />
      </SettingRow>
      {upgrading && (
        <UpgradeDialog
          initial={cur.name}
          onClose={() => setUpgrading(false)}
          onDone={(name) => {
            setUpgrading(false);
            setDone(`已升级为团队「${name}」。现在可以在“设置 · 团队”里邀请同事。`);
            notifyWorkspaceChanged();
          }}
        />
      )}
    </section>
  );
}

/** 升级为团队的二次确认：名称 + 后果清单 + “我知道不能撤回”。 */
function UpgradeDialog({ initial, onClose, onDone }: { initial: string; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState(initial);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ok = teamNameOk(name);
  const submit = async () => {
    if (!ok || !ack || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await workspaces.upgrade(name.replace(/\s+/g, " ").trim());
      if (r.supported === false) throw new Error("云端暂时不支持升级为团队：请稍后重试，或联系中软客服");
      onDone(r.workspace?.name ?? name.trim());
    } catch (e) {
      setErr(teamErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="把工作室升级为团队" onClose={onClose}>
      <form
        className="ws-upgrade"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>团队名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus placeholder="例如：某某律师事务所" />
          {name.trim() && !ok && <span className="field-warn">团队名称须为 2～40 个字</span>}
        </label>
        <ul className="team-lines is-check">
          {upgradeLines(name).map((l, i) => (
            <li key={i} className={i === 3 ? "is-warn" : undefined}>
              {l}
            </li>
          ))}
        </ul>
        <label className="team-ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 我知道升级后不能撤回
        </label>
        {err && (
          <p className="activate-error" role="alert">
            {err}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn-primary btn-sm" disabled={!ok || !ack || busy}>
            {busy ? "正在升级…" : "升级为团队"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 加入团队：邀请码按 4 位一组自动加横线；加入后切到新的团队空间（同一条切换流程）。 */
function JoinTeam() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const flow = useSwitchFlow();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = () => {
      joinPending = false;
      setTimeout(() => {
        ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
        ref.current?.focus();
      }, 60);
    };
    if (joinPending) focus();
    window.addEventListener(JOIN_EVENT, focus);
    return () => window.removeEventListener(JOIN_EVENT, focus);
  }, []);
  const ready = inviteCodeComplete(code);
  const join = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const o = await flow.run(() => workspaces.join(code), "团队空间");
    if (o === "unsupported") flow.clearError();
    setBusy(false);
  };
  return (
    <>
    <form
      className="ws-join"
      onSubmit={(e) => {
        e.preventDefault();
        void join();
      }}
    >
      <span className="ws-join-row">
        <input
          ref={ref}
          className="mono ws-join-input"
          value={code}
          onChange={(e) => (flow.clearError(), setCode(formatInviteCode(e.target.value)))}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          aria-label="团队邀请码"
          autoComplete="off"
          spellCheck={false}
          maxLength={19}
        />
        <button type="submit" className="btn-primary btn-sm" disabled={!ready || busy}>
          {busy ? "正在加入…" : "加入"}
        </button>
      </span>
      {flow.error && (
        <span className="activate-error" role="alert">
          {flow.error}
        </span>
      )}
    </form>
    {flow.view}
    </>
  );
}

/** 设置 · 团队的页首：团队名称、我的角色、名额与用量（只读）。children 放本所识别码等折叠项。 */
export function TeamHeader({ ws, children }: { ws: WorkspaceState; children?: ReactNode }) {
  const [q, setQ] = useState<QuotaStatus | null>(null);
  useEffect(() => {
    api.quotaStatus().then(setQ).catch(() => setQ(null));
  }, []);
  const cur = ws.list?.current ?? null;
  const name = cur?.name ?? "本团队";
  const role = ws.role ? WS_ROLE_LABEL[ws.role] : null;
  const firm = q?.mode === "control_plane" ? q.firm : null;
  const mine = q && q.mode === "control_plane" && q.firm ? personalView(q).used : null;
  const stats: { k: string; v: string }[] = [
    // 管理员与合伙人在下面的成员一节看到“席位 n / N 已分配”，这里不重复
    ...(firm && Number.isFinite(firm.seats) && !ws.features.teamRead ? [{ k: "AI 使用名额", v: `${firm.seats} 个` }] : []),
    ...(firm ? [{ k: "团队本期已用", v: fmtPct(firm.used_ratio) }] : []),
    ...(mine !== null ? [{ k: "你本期已用", v: fmtPct(mine) }] : []),
    ...(q?.plan?.label ? [{ k: "套餐", v: q.plan.label }] : []),
  ];
  return (
    <section className="panel device-section team-head" aria-labelledby="sec-team-head">
      <h2 className="sr-only" id="sec-team-head">
        团队
      </h2>
      <WorkspacePlate name={name} kind="team" role={role} sub={cur?.local_profile === false ? null : "这台电脑上的团队空间：团队事项与个人事项分开保存。"} />
      {stats.length > 0 && (
        <dl className="team-stats">
          {stats.map((s) => (
            <div key={s.k}>
              <dt>{s.k}</dt>
              <dd>{s.v}</dd>
            </div>
          ))}
        </dl>
      )}
      {/* 管理员与合伙人在成员一节的页首看到同一句，这里不重复 */}
      {!ws.features.teamRead && (
        <p className="team-privacy" role="note">
          {Icon.lock()}
          <span>事项内容只在成员各自的电脑上，管理员看不到。要和同事一起办，在事项里开启团队共享。</span>
        </p>
      )}
      {children}
    </section>
  );
}

/** 退出团队：先说明会进入离所交接，引导去交接；确认后切回另一个工作空间。 */
export function LeaveTeam({ ws }: { ws: WorkspaceState }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const flow = useSwitchFlow();
  const cur = ws.list?.current ?? null;
  if (!ws.list?.supported || !cur || cur.kind !== "team") return null;
  const back = (ws.list.workspaces ?? []).find((w) => !w.current && w.status === "active") ?? null;
  const show = () => {
    setOpen(true);
    setAck(false);
    flow.clearError();
    members
      .offboarding()
      .then((d) => setSummary(offboardingSummary(d)))
      .catch(() => setSummary(null));
  };
  const leave = async () => {
    setBusy(true);
    const o = await flow.run(() => workspaces.leave(), back?.name ?? null);
    setBusy(false);
    if (o === "none" || o === "same") setOpen(false);
  };
  // 与上面的“团队共享”“离所交接”同一种行（device-row），标签与内容列对齐
  return (
    <div className="device-row leave-row">
      <div className="device-k">退出团队</div>
      <div>
        <div className="muted">{back ? `离开「${cur.name}」。退出前先在上面的“离所交接”里把你负责的事项交接好。` : ws.role === "admin" ? "这是你唯一的工作空间，你也是这个团队的管理员，不能退出。" : "这是你唯一的工作空间：要离开，请团队管理员把你移出。"}</div>
        {back && (
          <button className="btn-ghost btn-danger btn-sm" onClick={show}>
            退出团队…
          </button>
        )}
      </div>
      {open && (
        <Modal title={`退出「${cur.name}」？`} onClose={() => setOpen(false)}>
          <div className="leave-step">
            <span className="leave-no">1</span>
            <div>
              <b>先交接你负责的事项</b>
              <p className="muted">{summary ?? "正在查看你负责的事项…"}</p>
              <button
                className="btn-link"
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(new Event(OPEN_OFFBOARDING));
                }}
              >
                去离所交接 →
              </button>
            </div>
          </div>
          <div className="leave-step">
            <span className="leave-no">2</span>
            <div>
              <b>再退出团队</b>
              <ul className="team-lines">
                {leaveLines(cur.name, back?.name ?? null).map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          </div>
          <label className="team-ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 我负责的事项已交接好（或没有要交接的）
          </label>
          {flow.error && (
            <p className="activate-error" role="alert">
              {flow.error}
            </p>
          )}
          <div className="modal-actions">
            <button className="btn-ghost btn-sm" autoFocus onClick={() => setOpen(false)}>
              取消
            </button>
            <button className="btn-danger-solid btn-sm" disabled={!ack || busy} onClick={() => void leave()}>
              {busy ? "正在退出…" : "退出团队"}
            </button>
          </div>
        </Modal>
      )}
      {flow.view}
    </div>
  );
}
