/**
 * 客户授权依据留痕（D-216，迁移 0072）。
 *
 * 授权依据是“每一份委托合同”或客户单独的书面同意，不是律师个人的一次声明：每个事项记录可核对的出处（basis_ref）、
 * 记录时告知客户的 AI 次处理者清单版本（basis_notice_version）。次处理者清单变更（版本号变化）后，
 * 按旧清单记录的事项须重新确认——模型推理在内核、闸门、宿主与网关摘要里同一口径拦下；版本为空的旧事项不拦（兼容已有数据）。
 *
 * 本模块只放常量与纯函数（另有只读审计表的 authorizationHistory，D-225），闸门（egress/gate-host.ts）、内核接口与事项归档共用。
 */

/** AI 次处理者清单：随版本号一起告知客户；清单内容或角色变化时须换新版本号。 */
export const AI_SUBPROCESSORS = {
  version: "sp-2026-11",
  items: [
    { name: "中软国际", role: "云端转发，不保存内容" },
    { name: "月之暗面", role: "Kimi 模型推理" },
  ],
} as const;

/**
 * 第 73 批（V47，P2-3）：团队共享事项（和同事一起办）的次处理者清单——中软除了转发 AI 请求，还经同事之间同步保存加密副本。
 * 与只有我的事项分开记版本：按只有我的清单记录的授权，转成团队共享后须按这一份重新确认（授权覆盖范围变了）。
 * 角色原话与开通“同事之间同步”的确认框一致（服务方打不开；本机删除事项不会删除服务方那里的加密副本）。
 */
export const AI_SUBPROCESSORS_TEAM = {
  version: "sp-2026-11-team",
  items: [
    { name: "中软国际", role: "云端转发 AI 请求，不保存内容；同事之间同步时保存加密副本，打不开内容；本机删除事项不会删除中软上的加密副本" },
    { name: "月之暗面", role: "Kimi 模型推理" },
  ],
} as const;

export type CollabScopeLike = string | null | undefined;

/** 事项范围对应的次处理者清单（团队共享 / 只有我）。 */
export function subprocessorsFor(scope: CollabScopeLike): { version: string; items: readonly { name: string; role: string }[] } {
  return scope === "team" ? AI_SUBPROCESSORS_TEAM : AI_SUBPROCESSORS;
}

/** 事项范围对应的“当前”次处理者清单版本（授权记录按它判断是否须重新确认）。 */
export function noticeVersionFor(scope: CollabScopeLike): string {
  return subprocessorsFor(scope).version;
}

/** 数据去向的一条（开始前确认的授权卡、授权记录、估价的完整说明共用）。 */
export interface DataFlowEntry {
  key: "local" | "colleagues" | "zr_relay";
  label: string;
  text: string;
  /** 第 73 批：同事电脑一条带人数（不含本人的在册事项成员；不知道为 null）；其余条目没有。 */
  count?: number | null;
}

/**
 * 事项的数据去向（P2-3）：只有我的事项——案卷只存这台电脑；团队共享事项——同事电脑上也有（经加密同步到事项成员的电脑）、
 * 中软保存加密副本（打不开；本机删除事项不会删除中软上的加密副本）。colleagues = 除本人外的在册事项成员数（不知道为 null）。纯函数。
 */
export function dataFlowsFor(scope: CollabScopeLike, colleagues: number | null = null): DataFlowEntry[] {
  if (scope !== "team") return [{ key: "local", label: "案卷", text: "案卷只存这台电脑" }];
  return [
    // 还没加同事（0 人）时不写人数（11-27 实拍：“本所同事 0 人”读着像没有去向）
    {
      key: "colleagues",
      label: "同事电脑",
      count: colleagues,
      text: colleagues === 0 ? "经加密同步到之后加进来的同事电脑；他们电脑上也会有材料与成果" : `经加密同步到事项成员的电脑${colleagues !== null ? `（本所同事 ${colleagues} 人）` : ""}；他们电脑上也有材料与成果`,
    },
    { key: "zr_relay", label: "中软", text: "保存加密副本，打不开内容；本机删除事项不会删除中软上的加密副本" },
  ];
}

/** 律师本人“首次使用 AI 数据去向告知”的版本（user_ai_notice）。 */
export const AI_NOTICE_VERSION = "notice-2026-11";

/** 四项依据的记录方式（matters.basis_source）。confirmed 为第 48 批的旧值（律师确认 / 逐项记录），继续接受以兼容。 */
export const BASIS_SOURCES = ["engagement_terms", "separate_consent", "confirmed"] as const;
export type BasisSource = (typeof BASIS_SOURCES)[number];

/** 授权依据出处（basis_ref）与律师常用条款出处（default_ref）的长度上限（字）。 */
export const BASIS_REF_MAX = 200;

/** 次处理者清单已更新、须按新清单重新记录时的阻断原因（以“四项依据”开头：阻断类别为 consent）。 */
export const NOTICE_RECONFIRM_REASON = "四项依据须重新确认：AI 次处理者清单已更新，请按新的清单重新记录客户授权";

/**
 * 四项已齐但没有记下依据出处时的阻断原因（D-225；以“四项依据”开头：阻断类别为 consent，界面给重新确认卡）。
 * 这是 D-216 之前的记录，或“逐项记录”路径留下的；补记一次即可。
 */
export const NEEDS_REF_REASON = "四项依据须补记出处：这是早期记录，缺少客户授权依据的出处，请补记一次";

/** 每次记录或重新确认客户授权时追加的审计事件（D-225）：detail 列存规整 JSON 明文（依据类型、出处、次处理者清单版本、四项），只增不改。 */
export const AUTHORIZATION_AUDIT_ACTION = "matter.ai_authorization";

/** 一条授权记录（D-225；从审计事件读出的明文）。 */
export interface AuthorizationRecordEntry {
  basis_source: string;
  basis_ref: string;
  basis_notice_version: string;
  basis: Record<string, string> | null;
  /** 第 73 批：记录时的事项范围与数据去向（此前的记录没有，为 null）。 */
  scope: "personal" | "team" | null;
  data_flows: DataFlowEntry[] | null;
  recorded_by_id: string;
  recorded_at: string;
}

/** 事项的授权记录历史（新的在前）。只读审计表；内核接口与事项归档共用。 */
export function authorizationHistory(db: { all<T>(sql: string, params?: unknown[]): T[] }, matterId: string): AuthorizationRecordEntry[] {
  const out: AuthorizationRecordEntry[] = [];
  for (const r of db.all<{ actor_id: string; detail_hash: string | null; created_at: string }>(
    `SELECT actor_id, detail_hash, created_at FROM audit_events WHERE action = ? AND object_kind = 'matter' AND object_id = ? ORDER BY audit_event_id DESC`,
    [AUTHORIZATION_AUDIT_ACTION, matterId],
  )) {
    let d: { basis_source?: unknown; basis_ref?: unknown; basis_notice_version?: unknown; basis?: unknown; scope?: unknown; data_flows?: unknown } | null = null;
    try {
      d = JSON.parse(String(r.detail_hash ?? ""));
    } catch {
      d = null;
    }
    if (!d || typeof d.basis_ref !== "string") continue;
    out.push({
      basis_source: String(d.basis_source ?? ""),
      basis_ref: d.basis_ref,
      basis_notice_version: String(d.basis_notice_version ?? ""),
      basis: d.basis && typeof d.basis === "object" ? (d.basis as Record<string, string>) : null,
      scope: d.scope === "team" || d.scope === "personal" ? d.scope : null,
      data_flows: Array.isArray(d.data_flows) ? (d.data_flows as DataFlowEntry[]) : null,
      recorded_by_id: r.actor_id,
      recorded_at: r.created_at,
    });
  }
  return out;
}

/** 事项的授权记录是否按旧的次处理者清单（版本非空且不等于这个事项范围的当前版本）。版本为空（此前的事项、未记来源）不算。 */
export function basisNoticeStale(m: { basis_notice_version?: string | null; collab_scope?: CollabScopeLike }): boolean {
  const v = m.basis_notice_version;
  return typeof v === "string" && v !== "" && v !== noticeVersionFor(m.collab_scope);
}

/** 出处文字规整：去首尾空白，空串为 null；非字符串、超长返回错误说明（调用方抛 validation）。 */
export function normalizeRef(v: unknown, what: string): { ok: true; value: string | null } | { ok: false; message: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, message: `${what}须为文字` };
  const s = v.trim();
  if (!s) return { ok: true, value: null };
  if (Array.from(s).length > BASIS_REF_MAX) return { ok: false, message: `${what}至多 ${BASIS_REF_MAX} 字` };
  return { ok: true, value: s };
}
