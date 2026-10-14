// 由 gen-t2s.jxa.js 的输出生成 src/t2s-data.ts（审查 S4-18）。
// 用法：osascript -l JavaScript packages/tokenizer/scripts/gen-t2s.jxa.js > t2s.txt && node packages/tokenizer/scripts/build-t2s-data.mjs t2s.txt
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const all = readFileSync(process.argv[2], "utf8").split("\n").map((l) => l.split("\t")).filter((r) => r.length === 2 && r[0] && r[1]);
// 阶段 4 终核 S4-25：本身就是现行规范字的字不折叠（乾坤、於姓、著作、慰藉、俱乐部、姊妹、摔跤……），否则不同的词、不同的人会被当成同一当事人。
// 判定 = GB2312 汉字（6,763 个，以 TextDecoder("gbk") 解码 B0A1–F7FE 得到）+ 不在 GB2312 但属《通用规范汉字表》常用义项的字（瞭望、二噁英）
const decoder = new TextDecoder("gbk");
const standard = new Set(["瞭", "噁"]);
for (let hi = 0xb0; hi <= 0xf7; hi++) for (let lo = 0xa1; lo <= 0xfe; lo++) standard.add(decoder.decode(new Uint8Array([hi, lo])));
const excluded = all.filter(([t]) => standard.has(t));
const rows = all.filter(([t]) => !standard.has(t));
rows.sort((a, b) => a[0].codePointAt(0) - b[0].codePointAt(0));
const pairs = rows.map(([t, s]) => t + s).join("");
const lines = [];
for (let i = 0, chunk = []; i <= rows.length; i++) {
  if (i < rows.length) chunk.push(rows[i][0] + rows[i][1]);
  if (chunk.length === 40 || (i === rows.length && chunk.length)) {
    lines.push(`  ${JSON.stringify(chunk.join(""))}`);
    chunk = [];
  }
}
const out = `/**
 * 繁体 → 简体单字对照（生成文件，勿手改；审查 S4-18）。
 *
 * 来源：ICU 转写器 “Hant-Hans”（Unicode Unihan 简繁变体数据，Unicode 许可），由 macOS 系统自带 ICU 逐字转换生成，不联网：
 * \`osascript -l JavaScript packages/tokenizer/scripts/gen-t2s.jxa.js > t2s.txt && node packages/tokenizer/scripts/build-t2s-data.mjs t2s.txt\`。
 * 范围：CJK 统一表意文字基本区、扩展 A 区与兼容表意文字中，转换结果为另一单字的 ${all.length} 对，
 * 去掉本身就是现行规范字的 ${excluded.length} 个（${excluded.map(([t, s]) => t + "→" + s).join("、")}；阶段 4 终核 S4-25），余 ${rows.length} 对。
 * 用途只是名称比对时的折叠（两侧同样折叠），不用于改写任何文本。
 */
export const T2S_PAIRS: string =
${lines.join(" +\n")};
`;
writeFileSync(fileURLToPath(new URL("../src/t2s-data.ts", import.meta.url)), out);
console.log(`t2s-data.ts: ${rows.length} pairs (excluded ${excluded.length} standard chars), ${[...pairs].length} code points`);
