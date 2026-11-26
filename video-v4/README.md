# Kimi Work 法律行业发行版 · 产品宣传片 V4

正片 114 秒，30 秒社媒版 1 支，封面与联合品牌落版各 1 张。合成 1920×1080 @ 60 fps，渲染时 `--scale=2` 输出 **3840×2160 / 60 fps**（界面与文字按 2 倍像素真实栅格化）。
主题「让法律专业能力，进入 AI 时代。」 / Legal Intelligence. Reimagined. 结尾：中软国际（左）× Kimi（右），下方「联袂打造」。

- 创意方案、文案与分镜：`docs/00-V4创意方案与分镜.md`
- 产品现状核查（片中每句说法的出处与禁用说法）：`docs/01-产品现状核查.md`
- 逐镜头评审与验收：`docs/03-逐镜头评审与验收.md`
- V1 / V2 / V3 在 `../video/`（未改动）。

## 命令

```bash
npm install
npm run music          # 合成正片配乐 public/audio/score.wav 与 30 秒版 score-cut30.wav（纯程序合成，无第三方音乐素材）
npm run studio         # Remotion Studio：KimiWorkLegalV4（正片）、KimiWorkLegalV4-30s、Cover、SnapCheck、S-<场景>
npm run render         # 正片 4K60 → out/kimi-work-legal-film-v4-4k60.mp4
scripts/render-all.sh  # 正片 + 30 秒版 + 封面 + 落版静帧 + 响度归一化，全部交付物
scripts/sheet.sh S-<场景> <帧…>   # 半分辨率渲染一场并抽帧拼联系表（检查用）
```

## 界面从哪里来（全部真实）

| 环节 | 做法 |
|---|---|
| 产品版本 | 第 69 批 `e56b568a`（客户端 0.9.0）的干净检出：`.claude/worktrees/film-v4-capture` |
| 采集栈 | `scripts/capture/stack-real.mjs`：vite 界面 + 内核开发桥 + 本机法律模型网关 v0 → 中软 MaaS → **kimi-k3.1-pro（真实模型）**。MaaS 密钥只从钥匙串读、只给网关进程，输出遮盖 |
| 案例 | `scripts/capture/seed.mjs`：三条业务线各一件虚构、脱敏事项（甲乙丙丁戊己；姓名、证件号、电话为编造） |
| 拍摄 | `scripts/capture/shoot.mjs` 分阶段：start（发起真实审合同任务并逐步拍下）、post、wbact/wbfinish/wbredline（律师在审查工作台逐条处理、生成修订稿）、sign2/signview（复核签发）、pages、chat（真实问答）、dark、lit（真实起草起诉状）、casefile（整理案卷，全程本机）、aisees（“AI 会看到的内容”） |
| 样式 | 运行中界面的 CSSOM 全量 → `scripts/snap-css.mjs` 作用域化；快照每帧重建，产品入场动画在 `src/film.css` 关掉 |
| 导入 | 选用的 DOM 快照放进 `snaps-src/`，`node scripts/snap-import.mjs` 生成 `src/snaps/` |

真实任务记录（采集当天，2026-11-26）：
- 审合同（股权转让协议，我方受让方）：用时 24 分 2 秒、29 步；中途停下来问律师“拟签还是已签”（选拟签文本）；提出 17 项审查意见（重大 8、一般 7、提示 2）；交稿前独立复核；律师接受 15 项、不采纳第 9.1 条；产品如实提示 2 项修改无法准确定位，跳过后生成对外版修订稿（13 处 Word 修订）与清洁稿；复核签发。
- 起草起诉状（建设工程款）：用时 16 分 12 秒；律师在论点确认卡逐条“采用”3 条论点，选受诉法院与“本次不申请保全”。
- 整理案卷：全部在本机完成（用时 0 秒），出证据目录、事实时间轴、争点证据矩阵等 6 份。
- 法律问答：真实 Kimi 模型回答。
- 发出前的代号：`materials.send_preview` 给出的本事项代号（张伟 → 〔自然人·16H38B〕等），与任务实际发出的一致（`src/real.ts`）。

## 片中对真实画面做的处理（全部列出）

- **账号显示名**：采集栈是开发身份（侧栏“我 · 本机”、签发人 `film-lawyer`）。片中按登录后产品在同一位置显示账号名的方式，显示为“王 · 王律师”（`src/ui/Snap.tsx` 的 `personalize`，只改这几处文字）。
- **滚动、勾选、打字、显隐、聚光框、景深虚化**：都按真实界面里存在的状态演示（快照之间的中间态由交叉溶解过渡）。
- **虚化而非删改**：数据去向页中转站说明里含英文“token 数”的计量细项、Kimi 模型一栏“与月之暗面‘不用于训练、不保留’的书面确认：待签署”一行，在片中轻度虚化，不进入可读焦点；产品原文未改。后者属合作进展，**是否在片中露出请甲方决定**。
- **签发清单**：复核签发页里“你来核对”的检查项含内部术语，片中用景深虚化，只让“我已实质复核全部内容”“确认签发”与签发人一行清晰。
- **纸面镜头**：片头与价值段的纸张、第 7.1 条修订稿是按真实内容排版的“纸”（`src/ui/paper.tsx`、`src/ui/redline.tsx`）：合同条款与采集任务所审协议逐字一致；修订文字逐字取自本次任务审查工作台“接受后”视图（快照 `w34-after-s3`）；代号取自产品 `materials.send_preview`。

## 交付物（`out/final/`）

| 文件 | 规格 |
|---|---|
| `KimiWorkLegal-V4-正片-4K60.mp4` | 3840×2160，60 fps，H.264 High（x264 CRF 14），有限范围 BT.709，AAC 320 kbps，−16 LUFS / ≤ −1.5 dBTP，114 秒 |
| `KimiWorkLegal-V4-30秒-4K60.mp4` | 同上规格，30 秒 |
| `KimiWorkLegal-V4-封面-4K.png` | 3840×2160 |
| `KimiWorkLegal-V4-封面-1x1.png` / `-3x4.png` | 2160×2160 / 2160×2880 |
| `KimiWorkLegal-V4-联合品牌落版-4K.png` | 3840×2160 |

## 结构

`src/timeline.ts`（60 fps，100 BPM，1 小节 = 144 帧）是全片唯一时间轴；`src/beats.ts` 是各场内的关键时刻，画面与音效共用；`src/cues.ts` 生成音效提示点；`src/cut30.ts` 是 30 秒版剪辑表。

| 场景 | 文件 | 内容 |
|---|---|---|
| paper | `S01Paper.tsx` | 第 7.1 条微距 → 纸堆纵深 → 命题 → 蓝点 |
| reveal | `S02Reveal.tsx` | 蓝点 → 标识 → 产品名 → 字标匹配剪辑 |
| home / start | `S03Home.tsx` `S04Start.tsx` | 首页分层展开合拢 → 交代任务 → 开始面板 |
| consent | `S05Consent.tsx` | 客户授权 → 开始用 AI 之前 → 纸面上姓名换成代号 |
| run … deliver | `S06Work.tsx` `S10Deliver.tsx` | 过程（停下来问律师 + 独立复核）、风险（蓝点落在第 7.1 条）、证据（17 / 8）、引用、判断（修订写在纸上）、签发、交付（签发后的纸抬离屏幕） |
| breadth / trust | `S12Breadth.tsx` | 一个工作空间（画廊横移）、保密（深色数据去向） |
| value … partner | `S15Finale.tsx` | 价值（夜色里修订后的第 7.1 条）、主题、产品名（从蓝点展开）、联袂打造（落印） |

## 版权与授权

- 字体：Noto Sans SC、Noto Serif SC、Inter（均 SIL Open Font License 1.1，`@fontsource/*`）；产品界面内为产品自身字体栈。
- 配乐与音效：`scripts/make-music.mjs` 纯程序合成，无采样、无第三方音乐。
- 标识：Kimi 官方标识包（`~/Downloads/KIMI-logos`）与中软国际标识（`maas-site/shared/img/logo-csi.png`）原样使用，未改形改色。
- 法条：产品随包法规库的官方公布文本。
