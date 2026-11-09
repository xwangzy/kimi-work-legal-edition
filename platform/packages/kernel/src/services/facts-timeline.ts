/**
 * 《事实时间线》由系统按已提交的事实生成（V14 第 39 批）。
 *
 * 根因（V13 第 38 批 W5 真实走查，独立评分 11/24、命中否决 V5）：案卷整理任务里助手已经把 119 条事实逐条提交到事实时间线，
 * 律师点名的第一项交付《事实时间线》却没有文件——助手要把这 119 条再用模型输出逐行重写成表格（约 25 token/秒），
 * 中途自写脚本拼数据连续出错，40 分钟工作时限到时还没渲染出来。时间线本来就是“已提交事实”按日期排序、分四列的投影，
 * 不需要模型再写一遍：由内核确定性生成，助手只做目录、缺口清单与分析。
 *
 * 本文件只放纯函数（取行、排序、合并重复、成表）；登记成果在执行器里做。
 */
import type { KernelDb } from "../db.ts";

export interface TimelineFact {
  fact_id: string;
  seq: number;
  statement: string;
  kind: string;
  occurred_on: string | null;
  amount_yuan: number | null;
  party: string | null;
  document_version_id: string | null;
  quote: string | null;
  anchor_status: string;
  status: string;
  filename: string | null;
}

/** 本事项未被律师驳回的事实（带来源材料文件名）。 */
export function timelineFacts(db: KernelDb, matterId: string): TimelineFact[] {
  return db.all<TimelineFact>(
    `SELECT f.fact_id, f.seq, f.statement, f.kind, f.occurred_on, f.amount_yuan, f.party, f.document_version_id, f.quote, f.anchor_status, f.status, d.filename
       FROM matter_facts f LEFT JOIN document_versions d ON d.document_version_id = f.document_version_id
      WHERE f.matter_id = ? AND f.status != 'rejected'
      ORDER BY f.created_at, f.seq LIMIT 5000`,
    [matterId],
  );
}

/**
 * 排序键：按日期升序；只到月的排在该月末尾、只到年的排在该年末尾（casefile-schema 第四节），日期未知的放表尾；同日按提交先后。
 */
export function dateSortKey(d: string | null): string {
  if (!d) return "9999-99-99~";
  if (/^\d{4}$/.test(d)) return `${d}-99-99`;
  if (/^\d{4}-\d{2}$/.test(d)) return `${d}-99`;
  return d;
}

const ANCHOR: Record<string, string> = { located: "已定位", ambiguous: "多处匹配", not_found: "未定位", no_document: "无来源材料" };
const KIND_COL: Record<string, number> = { claimed: 0, confirmed: 1, inferred: 2, to_confirm: 3 };

export interface TimelineTable {
  sheets: { name: string; rows: (string | number | null)[][] }[];
  facts: number;
  rows: number;
  merged: number;
}

/**
 * 成表：工作表“时间线”（序号 / 日期 / 材料载明 / 律师确认 / 推论 / 待确认 / 涉及主体 / 金额（元）/ 来源材料 / 逐字引文 / 定位状态 / 事实编号，
 * 与方法 casefile-organize 第 5 节同列）、“待确认事项”、“说明”。
 * 重复行合并（同日期、同列、同陈述）：事实编号写在一起，不出两行。律师已确认的写在“律师确认”一列。纯函数。
 */
export function buildTimeline(facts: readonly TimelineFact[], materialName: (f: TimelineFact) => string = (f) => f.filename ?? ""): TimelineTable {
  const norm = (s: string) => s.replace(/[\s，,。.；;：:、“”"'‘’（）()]/g, "");
  const sorted = [...facts].sort((a, b) => dateSortKey(a.occurred_on).localeCompare(dateSortKey(b.occurred_on)) || a.seq - b.seq);
  type Row = { f: TimelineFact; col: number; ids: string[] };
  const rows: Row[] = [];
  const index = new Map<string, Row>();
  let merged = 0;
  for (const f of sorted) {
    const col = f.status === "confirmed" ? 1 : (KIND_COL[f.kind] ?? 3);
    const key = `${f.occurred_on ?? ""}|${col}|${norm(f.statement)}`;
    const hit = index.get(key);
    if (hit) {
      hit.ids.push(`F${f.seq}`);
      merged += 1;
      continue;
    }
    const r: Row = { f, col, ids: [`F${f.seq}`] };
    rows.push(r);
    index.set(key, r);
  }
  const header = ["序号", "日期", "材料载明", "律师确认", "推论", "待确认", "涉及主体", "金额（元）", "来源材料", "逐字引文", "定位状态", "事实编号"];
  const body = rows.map((r, i) => {
    const four: (string | null)[] = [null, null, null, null];
    four[r.col] = r.f.statement;
    return [i + 1, r.f.occurred_on ?? "日期不明", ...four, r.f.party ?? "", r.f.amount_yuan ?? null, materialName(r.f), r.f.quote ?? "", ANCHOR[r.f.anchor_status] ?? r.f.anchor_status, r.ids.join("、")];
  });
  const pending = rows.filter((r) => r.col === 3);
  const sheets: TimelineTable["sheets"] = [
    { name: "时间线", rows: [header, ...body] },
    {
      name: "待确认事项",
      rows: [["序号", "日期", "待确认事项（材料矛盾、识别不清、日期不确定）", "来源材料", "逐字引文", "事实编号"], ...pending.map((r, i) => [i + 1, r.f.occurred_on ?? "日期不明", r.f.statement, materialName(r.f), r.f.quote ?? "", r.ids.join("、")])],
    },
    {
      name: "说明",
      rows: [
        ["说明"],
        [`本表由系统按本事项“事实时间线”里已提交的事实生成：共 ${facts.length} 条事实，按日期排序（只到月或年的排在该月、该年末尾，日期不明的在表尾），同日期同陈述的重复行已合并（${merged} 条）。`],
        ["“材料载明”“推论”“待确认”三列是助手提交、尚未经律师确认的事实；“律师确认”一列只有律师在界面上逐条确认过的事实。只有律师确认的事实才会被起诉状、律师函与汇报引用。"],
        ["“逐字引文”摘自来源材料；“定位状态”为“未定位”的，引文没有在材料里逐字找到，使用前请核对原件。"],
        ["本表是工作底稿（草稿），不对事实真伪或证明力作判断。"],
      ],
    },
  ];
  return { sheets, facts: facts.length, rows: rows.length, merged };
}
