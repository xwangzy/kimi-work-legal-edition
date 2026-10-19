/**
 * 恢复与备份（第 14 批；设计 docs/design/恢复与备份设计-v1.md）端到端：
 * 原电脑：事项 + 材料 → 选备份位置 → 备份（全是密文）→ 生成恢复包（恢复码只给一次）→ 试解；
 * 新电脑（另一个数据根、另一把数据库主密钥、待激活模式）：恢复包 + 恢复码 + 备份位置 → 恢复 → 请求采用旧主密钥 →
 * 以旧主密钥重启：事项、材料原文都能读，身份与原机相同。负例：恢复码抄错一行（指出行号）、清单被改、不是这台电脑的备份。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "backup-restore-secret-0123456789abcd";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kernel } from "../src/index.ts";

const open: Kernel[] = [];
after(async () => {
  for (const k of open) await k.close().catch(() => {});
});

async function kernelAt(dir: string, o: { dbKey: string; slugs?: boolean; onboarding?: boolean }): Promise<Kernel> {
  const { createKernel } = await import("../src/index.ts");
  const env: Record<string, string | undefined> = { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off", ZR_BACKUP_TIMER: "off", ...(o.onboarding ? { ZR_ONBOARDING: "1" } : {}) };
  delete env.ZR_FIRM_SLUG;
  delete env.ZR_USER_SLUG;
  const k = await createKernel({ dataDir: dir, dbKey: o.dbKey, env: env as NodeJS.ProcessEnv, ...(o.slugs ? { firmSlug: "bk-firm", userSlug: "lawyer" } : {}) });
  open.push(k);
  return k;
}

const anyText = (r: unknown) => JSON.stringify(r);

test("备份 → 恢复包 → 新电脑从备份恢复：身份与数据与原机相同；恢复码抄错指出行号；清单被改与别的设备的备份被拒", { timeout: 240_000 }, async () => {
  const keyA = randomBytes(32).toString("base64");
  const keyNew = randomBytes(32).toString("base64");
  const dirA = mkdtempSync(join(tmpdir(), "kwl-bk-a-"));
  const backupDir = mkdtempSync(join(tmpdir(), "kwl-bk-target-"));
  const outDir = mkdtempSync(join(tmpdir(), "kwl-bk-out-"));
  const a = await kernelAt(dirA, { dbKey: keyA, slugs: true });
  const { matter } = (await a.invoke("matters.create", { title: "恢复演练事项", stance: "原告", consent_status: "not_required" })) as any;
  const doc = (await a.invoke("materials.import", { matter_id: matter.matter_id, filename: "借款合同.txt", data_base64: Buffer.from("借款金额 BKCANARY-7781 元，月息一分。").toString("base64"), mime: "text/plain" })) as any;

  // 备份位置不能在数据目录里
  await assert.rejects(a.invoke("backup.configure", { dir: dirA }), (e: any) => e.code === "validation");
  await a.invoke("backup.configure", { dir: backupDir });
  const b1 = (await a.invoke("backup.run")) as any;
  assert.equal(b1.ok, true);
  assert.ok(b1.files > 3);
  // 备份里全是密文：金丝雀不以明文出现
  const scan = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? scan(join(d, e.name)) : [join(d, e.name)]));
  for (const f of scan(backupDir)) assert.ok(!readFileSync(f).includes(Buffer.from("BKCANARY-7781")), `备份文件含明文：${f}`);
  // 第二次备份：增量（没有新文件就几乎不复制）
  const b2 = (await a.invoke("backup.run")) as any;
  assert.ok(b2.copied <= 3, `第二次复制了 ${b2.copied} 个文件`);

  // 恢复包：恢复码只在这次返回；试解成功
  const pkgPath = join(outDir, "恢复包.kwlr");
  const pk = (await a.invoke("recovery.create_package", { path: pkgPath })) as any;
  assert.match(pk.code_text, /^KWR1\n/);
  assert.equal(pk.includes_firm_root, true, "创始设备的恢复包含律所根");
  const v = (await a.invoke("recovery.verify_package", { file: pkgPath, code: pk.code_text })) as any;
  assert.equal(v.same_device, true);
  assert.equal(v.includes_db_key, true);
  // 恢复码抄错一行：指出行号
  const lines = pk.code_text.split("\n");
  const bad = [...lines];
  bad[2] = bad[2]!.replace(/[0-9A-Z]/, (c: string) => (c === "A" ? "B" : "A"));
  await assert.rejects(a.invoke("recovery.verify_package", { file: pkgPath, code: bad.join("\n") }), (e: any) => e.code === "validation" && /第 2 行可能抄错/.test(e.message));
  const st = (await a.invoke("backup.status")) as any;
  assert.equal(st.configured, true);
  assert.equal(st.packages_created, 1);
  assert.ok(st.packages_verified >= 1);
  await a.close();
  open.splice(open.indexOf(a), 1);

  // ── 新电脑：待激活模式，另一把主密钥 ──
  const dirN = mkdtempSync(join(tmpdir(), "kwl-bk-new-"));
  const n = await kernelAt(dirN, { dbKey: keyNew, onboarding: true });
  assert.equal(((await n.invoke("kernel.status")) as any).onboarding.mode, "unactivated");
  // 别的设备的备份（清单签名不对）：先篡改一份清单副本对照
  const target = join(backupDir, "KimiWorkLegal-backup", "bk-firm", "dev_bk-firm_lawyer");
  const manifestPath = join(target, "manifest.json");
  const orig = readFileSync(manifestPath, "utf8");
  const tampered = JSON.parse(orig);
  tampered.seq += 1;
  writeFileSync(manifestPath, JSON.stringify(tampered));
  await assert.rejects(n.invoke("onboarding.restore", { dir: backupDir, file: pkgPath, code: pk.code_text }), (e: any) => e.code === "validation" && /清单核对不通过/.test(e.message));
  writeFileSync(manifestPath, orig);
  assert.ok(!existsSync(join(dirN, "bk-firm")), "核对不通过时没有写入任何数据");

  let adopted: string | null = null;
  n.onBroadcast((m) => {
    if (m.type === "kernel.adopt_master_key") adopted = String(m.key);
  });
  const r = (await n.invoke("onboarding.restore", { dir: backupDir, file: pkgPath, code: pk.code_text })) as any;
  assert.equal(r.ok, true);
  assert.equal(r.next, "restart");
  await new Promise((res) => setTimeout(res, 600));
  assert.equal(adopted, keyA, "请主进程采用旧电脑的数据库主密钥");
  await n.close();
  open.splice(open.indexOf(n), 1);

  // 主进程采用旧主密钥后按 activation.json 重启：事项与材料原文都在
  const n2 = await kernelAt(dirN, { dbKey: keyA });
  const st2 = (await n2.invoke("kernel.status")) as any;
  assert.equal(st2.firm, "bk-firm");
  assert.equal(st2.user, "lawyer");
  assert.equal(st2.onboarding, null);
  const list = (await n2.invoke("matters.list")) as any;
  assert.ok(anyText(list).includes(matter.matter_id), "恢复后事项在");
  const text = await n2.invoke("materials.text", { document_version_id: doc.document_version_id });
  assert.match(anyText(text), /BKCANARY-7781/, "恢复后材料原文可读（事项密钥经恢复的设备私钥解开）");
  assert.ok(!existsSync(join(dirN, "pending-activation")), "占位工作区已删除");
});
