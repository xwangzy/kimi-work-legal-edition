/**
 * 开通向导（v9.3 第 14 批续；评审 Z4 P0-1“开通即恢复演练”、§6 第 14 批“开通向导串起激活 → 恢复包 → 示例事项”）的步骤与完成情况。纯函数。
 * 激活之后律师要亲手做的只有三件事：生成恢复包（抄下或打印恢复码）、试一下能不能打开、选一个备份位置并完成第一次备份。
 */
export interface WelcomeStatus {
  packages_created?: number;
  packages_verified?: number;
  /** 最新生成的那份恢复包试开过（重新生成后回到 false；复核 R15B-25）。旧内核没有这一项时按“试过任意一份”。 */
  latest_package_verified?: boolean;
  configured?: boolean;
  last_ok_at?: string | null;
  revoked?: boolean;
}

export interface WelcomeStep {
  key: "package" | "verify" | "backup";
  title: string;
  hint: string;
  done: boolean;
}

export function welcomeSteps(s: WelcomeStatus | null | undefined): WelcomeStep[] {
  const st = s ?? {};
  return [
    { key: "package", title: "生成恢复包", hint: "存到 U 盘或交给律所负责人；恢复码手抄或打印，和恢复包分开放。", done: (st.packages_created ?? 0) > 0 },
    {
      key: "verify",
      title: "试一下能不能打开",
      hint:
        (st.packages_verified ?? 0) > 0 && st.latest_package_verified === false
          ? "你重新生成过恢复包：用新的恢复码打开新的那份，确认没有抄错。"
          : "用刚抄下的恢复码打开恢复包，确认没有抄错。",
      done: st.latest_package_verified ?? (st.packages_verified ?? 0) > 0,
    },
    { key: "backup", title: "选一个备份位置", hint: "移动硬盘或律所共享盘；选好后马上备份一次，之后每天自动备份。", done: !!st.configured && !!st.last_ok_at },
  ];
}

/** 向导顶上的一句话：按缺的是哪一步说后果（复核 R15B-25：只差“试一下”时不说“无法找回”，恢复包和备份都已具备）。 */
export function welcomeHeadline(steps: WelcomeStep[]): string {
  const missing = new Set(steps.filter((x) => !x.done).map((x) => x.key));
  if (missing.size === 0) return "都设好了。这台电脑坏了或丢了，也能在新电脑上从备份恢复全部事项。";
  const left = `还差 ${missing.size} 步。`;
  if (missing.has("package")) return `${left}还没有恢复包：这台电脑坏了或丢了，案件数据将无法找回。`;
  if (missing.has("backup")) return `${left}还没有备份：这台电脑坏了或丢了，有恢复包也找不回案件数据。`;
  return `${left}恢复包和备份都有了，再用恢复码试开一次，确认没有抄错（抄错了，真要恢复时会打不开）。`;
}
