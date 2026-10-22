-- v9.4 第 20 批 S-08（评审 S1 §6.2 第 10 项后半、C1 §3.2）：事项的程序阶段、事件时点与地域。
--   stage：律师点选的当前阶段（诉讼 pre_filing 立案前 / first_instance 一审 / second_instance 二审 / retrial 再审 / enforcement 执行；
--          仲裁 arbitration；非诉 due_diligence 尽调 / negotiation 谈判 / signing 签约 / closing 交割 / performance 履约；顾问 advisory），不由 AI 推断；
--   event_date：引起纠纷或交易的主要法律事实发生的时点（YYYY-MM-DD 或只到月 YYYY-MM），签发前按它复核实体法引用的适用版本（程序法从新，不按它核）；
--   region：事项所在地域（省市名，可空），核对地方性法规、地方口径是否适用。
-- kwl:managed-transaction
ALTER TABLE matters ADD COLUMN stage text;
ALTER TABLE matters ADD COLUMN event_date text;
ALTER TABLE matters ADD COLUMN region text;
