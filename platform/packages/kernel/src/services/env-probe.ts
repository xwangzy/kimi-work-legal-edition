/**
 * Windows 环境自检（v9.2 §3.7；调研 Y5 §2、P1-6）：只读核对会让“本机加密保存”打折扣的系统环境，在设备页与诊断包里如实提示——
 * BitLocker（数据所在盘）、漫游配置文件、文件夹重定向到网络位置、FSLogix 配置文件容器、OneDrive 已知文件夹移动、WER 本地完整转储（LocalDumps）、
 * 律所 IT 下发的出站规则组是否存在、杀毒软件产品名。
 *
 * 做法：一段**固定的** PowerShell 脚本（不拼接任何外部输入）经随系统的 powershell.exe 运行一次，输出 JSON；读不到的一项一律“未知”，不误报。
 * 结果只含枚举与产品名，不含路径与用户名。BitLocker 的 Shell 属性取值须在“开/关/暂停/等待激活”四种状态的真机上标定（Y5 P1-6），
 * 标定前只认最常见的取值，其余报“未知”。
 */
import { execFile } from "node:child_process";
import { join } from "node:path";

export type Tri = "yes" | "no" | "unknown" | "not_applicable";
export type BitLockerState = "on" | "off" | "suspended" | "pending" | "in_progress" | "unknown" | "not_applicable";

export interface EnvProbeResult {
  platform: string;
  bitlocker: BitLockerState;
  roaming_profile: Tri;
  folder_redirection: Tri;
  fslogix: Tri;
  onedrive_kfm: Tri;
  local_dumps: Tri;
  firewall_rules: Tri;
  antivirus: string[];
  checked_at: string;
}

export type ProbeRunner = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

/** 固定脚本：只读注册表、Shell 属性、安全中心与防火墙规则组；任何一步失败都静默跳过。 */
export const PROBE_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$o=@{}",
  "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$p=Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$sid)",
  "$o.central=[string]$p.CentralProfile",
  "$sf=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'",
  "$o.appdata=[string]$sf.AppData; $o.localappdata=[string]$sf.'Local AppData'; $o.personal=[string]$sf.Personal; $o.desktop=[string]$sf.Desktop",
  "$fx=Get-ItemProperty 'HKLM:\\SOFTWARE\\FSLogix\\Profiles'; $o.fslogix=[string]$fx.Enabled",
  "$o.localdumps=[bool](Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps')",
  "$drive=Split-Path -Qualifier $env:LOCALAPPDATA",
  "$o.bitlocker=(New-Object -ComObject Shell.Application).NameSpace($drive).Self.ExtendedProperty('System.Volume.BitLockerProtection')",
  "$o.av=@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object { [string]$_.displayName })",
  "$o.fw=@(Get-NetFirewallRule -Group 'KimiWorkLegal').Count",
  "$o | ConvertTo-Json -Compress",
].join("; ");

const defaultRunner: ProbeRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", LOCALAPPDATA: process.env.LOCALAPPDATA ?? "", USERPROFILE: process.env.USERPROFILE ?? "" } }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout ?? "") });
    });
  });

const isUnc = (v: unknown) => typeof v === "string" && /^\\\\/.test(v.trim());

/** BitLocker Shell 属性取值 → 状态（常见取值；其余未知，待真机标定）。 */
export function bitlockerOf(v: unknown): BitLockerState {
  if (v === null || v === undefined || v === "") return "unknown";
  const n = Number(v);
  if (n === 1 || n === 6) return "on";
  if (n === 2) return "off";
  if (n === 5) return "suspended";
  if (n === 8) return "pending";
  if (n === 3 || n === 4) return "in_progress";
  return "unknown";
}

/** 解析固定脚本的输出（纯函数，可单测）。 */
export function interpretProbe(stdout: string, now = new Date()): EnvProbeResult {
  const base: EnvProbeResult = { platform: "win32", bitlocker: "unknown", roaming_profile: "unknown", folder_redirection: "unknown", fslogix: "unknown", onedrive_kfm: "unknown", local_dumps: "unknown", firewall_rules: "unknown", antivirus: [], checked_at: now.toISOString() };
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    return base;
  }
  if (!o || typeof o !== "object") return base;
  const folders = [o.appdata, o.localappdata, o.personal, o.desktop].filter((x) => typeof x === "string" && x.trim()) as string[];
  const av = (Array.isArray(o.av) ? o.av : typeof o.av === "string" ? [o.av] : [])
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60))
    .slice(0, 5);
  return {
    ...base,
    bitlocker: bitlockerOf(o.bitlocker),
    roaming_profile: typeof o.central === "string" ? (o.central.trim() ? "yes" : "no") : "unknown",
    folder_redirection: folders.length ? (folders.some(isUnc) ? "yes" : "no") : "unknown",
    fslogix: typeof o.fslogix === "string" ? (o.fslogix.trim() === "1" ? "yes" : "no") : "unknown",
    onedrive_kfm: o.personal !== undefined || o.desktop !== undefined ? ([o.personal, o.desktop].some((x) => typeof x === "string" && /onedrive/i.test(x)) ? "yes" : "no") : "unknown",
    local_dumps: typeof o.localdumps === "boolean" ? (o.localdumps ? "yes" : "no") : "unknown",
    firewall_rules: typeof o.fw === "number" ? (o.fw > 0 ? "yes" : "no") : "unknown",
    antivirus: av,
  };
}

/** 运行自检（Windows 之外如实返回“不适用”）。 */
export async function probeEnvironment(o: { platform?: string; runner?: ProbeRunner; systemRoot?: string; now?: Date } = {}): Promise<EnvProbeResult> {
  const platform = o.platform ?? process.platform;
  const now = o.now ?? new Date();
  if (platform !== "win32") {
    return { platform, bitlocker: "not_applicable", roaming_profile: "not_applicable", folder_redirection: "not_applicable", fslogix: "not_applicable", onedrive_kfm: "not_applicable", local_dumps: "not_applicable", firewall_rules: "not_applicable", antivirus: [], checked_at: now.toISOString() };
  }
  const ps = join(o.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const r = await (o.runner ?? defaultRunner)(ps, ["-NoProfile", "-NonInteractive", "-Command", PROBE_SCRIPT], 20_000);
  return r.code === 0 ? interpretProbe(r.stdout, now) : interpretProbe("", now);
}
