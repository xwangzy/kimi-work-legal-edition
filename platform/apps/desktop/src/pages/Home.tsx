import { useEffect, useState } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";

/** 首页（§5.4 线框：轻侧栏 + 居中输入 + 交付件卡只露生产档/Beta 标注）。 */
const DELIVERABLES = [
  { key: "s1", title: "合同审查与修订", desc: "DOCX 进、原生修订稿与审查意见书出；首批 9 类 × 双立场", tier: "demo" as const },
  { key: "s1b", title: "回稿比对", desc: "对方回稿只重审改动，标出静默改动", tier: "demo" as const },
  { key: "s2", title: "案卷整理", desc: "证据目录、事实时间轴、争点—证据矩阵（≤100 页标准档）", tier: "demo" as const },
  { key: "s6", title: "对外脱敏", desc: "脱敏件 + 脱敏报告；全流程化名", tier: "demo" as const },
  { key: "a1", title: "Agent 模式", desc: "开放任务：计划先行、预算上限、产物仅为草稿", tier: "beta" as const },
];

export function Home() {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [lawdb, setLawdb] = useState<any>(null);
  const [goal, setGoal] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    api.listMatters().then((r) => setMatters(r.matters)).catch((e) => setErr(e.message));
    api.pending().then((r) => setPending(r.pending)).catch(() => {});
    // 法规库最后更新日（§9）；签名无效时内核拒载、此处如实显示不可用
    api.lawdbStatus().then(setLawdb).catch((e) => setLawdb({ display: `法规库不可用：${e.message}`, error: true }));
  }, []);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          ◉ Kimi Work<small>法律行业发行版（demo）</small>
        </div>
        <button className="nav-item active">＋ 新建任务</button>
        <button className="nav-item">▤ 事项</button>
        <button className="nav-item">◷ 待我处理<span className="badge">{pending.length}</span></button>
        <button className="nav-item">⇪ 交付中心</button>
        <button className="nav-item">◇ 方法与知识</button>
        <button className="nav-item">⚯ 连接</button>
        <div className="sidebar-section">最近事项</div>
        {matters.slice(0, 6).map((m) => (
          <a key={m.matter_id} className="sidebar-link" href={`#/matter/${m.matter_id}`}>{m.title}</a>
        ))}
      </aside>
      <main className="main">
        <div className="main-narrow">
          <h1 className="page-title">今天要处理什么？</h1>
          <div className="hero-input">
            <textarea
              placeholder="审查这份股权转让协议，我方为受让方……"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
            <div className="hero-toolbar">
              <span>/ 方法</span><span>@ 材料</span><span>＋ 上传</span>
              <span className="spacer" />
              <span>事项：自动匹配 ▾</span>
              <button
                className="btn-primary"
                disabled={!goal.trim()}
                onClick={async () => {
                  const { matter } = await api.createMatter({ title: goal.trim().slice(0, 24) || "新事项", stance: "待定（创建后确认）" });
                  nav(`/matter/${matter.matter_id}`);
                }}
              >➤</button>
            </div>
          </div>
          {err && <p className="muted">{err}（请确认内核已启动：Electron 内嵌，或 web 调试桥 127.0.0.1:7720）</p>}

          {pending.length > 0 && (
            <>
              <div className="section-title">待我复核 / 签发</div>
              <div className="cards">
                {pending.map((p) => (
                  <button key={p.artifact_version_id} className="card" onClick={() => nav(`/review/${p.artifact_version_id}`)}>
                    <div className="title">{p.filename}</div>
                    <div className="desc">{p.matter_title} · v{p.version} · 待复核</div>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="section-title">非诉</div>
          <div className="cards">
            {DELIVERABLES.filter((d) => ["s1", "s1b"].includes(d.key)).map((d) => (
              <DeliverableCard key={d.key} d={d} />
            ))}
          </div>
          <div className="section-title">诉讼仲裁</div>
          <div className="cards">
            {DELIVERABLES.filter((d) => ["s2"].includes(d.key)).map((d) => (
              <DeliverableCard key={d.key} d={d} />
            ))}
          </div>
          <div className="section-title">横切 / Beta</div>
          <div className="cards">
            {DELIVERABLES.filter((d) => ["s6", "a1"].includes(d.key)).map((d) => (
              <DeliverableCard key={d.key} d={d} />
            ))}
          </div>
          <p className="muted" style={{ marginTop: 24 }}>
            G0 开发骨架（方案 v5.0：本地执行、云端推理）：S1/S1b/S2/S6 工作流与 A1（Beta）已接本机内核；
            模型默认可用离线 mock（无网络外发），真实链路经出站闸门。示例数据均为虚构。
          </p>
          {lawdb && (
            <p className="muted" style={{ marginTop: 4 }}>
              {lawdb.error ? lawdb.display : `${lawdb.display}（演示种子，覆盖见法规库说明）`}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

function DeliverableCard({ d }: { d: (typeof DELIVERABLES)[number] }) {
  return (
    <button className="card" onClick={() => nav("/")}>
      <div className="title">
        {d.title}
        <span className={`tag ${d.tier === "demo" ? "tag-prod" : "tag-beta"}`}>{d.tier === "demo" ? "演示" : "Beta"}</span>
      </div>
      <div className="desc">{d.desc}</div>
    </button>
  );
}
