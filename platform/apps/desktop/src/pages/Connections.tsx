/**
 * 设置（UIUX 增量评审 ST-1～ST-5、§3.5；v9 第 03 篇 §4.1、§8.5；第 02 篇 §12；第 04 篇 §5.1；V16 IA-1 重排）。
 * 律师版五页：通用（字号、外观、通知、示例事项、版本）/ 文书与写作（文书版式、写作偏好、本所范本入口）/
 * 账号与团队（本所、账号与电脑、团队共享、离所相关；第 44 批起账号为自有邮箱账号）/ 备份与安全（恢复包、自动备份、遇到问题、电脑环境）/
 * 数据去向（三栏 + 现场生成的示例请求，可打印给客户；页底“这台电脑能用的资料”，原“资料来源”页并入）。
 * 管理员另有“管理”：成员、律所策略、中软侧操作记录、技术支持（诊断、加密保存的局限、技术版数据去向）、替换准确度测试。
 * 第 68 批：团队用量与上限（本所额度、按成员、律所上限、个人额度）只在云端控制台管理，客户端“管理”不再有“用量与上限”。
 * 旧地址（#/connections/device、/sources、/data、/policy）由 App.tsx 的 settingsTabOf 落到新分区。
 * “管理”是否显示只是界面安排，授权一律由内核按角色逐个方法核验。
 * 第 72 批（V46，D-305 第 5 条，A3 D1）：按工作空间类型显示功能（useWorkspace：内核状态 workspace_kind，替换原来的 inFirm / isAdmin 推断）——
 * 个人空间没有“团队”“管理”，设置 · 账号里有“升级为团队”“加入团队”，技术支持收进“备份与安全”页底；团队空间多一个“团队”页签
 * （所有成员：团队名称、我的角色、名额与用量、团队共享、离所交接、退出团队；管理员另有成员、邀请、电脑待确认、新电脑策略），
 * “管理”只留团队策略、操作记录、技术支持、代号准确度（管理员与合伙人）。
 */
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import "../styles-dataflow.css";
import "../styles-settings.css";
import { notifyDataChanged } from "../lib/events.ts";
import { api, recovery as recoveryApi, updates, type AiAuthorization, type Capabilities, type ConnectionDiagnosis, type ContentCheckResult, type ContentStatus, type ControlPlaneStatus, type PolicyDraft } from "../api.ts";
import { CONTENT_CHECK_FAILED, CONTENT_PANEL_NOTE, contentCheckLine, contentSourceLine, contentStaleLine } from "../lib/content-labels.ts";
import { nav, OPEN_GUIDE, type SettingsTab } from "../App.tsx";
import { displayVersion, fmtDate, fmtTime, groupDigits } from "../lib/labels.ts";
import { deviceSafetyTile } from "../lib/device-status.ts";
import { applyUiTheme, applyUiZoom, readUiTheme, readUiZoom, UI_THEME_OPTIONS, UI_ZOOM_OPTIONS } from "../lib/ui-prefs.ts";
import { RecallEvalPanel } from "./RecallEval.tsx";
import { CpAuditPanel } from "./FirmUsage.tsx";
import { PersonalUsage } from "./PersonalUsage.tsx";
import { AccountSection } from "../components/AccountPanel.tsx";
import { SupportUpload } from "../components/SupportUpload.tsx";
import { TeamShare } from "../components/TeamShare.tsx";
import { MembersAdmin } from "../components/MembersAdmin.tsx";
import { MemberDevicePolicy, TeamAdmin } from "../components/TeamAdmin.tsx";
import { LeaveTeam, TeamHeader, WorkspaceSection } from "../components/TeamSpace.tsx";
import { useWorkspace, type WorkspaceState } from "../components/WorkspaceSwitch.tsx";
import { dueLabel, shareIssuerNote } from "../lib/workspace.ts";
import { BackupTrack } from "../components/RecoveryBackup.tsx";
import { AuthorizationOverview } from "../components/AuthorizationOverview.tsx";
import { Offboarding } from "../components/Offboarding.tsx";
import { DepartedMembers } from "../components/DepartedMembers.tsx";
import { DocStyle } from "../components/DocStyle.tsx";
import { WritingPrefs } from "../components/WritingPrefs.tsx";
import { Select } from "../components/Select.tsx";
import { SettingRow } from "../components/SettingRow.tsx";
import { Icon } from "../components/Icons.tsx";
import { ConnectionCheck, ConnectionResult } from "../components/ConnectionCheck.tsx";
import { BusyLabel, KimiPulse } from "../components/Loading.tsx";
import { connectionReport } from "../lib/connection-check.ts";
import { supportChecks, supportSummary } from "../lib/support-status.ts";

/**
 * 律师版六页的名称（V16 IA-1；第 47 批加“套餐与用量”）；错误提示、恢复包横幅里的“设置 → …”写的是这些名字。
 * 第 72 批：“账号与团队”改“账号”（团队的事在团队空间自己的“团队”页签里）。
 */
export const SETTINGS_TAB_LABELS: Record<Exclude<SettingsTab, "admin" | "team">, string> = {
  general: "通用",
  writing: "文书与写作",
  account: "账号",
  usage: "套餐与用量",
  backup: "备份与安全",
  visibility: "数据去向",
};

export function ConnectionsPage({ tab }: { tab: SettingsTab }) {
  const [status, setStatus] = useState<any>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [lawdb, setLawdb] = useState<any>(null);
  const [im, setIm] = useState<any[]>([]);
  const [devices, setDevices] = useState<any[]>([]);
  const [mySafety, setMySafety] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<any>(null);
  const [unresolved, setUnresolved] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const load = () => {
    api.kernelStatus().then(setStatus).catch((e) => setErr(e.message));
    api.capabilities().then(setCaps).catch(() => setCaps(null));
    api.lawdbStatus().then(setLawdb).catch((e) => setLawdb({ error: e.message }));
    api.imList().then((r) => setIm(r.bindings ?? [])).catch(() => setIm([]));
    api
      .devices()
      .then((r) => {
        setDevices(r.devices);
        setMySafety(r.my_safety_code ?? null);
      })
      .catch(() => {});
    api.recoveryStatus().then(setRecovery).catch(() => {});
    api.egressUnresolved().then((r) => setUnresolved(r.records)).catch(() => {});
  };
  useEffect(load, []);
  const gate = status?.egress_gate ?? null;
  // 第 72 批（A3 D1）：按工作空间类型与角色显示，不再按证书角色推断（个人账号的证书角色也是管理员）
  const ws = useWorkspace();
  const f = ws.features;
  const isAdmin = f.adminTab;
  const tabs: [SettingsTab, string][] = (Object.entries(SETTINGS_TAB_LABELS) as [SettingsTab, string][]).flatMap((t) => (t[0] === "account" && f.teamTab ? [t, ["team", "团队"] as [SettingsTab, string]] : [t]));
  // 第 72 批评分 C10 第 3 条：团队空间里成员、邀请、团队策略都在“团队”；剩下的操作记录、技术支持、代号准确度叫“审计与支持”
  if (isAdmin) tabs.push(["admin", f.teamTab ? "审计与支持" : "管理"]);
  return (
    <main className="main">
      {/* 第 55 批：表单类页签（通用、文书与写作、账号、备份）把正文收窄，见 styles-settings.css */}
      <div className={`main-wide set-page set-${tab}`}>
        <h1 className="page-title h-page">设置</h1>
        <div className="tabs tabs-line" role="tablist" aria-label="设置">
          {tabs.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? " active" : ""}`} onClick={() => nav(`/connections/${k}`)}>
              {label}
            </button>
          ))}
        </div>
        {err && <div className="banner banner-red">{err}</div>}
        {tab === "general" && <GeneralTab version={displayVersion(status?.app_version, status?.version)} />}
        {tab === "writing" && <WritingTab />}
        {tab === "account" && <AccountTab ws={ws} />}
        {tab === "team" &&
          (!ws.ready ? null : f.teamTab ? (
            <TeamTab ws={ws} mySafety={mySafety} />
          ) : (
            <div className="banner banner-gray">“团队”只在团队空间里有。个人工作室可以在“设置 · 账号”里升级为团队，或用邀请码加入团队。</div>
          ))}
        {/* 套餐与用量（第 66 批 V40 P0-5；第 68 批）：只给当前登录者本人的用量；团队用量与上限在云端控制台，管理员在页底看到一句提示 */}
        {tab === "usage" && <PersonalUsage admin={isAdmin} />}
        {tab === "backup" && (
          <BackupTab caps={caps} gate={gate} support={f.supportInBackup ? <DiagnosticsTab caps={caps} gate={gate} devices={devices} unresolved={unresolved} onReconciled={load} im={im} recovery={recovery} /> : null} supportOpen={unresolved.length > 0} />
        )}
        {tab === "visibility" && (
          <>
            <VisibilityTab gate={gate} im={im} recovery={recovery} firm={status?.firm_name ?? null} syncOn={!!status?.sync_configured} />
            <SourcesTab gate={gate} lawdb={lawdb} im={im} onLawdbChanged={() => api.lawdbStatus().then(setLawdb).catch(() => {})} />
            <AuthorizationSettings />
          </>
        )}
        {tab === "admin" &&
          (!ws.ready ? null : isAdmin ? (
            <AdminTab caps={caps} gate={gate} devices={devices} unresolved={unresolved} onReconciled={load} im={im} recovery={recovery} legacyMembers={ws.kind === null} withPolicy={!f.teamTab} />
          ) : (
            <div className="banner banner-gray">{ws.kind === "personal" ? "个人工作室没有“管理”：技术支持在“设置 · 备份与安全”页底。" : "“管理”只对团队管理员与合伙人开放。"}</div>
          ))}
      </div>
    </main>
  );
}

/**
 * 示例事项（余项续复核 RC-B-13）：诉讼示例上线前已经放过非诉示例的电脑，在这里补放一次诉讼示例；放过（含已移除）就不再显示。
 * 2026-11：正式产品不放演示数据——内核没开演示开关（available === false）时整行不显示。
 */
function SampleRow() {
  const [offer, setOffer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api
      .sampleStatus()
      .then((st) => setOffer(st.available !== false && !st.litigation_offered && (st.installed || st.removed)))
      .catch(() => setOffer(false));
  }, []);
  if (!offer && !msg) return null;
  return (
    <SettingRow label="示例事项" hint={msg || "放入一件虚构的诉讼示例（买卖合同纠纷），可以试“整理案卷”等方法。"}>
      {offer && (
        <div>
          <button
            className="btn-ghost btn-sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api
                .installSample("litigation")
                .then((r) => {
                  setOffer(false);
                  setMsg(r.installed ? "已放入诉讼示例，可以在“事项”里找到它。" : "这台电脑已经放过诉讼示例。");
                  if (r.installed) notifyDataChanged();
                })
                .catch((e) => setMsg((e as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            放入诉讼示例
          </button>
        </div>
      )}
    </SettingRow>
  );
}

function GeneralTab({ version }: { version: string }) {
  const [zoom, setZoom] = useState(readUiZoom());
  const [theme, setTheme] = useState(readUiTheme());
  return (
    <div className="device">
      <div className="panel">
        <SettingRow label="字号">
          {/* 第 26 批（评审 U2 §1.4）：与文书版式同一种分段控件 */}
          <div className="seg seg-lg" role="radiogroup" aria-label="字号">
            {UI_ZOOM_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={zoom === o.value}
                className={`seg-btn${zoom === o.value ? " on" : ""}`}
                onClick={() => {
                  applyUiZoom(o.value, true);
                  setZoom(o.value);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow label="外观" hint="深色模式下，文书预览仍是白纸，便于对照打印稿。">
          <div className="seg seg-lg" role="radiogroup" aria-label="外观">
            {UI_THEME_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={theme === o.value}
                className={`seg-btn${theme === o.value ? " on" : ""}`}
                onClick={() => {
                  applyUiTheme(o.value, true);
                  setTheme(o.value);
                }}
              >
                {o.value === "system" ? `${o.label}（现在是${document.documentElement.dataset.theme === "dark" ? "深色" : "浅色"}）` : o.label}
              </button>
            ))}
          </div>
        </SettingRow>
        {/* 标题“通知”（审计 1.2：原“提醒”与侧栏“期限提醒”撞名） */}
        <SettingRow label="通知" hint="有任务等你确认时，系统会通知你；通知里不写事项内容。">
          <details className="quiet-details">
            <summary>怎么关闭</summary>
            在 Windows“设置 → 系统 → 通知”里关闭 Kimi Work 的通知。
          </details>
        </SettingRow>
        {/* 首次上手指南（2026-11）：五步认识事项、发起任务、复核成果、期限与问答 */}
        <SettingRow label="上手指南" hint="用一分钟认识事项、发起任务、复核成果和期限提醒。">
          <button className="btn-ghost btn-sm" onClick={() => window.dispatchEvent(new Event(OPEN_GUIDE))}>
            再看一遍
          </button>
        </SettingRow>
        <SampleRow />
        <SettingRow label="版本">{version}</SettingRow>
      </div>
    </div>
  );
}

/** 文书与写作（V16 IA-1）：下载的文书怎么排版、AI 起草时按什么习惯写；本所范本在“方法与模板”里放。 */
function WritingTab() {
  return (
    <div className="device">
      <div className="panel">
        <DocStyle />
        <WritingPrefs />
        <SettingRow label="本所范本" hint="本所常用的合同范本，审合同时每条意见旁会列出范本的写法。">
          <button className="btn-ghost btn-sm" onClick={() => nav("/methods")}>
            去“方法与模板”管理范本 →
          </button>
        </SettingRow>
      </div>
    </div>
  );
}

/**
 * “数据去向”（第 48 批重做；第 49 批对照表；第 51 批再重做信息架构）：回答“东西在哪、经过谁、留下什么”，可打印给客户。
 * 第 51 批（第 49 批的对照表有 21 格、12 格是“—”，读者要在表里横竖找；结论被埋在格子里）：
 * - 先三句要点（案卷只在这台电脑 / 发出前换成代号 / 中转不留内容），读一行就知道结论；
 * - 再一张“去向图”：以“律所内 | 律所外（云端）”为边界，三站（这台电脑 → 中软云端服务 → Kimi 模型）各写“留下什么”，
 *   站与站之间写“经过的是什么”；同一件事只说一遍，没有空格子；示例请求（本机现场生成、代号高亮）挂在图下，说明“换成代号”长什么样；
 * - 替换规则、其他联网功能、需要知道的局限、未启用的功能收成可展开的行（打印时全部展开）；
 * - “客户授权”是律师本人的设置，不是给客户看的披露，移到页底（不打印），见 AuthorizationSettings。
 * 口径与第 48、49 批逐条对应（替换范围、中软保存的字段、待签署的书面确认、识别会遗漏），只改组织方式。
 */
type Station = { kind: "local" | "relay" | "model"; icon: () => ReactNode; title: string; sub: string; groups: { label: string; tone: "keep" | "pass" | "meta" | "plain" | "warn"; items: { text: string; note?: string }[] }[] };
function VisibilityTab({ gate, im, recovery, firm, syncOn }: { gate: any; im: any[]; recovery: any; firm: string | null; syncOn: boolean }) {
  const [example, setExample] = useState<{ sent: string; replaced: number } | null>(null);
  const [relayUsed, setRelayUsed] = useState(false);
  const [updatesOn, setUpdatesOn] = useState(false);
  const [contentOn, setContentOn] = useState(false);
  useEffect(() => {
    api.exampleRequest().then(setExample).catch(() => setExample(null));
    // 本机经中继收发过：律所关闭开关后，已保存在中软的密文仍在（复核 S11B-10）
    api.relayStatus().then((r) => setRelayUsed((r.matters ?? 0) > 0)).catch(() => setRelayUsed(false));
    updates.status().then((u) => setUpdatesOn(!!u?.enabled)).catch(() => setUpdatesOn(false));
    api.contentStatus().then((c) => setContentOn(!!c?.configured)).catch(() => setContentOn(false));
  }, []);
  // 打印给客户时，收起的说明全部展开（打印完恢复原样）
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let opened: HTMLDetailsElement[] = [];
    const before = () => {
      opened = [...(rootRef.current?.querySelectorAll("details.dfx-fold:not([open])") ?? [])] as HTMLDetailsElement[];
      opened.forEach((d) => (d.open = true));
    };
    const after = () => {
      opened.forEach((d) => (d.open = false));
      opened = [];
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
  // 第 11 批 S11：团队共享经中软共享中继（本所策略开启且已配置）
  const relayOn = !!gate?.relay_configured && !!gate?.share_relay_allowed;
  const relayStored = relayOn || (!!gate?.relay_configured && relayUsed);
  // 去向图三站（口径同第 49 批对照表：替换了什么、哪些按原文、中软保存哪些字段、待签署的书面确认）
  const stations: Station[] = [
    {
      kind: "local",
      icon: Icon.device,
      title: "这台电脑",
      sub: "律所内 · 只有你能打开",
      groups: [{ label: "加密保存", tone: "keep", items: [{ text: "案卷原件与全部成果" }, { text: "代号与真实姓名的对照表" }, { text: "对话、问答与任务记录" }] }],
    },
    {
      kind: "relay",
      icon: Icon.shield,
      title: "中软云端服务",
      sub: "中软国际运营",
      groups: [
        { label: "只转发，不保存", tone: "pass", items: [{ text: "发给 AI 的任务内容与问答的问题", note: "已把姓名、证件号等换成代号" }, ...(gate?.search_configured ? [{ text: "联网检索的查询", note: "默认去掉当事人名称，转发给检索服务" }] : [])] },
        // 原句保留（第 44 批口径：用量单位就是 token，如实写出中软看得到的字段）
        { label: "保存（不含内容）", tone: "meta", items: [{ text: "账号与用量记录", note: "你的登录邮箱、姓名和登记的电脑，以及每次 AI 调用的用量（请求编号、模型、token 数、金额）；看不到内容" }, { text: "匿名事项编号、调用记录与律所规则" }] },
      ],
    },
    {
      kind: "model",
      icon: Icon.sparkle,
      title: "Kimi 模型",
      sub: "月之暗面",
      groups: [
        { label: "处理", tone: "plain", items: [{ text: "换成代号后的任务内容与问题", note: "生成回答后返回这台电脑" }] },
        { label: "书面确认", tone: "warn", items: [{ text: "与月之暗面“不用于训练、不保留”的书面确认：待签署" }] },
      ],
    },
  ];
  // 其他会联网的功能（只列已启用的）：不经中软的直连，与经中软保存少量记录的
  const others: { name: string; line: string }[] = [
    ...(gate?.fetch === "local" ? [{ name: "打开公开网页", line: "网址由这台电脑直接发往该网站，不经中软" }] : []),
    ...(im.length > 0 ? [{ name: "从聊天工具转文件", line: "文字与文件经所用的聊天平台（如企业微信）传递" }] : []),
    ...(syncOn ? [{ name: "团队共享", line: "经律所指定的共享文件夹同步（加密）" }] : []),
    ...(relayStored ? [{ name: "团队事项的加密副本", line: `中软打不开，只看得到大小、时间和哪几台电脑参与；保存到律所停止使用${relayOn ? "" : "；本所已关闭这一项，已存的仍在"}` }] : []),
    // 第 10 批 S9：期限提醒交中软通知服务——中软只保存提醒时间与接收设备，内容加密
    ...(gate?.notify_configured ? [{ name: "电脑关机时的期限提醒", line: "中软只保存响铃时间和接收电脑，提醒内容加密；响过 7 天后删除" }] : []),
    ...(updatesOn ? [{ name: "检查更新", line: "中软保存访问记录（IP 与版本）" }] : []),
    // 复核 S8A-05：法规库与方法模板的在线更新也是一条出网（服务端看得到账号与设备）
    ...(contentOn ? [{ name: "法规库与方法模板更新", line: "中软保存下载记录（账号、设备、版本与时间；不含案件信息）" }] : []),
    // 开关关闭后已上传的包仍保存至 7 天：只要配置了支持服务就列出（复核 S9B-04⑤）
    ...(gate?.support_configured ? [{ name: "问题报告", line: "只在你主动发送时上传，不含案件内容，保存 7 天" }] : []),
  ];
  const limits: { name: string; line: string }[] = [
    { name: "识别会遗漏", line: "识别依靠规则与当事人名单，可能遗漏：没有识别出的姓名会按原文发出。每个任务的“数据去向”里可以逐条查看实际发出的内容。" },
    ...(gate?.search_configured ? [{ name: "联网检索", line: "默认去掉当事人名称再发出；含当事人名称的查询须经办律师逐条确认，确认后可按原文发出（保留机构当事人名称；已识别的自然人姓名与证件、账号不发出）。" }] : []),
    { name: "客户可以拒绝", line: "客户不希望使用云端 AI 的事项，律师可设为“客户要求不上云”：只在这台电脑上处理，不用云端 AI，也不联网查询。" },
    { name: "不经中软的情形", line: "使用律所自己的 Kimi 账号或律所自建 AI 的事项，不经过中软。" },
    // V16（审计第 24 条）：“加密保存的局限”整段在 管理 · 技术支持（给 IT）；律师版只留一句
    { name: "电脑账户", line: "加密的钥匙跟你这台电脑的登录账户绑定，请不要和别人共用电脑账户。" },
  ];
  const notEnabled = [
    ...(gate?.search_configured ? [] : ["联网检索"]),
    "法源与主体信息查询",
    ...(im.length > 0 ? [] : ["从聊天工具转文件"]),
    ...(syncOn || relayOn ? [] : ["团队共享"]),
    ...(relayOn ? [] : ["同事之间同步（中软看不到内容）"]),
    ...(gate?.notify_configured ? [] : ["电脑关机时的期限提醒（现在只在这台电脑上提醒）"]),
    "云端事项",
    ...(recovery?.escrow ? [] : ["中软托管恢复"]),
  ];
  return (
    <div className="dfx dfm-page" ref={rootRef}>
      <div className="dfx-head">
        <div>
          <h2 className="h-section dfx-title">数据去向说明</h2>
          <div className="dfx-sub">
            {firm ? `${firm} · ` : ""}按本所当前设置生成 · {fmtDate(Date.now())}
          </div>
        </div>
        <button className="btn-ghost btn-sm no-print" onClick={() => window.print()}>
          打印或另存为 PDF
        </button>
      </div>

      {/* 三句要点：读一行就知道结论 */}
      <ul className="dfm-points" aria-label="要点">
        <li>
          <span className="dfm-point-ico dfm-tone-keep" aria-hidden="true">{Icon.lock()}</span>
          <b>案卷只在这台电脑</b>
          <span>原件、成果和代号对照表加密保存在本机，不上传到任何地方。</span>
        </li>
        <li>
          <span className="dfm-point-ico" aria-hidden="true">{Icon.eye()}</span>
          <b>发出前换成代号</b>
          <span>需要 AI 时，先把姓名、证件号、电话等换成代号，再发出去。</span>
        </li>
        <li>
          <span className="dfm-point-ico" aria-hidden="true">{Icon.shield()}</span>
          <b>中转不留内容</b>
          <span>中软只转发，不保存内容；只记录账号与用量。</span>
        </li>
      </ul>

      {/* 去向图（律所内 | 律所外）。律师层其他地方统一说“Kimi Work 服务 / 客服”；这一页是给客户看的披露，按实际运营方写（v9.4 U1 #6） */}
      <section className="dfm" aria-label="一次 AI 请求经过哪里、各处留下什么">
        <div className="dfm-zones" aria-hidden="true">
          <span className="dfm-zone dfm-zone-in">律所内</span>
          <span className="dfm-zone dfm-zone-out">律所外 · 云端</span>
        </div>
        <ol className="dfm-map">
          {stations.map((st, i) => (
            <Fragment key={st.kind}>
              {i > 0 && (
                <li className="dfm-link" aria-hidden="true">
                  <span className="dfm-link-label">{i === 1 ? "换成代号后发出" : "只转发"}</span>
                  <span className="dfm-link-line" />
                </li>
              )}
              <li className={`dfm-station dfm-${st.kind}`}>
                <div className="dfm-station-head">
                  <span className="dfm-station-ico" aria-hidden="true">{st.icon()}</span>
                  <span>
                    <b className="dfm-station-title">{st.title}</b>
                    <small className="dfm-station-sub">{st.sub}</small>
                  </span>
                </div>
                {st.groups.map((g) => (
                  <div key={g.label} className={`dfm-group dfm-tone-${g.tone}`}>
                    <div className="dfm-group-label">{g.label}</div>
                    <ul>
                      {g.items.map((it) => (
                        <li key={it.text}>
                          {it.text}
                          {it.note && <small>{it.note}</small>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </li>
            </Fragment>
          ))}
        </ol>
        {/* 示例请求：本机现场生成（示例句子与人物均为虚构），代号高亮——“换成代号”长什么样 */}
        <div className="dfm-sample">
          <div className="dfm-sample-cap">
            一次 AI 请求实际发出的样子<span>（示例句子与人物均为虚构，由这台电脑现场生成）</span>
          </div>
          <div className="dfx-sample-text">{example ? sampleParts(example.sent).map((p, i) => (p.token ? <span key={i} className="dfx-token">{p.text}</span> : <span key={i}>{p.text}</span>)) : "—"}</div>
        </div>
      </section>

      <div className="dfx-folds">
        <details className="dfx-fold">
          <summary>
            <span className="dfx-fold-title">发出前替换了什么</span>
            <span className="dfx-fold-sum">姓名、证件号、手机号、账号、住址换成代号；机构名称、案情、金额、日期按原文</span>
          </summary>
          <div className="dfx-fold-body">
            <dl className="dfx-rules">
              <div>
                <dt>换成代号</dt>
                <dd>自然人姓名、证件号、手机号、账号、住址</dd>
              </div>
              <div>
                <dt>按原文发送</dt>
                <dd>机构名称（含客户名称）、案情、金额、日期；可按事项开启“全部化名”，公司名称也换成代号</dd>
              </div>
            </dl>
          </div>
        </details>
        {others.length > 0 && (
          <details className="dfx-fold">
            <summary>
              <span className="dfx-fold-title">其他会联网的功能</span>
              <span className="dfx-fold-sum">{others.map((o) => o.name).join("、")}</span>
            </summary>
            <ul className="dfx-list dfx-fold-body">
              {others.map((o) => (
                <li key={o.name}>
                  <b>{o.name}</b>
                  <span>{o.line}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <details className="dfx-fold">
          <summary>
            <span className="dfx-fold-title">需要知道的</span>
            <span className="dfx-fold-sum">{limits.map((o) => o.name).join("、")}</span>
          </summary>
          <ul className="dfx-list dfx-limits dfx-fold-body">
            {limits.map((o) => (
              <li key={o.name}>
                <b>{o.name}</b>
                <span>{o.line}</span>
              </li>
            ))}
          </ul>
        </details>
        <details className="dfx-fold">
          <summary>
            <span className="dfx-fold-title">未启用的功能</span>
            <span className="dfx-fold-sum">{notEnabled.length} 项</span>
          </summary>
          <ul className="plain-list muted dfx-fold-body">{notEnabled.map((x) => <li key={x}>{x}：未启用</li>)}</ul>
        </details>
      </div>
    </div>
  );
}

/** 示例请求按代号切段（〔类别 · 编号〕高亮）。 */
function sampleParts(text: string): { text: string; token: boolean }[] {
  return text.split(/(〔[^〕]{1,40}〕)/).filter(Boolean).map((t) => ({ text: t, token: /^〔[^〕]+〕$/.test(t) }));
}

/**
 * 客户授权的记录方式（第 51 批，D-216；取代第 48 批“开关一开，新建事项默认按委托合同条款记录”）。
 * 合规核验：律师点确认不等于客户授权；授权依据是每一份委托合同，不是律师的一次声明。所以：
 * - 每个事项第一次用 AI 时，在“开始前确认”里逐案记录依据类型与出处（委托合同条款 / 客户书面同意），并留下当时告知的次处理者清单版本；
 * - 这里只保存“常用的委托合同 AI 条款出处”，用来预填（一键确认），不会替任何事项自动记录。
 * 律师本人的设置，不打印给客户；修改记入审计。
 */
function AuthorizationSettings() {
  const [state, setState] = useState<AiAuthorization | null>(null);
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api
      .aiAuthorization()
      .then((a) => {
        setState(a);
        setRef(a.default_ref ?? "");
      })
      .catch(() => setState(null));
  }, []);
  if (!state) return null;
  const on = state.engagement_terms;
  const save = async (next: { engagement_terms?: boolean; default_ref?: string | null }) => {
    setBusy(true);
    setErr("");
    setSaved(false);
    try {
      const r = await api.setAiAuthorization(next);
      setState(r);
      setRef(r.default_ref ?? "");
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const dirty = ref.trim() !== (state.default_ref ?? "");
  const processors = state.subprocessors?.items ?? [];
  return (
    <section className="dfm-authz no-print" aria-labelledby="dfm-authz-h">
      <h2 className="h-sub" id="dfm-authz-h">
        客户授权怎么记录
      </h2>
      <p className="dfm-authz-lead">
        每个事项第一次用 AI 时，“开始前确认”会请你记录这个案子的授权依据——委托合同里的 AI 条款，或客户的书面同意——并写明出处。记录随事项保存、写进事项日志；它是你核实过的依据，不代替客户本人的授权。
      </p>
      <div className="dfm-authz-card">
        <div className="dfm-authz-row">
          <div className="dfm-authz-main">
            <b>用常用条款预填</b>
            <span>你的委托合同模板已含 AI 辅助条款时打开：记录时预先选好“委托合同中的 AI 条款”并填好出处。只是预填——每个事项仍需你确认一次，不会替任何事项自动记录。</span>
          </div>
          <button role="switch" aria-checked={on} aria-label="用常用条款预填"className="switch" disabled={busy} onClick={() => void save({ engagement_terms: !on })} />
        </div>
        {on && (
          <label className="dfm-authz-ref">
            <span>常用的条款出处</span>
            <input value={ref} maxLength={200} placeholder="例如：委托代理合同（本所 2026 版）第 9 条“AI 辅助与次处理者”" onChange={(e) => setRef(e.target.value)} aria-label="常用的条款出处" />
            <button className="btn-ghost btn-sm" disabled={busy || !dirty} aria-busy={busy} onClick={() => void save({ default_ref: ref.trim() || null })}>
              <BusyLabel busy={busy} busyText="正在保存…">
                保存
              </BusyLabel>
            </button>
          </label>
        )}
        {processors.length > 0 && (
          <div className="dfm-authz-meta">
            条款里应告知客户的次处理者：{processors.map((p) => `${p.name}（${p.role}）`).join("、")}。清单有变化时，已记录的事项会在下次用 AI 前请你重新确认。
          </div>
        )}
        {state.updated_at && <div className="dfm-authz-meta">上次修改：{fmtTime(state.updated_at)}（已记入审计）{saved ? " · 已保存" : ""}</div>}
        {err && <div className="banner banner-red">{err}</div>}
      </div>
      {/* D-225：各事项授权记录的只读总览（律所合规检查用），可导出 */}
      <AuthorizationOverview />
    </section>
  );
}

/** 这台电脑能用的资料（ST-2；V16 IA-2：原“资料来源”页并入数据去向页底，不列“即将推出”；第 48 批改为一行一项的清单）。 */
function SourcesTab({ gate, lawdb, im, onLawdbChanged }: { gate: any; lawdb: any; im: any[]; onLawdbChanged: () => void }) {
  const [content, setContent] = useState<ContentStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<ContentCheckResult[] | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  useEffect(() => {
    api.contentStatus().then(setContent).catch(() => setContent(null));
  }, []);
  const check = () => {
    setChecking(true);
    setCheckFailed(false);
    api
      .contentCheck()
      .then((r) => {
        setResults(r.results);
        setContent(r.status);
        if (r.results.some((x) => x.kind === "lawdb" && (x.outcome === "installed" || x.outcome === "reverted"))) onLawdbChanged();
      })
      // 失败时保留上次结果，另给一句提示（复核 S8B-03）
      .catch(() => setCheckFailed(true))
      .finally(() => setChecking(false));
  };
  const shown = (results ?? [content?.lawdb?.last_check, content?.skills?.last_check].filter(Boolean)) as ContentCheckResult[];
  const lines = shown.map((r) => contentCheckLine(r)).filter(Boolean) as string[];
  const lastAt = shown.map((r) => r.at).sort().at(-1) ?? null;
  const rows: { name: string; state: "可用" | "部分可用" | "未开通" | "不可用"; note: string; detail?: string; more?: string }[] = [
    {
      name: "离线法规库",
      state: lawdb?.error ? "不可用" : lawdb?.coverage?.level === "sample" ? "部分可用" : "可用",
      // 第 27 批（评审 U3-21）：“部分可用”首句直接写收录了多少、缺什么，不让律师去“版本”折叠里找
      note: lawdb?.error
        ? "法规库文件没有通过核对，已停用"
        : `${lawdb?.coverage?.level === "sample" ? `只收录 ${lawdb.coverage.laws ?? 0} 部法律法规、${lawdb.coverage.articles ?? 0} 条正文，不在库里的引用核对不了；` : ""}${content?.configured ? "法条核验在本机完成；法规库可在线更新（见下方）" : "法条核验在本机完成，不联网"}`,
      detail: lawdb?.error ? undefined : lawdb?.display,
    },
    { name: "Kimi AI", state: gate?.routes ? "可用" : "未开通", note: "一般事项可用；敏感事项须管理员放开并全部化名；客户要求不上云的事项不用" },
    // 第 26 批（评审 U2-39）：首层一句结论，完整规则放“了解更多”（口径不删）
    { name: "联网检索", state: gate?.search_configured ? "可用" : "未开通", note: "默认去掉当事人名称再查；要带名称查时逐条问你", more: "含当事人名称的查询须经办律师逐条确认，确认后可按原文发出（保留机构当事人名称；已识别的自然人姓名与证件、账号不发出）。" },
    { name: "公开网页", state: gate?.fetch === "local" ? "可用" : "未开通", note: `只打开公开官方站点与律所允许的网站（${gate?.fetch_allowlist_size ?? 0} 个），新网站要你确认` },
    // V16 IA-2：“案例与工商查询”“律所自有系统”两行“即将推出”不进设置；聊天工具未开通时整行不显示
    ...(im.length > 0 ? [{ name: "从聊天工具转文件（如企业微信）", state: "可用" as const, note: "所内试用版" }] : []),
  ];
  const tone = (s: string) => (s === "可用" ? "ok" : s === "不可用" ? "bad" : s === "部分可用" ? "warn" : "off");
  return (
    <section className="sources-sec no-print" id="sources" aria-labelledby="sec-sources">
      <h2 className="h-sub" id="sec-sources">这台电脑能用的资料</h2>
      <ul className="src-list">
        {rows.map((r) => (
          <li key={r.name} className="src-row">
            <span className={`src-dot src-${tone(r.state)}`} aria-hidden="true" />
            <div className="src-main">
              <div className="src-name">
                <b>{r.name}</b>
                <span className="src-state">{r.state}</span>
              </div>
              <div className="src-note">{r.note}</div>
              {r.more && (
                <details className="quiet-details">
                  <summary>了解更多</summary>
                  {r.more}
                </details>
              )}
              {r.detail && (
                <details className="quiet-details">
                  <summary>收录范围与更新</summary>
                  {r.detail}
                </details>
              )}
            </div>
          </li>
        ))}
      </ul>
      {content?.configured && (
        <div className="panel content-updates">
          <div className="content-updates-head">
            <b>在线更新</b>
            <span className="muted">{CONTENT_PANEL_NOTE}</span>
            <span className="spacer" />
            <button className="btn-ghost btn-sm" disabled={checking} onClick={check}>
              {checking ? "正在检查…" : "检查更新"}
            </button>
          </div>
          {[contentSourceLine("lawdb", content), contentSourceLine("skills", content)].filter(Boolean).map((l) => (
            <div key={l} className="content-line">
              {l}
            </div>
          ))}
          {lines.map((l) => (
            <div key={l} className="content-line muted">
              {l}
            </div>
          ))}
          {checkFailed && <div className="content-line muted">{CONTENT_CHECK_FAILED}</div>}
          {[contentStaleLine("lawdb", content, Date.now()), contentStaleLine("skills", content, Date.now())].filter(Boolean).map((l) => (
            <div key={l} className="content-line content-warn">
              {l}
            </div>
          ))}
          {lastAt && <div className="content-line muted">最近检查：{fmtTime(lastAt)}</div>}
        </div>
      )}
    </section>
  );
}

/**
 * 账号（V16 IA-1、IA-8；第 72 批起团队的事移到“团队”页签）：工作空间（升级为团队、加入团队）、账号与电脑（用量在“套餐与用量”）。
 * “使用许可”正常时不显示，到期或尚未取得时才出一行；本机核对码收进底部“更多”。
 */
function AccountTab({ ws }: { ws: WorkspaceState }) {
  const [cp, setCp] = useState<ControlPlaneStatus | null>(null);
  const [firm, setFirm] = useState<any | null>(null);
  useEffect(() => {
    api.kernelStatus().then((st: any) => setFirm(st?.activation ?? null)).catch(() => setFirm(null));
    api
      .controlPlaneStatus()
      .then(setCp)
      .catch(() => setCp(null));
  }, []);
  const licenseProblem = cp && cp.mode === "control_plane" && (cp.exit_mode || cp.license?.state !== "valid" || cp.policy?.source !== "control_plane");
  // 第 72 批：云端支持工作空间时“所属”由上面的“工作空间”一节说清（本所识别码移到“团队”页签）；旧云端照旧显示
  const legacyFirm = !ws.list?.supported && firm;
  return (
    <div className="device">
      <WorkspaceSection ws={ws} />
      {(firm || cp?.mode === "control_plane") && (
      <section className="panel device-section" aria-labelledby="sec-team">
        <h2 className="section-h h-section" id="sec-team">账号</h2>
        {legacyFirm && (
          <SettingRow label="所属">
            {/* 第 55 批：名称与姓名放进同一个 span——右栏是纵向排列，原来“ · 姓名”这段文字单独落成一行，开头是一个孤零零的“·” */}
            <span>
              <b>{firm.firm?.name}</b>
              {firm.member?.name ? ` · ${firm.member.name}` : ""}
            </span>
            {ws.kind !== "personal" && (
              <details className="quiet-details">
                {/* 第 26 批（评审 U2-06）：“核对码”原来指三样东西——本所的这串改叫“本所识别码” */}
                <summary>团队识别码（入组时核对团队用）</summary>
                <span className="mono">{firm.firm_check_code}</span>：与管理员“设置 → 团队”页里的数字一致，说明你加入的是这个团队。
              </details>
            )}
          </SettingRow>
        )}
        {licenseProblem && (
          <SettingRow label="使用许可">
            {cp!.exit_mode ? (
              <span className="pill pill-red">{cp!.exit_mode.message}</span>
            ) : (
              <>
                {cp!.license?.state === "valid" ? `有效${cp!.license.expires_at ? `，至 ${fmtDate(cp!.license.expires_at)}` : ""}` : cp!.license?.state === "expired" ? "已到期" : "尚未取得"}
                {cp!.policy?.source === "control_plane" ? "" : <div className="muted">还没有取得本所规则，暂按最严的设置运行。</div>}
              </>
            )}
          </SettingRow>
        )}
        {cp && cp.mode === "control_plane" && <AccountSection firm={firm?.firm?.name ?? null} />}
      </section>
      )}
    </div>
  );
}

/**
 * 团队（第 72 批，D-305 第 5 条）：只在团队空间显示。页首（团队名称、我的角色、名额与用量、本所识别码）→ 成员与邀请（管理员可改、合伙人只读）→
 * 协作与离开（团队共享、离所同事、离所交接、退出团队、本机核对码）。单机使用（个人空间、开发形态）时整页不出现（第 26 批 U2-08 的意图不变）。
 */
function TeamTab({ ws, mySafety }: { ws: WorkspaceState; mySafety: string | null }) {
  const [firm, setFirm] = useState<any | null>(null);
  useEffect(() => {
    api.kernelStatus().then((st: any) => setFirm(st?.activation ?? null)).catch(() => setFirm(null));
  }, []);
  const f = ws.features;
  const note = shareIssuerNote(ws.issuer, ws.kind, f.teamAdmin);
  return (
    <div className="device team-page">
      <TeamHeader ws={ws}>
        {firm?.firm_check_code && (
          <details className="quiet-details team-check">
            {/* 设计评分第四轮：与页底“本机识别码”只差一字——改叫“团队识别码”并写明用途 */}
            <summary>团队识别码（入组时核对团队用）</summary>
            <span className="mono">{firm.firm_check_code}</span>：同事加入后，他的这一页应显示同一串数字，说明加入的是同一个团队。
          </details>
        )}
      </TeamHeader>
      {f.teamRead && <TeamAdmin canEdit={f.teamAdmin} myAid={ws.list?.current?.aid ?? null} />}
      {/* 第 72 批评分 C10 第 3 条：团队策略（成员新电脑、本所规则）并进“团队”，管理员要改的都从这一个页签进 */}
      {f.adminTab && (
        <section className="team-policy-sec" aria-labelledby="sec-policy">
          <h2 className="h-section team-sec-title" id="sec-policy">团队策略</h2>
          {f.teamAdmin && (
            <div className="panel device-section">
              <SettingRow label="成员新电脑">
                <MemberDevicePolicy />
              </SettingRow>
            </div>
          )}
          <PolicyTab />
        </section>
      )}
      <section className="panel device-section" aria-labelledby="sec-share">
        <h2 className="section-h h-section" id="sec-share">协作与离开</h2>
        <TeamShare admin={f.teamRead} note={note} />
        <DepartedMembers />
        <Offboarding />
        <LeaveTeam ws={ws} />
        <details className="quiet-details account-more">
          {/* 第 72 批（复测 N7）：这是这台电脑密钥的识别码（同事核对公钥变更时用），与申请接收团队共享事项时读的 12 位入组核对码无关——改名“本机识别码”，避免念错 */}
          <summary>更多：本机识别码（管理员来电核对这台电脑时用）</summary>
          <div>这台电脑重装或重新登记后，管理员会请你在电话里读这串数字。申请接收团队共享事项时要读的是上面的 12 位入组核对码，不是这一串。</div>
          <SafetyCode code={mySafety} />
          <div className="muted">请在电话里或当面逐组读给对方；对方屏幕上的一致才确认。不要截图转发。</div>
        </details>
      </section>
    </div>
  );
}

/**
 * 备份与安全（V16 IA-1；原“本机与安全”）：先给两句结论（案卷安全、备份），再是“备份与恢复 / 遇到问题”两块；
 * 只给 IT 看的内容（电脑环境自检、诊断包里有什么）一律折叠。律师层不出现研发用语。
 */
function BackupTab({ caps, gate, support = null, supportOpen = false }: { caps: Capabilities | null; gate: any; support?: ReactNode; supportOpen?: boolean }) {
  const [envMsg, setEnvMsg] = useState("");
  const [env, setEnv] = useState<Record<string, any> | null>(null);
  const [cp, setCp] = useState<ControlPlaneStatus | null>(null);
  useEffect(() => {
    api.envProbe().then(setEnv).catch(() => setEnv(null));
    api.controlPlaneStatus().then(setCp).catch(() => setCp(null));
  }, []);
  const domainOk = !!caps && !/不可用|未启用|失败/.test(String(caps.execution_domain.status ?? ""));
  const envWarn = env && env.platform === "win32" ? envLines(env).filter((l) => l.warn).length : 0;
  const safe = deviceSafetyTile(domainOk, !!gate, { envWarn, exitMessage: cp?.exit_mode?.message ?? null });
  return (
    <div className="bk-page">
      {/* 第 56 批：页首一条状态（结论 + 后果 | 唯一的下一步）+ 一行案卷保护说明 + 纵向三步；原来两张状态卡与三张步骤卡重复 */}
      <BackupTrack safe={safe} />

      {/* 遇到问题时（第 56 批）：小标题 + 列表行，不再是两张与备份同样重的卡 */}
      <section className="help-sec" aria-labelledby="sec-help">
        <h2 className="help-sec-h" id="sec-help">遇到问题时</h2>
        {/* 检测连接（IP 部署第 50 批）：逐项连一次云端服务，分清加密核对没通过与断网；文字由内核给出 */}
        <ConnectionCheck />
        {/* 脱敏诊断包（v9.2 §3.6）：律师主动导出交给支持团队；内容白名单 + 导出前自证 + 设备签名 */}
        <DiagExportRow>
          <SupportUpload allowed={gate ? !!gate.support_upload_allowed : null} configured={gate ? !!gate.support_configured : null} />
        </DiagExportRow>
        {/* Windows 环境自检（v9.2 §3.7；Y5 P1-6）：只提示会让“本机加密保存”打折扣的系统设置，读不到的写“未知”；给 IT 看，默认折叠 */}
        {env && env.platform === "win32" && (
          // 不自动展开（第 26 批，评审 U2-11）：律师只需知道要不要找 IT；明细给 IT，可一键复制
          <details className="quiet-details help-env">
            <summary>
              电脑环境（给 IT 看）{envWarn > 0 ? <span className="pill pill-orange">{envWarn} 项需要 IT 处理</span> : null}
              {env.checked_at ? <span className="muted"> · 最近检查 {fmtTime(env.checked_at)}</span> : null}
            </summary>
            <ul className="plain-list">
              {envLines(env).map((l) => (
                <li key={l.k} className={l.warn ? "env-warn" : undefined}>
                  {l.k}：{l.v}
                </li>
              ))}
            </ul>
            <div className="banner-actions">
              <button
                className="btn-ghost btn-sm"
                onClick={() => {
                  const text = [`Kimi Work 法律版 电脑环境检查${env.checked_at ? `（${fmtTime(env.checked_at)}）` : ""}`, ...envLines(env).map((l) => `${l.warn ? "【需处理】" : ""}${l.k}：${l.v}`)].join("\n");
                  void navigator.clipboard?.writeText(text).then(() => setEnvMsg("已复制，可以直接发给所内 IT。"), () => setEnvMsg("复制没有成功，请截图这一段发给 IT。"));
                }}
              >
                复制给 IT 的说明
              </button>
              <button className="btn-ghost btn-sm" onClick={() => void api.envProbe(true).then(setEnv).catch(() => {})}>
                重新检查
              </button>
            </div>
            {envMsg && <div className="muted">{envMsg}</div>}
          </details>
        )}
        {/* 第 72 批：个人空间没有“管理”，原来“管理 · 技术支持”的运行状态与诊断收在这里（有联网记录要核对时自动展开） */}
        {support && (
          <details className="quiet-details help-support" open={supportOpen || undefined}>
            <summary>更多技术信息（运行状态、联网记录核对，给 IT 与客服看）</summary>
            {support}
          </details>
        )}
      </section>
    </div>
  );
}

/**
 * 导出诊断信息（一行：说明 + 右侧按钮；点了先就地确认）。备份与安全、技术支持两处共用。
 * 诊断包内容白名单 + 导出前自证 + 设备签名（v9.2 §3.6）；不含任何事项名称、当事人、材料和成果。
 */
function DiagExportRow({ children, detail = false }: { children?: ReactNode; detail?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [diag, setDiag] = useState<{ open: boolean; msg: string }>({ open: false, msg: "" });
  const doExport = async () => {
    setBusy(true);
    try {
      const r = await api.exportDiagnostics();
      if (!r) {
        setDiag({ open: false, msg: "" });
        return;
      }
      setDiag({ open: false, msg: `已保存 ${r.filename}（${Math.ceil(r.bytes / 1024)} KB）。请按所内要求发给 IT 或客服。` });
    } catch (e) {
      setDiag({ open: false, msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="help-row">
      <div className="help-row-main">
        <div className="help-row-text">
          <div className="help-row-title">导出诊断信息</div>
          <p className="help-row-desc">
            {detail
              ? "包含软件版本、电脑环境、最近的出错记录（只有代码、时间与次数）；"
              : "交给所内 IT 或客服排查问题；"}
            <b>不含任何事项名称、当事人、材料和成果。</b>
            {detail ? "导出前会自动检查，发现当事人信息就不导出。" : ""}
          </p>
        </div>
        <div className="help-row-actions">
          {!diag.open ? (
            <button className="btn-ghost btn-sm" onClick={() => setDiag({ open: true, msg: "" })}>
              导出诊断信息
            </button>
          ) : (
            <>
              <button className="btn-ghost btn-sm" onClick={() => setDiag({ open: false, msg: "" })}>
                取消
              </button>
              <button className="btn-primary btn-sm" disabled={busy} aria-busy={busy} onClick={() => void doExport()}>
                <BusyLabel busy={busy} busyText="正在导出…">确认导出</BusyLabel>
              </button>
            </>
          )}
        </div>
      </div>
      {diag.msg && <div className="help-row-msg">{diag.msg}</div>}
      {!detail && (
        <details className="quiet-details">
          <summary>诊断信息里有什么</summary>
          软件版本、电脑环境和最近的出错记录（只有代码、时间与次数）。导出前会自动检查，发现当事人信息就不导出。
        </details>
      )}
      {children}
    </div>
  );
}

/**
 * 本机核对码（第 26 批，评审 U2-07）：34 位按 4 位一组、分两行显示，每组下面标组序号，电话里读到第几组不会串行；
 * 长度按 10-23 拍板不变，只改呈现。不给“复制”——核对要读出来。
 */
function SafetyCode({ code }: { code: string | null }) {
  if (!code) return <b className="mono safety-code">—</b>;
  const groups = groupDigits(code).split(" ");
  return (
    <div className="safety-groups" role="group" aria-label="本机识别码">
      {groups.map((g, i) => (
        <span key={i} className="safety-group">
          <b className="mono">{g}</b>
          <small>{i + 1}</small>
        </span>
      ))}
    </div>
  );
}

/** 本机与安全顶部的三块结论（v9.4）。tone：ok 绿 / warn 橙 / info 灰。 */
function StatusTile({ tone, title, line, action }: { tone: "ok" | "warn" | "info"; title: string; line: string; action?: { label: string; href: string } }) {
  return (
    <div className={`status-tile status-tile-${tone}`} role="listitem">
      <div className="status-tile-title">
        <span className="status-tile-dot" aria-hidden="true">{tone === "ok" ? "✓" : tone === "warn" ? "!" : "·"}</span>
        {title}
      </div>
      <div className="status-tile-line">{line}</div>
      {action && (
        <button className="btn-link" onClick={() => document.getElementById(action.href)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
          {action.label} →
        </button>
      )}
    </div>
  );
}

/** 管理（ST-1、ST-4）：成员、律所策略、中软侧操作记录、诊断（工程细节）、召回评测（律所内）。 */
function AdminTab({ legacyMembers = false, withPolicy = true, ...props }: { caps: Capabilities | null; gate: any; devices: any[]; unresolved: any[]; onReconciled: () => void; im: any[]; recovery: any; legacyMembers?: boolean; withPolicy?: boolean }) {
  // 子标签收敛（Z3 评审 #7.3、I2 遗留）：诊断与替换准确度测试是给律所 IT 与中软运维用的，收进“技术支持”
  // V16 IA-4：“技术支持”直接展开诊断首层；替换准确度测试升为独立二级标签“代号准确度”（进所评测是售前动作）
  // 第 68 批：客户端不再展示团队用量——本所额度、按成员、律所上限与个人额度统一在云端控制台（本所 · 概览 / 用量 / 成员）管理
  // 第 72 批：“成员”移到“团队”页签（成员、邀请、电脑待确认、新电脑策略）；这里留团队策略、操作记录、技术支持、代号准确度。
  // 取不到工作空间类型（开发形态、没有账号）时保留原来的成员页（legacyMembers）
  // 团队空间（withPolicy = false）：团队策略在“团队”页签，这里从操作记录开始
  const [sub, setSub] = useState<"members" | "policy" | "cp_audit" | "support" | "recall">(legacyMembers ? "members" : withPolicy ? "policy" : "cp_audit");
  return (
    <div>
      <div className="tabs" role="tablist" aria-label="管理">
        {(
          [
            ...(legacyMembers ? ([["members", "成员"]] as const) : []),
            ...(withPolicy ? ([["policy", "团队策略"]] as const) : []),
            ["cp_audit", "操作记录"],
            ["support", "技术支持"],
            // 第 72 批评分 C10 第 4 条：“代号准确度”是内部说法——测的是姓名、机构等能不能都被换成化名
            ["recall", "化名效果检测"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={sub === k} className={`tab${sub === k ? " active" : ""}`} onClick={() => setSub(k)}>
            {label}
          </button>
        ))}
      </div>
      {sub === "members" && <MembersAdmin />}
      {sub === "policy" && <PolicyTab />}
      {sub === "cp_audit" && <CpAuditPanel />}
      {sub === "support" && (
        <>
          {/* 第 56 批：运行状态（哪里坏了）→ 联系支持前（怎么求助）→ 给 IT 的技术信息（两个折叠原样在最后） */}
          <DiagnosticsTab {...props} />
        </>
      )}
      {sub === "recall" && <RecallEvalPanel />}
    </div>
  );
}

function DiagnosticsTab({ caps, gate, devices, unresolved, onReconciled, im, recovery }: { caps: Capabilities | null; gate: any; devices: any[]; unresolved: any[]; onReconciled: () => void; im: any[]; recovery: any }) {
  const [busy, setBusy] = useState(false);
  const [logLevel, setLogLevel] = useState<string | null>(null);
  const [build, setBuild] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [msg, setMsg] = useState("");
  const [ident, setIdent] = useState<{ firm: string | null; tid: string | null; device: string | null; edition: string | null }>({ firm: null, tid: null, device: null, edition: null });
  // 运行状态（第 56 批）：本机功能一览与联网程序状态先读一次；“立即检测”跑真实的连接检测并重读能力，逐行更新
  const [liveCaps, setLiveCaps] = useState<Capabilities | null>(caps);
  const [liveGate, setLiveGate] = useState<any>(gate);
  const [diag, setDiag] = useState<ConnectionDiagnosis | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState("");
  const [copyMsg, setCopyMsg] = useState("");
  useEffect(() => setLiveCaps(caps), [caps]);
  useEffect(() => setLiveGate(gate), [gate]);
  useEffect(() => {
    api
      .kernelStatus()
      .then((st: any) => {
        setLogLevel(typeof st?.log_level === "string" ? st.log_level : null);
        setBuild([st?.app_version ? `${st?.edition === "trial" ? "试用版" : "安装包"} ${st.app_version}` : st?.edition === "trial" ? "试用版" : "开发形态", st?.version ? `内核 ${st.version}` : ""].filter(Boolean).join(" · "));
        setAppVersion(displayVersion(st?.app_version, st?.version));
        setIdent((x) => ({ ...x, firm: st?.firm_name ?? null, tid: st?.tenant_id ?? null, edition: st?.edition ?? null }));
      })
      .catch(() => setLogLevel(null));
    api
      .devices()
      .then((r) => setIdent((x) => ({ ...x, device: r.my_device_id ?? null })))
      .catch(() => {});
  }, []);
  const runChecks = async () => {
    setChecking(true);
    setCheckErr("");
    try {
      const [d, c, st] = await Promise.all([api.connectionDiagnose(), api.capabilities().catch(() => null), api.kernelStatus().catch(() => null)]);
      setDiag(d);
      if (c) setLiveCaps(c);
      if (st) setLiveGate(st.egress_gate ?? null);
    } catch (e) {
      setCheckErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const checks = supportChecks({ caps: liveCaps, gate: liveGate, diag });
  const versionText = [
    `Kimi Work 法律版 ${appVersion || "—"}`,
    build ? `版本标记：${build}` : "",
    ident.firm || ident.tid ? `律所：${ident.firm ?? "—"}（识别码 ${ident.tid ?? "—"}）` : "",
    ident.device ? `这台电脑：${ident.device}` : "",
    `系统：${navigator.platform || "—"}`,
    `复制时间：${fmtTime(new Date().toISOString())}`,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="sup-page">
      {/* 一、运行状态：哪里坏了（状态来自真实数据；没检测过写“尚未检测”） */}
      <section className="help-sec" aria-labelledby="sec-run">
        <div className="help-sec-head">
          <h2 className="help-sec-h" id="sec-run">
            运行状态<span className="sup-sum">{diag || !checking ? ` · ${supportSummary(checks)}` : ""}</span>
          </h2>
          <button className="btn-ghost btn-sm" disabled={checking} aria-busy={checking} onClick={() => void runChecks()}>
            <BusyLabel busy={checking} busyText="正在检测…">{diag ? "重新检测" : "立即检测"}</BusyLabel>
          </button>
        </div>
        <ul className="sup-checks">
          {checks.map((c) => (
            <li key={c.key} className={`sup-check${c.key === "computer_use" ? " is-absent" : ""}`}>
              <div className="sup-check-main">
                {checking && c.probed ? <KimiPulse size="sm" label="检测中" /> : <span className={`sdot sdot-${c.tone}`} aria-hidden="true" />}
                <span className="sup-check-name">{c.name}</span>
                <span className="sup-check-desc">{c.desc}</span>
                <span className={`sup-check-state sup-${c.tone}`}>{checking && c.probed ? "检测中…" : c.state}</span>
              </div>
              {c.fix && !checking && <p className="sup-fix">怎么办：{c.fix}</p>}
            </li>
          ))}
        </ul>
        {/* 没能确认是否发出的内容：要管理员登记结论，属于“哪里坏了”，放在运行状态里 */}
        {unresolved.length > 0 && (
          <>
            <div className="section-title">没能确认是否发出的内容</div>
            <p className="muted">发送过程中软件中断，无法确定这些内容是否已经发出。请核实后登记结论（不会重发，也不改原来的记录）。</p>
            <table className="data">
              <thead><tr><th>时间</th><th>用途</th><th>去向</th><th>结论</th></tr></thead>
              <tbody>
                {unresolved.map((r) => (
                  <tr key={r.record_id}>
                    <td>{fmtTime(r.created_at)}</td>
                    <td>{PURPOSE_TEXT[String(r.purpose)] ?? r.purpose}</td>
                    <td title={String(r.destination_host ?? "")}>{destinationLabel(String(r.destination_host ?? ""), String(r.purpose ?? ""))}</td>
                    <td>
                      {r.reconcile === "done" ? (r.resolution === "not_sent" ? "确认未发出" : r.resolution === "confirmed_sent" ? "确认已发出" : "无法确定") : (
                        <>
                          {(["confirmed_sent", "not_sent", "unknown"] as const).map((res) => (
                            <button
                              key={res}
                              className="btn-link"
                              disabled={busy}
                              onClick={async () => {
                                setBusy(true);
                                try {
                                  await api.egressReconcile(r.record_id, res);
                                  onReconciled();
                                } finally {
                                  setBusy(false);
                                }
                              }}
                            >
                              {res === "confirmed_sent" ? "已发出" : res === "not_sent" ? "未发出" : "无法确定"}
                            </button>
                          ))}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {checkErr && <div className="banner banner-red">没能检测：{checkErr}</div>}
        {diag && (
          <details className="quiet-details sup-diag">
            <summary>逐项连接结果（{fmtTime(diag.checked_at)}）</summary>
            <ConnectionResult result={diag} />
            <button className="btn-link" onClick={() => void navigator.clipboard?.writeText(connectionReport(diag)).then(() => setCopyMsg("已复制检测结果，可以直接发给所内 IT。"), () => setCopyMsg("复制没有成功，请截图这一段发给 IT。"))}>
              复制给 IT 的说明
            </button>
          </details>
        )}
      </section>

      {/* 二、联系支持前：导出诊断信息、详细运行记录、复制版本信息 */}
      <section className="help-sec" aria-labelledby="sec-support">
        <h2 className="help-sec-h" id="sec-support">联系支持前</h2>
        <DiagExportRow detail>
          <SupportUpload allowed={liveGate ? !!liveGate.support_upload_allowed : null} configured={liveGate ? !!liveGate.support_configured : null} />
        </DiagExportRow>
        {logLevel && (
          <div className="help-row">
            <div className="help-row-main">
              <div className="help-row-text">
                <div className="help-row-title">
                  详细运行记录
                  {logLevel === "debug" && (
                    <span className="sup-on">
                      <span className="sdot sdot-ok" aria-hidden="true" />
                      已开启
                    </span>
                  )}
                </div>
                <p className="help-row-desc">{logLevel === "debug" ? "已开启，24 小时后自动关闭；同样不含任何事项内容。" : "排查偶发问题时，可临时记录更详细的运行事件（同样不含任何事项内容）。"}</p>
              </div>
              <div className="help-row-actions">
                <button
                  className="btn-ghost btn-sm"
                  onClick={async () => {
                    try {
                      const r = await api.setLogLevel(logLevel === "debug" ? "info" : "debug");
                      setLogLevel(r.level);
                    } catch (e) {
                      setMsg((e as Error).message);
                    }
                  }}
                >
                  {logLevel === "debug" ? "关闭详细记录" : "开启 24 小时"}
                </button>
              </div>
            </div>
            {msg && <div className="help-row-msg">{msg}</div>}
          </div>
        )}
        <div className="help-row">
          <div className="help-row-main">
            <div className="help-row-text">
              <div className="help-row-title">
                版本信息<span className="sup-ver">Kimi Work 法律版 {appVersion || "—"}</span>
              </div>
              <p className="help-row-desc">客服会问版本号、团队识别码与这台电脑的编号：一键复制，直接粘贴给客服。</p>
              <p className="sup-ident mono">
                {ident.tid && <span>团队识别码 {ident.tid}</span>}
                {ident.device && <span>这台电脑 {ident.device}</span>}
                {build && <span>{build}</span>}
              </p>
            </div>
            <div className="help-row-actions">
              <button className="btn-ghost btn-sm" onClick={() => void navigator.clipboard?.writeText(versionText).then(() => setCopyMsg("已复制版本信息。"), () => setCopyMsg("复制没有成功，请截图这一段发给客服。"))}>
                复制版本信息
              </button>
            </div>
          </div>
          {copyMsg && <div className="help-row-msg" role="status">{copyMsg}</div>}
        </div>
      </section>

      {/* 三、给 IT 的技术信息（原样保留在最后） */}
      <section className="help-sec sup-it" aria-labelledby="sec-it">
        <h2 className="help-sec-h" id="sec-it">给 IT 的技术信息</h2>
      <details className="quiet-details tech-info">
        <summary>技术信息（给 IT）</summary>
        <ul className="plain-list">
          {build && <li>版本标记：<span className="mono">{build}</span></li>}
          <li>
            表格计算：在隔离环境中运行（不联网、只见本事项）；状态：{caps?.execution_domain.status ?? "未知"}
          </li>
          <li>更强的系统级隔离：本版本未提供。</li>
          <li>联网：AI、检索、打开网页都只经一个独立的联网程序（{gate?.sole_exit ?? caps?.sole_exit ?? "应用层约束"}）；表格计算环境不联网。</li>
          <li>联网程序：{gate ? `${gate.running ? "运行中" : "待用"}，已启动 ${gate.stats?.starts ?? 0} 次` : "未启用"}</li>
        </ul>
        <div className="section-title">已登记的电脑</div>
        <table className="data">
          <thead><tr><th>电脑</th><th>角色</th><th>状态</th><th>登记</th></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.device_id}><td className="mono" title={String(d.device_id)}>{shortId(String(d.device_id))}</td><td>{DEVICE_ROLE_LABELS[String(d.role)] ?? "成员"}</td><td>{d.status === "revoked" ? "已停用" : "有效"}</td><td>{fmtTime(d.created_at)}</td></tr>
            ))}
          </tbody>
        </table>
        {import.meta.env.DEV && caps && caps.rows.length > 0 && (
          <>
            <div className="section-title">能力账本（仅开发形态显示）</div>
            <table className="data">
              <thead><tr><th>能力</th><th>状态</th><th>说明</th></tr></thead>
              <tbody>{caps.rows.map((r) => <tr key={r.capability}><td>{r.capability}</td><td>{r.status}</td><td className="muted">{r.note}</td></tr>)}</tbody>
            </table>
          </>
        )}
        <div className="section-title">数据去向（技术版）</div>
        <TechnicalVisibility gate={gate} im={im} recovery={recovery} />
      </details>
      {/* 本机密钥保护的如实说明（调研 Y5 §7.3 建议原文）：V16（审计第 24 条）从律师版“数据去向”移到这里，律师版只留一句 */}
      <details className="quiet-details">
        <summary>加密保存的局限（给 IT）</summary>
        <ol className="plain-list">
          <li>案件数据在本机加密保存，解密密钥受 Windows 数据保护（DPAPI）保护、与你的 Windows 账户绑定；以同一账户运行的其他程序（包括恶意软件）技术上可以调用同一保护机制，使用域账户的律所，域管理员按 Windows 的设计也具备恢复能力。</li>
          <li>这台电脑的身份凭证与解密密钥目前由软件保存，尚未存放在电脑的安全芯片（TPM）中。</li>
          <li>律所恢复所需的根密钥目前保存在各成员的电脑上；律所版将改为线下分片保管。</li>
          <li>删除事项会销毁本机密钥并删除数据；Windows 还原点、文件历史和备份软件中的旧副本不在删除范围内。</li>
          <li>建议开启 BitLocker，并使用本机（非漫游、非重定向）的用户目录。</li>
        </ol>
      </details>
      </section>
    </div>
  );
}

/** 原“中软看得到什么”逐情形明细（技术版，供管理员与客户 IT 核对；律师版见“数据去向说明”）。 */
function TechnicalVisibility({ gate, im, recovery }: { gate: any; im: any[]; recovery: any }) {
  const [updatesOn, setUpdatesOn] = useState(false);
  const [relayUsed, setRelayUsed] = useState(false);
  const [contentOn, setContentOn] = useState(false);
  useEffect(() => {
    updates.status().then((u) => setUpdatesOn(!!u?.enabled)).catch(() => setUpdatesOn(false));
    api.relayStatus().then((r) => setRelayUsed((r.matters ?? 0) > 0)).catch(() => setRelayUsed(false));
    api.contentStatus().then((c) => setContentOn(!!c?.configured)).catch(() => setContentOn(false));
  }, []);
  const rows: { situation: string; enabled: boolean; sees: string; notSees: string }[] = [
    {
      situation: "法规库与方法模板的在线更新",
      enabled: contentOn,
      sees: "每天一次（及手动“检查更新”）经联网出口的检查与下载：席位令牌所含的租户、成员、席位与设备编号，本机 IP，检查时刻，所请求的通道清单与包文件名（文件名含版本；增量包还反映本机当前法规库版本）；分发服务保存下载记录（租户、设备编号的密钥摘要、类别、通道、文件名、时间）",
      notSees: "事项与案卷的任何内容、事项编号、查询与对话",
    },
    {
      situation: "上传诊断包给中软支持",
      enabled: !!gate?.support_configured && !!gate?.support_upload_allowed,
      sees: "律师逐次预览并确认后上传的脱敏诊断包，保存 7 天，运营查看记入支持服务的访问审计：设备编号原文与本机签名；软件版本与运行环境（操作系统、处理器、内存）；电脑环境自检（BitLocker、漫游/重定向目录、同步盘、本地转储、防火墙规则、杀毒软件产品名）；后台服务状态；近 30 天任务按场景与状态计数、最近 20 个任务的状态、错误代码、开始时刻与时长；出站与审计按类别计数；各数据表条数（反映业务量）；近 7 天运行记录（事件代码、时间与封闭字段，最多 200 条）。另有本机网络地址、只限支持服务的短期凭据所含的租户、成员、席位与设备编号、上传时刻",
      notSees: "事项名称、当事人、材料、成果、任务内容、文件名、检索式（上传前本机按全部当事人与令牌原文自证）",
    },
    {
      situation: "期限提醒（电脑关机也提醒）",
      enabled: !!gate?.notify_configured,
      sees: "每条提醒的触发时刻（到分钟；按“提前几天、几点”可大致推出期限日）、接收设备编号（本人在用的设备；选“事项成员”时含事项成员的设备）、每台设备一份密文（明文补齐到固定长度后加密）、是否已送达或暂缓；建立者的成员编号、版本号（反映改动次数）与最后修改时刻、每名成员每天的写入次数；撤销后的墓碑（编号、版本、建立者）保存到触发后 7 天；领取凭据与取提醒时：只限通知服务的短期凭据所含的租户、成员、席位与设备编号，本机 IP，客户端在线时约每分钟一次的取提醒请求时刻（反映电脑何时开机）；签发通知凭据记入中软侧操作记录。触发后 7 天删除；撤销、改期、删除事项后在这台电脑下次联网巡检成功时删除",
      notSees: "期限类型、期限日本身、事项名称与编号、当事人、备注（在律师电脑上用接收设备的公钥加密、补齐长度、并由发出设备签名；中软解不开，也不能把一份密文挪给别的提醒或别的设备；撤销后迟到的旧版本登记会被云端拒收，但被攻破的云端仍可能重放一次已撤销的提醒）",
    },
    {
      situation: "团队事项经中软共享服务同步",
      enabled: !!gate?.relay_configured && (!!gate?.share_relay_allowed || relayUsed),
      sees: "每个团队事项的匿名编号（随机生成）；每次改动的同步记录与引用的材料块，均为按事项密钥加密的密文，切成不超过 4 MiB 的块、按密文的摘要存放，材料的确切字节数可见（保存到律所退约整体删除；关闭开关后已保存的仍在；共享服务上的事项状态异常时中软运营可按事项重置——删除该事项在共享服务上的密文，各成员的电脑随后（至多 6 小时，点“立即同步”即时）重新上传本机写入的内容，已不再使用的电脑写过的不再上传；单个事项的团队删除指令待后续版本）；每条同步记录的编号、写入设备与写入成员编号、条数（行数）、事件序号区间、大小、时间与密钥纪元；能读取该事项的设备编号；同步记录明文部分里的写入设备证书（成员编号、角色、公钥——成员编号由律所设定，可能含姓名拼音）与面向各设备的密钥包裹（密文，含各纪元、已移出成员的设备与是否启用恢复托管，反映团队加入、移出的时间线）；取新改动的请求时刻（客户端在线时长轮询，反映电脑何时开机）；只限共享服务的短期凭据所含的租户、成员、席位与设备编号，本机 IP；签发共享服务凭据记入中软侧操作记录。设备被停用后，在共享服务刷新停用名单之前（通常 30 秒内、至多约 10 分钟）该设备仍可能取到新的密文",
      notSees: "事项名称、当事人、材料原文与文件名、成果、任务内容（都在律师电脑上按事项密钥加密，中软没有事项密钥）；材料明文的摘要（共享服务只按密文摘要寻址）。成员电脑先核验同步记录的设备签名与证书链再取材料，材料按“解开后的摘要 = 名称”核对后才放进本机：被攻破的共享服务换掉的内容会被拒收，但它可以扣留、延迟或丢弃改动",
    },
    {
      situation: "自动更新",
      enabled: updatesOn,
      sees: "每 6 小时一次的更新检查与安装包下载：本机 IP、操作系统与应用版本（请求的 User-Agent）、更新渠道（保存在更新服务器的访问日志里）",
      notSees: "账号、设备编号、任何持久的本机标识（更新编号固定为全零）、事项与案卷的任何内容",
    },
    {
      situation: "日常使用 AI",
      enabled: true,
      sees: "账号、设备与执行域等级、席位、用量；匿名事项编号与推理调用元数据（保存）；匿名事项编号对应的数据级别、模型端点、依据是否齐备、事项策略版本计数与更新时间（保存，供网关二次检查）；律所策略与律所系统接入登记（含抓取允许访问的网站追加的域名、律所系统接入服务地址与工具清单）、设备证书（成员编号、角色、公钥）与管理员签名记录、设备与席位的停用记录（含预先停用的设备编号）（保存）；推理时任务涉及的文档内容（证件、账户、联系方式与自然人姓名替换为代号后过境，不落盘）；网关内容安全检查命中的类别编号与次数（随该次调用的元数据保存，含匿名事项编号与席位；不含命中的文字）",
      notSees: "落盘的案卷、成果、会话转录、令牌映射表、事项名称",
    },
    {
      situation: "启用联网检索",
      enabled: !!gate?.search_configured,
      sees: "令牌化并去除已知当事人名称的查询原文与发起席位（过境，不保存查询原文），可能含案情要素；含当事人名称的查询须经办律师逐条确认，确认后可按原文发出（保留机构当事人名称；已识别的自然人姓名与证件、账号不发出）",
      notSees: "查询属于哪个事项（检索调用不携带事项编号）",
    },
    {
      situation: "启用法源与主体信息查询",
      enabled: false,
      sees: "案例核验与工商查询所需的查询项（可能含当事人或关联方名称，经确认或按策略放行），转给数据商",
      notSees: "事项其他内容",
    },
    {
      situation: "从聊天工具转文件",
      enabled: false,
      sees: "律师发给机器人的文字指令与文件名（过境）；电脑离线时后端在内存取得文件后立即加密暂存",
      notSees: "落盘的文件明文",
    },
    {
      situation: "使用无事项问答",
      enabled: !!gate,
      sees: "问题文本（经联网出口令牌化与当事人词典检查后过境，不保存）与发起席位",
      notSees: "问答历史（只在本人设备）",
    },
    {
      situation: "选择中软托管恢复",
      enabled: !!recovery?.escrow,
      sees: "HSM 中的恢复材料；两名管理员签名请求 + 72 小时冷静期后可协助恢复——此时“中软无密钥”对本所不成立",
      notSees: "平时仍看不到事项内容",
    },
  ];
  const on = rows.filter((r) => r.enabled);
  return (
    <>
      <table className="data visibility-table">
        <thead><tr><th>本所已启用的情形</th><th>中软看得到（转发或保存）</th><th>中软看不到</th></tr></thead>
        <tbody>{on.map((r) => <tr key={r.situation}><td><b>{r.situation}</b></td><td>{r.sees}</td><td>{r.notSees}</td></tr>)}</tbody>
      </table>
      {im.length > 0 && <p className="muted">当前的聊天工具接入是所内试用版，不经中软。</p>}
    </>
  );
}

const AREA: Record<string, string> = {
  policy: "律所策略",
  directory: "已登记的电脑",
  connectors: "律所系统接入",
  license: "许可",
  salt: "代号规则",
  seat: "席位",
  drafts: "草稿",
  revocation: "停用",
  clock: "时钟",
};

/** 设备的证书角色 → 中文（第 26 批，评审 U2-15：原来直接显示 admin）；与成员页同一套说法。 */
const DEVICE_ROLE_LABELS: Record<string, string> = { firm_admin: "管理员", admin: "管理员", partner: "合伙人", lawyer: "律师", assistant: "助理", member: "成员" };

/** 去向的人话（审计 1.2：原来直接显示主机名；主机名放悬停）。 */
function destinationLabel(host: string, purpose: string): string {
  if (purpose === "search") return "联网检索";
  if (purpose === "fetch") return host ? `网站 ${host}` : "打开网页";
  if (purpose === "model" || /kimi|moonshot/i.test(host)) return "Kimi AI";
  return host || "—";
}
const PURPOSE_TEXT: Record<string, string> = { model: "发给 AI", search: "联网检索", fetch: "打开网页", chat: "问答" };

/** 设备编号过长时截断并加省略号（悬停显示全称）。 */
function shortId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 23)}…` : id;
}

const CP_ERROR_TEXT: Record<string, string> = {
  revoker_required: "这台电脑不是管理员或合伙人的电脑",
  device_id_invalid: "设备编号不合法",
  cp_path_not_allowed: "设备编号不合法",
  cp_unreachable: "Kimi Work 服务不可达",
  cp_not_configured: "Kimi Work 服务地址未配置",
  device_auth_stale: "本机时钟与 Kimi Work 服务相差超过 5 分钟",
  cert_required: "那台电脑还没登记；它一登记就会被停用（通常 10 分钟内）",
  cert_invalid: "那台电脑还没登记；它一登记就会被停用（通常 10 分钟内）",
  pre_revocation_limit: "预先停用已达上限：那台电脑一登记就会被停用（通常 10 分钟内）",
};

/** 待同步动作的状态（复核 S6-A22、S6-B31）：区分“会自动重试”与“需人工处理”。 */
function pendingActionText(a: { state?: string; last_error: string | null }): string {
  const why = a.last_error ? CP_ERROR_TEXT[a.last_error] ?? a.last_error : null;
  if (a.state === "failed") return `停用没有成功（${why ?? "原因不明"}）。请在管理员电脑上再停用一次，或稍后点“立即同步”`;
  if (a.state === "submitted") return "已提交，等待生效（几分钟内）";
  return `待发送，联网后自动重试${why ? `（上次失败：${why}）` : ""}`;
}

/** 放宽项 → 人话（签名前给管理员看清楚放宽了什么）。 */
function relaxationText(r: string): string {
  const [k, ...rest] = r.split(":");
  const v = rest.join(":");
  if (k === "max_mode") return `AI 最高档位放宽到“${MODE_TEXT[v] ?? v}”`;
  if (k === "auto_preauthorization") return v === "search_generalized" ? "“放手做”可以事先同意：去掉当事人名称后的检索" : `“放手做”可以事先同意：${v}`;
  if (k === "fetch_allowlist") return `官方网站之外还可打开的网站：${v}`;
  if (k === "l3a_standard_model") return "敏感事项可以用通用 AI 服务（全部化名）";
  if (k === "support_upload") return "律师可以把问题报告直接发给客服（每次确认；保存 7 天）";
  if (k === "share_relay") return "同事之间可以经中软同步团队事项（加密，中软打不开）";
  if (k === "connector") return `登记律所系统接入：${v}`;
  return r;
}

function policyLine(st: ControlPlaneStatus): string {
  const p = st.policy;
  if (!p) return "未知";
  if (p.source === "local_dev") return import.meta.env.DEV ? "开发形态：律所规则取本机配置项（未接入中软）" : "当前律所规则：中软默认（最严）";
  if (p.source === "strictest_fallback") {
    if (p.fallback_reason === "expired") return `律所策略第 ${p.version} 版已于 ${fmtTime(p.expires_at ?? "")} 过期：已改按最严设置运行（不比原规则宽）`;
    if (p.fallback_reason === "signers_insufficient") return `确认律所规则（第 ${p.version} 版）的管理员不够了，暂时按最严规则执行`;
    if (p.fallback_reason === "unrecognized_newer") return "本所规则是新版本，这台电脑需要先更新软件；更新前按最严规则运行";
    return "尚未取得律所策略：按最严设置运行";
  }
  // 第 56 批：签名人是成员编号（usr_…），不显示给律师——只说有几名管理员确认过；是谁、何时，在“操作记录”里
  const who = p.signers.length > 0 ? `已由 ${p.signers.length} 名管理员确认` : "最严设置，Kimi Work 服务签发";
  // 第 72 批评分 C10 第 3 条：日期统一“12 月 27 日 12:00”（跨年写年份），与操作记录同一写法
  // 设计评分第三轮 C10：日期与时刻不断在两行（不换行空格）
  return `本所规则第 ${p.version} 版（${who}）· ${dueLabel(p.expires_at).replace(/ /g, "\u00a0")}\u00a0前有效`;
}

function PolicyTab() {
  const [st, setSt] = useState<ControlPlaneStatus | null>(null);
  const [drafts, setDrafts] = useState<PolicyDraft[] | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => {
    api.controlPlaneStatus().then(setSt).catch((e) => setMsg(e.message));
    // 草稿只对管理员设备可见（非管理员调用会被内核拒绝：不显示）
    api.policyDrafts().then((r) => setDrafts(r.drafts)).catch(() => setDrafts(null));
  };
  useEffect(load, []);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
      setMsg(done);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!st) return <p className="muted">读取中…</p>;
  const pol = st.policy;
  return (
    <div className="device">
      {st.exit_mode && <div className="banner banner-red">{st.exit_mode.message}</div>}
      {msg && <div className="banner">{msg}</div>}
      <div className="panel">
        <div className="device-row">
          <div className="device-k">生效策略</div>
          <div>
            <b>{policyLine(st)}</b>
            {/* 第 72 批评分 C10 第 4 条：逐条分行（规则名：取值），取值不在词中折行 */}
            {pol && (
              <dl className="policy-rules">
                <div>
                  <dt>AI 最多能自己做到哪一步</dt>
                  <dd>{MODE_TEXT[pol.body.max_mode] ?? pol.body.max_mode}</dd>
                </div>
                <div>
                  <dt>官方网站之外还能打开的网站</dt>
                  <dd>{pol.body.fetch_allowlist_extra.length > 0 ? pol.body.fetch_allowlist_extra.join("、") : "没有（只限法院、政府等官方网站）"}</dd>
                </div>
                <div>
                  <dt>敏感事项能否用通用 AI 服务</dt>
                  <dd>{pol.body.l3a_standard_model === "allow" ? "可以（全部化名后发送）" : "不可以"}</dd>
                </div>
              </dl>
            )}
            {pol && pol.relaxations.length > 0 && <div className="muted">比最严设置宽的地方：{pol.relaxations.map(relaxationText).join("；")}</div>}
          </div>
        </div>
        {st.mode === "control_plane" && (
          <>
            <div className="device-row">
              <div className="device-k">许可</div>
              <div>
                {st.license?.state === "valid" ? `${dueLabel(st.license.expires_at)} 前有效（${st.license.edition === "firm" ? "律所版" : "团队版"}，${st.license.seats} 个席位）` : st.license?.state === "expired" ? "已到期：不能再发起新任务，已有成果可以查看和导出" : "尚未取得"}
                <div className="muted">
                  {st.admin_threshold_pinned === false
                    ? "取得许可之前，本所规则只能比最严设置更严。"
                    : (st.admin_threshold ?? 1) > 1
                      ? `要把本所规则放宽，需要 ${st.admin_threshold} 位管理员分别在自己的电脑上同意。`
                      : "要把本所规则放宽，需要管理员在自己的电脑上同意。"}
                </div>
              </div>
            </div>
            <div className="device-row">
              <div className="device-k">离线可用</div>
              <div>
                {st.seat?.has_token && st.seat.expires_at ? `断网也能用到 ${dueLabel(st.seat.expires_at)}；联网后会自动延长` : "暂时用不了 Kimi 和联网检索（还没连上中软，或本所许可已失效），本机功能不受影响"}

              </div>
            </div>
            <div className="device-row">
              <div className="device-k">Kimi Work 服务</div>
              <div>
                {st.last_sync ? `上次同步 ${dueLabel(st.last_sync.at)} · ${st.last_sync.ok ? "正常" : "部分未完成（本机已接受的内容继续有效）"}` : "尚未同步"}
                {st.directory?.stale && <div className="muted">已登记电脑的名单过期未更新：已知的停用保持，新的停用信息可能不完整。</div>}
                {(st.pending_actions ?? []).length > 0 && (
                  <div className="muted">
                    以下停用还没生效（生效前，那台电脑可能还能用 AI）：
                    <ul className="plain-list">
                      {st.pending_actions!.map((a) => (
                        <li key={`${a.kind}:${a.target}`}>
                          {a.kind === "revoke_device" ? <span title={a.target}>停用设备 {shortId(a.target)}</span> : a.kind}：{pendingActionText(a)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="banner-actions">
                  <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api.controlPlaneSync(), "已同步")}>立即同步</button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      {(st.alerts ?? []).length > 0 && (
        <>
          <div className="section-title">需要管理员留意的事</div>
          <table className="data">
            <thead><tr><th>时间</th><th>范围</th><th>说明</th><th></th></tr></thead>
            <tbody>
              {st.alerts!.map((a) => (
                <tr key={a.alert_id}>
                  <td>{fmtTime(a.created_at)}</td>
                  <td>{AREA[a.area] ?? a.area}</td>
                  <td>{a.detail}</td>
                  <td><button className="btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api.controlPlaneAck(a.alert_id), "已标记知悉")}>知悉</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {(st.key_changes ?? []).length > 0 && (
        <>
          <div className="section-title h-sub">有同事换了电脑，请核对后确认</div>
          <p>请对方读出他“设置 → 团队 · 更多”里的本机识别码，与他读的一致再确认；确认前他的新电脑收不到事项内容。</p>
          <table className="data">
            <thead><tr><th>成员</th><th>设备</th><th>对方读出的本机识别码</th></tr></thead>
            <tbody>
              {st.key_changes!.map((k) => (
                <tr key={k.device_id}>
                  <td>{k.member_id}</td>
                  <td className="mono" title={k.device_id}>{shortId(k.device_id)}</td>
                  <td>
                    <input value={codes[k.device_id] ?? ""} onChange={(e) => setCodes({ ...codes, [k.device_id]: e.target.value })} placeholder="请对方读出本机识别码" />
                    <button className="btn-ghost btn-sm" disabled={busy || !(codes[k.device_id] ?? "").trim()} onClick={() => act(() => api.keyChangeConfirm(k.device_id, codes[k.device_id] ?? ""), "本机识别码一致：已确认他的新电脑")}>核对</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="section-title">已登记的律所系统接入</div>
      {(st.connectors ?? []).length === 0 ? (
        <p className="muted">还没有接入本所系统（如 OA、案件管理）。接入要管理员在自己的电脑上同意；本所规则过期时，接入会暂停使用。</p>
      ) : (
        <table className="data">
          <thead><tr><th>律所系统接入</th><th>版本</th><th>服务地址</th><th>可接收至</th><th>工具数</th><th>签名管理员</th></tr></thead>
          <tbody>{st.connectors!.map((c) => <tr key={c.connector_id}><td>{c.name}</td><td>v{c.version}</td><td className="mono">{c.url ?? "—"}</td><td>{c.max_data_level}</td><td>{c.tools}</td><td>{c.signers.join("、")}</td></tr>)}</tbody>
        </table>
      )}
      {drafts && (
        <>
          <div className="section-title">待确认的规则草稿</div>
          {drafts.length === 0 ? (
            <p className="muted">没有待确认的规则草稿。可以在下方起草新版本。</p>
          ) : (
            drafts.map((d) => (
              <div key={d.draft_id} className="panel">
                <div className="device-row">
                  <div className="device-k">{d.kind === "policy" ? `律所策略第 ${d.doc.version} 版` : `律所系统接入第 ${d.doc.version} 版`}</div>
                  <div>
                    {d.created_at && <div className="muted" title={d.draft_id}>起草于 {fmtTime(d.created_at)}</div>}
                    <DraftContent d={d} />
                    <div className="muted">
                      比最严规则放宽的地方：{!d.valid ? `这份草稿有问题（${d.problem}），不能确认` : d.relaxations.length > 0 ? d.relaxations.map(relaxationText).join("；") : "无（不比最严规则宽）"}
                    </div>
                    <div className="muted">已确认：{d.signed_by.map((x) => x.member_id).join("、") || "—"}</div>
                    <div className="banner-actions">
                    {d.valid && !d.signed_by_me && d.digest && (
                      <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api.policySign(d.draft_id, d.digest!), "已确认（确认的是上面显示的完整内容）")}>
                        核对无误，确认
                      </button>
                    )}
                    <ConfirmButton label="发布" danger={false} className="btn-primary btn-sm" disabled={busy} question="发布后全所设备同步生效。确定发布？" confirmLabel="确定发布" onConfirm={() => act(() => api.policyPublish(d.draft_id), "已发布并同步（本机按同一规则核验后生效）")} />
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
          <PolicyDraftForm busy={busy} onSubmit={(body, ttl) => act(() => api.policyCreateDraft(body, ttl), "草稿已生成：核对放宽项后确认并发布")} />
        </>
      )}
    </div>
  );
}

// 与律师在输入框里看到的档位同名（第 26 批，评审 U2-17）
const MODE_TEXT: Record<string, string> = { chat: "只问答", manual: "每步问我", default: "标准", auto: "放手做" };

/** 草稿的完整内容（所见即所签：管理员签名覆盖整份文档，签名前逐项展示）。 */
function DraftContent({ d }: { d: PolicyDraft }) {
  const doc = d.doc as Record<string, any>;
  if (d.kind === "policy") {
    const b = (doc.body ?? {}) as Record<string, any>;
    return (
      <div>
        有效期：{fmtTime(String(doc.issued_at ?? ""))} 至 {fmtTime(String(doc.expires_at ?? ""))}
        <div className="muted">
          最高档位：{MODE_TEXT[String(b.max_mode)] ?? String(b.max_mode)} · “放手做”可以事先同意：{Array.isArray(b.auto_preauthorizations) && b.auto_preauthorizations.length > 0 ? b.auto_preauthorizations.join("、") : "无"} ·
          官方网站之外还可打开的网站：{Array.isArray(b.fetch_allowlist_extra) && b.fetch_allowlist_extra.length > 0 ? b.fetch_allowlist_extra.join("、") : "无"} · 敏感事项用通用 AI 服务：{b.l3a_standard_model === "allow" ? "放开" : "不放开"} · 上传诊断包给中软支持：{b.support_upload === "allow" ? "允许" : "不允许"} · 经中软共享服务的团队共享：{b.share_relay === "allow" ? "允许" : "不允许"}
        </div>
      </div>
    );
  }
  const tools = (Array.isArray(doc.tools) ? doc.tools : []) as { name?: string; side_effect?: string; schema_hash?: string }[];
  return (
    <div>
      「{String(doc.name ?? "")}」（编号 {String(doc.connector_id ?? "")}，服务名 {String(doc.server ?? "")}）
      <div className="muted mono">服务地址：{String(doc.url ?? "")}</div>
      <div className="muted">可接收至：{String(doc.max_data_level ?? "")}</div>
      <ul className="plain-list muted">
        {tools.map((t) => (
          <li key={String(t.name)} className="mono">
            {String(t.name)} · {String(t.side_effect)} · schema {String(t.schema_hash ?? "").slice(0, 16)}…
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 管理员起草律所策略（G0 没有 Web 控制台，D-32）：草稿发到控制面，本机重算放宽项、签名、发布。 */
function PolicyDraftForm({ busy, onSubmit }: { busy: boolean; onSubmit: (body: Record<string, unknown>, ttlDays: number) => void }) {
  const [maxMode, setMaxMode] = useState("default");
  const [preSearch, setPreSearch] = useState(false);
  const [extra, setExtra] = useState("");
  const [l3a, setL3a] = useState(false);
  const [support, setSupport] = useState(false);
  const [relay, setRelay] = useState(false);
  const [ttl, setTtl] = useState(30);
  const domains = extra
    .split(/[\s,，、]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length > 0);
  return (
    <div className="panel">
      <div className="device-row">
        <div className="device-k">起草律所策略</div>
        {/* 第 55 批：一行一项（左标签、右控件）。原来标签、下拉、勾选、输入框挤在一段文字流里，互相错位；文字与逻辑没有改 */}
        <div className="pd-form">
          <div className="settings-grid pd-grid">
            <span className="sg-k">最高档位</span>
            <span className="sg-v sg-select">
              <Select aria-label="最高档位" value={maxMode} onChange={setMaxMode} options={(["chat", "manual", "default", "auto"] as const).map((m) => ({ value: m, label: MODE_TEXT[m] ?? m }))} />
              <label className={`pd-check${maxMode !== "auto" ? " sg-off" : ""}`}>
                <input type="checkbox" checked={preSearch && maxMode === "auto"} disabled={maxMode !== "auto"} onChange={(e) => setPreSearch(e.target.checked)} /> “放手做”可以事先同意“去掉当事人名称后的检索”
              </label>
            </span>
            <span className="sg-k sg-top">可打开的网站</span>
            <span className="sg-v">
              <textarea aria-label="官方网站之外，AI 还可以打开的网站" value={extra} onChange={(e) => setExtra(e.target.value)} rows={2} placeholder="www.example.com" />
              <span className="sg-help">官方网站之外，AI 还可以打开的网站（每行一个网址，例如 www.example.com）</span>
            </span>
            <span className="sg-k">放宽项</span>
            <span className="sg-v">
              <label className="pd-check">
                <input type="checkbox" checked={l3a} onChange={(e) => setL3a(e.target.checked)} /> 敏感事项可以用通用 AI 服务（强制全部化名）
              </label>
              <label className="pd-check">
                <input type="checkbox" checked={support} onChange={(e) => setSupport(e.target.checked)} /> 律师可以把问题报告直接发给客服
              </label>
              <label className="pd-check">
                <input type="checkbox" checked={relay} onChange={(e) => setRelay(e.target.checked)} /> 同事之间可以经中软同步团队事项（加密，中软打不开）
              </label>
              {relay && (
                <span className="sg-help">
                  开启后，团队事项会加密后经中软在同事电脑之间同步（中软打不开）；本机删除事项不会删除中软上的副本，关闭后已存的副本保留到律所停止使用。
                </span>
              )}
            </span>
            <span className="sg-k">有效期</span>
            <span className="sg-v">
              <span className="pd-ttl">
                <input type="number" aria-label="有效期（天，≤ 30）" min={1} max={30} value={ttl} onChange={(e) => setTtl(Math.max(1, Math.min(30, Number(e.target.value) || 30)))} /> 天（≤ 30）
              </span>
            </span>
          </div>
          {(support || relay) && <div className="banner banner-gray">勾选后，没更新软件的电脑会暂时按最严规则运行，直到更新。建议先让全所电脑更新到最新版。</div>}
          <div className="muted pd-note">放宽的规则须管理员各自在电脑上确认后才生效（团队版 1 人，律所版 2 人）。</div>
          <button
            className="btn-primary btn-sm"
            disabled={busy}
            onClick={() =>
              onSubmit(
                { max_mode: maxMode, auto_preauthorizations: maxMode === "auto" && preSearch ? ["search_generalized"] : [], fetch_allowlist_extra: [...new Set(domains)], l3a_standard_model: l3a ? "allow" : "deny", ...(support ? { support_upload: "allow" } : {}), ...(relay ? { share_relay: "allow" } : {}) },
                ttl,
              )
            }
          >
            生成草稿
          </button>
        </div>
      </div>
    </div>
  );
}

/** 环境自检 → 律师看得懂的几行（“未知”如实写）。 */
function envLines(e: Record<string, any>): { k: string; v: string; warn: boolean }[] {
  const tri = (v: string, yes: string, no: string) => (v === "yes" ? yes : v === "no" ? no : "未知（没能读到）");
  const bl: Record<string, string> = { on: "已开启", off: "未开启：电脑丢失时硬盘上的数据可能被读取，建议请 IT 开启", suspended: "已暂停：请 IT 恢复", pending: "等待激活：请 IT 完成开启", in_progress: "正在加密或解密", unknown: "未知（没能读到）" };
  return [
    { k: "磁盘加密（BitLocker）", v: bl[e.bitlocker] ?? "未知（没能读到）", warn: e.bitlocker === "off" || e.bitlocker === "suspended" || e.bitlocker === "pending" },
    { k: "漫游配置文件", v: tri(e.roaming_profile, "是：数据目录在本机，但请 IT 确认不要把应用数据加入漫游", "否"), warn: e.roaming_profile === "yes" },
    { k: "文件夹重定向到网络位置", v: tri(e.folder_redirection, "是：保存成果时请选本机位置", "否"), warn: e.folder_redirection === "yes" },
    { k: "OneDrive 同步“文档/桌面”", v: tri(e.onedrive_kfm, "是：保存到这些位置的文件会同步到云端", "否"), warn: e.onedrive_kfm === "yes" },
    { k: "FSLogix 配置文件容器", v: tri(e.fslogix, "是：配置文件在网络容器中，请 IT 确认存放位置", "否"), warn: e.fslogix === "yes" },
    { k: "系统完整内存转储（LocalDumps）", v: tri(e.local_dumps, "已配置：程序崩溃时可能留下含案件文字的转储，请 IT 排除本应用", "未配置"), warn: e.local_dumps === "yes" },
    { k: "律所防火墙规则", v: tri(e.firewall_rules, "已配置", "未配置（律所版可由 IT 配置，见部署指南）"), warn: false },
    { k: "杀毒软件", v: Array.isArray(e.antivirus) && e.antivirus.length ? e.antivirus.join("、") : "未知", warn: false },
  ];
}

