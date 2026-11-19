-- 第 47 批：无事项问答按次选模型（K3 / K2.6）——每条回答（含“未能取得回答”）记下实际用的模型别名（legal/k3、legal/k2.6），
--   界面据此显示“由 K2.6 回答”。可空：问题本身与此前的旧记录为 NULL（界面不显示）。
ALTER TABLE qa_messages ADD COLUMN route text;
