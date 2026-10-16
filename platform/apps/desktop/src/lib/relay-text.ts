/**
 * 团队共享（第 11 批 S11）的文字：错误代码 → 律师看得懂的说法；“立即同步”之后的一句话（复核 S11B-04③：有错误时不说“已是最新”）。
 */
import type { RelayReport } from "../api.ts";

/** 错误代码 → 律师看得懂的说法。 */
export function relayErrorText(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code === "waiting_for_owner") return "这个事项的负责人还没有经中继同步过：负责人的电脑同步一次后，这里的改动会自动发出";
  if (code === "epoch_not_established") return "事项负责人刚调整过成员，正在等负责人的变更先送达，会自动重试";
  if (code === "segment_too_large" || code === "too_many_readers") return "有一批改动过大或事项成员过多，无法经中继同步；请联系中软客服，或先经律所共享文件夹同步";
  if (code === "not_reader") return "这台电脑已不在其中某个事项里，那批改动没有发出";
  if (code === "inbox_full") return "这台电脑上等待处理的同事改动过多，已暂停取回，处理完后自动继续";
  if (code === "export_failed") return "整理本机改动时出错（可能是磁盘已满），稍后自动重试";
  if (code === "device_pending_full") return "这台电脑上传了较多尚未完成的内容，稍后自动继续";
  if (code === "tenant_storage_full") return "本所在中软中继上的存储已满，请联系中软客服";
  if (code === "tenant_unavailable") return "中软中继暂时不可用（服务端正在恢复），会自动重试";
  if (/^tls_|_tls_/.test(code)) return "与中软中继的加密连接核对未通过，已停止收发（请联系 IT）";
  if (/timeout|connect|unreachable|gate_|http_5|relay_error/.test(code)) return "暂时连不上中软中继，会自动重试";
  if (/credential_|no_seat|seat_revoked|license/.test(code)) return "席位或许可暂时不可用，团队共享已暂停";
  if (code === "relay_not_allowed") return "中软中继按本所策略拒绝了请求（策略可能刚更改），稍后自动重试";
  if (/digest_mismatch|blob_mismatch|blob_ref_invalid/.test(code)) return "有一份同事的改动在中继上核对不通过，已跳过并会重试";
  return "有改动暂时没有同步成功，会自动重试";
}

/** “立即同步”之后的一句话（复核 S11B-04③）。 */
export function syncOutcomeText(r: { push: RelayReport; pull: RelayReport }): string {
  const errs = [...r.push.errors, ...r.pull.errors];
  const done = `发出 ${r.push.uploaded} 条改动，收到并合入 ${r.pull.applied} 条同事的改动`;
  if (errs.length === 0) return r.push.uploaded + r.pull.applied === 0 ? "已是最新" : done;
  return `${r.push.uploaded + r.pull.applied > 0 ? `${done}；` : ""}有部分没有完成：${relayErrorText(errs[0])}`;
}
