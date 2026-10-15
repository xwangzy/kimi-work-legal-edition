/**
 * 交付件按内容命名（UIUX 增量评审 D-2）：Markdown/文本成果取第一个非空行作标题——去掉标题符号、列表与强调符号，至多 40 字。
 * 输入是令牌形态的成果字节（界面还原代号后显示）；不是文本类文件名或读不出时返回 null。
 */
export function isTitledFilename(filename: string): boolean {
  return /\.(md|markdown|txt)$/i.test(filename);
}

/** 按字截断，但不把代号“〔类别·XXXXXX〕”切成半截（复核 S6B-14）：截点落在未闭合的代号里就退到代号之前。 */
export function cutKeepingTokens(s: string, n: number): string {
  const cs = [...s];
  if (cs.length <= n) return s;
  let cut = cs.slice(0, n).join("");
  const open = cut.lastIndexOf("〔");
  if (open > cut.lastIndexOf("〕")) cut = cut.slice(0, open);
  return cut;
}

export function firstLineTitle(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString("utf8");
  for (const raw of head.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*|^[-*+]\s+|[*_\x60>]/g, "").trim();
    if (line.length > 0) return cutKeepingTokens(line, 40);
  }
  return null;
}
