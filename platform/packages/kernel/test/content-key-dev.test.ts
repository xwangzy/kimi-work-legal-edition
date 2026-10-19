/**
 * 开发内容签名公钥按指纹识别（复核 A-14 / B13-O05）：复制一份开发公钥、去掉 dev 标记，内核仍报 content_key=dev；
 * release.json 的 content_keys 混进开发公钥同样报 dev；构建脚本对指向开发公钥副本的 KWL_CONTENT_SIGNING_PUB_FILE 直接失败。
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

test("构建脚本：KWL_CONTENT_SIGNING_PUB_FILE 指向去掉标记的开发公钥副本 → 构建失败", { skip: !devPem && "本机还没有开发公钥", timeout: 60_000 }, () => {
  const copy = join(mkdtempSync(join(tmpdir(), "kwl-ck-pub-")), "prod.pub.json");
  writeFileSync(copy, JSON.stringify({ publicKeyPem: devPem }));
  const r = spawnSync(process.execPath, [join(root, "scripts/build-kernel.mjs")], { cwd: root, env: { ...process.env, KWL_CONTENT_SIGNING_PUB_FILE: copy }, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /指向的是开发公钥/);
});
