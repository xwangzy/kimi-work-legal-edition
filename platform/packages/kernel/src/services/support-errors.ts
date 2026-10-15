/**
 * 诊断包上传失败时给律师看的话（第 9 批复核 S9B-11）：工程代码只进审计与本机上传记录，不出现在提示里。
 */
export function supportErrorText(code: string, status: "failed" | "unknown"): string {
  if (status === "unknown") return "上传结果不明（网络中断或超时）：中软可能已经收到。请不要重复上传，把这台电脑的上传记录告诉支持人员核对。";
  if (code === "too_many_tickets") return "这台电脑今天的上传次数已达上限：请明天再试，或导出文件后按所内要求发送。";
  if (code === "support_upload_disabled") return "中软支持服务按律所设置拒绝了上传（律所可能刚刚关闭了这一项）：可导出文件后按所内要求发送。";
  if (code.startsWith("credential:") || code.startsWith("seat_") || code === "upload_token_expired" || code === "upload_token_invalid") return "登录状态暂时无法确认：请稍后再试。";
  if (code === "support_body_too_large" || code === "package_too_large") return "诊断包超过 2 MB，无法上传：请导出文件后按所内要求发送。";
  if (code.includes("tls") || code.includes("pin")) return "与中软支持服务的安全连接校验失败，未上传：请联系所内 IT。";
  if (code === "support_not_configured") return "这台电脑没有配置中软支持服务：可导出文件后按所内要求发送。";
  return "上传没有成功，诊断包没有送出：可以稍后重试，或导出文件后按所内要求发送。";
}
