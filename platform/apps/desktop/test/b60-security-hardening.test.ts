/**
 * 第 60 批安全加固（研究记录 V34）：
 * H1 安装包 JS 制品压缩；H2 生产内容签名密钥（开发密钥拒用、演示增量样例不签）；H3 安装包 SHA256SUMS 与 Ed25519 签名；
 * H4 正式包关开发者工具、精简菜单；H5 通用秘密扫描；H6 发布签名不再静默用开发密钥；H7 windows-e2e 工作流加固。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const PLATFORM = join(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(join(PLATFORM, p), "utf8");

const { devToolsAllowed, appMenuTemplate, menuHasDebugItems } = require("../electron/release-hardening.cjs") as {
  devToolsAllowed: (o: { isPackaged: boolean; testBuild?: boolean }) => boolean;
  appMenuTemplate: (platform: string, name: string) => unknown[] | null;
  menuHasDebugItems: (t: unknown[] | null) => boolean;
};

test("H4 正式包不允许开发者工具；测试包与开发形态保留", () => {
  assert.equal(devToolsAllowed({ isPackaged: true, testBuild: false }), false);
  assert.equal(devToolsAllowed({ isPackaged: true }), false);
  assert.equal(devToolsAllowed({ isPackaged: true, testBuild: true }), true);
  assert.equal(devToolsAllowed({ isPackaged: false }), true);
});

test("H4 安装包菜单：macOS 有编辑菜单、不含开发者工具与强制重载；Windows 不显示菜单栏", () => {
  const mac = appMenuTemplate("darwin", "Kimi Work 法律版");
  assert.ok(Array.isArray(mac));
  assert.equal(menuHasDebugItems(mac), false);
  const roles = JSON.stringify(mac);
  for (const r of ["copy", "paste", "selectAll", "undo", "quit"]) assert.match(roles, new RegExp(`"role":"${r}"`));
  assert.equal(appMenuTemplate("win32", "x"), null);
  // 自检函数本身认得出调试项
  assert.equal(menuHasDebugItems([{ label: "视图", submenu: [{ role: "toggleDevTools" }] }]), true);
  const main = read("apps/desktop/electron/main.cjs");
  assert.match(main, /devTools: devToolsAllowed\(\{ isPackaged: app\.isPackaged, testBuild: releaseConfig\(\)\?\.testBuild === true \}\)/);
  assert.match(main, /if \(app\.isPackaged\) \{\n\s*const tpl = appMenuTemplate\(process\.platform, app\.getName\(\)\);\n\s*Menu\.setApplicationMenu/);
});

test("H5 通用秘密扫描：私钥 PEM、sk- 形态、GitHub 令牌、AWS 密钥命中；只有 PEM 头（解析代码里的常量）不算", () => {
  const script = read("scripts/package-desktop.mjs");
  const fn = /function secretHits\(buf\) \{[\s\S]*?\n\}\n/.exec(script)?.[0];
  assert.ok(fn, "package-desktop.mjs 里应有 secretHits");
  const secretHits = new Function(`${fn}; return secretHits;`)() as (b: Buffer) => { fatal: string[]; jwt: boolean };
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.deepEqual(secretHits(Buffer.from(`const k=${JSON.stringify(pem)};`)).fatal, ["私钥 PEM"]);
  assert.deepEqual(secretHits(Buffer.from(pem)).fatal, ["私钥 PEM"]);
  assert.deepEqual(secretHits(Buffer.from('const H="-----BEGIN PRIVATE KEY-----";')).fatal, []);
  assert.deepEqual(secretHits(Buffer.from(`k=sk-${"A1b2".repeat(10)}`)).fatal, ["sk- 形态的 API Key"]);
  assert.deepEqual(secretHits(Buffer.from("task-list sk-short risk-management")).fatal, []);
  assert.deepEqual(secretHits(Buffer.from(`t=ghp_${"a".repeat(36)}`)).fatal, ["GitHub 令牌"]);
  assert.deepEqual(secretHits(Buffer.from("AKIAABCDEFGHIJKLMNOP")).fatal, ["AWS 访问密钥"]);
  assert.equal(secretHits(Buffer.from("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstu")).jwt, true);
  assert.deepEqual(secretHits(Buffer.from("plain text 法律文书")).fatal, []);
  // 范围：暂存目录与随包运行时；命中即中止
  assert.match(script, /for \(const d of \[stage, join\(desktop, "runtime"\)\]\) scanSecrets\(d\);\n\s*if \(hits\.length\) throw new Error/);
});

test("H2 生产内容签名密钥：未设返回 null；开发密钥、公私钥不配对、非 Ed25519 一律拒用", async () => {
  const { releaseContentSigningKey, keyFp } = (await import("../../../scripts/lib/dev-content-keys.mjs")) as {
    releaseContentSigningKey: (root: string, env?: Record<string, string | undefined>) => { publicKeyPem: string } | null;
    keyFp: (pem: string) => string;
  };
  const dir = mkdtempSync(join(tmpdir(), "kwl-b60-key-"));
  const pair = () => {
    const p = generateKeyPairSync("ed25519");
    return { publicKeyPem: p.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem: p.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  };
  assert.equal(releaseContentSigningKey(PLATFORM, {}), null);
  const good = pair();
  writeFileSync(join(dir, "good.json"), JSON.stringify(good));
  assert.equal(keyFp(releaseContentSigningKey(PLATFORM, { KWL_CONTENT_SIGNING_KEY_FILE: join(dir, "good.json") })!.publicKeyPem), keyFp(good.publicKeyPem));
  const other = pair();
  writeFileSync(join(dir, "mismatch.json"), JSON.stringify({ publicKeyPem: other.publicKeyPem, privateKeyPem: good.privateKeyPem }));
  assert.throws(() => releaseContentSigningKey(PLATFORM, { KWL_CONTENT_SIGNING_KEY_FILE: join(dir, "mismatch.json") }), /不配对/);
  writeFileSync(join(dir, "dev.json"), JSON.stringify({ ...pair(), dev: true }));
  assert.throws(() => releaseContentSigningKey(PLATFORM, { KWL_CONTENT_SIGNING_KEY_FILE: join(dir, "dev.json") }), /开发密钥/);
  // 登记表里的开发公钥（按指纹）也拒用：取登记表里随便一把对不上私钥，故用“本机开发密钥”本身验证
  const localDev = join(PLATFORM, "content/keys/content-signing-dev.json");
  try {
    readFileSync(localDev);
    assert.throws(() => releaseContentSigningKey(PLATFORM, { KWL_CONTENT_SIGNING_KEY_FILE: localDev }), /开发密钥/);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
  writeFileSync(join(dir, "rsa.json"), JSON.stringify({ publicKeyPem: rsa.publicKey.export({ type: "spki", format: "pem" }), privateKeyPem: rsa.privateKey.export({ type: "pkcs8", format: "pem" }) }));
  assert.throws(() => releaseContentSigningKey(PLATFORM, { KWL_CONTENT_SIGNING_KEY_FILE: join(dir, "rsa.json") }), /Ed25519/);
});

test("H2 四类内容构建都经 releaseContentSigningKey 取密钥；演示增量样例在生产签名时跳过", () => {
  for (const f of ["content/lawdb/build-lawdb.mjs", "content/skills/build-skills.mjs", "content/tool-manifest/build-lock.mjs", "content/agent-profile/build-profile.mjs"]) {
    assert.match(read(f), /const key = releaseContentSigningKey\(root\) \?\? /, f);
  }
  const incr = read("content/lawdb/build-increment-sample.mjs");
  assert.ok(incr.indexOf("if (process.env.KWL_CONTENT_SIGNING_KEY_FILE)") < incr.indexOf("const key = ensureContentSigningKey"));
  const pkg = read("scripts/package-desktop.mjs");
  // 正式发布不用代码签名只在显式 --unsigned-release 时放行；--sign dev 一律不放行
  assert.match(pkg, /if \(sign === "dev" \|\| \(sign === "none" && !unsignedRelease\)\) throw new Error/);
  assert.match(pkg, /else if \(unsignedRelease\) throw new Error\("--unsigned-release 只用于正式发布/);
  // H1：打包缺省压缩
  assert.match(pkg, /const minify = !argv\.includes\("--no-minify"\);\nif \(minify\) process\.env\.KWL_MINIFY = "1";/);
  assert.match(read("scripts/build-kernel.mjs"), /process\.env\.KWL_MINIFY === "1" \? \{ minify: true, keepNames: true/);
  assert.match(read("scripts/build-runtime.mjs"), /process\.env\.KWL_MINIFY === "1" \? \{ minify: true, keepNames: true/);
});

test("H3 SHA256SUMS 签名：通过；改文件、改清单、换公钥都报出来", async () => {
  const mod = (await import("../../../scripts/sign-release-checksums.mjs")) as { verifyDir: (d: string, pub?: string) => string[]; parseSums: (t: string) => unknown[] };
  const dir = mkdtempSync(join(tmpdir(), "kwl-b60-sums-"));
  writeFileSync(join(dir, "KimiWorkLegal-Setup-0.2.0.exe"), "exe-bytes");
  writeFileSync(join(dir, "KimiWorkLegal-0.2.0-arm64.dmg"), "dmg-bytes");
  const key = generateKeyPairSync("ed25519");
  writeFileSync(join(dir, "k.pem"), key.privateKey.export({ type: "pkcs8", format: "pem" }));
  execFileSync(process.execPath, [join(PLATFORM, "scripts/sign-release-checksums.mjs"), "--out", dir, join(dir, "KimiWorkLegal-Setup-0.2.0.exe"), join(dir, "KimiWorkLegal-0.2.0-arm64.dmg")], { env: { ...process.env, KWL_RELEASE_SIGNING_KEY: join(dir, "k.pem") }, stdio: "pipe" });
  assert.deepEqual(mod.verifyDir(dir), []);
  assert.equal(mod.parseSums(readFileSync(join(dir, "SHA256SUMS.txt"), "utf8")).length, 2);
  writeFileSync(join(dir, "KimiWorkLegal-0.2.0-arm64.dmg"), "tampered");
  assert.deepEqual(mod.verifyDir(dir), ["摘要不符：KimiWorkLegal-0.2.0-arm64.dmg"]);
  writeFileSync(join(dir, "KimiWorkLegal-0.2.0-arm64.dmg"), "dmg-bytes");
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.match(mod.verifyDir(dir, other).join(), /签名不符/);
  writeFileSync(join(dir, "SHA256SUMS.txt"), readFileSync(join(dir, "SHA256SUMS.txt"), "utf8").replace(/^[0-9a-f]/, (c) => (c === "0" ? "1" : "0")));
  assert.match(mod.verifyDir(dir).join(), /签名不符/);
  assert.throws(() => mod.parseSums("abc  ../evil.exe\n"), /格式不对/);
});

test("H6 发布签名不再静默改用开发密钥", () => {
  const s = read("scripts/sign-update.mjs");
  assert.match(s, /if \(!argv\.includes\("--dev-key"\)\) \{[\s\S]*?process\.exit\(2\);/);
});

test("H7 windows-e2e：Action 固定提交 SHA、checkout 不留凭据、run 脚本里不内插输入、断网按解析出的 IP 封锁、正式包按摘要取签名内容包", () => {
  for (const f of ["desktop-repo/template/.github/workflows/windows-e2e.yml", "desktop-repo/template/.github/workflows/desktop-ci.yml"]) {
    const y = read(f);
    for (const m of y.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: ${m[1]} 须固定到提交 SHA`);
  }
  const y = read("desktop-repo/template/.github/workflows/windows-e2e.yml");
  assert.match(y, /persist-credentials: false/);
  // run 块里不出现 ${{ inputs.* }}（输入只经 env: 或事件文件进入脚本）
  const runBlocks = [...y.matchAll(/run: \|\n((?:\s{10,}.*\n)+)/g)].map((m) => m[1]).concat([...y.matchAll(/run: (?!\|)(.*)/g)].map((m) => m[1]));
  for (const b of runBlocks) assert.doesNotMatch(b, /\$\{\{\s*inputs\./);
  assert.match(y, /-RemoteAddress \(\$env:KWL_CLOUD_IPS -split ','\)/);
  assert.match(y, /\[ "\$gotc" = "\$WANT_CONTENT" \]/);
  assert.match(y, /KWL_PKG_FLAGS=--prebuilt-content --unsigned-release/);
  assert.doesNotMatch(y, /须标 test_build/);
});
