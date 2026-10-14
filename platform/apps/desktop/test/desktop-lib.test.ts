/**
 * 桌面界面的纯函数（不依赖 DOM）：
 * - 预览样式清洗（复核 S5-B15）：解开 CSS 转义与注释后判断，url() 只允许 data: 图片与字体，image-set 等一律去掉；
 * - 执行位置徽标（复核 S5-A04）：由运行状态、场景、事项端点、全部化名与在途出站生成，不靠推断。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cssHasExternalRef, scrubCss } from "../src/lib/css-scrub.ts";
import { currentBadges, type BadgeFacts } from "../src/lib/badges.ts";

test("预览样式清洗：外部引用（含转义、注释拆分、image-set、@import、src()）整条去掉；data: 图片与普通样式保留", () => {
  const external = [
    "background:url(http://tracker.invalid/a.png)",
    "background:url( 'https://tracker.invalid/a.png' )",
    "background:\\75 rl(http://tracker.invalid/a.png)",
    "background:\\000075rl(http://tracker.invalid/a.png)",
    "background:u\\rl(http://tracker.invalid/a.png)",
    "background:ur/**/l(http://tracker.invalid/a.png)",
    "background-image:image-set(\"http://tracker.invalid/a.png\" 1x)",
    "background-image:-webkit-image-set(url(http://tracker.invalid/a.png) 1x)",
    "@import 'http://tracker.invalid/x.css';",
    "@\\69mport 'http://tracker.invalid/x.css';",
    "content:image('http://tracker.invalid/a.png')",
    "background:url(//tracker.invalid/a.png)",
    "background:url(http://tracker.invalid/a.png",
    "-moz-binding:url(http://tracker.invalid/x.xml#b)",
    "width:expression(alert(1))",
  ];
  for (const css of external) {
    assert.equal(cssHasExternalRef(css), true, css);
    assert.equal(scrubCss(css), "", css);
  }
  const safe = ["color:#333;font-weight:bold", "background:url(data:image/png;base64,iVBORw0KGgo=)", "background:linear-gradient(#fff,#eee)", "font-family:'PingFang SC'"];
  for (const css of safe) {
    assert.equal(cssHasExternalRef(css), false, css);
    assert.equal(scrubCss(css), css, css);
  }
});

const base: BadgeFacts = { status: "running", scenario: "a1.agent_task", endpoint: "standard", fullPseudonym: false, inflight: { model: 0, search: 0, fetch: 0 }, openTools: [], execOpen: false };
const labels = (f: Partial<BadgeFacts>) => currentBadges({ ...base, ...f }).map((b) => b.label);

test("执行位置徽标：由事实生成——排队、恢复、预算暂停、等待各有文案；“模型推理中”只在有在途模型请求时出现，去向按端点、代号范围按全部化名", () => {
  assert.deepEqual(labels({ status: "queued" }), ["排队中"]);
  assert.deepEqual(labels({ status: "recovering" }), ["恢复中（从最后检查点继续）"]);
  assert.deepEqual(labels({ status: "budget_paused" }), ["预算暂停（等你决定）"]);
  assert.deepEqual(labels({ status: "waiting_approval" }), ["等待你确认"]);
  assert.deepEqual(labels({ status: "waiting_device" }), ["等待电脑上线"]);
  assert.deepEqual(labels({ status: "succeeded" }), []);
  // 退出模式：排队与恢复中的任务暂停（阶段 6 复核 S6-C12）；等待律师的照旧
  assert.deepEqual(labels({ status: "queued", exitMode: "license_expired" }), ["暂停（退出模式：恢复许可后自动继续）"]);
  assert.deepEqual(labels({ status: "recovering", exitMode: "license_missing" }), ["暂停（退出模式：恢复许可后自动继续）"]);
  assert.deepEqual(labels({ status: "queued", exitMode: "device_revoked" }), ["已暂停（本设备已被吊销，不会继续）"], "复核 S6-C18");
  assert.deepEqual(labels({ status: "queued", exitMode: "control_plane_unconfigured" }), ["暂停（控制面地址未配置）"]);
  assert.deepEqual(labels({ status: "waiting_approval", exitMode: "license_expired" }), ["等待你确认"]);
  assert.deepEqual(labels({ status: "queued", exitMode: null }), ["排队中"]);
  // 没有在途模型请求：不写“模型推理中”
  assert.deepEqual(labels({}), ["本机处理中"]);
  assert.deepEqual(labels({ scenario: "s6.redaction" }), ["本机处理中（本场景不调用模型、不联网）"]);
  // 在途模型请求：按端点写去向，按全部化名写代号范围
  assert.match(labels({ inflight: { model: 1, search: 0, fetch: 0 } })[0]!, /经中软网关；证件、账户、联系方式与自然人姓名已替换为代号/);
  assert.match(labels({ inflight: { model: 1, search: 0, fetch: 0 }, fullPseudonym: true })[0]!, /自然人姓名与机构名称已替换为代号/);
  assert.match(labels({ inflight: { model: 1, search: 0, fetch: 0 }, endpoint: "byok" })[0]!, /自带密钥.*不经中软/);
  assert.match(labels({ inflight: { model: 1, search: 0, fetch: 0 }, endpoint: "private" })[0]!, /律所私有模型/);
  // 执行域与检索、抓取
  assert.deepEqual(labels({ openTools: ["Bash"] }), ["本机 · 运行时隔离（W）"]);
  assert.ok(labels({ inflight: { model: 0, search: 1, fetch: 0 } }).some((l) => l.startsWith("联网检索中")));
  assert.ok(labels({ openTools: ["FetchURL"] }).some((l) => l.startsWith("抓取公开网页中")));
});
