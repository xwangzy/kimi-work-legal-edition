# Kimi Work 法律行业发行版 · 品牌广告片 V5

正片 150 秒（3840×2160 / 60 fps），30 秒品牌精简版 1 支，封面三种比例，联合品牌落版静帧。
合成 1920×1080 @ 60 fps，渲染 `--scale=2` 输出 4K（界面与文字按 2 倍像素真实栅格化，不是放大）。

**一句话概念**：当智能可以读完一切，律师的时间，应该留给什么？——让智能承担繁复，把时间留给判断。

- 历史版本复盘：`docs/00a-历史版本复盘.md`
- 创意重构方案、文案、分镜：`docs/00-V5创意方案与分镜.md`
- 产品事实核查（片中每句说法的出处、不能说的话、快照与最新版的差异）：`docs/01-产品事实核查.md`
- 逐镜头评审与验收、版本对比：`docs/03-逐镜头评审与验收.md`（各轮原始评审在 `docs/review/`）
- V1～V3 在 `../video/`，V4 在 `../video-v4/`（均未改动）。

## 命令

```bash
npm install                       # 依赖与 V4 相同（Remotion 4.0.531、React 18、fontsource）
npm run music                     # 合成配乐 public/audio/score.wav 与 30 秒版 score-cut30.wav（纯程序合成）
npm run studio                    # Remotion Studio：KimiWorkLegalV5、KimiWorkLegalV5-30s、Cover*、S-<场景>
P=3 CONC=4 scripts/render-chunks.sh && scripts/render-chunks.sh --assemble   # 正片 4K60：每 500 帧一块、3 个渲染进程并行（约 60 分钟），拼接后母带
scripts/render-all.sh cut && scripts/render-all.sh stills && scripts/render-all.sh broadcast       # 30 秒版 4K60、封面与落版静帧、−23 LUFS 广播版音轨
scripts/sheet.sh S-<场景> <帧…>   # 半分辨率渲染一场并抽帧拼联系表（检查用；SCALE=0.4 更快）
python3 scripts/ydif-scan.py <视频> [切点秒,…]   # 场内单帧突变扫描
```

## 结构

`src/timeline.ts` 是全片唯一时间轴（60 fps，72 BPM，1 小节 = 200 帧）；`src/beats.ts` 是各场内的关键时刻，画面与配乐共用；`src/copy.ts` 是全部文案；`src/cut30.ts` 是 30 秒版剪辑表。

| 幕 | 场景 | 文件 | 内容 |
|---|---|---|---|
| 一 时代 | corpus | `scenes/S1Corpus.tsx` | 《民法典》第一条微距（“秩序”）→ 后拉成法条星海（随包法规库真实条文）→ 蓝点读过条文 → 潜入第五百八十五条“违约金” |
| 二 痛点 | night | `scenes/S2Night.tsx` | 台灯下合同第 7.1 条“违约金”（虚焦匹配剪辑）→ 打开的钢笔、荧光笔与纸堆 → 十个中性工具窗口的碎片 → 寂静（02:08） |
| 二→三 | turn | `scenes/S3Turn.tsx` | 通用 AI 的“根据相关法律规定……”→ 三个问题 → “？”的点变成 Kimi 蓝点 → 曝光渐升 → 标识 |
| 三 登场 | home | `scenes/S4Home.tsx` | 标识组合 → 字标匹配剪辑进首页 → 首页分层成形 → 方法 |
| 四 一件事 | onetake | `scenes/S5OneTake.tsx` | 一镜到底（25 秒）：首页交代 → 停下来问（蓝点从选中的“拟签文本”升起，带镜头飞到工作台）→ 风险指在第 7.1 条 → 律师接受第 7.1 条、不采纳第 9.1 条 → 修订稿与清洁稿 → Word 第七条红删绿增（四个真实界面在同一三维空间里，镜头不切） |
| 五 回答 | answers | `scenes/S6Answers.tsx` | 夜色里逐一回答三问：《民法典》第五百八十五条引用核验 / 本事项真实代号与数据去向三站 / 交稿前 AI 复核人 → 律师签发（签发人与时间）→ 已签发 |
| 六 升华 | dawn | `scenes/S7Dawn.tsx` | 与第二幕开场同一景别：台灯下修订后的第 7.1 条 → 熄灯 → 窗格晨光、合帽的钢笔 → 后拉 → 价值 → 主题 |
| 落版 | finale | `scenes/S8Finale.tsx` | Kimi Work 法律行业发行版 → 中软国际（左）× Kimi（右）联袂打造 |

镜头与渲染的几个关键做法：
- `ui/space.tsx`：世界坐标相机（位置 + 偏航 + 俯仰 + 焦距），景深、雾、近裁剪手算。
- 第一幕景深在 4K 下的性能：离焦用 text-shadow（透明字 + 同色柔影）代替 CSS filter；屏幕模糊 ≥ 9px 的远处条文块画成“离焦的文字行”软条（box-shadow 偏移法，Skia 解析快路径），9–12px 与模糊文字交叉过渡；投影过大或完全出画的块剔除。不做这些，4K 单帧要一分钟以上甚至卡死。
- 近景文字（第一幕主角行、潜入目标）不用 CSS 3D 放大（Chrome 会按低分辨率栅格化后放大，字会糊），改为逐字手算透视投影、按真实屏幕字号在 2D 里排字，逐字景深。
- `ui/stage.tsx`：一镜到底的“世界里的产品窗口”，按窗口逐个投影，放大来自 `scale()`，界面文字保持清晰。
- 产品界面全部是真实运行时 DOM 快照（`snaps-src/` → `scripts/snap-import.mjs` → `src/snaps/`），由快照自带的 CSSOM 样式渲染（`src/product/`）；`src/film.css` 末尾把链接样式对齐到第 71 批。

## 界面与内容从哪里来（全部真实）

- **产品界面**：V4 采集栈（第 69 批 `e56b568a`，真实 Kimi 模型 kimi-k3.1-pro 执行真实审合同任务）录下的 DOM 快照；与最新第 71 批 `55d75f32` 的差异逐个核对（`docs/01-产品事实核查.md`）。片中只用与最新版一致的画面区域；第 71 批把链接从蓝色改为正文色加下划线，已在 `src/film.css` 对齐。
- **法条**：第一幕的条文全部取自产品随包法规库（`platform/content/lawdb/sources/laws.json`，仅 official-text-collected-* 来源的现行有效版本）的官方公布文本；法律条文不受著作权保护。
- **合同与修订**：桌上合同与真实任务所审《股权转让协议》逐字一致；第六幕的第 7.1 条是律师接受意见后的修订文字，逐字取自审查工作台“接受后”视图。
- **代号**：`src/real.ts`，产品 `materials.send_preview` 给出的本事项代号，与任务实际发出的一致。
- **通用 AI 那段文字**与第二幕的工具窗口是示意：不仿任何真实品牌，不点名、不比较。

## 片中对真实画面做的处理（全部列出）

- 账号显示名“王 · 王律师”（与 V4 相同，`ui/Snap.tsx` 的 `personalize`）。
- 景深虚化（不进入可读焦点）：执行页时间线（含一行内部工具名 WaitFor 与“正在起草”一段）、数据去向页里 token 计量细项与“不用于训练、不保留”的书面确认“待签署”一行。产品原文未改。
- 复核签发页：片中只取签发确认区、签发人一行与顶部状态（与第 71 批一致的部分），裁成受光卡片；不露出“你来核对”清单（含内部字段名）与第 71 批新增按钮所在的顶栏右侧。
- 隐私：演示手机号、身份证号全片中段打码（纸面与所有界面快照，`ui/Snap.tsx` 的 `prepare`）。
- 复核签发页的 Word 预览从“第七条 违约责任”开始显示（相当于把预览滚到第 7.1 条，`ui/Snap.tsx` 的 `PREPARE`）。
- 一镜到底里工作台以外条款的高亮压到 28%，突出第 7.1 条；第 9.1 条“不采纳”为本次真实任务的记录（快照 `w12-rej`）。

## 交付物（`out/final/`）

| 文件 | 规格 |
|---|---|
| `KimiWorkLegal-V5-正片-4K60.mp4` | 3840×2160，60 fps，H.264 High，BT.709 有限范围，AAC 320 kbps，−16 LUFS / ≤ −1.5 dBTP，150 秒 |
| `KimiWorkLegal-V5-30秒-4K60.mp4` | 同上规格，30 秒 |
| `KimiWorkLegal-V5-封面-4K.png` / `-1x1.png` / `-3x4.png` | 3840×2160 / 2160×2160 / 2160×2880 |
| `KimiWorkLegal-V5-联合品牌落版-4K.png` | 3840×2160 |
| `KimiWorkLegal-V5-正片-配乐-广播版-23LUFS.wav` | 广播用 −23 LUFS 音轨 |

## 版权与授权

- 字体：Noto Sans SC、Noto Serif SC、Inter（SIL Open Font License 1.1）；产品界面内为产品自身字体栈。
- 配乐与音效：`scripts/make-music.mjs` 纯程序合成，无采样、无第三方音乐。正式对外发布前，如需更高的音乐质感，建议请作曲按 `docs/00-V5创意方案与分镜.md` 的情绪曲线与切点另行录制授权配乐（时间轴与切点不变）。
- 标识：Kimi 官方标识包（`~/Downloads/KIMI-logos`）与中软国际标识（`maas-site/shared/img/logo-csi.png`）原样使用，未改形改色。
