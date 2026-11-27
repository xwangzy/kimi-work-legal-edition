/** 第 72 批（拍板第 23 项）：Work 与 Chat 统一“回车发送、Shift + 回车换行”。纯函数，可单测。 */
/** 回车发送的判定：回车、未按 Shift、不在输入法组字中（isComposing；部分输入法组字时 keyCode 报 229）。 */
export function isSendEnter(e: { key: string; shiftKey: boolean; nativeEvent?: { isComposing?: boolean; keyCode?: number }; keyCode?: number }): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  if (e.nativeEvent?.isComposing) return false;
  if (e.keyCode === 229 || e.nativeEvent?.keyCode === 229) return false;
  return true;
}
