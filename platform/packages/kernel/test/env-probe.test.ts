/**
 * Windows 环境自检（v9.2 §3.7；Y5 P1-6）：固定脚本、只读；读不到的一项报“未知”不误报；Windows 之外“不适用”；
 * 输出只含枚举与杀软产品名（不含路径与用户名）。BitLocker 取值的真机标定见 Y5（本用例只锁定解析口径）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bitlockerOf, interpretProbe, PROBE_SCRIPT, probeEnvironment } from "../src/services/env-probe.ts";

test("解析：漫游、重定向、FSLogix、OneDrive、LocalDumps、防火墙规则组、杀软、BitLocker", () => {
  const r = interpretProbe(
    JSON.stringify({
      central: "\\\\fs01\\profiles$\\zhang",
      appdata: "\\\\fs01\\redirect\\zhang\\AppData\\Roaming",
      localappdata: "%USERPROFILE%\\AppData\\Local",
      personal: "C:\\Users\\zhang\\OneDrive - 某律所\\Documents",
      desktop: "%USERPROFILE%\\Desktop",
      fslogix: "1",
      localdumps: true,
      bitlocker: 1,
      av: ["Windows Defender", "火绒安全软件\u0007"],
      fw: 3,
    }),
  );
  assert.deepEqual(
    { ...r, checked_at: "x" },
    { platform: "win32", bitlocker: "on", roaming_profile: "yes", folder_redirection: "yes", fslogix: "yes", onedrive_kfm: "yes", local_dumps: "yes", firewall_rules: "yes", antivirus: ["Windows Defender", "火绒安全软件"], checked_at: "x" },
  );
  assert.ok(!JSON.stringify(r).includes("zhang") && !JSON.stringify(r).includes("fs01"), "结果不含路径与用户名");
  const plain = interpretProbe(JSON.stringify({ central: "", appdata: "%USERPROFILE%\\AppData\\Roaming", personal: "%USERPROFILE%\\Documents", fslogix: "", localdumps: false, bitlocker: 2, av: "Windows Defender", fw: 0 }));
  assert.equal(plain.roaming_profile, "no");
  assert.equal(plain.folder_redirection, "no");
  assert.equal(plain.onedrive_kfm, "no");
  assert.equal(plain.bitlocker, "off");
  assert.equal(plain.firewall_rules, "no");
  assert.deepEqual(plain.antivirus, ["Windows Defender"]);
});

test("读不到即未知（不误报）；BitLocker 只认常见取值；Windows 之外不适用；脚本固定、不拼接输入", async () => {
  const empty = interpretProbe("not json");
  for (const k of ["bitlocker", "roaming_profile", "folder_redirection", "fslogix", "onedrive_kfm", "local_dumps", "firewall_rules"] as const) assert.equal(empty[k], "unknown", k);
  assert.equal(bitlockerOf(null), "unknown");
  assert.equal(bitlockerOf(5), "suspended");
  assert.equal(bitlockerOf(8), "pending");
  assert.equal(bitlockerOf(99), "unknown");
  const mac = await probeEnvironment({ platform: "darwin" });
  assert.equal(mac.bitlocker, "not_applicable");
  let seen: { file: string; args: string[] } | null = null;
  const win = await probeEnvironment({ platform: "win32", systemRoot: "C:\\Windows", runner: async (file, args) => ((seen = { file, args }), { code: 0, stdout: JSON.stringify({ central: "", fw: 0 }) }) });
  assert.equal(win.roaming_profile, "no");
  assert.ok(seen!.file.endsWith("powershell.exe") && seen!.file.includes("System32"));
  assert.deepEqual(seen!.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(seen!.args[3], PROBE_SCRIPT);
  assert.ok(!PROBE_SCRIPT.includes("Invoke-WebRequest") && !/Set-|Remove-|New-Item/.test(PROBE_SCRIPT), "只读");
  const failed = await probeEnvironment({ platform: "win32", runner: async () => ({ code: 1, stdout: "" }) });
  assert.equal(failed.bitlocker, "unknown");
});
