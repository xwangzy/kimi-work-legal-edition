/**
 * 第 9 批复核 S9B-11、S9B-21：诊断包上传失败的提示用律师语言（不出现工程代码）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { supportErrorText } from "../src/services/support-errors.ts";

test("诊断包上传失败提示：各类代码都有律师语言，不出现英文代码；结果不明提示不要重复上传", () => {
  const codes = ["too_many_tickets", "support_upload_disabled", "credential:no_seat", "seat_expired", "upload_token_expired", "support_body_too_large", "support_tls_pin_mismatch", "support_not_configured", "support_connect_failed", "http_500", "whatever"];
  for (const c of codes) {
    const t = supportErrorText(c, "failed");
    assert.doesNotMatch(t, /[a-z_]{3,}/, `${c}: ${t}`);
  }
  assert.match(supportErrorText("support_timeout", "unknown"), /不要重复上传/);
  assert.match(supportErrorText("too_many_tickets", "failed"), /明天再试/);
});
