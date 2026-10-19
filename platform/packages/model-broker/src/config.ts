/**
 * 本机模型代理：路由与价格配置（方案 v5.0 第 4 篇 §10.1）。
 * - 路由别名解耦模型生命周期（补丁 ZP-8：K3 / K2.6 / K2.7-code 可替换）；
 * - 温度固定 1.0；K3 厂商默认 max，本产品默认 high，代理按步骤下调，max 只在律师显式选择时使用；
 * - 价格为占位版本（price-v0-placeholder）：探针 9 实测后校准，客户点数与真实成本分账；
 * - 供应商故障不静默切换其他厂商模型（§10.1 故障）：端点配置显式、报错显式；
 * - 三种模型端点（§10.2）：标准 / 自带密钥 / 私有模型，按事项选定；v9 阶段 4 起端点地址与凭据只在出站闸门进程（标准端点 = 法律模型网关），
 *   本包不持有任何上游地址或密钥。
 */

export interface RouteDef {
  alias: string;
  provider: "upstream" | "mock";
  providerModel: string;
  supportsEffort: boolean;
  defaultEffort: "low" | "high" | "max" | null;
  allowedEfforts: ("low" | "high" | "max")[];
  temperature: number;
  priceKey: string;
  /** 缺省输出上限（复核 B13-C01：按路由配置而非常量；请求未给 max_tokens 时用它；推理 token 计入输出）。 */
  maxOutputTokens?: number;
}

/**
 * 正整数环境变量（1,000–48,000），否则用缺省值。上限 48,000（复核 R2B-32）：引擎自动压缩为输出预留 50,000，
 * 输出上限超过它，上下文接近满时请求可能被上游以超窗拒绝；网关按“输入估算 + 输出上限”预占点数，调得越高越早被额度挡下。
 */
function tokensEnv(e: BrokerEnv, name: string, fallback: number): number {
  const n = Number(e[name]);
  return Number.isInteger(n) && n >= 1_000 && n <= 48_000 ? n : fallback;
}

export const PRICE_VERSION = "price-v0-placeholder-2026-10-01";

/** 微元 / token（1 元 = 1e6 微元）。 */
export interface PriceRow {
  uncached_input: number;
  cached_input: number;
  cache_write: number;
  output: number; // 含推理 token
}

export const PRICES: Record<string, PriceRow> = {
  k3: { uncached_input: 4, cached_input: 1, cache_write: 5, output: 16 },
  k26: { uncached_input: 2, cached_input: 0.5, cache_write: 2.5, output: 8 },
};

export interface BrokerEnv {
  [k: string]: string | undefined;
}

function env(e: BrokerEnv, name: string, fallback?: string): string | undefined {
  const v = e[name];
  return v && v.length > 0 ? v : fallback;
}

export function buildRoutes(e: BrokerEnv = process.env): Record<string, RouteDef> {
  const defaultProvider = (env(e, "ZR_MODEL_PROVIDER", "mock") ?? "mock") === "mock" ? ("mock" as const) : ("upstream" as const);
  return {
    "legal/k3": {
      alias: "legal/k3",
      provider: (env(e, "ZR_MODEL_PROVIDER_K3", defaultProvider) ?? "mock") as "upstream" | "mock",
      providerModel: env(e, "ZR_MODEL_K3", "kimi-k3")!,
      supportsEffort: true,
      defaultEffort: "high", // 厂商默认 max；本代理默认 high，按步骤分档控成本
      allowedEfforts: ["low", "high", "max"],
      temperature: 1.0,
      priceKey: "k3",
      maxOutputTokens: tokensEnv(e, "ZR_MODEL_K3_MAX_TOKENS", 32_000),
    },
    "legal/k2.6": {
      alias: "legal/k2.6",
      provider: (env(e, "ZR_MODEL_PROVIDER_K26", defaultProvider) ?? "mock") as "upstream" | "mock",
      providerModel: env(e, "ZR_MODEL_K26", "kimi-k2.6")!,
      supportsEffort: false,
      defaultEffort: null,
      allowedEfforts: [],
      temperature: 1.0,
      priceKey: "k26",
      maxOutputTokens: tokensEnv(e, "ZR_MODEL_K26_MAX_TOKENS", 32_000),
    },
  };
}
