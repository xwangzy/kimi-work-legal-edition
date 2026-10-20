/**
 * 备份盘“还是不是原来那块”（第 14 批第二轮复核 R2B-06）：选定位置时写备份盘标记、编号记进本机状态；每次备份先核对——
 * 同一路径上换成了别的盘（原来的备份文件夹不在了）就停下、报 location_changed，**不在那块盘上建任何东西**；插回原来的盘照常备份。
 * 旧设置（没记编号）：设备目录里已有备份即认作原来那块并补标记，什么都没有就请律师重新选。重新选回原来的盘沿用它的标记。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "backup-location-secret-0123456789abc";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kernel } from "../src/index.ts";

let k: Kernel | null = null;
after(async () => {
  await k?.close().catch(() => {});
});

test("备份盘标记：换了盘即停、不在别的盘上写东西；插回原盘照常；旧设置有备份即补标记、没有即请重选", { timeout: 120_000 }, async () => {
  const { createKernel } = await import("../src/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "kwl-bkloc-"));
  const env: Record<string, string | undefined> = { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off", ZR_BACKUP_TIMER: "off" };
  delete env.ZR_FIRM_SLUG;
  delete env.ZR_USER_SLUG;
  k = await createKernel({ dataDir: dir, dbKey: randomBytes(32).toString("base64"), env: env as NodeJS.ProcessEnv, firmSlug: "bkloc-firm", userSlug: "lawyer" });
  await k.invoke("matters.create", { title: "备份盘演练", stance: "原告", consent_status: "not_required" });
  const stateFile = join(dir, "bkloc-firm", "backup.json");

  // 选定位置：设备目录与标记即刻建好，编号记进本机状态
  const disk = mkdtempSync(join(tmpdir(), "kwl-bkloc-disk-"));
  await k.invoke("backup.configure", { dir: disk });
  const root = join(disk, "KimiWorkLegal-backup");
  const [devDir] = readdirSync(root);
  const marker = JSON.parse(readFileSync(join(root, devDir!, "location.kwlm"), "utf8"));
  assert.match(marker.id, /^[0-9a-f]{32}$/);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).location_id, marker.id);
  assert.equal(((await k.invoke("backup.run")) as any).ok, true);

  // 盘符被另一只 U 盘占用：同一路径上原来的备份文件夹不在了 → 停下、报 location_changed，不在这块盘上建任何东西
  const away = mkdtempSync(join(tmpdir(), "kwl-bkloc-away-"));
  renameSync(root, join(away, "KimiWorkLegal-backup"));
  await assert.rejects(k.invoke("backup.run"), (e: any) => e.code === "conflict" && e.detail?.code === "location_changed" && /不是原来那块/.test(e.message));
  assert.deepEqual(readdirSync(disk), [], "别的盘上没有新建任何文件夹或文件");
  const st1 = (await k.invoke("backup.status")) as any;
  assert.equal(st1.last_error, "location_changed", "状态里是专门的错误代码，界面据此提醒");
  // 同一路径上有另一份备份文件夹、但标记不同（别人的盘、或别的设备的备份）：同样停下
  const other = mkdtempSync(join(tmpdir(), "kwl-bkloc-other-"));
  await k.invoke("backup.configure", { dir: other }); // 借它生成一个设备目录 + 不同的标记
  writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, "utf8")), dir: disk, location_id: marker.id }));
  renameSync(join(other, "KimiWorkLegal-backup"), root);
  await assert.rejects(k.invoke("backup.run"), (e: any) => e.detail?.code === "location_changed");
  renameSync(root, join(other, "KimiWorkLegal-backup"));
  // 插回原来的盘：照常备份，错误清除
  renameSync(join(away, "KimiWorkLegal-backup"), root);
  assert.equal(((await k.invoke("backup.run")) as any).ok, true);
  assert.equal(((await k.invoke("backup.status")) as any).last_error, null);

  // 旧设置（第 14 批第二轮之前，没记编号）：已有备份即认作原来那块并补记编号
  const legacy = JSON.parse(readFileSync(stateFile, "utf8"));
  delete legacy.location_id;
  writeFileSync(stateFile, JSON.stringify(legacy));
  assert.equal(((await k.invoke("backup.run")) as any).ok, true);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).location_id, marker.id, "沿用盘上已有的标记");
  // 旧设置指向一块什么备份都没有的盘：不新建，请律师重新选
  const blank = mkdtempSync(join(tmpdir(), "kwl-bkloc-blank-"));
  writeFileSync(stateFile, JSON.stringify({ ...legacy, dir: blank }));
  await assert.rejects(k.invoke("backup.run"), (e: any) => e.detail?.code === "location_changed");
  assert.deepEqual(readdirSync(blank), []);

  // 重新选回原来的盘（例如换电脑恢复之后）：沿用它的标记，接着备份
  await k.invoke("backup.configure", { dir: disk });
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).location_id, marker.id);
  assert.equal(((await k.invoke("backup.run")) as any).ok, true);
  assert.ok(existsSync(join(root, devDir!, "location.kwlm")));
});
