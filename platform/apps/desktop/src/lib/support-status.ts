/**
 * 管理 → 技术支持 → 运行状态（第 56 批）：管理员来这页要知道“哪里坏了”。每行 = 状态点 + 名称 + 一句说明 + 状态词，有问题的给一句“怎么办”。
 * 状态一律来自真实数据：本机功能一览（kernel.capabilities 的 customer_rows 与 execution_domain）、联网程序状态（gate）、
 * “检测连接”的结果（connection.diagnose）。没检测过的写“尚未检测”（灰点），不写“未知”，更不写死“正常”。纯函数。
 */
import type { Capabilities, ConnectionDiagnosis } from "../api.ts";

export type CheckTone = "ok" | "warn" | "bad" | "idle";
export interface SupportCheck {
  key: string;
  name: string;
  desc: string;
  tone: CheckTone;
  state: string;
  /** 有问题时的“怎么办”一句话。 */
  fix?: string;
  /** 这一行会被“立即检测”刷新（检测中显示等待样式）。 */
  probed: boolean;
}

type Row = ConnectionDiagnosis["rows"][number];
const OK_CLASSES = new Set(["ok"]);

function customer(caps: Capabilities | null, re: RegExp): string | null {
  return caps?.customer_rows?.find((r) => re.test(r.feature))?.status ?? null;
}
/** customer_rows 的状态词 → 灰 / 绿 / 橙：“可用”绿；“未知”= 尚未检测；“本版本没有”灰；其余（不可用、未开通…）橙并原样写出。 */
function fromCustomer(status: string | null): { tone: CheckTone; state: string } | null {
  if (!status) return null;
  if (status === "可用") return { tone: "ok", state: "正常" };
  if (status === "未知") return { tone: "idle", state: "尚未检测" };
  if (/本版本没有/.test(status)) return { tone: "idle", state: "本版本没有" };
  return { tone: "warn", state: status };
}
function fromDiag(row: Row | undefined): { tone: CheckTone; state: string } | null {
  if (!row) return null;
  if (OK_CLASSES.has(row.class)) return { tone: "ok", state: "正常" };
  if (row.class === "not_configured") return { tone: "idle", state: "未开通" };
  return { tone: "bad", state: row.label || "连不上" };
}

const FIX_NET = "先确认这台电脑能上网；仍不行就点“导出诊断信息”发给客服，或把检测结果复制给所内 IT。";

export function supportChecks(o: { caps: Capabilities | null; gate: any; diag: ConnectionDiagnosis | null }): SupportCheck[] {
  const { caps, gate, diag } = o;
  const row = (u: string) => diag?.rows.find((r) => r.upstream === u);
  const out: SupportCheck[] = [];

  // 1. Kimi Work 服务连接：只认“检测连接”的真实结果
  const svcNames = diag ? diag.rows.filter((r) => r.class !== "not_configured").map((r) => r.name) : [];
  out.push({
    key: "service",
    name: "Kimi Work 服务连接",
    desc: diag ? (diag.tone === "ok" ? `${svcNames.join("、")}都能连上` : diag.conclusion) : "账号与授权、AI 服务、联网检索是否连得上",
    probed: true,
    ...(diag ? (diag.tone === "ok" ? { tone: "ok" as const, state: "正常" } : diag.tone === "warn" ? { tone: "warn" as const, state: "部分有问题", fix: FIX_NET } : { tone: "bad" as const, state: "连不上", fix: FIX_NET }) : { tone: "idle" as const, state: "尚未检测" }),
  });

  // 2. AI 起草、审查与问答：检测过就以 AI 服务的连通为准；否则看本机功能一览
  const ai = !gate ? { tone: "warn" as CheckTone, state: "未开通" } : (fromDiag(row("model")) ?? fromCustomer(customer(caps, /AI 起草/)) ?? { tone: "idle" as CheckTone, state: "尚未检测" });
  out.push({
    key: "ai",
    name: "AI 起草、审查与问答",
    desc: "发给 AI 的内容都有记录可查",
    probed: true,
    ...ai,
    ...(ai.tone === "bad" || ai.tone === "warn" ? { fix: !gate ? "这台电脑还没开通联网：请重新登录账号，或联系所内 IT。" : FIX_NET } : {}),
  });

  // 3. 表格计算环境：执行环境自检的结果（第一次运行任务时自检）
  const ed = caps?.execution_domain ?? null;
  const exec = !ed ? { tone: "idle" as CheckTone, state: "尚未检测" } : ed.available === true ? { tone: "ok" as CheckTone, state: "正常" } : ed.available === false ? { tone: "warn" as CheckTone, state: "不可用" } : { tone: "idle" as CheckTone, state: "尚未检测" };
  out.push({
    key: "exec",
    name: "表格计算环境",
    desc: ed?.available === null || !ed ? "第一次运行任务时自动检查；AI 写的计算在隔离环境里跑，不能联网" : "AI 写的计算（如金额表）在隔离环境里跑：不能联网，只见本事项材料",
    probed: false,
    ...exec,
    ...(exec.tone === "warn" ? { fix: "这台电脑不运行 AI 写的计算，起草、审查不受影响；请所内 IT 查看最下面的技术信息。" } : {}),
  });

  // 4. 联网检索：没接入 = 未开通；检测过以检索服务的连通为准
  const searchOn = !!gate?.routes?.search;
  const search = !gate || !searchOn ? { tone: "idle" as CheckTone, state: "未开通" } : (fromDiag(row("search")) ?? fromCustomer(customer(caps, /联网检索/)) ?? { tone: "idle" as CheckTone, state: "尚未检测" });
  out.push({ key: "search", name: "联网检索", desc: "查询前默认去掉当事人名称", probed: true, ...search, ...(search.tone === "bad" ? { fix: FIX_NET } : {}) });

  // 5. 打开网页
  const fetchOn = !!gate?.routes?.fetch;
  const fetch = !gate || !fetchOn ? { tone: "idle" as CheckTone, state: "未开通" } : (fromCustomer(customer(caps, /打开网页/)) ?? { tone: "ok" as CheckTone, state: "正常" });
  out.push({ key: "fetch", name: "打开网页", desc: "只限官方网站与本所允许的网站", probed: false, ...fetch, ...(fetch.tone === "warn" ? { fix: "请所内 IT 在“律所策略”里核对允许打开的网站。" } : {}) });

  // 6. 读写本事项材料
  const files = fromCustomer(customer(caps, /读写本事项/)) ?? { tone: "idle" as CheckTone, state: "尚未检测" };
  out.push({ key: "files", name: "读写本事项材料", desc: "原件只读；草稿可回到任一版", probed: false, ...files, ...(files.tone === "warn" ? { fix: "请重启 Kimi Work；仍不行请导出诊断信息发给客服。" } : {}) });

  // 7. 本版本没有的放最后一行，灰色
  out.push({ key: "computer_use", name: "操作网页与电脑", desc: "AI 不会替你点网页、操作电脑", probed: false, tone: "idle", state: "本版本没有" });
  return out;
}

/** 页首一句：几项正常、几项有问题、几项尚未检测（不含“本版本没有”）。 */
export function supportSummary(rows: readonly SupportCheck[]): string {
  const live = rows.filter((r) => r.state !== "本版本没有" && r.state !== "未开通");
  const bad = live.filter((r) => r.tone === "bad" || r.tone === "warn").length;
  const idle = live.filter((r) => r.tone === "idle").length;
  if (bad > 0) return `${bad} 项有问题`;
  if (idle > 0) return `${live.length - idle} 项正常，${idle} 项尚未检测`;
  return "全部正常";
}
