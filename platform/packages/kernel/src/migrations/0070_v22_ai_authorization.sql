-- 第 48 批：AI 辅助授权前移到“委托时一次、设置里一次”（D-202）。
--   客户授权仍按四项依据分别记录（第 02 篇 §8.1，闸门、宿主、网关口径不变）；变的是“谁、在什么时候回答”：
--   律师在设置里声明一次“我的委托合同含使用 AI 辅助及次处理者（中软、月之暗面）的条款”，之后新建事项默认按此记录，
--   每个事项仍可另行标为“尚未取得”或“客户要求不上云”；敏感事项的“敏感信息特别条件”不随默认确认（须逐案确认）。
--
--   matters.basis_source：四项依据是怎么记下的——
--     engagement_terms  新建事项时按律师的默认设置（委托合同条款）记录；
--     confirmed         律师在这个事项里确认已取得客户同意（委托合同条款或书面确认）；
--     NULL              逐项编辑，或此前的事项。
--   user_ai_authorization：律师本人的默认设置（只在本机、按律师本人，不同步、不上云）。
ALTER TABLE matters ADD COLUMN basis_source text;
CREATE TABLE user_ai_authorization (
  tenant_id        text NOT NULL,
  user_id          text NOT NULL,
  engagement_terms integer NOT NULL DEFAULT 0,
  updated_at       text NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
