/**
 * 第 72 批（D-300 第 3 条）：Windows 随包中文字体、品牌字标随包字体、按平台字体栈、字重令牌门禁。
 *
 * src/assets/fonts/noto-sans-sc.css 由本用例从 @fontsource/noto-sans-sc 5.3.1 的 400/500/600.css 生成（只留 woff2、加纵向度量覆盖）：
 *   KWL_REGEN_FONT_CSS=1 node --test apps/desktop/test/b72-fonts.test.ts
 * 平时本用例只核对：生成结果与已安装的包逐条一致（包升级、切片变化时会失败，提示重新生成）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = join(root, "../../node_modules/@fontsource/noto-sans-sc");
const out = join(root, "src/assets/fonts/noto-sans-sc.css");
const src = (p: string) => readFileSync(join(root, p), "utf8");

/** 苹方的纵向度量（1000 单位：上 1060、下 340、行距 0）：中文在固定高度的胶囊、按钮里与 macOS 同高，不偏下。 */
const METRICS = "  ascent-override: 106%;\n  descent-override: 34%;\n  line-gap-override: 0%;\n";

/**
 * 第 72 批第二轮（设计评分跨页第 4/5 条）：分隔点“·”（U+00B7）与省略号“…”（U+2026）不由 Noto Sans SC 画——
 * 中文字体把它们画成全角粗圆点“ • ”和居中“⋯”，与 macOS 不同；从切片里剔掉，Windows 落到 Segoe UI（西文写法，与苹方同形）。
 */
const EXCLUDE = [0xb7, 0x2026];
function excludeFromRange(range: string): string {
  const out: string[] = [];
  for (const tok of range.split(",")) {
    const m = /^U\+([0-9a-f]+)(?:-([0-9a-f]+))?$/i.exec(tok.trim());
    if (!m) {
      out.push(tok);
      continue;
    }
    let lo = parseInt(m[1]!, 16);
    const hi = m[2] ? parseInt(m[2], 16) : lo;
    const hex = (n: number) => n.toString(16);
    for (const x of EXCLUDE.filter((c) => c >= lo && c <= hi).sort((a, b) => a - b)) {
      if (x > lo) out.push(x - 1 > lo ? `U+${hex(lo)}-${hex(x - 1)}` : `U+${hex(lo)}`);
      lo = x + 1;
    }
    if (lo <= hi) out.push(hi > lo ? `U+${hex(lo)}-${hex(hi)}` : `U+${hex(lo)}`);
  }
  return out.join(",");
}

function generate(): string {
  const head = `/*
 * Noto Sans SC（思源黑体）400 / 500 / 600，SIL Open Font License 1.1（许可原文见同目录 NotoSansSC-OFL.txt）。
 * 由 test/b72-fonts.test.ts 从 @fontsource/noto-sans-sc 5.3.1 生成，勿手改：只留 woff2（不带 woff 回退，Electron 内核都支持 woff2）、
 * 加纵向度量覆盖（对齐苹方，中文在胶囊与按钮里不偏下）；分隔点“·”与省略号“…”不由它画（与 macOS 同形）。按字符区间切片，界面用到哪些字才加载哪些片。
 * 只有 Windows 的字体栈引用它（tokens.css 的 html.plat-win32），macOS 与网页开发形态不下载。
 */
`;
  const blocks: string[] = [];
  for (const w of [400, 500, 600]) {
    const css = readFileSync(join(pkg, `${w}.css`), "utf8");
    for (const m of css.matchAll(/@font-face \{([^}]*)\}/g)) {
      const body = m[1]!;
      const file = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(body)?.[1];
      const raw = /unicode-range: ([^;]+);/.exec(body)?.[1];
      const range = raw ? excludeFromRange(raw) : raw;
      if (!file || !range) throw new Error(`切片缺字段：${body.slice(0, 80)}`);
      blocks.push(`@font-face {\n  font-family: "Noto Sans SC";\n  font-style: normal;\n  font-display: swap;\n  font-weight: ${w};\n  src: url("@fontsource/noto-sans-sc/files/${file}") format("woff2");\n${METRICS}  unicode-range: ${range};\n}\n`);
    }
  }
  return head + blocks.join("");
}

test("随包中文字体：@fontsource/noto-sans-sc 5.3.1（OFL-1.1）已声明依赖与锁文件；生成的 noto-sans-sc.css 与包逐条一致", { skip: !existsSync(pkg) && "未安装 @fontsource/noto-sans-sc" }, () => {
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  assert.equal(manifest.version, "5.3.1");
  assert.equal(JSON.parse(src("package.json")).dependencies["@fontsource/noto-sans-sc"], "5.3.1");
  const lock = JSON.parse(readFileSync(join(root, "../../package-lock.json"), "utf8"));
  const entry = lock.packages["node_modules/@fontsource/noto-sans-sc"];
  assert.equal(entry.version, "5.3.1");
  assert.equal(entry.license, "OFL-1.1");
  assert.match(entry.integrity, /^sha512-/);
  assert.equal(lock.packages["apps/desktop"].dependencies["@fontsource/noto-sans-sc"], "5.3.1");
  const css = generate();
  if (process.env.KWL_REGEN_FONT_CSS === "1") writeFileSync(out, css);
  assert.equal(readFileSync(out, "utf8"), css, "包内容变了：用 KWL_REGEN_FONT_CSS=1 重新生成");
  // 三个字重都在、都只引 woff2、都带度量覆盖
  for (const w of [400, 500, 600]) assert.ok((css.match(new RegExp(`font-weight: ${w};`, "g")) ?? []).length > 90, `${w} 切片`);
  assert.doesNotMatch(css, /\.woff\)/);
  // 分隔点与省略号剔出了切片
  assert.equal(excludeFromRange("U+0-ff,U+2000-206f"), "U+0-b6,U+b8-ff,U+2000-2025,U+2027-206f");
  assert.equal(excludeFromRange("U+b7,U+2026"), "");
  assert.equal((css.match(/ascent-override: 106%;/g) ?? []).length, (css.match(/@font-face/g) ?? []).length);
});

test("字体只在 Windows 引用：macOS 栈是系统 SF + 苹方；Windows 栈 Segoe UI Variable Text → Segoe UI → Noto Sans SC → 雅黑 UI", () => {
  const tokens = readFileSync(join(root, "../../packages/design-tokens/src/tokens.css"), "utf8");
  assert.match(tokens, /html\.plat-darwin \{ --font-sans: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; \}/);
  assert.match(tokens, /html\.plat-win32 \{ --font-sans: "Segoe UI Variable Text", "Segoe UI", "Noto Sans SC", "Microsoft YaHei UI", sans-serif; \}/);
  const darwin = /html\.plat-darwin \{([^}]*)\}/.exec(tokens)![1]!;
  assert.doesNotMatch(darwin, /Noto/, "Mac 不引用随包字体（不下载）");
  // 字体样式表由入口引入；许可原文随源码
  assert.match(src("src/main.tsx"), /import "\.\/assets\/fonts\/fonts\.css";/);
  assert.match(src("src/assets/fonts/fonts.css"), /@import "\.\/noto-sans-sc\.css";/);
  assert.match(src("src/assets/fonts/NotoSansSC-OFL.txt"), /SIL Open Font License/);
  assert.match(src("src/assets/fonts/Inter-OFL.txt"), /SIL Open Font License/);
});

test("品牌字标不依赖系统字体：随包 Inter 800 拉丁子集，SVG 文字不再用 textLength 挤压", () => {
  const fonts = src("src/assets/fonts/fonts.css");
  assert.match(fonts, /font-family: "KWL Brand";[\s\S]*font-weight: 800;[\s\S]*src: url\("\.\/inter-latin-800-normal\.woff2"\) format\("woff2"\);/);
  assert.ok(existsSync(join(root, "src/assets/fonts/inter-latin-800-normal.woff2")));
  for (const f of ["src/components/Brand.tsx", "src/pages/Home.tsx"]) {
    const s = src(f);
    assert.doesNotMatch(s, /textLength=/, `${f} 不再挤压字距`);
    assert.doesNotMatch(s, /fontWeight="800"/, `${f} 字标字重由 .brand-wordmark-text 给`);
  }
  assert.match(src("src/styles.css"), /\.brand-wordmark-text \{[^}]*font-family: "KWL Brand", var\(--font-sans\);/);
});

test("字重只用令牌：组件样式不写字面 font-weight（@font-face 声明除外）；令牌只有 400 / 500 / 600 三档", () => {
  const tokens = readFileSync(join(root, "../../packages/design-tokens/src/tokens.css"), "utf8");
  assert.match(tokens, /--fw-regular: 400;\s*--fw-medium: 500;\s*--fw-strong: 600;/);
});
