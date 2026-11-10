/**
 * 最终答复里的本机路径清理（V16 第 41 批）：助手的最终答复里出现过
 * “[管辖与时效核查表.xlsx](sandbox:/private/tmp/…/outputs/管辖与时效核查表.xlsx)”这样的链接——律师点不开，还露出本机目录。
 * 登记最终答复前做一次确定性的替换：指向本机的链接与路径一律换成文件名本身（“《文件名》（见本任务的成果）”），
 * Markdown 链接保留显示文字。网址（https:// 等）不动。纯函数。
 */

const SEE = "（见本任务的成果）";

/** 路径里不会出现、到此为止的字符：空白、括号、引号、中文标点、反引号。 */
const STOP = "\\s)\\]>」』”\"'`，。；、）！？";

/** 指向本机的地址：sandbox:、file:、类 Unix 的完整路径（/private/、/Users/、/tmp/ 等）、Windows 盘符路径。 */
const LOCAL_TARGET = /^(?:sandbox:|file:|\/(?:private|Users|tmp|var|home|mnt|Volumes|opt|root|data)\/|~\/|[A-Za-z]:[\\/])/i;

/** 正文里直接出现的本机路径（前面不能紧挨字母、数字或斜杠，避免把网址里的一段当成本机路径）。 */
const BARE_PATH = new RegExp(
  `(?<![A-Za-z0-9_.\\/\\\\-])(?:sandbox:[^${STOP}]+|file:[^${STOP}]+|(?:\\/(?:private|Users|tmp|var|home|mnt|Volumes|opt|root)\\/|~\\/|[A-Za-z]:[\\\\/])[^${STOP}]+)`,
  "gi",
);

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 路径的文件名（最后一段）；没有扩展名的（目录）返回空串。 */
function baseName(path: string): string {
  const p = decode(path.replace(/^(?:sandbox:|file:)\/*/i, "/")).replace(/[\\/]+$/, "");
  const last = p.split(/[\\/]/).at(-1) ?? "";
  return /\.[A-Za-z0-9]{1,6}$/.test(last) ? last : "";
}

const named = (name: string) => (name ? `《${name}》${SEE}` : "本任务的成果");

export function isLocalTarget(target: string): boolean {
  return LOCAL_TARGET.test(target.trim());
}

/** 把最终答复里指向本机的链接与路径换成文件名。没有本机路径时原样返回。 */
export function scrubLocalPaths(text: string): string {
  if (!/sandbox:|file:|\/(?:private|Users|tmp|var|home|mnt|Volumes|opt|root)\/|~\/|[A-Za-z]:[\\/]/i.test(text)) return text;
  // ① Markdown 链接与图片：[显示文字](本机地址) → 保留显示文字
  let out = text.replace(/!?\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g, (whole, label: string, angled?: string, plain?: string) => {
    const target = (angled ?? plain ?? "").trim();
    if (!isLocalTarget(target)) return whole;
    const shown = label.replace(/^[《\s]+|[》\s]+$/g, "").replace(/^`|`$/g, "");
    const file = baseName(target);
    if (!shown) return named(file);
    // 显示文字本身就是文件名（或与文件名同名）：写成《文件名》；否则保留显示文字，后面补上文件名
    if (/\.[A-Za-z0-9]{1,6}$/.test(shown) || !file || shown === file.replace(/\.[^.]+$/, "")) return named(shown);
    return `${shown}（《${file}》，见本任务的成果）`;
  });
  // ② 正文里直接写出的本机路径
  out = out.replace(BARE_PATH, (m) => named(baseName(m)));
  // 路径写在反引号里的：去掉空出来的反引号包裹
  return out.replace(/`(《[^`\n]*》（见本任务的成果）|本任务的成果)`/g, "$1");
}
