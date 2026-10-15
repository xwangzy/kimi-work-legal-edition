/**
 * 导出直写（v9.2 §3.7；Y5 P1-4、F6）：成果、诊断包与结案归档由内核直接写到律师在系统对话框里选定的位置——
 * 内容与原先经渲染进程下载的一致；不留临时文件；不经渲染进程（响应里不再带文件内容）；不能写进数据根、相对路径、
 * 不存在的目录、经符号链接的目录或已有的目录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeKernel } from "./helpers.ts";
import { writeExportFile } from "../src/services/export-file.ts";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "export-file-test-secret-0123456789";

test("writeExportFile：原子写入、不留临时文件；拒绝数据根内、相对路径、不存在的目录、符号链接目录与目录目标", () => {
  const out = mkdtempSync(join(tmpdir(), "kwl-export-"));
  const root = mkdtempSync(join(tmpdir(), "kwl-root-"));
  try {
    const r = writeExportFile(join(out, "意见书.docx"), Buffer.from("第一版"), root);
    assert.deepEqual(r, { name: "意见书.docx", bytes: Buffer.byteLength("第一版") });
    writeExportFile(join(out, "意见书.docx"), Buffer.from("第二版"), root); // 覆盖已由系统对话框确认
    assert.equal(readFileSync(join(out, "意见书.docx"), "utf8"), "第二版");
    assert.deepEqual(readdirSync(out), ["意见书.docx"], "没有残留的临时文件");
    const bad = (p: string) => assert.throws(() => writeExportFile(p, Buffer.from("x"), root), (e: any) => e.code === "validation", p);
    bad("意见书.docx");
    bad(join(root, "ledger.db"));
    mkdirSync(join(root, "keys"));
    bad(join(root, "keys", "device.json"));
    bad(join(out, "不存在的目录", "a.docx"));
    mkdirSync(join(out, "子目录"));
    bad(join(out, "子目录"));
    symlinkSync(root, join(out, "链接"));
    bad(join(out, "链接", "a.docx"));
    assert.ok(!existsSync(join(root, "ledger.db")));
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("成果与诊断包按保存位置直写：内容与原下载一致、响应不带文件内容、记审计；保存位置在数据根内即拒绝", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({}, "export-direct");
  const out = mkdtempSync(join(tmpdir(), "kwl-export-api-"));
  try {
    const { matter } = await tk.inv("matters.create", { title: "导出直写", stance: "原告", client_name: "滨江置业有限公司", consent_status: "pending" });
    const notice = await tk.inv("matters.consent_notice", { matter_id: matter.matter_id });
    const viaRenderer = await tk.inv("artifacts.download", { artifact_version_id: notice.artifact_version_id });
    const target = join(out, notice.filename);
    const saved = await tk.inv("artifacts.download", { artifact_version_id: notice.artifact_version_id, save_path: target });
    assert.equal(saved.saved, true);
    assert.equal(saved.data_base64, undefined, "直写时响应不带文件内容");
    assert.deepEqual(readFileSync(target), Buffer.from(viaRenderer.data_base64, "base64"), "与原下载内容一致（同样还原真名）");
    assert.ok(tk.kernel.db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'artifact.saved'`), "记审计");
    // 预览形态（restore:false）不接受保存位置：不写文件、照常返回令牌形态
    const preview = await tk.inv("artifacts.download", { artifact_version_id: notice.artifact_version_id, restore: false, save_path: join(out, "预览.docx") });
    assert.ok(preview.data_base64 && !existsSync(join(out, "预览.docx")));
    await assert.rejects(() => tk.inv("artifacts.download", { artifact_version_id: notice.artifact_version_id, save_path: join(tk.kernel.config.workspaceDir, "x.docx") }), (e: any) => e.code === "validation");
    const diag = await tk.inv("diagnostics.export", { save_path: join(out, "diag.json") });
    assert.equal(diag.saved, true);
    const doc = JSON.parse(readFileSync(join(out, "diag.json"), "utf8"));
    assert.equal(doc.format, "kwl-diagnostics/1");
    assert.equal(doc.content_sha256, diag.content_sha256);
  } finally {
    rmSync(out, { recursive: true, force: true });
    await tk.kernel.close();
  }
});
