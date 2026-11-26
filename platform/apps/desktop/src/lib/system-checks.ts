/**
 * 复核页右栏“系统已核对”（v9.2 §4.4；Y4 #18、§5 D-3）：由内核完整性单（review.completeness 的 completeness）得出逐项事实。
 * 只陈述结果；ok 为 true 打勾、false 标红并给出处理入口、null 只是说明（不打勾）。纯函数（第 71 批从 Review.tsx 抽出补用例）。
 *
 * 第 71 批两处口径：
 * - D1 材料读取：开始面板没勾材料（D-183：本事项的现行材料都可读，助手按需读取）时，按实际读过的份数 / 发起时本事项的现行材料份数写，
 *   此前把“没设边界”写成“已读 0/0 份”并打绿勾，与助手“3 份均已读取”相反；
 * - D2 引用核验：与下方“论断与依据”和签发门禁同一来源——成果文件自身的引用核验（artifact_citations）；此前只认运行中对材料的
 *   核验事件（只有合同审查默认路径才有），Agent 任务的成果明明列出 10 处已核引用，这一行却写“本成果没有引用核验记录”。
 */

/** fix：没通过的项可以直接去处理的地方（Astra M-2）。 */
export type Check = { label: string; ok: boolean | null; text: string; fix?: "materials" | "citations" | "version" };

const n = (v: unknown): number => Number(v ?? 0) || 0;
const quoted = (names: readonly string[]): string => names.map((x) => `《${x}》`).join("");

/** 材料读取一项。 */
export function materialsCheck(m: any): Check {
  const label = "材料读取";
  if (!m || typeof m !== "object") return { label, ok: null, text: "不是任务产出（无材料读取记录）" };
  if (m.on_demand) {
    if (!m.tracked) return { label, ok: null, text: "没有勾选材料：按需读取本事项的材料（这次任务没有逐份读取记录）" };
    const total = n(m.total);
    const read = n(m.read);
    if (total === 0) return { label, ok: null, text: "没有勾选材料，本事项也没有材料" };
    const unread: string[] = Array.isArray(m.unread_files) ? m.unread_files.map(String) : [];
    // 与勾了材料时同一种写法“已读 k/n 份”，括注说明没勾（第 71 批：开始面板、确认框、任务页、复核页同一口径）
    if (read >= total) return { label, ok: true, text: `已读 ${total}/${total} 份（没有勾选：本事项全部材料）` };
    const names = unread.length ? `，没读：${quoted(unread.slice(0, 3))}${total - read > 3 ? ` 等 ${total - read} 份` : ""}` : "";
    return { label, ok: null, text: `已读 ${read}/${total} 份（没有勾选：按需读取）${names}` };
  }
  if (m.requested === undefined) return { label, ok: null, text: "不是任务产出（无材料读取记录）" };
  const failed = n(m.failed);
  const ok = failed === 0 && n(m.loaded) === n(m.requested);
  return { label, ok, text: `已读 ${n(m.loaded)}/${n(m.requested)} 份${failed > 0 ? `，${failed} 份没有读到` : ""}`, ...(ok ? {} : { fix: "materials" as const }) };
}

/** 引用核验一项：先看成果文件自身的核验（与下方论断与依据、签发门禁同源），没有时退回运行中对材料的核验。 */
export function citationsCheck(ac: any, run: any): Check {
  const label = "引用核验";
  const runBad = run && run.total !== undefined ? n(run.intercepted) + n(run.unverified_offline) : 0;
  const runNote = runBad > 0 ? `；材料里另有${n(run.intercepted) > 0 ? ` ${n(run.intercepted)} 条被拦下` : ""}${n(run.unverified_offline) > 0 ? ` ${n(run.unverified_offline)} 条离线未能核实` : ""}` : "";
  if (ac && typeof ac === "object") {
    if (ac.checked === false) {
      return { label, ok: false, fix: "citations", text: `系统没有核对这份文件里的引用（${ac.unchecked_reason === "format" ? "格式不认识" : "读取出错"}），须人工核对${runNote}` };
    }
    const total = ac.total !== undefined ? n(ac.total) : Array.isArray(ac.items) ? ac.items.length : 0;
    if (total === 0) return { label, ok: runBad > 0 ? false : null, ...(runBad > 0 ? { fix: "citations" as const } : {}), text: `成果里没有法规或案号引用${runNote}` };
    const wrong = n(ac.wrong);
    const offline = n(ac.unverified_offline);
    const outside = n(ac.outside_registry);
    const timing = n(ac.timing);
    const pending = n(ac.support_pending);
    const verified = ac.verified !== undefined ? n(ac.verified) : Math.max(0, total - wrong - offline - outside);
    const bad = wrong + offline + outside + timing + runBad;
    const parts = [
      `共 ${total} 处，来源与版本已核 ${verified} 处`,
      wrong > 0 ? `${wrong} 处核对不通过` : "",
      offline > 0 ? `${offline} 个案号离线未能核实` : "",
      outside > 0 ? `${outside} 处不在本机法规库、须人工核对` : "",
      timing > 0 ? `${timing} 处须按事件时点或地域核对` : "",
    ].filter(Boolean);
    const support = pending > 0 ? `；支持性待你逐条确认 ${pending} 处` : "";
    return { label, ok: bad === 0, ...(bad === 0 ? {} : { fix: "citations" as const }), text: `${parts.join("，")}${support}${runNote}` };
  }
  if (run && run.total !== undefined) {
    return {
      label,
      ok: runBad === 0,
      ...(runBad === 0 ? {} : { fix: "citations" as const }),
      text: `共 ${n(run.total)} 条${n(run.intercepted) > 0 ? `，${n(run.intercepted)} 条被拦下` : ""}${n(run.unverified_offline) > 0 ? `，${n(run.unverified_offline)} 条离线未能核实` : ""}${run.as_of ? `（法规版本截至 ${run.as_of}）` : ""}`,
    };
  }
  return { label, ok: null, text: "本成果没有引用核验记录" };
}

/** 系统已核对的事实（来自内核完整性单；只陈述结果）。 */
export function systemChecks(c: any, latest: boolean): Check[] {
  const out: Check[] = [];
  out.push(materialsCheck(c.materials));
  out.push(citationsCheck(c.artifact_citations, c.citations));
  out.push({ label: "文件未被改动", ok: c.file_integrity === "ok", text: c.file_integrity === "ok" ? "与生成时一致" : "与生成时不一致，不能签发" });
  out.push({ label: "版本", ok: latest, text: latest ? "这是最新版本" : "已有更新版本，本版不能签发", ...(latest ? {} : { fix: "version" as const }) });
  out.push({ label: "受众", ok: null, text: c.audience_check });
  out.push({ label: "AI 辅助标识", ok: null, text: "文档属性中已标明 AI 辅助起草" });
  if (c.egress?.note) out.push({ label: "数据去向", ok: null, text: c.egress.note });
  return out;
}
