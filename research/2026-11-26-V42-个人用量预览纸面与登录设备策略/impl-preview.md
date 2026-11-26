# V42 工作线：全局预览“草稿纸”与画布层次（实施记录）

> 分支 claude/kimi-legal-b68-auth-usage（worktree kimi-legal-b68），未提交，由主会话统一提交。
> 截图：`evidence/preview/{before,options,after}/`（1440×900，成果页右栏 `.dlp`，浅色 / 深色）。

## 一、预览表面盘点（阶段 1）

| # | 表面 | 位置 | 渲染方式 | 改前底色 |
|---|---|---|---|---|
| 1 | Word 成果（起诉状、审查意见书、清洁稿、修订稿含 ins/del） | 成果页右栏、执行页右栏、复核页 | 内核 `docx-engine/render-html.ts` 出白名单 HTML → 桌面 `lib/safe-preview.ts buildPreviewDoc({paper})` 清洗包装 → `SafePreview` 的 `sandbox=""` iframe | 框架内 `html,body{background:#f4f3f2}` + 白纸 `.kwl-paper`（1px #eeebe7 描边 + shadow-sm）。画布与纸只差 ~4% 亮度，几乎看不出纸 |
| 2 | Excel 成果（证据目录、计算明细、核对清单、问题清单） | 同上 | 内核 `render-html.ts` 的 `kwl-grid` + 桌面 `SHEET_STYLE`；框架外表签 `.sp-sheets` | 纯白满铺 |
| 3 | 其他 HTML 产物 | 同上 | `buildPreviewDoc()` 只套 `BASE_STYLE` | 纯白，margin 16px |
| 4 | Markdown / 文本草稿（“答复摘要”“独立复核意见”等 .md、事项页“预览.txt”） | 成果页过程文件、执行页、事项页 | `SafePreview` → `Markdown.tsx`（在父页面直接渲染，不进框架） | `.safe-preview{background:var(--bg-surface)}`，`.sp-md{padding:10px 14px}`：纯白（深色为深灰），无纸面 |
| 5 | 复核工作台文书栏 `.wb-doc`、证据原文 `.ev-text/.ev-quote` | 复核工作台 | 父页面直接渲染 | `--bg-paper`（#fffdf9 米白），整栏铺满，不属于“纸在画布上”结构 |
| 6 | 导出 PDF 打印页 | 主进程隐藏窗口 | 内核 `artifacts.print_html` → `docx-engine/print-html.ts renderDocxPrintHtml`（独立样式，`background:#fff`）→ `printToPDF({printBackground:false})` | 与预览样式完全无关 |
| 7 | 文书版式样张（设置页 `DocStyle.tsx`） | 设置 | 只给“下载样张 docx”，无应用内预览 | — |

安全约束（不放宽）：框架 CSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'; base-uri 'none'`。
CSS 渐变（`radial-gradient` / `linear-gradient`）不是资源请求，不受 `img-src` 约束；`data:image/svg+xml` 背景受 `img-src data:` 允许。两种都不需要改 CSP。

改前问题（截图 `before/`）：
- 浅色：Word 画布 #f4f3f2 与白纸几乎同色，层次弱，整片看着“一片白”；
- **深色：Word 预览框架内仍是浅灰画布，整块亮灰嵌在深色界面里，刺眼**（`before/doc-dark.png`、`page-dark.png`）；
- Excel：纯白满铺，表格之外的空白与数据区无分界；
- Markdown 草稿：直接铺在面板底色上，无纸面、无画布，与 Word 预览不是一套语言。

## 二、方案对比与打分（阶段 2）

做法：在真实成果页（ws-preview 工作区）上把各方案样式注入隔离框架（取框架的 srcdoc 加一段 `<style>` 后换新框架元素，与正式代码走同一 CSP）与父页面（Markdown 草稿），每个方案截 Word / Excel / Markdown × 浅色 / 深色。
截图：`evidence/preview/options/{A,B,C,D,E}/{doc,xlsx,md,page}-{light,dark}.png`（`page-*` 为整页）。

每项 1～5 分（5 最好；“干扰”5 = 最少干扰；“层次/辨识度”= 草稿纸与画布分不分得开、像不像本产品自己的东西）。

| 方案 | 做法 | 美感 | 长读舒适 | 专业 | 干扰 | 层次/辨识度 | 大文档滚动 | 深色 | 打印/导出隔离 | 合计（40） |
|---|---|---|---|---|---|---|---|---|---|---|
| A 纸张噪点肌理 | 暖灰画布 #ebe8e4；纸面叠 `feTurbulence` 细颗粒（data:image/svg+xml，CSP 允许） | 3 | 3 | 2.5 | 2.5 | 3 | 3.5 | 3 | 5 | 25.5 |
| B 画布点阵 + 纯白纸 | 画布 #f4f3f2 + 16px 点阵（16% 墨色）；纸 1px 描边 + 轻阴影 | 3.5 | 4.5 | 3.5 | 3.5 | 4 | 5 | 4 | 5 | 33 |
| C 纸面横线 + 页边线 | 纸面每 28px 一条浅蓝横线、左侧红色页边线 | 2.5 | 2 | 2 | 1.5 | 3 | 5 | 3 | 5 | 24 |
| D 暖灰画布 + 分层投影 | 画布 #ebe8e4；纸去描边，改“1px 环 + 近影 + 远影”三层投影 | 4 | 5 | 5 | 5 | 3.5 | 5 | 4.5 | 5 | 37 |
| **E D 的纸 + 画布极淡点阵（选定）** | 画布 #efedea + 20px 点阵（12% 墨色，深色 7% 白）；纸同 D；纸面纯白 | **4.5** | **5** | **4.5** | **4.5** | **4.5** | **5** | **4.5** | **5** | **37.5** |

（D 与 E 只差“点阵”这一层：D 最保守、E 多了“工作画布”的辨识度，而点阵只在纸外、读正文时看不到，代价几乎为零，故选 E。）

逐项判断：
- **A 噪点**：1× 屏（律所 Windows 常见 1080p 100% 缩放）上颗粒像有损压缩的脏点，纸面整体发灰、正文对比度下降，像“旧纸/扫描件”，与“正式文书”的专业感相反；SVG 滤镜首绘有栅格化成本。否决。
- **C 横线**：Word 文书的行距随字号、标题、表格变化，固定 28px 横线必然穿字、错位（`options/C/doc-light.png` 可见），还容易被误认为文件里自带的格式，属于格式误导。否决。
- **B 点阵**：方向对（点阵只在画布、纸面纯白，不碍阅读），但 16px、16% 偏密偏重，像设计工具，纸本身靠 1px 描边浮不起来。
- **D 分层投影**：最稳的“纸在桌上”层次，长时间读 A4 正文零干扰；单看略平，辨识度一般。
- **E**：取 D 的纸（三层投影，无描边，纸面纯白），画布加一层极淡、稀疏的点阵——点阵只在纸外（像制图台/工作画布），读正文时视线落在纯白纸上看不到它，换到纸边才隐约有“工作空间”的质感；深色下点阵 7% 白几乎只剩纹理感，白纸浮在深色桌面上，**同时修掉了改前深色模式整块亮灰的问题**。性能：点阵是 CSS 渐变（不是图片请求、不受 img-src 约束），根元素背景随内容滚动、合成层光栅化一次，长文档滚动无额外重绘。

Excel 单独判断：表格本身就是网格，点阵与单元格线并排是噪声 → Excel 只用画布底色（不加点阵），白色表格落在画布上，“数据到这里为止”一目了然；表后的说明文字在画布上用次级字色。

“草稿”与“成果文书”是否区分：**不以底纹区分**。理由：① 成果页右栏、执行页、复核页的表头已用文字标出“草稿 / 待复核 / 已签发”，状态不能只靠纹理传达（可达性）；② 同一份文件从草稿到签发底纹会变，反而让人以为文件变了；③ 绝大多数成果长期处于草稿态，区分收益低。真正需要区分的是**形态**：Word 成果是 A4 比例的衬线纸；Markdown 过程文本（答复摘要、复核意见等 AI 工作稿）是不定高的“便笺纸”（无 A4 比例、无衬线、随主题明暗）——同一张画布、两种纸，草稿与文书一眼可分。

## 三、实现（阶段 3，方案 E）

改动文件（均未提交）：

| 文件 | 改动 |
|---|---|
| `platform/packages/design-tokens/src/tokens.css` | **只追加 4 个新令牌**（浅色 `:root` 与深色块各一份，未改任何已有值）：`--preview-canvas`（#efedea / #161514）、`--preview-canvas-dot`（rgba(14,18,25,.12) / rgba(255,255,255,.07)）、`--preview-sheet-shadow`（Word 白纸三层投影，浅/深两套）、`--preview-note-shadow`（Markdown 便笺纸投影，浅/深两套）。名字不落在纸面类前缀里（`--bg-preview` 等纸面令牌不动），深色覆盖完整门禁通过 |
| `platform/apps/desktop/src/lib/safe-preview.ts` | `PAPER_STYLE`：画布与点阵只画在 `html`（`radial-gradient(circle, dot 1px, transparent 1.3px)`，20px 一格，偏移 10px），`body` 透明（盖掉 BASE_STYLE 的白底，避免点阵叠两层）；`.kwl-paper` 纯白、去 1px 描边改 `--preview-sheet-shadow`；`@media print` 去画布、投影与 body 内边距。新增 `PAPER_DARK_STYLE`（深色画布 + 7% 白点阵、`html{color-scheme:dark}` 让滚动条随深色、`.kwl-paper{color-scheme:light}`、投影加深；纸色不变）。`SHEET_STYLE`：表格外是画布底色（不加点阵），旧版平铺表格补白底与字色；新增 `SHEET_DARK_STYLE`（深色画布、表后说明用深色次级字色 #a9a59f）。`buildPreviewDoc` 新增 `dark` 选项，深色样式排在内核样式之后 |
| `platform/apps/desktop/src/components/SafePreview.tsx` | `useDarkUi()`：`useSyncExternalStore` + `MutationObserver` 监听 `<html data-theme>`（ui-prefs 写入），只对 Office 预览传 `dark`；`dark` 进 `useMemo` 依赖——主题一变 srcDoc 变、框架按内容摘要换新元素（沿用第 62 批“不在原框架上改 srcdoc”的约束） |
| `platform/apps/desktop/src/styles-preview.css` | 框架外：`.sp-is-doc .sp-frame, .sp-is-sheet .sp-frame{background:var(--preview-canvas)}`（载入前不闪白块）；Markdown 草稿 `.safe-preview.sp-md` 画布 + 点阵、`.sp-md > .md` 便笺纸（最宽 760px、`clamp()` 内边距随栏宽收、`--bg-surface` 随明暗、`--preview-note-shadow`）；`@media print` 全部去掉。只作用在预览容器里，不改全局 `.md`（问答等处不受影响） |
| `platform/apps/desktop/test/style-tokens.test.ts` | 手抄值核对改为新令牌（画布、点阵、纸投影、深色两套、表格画布、深色说明字色）；豁免名单加两个深色常量；断言四个框架样式常量都不含 `url(` |
| `platform/apps/desktop/test/b68-preview-canvas.test.ts`（新） | CSP 原样；点阵只在 html、不在正文祖先链；深色样式只在 Office 预览且排在内核样式后；四个常量都有打印重置；Markdown 画布只在预览容器；导出路径（print_html、printBackground:false、print-html.ts 白底）不经过预览样式 |

安全策略：**未放宽 CSP**。点阵、投影全是 CSS 渐变/阴影，不是资源请求；没有用 data: SVG（方案 A 的噪点需要 data: 图片，已否决）。真实界面跑下来框架内 0 条 CSP 报错。

改后截图：`evidence/preview/after/`
- 成果页右栏：`doc-{light,dark}.png`、`redline-{light,dark}.png`（修订稿 ins/del 颜色不变）、`xlsx-{light,dark}.png`、`md-{light,dark}.png`、整页 `page-{light,dark}.png`；
- 复核页 `review-{light,dark}.png`、执行页右栏 `run-{light,dark}.png`（同一组件，表现一致）；窄窗口 `narrow-1100-light.png`（纸内边距按原断点收小）。

## 四、导出 / 复制 / 打印隔离核对（阶段 4）

1. **下载件（docx / xlsx）**：`api.downloadArtifact` → 内核 `artifacts.download` 直接给文件字节，不经过任何预览 HTML。核对：`grep` 证实内核与 docx-engine 源码不引用 `safe-preview` 或 `design-tokens`；本次改动不触内核（`git diff --stat` 里内核文件的改动属于主会话的登录/设备工作，与本工作线无关）。真实成果经开发桥调用两次下载：
   - 民事起诉状.docx 6,335 B，两次 sha256 相同 `fdb194df…638b`（下载时还原真名并套本机版式，故与内核登记的令牌形态 sha `ac60583d…` 不同，第 29 批起即如此，与预览无关）；
   - 证据目录-锐川诉禾丰买卖合同纠纷.xlsx 6,173 B，两次相同且等于内核登记 sha256 `463cea39…cc44`（逐字节即原文件）；
   - `unzip -l` 均为 7 个部件，`unzip -p | grep -ciE "efedea|161514|radial-gradient|kwl-paper|preview-canvas"` 均为 0。
2. **导出 PDF**：安装包走主进程隐藏窗口 + 内核 `artifacts.print_html`（`docx-engine/print-html.ts`，自带 `html,body{…background:#fff}`），`printToPDF({printBackground:false})`；开发形态走同一份 print_html 新开窗口打印。真实调用 print_html：15,312 字节，不含任何画布/点阵/投影/`.kwl-paper` 标记。预览样式完全不在这条路上。
3. **复制**（Playwright 授权剪贴板，真实界面全选复制后读 `text/html`）：Word（起诉状、修订稿）、Excel（证据目录）在浅色与深色下复制出的 HTML 都**不含画布色、点阵、投影**；出现的底色只有文件自己的格式（修订的插入绿/删除红、Excel 表头与单元格底色），与改前一致。Markdown 草稿选中正文复制，浅色、深色都不带任何 background。原因：点阵只画在 `html`，正文最近的不透明祖先是白纸（或便笺纸），Chromium 取的“生效底色”到纸为止；`background-image` 不在复制的编辑样式里。
4. **打印**：四个框架样式常量与 `styles-preview.css` 都有 `@media print` 重置（去画布、点阵、投影）；此外 ui-prefs 在 `beforeprint` 把界面切回浅色，Chromium 默认也不印背景。

## 五、用例与性能（阶段 5）

- `cd platform/apps/desktop && npx tsc --noEmit`：0 错。
- 预览相关：`b68-preview-canvas`（新，4）、`style-tokens`（8）、`b62-preview-frame`、`b67-preview-sheets`、`desktop-lib`、`citation-review`、`review-extras`、`b66-material-links`、`accept-preview`、`b45-kimi-home-guide`：73/73 过。
- 桌面端全量 `node --test test/*.test.ts`：611 项 610 过，1 项失败为 `b67-card-forms.test.ts` 的“52 张卡都有形态…”——该文件在本 worktree 里被其他会话改过（`git status` 显示 M），与预览无关，未动。
- `packages/design-tokens/test`：6/6 过（深色覆盖完整、对比度）。
- `packages/docx-engine/test` 中 render-html、b67-xlsx-preview、b67-xlsx-numfmt、engine、external-refs（外部引用剥离）、b35-print-breaks、b35-xlsx-print：40/40 过（内核预览 HTML 白名单与无外部引用的用例未受影响——本工作线没改 docx-engine）。
- 滚动性能（Playwright 追踪，修订稿长文档，鼠标滚轮下滚 40 次再上滚 40 次，新样式与旧样式各两轮）：主线程 Paint 两者都约 1～2 ms、6 次（滚动走合成，不重绘）；光栅线程合计新样式 46～67 ms、旧样式 18～21 ms（一轮离群 113 ms），即约 3 秒滚动里多 30～45 ms，折合每帧 <0.3 ms，且这是无头浏览器的软件光栅，真机 GPU 光栅更低。无卡顿风险。

## 六、遗留与说明

1. **深色模式复制 Markdown 时带浅色字色**：选中便笺纸正文复制，HTML 里带 `color: rgb(236,235,233)`（界面深色字色），粘到 Word 白底上偏浅。这是改前就有的行为（整个界面的深色复制都如此），不是底纹；若要处理，可在 `.sp-md` 上接 copy 事件只给纯文本或去色 HTML，另行拍板。
2. **复核工作台文书栏 `.wb-doc` 与证据原文 `.ev-text`** 仍是整栏米白纸面（`--bg-paper`），不是“纸在画布上”结构；它们是逐句批注的工作面，不在本次“预览”范围，未改。若要统一，可给 `.wb-doc` 外加画布、内放纸，需与复核卡片联动另做。
3. **任意 HTML 产物**（非 Office、非 Markdown）仍按原样白底显示（不套纸面）：它们自带版式，加画布会误导版式。
4. 新令牌：`--preview-canvas`、`--preview-canvas-dot`、`--preview-sheet-shadow`、`--preview-note-shadow`（浅/深两套，只追加）。框架内手抄值由 `style-tokens.test.ts` 核对相等。
5. 未在 Windows 真机与安装包（Electron 跨进程框架）里看效果；纯 CSS 改动、框架身份规则沿用第 62 批，风险低，但发版前宜在安装包里看一眼深色切换（主题切换会换一次新框架）。
