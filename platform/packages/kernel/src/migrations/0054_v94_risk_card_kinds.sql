-- v9.4 第 19 批 C-02 / C-05（评审 C1 §2.2）：风险卡分四类、标明判断依据的来源、缺失卡说清“为什么认为缺失”、谈判梯度可选用。
--   kind：risk 条款写了但不利（缺省，含本批之前的卡）/ missing 该有没有 / deviation 偏离本所或客户规则 / consistency 前后不一致；
--   rule_source：law 法律强制 / firm_rule 本所或客户规则 / general 通用建议（没有规则时的模型意见，须律师判断）；空 = 本批之前的卡；
--   rule_ref：规则编号与要点（偏离卡必填；文字字段按令牌形态保存）；
--   searched_terms / searched_docs：缺失卡查过的说法与文件（JSON 数组）；searched_found：内核在材料里逐个复查这些说法、实际找到的（JSON 数组，非空即可能误报）；
--   chosen_level：律师接受时选用的一级（suggestion 首选 / fallback 可退让）；底线只展示、不写进修订稿。
ALTER TABLE risk_cards ADD COLUMN kind text CHECK (kind IS NULL OR kind IN ('risk','missing','deviation','consistency'));
ALTER TABLE risk_cards ADD COLUMN rule_source text CHECK (rule_source IS NULL OR rule_source IN ('law','firm_rule','general'));
ALTER TABLE risk_cards ADD COLUMN rule_ref text;
ALTER TABLE risk_cards ADD COLUMN searched_terms text;
ALTER TABLE risk_cards ADD COLUMN searched_docs text;
ALTER TABLE risk_cards ADD COLUMN searched_found text;
ALTER TABLE risk_cards ADD COLUMN chosen_level text CHECK (chosen_level IS NULL OR chosen_level IN ('suggestion','fallback'));
