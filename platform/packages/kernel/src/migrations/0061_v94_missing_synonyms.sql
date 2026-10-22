-- v9.4 第 20 批 C-02 残余（评审 C1 §2.2 第 2 条）：缺失卡误报时律师一键驳回，并把材料里实际的说法补进“说法组”——
-- 以后同一组说法的缺失卡，内核复查时连这个说法一起找，找到即标“可能误报”。本所范围、只在本机；不进修订稿、不发给 AI。
--   group_terms：当时那张缺失卡查过的说法（JSON 数组）；term：律师补的说法。
-- kwl:managed-transaction
CREATE TABLE missing_synonyms (
  synonym_id  text PRIMARY KEY,
  tenant_id   text NOT NULL,
  group_terms text NOT NULL,
  term        text NOT NULL,
  added_by    text NOT NULL,
  added_at    text NOT NULL,
  UNIQUE (tenant_id, term, group_terms)
);
