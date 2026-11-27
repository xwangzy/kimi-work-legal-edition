/**
 * 第 71 批（V45）登录类页面、设备选择与设置·账号打磨（研究目录 08-登录与设备界面打磨.md）：
 * 1. 称呼本人“姓名（138****0000）”（accountWho / maskPhoneTight）；
 * 2. 找回密码合并为一个“手机号或邮箱”框（resetIdKind）；开通页与重新登录页同一个 ResetPasswordForm；
 * 3. 重新登录只填验证码：发码失败除限频外一律退回可输入手机号（reloginSmsFailure）；
 * 4. 被让出的三种原因（本人 / 律所管理员 / 客服协助）与同时登录已满的标题说明（reloginView / loginRequiredText）；
 * 5. 电脑选择卡：只有一台可选时不显示单选、按钮写名字；移除用琥珀色风险提示；旧云端只能移除时按移除口径写；
 * 6. 登录记录“Mac 电脑 · 第 1 台”，状态词“登录中”；上手清单“收起”改为 ×。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { accountWho, deviceDisplayName, loginRequiredText, maskPhoneTight, momentLabel, recentLoginRows, reloginSmsFailure, reloginView, resetIdKind, sessionLine } from "../src/lib/account.ts";

const src = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");
const err = (reason: string | null, extra: Record<string, unknown> = {}) => Object.assign(new Error("x"), { code: "validation", detail: { ...(reason ? { reason } : {}), ...extra } });

test("称呼本人：姓名（打码手机号）；云端给的打码号原样去空格；没有手机号写姓名，再没有写邮箱", () => {
  assert.equal(accountWho({ name: "陈律师", phone: "139****7001", email: "chen@x.example" }), "陈律师（139****7001）");
  assert.equal(accountWho({ name: "陈律师", phone: "13900007001" }), "陈律师（139****7001）", "本机输入的完整号码在这里打码");
  assert.equal(accountWho({ name: "陈律师", phone: null, email: "chen@x.example" }), "陈律师");
  assert.equal(accountWho({ name: "", phone: "", email: "chen@x.example" }), "chen@x.example");
  assert.equal(accountWho(null), null);
  assert.equal(maskPhoneTight("139 **** 7001"), "139****7001");
  assert.equal(maskPhoneTight("abc"), "abc");
});

test("找回密码一个框：11 位手机号（云端开了手机号找回）/ 邮箱 / 认不出", () => {
  assert.equal(resetIdKind("13800007818", true), "phone");
  assert.equal(resetIdKind("13800007818", false), null, "云端没开手机号找回时只认邮箱");
  assert.equal(resetIdKind(" lin@x.example ", true), "email");
  assert.equal(resetIdKind("1380000", true), null);
  const a = src("pages/Activate.tsx");
  const panel = src("components/AccountPanel.tsx");
  assert.match(a, /<ResetPasswordForm meta=\{p\.meta\} prefill=\{p\.email\}/, "开通页只预填");
  assert.match(panel, /<ResetPasswordForm\s+meta=\{meta\}\s+prefill=\{email\}/, "重新登录页只预填");
  assert.doesNotMatch(panel, /function ResetBox/, "重新登录页的旧找回流程已删");
  assert.doesNotMatch(a, /用手机号[\s\S]{0,40}用邮箱/, "不再有“用手机号 | 用邮箱”页签");
});

test("重新登录只填验证码：限频照常倒计时；其余失败（没绑手机号、旧云端 400、签名不通过）退回可输入手机号", () => {
  assert.equal(reloginSmsFailure(err("rate_limited", { retry_after_s: 30 })), "wait");
  assert.equal(reloginSmsFailure(err(null, { retry_after_s: 12 })), "wait");
  assert.equal(reloginSmsFailure(err("phone_unbound")), "fallback");
  assert.equal(reloginSmsFailure(err("phone_invalid")), "fallback", "旧云端不认 relogin，回 phone_invalid");
  assert.equal(reloginSmsFailure(err("device_auth_missing")), "fallback");
  assert.equal(reloginSmsFailure(new Error("network")), "fallback");
  const panel = src("components/AccountPanel.tsx");
  assert.match(panel, /account\.smsSendRelogin\(\)/);
  assert.match(panel, /account\.loginRelogin\(smsCode\.trim\(\)\)/);
  assert.match(panel, /reloginSmsFailure\(e\) === "fallback"\) return p\.onUnavailable\(\)/);
  assert.match(panel, /const reloginAccount = page && subtle && !!initialEmail;/, "只在回到这台电脑原来的账号时（换个账号、已移除时照旧输手机号）");
});

test("被让出的三种原因与同时登录已满：标题同一句“这台电脑已退出登录”，说明写清谁让它退出、资料都在", () => {
  for (const [r, who] of [["session_signed_out", "另一台电脑"], ["session_signed_out_admin", "律所管理员"], ["session_signed_out_support", "客服协助"]] as const) {
    const v = reloginView(r);
    assert.equal(v.title, "这台电脑已退出登录", r);
    assert.match(v.lead, new RegExp(who), r);
    assert.match(v.lead, /事项和成果都还在这台电脑上，重新登录即可继续/, r);
  }
  assert.match(loginRequiredText("session_signed_out_admin"), /^律所管理员让这台电脑退出了登录，请重新登录/);
  assert.match(loginRequiredText("session_signed_out_support"), /^客服协助让这台电脑退出了登录，请重新登录/);
  const lim = reloginView("session_device_limit");
  assert.equal(lim.title, "同时登录的电脑已达上限", "与电脑数已满选择卡同一句");
  assert.match(lim.lead, /选一台让它退出登录/);
});

test("电脑选择卡：只有一台可选不显示单选、按钮写名字；移除用琥珀色提示；这台电脑排最前、不置灰；旧云端按移除口径", () => {
  const s = src("components/DeviceLimitList.tsx");
  assert.match(s, /const single = choices\.length === 1/);
  // 第 72 批（D-303）：整卡可点，选中态是描边 + 勾（不再是单选圈与大黑框）；登录中不再每行挂标签，只一个小绿点
  assert.match(s, /\{actionable && can && \(\s*<span className=\{`auth-device-check/);
  assert.match(s, /className="auth-device-dot" title="登录中"/);
  assert.match(s, /className="auth-warn" role="note"/);
  assert.match(s, /你正在这台电脑上登录/);
  assert.match(s, /removeOnly \? `已有 \$\{n\} 台电脑`/);
  const css = src("styles-auth.css");
  assert.match(css, /\.auth-card \.auth-warn \{[^}]*var\(--status-warning-bg-soft\)[^}]*var\(--status-warning-text\)/);
  assert.match(css, /\.auth-device-row\.is-this \{[^}]*border-style: dashed/);
  // 禁用主按钮：浅灰底中灰字（令牌），登录类卡片不再写白字
  assert.match(css, /\.auth-card \.activate-submit:disabled, \.auth-card \.auth-btn:disabled \{ background: var\(--btn-primary-disabled\); border-color: transparent; color: var\(--btn-primary-disabled-text\);/);
});

test("登录类卡片：每页一个标题、页签 14 号；浮动标签；密码规则收起不占位；辅助链接两种样式", () => {
  const css = src("styles-auth.css");
  assert.match(css, /\.auth-card \.auth-method button \{[^}]*font-size: var\(--fs-body\)/);
  assert.match(css, /\.field:has\(\.auth-input:not\(:placeholder-shown\)\) > span:first-child/);
  assert.match(css, /\.auth-card \.pw-rules\.idle \{ display: none; \}/);
  // 第三轮：“律所名称 / 邀请码”也是句内操作（黑色下划线），链接行里不再有灰色例外
  assert.match(css, /\.auth-links \.btn-link, \.auth-devlimit \.btn-link\.auth-alt-link \{[^}]*color: var\(--text-primary\); text-decoration: underline;/);
  assert.match(css, /\.auth-title-row \.btn-link, \.auth-alt \.btn-link[^{]*\{[^}]*color: var\(--text-secondary\);[^}]*text-decoration: none;/);
  assert.match(css, /\.auth-card-body:has\(\[data-auth-step="forgot"\]\) > \.auth-reloginwho/, "重新登录页切到找回密码时身份卡让位");
  const a = src("pages/Activate.tsx");
  assert.match(a, /不验证手机号，用邮箱注册/);
  assert.doesNotMatch(a, />\s*跳过\s*</);
});

test("设置·账号：登录记录“Mac 电脑 · 第 1 台”、账号卡状态“登录中”、改名反馈就地且可撤销；上手清单“收起”改为 ×", () => {
  const s = sessionLine({ sid: "ses_aaaaaaaaaaaaaaaa", kind: "desktop", device_id: "dev_firm_li", created_at: "2026-11-26T01:00:00Z", last_seen_at: "2026-11-26T01:00:00Z", idle_expires_at: "2026-12-26T01:00:00Z", client: { platform: "darwin" }, current: true }, Date.parse("2026-11-26T01:00:30Z"));
  assert.equal(s.title, "Mac 电脑 · 第 1 台 · 当前这次登录");
  assert.match(s.meta, /最近活动 刚刚/);
  const panel = src("components/AccountPanel.tsx");
  assert.match(panel, /<span className="pill pill-green">登录中<\/span>/);
  assert.doesNotMatch(panel, />已登录</);
  assert.match(panel, /undo: prev/);
  assert.doesNotMatch(panel, /setMsg\(`已移除/);
  const g = src("components/GuideChecklist.tsx");
  assert.match(g, /className="icon-btn guide-checklist-close" onClick=\{hide\}/);
  assert.doesNotMatch(g, />\s*收起\s*</);
});

test("第二轮：重新登录页用内核给的打码手机号（last_account.phone）与本机其他账号个数（other_profiles）", () => {
  const r = src("pages/Relogin.tsx");
  assert.match(r, /x\.last_account && \(!p\.email \|\| x\.last_account\.email === p\.email\)/, "只用同一个账号的号码");
  assert.match(r, /acct\?\.phone \?\? \(who && p\.email \? p\.email : ""\)/, "身份卡副标题写打码手机号，没有时写邮箱");
  assert.match(r, /这台电脑上还有 \$\{others\} 个账号/);
  assert.doesNotMatch(r, /other_profiles[\s\S]{0,200}name/, "不列其他账号的姓名");
  const panel = src("components/AccountPanel.tsx");
  assert.match(panel, /const codeOnly = reloginAccount && !codeOnlyOff && knownPhone !== null;/, "内核明确没有号码时直接用可输入手机号的原流程");
  assert.match(panel, /const masked = sent \?\? \(p\.knownPhone \? maskPhoneTight\(p\.knownPhone\) : null\);/, "发码前就显示打码号");
});

test("第三轮：最近登录同一个名字、中文时刻、新电脑先登录后登记合并；分区名“最近登录 / 仍有效的登录”", () => {
  const now = Date.parse("2026-11-26T12:50:00Z");
  const dev = (o: Record<string, unknown>) => ({ device_id: "dev_t_t", platform: "darwin", registered_at: "2026-11-26T12:00:00Z", ...o }) as never;
  const devices = [dev({ device_id: "dev_t_t", current: true, name: "办公室 iMac" }), dev({ device_id: "dev_t_t_D2" })];
  const rows = recentLoginRows(
    [
      { at: "2026-11-26T12:41:00Z", kind: "login", device_id: "dev_t_t", platform: "darwin", net: "127.0.x.x" },
      { at: "2026-11-26T12:40:30Z", kind: "enroll", device_id: "dev_t_t_D2", platform: "darwin", net: "127.0.x.x" },
      { at: "2026-11-26T12:40:00Z", kind: "login", device_id: null, platform: "darwin", net: "127.0.x.x" },
      { at: "2026-11-20T01:00:00Z", kind: "login", device_id: null, platform: "win32", net: "未知" },
    ],
    devices,
    now,
  );
  assert.deepEqual(rows.map((r) => r.title), ["办公室 iMac · 这台电脑 · 登录", "Mac 电脑 · 第 2 台 · 新电脑登录并登记", "新电脑登录（没有完成登记）"]);
  assert.equal(rows[0]!.meta, "今天 20:41 · macOS · 网段 127.0.x.x");
  assert.equal(rows[2]!.meta, "11 月 20 日 09:00 · Windows");
  assert.equal(momentLabel("2026-11-25T13:05:00Z", now), "昨天 21:05");
  assert.equal(momentLabel("2025-03-01T01:00:00Z", now), "2025 年 3 月 1 日 09:00");
  assert.equal(deviceDisplayName({ device_id: "dev_t_t_D2", platform: "darwin", name: null }), "Mac 电脑 · 第 2 台");
  const panel = src("components/AccountPanel.tsx");
  assert.match(panel, /<SettingRow label="仍有效的登录"/);
  assert.doesNotMatch(panel, /label="登录记录"/);
  assert.doesNotMatch(panel, /还没登记的电脑|toLocaleString/);
  assert.match(panel, /\{d\.current && <span className="tag tag-this">这台电脑<\/span>\}/);
});
