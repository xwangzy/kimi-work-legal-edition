/** 中文数字 → 整数（覆盖法条号范围 1..9999：零一二三四五六七八九十百千）。 */
const DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

export function cnToInt(text: string): number | null {
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  let total = 0;
  let section = 0;
  let hasDigit = false;
  for (const ch of text) {
    const d = DIGITS[ch];
    if (d !== undefined) {
      section = d;
      hasDigit = true;
      continue;
    }
    const u = UNITS[ch];
    if (u !== undefined) {
      total += (section === 0 ? 1 : section) * u;
      section = 0;
      hasDigit = true;
      continue;
    }
    return null;
  }
  if (!hasDigit) return null;
  return total + section;
}

export function intToCn(n: number): string {
  if (n < 0 || n > 9999 || !Number.isInteger(n)) throw new RangeError("out of range");
  if (n === 0) return "零";
  const units = [1000, 100, 10, 1] as const;
  const names = ["千", "百", "十", ""] as const;
  const digitNames = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;
  let out = "";
  let rest = n;
  let pendingZero = false;
  for (let i = 0; i < 4; i++) {
    const u = units[i]!;
    const d = Math.floor(rest / u);
    rest %= u;
    if (d === 0) {
      if (out !== "" && rest > 0) pendingZero = true;
      continue;
    }
    if (pendingZero) {
      out += "零";
      pendingZero = false;
    }
    // 10-19 开头习惯说"十X"而非"一十X"
    if (!(u === 10 && d === 1 && out === "")) out += digitNames[d]!;
    out += names[i]!;
  }
  return out;
}
