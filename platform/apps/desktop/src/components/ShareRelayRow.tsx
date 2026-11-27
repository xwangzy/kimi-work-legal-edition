/**
 * 第 73 批（V47，D-309，契约 02 §2.6）：设置 → 团队 → 团队策略首行“同事之间同步”。
 * - 三态：需中软开通（服务没部署：如实说，不给按钮）/ 未开通（“开通…”）/ 已开通至某日；另有待第二位管理员确认、已过期。
 * - 开通：以当前生效的本所规则为底稿只改这一项（内核 firm_policy.share_relay_enable 一次完成起草、本机确认、达到人数即发布）；
 *   律所版要 2 位管理员时写明还需另一位确认；第二位管理员在自己电脑上这一行点“确认开通…”即确认同一份（内核找一致的待签草稿）。
 * - 到期前 7 天：这一行变色并给“续期…”（按当前生效规则原样重签）；团队页顶部另有一行提醒（ShareRelayExpiring）。
 * - 开通、续期都是管理员签名：确认框写明后果，并逐条列出这次一并确认的其它放宽项（所见即所签）。
 * 合伙人等不能管理的角色只读（can_manage 由内核按这台电脑判定）。旧内核没有这个方法时整行不出现。
 */
import { useEffect, useState } from "react";
import { teamMatters, type ShareRelayStatus } from "../api.ts";
import { dueLabel } from "../lib/workspace.ts";
import { carriedLine, memberErrorText, relayExpiringText, shareRelayEnableLines, shareRelayRenewLines, shareRelayRow } from "../lib/team-matters.ts";
import { Modal } from "./Modal.tsx";
import { SettingRow } from "./SettingRow.tsx";
import "../styles-team-matters.css";

/** 状态变了（开通、续期）：团队页顶部提醒、下面的规则与草稿据此重读。 */
export const SHARE_RELAY_CHANGED = "kwl:share-relay-changed";

function useShareRelay(): [ShareRelayStatus | null | undefined, (s: ShareRelayStatus) => void] {
  const [s, setS] = useState<ShareRelayStatus | null | undefined>(undefined);
  useEffect(() => {
    const load = () => void teamMatters.shareRelayStatus().then(setS);
    load();
    window.addEventListener(SHARE_RELAY_CHANGED, load);
    return () => window.removeEventListener(SHARE_RELAY_CHANGED, load);
  }, []);
  return [s, setS];
}

function doneText(s: ShareRelayStatus, renew: boolean, now = Date.now()): string {
  if (s.state === "pending_second_signature") return `已确认：还需另一位管理员在自己的电脑上确认后${renew ? "续期" : "开通"}。`;
  if (s.state === "allowed") return `${renew ? "已续期" : "已开通"}：团队共享事项会在同事电脑之间同步${s.expires_at ? `，${dueLabel(s.expires_at, now)} 前有效` : ""}。`;
  return "已提交，稍后生效。";
}

export function ShareRelayRow() {
  const [s, setS] = useShareRelay();
  const [asking, setAsking] = useState<"enable" | "renew" | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  if (s === null) return null;
  const row = shareRelayRow(s ?? null);
  const run = async (kind: "enable" | "renew") => {
    setBusy(true);
    setMsg(null);
    try {
      const r = kind === "renew" ? await teamMatters.shareRelayRenew() : await teamMatters.shareRelayEnable();
      setS(r);
      setAsking(null);
      setMsg({ text: doneText(r, kind === "renew"), ok: true });
      window.dispatchEvent(new Event(SHARE_RELAY_CHANGED));
    } catch (e) {
      setMsg({ text: memberErrorText(e), ok: false });
    } finally {
      setBusy(false);
    }
  };
  const act = row.action;
  // 我是第二位管理员：确认的是别人发起的那一份，确认后即生效
  const second = !!s?.pending && !s.pending.signed_by_me;
  const lines = asking === "renew" ? shareRelayRenewLines(s?.threshold ?? 1, second) : shareRelayEnableLines(s?.threshold ?? 1, second);
  const carried = asking ? carriedLine(asking === "renew" ? s?.carry_relaxations?.renew : s?.carry_relaxations?.enable) : null;
  return (
    <SettingRow label="同事之间同步" id="row-share-relay" hint="团队共享事项加密后在同事电脑之间同步，中软打不开。">
      {s === undefined ? (
        <p className="muted team-empty">正在读取…</p>
      ) : (
        <div className="relay-row">
          <span className={`relay-state${row.warn ? " is-warn" : ""}`} role="status">
            <span className={`sdot ${row.state === "on" ? "sdot-ok" : row.warn ? "sdot-warn" : "sdot-idle"}`} aria-hidden="true" />
            {row.text}
          </span>
          {act && (
            <button
              type="button"
              className={act.kind === "renew" && row.warn ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
              disabled={busy}
              onClick={() => {
                if (act.kind === "review") document.getElementById("sec-policy-drafts")?.scrollIntoView({ behavior: "smooth", block: "start" });
                else setAsking(act.kind);
              }}
            >
              {act.label}
            </button>
          )}
        </div>
      )}
      {msg && (
        <p className={`relay-msg${msg.ok ? " is-ok" : " activate-error"}`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
      {asking && s && (
        <Modal title={asking === "renew" ? "续期同事之间同步" : "开通同事之间同步"} onClose={() => !busy && setAsking(null)}>
          <ul className="relay-lines">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {carried && <p className="relay-carried">{carried}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setAsking(null)}>
              取消
            </button>
            <button type="button" className="btn-primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void run(asking)}>
              {busy ? "正在确认…" : asking === "renew" ? "确认续期" : second ? "确认开通" : s.threshold > 1 ? "确认并发起" : "开通"}
            </button>
          </div>
        </Modal>
      )}
    </SettingRow>
  );
}

/** 团队页顶部（管理员）：同事之间同步 7 天内到期或已过期时一行提醒，点“去续期”到团队策略那一行。 */
export function ShareRelayExpiring() {
  const [s] = useShareRelay();
  const text = s && s.can_manage && s.relay_configured && (s.state === "allowed" || s.state === "expired") ? (s.state === "expired" ? "同事之间同步已过期，已暂停" : relayExpiringText(s.days_left)) : null;
  if (!text) return null;
  return (
    <div className="banner banner-orange team-expiring" role="status">
      <span>
        {text}
        {s?.expires_at && s.state !== "expired" ? `（${dueLabel(s.expires_at)} 前有效）` : ""}：{s?.state === "expired" ? "续期后恢复" : "到期后团队共享事项暂停在同事电脑之间同步"}，事项内容不受影响。
      </span>
      <button type="button" className="btn-ghost btn-sm" onClick={() => document.getElementById("row-share-relay")?.scrollIntoView({ behavior: "smooth", block: "center" })}>
        去续期 →
      </button>
    </div>
  );
}
