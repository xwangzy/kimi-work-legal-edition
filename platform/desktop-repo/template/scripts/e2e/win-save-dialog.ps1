# 安装包真实联调（第 54 批）：常驻处理 Kimi Work 法律版弹出的系统“另存为”对话框。
# 驱动脚本（scripts/e2e/ui.mjs export）点“下载”之前把目标路径写进 <证据目录>\next-save-path.txt；本脚本发现应用的保存对话框后
# 用 Windows UI 自动化把文件名框改成该路径并点“保存”（找不到控件时退回键盘输入）。只处理本应用进程的对话框。
# 用法（Windows PowerShell 5.1，需 UIAutomationClient）：powershell -NoProfile -File win-save-dialog.ps1 -OutDir C:\kwl-e2e\out [-Minutes 240]
param([Parameter(Mandatory = $true)][string]$OutDir, [int]$Minutes = 240)
$ErrorActionPreference = "Continue"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$pathFile = Join-Path $OutDir "next-save-path.txt"
$logFile = Join-Path $OutDir "save-dialog.log"
function Log($m) { $line = "[save-dialog $(Get-Date -Format HH:mm:ss)] $m"; Write-Output $line; Add-Content -Path $logFile -Value $line -Encoding UTF8 }
$deadline = (Get-Date).AddMinutes($Minutes)
$handled = @{}
Log "watching for save dialogs"
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  $pids = @(Get-Process -Name KimiWorkLegal -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($pids.Count -eq 0) { continue }
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, "#32770")
  $dialogs = @()
  try { $dialogs = @($AE::RootElement.FindAll($TS::Descendants, $cond)) } catch { continue }
  foreach ($d in $dialogs) {
    try {
      if ($pids -notcontains $d.Current.ProcessId) { continue }
      $key = "$($d.Current.NativeWindowHandle)"
      if ($handled.ContainsKey($key)) { continue }
      if (-not (Test-Path $pathFile)) { Log "dialog [$($d.Current.Name)] appeared but no pending target path; skipped"; $handled[$key] = 1; continue }
      $target = (Get-Content $pathFile -Raw -Encoding UTF8).Trim()
      Log "handling dialog [$($d.Current.Name)] -> $target"
      $editCond = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
        (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, "1001")))
      $edit = $d.FindFirst($TS::Descendants, $editCond)
      $done = $false
      if ($edit) {
        $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $vp.SetValue($target)
        Start-Sleep -Milliseconds 300
        $btnCond = New-Object System.Windows.Automation.AndCondition(
          (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
          (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, "1")))
        $save = $d.FindFirst($TS::Descendants, $btnCond)
        if ($save) {
          $save.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
          $done = $true
        }
      }
      if (-not $done) {
        Log "file name box or Save button not found; falling back to keystrokes"
        $d.SetFocus()
        Start-Sleep -Milliseconds 300
        [System.Windows.Forms.SendKeys]::SendWait("^a")
        [System.Windows.Forms.SendKeys]::SendWait(($target -replace '([+^%~(){}\[\]])', '{$1}'))
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
      }
      $handled[$key] = 1
      Remove-Item $pathFile -ErrorAction SilentlyContinue
      Log "save submitted"
    } catch {
      Log "failed: $($_.Exception.Message)"
    }
  }
}
Log "watch ended"
