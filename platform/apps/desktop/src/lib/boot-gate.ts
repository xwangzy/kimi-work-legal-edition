/**
 * 激活门禁取内核状态的重试节奏（复核 B13-K01）：取不到不当作“已激活”，按 1、2、4、8、8… 秒退避；
 * 第 20 次仍失败返回 null（界面给出说明与“重试”）。纯函数。
 */
export const BOOT_MAX_ATTEMPTS = 20;

export function bootRetryDelay(failedAttempts: number): number | null {
  if (failedAttempts >= BOOT_MAX_ATTEMPTS) return null;
  return Math.min(8_000, 500 * 2 ** Math.min(failedAttempts, 4));
}
