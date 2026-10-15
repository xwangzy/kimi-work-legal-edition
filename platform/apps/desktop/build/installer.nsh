; Kimi Work 法律版安装脚本补充（electron-builder nsis.include；v9.2 §3.7、调研 Y5 P1-5 / F4 / W8）
; 随包 Node 以独立文件名运行闸门（kwl-egress.exe）、Agent 宿主（kwl-host.exe）与解析进程（kwl-parse.exe）。
; 这些进程不在 Electron Crashpad 覆盖内，原生崩溃由 Windows 错误报告（WER）处理——其内存是令牌化后的案件文字与密钥材料，
; 按当前用户把三个文件名登记为 WER 排除项（不生成报告、不上传）；卸载时移除。只写当前用户的注册表，不需要管理员权限。
; 律所 IT 若配置了全机 LocalDumps，须另行排除（设备页环境自检会提示）。

!macro customInstall
  WriteRegDWORD HKCU "Software\Microsoft\Windows\Windows Error Reporting\ExcludedApplications" "kwl-egress.exe" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\Windows Error Reporting\ExcludedApplications" "kwl-host.exe" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\Windows Error Reporting\ExcludedApplications" "kwl-parse.exe" 1
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\Windows Error Reporting\ExcludedApplications" "kwl-egress.exe"
  DeleteRegValue HKCU "Software\Microsoft\Windows\Windows Error Reporting\ExcludedApplications" "kwl-host.exe"
  DeleteRegValue HKCU "Software\Microsoft\Windows\Windows Error Reporting\ExcludedApplications" "kwl-parse.exe"
!macroend
