/**
 * 设置 → 管理 → 成员（第 13 批开通与成员入组；只有管理员能用，控制面同样核对）。
 * 邀请：填姓名与角色 → 生成一次性邀请码（只显示这一次）→ 经微信或当面交给同事。
 * 批准：同事在新装的客户端输入邀请码后，这里出现待批准申请；请对方念出他屏幕上的 12 位数字，与这里一致再批准。
 */
import { useEffect, useState } from "react";
import { members, type RosterMember } from "../api.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { fmtTime } from "../lib/labels.ts";
import { memberLabel, memberStatusText, removalLines } from "../lib/offboarding.ts";
import { Select } from "./Select.tsx";
import { joinHelpText, twelveDigits, upgradeTitle } from "../lib/team-admin.ts";
import { notifyDataChanged } from "../lib/events.ts";

/** 行内操作：成功写一句结果并刷新（侧栏“有 n 台电脑等你确认”随即重取，复测 N1）；失败时有 onErr 的写在出错那一行（复测 N6），否则写在表下。 */
type RowAct = (fn: () => Promise<unknown>, ok: string, onErr?: (message: string) => void) => Promise<void>;

const ROLES: [string, string][] = [
  ["lawyer", "律师"],
  ["partner", "合伙人"],
  ["assistant", "助理"],
  ["admin", "管理员"],
];
const ROLE_LABEL = Object.fromEntries(ROLES);
const STATUS_LABEL: Record<string, string> = { open: "未使用", claimed: "对方已输入，等你批准", consumed: "已加入", revoked: "已作废", expired: "已过期" };

export function MembersAdmin() {
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("lawyer");
  const [issued, setIssued] = useState<{ code: string; name: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () =>
    members
      .list()
      .then((d) => {
        setData(d);
        setErr("");
      })
      .catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, []);
  const invite = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await members.invite(name.trim(), role);
      setIssued({ code: r.code, name: r.member?.name ?? name.trim(), expires_at: r.expires_at });
      setName("");
      void load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act: RowAct = async (fn, ok, onErr) => {
    setMsg("");
    try {
      await fn();
      setMsg(ok);
      notifyDataChanged();
      void load();
    } catch (e) {
      if (onErr) onErr((e as Error).message);
      else setMsg((e as Error).message);
    }
  };
  if (err && !data) {
    return (
      <div className="panel">
        <p className="muted">{err}</p>
      </div>
    );
  }
  const requests: any[] = data?.join_requests ?? [];
  const invitations: any[] = data?.invitations ?? [];
  return (
    <div className="device">
      {/* 第 56 批：没有申请时不占一张空卡；有申请时排在最前（管理员来这页最急的事） */}
      {requests.length > 0 && (
        <div className="panel">
          <div className="section-title">等你批准（{requests.length}）</div>
          <JoinRequestTable requests={requests} act={act} />
        </div>
      )}

      <div className="panel">
        <div className="section-title">邀请同事</div>
        <p className="muted">对方在新装的 Kimi Work 里输入邀请码；你在下面核对他屏幕上的数字后批准，他就能开始使用。</p>
        <form
          className="settings-choice"
          onSubmit={(e) => {
            e.preventDefault();
            void invite();
          }}
        >
          <label className="field">
            <span>姓名</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：张律师" maxLength={40} />
          </label>
          <label className="field">
            <span>角色</span>
            <Select aria-label="角色" value={role} onChange={setRole} options={ROLES.map(([k, l]) => ({ value: k, label: l }))} />
          </label>
          <button type="submit" className="btn-primary" disabled={!name.trim() || busy}>
            {busy ? "正在生成…" : "生成邀请码"}
          </button>
        </form>
        {issued && (
          <div className="card" role="status">
            <div>
              给 {issued.name} 的邀请码（只显示这一次）：
            </div>
            <div className="members-code">{issued.code}</div>
            <div className="card-actions">
              <button className="btn-ghost btn-sm" onClick={() => void navigator.clipboard?.writeText(issued.code).then(() => setMsg("已复制"))}>
                复制
              </button>
            </div>
            <p className="muted">{fmtTime(issued.expires_at)} 前有效，只能用一次。请发给对方：他在自己的电脑上安装 Kimi Work 后输入这个码，然后会打电话把屏幕上的入组核对码读给你，你在“等你批准”里核对后批准。</p>
          </div>
        )}
        {msg && <p className="muted">{msg}</p>}
      </div>

      <MemberRoster />

      <div className="panel">
        <div className="section-title">发出的邀请</div>
        {invitations.length === 0 ? (
          <p className="muted">还没有发出邀请。</p>
        ) : (
          <table className="members-table">
            <thead>
              <tr>
                <th>姓名</th>
                <th>角色</th>
                <th>状态</th>
                <th>有效期至</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invitations.map((x) => (
                <tr key={x.activation_id}>
                  <td>{x.name ?? "—"}</td>
                  <td>{ROLE_LABEL[x.role] ?? x.role}</td>
                  <td>{STATUS_LABEL[x.status] ?? x.status}</td>
                  <td>{fmtTime(x.expires_at)}</td>
                  <td>{(x.status === "open" || x.status === "claimed") && <ConfirmButton label="作废" question="作废后这串邀请码不能再用。" onConfirm={() => act(() => members.revokeInvitation(x.activation_id), "已作废")} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data?.firm_check_code && <p className="muted">本所识别码：{data.firm_check_code}（同事加入后，他的“设置 · 团队”里应显示同一串数字）</p>}
      </div>
    </div>
  );
}

/**
 * 入组申请表（第 13 批起）：请对方念出他屏幕上的 12 位入组核对码，与这里一致再批准。
 * 第 72 批（D-304）：团队设置“电脑待确认”与旧云端的完整成员页共用——登录不再等批准，这一步只为让那台电脑能接收团队共享事项。
 */
export function JoinRequestTable({ requests, act }: { requests: any[]; act: RowAct }) {
  // 复测 N5：表头与说明对两种行都成立——入组申请对照这一列显示的号码；接收团队共享事项的申请不显示号码，填进本行的输入框由这台电脑核对
  const hasUpgrade = requests.some((r) => r.kind === "upgrade");
  const hasJoin = requests.some((r) => r.kind !== "upgrade");
  return (
    <>
      <table className="members-table">
        <thead>
          <tr>
            <th>姓名</th>
            <th className="members-nowrap">角色</th>
            <th className="members-nowrap">申请时间</th>
            <th>入组核对码（请对方读出他屏幕上的号码）</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td className="members-name">
                {r.kind === "upgrade" ? upgradeTitle(r) : (r.name ?? (r.via === "account" ? (r.account_email ?? "本所成员") : "（不是在这台电脑上邀请的）"))}
                {/* 第 44 批（D-186）：同一账号的新电脑——没有邀请可对，只能人工核对核对码 */}
                {r.via === "account" && <div className="muted">同一账号的新电脑{r.account_email && r.name ? ` · ${r.account_email}` : ""}</div>}
              </td>
              <td className="members-nowrap">{ROLE_LABEL[r.role] ?? r.role}</td>
              <td className="members-time">{fmtTime(r.requested_at)}</td>
              {/* 第 72 批（补测 D4）：“接收团队共享事项”的行不显示本机算出的核对码（否则照抄即“一致”）——说明、输入框与按钮合在一格（复测 N4：窄屏不溢出） */}
              {r.kind === "upgrade" ? (
                <td colSpan={2}>
                  {r.verified === false ? (
                    <span className="settings-choice">
                      <span className="activate-error">这份申请的电脑编号或角色与成员对不上，不要确认；请拒绝，并联系 Kimi Work 客服</span>
                      <ConfirmButton label="拒绝" question="拒绝这份申请？对方可以重新申请。" confirmLabel="拒绝" onConfirm={() => act(() => members.reject(r.id), "已拒绝")} />
                    </span>
                  ) : (
                    <UpgradeConfirm r={r} act={act} />
                  )}
                </td>
              ) : (
                <>
              <td className="members-check">{r.check_code}</td>
              <td>
                {r.local_invite && r.verified === false ? (
                  <span className="settings-choice">
                    <span className="activate-error">这份申请在传送中被改动过，不要批准；请拒绝并重新发邀请，同时告知 Kimi Work 客服</span>
                    {/* 第 54 批真实联调：原来只有这句提示、没有“拒绝”按钮，管理员照提示做不了 */}
                    <ConfirmButton label="拒绝" question={`拒绝${r.name ? ` ${r.name} ` : ""}的这份申请？他需要新的邀请码才能再次申请。`} confirmLabel="拒绝" onConfirm={() => act(() => members.reject(r.id), "已拒绝")} />
                  </span>
                ) : r.local_invite ? (
                  <span className="settings-choice">
                    <ConfirmButton label="批准" danger={false} className="btn-primary btn-sm" question={r.via === "account" ? `这是${r.name ?? r.account_email ?? "本所成员"}的账号在一台新电脑上申请加入。请先电话或当面联系本人，请他读出新电脑屏幕上的 12 位入组核对码，与这里逐位对照。号码一致吗？` : `请先电话或当面联系${r.name ?? "对方"}，请他读出屏幕上的入组核对码，与这里逐位对照。号码一致吗？`} confirmLabel="已核对一致，批准" onConfirm={() => act(() => members.approve(r.id), `已批准${r.name ? ` ${r.name}` : ""}`)} />
                    <ConfirmButton label="拒绝" question={r.via === "account" ? "拒绝这台新电脑的申请？对方可以重新登录后再申请。" : `拒绝${r.name ? ` ${r.name} ` : ""}的申请？他需要新的邀请码才能再次申请。`} confirmLabel="拒绝" onConfirm={() => act(() => members.reject(r.id), "已拒绝")} />
                  </span>
                ) : (
                  <span className="muted">请在发出邀请的电脑上处理</span>
                )}
              </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        {joinHelpText(hasJoin, hasUpgrade)}
      </p>
    </>
  );
}

/**
 * 第 72 批（U-2b）：确认成员电脑接收团队共享事项——请对方念出他屏幕上的 12 位核对码、在这里输入，逐位一致才能“确认”
 * （内核另行逐位核对，不一致不签发）。
 */
function UpgradeConfirm({ r, act }: { r: any; act: RowAct }) {
  const [typed, setTyped] = useState("");
  // 复测 N6：核对码不一致等原因写在这一行（多行待确认时不串）
  const [rowErr, setRowErr] = useState("");
  // 第 72 批（补测 D4）：界面拿不到本机算出的核对码——填满 12 位即可点“确认”，由内核按本机独立算出的逐位比对（不一致不签发，原因写在下面）
  const typedDigits = typed.replace(/[\s-]/g, "");
  const ready = twelveDigits(typed);
  return (
    <span className="settings-choice members-upgrade">
      <span className="muted members-code-label">请让对方读出他屏幕上的 12 位入组核对码，填在这里：</span>
      {/* 复测 N4：占位写号码的样子（000 000 000 000），说明在左边一列；输入框按 15 个等宽字符留宽 */}
      <input className="members-code-input" inputMode="numeric" maxLength={17} placeholder="000 000 000 000" aria-label="对方读出的 12 位入组核对码" aria-invalid={rowErr ? true : undefined} value={typed} onChange={(e) => {
          setTyped(e.target.value);
          setRowErr("");
        }} />
      <button type="button" className="btn-primary btn-sm" disabled={!ready} onClick={() => void act(() => members.approve(r.id, typedDigits), `已确认${r.name ? ` ${r.name} 的电脑` : ""}：同步后即可接收团队共享事项`, setRowErr)}>
        确认
      </button>
      <ConfirmButton label="拒绝" question="拒绝这份申请？对方可以重新申请。" confirmLabel="拒绝" onConfirm={() => act(() => members.reject(r.id), "已拒绝", setRowErr)} />
      {rowErr && (
        <span className="activate-error members-row-error" role="alert">
          {rowErr}
        </span>
      )}
    </span>
  );
}

/**
 * 第 72 批（D-304）：设置 · 团队 · 电脑待确认（管理员）。成员的新电脑登录后就能正常工作（用 AI、办自己的事项）；
 * 要接收团队共享事项，才需要管理员在这里确认一次（确认动作沿用入组批准：核对对方屏幕上的入组核对码）。没有待确认的电脑时一行说明。
 */
export function PendingDevices() {
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const load = () =>
    members
      .list()
      .then((d) => {
        setData(d);
        setErr("");
      })
      .catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, []);
  const act: RowAct = async (fn, ok, onErr) => {
    setMsg("");
    try {
      await fn();
      setMsg(ok);
      notifyDataChanged();
      void load();
    } catch (e) {
      if (onErr) onErr((e as Error).message);
      else setMsg((e as Error).message);
    }
  };
  const requests: any[] = data?.join_requests ?? [];
  return (
    <div className="team-pending">
      <p className="team-pending-lead">成员的电脑登录后可正常工作；要接收团队共享事项，成员申请后需要你在这里核对入组核对码、确认一次。</p>
      {requests.length > 0 ? (
        <JoinRequestTable requests={requests} act={act} />
      ) : (
        <p className="muted team-empty">{err ? "要在团队开通时用的那台电脑上确认；这台电脑上看不到待确认的电脑。" : data ? "没有待确认的电脑。" : "正在读取…"}</p>
      )}
      {msg && (
        <p className="muted" role="status">
          {msg}
        </p>
      )}
    </div>
  );
}

/**
 * 成员（B-10）：按中软签名的设备目录列出本所成员与他们的电脑。管理员可以停用某一台电脑（丢失、换机），或把人移出律所
 * （停用他的全部电脑、释放席位）。移出前提醒对方先在自己电脑上做“离所交接”——这台电脑看不到他自己的事项。
 */
function MemberRoster() {
  const [data, setData] = useState<{ members: RosterMember[]; can_remove: boolean } | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [asking, setAsking] = useState<{ member: RosterMember; lines: string[]; ack: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    members
      .roster()
      .then((d) => {
        setData(d);
        setErr("");
      })
      .catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
  }, []);
  const ask = async (m: RosterMember) => {
    setMsg("");
    try {
      const p = await members.removalPreview(m.member_id);
      setAsking({ member: m, lines: removalLines({ ...p, name: memberLabel(m) }), ack: false });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const run = async (fn: () => Promise<{ note: string }>) => {
    setBusy(true);
    setMsg("");
    try {
      setMsg((await fn()).note);
      setAsking(null);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      void load();
    }
  };
  if (err && !data) return null;
  const list = data?.members ?? [];
  const active = list.filter((m) => m.status === "active");
  const removed = list.filter((m) => m.status === "removed");
  const row = (m: RosterMember) => {
    const devices = m.devices.filter((d) => d.status === "active");
    return (
      <tr key={m.member_id}>
        <td>{memberLabel(m)}</td>
        <td>{ROLE_LABEL[m.role] ?? m.role}</td>
        <td>{fmtTime(m.joined_at)}</td>
        <td>
          {devices.length === 0 ? "—" : `${devices.length} 台`}
          {devices.length > 0 && (
            <details className="muted">
              <summary>电脑</summary>
              {devices.map((d) => (
                <div key={d.device_id}>
                  {fmtTime(d.created_at)} 加入{d.this_device ? "（这台）" : ""}{" "}
                  {!d.this_device && (
                    <ConfirmButton
                      label="停用这台电脑"
                      className="btn-ghost btn-danger btn-sm"
                      question={`停用后，${m.is_me ? "你的" : `${memberLabel(m)} 的`}这台电脑不能再同步、用 AI、签发或导出（上面已有的内容无法远程删除）；换新电脑需要重新申请加入。`}
                      confirmLabel="停用"
                      disabled={busy}
                      onConfirm={() => run(() => members.revokeDevice(d.device_id))}
                    />
                  )}
                </div>
              ))}
            </details>
          )}
        </td>
        <td>{memberStatusText(m)}</td>
        <td>
          {data?.can_remove && !m.is_me && m.status !== "removed" && (
            <button className="btn-ghost btn-danger btn-sm" disabled={busy} onClick={() => void ask(m)}>
              移出律所…
            </button>
          )}
          {data?.can_remove && m.status === "removed" && m.removal && !m.removal.seat_released && (
            <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => members.remove(m.member_id))}>
              现在再试一次
            </button>
          )}
        </td>
      </tr>
    );
  };
  return (
    <div className="panel">
      <div className="section-title">成员（{active.length}）</div>
      {list.length === 0 ? (
        <p className="muted">还没有取到本所的成员名单（连上中软后自动更新）。</p>
      ) : (
        <table className="members-table">
          <thead>
            <tr>
              <th>姓名</th>
              <th>角色</th>
              <th>加入时间</th>
              <th>在用电脑</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {active.map(row)}
            {removed.map(row)}
          </tbody>
        </table>
      )}
      {asking && (
        <div className="card" role="alertdialog" aria-label={`移出 ${memberLabel(asking.member)}`}>
          <div className="section-title">移出 {memberLabel(asking.member)}？</div>
          {asking.lines.map((l, i) => (
            <p key={i} className={i === 0 ? "" : "muted"}>
              {l}
            </p>
          ))}
          <label>
            <input type="checkbox" checked={asking.ack} onChange={(e) => setAsking({ ...asking, ack: e.target.checked })} /> {memberLabel(asking.member)} 已交接完，或律所决定不再等
          </label>
          <div className="card-actions">
            <button className="btn-ghost btn-danger" disabled={!asking.ack || busy} onClick={() => void run(() => members.remove(asking.member.member_id))}>
              {busy ? "正在移出…" : "移出律所"}
            </button>
            <button className="btn-ghost" onClick={() => setAsking(null)}>
              取消
            </button>
          </div>
        </div>
      )}
      {msg && (
        <p className="muted" role="status">
          {msg}
        </p>
      )}
      {!data?.can_remove && list.length > 0 && <p className="muted">移出成员要在开通律所的那台电脑上操作（和批准新成员是同一台）；停用某一台电脑可以在任一管理员或合伙人的电脑上做。</p>}
    </div>
  );
}

