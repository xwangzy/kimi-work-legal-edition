/** 激活页文字（纯函数，供用例直接核对）。 */

/** 打不开的数据移到一边之后的说明（v9.3 主文 §9 第 7 项）：目录名只给 IT 看位置；不含任何案件信息。 */
export function setAsideNotice(dir: string): string {
  return `这台电脑上原来的数据打不开，已移到数据目录下的 ${dir}（没有删除，由所内 IT 决定保留或清理）。请用恢复包从备份恢复；没有备份的，点“返回”用律所管理员给的邀请码重新入组；你是律所唯一的管理员（或律所只有你一人）时，请联系中软客服按开通流程恢复。`;
}

/**
 * 激活页要不要自动打开“从备份恢复”（复核 RB16B-20）：只在刚移走（目录时刻 24 小时以内）、且律师没点过“返回”时——
 * 目录按设计不删除，否则以后每次进入待激活都会被带回恢复页。
 */
export function setAsideAutoOpen(dir: string, now: number, dismissed: string | null): boolean {
  if (dismissed === dir) return false;
  const m = /^\.unreadable-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(dir);
  if (!m) return false;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isFinite(t) && now - t >= 0 && now - t < 24 * 3600_000;
}
