import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Matter, type EgressRecord } from "../api.ts";
import { nav } from "../App.tsx";

const ENDPOINT_LABELS: Record<string, string> = { standard: "标准端点（中软 MaaS）", byok: "自带密钥", private: "私有模型", none: "不使用模型" };
const SCOPE_LABELS: Record<string, string> = { personal: "个人（仅本机）", team: "团队（所内同步）" };
const CONSENT_LABELS: Record<string, string> = { agreed: "已同意", pending: "待取得", refused: "已拒绝", not_required: "无需" };

/** 事项页（第 2 篇 §4.3：头部常显立场/法域/保密/模型端点/协作范围/当事人同意；材料与任务；数据去向）。 */
export function MatterPage({ matterId }: { matterId: string }) {
  const [matter, setMatter] = useState<Matter | null>(null);
  const [docs, setDocs] = useState<any[]>([]);
  const [egress, setEgress] = useState<EgressRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [goal, setGoal] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const mountRef = useRef<HTMLInputElement>(null);

  const [channel, setChannel] = useState<string>("");
  const reload = useCallback(() => {
    api.getMatter(matterId).then((r) => {
      setMatter(r.matter);
      setDocs(r.documents);
    }).catch((e) => setMsg(e.message));
    api.egressRecords({ matterId }).then((r) => setEgress(r.records)).catch(() => {});
    api.kernelStatus().then((s) => setChannel(s.note ?? "")).catch(() => {});
  }, [matterId]);
  useEffect(reload, [reload]);

  const uploadFiles = useCallback(
    async (files: FileList | null, mode: "import" | "mount") => {
      if (!files || files.length === 0) return;
      setBusy(true);
      setMsg("");
      try {
        for (const f of Array.from(files)) {
          const r = mode === "import" ? await api.importMaterial(matterId, f) : await api.mountMaterial(matterId, f);
          setMsg(`已${mode === "import" ? "导入" : "挂载"} ${f.name}（${r.chars} 字符；${r.note}）`);
        }
        reload();
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [matterId, reload],
  );

  const patchMatter = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        const r = await api.updateMatter(matterId, patch);
        setMatter(r.matter);
        if (patch.model_endpoint) {
          const notes: Record<string, string> = {
            standard: "标准端点：模型请求经中软 MaaS 法律通道 → Kimi；只发经化名校验的必要片段",
            byok: "自带密钥：模型请求直连月之暗面，不经中软；token 由律所承担",
            private: "私有模型：请求发往律所内推理服务（全链路本地化）",
            none: "不使用模型：只用本机确定性工具与人工",
          };
          setMsg(`模型端点已变更并留痕。数据去向变化：${notes[String(patch.model_endpoint)] ?? ""}`);
        } else {
          setMsg("事项口径已更新并留痕");
        }
      } catch (e) {
        setMsg((e as Error).message);
      }
    },
    [matterId],
  );

  const startRun = useCallback(
    async (scenario: "s1.contract_review" | "a1.agent_task" | "s2.case_file" | "s1b.draft_compare" | "s6.redaction") => {
      if (docs.length === 0) {
        setMsg("请先导入或挂载材料");
        return;
      }
      setBusy(true);
      setMsg("");
      try {
        const docIds = docs.map((d) => d.document_version_id);
        const extra: Record<string, unknown> = {};
        if (scenario === "s1.contract_review") extra.topic_hint = "保密义务";
        if (scenario === "s1b.draft_compare") {
          if (docs.length < 2) {
            setMsg("回稿比对需要至少两份文档（基线 + 回稿）");
            setBusy(false);
            return;
          }
          // v0：最早一份为基线、最新一份为回稿（正式版提供选择器）
          extra.baseline_document_version_id = docs.at(-1)!.document_version_id;
          extra.current_document_version_id = docs[0]!.document_version_id;
        }
        if (goal) extra.goal = goal;
        const est = await api.estimate(matterId, { scenario, document_version_ids: docIds, ...extra });
        const run = await api.startRun(matterId, {
          estimate_id: est.estimate_id,
          idempotency_key: `${matterId}-${scenario}-${Date.now()}`,
          goal: goal || (scenario === "a1.agent_task" ? "请核验材料中引用的法条是否现行有效，并给出处理建议。" : undefined),
          topic_hint: extra.topic_hint as string | undefined,
        });
        nav(`/run/${run.run_id}/${matterId}`);
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [docs, goal, matterId],
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">◉ Kimi Work<small>法律行业发行版（demo）</small></div>
        <button className="nav-item" onClick={() => nav("/")}>← 返回首页</button>
        {channel && (
          <>
            <div className="sidebar-section">模型通道</div>
            <div className="sidebar-link" style={{ whiteSpace: "normal", fontSize: 12 }}>{channel}</div>
          </>
        )}
      </aside>
      <main className="main">
        <div className="main-narrow">
          <h1 className="page-title">{matter?.title ?? "事项"}</h1>
          {matter && (
            <>
              <div className="matter-head">
                <span><span className="kv">客户</span><span className="v">{matter.client_name ?? "—"}</span></span>
                <span><span className="kv">相对方</span><span className="v">{matter.counterparty ?? "—"}</span></span>
                <span><span className="kv">我方立场</span><span className="v">{matter.stance}</span></span>
                <span><span className="kv">法域</span><span className="v">{matter.jurisdiction}</span></span>
                <span><span className="kv">保密</span><span className="v">{matter.confidentiality}</span></span>
                <span><span className="kv">分析截止日</span><span className="v">{(matter as any).key_dates?.analysis_as_of ?? "—"}</span></span>
              </div>
              <div className="matter-head" style={{ marginTop: 6 }}>
                <label className="kv-field">
                  模型端点
                  <select value={matter.model_endpoint} onChange={(e) => void patchMatter({ model_endpoint: e.target.value })}>
                    {Object.entries(ENDPOINT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
                <label className="kv-field">
                  协作范围
                  <select value={matter.collab_scope} onChange={(e) => void patchMatter({ collab_scope: e.target.value })}>
                    {Object.entries(SCOPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
                <label className="kv-field">
                  当事人同意
                  <select value={matter.consent_status} onChange={(e) => void patchMatter({ consent_status: e.target.value })}>
                    {Object.entries(CONSENT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
              </div>
              {matter.consent_status === "pending" && (
                <p className="muted" style={{ marginTop: 6 }}>
                  当事人告知同意「待取得」：模型步骤将被出站闸门拦截，只用本机能力（解析、比对、脱敏、法条核验）；改为「无需/已同意」后可使用模型。
                  <button
                    className="btn-ghost"
                    style={{ marginLeft: 8 }}
                    onClick={() => {
                      void api.consentNotice(matterId).then((r) => {
                        setMsg(r.note);
                        return api.downloadArtifact(r.artifact_version_id, r.filename);
                      }).catch((e) => setMsg(e.message));
                    }}
                  >
                    一键生成告知函
                  </button>
                </p>
              )}
              {matter.consent_status === "refused" && (
                <p className="muted" style={{ marginTop: 6 }}>
                  当事人已拒绝云端处理：只允许私有模型端点或不使用模型。
                </p>
              )}
              {matter.node_allowed === 1 && (
                <p className="muted" style={{ marginTop: 6 }}>
                  已授权所内节点执行本事项（strict 与伦理墙事项不可授权）。
                  <button
                    className="btn-ghost"
                    style={{ marginLeft: 8 }}
                    onClick={() => {
                      void api
                        .nodeEnqueue({
                          matter_id: matterId,
                          scenario: "s1.contract_review",
                          input: { document_version_ids: docs.map((d) => d.document_version_id) },
                          idempotency_key: `node-${matterId}-${Date.now()}`,
                        })
                        .then((r) => setMsg(`已转交节点执行（${r.task_id}）：节点拾取后执行，结果经同步回来，可在 node_tasks 查看`))
                        .catch((e) => setMsg(e.message));
                    }}
                  >
                    转到所内节点
                  </button>
                </p>
              )}
            </>
          )}

          <div className="section-title">材料（原件只读、不可变版本；挂载不复制原件）</div>
          <div
            className="upload-zone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void uploadFiles(e.dataTransfer.files, "import");
            }}
          >
            拖入 DOCX / TXT 导入，或{" "}
            <button className="btn-ghost" disabled={busy} onClick={() => fileRef.current?.click()}>选择文件导入</button>
            <button className="btn-ghost" disabled={busy} style={{ marginLeft: 8 }} onClick={() => mountRef.current?.click()}>挂载文件（不复制）</button>
            <input ref={fileRef} type="file" multiple hidden accept=".docx,.txt,.md" onChange={(e) => void uploadFiles(e.target.files, "import")} />
            <input ref={mountRef} type="file" multiple hidden accept=".docx,.txt,.md" onChange={(e) => void uploadFiles(e.target.files, "mount")} />
            <div className="muted" style={{ marginTop: 6 }}>内核复算 hash 后入库；PDF 待文档服务接入（G0 第 3–4 周）</div>
          </div>
          {docs.length > 0 && (
            <table className="data" style={{ marginTop: 12 }}>
              <thead><tr><th>文件</th><th>方式</th><th>大小</th><th>hash（前 12 位）</th><th>时间</th></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.document_version_id}>
                    <td>{d.filename}</td>
                    <td>{d.storage_mode === "mount" ? "挂载" : "导入"}</td>
                    <td>{(d.size_bytes / 1024).toFixed(1)} KB</td>
                    <td className="mono">{d.sha256.slice(0, 12)}</td>
                    <td>{new Date(d.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="section-title">发起任务</div>
          <div className="hero-input">
            <textarea
              placeholder="任务说明（可选）：例如“核验引用法条是否现行有效，给出处理建议”"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              style={{ minHeight: 56 }}
            />
            <div className="hero-toolbar">
              <button className="btn-primary" disabled={busy} onClick={() => void startRun("s1.contract_review")}>
                按 Playbook 审查（S1）
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => void startRun("s1b.draft_compare")}>
                回稿比对（S1b）
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => void startRun("s2.case_file")}>
                案卷整理（S2）
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => void startRun("s6.redaction")}>
                脱敏（S6）
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => void startRun("a1.agent_task")}>
                Agent 模式（A1 Beta）
              </button>
            </div>
          </div>
          {msg && <p className="muted" style={{ marginTop: 14 }}>{msg}</p>}

          <div className="section-title">数据去向（每一次外发都有记录）</div>
          {egress.length === 0 && <p className="muted">本事项尚无外发记录；原件与成果默认留在本机工作区。</p>}
          {egress.length > 0 && (
            <table className="data">
              <thead><tr><th>时间</th><th>目的地</th><th>类别</th><th>字符数</th><th>化名校验</th><th>请求</th></tr></thead>
              <tbody>
                {egress.map((r) => (
                  <tr key={r.record_id}>
                    <td>{new Date(r.created_at).toLocaleString()}</td>
                    <td>{r.destination_host}</td>
                    <td>{r.destination_kind}</td>
                    <td>{r.chars}</td>
                    <td>{r.pseudonym_findings > 0 ? `发现 ${r.pseudonym_findings} 处` : "无未替换标识符"}</td>
                    <td className="mono">{(r.request_id ?? "—").slice(0, 18)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}
