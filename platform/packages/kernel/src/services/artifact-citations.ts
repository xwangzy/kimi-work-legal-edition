/**
 * 成果文件的引用核验（第 13 批；评审 Z1 P0-5）：Agent 任务（研究备忘录、起诉状、律师函、审查意见等）产出的成果，
 * 签发前按成果文件自身的文字做一次离线核验——此前只有 S1 默认路径在运行中核验材料，A1 成果里的引用不受签发门禁约束。
 *
 * 判定（与 citations.verify 四态一致，生成器无权标“律师已确认”）：
 * - 定性错误（条号超出范围、已改号、适用时点无有效版本）→ 不得签发，须先改引；
 * - 案号（离线一律未核实；第 13 批复核 B13-U01：上诉状、代理词、类案备忘录离不开案号，联网补核尚未上线）→
 *   律师逐条核对后勾选“已逐条核对案号”才可签发，核对方式留痕进签发记录（D-98 扩展）；
 * - 本机法规库未收录的法源（unknown_source）→ 系统核对不了：律师勾选“已逐条人工核对”后才可签发——
 *   如实承认法规库覆盖有限，不把“没查到”说成“没问题”，也不让演示法规库把所有成果卡死；
 * - 系统读不出文字的成果（格式不认识、解析出错；复核 B13-U02、A-12）→ 不再静默放行：须勾选“这份文件的引用已人工核对”。
 * DOCX 核验正文以外的脚注、尾注、页眉页脚与批注（复核 A-12）。
 * 只读：不改成果、不写事件；签发时由调用方把结果计数写进设备签名的签发记录（signed_payload.citation_check，复核 A-12）。
 */
import { CitationState } from "@zr-legal/domain";
import { extractParagraphs, mapParagraphs, readZipText, xlsxToText } from "@zr-legal/docx-engine";
import { versionAt, type Lawdb } from "@zr-legal/lawdb";
import { eventDateRange, isProceduralLaw } from "./matter-facts.ts";
import { lawNameCandidates } from "../tools/tools/law-names.ts";
import { citationsVerify, extractCitations, unrecognizedArticleRefs, type CitationVerdict } from "../tools/tools/citations.ts";

export interface ArtifactCitationCheck {
  /** 能取到文字的成果才核验（xlsx、图片等为 false）；false 时须人工核对（不放行）。 */
  checked: boolean;
  /** checked=false 的原因：format（格式不认识）/ error（读取或解析出错）。 */
  unchecked_reason?: "format" | "error";
  total: number;
  /** 定性错误：条号不存在、已改号、无适用版本。 */
  wrong: number;
  /** 案号：离线未核实。 */
  unverified_offline: number;
  /** 本机法规库未收录的法源（须人工核对）。 */
  outside_registry: number;
  /** 已核到来源或版本的条数。 */
  verified: number;
  items: { raw: string; state: CitationVerdict["state"]; reason: string | null; kind: "wrong" | "case" | "outside" | "ok"; partial?: boolean; timing?: string }[];
  /**
   * 按事件时点与地域须律师核对的条数（v9.4 S-08）：事件发生时这部法尚未施行、当时适用的是另一版本、地方性法规的地域与事项不符。
   * 每条在 items[].timing 写一句话；只在事项填了事件时点或地域时才核。
   */
  timing?: number;
  event_date?: string | null;
  /** 核到了、但只核到条号（款项或“之X”没核）的条数（复核 R15B-05）。 */
  partial?: number;
  /** 写了“第X条”却没认出是哪部法的处数（复核 R15B-02；只提示、不拦签发）。 */
  unrecognized?: number;
  registry_coverage: string;
  as_of: string;
}

/** DOCX 正文以外也会写引用的部件（复核 A-12）。 */
const DOCX_EXTRA_PARTS = ["word/footnotes.xml", "word/endnotes.xml", "word/comments.xml", ...[1, 2, 3, 4, 5, 6].flatMap((n) => [`word/header${n}.xml`, `word/footer${n}.xml`])];

/** 成果文件 → 可见文字（docx 取正文与脚注、尾注、批注、页眉页脚的可见文字；md/txt/csv 直接按 UTF-8）；格式不认识为 "format"，读不出为 "error"。 */
export function artifactText(filename: string, bytes: Buffer): string | "format" | "error" {
  const name = filename.toLowerCase();
  try {
    if (name.endsWith(".docx")) {
      const parts = [extractParagraphs(bytes).map((p) => p.text).join("\n")];
      for (const part of DOCX_EXTRA_PARTS) {
        const xml = readZipText(bytes, part);
        if (xml) parts.push(mapParagraphs(xml).map((p) => p.text).join("\n"));
      }
      return parts.join("\n");
    }
    if (name.endsWith(".xlsx")) return xlsxToText(bytes).text;
    if (/\.(md|txt|csv|markdown)$/.test(name)) return bytes.toString("utf8");
  } catch {
    return "error";
  }
  return "format";
}

/**
 * 须律师人工核对、勾选后可签发的理由（复核 R15B-03、R15B-14）：法规库没收、款项与本机正文对不上（可能是正文排版）、
 * 适用时点没有有效版本（已废止的旧法按时间效力规定仍可正当引用）。条号超出总条数、已改号仍是定性错误。
 */
const MANUAL_REASONS = ["unknown_source:", "paragraph_out_of_range:", "item_out_of_range:", "no_applicable_version:"];

function classify(v: CitationVerdict): ArtifactCitationCheck["items"][number]["kind"] {
  if (v.state === CitationState.unverifiedOffline) return "case";
  if (v.state !== CitationState.intercepted) return "ok";
  // 错误优先（复核 A-13）：同一引用既有须人工核对的理由又有定性错误理由时按错误处理；没有理由也按错误（失败关闭）
  return v.reasons.length > 0 && v.reasons.every((r) => MANUAL_REASONS.some((p) => r.startsWith(p))) ? "outside" : "wrong";
}

/** 每条核对结果给律师看的一句话（复核 R15B-15：不出现条文编号、注册库、版本编号这类说法）。 */
export function reasonText(v: Pick<CitationVerdict, "reasons" | "state" | "suggestion">): string | null {
  const codes = v.reasons.map((r) => r.split(":")[0]);
  if (v.state === CitationState.unverifiedOffline) return "案号系统离线没法核对：请到裁判文书网等官方来源逐个核对";
  if (codes.includes("article_out_of_range")) return "条号超出这部法规的总条数";
  if (codes.includes("renumbered")) return v.suggestion ? `适用的版本里这一条已改号：${v.suggestion.replace(/（[^（）]*施行版本）/, "")}` : "适用的版本里这一条已改号";
  if (codes.includes("unknown_source")) return "本机法规库没有收录这部法规，系统没法核对";
  if (codes.includes("no_applicable_version")) return "适用时点没有有效版本（可能已废止或尚未施行），请人工核对适用依据";
  if (codes.includes("paragraph_out_of_range")) return "条号核到了，但本机法规库里这一条没有这么多款（也可能是正文排版），请人工核对";
  if (codes.includes("item_out_of_range")) return "条号核到了，但本机法规库里这一款没有这么多项（也可能是正文排版），请人工核对";
  if (codes.includes("subdivision_unchecked") || codes.includes("suffix_unchecked")) return "只核到条号，款项没有核对";
  return v.state === CitationState.intercepted ? "核对不通过" : null;
}

/**
 * 按事件时点与地域复核一条已核过的法条引用（v9.4 S-08）：返回须律师核对的一句话，没有问题返回 null。
 * - 程序法从新：民事诉讼法、仲裁法等不按事件时点核；
 * - 事件发生时还没施行（如 2019 年的合同纠纷引民法典）→ 须按时间效力规定核对能否适用；
 * - 事件时点适用的版本与现行版本不同 → 须核对引的是哪一版、条号与内容是否对得上；只到月且当月内版本有变化的如实说；
 * - 地方性法规的地域与事项地域不同 → 须核对是否适用。
 */
export function timingNote(lawdb: Pick<Lawdb, "findLawVersions">, law: string, article: number, asOf: string, eventDate: string | null, region: string | null): string | null {
  let rows = lawdb.findLawVersions(law);
  for (const name of lawNameCandidates(law)) {
    if (rows.length > 0) break;
    rows = lawdb.findLawVersions(name);
  }
  if (rows.length === 0) return null;
  const name = rows[0]!.law_name;
  const lawRegion = rows[0]!.law_region ?? "";
  if (region && lawRegion && lawRegion !== "全国" && !region.includes(lawRegion) && !lawRegion.includes(region)) {
    return `这是${lawRegion}的地方性规定，本事项地域是${region}：请核对是否适用`;
  }
  const range = eventDateRange(eventDate);
  if (!range || isProceduralLaw(name)) return null;
  const now = versionAt(rows, asOf);
  const atFrom = versionAt(rows, range.from);
  const atTo = versionAt(rows, range.to);
  const when = eventDate!;
  if (!atFrom && !atTo) {
    // 法规库可能没收早期版本：不说“还没有施行”，只说库里没有当时有效的版本
    const first = rows[0]!.effective;
    return first > range.to
      ? `本机法规库里这部法规最早的版本 ${first} 起施行，事件发生时（${when}）没有有效版本：请按时间效力规定核对当时适用的法律或版本`
      : `事件发生时（${when}）这部法规没有有效版本（可能已废止）：请核对适用依据`;
  }
  if (range.monthOnly && atFrom?.lsv_id !== atTo?.lsv_id) return `事件时点只到月（${when}），当月内这部法规的版本有变化：请按具体日期核对适用哪一版`;
  const at = atTo ?? atFrom!;
  if (now && at.lsv_id !== now.lsv_id) {
    if (article > at.total_articles) return `事件发生时（${when}）适用的是 ${at.effective} 施行的版本，那一版没有第 ${article} 条：请核对是否引了现行版本的条号`;
    return `事件发生时（${when}）适用的是 ${at.effective} 施行的版本，不是现行版本：请核对条号与内容是否按当时的版本引用`;
  }
  return null;
}

export function checkArtifactCitations(lawdb: Lawdb, filename: string, bytes: Buffer, asOf: string, matter: { event_date?: string | null; region?: string | null } = {}): ArtifactCitationCheck {
  const text = artifactText(filename, bytes);
  const base: ArtifactCitationCheck = { checked: false, total: 0, wrong: 0, unverified_offline: 0, outside_registry: 0, verified: 0, items: [], registry_coverage: lawdb.packageVersion, as_of: asOf };
  if (text === "format" || text === "error") return { ...base, unchecked_reason: text };
  const body = text.slice(0, 2_000_000);
  const r = citationsVerify(lawdb, { text: body, as_of: asOf });
  const eventDate = matter.event_date ?? null;
  const region = matter.region ?? null;
  const items = r.verdicts.map((v) => {
    const kind = classify(v);
    const partial = kind === "ok" && v.reasons.some((x) => x.startsWith("subdivision_unchecked:") || x.startsWith("suffix_unchecked:"));
    // 只复核系统核到了的法条（核对不通过的先改；库外的本来就要人工核）
    const timing = kind === "ok" && v.kind === "statute" && v.article !== null && (eventDate || region) ? timingNote(lawdb, v.law_input, v.article, asOf, eventDate, region) : null;
    return { raw: v.raw, state: v.state, reason: reasonText(v), kind, ...(partial ? { partial: true } : {}), ...(timing ? { timing } : {}) };
  });
  return {
    ...base,
    checked: true,
    total: items.length,
    wrong: items.filter((i) => i.kind === "wrong").length,
    unverified_offline: items.filter((i) => i.kind === "case").length,
    outside_registry: items.filter((i) => i.kind === "outside").length,
    verified: items.filter((i) => i.kind === "ok").length,
    partial: items.filter((i) => i.partial).length,
    timing: items.filter((i) => i.timing).length,
    event_date: eventDate,
    unrecognized: unrecognizedArticleRefs(body, extractCitations(body)),
    items: items.slice(0, 200),
    registry_coverage: r.registry_coverage,
  };
}

/** 复核清单里律师人工核对的勾选键（只认布尔 true；随签发记录的完整性单留痕）。 */
export const CITATIONS_MANUAL_CHECK_KEY = "citations_outside_registry_checked";
export const CITATIONS_CASES_CHECK_KEY = "citations_cases_checked";
export const CITATIONS_UNVERIFIABLE_CHECK_KEY = "citations_unverifiable_checked";
/** 按事件时点与地域须核对的引用（v9.4 S-08）。 */
export const CITATIONS_EVENT_TIME_CHECK_KEY = "citations_event_time_checked";

/** 系统读不出文字时的核验结果（复核 B13-U02：出错不放行）。 */
export function uncheckedCitations(reason: "format" | "error", registry: string, asOf: string): ArtifactCitationCheck {
  return { checked: false, unchecked_reason: reason, total: 0, wrong: 0, unverified_offline: 0, outside_registry: 0, verified: 0, items: [], registry_coverage: registry, as_of: asOf };
}

/** 签发门禁：返回阻止签发的理由（null = 可以签发）。 */
export function artifactCitationBlock(c: ArtifactCitationCheck, checklist: Record<string, unknown>): { code: "wrong" | "case" | "outside" | "unchecked" | "timing"; message: string } | null {
  if (!c.checked) {
    return checklist[CITATIONS_UNVERIFIABLE_CHECK_KEY] === true
      ? null
      : { code: "unchecked", message: "这份文件的引用系统没有核对（格式不认识或读取出错）：请人工核对后，在复核页勾选“这份文件的引用已人工核对”再签发" };
  }
  if (c.wrong > 0) return { code: "wrong", message: `成果里有 ${c.wrong} 条引用核对不通过（条号不存在、已改号或当时没有有效版本）：请先改正引用再签发` };
  if (c.unverified_offline > 0 && checklist[CITATIONS_CASES_CHECK_KEY] !== true) {
    return { code: "case", message: `成果里有 ${c.unverified_offline} 个案号系统离线无法核实：请逐个在裁判文书网等官方来源核对，在复核页勾选“已逐个核对案号”后再签发` };
  }
  if (c.outside_registry > 0 && checklist[CITATIONS_MANUAL_CHECK_KEY] !== true) {
    return { code: "outside", message: `成果里有 ${c.outside_registry} 条引用系统没法核对（不在本机法规库里，或款项、适用版本对不上）：请逐条人工核对，在复核页勾选“已逐条人工核对”后再签发` };
  }
  if ((c.timing ?? 0) > 0 && checklist[CITATIONS_EVENT_TIME_CHECK_KEY] !== true) {
    return { code: "timing", message: `成果里有 ${c.timing} 条引用要按事件时点或地域核对（事件发生时尚未施行、当时适用另一版本，或地方性规定的地域不符）：请逐条核对，在复核页勾选“已按事件时点和地域核对”后再签发` };
  }
  return null;
}
