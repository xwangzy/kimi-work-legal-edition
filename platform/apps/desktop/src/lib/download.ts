/**
 * 下载按钮说清下载的是什么（D-2），以及 Markdown 成果下载成 Word（v9.3 第 15 批 B-4：Agent 写的备忘录、意见书多是 Markdown，
 * 律师要的是能直接打印的 Word——内核按本机“文书版式”套函头、字体与页码）。纯函数。
 */
export function downloadPlan(filename: string): { label: string; as: "docx" | null; saveName: string } {
  if (/\.(md|markdown)$/i.test(filename)) return { label: "下载 Word", as: "docx", saveName: filename.replace(/\.(md|markdown)$/i, ".docx") };
  if (/\.docx$/i.test(filename)) return { label: "下载 Word", as: null, saveName: filename };
  if (/\.xlsx$/i.test(filename)) return { label: "下载 Excel", as: null, saveName: filename };
  if (/\.pdf$/i.test(filename)) return { label: "下载 PDF", as: null, saveName: filename };
  return { label: "下载", as: null, saveName: filename };
}
