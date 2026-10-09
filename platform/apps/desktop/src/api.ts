/** 内核 API 客户端（§15.2）：Electron 经 preload IPC；web 开发经 dev bridge（127.0.0.1:7720）。 */

declare global {
  interface Window {
    zrKernel?: {
      invoke: (method: string, params?: Record<string, unknown>) => Promise<any>;
      onEvent?: (cb: (msg: any) => void) => () => void;
      getPathForFile?: (file: File) => string;
      platform?: string;
    };
  }
}

const BRIDGE = "http://127.0.0.1:7720/invoke";

async function invoke<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (window.zrKernel?.invoke) return window.zrKernel.invoke(method, params) as Promise<T>;
  // web 开发桥（仅开发；生产为 Electron IPC）
  const res = await fetch(BRIDGE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(data.error?.message ?? `内核调用失败`) as Error & { code?: string };
    err.code = data.error?.code;
    throw err;
  }
  return data.result as T;
}

export interface Matter {
  matter_id: string;
  title: string;
  client_name: string | null;
  counterparty: string | null;
  stance: string;
  jurisdiction: string;
  confidentiality: string;
  model_endpoint: "standard" | "byok" | "private" | "none";
  collab_scope: "personal" | "team";
  consent_status: "agreed" | "pending" | "refused" | "not_required";
  node_allowed?: 0 | 1;
  created_at: string;
}

export interface RunEvent {
  event_id: number;
  seq: number;
  type: string;
  payload: Record<string, any>;
  created_at: string;
}

export interface EgressRecord {
  record_id: string;
  destination_kind: string;
  destination_host: string;
  request_id: string | null;
  chars: number;
  segments: number;
  pseudonym_findings: number;
  pseudonym_counts: Record<string, number>;
  note: string | null;
  created_at: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const api = {
  listMatters: () => invoke<{ matters: Matter[] }>("matters.list"),
  createMatter: (body: { title: string; stance: string; jurisdiction?: string; model_endpoint?: string; collab_scope?: string; consent_status?: string; client_name?: string; counterparty?: string }) =>
    invoke<{ matter: Matter }>("matters.create", body),
  getMatter: (id: string) => invoke<{ matter: Matter; documents: any[] }>("matters.get", { matter_id: id }),
  updateMatter: (id: string, patch: Record<string, unknown>) => invoke<{ matter: Matter }>("matters.update", { matter_id: id, patch }),
  consentNotice: (id: string) => invoke<{ artifact_version_id: string; filename: string; note: string }>("matters.consent_notice", { matter_id: id }),

  /** 导入材料：Electron 优先按路径（字节不过 IPC）；web 开发读 base64。内核复算 hash 入库。 */
  importMaterial: async (matterId: string, file: File): Promise<{ document_version_id: string; quality_flags: string[]; chars: number; sha256: string; note: string }> => {
    const path = window.zrKernel?.getPathForFile?.(file);
    if (path) {
      return invoke("materials.import", { matter_id: matterId, path, filename: file.name, mime: file.type || "application/octet-stream" });
    }
    const data_base64 = await fileToBase64(file);
    return invoke("materials.import", { matter_id: matterId, data_base64, filename: file.name, mime: file.type || "application/octet-stream" });
  },

  /** 挂载材料（只读引用，不复制；Electron 桌面可用）。 */
  mountMaterial: async (matterId: string, file: File): Promise<{ document_version_id: string; quality_flags: string[]; chars: number; sha256: string; note: string }> => {
    const path = window.zrKernel?.getPathForFile?.(file);
    if (!path) throw new Error("挂载需要桌面客户端（web 调试请用导入）");
    return invoke("materials.mount", { matter_id: matterId, path, filename: file.name, mime: file.type || "application/octet-stream" });
  },

  estimate: (matterId: string, body: { scenario: string; document_version_ids: string[]; goal?: string; topic_hint?: string } & Record<string, unknown>) =>
    invoke<{ estimate_id: string; points: number; points_display: string; assumptions: string[] }>("runs.estimate", { matter_id: matterId, ...body }),

  startRun: (matterId: string, body: { estimate_id: string; idempotency_key: string; goal?: string; topic_hint?: string }) =>
    invoke<{ run_id: string; status: string }>("runs.start", { matter_id: matterId, ...body }),

  getRun: (runId: string) => invoke<{ run: any; artifacts: any[] }>("runs.get", { run_id: runId }),
  runEvents: (runId: string, cursor = 0) =>
    invoke<{ events: RunEvent[]; next_cursor: number; run_status: string }>("runs.events", { run_id: runId, cursor, limit: 500 }),
  cancelRun: (runId: string, expectedVersion: number) =>
    invoke("runs.cancel", { run_id: runId, expected_version: expectedVersion, reason: "用户取消" }),

  /** 下载成果文件（hash 由内核校验；触发浏览器保存）。 */
  downloadArtifact: async (artifactVersionId: string, filename: string): Promise<void> => {
    const r = await invoke<{ filename: string; sha256: string; data_base64: string }>("artifacts.download", { artifact_version_id: artifactVersionId });
    const bin = Uint8Array.from(atob(r.data_base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bin], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
  revisionOps: (artifactVersionId: string) => invoke("artifacts.revisionOps", { artifact_version_id: artifactVersionId }),

  // 复核与签发
  submitReview: (artifactVersionId: string) => invoke("review.submit", { artifact_version_id: artifactVersionId }),
  completeness: (artifactVersionId: string) => invoke<any>("review.completeness", { artifact_version_id: artifactVersionId }),
  approve: (artifactVersionId: string, body: { decision: "approved" | "rejected"; expected_sha256: string; checklist?: Record<string, unknown> }) =>
    invoke<any>("review.approve", { artifact_version_id: artifactVersionId, ...body }),
  deliver: (body: { artifact_version_id: string; action: "download" | "external_send" | "archive"; audience?: string }) =>
    invoke<any>("deliveries.create", body),
  pending: () => invoke<{ pending: any[]; count: number }>("pending.list"),

  // 数据去向卡（§6.3 组件）
  egressRecords: (args: { runId?: string; matterId?: string }) =>
    invoke<{ records: EgressRecord[] }>("egress.records", args.runId ? { run_id: args.runId } : { matter_id: args.matterId }),

  kernelStatus: () => invoke<any>("kernel.status"),
  /** 法规库状态（§9「法规库最后更新日」；签名无效时内核已拒载，调用会报错）。 */
  lawdbStatus: () => invoke<any>("lawdb.status"),

  /** 转到所内节点执行（须事项已授权 node_allowed；结果经同步回来）。 */
  nodeEnqueue: (body: { matter_id: string; scenario: string; input?: Record<string, unknown>; idempotency_key: string }) => invoke<any>("runs.node_enqueue", body),
  nodeTasks: (matterId: string) => invoke<{ tasks: any[] }>("node_tasks.list", { matter_id: matterId }),
  nodeAuthorize: (matterId: string) => invoke<any>("matters.node_authorize", { matter_id: matterId }),
};
