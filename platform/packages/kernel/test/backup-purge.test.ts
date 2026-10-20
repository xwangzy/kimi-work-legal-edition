/**
 * 删除事项与本应用的自动备份（第 14 批第二轮复核 R2A-10；余项修正）：备份保留 7 代（R2B-03），旧几代的账本快照里还有被删事项的密钥包裹——
 * 删除后再备份一次而不清旧代，删除承诺就落空。现行：删除即记“待清旧代”并立即再备份，成功后只留新的一代，该事项的块从备份位置消失；
 * 备份位置当时不可用，标记留着，下一次成功的备份再清。删除回执写明本应用备份的处理。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "backup-purge-secret-0123456789abcdef";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kernel } from "../src/index.ts";

let k: Kernel | null = null;
after(async () => {
  await k?.close().catch(() => {});
});

const scan = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? scan(join(d, e.name)) : [join(d, e.name)])) : []);
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

test("删除事项后备份只留新的一代、该事项的块从备份位置消失；备份位置不可用时标记留到下次成功；回执写明", { timeout: 180_000 }, async () => {
  const { createKernel } = await import("../src/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "kwl-bkpurge-"));
  const env: Record<string, string | undefined> = { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off", ZR_BACKUP_TIMER: "off" };
  delete env.ZR_FIRM_SLUG;
  delete env.ZR_USER_SLUG;
  k = await createKernel({ dataDir: dir, dbKey: randomBytes(32).toString("base64"), env: env as NodeJS.ProcessEnv, firmSlug: "bkpurge-firm", userSlug: "lawyer" });
  const ws = join(dir, "bkpurge-firm");
  const stateOf = () => JSON.parse(readFileSync(join(ws, "backup.json"), "utf8"));
  const disk = mkdtempSync(join(tmpdir(), "kwl-bkpurge-disk-"));
  await k.invoke("backup.configure", { dir: disk });
  const devDir = () => {
    const root = join(disk, "KimiWorkLegal-backup");
    return join(root, readdirSync(root)[0]!);
  };
  const manifests = () => readdirSync(devDir()).filter((n) => /^manifest-\d{8}\.kwlb$/.test(n));
  const objects = () => new Set(readdirSync(join(devDir(), "objects")));
  const waitIdle = async () => {
    const deadline = Date.now() + 60_000;
    while (((await k!.invoke("backup.status")) as any).running || stateOf().prune_pending) {
      if (Date.now() > deadline) throw new Error(`后台备份没有完成：${JSON.stringify(stateOf())}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const newMatter = async (title: string) => {
    const { matter } = (await k!.invoke("matters.create", { title, stance: "原告", consent_status: "not_required" })) as any;
    const blobsBefore = new Set(scan(join(ws, "blobs")));
    await k!.invoke("materials.import", { matter_id: matter.matter_id, filename: `${title}.txt`, data_base64: Buffer.from(`${title} 的材料 ${randomBytes(8).toString("hex")}`).toString("base64"), mime: "text/plain" });
    const own = scan(join(ws, "blobs")).filter((f) => !blobsBefore.has(f));
    assert.ok(own.length >= 1, "导入材料生成了块");
    return { matter, title, blobHashes: own.map(sha) };
  };
  const purge = async (m: { matter: any; title: string }) => {
    await k!.invoke("matters.close", { matter_id: m.matter.matter_id, retention_years: 1 });
    return (await k!.invoke("matters.purge", { matter_id: m.matter.matter_id, confirm_title: m.title, early: true, reason: "客户书面要求" })) as any;
  };

  // 删除之前已有三代备份，被删事项的块都在备份位置上
  const m1 = await newMatter("删除演练一");
  for (let i = 0; i < 3; i++) await k.invoke("backup.run");
  assert.equal(manifests().length, 3);
  for (const h of m1.blobHashes) assert.ok(objects().has(h), "被删事项的块在备份里");
  const r1 = await purge(m1);
  // 回执里的去向表（copies）：本应用的自动备份一行，待处理、写明只留新的一代
  const findCopy = (x: unknown): any => {
    if (typeof x === "string" && x.startsWith("{")) {
      try {
        return findCopy(JSON.parse(x));
      } catch {
        return null;
      }
    }
    if (!x || typeof x !== "object") return null;
    if (Array.isArray((x as any).copies)) return (x as any).copies.find((c: any) => /本应用的自动备份/.test(c.where)) ?? null;
    for (const v of Object.values(x)) {
      const hit = findCopy(v);
      if (hit) return hit;
    }
    return null;
  };
  const copy = findCopy(r1);
  assert.ok(copy, "删除回执有“本应用的自动备份”一行");
  assert.equal(copy.status, "pending");
  assert.match(copy.note, /只留新的一代/);
  await waitIdle();
  assert.equal(manifests().length, 1, "删除后的这次备份只留新的一代");
  for (const h of m1.blobHashes) assert.ok(!objects().has(h), "被删事项的块已从备份位置删除");
  assert.equal(stateOf().prune_pending, false);
  // 之后照常保留多代
  await k.invoke("backup.run");
  assert.equal(manifests().length, 2);

  // 备份位置不可用时删除：标记留着；插回后下一次成功的备份再清
  const m2 = await newMatter("删除演练二");
  await k.invoke("backup.run");
  for (const h of m2.blobHashes) assert.ok(objects().has(h));
  const root = join(disk, "KimiWorkLegal-backup");
  const away = join(mkdtempSync(join(tmpdir(), "kwl-bkpurge-away-")), "KimiWorkLegal-backup");
  renameSync(root, away);
  await purge(m2);
  const deadline = Date.now() + 30_000;
  while (((await k.invoke("backup.status")) as any).last_error !== "location_changed") {
    if (Date.now() > deadline) throw new Error("删除后的备份没有按“备份盘不是原来那块”失败");
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(stateOf().prune_pending, true, "备份没成功，待清旧代的标记留着");
  renameSync(away, root);
  assert.ok(manifests().length >= 3, "插回时旧几代还在");
  await k.invoke("backup.run");
  assert.equal(manifests().length, 1, "插回后的第一次成功备份清掉旧几代");
  for (const h of m2.blobHashes) assert.ok(!objects().has(h));
  assert.equal(stateOf().prune_pending, false);
});
