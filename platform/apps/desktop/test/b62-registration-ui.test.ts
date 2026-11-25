/**
 * 第 62 批：注册页按云端能力字段做特性检测（Windows 与 macOS 同一份界面代码）。
 * - 旧云端（legacy）或取不到策略：照旧流程——不显示手机号、码用勾选框、只认 20 / 36 位、原有文案不变；
 * - 新云端：短信可用才显示手机号（要求时必填、否则选填）；仅凭码注册时码必填；另认 12 位注册邀请码；找回密码可用手机号。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { codeLengthOk, phoneLooksValid, registerCodeLengthOk, registrationFields, smsCodeLooksValid } from "../src/lib/account.ts";

// 第 63 批：手机号 + 验证码与注册策略的读取抽到 components/SmsCodeFields.tsx（开通页与“设置 → 账号”共用），两处一起查
const src = ["../src/pages/Activate.tsx", "../src/components/SmsCodeFields.tsx"].map((f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8")).join("\n");

test("旧云端或取不到策略：照旧流程（不显示手机号、码用勾选框）", () => {
  for (const m of [null, undefined, { legacy: true }, { legacy: true, mode: "code" as const }]) assert.deepEqual(registrationFields(m), { legacy: true, phone: "hidden", code: "checkbox", codeLength: 6, resendSeconds: 60, phoneReset: false });
  // 旧流程的文案原样保留
  for (const s of ["我有开通码或邀请码", "开通码 20 位，邀请码 36 位", "凭码注册时，律所以码对应的为准。", "不填码即自助注册：为你开通一个试用的个人工作室，之后可以邀请同事加入。"]) assert.ok(src.includes(s), s);
  assert.equal(codeLengthOk("ABCD-EFGH-JKMN"), false, "直接输入码（兑换）仍只认 20 / 36 位");
});

test("新云端：按策略显示手机号与邀请码；12 位注册邀请码；手机号与验证码的粗查", () => {
  const base = { legacy: false, mode: "open" as const, invite_required: false, require_phone: false, sms_available: false, phone_reset: false, sms: { code_length: 6, resend_seconds: 60, ttl_minutes: 10 } };
  assert.equal(registrationFields(base).phone, "hidden", "短信不可用：不显示手机号");
  assert.equal(registrationFields({ ...base, sms_available: true }).phone, "optional");
  assert.deepEqual(registrationFields({ ...base, require_phone: true, sms_available: true, invite_required: true, mode: "code", phone_reset: true, sms: { code_length: 4, resend_seconds: 90, ttl_minutes: 5 } }), { legacy: false, phone: "required", code: "required", codeLength: 4, resendSeconds: 90, phoneReset: true });
  assert.deepEqual(["ABCD-EFGH-JKMN", "A".repeat(20), "A".repeat(36), "A".repeat(13)].map(registerCodeLengthOk), [true, true, true, false]);
  assert.deepEqual(["13800138000", "+86 138-0013-8000", "12800138000", "1380013800"].map(phoneLooksValid), [true, true, false, false]);
  assert.deepEqual([smsCodeLooksValid("123456"), smsCodeLooksValid("12345"), smsCodeLooksValid("1234", 4), smsCodeLooksValid("12a456")], [true, false, true, false]);
});

test("注册页与找回密码页：取策略失败按旧流程、发验证码倒计时与失败提示、找回密码可用手机号（只在云端支持时）", () => {
  // 第 64 批改：取不到策略不再冒充“旧云端”（那会让验证码登录整次打开都不出现）——如实进入 error 态（原因 + 重试 + 退避自动再试）；
  // 旧云端（云端答复里没有策略）仍由内核回 legacy、照旧流程
  assert.doesNotMatch(src, /setMeta\(\{ legacy: true \}\)/, "取不到不再按旧流程");
  assert.match(src, /\.registrationMeta\(\)[\s\S]{0,300}\.catch\(\(e\) => \{[\s\S]{0,200}status: "error"/, "取不到 → error 态");
  assert.match(src, /const META_BACKOFF_S = \[5, 10, 20, 40, 60\];/, "按退避自动再试");
  assert.ok(src.includes("秒后重新获取") && src.includes("获取验证码"), "倒计时按钮");
  assert.ok(src.includes("retry_after_s"), "频控时按云端给的秒数倒计时");
  assert.ok(src.includes("测试环境：验证码是"), "dry-run 写明是测试环境");
  assert.ok(src.includes('f.phoneReset && by === "phone"') && src.includes("resetConfirmByPhone"), "找回密码的手机号方式只在云端支持时出现");
});
