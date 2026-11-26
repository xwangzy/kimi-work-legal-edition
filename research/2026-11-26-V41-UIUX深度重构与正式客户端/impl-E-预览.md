# 工作线 E 实施记录：Excel 预览根因修复与文档预览视觉（V41 第 67 批）

- 范围：`packages/docx-engine/src/render-html.ts`、`apps/desktop/src/lib/safe-preview.ts`、`apps/desktop/src/components/SafePreview.tsx`、新增 `apps/desktop/src/styles-preview.css`、`styles.css` 里 `.sp-note` 两条、内核 `artifacts.render_html`（只加字段）。
- 未提交、未推送。内核改动要**重启开发桥**才生效；界面改动已经由 HMR 生效。

## 1. 问题与根因（行号指改前文件，即 b9e46f18）

改前截图：`scratchpad/shots/before/05-deliverables-xlsx.png`——证据目录.xlsx 的“证据编号”被挤成一字一行，表格用衬线 16px、米黄底。

| # | 级 | 根因 | 位置（改前） |
|---|---|---|---|
| E1 | P0 | XLSX 渲染不读列宽 `<cols>`、行高、合并单元格 `<mergeCells>`、样式（字形、底色、边框、对齐、换行、缩进）、除日期外的数字格式、隐藏行列；输出一张没有任何宽度的平铺表格 | `render-html.ts:188-231`（`renderXlsxHtml`），单元格只取值 `:205-223`，样式表只有一行 `:229` |
| E2 | P0 | 表名与表文件按 `sheetN.xml` 的数字排序对应，不走 `xl/_rels/workbook.xml.rels` 的 `r:id`：调整过表签顺序或文件编号不连续的工作簿，表名和内容会对错 | `render-html.ts:195-199`；`PREVIEW_PARTS` 也没解压关系文件 `:186` |
| E3 | P0 | 界面给 Excel 也套了文书纸面（衬线、16px、行距 1.9、左右 40px 边距、米黄 `#fffdf9`），表格无列宽，被框架宽度压到每列一个字宽 | `safe-preview.ts:51`（`PAPER_STYLE`）、`SafePreview.tsx:19`（`paper: !!office` 对 XLSX 同样为真） |
| E4 | P1 | 所有工作表上下平铺、每张一个 h3，没有表签，第二张表要滚很远才看到 | `render-html.ts:227` |
| E5 | P1 | 共享字符串把拼音注音 `<rPh>` 的文字拼进正文；富文本格式丢失；`_x000D_` 转义原样显示（`xlsxToText` 材料导入同病） | `render-html.ts:192`、`:325` |
| E6 | P1 | 首行一律当表头 `th`（Excel 没有这个概念）；数字不按格式：66970 显示成 66970（Excel 里是 66,970），0.1+0.2 显示浮点尾数 | `render-html.ts:213-224` |
| E7 | P2 | Word 预览：米黄纸、无版心；段落对齐与首行缩进全部丢掉（标题、落款、正文缩进与 Word 不一样）；段距用浏览器缺省 1em，过松 | `safe-preview.ts:51`、`render-html.ts:107-117`、`:168` |

## 2. 改了什么

### 2.1 内核渲染（`render-html.ts`，需重启开发桥）

- **工作簿结构**：`workbookSheets()` 按 `workbook.xml` 的表签顺序 + 关系 `r:id` 找表文件；隐藏表（`state="hidden|veryHidden"`）不显示，文末如实写“另有 N 张隐藏的工作表未显示”。`PREVIEW_PARTS` 加解压关系与主题文件，仍不解压图片。
- **每张表一个 `<section class="kwl-sheet" data-sheet-name="表名">`**，界面据此做表签；表名转义。
- **样式**：解析 `styles.xml` 的字体（粗、斜、下划线、删除线、字号按缺省字号映射到 13px 等比、颜色）、底色（rgb、主题色 + tint 明暗、旧式索引色与自定义索引色、渐变取首色）、边框（thin/hair/dotted/dashed/medium/thick/double，颜色）、对齐（水平 general/left/center/right/justify/distributed/centerContinuous，垂直缺省靠下）、自动换行、缩进。每个 xf 生成一个样式类 `.kwl-grid td.xN`，边框按“分离边框模型”合成右框/下框（与右邻左框、下邻上框合并）去重成 `.bN`。
- **列宽、行高、合并**：列宽 = Excel 宽度 × 7px（100% 缩放的数字宽），缺省列宽按 `defaultColWidth/baseColWidth`；`table-layout:fixed` + `<colgroup>` 定宽，表格宽于框架就横向滚动，**不再压缩列**。行高按 `ht` 磅 × 4/3（缺省按 `defaultRowHeight`）。合并单元格用 colspan/rowspan，隐藏行列不计入跨度，被覆盖的格子不输出。
- **隐藏行列**不显示；列号（A B C…）与行号照原文（跳过隐藏的），并以 `position:sticky` 固定在框架顶边与左边；冻结窗格的前几行（≤3）跟着固定在列号下面。关了网格线的表不画网格线。
- **数字格式**（`formatNumber`/`generalNumber`，已导出供用例）：常规（≤约 10 位有效数字，去浮点尾数，过大过小用科学计数）、千分位、小数位（十进制四舍五入，1.005→1.01）、百分比、科学计数、引号与 `[$¥-804]` 货币符号、正/负/零三段与括号负数、会计格式、`[Red]` 等颜色；条件段与分数退回常规。日期沿用第 59 批逻辑（yyyy-mm-dd），**中文日期格式**（含年月日时分秒的自定义格式与内置 27–36、50–58）按原格式写（如 2026年11月9日）。布尔 TRUE/FALSE、错误值、公式文字照原样；常规对齐时数字靠右、文字靠左、布尔与错误值居中。
- **不换行文字**按 Excel 规则：不折行，靠左的长文字溢到右边连着的空格子（用 colspan，遇到有内容、有底色或边框的格子停），已用范围不够就补空列（≤40 列）；有底色的格子不溢。
- **共享字符串**：去掉 `<rPh>` 注音；富文本按段输出 `<span style>`；解 `_xHHHH_`。`xlsxToText`（材料导入）同样去掉注音。
- **上限不变**：12 张表、每表 500 行、40 列；超出写明“预览只显示每个表前 500 行、前 40 列”（原先超 40 列静默丢弃，现在也算截断）。
- **Word**：读 `styles.xml` 的段落样式（沿 basedOn、文档缺省、缺省段落样式）与段落直接格式，输出对齐（居中/右/两端）、首行缩进（字符或缇）、悬挂缩进、左缩进；修订里的旧格式 `<w:pPrChange>` 不算。样式表收紧段距（`p{margin:0 0 6px}`）、标题层级与表格（整宽、细框）。修订绿插红删、批注上标与文末列表不变。
- 输出仍是白名单：元素 `style section table colgroup col thead tbody tr th td p span`（Word 另有 `h2–h4 ins del sup ol li strong em br`），属性只有 `class style colspan rowspan data-sheet-name title value`；所有文字转义；样式里没有 url/@import（用例核对）。

### 2.2 内核接口（`api/index.ts`，向后兼容）

`artifacts.render_html` 对 XLSX 的 `summary` 加 `sheet_names`、`hidden_sheets` 两个字段，原字段不变。`artifacts.print_html` 用的是 `print-html.ts`，与预览样式不共用，未改。

### 2.3 界面（已经 HMR 生效）

- `safe-preview.ts`
  - `PAPER_STYLE`（Word）：中性浅灰画布 `#f4f3f2`（= `--bg-muted` 浅色值）上一张纯白纸（`--p-white`），细描边 `--border-subtle`、轻阴影 `--shadow-sm`，宽 794px 内随可用宽度缩、比例 210:297、内容多了往下长；页边距 72px，窄于 760px 收成 48/40px、窄于 520px 收成 28/20px；四周画布留 32/28px（窄时 24/20px、更窄 12/10px）；正文 `--font-doc` 16px / 1.75、段距 4px（主 Agent 复看后要求：起诉状首部像打印件，不再一段一空行；旧版内核输出也按这个排）。**取消米黄纸色**。
  - 新增 `SHEET_STYLE`（Excel）：白底、无边距、等线/微软雅黑/苹方 13px；附带对旧版内核输出（无 `kwl-grid` 的平铺表格）的兜底——中文不在字间断行、表头不折行、宽了横向滚动。所以**开发桥不重启、或旧内核**时“证据编号”也不再一字一行。
  - 新增 `splitSheets()`：按内核输出结构（新版 `section.kwl-sheet`、旧版 `section > h3`）拆成一张张表，样式块与表后说明每张都带上；每一份仍整份经 `buildPreviewDoc` 清洗。
  - `buildPreviewDoc` 新增可选 `sheet`、`citePrefix`：`paper` 时正文包进 `.kwl-paper`；分表显示时用 `citePrefix`（排在本表前面的各表）先数引用出现次数，引用角标的“第 n 次”与内核按整份成果数的一致。
- `SafePreview.tsx`：Excel 在框架外显示表签（`role=tablist`，表名在本机还原代号、React 按文字输出），框架里一次只放一张表；切换表签就是换一个新框架（仍按内容摘要 `previewFrameKey` 作 key，绝不原地改 srcdoc，仍只有一个 `sandbox=""` 的 iframe）。换文件回到第一张表，同一文件出新版本时留在原来那张。说明条按类型分开：“近似预览 · 以 Excel 打开为准” / “近似预览 · 以 Word 打开为准”，完整说法放悬停；非紧凑形态写全。新增 prop 为零，`DeliverablePreview`、`Review`、`RunView` 不用改。
- `styles-preview.css`（由 SafePreview 引入）：预览区改为纵向弹性布局，框架有余高时撑满；成果页右栏（`.dlp-body > .safe-preview`）里框架填满栏高（不再在画布下留一截空白，最小 320px），复核页、任务页仍是 62vh。表签条（`--bg-subtle` 底、选中白底 + `--shadow-xs`、悬停 `--bg-hover`、超长表名省略）。`styles.css` 只改 `.sp-note` 两条：最小高 32px、白底、说明单行省略。全部取令牌，无颜色字面量。

## 3. 用例与结果

| 命令（在 `platform/` 下） | 结果 |
|---|---|
| `node --test packages/docx-engine/test/*.test.ts` | 131 过 / 0 败（含新增 `b67-xlsx-preview.test.ts` 13 条） |
| `node --test apps/desktop/test/style-tokens.test.ts apps/desktop/test/b62-preview-frame.test.ts apps/desktop/test/b67-preview-sheets.test.ts apps/desktop/test/b66-material-links.test.ts` | 24 过 / 0 败（含新增 `b67-preview-sheets.test.ts` 4 条） |
| `node --test --test-name-pattern="12 张" packages/kernel/test/b41-xlsx-edit.test.ts` | 1 过（12 张表全部预览、改过的第 12 张可见） |
| `node --test apps/desktop/test/lawyer-copy.test.ts` | 过（主 Agent 报的失败：表签“（未命名）”所在的箭头函数被当成可见文字；已把表名还原挪到组件外的 `sheetLabel()`，未放宽用例） |
| `npx tsc -b tsconfig.check.json` | 0 个错误 |

新增用例（`packages/docx-engine/test/b67-xlsx-preview.test.ts`，手工工作簿 `test/fixtures/xlsx-complex.ts`，不经本产品写入器）：表签顺序与关系对应（文件编号 3/1/2）、隐藏表；列宽像素与隐藏列、列号跳过；合并标题行（跨过隐藏列）；行高、隐藏行、行号、冻结行固定；对齐/换行/缩进/字形/主题色明暗/边框/无网格线；货币、千分位、百分比、中文日期、红色负数、浮点尾数、公式文字；溢出文字与补列；富文本、注音、布尔、错误值、转义；白名单元素与属性、无外部引用；500 行 / 40 列截断说明与表名转义；数字格式单元（会计格式零与括号负数、1.005、条件段）；Word 段落对齐与首行缩进（basedOn、直接格式、pPrChange 不算）。
`apps/desktop/test/b67-preview-sheets.test.ts`：新旧两种内核输出都拆得开、表名解转义、说明附在每张表后；Word 不拆；SafePreview 表签在框架外、仍一个 `sandbox=""` 框架且按摘要换新元素；Excel 不套纸面。

按“合理变化”更新的旧用例：`render-html.test.ts`（表名改在 `data-sheet-name`；首行不再是 `th`；单元格带样式类；66970 按 `#,##0` 显示为 66,970——与 Excel 一致）、`v18-heading-levels.test.ts`（标题与段落允许带对齐/缩进的 style 属性，层级断言不变）、`style-tokens.test.ts`（纸面改核对 `--bg-muted`/`--p-white`/`--border-subtle`/`--shadow-sm`/`--p-paper-ink`，并断言不再含 `--p-paper`；新增 `SHEET_STYLE` 的令牌核对与豁免）。

## 4. 截图（scratchpad，均为本机真实数据）

目录 `/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/84fa22c5-5afe-48f4-9b72-70ab293f67eb/scratchpad/shots/e/`：

- `live-*.png`：当前开发实例（新界面 + **旧内核**输出，即开发桥未重启时）。证据目录已不再一字一行，有表签；Word 已是灰底白纸。
- `after-*.png`：真实界面 + 新内核输出（Playwright 拦截 `artifacts.render_html` 的回复，换成新渲染器对**同一成果字节**的输出；界面、清洗、隔离框架都是真实代码）——等同重启开发桥后的样子。`after-01-evidence-xlsx.png`（证据目录：列宽、冻结表头、表签）、`after-02-calc-xlsx.png`（分段计算）、`after-03/04`、`after-05-complaint-docx.png`、`after-06-opinion-docx.png`。
- `kernel-new/*.png`：新内核输出经真实 `buildPreviewDoc` 后在 680px（成果页右栏宽）与 1150px 两种宽度的框架截图，每张工作表一张。
- 复杂工作簿：`fixture-complex-sheet1.png`（合并标题、主题色表头、隐藏 D 列、换行、缩进、货币）、`fixture-complex-sheet2.png`（百分比底色、中文日期、0.3、红色负数、隐藏第 4 行、溢出补列）、`fixture-complex-sheet3.png`（富文本、无网格线、TRUE、#DIV/0!、转义）。文件在 `scratchpad/xlsx-fixtures/`：`complex-workbook.xlsx`（可用 Excel/WPS 打开对照）、`complex-workbook.kernel.html`（内核输出）、`complex-workbook-sheet{1,2,3}-*.preview.html`（经 buildPreviewDoc 的 srcdoc）。

## 5. 余项（如实）

1. **开发桥须重启**才会用新内核渲染；在此之前界面走旧输出的兜底（已不压缩列、有表签，但没有原文列宽、合并、底色、数字格式）。
2. **发现的写入器缺陷（不在本线范围，P0 候选）**：`xlsx.ts` 的 `numStyle` 把一切非整数套 `#,##0.00`，计算明细“利率数值”0.0005 在 **Excel 里显示 0.00**（已用真实文件核对 `H2 = 0.0005, s=4 → numFmtId 4`）。新预览如实显示 0.00，旧预览显示 0.0005，等于此前把问题藏住了。建议写入器对小于 1 的小数用常规或更多小数位。
3. 行高：`customHeight` 的行内容超出时 HTML 会把行撑高（Excel 会截断）；没有 `ht` 的行按内容自动长高（与 Excel 打开时自动调整行高一致）。冻结多行时若上面的行被换行撑高，下面固定行的偏移会差几像素。
4. 未做：条件格式、数据条、图片与图表、批注、超链接、文字旋转、`fill` 对齐的重复填充、分数格式（退回常规）、`[DBNum]` 中文大写数字（显示阿拉伯数字）、`centerContinuous` 跨格居中（按本格居中）、主题字体。列宽统一按 7px 数字宽换算，等线 / 宋体等非 Calibri 缺省字体与 Excel 实际像素可能差几 px。
5. 画布：框架内取不到主题令牌，Word 的灰画布在深色模式下仍是浅灰（§2.8“预览框架永远是浅色纸面”成立，“画布随主题”只在框架外成立）。
6. 成果页右栏框架已填满栏高（只在 `styles-preview.css` 用 `.dlp-body > .safe-preview` 限定，未改 DeliverablePreview 与 styles-deliverables.css）。
7. 只在 Chromium（Playwright）与开发形态核对；Electron 安装包与 Windows 未跑。
8. 为了用新渲染器渲染真实成果，经开发桥调用了 `artifacts.download`（与律师点“下载”同一接口），工作区审计里会多几条下载记录。截图期间有真实任务在跑，后几张截图里的成果列表已是新一轮任务的版本。
