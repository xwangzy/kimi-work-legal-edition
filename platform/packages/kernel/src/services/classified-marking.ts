/**
 * 国家秘密标志检测（v9 第 02 篇 §8.1 L4“涉密：检测到密级标志即拒绝导入，线下处理”；隐私安全审查 P0-6 / 审计 S6）。
 *
 * 国家秘密标志的通行写法是“密级★保密期限”（如“绝密★启用前”“机密★1年”“秘密★6个月”“秘密★长期”），出现在首页左上角、
 * 页眉页脚或文件名中。检测原则——**宁可多拦、不可漏放，但不误伤日常法律文本**：
 *
 * - 命中（拒绝导入）：“绝密/机密/秘密”紧跟星形符号（★☆✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺）；或紧跟保密期限（启用前、长期、N年、N个月）且位于行首；
 *   ASCII 星号“*”（OCR 常把★识别成它）只在密级词前不是汉字、且星号后不是另一个星号时算（复核 B3-A06：Markdown 粗体“**商业秘密**”、
 *   脚注“商业秘密*”不误拦）；允许字间与符号前后的空白（排版加空格、分散对齐、竖排逐字换行、OCR 断行）；
 *   检测前做 NFKC 规范化并剔除不可见格式字符（零宽空格、软连字符、BOM 等；复核 B3-A07）；
 * - 不命中：“商业秘密”“机密信息”“保密协议”“国家秘密的范围”等不带星形符号与期限的普通用语；
 * - “内部★”“工作秘密”“内部资料”：不属于国家秘密，导入照常，但提示律师确认可以使用 AI 处理（不拦截）。
 *
 * 只检测文字层：扫描件在本机 OCR 未就绪时无文字可查，如实列为残余（设备页与导入结果说明）。
 * 审计只记“命中类别 + 文件 hash”，不记命中的上下文原文。
 */

export type ClassifiedLevel = "绝密" | "机密" | "秘密";

export interface ClassifiedFinding {
  kind: "state_secret" | "internal";
  /** state_secret：密级；internal：标志原文类别（内部/工作秘密）。 */
  level: ClassifiedLevel | "内部" | "工作秘密";
  /** 命中所在：文件名 / 正文 / 页眉页脚。 */
  where: "filename" | "text" | "header_footer";
}

/** 专用星形符号（不含 ASCII 星号）。 */
const STAR_SPECIAL = "[★☆✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺]";
/** 字间允许的空白（含全角空格、竖排换行、制表与分散对齐的多个空格）。不可见格式字符在规范化时已剔除。 */
const GAP = "[\\s\\u3000]{0,6}";
const spaced = (word: string) => [...word].join(GAP);
const LEVELS: readonly ClassifiedLevel[] = ["绝密", "机密", "秘密"];
const PERIOD = `(?:启用前|长期|[0-9０-９一二三四五六七八九十]{1,3}${GAP}(?:年|个${GAP}月))`;

/** NFKC（全角折半角、兼容字形归一；全角星号 ＊ → *）并剔除不可见格式字符（\p{Cf}：零宽空格、软连字符、BOM、方向控制等）。 */
function normalize(s: string): string {
  return s.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

/** 密级词 + 星形符号：专用星形符号直接算；ASCII 星号要求密级词前不是汉字、星号后不是另一个星号（排除 Markdown 粗体与脚注）。 */
function starPattern(word: string, flags = ""): RegExp {
  return new RegExp(`(?:${spaced(word)}${GAP}${STAR_SPECIAL}|(?<![\\u3400-\\u9fff*])${spaced(word)}${GAP}\\*(?!\\*))`, flags);
}

function scanOne(text: string, where: ClassifiedFinding["where"]): ClassifiedFinding[] {
  const t = normalize(text);
  const out: ClassifiedFinding[] = [];
  for (const level of LEVELS) {
    if (starPattern(level).test(t)) {
      out.push({ kind: "state_secret", level, where });
      continue;
    }
    // 无星形符号（OCR 丢失）但带保密期限：只认行首（文件名整体视为一行）——“商业秘密三年”之类行中用语因此不命中
    if (new RegExp(`(?:^|\\n)[\\s\\u3000]*${spaced(level)}${GAP}${PERIOD}`).test(t)) out.push({ kind: "state_secret", level, where });
  }
  if (out.length === 0) {
    if (starPattern("内部").test(t)) out.push({ kind: "internal", level: "内部", where });
    else if (new RegExp(`(?:^|\\n)[\\s\\u3000]*${spaced("工作秘密")}`).test(t)) out.push({ kind: "internal", level: "工作秘密", where });
  }
  return out;
}

/**
 * 检测文件名、正文与页眉页脚中的密级标志。正文只查前 20,000 字与末 5,000 字（标志在首页与末页；长文书全文扫描无必要）——
 * 但星形符号写法在全文任何位置命中都算（附件首页可能在中间），全文查一次星形写法。
 */
export function detectClassifiedMarking(input: { filename: string; text: string; headerFooter?: readonly string[] }): ClassifiedFinding[] {
  const findings: ClassifiedFinding[] = [];
  findings.push(...scanOne(input.filename.replace(/\.[A-Za-z0-9]{1,6}$/, ""), "filename"));
  const text = input.text ?? "";
  const ends = text.length > 25_000 ? `${text.slice(0, 20_000)}\n${text.slice(-5_000)}` : text;
  const body = scanOne(ends, "text");
  if (!body.some((f) => f.kind === "state_secret") && text.length > 25_000) {
    // 全文只补查星形写法
    const all = normalize(text);
    for (const level of LEVELS) {
      if (starPattern(level).test(all)) {
        body.push({ kind: "state_secret", level, where: "text" });
        break;
      }
    }
  }
  findings.push(...body);
  for (const hf of input.headerFooter ?? []) findings.push(...scanOne(hf, "header_footer"));
  // 有国家秘密命中时不再报“内部”提示
  return findings.some((f) => f.kind === "state_secret") ? findings.filter((f) => f.kind === "state_secret") : findings.slice(0, 1);
}
