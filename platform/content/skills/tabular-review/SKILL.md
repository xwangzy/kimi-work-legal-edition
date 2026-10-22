---
name: tabular-review
description: >-
  表格审阅：按律师建好的审阅表（证据清单、合同尽调摘要、合同台账），逐份材料、逐列回答，每格写值并附逐字引文，填进事项材料页的审阅表，律师逐格核对。文件里没有的如实写“没找到”，读不出文字的材料不猜，律师已核过的格子不重填。用于多份材料要回答同一组问题的场景。
when_to_use: 律师在事项“材料 → 表格审阅”里建了表并点“让助手填表”时使用（方法参数 table_id 为表的编号）；单份合同逐条审查请用 contract-review。
arguments: [table_id]
kwl:
  id: tabular-review
  version: 1.0.0
  lines: [诉讼仲裁, 非诉, 企业法务]
  chain: casefile
  tier: beta
  tools_required: [table.get, table.fill, materials.list, materials.read_excerpt]
  tools_optional: [facts.list]
  outputs: [审阅表（事项材料页）]
  source_lineage: [spec:v9.4评审C1§3.3, product:harvey-review-table, product:legora-tabular-review]
---

# 表格审阅（逐格带出处）· 试用

## 1. 适用范围
- **交付**：事项材料页里那张审阅表的格子（`table.fill` 写入）；回报里写清填了多少、没找到多少、哪些需要律师先看。**不另出文书。**
- **做什么**：表的每一行是一份材料、每一列是一个问题；逐份读、逐列回答，每格给值与逐字引文。
- **不做什么**：不综合成报告（律师核完格子后另起任务据表起草）；不改律师已核或已改的格子；不替律师判断争点归属与三性结论之外的法律后果。
- **试用**：未经本所质量验收。

## 2. 输入与前置检查
1. 方法参数 `table_id`（`$table_id`）是要填的表。没有这个参数时，停止并回报“请在事项材料页的表格审阅里点‘让助手填表’”，不要自己建表。
2. `table.get` 读表：列（column 编号、列名、格式、填写说明 hint）、材料（document_version_id、filename、unreadable）、已有格子（state、locked）。
3. `materials.list` 核对每份材料的读取质量；`quality` 为 partial 的材料，在回报里写明未读取的页。

## 3. 步骤
1. **逐份读材料**：按 `table.get` 的材料顺序，用 `materials.read_excerpt`（或工作区快照）读全文；`unreadable=true` 的材料跳过（格子已标“读取差”）。
2. **逐列回答**：按每列的 hint 找答案。
   - 找到：`value` 按列格式写（日期 YYYY-MM-DD，只知年月写 YYYY-MM、不补日；是否列只填“是 / 否”；选项列只填给定选项；金额写数字与币种）；`quote` **逐字**摘自该材料，取能看出答案的最短完整句，代号（如〔机构·XXXXXX〕）原样保留。
   - 文件里确实没有：`status: "not_found"`，不写值。不要把“没写明”写成一个推测值。
   - 同一份材料两处说法不一：`status: "conflict"`，`value` 写你认为更可能的一处，`note` 写明两处各在哪、各怎么说。
3. **跳过已锁定的格子**：`locked=true` 的不填；律师撤回后才会解锁。
4. **分批写入**：每份材料填完即调一次 `table.fill`（一次不超过 400 格）。按回报处理：`rejected` 的格子按原因改正后重填；`quote_not_found` 大于 0 时，把那些格子的引文改为逐字摘录重填。
5. **回报**：一段话写清：填了几份材料、几格；没找到的格子数（按列）；有冲突的格子；读取差的材料；建议律师先核的格子（冲突、金额、日期）。

## 4. 工具调用约定
| 工具 | 用途 | 关键参数 | 失败时 |
|---|---|---|---|
| table.get | 读表结构与格子状态 | table_id | 表不存在：停止并回报 |
| table.fill | 逐格写值与引文 | table_id，cells[{document_version_id, column, status, value, quote, note}] | 按 rejected 原因改正重填 |
| materials.read_excerpt | 读材料原文 | parse_version_id，char_start / char_end | 某段失败：回报中列为未读 |
| materials.list | 材料读取质量 | — | 不可用：回报中写明未核对读取质量 |

## 5. 输出规格
- 格子：每格必有 `quote`（status=not_found 除外）；值与引文一致，不加引文里没有的信息。
- 回报：不超过 300 字；不复述每格内容（律师在表里看）。

## 6. 质量自检
- [ ] 每份可读材料的每一列都有结果（找到 / 没找到 / 冲突），没有漏格。
- [ ] 每个“找到”的格子都有逐字引文，且引文能看出这个值。
- [ ] 日期没有补成 1 日；只知年月的写成 YYYY-MM。
- [ ] 没有改动 locked 的格子；没有为读取差的材料编值。

## 7. 禁止事项
- 不编造值：材料里没有的写“没找到”。
- 不把推断写成材料记载；需要推算的（如按期限推到期日）写在 note，值留给律师。
- 不联网查询表里的主体。

## 8. 依赖缺失时的降级
- `table.get` / `table.fill` 不可用：停止，回报“表格审阅暂不可用”；不要改用 xlsx.render_table 另做一张表冒充。
