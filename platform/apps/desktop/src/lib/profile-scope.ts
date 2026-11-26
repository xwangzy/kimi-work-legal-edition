/**
 * 本机偏好按账号分开（第 68 批，V42，D-294）：同一台电脑上的几个账号共用同一个界面存储（localStorage），
 * 与账号有关的记忆（上次打开的事项、收起的额度提示、备份提醒的“稍后”、问答选的模型、业务线）按当前账号档案分键，
 * 换账号后不会把上一个账号的事项编号、选择带过来。主题、缩放、侧栏收起这类纯界面偏好仍全机共用。
 * 档案标识是内核给的摘要（kernel.status profile.id，16 位十六进制），不含可读身份。
 */
let scope = "";

/** 启动取到 kernel.status 后设置（待激活时为空）。 */
export function setProfileScope(id: string | null | undefined): void {
  scope = typeof id === "string" && /^[0-9a-f]{16}$/.test(id) ? id : "";
}

/** 与账号有关的本机偏好键：有档案时带上档案标识。纯函数（依赖当前档案）。 */
export function scopedKey(key: string): string {
  return scope ? `${key}@${scope}` : key;
}
