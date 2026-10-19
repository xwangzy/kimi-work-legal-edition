/**
 * 设置 → 本机与安全 → 恢复与备份（第 14 批；设计 docs/design/恢复与备份设计-v1.md）。
 * 律师要做的只有三件事：生成恢复包（抄下或打印恢复码）、试一次、选一个备份位置。之后每天自动备份。
 * 电脑坏了：在新电脑的激活页点“从备份恢复”。律师层不出现“主密钥、DPAPI、证书”等词。
 */
import { useEffect, useState } from "react";
import { recovery } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";

export function RecoveryBackup() {
  const [st, setSt] = useState<any | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  const [devPath, setDevPath] = useState("");
  const [syncNote, setSyncNote] = useState(false);
  const dialogs = recovery.hasDialogs();
  const load = () => recovery.backupStatus().then(setSt).catch(() => setSt(null));
  useEffect(() => {
    void load();
  }, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
      setMsg(ok);
      void load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      const target = dialogs ? await recovery.pickPackageSave() : null;
      if (dialogs && !target) throw new Error("没有选择保存位置");
      const r = await recovery.createPackage(target ? { save_handle: target.handle } : { path: devPath });
      setCode(r.code_text);
      setCopied(false);
    }, "恢复包已保存。请马上抄下或打印下面的恢复码——关掉这一页就再也看不到了。");

  const verify = () =>
    run(async () => {
      const f = dialogs ? await recovery.pickPackageFile() : null;
      if (dialogs && !f) throw new Error("没有选择恢复包");
      const r = await recovery.verifyPackage(f ? { file_handle: f.handle, code: verifyCode } : { file: devPath, code: verifyCode });
      if (!r.same_device) throw new Error("这份恢复包能打开，但不是这台电脑的");
    }, "试过了：恢复包和恢复码都能用。");

  const chooseFolder = () =>
    run(async () => {
      const f = dialogs ? await recovery.pickFolder() : null;
      if (dialogs && !f) throw new Error("没有选择备份位置");
      await recovery.configureBackup(f ? { folder_handle: f.handle } : { dir: devPath });
      await recovery.runBackup();
      // 同步盘、网络位置：内容是加密的，网盘服务商看不到案件内容，但能看到文件大小与时间——如实告知
      if (f?.risk === "onedrive" || f?.risk === "cloud" || f?.risk === "network") setSyncNote(true);
    }, "备份位置已设好，并已完成第一次备份。之后每天自动备份一次。");

  const days = st?.last_ok_at ? Math.floor((Date.now() - Date.parse(st.last_ok_at)) / 86400_000) : null;
  return (
    <div className="device-row" id="recovery-backup">
      <>
        <div className="device-k">恢复与备份</div>
        <div>
          {st && st.packages_created === 0 && <div className="banner banner-orange">还没有生成恢复包：这台电脑坏了或丢了，案件数据将无法找回。</div>}
          <div>
            恢复包：{st?.packages_created ? `已生成 ${st.packages_created} 次，试过 ${st.packages_verified} 次` : "未生成"}
            {" · "}
            自动备份：{st?.configured ? (st.last_ok_at ? `最近一次 ${fmtTime(st.last_ok_at)}${days !== null && days >= 3 ? `（已 ${days} 天没有成功备份）` : ""}` : "还没有成功过") : "未设置"}
            {st?.last_error ? "（上次没有成功，请检查备份位置是否插好、空间是否够）" : ""}
          </div>
          <div className="muted">恢复包和恢复码要分开放（例如恢复包放 U 盘，恢复码打印后锁进柜子）；两样在一起，就等于这台电脑的全部数据。备份的内容都是加密的。</div>
          {!dialogs && (
            <label className="field">
              <span>开发形态：路径（恢复包文件或备份文件夹）</span>
              <input value={devPath} onChange={(e) => setDevPath(e.target.value)} />
            </label>
          )}
          <div className="settings-choice">
            <button className="btn-primary" disabled={busy} onClick={() => void create()}>
              生成恢复包
            </button>
            <button className="btn-ghost" disabled={busy} onClick={() => void chooseFolder()}>
              {st?.configured ? "更换备份位置" : "设置备份位置"}
            </button>
            {st?.configured && (
              <button className="btn-ghost" disabled={busy} onClick={() => void run(() => recovery.runBackup(), "已备份")}>
                立即备份
              </button>
            )}
          </div>
          {code && (
            <div className="card" role="status">
              <div>恢复码（只显示这一次）：</div>
              <pre className="members-code recovery-code">{code}</pre>
              <div className="settings-choice">
                <button className="btn-ghost btn-sm" onClick={() => window.print()}>
                  打印
                </button>
                <label>
                  <input type="checkbox" checked={copied} onChange={(e) => setCopied(e.target.checked)} /> 我已抄下或打印好
                </label>
                <button className="btn-ghost btn-sm" disabled={!copied} onClick={() => setCode(null)}>
                  收起
                </button>
              </div>
            </div>
          )}
          <details>
            <summary>试一下恢复包能不能用</summary>
            <label className="field">
              <span>输入恢复码（含第一行 KWR1）</span>
              <textarea rows={4} value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} spellCheck={false} />
            </label>
            <button className="btn-ghost btn-sm" disabled={busy || verifyCode.trim().length < 10} onClick={() => void verify()}>
              选择恢复包并试解
            </button>
          </details>
          {msg && <p className="muted" role="status">{msg}</p>}
          {syncNote && <p className="muted">提示：这个备份位置会同步到网盘或网络存储。备份内容是加密的，对方看不到案件内容，但能看到文件大小与备份时间。</p>}
        </div>
      </>
    </div>
  );
}
