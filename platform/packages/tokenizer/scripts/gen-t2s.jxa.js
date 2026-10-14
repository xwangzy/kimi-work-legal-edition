// 生成繁体→简体单字对照（审查 S4-18）：用 macOS 自带的 ICU 转写器 “Hant-Hans”（Unihan 简繁变体数据），逐字转换、不联网。
// 用法：osascript -l JavaScript packages/tokenizer/scripts/gen-t2s.jxa.js > /tmp/t2s.txt （输出：每行 “繁<TAB>简”）
ObjC.import("Foundation");
function run() {
  var ranges = [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]];
  var chars = [];
  for (var r = 0; r < ranges.length; r++) for (var cp = ranges[r][0]; cp <= ranges[r][1]; cp++) chars.push(String.fromCodePoint(cp));
  var joined = chars.join("\n");
  var out = ObjC.unwrap($.NSString.alloc.initWithString(joined).stringByApplyingTransformReverse("Hant-Hans", false));
  var parts = out.split("\n");
  if (parts.length !== chars.length) throw new Error("length mismatch " + parts.length + " vs " + chars.length);
  var lines = [];
  for (var i = 0; i < chars.length; i++) {
    var t = chars[i], s = parts[i];
    if (s !== t && Array.from(s).length === 1) lines.push(t + "\t" + s);
  }
  return lines.join("\n");
}
