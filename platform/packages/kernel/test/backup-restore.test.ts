/**
 * 恢复与备份（第 14 批；设计 docs/design/恢复与备份设计-v1.md）端到端：
 * 原电脑：事项 + 材料 → 选备份位置 → 备份（全是密文、文件名不可见）→ 生成恢复包（恢复码只给一次）→ 试解；
 * 新电脑（另一个数据根、另一把数据库主密钥、待激活模式）：恢复包 + 恢复码 + 备份位置 → 恢复 → 请求采用旧主密钥 →
 * 以旧主密钥重启：事项、材料原文都能读，身份与原机相同。负例：恢复码抄错一行（指出行号）、清单被改、对象被换（第二轮复核 R2A-08）、
 * 备份位置里的链接（R2A-11）、备份比恢复包旧（R2A-12）、本机有以前留下的数据（R2A-05）、主进程没能采用主密钥时回滚（R2A-15）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "backup-restore-secret-0123456789abcd";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
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
async function closeK(k: Kernel): Promise<void> {
  await k.close();
  open.splice(open.indexOf(k), 1);
}

const anyText = (r: unknown) => JSON.stringify(r);
const scan = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? scan(join(d, e.name)) : [join(d, e.name)]));
/** 备份目录（不透明编号）：备份位置下唯一的设备目录。 */
const targetIn = (backupDir: string) => {
  const root = join(backupDir, "KimiWorkLegal-backup");
  const ids = readdirSync(root);
  assert.equal(ids.length, 1);
  assert.match(ids[0]!, /^[0-9a-f]{32}$/, "目录名是不透明编号，看不出律所与设备");
  return join(root, ids[0]!);
};

test("备份 → 恢复包 → 新电脑从备份恢复：身份与数据与原机相同；篡改、链接、旧备份、旧数据与采用失败各自被挡住或回滚", { timeout: 300_000 }, async () => {
  const keyA = randomBytes(32).toString("base64");
  const keyNew = randomBytes(32).toString("base64");
  const dirA = mkdtempSync(join(tmpdir(), "kwl-bk-a-"));
  const backupDir = mkdtempSync(join(tmpdir(), "kwl-bk-target-"));
  const outDir = mkdtempSync(join(tmpdir(), "kwl-bk-out-"));
  const a = await kernelAt(dirA, { dbKey: keyA, slugs: true });
  const { matter } = (await a.invoke("matters.create", { title: "恢复演练事项", stance: "原告", consent_status: "not_required" })) as any;
  const doc = (await a.invoke("materials.import", { matter_id: matter.matter_id, filename: "借款合同.txt", data_base64: Buffer.from("借款金额 BKCANARY-7781 元，月息一分。").toString("base64"), mime: "text/plain" })) as any;
  // 工作区里带敏感文件名的文件（复核 R2A-09：文件名不得以明文进入备份位置）
  mkdirSync(join(dirA, "bk-firm", "kap", "m-test", "work"), { recursive: true });
  const stable = randomBytes(64); // 各代备份都引用的同一个对象
  writeFileSync(join(dirA, "bk-firm", "kap", "m-test", "work", "NAMECANARY-起诉状.docx"), stable);

  // 备份位置不能在数据目录里（含经链接指进去的）
  await assert.rejects(a.invoke("backup.configure", { dir: dirA }), (e: any) => e.code === "validation");
  const viaLink = join(outDir, "link-to-data");
  symlinkSync(dirA, viaLink, "dir");
  await assert.rejects(a.invoke("backup.configure", { dir: viaLink }), (e: any) => e.code === "validation", "解析链接后在数据目录里");
  await a.invoke("backup.configure", { dir: backupDir });
  const b1 = (await a.invoke("backup.run")) as any;
  assert.equal(b1.ok, true);
  assert.ok(b1.files > 3);
  const target = targetIn(backupDir);
  // 备份里全是密文：金丝雀不以明文出现在任何文件内容或文件名里
  for (const f of scan(backupDir)) {
    assert.ok(!readFileSync(f).includes(Buffer.from("BKCANARY-7781")), `备份文件含明文：${f}`);
    assert.ok(!readFileSync(f).includes(Buffer.from("NAMECANARY")), `备份文件内容含文件名明文：${f}`);
    assert.ok(!f.includes("NAMECANARY") && !f.includes("bk-firm") && !f.includes("dev_bk-firm"), `备份路径含明文名：${f}`);
  }
  const oldSnapshot = mkdtempSync(join(tmpdir(), "kwl-bk-old-"));
  cpSync(backupDir, oldSnapshot, { recursive: true });
  // 第二次备份：增量（没有新文件就几乎不复制）
  const b2 = (await a.invoke("backup.run")) as any;
  assert.ok(b2.copied <= 3, `第二次复制了 ${b2.copied} 个对象`);

  // 复核 R2A-08：能写备份位置的人把一个对象换成同样大小的内容、修改时间设到将来——下次备份不会为它背书
  const objects = join(target, "objects");
  const victim = join(objects, createHash("sha256").update(stable).digest("hex"));
  assert.ok(existsSync(victim), "对象按内容摘要命名");
  const orig = readFileSync(victim);
  chmodSync(victim, 0o600);
  writeFileSync(victim, randomBytes(orig.length));
  const future = new Date(Date.now() + 86400_000);
  utimesSync(victim, future, future);
  await a.invoke("backup.run");

  // 恢复包：恢复码只在这次返回；试解成功
  const pkgPath = join(outDir, "恢复包.kwlr");
  const pk = (await a.invoke("recovery.create_package", { path: pkgPath })) as any;
  assert.match(pk.code_text, /^KWR1\n/);
  assert.equal(pk.includes_firm_root, true, "创始设备的恢复包含律所根");
  const v = (await a.invoke("recovery.verify_package", { file: pkgPath, code: pk.code_text })) as any;
  assert.equal(v.same_device, true);
  assert.equal(v.includes_db_key, true);
  const lines = pk.code_text.split("\n");
  const bad = [...lines];
  bad[2] = bad[2]!.replace(/[0-9A-Z]/, (c: string) => (c === "A" ? "B" : "A"));
  await assert.rejects(a.invoke("recovery.verify_package", { file: pkgPath, code: bad.join("\n") }), (e: any) => e.code === "validation" && /第 2 行可能抄错/.test(e.message));
  const st = (await a.invoke("backup.status")) as any;
  assert.equal(st.configured, true);
  assert.equal(st.packages_created, 1);
  assert.equal(st.recent_packages.length, 1);
  assert.ok(st.packages_verified >= 1);
  await closeK(a);

  // ── 新电脑：待激活模式，另一把主密钥；本机还有一个以前留下的工作区 ──
  const dirN = mkdtempSync(join(tmpdir(), "kwl-bk-new-"));
  mkdirSync(join(dirN, "demo-firm"), { recursive: true });
  writeFileSync(join(dirN, "demo-firm", "ledger.db"), randomBytes(64));
  let n = await kernelAt(dirN, { dbKey: keyNew, onboarding: true });
  assert.equal(((await n.invoke("kernel.status")) as any).onboarding.mode, "unactivated");
  const restore = (extra: Record<string, unknown> = {}, from = backupDir) => n.invoke("onboarding.restore", { dir: from, file: pkgPath, code: pk.code_text, legacy_ack: true, ...extra });

  // 以前留下的数据：不确认即拒绝（复核 R2A-05）
  await assert.rejects(n.invoke("onboarding.restore", { dir: backupDir, file: pkgPath, code: pk.code_text }), (e: any) => e.code === "conflict" && e.detail?.code === "legacy_present");
  // 被换掉的对象：清单按本机源文件摘要签名，恢复核对失败，且不留任何残余
  await assert.rejects(restore(), (e: any) => e.code === "validation" && /被改动过|缺少/.test(e.message));
  assert.ok(!existsSync(join(dirN, "bk-firm")), "核对不通过时没有写入任何数据");
  assert.equal(readdirSync(dirN).filter((x) => x.startsWith(".restore-")).length, 0, "暂存已删除");
  // 修好对象（重新备份前的原样）；最新一代清单被改：退回上一代（复核 R2B-03），但它比恢复包旧——须确认
  writeFileSync(victim, orig);
  const gens = readdirSync(target).filter((n) => /^manifest-\d{8}\.kwlb$/.test(n)).sort();
  assert.equal(gens.length, 3, "保留了三代清单");
  const mfPath = join(target, gens[gens.length - 1]!);
  const mfOrig = readFileSync(mfPath, "utf8");
  const mf = JSON.parse(mfOrig);
  mf.body.ct = (mf.body.ct[0] === "A" ? "B" : "A") + mf.body.ct.slice(1);
  writeFileSync(mfPath, JSON.stringify(mf));
  await assert.rejects(restore(), (e: any) => e.code === "conflict" && e.detail?.code === "backup_older" && /较新的几份不完整/.test(e.message));
  // 各代清单都被改：拒绝
  const saved = gens.map((g) => [g, readFileSync(join(target, g), "utf8")] as const);
  for (const [g, txt] of saved) {
    const x = JSON.parse(txt);
    x.sig = x.sig.slice(0, -2) + (x.sig.endsWith("AA") ? "BB" : "AA");
    writeFileSync(join(target, g), JSON.stringify(x));
  }
  await assert.rejects(restore(), (e: any) => e.code === "validation" && /清单核对不通过/.test(e.message));
  for (const [g, txt] of saved) writeFileSync(join(target, g), txt);
  writeFileSync(mfPath, mfOrig);
  // 备份比恢复包还旧（被换回更早的一份）：须确认（复核 R2A-12）
  await assert.rejects(restore({}, oldSnapshot), (e: any) => e.code === "conflict" && e.detail?.code === "backup_older");
  // 备份位置里的链接：不从这里恢复（复核 R2A-11）
  const linked = mkdtempSync(join(tmpdir(), "kwl-bk-linked-"));
  symlinkSync(join(backupDir, "KimiWorkLegal-backup"), join(linked, "KimiWorkLegal-backup"), "dir");
  await assert.rejects(restore({}, linked), (e: any) => e.code === "validation" && /链接/.test(e.message));

  // 恢复成功，但主进程没能采用旧主密钥（仍以本机主密钥重启）→ 回滚、回到待激活并报原因，可以再恢复一次（复核 R2A-15）
  let adopted: string | null = null;
  n.onBroadcast((m) => {
    if (m.type === "kernel.adopt_master_key") adopted = String(m.key);
  });
  // 律师选的是最里层的备份目录（复核 R2B-16：选哪一层都能找到）
  const r1 = (await restore({}, target)) as any;
  assert.equal(r1.next, "restart");
  await assert.rejects(n.invoke("onboarding.restore", { dir: backupDir, file: pkgPath, code: pk.code_text, legacy_ack: true }), (e: any) => e.code === "conflict", "已请求重启：再次恢复一律 409");
  await new Promise((res) => setTimeout(res, 600));
  assert.equal(adopted, keyA, "请主进程采用旧电脑的数据库主密钥");
  assert.ok(existsSync(join(dirN, "activation.pending.json")) && !existsSync(join(dirN, "activation.json")), "激活记录先是待生效");
  await closeK(n);
  n = await kernelAt(dirN, { dbKey: keyNew, onboarding: true }); // 安装包形态：没有激活记录即待激活
  const stFail = (await n.invoke("onboarding.status")) as any;
  assert.equal(stFail.mode, "unactivated");
  assert.equal(stFail.last_failure.code, "restore_incomplete");
  assert.ok(!existsSync(join(dirN, "bk-firm")) && !existsSync(join(dirN, "activation.pending.json")), "恢复出来的工作区与待生效记录已清掉");
  assert.ok(existsSync(join(dirN, "demo-firm", "ledger.db")), "以前留下的数据不动");

  // 再恢复一次（这次选的是 KimiWorkLegal-backup 文件夹），主进程采用成功（以旧主密钥重启）：事项与材料原文都在
  await restore({}, join(backupDir, "KimiWorkLegal-backup"));
  await new Promise((res) => setTimeout(res, 600));
  await closeK(n);
  const n2 = await kernelAt(dirN, { dbKey: keyA, onboarding: true });
  const st2 = (await n2.invoke("kernel.status")) as any;
  assert.equal(st2.firm, "bk-firm");
  assert.equal(st2.user, "lawyer");
  assert.equal(st2.onboarding, null);
  assert.ok(existsSync(join(dirN, "activation.json")) && !existsSync(join(dirN, "activation.pending.json")), "待生效记录已生效");
  const list = (await n2.invoke("matters.list")) as any;
  assert.ok(anyText(list).includes(matter.matter_id), "恢复后事项在");
  const text = await n2.invoke("materials.text", { document_version_id: doc.document_version_id });
  assert.match(anyText(text), /BKCANARY-7781/, "恢复后材料原文可读（事项密钥经恢复的设备私钥解开）");
  assert.ok(!existsSync(join(dirN, "pending-activation")), "占位工作区已删除");
  assert.ok(!existsSync(join(dirN, "bk-firm", "backup.json")), "备份位置设置不随恢复带到新电脑（请律师重新选择）");
  const bs = (await n2.invoke("backup.status")) as any;
  assert.equal(bs.configured, false);
  // 恢复出的账本里记了一条“从备份恢复”审计（复核 R2A-14）
  const audit = (n2 as any).db.get(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'device.restored_from_backup'`) as { n: number };
  assert.equal(audit.n, 1);
  assert.ok(!existsSync(join(dirN, "bk-firm", ".restored-from-backup.json")), "恢复标记已消费");
  rmSync(oldSnapshot, { recursive: true, force: true });
});
