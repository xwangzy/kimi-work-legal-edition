/**
 * “发送什么、发给谁”（第 27 批，评审 U3-01）：开始前确认与场景卡开始面板共用同一块——同一份数据（内核 runs.estimate 的
 * bullets + bullet_kinds + preview_rows），同一套记号（→ 去向、✓ 换成代号、橙点 按原文、灰点 检索与留存）。
 * 原来卡片路径只有一段折叠的长句，“没认出的姓名也按原文”埋在括号里；输入框路径是五条记号要点——两条入口披露不一致。
 */
import type { ReactNode } from "react";

export interface DataWhereView {
  preview?: string;
  preview_rows?: { label: string; text: string }[];
  bullets?: string[];
  bullet_kinds?: string[];
}

export function SendPoints({ dataWhere, children }: { dataWhere: DataWhereView | undefined; children?: ReactNode }) {
  const bullets = dataWhere?.bullets ?? [];
  return (
    <section className="sheet-privacy" aria-label="发送什么、发给谁">
      <div className="sheet-privacy-title">发送什么、发给谁</div>
      {bullets.length ? (
        <ul className="sheet-points">
          {bullets.map((b, i) => (
            <li key={i} data-kind={dataWhere?.bullet_kinds?.[i] ?? undefined}>
              {b}
            </li>
          ))}
        </ul>
      ) : (
        <p>{dataWhere?.preview ?? "—"}</p>
      )}
      {children}
      {bullets.length && dataWhere?.preview ? (
        <details className="sheet-detail">
          <summary>完整说明</summary>
          {/* 第 27 批（评审 U2-25）：内核给了分行就一项一行排成表（文字与整段相同）；没给时照旧显示整段 */}
          {dataWhere.preview_rows?.length ? (
            <dl className="sheet-detail-rows">
              {dataWhere.preview_rows.map((r) => (
                <div key={r.label} className="sheet-detail-row">
                  <dt>{r.label}</dt>
                  <dd>{r.text}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>{dataWhere.preview}</p>
          )}
        </details>
      ) : null}
    </section>
  );
}
