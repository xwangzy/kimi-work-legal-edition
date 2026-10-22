/**
 * 材料初判（v9.4 第 22 批；评审 C1 §1 #28“开审前分诊”，借鉴 LegalOn Triage Agent）：材料一多，先知道每份是什么、多长、该用哪个方法。
 *
 * 在这台电脑上按规则判断（不调用 AI）：看文件名与解析文本的开头几千字，认文书类型（合同、补充协议、起诉状、判决书、裁决书、规章制度、公司决议等）、
 * 合同类型（与合同审查方法的十类同名）与篇幅。**只做建议**：不改文件名、不移动原件、不替律师决定用哪个方法（评审 C1 §5：AI 不整理原件）；
 * 认不出的写“其他”，不猜。
 */
import type { KernelDb } from "../db.ts";

export type MaterialKind =
  | "contract"
  | "supplement"
  | "complaint"
  | "defense"
  | "appeal"
  | "arbitration_application"
  | "labor_application"
  | "judgment_first"
  | "judgment_final"
  | "ruling"
  | "award"
  | "mediation"
  | "letter"
  | "policy"
  | "corporate"
  | "other";

export const MATERIAL_KIND_LABELS: Record<MaterialKind, string> = {
  contract: "合同",
  supplement: "补充协议",
  complaint: "起诉状",
  defense: "答辩状",
  appeal: "上诉状",
  arbitration_application: "仲裁申请书",
  labor_application: "劳动仲裁申请书",
  judgment_first: "一审判决书",
  judgment_final: "终审判决书",
  ruling: "裁定书",
  award: "仲裁裁决书",
  mediation: "调解书",
  letter: "函件",
  policy: "规章制度",
  corporate: "公司决议或章程",
  other: "其他",
};

export interface MaterialTriage {
  document_version_id: string;
  kind: MaterialKind;
  label: string;
  /** 合同类型（与合同审查方法 references/contract-types.md 的十类同名）；不是合同或认不出为 null。 */
  contract_type: string | null;
  chars: number;
  pages: number | null;
  /** 篇幅：short 短（< 3,000 字）/ medium 中 / long 长（≥ 20,000 字）。 */
  size: "short" | "medium" | "long";
}

/** 先认更具体的（劳动仲裁申请书先于仲裁申请书、补充协议先于合同、终审判决先于一审判决）。 */
const KIND_RULES: [MaterialKind, RegExp][] = [
  ["labor_application", /劳动(人事)?争议仲裁申请书|劳动仲裁申请书/],
  ["arbitration_application", /仲裁申请书/],
  ["award", /裁\s*决\s*书/],
  ["mediation", /调\s*解\s*书/],
  ["judgment_final", /本判决为终审判决|二审判决|民事判决书[\s\S]{0,400}终\d+号|[(（]\d{4}[)）][^\s]{0,12}民终\d+号/],
  ["judgment_first", /判\s*决\s*书/],
  ["ruling", /裁\s*定\s*书/],
  ["appeal", /上\s*诉\s*状/],
  ["defense", /答\s*辩\s*状/],
  ["complaint", /起\s*诉\s*状|起诉书/],
  ["supplement", /补充协议|变更协议|修订协议|补充合同/],
  ["corporate", /股东(大)?会决议|董事会决议|公司章程|股东会会议记录/],
  ["policy", /员工手册|规章制度|管理制度|管理办法|考勤制度|薪酬制度|奖惩制度/],
  ["letter", /律师函|催告函|通知函|告知函|催款函|函\s*$/m],
  ["contract", /合同|协议书?|契约/],
];

const CONTRACT_TYPES: [string, RegExp][] = [
  ["股权转让", /股权转让/],
  ["投资协议（增资 / 股权收购）", /增资|投资协议|股权收购|认购/],
  ["技术开发", /技术开发/],
  ["劳动合同（用人单位）", /劳动合同/],
  ["保密与竞业限制", /保密协议|竞业限制|竞业禁止/],
  ["建设工程施工", /施工合同|建设工程/],
  ["租赁", /租赁/],
  ["借款与担保", /借款|贷款|保证合同|担保|抵押|质押/],
  ["买卖", /买卖|采购|销售|购销|供货/],
  ["服务 / 技术服务", /服务/],
];

/** 纯函数：文件名 + 解析文本开头 → 初判。 */
export function triageText(filename: string, head: string, chars: number, pages: number | null): Omit<MaterialTriage, "document_version_id"> {
  const name = filename.replace(/\.[a-z0-9]{2,5}$/i, "");
  // 先看文件名，再看开头 600 字（标题通常在最前）；判决书类再看全部开头（“本判决为终审判决”在末尾时认不出，就按一审判决书——律师自行看）
  const title = `${name}\n${head.slice(0, 600)}`;
  // 合同与补充协议只看文件名与标题行（前三行里以“合同 / 协议 / 契约”结尾的那一行）：证据、发票、函件正文里常提到“合同”，不能据此当成合同
  const titleLine = head.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).find((l) => [...l].length <= 40 && /(合同|协议书?|契约)(（[^）]*）|\([^)]*\))?$/.test(l)) ?? "";
  const top = `${name}\n${titleLine}`;
  let kind: MaterialKind = "other";
  for (const [k, re] of KIND_RULES) {
    if (re.test(k === "judgment_final" ? `${name}\n${head}` : k === "contract" || k === "supplement" ? top : title)) {
      kind = k;
      break;
    }
  }
  const isContract = kind === "contract" || kind === "supplement";
  const contract_type = isContract ? (CONTRACT_TYPES.find(([, re]) => re.test(top))?.[0] ?? null) : null;
  return { kind, label: MATERIAL_KIND_LABELS[kind], contract_type, chars, pages, size: chars < 3_000 ? "short" : chars < 20_000 ? "medium" : "long" };
}

/** 事项里每份材料（最新解析版本）的初判；没解析出文字的不列。 */
export function triageMatter(db: KernelDb, matterId: string): MaterialTriage[] {
  const rows = db.all<{ document_version_id: string; filename: string; head: string | null; chars: number | null; page_count: number | null }>(
    `SELECT dv.document_version_id, dv.filename, substr(pt.content, 1, 4000) AS head, length(pt.content) AS chars, pv.page_count
       FROM document_versions dv
       JOIN parse_versions pv ON pv.parse_version_id = (SELECT p2.parse_version_id FROM parse_versions p2 WHERE p2.document_version_id = dv.document_version_id ORDER BY p2.created_at DESC, p2.rowid DESC LIMIT 1)
       JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id
      WHERE dv.matter_id = ? AND dv.quarantined_at IS NULL
      ORDER BY dv.created_at DESC LIMIT 500`,
    [matterId],
  );
  return rows.map((r) => ({ document_version_id: r.document_version_id, ...triageText(r.filename, r.head ?? "", r.chars ?? 0, r.page_count ?? null) }));
}
