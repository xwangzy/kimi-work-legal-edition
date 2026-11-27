/**
 * 方法库（第 55 批重做；第 03 篇 §4.1、v9.2 §4.4 / Y4 ME-1～ME-4 的口径保留）：与首页同一数据源（lib/scenarios.ts），
 * 卡片写“得到什么 / 需要什么”，不出现内部标识。
 *
 * 原先是一面 47 张等大的卡片墙，外加一遍与卡片重复的“通用方法模板”列表：没有主次、不能搜、要逐张读标题。现在是一份目录：
 *  - 页首一行搜索（标题、交付件、需要的材料、常用说法都能搜）；
 *  - 业务线筛选胶囊（与首页同一种胶囊，带数量），右端是“本所范本”；
 *  - 每条业务线下按办案阶段分组（接案与案情 → 起诉与应诉 → 庭审 → 执行与汇报…），阶段名在左侧成一列，右侧是该阶段的方法；
 *  - 每个方法一行：图标 + 名称 + 得到什么 + 需要什么，悬停出现“开始”，整行可点（与首页场景行同一种写法）。
 * “通用方法模板”一节撤掉：33 个模板里 32 个已经是上面的方法（剩下的表格审阅从事项材料页进入），重复列一遍只会让人以为是两套东西；
 * 模板读不到时的提示保留在页首。
 */
import { useEffect, useMemo, useState } from "react";
import { nav } from "../App.tsx";
import { api } from "../api.ts";
import { cardGets, cardGives, COMING_SOON, SCENARIOS } from "../lib/scenarios.ts";
import { buildCatalog, catalogCounts, CATALOG_LINE_LABELS, CATALOG_LINES, type CatalogLine } from "../lib/method-catalog.ts";
import { FirmTemplates } from "../components/FirmTemplates.tsx";
import { useWorkspace } from "../components/WorkspaceSwitch.tsx";
import { templatesLabel } from "../lib/workspace.ts";
import { Icon } from "../components/Icons.tsx";
import { scenarioIcon } from "./Home.tsx";
import "../styles-methods.css";

type Tab = "all" | CatalogLine | "templates";

function lineIcon(l: CatalogLine | "all") {
  if (l === "all") return Icon.list();
  if (l === "litigation") return Icon.scale();
  if (l === "transactional") return Icon.fileCheck();
  if (l === "inhouse") return Icon.shield();
  return Icon.compass();
}

export function MethodsPage() {
  const ws = useWorkspace();
  const tplLabel = templatesLabel(ws.kind);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [skillsNote, setSkillsNote] = useState("");
  useEffect(() => {
    // 方法模板读不到时如实说（任务仍可在首页直接描述）；读到了不用展示——模板与下面的方法是同一批东西
    api
      .listSkills()
      .then((r) => {
        if (!r.ok) setSkillsNote("方法暂时用不了，可以照常在首页描述任务。");
      })
      .catch(() => setSkillsNote("方法模板暂不可用。可以照常在首页描述任务。"));
  }, []);
  const counts = useMemo(() => catalogCounts(), []);
  const q = query.trim();
  // 搜索时跨全部业务线找（律师不一定记得方法归在哪条线）
  const sections = useMemo(() => buildCatalog({ line: q || tab === "templates" ? "all" : tab, query: q }), [tab, q]);
  const found = sections.reduce((n, s) => n + s.count, 0);
  const showTemplates = tab === "templates" && !q;

  return (
    <main className="main">
      <div className="main-wide mc-page">
        <header className="mc-head">
          <div className="mc-head-text">
            <h1 className="page-title">方法库</h1>
            <p className="mc-sub">{SCENARIOS.length} 个法律工作方法，按办案阶段排列。结果都是草稿，须律师复核后使用。</p>
          </div>
          <label className="dl-search mc-search">
            <span className="dl-search-icon" aria-hidden="true"><Icon.search /></span>
            <input type="search" aria-label="搜索方法" placeholder="搜索方法、文书或材料，如“起诉状”“回稿”" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </header>

        <div className="mc-filters">
          <div className="mc-chips" role="tablist" aria-label="业务线">
            {(["all", ...CATALOG_LINES] as const).map((l) => (
              <button key={l} role="tab" aria-selected={!q && tab === l} className={`scene-chip${!q && tab === l ? " active" : ""}`} onClick={() => { setTab(l); setQuery(""); }}>
                <span className="scene-chip-icon" aria-hidden="true">{lineIcon(l)}</span>
                {l === "all" ? "全部" : CATALOG_LINE_LABELS[l]}
                <span className="mc-chip-n">{counts[l]}</span>
              </button>
            ))}
          </div>
          <button role="tab" aria-selected={showTemplates} className={`scene-chip mc-chip-templates${showTemplates ? " active" : ""}`} onClick={() => { setTab("templates"); setQuery(""); }}>
            <span className="scene-chip-icon" aria-hidden="true"><Icon.book /></span>
            {/* 第 72 批（A3 D4）：个人空间叫“我的范本” */}
            {tplLabel.short}
          </button>
        </div>

        {skillsNote && <div className="banner banner-orange">{skillsNote}</div>}

        {showTemplates ? (
          <div className="mc-templates">
            <FirmTemplates />
            {/* 第 72 批评分 C17：路线图不放进“我的范本”页（原“即将推出 · 个人模板”与“范本”两个概念并排，律师分不清） */}
          </div>
        ) : (
          <>
            {q && (
              <p className="mc-found" role="status">
                {found > 0 ? `找到 ${found} 个方法` : `没有找到“${q}”`}
              </p>
            )}
            {sections.map((s) => (
              <section key={s.line} className="mc-line" aria-label={s.label}>
                {/* 只看一条线时线名已在胶囊上，不再重复 */}
                {(q || tab === "all") && (
                  <h2 className="mc-line-title">
                    {s.label}
                    <span className="mc-line-n">{s.count}</span>
                  </h2>
                )}
                {s.groups.map((g) => (
                  <div key={g.stage} className="mc-group">
                    <div className="mc-stage">{g.stage}</div>
                    <div className="mc-grid">
                      {g.cards.map((c) => (
                        // 整行可点（Y4 V-5：要么整卡可点、要么只有一个明确按钮），与首页场景行一致
                        <button key={c.id} className="mc-row" aria-label={`开始：${c.title}。得到 ${c.gets.join("、")}；需要 ${c.gives}`} onClick={() => nav(`/start/${c.id}`)}>
                          <span className="mc-row-icon" aria-hidden="true">{scenarioIcon(c)}</span>
                          <span className="mc-row-title">{c.title}</span>
                          <span className="mc-row-go" aria-hidden="true">开始 <Icon.right /></span>
                          <span className="mc-row-gets">{cardGets(c)}</span>
                          <span className="mc-row-gives">需要：{cardGives(c)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {/* 即将推出（S1 §5.1 第 4 条）：灰显，不能发起 */}
                {!q && COMING_SOON.some((x) => x.line === s.line) && (
                  <div className="mc-group">
                    <div className="mc-stage">即将推出</div>
                    <div className="mc-grid">
                      {COMING_SOON.filter((x) => x.line === s.line).map((x) => (
                        <div key={x.title} className="mc-row mc-row-soon" aria-disabled="true">
                          <span className="mc-row-icon" aria-hidden="true"><Icon.clock /></span>
                          <span className="mc-row-title">{x.title}</span>
                          <span className="mc-row-gives">还没有对应的方法，即将推出</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            ))}
            {/* 自由描述：原先是页首一张整宽卡片，抢在目录前面；现在收成目录后的一行出口，搜不到时也是它 */}
            <div className={`mc-free${q && found === 0 ? " mc-free-empty" : ""}`}>
              <span className="mc-free-icon" aria-hidden="true"><Icon.sparkle /></span>
              <span className="mc-free-text">
                <strong>{q && found === 0 ? "换个说法，或者直接描述任务" : "没有合适的方法？"}</strong>
                在首页输入框写下要做的事，例如“审查这份股权转让协议，我方为受让方”，助手会选用合适的方法。
              </span>
              <button className="btn-ghost btn-sm" onClick={() => nav("/")}>去首页描述</button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
