/**
 * 第 73 批（V47，D-309，契约 02 §2.6）：设置 → 团队 → 团队策略首行“同事之间同步”。
 * - 状态行只说一次（设计评分第一轮 T8）：“● 未开通 [开通…]”/“● 已开通 · 12 月 27 日前有效 [续期…] [关闭…]”；到期前 7 天“续期…”提为主按钮；
 *   需中软开通（服务没部署）如实说、不给按钮；另有待第二位管理员确认、已过期。结果用一次性轻提示（几秒后消失），不再常驻一句绿色正文。
 * - 开通：以当前生效的本所规则为底稿只改这一项（内核 firm_policy.share_relay_enable 一次完成起草、本机确认、达到人数即发布）；
 *   律所版要 2 位管理员时写明还需另一位确认；第二位管理员在自己电脑上这一行点“确认开通…”即确认同一份（内核找一致的待签草稿）。
 * - 续期：按当前生效规则原样重签；已过期时恢复那一份，确认框逐条列出一并恢复的放宽项（所见即所签）。
 * - 关闭：内核没有单独的方法——确认框写清后果（关闭后要再开通需联系中软），再打开下面的“起草律所策略”并预置“不允许同事之间同步”，走原有的确认与发布。
 * 合伙人等不能管理的角色只读（can_manage 由内核按这台电脑判定）。旧内核没有这个方法时整行不出现。
 */
import { useEffect, useState } from "react";
import { teamMatters, type ShareRelayStatus } from "../api.ts";
import { carriedLine, dayOnly, relayExpiringText, shareRelayCloseLines, shareRelayEnableLines, shareRelayRenewLines, shareRelayRow, teamFaultText } from "../lib/team-matters.ts";
import { Icon } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { useRoster } from "./TeamMatter.tsx";
import "../styles-team-matters.css";

/** 状态变了（开通、续期）：团队页顶部提醒、下面的规则与草稿据此重读。 */
export const SHARE_RELAY_CHANGED = "kwl:share-relay-changed";
/** 关闭同事之间同步：让“起草律所策略”预置“不允许同事之间同步”并滚到那里（Connections.tsx PolicyDraftForm 监听）。 */
export const POLICY_DRAFT_PRESET = "kwl:policy-draft-preset";

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

/** 一次性结果（有效期就在状态行里，这里不再写）。 */
function doneText(s: ShareRelayStatus, renew: boolean): string {
  if (s.state === "pending_second_signature") return `已确认，还需另一位管理员确认后${renew ? "续期" : "开通"}`;
  if (s.state === "allowed") return renew ? "已续期" : "已开通";
  return "已提交，稍后生效";
}

export function ShareRelayRow() {
  const [s, setS] = useShareRelay();
  // 云端还没有同事名单能力（team.roster 回 not_supported）时这一行只说“需要中软把云端升级后才能使用”（不说“暂时连不上”、不给按钮）
  const roster = useRoster(true);
  const [asking, setAsking] = useState<"enable" | "renew" | "close" | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // 成功的轻提示几秒后消失；失败的留着（要让管理员看见原因）
  useEffect(() => {
    if (!msg?.ok) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);
  if (s === null && roster?.reason !== "not_supported") return null;
  const row = shareRelayRow(s ?? null, Date.now(), roster);
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
      setMsg({ text: teamFaultText(e), ok: false });
    } finally {
      setBusy(false);
    }
  };
  // 我是第二位管理员：确认的是别人发起的那一份，确认后即生效
  const second = !!s?.pending && !s.pending.signed_by_me;
  const expired = s?.state === "expired";
  const lines =
    asking === "close" ? shareRelayCloseLines() : asking === "renew" ? shareRelayRenewLines(s?.threshold ?? 1, second, expired) : shareRelayEnableLines(s?.threshold ?? 1, second);
  // 过期续期写明一并恢复的放宽项（内核 carry_relaxations.renew）；开通写明同时仍允许的（carry_relaxations.enable）
  const carried = asking === "renew" ? carriedLine(s?.carry_relaxations?.renew, expired ? "restore" : "renew") : asking === "enable" ? carriedLine(s?.carry_relaxations?.enable) : null;
  const title = asking === "close" ? "关闭同事之间同步" : asking === "renew" ? "续期同事之间同步" : "开通同事之间同步";
  return (
    <SettingRow label="同事之间同步" id="row-share-relay" hint="团队共享事项在同事电脑之间加密同步。">
      {s === undefined && row.state !== "upgrade" ? (
        <p className="muted team-empty">正在读取…</p>
      ) : (
        <div className="relay-row">
          <span className={`relay-state${row.warn ? " is-warn" : ""}`} role="status">
            <span className={`sdot ${row.warn ? "sdot-warn" : row.state === "on" ? "sdot-ok" : "sdot-idle"}`} aria-hidden="true" />
            {row.text}
          </span>
          {row.actions.length > 0 && (
            <span className="relay-acts">
              {row.actions.map((a) => (
                <button
                  key={a.kind}
                  type="button"
                  className={a.primary ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                  disabled={busy}
                  onClick={() => {
                    if (a.kind === "review") document.getElementById("sec-policy-drafts")?.scrollIntoView({ behavior: "smooth", block: "start" });
                    else setAsking(a.kind);
                  }}
                >
                  {a.label}
                </button>
              ))}
            </span>
          )}
          {msg && (
            <span className={msg.ok ? "lite-toast" : "activate-error relay-err"} role={msg.ok ? "status" : "alert"}>
              {msg.ok && <Icon.check />}
              {msg.text}
            </span>
          )}
        </div>
      )}
      {asking && s && (
        <Modal title={title} onClose={() => !busy && setAsking(null)}>
          <ul className="relay-lines">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {carried && <p className="relay-carried">{carried}</p>}
          <div className="modal-actions modal-actions-sticky">
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setAsking(null)}>
              取消
            </button>
            {asking === "close" ? (
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setAsking(null);
                  window.dispatchEvent(new CustomEvent(POLICY_DRAFT_PRESET, { detail: { share_relay: false } }));
                }}
              >
                去起草规则
              </button>
            ) : (
              <button type="button" className="btn-primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void run(asking)}>
                {busy ? "正在确认…" : asking === "renew" ? "确认续期" : second ? "确认开通" : s.threshold > 1 ? "确认并发起" : "开通"}
              </button>
            )}
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
        {s?.expires_at && s.state !== "expired" ? `（${dayOnly(s.expires_at)}前有效）` : ""}：{s?.state === "expired" ? "续期后恢复" : "到期后，团队共享事项暂停同步"}，各人电脑上的内容不受影响。
      </span>
      <button type="button" className="btn-ghost btn-sm" onClick={() => document.getElementById("row-share-relay")?.scrollIntoView({ behavior: "smooth", block: "center" })}>
        去续期 →
      </button>
    </div>
  );
}
