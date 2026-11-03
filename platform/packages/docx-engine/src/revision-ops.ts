/**
 * 修订指令（修订桥协议，方案 §4.1 宿主修订桥：锚点、原文 hash、新文本、批注、作者与来源标记）。
 * 同一 schema 供三处使用：云端文书引擎（直出修订稿）、Word/WPS 宿主修订桥、Office.js 加载项。
 */
export interface RevisionOp {
  opId: string;
  /** 锚点：在段落纯文本中定位的原文（精确匹配，区分第 N 次出现） */
  anchor: {
    originalText: string;
    occurrence?: number | undefined; // 默认 0（第一次出现）
    paragraphHint?: string | undefined; // 条款号提示（如 "7.1"），用于冲突时的人工定位
    /** 改页眉或页脚里的文字（V10 第 36 批）：在每个含锚点的页眉 / 页脚部件里写原生修订；缺省为正文。页眉页脚里不加批注。 */
    part?: "body" | "header" | "footer" | undefined;
  };
  /** 原文 hash（sha256 of originalText）：不符即停止并转人工，不覆盖原件（§6.2） */
  originalHash: string;
  newText: string; // 空串 = 纯删除
  /**
   * 段后插入（v9.4 第 19 批 C-02 缺失条款）：不删锚点，在锚点所在段落之后插入新段落（newText 按换行分段），
   * 新段落的段落标记与文字都标为插入修订——拒绝修订即恢复原样。段落格式沿用锚点段落（去掉分节与段落标记格式）。
   */
  insertAfter?: boolean | undefined;
  comment?: string | undefined; // 批注
  ruleId?: string | undefined; // 触发规则（规则 ID、版本）
  riskLevel?: "high" | "mid" | "low" | undefined;
  author: string; // 修订作者标记（与交付记录区分 AI 建议/律师批准）
}

export interface RevisionPlan {
  baselineHash: string; // 目标 document_version 的 sha256
  ops: RevisionOp[];
}

export interface AppliedRevision {
  opId: string;
  status: "applied";
  /** 正文段落序号；改在页眉页脚里的为 -1（见 part / partName）。 */
  paragraphIndex: number;
  part?: "header" | "footer";
  /** 改到的页眉页脚部件（word/header1.xml 等），一条修改可能改到几个部件（首页页眉与默认页眉）。 */
  partNames?: string[];
}

export interface RevisionFailure {
  opId: string;
  status: "anchor_mismatch";
  detail: string;
}
