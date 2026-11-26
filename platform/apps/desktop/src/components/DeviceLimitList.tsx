/**
 * 同时登录的电脑已达上限（第 68 批 D-295 起；第 69 批 D-297“选一台移除”；第 71 批 V45 D-298 重做为“选一台让它退出登录”）。
 *
 * 每个账号能**同时登录**的电脑数由云端设定，客户端不另设限制、也不做判定。满了时这里整卡显示：
 * - 列出这个账号的电脑：名字或类型、最近使用、状态（登录中 / 已退出登录 / 这台电脑）；只有登录中的电脑占名额；
 * - 默认动作是**让它退出登录**（可逆）：那台电脑上的事项和成果都还在，之后在那台电脑上重新登录即可；默认预选登录中最久没用的一台；
 * - “移除”是次要动作（电脑丢了、转手或不再使用）：吊销后那台电脑不能再用这个账号；登记数到了封顶（limit_kind = registered）时只能移除；
 * - 都用刚完成的这次登录（10 分钟内、一次性票据），不必再输一次密码或再收一次验证码；不自动替换（D-297/D-298 的理由见研究目录 04）。
 * 云端不支持让出（旧云端）时退回只能移除；连移除也不支持（网页会话等）时只列出，说明去哪里处理。
 * 开通页（新电脑）、重新登录页（这台已登记的电脑、换账号）共用。
 */
import { useMemo, useState } from "react";
import { defaultRemovalPick, defaultSignoutPick, deviceChoiceLine, deviceState, type AccountDevice } from "../lib/account.ts";
import { Icon } from "./Icons.tsx";

type Mode = "signout" | "remove";

export function DeviceLimitList(p: {
  devices: AccountDevice[];
  canUnbind: boolean;
  canSignout?: boolean;
  limit?: number | null;
  limitKind?: "signed_in" | "registered" | null;
  thisDevice?: string | null;
  who?: string | null;
  onUnbind: (deviceId: string) => Promise<void>;
  onSignout?: (deviceId: string) => Promise<void>;
  onBack: () => void;
}) {
  const thisDevice = p.thisDevice ?? null;
  const registeredCap = p.limitKind === "registered";
  const signoutOk = p.canSignout === true && !!p.onSignout && !registeredCap && defaultSignoutPick(p.devices, thisDevice) !== null;
  const [mode, setMode] = useState<Mode>(signoutOk ? "signout" : "remove");
  const removable = useMemo(() => p.devices.filter((d) => d.device_id !== thisDevice && deviceState(d) !== "revoked"), [p.devices, thisDevice]);
  const firstPick = (m: Mode) => (m === "signout" ? defaultSignoutPick(p.devices, thisDevice) : p.canUnbind ? defaultRemovalPick(removable) : null);
  const [pick, setPick] = useState<string | null>(() => firstPick(mode));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const now = useMemo(() => Date.now(), []);
  const n = typeof p.limit === "number" && p.limit > 0 ? p.limit : p.devices.filter((d) => deviceState(d) === "signed_in").length || p.devices.length;

  const who = (p.who ?? "").trim();
  const actionable = mode === "signout" ? signoutOk : p.canUnbind;
  // 这一行能不能选：让出时只有登录中的别的电脑（只有它们占名额）；移除时除这台以外未移除的都可以
  const selectable = (d: AccountDevice) => d.device_id !== thisDevice && (mode === "signout" ? deviceState(d) === "signed_in" : deviceState(d) !== "revoked");
  const switchMode = (m: Mode) => {
    setMode(m);
    setPick(firstPick(m));
    setErr("");
  };
  const submit = async () => {
    // 只有一台可选时就是它（不显示单选）
    const target = single?.device_id ?? pick;
    if (!target || busy) return;
    setBusy(true);
    setErr("");
    try {
      if (mode === "signout") await p.onSignout!(target);
      else await p.onUnbind(target);
    } catch (e) {
      setErr((e as Error).message || (mode === "signout" ? "没有让它退出登录，请稍后重试" : "没有移除成功，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };
  // 第 71 批（V45）：旧云端（can_signout=false）只能移除——标题与说明按移除的口径写，不再说“让它退出登录”
  const removeOnly = !signoutOk;
  // 只有一台可选时不要单选：整行作为“将要退出登录 / 移除的那台”展示，按钮写出它的名字
  const choices = actionable ? p.devices.filter((d) => deviceState(d) !== "revoked" && selectable(d)) : [];
  const single = choices.length === 1 ? choices[0]! : null;
  const singleName = single ? deviceChoiceLine(single, now).title : "";
  const chosen = single ?? p.devices.find((d) => d.device_id === pick) ?? null;
  const title = registeredCap ? "登记的电脑已达上限" : mode === "signout" ? "同时登录的电脑已达上限" : removeOnly ? "电脑数已达上限" : "移除一台电脑";
  const whoPart = who ? (
    <>
      <b>{who}</b>
    </>
  ) : (
    "这个账号"
  );
  const lead = registeredCap ? (
    <>{whoPart}登记过的电脑已经很多了。移除一台不再使用的，就能在这台电脑上继续。</>
  ) : mode === "signout" ? (
    <>
      {whoPart}最多同时在 {n} 台电脑上登录。{single ? "让下面这台退出登录" : "选一台让它退出登录"}，就能在这台电脑上继续。
    </>
  ) : removeOnly ? (
    <>
      {whoPart}最多可用 {n} 台电脑。{single ? "移除下面这台" : "选一台不再使用的移除"}，就能在这台电脑上继续。
    </>
  ) : (
    <>电脑丢了、转手或不再使用时才需要移除。{single ? "" : "选一台移除，就能在这台电脑上继续。"}</>
  );
  const consequence =
    mode === "signout"
      ? `${chosen ? `「${deviceChoiceLine(chosen, now).title}」` : "那台电脑"}会立即退出登录、停止使用 AI；上面的事项和成果都还在，之后在那台电脑上重新登录即可。`
      : chosen?.session === "active" || (chosen && deviceState(chosen) === "signed_in")
        ? "那台电脑正在使用，移除后立即停用这个账号，不能撤销；资料仍加密留在那台电脑上。"
        : "移除后那台电脑不能再用这个账号，不能撤销；资料仍加密留在那台电脑上。";
  const submitText = busy ? (mode === "signout" ? "正在让它退出…" : "正在移除…") : mode === "signout" ? (single ? `让「${singleName}」退出登录，在这台继续` : "让它退出登录，在这台继续") : single ? `移除「${singleName}」并继续` : "移除并继续";
  // 这台电脑排在最前（标明“你在这里”），其余按云端给的顺序
  const rows = p.devices.filter((d) => deviceState(d) !== "revoked").sort((x, y) => Number(y.device_id === thisDevice) - Number(x.device_id === thisDevice));
  return (
    <div className="auth-devlimit" data-auth-step="device-limit" data-mode={mode}>
      <div className="auth-title-row">
        <h1 className="auth-title">{title}</h1>
        <button type="button" className="btn-link" onClick={mode === "remove" && signoutOk ? () => switchMode("signout") : p.onBack} disabled={busy}>
          返回
        </button>
      </div>
      <p className="auth-lead">{lead}</p>
      <div className="auth-devices" role={actionable && !single ? "radiogroup" : "list"} aria-label="这个账号的电脑">
        {rows.map((d) => {
          const l = deviceChoiceLine(d, now);
          const st = deviceState(d);
          const isThis = d.device_id === thisDevice;
          const can = actionable && selectable(d);
          const on = pick === d.device_id;
          const badge = isThis ? <span className="auth-device-tag is-this">这台电脑</span> : st === "signed_in" ? <span className="auth-device-live">登录中</span> : <span className="auth-device-tag">已退出登录</span>;
          const body = (
            <>
              <span className="auth-device-icon" aria-hidden="true">
                <Icon.monitor />
              </span>
              <span className="auth-device-text">
                <b>
                  {l.title}
                  {badge}
                </b>
                <span>{isThis ? "你正在这台电脑上登录" : l.meta}</span>
              </span>
              {actionable && !single && <span className="auth-device-radio" aria-hidden="true" />}
            </>
          );
          const cls = `auth-device-row${isThis ? " is-this" : ""}${single && single.device_id === d.device_id ? ` is-target${mode === "remove" ? " is-danger" : ""}` : ""}${!single && on ? " on" : ""}${can ? "" : " off"}`;
          return actionable && !single ? (
            <button key={d.device_id} type="button" role="radio" aria-checked={on} aria-disabled={!can} className={cls} onClick={() => can && setPick(d.device_id)} disabled={busy || !can}>
              {body}
            </button>
          ) : (
            <div key={d.device_id} role="listitem" className={cls}>
              {body}
            </div>
          );
        })}
      </div>
      {err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
      {actionable ? (
        <>
          {/* 后果放在按钮上方，做决定前读到（第 69 批第二轮独立评审）；移除不可逆，用琥珀色风险提示（第 71 批，独立评分区域 9-2） */}
          {mode === "signout" ? (
            <p className="auth-fine">{consequence}</p>
          ) : (
            <p className="auth-warn" role="note">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3.5 2.8 19.5h18.4z" />
                <path d="M12 10v4.2M12 17h.01" />
              </svg>
              <span>{consequence}</span>
            </p>
          )}
          <button type="button" className={mode === "signout" ? "btn-primary activate-submit" : "btn-danger-solid activate-submit"} disabled={!(single?.device_id ?? pick) || busy} onClick={() => void submit()}>
            {submitText}
          </button>
          {mode === "signout" && p.canUnbind && removable.length > 0 && (
            <button type="button" className="btn-link auth-alt-link" onClick={() => switchMode("remove")} disabled={busy}>
              电脑丢了或不再使用？改为移除
            </button>
          )}
        </>
      ) : (
        <p className="auth-fine">请在那台电脑上退出登录，或在“设置 → 账号”、云端控制台“我的电脑”里处理一台，再回来登录。</p>
      )}
    </div>
  );
}
