/**
 * 整单金额勾稽（第 57 批，D-229）：独立复核之前，内核对本任务最新版的 Word 文书与 Excel 表做一次确定性核对——
 * 写出来的算式逐条复算；文书里算出来的金额要能在最新计算表、材料或本文书成立的算式里找到出处。
 * 查出的不一致作为“必须改”并入复核意见交回修改；修改后由内核重跑同一项核对判断是否落实（不靠模型回看）。
 *
 * 为什么不交给复核模型（第 56 批取证）：复核模型看不到计算过程、不能调工具、推理强度低，规则又允许它把没算清的降为“建议复算”；
 * 十三张卡的金额错误一条也没被它拦下，而复核误判恰恰多出在计算、条号这些客观类上。算术是机器的事。
 */
import { readCreatedXlsx } from "@zr-legal/docx-engine";
import type { KernelDb } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import { LIVE_ARTIFACT } from "../services/attempt-supersede.ts";
import { blocksOfSections, blocksOfSheets, checkAmounts, type AmountDoc, type AmountIssue } from "../services/amount-check.ts";
import type { ReviewFinding } from "../services/independent-review.ts";
import { sectionsOfDocx } from "../tools/tools/edit-draft.ts";

/** 机器核对出的意见在“依据”一栏的固定写法：回看时据此区分由谁核对。 */
export const MACHINE_BASIS = "系统复算（确定性核对，不是模型判断）";
/** 一次并入复核意见的机器核对条数上限（复核意见总数上限 15 条）。 */
export const MACHINE_FINDINGS_MAX = 8;

/** 本任务最新版的文书与表格（每个文件名取最新一版；在律师原件上做的修订稿、系统生成的事实时间线不在此列）。 */
export function latestAmountDocs(deps: { db: KernelDb; blobs: BlobStore }, runId: string, matterId: string): AmountDoc[] {
  const rows = deps.db.all<{ filename: string; storage_uri: string; manifest: string | null; kind: string }>(
    `SELECT filename, storage_uri, manifest, kind FROM artifact_versions WHERE run_id = ? AND matter_id = ? AND kind IN ('agent_report','agent_table') AND ${LIVE_ARTIFACT} ORDER BY created_at, version`,
    [runId, matterId],
  );
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(r.filename, r);
  const docs: AmountDoc[] = [];
  for (const r of latest.values()) {
    const manifest = r.manifest ?? "";
    try {
      if (r.kind === "agent_report") {
        if (!/\.docx$/i.test(r.filename) || !/"tool"\s*:\s*"docx\.(?:render_report|edit_draft)"/.test(manifest)) continue;
        docs.push({ filename: r.filename, kind: "docx", ...blocksOfSections(sectionsOfDocx(deps.blobs.read(r.storage_uri)).sections) });
      } else {
        if (!/\.xlsx$/i.test(r.filename) || manifest.includes('"system_generated":true')) continue;
        const sheets = readCreatedXlsx(deps.blobs.read(r.storage_uri));
        if (sheets) docs.push({ filename: r.filename, kind: "xlsx", ...blocksOfSheets(sheets) });
      }
    } catch {
      // 读不出的文件不参与核对（文件本身的完整性另有检查）
    }
  }
  return docs;
}

/** 对本任务最新版成果做金额勾稽。sources 是可以作为数字出处的文字（材料、委托、律师的回答）。出错时返回空（不因核对本身的缺陷拦住交付）。 */
export function runAmountIssues(deps: { db: KernelDb; blobs: BlobStore }, runId: string, matterId: string, sources: readonly string[]): AmountIssue[] {
  try {
    const docs = latestAmountDocs(deps, runId, matterId);
    if (docs.length === 0) return [];
    return checkAmounts({ docs, sources: [...sources] }).issues;
  } catch {
    return [];
  }
}

/** 同一处不一致的标识：修改后重跑核对，这个标识还在就是没落实。 */
export function issueKey(i: AmountIssue): string {
  return i.kind === "equation" ? `eq|${i.filename ?? ""}|${i.text.replace(/\s+/g, "")}` : `orphan|${i.filename ?? ""}|${i.amount.toFixed(2)}`;
}

/**
 * 修改轮新引入的不一致（第 58 批，V31 企业催告函一单：修改轮把违约金基数原额改成 0，回看只核对上一轮报过的几条，没发现）：
 * 回看时在最新版上重跑核对，上一轮没有、这一轮出现的就是修改带进来的。纯函数；接到回看里由调用方决定按“必须改”交回还是列给律师。
 */
export function newIssuesSince(previousKeys: Iterable<string>, current: readonly AmountIssue[]): AmountIssue[] {
  const before = new Set(previousKeys);
  const seen = new Set<string>();
  return current.filter((i) => {
    const k = issueKey(i);
    if (before.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const money = (n: number): string => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * 机器核对结果写成复核意见（接在模型意见之后编号）。纯函数。
 * 算式两边不等是客观事实，一律“必须改”。金额找不到出处取决于出处集合全不全：材料都读出了文字时列“必须改”；
 * 有材料读不出文字（扫描件、图片）时出处集合不全，只列“建议复算”，不自动交回修改（orphanMust=false）。
 */
export function machineFindings(issues: readonly AmountIssue[], startNo: number, o: { orphanMust?: boolean } = {}): (ReviewFinding & { machine_key: string })[] {
  const orphanMust = o.orphanMust ?? true;
  // 必须改的排前面，超出上限时先留它们
  const ordered = [...issues].sort((a, b) => Number(b.kind === "equation") - Number(a.kind === "equation"));
  return ordered.slice(0, MACHINE_FINDINGS_MAX).map((i, k) => ({
    no: startNo + k,
    where: `《${i.filename ?? "交付件"}》${i.where}`,
    problem: i.kind === "equation" ? `算式“${i.text}”两边不等：左边算出来是 ${money(i.expected)}，写的是 ${money(i.actual)}` : `金额 ${money(i.amount)} 元（“${i.text}”）在本任务最新的计算表和材料里都找不到出处`,
    basis: MACHINE_BASIS,
    fix: i.fix,
    must: i.kind === "equation" || orphanMust,
    level: i.kind === "equation" || orphanMust ? ("must" as const) : ("recheck" as const),
    machine_key: issueKey(i),
  }));
}

export const isMachineFinding = (f: Pick<ReviewFinding, "basis">): boolean => f.basis === MACHINE_BASIS;
