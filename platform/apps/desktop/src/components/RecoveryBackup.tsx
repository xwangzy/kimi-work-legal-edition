/**
 * 设置 → 本机与安全 → 恢复与备份（第 14 批；设计 docs/design/恢复与备份设计-v1.md）。
 * 律师要做的只有三件事：生成恢复包（抄下或打印恢复码）、试一次、选一个备份位置。之后每天自动备份。
 * 电脑坏了：在新电脑的激活页点“从备份恢复”。律师层不出现“主密钥、DPAPI、证书”等词。
 * 第二轮复核处置：恢复码逐行编号、打印带抬头与配对编号（R2B-18、R2B-21）；保存后提醒把恢复包放到别处、自动展开“试一下”（R2B-17）；
 * 以前生成的恢复包仍然有效（R2A-01）；开通律所的电脑的恢复包另有提示（R2A-02）；备份进行中显示进度（R2B-19）。
 */
import { useEffect, useRef, useState } from "react";
import { recovery } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";

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

export function RecoveryBackup() {
  const [st, setSt] = useState<any | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyOpen, setVerifyOpen] = useState(false);
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
    }
  };

  const create = () =>
    run(async () => {
      const target = dialogs ? await recovery.pickPackageSave() : null;
      if (dialogs && !target) throw new Error("没有选择保存位置");
      const r = await recovery.createPackage(target ? { save_handle: target.handle } : { path: devPath });
      setCreated({ code: r.code_text, setId: String(r.set_id ?? ""), firmName: String(r.firm_name ?? ""), createdAt: String(r.created_at ?? ""), founder: !!r.includes_firm_root });
      setCopied(false);
      setPlaceNote(target?.risk === "onedrive" || target?.risk === "cloud" ? "sync" : "local");
      setVerifyOpen(true);
    }, "恢复包已保存。请马上抄下或打印下面的恢复码——离开这一页就再也看不到了。然后在下面“试一下”。");

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
      // 同步盘、网络位置：内容与文件名都是加密的，网盘服务商只看得到文件数量、大小与时间——如实告知
      if (f?.risk === "onedrive" || f?.risk === "cloud" || f?.risk === "network") setSyncNote(true);
    }, "备份位置已设好，并已完成第一次备份。之后每天自动备份一次。");

  const days = typeof st?.stale_days === "number" ? st.stale_days : null;
  const running = st?.running as { done: number; total: number } | null | undefined;
  return (
    <div className="device-row" id="recovery-backup">
      <>
        <div className="device-k">恢复与备份</div>
        <div>
          {st && st.packages_created === 0 && <div className="banner banner-orange">还没有生成恢复包：这台电脑坏了或丢了，案件数据将无法找回。</div>}
          {st?.revoked && <div className="banner banner-red">本设备已被吊销：不能再备份或生成恢复包。</div>}
          <div>
            恢复包：{st?.packages_created ? `已生成 ${st.packages_created} 次，试过 ${st.packages_verified} 次` : "未生成"}
            {" · "}
            自动备份：{st?.configured ? (st.last_ok_at ? `最近一次 ${fmtTime(st.last_ok_at)}${days !== null && days >= 3 ? `（已 ${days} 天没有成功备份）` : ""}` : "还没有成功过") : "未设置"}
            {st?.last_error === "location_changed"
              ? "（备份盘不是原来那块：请插回原来的备份盘，或重新选择备份位置）"
              : st?.last_error
                ? "（上次没有成功，请检查备份位置是否插好、空间是否够）"
                : ""}
          </div>
          {running && <div className="muted" role="status">正在备份：{running.total ? `已处理 ${running.done} / ${running.total} 个文件` : "正在准备"}。可以继续工作，请不要拔出备份用的移动硬盘。</div>}
          <div className="muted">恢复包和恢复码要分开放（例如恢复包放 U 盘，恢复码打印后锁进柜子）；两样在一起，就等于这台电脑的全部数据。备份的内容都是加密的。第一次备份要把全部案卷复制一遍，可能需要较长时间。</div>
          {(st?.recent_packages?.length ?? 0) > 1 && (
            <div className="muted">
              以前生成的恢复包仍然有效（再生成一份不会让旧的失效）：最近几次生成于 {(st.recent_packages as string[]).map((t) => fmtTime(t)).join("、")}。不用的那份请销毁；丢了请告诉所内 IT。
            </div>
          )}
          {!dialogs && (
            <label className="field">
              <span>开发形态：路径（恢复包文件或备份文件夹）</span>
              <input value={devPath} onChange={(e) => setDevPath(e.target.value)} />
            </label>
          )}
          <div className="settings-choice">
            <button className="btn-primary" disabled={busy || st?.revoked} onClick={() => void create()}>
              生成恢复包
            </button>
            <button className="btn-ghost" disabled={busy || st?.revoked} onClick={() => void chooseFolder()}>
              {st?.configured ? "更换备份位置" : "设置备份位置"}
            </button>
            {st?.configured && (
              <button className="btn-ghost" disabled={busy || st?.revoked} onClick={() => void run(() => recovery.runBackup(), "已备份")}>
                立即备份
              </button>
            )}
          </div>
          {created && (
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
              {placeNote === "local" && (
                <p className="muted no-print">恢复包如果存在这台电脑上（例如“文档”），电脑坏了它也会一起丢：请把它复制到 U 盘，或交给律所负责人保管。</p>
              )}
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
          )}
          <details open={verifyOpen} onToggle={(e) => setVerifyOpen((e.target as HTMLDetailsElement).open)}>
            <summary>试一下恢复包能不能用</summary>
            <label className="field">
              <span>输入恢复码（第一行 KWR1 也照抄）</span>
              <textarea rows={4} value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} spellCheck={false} />
            </label>
            <button className="btn-ghost btn-sm" disabled={busy || verifyCode.trim().length < 10} onClick={() => void verify()}>
              选择恢复包，打开试试
            </button>
          </details>
          {msg && <p className="muted" role="status">{msg}</p>}
          {syncNote && <p className="muted">提示：这个备份位置会同步到网盘或网络存储。备份的内容与文件名都是加密的，对方只看得到文件数量、大小与备份时间。</p>}
        </div>
      </>
    </div>
  );
}
