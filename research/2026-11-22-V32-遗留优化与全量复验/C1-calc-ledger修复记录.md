# C1 calc.ledger 成表质量与违约金口径修复记录（V32，第 58 批）

基线：main d9eee05（worktree kimi-legal-b58-acceptance）。未提交。行号为改后文件的行号。

## 0. 先说一个事实：V31 交付件不是 d9eee05 的成表代码出的

改动前我先用 d9eee05 的 `ledgerWorkbook` 重出了 m05 两个口径：那时已经不出全为 0 的“冲费用”“冲加倍部分债务利息”列，汇总的“利息（违约金）累计”已是 SUMIF、已冲与已付已引用付款表合计行。V31 的 m05 交付件（`evidence/deliverables/wave2/m05-amount/v2-计算明细-…xlsx`）里这些列和写死的 B6 都还在，说明验收时跑的是第 57 批中途的版本。所以问题 1、2 有一部分在 d9eee05 已经修了，下面的“根因”只写 d9eee05 仍然存在的部分。

## 1. 逐项：根因、改动、口径依据

### A. 汇总、已付、余额用公式；日期是日期格；日数是公式；改截止日会重算
- 根因（d9eee05 仍在）：日期写成文字，日数写死；末段的截止日跟“暂计截止日”没有联系，律师改截止日什么都不会变；有上限时累计是写死的数；有单笔上限截断时没有判断公式和缓存值是否一致。
- 改动：
  - `packages/docx-engine/src/xlsx.ts:22-34`：`SheetSpec.dates`（日期格位置）、`excelSerial`、`serialToIso`；`:51` 加 `numFmt 164 = yyyy-mm-dd`，`cellXfs` 加样式 6；`sheetXml` 给日期格用样式 6，列宽按“2026-11-30”估；`readCreatedXlsx` 按样式 6 读回 `dates`（`:229` 正则加了样式捕获），保证 `xlsx.edit_cells` 读回再写时日期格还在。
  - `packages/kernel/src/tools/tools/review.ts:547`：`xlsx.edit_cells` 读回时把 `dates` 一起带上（只加了一个展开）。
  - `packages/kernel/src/tools/tools/ledger-table.ts:42` `segmentSheet`：起止日写成日期格，`F = E−D+1`，`J = ROUND(G*H*F[/年日数],2)`，截止日等于暂计截止日的段 `E = '汇总'!$B$2`（`:55`）。
  - `ledger-table.ts:142` `summarySheet`：累计 = 已确定数额 + SUMIF(分段表类别列)，有总上限时写 `MIN(上限, SUMIF)`；只有公式与缓存值逐分相等才写公式（单笔上限截断时不写）；已冲各项、已付合计、多付引用付款表合计行；余额 = 原额 − 已冲；未清偿合计 = 各余额之和；暂计截止日是日期格。
  - `ledger-table.ts:73` `paymentSheet`：付款日是日期格；“抵扣后本金余额” = `'汇总'!本金原额 − SUM(冲本金$2:冲本金n)`。
  - `packages/kernel/src/services/amount-check.ts:563-579`：`blocksOfSheets` 把日期格还原成“2025-12-04”文字，金额勾稽不会把日期序号当金额出处。
- 校验：
  - LibreOffice 26 实测：5 个工作簿（m05 两口径、m07 待核日期、m45 违约金基数、强制执行加倍利息、LPR + 上限），先把所有公式格的缓存值改成 0，再用 `soffice --headless --convert-to xlsx` 强制重算后用 openpyxl 读值：132 个公式全部算回工具返回的数，0 处不符；日期格全部识别为日期。注意：LibreOffice 缺省打开 xlsx 不重算（显示缓存值，缓存值本来就等于工具返回值），实测时用了独立配置 `OOXMLRecalcMode=0`；律师在 LibreOffice 里改格子时照常联动。Excel 与 WPS 读 `fullCalcOnLoad`，本次没有在 Excel、WPS 实机打开。
  - 用例里另写了一个只认本表写法的小公式求值器（SUM、SUMIF、ROUND、MIN、四则、跨表引用），把缓存清零后逐格求值，CI 里不依赖 LibreOffice 也能证明公式能算回原数；并模拟“律师把截止日从 11-30 改到 12-10”：末段 276 日，合计增加 310,000 × 万分之五 × 10 = 1,550 元。

### B. 只出用到的列与行；计算口径只写一次；没有内部用语
- 根因：违约金与利息共用“利息（违约金）”一套行列；没有付款的口径也出“（没有付款）”空表，没有计息期间的也出“（本口径下没有计息的期间）0”空表；“参数与假设”每个口径把同样的计算口径整套重抄（V31 m05 三个口径 × 5 条 = 15 行）。
- 改动：
  - `ledger-table.ts:119` `summaryLayout`：本金、利息、违约金、费用、加倍利息、多付、约定上限、调减参照、抵充顺序、待核日期这些行，只有本次某个口径用到才出。
  - `paymentSheet`：抵充列（冲费用 / 冲利息 / 冲本金 / 冲违约金 / 冲加倍部分债务利息 / 未冲）全为 0 的不出；余额列按本口径有没有本金、利息、违约金决定；备注列有备注才出。
  - `ledgerWorkbook`（`:267`）：没有付款不出付款表，没有分段不出分段表。
  - `paramSheet`（`:227`，`:243`）：各口径完全相同的行（同一笔债务、同一条计算口径）合并为一行，口径栏写“全部口径”；“来源或说明”不再写“本表固定口径”；末尾一行说明改截止日的效果与限度。
  - 用语：类别写“利息”“违约金”“加倍部分债务利息”；表里不出现“系统”“工具”“内核”和参数名（用例逐格检查）。
- 依据：评分报告 m05 第 6、7 项，m45 第 6、7 项。

### C. 违约金单独成项；计算基数不计入合计；缺省不按“利息”优先冲抵
- 根因：`kind` 只有 principal / cost / interest；本金按 rate 计得的一律归“利息（违约金）”，`cost_interest_principal` 下一律先于本金冲抵；违约金只能把基数当“本金”记——要么计入未清偿合计（m45 v1 的 714,259.85 元），要么模型把基数填 0（m45 v6）。
- 改动（`packages/kernel/src/tools/tools/ledger.ts`）：
  - 新类别：`kind: "penalty"`（违约金计算基数：`amount_yuan` 是基数，只计违约金，不计入未清偿合计、不参与抵充、不能计入加倍利息基数）、`kind: "penalty_fixed"`（数额已确定的违约金）；`accrual: "interest" | "penalty"`（本金按 rate 计得的是利息还是违约金，可写在口径上；缺省 interest，保持旧调用结果不变）；`accrue_to`（计至日，含当日）；逐笔 `cap_yuan`（各部分分别适用上限）。
  - 冲抵（`:548` 起）：`cost_interest_principal` = 费用 → 利息 → 本金 → 违约金 → 加倍利息；`penalty_order: "as_interest"` 时违约金与利息同序、先于本金；`principal_first` = 本金 → 利息 → 违约金 → 费用；`principal_only` 不变。
  - assumptions 写明依据与争议（`:317` `PENALTY_AFTER`、`PENALTY_AS_INTEREST`）；只冲本金或没有付款的口径不写这一条。
  - 结果新增 `totals.penalty_base_yuan / penalty_fixed_yuan / penalty_accrued_yuan / penalty_paid_yuan / penalty_outstanding_yuan`、付款行 `to_penalty_yuan / penalty_unpaid_after_yuan`、`per_debt[].accrued_as`；`interest_*` 只含利息。
  - 金额为 0 的本金或基数给提示（`:369`）。
- 法条表述核对（原注释的问题与改法）：
  - 第五百六十一条：法规库原文是“实现债权的有关费用 → 利息 → 主债务”，原注释与 ALLOCATION_TEXT 把它写成“利息（违约金）”，等于把违约金读进了法条，已改。
  - 第五百六十条：原注释写“同一层内先到期的先冲，第五百六十条”。法规库原文第二款依次是“已到期的优先 → 担保最少 → 负担较重 → 到期先后 → 按比例”，第一款还有债务人清偿时的指定。工具只实现“已到期的优先、到期先后”，已改为如实写明“各笔担保或负担轻重不同的，另行判断”。
  - 法释〔2014〕8 号：原注释把“基数是除一般债务利息之外的金钱债务”和“排在文书确定的金钱债务之后”都挂在第四条下。前者是第一条（加倍部分债务利息的计算方法），后者是第四条，已分开写。这部司法解释法规库没有收录，条文是按记忆写的，未经法规库核对。
  - 合同编通则解释第六十五条：引文与法规库原文一致（第二款“人民法院一般可以认定为过分高于造成的损失”）。
- 口径选择：缺省“违约金排在本金之后”。理由：第五百六十一条没有列违约金，违约金是否当然适用这个顺序，实务有争议，主流做法不当然适用。另给 `as_interest` 作为律师明确选择的有争议口径。
- 我改了一处缺省口径，需要拍板：`penalty_fixed` 缺省计入加倍部分债务利息的基数。依据是法释〔2014〕8 号第一条“除一般债务利息之外的金钱债务”。旧的 `kind: interest` 仍不计入，旧调用结果不变。执行方法里原有的“计入 / 不计入两个口径并列”的要求保留。

### D. 每笔款项只按自己的基数变化分段
- 根因：时间轴上的分界点（各笔起算日、全部付款日、LPR 报价日）对所有款项一起切，别的款项的日期把这一笔切成几段（m45 的 10-31、11-06）。
- 改动：`ledger.ts:589` 起重写推进逻辑。分界点只用来推进时间，每笔款项各开一段，只有它自己的计算基数或利率变了（或到了计至日、截止日）才结束这一段，金额按整段一次四舍五入。付款日要冲利息或违约金时，按“到当天为止的暂计数”冲，整段结束时再定数；舍入单调，已冲数不会超过定数。加倍利息同理，只按基数变化分段。分段按款项归在一起排列。
- 结果：m45 第二批 11-01～11-09 一段 9 日 1,850.85 元，不再出“×6 日＋×3 日”。一笔用 LPR、一笔用固定日利率时，报价日只切开用 LPR 的那一笔。

### E. 日期待核（区间）
- 改动：付款写 `date_range: {earliest, latest}`（此时 `date` 可省），起算写 `due_date_range` / `accrue_from_range`。
  - `ledger.ts:817` `expandPendingDates` 展开为“按最早”“按最晚”两个确定口径；`:871` `calcLedgerScenarios` 两端各算一次并列，口径名带“（待核日期按最早 / 最晚）”。
  - `:849` `markPending` 逐段对照两端：另一端没有完全相同的一段，就标 `pending`（表里“说明”列写“依赖待核日期”）；返回 `pending_dates`（待核项、依赖段数、另一端合计）；付款备注写明“日期待核（起～止），本口径按最早 / 最晚日计”。
  - 展开后最多 6 个口径。`calcLedger` 单独收到区间会拒收，要求先展开。
- 结果：m07 的 30 万元在 12-10～01-20 之间到账，两端为 63,355 / 69,505 元，与评分报告的“确定最低 63,355”“上限约 69,505”一致。03-10 以后的一段两端相同，标为确定。

### F. 违约金调减参照（第六十五条）
- 改动：口径上可写 `penalty_check: {loss_yuan | loss_rate, loss_basis}`（`ledger.ts:672` 起）。
  - `loss_yuan` 是律师给的或材料载明的损失数额；`loss_rate` 是损失的计算标准，工具把违约金各笔的 rate 换成它，按同一基数、同一期间重算出损失。
  - 返回 `penalty_check`：参与比较的违约金、损失、损失 × 130%（四舍五入到分）、是否超过、结论。
  - 没有损失数据时，`loss_yuan`、`reference_yuan`、`exceeds` 都是 null，`needs` 列出需要的证据（第五百八十四条的损失、或损失的计算标准），不编数。
  - 有违约金的口径一律给出这一项。assumptions 写明这是“一般可以认定”的参照、不是确定结论，以及第一款的考量因素、第三款恶意违约、第六十四条第二款举证责任。
  - 汇总表出“损失数额”“损失的 130%”（有数时是公式 `ROUND(损失*1.3,2)`）“违约金调减参照”三行。

### 主会话补充的三项
1. 没有录入付款的口径：汇总的“已付款合计”写“未录入”（`ledger-table.ts:189`），不出空的付款表。相邻同基数、同利率的分段合并已由 D 解决。
2. 修改轮之后重跑金额勾稽：现有代码在回看里（`executor.ts` 约 2336 行）已经重跑 `runAmountIssues`，但只用来判断上一轮报过的机器意见还在不在；修改轮新引入的不一致不会报出。
   - 按原约定，我没有改 `executor.ts` 的复核部分。
   - 新增纯函数 `newIssuesSince(上一轮键, 本轮结果)`（`executor/amount-reconcile.ts:69`），返回上一轮没有、这一轮出现的不一致，已写用例。
   - 接入方法（待复核部分的负责人做）：在约 2141 行首次核对时保存全部 `issueKey`（不只是并入意见的前 8 条）；在约 2336 行对重跑结果调用 `newIssuesSince`，非空的按“必须改”或列给律师。
   - m45 那种“基数填 0、与分段表矛盾”的情形，现在有了 `kind: "penalty"` 和金额为 0 的提示，表里的计算工作表又不能逐格改，同样的路径已不会再出现。
3. `calc.labor` 的 `wage_table` 已经是“收原始逐月各项目 + include 声明计入项目”的结构，加回扣款就是 include 里不列扣款项，不需要改代码。
   - 方法正文改了两处自相矛盾的句子：`labor-dispute/SKILL.md:69`、`labor-arbitration-draft/SKILL.md:81` 原写“每个口径各给一组逐月数字”，改为“有台账的用同一份台账、只改 include，不自己算好月工资或加回后再传”。两处都是用 Edit 精确替换。
   - 补了一条 m17 型用例：不加回 29,724.14 元，加回 30,000 元；若重复加回会是 30,275.86 元。

## 2. 工具 schema、锁文件与方法
- `packages/kernel/src/tools/registry.ts`：
  - calc.ledger 的 description 重写（:229 起），新增 `LEDGER_DATE_RANGE_SCHEMA`（:78）。
  - 债务新增 `kind` 两个枚举、`due_date_range`、`accrue_from_range`、`accrue_to`、`accrual`、`cap_yuan`。
  - 付款的 `required` 改为只要 `amount_yuan`，新增 `date_range`。
  - 口径新增 `accrual`、`penalty_order`、`penalty_check`。
  - 版本号仍为 "1"。
- `content/tool-manifest/tool-manifest.lock.json`：只改了 calc.ledger 一项的 schemaHash（→ b9975378…），没有用 `--regenerate`；之后跑了 `npm run build:tool-manifest` 签名。`legalToolLockProblems()` 返回空。主会话后来给的 `sync-lock.mjs` 我没有用：我的同步早于那条消息，手工只改了这一项，效果相同。
- 方法（改后跑了 `npm run build:skills`，33 个方法、53 个文件）：
  - `amount-calc/SKILL.md`：适用范围；第 2 节第 1、3、4 项（区间日期、款项写法、违约金冲抵）；第 3 节第 2、4、5 步（字段、逐笔上限、调减参照）；输出规格（附页按分段逐段照抄、不拆段）；自检 3 条；降级段按主会话口径改为“计算方式 / 人工核算”。
  - `defense-draft`：答辩要点第 1 项改为 accrual、date_range、penalty_check；工具表；降级段。
  - `pleading-draft`、`demand-letter`、`arbitration-application`、`preservation-application`：款项写法、工具表，以及降级段的“手工计算，请复核”。`demand-letter` 另加了“算式按分段表逐段照抄、不拆段”。
  - `enforcement-application`：penalty_fixed、加倍基数缺省、违约金冲抵、降级段、工具表。
  - `appeal-draft`：工具表。
  - `labor-dispute`、`labor-arbitration-draft`：见上文第 3 项。

## 3. 用例与结果
Node：`export PATH="$HOME/.nvm/versions/node/v26.8.1/bin:$PATH"`，逐个 `node --test <文件>`：

| 用例文件 | 结果 |
|---|---|
| packages/kernel/test/b58-calc-ledger.test.ts（新，A～F 与补充项，金额全部手算） | 13 过 0 败 |
| b57-calc-ledger.test.ts | 11/0 |
| b57-calc-ledger-tool.test.ts（汇总行名“利息（违约金）未付”改为“利息未付”） | 3/0 |
| b57-amount-check.test.ts | 34/0 |
| b57-amount-reconcile.test.ts | 8/0 |
| docx-engine b34-revise-fidelity（样式计数 6→7、xf 7→8） | 17/0 |
| docx-engine b41-xlsx-read / b35-xlsx-print / render-html | 2/0、3/0、4/0 |
| kernel b41-xlsx-edit / import-xlsx / review-tables / skills-contract / privacy-residency / b42-tools-end-to-end / tools-labor / tools-court-fee / s6-formats / b41-fact-refs / b41-review-coverage / v9-defects / b43-followup-edit / artifact-citations / docx-revise / tools-deadline / tools-law-article / prompt-text-names | 全部 0 败 |

- `npx tsc -b tsconfig.check.json`：只剩 `packages/tokenizer/test/v10-address-admin.test.ts(61)` 一处，是另一位开发者的文件，与本项无关。
- 全量 478 个用例文件没有跑。

## 4. 遗留风险与没做的
1. 没有在 Excel、WPS 实机打开。LibreOffice 强制重算 132 个公式、日期格识别都已通过。
2. `accrual` 缺省仍是 interest（为了兼容旧调用）。模型给逾期付款违约金漏写 `accrual: "penalty"` 时，表里会标“利息”，并按利息先冲抵。方法和工具说明都已强调。若要彻底避免，可以改成“有 rate 的本金必须写 accrual”，但这会改变旧调用，需要拍板。
3. 总上限的适用对象：口径里有违约金时只用于违约金，没有时用于利息；两者都有时只约束违约金（写进了 assumptions）。上限到达日仍按日均摊推算，没有扣除逐笔上限的截断。
4. 待核日期只算“全按最早”和“全按最晚”两端。几个待核日期混合组合不算，展开后计入 6 个口径的上限。
5. `loss_rate` 的损失是把违约金的 rate 换掉后重跑得出的。`as_interest` 口径下，两次重跑的基数路径不同（违约金冲抵改变了本金余额），比较的是各自口径下的数。
6. `penalty_fixed` 缺省计入加倍部分基数，是新口径，依据法释〔2014〕8 号第一条，条文没有经法规库核对，请拍板。
7. 回看接入新增不一致（主会话补充第 2 项）只做了纯函数和用例，`executor.ts` 没有动。
8. 只改截止日，末段跟着重算；期间另有付款、利率调整，或截止日改到末段起算日之前（日数变成 0 或负数），都要重新调用工具。这一点已写进“参数与假设”的最后一行。
9. 共享文件：`registry.ts`、`review.ts`、`labor-dispute`、`labor-arbitration-draft` 都用 Edit 精确改了一处，或用脚本精确替换了 calc.ledger 段。其他开发者在同一文件的改动没有被覆盖（diff 已看过）。

## 5. 追加：calc.labor kind=overtime（加班费与加班费差额）

- **根因**：加班费没有计算工具，方法让模型按工作准则第 4 条人工核算。真实复测里，劳动卡的加班小时由模型手工汇总，台账 144 小时被加成 152 小时；5 张劳动卡都要算加班费差额。
- **新文件 `packages/kernel/src/tools/tools/labor-overtime.ts`**：
  - `calcOvertime` 逐月计算：
    - 小时工资 = 基数 ÷ 计薪天数（缺省 21.75）÷ 每日小时（缺省 8），先四舍五入到分；
    - 各类加班费 = 小时 × 小时工资 × 倍数（缺省 1.5 / 2 / 3，`multiples` 可改），四舍五入到分；
    - 应付 = 各类之和；差额 = 应付 − 已付，已付超过应付的该月按 0 计，并标注多付多少、不抵其他月份；
    - 部分月份录了已付、部分没录的，没录的标“本月已付未录入，按 0 计”。
  - 小时数按百分之一小时的整数相加，不会出现浮点尾差。
  - 舍入用现有的 `roundHalfUpCents`。
  - assumptions：
    - 计薪天数 21.75 天。法规库没有这份通知，只写“原劳动和社会保障部通知口径”，不写文号。
    - 倍数依据劳动法第四十四条，条文已与法规库原文核对。
    - 休息日已补休的不计。
    - 基数口径由调用方在 `base_basis` 声明。
  - `overtimeSheet` 出带公式的计算表：
    - 公式：小时工资 `ROUND(基数/21.75/8,2)`；各类 `ROUND(小时*小时工资*倍数,2)`；应付为各类之和；差额 `MAX(0,应付−已付)`（没有已付列时等于应付）；合计行用 SUM。
    - 只出用到的加班类别；没有任何一个月录入已付时不出已付列。
    - 表末附计算口径。
- **成表方式与要求不同（需要你知道）**：calc.labor 的副作用类别是 `read`、资源是 `pure`；问答模式的令牌只授予 `read`（`identity.ts:63`）。如果按要求让 calc.labor 在给了 title 时直接成表，就得把它改成 `write_draft`，问答模式会因此失去整个 calc.labor。让只读工具写成果也不符合锁文件“副作用如实申报”的原则。
  - 所以我没有给 calc.labor 加 title，改为给 `xlsx.render_table` 加了可选的 `computed: [{ tool: "calc.labor", name, params }]`。
  - 内核用与 calc.labor 同一个函数算出结果，写成带公式的工作表，排在模型写的 sheets 之后；只有计算表时 sheets 写空数组。
  - 表带公式，所以 `xlsx.edit_cells` 自动拒绝逐格改这张表。
  - 改动：`review.ts` 的 `xlsxRenderTable` 入口加 computed 处理与 `computedSheets` 函数，另加一行 import。
- **schema 与锁文件**：
  - `registry.ts`：calc.labor 的 description 加了 overtime 一段，`kind` 加 overtime，新增 `months`（`OVERTIME_MONTH_SCHEMA`）、`divisor_days`、`hours_per_day`、`multiples`、`base_basis`，版本 2→3；invoke 分派到 `calcOvertime`。
  - `xlsx.render_table` 的 description 与 schema 加 computed，版本 1→2。
  - 用主会话的 `sync-lock.mjs` 只同步了 `calc.labor` 和 `xlsx.render_table` 两项。后者也必须同步：它的 schema 改了，不同步锁文件就会被停用。之后跑了 `npm run build:tool-manifest`，锁文件检查返回空。
  - `CALC_RESULT_TOOLS` 已含 calc.labor，overtime 的结果会作为金额勾稽的出处，代码不用改。
- **方法**（劳动三处都用 Edit 精确替换，改前重读）：
  - `labor-dispute/SKILL.md`：第 70 行（加班费改用 overtime，小时数不自己合计）、第 90 行工具表。
  - `labor-arbitration-draft/SKILL.md`：第 82 行、第 112 行工具表、第 143 行自检（“手工计算的过程（仅加班费等没有工具的项目）”→“人工核算的过程（仅没有计算工具的项目）”）。
  - `labor-dispute/references/claim-checklist.md`：加班费计算行、计算要求。
  - `amount-calc/SKILL.md`：“不覆盖”一行去掉加班费，改为指向 overtime。
  - 跑了 `npm run build:skills`（33 个方法、53 个文件）。
- **用例**（加在 `packages/kernel/test/b58-calc-ledger.test.ts`，现共 17 条，17 过 0 败）：
  1. 三个月手算样例：
     - 3 月：小时工资 50 元，工作日 1,500 元，休息日 1,600 元，已付 1,000 元，差额 2,100 元；
     - 4 月：小时工资 51.72 元，工作日 2,366.19 元，法定休假日 1,241.28 元，应付 3,607.47 元，已付 4,000 元，差额 0，标注多付 392.53 元；
     - 5 月：93.5 小时，7,012.50 元，标注已付未录入；
     - 合计：工作日 144 小时、休息日 16、法定休假日 8，共 168 小时；应付 13,719.97 元，已付 5,000 元，差额 9,112.50 元。
  2. 休息日已补休（不填小时）不计；计薪天数 20.83 时小时工资 52.21 元、应付 1,566.30 元；月份格式错、月份重复、基数为 0 均拒收。
  3. 成表：列头只出用到的类别；小时工资、各类加班费、MAX 差额、SUM 合计都是公式；清零缓存后求值器逐格算回原数。
  4. 经本机端点：calc.labor overtime 通过 schema 校验；`xlsx.render_table` 的 computed 成表，读回有公式、交付前检查通过；computed 写的 kind 不是 overtime 时被拒收。
- **LibreOffice**：4 个月（含基数 12,345.67 元、17.25 小时等不整的数）的加班费表，缓存清零后强制重算，33 个公式 0 处不符。
- **其他回归**：tools-labor、b57 四个文件、skills-contract、review-tables、b41-xlsx-edit、b42-tools-end-to-end、v9-defects、s6-formats、privacy-residency、b39-facts-timeline、b41-review-coverage、b35-shrink、b35-deliverable-check、run-mode-gates、b43-followup-edit、b44-retry-supersede、review-tools 均 0 败。`npx tsc -b tsconfig.check.json` 无错误。
  - `b41-fact-refs.test.ts` 现在 2 过 2 败，报的是 Word 对外文书里“事实 N”的检查。该文件和 `fact-refs.ts`、`deliverable-check.ts` 都是另一位开发者在改；本节开工前它是 4 过 0 败，与加班费改动无关，未处理。
- **遗留**：
  1. 基数口径（是否含奖金、津贴，约定基数是否有效，是否低于最低工资）由调用方声明，工具不判断，写进了 warnings。
  2. 多付不跨月抵扣，能否抵扣由律师判断，已提示。
  3. 综合计算工时、不定时工作制没有专门处理，需要时用 `multiples` 或调用方自行拆分。
  4. `computed` 目前只支持 calc.labor 的 overtime。
