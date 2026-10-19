/**
 * 团队共享（第 11 批 S11）的文字：错误代码 → 律师看得懂的说法；“立即同步”之后的一句话（复核 S11B-04③：有错误时不说“已是最新”）。
 */
import type { RelayReport } from "../api.ts";

/** 错误代码 → 律师看得懂的说法。 */
/** 团队同步告警的说明（第六轮复核 S11A-51/52）。 */
export function syncAlertText(a: { kind: string; title: string | null; peer_member?: string | null }): string {
  const t = a.title ? `「${a.title}」` : "一个团队事项";
  if (a.kind === "epoch_conflict")
    return `事项${t}的加密密钥在这台电脑与负责人${a.peer_member ? `（${a.peer_member}）` : ""}那里不一致（多为成员调整时这台电脑离线）：这台电脑暂停发出该事项的新改动，免得被移出的人读到。请这位负责人在其电脑上重新轮换密钥（例如移出后再加回任一成员），由他发出的新密钥送到后自动恢复；你是该事项的负责人时，也可以在这台电脑上重新轮换`;
  if (a.kind === "owner_unverifiable")
    return `事项${t}的负责人在这台电脑上暂时无法确认（原负责人的电脑已停用，这台电脑还没收到其他在用负责人的确认）：这台电脑暂停发出该事项的新改动、暂不能调整成员。在用的负责人同步一次后自动恢复；若负责人都已离所，请联系中软客服`;
  // 第 12 批：成员链的四种告警
  if (a.kind === "chain_pending")
    return `事项${t}有成员变更还在等确认（例如由已停用电脑做的变更，等在用的负责人确认；或部分变更还没送到）：这台电脑暂停发出该事项的新内容，只同步成员信息。在用的负责人同步一次后自动恢复；负责人都已离所时请联系中软客服`;
  if (a.kind === "rekey_needed")
    return `事项${t}有成员已被移出，但当前密钥仍包含他（多为两位负责人同时调整成员）：这台电脑暂停发出该事项的新内容，等负责人${a.peer_member ? `（${a.peer_member}）` : ""}的电脑同步时自动换新密钥后恢复；超过一天未处理，其他负责人的电脑会接手（经中软中继同步的事项只能由中继上的控制成员处理）`;
  if (a.kind === "epoch_superseded")
    return `事项${t}的密钥在两位负责人同时调整成员时有了两把，这台电脑手里的这把没有被采用：暂停发出新内容，收到被采用的那把后自动恢复并补发；长期不恢复，请负责人在其电脑上再换一次密钥（移出后再加回任一成员）`;
  if (a.kind === "root_conflict")
    return `事项${t}在这台电脑上的成员记录与${a.peer_member ? `负责人（${a.peer_member}）` : "另一位负责人"}发来的起点不同（多为升级时两台电脑各自整理了一次）：这台电脑暂停发出该事项的新内容。请与负责人核实后点“本机重新引导”：这台电脑清除该事项的成员记录链，之后只采用这台电脑记录里在册负责人发来的起点（经中软中继同步的事项只认中继上的控制成员）`;
  return `事项${t}的团队同步有异常（${a.kind}）`;
}

export function relayErrorText(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code === "waiting_for_owner") return "这个事项的负责人还没有经中继同步过：负责人的电脑同步一次后，这里的改动会自动发出";
  if (code === "epoch_not_established")
    return "这个事项的成员或密钥在本机有调整，中继上还没有生效：正在等中继上的控制成员的变更送达。若是在律所关闭共享中继期间做的移出，被移出的人仍能经中继收到其他成员的新内容——请由那位负责人在其电脑上重做移出，或联系中软客服重置该事项";
  if (code === "credential_backoff") return "暂时取不到中继的使用凭据（控制面可能暂时连不上），稍后自动重试";
  if (code === "relay_push_failed" || code === "relay_blob_failed" || code === "relay_import_failed") return "本机处理改动时出错（可能是文件被占用），稍后自动重试";
  if (code === "segment_too_large" || code === "too_many_readers") return "有一批改动过大或事项成员过多，无法经中继同步；请联系中软客服，或先经律所共享文件夹同步";
  if (code === "not_reader") return "这台电脑已不在其中某个事项里，那批改动没有发出";
  if (code === "relay_matter_conflict") return "中软中继上这个事项的状态异常（可能被他人抢先登记），改动暂存在本机；请联系中软客服处理，处理后会自动重发";
  if (code === "staging_full") return "这台电脑上暂存的同事材料过多，已暂停取回，处理完后自动继续";
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
  return "有改动没有同步成功";
}

/** “立即同步”之后的一句话（复核 S11B-04③）。 */
export function syncOutcomeText(r: { push: RelayReport; pull: RelayReport }): string {
  const errs = [...r.push.errors, ...r.pull.errors];
  const done = `发出 ${r.push.uploaded} 条改动，收到并合入 ${r.pull.applied} 条同事的改动`;
  if (errs.length === 0) return r.push.uploaded + r.pull.applied === 0 ? "已是最新" : done;
  return `${r.push.uploaded + r.pull.applied > 0 ? `${done}；` : ""}有部分没有完成：${relayErrorText(errs[0])}`;
}
