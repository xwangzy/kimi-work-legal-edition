/**
 * 把采集到的真实界面 DOM 快照（snaps-src/*.json，由 scripts/capture/shoot-film.mjs 生成）转成片子可用的模块 src/snaps/*.ts。
 * 处理：去掉脚本；把 srcdoc 隔离框架（文书预览）展开成普通 div，并把其内部样式加上作用域前缀（避免每帧重载 iframe）。
 * 用法：node scripts/snap-import.mjs
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
const SRC = fileURLToPath(new URL("../snaps-src/", import.meta.url));
const OUT = fileURLToPath(new URL("../src/snaps/", import.meta.url));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const prefix = (css, scope) =>
  css.replace(/([^{}]+)\{/g, (_, sel) => sel.split(",").map((s) => { s = s.trim(); return s === "body" || s === "html" ? scope : `${scope} ${s}`; }).join(", ") + "{");
let n = 0;
const names = [];
for (const f of readdirSync(SRC).filter((x) => x.endsWith(".json")).sort()) {
  const d = JSON.parse(readFileSync(SRC + f, "utf8"));
  let html = d.html.replace(/<script[\s\S]*?<\/script>/g, "");
  html = html.replace(/<iframe([^>]*?)srcdoc="([^"]*)"([^>]*)><\/iframe>/g, (_, a, src, b) => {
    const doc = unesc(src);
    const cls = `kw-frame-${++n}`;
    const css = [...doc.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => prefix(m[1], `.${cls}`)).join("\n");
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(doc)?.[1] ?? "";
    const klass = /class="([^"]*)"/.exec(a + b)?.[1] ?? "";
    return `<div class="${klass} kw-frame ${cls}"><style>${css}</style>${body}</div>`;
  });
  const name = f.replace(/\.json$/, "");
  const id = "s_" + name.replace(/[^a-zA-Z0-9]/g, (c) => (c.charCodeAt(0) > 127 ? c.charCodeAt(0).toString(16) : "_"));
  names.push([name, id]);
  writeFileSync(`${OUT}${id}.ts`, `// 由 scripts/snap-import.mjs 自 snaps-src/${f} 生成，勿手改\nexport default ${JSON.stringify({ name, theme: d.theme === "dark" ? "dark" : "light", html })};\n`);
}
writeFileSync(`${OUT}index.ts`, `// 由 scripts/snap-import.mjs 生成，勿手改\n${names.map(([, id]) => `import ${id} from "./${id}";`).join("\n")}\n\nexport const SNAPS = {\n${names.map(([name, id]) => `  ${JSON.stringify(name)}: ${id},`).join("\n")}\n} as const;\nexport type SnapName = keyof typeof SNAPS;\n`);
console.log(`${names.length} snaps, ${n} frames inlined`);
