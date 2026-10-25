/**
 * 律师层的兜底错误文案（Z3 评审 3.5、#13）：只说一句话加“怎么办”，不出现内核、开发桥、端口等研发用语。纯函数。
 */

/** 首页连不上后台：律师层一句话；开发环境另附开发桥地址，方便研发排查。 */
export function backendDownText(dev: boolean): string {
  const base = "Kimi Work 的后台服务没有响应。请关闭后重新打开；仍不行，请在 设置 → 本机与安全 导出诊断信息交给 IT。";
  return dev ? `${base}（开发：确认开发桥已启动）` : base;
}

/** 调用失败但没有具体说明时的通用兜底。 */
export const GENERIC_FAILURE = "操作没有完成，请重试。";

/**
 * 材料没添加上的原因（第 27 批，评审 U3-04）：内核给的中文原因（如带国家秘密标志被拒）照写；
 * 解析库的英文原文（如“Invalid PDF structure.”）不上屏，按类别换成律师话加“怎么办”。纯函数。
 */
export function importFailText(fileName: string, message: string): string {
  const raw = String(message ?? "").split(fileName).join("").trim();
  // 内核写好的中文原因照写，哪怕里面有 Word、WPS、PDF 这类词（复核 Q8-03：原先按“含 4 个英文字母”判断，把“另存为 .docx”的办法整句换掉了）
  if (raw && /[\u4e00-\u9fff]/.test(raw)) return `${fileName} 没有添加：${raw}`;
  const ext = (/\.([A-Za-z0-9]+)$/.exec(fileName)?.[1] ?? "").toLowerCase();
  if (/password|encrypt/i.test(raw)) return `${fileName} 没有添加：这个文件设了密码。请先去掉密码（另存一份不加密的）再添加。`;
  // PDF 只看扩展名（复核 Q8-03：.msg 等格式的英文报错里也可能出现“PDF”）
  if (ext === "pdf") return `${fileName} 没有添加：这个 PDF 打不开，可能已损坏或设了密码。请用原文件重新导出 PDF 后再添加。`;
  if (/unsupported|not supported|unknown (file|format)/i.test(raw)) return `${fileName} 没有添加：暂不支持这种格式。支持 Word、WPS、PDF、Excel、图片和文本文件。`;
  return `${fileName} 没有添加：没能读出这个文件。请确认它能正常打开后再试；仍不行，请在 设置 → 本机与安全 导出诊断信息交给 IT。`;
}
