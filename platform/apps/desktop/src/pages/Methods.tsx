/**
 * 方法与模板（第 03 篇 §4.1；v9.2 §4.4 / Y4 ME-1～ME-4）：与首页同一数据源（lib/scenarios.ts）、同名同序；
 * 卡片写“你给什么 → 你得到什么”，不出现内部标识；统一“开始 →”；档位只有一个维度（可用 / 试用 / 即将推出）。
 */
import { useEffect, useState } from "react";
import { nav } from "../App.tsx";
import { api } from "../api.ts";
import { cardGets, cardGives, COMING_SOON, LINE_LABELS, SCENARIOS, type BusinessLine } from "../lib/scenarios.ts";

type Skill = { id: string; title: string; description: string; version: string; tier: string; lines: string[] };

const LINES: BusinessLine[] = ["litigation", "transactional", "inhouse"];

/** 模板标题里的档位说明另由标签表达（“· 试用（通用辅助）”不重复显示）。 */
const cleanTitle = (t: string) => t.replace(/\s*·\s*试用.*$/, "");

export function MethodsPage() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [skillsNote, setSkillsNote] = useState("");
  useEffect(() => {
    api
      .listSkills()
      .then((r) => {
        setSkills(r.skills ?? []);
        if (!r.ok) setSkillsNote("方法模板暂不可用（模板包校验未通过）。可以照常在首页描述任务。");
      })
      .catch(() => {
        setSkills([]);
        setSkillsNote("方法模板暂不可用。可以照常在首页描述任务。");
      });
  }, []);
  return (
    <main className="main">
      <div className="main-wide">
        <h1 className="page-title">方法与模板</h1>
        <p className="muted">全部在试用阶段：结果是草稿，须律师复核后使用。</p>

        <div className="card card-static methods-free">
          <div className="title">自由描述任务</div>
          <div className="desc">在首页输入框里写下要做的事，例如“审查这份股权转让协议，我方为受让方”，助手会选用合适的方法。</div>
          <div className="card-actions">
            <button className="btn-link" onClick={() => nav("/")}>开始 →</button>
          </div>
        </div>

        <div className="section-title">按业务场景</div>
        {LINES.map((line) => (
          <section key={line} aria-label={LINE_LABELS[line]}>
            <div className="methods-line">{LINE_LABELS[line]}</div>
            <div className="cards">
              {SCENARIOS.filter((c) => c.line === line && !c.general).map((c) => (
                // 卡片要么整卡可点、要么只有一个明确按钮（Y4 V-5）：与首页场景卡一致，整卡可点
                <button key={c.id} className="card method-card" aria-label={`开始：${c.title}`} onClick={() => nav(`/start/${c.id}`)}>
                  {/* v9.4 U1 #16：档位在页首统一说一次；卡面与首页同一套写法（交付件一行 + 需要什么一行） */}
                  <span className="title">{c.title}</span>
                  <span className="sc-gets">{cardGets(c)}</span>
                  <span className="sc-gives">需要：{cardGives(c)}</span>
                  <span className="method-go">开始 →</span>
                </button>
              ))}
              {/* 即将推出（S1 §5.1 第 4 条）：灰显卡，不能发起 */}
              {COMING_SOON.filter((x) => x.line === line).map((x) => (
                <div key={x.title} className="card method-card method-soon" aria-disabled="true">
                  <span className="title">{x.title}</span>
                  <span className="sc-gives">还没有对应的方法，即将推出</span>
                </div>
              ))}
            </div>
          </section>
        ))}

        <section aria-label="三条线通用">
          <div className="methods-line">三条线通用</div>
          <div className="cards">
            {SCENARIOS.filter((c) => c.general).map((c) => (
              <button key={c.id} className="card method-card" aria-label={`开始：${c.title}`} onClick={() => nav(`/start/${c.id}`)}>
                <span className="title">{c.title}</span>
                <span className="sc-gets">{cardGets(c)}</span>
                <span className="sc-gives">需要：{cardGives(c)}</span>
                <span className="method-go">开始 →</span>
              </button>
            ))}
          </div>
        </section>

        <div className="section-title">通用方法模板</div>
        <p className="muted">在任务里描述需求即可，助手会按合适的模板工作；也可以直接写“按《{cleanTitle(skills?.[0]?.title ?? "法律研究备忘录")}》的方法”。</p>
        {skillsNote && <div className="banner banner-orange">{skillsNote}</div>}
        {skills === null ? (
          <p className="muted">载入中…</p>
        ) : (
          <div className="cards">
            {skills.map((s) => (
              <button key={s.id} className="card method-card" aria-label={`${cleanTitle(s.title)}：在首页描述任务`} onClick={() => nav("/")}>
                <span className="title">
                  {cleanTitle(s.title)}
                  {s.tier === "production" && <span className="tag tag-ok"> 可用</span>}
                </span>
                <span className="desc clamp-2">{s.description}</span>
                {s.lines.length > 0 && <span className="desc">适用：{s.lines.join(" · ")}</span>}
                <span className="method-go">开始 →</span>
              </button>
            ))}
          </div>
        )}

        <div className="section-title">即将推出</div>
        <ul className="plain-list muted">
          <li>本所规则与模板：由律所管理员审核发布后，所有律师可用。</li>
          <li>个人模板：把常用做法保存为自己的模板。</li>
        </ul>
      </div>
    </main>
  );
}
