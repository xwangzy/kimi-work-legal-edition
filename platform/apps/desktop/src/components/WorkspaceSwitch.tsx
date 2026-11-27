/**
 * 第 72 批（V46，D-305 第 4 条，契约 02 §7）：当前工作空间（个人 / 团队）与切换。
 *
 * - useWorkspace：内核状态的 workspace_kind / device_issuer + workspaces.list，得出这台电脑当前是哪个工作空间、显示哪些功能
 *   （lib/workspace.ts workspaceFeatures；替换原来按律所名、证书角色的推断）。侧栏与设置共用一份缓存，切换、升级、加入后通知刷新。
 * - useSwitchFlow：workspaces.switch / teams.join / teams.leave 的结果交给第 68 批“换账号登录”的同一条流程（lib/account-switch.ts）：
 *   同档案直接进 / 新档案开通（内核换档案后整页重载）/ 满额选择卡（DeviceLimitList，用这次切换的会话就地让一台电脑退出登录后继续）。不另起一套。
 */
import { useEffect, useState, type ReactNode } from "react";
import { account, api, workspaces, type WorkspaceList } from "../api.ts";
import { currentProfileMark, deviceLimitOf, isSwitchResult, switchOutcome, waitForProfileSwitch, type DeviceLimitChoice } from "../lib/account-switch.ts";
import { resolveKind, roleOfMember, teamErrorText, workspaceFeatures, type WorkspaceFeatures, type WorkspaceKind, type WorkspaceRole } from "../lib/workspace.ts";
import { DeviceLimitList } from "./DeviceLimitList.tsx";
import { KimiPulse } from "./Loading.tsx";
import { Modal } from "./Modal.tsx";
import "../styles-team.css";

/** 工作空间变了（升级、加入、退出、切换失败后重读）：侧栏与设置据此重读。 */
export const WORKSPACE_CHANGED = "kwl:workspace-changed";
export const notifyWorkspaceChanged = () => window.dispatchEvent(new Event(WORKSPACE_CHANGED));

export interface WorkspaceState {
  ready: boolean;
  kind: WorkspaceKind | null;
  role: WorkspaceRole | null;
  issuer: "firm_root" | "account_ca" | null;
  features: WorkspaceFeatures;
  list: WorkspaceList | null;
  reload: () => void;
}

let shared: { st: any; list: WorkspaceList | null } | null = null;
let inflight: Promise<{ st: any; list: WorkspaceList | null }> | null = null;
function fetchShared(force: boolean): Promise<{ st: any; list: WorkspaceList | null }> {
  if (!force && shared) return Promise.resolve(shared);
  if (inflight) return inflight;
  inflight = Promise.all([api.kernelStatus().catch(() => null), workspaces.list()])
    .then(([st, list]) => (shared = { st, list }))
    .finally(() => (inflight = null));
  return inflight;
}

export function useWorkspace(): WorkspaceState {
  const [data, setData] = useState<{ st: any; list: WorkspaceList | null } | null>(shared);
  const load = (force = true) => void fetchShared(force).then(setData).catch(() => {});
  useEffect(() => {
    load(!shared);
    const on = () => load(true);
    window.addEventListener(WORKSPACE_CHANGED, on);
    return () => window.removeEventListener(WORKSPACE_CHANGED, on);
  }, []);
  const st = data?.st ?? null;
  const list = data?.list ?? null;
  const kind = resolveKind(st?.workspace_kind, list?.current ?? null);
  const role = (list?.current?.role as WorkspaceRole | null | undefined) ?? roleOfMember(st?.member_role);
  return {
    ready: !!data,
    kind,
    role,
    issuer: st?.device_issuer === "account_ca" ? "account_ca" : st?.device_issuer === "firm_root" ? "firm_root" : null,
    features: workspaceFeatures(kind, role),
    list,
    reload: () => load(true),
  };
}

/**
 * 切换类调用（切到另一个工作空间、用邀请码加入团队、退出团队）的统一流程。run 返回结果归类；
 * view 是要挂在页面上的过渡层（正在打开…）或满额选择卡。
 */
export function useSwitchFlow(): { run: (fn: () => Promise<unknown>, target?: string | null) => Promise<"switched" | "same" | "unsupported" | "none" | "limit" | "error">; view: ReactNode; error: string; clearError: () => void } {
  const [switching, setSwitching] = useState<string | null>(null);
  const [limit, setLimit] = useState<DeviceLimitChoice | null>(null);
  const [error, setError] = useState("");
  const after = async (r: unknown, before: string, target: string | null): Promise<boolean> => {
    if (!isSwitchResult(r)) return false;
    setLimit(null);
    setSwitching(r.enrolling ? `正在为${target ? `「${target}」` : "这个工作空间"}登记这台电脑…` : `正在打开${target ? `「${target}」` : "这个工作空间"}…`);
    await waitForProfileSwitch(before, (t) => {
      setSwitching(null);
      setError(t);
    });
    return true;
  };
  const [target, setTarget] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, t: string | null = null) => {
    setError("");
    setTarget(t);
    try {
      const before = await currentProfileMark();
      const r = await fn();
      if (await after(r, before, t)) return "switched" as const;
      const o = switchOutcome(r);
      notifyWorkspaceChanged();
      return o;
    } catch (e) {
      const l = deviceLimitOf(e, t);
      if (l) {
        setLimit(l);
        return "limit" as const;
      }
      setError(teamErrorText(e));
      return "error" as const;
    }
  };
  const continueWith = async (fn: () => Promise<unknown>) => {
    const before = await currentProfileMark();
    const r = await fn().catch((e) => {
      const again = deviceLimitOf(e, target);
      if (again) setLimit(again);
      throw e;
    });
    if (await after(r, before, target)) return;
    setLimit(null);
    notifyWorkspaceChanged();
  };
  const view = switching ? (
    <div className="ws-switching" role="status" aria-live="polite">
      <div className="ws-switching-card">
        <KimiPulse size="md" />
        <p className="ws-switching-title">{switching}</p>
        <p className="ws-switching-note">各工作空间的事项、材料和成果分开保存，互不可见。</p>
      </div>
    </div>
  ) : limit ? (
    <Modal title="选一台电脑退出登录" onClose={() => setLimit(null)} size="card">
      <DeviceLimitList
        devices={limit.devices}
        canUnbind={limit.canUnbind}
        canSignout={limit.canSignout}
        limit={limit.limit}
        limitKind={limit.limitKind}
        thisDevice={limit.thisDevice}
        who={limit.who}
        onBack={() => setLimit(null)}
        onUnbind={(id) => continueWith(() => account.unbindForLogin(id))}
        onSignout={(id) => continueWith(() => account.signoutForLogin(id))}
      />
    </Modal>
  ) : null;
  return { run, view, error, clearError: () => setError("") };
}
