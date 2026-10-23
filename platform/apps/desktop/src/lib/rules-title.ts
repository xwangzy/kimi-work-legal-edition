/**
 * 审定 AI 起草的审查要点时，名称去掉“草稿”字样（v9.4 第 25 批走查：方法让模型写“××标准（草稿）”，模型也会写成“（买方，草稿）”“(草稿)”，
 * 原来只去掉结尾的“（草稿）”，启用后的在用版本仍叫“……（买方，草稿）”）。括注里还有别的内容的保留（“（买方）”）。
 */
export function stripDraftMark(title: string): string {
  const t = title.trim();
  const sep = "[，,、；;\\s]+";
  return t
    .replace(/\s*[（(]\s*草稿\s*[）)]\s*$/, "")
    .replace(new RegExp(`[（(]\\s*([^（）()]+?)${sep}草稿\\s*[）)]\\s*$`), "（$1）")
    .replace(new RegExp(`[（(]\\s*草稿${sep}([^（）()]+?)\\s*[）)]\\s*$`), "（$1）")
    .replace(/\s*[【[]\s*草稿\s*[】\]]\s*$/, "")
    .replace(/[\s·—\-－]+草稿$/, "")
    .trim();
}
