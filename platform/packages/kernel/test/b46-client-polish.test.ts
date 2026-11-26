/**
 * 第 46 批（主文 §5，D-195）客户端产品化修补的内核侧：发起前检查、错误文案去术语、账号错误映射收敛、单任务用量口径。纯函数与小桩，不起内核。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SoftwareSigner } from "@zr-legal/keys";
import { accountFailure, accountErrorText, clientOutdatedText, controlPlaneErrorText, onboardingStateText } from "../src/account-session.ts";
import { launchCheck, QUOTA_VIEW_MAX_AGE_MS, type LaunchQuotaView } from "../src/services/launch-check.ts";
import { chargedDisplay, estimateDisplay } from "../src/services/usage-display.ts";
import { agentFailureText } from "../src/executor/executor.ts";
import { ControlPlaneClient } from "../src/control-plane/client.ts";

// “席位”是律所买的账号数，律师认得；“席位令牌”“控制面”这类才是研发用语
const JARGON = /控制面|席位令牌|令牌|出站闸门|预占|budget_points|开发形态|\bseat_|\bquota_|\b[a-z]+_[a-z_]+\b/;
const NOW = Date.parse("2026-11-19T10:00:00Z");
const view = (over: Partial<LaunchQuotaView> & { paused?: LaunchQuotaView["firm"]["paused"] } = {}): LaunchQuotaView => ({
  period: { kind: "month", resets_at: "2026-12-01T00:00:00Z" },
  firm: { paused: over.paused ?? null, cap_pct: 80 },
  burst: { hours: 5, resets_at: "2026-11-19T12:30:00Z" },
  own: null,
  ...over,
});
const base = { viaGateway: true, accountProblem: null, clientOutdated: null, quota: null, now: NOW };

test("发起前检查：要重新登录、账号停用、客户端过旧——不排队，给原因与入口", () => {
  const login = launchCheck({ ...base, accountProblem: "session_expired" });
  assert.equal(login?.kind, "login");
  assert.equal(login?.action, "login");
  assert.match(login!.message, /^登录已失效：请先重新登录/);
  const disabled = launchCheck({ ...base, accountProblem: "account_disabled" });
  assert.match(disabled!.message, /账号已停用.*律所管理员/);
  assert.equal(disabled!.action, null, "停用的账号重新登录也没用，不给登录入口");
  const old = launchCheck({ ...base, clientOutdated: { min_version: "1.4.0" } });
  assert.match(old!.message, /客户端版本过旧.*请升级到 1\.4\.0 或以上/);
  for (const h of [login, disabled, old]) assert.doesNotMatch(h!.message, JARGON);
});

test("发起前检查：额度暂停（本期用完 / 律所上限 / 5 小时窗口 / 个人上限）按缓存视图拦，给“查看用量”入口", () => {
  const q = (v: LaunchQuotaView, at = NOW - 60_000) => launchCheck({ ...base, quota: { view: v, at } });
  assert.match(q(view({ paused: "allowance" }))!.message, /^本所本月 AI 额度已用完：请联系律所管理员加量/);
  assert.match(q(view({ paused: "cap" }))!.message, /律所设定的本月 AI 用量上限（本期额度的 80%）.*设置 → 套餐与用量/);
  assert.match(q(view({ paused: "burst" }))!.message, /最近 5 小时.*起恢复/);
  assert.match(q(view({ own: { used_ratio: 1, enforced: true, denominator: "account_limit" } }))!.message, /个人 AI 额度已用完/);
  assert.equal(q(view({ own: { used_ratio: 1.2, enforced: false, denominator: "seat_quota" } })), null, "个人额度没有硬性生效时不拦");
  for (const p of ["allowance", "cap", "burst"] as const) {
    const h = q(view({ paused: p }))!;
    assert.equal(h.kind, "quota");
    assert.equal(h.action, "usage");
    assert.doesNotMatch(h.message, JARGON);
  }
  assert.equal(q(view({ paused: null })), null, "没暂停不拦");
});

test("发起前检查：缓存超过 10 分钟、已过重置时刻、本机流程与律所自己的 AI 都不拦（交给网关兜底）", () => {
  assert.equal(launchCheck({ ...base, quota: { view: view({ paused: "allowance" }), at: NOW - QUOTA_VIEW_MAX_AGE_MS - 1 } }), null);
  assert.equal(launchCheck({ ...base, quota: { view: view({ paused: "allowance", period: { kind: "month", resets_at: "2026-11-19T09:00:00Z" } }), at: NOW - 1000 } }), null);
  assert.equal(launchCheck({ ...base, quota: { view: view({ paused: "burst", burst: { hours: 5, resets_at: "2026-11-19T09:59:00Z" } }), at: NOW - 1000 } }), null);
  assert.equal(launchCheck({ ...base, viaGateway: false, accountProblem: "session_expired", quota: { view: view({ paused: "allowance" }), at: NOW } }), null);
  assert.equal(QUOTA_VIEW_MAX_AGE_MS, 10 * 60_000);
});

test("账号错误映射一处：待激活与正常模式同一套状态码与文案；新增 client_outdated、staff_client_forbidden", () => {
  assert.deepEqual(
    ["auth_invalid", "session_expired", "account_locked", "rate_limited", "email_taken", "member_taken", "account_disabled", "registration_closed", "code_required", "staff_client_forbidden", "client_outdated", "cp_unreachable", "gate_unavailable", "password_weak"].map((c) => accountFailure(c).status),
    [401, 401, 423, 429, 409, 409, 403, 403, 403, 403, 426, 502, 502, 400],
  );
  assert.equal(accountFailure("client_outdated", "x", { min_version: "1.4.0" }).text, "客户端版本过旧，请升级到 1.4.0 或以上");
  assert.equal(accountFailure("client_outdated").text, "客户端版本过旧，请升级到最新版本");
  assert.equal(clientOutdatedText("1.4.0; rm -rf"), "客户端版本过旧，请升级到最新版本", "版本号不像版本号时不照抄");
  assert.equal(accountFailure("staff_client_forbidden").text, "这是中软平台人员账号，请在网页控制台登录");
  assert.equal(accountErrorText("staff_client_forbidden"), "这是中软平台人员账号，请在网页控制台登录");
  assert.equal(accountFailure("password_weak", "至少 12 位").text, "至少 12 位", "密码规则用控制面原话");
  assert.equal(accountFailure("weird_code", "Internal error at x.ts:12").text, "没有完成，请稍后重试；仍不行请联系客服", "其余不照抄控制面原话");
  assert.equal(accountFailure("cp_unreachable").fault, "provider_unavailable");
  assert.equal(accountFailure("auth_invalid").reason, "auth_invalid");
  // 两处调用都走 accountFailure，不再各写一份状态码映射
  const api = readFileSync(join(import.meta.dirname, "../src/api/index.ts"), "utf8");
  const onb = readFileSync(join(import.meta.dirname, "../src/services/onboarding.ts"), "utf8");
  assert.match(api, /accountFailure\(code,/);
  assert.match(onb, /accountFailure\(r\.code,/);
  assert.doesNotMatch(onb, /r\.code === "email_taken" \|\| r\.code === "member_taken" \? 409/);
});

test("登录后不能直接继续的状态：待激活与正常模式同一份文案；ready 也说清怎么办", () => {
  // 第 68 批（V42，D-295）：上限由云端设定；可就地移除一台后继续
  assert.match(onboardingStateText("device_limit"), /云端设定的上限.*移除一台/);
  assert.doesNotMatch(onboardingStateText("device_mismatch"), /另一位成员|那位成员/);
  assert.equal(onboardingStateText("device_limit", { admin: true }), onboardingStateText("device_limit"), "个人账号的管理员就是本人：不给“调高本所成员上限”的说法");
  assert.match(onboardingStateText("needs_device_join"), /还没有登记这台电脑/);
  assert.match(onboardingStateText("waiting_founder"), /律所还没有完成开通/);
  assert.match(onboardingStateText("ready"), /从备份恢复/);
  assert.doesNotMatch(onboardingStateText("ready"), /联系客服/, "ready 不再落到兜底文案");
  for (const s of ["device_limit", "needs_device_join", "waiting_founder", "needs_founder_setup", "device_mismatch"]) assert.doesNotMatch(onboardingStateText(s), /登录已失效/, s);
  const api = readFileSync(join(import.meta.dirname, "../src/api/index.ts"), "utf8");
  assert.match(api, /onboardingStateText\(String\(onb\.state \?\? ""\), \{ admin: acc\.role === "admin" \}\)/, "正常模式 account.login 用同一份文案");
});

test("非账号的控制面错误：按码映射人话，不认识的说“中软服务暂时不可用”；界面上不再出现“控制面：<代码>”", () => {
  assert.equal(controlPlaneErrorText("cp_unreachable"), "连不上中软服务，请检查网络后重试");
  assert.equal(controlPlaneErrorText("quota_view_invalid"), "中软服务暂时不可用，请稍后重试");
  assert.equal(controlPlaneErrorText("http_500"), "中软服务暂时不可用，请稍后重试");
  assert.match(controlPlaneErrorText("device_auth_stale"), /系统时间/);
  assert.match(controlPlaneErrorText("admin_required"), /律所管理员/);
  assert.equal(controlPlaneErrorText("client_outdated", { min_version: "2.0.1" }), "客户端版本过旧，请升级到 2.0.1 或以上");
  for (const c of ["no_seat", "rate_limited", "cap_invalid", "cp_unreachable", "device_auth_stale", "admin_required", "device_revoked", "license_expired", "client_outdated", "staff_client_forbidden", "x_y"]) assert.doesNotMatch(controlPlaneErrorText(c), JARGON, c);
  const api = readFileSync(join(import.meta.dirname, "../src/api/index.ts"), "utf8");
  assert.doesNotMatch(api, /`控制面：\$\{/);
  assert.doesNotMatch(api, /throw validation\(`budget_points 超出/);
  assert.doesNotMatch(api, /未配置中软服务（开发形态没有账号登录）/);
});

test("单任务预计用量：不再出由点数表折算的百分比，按实际用量计入本月额度（本月已用 x%）；本机流程不占额度", () => {
  assert.equal(estimateDisplay(true), "不调用 AI，不占用额度");
  assert.equal(estimateDisplay(false), "按实际用量计入本月额度");
  assert.equal(estimateDisplay(false, 0.374), "按实际用量计入本月额度（本月已用 37%）");
  assert.equal(estimateDisplay(false, 0.004), "按实际用量计入本月额度（本月已用 不到 1%）");
  assert.equal(estimateDisplay(false, 0.5, "本周"), "按实际用量计入本周额度（本周已用 50%）");
  assert.equal(chargedDisplay(30, 60), "已按实际用量计入本所额度");
  assert.equal(chargedDisplay(0, 60), "未占用额度");
  assert.equal(chargedDisplay(0, 0), "不调用 AI，不占用额度");
  for (const t of [estimateDisplay(false, 0.3), chargedDisplay(45, 60)]) assert.doesNotMatch(t, /上限的|预留额度|点/);
});

test("任务失败文案：429、5xx、兜底不再拼原始错误；网关 401 登录与授权单独说；402 按错误码匹配", () => {
  const busy = agentFailureText(null, "429 Too Many Requests: upstream said rate_limit_exceeded (req_abc)");
  assert.match(busy, /^AI 服务繁忙（请求太多被限流），任务没有完成/);
  assert.doesNotMatch(busy, /req_abc|Too Many/);
  const down = agentFailureText(null, "502 模型通道不可达（已排队或稍后重试）");
  assert.match(down, /^AI 服务暂时连不上，任务没有完成/);
  assert.doesNotMatch(down, /502|通道/);
  assert.equal(agentFailureText("host_reported_failure", null), "任务没有完成；可以点“重新运行”。仍不行请在 设置 → 备份与安全 导出诊断信息交给客服");
  assert.doesNotMatch(agentFailureText(null, "TypeError: Cannot read properties of undefined"), /TypeError/);
  assert.match(agentFailureText(null, "材料里没有找到合同正文"), /^任务没有完成：材料里没有找到合同正文/, "宿主给的中文说明照写");
  // 401：登录失效 / 没有授权（闸门 503 seat_unavailable 同样）
  assert.match(agentFailureText(null, "401 登录已失效，请重新登录 [kwl:seat_session_inactive]"), /^登录已失效，任务没有完成：请重新登录/);
  assert.match(agentFailureText(null, "401 缺少席位令牌 [kwl:seat_token_missing]"), /暂时没有取得 AI 使用授权/);
  assert.match(agentFailureText(null, "503 这台电脑暂时没有取得 AI 使用授权（还没登录，或联网续期还没完成）：AI 请求没有发出"), /暂时没有取得 AI 使用授权.*重新运行/);
  assert.doesNotMatch(agentFailureText(null, "503 这台电脑暂时没有取得 AI 使用授权：AI 请求没有发出"), /连不上/);
  assert.match(agentFailureText(null, "401 席位令牌无效或已吊销 [kwl:seat_device_revoked]"), /授权已被收回/);
  // 第 54 批：控制面不发额度租约（网关 402 quota_denied）与内容安全拦截（422）——重新运行不会好，不能落到通用“可以点重新运行”
  const denied = agentFailureText(null, "402 暂时无法为本所发放 AI 额度：请联系律所管理员 [kwl:quota_denied]");
  assert.match(denied, /^本所暂时无法取得 AI 额度.*联系律所管理员/);
  assert.doesNotMatch(denied, /^任务没有完成；可以点/);
  const blocked = agentFailureText(null, "422 请求内容命中内容安全策略（x），已拒绝 [kwl:content_blocked_input]");
  assert.match(blocked, /内容安全策略拦截.*重新运行仍会被拦/);
  assert.match(agentFailureText(null, "402 本期额度已用完 [kwl:quota_exhausted]"), /^本所本期 AI 额度已用完/, "已有的具体额度码仍走原分支");
  // 第 46 批真实验收：网关二次检查按事项摘要拒绝（刚确认依据就发起时摘要还没同步）——说清是事项依据的事，不说“连不上”
  const basis = agentFailureText(null, "403 事项四项依据未齐备：不经网关推理 [kwl:basis_incomplete]");
  assert.match(basis, /^这个事项的四项数据依据.*还没确认，或刚确认还没同步到中软/);
  assert.doesNotMatch(basis, /连不上|403|kwl:/);
  assert.match(agentFailureText(null, "403 该事项未选用标准端点（不经中软网关） [kwl:endpoint_not_permitted]"), /没有选用中软标准模型端点/);
  assert.match(agentFailureText(null, "403 律所未放开敏感事项（L3a）经标准端点推理 [kwl:l3a_not_permitted]"), /数据级别不允许经中软标准端点推理/);
  // 停用演练：账号停用不说“连不上”
  assert.match(agentFailureText(null, "402 账号已停用 [kwl:account_disabled]"), /^你的账号已被停用，任务没有完成/);
  // 402：闸门附上的代码优先；网关当前原文（不含旧正则里的关键词）也认得
  assert.match(agentFailureText(null, "402 本所 5 小时内的用量已达上限，请稍后再试 [kwl:quota_burst]"), /5 小时频率窗口已满/);
  assert.match(agentFailureText(null, "402 本所 5 小时内的用量已达上限，请稍后再试"), /5 小时频率窗口已满/);
  assert.match(agentFailureText(null, "402 本所本期 AI 额度已达律所设定的上限：请联系律所管理员 [kwl:quota_cap_reached]"), /律所设定的本期 AI 用量上限/);
  assert.match(agentFailureText(null, "402 本所本期 AI 额度已达律所设定的上限：请联系律所管理员"), /律所设定的本期 AI 用量上限/);
  assert.match(agentFailureText(null, "402 本所本期 AI 额度不足（预占失败） [kwl:quota_exhausted]"), /本所本期 AI 额度已用完/);
  assert.doesNotMatch(agentFailureText(null, "402 本所本期 AI 额度不足（预占失败） [kwl:quota_exhausted]"), /预占/);
  assert.match(agentFailureText(null, "402 您本期的个人 AI 额度已用完：请联系律所管理员 [kwl:quota_seat_limit]"), /个人 AI 额度已用完/);
  assert.match(agentFailureText(null, "402 x [kwl:price_unconfigured]"), /还没有定价/);
});

test("控制面客户端：缓存最近一次验过签的用量视图；426 client_outdated 记下最低版本，签出席位令牌后清除", async () => {
  const signer = new SoftwareSigner(generateKeyPairSync("ed25519").privateKey);
  let reply: { status: number; body: unknown } = { status: 200, body: { tid: "ten_demo", firm: { paused: null } } };
  let t = 1_000_000;
  const cp = new ControlPlaneClient({
    gov: { openSigned: (j: unknown) => j } as never,
    relay: async () => ({ ok: true, status: reply.status, body: JSON.stringify(reply.body) }) as never,
    tenantId: "ten_demo",
    device: { deviceId: "dev_demo_a_1", cert: {} as never, signer: signer as never },
    now: () => t,
  });
  assert.equal(cp.cachedQuota(), null);
  await cp.quota();
  assert.equal(cp.cachedQuota()?.at, 1_000_000);
  reply = { status: 426, body: { error: { code: "client_outdated", message: "客户端版本过旧", min_version: "1.4.0" } } };
  await assert.rejects(cp.quota(), /client_outdated/);
  assert.equal(cp.clientOutdated()?.min_version, "1.4.0");
  assert.equal(cp.cachedQuota()?.at, 1_000_000, "失败不覆盖上一份视图");
  await assert.rejects(cp.account("POST", "/v1/auth/login", {}), (e: { code?: string; minVersion?: string }) => e.code === "client_outdated" && e.minVersion === "1.4.0");
  // 刷新单飞且只在过时后发起
  let calls = 0;
  reply = { status: 200, body: { tid: "ten_demo", firm: { paused: "allowance" } } };
  const cp2 = new ControlPlaneClient({
    gov: { openSigned: (j: unknown) => j } as never,
    relay: async () => {
      calls += 1;
      return { ok: true, status: 200, body: JSON.stringify(reply.body) } as never;
    },
    tenantId: "ten_demo",
    device: { deviceId: "dev_demo_a_1", cert: {} as never, signer: signer as never },
    now: () => t,
  });
  cp2.refreshQuotaIfStale(60_000);
  cp2.refreshQuotaIfStale(60_000);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
  cp2.refreshQuotaIfStale(60_000);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1, "缓存还新：不再请求");
  t += 61_000;
  cp2.refreshQuotaIfStale(60_000);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2);
});

test("问答取不到回答：额度、登录类按闸门附上的代码说人话，其余照原话并去掉代码", async () => {
  const { qaFailureText } = await import("../src/services/qa-chat.ts");
  assert.match(qaFailureText("402 本所本期 AI 额度不足（预占失败） [kwl:quota_exhausted]"), /^你的 AI 额度暂时用到限制/);
  assert.match(qaFailureText("401 登录已失效，请重新登录 [kwl:seat_session_inactive]"), /^登录已失效或这台电脑暂时没有取得 AI 使用授权/);
  assert.equal(qaFailureText("模型通道不可达 [kwl:x_y]"), "模型通道不可达");
  assert.equal(qaFailureText("超时"), "超时");
  // 停用演练（第 46 批真实验收）：原来显示“模型通道错误 402：账号已停用”
  assert.equal(qaFailureText("模型通道错误 402：账号已停用 [kwl:account_disabled]"), "你的账号已被停用，这次没有取得回答：请联系律所管理员或中软客服");
  assert.equal(qaFailureText("模型通道错误 503：服务维护中"), "服务维护中", "去掉“模型通道错误 4xx/5xx：”前缀");
  assert.equal(qaFailureText("模型通道错误 500：Internal Server Error"), "AI 服务暂时不可用，这次没有取得回答：请稍后再问");
});
