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
  const actions = (
    <div className="settings-choice welcome-actions">
      {allDone ? (
        <button className="btn-primary" onClick={() => nav("/")}>
          开始使用
        </button>
      ) : (
        <button className="btn-ghost" onClick={() => nav("/")}>
          以后再说
        </button>
      )}
      {/* 第 72 批（D-302 第 4 条）：讲解早已不自动弹出，删掉“进入首页后会带你认识…”的承诺 */}
    </div>
  );
  return (
    <main className="main">
      {/* 第 71 批第二轮（区域 1）：内容区收窄并在页面里纵向居中，下半页不再大片空白 */}
      <div className="main-wide welcome-wrap">
        {/* 第 71 批（区域 1）：原标题“开通的最后一步”与下面“还差 3 步”自相矛盾——开通已经完成，这一页只做备份三步 */}
        <h1 className="page-title">开通完成，先做好备份</h1>
        {who && (
          <p className="muted">
            已加入 {who.firm}
            {/* 个人工作室名里已经有本人姓名（“周律师的工作室”）时不再重复写一次 */}
            {who.name && !who.firm.includes(who.name) ? ` · ${who.name}` : ""}
          </p>
        )}
        {/* 第 71 批 D12：上方只留一句为什么要做（按缺的是哪一步说后果）；三步只在下面的卡片里列一次（原先上方 1/2/3 与卡片重复） */}
        {st ? <p className={`welcome-why ${allDone ? "is-ok" : "is-warn"}`} role="status">{welcomeHeadline(steps).replace(/^还差 \d+ 步。/, "")}</p> : loadErr !== null ? <LoadError what="备份状态" message={loadErr} onRetry={() => void load()} /> : <ListSkeleton rows={1} label="正在载入备份状态" />}
        {/* “以后再说”放回卡内（第 71 批，区域 1：原先在卡片外、压着卡片下边线） */}
        {!st?.revoked ? (
          <div className="device">
            <div className="panel">
              <RecoveryBackup onChanged={() => void load()} footer={actions} />
            </div>
          </div>
        ) : (
          actions
        )}
      </div>
    </main>
  );
}
