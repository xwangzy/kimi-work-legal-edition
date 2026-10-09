import { useEffect, useMemo, useRef, useState } from "react";
import { api, type RunEvent } from "../api.ts";
import { nav } from "../App.tsx";

/** 执行态三栏（第 2 篇 §4.4：左步骤流、右预览约 45% 多标签；进度只说事实；拦截可见；去向可查）。 */
export function RunView({ runId, matterId }: { runId: string; matterId: string }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState("queued");
  const [run, setRun] = useState<any>(null);
  const [tab, setTab] = useState<"citations" | "doc" | "record" | "egress">("citations");
  const cursor = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // 切换任务时重置本地状态，避免串台
    setEvents([]);
    setStatus("queued");
    setRun(null);
    cursor.current = 0;
    api.getRun(runId).then((r) => setRun(r.run)).catch(() => {});
    const tick = async () => {
      try {
        const r = await api.runEvents(runId, cursor.current);
        if (r.events.length > 0) {
          cursor.current = r.next_cursor;
          setEvents((prev) => [...prev, ...r.events]);
        }
        setStatus(r.run_status);
        if (["succeeded", "failed", "cancelled"].includes(r.run_status) && timer.current) {
          clearInterval(timer.current);
          api.getRun(runId).then((x) => setRun(x.run)).catch(() => {});
        }
      } catch {
        // BFF 未就绪时下个周期重试
      }
    };
    void tick();
    timer.current = setInterval(() => void tick(), 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [runId]);

  const citationEvent = useMemo(() => [...events].reverse().find((e) => e.type === "citations.verified"), [events]);
  const agentOutput = useMemo(() => [...events].reverse().find((e) => e.type === "agent.output"), [events]);
  const verdicts: any[] = citationEvent?.payload?.verdicts ?? [];
  const intercepted: any[] = citationEvent?.payload?.intercepted_items ?? [];

  return (
    <div className="exec">
      <aside className="sidebar">
        <div className="brand">◉ Kimi Work<small>法律行业发行版（demo）</small></div>
        <button className="nav-item" onClick={() => nav(`/matter/${matterId}`)}>← 返回事项</button>
        <div className="sidebar-section">任务状态</div>
        <div className="sidebar-link">{statusLabel(status)}</div>
        {run && (
          <>
            <div className="sidebar-section">点数</div>
            <div className="sidebar-link">预留 {run.points_reserved} · 已扣 {run.points_charged}</div>
          </>
        )}
      </aside>
      <div className="exec-mid">
        <h1 className="page-title">执行 · {run?.scenario ?? ""}</h1>
        <p className="muted">事件先落本机事项账本，本页按游标续传；离开本页不会取消内核任务。</p>
        <div>
          {events.map((e) => (
            <StepRow key={e.event_id} e={e} />
          ))}
          {!["succeeded", "failed", "cancelled"].includes(status) && <p className="muted">执行中…</p>}
        </div>
        {["queued", "running"].includes(status) && run && (
          <button
            className="btn-ghost"
            onClick={async () => {
              try {
                const cur = await api.getRun(runId);
                await api.cancelRun(runId, cur.run.status_version);
              } catch (e) {
                alert((e as Error).message);
              }
            }}
          >取消任务</button>
        )}
      </div>
      <div className="exec-right">
        <div className="tabs">
          <button className={`tab ${tab === "doc" ? "active" : ""}`} onClick={() => setTab("doc")}>文档</button>
          <button className={`tab ${tab === "citations" ? "active" : ""}`} onClick={() => setTab("citations")}>
            引用{intercepted.length > 0 ? `（拦截 ${intercepted.length}）` : ""}
          </button>
          <button className={`tab ${tab === "egress" ? "active" : ""}`} onClick={() => setTab("egress")}>去向</button>
          <button className={`tab ${tab === "record" ? "active" : ""}`} onClick={() => setTab("record")}>记录</button>
        </div>
        <div className="tab-body">
          {tab === "citations" && (
            <>
              {intercepted.length > 0 && (
                <div className="intercept-banner">
                  本次拦截 {intercepted.length} 条无法核实的引用（不静默删除，复核确认前不得作为依据）
                </div>
              )}
              {verdicts.length === 0 && <p className="muted">引用核验尚未产生结果。</p>}
              {verdicts.map((v, i) => (
                <div className="verdict" key={i}>
                  <div>
                    <span className="raw">{v.raw}</span>{" "}
                    <span className={`cite-state cite-${v.state === "support_pending" ? "support-pending" : v.state}`}>
                      {citeStateLabel(v.state)}
                    </span>
                  </div>
                  <div className="row">
                    {v.matched_law_name ?? "未匹配法源"}
                    {v.effectiveness ? `〔${effectivenessLabel(v.effectiveness)}〕` : ""}
                  </div>
                  {v.reasons?.map((r: string, j: number) => <div className="row" key={j}>{r}</div>)}
                  {v.suggestion && <div className="row suggestion">建议：{v.suggestion}</div>}
                  {v.historical_note && <div className="row">{v.historical_note}</div>}
                </div>
              ))}
            </>
          )}
          {tab === "doc" && <DocTab runId={runId} />}
          {tab === "egress" && <EgressTab runId={runId} />}
          {tab === "record" && <RecordTab runId={runId} />}
        </div>
      </div>
    </div>
  );
}

/** 数据去向卡（§6.3：每个任务可展开——发了哪些内容、发给谁、化名了什么）。 */
function EgressTab({ runId }: { runId: string }) {
  const [records, setRecords] = useState<import("../api.ts").EgressRecord[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.egressRecords({ runId }).then((r) => setRecords(r.records)).catch((e) => setErr(e.message));
  }, [runId]);
  if (err) return <p className="muted">{err}</p>;
  if (!records) return <p className="muted">载入中…</p>;
  const external = records.filter((r) => r.destination_kind !== "mock_local");
  return (
    <>
      <div className="intercept-banner" style={external.length === 0 ? {} : { borderColor: "#e8b23a", background: "#fdf6e3" }}>
        {external.length === 0
          ? "本任务未向律所侧之外发送任何内容（离线 mock 或纯本机步骤）。"
          : `本任务外发 ${external.length} 次：只发送经化名校验的必要片段；原件与成果的其余副本未离开本机。`}
      </div>
      {records.map((r) => (
        <div className="verdict" key={r.record_id}>
          <div>
            <b>{destLabel(r.destination_kind)}</b> <span className="tag tag-prod">{r.destination_host}</span>
          </div>
          <div className="row">
            {r.segments} 段 · {r.chars.toLocaleString()} 字符 · 化名校验：
            {r.pseudonym_findings > 0
              ? `发现 ${r.pseudonym_findings} 处未替换标识符（${Object.entries(r.pseudonym_counts).map(([k, v]) => `${k}×${v}`).join("、")}）`
              : "无未替换直接标识符"}
          </div>
          {r.note && <div className="row">{r.note}</div>}
          <div className="row mono">请求 {(r.request_id ?? "—").slice(0, 28)} · {new Date(r.created_at).toLocaleTimeString()}</div>
        </div>
      ))}
    </>
  );
}

function destLabel(kind: string): string {
  const map: Record<string, string> = {
    maas_model: "Kimi 模型（经中软 MaaS 法律通道）",
    byok_model: "Kimi 模型（律所自带密钥，不经中软）",
    private_model: "律所内私有模型",
    moonshot_verify: "模型真实性校验",
    law_source: "法源数据商（去标识查询）",
    timestamp: "可信时间戳（仅 hash）",
    content_update: "内容分发（只下行）",
    support_upload: "工单与诊断包",
    mock_local: "本机 mock（未外发）",
  };
  return map[kind] ?? kind;
}

const ARTIFACT_LABELS: Record<string, string> = {
  s1_redline: "修订稿（原生修订）",
  s1_clean: "清洁稿",
  s1_opinion: "审查意见书（内部稿）",
  s1_issue_table: "条款问题表",
  s1b_report: "回稿比对报告",
  s1b_diff_table: "回稿差异表",
  s6_redacted: "脱敏件",
  s6_report: "脱敏报告",
  a1_agent_draft: "Agent 草稿",
};

/** 文档页：本次任务产出的交付件（真实文件，可下载）。 */
function DocTab({ runId }: { runId: string }) {
  const [data, setData] = useState<{ run: any; artifacts: any[] } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.getRun(runId).then(setData).catch((e) => setErr(e.message));
  }, [runId]);
  if (err) return <p className="muted">{err}</p>;
  if (!data) return <p className="muted">载入中…</p>;
  if (data.artifacts.length === 0) return <p className="muted">尚无成果文件。</p>;
  return (
    <>
      <p className="muted">交付件（草稿状态，经律师复核签发后方可对外）：</p>
      {data.artifacts.map((a) => (
        <div className="verdict" key={a.artifact_version_id}>
          <div>
            <b>{ARTIFACT_LABELS[a.kind] ?? a.kind}</b> <span className="tag tag-beta">{a.status}</span>
          </div>
          <div className="row">{a.filename} · v{a.version}</div>
          <div className="row mono">sha256 {a.sha256.slice(0, 20)}…</div>
          <div className="row">
            <button
              className="btn-ghost"
              onClick={() =>
                void api
                  .downloadArtifact(a.artifact_version_id, a.filename)
                  .then(() => api.deliver({ artifact_version_id: a.artifact_version_id, action: "download" }))
                  .catch((e) => alert(e.message))
              }
            >
              下载（留痕）
            </button>
            {a.status === "draft" && (
              <button
                className="btn-primary"
                style={{ marginLeft: 8 }}
                onClick={async () => {
                  try {
                    await api.submitReview(a.artifact_version_id);
                    nav(`/review/${a.artifact_version_id}`);
                  } catch (e) {
                    alert((e as Error).message);
                  }
                }}
              >
                提交复核
              </button>
            )}
            {a.status === "pending_review" && (
              <button className="btn-primary" style={{ marginLeft: 8 }} onClick={() => nav(`/review/${a.artifact_version_id}`)}>
                去复核/签发
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

function RecordTab({ runId }: { runId: string }) {
  const [data, setData] = useState<{ run: any; artifacts: any[] } | null>(null);
  useEffect(() => {
    api.getRun(runId).then(setData).catch(() => {});
  }, [runId]);
  if (!data) return <p className="muted">载入中…</p>;
  return (
    <>
      <table className="data">
        <tbody>
          <tr><th>任务</th><td className="mono">{data.run.run_id}</td></tr>
          <tr><th>状态</th><td>{statusLabel(data.run.status)}</td></tr>
          <tr><th>点数</th><td>预留 {data.run.points_reserved} / 已扣 {data.run.points_charged}</td></tr>
        </tbody>
      </table>
      <div className="section-title">成果（生成物状态只能是草稿，复核签发后才是交付件）</div>
      {data.artifacts.length === 0 && <p className="muted">尚无成果。</p>}
      {data.artifacts.map((a) => (
        <div className="verdict" key={a.artifact_version_id}>
          <div><b>{a.filename}</b> <span className="tag tag-beta">{a.status}</span> <span className="tag tag-prod">{a.audience}</span></div>
          <div className="row mono">sha256 {a.sha256.slice(0, 24)}…</div>
          <div className="row">{a.kind} · v{a.version} · {new Date(a.created_at).toLocaleString()}</div>
        </div>
      ))}
    </>
  );
}

function StepRow({ e }: { e: RunEvent }) {
  const icon = e.type.endsWith(".succeeded") || e.type === "run.succeeded" ? "✓" : e.type.endsWith(".failed") ? "✗" : "•";
  return (
    <div className="step">
      <div className="dot">{icon}</div>
      <div style={{ flex: 1 }}>
        <div>
          {stepTitle(e)}
          {e.payload?.where && <span className="tag tag-prod" style={{ marginLeft: 8 }}>{e.payload.where}</span>}
        </div>
        <div className="meta">{new Date(e.created_at).toLocaleTimeString()} · {e.type}</div>
        {e.type === "plan.created" && <div className="meta">计划（已确认）：{(e.payload.steps ?? []).join(" → ")}</div>}
        {e.type === "citations.verified" && (
          <div className="meta">
            引用 {e.payload.total} 条 · 拦截 {e.payload.intercepted} 条{Number(e.payload.intercepted) > 0 ? "（详见右侧“引用”页）" : ""}
            {Number(e.payload.unverified_offline) > 0 ? ` · 未核实（离线） ${e.payload.unverified_offline} 条（不得签发）` : ""}
          </div>
        )}
        {e.type === "model.completed" && (
          <div className="meta">
            模型路由 {e.payload.route} · 提供方 {e.payload.provider} · 端点 {e.payload.endpoint ?? "—"} · 成本 {(Number(e.payload.cost_microcny) / 1e6).toFixed(4)} 元
          </div>
        )}
        {e.type === "agent.approval" && (
          <div className="meta">控制面审批：{e.payload.tool} → {e.payload.decision === "approved" ? "批准" : "拒绝"}（{e.payload.policy}）</div>
        )}
        {e.type === "agent.output" && <div className="meta">产出 {e.payload.output_chars} 字符 · {e.payload.status}</div>}
        {e.type === "run.failed" && <pre>{e.payload.error}</pre>}
      </div>
    </div>
  );
}

function stepTitle(e: RunEvent): string {
  switch (e.type) {
    case "run.started": return "任务受理";
    case "plan.created": return "计划已生成";
    case "materials.loaded": return `材料载入：已读 ${e.payload.loaded}/${e.payload.requested} 份${e.payload.failed ? `，${e.payload.failed} 份失败` : ""}`;
    case "citations.verified": return "引用核验完成";
    case "model.completed": return "模型审查完成";
    case "artifact.drafted": return "草稿已生成（待复核）";
    case "run.succeeded": return "任务完成";
    case "run.failed": return "任务失败";
    case "run.cancelled": return "任务已取消";
    case "agent.task_started": return "Agent worker 已启动（隔离进程）";
    case "agent.ready": return "Agent 引擎就绪";
    case "agent.approval": return "工具调用审批";
    case "agent.done": return `Agent 执行结束（${e.payload.status}）`;
    case "agent.output": return "Agent 产出汇总";
    case "agent.error": return "Agent 错误";
    default: return e.type;
  }
}

function statusLabel(s: string): string {
  const map: Record<string, string> = {
    queued: "排队中", running: "执行中", waiting_input: "等待输入", waiting_approval: "等待审批",
    budget_paused: "预算暂停", succeeded: "已完成", failed: "失败", cancelled: "已取消", reconciling: "对账中",
  };
  return map[s] ?? s;
}

function citeStateLabel(s: string): string {
  const map: Record<string, string> = {
    source_verified: "来源已核", version_verified: "版本已核", support_pending: "支持待判",
    lawyer_confirmed: "律师已确认", intercepted: "已拦截", unverified_offline: "未核实（离线）",
  };
  return map[s] ?? s;
}

function effectivenessLabel(s: string): string {
  const map: Record<string, string> = { valid: "现行有效", amended: "已修改", repealed: "已废止" };
  return map[s] ?? s;
}
