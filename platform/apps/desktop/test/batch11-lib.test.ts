/**
 * 第 11 批 S11 团队共享界面文字（复核 S11B-04、S11B 第四节第 14 项）：错误代码映射到律师看得懂的说法；
 * “立即同步”有错误时如实说明，不说“已是最新”。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { relayErrorText, syncAlertText, syncOutcomeText } from "../src/lib/relay-text.ts";

const rep = (o: Partial<{ uploaded: number; applied: number; errors: string[] }> = {}) => ({ ran: true, exported: 0, uploaded: o.uploaded ?? 0, downloaded: 0, applied: o.applied ?? 0, held: 0, dropped: 0, errors: o.errors ?? [] });

test("错误代码映射：每类代码给出对应说法；未知代码给通用说法；空值不显示", () => {
  assert.equal(relayErrorText(null), null);
  assert.equal(relayErrorText(""), null);
  assert.match(relayErrorText("waiting_for_owner")!, /负责人/);
  assert.match(relayErrorText("epoch_not_established")!, /最先同步该事项的负责人/);
  assert.match(relayErrorText("segment_too_large")!, /过大/);
  assert.match(relayErrorText("relay_connect_failed")!, /连不上/);
  assert.match(relayErrorText("relay_timeout")!, /连不上/);
  assert.match(relayErrorText("relay_tls_pin_mismatch")!, /加密连接/);
  assert.match(relayErrorText("credential_no_seat")!, /席位或许可/);
  assert.match(relayErrorText("tenant_storage_full")!, /存储已满/);
  assert.match(relayErrorText("relay_chunk_digest_mismatch")!, /核对不通过/);
  assert.match(relayErrorText("not_reader")!, /已不在/);
  assert.match(relayErrorText("export_failed")!, /磁盘/);
  assert.equal(relayErrorText("something_new"), "有改动没有同步成功", "未知代码不承诺会自动重试（第二轮复核 S11B-23③）");
  assert.match(relayErrorText("credential_backoff")!, /控制面/);
  assert.match(relayErrorText("relay_matter_conflict")!, /中软客服/);
  // epoch_jump 已不存在：不再说成“会自动重试”而实际卡死（复核 S11B 第六节）
  assert.equal(relayErrorText("epoch_not_established")!.includes("连不上"), false);
});

test("立即同步的结果：成功且无改动说“已是最新”；有错误时说明没完成的原因，不说“已是最新”", () => {
  assert.equal(syncOutcomeText({ push: rep(), pull: rep() }), "已是最新");
  assert.equal(syncOutcomeText({ push: rep({ uploaded: 2 }), pull: rep({ applied: 1 }) }), "发出 2 条改动，收到并合入 1 条同事的改动");
  const e = syncOutcomeText({ push: rep({ errors: ["waiting_for_owner"] }), pull: rep() });
  assert.ok(!e.includes("已是最新") && e.includes("负责人"), e);
  // 退避中的段：立即同步会强制再试，仍失败就有错误代码，不会说“已是最新”
  assert.ok(!syncOutcomeText({ push: rep({ errors: ["epoch_not_established"] }), pull: rep() }).includes("已是最新"));
  const mixed = syncOutcomeText({ push: rep({ uploaded: 1 }), pull: rep({ errors: ["relay_connect_failed"] }) });
  assert.ok(mixed.startsWith("发出 1 条改动") && mixed.includes("连不上"), mixed);
});

test("第六轮：团队同步告警的说明（纪元冲突、负责人无法确认）写明本机暂停发出与出路，不含内容", () => {
  const c = syncAlertText({ kind: "epoch_conflict", title: "甲案", peer_member: "usr_x" });
  assert.match(c, /「甲案」/);
  assert.match(c, /usr_x/, "写明冲突的另一方");
  assert.match(c, /暂停发出/);
  assert.match(c, /重新轮换密钥/);
  const o = syncAlertText({ kind: "owner_unverifiable", title: null });
  assert.match(o, /一个团队事项/);
  assert.match(o, /自动恢复/);
  assert.doesNotMatch(o, /交接/, "不断言发生过交接（第七轮复核 S11A-55）");
});
