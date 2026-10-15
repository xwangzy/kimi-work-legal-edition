/**
 * 设置（UIUX 增量评审 ST-1～ST-5、§3.5；v9 第 03 篇 §4.1、§8.5；第 02 篇 §12；第 04 篇 §5.1）。
 * 律师版四页：通用（字号、通知）/ 数据去向说明（三栏 + 现场生成的示例请求，可打印给客户）/ 资料来源 / 本机与安全；
 * 管理员另有“管理”：律所策略、诊断（技术版数据去向表、能力账本、待对账出站、闸门与执行域细节、详细运行记录）、召回评测（律所内）。
 * “管理”是否显示只是界面安排，授权一律由内核按角色逐个方法核验。
 */
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { useEffect, useState } from "react";
import { api, updates, type Capabilities, type ControlPlaneStatus, type PolicyDraft } from "../api.ts";
import { nav, type SettingsTab } from "../App.tsx";
import { fmtTime } from "../lib/labels.ts";
import { applyUiZoom, readUiZoom, UI_ZOOM_OPTIONS } from "../lib/ui-prefs.ts";
import { RecallEvalPanel } from "./RecallEval.tsx";

const ADMIN_ROLES = new Set(["firm_admin", "partner"]);

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
  const isAdmin = ADMIN_ROLES.has(String(status?.member_role ?? ""));
  const tabs: [SettingsTab, string][] = [
    ["general", "通用"],
    ["visibility", "数据去向说明"],
    ["sources", "资料来源"],
    ["device", "本机与安全"],
    ...(isAdmin ? ([["admin", "管理"]] as [SettingsTab, string][]) : []),
  ];
  return (
    <main className="main">
      <div className="main-wide">
        <h1 className="page-title">设置</h1>
        <div className="tabs tabs-line" role="tablist" aria-label="设置">
          {tabs.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? " active" : ""}`} onClick={() => nav(`/connections/${k}`)}>
              {label}
            </button>
          ))}
        </div>
        {err && <div className="banner banner-red">{err}</div>}
        {tab === "general" && <GeneralTab version={status?.version ?? null} />}
        {tab === "visibility" && <VisibilityTab gate={gate} im={im} recovery={recovery} firm={status?.firm ?? null} syncOn={!!status?.sync_configured} />}
        {tab === "sources" && <SourcesTab gate={gate} lawdb={lawdb} im={im} />}
        {tab === "device" && <DeviceTab caps={caps} gate={gate} mySafety={mySafety} recovery={recovery} />}
        {tab === "admin" &&
          (status === null ? null : isAdmin ? (
            <AdminTab caps={caps} gate={gate} devices={devices} unresolved={unresolved} onReconciled={load} im={im} recovery={recovery} />
          ) : (
            <div className="banner banner-gray">“管理”只对律所管理员与合伙人开放。</div>
          ))}
      </div>
    </main>
  );
}

function GeneralTab({ version }: { version: string | null }) {
  const [zoom, setZoom] = useState(readUiZoom());
  return (
    <div className="device">
      <div className="panel">
        <div className="device-row">
          <div className="device-k">字号</div>
          <div className="settings-choice" role="radiogroup" aria-label="字号">
            {UI_ZOOM_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={zoom === o.value}
                className={`q-option${zoom === o.value ? " on" : ""}`}
                onClick={() => {
                  applyUiZoom(o.value, true);
                  setZoom(o.value);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="device-row">
          <div className="device-k">提醒</div>
          <div>
            任务需要你确认或回答问题、而 Kimi Work 不在前台时，会发一条系统通知并闪烁任务栏。通知只写“有一个任务在等你确认”，不写事项内容。
            <div className="muted">如不想收到，可在 Windows“设置 → 系统 → 通知”里关闭 Kimi Work 的通知。</div>
          </div>
        </div>
        <div className="device-row">
          <div className="device-k">版本</div>
          <div>{version ?? "—"}</div>
        </div>
      </div>
    </div>
  );
}

/** “数据去向说明”（UIUX 增量评审 §3.5）：一眼回答“东西在哪”，按本所实际启用的功能生成，可打印成 PDF 给客户。 */
function VisibilityTab({ gate, im, recovery, firm, syncOn }: { gate: any; im: any[]; recovery: any; firm: string | null; syncOn: boolean }) {
  const [example, setExample] = useState<{ sent: string; replaced: number } | null>(null);
  const [updatesOn, setUpdatesOn] = useState(false);
  useEffect(() => {
    api.exampleRequest().then(setExample).catch(() => setExample(null));
    updates.status().then((u) => setUpdatesOn(!!u?.enabled)).catch(() => setUpdatesOn(false));
  }, []);
  // 复核 S6A-02/03：逐项写清替换了什么、哪些按原文；不经中软但会出本机的去向（网页、IM、团队共享）单列
  const local = ["案卷原件与全部交付件", "代号与真实姓名的对照表", "对话、问答与任务记录", "事项名称与事项头信息"];
  const transit = [
    "发给 AI 的任务内容：证件号、账号、电话、住址与识别出的姓名先换成代号；机构名称（含客户名称）、案情、金额、日期按原文",
    ...(gate?.search_configured ? ["联网检索的查询（默认去掉当事人名称）"] : []),
    ...(gate ? ["无事项问答的问题（同样先替换）"] : []),
  ];
  const direct = [
    ...(gate?.fetch === "local" ? ["打开公开网页：网址由这台电脑直接发往该网站（不经中软）"] : []),
    ...(im.length > 0 ? ["IM 收件：发给机器人的文字与文件经所用的 IM 平台传递"] : []),
    ...(syncOn ? ["团队共享：经律所指定的共享文件夹同步（加密）"] : []),
  ];
  const stored = ["账号、席位与用量", "匿名事项编号与调用记录（不含内容）", "律所策略与设备证书", ...(updatesOn ? ["更新检查的访问记录（IP 与版本）"] : [])];
  const notEnabled = [
    ...(gate?.search_configured ? [] : ["联网检索"]),
    "法源与主体信息查询",
    ...(im.length > 0 ? [] : ["IM 收件"]),
    ...(syncOn ? [] : ["团队共享"]),
    "设备中继（端到端加密）",
    "期限提醒",
    "云端事项",
    ...(recovery?.escrow ? [] : ["中软托管恢复"]),
  ];
  return (
    <div className="visibility v2">
      <div className="vis-head">
        <div>
          <b>数据去向说明</b>
          <span className="muted">
            {" "}
            · {firm ? `${firm} · ` : ""}本所当前设置 · {new Date().toLocaleDateString("zh-CN")}
          </span>
        </div>
        <button className="btn btn-sm no-print" onClick={() => window.print()}>
          打印或另存为 PDF
        </button>
      </div>
      <div className="vis-cols">
        <section className="vis-col vis-local" aria-label="只在你的电脑上">
          <h3>只在你的电脑上</h3>
          <ul>{local.map((x) => <li key={x}>{x}</li>)}</ul>
        </section>
        <section className="vis-col vis-transit" aria-label="经过中软，不保存">
          <h3>经过中软，不保存</h3>
          <ul>{transit.map((x) => <li key={x}>{x}</li>)}</ul>
        </section>
        <section className="vis-col vis-stored" aria-label="中软会保存">
          <h3>中软会保存</h3>
          <ul>{stored.map((x) => <li key={x}>{x}</li>)}</ul>
        </section>
      </div>
      {direct.length > 0 && (
        <div className="panel vis-direct">
          <b>不经中软、但会离开这台电脑的</b>
          <ul className="plain-list">{direct.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
      <div className="panel vis-example">
        <div className="muted">一次 AI 请求长什么样（示例句子与人物均为虚构，由本机现场替换生成）：</div>
        <div className="vis-sent">{example ? example.sent : "—"}</div>
        <div className="muted">姓名、证件号、电话等换成了代号；机构名称、案情、金额和日期按原文发送（可按事项开启“全部化名”）。</div>
      </div>
      <ul className="plain-list">
        <li>
          与月之暗面“不用于训练、不保留”的书面确认：<b>待签署</b>（签署后此处显示日期）。在此之前，模型服务商一侧的保留以其企业协议为准。
        </li>
        {gate?.search_configured && <li>联网检索默认去掉当事人名称再发出；含当事人名称的查询须经办律师逐条确认，确认后可按原文发出（保留机构当事人名称；已识别的自然人姓名与证件、账号不发出）。</li>}
        <li>识别依靠规则与当事人名单，可能遗漏：<b>没有识别出的姓名会按原文发出</b>；每个任务的“数据去向”里可以逐条查看实际发出的内容。</li>
        <li>自带密钥或律所私有端点的事项，模型请求不经中软。</li>
      </ul>
      {/* 本机密钥保护的如实说明（调研 Y5 §7.3 建议原文的律师版） */}
      <details className="vis-more">
        <summary>本机密钥保护（当前版本）</summary>
        <ol className="plain-list muted">
          <li>案件数据在本机加密保存，解密密钥受 Windows 数据保护（DPAPI）保护、与你的 Windows 账户绑定；以同一账户运行的其他程序（包括恶意软件）技术上可以调用同一保护机制，使用域账户的律所，域管理员按 Windows 的设计也具备恢复能力。</li>
          <li>设备签名与解密密钥目前由软件保存，尚未存放在电脑的安全芯片（TPM）中。</li>
          <li>律所恢复所需的根密钥目前保存在各成员的电脑上；律所版将改为线下分片保管。</li>
          <li>删除事项会销毁本机密钥并删除数据；Windows 还原点、文件历史和备份软件中的旧副本不在删除范围内。</li>
          <li>建议开启 BitLocker，并使用本机（非漫游、非重定向）的用户目录。</li>
        </ol>
      </details>
      <details className="vis-more">
        <summary>未启用的功能（{notEnabled.length}）</summary>
        <ul className="plain-list muted">{notEnabled.map((x) => <li key={x}>{x}：未启用</li>)}</ul>
      </details>
    </div>
  );
}

/** 资料来源（ST-2）：来源 · 状态 · 一句话；数据级别用“一般 / 敏感 / 客户要求不上云”。 */
function SourcesTab({ gate, lawdb, im }: { gate: any; lawdb: any; im: any[] }) {
  const rows: { name: string; state: "可用" | "未开通" | "即将推出" | "不可用"; note: string; detail?: string }[] = [
    { name: "离线法规库", state: lawdb?.error ? "不可用" : "可用", note: lawdb?.error ? "法规库文件没有通过签名核对，已停用" : "法条核验在本机完成，不联网", detail: lawdb?.error ? undefined : lawdb?.display },
    { name: "Kimi 模型（经中软）", state: gate?.routes ? "可用" : "未开通", note: "一般事项可用；敏感事项须管理员放开并全部化名；客户要求不上云的事项不用" },
    { name: "联网检索", state: gate?.search_configured ? "可用" : "未开通", note: "默认去掉当事人名称再发出；含当事人名称的查询须经办律师逐条确认，确认后可按原文发出（保留机构当事人名称；已识别的自然人姓名与证件、账号不发出）" },
    { name: "公开网页", state: gate?.fetch === "local" ? "可用" : "未开通", note: `只打开公开官方站点与律所允许的网站（${gate?.fetch_allowlist_size ?? 0} 个），新网站要你确认` },
    { name: "案例与工商查询", state: "即将推出", note: "经数据商合同接入" },
    { name: "律所自有系统（连接器）", state: "即将推出", note: "由管理员登记，按事项敏感程度放行" },
    { name: "IM 收件", state: im.length > 0 ? "可用" : "即将推出", note: im.length > 0 ? "所内节点原型" : "文件进入本人收件区" },
  ];
  const tone = (s: string) => (s === "可用" ? "pill-green" : s === "不可用" ? "pill-red" : "pill-gray");
  return (
    <table className="data">
      <thead>
        <tr>
          <th>资料来源</th>
          <th>状态</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td>
              <b>{r.name}</b>
            </td>
            <td>
              <span className={`pill ${tone(r.state)}`}>{r.state}</span>
            </td>
            <td>
              {r.note}
              {r.detail && (
                <details className="muted">
                  <summary>版本与签名</summary>
                  {r.detail}
                </details>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 本机与安全（ST-1 律师版）：四行结论 + 电脑环境 + 遇到问题；工程细节在“管理 → 诊断”。 */
function DeviceTab({ caps, gate, mySafety, recovery }: { caps: Capabilities | null; gate: any; mySafety: string | null; recovery: any }) {
  const [busy, setBusy] = useState(false);
  const [diag, setDiag] = useState<{ open: boolean; msg: string }>({ open: false, msg: "" });
  const [env, setEnv] = useState<Record<string, any> | null>(null);
  const [cp, setCp] = useState<ControlPlaneStatus | null>(null);
  useEffect(() => {
    api.envProbe().then(setEnv).catch(() => setEnv(null));
    api.controlPlaneStatus().then(setCp).catch(() => setCp(null));
  }, []);
  const domainOk = !!caps && !/不可用|未启用|失败/.test(String(caps.execution_domain.status ?? ""));
  const envWarn = env && env.platform === "win32" ? envLines(env).filter((l) => l.warn).length : 0;
  return (
    <div className="device">
      <div className="panel">
        <div className="device-row">
          <div className="device-k">本机防护</div>
          <div>
            {domainOk ? "✓ " : ""}案卷加密保存在这台电脑上；AI 运行代码时不能联网、只看得到本事项的文件。
            {!domainOk && <div className="muted">代码运行环境暂不可用：需要运行代码的任务会停下并说明原因。</div>}
          </div>
        </div>
        <div className="device-row">
          <div className="device-k">联网通道</div>
          <div>
            {gate ? "✓ " : ""}模型、检索与网页只经 Kimi Work 自己的联网通道发出，每一次都记在“数据去向”里。
            <div className="muted">律所 IT 可另加系统防火墙规则，让“只有这条通道能联网”由 Windows 强制。</div>
          </div>
        </div>
        <div className="device-row">
          <div className="device-k">本机安全码</div>
          <div>
            <b className="mono">{mySafety ?? "—"}</b>
            <div className="muted">同事核对你的设备变更时，请在电话或当面读出这串数字；对方屏幕上的一致才确认。</div>
          </div>
        </div>
        {/* 律所设置与许可（复核 S6B-08：拆分后普通律师也要看得到许可是否有效、是否处于退出状态） */}
        {cp && cp.mode === "control_plane" && (
          <div className="device-row">
            <div className="device-k">律所设置</div>
            <div>
              {cp.exit_mode ? (
                <span className="pill pill-red">{cp.exit_mode.message}</span>
              ) : (
                <>
                  {cp.license?.state === "valid" ? `许可有效${cp.license.expires_at ? `，至 ${fmtTime(cp.license.expires_at)}` : ""}` : cp.license?.state === "expired" ? "许可已到期" : "尚未取得许可"}
                  {" · "}
                  {cp.policy?.source === "control_plane" ? `本所策略第 ${cp.policy.version} 版` : "按最严设置运行（尚未取得或已不能使用本所策略）"}
                </>
              )}
            </div>
          </div>
        )}
        <div className="device-row">
          <div className="device-k">最近一次自检</div>
          <div>
            {env?.checked_at ? fmtTime(env.checked_at) : "—"}
            {envWarn > 0 && <span className="pill pill-orange"> {envWarn} 项需要 IT 处理（见下）</span>}
          </div>
        </div>
      </div>
      {/* Windows 环境自检（v9.2 §3.7；Y5 P1-6）：只提示会让“本机加密保存”打折扣的系统设置，读不到的写“未知” */}
      {env && env.platform === "win32" && (
        <div className="panel">
          <div className="device-row">
            <div className="device-k">电脑环境</div>
            <div>
              <ul className="plain-list">
                {envLines(env).map((l) => (
                  <li key={l.k} className={l.warn ? "env-warn" : undefined}>
                    {l.k}：{l.v}
                  </li>
                ))}
              </ul>
              <button className="btn btn-sm" onClick={() => void api.envProbe(true).then(setEnv).catch(() => {})}>
                重新检查
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 脱敏诊断包（v9.2 §3.6）：律师主动导出交给支持团队；内容白名单 + 导出前自证 + 设备签名 */}
      <div className="panel diag-panel">
        <div className="device-row">
          <div className="device-k">遇到问题</div>
          <div>
            导出一份诊断信息交给所内 IT 或客服：只包含软件版本、运行环境、后台服务状态、最近任务的状态与错误代码、联网次数统计、近 7 天的运行记录（只有事件代码与次数），
            <b>不包含任何事项名称、当事人、材料、成果与任务内容</b>；导出前软件会自动核对，发现可能含有当事人信息即不导出。
            {!diag.open ? (
              <div className="banner-actions">
                <button className="btn btn-sm" onClick={() => setDiag({ open: true, msg: "" })}>
                  导出诊断信息
                </button>
              </div>
            ) : (
              <div className="banner-actions">
                <button
                  className="btn-primary btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await api.exportDiagnostics();
                      if (!r) {
                        setDiag({ open: false, msg: "" });
                        return;
                      }
                      setDiag({ open: false, msg: `已保存 ${r.filename}（${Math.ceil(r.bytes / 1024)} KB）。文件带本机签名，请按所内要求发给 IT 或客服。` });
                    } catch (e) {
                      setDiag({ open: false, msg: (e as Error).message });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  确认导出
                </button>{" "}
                <button className="btn btn-sm" onClick={() => setDiag({ open: false, msg: "" })}>
                  取消
                </button>
              </div>
            )}
            {diag.msg && <div className="muted">{diag.msg}</div>}
          </div>
        </div>
      </div>
      {recovery && <p className="muted">设备恢复：{recovery.note ?? (recovery.configured ? "已配置" : "未配置")}</p>}
    </div>
  );
}

/** 管理（ST-1、ST-4）：律所策略、诊断（工程细节）、召回评测（律所内）。 */
function AdminTab(props: { caps: Capabilities | null; gate: any; devices: any[]; unresolved: any[]; onReconciled: () => void; im: any[]; recovery: any }) {
  const [sub, setSub] = useState<"policy" | "diagnostics" | "recall">("policy");
  return (
    <div>
      <div className="tabs" role="tablist" aria-label="管理">
        {(
          [
            ["policy", "律所策略"],
            ["diagnostics", "诊断"],
            ["recall", "召回评测（律所内）"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={sub === k} className={`tab${sub === k ? " active" : ""}`} onClick={() => setSub(k)}>
            {label}
          </button>
        ))}
      </div>
      {sub === "policy" && <PolicyTab />}
      {sub === "diagnostics" && <DiagnosticsTab {...props} />}
      {sub === "recall" && <RecallEvalPanel />}
    </div>
  );
}

function DiagnosticsTab({ caps, gate, devices, unresolved, onReconciled, im, recovery }: { caps: Capabilities | null; gate: any; devices: any[]; unresolved: any[]; onReconciled: () => void; im: any[]; recovery: any }) {
  const [busy, setBusy] = useState(false);
  const [logLevel, setLogLevel] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api.kernelStatus().then((st: any) => setLogLevel(typeof st?.log_level === "string" ? st.log_level : null)).catch(() => setLogLevel(null));
  }, []);
  return (
    <div className="device">
      <div className="panel">
        <div className="device-row">
          <div className="device-k">代码运行</div>
          <div>
            <b>{caps?.execution_domain.label ?? "运行时隔离（W）"}</b>：{caps?.execution_domain.detail ?? "无网络、只见本事项；非操作系统沙箱"}
            <div className="muted">状态：{caps?.execution_domain.status ?? "未知（内核未返回能力账本）"}</div>
          </div>
        </div>
        <div className="device-row">
          <div className="device-k">系统强制（MXC）</div>
          <div>本版本未提供（P3：Windows 11 进程容器，按设备条件提供）——数据分析增强不可用。</div>
        </div>
        <div className="device-row">
          <div className="device-k">唯一出口</div>
          <div>
            <b>{gate?.sole_exit ?? caps?.sole_exit ?? "应用层约束"}</b>：模型、检索、抓取只经出站闸门（独立进程）；执行域无网；渲染进程拦截一切外部请求。
          </div>
        </div>
        <div className="device-row">
          <div className="device-k">出站闸门</div>
          <div>
            {gate ? <>{gate.running ? "运行中" : "已配置（按需拉起：下一次出站时启动）"} · 检索{gate.routes?.search ? "已接入" : "未接入"} · 抓取{gate.routes?.fetch ? "已接入" : "未接入"} · 已拉起 {gate.stats?.starts ?? 0} 次</> : "未启用（离线模拟提供方）"}
          </div>
        </div>
        {logLevel && (
          <div className="device-row">
            <div className="device-k">详细运行记录</div>
            <div>
              {logLevel === "debug" ? "已开启（24 小时后自动关闭）。" : "排查偶发问题时，可临时记录更详细的运行事件（同样不含任何事项内容）。"}{" "}
              <button
                className="btn btn-sm"
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
              {msg && <div className="muted">{msg}</div>}
            </div>
          </div>
        )}
      </div>
      {caps && caps.rows.length > 0 && (
        <>
          <div className="section-title">能力账本（本设备）</div>
          <table className="data">
            <thead><tr><th>能力</th><th>状态</th><th>说明</th></tr></thead>
            <tbody>{caps.rows.map((r) => <tr key={r.capability}><td>{r.capability}</td><td>{r.status}</td><td className="muted">{r.note}</td></tr>)}</tbody>
          </table>
        </>
      )}
      {unresolved.length > 0 && (
        <>
          <div className="section-title">结果不明的出站（待对账）</div>
          <p className="muted">预写后闸门或内核中断，无法确定是否已发出。核实后登记结论（不重发、不改写原记录）。</p>
          <table className="data">
            <thead><tr><th>时间</th><th>用途</th><th>去向</th><th>结论</th></tr></thead>
            <tbody>
              {unresolved.map((r) => (
                <tr key={r.record_id}>
                  <td>{fmtTime(r.created_at)}</td>
                  <td>{r.purpose}</td>
                  <td>{r.destination_host}</td>
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
      <div className="section-title">设备</div>
      <table className="data">
        <thead><tr><th>设备</th><th>角色</th><th>状态</th><th>登记</th></tr></thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.device_id}><td className="mono" title={String(d.device_id)}>{shortId(String(d.device_id))}</td><td>{d.role}</td><td>{d.status === "revoked" ? "已吊销" : "有效"}</td><td>{fmtTime(d.created_at)}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="section-title">数据去向（技术版）</div>
      <TechnicalVisibility gate={gate} im={im} recovery={recovery} />
    </div>
  );
}

/** 原“中软看得到什么”逐情形明细（技术版，供管理员与客户 IT 核对；律师版见“数据去向说明”）。 */
function TechnicalVisibility({ gate, im, recovery }: { gate: any; im: any[]; recovery: any }) {
  const [updatesOn, setUpdatesOn] = useState(false);
  useEffect(() => {
    updates.status().then((u) => setUpdatesOn(!!u?.enabled)).catch(() => setUpdatesOn(false));
  }, []);
  const rows: { situation: string; enabled: boolean; sees: string; notSees: string }[] = [
    {
      situation: "自动更新",
      enabled: updatesOn,
      sees: "每 6 小时一次的更新检查与安装包下载：本机 IP、操作系统与应用版本（请求的 User-Agent）、更新渠道（保存在更新服务器的访问日志里）",
      notSees: "账号、设备编号、任何持久的本机标识（更新编号固定为全零）、事项与案卷的任何内容",
    },
    {
      situation: "默认（本地事项 + 法律模型网关）",
      enabled: true,
      sees: "账号、设备与执行域等级、席位、用量；匿名事项编号与推理调用元数据（保存）；匿名事项编号对应的数据级别、模型端点、依据是否齐备、事项策略版本计数与更新时间（保存，供网关二次检查）；律所策略与连接器登记（含抓取白名单追加的域名、连接器服务地址与工具清单）、设备证书（成员编号、角色、公钥）与管理员签名记录、设备与席位的吊销记录（含预先吊销的设备编号）（保存）；推理时任务涉及的文档内容（证件、账户、联系方式与自然人姓名替换为代号后过境，不落盘）；网关内容安全检查命中的类别编号与次数（随该次调用的元数据保存，含匿名事项编号与席位；不含命中的文字）",
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
      situation: "启用 IM",
      enabled: false,
      sees: "律师发给机器人的文字指令与文件名（过境）；电脑离线时后端在内存取得文件后立即加密暂存",
      notSees: "落盘的文件明文",
    },
    {
      situation: "使用无事项问答",
      enabled: !!gate,
      sees: "问题文本（经出站闸门令牌化与当事人词典检查后过境，不保存）与发起席位",
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
        <thead><tr><th>本所已启用的情形</th><th>中软看得到（过境或保存）</th><th>中软看不到</th></tr></thead>
        <tbody>{on.map((r) => <tr key={r.situation}><td><b>{r.situation}</b></td><td>{r.sees}</td><td>{r.notSees}</td></tr>)}</tbody>
      </table>
      {im.length > 0 && <p className="muted">当前的 IM 绑定为所内节点原型，不经中软。</p>}
    </>
  );
}

const AREA: Record<string, string> = {
  policy: "律所策略",
  directory: "设备目录",
  connectors: "连接器",
  license: "许可",
  salt: "租户盐",
  seat: "席位",
  drafts: "草稿",
  revocation: "吊销",
  clock: "时钟",
};

/** 设备编号过长时截断并加省略号（悬停显示全称）。 */
function shortId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 23)}…` : id;
}

const CP_ERROR_TEXT: Record<string, string> = {
  revoker_required: "本设备证书的角色不是管理员或合伙人",
  device_id_invalid: "设备编号不合法",
  cp_path_not_allowed: "设备编号不合法",
  cp_unreachable: "控制面不可达",
  cp_not_configured: "控制面地址未配置",
  device_auth_stale: "本机时钟与控制面相差超过 5 分钟",
  cert_required: "该设备尚未在控制面登记、本机也没有可核实的证书：它登记之后，本机下一次同步即补发吊销（缺省 10 分钟内；本机不在线时更久）",
  cert_invalid: "该设备尚未在控制面登记、证书无法核实：它登记之后，本机下一次同步即补发吊销（缺省 10 分钟内；本机不在线时更久）",
  pre_revocation_limit: "预先吊销已达上限：该设备登记之后，本机下一次同步即补发吊销（缺省 10 分钟内；本机不在线时更久）",
};

/** 待同步动作的状态（复核 S6-A22、S6-B31）：区分“会自动重试”与“需人工处理”。 */
function pendingActionText(a: { state?: string; last_error: string | null }): string {
  const why = a.last_error ? CP_ERROR_TEXT[a.last_error] ?? a.last_error : null;
  if (a.state === "failed") return `控制面拒绝（${why ?? "原因不明"}）：不会自动重试，需人工处理——请由管理员或合伙人设备再次吊销该设备（控制面目录列为吊销后此项自动消除），或处理后点“立即同步”重发`;
  if (a.state === "submitted") return "控制面已接受，待控制面签名的设备目录确认（每次同步自动核对）";
  return `待发送，联网后自动重试${why ? `（上次失败：${why}）` : ""}`;
}

/** 放宽项 → 人话（签名前给管理员看清楚放宽了什么）。 */
function relaxationText(r: string): string {
  const [k, ...rest] = r.split(":");
  const v = rest.join(":");
  if (k === "max_mode") return `运行模式上限放宽到“${v === "auto" ? "自动" : v}”`;
  if (k === "auto_preauthorization") return v === "search_generalized" ? "自动档可预授权：泛化后放行的检索" : `自动档可预授权：${v}`;
  if (k === "fetch_allowlist") return `抓取白名单追加：${v}`;
  if (k === "l3a_standard_model") return "敏感事项（L3a）可经标准端点推理（全部化名）";
  if (k === "connector") return `登记连接器：${v}`;
  return r;
}

function policyLine(st: ControlPlaneStatus): string {
  const p = st.policy;
  if (!p) return "未知";
  if (p.source === "local_dev") return "开发形态：律所策略取本机配置项（未接入控制面）";
  if (p.source === "strictest_fallback") {
    if (p.fallback_reason === "expired") return `律所策略 v${p.version} 已于 ${fmtTime(p.expires_at ?? "")} 过期：已回退“产品基线 + 最严模板”（不比该策略宽）`;
    if (p.fallback_reason === "signers_insufficient") return `律所策略 v${p.version} 的有效管理员签名已不足门限（签名设备被吊销或门限提高）：已回退最严模板（不比该策略宽）`;
    if (p.fallback_reason === "unrecognized_newer") return "收到本机不认识的律所策略新版本（客户端需要升级）：已回退最严模板";
    return "尚未取得律所策略：按“产品基线 + 最严模板”运行";
  }
  const who = p.signers.length > 0 ? `管理员 ${p.signers.join("、")} 设备签名` : "最严模板，控制面签发";
  return `律所策略 v${p.version}（${who}）· 有效至 ${fmtTime(p.expires_at ?? "")}`;
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
            {pol && (
              <div className="muted">
                运行模式上限：{pol.body.max_mode === "auto" ? "自动" : pol.body.max_mode === "default" ? "默认" : pol.body.max_mode === "manual" ? "手动" : "问答"} ·
                抓取白名单追加：{pol.body.fetch_allowlist_extra.length > 0 ? pol.body.fetch_allowlist_extra.join("、") : "无（只用公开官方站点基线）"} ·
                敏感事项（L3a）经标准端点：{pol.body.l3a_standard_model === "allow" ? "已放开（全部化名）" : "不放开"}
              </div>
            )}
            {pol && pol.relaxations.length > 0 && <div className="muted">相对最严模板的放宽：{pol.relaxations.map(relaxationText).join("；")}</div>}
          </div>
        </div>
        {st.mode === "control_plane" && (
          <>
            <div className="device-row">
              <div className="device-k">许可</div>
              <div>
                {st.license?.state === "valid" ? `有效至 ${fmtTime(st.license.expires_at ?? "")}（${st.license.edition === "firm" ? "律所版" : "团队版"}，${st.license.seats} 席）` : st.license?.state === "expired" ? "已到期：退出模式" : "尚未取得"}
                <div className="muted">
                  {st.admin_threshold_pinned === false
                    ? "管理员签名门限尚未固定（首次取得许可后按版本固定）：固定之前不接受任何放宽类策略与连接器登记。"
                    : `放宽类策略与连接器登记须 ${st.admin_threshold ?? 1} 名管理员设备签名（首次取得许可时按版本固定，只升不降）。`}
                </div>
              </div>
            </div>
            <div className="device-row">
              <div className="device-k">离线可用</div>
              <div>
                {st.seat?.has_token && st.seat.expires_at ? `席位令牌有效至 ${fmtTime(st.seat.expires_at)}` : "席位令牌未取得或已失效：经标准端点的推理与联网检索暂不可用"}
                <div className="muted">控制面不可达时，经标准端点的推理与联网检索可用到席位令牌到期（在线时自动续期，保持至少 72 小时）；本机能力不受影响。{st.directory?.expires_at ? `设备目录有效至 ${fmtTime(st.directory.expires_at)}。` : ""}</div>
              </div>
            </div>
            <div className="device-row">
              <div className="device-k">控制面</div>
              <div>
                {st.last_sync ? `上次同步 ${fmtTime(st.last_sync.at)} · ${st.last_sync.ok ? "正常" : "部分未完成（本机已接受的内容继续有效）"}` : "尚未同步"}
                {st.directory?.stale && <div className="muted">设备目录已过有效期仍未更新：已知的吊销保持，新的吊销信息可能不完整。</div>}
                {(st.pending_actions ?? []).length > 0 && (
                  <div className="muted">
                    待同步到控制面（控制面签名的设备目录列为吊销之前，网关可能仍接受这些设备）：
                    <ul className="plain-list">
                      {st.pending_actions!.map((a) => (
                        <li key={`${a.kind}:${a.target}`}>
                          {a.kind === "revoke_device" ? <span title={a.target}>吊销设备 {shortId(a.target)}</span> : a.kind}：{pendingActionText(a)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <button className="btn-link" disabled={busy} onClick={() => act(() => api.controlPlaneSync(), "已同步")}>立即同步</button>
                <div className="muted">控制面签名只证明“出自控制面”：放宽类策略、连接器登记与成员公钥另须本所管理员设备签名或律所根签发，本机逐项核验。</div>
              </div>
            </div>
          </>
        )}
      </div>
      {(st.alerts ?? []).length > 0 && (
        <>
          <div className="section-title">控制面告警（下发内容未通过本机核验而被拒绝，或须人工核对）</div>
          <table className="data">
            <thead><tr><th>时间</th><th>范围</th><th>说明</th><th></th></tr></thead>
            <tbody>
              {st.alerts!.map((a) => (
                <tr key={a.alert_id}>
                  <td>{fmtTime(a.created_at)}</td>
                  <td>{AREA[a.area] ?? a.area}</td>
                  <td>{a.detail}</td>
                  <td><button className="btn-link" disabled={busy} onClick={() => act(() => api.controlPlaneAck(a.alert_id), "已标记知悉")}>知悉</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {(st.key_changes ?? []).length > 0 && (
        <>
          <div className="section-title">成员设备公钥变更（核对安全码后才替换）</div>
          <p className="muted">请与该成员当面或电话核对：请对方在其设备“连接与数据 → 设备”页读出“本机安全码”，与下方一致才确认。确认前不会向新公钥包裹任何事项密钥；确认只影响本机今后向该设备包裹事项密钥。</p>
          <table className="data">
            <thead><tr><th>成员</th><th>设备</th><th>对方读出的安全码</th></tr></thead>
            <tbody>
              {st.key_changes!.map((k) => (
                <tr key={k.device_id}>
                  <td>{k.member_id}</td>
                  <td className="mono" title={k.device_id}>{shortId(k.device_id)}</td>
                  <td>
                    <input value={codes[k.device_id] ?? ""} onChange={(e) => setCodes({ ...codes, [k.device_id]: e.target.value })} placeholder="请对方读出 30 位数字" />
                    <button className="btn-link" disabled={busy || !(codes[k.device_id] ?? "").trim()} onClick={() => act(() => api.keyChangeConfirm(k.device_id, codes[k.device_id] ?? ""), "安全码一致：已替换公钥")}>本机比对</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="section-title">已登记的律所连接器</div>
      {(st.connectors ?? []).length === 0 ? (
        <p className="muted">没有。连接器登记须管理员设备签名；律所策略回退最严模板时一律不可用。连接器的运行通道即将开放。</p>
      ) : (
        <table className="data">
          <thead><tr><th>连接器</th><th>版本</th><th>服务地址</th><th>可接收至</th><th>工具数</th><th>签名管理员</th></tr></thead>
          <tbody>{st.connectors!.map((c) => <tr key={c.connector_id}><td>{c.name}</td><td>v{c.version}</td><td className="mono">{c.url ?? "—"}</td><td>{c.max_data_level}</td><td>{c.tools}</td><td>{c.signers.join("、")}</td></tr>)}</tbody>
        </table>
      )}
      {drafts && (
        <>
          <div className="section-title">待签名的草稿（管理员）</div>
          {drafts.length === 0 ? (
            <p className="muted">没有待处理的草稿。目前没有网页控制台：律所策略在下方起草（连接器登记经接口起草）；签名在本机进行，签名前本机重算放宽项。同号草稿发布其中一份后，其余自动作废。</p>
          ) : (
            drafts.map((d) => (
              <div key={d.draft_id} className="panel">
                <div className="device-row">
                  <div className="device-k">{d.kind === "policy" ? `律所策略 v${d.doc.version}` : `连接器 v${d.doc.version}`}</div>
                  <div>
                    <div className="muted mono">
                      {d.draft_id}
                      {d.created_at ? ` · 起草于 ${fmtTime(d.created_at)}` : ""}（同号草稿发布其中一份后，其余自动作废）
                    </div>
                    <DraftContent d={d} />
                    <div className="muted">
                      放宽项（本机重算）：{!d.valid ? `未通过本机核验（${d.problem}）：不可签名` : d.relaxations.length > 0 ? d.relaxations.map(relaxationText).join("；") : "无（不比最严模板宽）"}
                    </div>
                    <div className="muted">已签名：{d.signed_by.map((x) => x.member_id).join("、") || "—"}</div>
                    {d.valid && !d.signed_by_me && d.digest && (
                      <button className="btn-link" disabled={busy} onClick={() => act(() => api.policySign(d.draft_id, d.digest!), "已用本机管理员设备签名（签的是上面显示的完整内容）")}>
                        核对无误，签名
                      </button>
                    )}
                    <ConfirmButton label="发布" danger={false} className="btn-link" disabled={busy} question="发布后全所设备同步生效。确定发布？" confirmLabel="确定发布" onConfirm={() => act(() => api.policyPublish(d.draft_id), "已发布并同步（本机按同一规则核验后生效）")} />
                  </div>
                </div>
              </div>
            ))
          )}
          <PolicyDraftForm busy={busy} onSubmit={(body, ttl) => act(() => api.policyCreateDraft(body, ttl), "草稿已起草：核对放宽项后签名并发布")} />
        </>
      )}
    </div>
  );
}

const MODE_TEXT: Record<string, string> = { chat: "问答", manual: "手动", default: "默认", auto: "自动" };

/** 草稿的完整内容（所见即所签：管理员签名覆盖整份文档，签名前逐项展示）。 */
function DraftContent({ d }: { d: PolicyDraft }) {
  const doc = d.doc as Record<string, any>;
  if (d.kind === "policy") {
    const b = (doc.body ?? {}) as Record<string, any>;
    return (
      <div>
        有效期：{fmtTime(String(doc.issued_at ?? ""))} 至 {fmtTime(String(doc.expires_at ?? ""))}
        <div className="muted">
          运行模式上限：{MODE_TEXT[String(b.max_mode)] ?? String(b.max_mode)} · 自动档可预授权：{Array.isArray(b.auto_preauthorizations) && b.auto_preauthorizations.length > 0 ? b.auto_preauthorizations.join("、") : "无"} ·
          抓取白名单追加：{Array.isArray(b.fetch_allowlist_extra) && b.fetch_allowlist_extra.length > 0 ? b.fetch_allowlist_extra.join("、") : "无"} · 敏感事项（L3a）经标准端点：{b.l3a_standard_model === "allow" ? "放开" : "不放开"}
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
  const [ttl, setTtl] = useState(30);
  const domains = extra
    .split(/[\s,，、]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length > 0);
  return (
    <div className="panel">
      <div className="device-row">
        <div className="device-k">起草律所策略</div>
        <div>
          <label>
            运行模式上限{" "}
            <select value={maxMode} onChange={(e) => setMaxMode(e.target.value)}>
              {(["chat", "manual", "default", "auto"] as const).map((m) => (
                <option key={m} value={m}>{MODE_TEXT[m]}</option>
              ))}
            </select>
          </label>{" "}
          <label>
            <input type="checkbox" checked={preSearch && maxMode === "auto"} disabled={maxMode !== "auto"} onChange={(e) => setPreSearch(e.target.checked)} /> 自动档可预授权“泛化后放行的检索”
          </label>
          <div>
            <label>
              抓取白名单追加（每行一个域名）
              <textarea value={extra} onChange={(e) => setExtra(e.target.value)} rows={2} />
            </label>
          </div>
          <label>
            <input type="checkbox" checked={l3a} onChange={(e) => setL3a(e.target.checked)} /> 敏感事项（L3a）可经标准端点推理（全部化名强制）
          </label>{" "}
          <label>
            有效期（天，≤ 30）{" "}
            <input type="number" min={1} max={30} value={ttl} onChange={(e) => setTtl(Math.max(1, Math.min(30, Number(e.target.value) || 30)))} />
          </label>
          <div className="muted">比最严模板宽的任一项都须管理员设备签名后才生效（团队版 1 名、律所版 2 名）；起草后在上方核对完整内容再签名。</div>
          <button
            className="btn-link"
            disabled={busy}
            onClick={() =>
              onSubmit(
                { max_mode: maxMode, auto_preauthorizations: maxMode === "auto" && preSearch ? ["search_generalized"] : [], fetch_allowlist_extra: [...new Set(domains)], l3a_standard_model: l3a ? "allow" : "deny" },
                ttl,
              )
            }
          >
            起草
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
    { k: "文件夹重定向到网络位置", v: tri(e.folder_redirection, "是：保存交付件时请选本机位置", "否"), warn: e.folder_redirection === "yes" },
    { k: "OneDrive 同步“文档/桌面”", v: tri(e.onedrive_kfm, "是：保存到这些位置的文件会同步到云端", "否"), warn: e.onedrive_kfm === "yes" },
    { k: "FSLogix 配置文件容器", v: tri(e.fslogix, "是：配置文件在网络容器中，请 IT 确认存放位置", "否"), warn: e.fslogix === "yes" },
    { k: "系统完整内存转储（LocalDumps）", v: tri(e.local_dumps, "已配置：程序崩溃时可能留下含案件文字的转储，请 IT 排除本应用", "未配置"), warn: e.local_dumps === "yes" },
    { k: "律所防火墙规则", v: tri(e.firewall_rules, "已配置", "未配置（律所版可由 IT 配置，见部署指南）"), warn: false },
    { k: "杀毒软件", v: Array.isArray(e.antivirus) && e.antivirus.length ? e.antivirus.join("、") : "未知", warn: false },
  ];
}

