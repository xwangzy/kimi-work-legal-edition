/**
 * 脱敏诊断包（v9.2 §3.6；Y5 P1-2）：只含白名单结构化事实；不含事项名称、客户与相对方、当事人、材料文字、任务目标；
 * 设备签名可核对；导出前自证——敏感字符串从任何字段漏进来都拒绝导出（只报字段路径，不报值）；记审计。
 */
import { SoftwareSigner } from "@zr-legal/keys";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeKernel, importText } from "./helpers.ts";
import { buildDiagnostics } from "../src/services/diagnostics.ts";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "diagnostics-test-secret-0123456789";

test("诊断包：不含任何事项内容与当事人；签名可核对；记审计", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({}, "diag-firm");
  try {
    const { matter } = await tk.inv("matters.create", { title: "柳城建材买卖纠纷", stance: "原告", client_name: "柳城建材有限公司", counterparty: "江北钢铁有限公司", consent_status: "not_required" });
    await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "司马青云", kind: "person", aliases: ["司马总"] }).catch(() => {});
    await importText(tk.inv, matter.matter_id, "合同.txt", "甲方：柳城建材有限公司；乙方联系人司马青云，电话 13711112222，身份证 440101198001010012。");
    const r = await tk.inv("diagnostics.export", {});
    const text = Buffer.from(r.data_base64, "base64").toString("utf8");
    for (const s of ["柳城建材", "江北钢铁", "司马青云", "司马总", "13711112222", "440101198001010012", "合同.txt", "买卖纠纷"]) assert.ok(!text.includes(s), `诊断包不得含 ${s}`);
    const doc = JSON.parse(text);
    assert.equal(doc.format, "kwl-diagnostics/1");
    assert.ok(doc.content.environment && doc.content.table_rows && Array.isArray(doc.content.recent_runs), "结构化事实齐全");
    // 内容摘要 = 规范 JSON 的 sha256；设备签名用本机设备签名公钥核对
    const { canonicalJson, verifyBytes } = await import("@zr-legal/keys");
    assert.equal(createHash("sha256").update(canonicalJson(doc.content)).digest("hex"), doc.content_sha256);
    const { getDeviceKeys, keysDirOf } = await import("../src/devices.ts");
    const dk = getDeviceKeys(keysDirOf(tk.kernel.config.workspaceDir));
    assert.ok(verifyBytes(dk.signPublicKeyPem, new TextEncoder().encode(doc.content_sha256), doc.signature), "设备签名有效");
    assert.ok(tk.kernel.db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'diagnostics.export'`), "记审计");
  } finally {
    await tk.kernel.close();
  }
});

test("诊断包含近 7 天统一脱敏日志（v9.2 §3.6）：按事件码计数与最近记录；日志文件不含事项内容；debug 只能临时开启", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({}, "diag-logs");
  try {
    const { matter } = await tk.inv("matters.create", { title: "欧阳明月借款纠纷", stance: "原告", client_name: "欧阳明月", consent_status: "not_required" });
    await importText(tk.inv, matter.matter_id, "借条.txt", "借款人欧阳明月，电话 13911112222。");
    const lv = await tk.inv("diagnostics.set_log_level", { level: "debug" });
    assert.equal(lv.level, "debug");
    await assert.rejects(() => tk.inv("diagnostics.set_log_level", { level: "trace" }), (e: any) => e.code === "validation");
    await tk.inv("diagnostics.set_log_level", { level: "info" });
    const st = await tk.inv("kernel.status", {});
    assert.equal(st.log_level, "info");
    const r = await tk.inv("diagnostics.export", {});
    const doc = JSON.parse(Buffer.from(r.data_base64, "base64").toString("utf8"));
    const logs = doc.content.logs_7d;
    assert.ok(logs && Array.isArray(logs.counts) && Array.isArray(logs.recent), "含日志节");
    assert.ok(logs.counts.some((c: any) => c.code === "KERNEL_STARTED" && c.proc === "kernel"), "内核启动事件已写盘并计入");
    assert.ok(logs.counts.some((c: any) => c.code === "SAFE_LOG_LEVEL_CHANGED"), "级别变更有记录");
    // 数据根下日志目录逐文件扫描：不含事项名称、当事人与号码
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(tk.kernel.config.workspaceDir, "logs");
    const files = readdirSync(dir);
    assert.ok(files.length >= 1);
    for (const f of files) {
      const t = readFileSync(join(dir, f), "utf8");
      for (const s of ["欧阳明月", "借款纠纷", "13911112222", "借条", tk.kernel.config.workspaceDir]) assert.ok(!t.includes(s), `日志 ${f} 不得含 ${s}`);
    }
  } finally {
    await tk.kernel.close();
  }
});

test("诊断包自证：当事人名称经任何白名单字段漏进来都拒绝导出，且只报字段路径", async () => {
  const tk = await makeKernel({}, "diag-firm2");
  try {
    const { matter } = await tk.inv("matters.create", { title: "acme 事项", stance: "原告", client_name: "acmeholdings", consent_status: "not_required" });
    assert.ok(matter);
    const keys = (await import("../src/devices.ts")).getDeviceKeys((await import("../src/devices.ts")).keysDirOf(tk.kernel.config.workspaceDir));
    await assert.rejects(
      () =>
        buildDiagnostics({
          db: tk.kernel.db,
          tokens: null,
          tenantId: tk.kernel.db.get<any>(`SELECT tenant_id FROM matters LIMIT 1`).tenant_id,
          deviceId: "dev_test",
          signer: new SoftwareSigner(keys.signPrivateKeyPem),
          // 模拟某个白名单字段（形如版本号的小写串）里混进了客户名称
          status: async () => ({ version: "acmeholdings", queue: {} }),
          capabilities: async () => ({}),
        }),
      (e: any) => e.code === "conflict" && /自检未通过/.test(e.message) && /\$\.kernel\.version/.test(e.message) && !/acmeholdings/.test(e.message),
    );
  } finally {
    await tk.kernel.close();
  }
});

test("诊断包自证（复核 B4-R03）：两侧同一套折叠（全角、大小写）；人名按拉丁词比对；带字母的“版本形态”不放行；任务目标与文件名也在比对表里", async () => {
  const tk = await makeKernel({}, "diag-firm3");
  try {
    const { matter } = await tk.inv("matters.create", { title: "Zhang Wei v Li", stance: "原告", client_name: "ＡＣＭＥ Holdings", counterparty: "Smith & Co", consent_status: "not_required" });
    assert.ok(matter);
    const { getDeviceKeys, keysDirOf } = await import("../src/devices.ts");
    const keys = getDeviceKeys(keysDirOf(tk.kernel.config.workspaceDir));
    const tenantId = tk.kernel.db.get<any>(`SELECT tenant_id FROM matters LIMIT 1`).tenant_id;
    const run = (status: Record<string, unknown>) =>
      buildDiagnostics({ db: tk.kernel.db, tokens: null, tenantId, deviceId: "dev_test", signer: new SoftwareSigner(keys.signPrivateKeyPem), status: async () => ({ queue: {}, ...status }), capabilities: async () => ({}) });
    const refused = (e: any) => e.code === "conflict" && /自检未通过/.test(e.message);
    // 全角客户名 ＡＣＭＥ 折叠后与小写代码 acme 相同 → 拒绝
    await assert.rejects(() => run({ model_provider: "acme" }), refused);
    // 相对方 Smith 按拉丁词比对；原样大写的被白名单挡下，小写的被自证挡下
    await assert.rejects(() => run({ model_provider: "smith" }), refused);
    // 带字母的版本形态不再放行（变为 null，不进诊断包）
    const ok = await run({ version: "1.0-smith" });
    const text = Buffer.from(ok.data_base64, "base64").toString("utf8").toLowerCase();
    assert.equal(text.includes("smith"), false);
    assert.equal(JSON.parse(Buffer.from(ok.data_base64, "base64").toString("utf8")).content.kernel.version, null);
    // 当事人名称拼进错误码同样拒绝（人名与机构名按拉丁词比对；事项名称不拆词，见下一条）
    await assert.rejects(() => run({ control_plane: { mode: "smith_failed" } }), refused);
    // 事项名称里的普通英文词不拆词比对（不误拒）：场景与状态代码照常导出
    const fine = await run({ model_provider: "upstream", version: "0.4.0" });
    assert.ok(fine.content_sha256);
  } finally {
    await tk.kernel.close();
  }
});
