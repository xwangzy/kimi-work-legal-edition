/**
 * v9.3 第 14 批续：B-10 成员离所（交接清单、移出前提醒、成员表状态）与 B-9 团队同步告警收口（重新同步成员名单只给管理员与负责人；
 * 律师看得到的文字不讲密钥、起点、控制成员、中继、吊销）。纯函数与静态门禁。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { memberLabel, memberStatusText, offboardArchiveName, offboardingRow, offboardingSummary, removalLines } from "../src/lib/offboarding.ts";
import { canResyncMembers } from "../src/lib/relay-text.ts";
import type { OffboardingItem } from "../src/api.ts";

const JARGON = /密钥|纪元|起点|控制成员|中继|吊销|证书|设备目录/;
const item = (o: Partial<OffboardingItem>): OffboardingItem => ({ matter_id: "m1", title: "甲案", scope: "team", status: "ok", colleagues: [], ...o });
const bob = { user_id: "usr_f_bob", name: "王律师", role: "editor" };
const amy = { user_id: "usr_f_amy", name: null, role: "owner" };

test("B-10 交接清单的一行：个人事项看导出，团队事项交给同事；没有同事的团队事项也按导出处理", () => {
  assert.deepEqual(offboardingRow(item({ scope: "personal", status: "needs_archive" })), { state: "只在这台电脑上 · 还没有导出归档", action: "archive", candidates: [] });
  assert.equal(offboardingRow(item({ scope: "personal", status: "needs_archive", archived_at: "2026-10-20T01:00:00Z" })).state, "只在这台电脑上 · 导出后又有改动，要重新导出");
  assert.equal(offboardingRow(item({ scope: "personal", status: "ok", archived_at: "2026-10-20T01:00:00Z" })).action, "none");
  assert.equal(offboardingRow(item({ scope: "team", status: "needs_archive" })).state, "事项里已没有在用的同事 · 还没有导出归档");
  const owner = offboardingRow(item({ status: "needs_owner", colleagues: [bob, amy] }));
  assert.equal(owner.action, "handoff");
  assert.deepEqual(owner.candidates, [bob, amy], "没有别的负责人：谁都可以接手");
  const relay = offboardingRow(item({ status: "needs_handoff", colleagues: [bob, amy], relay_controller: true }));
  assert.deepEqual(relay.candidates, [amy], "管理权只能交给负责人");
  assert.equal(offboardingRow(item({ status: "ok", colleagues: [amy] })).action, "none");
});

test("B-10 清单顶上的一句话与移出前提醒", () => {
  assert.equal(offboardingSummary(null), "");
  assert.match(offboardingSummary({ matters: [], pending: 0 }), /不用交接/);
  assert.match(offboardingSummary({ matters: [item({}), item({})], pending: 1 }), /2 个事项里，还有 1 个没有交接好/);
  assert.match(offboardingSummary({ matters: [item({})], pending: 0 }), /都交接好了.*移出/);
  const none = removalLines({ name: "王律师", active_devices: 1, matters: [] });
  assert.equal(none.length, 2);
  assert.match(none[0]!, /王律师 的电脑不能再同步、不能用 AI、不能签发或导出，并释放 1 个席位/);
  assert.match(none[0]!, /无法远程删除/, "如实说明：已在他电脑上的内容收不回（复核 R15A-04）");
  for (const t of [...none, ...removalLines({ name: "甲", active_devices: 1, matters: [{ title: "乙", relay_controller: false }] })]) assert.doesNotMatch(t, /不能再打开本所事项/);
  assert.match(none[1]!, /离所交接/);
  const two = removalLines({ name: null, active_devices: 2, matters: [{ title: "甲案", relay_controller: true }] });
  assert.match(two[0]!, /这位同事 的 2 台电脑不能再同步/);
  assert.match(two[2]!, /「甲案」.*联系 Kimi Work 客服/);
  for (const t of [...none, ...two, offboardingSummary({ matters: [item({})], pending: 1 })]) assert.doesNotMatch(t, JARGON);
  for (const s of ["needs_archive", "needs_owner", "needs_handoff", "ok"] as const) {
    for (const scope of ["personal", "team"] as const) assert.doesNotMatch(offboardingRow(item({ scope, status: s, colleagues: s === "needs_archive" ? [] : [amy] })).state, JARGON);
  }
});

test("B-10 成员表：状态与姓名占位", () => {
  assert.equal(memberStatusText({ status: "active", is_me: true, removal: null }), "正常（你）");
  assert.equal(memberStatusText({ status: "active", is_me: false, removal: null }), "正常");
  assert.equal(memberStatusText({ status: "removed", is_me: false, removal: { removed_at: "x", seat_released: false, seat_error: "cp_unreachable" } }), "已移出 · 席位还没有释放（会自动再试）");
  assert.equal(memberStatusText({ status: "removed", is_me: false, removal: null }), "已移出");
  assert.equal(memberStatusText({ status: "devices_stopped", is_me: false, removal: null }), "电脑都已停用（还在律所，席位未释放）", "复核 R15A-02：只停用了电脑不算移出");
  assert.equal(offboardArchiveName("mat_5798f430-75ed-495c-9229-89da74388f0a", new Date("2026-10-20T08:00:00Z")), "离所归档-388f0a-2026-10-20.zip", "文件名不带事项标题（复核 R15A-15）");
  assert.equal(offboardingRow({ matter_id: "m", title: "t", scope: "team", status: "needs_archive", closed: true, colleagues: [] }).state, "已结案 · 还没有导出归档");
  assert.equal(memberLabel({ name: "林律师", member_id: "usr_f_lin", is_me: false }), "林律师");
  assert.equal(memberLabel({ name: null, member_id: "usr_f_m-0a1b2c3d4e", is_me: false }), "成员 2c3d4e");
  assert.equal(memberLabel({ name: null, member_id: "usr_f_lin", is_me: true }), "你");
});

test("B-9 “重新同步成员名单”只给管理员与该事项的负责人；界面按这个判断显示", () => {
  assert.equal(canResyncMembers(false, false), false);
  assert.equal(canResyncMembers(false, undefined), false, "还没查到是不是负责人：先不显示");
  assert.equal(canResyncMembers(false, true), true);
  assert.equal(canResyncMembers(true, undefined), true);
  const src = readFileSync(fileURLToPath(new URL("../src/components/TeamShare.tsx", import.meta.url)), "utf8");
  assert.match(src, /a\.kind === "root_conflict" && canResyncMembers\(admin, owners\[a\.matter_id\]\)/);
  assert.doesNotMatch(src, /window\.confirm\(/);
});

test("B-9 团队共享与离所交接：律师看得到的文字不讲密钥、起点、控制成员、中继（长说明只在管理员的“详情”里）", () => {
  const visible = (rel: string) => {
    const src = readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    return [...src.matchAll(/"(?:[^"\\\n]|\\.)*"/g), ...src.matchAll(/`(?:[^`\\]|\\.)*`/g), ...src.matchAll(/>([^<>{}]*[一-鿿][^<>{}]*)</g)].map((m) => m[0]).filter((t) => /[一-鿿]/.test(t));
  };
  // TeamShare：管理员“同步明细”与“详情”收起的内容来自 lib（syncAlertText、relayErrorText），这里只查组件自己的文字
  for (const f of ["components/TeamShare.tsx", "components/Offboarding.tsx", "components/DepartedMembers.tsx", "components/MembersAdmin.tsx"]) {
    const hits = visible(f).filter((t) => JARGON.test(t));
    assert.deepEqual(hits, [], `${f} 里有研发用语：${hits.join(" | ")}`);
  }
});
