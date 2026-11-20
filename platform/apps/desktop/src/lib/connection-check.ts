/**
 * 检测连接（第 52 批（IP 部署））的纯函数：复制给 IT 的说明（与表格同一份内容；钉住值只有内核给的短前缀）。
 */
import type { ConnectionDiagnosis } from "../api.ts";
import { fmtTime } from "./labels.ts";

/** 复制给 IT 的纯文本（与表格同一份内容；钉住值只有短前缀）。 */
export function connectionReport(d: ConnectionDiagnosis): string {
  const lines = d.rows.map((r) => {
    const addr = r.host ? `${r.host}${r.port ? `:${r.port}` : ""}` : "—";
    const extra = [r.pins.length ? `内置 ${r.pins.join(" ")}` : "", r.presented.length ? `服务器出示 ${r.presented.join(" ")}` : "", r.cloud_ca ? "测试包" : ""].filter(Boolean).join("；");
    return `${r.name}｜${addr}｜${r.label}｜${r.class}｜${r.elapsed_ms} ms${extra ? `｜${extra}` : ""}`;
  });
  return [`Kimi Work 法律版 连接检测（${fmtTime(d.checked_at)}）`, d.conclusion, ...lines].join("\n");
}
