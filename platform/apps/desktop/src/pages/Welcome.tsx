/**
 * 开通向导 · 最后一步（v9.3 第 14 批续）：激活或入组完成后先到这里——生成恢复包、试一下、选备份位置，然后进首页
 * （2026-11 正式产品不再放示例事项：首页先用一分钟的上手指南带律师认识主要功能）。
 * 可以“以后再说”：首页与事项页会一直提醒，点提醒回到这里。操作本身复用“设置 · 备份与安全 · 恢复与备份”的同一组件。
 */
import { useEffect, useState } from "react";
import { api, recovery } from "../api.ts";
import { RecoveryBackup } from "../components/RecoveryBackup.tsx";
import { welcomeHeadline, welcomeSteps, type WelcomeStatus } from "../lib/welcome-steps.ts";
import { nav } from "../App.tsx";
import { ListSkeleton, LoadError } from "../components/Loading.tsx";

export function WelcomePage() {
  const [st, setSt] = useState<WelcomeStatus | null>(null);
  const [who, setWho] = useState<{ firm: string; name: string | null } | null>(null);
  // 没读到备份状态（第 51 批）：原来失败后一直停在“正在读取…”；现在说清楚没读到并给重试，步骤照常列出（打勾以读到的为准）
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const load = () => {
    setLoadErr(null);
    return recovery
      .backupStatus()
      .then(setSt)
      .catch((e) => {
        setSt(null);
        setLoadErr((e as Error).message ?? "");
      });
  };
  useEffect(() => {
    void load();
    api
      .kernelStatus()
      .then((s: any) => s?.activation && setWho({ firm: String(s.activation.firm?.name ?? ""), name: s.activation.member?.name ?? null }))
      .catch(() => {});
  }, []);
  const steps = welcomeSteps(st);
  const allDone = steps.every((x) => x.done);
  return (
    <main className="main">
      <div className="main-wide">
        <h1 className="page-title">开通的最后一步</h1>
        {who && (
          <p className="muted">
            已加入 {who.firm}
            {who.name ? ` · ${who.name}` : ""}
          </p>
        )}
        <div className="panel">
          {st ? <p>{welcomeHeadline(steps)}</p> : loadErr !== null ? <LoadError what="备份状态" message={loadErr} onRetry={() => void load()} /> : <ListSkeleton rows={1} label="正在载入备份状态" />}
          <ol className="welcome-steps">
            {steps.map((x) => (
              <li key={x.key} className={x.done ? "done" : ""}>
                <b>
                  {x.done ? "✓ " : ""}
                  {x.title}
                </b>
                <div className="muted">{x.hint}</div>
              </li>
            ))}
          </ol>
        </div>
        {!st?.revoked && (
          <div className="device">
            <div className="panel">
              <RecoveryBackup onChanged={() => void load()} />
            </div>
          </div>
        )}
        <div className="settings-choice">
          {allDone ? (
            <button className="btn-primary" onClick={() => nav("/")}>
              开始使用
            </button>
          ) : (
            <button className="btn-ghost" onClick={() => nav("/")}>
              以后再说
            </button>
          )}
          <span className="muted">进入首页后，会用一分钟带你认识事项、发起任务、复核成果和期限提醒。</span>
        </div>
      </div>
    </main>
  );
}
