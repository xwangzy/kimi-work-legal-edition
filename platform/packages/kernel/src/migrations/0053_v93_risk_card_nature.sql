-- v9.3 P2 / Astra M-1（评审 Z3 §6.2）：风险卡标明建议的性质与谈判梯度。
--   nature：must 必须修改（法律硬伤、律所红线）/ should 建议修改 / negotiable 可谈判（商业条件）；第 15 批之前的卡为空，界面按类别推定。
--   梯度：suggestion = 首选（原有）→ fallback = 可退让（原有）→ bottom_line = 底线（新增；文字字段同样按令牌形态保存）。
ALTER TABLE risk_cards ADD COLUMN nature text CHECK (nature IS NULL OR nature IN ('must','should','negotiable'));
ALTER TABLE risk_cards ADD COLUMN bottom_line text;
