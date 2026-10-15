/**
 * 主进程文件对话框与一次性句柄（v9.2 §3.7；Y5 P1-4）：渲染进程拿不到也不能指定写入路径；句柄一次性、限时、分类型；
 * 导出类方法剥掉渲染进程自带的 save_path；保存目标在同步文件夹或网络位置时给出风险标记。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fd = require("../electron/file-dialogs.cjs") as {
  createHandleStore(now?: () => number): { issue(kind: string, p: string): string; take(h: unknown, kind: string): string | null; size(): number };
  classifySaveTarget(p: string, env?: Record<string, string>, platform?: string): string | null;
  resolveFileParams(method: string, params: unknown, store: ReturnType<typeof fd.createHandleStore>): { params?: Record<string, unknown>; error?: { code: string } };
  acceptDroppedPath(p: unknown): boolean;
  insideAppData(t: string, roots: string[], platform?: string): boolean;
  safeSuggestedName(n: unknown): string;
  mimeOf(n: string): string;
  HANDLE_TTL_MS: number;
};

test("句柄：一次性、按类型、过期作废、格式不符即拒", () => {
  let t = 1_000;
  const s = fd.createHandleStore(() => t);
  const h = s.issue("save", "/Users/x/Documents/a.docx");
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.equal(s.take(h, "open"), null, "类型不符");
  assert.equal(s.take(h, "save"), "/Users/x/Documents/a.docx");
  assert.equal(s.take(h, "save"), null, "用一次即作废");
  const h2 = s.issue("open", "/tmp/b.pdf");
  t += fd.HANDLE_TTL_MS + 1;
  assert.equal(s.take(h2, "open"), null, "过期");
  assert.equal(s.take("../../etc/passwd", "open"), null);
  assert.equal(s.take({ toString: () => h2 }, "open"), null);
});

test("转发前换句柄：导出类剥掉渲染进程自带的 save_path，只认句柄；读取类句柄换路径并补 mime", () => {
  const s = fd.createHandleStore();
  const forged = fd.resolveFileParams("artifacts.download", { artifact_version_id: "a1", save_path: "/Users/x/.ssh/authorized_keys" }, s);
  assert.equal(forged.params!.save_path, undefined, "渲染进程自带的路径被剥掉");
  const h = s.issue("save", "/Users/x/Documents/意见书.docx");
  const ok = fd.resolveFileParams("diagnostics.export", { save_handle: h, save_path: "/etc/hosts" }, s);
  assert.equal(ok.params!.save_path, "/Users/x/Documents/意见书.docx");
  assert.equal(ok.params!.save_handle, undefined);
  assert.equal(fd.resolveFileParams("matters.archive", { save_handle: h }, s).error?.code, "validation", "句柄已用过");
  const o = s.issue("open", "/Users/x/Desktop/合同.pdf");
  const imp = fd.resolveFileParams("materials.import", { matter_id: "m", file_handle: o }, s);
  assert.deepEqual(imp.params, { matter_id: "m", path: "/Users/x/Desktop/合同.pdf", filename: "合同.pdf", mime: "application/pdf" });
  // 其他方法带来的句柄字段一律去掉（不能借别的方法消费句柄）
  const other = fd.resolveFileParams("runs.start", { file_handle: "x", save_handle: "y" }, s);
  assert.equal(other.params!.file_handle, undefined);
  // save_handle 只在导出类方法里换；在别的方法里原样不会变成路径
  assert.equal(other.params!.save_path, undefined);
  // 非对象参数
  assert.deepEqual(fd.resolveFileParams("kernel.status", null, s).params, {});
});

test("保存目标风险：OneDrive（环境变量与路径名）、iCloud/云存储、UNC 网络路径；普通本机目录无风险", () => {
  const env = { OneDrive: "C:\\Users\\张律师\\OneDrive - 某律所", OneDriveCommercial: "" };
  assert.equal(fd.classifySaveTarget("C:\\Users\\张律师\\OneDrive - 某律所\\文档\\a.docx", env, "win32"), "onedrive");
  assert.equal(fd.classifySaveTarget("c:\\users\\张律师\\onedrive - 某律所\\a.docx", env, "win32"), "onedrive", "大小写不敏感");
  assert.equal(fd.classifySaveTarget("D:\\同步\\OneDrive\\a.docx", {}, "win32"), "onedrive");
  assert.equal(fd.classifySaveTarget("\\\\fileserver\\share\\a.docx", {}, "win32"), "network");
  assert.equal(fd.classifySaveTarget("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/a.docx", {}, "darwin"), "cloud");
  assert.equal(fd.classifySaveTarget("/Users/x/Library/CloudStorage/Dropbox/a.docx", {}, "darwin"), "cloud");
  assert.equal(fd.classifySaveTarget("C:\\Users\\张律师\\Documents\\a.docx", env, "win32"), null);
  assert.equal(fd.classifySaveTarget("/Users/x/Documents/a.docx", {}, "darwin"), null);
});

test("建议文件名只取基本名、去掉路径分隔符与控制字符", () => {
  assert.equal(fd.safeSuggestedName("../../etc/passwd"), "passwd");
  assert.equal(fd.safeSuggestedName("a\u0000b:c?.docx"), "a_b_c_.docx");
  assert.equal(fd.safeSuggestedName(""), "导出文件");
  assert.equal(fd.mimeOf("X.DOCX"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});

test("复核 S5A-01：任何方法里渲染进程自带的路径类参数一律剥掉；设备恢复的导出与导入同样只认句柄；拖放的网络路径不收", () => {
  const s = fd.createHandleStore();
  for (const [m, k] of [["materials.import", "path"], ["materials.mount", "path"], ["recovery.export_device", "path"], ["recovery.import_device", "file"], ["sync.export", "share_dir"], ["sync.import", "share_dir"]] as const) {
    const r = fd.resolveFileParams(m, { [k]: "\\\\attacker\\share\\x", matter_id: "m" }, s);
    assert.equal(r.params![k], undefined, `${m}.${k} 被剥掉`);
    assert.equal(r.params!.matter_id, "m");
  }
  const h = s.issue("save", "/Users/x/Documents/设备恢复.json");
  assert.equal(fd.resolveFileParams("recovery.export_device", { save_handle: h, passphrase: "p" }, s).params!.path, "/Users/x/Documents/设备恢复.json");
  const o = s.issue("open", "/Users/x/Documents/设备恢复.json");
  assert.deepEqual(fd.resolveFileParams("recovery.import_device", { file_handle: o }, s).params, { file: "/Users/x/Documents/设备恢复.json" });
  assert.equal(fd.acceptDroppedPath("\\\\fs01\\share\\a.docx"), false);
  assert.equal(fd.acceptDroppedPath("//fs01/share/a.docx"), false);
  assert.equal(fd.acceptDroppedPath("relative/a.docx"), false);
  assert.equal(fd.acceptDroppedPath("/Users/x/Desktop/a.docx"), true);
});

test("复核 S5A-04：保存目标落在数据根或 Electron userData 里一律不收（大小写不敏感）", () => {
  const roots = ["C:\\Users\\a\\AppData\\Local\\KimiWorkLegal", "C:\\Users\\a\\AppData\\Local\\KimiWorkLegal\\.electron"];
  assert.equal(fd.insideAppData("c:\\users\\a\\appdata\\local\\kimiworklegal\\.electron\\ledger-key", roots, "win32"), true);
  assert.equal(fd.insideAppData("C:\\Users\\a\\Documents\\x.docx", roots, "win32"), false);
  assert.equal(fd.insideAppData("/Users/A/Library/Application Support/KimiWorkLegal/x", ["/Users/a/Library/Application Support/KimiWorkLegal"], "darwin"), true);
});

