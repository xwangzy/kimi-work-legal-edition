/**
 * 设置 → 管理 → 成员（第 13 批开通与成员入组；只有管理员能用，控制面同样核对）。
 * 邀请：填姓名与角色 → 生成一次性邀请码（只显示这一次）→ 经微信或当面交给同事。
 * 批准：同事在新装的客户端输入邀请码后，这里出现待批准申请；请对方念出他屏幕上的 12 位数字，与这里一致再批准。
 */
import { useEffect, useState } from "react";
import { members } from "../api.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { fmtTime } from "../lib/labels.ts";

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
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg("");
    try {
      await fn();
      setMsg(ok);
      void load();
    } catch (e) {
      setMsg((e as Error).message);
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
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
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
            <p className="muted">{fmtTime(issued.expires_at)} 前有效，只能用一次。请发给对方：他在自己的电脑上安装 Kimi Work 后输入这个码，然后会打电话把屏幕上的核对码读给你，你在“等你批准”里核对后批准。</p>
          </div>
        )}
        {msg && <p className="muted">{msg}</p>}
      </div>

      <div className="panel">
        <div className="section-title">等你批准{requests.length > 0 ? `（${requests.length}）` : ""}</div>
        {requests.length === 0 ? (
          <p className="muted">没有等待批准的同事。</p>
        ) : (
          <table className="members-table">
            <thead>
              <tr>
                <th>姓名</th>
                <th>角色</th>
                <th>申请时间</th>
                <th>核对码（请对方念出，一致再批准）</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.name ?? "（不是在这台电脑上邀请的）"}</td>
                  <td>{ROLE_LABEL[r.role] ?? r.role}</td>
                  <td>{fmtTime(r.requested_at)}</td>
                  <td className="members-check">{r.check_code}</td>
                  <td>
                    {r.local_invite ? (
                      <span className="settings-choice">
                        <ConfirmButton label="批准" danger={false} className="btn-primary btn-sm" question={`请先电话或当面联系${r.name ?? "对方"}，请他读出屏幕上的核对码，与这里逐位对照。号码一致吗？`} confirmLabel="已核对一致，批准" onConfirm={() => act(() => members.approve(r.id), `已批准${r.name ? ` ${r.name}` : ""}`)} />
                        <ConfirmButton label="拒绝" question={`拒绝${r.name ? ` ${r.name} ` : ""}的申请？他需要新的邀请码才能再次申请。`} confirmLabel="拒绝" onConfirm={() => act(() => members.reject(r.id), "已拒绝")} />
                      </span>
                    ) : (
                      <span className="muted">请在发出邀请的电脑上处理</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {requests.length > 0 && <p className="muted">批准前，请先电话或当面联系对方，请他读出自己屏幕上的核对码，与这里逐位对照。号码对不上？不要批准，点“拒绝”，并联系中软客服。</p>}
      </div>

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
        {data?.firm_check_code && <p className="muted">本所核对码：{data.firm_check_code}（同事加入后，他的“设置 · 本机与安全”里应显示同一串数字）</p>}
      </div>
    </div>
  );
}
