# 文书版式与交付链路审查（agentB）

- 日期：2026-11-02；代码：分支 v9.6-b35，平台根 `.claude/worktrees/v96-b35/platform`（下文路径均相对平台根）。
- 范围：`docx.render_report`、`xlsx.render_table`、`docx.revise` 三个工具；文书引擎 `packages/docx-engine/src`（house-style、create、sanitize、xlsx、print-html）；律师界面“导出 PDF”（Electron 主进程与 Web 开发形态）。
- 方法：读源码定位 → 解包上一轮真实成果（T2 合同、T5b 意见书、T3c 修订稿/清洁稿、四份 xlsx）看 XML → 按工具参数经内核同一实现 `docxRenderReport`（`packages/kernel/src/tools/tools/docx.ts`）生成《股权转让协议》（首部、鉴于、20 条、价款表、先决条件分项、签署页、附件）与《法律意见书》（致送对象、审阅文件表、假设与声明、逐问分析、结论、建议表、签署栏），再模拟“下载”（`restyleDocx` 套函头）与“导出 PDF”（`renderDocxPrintHtml`）→ LibreOffice 转图看版面。
- 未改仓库任何文件；样本、脚本在会话暂存区（见文末）。
- 说明：本机 homebrew 版 LibreOffice 找不到中文字体，转出的图里汉字是方框；图只用来看缩进、对齐、分页、页眉页脚的位置，文字以 XML 和 render-text 输出为准。
- 严重度：阻断＝交付件不能用；严重＝律师每次都要手工返工或内容/属性与事实不符；一般＝明显不规范但可手工修；提示＝改进项或待验证。

## 总览

没有发现阻断项：生成的 Word、Excel 都能打开，抽查的元素顺序合法（没有做 XSD 全量校验），上一轮 Word 实开也已通过。问题集中在“版式不像律所出的文书、律师要手工返工”和“PDF 与 Word 不一致”两类。

| 编号 | 严重度 | 律师看到的问题 | 主要改动位置 |
|---|---|---|---|
| A-01 | 严重 | 条款编号是手打文字，插删条款后编号和互引要全文手改 | create.ts `createDocx`；house-style.ts `buildStyledDocx` 加 numbering.xml |
| A-02 | 严重 | 签署页不另起一页、各方不并列、仍首行缩进；意见书落款整块不右对齐 | house-style.ts 加分页块、签署栏块；SIGNATURE_LINE 补“日期：” |
| A-03 | 严重 | 意见书标题印成“法律意见书-主题”，正文印出“致送对象与事由”“签署栏” | client-advice SKILL.md:35；create.ts:22 |
| A-04 | 严重 | 文件作者写“经律师复核”，与事实不符；清洁稿也被改写 | house-style.ts:219；sanitize.ts:35 |
| A-05 | 严重 | Markdown 成果下载 Word 时“7*24”变“724”、算式里的乘号被吞 | house-style.ts:633 |
| B-01 | 严重 | render_report 只能写一级标题和纯文字段落：分项、引用、加粗、分页、落款都表达不了 | createDocx 前缀识别（第 1 步）；inputSchema 扩展（第 2 步） |
| C-01 | 严重 | 按意见改完合同，没有《修改对照表》文件 | structured-patch.ts:357；revise.ts 成功分支 |
| D-01 | 严重 | PDF 没有律所函头和模板页眉，页脚写死，与下载的 Word 不一致 | print-html.ts；main.cjs:656；index.ts:2018 |
| A-06 | 一般 | 首部当事人信息、鉴于各项按正文首行缩进 | createDocx |
| A-07 | 一般 | 金额列左对齐，合计行不加粗 | house-style.ts:178-195 |
| A-08 | 一般 | 合同、协议下载时也套律所函头 | index.ts:1947-1949；house-style.ts:43 |
| B-02 | 一般 | `**`、`>` 原样印出；表格格内不能换行 | registry.ts:374；docx.ts:81 |
| D-02 | 一般 | PDF 不认分页符、段前分页、与下段同页 | print-html.ts:30-55、135-137 |
| D-03 | 一般 | PDF 表头不重复、列宽与 Word 不同、无框线表被画框、金额被拆行 | print-html.ts:181-184、195 |
| E-01 | 一般 | Excel 打印时表头不重复、不横向、无筛选 | xlsx.ts `sheetXml`、`createXlsx` |
| E-02 | 一般 | 同一金额列格式混排；长号码以数字传入时丢精度 | xlsx.ts:41；review.ts:257 |
| E-03 | 一般 | 表名重复，Excel 打开要修复 | review.ts:261 |
| A-09 | 提示 | 标题与各条同为大纲 1 级；长文没有目录 | house-style.ts:94 |
| D-04 | 提示 | Web 形态没有页码；Mac 没有仿宋、楷体；字体嵌入待验证 | — |
| C-02 | 并入 A-04 | 清洁稿作者被改写为“经律师复核” | sanitize.ts:35 |

**建议的修复顺序**：
1. **一两行就能改的**：A-04 作者口径、A-05 单星号、A-03 白名单和 SKILL、A-02 第 3 步“日期：”。
2. **在 `createDocx` 一处做前缀识别、自动编号、签署页与分页**：A-01、B-01 第 1 步、A-02 第 1–2 步、A-06、A-07；打印页同时做 D-02，否则 PDF 里仍不分页。
3. **C-01 修改对照表**。
4. **PDF**：D-01、D-03。
5. **Excel 与其余**：E-01～E-03、A-08、B-02。

---

## 一、合同与法律意见书的版式（问题 1）

### A-01 条款编号全是手打文字，没有 Word 自动编号（严重）

- **律师会看到**：Word 里“第一条”“1.1”“（1）”都是正文文字。插入或删除一条后，后面所有“第N条”“N.M”和正文里的“第5.1条”“第七条”互引都要逐个手改；“插入→交叉引用”里找不到编号项。合同方法承诺“条款编号连续，可直接在 Word 中继续修改”（`content/skills/contract-draft/SKILL.md:22`），实际做不到。
- **证据**：
  - `packages/docx-engine/src/create.ts:30-31`：`if (s.heading && !STRUCTURE_HEADING.test(s.heading.trim())) blocks.push({ kind: "h1", text: s.heading }); for (const p of s.paragraphs) blocks.push({ kind: "p", runs: [{ text: p }] });`——节名和段落原样当文字写入。
  - 生成包里没有 `word/numbering.xml`。生成样本的部件只有：`[Content_Types].xml _rels/.rels docProps/core.xml word/document.xml word/_rels/document.xml.rels word/styles.xml word/footer1.xml`。
  - 上一轮 T2 合同（终版）：`numPr` 0 处，`KwlHeading1` 26 段，`KwlBody` 116 段。本轮《股权转让协议》：`numPr=0`。
- **根因**：render_report 只收纯文字，引擎也没有编号定义。
- **最小改法**：不改工具参数，在 `createDocx`（create.ts）里识别编号前缀，并让 `buildStyledDocx`（house-style.ts:525）多写一个 `word/numbering.xml`：
  - 一个 abstractNum 分三级：lvl0 用 `numFmt=chineseCounting`、`lvlText="第%1条"`、`suff=space`；lvl1 用 `decimal`、`lvlText="%1.%2"`，并加 `<w:isLgl/>`，否则会显示成“一.1”；lvl2 用 `decimal`、`lvlText="（%3）"`。各级用悬挂缩进。
  - heading 匹配 `^第([一二三四五六七八九十百零〇两\d]+)条\s*` 的，去掉前缀，挂 `numId=1 ilvl=0`。段落匹配 `^\d+\.\d+\s*` 的挂 ilvl=1；匹配 `^[（(](\d+|[一二三四五六七八九十]+)[)）]` 的挂 ilvl=2。同时在 `[Content_Types].xml` 和 `document.xml.rels` 里各加一条。
  - 只在全文“第N条”从一开始连续时启用；不连续的仍按文字写，并在返回值里提示，免得把模型写错的号悄悄改掉，与正文互引对不上。
- **改动风险**：中。
  - ① 预览、导出 PDF、令牌化视图都靠 `numbering.ts` 算编号。它已支持 `chineseCounting`（numbering.ts:129）和 `isLgl`（numbering.ts:36），但要补用例核对三级显示。
  - ② `docx.revise` 已能处理自动编号段落（第 34 批 label_notes、numbering_changes），生成件改成自动编号后，两条链路反而一致。
  - ③ 律所模板自带 numbering.xml 时，`restyleDocx` 只在原包没有编号时才放入模板的编号（house-style.ts:498-500），不冲突。
  - ④ 正文里的“第5.1条”互引仍是文字，插删后靠 docx.revise 返回的 `references` 提示。不做 REF 域：REF 域要建书签，改动大。

### A-02 签署页：不另起一页、不对齐，意见书落款整块不右对齐（严重）

- **律师会看到**：
  - 合同最后一款下面紧接“（以下无正文，为《股权转让协议》之签署页）”和签署行，都在同一页。每行像正文一样首行缩进两字，甲乙双方上下堆叠，没有左右并列的签署栏；“附件”标题也紧跟在后面。
  - 意见书末尾“江苏衡定律师事务所／经办律师：【待签发】／日期：【待签发】”和正文一样首行缩进、两端对齐，没有右对齐。
  - 上一轮 T2 合同里，模型改用表格画签署页，结果是一张带框线的数据表：首行“签署事项｜甲方｜乙方”加粗居中，跨页时还会重复表头。
- **证据**：
  - 生成样本《股权转让协议》第 75–81 段全是 `KwlBody`（样式带 `w:firstLineChars="200"`），全文 `分页符=0 pageBreakBefore=0`。转图见 `png/股权转让协议-尾部样张.png`：签署行接在 20.2 款之后，同页、缩进、上下堆叠。
  - T5b 意见书最后 3 段都是 `KwlBody`：`江苏衡定律师事务所 | 经办律师：【待签发】 | 日期：【待签发】`。本轮生成的意见书相同（第 35–37 段）。
  - `house-style.ts:641-642` 的 SIGNATURE_LINE 只认这几类整行：“…律师事务所”“（承办/经办）律师：”“具状人/答辩人/…/原告/被告”“法定代表人…：”“XXXX 年 X 月 X 日”“__年__月__日”。
  - `alignSignature`（house-style.ts:653-658）从文末倒着逐行判断，遇到第一行不匹配就停。“日期：【待签发】”不匹配，上面两行于是也不处理。合同的“甲方（盖章）：…”“法定代表人或授权代表（签字）：”也不匹配：括号在冒号前，而且正则里没有“甲方/乙方/转让方/受让方”。
  - T2 签署页的 XML 是一张数据表：`<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>…<w:rPr><w:b/></w:rPr><w:t …>签署事项</w:t>`，四边和内部都有 `w:val="single"` 框线。
  - 正文块类型（house-style.ts:23-30）没有分页块，render_report 参数里也没有。
- **根因**：引擎对落款只有一种处理，即“文末几行靠正则猜、右对齐”。没有分页，没有无框线表，也没有签署栏块。
- **最小改法**（3 可以单独先上，先解决意见书落款不右对齐）：
  1. 引擎加两种块：
     - `{kind:"pageBreak"}`，写成 `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`；
     - `{kind:"signature", parties:{label, lines[]}[]}`，画成两列无框线表（`tblBorders` 各边 `w:val="nil"`），每格一方，格内用 KwlTable 样式、左对齐、无缩进，“（签字）：”后留下划线占位。
  2. `createDocx` 识别签署页：遇到以“（以下无正文”开头的段落，这一段留在上一页末尾，后面插 pageBreak。之后的段落按“X方（盖章）：／…（签字）：／日期：”分组成各方，生成 signature 块。意见书、律师函这类“律所名＋律师＋日期”的落款仍走右对齐。以“附件”开头的节前也插分页，附件另起一页。
  3. SIGNATURE_LINE 只补“日期”类整行：`(?:签署|签发|出具)?日期[:：].{0,20}`，解决意见书、律师函落款整块不右对齐。合同各方的签署行（“甲方（盖章）：”“法定代表人或授权代表（签字）：”）交给第 2 步的签署栏处理，不加进右对齐正则：合同签署栏的惯例是各方左右并列、格内左对齐，不是整体右对齐。
- **改动风险**：低到中。
  - 正则放宽后，正文末尾的短句可能被误判为落款；已有“≤40 字、只看文末 6 行”的限制，误判面小。
  - 签署块识别只在出现“（以下无正文”时启用，不影响起诉状等文书。
  - PDF 打印页要同时支持分页（见 D-02），否则 PDF 里签署页仍不另起一页。

### A-03 意见书印出“法律意见书-主题”式标题和“致送对象与事由”“签署栏”结构标签（严重）

- **律师会看到**：
  - 意见书首行大标题是“法律意见书-晟澜公司保证效力及补救”，带连字符，像文件名，而不是“关于……的法律意见书”。
  - 正文第一个黑体标题是“致送对象与事由”，最后一个黑体标题是“签署栏”。
  - 没有放文号（如“（2026）衡律意字第×号”）的位置。
- **证据**：
  - T5b 的 render-text 输出：第 1 行“法律意见书-晟澜公司保证效力及补救”，第 2 行“致送对象与事由”；落款前一段是“签署栏”（`KwlHeading1`）。本轮生成样本相同。
  - `content/skills/client-advice/SKILL.md:35` 要求“法律意见书：title `法律意见书-<主题>（草稿）`”；:57、:65 把“致送对象与事由”“签署栏”列为节。
  - `create.ts:22` 的 STRUCTURE_HEADING 只认 `落款|落款与联系方式|署名|签署|签字|签名|当事人|当事人信息|当事人基本情况|首部|尾部|结尾|结尾部分`，不含“签署栏、签署页、致送对象与事由”。
  - 同一个 title 有两个用途：`packages/kernel/src/tools/registry.ts:416` 用作文件名 `` filename: `${title}.docx` ``，`create.ts:27-28` 又把它印成文书标题（KwlTitle）。
- **根因**：title 同时当文件名和印出来的标题；结构性节名靠白名单过滤，方法（SKILL）和白名单不同步。
- **最小改法**：
  1. client-advice SKILL.md:35 改为：“法律意见书：title 写正式标题‘关于××的法律意见书’；第 1 部分、第 9 部分的 heading 写空字符串”。
  2. create.ts:22 的 STRUCTURE_HEADING 补 `签署栏|签署页|签字页|签章页|致送对象|致送对象与事由`。
  3. （可选）render_report 加可选参数 `filename`，registry.ts:416 改用 `p.filename ?? title`；再加可选 `doc_no`，印在标题下一行，居中。
- **改动风险**：低。STRUCTURE_HEADING 要求整串精确匹配，不会误伤正文标题。改 SKILL 后要按现有流程重建 `content/skills/dist` 并验签；加参数要同步工具清单锁。

### A-04 文件属性作者写“AI 辅助起草，经律师复核”，生成时就写入，清洁稿还覆盖原作者（严重）

- **律师会看到**：
  - Word“文件→信息→作者”显示“Kimi Work 法律行业发行版（AI 辅助起草，经律师复核）”。草稿刚生成、律师还没看，文件已声称“经律师复核”。上一轮律师已经指出这一点。
  - 修订链路的清洁稿作者也被改成这一串，而同一次生成的修订稿作者仍是原作者。
  - 文件的“标题”属性为空。
- **证据**：
  - `house-style.ts:219`：`<dc:creator>Kimi Work 法律行业发行版（AI 辅助起草，经律师复核）</dc:creator>`；`sanitize.ts:35`：同一串。
  - T3c 修订稿 core.xml 是 `<dc:creator>叶澄</dc:creator>`，T3c 清洁稿是 `<dc:creator>Kimi Work 法律行业发行版（AI 辅助起草，经律师复核）</dc:creator>`。
  - 生成样本的 core.xml 只有 creator、空的 lastModifiedBy 和 category：没有 `dc:title`，没有 `dcterms:created/modified`，也没有 `docProps/app.xml`。
  - 与产品自己的说法矛盾：
    - `packages/kernel/src/executor/deliverables.ts:171`：“本意见书为 AI 辅助起草的内部草稿，未经律师复核签发不得对外使用”；
    - `packages/kernel/src/tools/tools/revise.ts` 登记清洁稿时的 manifest.note：“含律师尚未逐条确认的修改”；
    - `props.ts:5` 的 `scrubDocProps` 用的是不带“经律师复核”的“Kimi Work 法律行业发行版”。
  - 全仓只有 house-style.ts:219 和 sanitize.ts:35 两处出现这串文字，没有用例断言它。
- **根因**：生成标识被写成了“已复核”的状态声明，而且在生成时写死。
- **最小改法**：
  - house-style.ts:219 和 sanitize.ts:35 改成“Kimi Work 法律行业发行版（AI 辅助生成）”。AI 标识仍保留，满足 sanitize.ts:4 注释里的 AIGC 标识要求。
  - `coreXml()` 增加 `<dc:title>`（把 title 从 `createDocx` 经 `createStyledDocx → buildStyledDocx` 传进去）和 `<dcterms:created xsi:type="dcterms:W3CDTF">`。
  - 要体现复核状态的，在下载导出时（`packages/kernel/src/api/index.ts:1943` 起）按成果状态写 `cp:contentStatus`（“草稿”或“已复核”），不写进作者。
- **改动风险**：低。

### A-05 Markdown 转 Word 时单个星号被当成斜体记号删掉：“7*24小时”→“724小时”（严重）

- **律师会看到**：Agent 的 Markdown 或文本成果点“下载 Word”后，“提供7*24小时服务，5*8小时响应”变成“提供724小时服务，58小时响应”，“违约金=本金*0.05%*逾期天数”变成“违约金=本金0.05%逾期天数”。没有任何提示，数字和算式被悄悄改了。
- **证据**：
  - `house-style.ts:633`：`.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2")`。
  - 样本脚本实测：
    - `inlineRuns('提供7*24小时服务，5*8小时响应') → "提供724小时服务，58小时响应"`；
    - `markdownToBlocks("违约金=本金*0.05%*逾期天数") → "违约金=本金0.05%逾期天数"`。
  - 调用处：`packages/kernel/src/api/index.ts:1952`（.md/.txt 成果“下载 Word”）和 `:2008`（版式样张）。
- **根因**：把成对的单星号一律当斜体记号删掉，没要求星号外侧是词边界。
- **最小改法**：删掉单星号斜体规则（法律文书几乎不用斜体）。如果要保留，改成只在星号外侧不是字母、数字、汉字时才认：`/(^|[^\p{L}\p{N}*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\p{L}\p{N}*])/gu`。补用例：`7*24`、`本金*0.05%*天数`、`*强调*`。
- **改动风险**：低，只影响 Markdown 导出路径。

### A-06 首部当事人信息、鉴于各项按正文首行缩进两字（一般）

- **律师会看到**：标题下“转让方（以下简称“甲方”）：……／统一社会信用代码：……／住所：……”每行都首行缩进两字，和正文段落没有区别；各方之间没有间隔，“鉴于：”及其各项也一样缩进。律所合同的常见版式是首部顶格成块、各方之间空一行。
- **证据**：生成样本《股权转让协议》第 1–13 段全是 `KwlBody`（house-style.ts:98：`<w:ind w:firstLineChars="200" …/>`）；T2 首部相同；转图见 `png/股权转让协议（下载版·套函头）.png`。
- **根因**：render_report 的段落只有一种样式。
- **最小改法**：
  - 在 `createDocx` 里，对标题之后、第一个非空 heading 之前的段落，凡是不超过 60 字、匹配 `^[^，。；]{1,24}[:：]` 的“字段：值”行，改用不缩进的段落：块上加 `plain:true`，写 pPr 时加 `<w:ind w:firstLine="0" w:firstLineChars="0"/>`。
  - 遇到以“X方／转让方／受让方…（以下简称”开头的行，在它前面加 `<w:spacing w:before="120"/>`，把各方隔开。
  - 只对非诉讼文书启用（`!isCourtFiling(title)`）；诉状首部按法院格式保持现状。
- **改动风险**：低，只作用于首部。

### A-07 表格：金额列左对齐、合计行不加粗；签署栏只能画成数据表（一般）

- **律师会看到**：价款表“金额（元）”一列数字左对齐，长短不齐，小数点对不齐；“合计”行和数据行同样式。签署栏见 A-02。
- **证据**：`house-style.ts:189` 数据格一律 `para(IDS.table, runs)`，KwlTable 样式是 `<w:jc w:val="left"/>`（:100）；T2 的 13 张表里右对齐格 0 个；本轮生成的价款表相同。
- **根因**：表格不区分列的类型。
- **最小改法**：在 `blocksToBodyXml` 的 table 分支（house-style.ts:178-195）里按列判断：某列全部非空数据格都匹配 `^[（(]?[-−]?[¥￥]?\d{1,3}(,\d{3})*(\.\d+)?%?[)）]?$`，或是“—／-”占位符，就给这列的数据格加 `<w:jc w:val="right"/>`；首格为“合计／总计／小计”的行整行加粗。
- **改动风险**：低。会影响所有生成的表格，`test/b32-table.test.ts`、`house-style.test.ts` 要补断言。

### A-08 合同、协议下载时也套律所函头（一般）

- **律师会看到**：下载的合同草稿页眉是“江苏衡定律师事务所＋地址电话＋粗横线”。合同是双方之间的文件，发给客户或对方之前要手工删掉页眉。
- **证据**：
  - `packages/kernel/src/api/index.ts:1947-1949`：`if (/\.docx$/i.test(filename) && isHouseStyled(out)) { out = isCourtFiling(filename) ? restyleDocx(out, courtFilingStyle(style), null) : restyleDocx(out, style, template); }`。
  - `house-style.ts:43` 的 COURT_FILING 只列了起诉状、答辩状、上诉状、申请书、代理词等诉讼文书。
  - `packages/kernel/src/services/doc-style.ts:59` 函头缺省为 `"auto"`；:86 `auto` 时取激活时登记的律所名称。
  - 生成的“股权转让协议（下载版·套函头）.docx”页眉文字为“江苏衡定律师事务所 地址：江苏省苏州市工业园区星湖街328号 电话：0512-6666 0000”；转图 `png/股权转让协议（下载版·套函头）.png` 可见页眉和横线。
- **根因**：导出时只按“是否递交法院”区分，没有区分律所出具的文书（意见书、律师函、备忘录）和当事人之间的文书（合同、协议、章程、决议）。
- **最小改法**：
  - house-style.ts 加 `isPartyDocument(filename)`：匹配 `/(合同|协议|章程|决议|承诺函|授权委托书)/`，但排除 `/(意见书|审查|法律意见|备忘录|报告)/`。“增资协议审查意见书”这类文件仍要套函头。
  - 导出时对当事人文书用 `{ ...style, letterhead: null }`；有律所模板的只取样式，不取模板页眉。
- **改动风险**：低。按文件名判断可能误判，靠上述排除词兜住。

### A-09 提示：标题与各条同为大纲 1 级；长文无目录；其余版式符合惯例

- 标题样式 KwlTitle 带 `<w:outlineLvl w:val="0"/>`（house-style.ts:94），和“第一条……”同为 1 级。导航窗格第一项是文书名，各条与它平级。建议去掉标题的 outlineLvl。
- 20 条以上的合同、多问的意见书都没有目录。可在 render_report 加可选 `toc:true`，插入 `TOC \o "1-2" \h \z` 域（Word 打开时提示更新域）。
- 以下已符合惯例，不需改：
  - 正文宋体小四、1.5 倍行距、首行缩进两字、两端对齐（house-style.ts:79、93、98）；
  - 标题宋体加粗小二、居中；一级标题黑体四号；诉讼文书仿宋三号、固定行距 28 磅（:78）；
  - 页脚“第 X 页 共 Y 页”用 PAGE/NUMPAGES 域（:209-213）；
  - 表头行跨页重复、行不跨页拆开（:190）；
  - A4 纸、公文页边距；
  - 标题样式带大纲级别，导航窗格可见各条。

---

## 二、docx.render_report 的输入能力（问题 2）

### B-01 只有“一级标题＋纯文字段落＋段后一张表”，专业文书的常见结构大多表达不了（严重）

- **律师会看到**：A-01、A-02、A-03、A-06、A-07 都出自这里。下表用两份样本逐项试过：

| 常见结构 | 能否表达 | 本轮样本里的结果 |
|---|---|---|
| “第N条 标题” | 能：heading 印成黑体一级标题 | 编号是文字（A-01） |
| “N.M”款 | 只能写成段落文字 | 首行缩进两字的正文，不是悬挂缩进 |
| “（1）”项下分项 | 只能写成段落文字 | 和上一款同样缩进，看不出层级（协议第 16–18 段） |
| 二级标题（意见书“问题一”下的“（一）结论／（二）分析”） | 只能写成段落，或另起一节（变成一级标题） | “（一）结论”成了正文段 |
| 加粗的定义词 | 不能；写 `**` 会原样印出 | 协议第 16、17 段带 `**` 字面，共 4 处（转图可见） |
| 引用法条原文（缩进或楷体） | 不能；写“> ”会原样印出 | 意见书有 1 段以“> ”开头 |
| “致：××”顶格 | 不能 | 首行缩进两字 |
| 落款右对齐 | 只能靠正则猜（A-02） | 意见书落款没有右对齐 |
| 签署页另起一页、各方并列 | 不能 | 同页、上下堆叠、缩进 |
| 文号、副标题 | 不能 | — |
| 无框线表、无表头表、指定列对齐 | 不能：每张表必有表头行和四边框线，一律左对齐 | T2 签署栏被画成数据表 |
| 表格放在两段正文之间 | 能（另起一个 heading 为空的节） | 可用 |

- **证据**：
  - `registry.ts:382-404` 的 inputSchema：sections 的元素只有 `heading`、`paragraphs`（string[]）、`table`，且 `additionalProperties:false`。
  - `create.ts:30-32` 只产出 h1、p、table 三种块。引擎已有的 h2、h3、li、right、blank 块（house-style.ts:23-30），从 render_report 这条路径用不上；right 只在 alignSignature 猜中落款时才会出现。
  - 生成样本的统计：`numPr=0 分页符=0 段内**=4`；意见书 `段首“> ”=1`。
- **最小改法**（两步，先做第 1 步）：
  1. **不改参数，在 `createDocx` 里按前缀识别**（和 A-01 改同一处）：
     - “第N条”→一级编号标题；“N.M ”→二级编号段（悬挂缩进）；“（N）”“(N)”→三级编号段；
     - 以“（一）”“一、”开头、不超过 20 字且没有句号的整段→h2；
     - 以“致：”开头→顶格；以“> ”开头→引用段（左缩进两字、楷体）；
     - `**…**`→加粗 run。只认成对双星号，不处理单星号，见 A-05。
  2. **inputSchema 加可选字段**（version 升到 5）：
     - section 加 `level: 1|2|3` 和 `page_break_before: boolean`；
     - paragraphs 的元素允许写成对象 `{text, style: "plain"|"item"|"quote"|"right"|"center"}`；
     - table 加 `header: boolean`（缺省 true）、`borders: boolean`（缺省 true）、`align: ("left"|"center"|"right")[]`；
     - 新增 section 级 `signature: {parties:[{label, lines}]}`。
- **改动风险**：
  - 第 1 步会改变现有文书的外观，版式用例要更新。误识别主要在以“（一）”开头的长句，用“≤20 字、无句号”限制住。
  - 第 2 步要同步工具清单锁（registry 的签名清单）和各 SKILL 的写法，影响面大，宜放在第 1 步之后。

### B-02 Markdown 记号原样印出；表格格内不能换行（一般）

- **律师会看到**：
  - 模型按习惯写 `**“交割日”**指……`，Word 里就出现星号；写“> 法条原文”，就出现“>”。
  - 签署栏、地址等需要在格内分行的内容被压成一行，例如“签字：____ 日期：____”挤在一起。
- **证据**：
  - `create.ts:31` 把每个段落直接写成一个 run；生成样本 `段内**=4`，转图首页可见“（1）**“标的股权”**指……”。
  - `docx.ts:81`：`String(v).replace(/\s*[\r\n]+\s*/g, " ")`，格内换行被换成空格。
  - 工具描述（registry.ts:374-377）没有告诉模型“段落是纯文字，不要写 Markdown 记号”。
  - 上一轮 T2、T5b 真实成果里没有出现 `**`，所以发生频率待验证；但加粗定义词这个能力确实没有。
- **最小改法**：
  - registry.ts:374 的描述加一句：“段落是纯文字，不写 Markdown 记号（**、#、>）；加粗与层级由版式处理”。或者按 B-01 第 1 步，把 `**…**` 转成加粗。
  - 格内换行：`normalizeTables` 保留 `\n`，`blocksToBodyXml` 按 `\n` 把一格拆成多段。
- **改动风险**：低。

---

## 三、修订交付链路（问题 3）

### C-01 只出修订稿和清洁稿，没有《修改对照表／修改说明》文件；现有数据足够低成本生成（严重）

- **律师会看到**：按意见改完合同后，拿到的只有《原名（修订稿）》和《原名（清洁稿）》两个 Word。客户或合伙人常要的“改了哪几条、原文怎么写、现在怎么写、为什么改”的对照表，只出现在对话的最终答复里，要律师自己复制整理成文件。
- **证据**：
  - `content/skills/doc-revise/SKILL.md:15` 写的是 `outputs: [修订稿.docx, 清洁稿.docx]`；:83-85“输出规格”只有修订稿、清洁稿、批注；:71 第 11 步的“修改清单”只写进最终答复。
  - `packages/kernel/src/tools/tools/revise.ts` 成功分支只登记两份成果，返回值是 `{status, applied, revision, clean, …numberingNotes}`，没有说明文件。
  - 另一个方法 contract-redline 能写《修订说明（致客户／致对方）》（`content/skills/contract-redline/SKILL.md:4、15`），但它读的是审查工作台里已接受的风险卡，和 docx.revise 的补丁不相通。走“按意见直接改”这条路，就拿不到修订说明。
  - 全仓（kernel、docx-engine、desktop、相关 SKILL）搜“修改对照／修改说明”，只有 `apps/desktop/src/lib/scenarios.ts:682` 把这两个词路由到 contract-redline。
- **现有数据**（都在内核里，不用模型再写）：
  - `structured-patch.ts:208`：原件逐段原文 `paragraphs`；
  - `structured-patch.ts:256-299`：每条补丁的落点 `spans`（段落序号、起止位置、旧文、新文、是否段后插入）；
  - `revise.ts` 里的 `previewChanges(paragraphs, spans)`：按段算出“改前整段／改后整段”；
  - 补丁本身的 `comment`（修改理由）和 `paragraph_hint`；
  - 条款号：`docxListLabels(原件)`（numbering.ts:217）算自动编号，手打编号取段首；
  - 编号顺延 `numbering.renumbered`，以及仍写旧号的互引 `numbering.references`。
  - 目前 `paragraphs` 和 `spans` 只在试写（dry_run）分支返回（structured-patch.ts:323），正式写入分支（:357）只返回 `preview`（锚点和新文的还原文本）。
- **最小改法**（约 60 行加 1 个用例）：
  1. `structured-patch.ts:357` 的 applied 返回值里，像 :323 一样带上 `paragraphs, spans`。两者都已算好，只是没返回。
  2. `revise.ts` 成功分支里，在登记清洁稿之后：
     - 用 `previewChanges(r.paragraphs, r.spans)` 得到每段的改前和改后，配上条款号（labels 或段首编号）和对应补丁的 comment，拼成表格行：`序号｜条款｜修改前｜修改后｜修改理由`；段后插入的新条款，“修改前”写“（新增）”。
     - 表前一段写文件名、修改处数；表后一段写编号顺延情况，以及 references 里仍写旧号的互引。
     - 调 `createDocx("《原文件名》修改对照表", sections)` 生成，套律所版式；登记为 `kind:"agent_report"`（已在 `executor.ts:1214` 的 WORD_ARTIFACT_SQL 里，不用新增种类），文件名“原文件名（修改对照表）.docx”。
     - 返回值加 `notes: {artifact_version_id, filename}`。
  3. doc-revise SKILL.md 的 outputs 和第 5 节加上这一项，并写明：“修改理由”就是批注文字，发给对方前要先删减。
- **改动风险**：低到中。
  - ① 修订稿存的是原文（真名），对照表与它同一口径存原文，不经模型、也不进工具返回值，不扩大暴露面。但要确认“导出时按令牌表还原”对已是原文的文件不出错（render_report 的成果存的是代号）。
  - ② 每次修订多一份 Word 成果，要核对执行态的“主交付物”判定，不能把对照表误认为主交付物（doc-revise 的主交付物是修订稿）。
  - ③ 表格超过 300 行时整份不生成（docx.ts 的 TABLE_MAX_ROWS）；REVISE_MAX_PATCHES 是 200，不会触发。

### C-02 清洁稿作者被改写为“…经律师复核”（并入 A-04）

- T3c 清洁稿的作者被改成“Kimi Work 法律行业发行版（AI 辅助起草，经律师复核）”。修订稿 manifest 自己写着清洁稿“含律师尚未逐条确认的修改”，两处说法矛盾。改法见 A-04（sanitize.ts:35）。

---

## 四、PDF 导出与预览一致性、Excel 附件（问题 4）

**实现方式（已核对）**：
- 界面“导出 PDF”（`apps/desktop/src/pages/Review.tsx:110、265`）调用 `api.exportArtifactPdf`（`apps/desktop/src/api.ts:859-877`）。
- 桌面形态：preload `kwl:export-pdf` → 主进程（`apps/desktop/electron/main.cjs:629-661`）向内核要 `artifacts.print_html`（`packages/kernel/src/api/index.ts:2018-2031`）。内核先按“下载 Word”同一份文件（还原真名、套版式），再用 `renderDocxPrintHtml`（`packages/docx-engine/src/print-html.ts`）排成 HTML。主进程在禁用脚本、拦截外部请求的隐藏窗口里调用 `printToPDF`，写到律师选定的位置。
- Web 开发形态（没有 `window.zrKernel`）：打开 blob 页面后调用 `window.print()`，由浏览器“存储为 PDF”（api.ts:867-876）。
- 修订稿不能导出 PDF，界面会提示改用清洁稿（index.ts:2021），这一点正确。
- 打印页大小已核对：200 条款的长合同，data: URL 约 35 万字符，远低于 Chromium 2MB 的 URL 上限，不构成问题。

### D-01 PDF 丢掉页眉（律所函头、模板页眉），页脚一律“第X页共Y页”，与下载的 Word 不一致（严重）

- **律师会看到**：
  - 同一份法律意见书，下载的 Word 页眉有“江苏衡定律师事务所＋地址电话＋横线”，导出的 PDF 没有页眉。
  - 律所上传了带徽标页眉、自定义页脚的模板，PDF 里也看不到；设置里关掉页码，PDF 照样有“第X页共Y页”。
  - 应用内预览不套版式（index.ts:1943 注释“预览不套”），于是预览、Word、PDF 三者的页眉各不相同。
- **证据**：
  - `print-html.ts:157` 只读 `word/document.xml`、`word/styles.xml`、`word/numbering.xml`，不读 header/footer 部件。
  - `main.cjs:655-656` 页眉写死为空：`headerTemplate: "<span></span>"`；页脚写死为“第 <span class="pageNumber"></span> 页 共 <span class="totalPages"></span> 页”。
  - 样本脚本：对套了函头的《法律意见书（下载版·套函头）.docx》调用 `renderDocxPrintHtml`，输出 `含函头地址行? false`，打印页见 `法律意见书-打印页.html`。
- **根因**：打印页只排正文，页眉页脚由主进程统一写死。
- **最小改法**：
  - `renderDocxPrintHtml` 增加返回或导出一个函数：从 `document.xml.rels` 找到缺省页眉、页脚部件，把其中的段落排成两段小 HTML（文字、居中或对齐、字号、下边框）。PAGE、NUMPAGES 域换成 `<span class="pageNumber">`、`<span class="totalPages">`。
  - `artifacts.print_html` 返回 `{html, header_html, footer_html}`，main.cjs:655-656 改用这两段；文件没有页脚时 `displayHeaderFooter` 只出页眉。
  - 页眉里的徽标图片要转成 data: URI 写进模板，并核对打印会话的请求拦截（main.cjs:650 只放行 `data:text/html`）会不会挡掉它（待验证）。
- **改动风险**：中。Chromium 页眉页脚模板的样式能力有限（不继承页面 CSS，要写内联样式），徽标和横线需要实测。

### D-02 PDF 不认分页符、段前分页、与下段同页：签署页会并到上一页（一般）

- **律师会看到**：上传的合同常在签署页前插分页符。它的清洁稿导出 PDF 后，签署页接在正文最后一款下面，不另起一页。黑体条款标题也可能单独落在页末。
- **证据**：
  - `print-html.ts:135-137`：`<w:br\b[^>]*\/>` 一律换成 `"\n"`，包括 `w:type="page"`。
  - `pFmt`（:30-55）只取对齐、缩进、行距、段前段后，不处理 `w:pageBreakBefore`、`w:keepNext`、`w:keepLines`。
  - 本产品生成的标题样式带 `<w:keepNext/>`（house-style.ts:95-97），在 PDF 里失效。
- **最小改法**：
  - `runsHtml` 遇到 `w:type="page"` 时结束当前段，插入 `<div style="break-before:page"></div>`；
  - `pFmt` 读 `pageBreakBefore`→`break-before:page`，`keepNext`→`break-after:avoid`，`keepLines`→`break-inside:avoid`（样式里的也要合并，styleTable 已有合并逻辑）。
- **改动风险**：低。

### D-03 PDF 表格：不重复表头、不按 Word 列宽、无框线表被画框，`break-all` 会把金额和编号从中间拆开（一般）

- **律师会看到**：
  - 跨页的证据目录、价款表在 PDF 第二页起没有表头（Word 里有）；
  - 列宽由浏览器自动分配，和 Word 不同；
  - 原件里无框线的签署栏表格在 PDF 里被画上框线；
  - 窄列里的“45,000,000.00”“HZ-ZZ-8000”可能被拆成两行。
- **证据**：
  - `print-html.ts:181-184` 输出 `<table><tr>…</tr></table>`，没有 `<thead>`、没有 `<colgroup>`；样本打印页 `<thead>? false  <col>? false`。
  - `print-html.ts:195` 写死 `td{border:0.5pt solid #000;…vertical-align:top}`，Word 生成件是 `w:vAlign w:val="center"`（house-style.ts:190）；同一行还有 `p{…word-break:break-all}`。
- **最小改法**：
  - 带 `<w:tblHeader/>` 的开头几行放进 `<thead>`（Chromium 打印时每页重复 thead）；
  - 由 `w:tblGrid/w:gridCol` 生成 `<colgroup><col style="width:…pt">`，并加 `table{table-layout:fixed}`；
  - 按 `w:tblBorders`、`w:tcBorders` 写框线，`nil` 或 `none` 就不画；读 `w:vAlign`；
  - `word-break:break-all` 改为 `overflow-wrap:anywhere`：汉字照常逐字换行，西文和数字只在放不下时才拆。
- **改动风险**：低。

### D-04 提示：Web 开发形态没有页码；macOS 没有仿宋、楷体；字体嵌入待验证

- Web 开发形态（api.ts:867-876）走浏览器打印：打印页没有页码页脚，浏览器还会默认加上自己的页眉页脚（标题、blob 地址、日期），要律师手动取消勾选。只影响开发和演示。
- 本机 `/System/Library/Fonts` 及 Supplemental 下只有 Songti.ttc、STHeiti，没有仿宋、楷体。`fontStack`（print-html.ts:104-106）在 macOS 上会回退到宋体，所以诉讼文书（仿宋三号）在 Mac 上导出的 PDF 是宋体。Windows 默认自带仿宋、楷体，不受影响。
- Chromium `printToPDF` 一般按子集嵌入字体，但宋体等字体的嵌入许可位可能导致退化成图形字形；本机没有 pdffonts，未验证。建议在 Windows 实机导出后用 `pdffonts` 核对字体是否为 Embedded Subset（待验证）。

### E-01 Excel 没有打印设置：打印时表头不重复、不横向、不缩到一页宽，也没有筛选（一般）

- **律师会看到**：8 列的证据目录、尽调清单直接打印时，A4 纵向，列被拆到两页，第二页起没有表头；大表也没有筛选按钮。
- **证据**：
  - `xlsx.ts:80-82` 的工作表只写了 `sheetViews`（冻结首行）、`cols`、`sheetData`，没有 `pageSetup`、`pageMargins`、`headerFooter`、`autoFilter`；workbook 里没有 `definedNames`。
  - 生成样本 `pageSetup? false  Print_Titles? false  autoFilter? false`；上一轮 D1、T1b、T6b 的计算明细和 T1b 证据目录也都是 `pageSetup False`。
- **最小改法**（`sheetXml` 与 `createXlsx`）：
  - `<worksheet>` 第一个子元素写 `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`；
  - `</sheetData>` 之后依次写：
    - `<autoFilter ref="A1:{末列}1"/>`
    - `<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`
    - `<pageSetup paperSize="9" orientation="{列数>5 ? landscape : portrait}" fitToWidth="1" fitToHeight="0"/>`
    - `<headerFooter><oddFooter>&amp;C第 &amp;P 页 共 &amp;N 页</oddFooter></headerFooter>`
  - workbook 加 `<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="i">'表名'!$1:$1</definedName>…</definedNames>`。有 autoFilter 的，再加隐藏的 `_xlnm._FilterDatabase`。
- **改动风险**：低。但子元素必须按 CT_Worksheet 的顺序写，否则 Excel 会报修复。要补一个按 XSD 顺序校验的用例（此前 PPT 交付已出过同类问题）。

### E-02 数字格式逐格判断：同一金额列混排“9800／10,000／3,000.50”；长号码按数字传入会丢精度（一般）

- **律师会看到**：
  - 计算明细的“金额（元）”一列里，9800 显示为“9800”，10000 显示为“10,000”，3000.5 显示为“3,000.50”；整数金额不显示两位小数。
  - 以文字传入的金额（“26,800.50”）左对齐，不能求和。
  - 身份证号、银行账号若以数字传入，末几位会变（320505199001011234→320505199001011260），并显示成千分位。
- **证据**：
  - `xlsx.ts:41`：`numStyle = (n) => (!Number.isInteger(n) ? 4 : Math.abs(n) >= 10000 ? 3 : 5)`，按单元格判断，不按列。
  - 生成样本的单元格：`B2 s="5" 9800`、`B3 s="3" 10000`、`B5 s="4" 3000.5`、`B6 t="inlineStr" 26,800.50`、`B7 s="3" 320505199001011260`。
  - 内核 `packages/kernel/src/tools/tools/review.ts:257` 对有限数字一律原样放行。
  - 上一轮四份 xlsx 样本没有出现同列混排，真实发生频率待验证。
- **最小改法**：
  - `sheetXml` 先按列定格式：表头含“金额、元、价款、本金、利息、费”，或该列出现过小数的，整列数字统一用 numFmt 4（`#,##0.00`）；表头含“序号、编号、期次、天数、年份”的，整列用 0；其余照旧。
  - 金额列里的文字格，匹配 `^-?\d{1,3}(,\d{3})*(\.\d+)?$` 的转成数字。
  - review.ts:257 遇到绝对值 ≥ 1e15 的整数，像 docx 拒收小数那样拒收，并提示“长号码（身份证号、账号）写成文字”。
- **改动风险**：低。按表头判断有误判可能，只影响显示格式，不影响取值。

### E-03 工作表重名不去重，Excel 打开时报错要修复（一般）

- **律师会看到**：模型给两个表起同名（如都叫“计算明细”），或两个长名前 31 个字相同，Excel 打开时提示“发现不可读取的内容”，要修复后才能看。
- **证据**：
  - `review.ts:261` 对表名只做去非法字符和截到 31 字，不去重；`xlsx.ts:100-102` 原样写入。
  - 生成样本的 workbook：`<sheet name="计算明细" sheetId="1" …/><sheet name="计算明细" sheetId="2" …/>`。
  - Excel 要求表名不分大小写唯一，这是已知约束；本机没有 Excel，未实开验证。
- **最小改法**：review.ts:261 之后按小写去重，重名的加“（2）”后缀，保证总长不超过 31 字；去掉首尾的单引号。
- **改动风险**：低。

---

## 附：样本与脚本

本轮生成，均在会话暂存区：
- 生成与分析脚本：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/gen.mts`（在平台根目录下用 `node <路径>` 运行；经内核 `docxRenderReport` 生成，再调 `restyleDocx`、`renderDocxPrintHtml`、`createXlsx`）
- 《股权转让协议》（工具原样生成）：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/股权转让协议.docx`
- 《股权转让协议》（模拟下载，套函头）：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/股权转让协议（下载版·套函头）.docx`
- 合同尾部样张（第二十条、签署页、附件）：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/股权转让协议-尾部样张.docx`
- 《法律意见书》（工具原样生成）：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/法律意见书-晟澜公司对外担保效力.docx`
- 《法律意见书》（模拟下载，套函头）：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/法律意见书（下载版·套函头）.docx`
- 意见书尾部样张：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/法律意见书-尾部样张.docx`
- 导出 PDF 用的打印页（由下载版生成，可见页眉丢失）：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/法律意见书-打印页.html`
- Excel 样张（金额列混排、长号码、重名表）：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/计算明细-样张.xlsx`
- LibreOffice 转图（中文显示为方框，只看版面）：
  - `/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/png/股权转让协议（下载版·套函头）.png`
  - `/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/png/股权转让协议-尾部样张.png`
  - `/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/png/法律意见书-尾部样张.png`
- 上一轮样本按 Word 打开的样子输出的文字：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/T2.txt`、`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/da807f02-9910-4291-9ca3-eb352c36ada9/scratchpad/agentB/T5b.txt`

引用的上一轮真实成果，在 `/Users/wangzeyu/Documents/Coding/Kimi Work Legal/research/2026-11-01-V9.5核心业务深度修复/samples/`：
- T2-SaaS订阅服务与数据处理协议（终版）.docx
- T5b-法律意见书（草稿·未退回计划）.docx
- T3c-借款合同修订稿（29处全部写入）.docx
- T3c-借款合同清洁稿.docx
- D1-计算明细.xlsx、T1b-计算明细.xlsx、T6b-计算明细-民间借贷.xlsx、T1b-证据目录.xlsx

## 附：现有用例的现状

- 单独运行 `node --test --test-reporter=tap packages/docx-engine/test/house-style.test.ts packages/docx-engine/test/b32-table.test.ts packages/docx-engine/test/b33-keep.test.ts`，结果 `# tests 17  # pass 17  # fail 0`。
- 以下行为目前没有用例覆盖，改动时要补：签署页分页与签署栏；以“日期：”结尾的落款右对齐（A-02）；单星号不吞字（A-05）；作者属性的文字（A-04）；自动编号的三级显示（A-01）；打印页的页眉、thead、分页（D-01～D-03）；xlsx 的打印设置、元素顺序、表名去重（E-01、E-03）。
