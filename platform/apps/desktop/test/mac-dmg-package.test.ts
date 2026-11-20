/**
 * macOS DMG 安装包（Apple 芯片）：目标平台校验与 electron-builder 参数（Windows 与改造前逐项相同）、electron-builder.yml 的 mac/dmg 段、
 * build/icon.icns（测试内独立解析，不复用生成脚本）、mac 运行时锁文件、非 Windows 下 --user-data-dir 隔离数据根、冒烟认得“登录 / 注册”激活页。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const file = (p: string) => new URL(`../${p}`, import.meta.url);
const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);
const { packageTargetProblem, electronBuilderArgs, PACKAGE_TARGETS } = (await import("../../../scripts/lib/package-targets.mjs")) as {
  packageTargetProblem: (o: { target: string; sign: string; hostPlatform: string }) => string | null;
  electronBuilderArgs: (o: { target: string; sign: string; trial: boolean; dirOnly: boolean }) => string[];
  PACKAGE_TARGETS: Record<string, unknown>;
};

test("目标平台：只认 win32-x64 与 darwin-arm64；DMG 只能在 macOS 上、只能 --sign none（ad-hoc）构建", () => {
  assert.deepEqual(Object.keys(PACKAGE_TARGETS).sort(), ["darwin-arm64", "win32-x64"]);
  for (const sign of ["dev", "env", "none"]) for (const host of ["win32", "darwin", "linux"]) assert.equal(packageTargetProblem({ target: "win32-x64", sign, hostPlatform: host }), null, `${sign}@${host}`);
  assert.equal(packageTargetProblem({ target: "darwin-arm64", sign: "none", hostPlatform: "darwin" }), null);
  for (const sign of ["dev", "env"]) assert.match(packageTargetProblem({ target: "darwin-arm64", sign, hostPlatform: "darwin" })!, /暂只支持 --sign none/);
  for (const host of ["win32", "linux"]) assert.match(packageTargetProblem({ target: "darwin-arm64", sign: "none", hostPlatform: host })!, /只能在 macOS 上构建/);
  for (const t of ["darwin-x64", "win32-arm64", "linux-x64", "win32", ""]) assert.match(packageTargetProblem({ target: t, sign: "none", hostPlatform: "darwin" })!, /暂只支持 win32-x64、darwin-arm64/);
});

test("electron-builder 参数：Windows 与改造前的写法逐项相同；macOS 用 --mac --arm64 与 ad-hoc 身份，试用包另起 ASCII 文件名", () => {
  // 改造前 package-desktop.mjs 的原样拼法（--win、--x64、试用 nsis.artifactName、--dir 在最后）
  const before = (trial: boolean, dirOnly: boolean) => {
    const a = ["electron-builder", "--win", "--x64", "--config", "electron-builder.yml", "--publish", "never"];
    if (trial) a.push("-c.nsis.artifactName=KimiWorkLegal-Trial-Setup-${version}.${ext}");
    if (dirOnly) a.push("--dir");
    return a;
  };
  for (const sign of ["dev", "env", "none"]) for (const trial of [false, true]) for (const dirOnly of [false, true]) assert.deepEqual(electronBuilderArgs({ target: "win32-x64", sign, trial, dirOnly }), before(trial, dirOnly));
  assert.deepEqual(electronBuilderArgs({ target: "darwin-arm64", sign: "none", trial: false, dirOnly: false }), ["electron-builder", "--mac", "--arm64", "--config", "electron-builder.yml", "--publish", "never", "-c.mac.identity=-"]);
  const t = electronBuilderArgs({ target: "darwin-arm64", sign: "none", trial: true, dirOnly: true });
  assert.ok(t.includes("-c.dmg.artifactName=KimiWorkLegal-Trial-${version}-${arch}.${ext}"));
  assert.equal(t.at(-1), "--dir");
  assert.ok(!t.some((a) => a.includes("nsis")), "mac 参数不带 nsis 覆盖");
  assert.throws(() => electronBuilderArgs({ target: "darwin-x64", sign: "none", trial: false, dirOnly: false }));
});

test("package-desktop.mjs：目标校验与 electron-builder 参数都走 scripts/lib/package-targets.mjs，macOS 运行时取 fetch-mac-runtime.mjs", () => {
  const s = readFileSync(repo("scripts/package-desktop.mjs"), "utf8");
  assert.match(s, /const problem = packageTargetProblem\(\{ target, sign, hostPlatform: process\.platform \}\);\n\s*if \(problem\) throw new Error\(problem\);/);
  assert.match(s, /const builderArgs = electronBuilderArgs\(\{ target, sign, trial: !!trial, dirOnly \}\);\nrun\("npx", builderArgs, \{ cwd: desktop, env \}\);/);
  assert.match(s, /run\("node", \["scripts\/fetch-mac-runtime\.mjs", "--target", target\]\)/);
  // 显式 --target darwin-* 时 build-runtime 只认锁定的官方 Node（不带 --target 的本机验证仍用当前 node）
  const br = readFileSync(repo("scripts/build-runtime.mjs"), "utf8");
  assert.match(br, /\} else if \(arg\("--target"\) !== undefined && targetPlatform === "darwin"\) \{/);
  assert.match(br, /lock\.node\[target\]\?\.binSha256/);
});

test("mac-runtime.lock.json：与 Windows 锁同一 Node 版本，只指向 nodejs.org 官方同版本地址，摘要已锁定", () => {
  const mac = JSON.parse(readFileSync(repo("scripts/mac-runtime.lock.json"), "utf8"));
  const win = JSON.parse(readFileSync(repo("scripts/win-runtime.lock.json"), "utf8"));
  assert.equal(mac.node.version, win.node.version);
  const v = mac.node.version;
  assert.equal(mac.node.shasumsUrl, `https://nodejs.org/dist/${v}/SHASUMS256.txt`);
  const a = mac.node["darwin-arm64"];
  assert.equal(a.tarUrl, `https://nodejs.org/dist/${v}/node-${v}-darwin-arm64.tar.gz`);
  assert.match(a.tarSha256, /^[0-9a-f]{64}$/);
  assert.match(a.binSha256, /^[0-9a-f]{64}$/);
});

test("electron-builder.yml：mac 段出 arm64 DMG、hardened runtime、不重签随包运行时与 unpacked 原生模块；DMG 文件名只用 ASCII；Windows 段不变", () => {
  const yml = readFileSync(file("electron-builder.yml"), "utf8");
  const block = (key: string) => {
    const m = yml.match(new RegExp(`^${key}:\\n((?:[ #].*\\n|\\n)*)`, "m"));
    assert.ok(m, `缺 ${key} 段`);
    return m[1]!;
  };
  const mac = block("mac");
  assert.match(mac, /- target: dmg\n\s+arch: \[arm64\]/);
  assert.match(mac, /^ {2}icon: build\/icon\.icns$/m);
  assert.match(mac, /^ {2}hardenedRuntime: true$/m);
  assert.match(mac, /^ {2}entitlements: build\/entitlements\.mac\.plist$/m);
  assert.match(mac, /^ {2}entitlementsInherit: build\/entitlements\.mac\.plist$/m);
  assert.match(mac, /^ {2}notarize: false$/m);
  assert.doesNotMatch(mac, /^ {2}identity:/m, "身份由 package-desktop.mjs 按 --sign 注入，不写死在配置里");
  const ignore = [...mac.matchAll(/^ {4}- "(.+)"$/gm)].map((m) => new RegExp(m[1]!.replace(/\\\\/g, "\\")));
  const app = "/x/KimiWorkLegal.app";
  for (const p of ["/Contents/Resources/runtime/node/kwl-host", "/Contents/Resources/runtime/parse/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node", "/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3-multiple-ciphers/prebuilds/darwin-arm64.node"]) {
    assert.ok(ignore.some((r) => r.test(app + p)), `应不重签：${p}`);
  }
  for (const p of ["/Contents/MacOS/KimiWorkLegal", "/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"]) assert.ok(!ignore.some((r) => r.test(app + p)), `应签名：${p}`);
  assert.match(block("dmg"), /^ {2}artifactName: KimiWorkLegal-\$\{version\}-\$\{arch\}\.\$\{ext\}$/m);
  const win = block("win");
  assert.match(win, /- target: nsis\n\s+arch: \[x64\]/);
  assert.match(win, /signExts: \["!node\.exe", "!kwl-egress\.exe", "!kwl-host\.exe", "!kwl-parse\.exe"\]/);
  const ent = readFileSync(file("build/entitlements.mac.plist"), "utf8");
  const keys = [...ent.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation"]);
});

/** 独立的 ICNS 解析：[类型, PNG] */
function readIcns(buf: Buffer): [string, Buffer][] {
  assert.equal(buf.toString("latin1", 0, 4), "icns");
  assert.equal(buf.readUInt32BE(4), buf.length, "总长");
  const out: [string, Buffer][] = [];
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off + 4);
    assert.ok(len > 8 && off + len <= buf.length, "条目越界");
    out.push([buf.toString("latin1", off, off + 4), buf.subarray(off + 8, off + len)]);
    off += len;
  }
  return out;
}
/** 取 8 位 RGBA、无隔行 PNG 的一个像素 */
function pngPixel(png: Buffer, x: number, y: number): number[] {
  const w = png.readUInt32BE(16);
  const idat: Buffer[] = [];
  for (let off = 8; off < png.length; ) {
    const len = png.readUInt32BE(off), type = png.toString("latin1", off + 4, off + 8);
    if (type === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * 4 + 1;
  const rows: Buffer[] = [];
  for (let r = 0; r <= y; r++) {
    const f = raw[r * stride]!, line = Buffer.from(raw.subarray(r * stride + 1, (r + 1) * stride)), prev = rows[r - 1];
    for (let i = 0; i < line.length; i++) {
      const a = i >= 4 ? line[i - 4]! : 0, b = prev ? prev[i]! : 0, c = prev && i >= 4 ? prev[i - 4]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      line[i] = (line[i]! + pred) & 0xff;
    }
    rows.push(line);
  }
  return [...rows[y]!.subarray(x * 4, x * 4 + 4)];
}

test("icon.icns：16～1024 共 10 个 PNG 条目，宽高与类型相符；按 macOS 栅格留边（角上透明）、底板黑色", () => {
  const want: Record<string, number> = { icp4: 16, icp5: 32, ic11: 32, ic12: 64, ic07: 128, ic13: 256, ic08: 256, ic14: 512, ic09: 512, ic10: 1024 };
  const entries = readIcns(readFileSync(file("build/icon.icns")));
  assert.deepEqual(entries.map(([t]) => t).sort(), Object.keys(want).sort());
  for (const [type, png] of entries) {
    assert.ok(png.subarray(1, 4).toString("latin1") === "PNG", `${type} 应为 PNG`);
    assert.equal(png.readUInt32BE(16), want[type], `${type} 宽`);
    assert.equal(png.readUInt32BE(20), want[type], `${type} 高`);
    assert.equal(png[25], 6, `${type} 应为 RGBA`);
  }
  const big = entries.find(([t]) => t === "ic10")![1];
  assert.equal(pngPixel(big, 50, 512)[3], 0, "留边处透明（100/1024 栅格）");
  const bg = pngPixel(big, 140, 512);
  assert.ok(bg[3] === 255 && bg[0]! < 16 && bg[1]! < 16 && bg[2]! < 16, `底板应为黑色：${bg}`);
});

test("非 Windows：显式 --user-data-dir 时数据根随之放进该目录（Windows 仍固定在 %LOCALAPPDATA%）", () => {
  const main = readFileSync(file("electron/main.cjs"), "utf8");
  assert.match(main, /const LOCAL_ROOT =\n\s+process\.platform === "win32" \?/);
  assert.match(
    main,
    /const DATA_DIR =\n\s+LOCAL_ROOT \?\? path\.join\(app\.commandLine\.hasSwitch\("user-data-dir"\) \? app\.getPath\("userData"\) : app\.getPath\("appData"\), "KimiWorkLegal"\);/,
  );
});

test("安装后冒烟认得未开通电脑的缺省激活页（登录 / 注册，.auth-seg）", () => {
  const main = readFileSync(file("electron/main.cjs"), "utf8");
  assert.match(main, /document\.querySelector\('\.activate-title, \.auth-seg, \.shell'\)/);
  const activate = readFileSync(file("src/pages/Activate.tsx"), "utf8");
  assert.match(activate, /const \[view, setView\] = useState<View>\(.*\? "restore" : "login"\);/, "缺省视图是登录");
  assert.match(activate, /<div className="auth-seg" role="tablist"/, "登录 / 注册页带 .auth-seg");
});
