/**
 * 团队共享（第 11 批 S11；含复核 S11B-04 处置；Z3 评审 #7、5.5）：团队事项经中软共享中继在成员电脑之间同步（端到端加密，中软没有事项密钥）。
 * 律师层只有一行结论（正常 / 有几个事项暂停同步）和“立即同步”；发出与收取的明细、每条告警的长说明收进“详情”，只给管理员看。
 * “重新同步成员名单”（原“本机重新引导”）只给管理员与事项负责人，用原位两步确认（不再用浏览器原生确认框）。
 */
import { useEffect, useState } from "react";
import { api, team, type DeviceShareStatus, type RelayStatus } from "../api.ts";
import { shareConfirmLine, shareNoteVisible } from "../lib/workspace.ts";
import { notifyWorkspaceChanged } from "./WorkspaceSwitch.tsx";
import { canResyncMembers, relayErrorText, syncAlertAction, syncAlertSummary, syncAlertText, syncOutcomeText, teamShareLine } from "../lib/relay-text.ts";
import { fmtTime } from "../lib/labels.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { Icon } from "./Icons.tsx";

/**
 * 第 72 批（D-304）：note = 这台电脑由账号直接登记、还不能接收团队共享事项时的一句非阻塞提示（lib/workspace.ts shareIssuerNote）；
 * 有提示时即使本所没开同事之间同步也显示这一行。
 */
export function TeamShare({ admin = false, note = null }: { admin?: boolean; note?: string | null }) {
  const [st, setSt] = useState<RelayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // 起点不同的事项：本人是否负责人（负责人也可以重新同步成员名单）
  const [owners, setOwners] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const load = () => void api.relayStatus().then(setSt).catch(() => setSt(null));
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  const alerts = st?.alerts ?? [];
  const rootIds = alerts.filter((a) => a.kind === "root_conflict").map((a) => a.matter_id).join(",");
  useEffect(() => {
    if (!rootIds) return;
    for (const id of rootIds.split(",")) {
      if (id in owners) continue;
      void api
        .getMatter(id)
        .then((r: any) => setOwners((o) => ({ ...o, [id]: r?.matter?.my_role === "owner" })))
        .catch(() => setOwners((o) => ({ ...o, [id]: false })));
    }
  }, [rootIds]);
  // 第 72 批（补测 D2 / D9；设计评分第三轮 C15 / C18）：申请状态提到这里——一处只说一件事：还没申请（中性提示 + 申请按钮）/ 已申请 / 被拒 / 已可接收（正向状态，
  // 带确认时刻与确认人，不再无声消失）；所内还没开通同事之间同步时，作为第二个前提写在同一行里（页顶横幅不再说）
  const share = useShareConfirm(true);
  const confirmedHere = share.s?.supported === true && share.s.state === "confirmed" && !!share.s.decided_at;
  const shareBlock = note ? (
    shareNoteVisible(share.s) ? (
      <div className="share-note share-note-neutral" role="note">
        {note}
        {share.s?.supported === true && <ShareConfirmActions share={share} />}
      </div>
    ) : (
      <ShareConfirmBox share={share} />
    )
  ) : confirmedHere ? (
    <ShareConfirmBox share={share} />
  ) : null;
  const relayMissing = !!st && st.blocked === "not_configured";
  const noteLine = shareBlock ? (
    <>
      {shareBlock}
      {relayMissing && <p className="muted share-prereq">所内还没有开通同事之间同步，开通后才能收到团队共享事项。</p>}
    </>
  ) : null;
  if (!st || (st.blocked === "not_configured" && alerts.length === 0))
    return noteLine ? (
      <div className="device-row">
        <div className="device-k">团队共享</div>
        <div>{noteLine}</div>
      </div>
    ) : null;
  const syncNow = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.relaySync();
      setSt(r.status);
      setMsg(syncOutcomeText(r));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // 第 12 批：清除这台电脑上该事项的成员链，下次收到时按首次同步的规则重新确认负责人（内容与密钥不动）
  const rebootstrap = async (matterId: string) => {
    setBusy(true);
    setMsg("");
    try {
      setMsg((await api.matterSyncRebootstrap(matterId)).note);
      setSt(await api.relayStatus());
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const counts = [
    st.pending_upload ? `${st.pending_upload} 条改动待发出` : "",
    st.stuck ? `${st.stuck_matters ?? 1} 个事项有改动发不出去` : "",
    st.waiting_key ? `${st.waiting_key} 条同事的改动要等事项负责人的电脑上线后才能收到` : "",
    st.waiting_blob ? `${st.waiting_blob} 条同事的改动正在下载材料` : "",
    st.retrying || st.deferred ? `${(st.retrying ?? 0) + (st.deferred ?? 0)} 条稍后重试` : "",
  ].filter(Boolean);
  const pushErr = relayErrorText(st.push_last_error);
  const pullErr = relayErrorText(st.pull_last_error);
  const stuckErr = st.stuck ? relayErrorText(st.stuck_errors?.[0]) : null;
  return (
    <div className="device-row">
      <div className="device-k">团队共享</div>
      <div>
        {noteLine}
        <span>{teamShareLine(st)}</span>
        {alerts.map((a) => (
          <div key={`${a.matter_id}-${a.kind}-${a.epoch}`} className="sync-alert">
            {syncAlertSummary(a)}
            {/* V16 三段式：暂停了 → 谁来处理 → 详情（管理员） */}
            <div className="sync-alert-action">{syncAlertAction(a)}</div>
            {a.kind === "root_conflict" && canResyncMembers(admin, owners[a.matter_id]) && (
              <>
                {" "}
                <ConfirmButton
                  label="重新同步成员名单"
                  className="btn-ghost btn-sm"
                  danger={false}
                  disabled={busy}
                  question={`这台电脑会重新向负责人${a.peer_name ?? a.peer_member ? ` ${a.peer_name ?? a.peer_member} ` : ""}确认「${a.title ?? "这个事项"}」有哪些成员。期间这个事项暂停同步，内容不受影响。`}
                  confirmLabel="重新同步"
                  onConfirm={() => rebootstrap(a.matter_id)}
                />
              </>
            )}
            {admin && (
              <details className="muted">
                <summary>详情</summary>
                {syncAlertText(a)}
              </details>
            )}
          </div>
        ))}
        {st.blocked === null && (
          <>
            {" "}
            <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void syncNow()}>
              {busy ? "正在同步…" : "立即同步"}
            </button>
            {msg && <span className="muted"> {msg}</span>}
            {admin && (
              <details className="muted">
                <summary>同步明细（管理员）</summary>
                <div>
                  上次发出 {st.push_last_ok_at ? fmtTime(st.push_last_ok_at) : "—"} · 上次收取 {st.pull_last_ok_at ? fmtTime(st.pull_last_ok_at) : "—"}
                  {counts.length > 0 ? ` · ${counts.join(" · ")}` : ""}
                </div>
                {stuckErr && <div>发不出去的原因：{stuckErr}（每 6 小时自动再试一次；点“立即同步”马上再试）</div>}
                {st.dropped_total ? <div>另有 {st.dropped_total} 条同事的改动无法在这台电脑上处理（多为这台电脑加入事项之前的内容），已略过。</div> : null}
                {pushErr && pushErr !== stuckErr && <div>发出：{pushErr}</div>}
                {pullErr && <div>收取：{pullErr}</div>}
                {st.chain_last_error && <div title={st.chain_last_error.slice(0, 200)}>成员名单暂时没核对完，下次同步时会再试</div>}
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 第 72 批（U-2b，D-304）：这台直接登录的电脑“申请接收团队共享事项”。申请后显示 12 位入组核对码（请管理员在团队设置 · 电脑待确认里核对后确认），可撤回；
 * 待处理期间每 15 秒问一次内核。内核取回确认结果、核验并换上律所根签的证书后重启：这里等内核回来、本机证书确为律所根签的，
 * 再通知工作空间状态重取（补测 D2：团队共享处随之刷新，不再停在“正在重新载入…”）。被拒 / 过期的结果一直显示到重新申请或点“知道了”（补测 D5）。
 * 旧云端 / 旧内核没有这一步时不出现。
 */
type ShareConfirmState = ReturnType<typeof useShareConfirm>;
function useShareConfirm(enabled: boolean) {
  const [s, setS] = useState<DeviceShareStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => void team.deviceShare.status().then((x) => live && setS(x)).catch(() => undefined);
    load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [enabled]);
  // 已可接收：内核换证后会重启——每 2 秒看一次，内核回来且本机证书已是律所根签的，就让工作空间状态重取（至多约 1 分钟）
  // 只在刚换上证书（restart）时等内核重启后重取；已确认过的电脑打开这一页不再轮询
  const confirmed = s?.state === "confirmed" && s.restart === true;
  useEffect(() => {
    if (!enabled || !confirmed) return;
    let live = true;
    let n = 0;
    const later: ReturnType<typeof setTimeout>[] = [];
    const t = setInterval(() => {
      n += 1;
      void api
        .kernelStatus()
        .then((st: any) => {
          if (!live) return;
          if (st?.device_issuer === "firm_root" || n >= 30) {
            clearInterval(t);
            // 换证后内核随即重启：立即重取一次，内核重启完再各取一次（重启期间那一次取不到也不要紧）
            notifyWorkspaceChanged();
            later.push(setTimeout(notifyWorkspaceChanged, 5_000), setTimeout(notifyWorkspaceChanged, 15_000));
          }
        })
        .catch(() => undefined);
    }, 2_000);
    return () => {
      live = false;
      clearInterval(t);
      for (const x of later) clearTimeout(x);
    };
  }, [enabled, confirmed]);
  const act = async (fn: () => Promise<DeviceShareStatus>) => {
    setBusy(true);
    setErr("");
    try {
      setS(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { s, busy, err, act };
}

/** 还没申请（或已撤回）时，橙色提示里的“申请”按钮。 */
function ShareConfirmActions({ share }: { share: ShareConfirmState }) {
  const { s, busy, err, act } = share;
  const line = shareConfirmLine(s);
  return (
    <div className="share-confirm">
      {line && (
        <p className="muted" role="status">
          {line}
        </p>
      )}
      <span className="settings-choice">
        <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void act(() => team.deviceShare.request())}>
          申请接收团队共享事项
        </button>
      </span>
      {err && <p className="activate-error">{err}</p>}
    </div>
  );
}

/** 已申请 / 被拒 / 已过期 / 已可接收：只这一块（不再并列橙色“还不能接收”）。 */
function ShareConfirmBox({ share }: { share: ShareConfirmState }) {
  const { s, busy, err, act } = share;
  if (!s || s.supported !== true) return null;
  const line = shareConfirmLine(s);
  const retry = s.state === "rejected" || s.state === "expired";
  const ok = s.state === "confirmed";
  return (
    <div className={`share-confirm share-confirm-box${ok ? " is-ok" : ""}`}>
      {line && (
        <p role="status" className={ok ? "share-confirm-ok" : undefined}>
          {ok && <span className="share-ok-icon">{Icon.check()}</span>}
          {line}
        </p>
      )}
      {s.state === "pending" && s.check_code && (
        // 设计评分第三轮 C18：已申请态最关键的是这串号码——单独一行、等宽大号
        <p className="share-code-line">
          <span className="muted">入组核对码</span>
          <span className="share-code mono">{s.check_code}</span>
        </p>
      )}
      <span className="settings-choice">
        {retry && (
          <>
            <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void act(() => team.deviceShare.request())}>
              重新申请
            </button>
            <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => team.deviceShare.dismiss())}>
              知道了
            </button>
          </>
        )}
        {/* 撤回可逆：中性描边，不用红色 */}
        {s.state === "pending" && <ConfirmButton label="撤回申请" danger={false} className="btn-ghost btn-sm" question="撤回这次申请？之后需要时可以重新申请。" confirmLabel="撤回" onConfirm={() => act(() => team.deviceShare.withdraw())} />}
      </span>
      {err && <p className="activate-error">{err}</p>}
    </div>
  );
}
