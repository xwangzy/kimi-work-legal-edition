/**
 * 桌面安装包的目标平台（scripts/package-desktop.mjs 用；纯函数，单测见 apps/desktop/test/mac-dmg-package.test.ts）。
 *
 *   win32-x64     Windows NSIS 安装包（按用户安装）。签名 dev|env|none
 *   darwin-arm64  macOS DMG（Apple 芯片）。暂只支持 --sign none：ad-hoc 签名（codesign 身份 "-"），只用于本机与内部测试——
 *                 Developer ID 签名与公证尚未接入（随包运行时须在算清单摘要之前先签，见 docs/部署-云端控制台与桌面端对接.md §7.3b）
 * darwin-x64（Intel Mac）未做：要另锁 @napi-rs/canvas-darwin-x64 原生包与 x64 的 Electron，且本机无法实测。
 */

/** target → electron-builder 平台开关 */
export const PACKAGE_TARGETS = {
  "win32-x64": { builder: "--win", arch: "x64" },
  "darwin-arm64": { builder: "--mac", arch: "arm64" },
};

/** 参数组合不可用时的原因（可用时为 null）。hostPlatform 为构建机 process.platform。 */
export function packageTargetProblem({ target, sign, hostPlatform }) {
  if (!Object.hasOwn(PACKAGE_TARGETS, target)) return `暂只支持 ${Object.keys(PACKAGE_TARGETS).join("、")} 安装包（得到 ${target}）`;
  if (target.startsWith("darwin-")) {
    if (hostPlatform !== "darwin") return "macOS 安装包（DMG）只能在 macOS 上构建（要用 codesign 与 hdiutil）";
    if (sign !== "none") return `macOS 安装包暂只支持 --sign none（ad-hoc 签名，得到 --sign ${sign}）：Developer ID 签名与公证尚未接入，见 docs/部署-云端控制台与桌面端对接.md §7.3b`;
  }
  return null;
}

/** electron-builder 命令行（npx 之后的参数）。Windows 与改造前逐项相同。 */
export function electronBuilderArgs({ target, sign, trial, dirOnly }) {
  const t = PACKAGE_TARGETS[target];
  if (!t) throw new Error(`未知目标 ${target}`);
  const args = ["electron-builder", t.builder, `--${t.arch}`, "--config", "electron-builder.yml", "--publish", "never"];
  if (target.startsWith("darwin-")) {
    // --sign none：ad-hoc 签名（Apple 芯片上的可执行文件必须至少有 ad-hoc 签名；熔断改写后的 Electron 也须重签才能启动）
    if (sign === "none") args.push("-c.mac.identity=-");
    // 试用安装包另起文件名（与正式安装包区分）
    if (trial) args.push("-c.dmg.artifactName=KimiWorkLegal-Trial-${version}-${arch}.${ext}");
  } else if (trial) args.push("-c.nsis.artifactName=KimiWorkLegal-Trial-Setup-${version}.${ext}");
  if (dirOnly) args.push("--dir");
  return args;
}
