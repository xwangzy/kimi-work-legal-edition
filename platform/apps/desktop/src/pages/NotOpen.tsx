/** 未开放的入口：如实标注所属阶段与将来的语义，不放占位按钮。 */
export function NotOpenPage({ title, phase, lines }: { title: string; phase: string; lines: string[] }) {
  return (
    <main className="main">
      <div className="main-narrow">
        <h1 className="page-title">
          {title} <span className="tag tag-phase">即将推出</span>
        </h1>
        <div className="panel">
          {lines.map((l, i) => (
            <p key={i} className={i === lines.length - 1 ? "muted" : ""}>{l}</p>
          ))}
        </div>
      </div>
    </main>
  );
}
