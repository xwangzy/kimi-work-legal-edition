/**
 * 密钥文件封装（隐私安全审查 P0-1）：配置数据库主密钥后，设备私钥、律所根私钥、恢复份额都以 AES-256-GCM 封装落盘；
 * 同一主密钥重开正常；主密钥不符或文件被改动即拒用；明文旧文件在下次启动时就地改写为封装形态。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "secret-files-test-secret-0123456789";

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

const env = (key?: string) => ({ ...process.env, ZR_MODEL_PROVIDER: "mock", ...(key ? { ZR_DB_KEY: key } : {}) });

test("密钥文件封装：工作区内不出现私钥明文；同密钥重开；错密钥与篡改拒用；明文旧文件迁移", { timeout: 180_000 }, async () => {
  const { createKernel } = await import("../src/index.ts");
  const key = "secret-files-test-key-2026-0123456789";
  const dir = mkdtempSync(join(tmpdir(), "kwl-sealed-"));

  const k1 = await createKernel({ dataDir: dir, firmSlug: "sealed-firm", userSlug: "lawyer", env: env(key) });
  const deviceId = (await k1.invoke("kernel.status", {})) as any;
  await k1.close();
  assert.ok(deviceId);

  const keysDir = join(dir, "sealed-firm", "keys");
  const files = allFiles(keysDir);
  assert.ok(files.some((f) => f.endsWith("device.json")) && files.some((f) => f.endsWith("firm-root.json")));
  for (const f of files) {
    const t = readFileSync(f, "utf8");
    assert.equal(t.includes("PRIVATE KEY"), false, `${f} 不应含私钥明文`);
    assert.equal(t.includes("privateKeyPem"), false, `${f} 不应含私钥字段`);
    assert.equal(t.includes("recoveryCode"), false, `${f} 不应含恢复码`);
    assert.equal(JSON.parse(t).format, "kwl-sealed/1");
  }

  // 同一主密钥重开正常
  const k2 = await createKernel({ dataDir: dir, firmSlug: "sealed-firm", userSlug: "lawyer", env: env(key) });
  await k2.close();

  // 主密钥不符：拒绝启动（数据库与密钥文件都打不开）
  await assert.rejects(() => createKernel({ dataDir: dir, firmSlug: "sealed-firm", userSlug: "lawyer", env: env("wrong-key-0000000000000000000000") }));

  // 两个密钥文件互换（附加数据为文件名）→ 解封失败拒用
  const swapped = mkdtempSync(join(tmpdir(), "kwl-sealed-swap-"));
  cpSync(join(dir, "sealed-firm"), join(swapped, "sealed-firm"), { recursive: true });
  const sk = join(swapped, "sealed-firm", "keys");
  writeFileSync(join(sk, "device.json"), readFileSync(join(sk, "firm-root.json")));
  await assert.rejects(() => createKernel({ dataDir: swapped, firmSlug: "sealed-firm", userSlug: "lawyer", env: env(key) }), /解封失败/);

  // 明文旧文件（开发形态建的工作区）迁移：无主密钥建库 → 有主密钥启动时密钥文件就地封装
  // （数据库本身仍是明文开发库：密钥文件迁移与数据库迁移分开，这里只验证前者）
  const legacy = mkdtempSync(join(tmpdir(), "kwl-sealed-legacy-"));
  const k3 = await createKernel({ dataDir: legacy, firmSlug: "legacy-firm", userSlug: "lawyer", env: env() });
  await k3.close();
  const lk = join(legacy, "legacy-firm", "keys");
  assert.ok(readFileSync(join(lk, "device.json"), "utf8").includes("PRIVATE KEY"), "对照：开发形态为明文");
  const { configureSecretSealing, readSecretFile } = await import("../src/devices.ts");
  configureSecretSealing(lk, key);
  const keys = readSecretFile<{ signPrivateKeyPem: string }>(join(lk, "device.json"));
  assert.ok(keys.signPrivateKeyPem.includes("PRIVATE KEY"));
  assert.equal(JSON.parse(readFileSync(join(lk, "device.json"), "utf8")).format, "kwl-sealed/1", "读到明文旧文件应就地封装");
  assert.equal(readSecretFile<{ signPrivateKeyPem: string }>(join(lk, "device.json")).signPrivateKeyPem, keys.signPrivateKeyPem);
  configureSecretSealing(lk, undefined);
});

test("设备恢复包与密钥封装（隐私安全增量评审 F2）：导出的备份含私钥；导入经封装写回、不落明文；口令不足、口令错误与别的设备的恢复文件一律拒绝", { timeout: 180_000 }, async () => {
  const { createKernel } = await import("../src/index.ts");
  const { getDeviceKeys, configureSecretSealing } = await import("../src/devices.ts");
  const { unwrapPrivateKeyScrypt } = await import("@zr-legal/keys");
  const key = "secret-files-recovery-key-2026-0123456789";
  const dir = mkdtempSync(join(tmpdir(), "kwl-sealed-rec-"));
  const k = await createKernel({ dataDir: dir, firmSlug: "rec-firm", userSlug: "lawyer", env: env(key) });
  const keysDir = join(dir, "rec-firm", "keys");
  try {
    await assert.rejects(() => k.invoke("recovery.export_device", { password: "short" }), /至少 10 个字/);
    const out = join(dir, "backup", "device.kwlrec");
    const ex = (await k.invoke("recovery.export_device", { password: "恢复口令-测试-0123", path: out })) as any;
    const doc = JSON.parse(readFileSync(out, "utf8"));
    const inner = JSON.parse(unwrapPrivateKeyScrypt(doc.wrapped, "恢复口令-测试-0123"));
    assert.match(inner.signPrivateKeyPem, /PRIVATE KEY/, "导出的备份必须含签名私钥（封装形态下曾导出空值）");
    assert.match(inner.encPrivateKeyPem, /PRIVATE KEY/);
    assert.equal(doc.device_id, ex.device_id);
    // 口令错误、别的设备的恢复文件：拒绝且不改动 device.json
    const before = readFileSync(join(keysDir, "device.json"), "utf8");
    await assert.rejects(() => k.invoke("recovery.import_device", { file: out, password: "错误口令-0000000000" }), (e: any) => e.code === "bad_password");
    const other = join(dir, "backup", "other.kwlrec");
    writeFileSync(other, JSON.stringify({ ...doc, device_id: "dev_other_device" }));
    await assert.rejects(() => k.invoke("recovery.import_device", { file: other, password: "恢复口令-测试-0123" }), /另一台设备/);
    assert.equal(readFileSync(join(keysDir, "device.json"), "utf8"), before);
    // 正常导入：device.json 仍是封装形态、无明文私钥，解封后与备份一致
    const im = (await k.invoke("recovery.import_device", { file: out, password: "恢复口令-测试-0123" })) as any;
    // 同机导出后立即导入：密钥相同，无需暂存与重启（换钥的完整场景见 device-recovery.test.ts）
    assert.equal(im.restart_required, false);
    assert.equal(im.staged, false);
    const raw = readFileSync(join(keysDir, "device.json"), "utf8");
    assert.equal(JSON.parse(raw).format, "kwl-sealed/1");
    assert.equal(raw.includes("PRIVATE KEY"), false, "导入后 device.json 不得出现明文私钥");
    assert.equal(getDeviceKeys(keysDir).signPrivateKeyPem, inner.signPrivateKeyPem);
  } finally {
    await k.close();
    configureSecretSealing(keysDir, undefined);
  }
});
