/**
 * 第 69 批（V43）：登录类卡片统一与电脑数已满“选一台移除”（D-297）的纯函数与源码约束。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agoLabel, defaultRemovalPick, deviceChoiceLine, deviceOrdinal, reloginView, type AccountDevice } from "../src/lib/account.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");
const NOW = Date.parse("2026-11-26T06:00:00.000Z"); // 北京 14:00
const dev = (id: string, o: Partial<AccountDevice> = {}): AccountDevice => ({ device_id: id, registered_at: "2026-11-01T02:00:00.000Z", client_version: "0.9.0", last_seen_on: null, ...o });

test("设备编号可到三位数（个人账号自第 66 批、团队成员自第 69 批）：第 10 台起不再显示成“第 1 台”", () => {
  assert.equal(deviceOrdinal("dev_firm_wang"), 1);
  assert.equal(deviceOrdinal("dev_firm_wang_D2"), 2);
  assert.equal(deviceOrdinal("dev_firm_wang_D12"), 12);
  assert.equal(deviceOrdinal("dev_firm_wang_D999"), 999);
});

test("电脑数已满的一行：电脑类型、最近使用（相对时间）、版本、是否登录中；旧云端没有平台时写第几台", () => {
  const a = deviceChoiceLine(dev("dev_f_m_D3", { platform: "darwin", last_seen_at: "2026-11-26T05:50:00.000Z", session: "active" }), NOW);
  assert.equal(a.title, "Mac 电脑 · 第 3 台");
  assert.equal(a.meta, "最近使用 10 分钟前 · 11 月 1 日登记 · 版本 0.9.0");
  assert.equal(a.active, true);
  const b = deviceChoiceLine(dev("dev_f_m_D2", { platform: "win32", last_seen_at: "2026-11-25T01:00:00.000Z" }), NOW);
  assert.equal(b.title, "Windows 电脑 · 第 2 台");
  assert.match(b.meta, /^最近使用 昨天 09:00/);
  const c = deviceChoiceLine(dev("dev_f_m_D4", { last_seen_on: "2026-11-26", client_version: "legacy" }), NOW);
  assert.equal(c.title, "第 4 台电脑");
  assert.equal(c.meta, "最近使用 今天 · 11 月 1 日登记", "旧客户端的占位版本不给律师看");
  // 第五轮：登记后再没用过（两个时刻相差不到 2 分钟）只写“最近使用”
  assert.equal(deviceChoiceLine(dev("dev_f_m_D5", { platform: "darwin", registered_at: "2026-11-26T05:40:00.000Z", last_seen_at: "2026-11-26T05:41:00.000Z" }), NOW).meta, "最近使用 19 分钟前 · 版本 0.9.0");
  assert.equal(agoLabel("2026-11-26T05:59:30.000Z", NOW), "刚刚");
  assert.equal(agoLabel("2026-11-20T05:59:30.000Z", NOW), "11 月 20 日");
});

test("默认预选：最久没用、不在登录中的那台（律师多半要换掉它）；都在登录中时挑最久没用的；没有可选的为 null", () => {
  const list = [
    dev("d_new", { last_seen_at: "2026-11-26T05:00:00.000Z", session: "active" }),
    dev("d_old_active", { last_seen_at: "2026-11-01T05:00:00.000Z", session: "active" }),
    dev("d_mid", { last_seen_at: "2026-11-20T05:00:00.000Z", session: "none" }),
    dev("d_older", { last_seen_on: "2026-11-10", session: "none" }),
  ];
  assert.equal(defaultRemovalPick(list), "d_older", "不在登录中的里面最久没用的");
  assert.equal(defaultRemovalPick(list.filter((d) => d.session === "active")), "d_old_active");
  assert.equal(defaultRemovalPick([]), null);
});

test("选一台移除：整卡（一个标题）、单选、默认预选、主按钮“移除并继续”；不自动替换；客户端不另设上限", () => {
  const s = src("components/DeviceLimitList.tsx");
  assert.match(s, /data-auth-step="device-limit"/);
  // 第 71 批（V45，D-298 与独立评分区域 9）：可选的多于一台才用单选；只有一台时整行就是目标、按钮写出它的名字；旧云端（不能让出）按移除口径写
  assert.match(s, /role=\{actionable && !single \? "radiogroup" : "list"\}/);
  assert.match(s, /defaultRemovalPick\(removable\)/);
  assert.match(s, /移除并继续/);
  assert.match(s, /移除「\$\{targetName\}」并继续/);
  assert.match(s, /让「\$\{targetName\}」退出登录，在这台继续/);
  assert.match(s, /最多同时在 \{n\} 台电脑上登录/);
  assert.match(s, /最多可用 \{n\} 台电脑/);
  // 上限只来自云端（limit = 云端 device_limit；没给时按列表台数说），界面没有写死的台数
  assert.doesNotMatch(s.replace(/\/\*[\s\S]*?\*\//g, ""), /\b(?:20|9)\s*台/);
  // 重新登录页里换成选电脑时外层标题让位
  assert.match(src("styles-auth.css"), /\.auth-card-body:has\(\[data-auth-step="device-limit"\]\) > \.auth-title-row/);
});

test("登录类卡片的小字：页脚一句隐私说明；注册不再有复选框说明、凭码说明与常驻密码规则", () => {
  assert.match(src("components/AuthShell.tsx"), /登录只核对账号信息，你的案卷不会上传/);
  const a = src("pages/Activate.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(a, /FOOT_TEXT|只把邮箱或手机号、密码或短信验证码、开通码或邀请码发给/);
  assert.doesNotMatch(a, /凭开通码或同事邀请码注册时，律所以码对应的为准|不勾选即自助注册试用的个人工作室/);
  assert.match(src("components/PasswordField.tsx"), /rulesShown = !!p\.rules && \(focus \|\| p\.value !== ""\) && hints\.some\(\(h\) => !h\.ok\)/);
  assert.equal(reloginView("account_disabled").title, "账号已停用");
  assert.match(reloginView("expired").lead, /重新登录/);
});
