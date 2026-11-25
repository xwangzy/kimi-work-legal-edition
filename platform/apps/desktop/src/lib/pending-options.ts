/**
 * 重新估价时沿用原发起的全部选项（第 61 批，真实验收 v35-L2-caselaw 抓包：经“发送什么、发给谁”确认页重新估价的两处漏了主交付物，
 * 场景卡指定的主交付物（类案检索报告、尽调报告、法律意见书、致对方的修订说明……）被丢掉，内核按方法缺省交付物执行）。纯函数。
 */
export function pendingOptions(cur: { skill?: string; label?: string; skillArgs?: Record<string, string>; reviewRules?: boolean; primaryOutput?: string; docNames?: string[]; model?: string }): { skill?: string; label?: string; skillArgs?: Record<string, string>; reviewRules?: boolean; primaryOutput?: string; docNames?: string[]; model?: string } {
  return {
    ...(cur.skill ? { skill: cur.skill } : {}),
    ...(cur.label ? { label: cur.label } : {}),
    ...(cur.skillArgs ? { skillArgs: cur.skillArgs } : {}),
    ...(cur.reviewRules !== undefined ? { reviewRules: cur.reviewRules } : {}),
    ...(cur.primaryOutput ? { primaryOutput: cur.primaryOutput } : {}),
    ...(cur.docNames ? { docNames: cur.docNames } : {}),
    // 第 66 批：首页选的模型（重新估价后照样按它发起）
    ...(cur.model ? { model: cur.model } : {}),
  };
}

