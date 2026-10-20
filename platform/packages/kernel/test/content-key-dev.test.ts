/**
 * 开发内容签名公钥按指纹识别（复核 A-14 / B13-O05）：复制一份开发公钥、去掉 dev 标记，内核仍报 content_key=dev；
 * release.json 的 content_keys 混进开发公钥同样报 dev；构建脚本对指向开发公钥副本的 KWL_CONTENT_SIGNING_PUB_FILE 直接失败。
 * 第 14 批第二轮复核 A 余项：开发公钥指纹登记进仓库表（content/dev-content-key-fingerprints.json）；正式安装包（安装包形态 +
 * release.json 未标 test_build）里内核拒载开发公钥；构建门禁在任何写盘之前判定（本测试用 --check-content-key，不改制品）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentKeyFingerprint, loadConfig } from "../src/config.ts";
// @ts-expect-error 构建脚本的 .mjs 工具模块（无类型声明）
import { readDevFpTable } from "../../../scripts/lib/dev-content-keys.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const devPubFile = join(root, "content/keys/content-signing-dev.pub.json");
const devPem = existsSync(devPubFile) ? (JSON.parse(readFileSync(devPubFile, "utf8")).publicKeyPem as string) : null;
const otherPem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

const cfg = (env: Record<string, string>) => loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "kwl-ck-")), firmSlug: "ck-firm", userSlug: "u", dbKey: "x", env: { ...env } as NodeJS.ProcessEnv } as any);

test("指纹与 PEM 写法无关；非公钥返回 null", { skip: !devPem && "本机还没有开发公钥（先 npm run build:lawdb）" }, () => {
  const fp = contentKeyFingerprint(devPem!);
  assert.match(fp!, /^[0-9a-f]{64}$/);
  assert.equal(contentKeyFingerprint(`\n${devPem!.replace(/\n/g, "\r\n")}`), fp);
  assert.equal(contentKeyFingerprint("not a key"), null);
});

test("内核：开发公钥（无 dev 标记）与 content_keys 里的开发公钥都报 dev；其他公钥报 release", { skip: !devPem && "本机还没有开发公钥" }, () => {
  assert.equal(cfg({ ZR_LAWDB_SIGNER_PUB: devPem! }).contentKeyDev, true, "经 ZR_LAWDB_SIGNER_PUB 给出的开发公钥（无标记）");
  assert.equal(cfg({ ZR_LAWDB_SIGNER_PUB: otherPem }).contentKeyDev, false);
  assert.equal(cfg({ ZR_LAWDB_SIGNER_PUB: otherPem, ZR_CONTENT_KEYS: JSON.stringify([devPem]) }).contentKeyDev, true, "轮换公钥表里混进开发公钥");
});

test("构建脚本：KWL_CONTENT_SIGNING_PUB_FILE 指向去掉标记的开发公钥副本 → 门禁失败；正式公钥 → 门禁通过（只核门禁，不改制品）", { skip: !devPem && "本机还没有开发公钥", timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ck-pub-"));
  const copy = join(dir, "prod.pub.json");
  writeFileSync(copy, JSON.stringify({ publicKeyPem: devPem }));
  const r = spawnSync(process.execPath, [join(root, "scripts/build-kernel.mjs"), "--check-content-key"], { cwd: root, env: { ...process.env, KWL_CONTENT_SIGNING_PUB_FILE: copy }, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /指向的是开发公钥/);
  const prod = join(dir, "real.pub.json");
  writeFileSync(prod, JSON.stringify({ publicKeyPem: otherPem }));
  const ok = spawnSync(process.execPath, [join(root, "scripts/build-kernel.mjs"), "--check-content-key"], { cwd: root, env: { ...process.env, KWL_CONTENT_SIGNING_PUB_FILE: prod }, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /门禁通过/);
});

test("仓库登记表：格式合格，本机开发公钥已登记（build:lawdb 自动登记），本机开发公钥文件带 dev 标记", { skip: !devPem && "本机还没有开发公钥" }, () => {
  const fps = readDevFpTable(root) as string[];
  assert.ok(fps.length >= 1);
  for (const f of fps) assert.match(f, /^[0-9a-f]{64}$/);
  assert.ok(fps.includes(contentKeyFingerprint(devPem!)!), "本机开发公钥指纹未登记：先运行 npm run build:lawdb 并提交 content/dev-content-key-fingerprints.json");
  assert.equal(JSON.parse(readFileSync(devPubFile, "utf8")).dev, true, "旧开发公钥文件补上了 dev 标记");
});

test("正式安装包（安装包形态 + 未标 test_build）：随包开发公钥拒载、内核不启动；content_keys 里的开发公钥剔除；测试构建照常只报 dev", { skip: !devPem && "本机还没有开发公钥", timeout: 60_000 }, async () => {
  const release = { ZR_REQUIRE_CONTROL_PLANE: "1", ZR_RELEASE_BUILD: "1" };
  const refused = cfg({ ...release, ZR_LAWDB_SIGNER_PUB: devPem! });
  assert.equal(refused.contentKeyRefused, true);
  assert.equal(refused.lawdbSignerPub, "", "开发公钥不进信任表");
  const testBuild = cfg({ ZR_REQUIRE_CONTROL_PLANE: "1", ZR_LAWDB_SIGNER_PUB: devPem! });
  assert.equal(testBuild.contentKeyRefused, false, "测试构建（未标正式发布）照常加载");
  assert.equal(testBuild.contentKeyDev, true);
  const other2 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const extra = cfg({ ...release, ZR_LAWDB_SIGNER_PUB: otherPem, ZR_CONTENT_KEYS: JSON.stringify([devPem, other2]) });
  assert.equal(extra.contentKeyRefused, false);
  assert.equal(extra.contentKeyDev, false, "剔除后信任表里没有开发公钥");
  assert.deepEqual(extra.contentKeysExtra, [other2]);
  assert.equal(extra.contentKeysRefused, 1);
  // 内核启动即报错（律师看到的是一句话，不是“先运行 build:lawdb”）
  const { createKernel } = await import("../src/index.ts");
  await assert.rejects(
    createKernel({ dataDir: mkdtempSync(join(tmpdir(), "kwl-ck-k-")), firmSlug: "ck-firm", userSlug: "u", dbKey: "x".repeat(44), env: { ...process.env, ...release, ZR_LAWDB_SIGNER_PUB: devPem!, ZR_KERNEL_TCP: "off" } as NodeJS.ProcessEnv } as any),
    (e: any) => e.code === "lawdb_invalid" && /测试用的内容签名公钥/.test(e.message),
  );
});
