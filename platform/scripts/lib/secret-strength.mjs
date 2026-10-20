/**
 * 云端密钥文件的强度检查（第 13 批复核 A-15；第 14 批第二轮复核 A 余项“服务间凭据只核格式与长度”）。
 * 只看格式与长度时，`000…0`、`0123456789abcdef` 重复四遍、“changeme…”这类手填的值都能通过。这里在格式之外再拒绝明显不是随机生成的值：
 * - 解码后的字节里不同取值少于 16 个（32 字节真随机平均约 30 个，少于 16 个的概率约 1e-10）；
 * - 整串由更短的片段重复而成；有 8 个以上逐个加一或减一的连续字符（abcdefgh、12345678）；
 * - 十六进制里只有数字或只有字母；base64url 里没有大写或没有小写（真随机时概率均低于 1e-9）；
 * - 含 changeme / password / example / secret 等占位词。
 * 判据只用于拒绝明显的手填值，不是熵估计；生成方法写在部署文档里（openssl rand -hex 32）。
 */

const PLACEHOLDERS = ["changeme", "password", "example", "secret", "default", "placeholder"];

/**
 * @param {string} s 文件内容（已去首尾空白）
 * @param {"hex32" | "random32"} kind hex32 = 恰好 32 字节十六进制；random32 = 至少 32 字节随机（64 位以上十六进制或 43 位以上 base64url）
 * @returns {string | null} 不合格的原因（中文短语）；合格为 null
 */
export function weakSecretReason(s, kind) {
  const isHex = kind === "hex32" ? /^[0-9a-f]{64}$/i.test(s) : /^[0-9a-f]{64,}$/i.test(s);
  const isB64 = kind === "random32" && !isHex && /^[A-Za-z0-9_-]{43,}$/.test(s);
  if (!isHex && !isB64) return kind === "hex32" ? "须为 32 字节十六进制（64 位）" : "须为至少 32 字节的随机值（64 位以上十六进制或 43 位以上 base64url）";
  const lower = s.toLowerCase();
  if (PLACEHOLDERS.some((w) => lower.includes(w))) return "含占位词，不是随机生成的值";
  if (/^(.+?)\1+$/.test(s)) return "由同一片段重复而成，不是随机生成的值";
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    const prev = i >= 2 ? s.charCodeAt(i - 1) - s.charCodeAt(i - 2) : 0;
    run = (d === 1 || d === -1) && (run === 1 || d === prev) ? run + 1 : 1;
    if (run >= 8) return "含连续递增或递减的字符，不是随机生成的值";
  }
  if (isHex && (!/[0-9]/.test(s) || !/[a-f]/i.test(s))) return "十六进制里只有数字或只有字母，不是随机生成的值";
  if (isB64 && (!/[A-Z]/.test(s) || !/[a-z]/.test(s))) return "没有同时含大写与小写字母，不是随机生成的值";
  const bytes = isHex ? Buffer.from(s.length % 2 ? s.slice(0, -1) : s, "hex") : Buffer.from(s, "base64url");
  if (new Set(bytes).size < 16) return "字节取值过于集中，不是随机生成的值";
  return null;
}
