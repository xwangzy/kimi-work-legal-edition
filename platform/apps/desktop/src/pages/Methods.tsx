/**
 * 方法与模板（第 03 篇 §4.1）：固定流程（内核确定性工作流）+ 方法模板（签名分发的 Kimi Code Skills，在任务中由 Agent 按需使用）。
 * 文案只用律师语言（UIUX 评审 P0-6）：不出现方案章节号、阶段代号与内部架构词。
 */
import { useEffect, useState } from "react";
import { nav } from "../App.tsx";
import { api } from "../api.ts";
import { METHODS } from "../components/Composer.tsx";

type Skill = { id: string; title: string; description: string; version: string; tier: string; lines: string[] };

export function MethodsPage() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [skillsNote, setSkillsNote] = useState("");
  useEffect(() => {
    api
      .listSkills()
      .then((r) => {
        setSkills(r.skills ?? []);
        if (!r.ok) setSkillsNote(r.reason ? `方法模板暂不可用：${r.reason}` : "方法模板暂不可用");
      })
      .catch(() => {
        setSkills([]);
        setSkillsNote("方法模板暂不可用");
      });
  }, []);
  return (
    <main className="main">
      <div className="main-wide">
        <h1 className="page-title">方法与模板</h1>
        <p className="muted">所有结果都是草稿，需要律师复核后使用。标“试用”的方法还在评测中。</p>

        <div className="section-title">固定流程</div>
        <p className="muted">按固定步骤运行，结果稳定，适合常规工作。</p>
        <div className="cards">
          {METHODS.map((m) => (
            <div key={m.scenario} className="card card-static">
              <div className="title">
                {m.label} <span className={`tag ${m.tier === "Beta" ? "tag-beta" : "tag-demo"}`}>{m.tier === "Beta" ? "试用" : "示例流程"}</span>
              </div>
              <div className="desc">{m.desc}</div>
              {m.needs && <div className="desc">需要：{m.needs}</div>}
              <div className="card-actions">
                <button className="btn-link" onClick={() => nav("/")}>用这个方法发起</button>
              </div>
            </div>
          ))}
        </div>

        <div className="section-title">方法模板</div>
        <p className="muted">在任务里描述需求即可，AI 会按合适的模板工作；也可以直接写“按《{skills?.[0]?.title ?? "法律研究备忘录"}》模板”。</p>
        {skillsNote && <div className="banner banner-orange">{skillsNote}</div>}
        {skills === null ? (
          <p className="muted">载入中…</p>
        ) : (
          <div className="cards">
            {skills.map((s) => (
              <div key={s.id} className="card card-static">
                <div className="title">
                  {s.title} <span className="tag tag-beta">{s.tier === "production" ? "可用" : "试用"}</span>
                </div>
                <div className="desc">{s.description}</div>
                {s.lines.length > 0 && <div className="desc">适用：{s.lines.join(" · ")}</div>}
                <div className="card-actions">
                  <button className="btn-link" onClick={() => nav("/")}>在新任务中使用</button>
                </div>
              </div>
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
