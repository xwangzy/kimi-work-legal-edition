/**
 * Apple 芯片 Mac 上出 Windows NSIS 安装包：electron-builder 自带的 makensis（nsis-3.0.4.1/mac）是 x86_64，没有 Rosetta 跑不起来。
 * 本脚本在 .cache/mac-nsis/ 生成一个 ELECTRON_BUILDER_NSIS_DIR 目录：mac/makensis 是转调 Homebrew 原生 makensis 的包装脚本
 * （NSISDIR 指向 Homebrew 的 share/nsis，含 x86-unicode 安装包存根），elevate.exe 取自 electron-builder 缓存的 NSIS 包。
 *
 * 前提：brew install makensis；electron-builder 至少跑过一次（缓存里有 nsis-3.0.4.1）。
 * 用法：node scripts/mac-nsis-shim.mjs   → 打印 export ELECTRON_BUILDER_NSIS_DIR=…，再运行 package-desktop.mjs
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, ".cache/mac-nsis");
const prefix = execFileSync("brew", ["--prefix", "makensis"], { encoding: "utf8" }).trim();
const bin = join(prefix, "bin/makensis");
const share = join(prefix, "share/nsis");
if (!existsSync(bin) || !existsSync(join(share, "Stubs"))) throw new Error("没有找到 Homebrew 的 makensis：先 brew install makensis");

const cache = join(homedir(), "Library/Caches/electron-builder/nsis-3.0.4.1");
const legacy = existsSync(cache) ? readdirSync(cache).map((d) => join(cache, d)).find((d) => existsSync(join(d, "elevate.exe"))) : undefined;
if (!legacy) throw new Error("electron-builder 缓存里没有 nsis-3.0.4.1（elevate.exe）：先运行一次 package-desktop.mjs 让它下载");

mkdirSync(join(out, "mac"), { recursive: true });
copyFileSync(join(legacy, "elevate.exe"), join(out, "elevate.exe"));
const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
writeFileSync(join(out, "mac/makensis"), `#!/bin/sh\nNSISDIR=${sq(share)} exec ${sq(bin)} "$@"\n`);
chmodSync(join(out, "mac/makensis"), 0o755);
console.log(`# makensis ${execFileSync(join(out, "mac/makensis"), ["-VERSION"], { encoding: "utf8" }).trim()}`);
console.log(`export ELECTRON_BUILDER_NSIS_DIR=${sq(out)}`);
