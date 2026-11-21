# 安装包真实联调（第 54 批）：常驻处理 Kimi Work 法律版弹出的系统“另存为”对话框。
# 驱动脚本（scripts/e2e/ui.mjs export）点“下载”之前把目标路径写进 <证据目录>\next-save-path.txt；本脚本发现应用进程的“另存为”
# 对话框（窗口类 #32770）后，用 Win32 消息把文件名框（Edit，控件号 1001）改成该路径（WM_SETTEXT）并按“保存”（按钮控件号 1，BM_CLICK；
# 找不到按钮时给对话框发 WM_COMMAND IDOK）。不用 UI 自动化、不需要前台焦点——第 54 批 Windows 运行器实测：UI 自动化找不到
# 文件名框，SetFocus 报“Target element cannot receive focus”。只处理本应用进程的对话框；同一对话框最多试 5 次。
# 用法（Windows PowerShell 5.1）：powershell -NoProfile -File win-save-dialog.ps1 -OutDir C:\kwl-e2e\out [-Minutes 240]
param([Parameter(Mandatory = $true)][string]$OutDir, [int]$Minutes = 240)
$ErrorActionPreference = "Continue"
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class KwlWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static List<IntPtr> Dialogs(int[] pids) {
    var set = new HashSet<uint>(); foreach (var p in pids) set.Add((uint)p);
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (set.Contains(p) && IsWindowVisible(h) && Cls(h) == "#32770") r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
  public static IntPtr Child(IntPtr d, string cls, int id) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(d, (h, l) => { if (Cls(h) == cls && GetDlgCtrlID(h) == id) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string Fill(IntPtr d, string path) {
    const uint WM_SETTEXT = 0x000C, BM_CLICK = 0x00F5, WM_COMMAND = 0x0111;
    var edit = Child(d, "Edit", 1001);
    if (edit == IntPtr.Zero) return "no-edit";
    SendMessage(edit, WM_SETTEXT, IntPtr.Zero, path);
    var btn = Child(d, "Button", 1);
    if (btn != IntPtr.Zero) { SendMessage(btn, BM_CLICK, IntPtr.Zero, IntPtr.Zero); return "clicked"; }
    PostMessage(d, WM_COMMAND, (IntPtr)1, IntPtr.Zero);
    return "idok";
  }
}
"@
$pathFile = Join-Path $OutDir "next-save-path.txt"
$logFile = Join-Path $OutDir "save-dialog.log"
function Log($m) { $line = "[save-dialog $(Get-Date -Format HH:mm:ss)] $m"; Write-Output $line; Add-Content -Path $logFile -Value $line -Encoding UTF8 }
$deadline = (Get-Date).AddMinutes($Minutes)
$tries = @{}
Log "watching for save dialogs (win32)"
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  $pids = @(Get-Process -Name KimiWorkLegal -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($pids.Count -eq 0) { continue }
  foreach ($d in [KwlWin]::Dialogs([int[]]$pids)) {
    $key = "$d"
    $n = [int]$tries[$key]
    if ($n -ge 5) { continue }
    $tries[$key] = $n + 1
    if (-not (Test-Path $pathFile)) { Log "dialog [$([KwlWin]::Text($d))] appeared but no pending target path; skipped"; $tries[$key] = 5; continue }
    $target = (Get-Content $pathFile -Raw -Encoding UTF8).Trim()
    try {
      $r = [KwlWin]::Fill($d, $target)
      Log "dialog [$([KwlWin]::Text($d))] try $($n + 1): $r -> $target"
      if ($r -ne "no-edit") { $tries[$key] = 5; Remove-Item $pathFile -ErrorAction SilentlyContinue }
    } catch {
      Log "failed: $($_.Exception.Message)"
    }
  }
}
Log "watch ended"
