/**
 * 跨交付件一致性核对（第 65 批，V39 研究 R2 第 5.2 节）：同一任务的几份最新成果之间，机器能确定比对的两类不一致。
 *
 * 起因：劳动仲裁答辩卡连续四次没通过验收（V35 m25-r4）。金额与答辩期全部复算无误，出问题的是“依据口径”——
 * 答辩书（二）以《员工手册（2021版）》为解除依据（“符合该条规定的解除条件”），证据目录证据 2 与提交前核对清单第 17 项
 * 却写它“不作为行为时直接适用的解除依据”。复核意见要求统一，修改轮只改了证据目录，答辩书与核对清单没改。
 * 金额一类已由 D-229 管住（amount-check.ts），这里补上金额以外能确定比对的两类：
 *
 *   X1 证据编号与名称（必须改）：
 *      ① 文书里“证据N《名称》”“证据N：名称”“（证据N：名称）”的名称，与证据目录里证据 N 对不上、却明确对得上目录里另一个编号的
 *         ——同一编号指向了不同证据；
 *      ② 同一任务里两份证据目录（如答辩书附的证据清单与证据目录表）是同一套编号，某个编号两边名称对不上的。
 *      名称近似（简称、目录名称包含正文简称、正文只写了其中几项）的不报：按两个字的片段计覆盖率，正文名称的片段有三成以上
 *      出现在目录名称里就算对得上；只有“对自己编号几乎不沾边、对另一个编号高度吻合”才报。
 *      不比：带当事人前缀的编号（“原告证据3”“上诉人一审证据3”“申请人提交的证据5”——那是另一方的编号体系）、
 *      编号区间与并列（“证据1至3”“证据1、证据2：”）、目录里没有又对不上任何条目的编号（可能是对方证据或补充证据）。
 *
 *   X5 依据角色冲突（须核，交修改轮与律师判断，不作必须改）：
 *      同一具名对象（书名号里的文件、制度、合同及其版本，如《员工手册（2021版）》，含“2021版手册”这类简称）
 *      在一份成果里作为依据或理由使用，在另一份成果里被明确写成“不作为依据 / 不以此为依据 / 不适用 / 不再主张”的，两处原句并列报出。
 *      机器能确定的是“同名对象 + 相反角色词”的句对，不能确定哪一边对（这是律师要拿主意的实体判断），所以只列须核。
 *      不报：
 *        - 正当的“主张 + 备位”：带“即使 / 即便 / 退一步 / 假设 / 如……不被采纳”的句子里的依据用法；
 *        - 同一文件内对同一范围两种角色都有的（该文件自己在作区分说明，或自相矛盾——后者留给模型复核）不作为依据一方；
 *        - 转述他方：“申请人主张 / 原告认为 / 解除通知援引 / 一审认定”句子里的依据用法；引号里的原话；
 *        - 只说“已废止 / 已失效”而没有明确“不作为依据”的（行为时有效的旧版常这样写）；“存在不能作为依据的风险”“能否作为依据待核实”这类风险提示与待核事项；
 *        - 针对某一条的否定（“该版第4.6条不适用”）与对另一条的依据用法——条号不同不算冲突；
 *          只否定其中部分条款、范围说不清的（“不以2021版信息安全条款为依据”“其余条款不作为依据”）不当作对整份文件的否定；
 *        - “不以工会程序事项为依据”这类否定说的是别的东西，不承前绑到上文提到的文件；
 *        - 法律、行政法规、司法解释（书名号里带“中华人民共和国”“最高人民法院”、以“法 / 条例 / 解释”结尾等）：
 *          法条引用集合不同是常态（研究 X6），这里只比书名号里的文件、制度、合同。
 *
 * 不做（研究 5.2 其余各类）：
 *   X2 证据↔请求项闭合：答辩一方“对应请求或答辩项”写的是对方请求的序号，文书本身的请求条数（答辩请求可能只有一条“驳回全部”）
 *      不等于对方请求条数；需要对方申请书的请求条数，纯成果比对会误报。
 *   X3 金额出处收窄、X4 届满日来源：要用到计算工具结果与材料，不是“成果之间”的比对，放在 amount-check / 期限核对里做。
 *   X6 法条引用集合、X7 状态口径：研究已判不做或留给模型复核。X8 修改轮漏改：由回看时重跑本核对（key 还在即没落实）实现。
 *
 * 纯函数，输入与金额勾稽相同（amount-check.ts 的 AmountDoc：每个文件最新一版的段落与表格行），宁可漏报不误报。
 */
import type { AmountDoc, AmountRow } from "./amount-check.ts";
import type { KernelDb } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import { latestAmountDocs, MACHINE_BASIS } from "../executor/amount-reconcile.ts";
import type { ReviewFinding } from "./independent-review.ts";

export interface CrossIssue {
  /** 同一处不一致的标识：修改后重跑核对，这个标识还在就是没落实。 */
  key: string;
  /** 要改的文件（X5 为作依据使用的一方）。 */
  filename: string;
  where: string;
  /** 原句（至多 160 字）。 */
  text: string;
  problem: string;
  fix: string;
  /** X1 为 true（必须改）；X5 为 false（须核，交修改轮与律师判断）。 */
  must: boolean;
}

// ───────────────────────── 公共 ─────────────────────────

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** “3”“３”“三”“十二”“二十一” → 数字；认不出返回 null。 */
function numOf(s: string): number | null {
  const t = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 48)).trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (!/^[零〇一二两三四五六七八九十百]+$/.test(t)) return null;
  let total = 0;
  let cur = 0;
  for (const c of t) {
    if (c === "百") {
      total += (cur || 1) * 100;
      cur = 0;
    } else if (c === "十") {
      total += (cur || 1) * 10;
      cur = 0;
    } else cur = CN_DIGIT[c] ?? 0;
  }
  return total + cur;
}

/** 引号里的原话不是本方的表态：替换成等长空白（位置不变），角色词与对象都不在其中认。 */
function maskQuotes(s: string): string {
  return s.replace(/“[^“”]{0,400}”|「[^「」]{0,400}」|『[^『』]{0,400}』/g, (m) => " ".repeat(m.length));
}

const clip = (s: string, n = 160): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** 文字单元：文书段落、表格里的一个文字格。rowKey 相同的格属于同一行。 */
interface Unit {
  filename: string;
  where: string;
  text: string;
  rowKey?: string;
  /** 行首两个文字格（行标签）。 */
  label?: boolean;
}

const cellText = (c: string | number | null | undefined): string => (typeof c === "string" ? c : "");

function unitsOf(doc: AmountDoc): Unit[] {
  const out: Unit[] = [];
  for (const p of doc.paragraphs ?? []) if (p.text.trim()) out.push({ filename: doc.filename, where: p.where, text: p.text });
  for (const r of doc.rows ?? []) {
    let textCells = 0;
    r.cells.forEach((c, ci) => {
      const t = cellText(c);
      if (!t.trim()) return;
      const col = cellText(r.columns?.[ci]).trim();
      out.push({ filename: doc.filename, where: `${r.where}${col ? `“${col}”列` : `第 ${ci + 1} 列`}`, text: t, rowKey: `${doc.filename}|${r.where}`, label: textCells++ < 2 });
    });
  }
  return out;
}

/** 按句切：句号、分号、问叹号、换行。返回每句在原文里的起点。 */
function sentences(s: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  let start = 0;
  for (let i = 0; i <= s.length; i++) {
    if (i === s.length || /[。；;！？!?\n]/.test(s[i]!)) {
      if (i > start) out.push({ start, text: s.slice(start, i) });
      start = i + 1;
    }
  }
  return out;
}

// ───────────────────────── X1 证据编号与名称 ─────────────────────────

/** 比名称用：去掉书名号、括号、标点与空白。 */
const normName = (s: string): string => s.replace(/[《》〈〉“”"'‘’（）()\[\]【】、，,；;：:。.\s·•\-—_／/]/g, "");

function bigrams(s: string): Set<string> {
  const t = normName(s);
  const out = new Set<string>();
  if (t.length === 1) out.add(t);
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** a 的两字片段有多少出现在 b 里（0～1）；b 包含 a 整体记 1。 */
function coverage(a: string, b: string): number {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (nb.includes(na)) return 1;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return ga.size === 0 ? 0 : hit / ga.size;
}
const similar = (a: string, b: string): number => Math.max(coverage(a, b), coverage(b, a));

/** 名称对得上的下限：正文名称的两字片段有三成出现在目录名称里。 */
const NAME_OK = 0.3;
/** 判“指向另一份证据”：对本编号几乎不沾边（低于此值）…… */
const NAME_OFF = 0.2;
/** ……且对另一个编号高度吻合（不低于此值），两者至少差这么多。 */
const NAME_HIT = 0.6;
const NAME_GAP = 0.4;

interface Catalog {
  filename: string;
  table: string;
  /** 编号 → { 名称, 位置 } */
  entries: Map<number, { name: string; where: string }>;
}

const tableOf = (where: string): string => where.replace(/\s*(?:表格)?第 \d+ 行$/, "");

/** 证据目录：表头有“证据名称”（或证据语境下的“名称”）与编号列（证据编号 / 编号 / 序号）。 */
function catalogsOf(doc: AmountDoc): Catalog[] {
  const byTable = new Map<string, AmountRow[]>();
  for (const r of doc.rows ?? []) {
    const t = tableOf(r.where);
    const list = byTable.get(t) ?? [];
    list.push(r);
    byTable.set(t, list);
  }
  const out: Catalog[] = [];
  for (const [table, rows] of byTable) {
    const headerOf = (cols: readonly (string | number | null)[] | undefined): { num: number; name: number } | null => {
      const h = (cols ?? []).map((c) => cellText(c).replace(/\s+/g, ""));
      const name = h.findIndex((c) => /^证据名称/.test(c) || (c === "名称" && /证据/.test(table)));
      if (name < 0) return null;
      let num = h.findIndex((c) => /^证据(?:编号|序号)$/.test(c));
      if (num < 0) num = h.findIndex((c) => /^(?:编号|序号)$/.test(c));
      return num < 0 ? null : { num, name };
    };
    // 表头一般是 columns；有标题行的表格，表头落在前几行的格里
    let hdr = headerOf(rows[0]?.columns);
    let from = 0;
    if (!hdr) {
      for (let i = 0; i < Math.min(3, rows.length) && !hdr; i++) {
        hdr = headerOf(rows[i]!.cells);
        from = i + 1;
      }
    }
    if (!hdr) continue;
    const entries = new Map<number, { name: string; where: string }>();
    const dup = new Set<number>();
    for (const r of rows.slice(from)) {
      const rawNo = r.cells[hdr.num];
      const name = cellText(r.cells[hdr.name]).trim();
      if (!name) continue;
      const m = typeof rawNo === "number" ? [String(rawNo), String(rawNo)] : /^\s*(?:[^\d一二三四五六七八九十]{0,6}?证据)?\s*([0-9０-９]{1,3}|[一二三四五六七八九十]{1,3})\s*$/.exec(cellText(rawNo));
      const n = m ? numOf(m[1]!) : null;
      if (n === null) continue;
      if (entries.has(n)) dup.add(n);
      entries.set(n, { name, where: r.where });
    }
    for (const n of dup) entries.delete(n); // 同一编号出现两次（分组编号等）的不比
    if (entries.size >= 2) out.push({ filename: doc.filename, table, entries });
  }
  return out;
}

/** 带当事人前缀的编号属于另一方的编号体系，不比。 */
const PARTY_PREFIX = /(?:原告|被告|申请人|被申请人|上诉人|被上诉人|对方|第三人|一审|二审|再审|反诉|答辩人|起诉人|我方|己方|本方|补充|新)\s*(?:提交|提供|出示)?(?:的)?\s*$/;
const EV_REF = /证据\s*([0-9０-９]{1,3}|[一二三四五六七八九十]{1,3})\s*([《：:（(“])/g;

/** 从“证据N”之后取证据名称。取不出返回空。 */
function refName(after: string, sep: string): string {
  let s = after;
  if (sep === "《" || /^\s*《/.test(s)) {
    const m = /^\s*《?([^《》]{1,60})》/.exec(sep === "《" ? `《${s}` : s);
    return m ? m[1]!.trim() : "";
  }
  if (sep === "“") {
    const m = /^([^“”]{1,60})”/.exec(s);
    return m ? m[1]!.trim() : "";
  }
  const stop = sep === "（" || sep === "(" ? /[）)；;。，,\n]/ : /[；;。，,）)\n]/;
  const k = s.search(stop);
  s = (k >= 0 ? s.slice(0, k) : s.slice(0, 60)).trim();
  // 名称后面跟的条号、页码、“相关条款”等不是名称
  s = s.replace(/第[^第]{0,12}[条款项页].*$/, "").replace(/(?:相关条款|复印件|原件|全文|节选)$/, "").trim();
  // “证据2：第3页”“证据2：3-5”是页码，不是名称（“2021版员工手册”这类以年份开头的名称照取）
  if (/^第/.test(s) || /^[0-9０-９]+(?:\s*[-－~～至]\s*[0-9０-９]+)?\s*(?:页|号)?$/.test(s)) return "";
  return s;
}

/** 诊断用：认出的证据目录与正文里的“证据N《名称》”，以及与目录本编号、最像的另一编号的吻合度（回放调阈值时看）。 */
export function explainEvidence(docs: readonly AmountDoc[]): { catalogs: { filename: string; table: string; size: number }[]; refs: { filename: string; where: string; n: number; name: string; own: number; best: number; bestNo: number | null }[] } {
  const cats = docs.flatMap(catalogsOf);
  const refs: { filename: string; where: string; n: number; name: string; own: number; best: number; bestNo: number | null }[] = [];
  for (const d of docs) {
    for (const u of unitsOf(d)) {
      for (const m of u.text.matchAll(EV_REF)) {
        const at = m.index!;
        const before = u.text.slice(Math.max(0, at - 10), at);
        if (PARTY_PREFIX.test(before) || /(?:证据\s*)?[0-9０-９一二三四五六七八九十]+\s*[、和及至到～~\-－]\s*$/.test(before)) continue;
        const n = numOf(m[1]!);
        const name = refName(u.text.slice(at + m[0].length), m[2]!);
        if (n === null || normName(name).length < 2) continue;
        const own = cats.reduce((sc, c) => Math.max(sc, c.entries.has(n) ? coverage(name, c.entries.get(n)!.name) : 0), 0);
        let best = 0;
        let bestNo: number | null = null;
        for (const c of cats) for (const [k, e] of c.entries) if (k !== n && coverage(name, e.name) > best) [best, bestNo] = [coverage(name, e.name), k];
        refs.push({ filename: u.filename, where: u.where, n, name, own, best, bestNo });
      }
    }
  }
  return { catalogs: cats.map((c) => ({ filename: c.filename, table: c.table, size: c.entries.size })), refs };
}

function evidenceIssues(docs: readonly AmountDoc[]): CrossIssue[] {
  const cats = docs.flatMap(catalogsOf);
  if (cats.length === 0) return [];
  const issues: CrossIssue[] = [];

  // ② 两份证据目录同一编号名称对不上：先判是不是同一套编号（共有编号里过半对得上），不是同一套的（如对方证据的质证表）不比
  for (let i = 0; i < cats.length; i++) {
    for (let j = i + 1; j < cats.length; j++) {
      const a = cats[i]!;
      const b = cats[j]!;
      const shared = [...a.entries.keys()].filter((n) => b.entries.has(n));
      if (shared.length < 2) continue;
      const agree = shared.filter((n) => similar(a.entries.get(n)!.name, b.entries.get(n)!.name) >= 0.5);
      if (agree.length < 2 || agree.length * 2 < shared.length) continue;
      for (const n of shared) {
        const ea = a.entries.get(n)!;
        const eb = b.entries.get(n)!;
        if (similar(ea.name, eb.name) >= NAME_OFF) continue;
        issues.push({
          key: `evcat|${a.filename}|${b.filename}|${n}`,
          filename: b.filename,
          where: eb.where,
          text: clip(`证据${n}：${eb.name}`),
          problem: `两份证据目录的证据${n}不是同一份证据：《${a.filename}》${ea.where}写“${clip(ea.name, 60)}”，《${b.filename}》${eb.where}写“${clip(eb.name, 60)}”`,
          fix: `核对证据编号，两份目录的证据${n}改成同一份证据（同时检查正文里引用证据${n}的地方）`,
          must: true,
        });
      }
    }
  }

  // ① 正文与表格里的“证据N《名称》”：对本编号几乎不沾边、对目录里另一个编号高度吻合的报出
  const lookup = (n: number): { name: string; cat: Catalog; where: string }[] =>
    cats.flatMap((c) => {
      const e = c.entries.get(n);
      return e ? [{ name: e.name, cat: c, where: e.where }] : [];
    });
  const seen = new Set<string>();
  for (const d of docs) {
    for (const u of unitsOf(d)) {
      for (const m of u.text.matchAll(EV_REF)) {
        const at = m.index!;
        const before = u.text.slice(Math.max(0, at - 10), at);
        if (PARTY_PREFIX.test(before)) continue;
        // 编号区间与并列（“证据1至3”“证据1、证据2：”）：名称对应不到单个编号
        if (/(?:证据\s*)?[0-9０-９一二三四五六七八九十]+\s*[、和及至到～~\-－]\s*$/.test(before)) continue;
        const n = numOf(m[1]!);
        if (n === null) continue;
        const name = refName(u.text.slice(at + m[0].length), m[2]!);
        if (normName(name).length < 2) continue;
        const own = lookup(n);
        const ownScore = own.reduce((s, e) => Math.max(s, coverage(name, e.name)), 0);
        if (ownScore >= NAME_OFF) continue;
        let best: { n: number; name: string; score: number } | null = null;
        for (const c of cats) {
          for (const [k, e] of c.entries) {
            if (k === n) continue;
            const sc = coverage(name, e.name);
            if (!best || sc > best.score) best = { n: k, name: e.name, score: sc };
          }
        }
        if (!best || best.score < NAME_HIT || best.score - ownScore < NAME_GAP) continue;
        const key = `evref|${u.filename}|${n}|${normName(name)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sent = sentences(u.text).find((s) => s.start <= at && at < s.start + s.text.length + 1)?.text ?? u.text;
        const ownDesc = own.length > 0 ? `证据目录里证据${n}是“${clip(own[0]!.name, 50)}”` : `证据目录里没有证据${n}`;
        issues.push({
          key,
          filename: u.filename,
          where: u.where,
          text: clip(sent),
          problem: `写的是“证据${n}：${clip(name, 40)}”，但${ownDesc}；这个名称在证据目录里是证据${best.n}（“${clip(best.name, 50)}”）`,
          fix: `把这里的编号改成证据${best.n}，或核对证据目录的编号后两边统一`,
          must: true,
        });
      }
    }
  }
  return issues;
}

// ───────────────────────── X5 依据角色冲突 ─────────────────────────
/** 要一起递交或发出的文书（文书正文与随附的证据目录）：两边都在其中时口径冲突作必须改。 */
const FILED_DOC = /答辩|起诉状|反诉状|申请书|上诉状|代理词|律师函|催告函|证据目录|证据清单/;
/** 给律师的内部件（文件名里常带案件名“……答辩”）：不算递交文书。 */
const INTERNAL_DOC = /核对|说明|备忘|分析|底稿|对照|要点|提纲|评估|测算|意见书（内部|内部稿/;
const isFiled = (name: string): boolean => FILED_DOC.test(name) && !INTERNAL_DOC.test(name);

/** 法律、行政法规、司法解释、部门规章：只比书名号里的文件、制度、合同，这些不比。 */
const LAW_LIKE = /中华人民共和国|最高人民|国务院|人民法院|人民检察院|委员会|司法解释|部关于|^关于.{2,}(?:解释|规定|意见|通知|批复|决定|办法)|暂行|实施办法|实施细则|实施条例|(?:法|法典|条例|解释|批复|纪要|决定)$|(?:时效|借贷|证据|担保|执行|保全|管辖|诉讼|审判|仲裁|跨境|出境|个人信息|数据|网络)[^《》]{0,8}(?:规定|办法)$/;
/** 文件名里的版本：“（2021版）”“（2021年修订）”“2021版”。 */
const VER_TAIL = /\s*[（(]\s*(\d{4})\s*年?\s*(?:版|修订版?|修订稿|修正版?)\s*[）)]\s*$/;
const VER_HEAD = /^\s*(\d{4})\s*年?\s*版\s*/;
const VER_AFTER = /^\s*[（(]\s*(\d{4})\s*年?\s*(?:版|修订版?|修订稿|修正版?)\s*[）)]/;
const VER_BEFORE = /(\d{4})\s*年?\s*版\s*$/;
/** 版本号后面跟着这些名词而又不是本对象名称的结尾，说的是别的文件。 */
const OTHER_DOC_NOUN = /^(?:合同|协议|章程|办法|制度|规定|细则|标准|条例|规则|方案|通知|版本|报告|清单|目录|模板|范本)/;
/**
 * 带版本的对象按“名词尾 + 版本年”认同一：《员工手册（2021版）》、员工手册（2021版）、2021版手册、2021版员工手册是同一份。
 * （同一任务里两份不同的“××手册”恰好同一年版的极少，宁可合并。）
 */
const DOC_NOUN = "手册|制度|规定|办法|细则|规则|合同|协议|章程|守则|规范|须知|方案|规章";
const NOUN_TAIL = new RegExp(`(?:${DOC_NOUN})$`);
const nounOf = (base: string): string => NOUN_TAIL.exec(base)?.[0] ?? base;
const keyOf = (base: string, year: string): string => (year ? `${nounOf(base)}@${year}` : `${base}@`);
/** 不带书名号的版本写法：“员工手册（2021版）”。 */
const UNQUOTED_TAIL = new RegExp(`([\\u4e00-\\u9fa5]{0,2}(?:${DOC_NOUN}))\\s*[（(]\\s*(\\d{4})\\s*年?\\s*(?:版|修订版?)\\s*[）)]`, "g");
/** 不带书名号的版本写法：“2021版手册”“2021版员工手册”（“2021版规定，……”里的“规定”是动词，不认）。 */
const UNQUOTED_HEAD = new RegExp(`(?<![0-9])(\\d{4})\\s*年?\\s*(?:版|修订版)\\s*《?([\\u4e00-\\u9fa5]{0,2}?(?:${DOC_NOUN.replace("规定|", "")}))`, "g");

interface Obj {
  key: string;
  base: string;
  year: string;
  label: string;
}
interface Mention {
  obj: Obj;
  /** 条号（“第5.3条第5项”），没有为 null，指代“该条”又找不到条号的为 UNKNOWN。 */
  art: string | null;
  start: number;
  end: number;
}
const UNKNOWN = "?";
/** 对象后面紧跟着限定到部分条款的说法。 */
const QUALIFIED = /^\s*》?\s*[^，。；、,;：:]{0,16}?(?:条款|相关规定|有关规定|的规定)/;

function parseTitle(inner: string): { base: string; year: string } {
  let base = inner.trim();
  let year = "";
  const t = VER_TAIL.exec(base);
  if (t) {
    year = t[1]!;
    base = base.slice(0, t.index).trim();
  } else {
    const h = VER_HEAD.exec(base);
    if (h) {
      year = h[1]!;
      base = base.slice(h[0].length).trim();
    }
  }
  return { base, year };
}

/** 书名号全称连同前后的版本写法（“《员工手册》（2021版）”“2021版《员工手册》”）。 */
function titlesIn(s: string): { base: string; year: string; start: number; end: number }[] {
  const out: { base: string; year: string; start: number; end: number }[] = [];
  for (const m of s.matchAll(/《([^《》\n]{1,60})》/g)) {
    const t = parseTitle(m[1]!);
    let start = m.index!;
    let end = start + m[0].length;
    if (!t.year) {
      const a = VER_AFTER.exec(s.slice(end));
      const b = VER_BEFORE.exec(s.slice(Math.max(0, start - 8), start));
      if (a) {
        t.year = a[1]!;
        end += a[0].length;
      } else if (b) {
        t.year = b[1]!;
        start -= b[0].length;
      }
    }
    out.push({ ...t, start, end });
  }
  return out;
}

/** 全任务的具名对象：书名号里的文件（去掉法律类），以及不带书名号的版本写法；带版本的按版本分开。 */
function objectsOf(units: readonly Unit[]): Map<string, Obj> {
  const objs = new Map<string, Obj>();
  const add = (base: string, year: string, titled: boolean): void => {
    const key = keyOf(base, year);
    const label = titled ? (year ? `《${base}（${year}版）》` : `《${base}》`) : `${base}（${year}版）`;
    const cur = objs.get(key);
    if (!cur) objs.set(key, { key, base, year, label });
    else if (titled && !cur.label.startsWith("《")) cur.label = label; // 有书名号全称的用全称
  };
  for (const u of units) {
    const s = maskQuotes(u.text);
    for (const t of titlesIn(s)) if (normName(t.base).length >= 2 && !LAW_LIKE.test(t.base)) add(t.base, t.year, true);
    for (const m of s.matchAll(UNQUOTED_TAIL)) add(m[1]!, m[2]!, false);
    for (const m of s.matchAll(UNQUOTED_HEAD)) add(m[2]!, m[1]!, false);
  }
  return objs;
}

const ART_RE = /^\s*》?\s*(?:的)?\s*第\s*([0-9０-９.．一二三四五六七八九十百零〇]+)\s*条(?:\s*第\s*[（(]?\s*([0-9０-９一二三四五六七八九十]+)\s*[）)]?\s*[项款])?/;
function articleAt(s: string, from: number): { art: string; len: number } | null {
  const m = ART_RE.exec(s.slice(from));
  if (!m) return null;
  const main = /^[0-9０-９.．]+$/.test(m[1]!) ? m[1]!.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 48)).replace("．", ".") : String(numOf(m[1]!) ?? m[1]);
  const item = m[2] ? `第${numOf(m[2]) ?? m[2]}项` : "";
  return { art: `第${main}条${item}`, len: m[0].length };
}

/** 一段文字里提到的对象（含“2021版手册”这类简称），按出现先后。 */
function mentionsIn(s: string, objs: ReadonlyMap<string, Obj>, versionedNouns: ReadonlySet<string>, yearOwner: ReadonlyMap<string, Obj | null>): Mention[] {
  const out: Mention[] = [];
  const taken: [number, number][] = [];
  const overlaps = (a: number, b: number): boolean => taken.some(([x, y]) => a < y && x < b);
  const push = (obj: Obj | undefined, start: number, end: number): void => {
    if (!obj || overlaps(start, end)) return;
    const a = articleAt(s, end);
    // “2021版信息安全条款”“《员工手册（2023版）》中当年未休视为自动放弃的条款”：说的是其中某些条款，范围不确定
    const art = a ? a.art : QUALIFIED.test(s.slice(end)) ? UNKNOWN : null;
    out.push({ obj, art, start, end: a ? end + a.len : end });
    taken.push([start, end]);
  };
  for (const t of titlesIn(s)) {
    // 法律类、以及不带版本而本任务里这类文件有多个版本的（指哪一版不确定）：占住位置但不认
    if (LAW_LIKE.test(t.base) || (!t.year && versionedNouns.has(nounOf(t.base)))) {
      taken.push([t.start, t.end]);
      continue;
    }
    const obj = objs.get(keyOf(t.base, t.year));
    if (obj) push(obj, t.start, t.end);
    else taken.push([t.start, t.end]);
  }
  for (const m of s.matchAll(UNQUOTED_TAIL)) push(objs.get(keyOf(m[1]!, m[2]!)), m.index!, m.index! + m[0].length);
  for (const m of s.matchAll(UNQUOTED_HEAD)) push(objs.get(keyOf(m[2]!, m[1]!)), m.index!, m.index! + m[0].length);
  // 版本号在本任务里只属于一个文件时，“2021版”单独也认（后面跟着别的文件名词的除外）
  for (const m of s.matchAll(/(?<![0-9])(\d{4})\s*年?\s*(?:版|修订版)/g)) {
    const owner = yearOwner.get(m[1]!);
    if (!owner || OTHER_DOC_NOUN.test(s.slice(m.index! + m[0].length))) continue;
    push(owner, m.index!, m.index! + m[0].length);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 指代：“该条”要找带条号的上一次提及；“该版手册”“上述规定”取上一次提及的对象。 */
const ANAPHORA = /该条款|该条|该款|该项|上述条款|前述条款|该版|该手册|该制度|该规定|该协议|该合同|该文件|上述规定|前述规定/g;

/** 明确不作依据（否定角色）。embed 表示对象写在这个短语中间（“不以《X》为依据”）。clause 表示只在同一逗号分句里找对象。 */
const NEG_PATTERNS: { re: RegExp; embed?: boolean; clause?: boolean }[] = [
  // “不以此为依据”“不以该版为依据”才承前；“不以工会程序事项为依据”说的是别的事，不承前
  { re: /不(?:以|把|将)([^。；，]{0,40}?)(?:为|作为|作)[^。；，]{0,10}依据/g, embed: true },
  { re: /(?:不作为|不作|不能作为|不应作为|不宜作为|不得作为|不再作为|并非|不是|不构成)[^。；，]{0,16}依据/g },
  { re: /不再适用|不予适用|不适用|不再援引|不予援引|不再主张/g, clause: true },
];
/** 作为依据使用（肯定角色）。 */
const POS_PATTERNS: { re: RegExp; embed?: boolean; after?: boolean; fallback?: boolean }[] = [
  { re: /以([^。；]{0,40}?)为(?:主要|直接|解除)?依据/g, embed: true },
  { re: /符合[^。；，]{0,14}(?:解除条件|解除情形|处分条件|违纪情形|情形|条件)/g, embed: true, fallback: true },
  { re: /主依据|主要依据/g, after: true },
  { re: /(?:作为|作|为)[^。；，]{0,12}依据/g },
];
/** 介词式依据：“依据《X》”“根据2021版手册第5.3条”。 */
const POS_PREFIX = /(?:依据|根据|按照|依照|基于|适用)(?:的是)?\s*$/;
/** 分句里肯定词之前出现这些否定，整句是否定（“不把2023版作为无争议直接依据”）。 */
const CLAUSE_NEG = /不(?:以|把|将|宜|应|能|得|再|作|是|予)|并非/;
/** 本句写了别的版本或书名号文件：没写对象的否定句不承上句、不按行推定。 */
const OTHER_REF = /《|\d{4}\s*年?\s*(?:版|修订)/;
const NEG_LEAD = /(?:不|非|并非|未|无|不能|不应|不得|不宜|不再)\s*$/;
/** 主张 + 备位、假设：其中的依据用法是正当的备位，不报。 */
const BACKUP = /即使|即便|纵使|纵然|退一步|退而言之|退而求其次|假设|假定|即令|就算|倘若|备位|补充主张|如[^。；]{0,30}(?:不被采纳|未被采纳|不予采纳|不予支持|不予认可|认定|认为)|若[^。；]{0,30}(?:不被采纳|认定|认为)/;
/** 转述他方或原文：申请人主张、通知援引、一审认定。 */
const ATTRIB = /(?:申请人|原告|被告|上诉人|被上诉人|对方|第三人)(?:一方)?(?:主张|认为|称|提出|援引|引用|所援引|所依据)|通知(?:书)?(?:中|所|载明|写明|援引|依据|载|记载)|一审(?:法院)?(?:认定|认为)|原审|原判|仲裁委(?:员会)?认为|法院认为/;
/**
 * 对方作为行为主体援用文件的句子（按文书一方定称谓）：申请书、起诉状、上诉状里对方是被申请人、被告、被上诉人，我方是申请人、原告、上诉人；
 * 答辩书、答辩状里相反（我方也常自称答辩人）。对方称谓到“以 / 依据 / 根据 / 援引 / 按照”之间出现我方称谓的，是我方在用，不算叙述对方。
 */
function counterpartNarrates(filename: string, text: string): boolean {
  const defense = /答辩/.test(filename);
  const filing = !defense && /申请书|起诉状|反诉状|上诉状/.test(filename);
  if (!defense && !filing) return false;
  const counter = defense ? /(?<!被)申请人|原告|(?<!被)上诉人/g : /被申请人|被告|被上诉人/g;
  const self = defense ? /答辩人|被申请人|被告|被上诉人|我方|本公司|公司/ : /(?<!被)申请人|原告|(?<!被)上诉人|我方|本人/;
  for (const m of text.matchAll(counter)) {
    const rest = text.slice(m.index! + m[0].length, m.index! + m[0].length + 80);
    const v = /以|依据|根据|援引|按照/.exec(rest);
    if (!v) continue;
    const gap = rest.slice(0, v.index);
    if (/[。；“”]/.test(gap) || self.test(gap)) continue;
    return true;
  }
  return false;
}
/** 风险提示、推测、待核：不是表态。 */
const HEDGE = /风险|可能|或许|是否|能否|可否|存疑|待核|核实|待定|如果|若/;
/** “根据《X》可知 / 显示 / 载明”：把文件当证据看，不是当依据用。 */
const AS_EVIDENCE = /^[^。；，]{0,30}(?:可知|显示|载明|记载|可见|所示|签收)/;

interface Role {
  obj: Obj;
  art: string | null;
  sign: 1 | -1;
  filename: string;
  where: string;
  sentence: string;
}

function rolesOf(units: readonly Unit[], objs: readonly Obj[]): Role[] {
  const byKey = new Map(objs.map((o) => [o.key, o] as const));
  const versionedNouns = new Set(objs.filter((o) => o.year).map((o) => nounOf(o.base)));
  const yearOwner = new Map<string, Obj | null>();
  for (const o of objs) if (o.year) yearOwner.set(o.year, yearOwner.has(o.year) && yearOwner.get(o.year) !== o ? null : o);

  // 行内只提到一个对象时，格里没写对象的“不作为依据”就是说它（证据目录“证据名称”列写对象、“证明目的”列写角色）
  const rowObjs = new Map<string, Set<Obj>>();
  const unitMentions = units.map((u) => {
    const masked = maskQuotes(u.text);
    const ms = mentionsIn(masked, byKey, versionedNouns, yearOwner);
    if (u.rowKey && u.label) {
      const set = rowObjs.get(u.rowKey) ?? new Set<Obj>();
      for (const m of ms) set.add(m.obj);
      rowObjs.set(u.rowKey, set);
    }
    return { masked, ms };
  });

  const roles: Role[] = [];
  const rowLast = new Map<string, Mention>();
  units.forEach((u, ui) => {
    const { masked, ms } = unitMentions[ui]!;
    // 先把指代落成提及
    let lastAny: Mention | null = u.rowKey ? rowLast.get(u.rowKey) ?? null : null;
    let lastArt: Mention | null = lastAny && lastAny.art && lastAny.art !== UNKNOWN ? lastAny : null;
    const all: Mention[] = [];
    const events = [...ms.map((m) => ({ at: m.start, m })), ...[...masked.matchAll(ANAPHORA)].map((a) => ({ at: a.index!, a }))].sort((x, y) => x.at - y.at);
    for (const ev of events) {
      if ("m" in ev && ev.m) {
        all.push(ev.m);
        lastAny = ev.m;
        if (ev.m.art) lastArt = ev.m;
        continue;
      }
      const a = (ev as { a: RegExpMatchArray }).a;
      if (ms.some((m) => a.index! >= m.start && a.index! < m.end)) continue;
      const word = a[0];
      const wantsArt = /条|款|项/.test(word) && !/^(?:上述规定|前述规定)$/.test(word);
      const src = wantsArt ? lastArt ?? lastAny : lastAny;
      if (!src) continue;
      const art = wantsArt ? (src.art && src.art !== UNKNOWN ? src.art : UNKNOWN) : word === "该版" || /手册|制度|协议|合同|文件/.test(word) ? null : src.art;
      // “该版手册第5.3条”：指代后面直接写了条号的，用这一条
      const own = articleAt(masked, a.index! + word.length);
      const m: Mention = { obj: src.obj, art: own ? own.art : art, start: a.index!, end: a.index! + word.length + (own ? own.len : 0) };
      all.push(m);
      lastAny = m;
      if (own) lastArt = m;
    }
    all.sort((x, y) => x.start - y.start);
    if (u.rowKey && lastAny) rowLast.set(u.rowKey, lastAny);
    if (all.length === 0 && !(u.rowKey && (rowObjs.get(u.rowKey)?.size ?? 0) === 1)) return;

    const sents = sentences(masked);
    sents.forEach((sen, si) => {
      const sEnd = sen.start + sen.text.length;
      const inSent = all.filter((m) => m.start >= sen.start && m.start < sEnd);
      const orig = u.text.slice(sen.start, sEnd);
      const clauseOf = (pos: number): [number, number] => {
        let a = pos;
        while (a > sen.start && !/[，,：:]/.test(masked[a - 1]!)) a--;
        let b = pos;
        while (b < sEnd && !/[，,]/.test(masked[b]!)) b++;
        return [a, b];
      };
      const negSpans: [number, number][] = [];
      const add = (m: Mention, sign: 1 | -1): void => {
        if (sign === -1 && m.art === UNKNOWN) return; // 否定的是“该条”而找不到哪一条：不知道否定范围，不认
        roles.push({ obj: m.obj, art: m.art === UNKNOWN ? null : m.art, sign, filename: u.filename, where: u.where, sentence: orig });
      };
      // 否定角色
      if (!HEDGE.test(sen.text)) {
        for (const p of NEG_PATTERNS) {
          for (const mm of sen.text.matchAll(p.re)) {
            const at = sen.start + mm.index!;
            const end = at + mm[0].length;
            negSpans.push([at, end]);
            let bound: Mention[] = [];
            if (p.embed) bound = inSent.filter((m) => m.start >= at && m.start < end);
            if (bound.length === 0 && p.embed && !/^\s*(?:此|其|之|该[^，。；]{0,3}|上述[^，。；]{0,4}|前述[^，。；]{0,4})?\s*$/.test(mm[1] ?? "")) continue;
            if (bound.length === 0) {
              const [ca] = clauseOf(at);
              const before = inSent.filter((m) => m.end <= at + 1 && (!p.clause || m.start >= ca));
              if (before.length > 0) bound = [before[before.length - 1]!];
            }
            if (bound.length === 0 && !p.clause && !p.embed && inSent.length === 0 && !OTHER_REF.test(sen.text)) {
              // 本句没写对象：承上一句的最后一次提及；表格行里只有一个对象时就是它
              const prev = si > 0 ? all.filter((m) => m.start < sen.start && m.start >= sents[si - 1]!.start) : [];
              if (prev.length > 0) bound = [prev[prev.length - 1]!];
              else if (u.rowKey && rowObjs.get(u.rowKey)?.size === 1) bound = [{ obj: [...rowObjs.get(u.rowKey)!][0]!, art: null, start: at, end: at }];
            }
            for (const b of bound) add(b, -1);
          }
        }
      }
      // 肯定角色：备位、转述、风险提示的句子不认
      if (BACKUP.test(sen.text) || ATTRIB.test(sen.text) || HEDGE.test(sen.text)) return;
      // 主会话（第 65 批真实验收 v39-m18 误报）：叙述对方的行为（“被申请人以……为由，依据《员工手册（2023版）》……解除”）不是我方把它当依据——
      // 按文书一方定对方的称谓：申请书、起诉状、上诉状里对方是被申请人、被告、被上诉人；答辩书、答辩状里对方是申请人、原告、上诉人
      if (counterpartNarrates(u.filename, sen.text)) return;
      const inNeg = (a: number, b: number): boolean => negSpans.some(([x, y]) => a < y && x < b);
      const posFound = new Set<Mention>();
      // 嵌入式短语（“以劳动合同为依据”）里写的是别的东西时，这一段不再交给泛化的“作为……依据”去承前
      const consumed: [number, number][] = [];
      for (const p of POS_PATTERNS) {
        for (const mm of sen.text.matchAll(p.re)) {
          const at = sen.start + mm.index!;
          const end = at + mm[0].length;
          if (p.embed) consumed.push([at, end]);
          else if (consumed.some(([x, y]) => at < y && x < end)) continue;
          if (inNeg(at, end) || NEG_LEAD.test(masked.slice(Math.max(sen.start, at - 3), at))) continue;
          {
            const [ca] = clauseOf(at);
            if (CLAUSE_NEG.test(masked.slice(ca, at))) continue;
          }
          let bound: Mention | undefined;
          if (p.embed) bound = inSent.find((m) => m.start >= at && m.start < end);
          if (!bound && p.after) {
            const [, cb] = clauseOf(at);
            bound = inSent.find((m) => m.start >= end && m.start < cb);
          }
          if (!bound && !p.embed) {
            // 肯定词所在分句或紧前一个分句里、40 字以内最近的一次提及
            const [ca] = clauseOf(at);
            const from = ca > sen.start + 1 ? clauseOf(ca - 2)[0] : ca;
            const before = inSent.filter((m) => m.end <= at && m.start >= from && at - m.end <= 40);
            bound = before[before.length - 1];
          }
          if (!bound && p.embed && p.fallback) {
            const before = inSent.filter((m) => m.end <= at && at - m.end <= 40);
            bound = before[before.length - 1];
          }
          if (bound) posFound.add(bound);
        }
      }
      for (const m of inSent) {
        const lead = masked.slice(Math.max(sen.start, m.start - 6), m.start);
        if (!POS_PREFIX.test(lead) || NEG_LEAD.test(masked.slice(Math.max(sen.start, m.start - 6), m.start).replace(POS_PREFIX, ""))) continue;
        if (inNeg(m.start, m.end) || AS_EVIDENCE.test(masked.slice(m.end, sEnd))) continue;
        posFound.add(m);
      }
      for (const m of posFound) add(m, 1);
    });
  });
  return roles;
}

/** 否定与肯定是否说的是同一范围：否定整份文件 → 冲突；都指到条号且同一条（一边是另一边的前缀）→ 冲突。 */
function compatible(posArt: string | null, negArt: string | null): boolean {
  if (negArt === null) return true;
  if (posArt === null) return false;
  return posArt.startsWith(negArt) || negArt.startsWith(posArt);
}

function roleIssues(docs: readonly AmountDoc[]): CrossIssue[] {
  const units = docs.flatMap(unitsOf);
  const objs = [...objectsOf(units).values()];
  if (objs.length === 0) return [];
  const roles = rolesOf(units, objs);
  const issues: CrossIssue[] = [];
  for (const o of objs) {
    const rs = roles.filter((r) => r.obj === o);
    const files = [...new Set(rs.map((r) => r.filename))];
    for (const a of files) {
      const mine = rs.filter((r) => r.filename === a);
      // 同一文件内对同一范围两种角色都有：该文件自己在作区分说明（“已废止但行为时有效”、主张与备位分写），这些依据用法不作为依据一方；
      // 只否定了另一条的（“第8条不作为依据”）不妨碍本文件对第3条的依据用法
      const ownNeg = mine.filter((r) => r.sign === -1);
      const pos = mine.filter((r) => r.sign === 1 && !ownNeg.some((n) => compatible(r.art, n.art)));
      if (pos.length === 0) continue;
      const negs = rs.filter((r) => r.sign === -1 && r.filename !== a && pos.some((p) => compatible(p.art, r.art)));
      if (negs.length === 0) continue;
      const p = pos.find((x) => negs.some((n) => compatible(x.art, n.art)))!;
      // 每个文件取一句，至多三句
      const picked: Role[] = [];
      const pickedKeys = new Set<string>();
      for (const n of negs) {
        const k = `${n.filename}|${n.where}`;
        if (pickedKeys.has(k)) continue;
        if (picked.some((x) => x.filename === n.filename) && negs.some((y) => !picked.some((x) => x.filename === y.filename))) continue;
        pickedKeys.add(k);
        picked.push(n);
        if (picked.length >= 3) break;
      }
      const label = `${o.label}${p.art ? p.art : ""}`;
      // 主会话（第 65 批）：作依据的一方与写“不作为依据”的一方都是要一起递交的文书（答辩书与证据目录等）时，
      // 裁判者两份都看得到，口径相反不是“须核”而是必须改——m25 四次未通过即此（证据目录与答辩书口径相反）；只有内部核对清单不一致的仍为须核
      // 第 65 批真实验收（v39-m25）：只有内部核对清单写“不作为依据”时原为须核，修改轮便把它当可选、没改核对清单那一行，回看判未落实——
      // 核对清单是律师递交前逐项核对的控制件，与要递交的文书口径相反同样会误导律师，作依据的一方是递交文书时一律必须改
      const filedTogether = isFiled(a);
      issues.push({
        key: `role|${o.key}|${a}`,
        filename: a,
        where: p.where,
        text: clip(p.sentence),
        problem: `${label}在这里作为依据使用（“${clip(p.sentence, 80)}”），另一份成果却写它不作为依据：${picked.map((n) => `《${n.filename}》${n.where}“${clip(n.sentence, 80)}”`).join("；")}`,
        fix: `${o.label}在本案里是依据还是只作辅助证据，各份成果须一个口径：按律师确定的口径同步改正文、证据目录与核对清单（确属“主张 + 备位”的，正文写明备位关系）`,
        must: filedTogether,
      });
    }
  }
  return issues;
}

/** 诊断用：各对象在各文件里被认成的角色（回放判读误报、漏报时看）。 */
export function explainRoles(docs: readonly AmountDoc[]): { object: string; sign: "依据" | "不作依据"; art: string | null; filename: string; where: string; sentence: string }[] {
  const units = docs.flatMap(unitsOf);
  const objs = [...objectsOf(units).values()];
  return rolesOf(units, objs).map((r) => ({ object: r.obj.label, sign: r.sign === 1 ? "依据" : "不作依据", art: r.art, filename: r.filename, where: r.where, sentence: clip(r.sentence, 100) }));
}

// ───────────────────────── 入口 ─────────────────────────

/** 对本任务各文件最新一版做跨交付件核对。必须改的排前面。 */
export function checkCrossDeliverables(docs: AmountDoc[]): CrossIssue[] {
  const issues = [...evidenceIssues(docs), ...roleIssues(docs)];
  const seen = new Set<string>();
  return issues.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true))).sort((a, b) => Number(b.must) - Number(a.must));
}

/** 对本任务最新版成果做跨交付件核对（与金额勾稽取同一批文件）。出错时返回空（不因核对本身的缺陷拦住交付）。 */
export function runCrossIssues(deps: { db: KernelDb; blobs: BlobStore }, runId: string, matterId: string): CrossIssue[] {
  try {
    const docs = latestAmountDocs(deps, runId, matterId);
    if (docs.length < 1) return [];
    return checkCrossDeliverables(docs);
  } catch {
    return [];
  }
}

/** 一次并入复核意见的跨交付件条数上限（与金额勾稽共用复核意见 15 条的总数）。 */
export const CROSS_FINDINGS_MAX = 4;

/**
 * 核对结果写成复核意见（接在模型意见与金额勾稽之后编号）。纯函数。
 * 依据一栏沿用金额勾稽的 MACHINE_BASIS：isMachineFinding 据此把它们交给内核重跑判断是否落实，不交模型回看；
 * 回看时“还在不在”的集合要并上本核对的 key（见 runCrossIssues）。X1 为必须改；X5 为建议改（须核：两句原文并列，口径由律师定）。
 */
export function crossFindings(issues: readonly CrossIssue[], startNo: number): (ReviewFinding & { machine_key: string })[] {
  return issues.slice(0, CROSS_FINDINGS_MAX).map((i, k) => ({
    no: startNo + k,
    where: `《${i.filename}》${i.where}`,
    problem: i.problem,
    basis: MACHINE_BASIS,
    fix: i.fix,
    must: i.must,
    level: i.must ? ("must" as const) : ("should" as const),
    machine_key: i.key,
  }));
}
