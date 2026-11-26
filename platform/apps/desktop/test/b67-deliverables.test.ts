/**
 * 第 67 批（V41 工作线 D）成果页：文档工作区。
 * 名称去噪用第 66 批真实验收工作区（ws1）里的真实文件名：合同审查一次（6 份）、起诉状一次（4 份）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { docTitle, foldEarlierRuns, pendingFillCount, subjectKey, subjectRedundant, taskTitles, trimMatterPrefix, whenText } from "../src/lib/deliverables.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const REVIEW_MATTER = "锐川与禾丰设备买卖合同审查（卖方）";
const SUIT_MATTER = "锐川诉禾丰设备买卖合同纠纷（起诉状）";
const REVIEW = [
  "审查意见书（内部稿）-设备买卖合同RC-XS-2025-118",
  "01-设备买卖合同（RC-XS-2025-118）（修订稿）",
  "01-设备买卖合同（RC-XS-2025-118）（清洁稿）",
  "01-设备买卖合同（RC-XS-2025-118）（修订稿·对外版）",
  "01-设备买卖合同（RC-XS-2025-118）（修改对照表）",
  "问题清单-设备买卖合同RC-XS-2025-118",
];
const SUIT = ["民事起诉状", "计算明细-锐川诉禾丰验收款-截至2026-11-30", "提交前核对清单-锐川诉禾丰买卖合同纠纷", "证据目录-锐川诉禾丰买卖合同纠纷"];

test("短名：同族文件取括号里的差异，“文书-对象”取连接符前的文书名，序号、日期不当文书名", () => {
  assert.deepEqual(docTitle(REVIEW[1]!, "01-设备买卖合同（RC-XS-2025-118）"), { title: "修订稿", subject: "01-设备买卖合同（RC-XS-2025-118）" });
  assert.deepEqual(docTitle(REVIEW[3]!, "01-设备买卖合同（RC-XS-2025-118）"), { title: "修订稿·对外版", subject: "01-设备买卖合同（RC-XS-2025-118）" });
  assert.deepEqual(docTitle(REVIEW[0]!), { title: "审查意见书（内部稿）", subject: "设备买卖合同RC-XS-2025-118" });
  assert.deepEqual(docTitle("民事起诉状"), { title: "民事起诉状", subject: "" });
  // 没有同族时“01-设备买卖合同（…）”不拆成“01”；以日期开头的名称不拆
  assert.equal(docTitle("01-设备买卖合同（RC-XS-2025-118）").title, "01-设备买卖合同（RC-XS-2025-118）");
  assert.equal(docTitle("2026-11-30 会谈纪要").title, "2026-11-30 会谈纪要");
  // 连接符前太长（超过 16 个字）不当文书名
  assert.equal(docTitle("关于锐川精密机械有限公司设备买卖合同履行情况的法律意见-终稿").subject, "");
});

test("对象：与事项名重复的不写；带事项名里没有的编号（合同号）不算重复；开头的当事人简称去掉", () => {
  assert.equal(subjectRedundant("锐川诉禾丰买卖合同纠纷", SUIT_MATTER), true);
  assert.equal(subjectRedundant("设备买卖合同RC-XS-2025-118", REVIEW_MATTER), false, "合同号是有用的信息");
  assert.equal(subjectRedundant("锐川诉禾丰验收款-截至2026-11-30", SUIT_MATTER), false);
  assert.equal(subjectRedundant("", SUIT_MATTER), false);
  assert.equal(subjectKey("01-设备买卖合同（RC-XS-2025-118）"), subjectKey("设备买卖合同RC-XS-2025-118"));
  assert.equal(trimMatterPrefix("锐川诉禾丰验收款-截至2026-11-30", SUIT_MATTER), "验收款-截至2026-11-30");
  assert.equal(trimMatterPrefix("锐川诉禾丰", SUIT_MATTER), "锐川诉禾丰", "去掉后不剩内容的不去");
  assert.equal(trimMatterPrefix("设备买卖合同RC-XS-2025-118", "甲公司股权转让"), "设备买卖合同RC-XS-2025-118");
});

test("一次任务的短名：合同审查六份不再像同一份重复四次；共同针对的合同只在任务行说一次", () => {
  const { names, shared } = taskTitles(REVIEW, REVIEW_MATTER);
  assert.deepEqual(REVIEW.map((d) => names.get(d)!.title), ["审查意见书（内部稿）", "修订稿", "清洁稿", "修订稿·对外版", "修改对照表", "问题清单"]);
  assert.equal(new Set(REVIEW.map((d) => names.get(d)!.title)).size, REVIEW.length, "六个短名各不相同");
  assert.ok(REVIEW.every((d) => names.get(d)!.subject === ""), "各行不再重复合同名");
  assert.equal(shared, "设备买卖合同（RC-XS-2025-118）");
});

test("一次任务的短名：起诉状一次——和事项名重复的后缀不写，各不相同的对象留在自己那一行", () => {
  const { names, shared } = taskTitles(SUIT, SUIT_MATTER);
  assert.equal(shared, "");
  assert.deepEqual(SUIT.map((d) => names.get(d)), [
    { title: "民事起诉状", subject: "" },
    { title: "计算明细", subject: "验收款-截至2026-11-30" },
    { title: "提交前核对清单", subject: "" },
    { title: "证据目录", subject: "" },
  ]);
  // 不给事项名（事项页里）也能拆，只是不去重
  assert.equal(taskTitles(SUIT).names.get(SUIT[3]!)!.subject, "锐川诉禾丰买卖合同纠纷");
});

test("同一种任务跑了几次：最新一次照常列出，更早的收成一行；“已有新版”只在最新一次把每份都重出过时才写（第三轮）", () => {
  // 第 67 批真实数据：起草起诉状跑了两次，第二次又出了起诉状、计算明细、证据目录、提交前核对清单
  const runs = [
    { id: "r3", name: "起草起诉状", titles: ["民事起诉状", "计算明细", "证据目录", "提交前核对清单"] },
    { id: "r2", name: "起草起诉状", titles: ["民事起诉状", "计算明细", "提交前核对清单", "证据目录"] },
    { id: "r1", name: "审合同", titles: ["审查意见书（内部稿）"] },
    { id: "", name: "", titles: ["助手生成的文件"] },
  ];
  const f = foldEarlierRuns(runs, (t) => t.name, (t) => t.titles);
  assert.deepEqual(f.map((g) => [g.task.id, g.earlier.map((e) => e.id), g.renewed]), [["r3", ["r2"], true], ["r1", [], false], ["", [], false]]);
  // 更早那次有一份最新一次没再出：不写“已有新版”
  const partial = foldEarlierRuns([runs[0]!, { ...runs[1]!, titles: [...runs[1]!.titles, "律师费说明"] }], (t) => t.name, (t) => t.titles);
  assert.equal(partial[0]!.renewed, false);
  // 不归并的组（任务名为空，如“其他”）各自成组
  assert.equal(foldEarlierRuns([runs[3]!, runs[3]!], (t) => t.name, (t) => t.titles).length, 2);
});

test("待填计数；当天时间写成“今天 00:58”", () => {
  assert.equal(pendingFillCount("<p>原告：【待填】</p><p>【 待填：联系电话】</p>"), 2);
  assert.equal(pendingFillCount("没有占位"), 0);
  assert.equal(whenText("00:58"), "今天 00:58");
  assert.equal(whenText("41 分钟前"), "41 分钟前");
  assert.equal(whenText("11月9日 21:46"), "11月9日 21:46");
});

test("成果页接线：工作区两栏各自滚动；分段筛选；上下键换文件；搜索、筛选后选中跟着走；窄窗口仍直达复核页", () => {
  const page = src("pages/Deliverables.tsx");
  assert.match(page, /<main className=\{`main dlws-main\$\{ws \? " is-ws" : ""\}`\}>/);
  assert.match(page, /const ws = wide && rows !== null && rows\.length > 0;/);
  assert.match(page, /<div className="dl-flow" role="tablist" aria-label="按复核流程筛选">/);
  assert.match(page, /onKeyDown=\{\(e\) => moveInList\(e, wide\)\}/);
  assert.match(page, /if \(selectedId && shownIds\.includes\(selectedId\)\) return;\s*setSelectedId\(firstShown\);/);
  assert.match(page, /const open = \(r: any\) => \(wide \? setSelectedId\(r\.artifact_version_id\) : nav\(`\/review\/\$\{r\.artifact_version_id\}`\)\);/);
  // 第三轮（独立评审 #1、#6）：缺省“全部”，不再自动跳段；页首只有标题与搜索；分段之间没有流程箭头
  assert.match(page, /const \[filter, setFilter\] = useState<Filter>\("all"\);/);
  assert.doesNotMatch(page, /defaultFilter\(|touchedRef|className="dl-sub"|dl-flow-arrow/);
  // 第三轮 #2：同一种任务更早的运行收成一行；#3：一份都没有时收起预览栏
  assert.match(page, /foldEarlierRuns\(g\.tasks,/);
  assert.match(page, /更早 \{runs\} 次运行（\{files\} 份）/);
  assert.match(page, /\{renewed && <span className="dl-earlier-note">· 已有新版<\/span>\}/);
  assert.match(page, /dl-split\$\{ws && shownGroups\.length === 0 \? " dl-split-empty" : ""\}/);
  assert.match(page, /\{ws &&\s*shownGroups\.length > 0 &&/);
  assert.match(page, /versionsInline=\{!wide\}/);
  // 预览没有关闭按钮了（常驻一栏）；没选中时右栏说清为什么空
  assert.doesNotMatch(page, /onClose=/);
  assert.match(page, /<DeliverablePreviewEmpty text=/);
  const css = src("styles-deliverables.css");
  assert.match(css, /\.main\.dlws-main\.is-ws \{ display: flex; flex-direction: column; overflow: hidden;/);
  assert.match(css, /\.dl-ws \.dl-list \{ flex: 1; min-height: 0; overflow: auto;/);
  assert.doesNotMatch(css, /\.dl-card \{/, "事项不再套带边框的卡片");
  // 菜单打开时那一行浮到后面几行之上（改前被后面的行盖住）
  assert.match(css, /\.dl-page \.dl-row:has\(\.dl-menu\) \{ z-index: 5; \}/);
  // 第三轮 #4：行尾操作与状态共用一个栏位、在文档流里；第二行一行文字末尾省略（不再浮在文字上把半个字盖住）
  assert.match(css, /\.dl-page \.dl-row-state, \.dl-page \.dl-row-acts \{ grid-column: 3; grid-row: 1; \}/);
  assert.doesNotMatch(css, /\.dl-row-acts \{ position: absolute/);
  assert.match(css, /\.dl-page \.dl-row-meta \{ display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis;/);
  assert.match(css, /\.dl-ws \.dl-split\.dl-split-empty \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  // .dl-search 也用在事项、方法库页：本页只在 .dl-page 内改它
  assert.doesNotMatch(css, /^\.dl-search\b/m);
});

test("预览头：一个主操作（按状态），其余进图标与“更多”；版本切换是下拉；状态含义在悬停提示", () => {
  const p = src("components/DeliverablePreview.tsx");
  const primary = p.slice(p.indexOf("const primary ="), p.indexOf("const more:"));
  assert.equal(primary.split('className="btn-primary').length - 1, 3, "草稿 / 待复核或退回 / 已签发各一个，任一时刻只渲染一个");
  assert.match(primary, /!isLatest \? \(\s*<button className="btn-ghost btn-sm" onClick=\{\(\) => setCur\(latest\)\}>/, "看旧版时不给黑色主按钮");
  // 与列表同一口径：过程文件、重新运行前的文件、已被取代的版本在预览里也不给“提交复核”（第三轮截图发现答复摘要给了黑色“提交复核”）
  assert.match(p, /const record = PROCESS_KINDS\.has\(cur\.kind\) \|\| isEarlierRun\(cur\) \|\| cur\.is_latest === false;/);
  assert.match(primary, /\) : record \? null : st === "draft" \? \(/);
  assert.match(p, /<MenuButton label="更多操作"/);
  // 第三轮 #5：复核入口不藏进“更多”——待复核 / 退回主按钮是“去复核”；草稿旁露“复核页”，已签发露“签发记录”
  assert.match(primary, />去复核<\/button>/);
  assert.match(p, /\{st === "approved" \? "签发记录" : "复核页"\}/);
  assert.match(p, /\.\.\.\(reviewShown \? \[\] : \[\{ label: "打开复核页"/);
  assert.match(p, /<MenuButton\s+label="切换版本"/);
  assert.doesNotMatch(p, /className="dlp-next"/, "不再有一整句状态说明");
  assert.match(p, /\{fills\} 处待填/);
  const row = src("components/ArtifactRow.tsx");
  assert.match(row, /title=\{STATUS_HINT\[status\]\}/);
  // 菜单：Esc 关闭并回到触发按钮、上下键移动、点外面关闭
  assert.match(row, /if \(e\.key === "Escape"\) \{\s*e\.stopPropagation\(\);\s*setOpen\(false\);\s*trigger\.current\?\.focus\(\);/);
  assert.match(row, /document\.addEventListener\("mousedown", away\)/);
  // 向后兼容：@ 材料弹层仍用 FileTypeIcon；FileRows 旧调用（不给 name、menu）照常
  assert.match(src("components/MaterialPicker.tsx"), /import \{ FileTypeIcon \} from "\.\/ArtifactRow\.tsx";/);
  assert.match(row, /export function FileTypeIcon\(/);
  assert.match(row, /versionsInline = true,/);
});
