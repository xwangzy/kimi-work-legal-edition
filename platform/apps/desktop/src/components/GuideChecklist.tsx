/**
 * 首页“上手清单”（第 46 批，主文 §5-5；第 72 批 D-302 重做）。
 * - 位置：输入框正上方（首屏主角），首访缺省展开成一排步骤；“收拢”收成一行（进度 + 下一步 + 去做）；
 * - 完整版五步：建事项 → 加材料 → 发起任务 → 复核成果 → 备份这台电脑（有材料后才点亮）；做完按真实数据自动打勾（内核 guide.progress）；
 * - 老律师新电脑（账号级已上手、这台电脑还没有任何事项）：新电脑版三项；
 * - 角色：团队管理员前面多一行“团队”（邀请同事 / 席位 / 本所范本，可整组跳过）；团队成员多一句“事项内容只在你的电脑”；
 * - 关闭（×）记本机“已收起”，并记账号级 dismissed（内核与云端支持时）；头像菜单“上手指南”同时恢复清单与讲解（OPEN_GUIDE）；
 * - 第一个任务出了成果即记账号级 completed（换电脑时据此给新电脑版）。账号级状态取不到时只用本机。
 */
import { useCallback, useEffect, useState } from "react";
import { account, api, recovery } from "../api.ts";
import { nav, OPEN_GUIDE, safeStorage } from "../App.tsx";
import { onDataChanged } from "../lib/events.ts";
import {
  checklistAction,
  checklistItems,
  checklistKey,
  checklistState,
  checklistVariant,
  checklistVisibility,
  newDeviceItems,
  onboardRole,
  setChecklistState,
  type BackupFacts,
  type ChecklistItem,
  type ChecklistKey,
  type GuideProgress,
  type OnboardRole,
} from "../lib/guide-checklist.ts";
import { Icon } from "./Icons.tsx";

type Acct = { supported: boolean; completed_at?: string | null; dismissed_at?: string | null };
const TEAM_LINKS: { label: string; path: string }[] = [
  // 第 72 批（impl-U2）：成员与邀请移到“设置 · 团队”
  { label: "邀请同事", path: "/connections/team" },
  { label: "管理成员", path: "/connections/team" },
  { label: "本所范本", path: "/methods/templates" },
];

/**
 * 头像菜单“上手指南”可能在别的页面点（App 先跳回首页、清单此刻还没挂上）：模块加载时就登记监听，记下“要恢复”，挂上后再生效。
 */
let reopenPending = false;
// 用字面量而不是 App.tsx 的 OPEN_GUIDE：本模块经 Home 被 App 引入，模块加载时 App 里的常量还没初始化（循环引用）
const OPEN_GUIDE_EVENT = "kwl:guide";
if (typeof window !== "undefined") window.addEventListener(OPEN_GUIDE_EVENT, () => (reopenPending = true));

/**
 * 第 72 批第二轮（设计评分 C1 建议 1）：展开与否由首页掌握（expanded / onExpanded）——首次进入（一步没做）展开成五卡、放在输入框上方；
 * 做完一步后缺省收成一行、放到输入框下方，不再把主任务压到屏幕中部。expanded 为 null = 还没定，取到进度后按“做没做过”定一次。
 */
export function GuideChecklist({ onNewMatter, expanded: expandedProp = true, onExpanded }: { onNewMatter: () => void; expanded?: boolean | null; onExpanded?: (v: boolean) => void }) {
  const [p, setP] = useState<(GuideProgress & { firm: string | null; user: string | null }) | null>(null);
  const [state, setState] = useState<"shown" | "hidden" | null>(null);
  const expanded = expandedProp !== false;
  const setExpanded = (f: (e: boolean) => boolean) => onExpanded?.(f(expanded));
  const [backup, setBackup] = useState<BackupFacts | null>(null);
  const [acct, setAcct] = useState<Acct | null>(null);
  const [role, setRole] = useState<OnboardRole>("personal");
  const [flags, setFlags] = useState<{ teamSkipped: boolean; deviceAcked: boolean }>({ teamSkipped: false, deviceAcked: false });
  const key = p ? checklistKey(p.firm, p.user) : null;
  const flagKey = (k: string) => (key ? `${key}.${k}` : null);
  const load = useCallback(() => {
    void api
      .guideProgress()
      .then((r) => {
        setP(r);
        const k = checklistKey(r.firm, r.user);
        setState(checklistState(safeStorage(), k));
        const st = safeStorage();
        setFlags({ teamSkipped: st?.getItem(`${k}.team`) === "skipped", deviceAcked: st?.getItem(`${k}.device`) === "acked" });
      })
      .catch(() => {});
    void recovery
      .backupStatus()
      .then((s: BackupFacts) => setBackup(s))
      .catch(() => setBackup(null));
  }, []);
  useEffect(() => {
    load();
    void account.onboarding().then(setAcct);
    // 角色：内核给 workspace_kind 就按它（契约 02 §7），否则按成员角色 + 个人账号标记推断
    void Promise.all([api.kernelStatus().catch(() => null), account.me().catch(() => null)]).then(([s, me]) => setRole(onboardRole(s as { workspace_kind?: string; member_role?: string } | null, me?.personal ?? null)));
    // 建事项、导入材料、发起任务后界面会发数据变更通知；从别的页面回到首页时组件重新挂载也会再取一次
    const off = onDataChanged(load);
    const onVis = () => (document.visibilityState === "visible" ? load() : undefined);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);
  // 头像菜单“上手指南”与“看看界面”：同时恢复清单（展开）
  useEffect(() => {
    const reopen = () => {
      if (!key) return;
      reopenPending = false;
      setChecklistState(safeStorage(), key, "shown");
      setState("shown");
      onExpanded?.(true);
    };
    if (reopenPending) reopen();
    window.addEventListener(OPEN_GUIDE, reopen);
    return () => window.removeEventListener(OPEN_GUIDE, reopen);
  }, [key]);
  const vis = checklistVisibility(state, p, acct);
  useEffect(() => {
    if (!key) return;
    // 第一次见到时：老用户（四步都已完成）或账号在别处收起过 → 悄悄记为收起；新用户记为“显示过”
    if (vis === "retire") {
      setChecklistState(safeStorage(), key, "hidden");
      setState("hidden");
    } else if (vis === "show" && state === null) {
      setChecklistState(safeStorage(), key, "shown");
      setState("shown");
    }
  }, [vis, key, state]);
  // 第一个任务出了成果：账号级记“已上手”（只记时间；换电脑时给新电脑版）
  useEffect(() => {
    if (acct?.supported && !acct.completed_at && p && p.deliverables > 0) void account.onboardingMark({ completed: true }).then((r) => r.ok && setAcct((a) => (a ? { ...a, completed_at: new Date().toISOString() } : a)));
  }, [acct, p]);
  // 展开与否还没定：按这台电脑上做没做过第一步定一次（一步没做 → 展开在输入框上方；做过 → 收成一行在输入框下方）
  useEffect(() => {
    if (expandedProp === null && p) onExpanded?.(p.own_matters === 0 && p.materials === 0 && p.runs === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedProp, p]);
  if (vis !== "show" || !p || !key || expandedProp === null) return null;
  const variant = checklistVariant(acct, p);
  const items: ChecklistItem[] = variant === "new_device" ? newDeviceItems(flags.deviceAcked, backup) : checklistItems(p, backup);
  const allDone = items.every((i) => i.done);
  const next = items.find((i) => !i.done && !i.locked) ?? null;
  const doneCount = items.filter((i) => i.done).length;
  const setFlag = (k: "team" | "device", v: string) => {
    const fk = flagKey(k);
    try {
      if (fk) safeStorage()?.setItem(fk, v);
    } catch {
      // 记不住：只在这次打开期间生效
    }
  };
  const hide = () => {
    setChecklistState(safeStorage(), key, "hidden");
    setState("hidden");
    void account.onboardingMark({ dismissed: true });
  };
  const go = (k: ChecklistKey) => {
    if (k === "device") {
      setFlag("device", "acked");
      setFlags((f) => ({ ...f, deviceAcked: true }));
      return;
    }
    const a = checklistAction(k, p);
    if (a.kind === "new_matter") onNewMatter();
    else if (a.kind === "nav") nav(a.path);
    else {
      const box = document.querySelector<HTMLElement>('[data-tour="composer"] textarea');
      box?.scrollIntoView({ block: "center" });
      box?.focus();
    }
  };
  const title = variant === "new_device" ? "在这台电脑上开始" : allDone ? "上手完成" : "上手清单";
  return (
    <section className={`guide-checklist${allDone ? " guide-checklist-done" : ""}${expanded ? " is-expanded" : ""}`} aria-label="上手清单" data-variant={variant} data-role={role}>
      <div className="guide-checklist-head">
        <h2 className="guide-checklist-title">{title}</h2>
        <span className="muted guide-checklist-count">
          {doneCount} / {items.length}
        </span>
        {!expanded && next && <span className="guide-checklist-next">下一步：{next.title}</span>}
        <span className="spacer" />
        {!expanded && next && (
          <button className="btn-primary btn-sm" onClick={() => go(next.key)}>
            {next.cta}
          </button>
        )}
        {expanded && !allDone && (
          <button className="btn-link" onClick={() => window.dispatchEvent(new Event(OPEN_GUIDE))}>
            界面导览
          </button>
        )}
        {!allDone && (
          <button className="btn-link" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
            {expanded ? "收起" : "展开"}
          </button>
        )}
        <button className="icon-btn guide-checklist-close" onClick={hide} aria-label="关闭上手清单" title="关闭上手清单（头像菜单“上手指南”可以再打开）">
          {Icon.x()}
        </button>
      </div>
      {expanded && role === "team_admin" && variant === "full" && !flags.teamSkipped && (
        <div className="guide-team" role="group" aria-label="团队">
          <span className="guide-team-k">团队</span>
          {TEAM_LINKS.map((l) => (
            <button key={l.label} className="btn-link" onClick={() => nav(l.path)}>
              {l.label}
            </button>
          ))}
          <span className="spacer" />
          <button
            className="btn-link guide-team-skip"
            onClick={() => {
              setFlag("team", "skipped");
              setFlags((f) => ({ ...f, teamSkipped: true }));
            }}
          >
            跳过
          </button>
        </div>
      )}
      {allDone ? (
        <p className="guide-checklist-lead">{variant === "new_device" ? "这台电脑准备好了。" : "都做过了：以后每个案件照这个顺序来——建事项、加材料、发起任务、复核成果。"}</p>
      ) : expanded ? (
        <ol className={`guide-steps guide-steps-${items.length}`}>
          {items.map((i, n) => {
            const current = next?.key === i.key;
            return (
              <li key={i.key} className={`guide-step${i.done ? " is-done" : ""}${current ? " is-current" : ""}${i.locked ? " is-locked" : ""}`}>
                <span className="guide-step-mark" aria-hidden="true">
                  {i.done ? Icon.check() : n + 1}
                </span>
                <span className="guide-step-title">{i.title}</span>
                <span className="guide-step-body">{i.locked ? "有了材料后可做" : i.body}</span>
                {current && (
                  <button className="btn-primary btn-sm guide-step-cta" onClick={() => go(i.key)}>
                    {i.cta}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
      {expanded && role === "team_member" && variant === "full" && <p className="guide-checklist-note">事项内容只在你的电脑上，团队管理员看不到内容。</p>}
    </section>
  );
}
