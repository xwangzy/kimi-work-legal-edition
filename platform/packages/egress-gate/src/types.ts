/**
 * 闸门与内核之间的契约（闸门是独立进程；事项策略、令牌化上下文与去向记录的权威都在内核——事项账本只在律所侧）。
 */
import type { PartyEntry, TokenCategory, TokenEntry } from "@zr-legal/tokenizer";
import type { SignedApproval } from "./approval.ts";
import type { DataLevel } from "./search-guard.ts";

export type GatePurpose = "model" | "search" | "fetch" | "qa";

/** 内核按任务令牌与事项记录给出的出站上下文（闸门不自行判定数据级别，也不信任请求方的自报）。 */
export interface MatterEgressContext {
  tenantId: string;
  matterId: string;
  runId: string;
  /** 运行发起人（任务令牌里的用户）：批准凭据的批准人须与之一致（复核 S5-B05）。 */
  userId: string;
  /** 无事项问答（第 04 篇 §5.3）：matterId/runId 为会话编号；走网关的问答专门路由，不带事项编号。 */
  qa?: boolean;
  /** 匿名事项编号（只用于模型网关的二次检查；**检索调用不携带**）。 */
  anonMatterId: string;
  dataLevel: DataLevel;
  basisComplete: boolean;
  /** 事项允许的模型端点；none = 不使用模型。 */
  modelEndpoint: "standard" | "byok" | "private" | "mock" | "none";
  preauth: { searchGeneralized: boolean; images: boolean };
  /** L3a 事项经标准端点推理是否已由律所管理员放开（第 02 篇 §8.2：“管理员放开 + 全部化名强制”）。 */
  l3aStandardAllowed: boolean;
  /**
   * 抓取域名白名单（公开官方站点基线 + 律所策略；第 04 篇 §5.1 `/fetch`）：每一跳都须命中。
   * 白名单之外的新域名须有律师对该域名的批准凭据（W1）；跳转到其他未经批准的域名一律拒绝。
   */
  fetchAllowlist: readonly string[];
  policyVersion: number;
  /** 审批策略指纹（与批准凭据的 pol 比对；无事项问答为空）。 */
  approvalPolicy?: string;
  tokenizer: {
    /**
     * 事项令牌密钥（base64）：与事项端到端密钥分离的独立随机密钥（D-18），原样下发到闸门进程；HKDF 派生在令牌化器内进行。
     * 只在闸门进程内存中使用，不落盘、不进日志（审查 S4-13 更正）。
     */
    keyB64: string;
    parties: PartyEntry[];
    table: TokenEntry[];
    fullPseudonym: boolean;
    /** 令牌表版本：内核侧有新条目时递增，闸门据此刷新缓存。 */
    tableVersion: number;
  };
}

export type AuthorizeResult = { ok: true; ctx: MatterEgressContext } | { ok: false; status: number; reason: string };

/** 数据去向记录（第 04 篇 §8 EgressRecord；写入本机事项账本——检索查询原文只在这里）。 */
export interface GateEgressRecord {
  at: string;
  /**
   * 记录阶段（审查 S4-03）：start = 转发之前的预写（已发出）；end = 结束时补全（结果、上游状态、用量）；缺省 = 一次写全（被拦截的请求）。
   * 两个阶段的不可变字段（目的地、用途、字数、代号数、请求 ID）相同；内核按请求 ID 合并。
   */
  phase?: "start" | "end";
  requestId: string;
  tenantId: string;
  matterId: string;
  runId: string;
  purpose: GatePurpose;
  /** 目的地类别：法律模型网关（标准端点）/ 自带密钥端点 / 律所私有端点 / 检索服务 / 公开网站（本机抓取）/ 未外发。 */
  destination: "legal_gateway" | "byok_model" | "private_model" | "search_service" | "public_web" | "none";
  destinationHost: string | null;
  outcome: "sent" | "blocked" | "failed";
  reason: string | null;
  chars: number;
  segments: number;
  /** 出站载荷中的代号数（按类别；模型请求含工作区已有的与闸门补替换的）。 */
  tokenized: Partial<Record<TokenCategory, number>>;
  /** 闸门本次补替换的次数（按类别；工作区已是令牌形态时通常为 0）。 */
  replacedAtGate?: Partial<Record<TokenCategory, number>>;
  /** 发送前二次检测：令牌化之后仍像自然人姓名的原文个数（按不同的值、分高中两档；只有计数，不含值）。 */
  suspectedNames?: { high: number; medium: number };
  media: string[];
  /** 检索：查询原文与实际发出的查询（只在本机事项账本）。 */
  query?: { original: string; sent: string | null; decision: string };
  /** 抓取：URL 与跳转链。 */
  url?: { requested: string; final: string | null; hops: number; bytes: number };
  /** 检索/抓取所依据的宿主裁决（宿主出口告知，只作关联，不作授权依据；审查 S4-03）。 */
  hostDecision?: string | null;
  /** 检索/抓取对应的工具调用编号（宿主告知，只作时间线关联）。 */
  toolCallId?: string | null;
  /** 闸门核验通过的批准凭据（律师在可信界面的确认；第 02 篇 §9.5）。 */
  approvalId?: string | null;
  policyVersion: number;
  upstreamStatus: number | null;
  durationMs: number;
  /** 模型请求：请求体中的模型别名与上游响应里的用量（闸门只在内存中从响应尾部读取，不改写响应流）。 */
  model?: string | null;
  usage?: GateUsage | null;
}

export interface GateUsage {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
}

export interface GateAuthority {
  /** light：只核对活性与归属（在途复核用），内核可不下发令牌化上下文；结果不得用于令牌化。 */
  authorize(req: { token: string; matterId: string; purpose: GatePurpose; light?: boolean }): Promise<AuthorizeResult>;
  record(rec: GateEgressRecord): void;
  /** 闸门新识别出的令牌条目（例如网页结果里的人名）回写内核事项令牌表（界面还原需要）。 */
  tokens(matterId: string, entries: TokenEntry[]): void;
  /**
   * 批准凭据（W1，收敛偏离 D-16）：闸门在原本要拒绝的那一刻，按（任务令牌、用途、出站内容摘要、目的地）向内核取律师的批准凭据；
   * 内核原子地消费“本次”凭据。取到后闸门用设备公钥独立核验签名与每个绑定字段（approval.ts）。未提供 = 不受理确认（失败关闭）。
   */
  approval?(req: { token: string; matterId: string; purpose: "search" | "fetch" | "media"; digest: string; dest: string }): Promise<SignedApproval | null>;
}

export interface UpstreamEndpoint {
  /** 例如 https://gateway.zr-legal.cn/v1（G0 开发：本机网关 v0）。 */
  baseUrl: string;
  /** 席位凭据（网关可离线验签；不含事项信息）。 */
  seatToken: string;
  /** SPKI 公钥钉住集（`sha256/…`，当前 + 备份；随客户端构建固定，tls-policy.ts）。 */
  pins?: readonly string[];
}

/** 律所自带密钥或律所内私有模型端点（OpenAI 兼容；密钥只在闸门进程内存，经内核 IPC 下发、不进环境变量）。 */
export interface DirectModelEndpoint {
  baseUrl: string;
  apiKey: string;
  /** 模型别名 → 上游模型 ID（未列出的别名原样透传）。 */
  models?: Readonly<Record<string, string>>;
  /** 律所内部 CA（PEM，只对该端点生效；私有端点常用内部证书）。 */
  caPem?: string;
}

export interface GateUpstreams {
  /** 标准端点：法律模型网关（席位凭据；网关直连月之暗面企业账户）。 */
  model: UpstreamEndpoint | null;
  /** 自带密钥端点（律所直签月之暗面）。 */
  byok?: DirectModelEndpoint | null;
  /** 律所内私有模型端点。 */
  private?: DirectModelEndpoint | null;
  search: UpstreamEndpoint | null;
  /** 抓取：本机直连（G0）/ 关闭。 */
  fetch: "local" | "disabled";
  /**
   * 控制面（阶段 6；第 04 篇 §5.1“控制面、更新、中继：目的地固定，只出元数据或密文”）：内核经 IPC 请闸门代发，地址随客户端构建固定。
   * 未配置 = 开发形态（律所策略以本机配置项代替，D-17）。
   */
  controlPlane?: { baseUrl: string; pins?: readonly string[] } | null;
  /**
   * 内容分发（v9.2 §5.1 S6/S7，dist-relay.ts）：法规库与方法模板的签名清单与包，内核经 IPC 请闸门代取；地址随客户端构建固定，
   * 凭据为席位令牌（闸门自己附上），钉住集与其他中软上游同规则。未配置 = 不检查在线更新。
   */
  dist?: { baseUrl: string; seatToken?: string; pins?: readonly string[] } | null;
  /**
   * 支持服务（第 9 批，v9.2 §5.1 S13，support-relay.ts）：律师确认上传的脱敏诊断包，内核经 IPC 请闸门代发；地址随客户端构建固定，
   * 凭据是内核交来的支持专用短期凭据（受众 support，闸门核对受众后附上；通用席位令牌不发往支持服务）。未配置 = 只能导出文件、不能上传。
   */
  support?: { baseUrl: string; pins?: readonly string[] } | null;
  /**
   * 通知服务（第 10 批，v9 #51 期限提醒、v9.2 §5.1 S9，notify-relay.ts）：提醒的登记、撤销、到时取回与确认，内核经 IPC 请闸门代发；
   * 地址随客户端构建固定；凭据是内核交来的通知专用短期凭据（受众 notify）。未配置 = 提醒只在本机响（电脑关机时不提醒）。
   */
  notify?: { baseUrl: string; pins?: readonly string[] } | null;
  /**
   * 共享中继（第 11 批，v9.2 §5.1 S11，share-relay.ts）：团队事项同步段与密文块切块后的上传、登记与取回，内核经 IPC 请闸门代发；
   * 地址随客户端构建固定；凭据是内核交来的中继专用短期凭据（受众 relay）。未配置 = 团队事项只能经律所共享文件夹同步。
   */
  relay?: { baseUrl: string; pins?: readonly string[] } | null;
  /**
   * 传输策略（tls-policy.ts；审计 S5）：非回环一律 https；回环 http 只在开发形态允许；安装包形态中软网关、检索与控制面必须带钉住集。
   * 缺省 = 开发形态（允许回环 http、不强制钉住）；安装包形态由内核按 ZR_UPSTREAM_TLS=strict 下发。
   */
  tls?: { allowLoopbackHttp: boolean; requirePins: boolean };
}
