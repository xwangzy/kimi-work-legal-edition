/**
 * 本机模型代理：路由与价格配置（方案 v5.0 第 4 篇 §10.1）。
 * - 路由别名解耦模型生命周期（补丁 ZP-8：K3 / K2.6 / K2.7-code 可替换）；
 * - 温度固定 1.0；K3 厂商默认 max，本产品默认 high，代理按步骤下调，max 只在律师显式选择时使用；
 * - 价格为占位版本（price-v0-placeholder）：探针 9 实测后校准，客户点数与真实成本分账；
 * - 供应商故障不静默切换其他厂商模型（§10.1 故障）：端点配置显式、报错显式；
 * - 三种模型端点（§10.2）：标准（中软 MaaS 法律分组）/ 自带密钥 / 私有模型，按事项选定。
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
    },
  };
}

/** 模型端点配置（§10.2）：律师电脑只持有席位令牌 / 自带密钥；月之暗面密钥只在服务端。 */
export interface EndpointConfig {
  kind: "standard" | "byok" | "private";
  baseUrl: string | null;
  apiKey: string | null;
  /** 未配置时给人话提示。 */
  missingNote: string | null;
}

export function resolveEndpoint(kind: "standard" | "byok" | "private", e: BrokerEnv = process.env): EndpointConfig {
  if (kind === "standard") {
    const baseUrl = env(e, "ZR_MAAS_BASE") ?? null;
    const apiKey = env(e, "ZR_MAAS_TOKEN") ?? null;
    return {
      kind,
      baseUrl,
      apiKey,
      missingNote: "中软 MaaS 法律专用分组未配置（ZR_MAAS_BASE/ZR_MAAS_TOKEN）；签署与开通前标准端点只处理合成或公开材料",
    };
  }
  if (kind === "byok") {
    // 开发兼容：沿用 ZR_MOONSHOT_* 作为自带密钥（语义即律所直签月之暗面）
    const baseUrl = env(e, "ZR_BYOK_BASE", env(e, "ZR_MOONSHOT_BASE", "https://api.moonshot.cn"))!;
    const apiKey = env(e, "ZR_BYOK_API_KEY", env(e, "ZR_MOONSHOT_API_KEY")) ?? null;
    return { kind, baseUrl, apiKey, missingNote: "自带密钥未配置（ZR_BYOK_API_KEY）；律所须与月之暗面直签后填入" };
  }
  const baseUrl = env(e, "ZR_PRIVATE_BASE") ?? null;
  const apiKey = env(e, "ZR_PRIVATE_API_KEY") ?? null;
  return { kind, baseUrl, apiKey, missingNote: "律所内私有模型端点未配置（ZR_PRIVATE_BASE）；2027-Q4 私有化 v1 提供" };
}
