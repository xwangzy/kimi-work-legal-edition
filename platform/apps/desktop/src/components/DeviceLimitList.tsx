/**
 * 电脑数已满（第 68 批 D-295 起；第 69 批 V43 D-297 重做为“选一台移除”）。
 *
 * 每个账号能同时使用的电脑数由云端设定，客户端不另设限制。满了时这里整卡显示（不再在登录表单下挤一段红字 + 列表）：
 * - 列出这个账号已登记的电脑：电脑类型、最近使用、版本，正在登录的标“登录中”；
 * - 单选，**默认预选最久没用的一台**（多半就是要换掉的那台，一次点击即可），律师可以改选；
 * - “移除所选并继续”：云端核对刚完成的这次登录（10 分钟内、会话还没绑任何电脑）后移除那台、这台电脑接着登记，不必再收一次验证码；
 * - 不自动替换：自动挤掉一台会让正在用的电脑在律师不知情时掉线，也会让拿到密码的人悄悄挤掉真主人的电脑（决策见 D-297）。
 * 云端不支持就地移除（旧云端、网页会话）时只列出，说明去哪里移除。开通页（待激活）与重新登录页（换账号）共用。
 */
import { useMemo, useState } from "react";
import { deviceChoiceLine, defaultRemovalPick, type AccountDevice } from "../lib/account.ts";
import { Icon } from "./Icons.tsx";

export function DeviceLimitList(p: { devices: AccountDevice[]; canUnbind: boolean; limit?: number | null; who?: string | null; onUnbind: (deviceId: string) => Promise<void>; onBack: () => void }) {
  const [pick, setPick] = useState<string | null>(() => (p.canUnbind ? defaultRemovalPick(p.devices) : null));
  const [oldest] = useState<string | null>(() => (p.devices.length > 1 ? defaultRemovalPick(p.devices) : null));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const now = useMemo(() => Date.now(), []);
  const n = typeof p.limit === "number" && p.limit > 0 ? p.limit : p.devices.length;
  const chosen = p.devices.find((d) => d.device_id === pick) ?? null;
  const who = (p.who ?? "").trim();
  const submit = async () => {
    if (!pick || busy) return;
    setBusy(true);
    setErr("");
    try {
      await p.onUnbind(pick);
    } catch (e) {
      setErr((e as Error).message || "没有移除成功，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-devlimit" data-auth-step="device-limit">
      {/* 第 69 批第二轮（独立评审）：“返回”与找回密码、换账号同一位置（标题行右侧）；说明里写明是哪个账号到了上限 */}
      <div className="auth-title-row">
        <h1 className="auth-title">电脑数已达上限</h1>
        <button type="button" className="btn-link" onClick={p.onBack} disabled={busy}>
          返回
        </button>
      </div>
      <p className="auth-lead">
        {who ? <b>{who}</b> : "这个账号"}
        {who ? " " : ""}最多同时在 {n} 台电脑上使用{p.canUnbind ? "，移除一台即可在这台电脑上继续。" : "。"}
      </p>
      <div className="auth-devices" role={p.canUnbind ? "radiogroup" : "list"} aria-label="这个账号已登记的电脑">
        {p.devices.map((d) => {
          const l = deviceChoiceLine(d, now);
          const on = pick === d.device_id;
          const body = (
            <>
              <span className="auth-device-icon" aria-hidden="true">
                <Icon.monitor />
              </span>
              <span className="auth-device-text">
                <b>
                  {l.title}
                  {l.active && <span className="auth-device-live">登录中</span>}
                  {!l.active && oldest === d.device_id && <span className="auth-device-tag">最久没用</span>}
                </b>
                <span>{l.meta}</span>
              </span>
              {p.canUnbind && <span className="auth-device-radio" aria-hidden="true" />}
            </>
          );
          return p.canUnbind ? (
            <button key={d.device_id} type="button" role="radio" aria-checked={on} className={`auth-device-row${on ? " on" : ""}`} onClick={() => setPick(d.device_id)} disabled={busy}>
              {body}
            </button>
          ) : (
            <div key={d.device_id} role="listitem" className="auth-device-row">
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
      {p.canUnbind ? (
        <>
          {/* 第 69 批真实验收：被移除的电脑在云端吊销，同一账号不能再在那里登录，备份、导出也随之停用（防丢失电脑上的案卷被复制）。
              第 68 批这里写“之后可重新登录”，与实际不符；第二轮（独立评审）：后果放在按钮上方，做决定前读到 */}
          <p className="auth-fine">{chosen?.session === "active" ? "那台电脑正在使用，移除后立即停用；那里的资料如还要用，先在那台电脑上备份。" : "移除后那台电脑上的这个账号随即停用（不能再用 AI、备份或导出）；那里的资料如还要用，先在那台电脑上备份。"}</p>
          <button type="button" className="btn-primary activate-submit" disabled={!pick || busy} onClick={() => void submit()}>
            {busy ? "正在移除…" : "移除并继续"}
          </button>
        </>
      ) : (
        <p className="auth-fine">请先在那台电脑的“设置 → 账号”或云端控制台移除一台，再回来登录。</p>
      )}
    </div>
  );
}
