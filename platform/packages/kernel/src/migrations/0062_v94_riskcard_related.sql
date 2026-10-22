-- v9.4 第 21 批 C-02 残余（评审 C1 §2 第 7 项“跨文件审查”）：审主合同时参考补充协议、附件、附函——
-- 风险卡可以引用同一事项另一份文件的原文（补充协议改了付款期限、附件价格表与正文不一致等），内核在那份文件里逐字定位。
--   related：JSON 数组 [{document_version_id, filename, quote, relation, anchor_status}]，quote 为令牌形态。
-- kwl:managed-transaction
ALTER TABLE risk_cards ADD COLUMN related text;
