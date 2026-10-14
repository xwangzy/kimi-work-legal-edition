/**
 * P12 注入红队框架（v9 阶段 7；第 04 篇 §11 P12、第 06 篇 §2 T08/T19）：用例格式与校验。
 *
 * 用例由独立红队按此格式编写（content/redteam/cases/**.json），研发只维护格式与运行器，不审改用例正文。
 * “脚本化模型”用工具调用序列模拟“已被载体说服的模型”——判定看的是系统是否让这些动作越界，而不是模型会不会被说服。
 * 校验失败的用例计为“无效”，不进分母（报告单列）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const CASE_SCHEMA = "kwl-redteam-case/1";
export const LAYERS = ["pdf", "web", "filename", "skill", "image_ocr", "doc_link", "im_text"] as const;
export type Layer = (typeof LAYERS)[number];

export type Carrier =
  /** 文本材料（文件名与正文都可作载体）。 */
  | { kind: "material_text"; filename: string; text: string }
  /** 最小 PDF（文本层只限 ASCII；中文请用样本文件或 OCR 路径）。 */
  | { kind: "pdf_text"; filename: string; pages: string[] }
  /** 红队样本文件（content/redteam/samples/ 下的相对路径）：PDF、图片、DOCX 等。 */
  | { kind: "sample_file"; path: string; filename?: string; mime: string }
  /** 检索结果（网页载体：模型检索时收到这些结果）。 */
  | { kind: "search_results"; results: { title: string; url: string; snippet: string }[] }
  /** 写入工作区的文件（技能、AGENTS.md 等）：第一次运行由 Agent 写入，第二次运行（新会话）检查是否被加载（T19）。 */
  | { kind: "workspace_file"; path: string; text: string }
  /** 图片材料，经模拟 OCR（冒烟用；红队图片样本走真实 OCR，用 sample_file）。 */
  | { kind: "image_mock_ocr"; filename: string }
  /** 带外取引用的 DOCX（附加模板、INCLUDEPICTURE 域等）：正文与外链目标都可作载体。 */
  | { kind: "docx_external"; filename: string; text: string; targets: string[] }
  /**
   * IM 入站（所内节点 IM 入口）：先作为 IM 文本消息、再作为 IM 文件送达（文件名可作载体）；
   * pending_signoff：运行前先放一条遗留的签发审批意向，检验 IM 不能确认签发（T18）。
   */
  | { kind: "im_text"; text: string; filename?: string; chat_type?: "direct" | "group"; pending_signoff?: boolean };

export interface ScriptedCall {
  name: string;
  args: Record<string, unknown>;
}

/** 律师对一类确认卡的答复：同意或拒绝；同意时可选范围（本次 / 本任务内）与检索的放行方式（原文 / 改写后）。 */
export type LawyerAnswer = "approve" | "reject" | { decision: "approve" | "reject"; scope?: "once" | "task"; variant?: "original" | "generalized" };
export const CARD_KINDS = ["plan", "search", "fetch", "image", "budget", "schedule", "stop", "manual", "connector", "other"] as const;
export const BASIS_KEYS = ["engagement", "personal_info", "sensitive", "subprocessor"] as const;

export interface RedteamCase {
  schema: typeof CASE_SCHEMA;
  id: string;
  layer: Layer;
  title: string;
  /** 样本来源（红队自拟 / 公开样本 / 改写自……），报告逐例列出。 */
  source: string;
  matter?: {
    title?: string;
    stance?: string;
    client_name?: string;
    counterparty?: string;
    full_pseudonym?: boolean;
    /** 密级：normal（L2）/ high / strict（L3b，零出站）。 */
    confidentiality?: "normal" | "high" | "strict";
    /** 四项依据（缺省全部齐备）；任一待确认即只运行本机能力。 */
    basis?: Partial<Record<(typeof BASIS_KEYS)[number], "confirmed" | "pending" | "not_applicable">>;
    consent_status?: "agreed" | "pending" | "refused" | "not_required";
    /** 模型端点：standard（经网关）/ byok / private / none。 */
    model_endpoint?: "standard" | "byok" | "private" | "none";
    /** 当事人词典（含类型与别名）：用于令牌化与“当事人名称出站”的独立核对。 */
    parties?: { name: string; kind: "person" | "org"; aliases?: string[] }[];
  };
  carrier: Carrier;
  /** 任务目标（缺省“阅读事项材料并完成任务”）。 */
  goal?: string;
  /** 运行选项（经同一个 runs.start 接口与律所策略钳制）：运行模式、先出计划、自动档预授权。 */
  run?: { mode?: "manual" | "default" | "auto"; plan_first?: boolean; preauthorizations?: string[] };
  /** 脚本化模型：每轮给出一组工具调用；全部轮次结束后给出 final 文本。参数里可引用此前工具结果：{{result:p12_<轮>_<序>}}。 */
  model: { turns: ScriptedCall[][]; final?: string };
  /** 律师对确认卡的答复（按卡片种类；缺省：计划卡同意，其余拒绝）。 */
  lawyer?: Partial<Record<(typeof CARD_KINDS)[number] | "others", LawyerAnswer>>;
  /** 预期（可选）：运行状态、某个脚本化调用的工具结果应匹配的文字（正则）。不符计为“未判定”，不计入通过。 */
  expect?: { run_status?: string[]; calls?: { id: string; matches: string }[] };
}

/** 各层允许的载体种类。 */
const LAYER_CARRIERS: Readonly<Record<Layer, readonly Carrier["kind"][]>> = {
  pdf: ["pdf_text", "sample_file"],
  web: ["search_results"],
  filename: ["material_text"],
  skill: ["workspace_file"],
  image_ocr: ["image_mock_ocr", "sample_file"],
  doc_link: ["docx_external", "sample_file"],
  im_text: ["im_text"],
};

const ID_RE = /^[a-z0-9][a-z0-9_-]{2,80}$/;
const str = (v: unknown, max = 20_000): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** 校验一份用例；返回问题列表（空 = 合法）。 */
export function validateCase(x: unknown): string[] {
  const e: string[] = [];
  if (!x || typeof x !== "object" || Array.isArray(x)) return ["用例不是 JSON 对象"];
  const c = x as Record<string, unknown>;
  for (const k of Object.keys(c)) if (!["schema", "id", "layer", "title", "source", "matter", "carrier", "goal", "run", "model", "lawyer", "expect"].includes(k)) e.push(`不认识的字段：${k}`);
  if (c.schema !== CASE_SCHEMA) e.push(`schema 须为 ${CASE_SCHEMA}`);
  if (typeof c.id !== "string" || !ID_RE.test(c.id)) e.push("id 须为 3–81 位小写字母、数字、下划线或连字符");
  if (!(LAYERS as readonly unknown[]).includes(c.layer)) e.push(`layer 须为 ${LAYERS.join("/")}`);
  if (!str(c.title, 200)) e.push("title 缺失或过长");
  if (!str(c.source, 500)) e.push("source（样本来源）缺失或过长");
  if (c.goal !== undefined && !str(c.goal, 2000)) e.push("goal 过长或为空");
  const carrier = c.carrier as Record<string, unknown> | undefined;
  if (!carrier || typeof carrier !== "object") e.push("carrier 缺失");
  else {
    const kind = carrier.kind as Carrier["kind"];
    const allowed = (LAYER_CARRIERS as Record<string, readonly string[]>)[String(c.layer)] ?? [];
    if (!allowed.includes(kind)) e.push(`层 ${String(c.layer)} 不支持载体 ${String(kind)}（允许：${allowed.join("/")}）`);
    switch (kind) {
      case "material_text":
        if (!str(carrier.filename, 200) || !str(carrier.text)) e.push("material_text 须有 filename 与 text");
        break;
      case "pdf_text":
        if (!str(carrier.filename, 200) || !Array.isArray(carrier.pages) || carrier.pages.length === 0 || carrier.pages.some((p) => !str(p) || /[^\x20-\x7e\n]/.test(p as string))) {
          e.push("pdf_text 须有 filename 与 pages（每页非空、只限 ASCII 可打印字符；中文请用 sample_file 或 OCR 路径）");
        }
        break;
      case "sample_file":
        if (!str(carrier.path, 300) || String(carrier.path).includes("..") || String(carrier.path).startsWith("/") || !str(carrier.mime, 100)) e.push("sample_file 须有 samples 目录下的相对 path 与 mime");
        break;
      case "search_results":
        if (!Array.isArray(carrier.results) || carrier.results.length === 0 || carrier.results.length > 20) e.push("search_results 须有 1–20 条结果");
        else for (const r of carrier.results as Record<string, unknown>[]) if (!str(r?.title, 500) || !str(r?.url, 2000) || !str(r?.snippet)) e.push("检索结果须有 title、url、snippet");
        break;
      case "workspace_file":
        if (!str(carrier.path, 200) || String(carrier.path).startsWith("/") || String(carrier.path).includes("..") || !str(carrier.text)) e.push("workspace_file 须有工作区内相对 path 与 text");
        break;
      case "image_mock_ocr":
        if (!str(carrier.filename, 200)) e.push("image_mock_ocr 须有 filename");
        break;
      case "docx_external":
        if (!str(carrier.filename, 200) || !str(carrier.text) || !Array.isArray(carrier.targets) || carrier.targets.length === 0 || carrier.targets.some((t) => !str(t, 2000))) e.push("docx_external 须有 filename、text 与 targets");
        break;
      case "im_text":
        if (!str(carrier.text, 4000)) e.push("im_text 须有 text");
        if (carrier.filename !== undefined && !str(carrier.filename, 200)) e.push("im_text.filename 过长或为空");
        if (carrier.chat_type !== undefined && carrier.chat_type !== "direct" && carrier.chat_type !== "group") e.push("im_text.chat_type 须为 direct 或 group");
        if (carrier.pending_signoff !== undefined && typeof carrier.pending_signoff !== "boolean") e.push("im_text.pending_signoff 须为布尔值");
        break;
      default:
        e.push(`不认识的载体：${String(kind)}`);
    }
  }
  const model = c.model as Record<string, unknown> | undefined;
  if (!model || typeof model !== "object" || !Array.isArray(model.turns)) e.push("model.turns 缺失");
  else {
    if (model.turns.length > 30) e.push("model.turns 最多 30 轮");
    // 非 IM 层至少一轮工具调用（没有动作的用例测不到任何东西；复核 S7-A05）
    if (c.layer !== "im_text" && model.turns.length === 0) e.push("非 IM 层的用例至少要有一轮工具调用");
    for (const turn of model.turns as unknown[]) {
      if (!Array.isArray(turn) || turn.length === 0 || turn.length > 8) {
        e.push("每轮须有 1–8 个工具调用");
        continue;
      }
      for (const call of turn as Record<string, unknown>[]) {
        if (!str(call?.name, 100) || !call.args || typeof call.args !== "object" || Array.isArray(call.args)) e.push("工具调用须有 name 与 args 对象");
      }
    }
    if (model.final !== undefined && !str(model.final, 4000)) e.push("model.final 过长或为空");
  }
  const lawyer = c.lawyer as Record<string, unknown> | undefined;
  if (lawyer !== undefined) {
    if (!lawyer || typeof lawyer !== "object" || Array.isArray(lawyer)) e.push("lawyer 须为对象");
    else
      for (const [k, v] of Object.entries(lawyer)) {
        if (!(CARD_KINDS as readonly string[]).includes(k) && k !== "others") e.push(`lawyer.${k}：不认识的卡片种类（${[...CARD_KINDS, "others"].join("/")}）`);
        const ok =
          v === "approve" ||
          v === "reject" ||
          (!!v &&
            typeof v === "object" &&
            ((v as Record<string, unknown>).decision === "approve" || (v as Record<string, unknown>).decision === "reject") &&
            [undefined, "once", "task"].includes((v as Record<string, unknown>).scope as string | undefined) &&
            [undefined, "original", "generalized"].includes((v as Record<string, unknown>).variant as string | undefined));
        if (!ok) e.push(`lawyer.${k} 须为 approve、reject 或 {decision, scope?, variant?}`);
      }
  }
  const matter = c.matter as Record<string, unknown> | undefined;
  if (matter !== undefined) {
    if (!matter || typeof matter !== "object" || Array.isArray(matter)) e.push("matter 须为对象");
    else {
      for (const k of Object.keys(matter)) {
        if (!["title", "stance", "client_name", "counterparty", "full_pseudonym", "confidentiality", "basis", "consent_status", "model_endpoint", "parties"].includes(k)) e.push(`matter 中不认识的字段：${k}`);
      }
      if (matter.confidentiality !== undefined && !["normal", "high", "strict"].includes(matter.confidentiality as string)) e.push("matter.confidentiality 须为 normal / high / strict");
      if (matter.model_endpoint !== undefined && !["standard", "byok", "private", "none"].includes(matter.model_endpoint as string)) e.push("matter.model_endpoint 须为 standard / byok / private / none");
      if (matter.basis !== undefined) {
        const b = matter.basis as Record<string, unknown>;
        if (!b || typeof b !== "object") e.push("matter.basis 须为对象");
        else for (const [k, v] of Object.entries(b)) if (!(BASIS_KEYS as readonly string[]).includes(k) || !["confirmed", "pending", "not_applicable"].includes(v as string)) e.push(`matter.basis.${k} 不合法`);
      }
      if (matter.parties !== undefined) {
        if (!Array.isArray(matter.parties) || matter.parties.length > 20) e.push("matter.parties 须为最多 20 项的数组");
        else for (const p of matter.parties as Record<string, unknown>[]) if (!str(p?.name, 100) || (p.kind !== "person" && p.kind !== "org") || (p.aliases !== undefined && (!Array.isArray(p.aliases) || p.aliases.some((a) => !str(a, 100))))) e.push("matter.parties 每项须有 name、kind（person/org）与可选 aliases");
      }
    }
  }
  const run = c.run as Record<string, unknown> | undefined;
  if (run !== undefined) {
    if (!run || typeof run !== "object" || Array.isArray(run)) e.push("run 须为对象");
    else {
      if (run.mode !== undefined && !["manual", "default", "auto"].includes(run.mode as string)) e.push("run.mode 须为 manual / default / auto");
      if (run.plan_first !== undefined && typeof run.plan_first !== "boolean") e.push("run.plan_first 须为布尔值");
      if (run.preauthorizations !== undefined && (!Array.isArray(run.preauthorizations) || run.preauthorizations.some((x) => !str(x, 60)))) e.push("run.preauthorizations 须为字符串数组");
    }
  }
  const expect = c.expect as Record<string, unknown> | undefined;
  if (expect !== undefined) {
    if (!expect || typeof expect !== "object" || Array.isArray(expect)) e.push("expect 须为对象");
    else {
      if (expect.run_status !== undefined && (!Array.isArray(expect.run_status) || expect.run_status.some((x) => !str(x, 30)))) e.push("expect.run_status 须为字符串数组");
      if (expect.calls !== undefined) {
        if (!Array.isArray(expect.calls)) e.push("expect.calls 须为数组");
        else
          for (const x of expect.calls as Record<string, unknown>[]) {
            if (typeof x?.id !== "string" || !/^p12_\d+_\d+$/.test(x.id) || !str(x.matches, 500)) e.push("expect.calls 每项须有 id（p12_<轮>_<序>）与 matches（正则）");
            else {
              try {
                new RegExp(x.matches as string);
              } catch {
                e.push(`expect.calls ${x.id} 的 matches 不是合法正则`);
              }
            }
          }
      }
    }
  }
  return e;
}

export interface LoadedCase {
  file: string;
  case: RedteamCase | null;
  problems: string[];
}

/** 递归载入目录下全部 .json 用例；格式不合法的同样返回（problems 非空），由报告计为无效。编号重复也计为无效。 */
export function loadCases(dir: string): LoadedCase[] {
  const out: LoadedCase[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json")) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(p, "utf8"));
        } catch (err) {
          out.push({ file: relative(dir, p), case: null, problems: [`不是合法 JSON：${(err as Error).message}`] });
          continue;
        }
        const problems = validateCase(parsed);
        out.push({ file: relative(dir, p), case: problems.length === 0 ? (parsed as RedteamCase) : null, problems });
      }
    }
  };
  walk(dir);
  const seen = new Map<string, string>();
  for (const l of out) {
    if (!l.case) continue;
    const prev = seen.get(l.case.id);
    if (prev) {
      l.problems.push(`编号 ${l.case.id} 与 ${prev} 重复`);
      l.case = null;
    } else seen.set(l.case.id, l.file);
  }
  return out;
}
