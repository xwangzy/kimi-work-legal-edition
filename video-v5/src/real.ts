/**
 * 本次真实任务里取出的数据（第 69 批 e56b568a 采集栈，真实 Kimi 模型 kimi-k3.1-pro）。
 * TOKENS：产品在发出前替换出的代号，由产品 materials.send_preview 按本事项代号密钥给出，与本次任务实际发出的内容一致。
 */
export const TOKENS = {
  // materials.send_preview（本事项代号密钥；与本次任务实际发出的一致）
  name1: "〔自然人·16H38B〕",
  id1: "〔证件号·AN6J1X〕",
  name2: "〔自然人·8SYHPZ〕",
  phone2: "〔电话·CNJEDX〕",
};

/** 清洁稿（律师接受审查意见后生成）里与主纸同位置的行：行号 → 文本。没有的行沿用原文。 */
export const CLEAN_ROWS: Record<number, string> = {};
