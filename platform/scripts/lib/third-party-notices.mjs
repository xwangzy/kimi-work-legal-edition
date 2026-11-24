/**
 * 第三方许可声明（第 62 批，发布配置核对 §1/§6 第 3 项：安装包没有第三方许可清单是商用合规缺口）。
 *
 * 输入 esbuild 的 metafile（打进单文件制品的模块），按 node_modules 包归并，读各包 package.json 的名称、版本、许可证
 * 与包内 LICENSE / LICENCE / COPYING / NOTICE 原文，输出一份纯文本声明。渲染进程用 vite 的 build.license 另出一份，
 * 随包运行时（runtime/ 下的依赖闭包）保留各包自带的许可文件。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/** metafile.inputs 的路径 → 包目录（取最后一个 node_modules 之后的一或两段）。 */
export function packageDirsFromMetafile(metafile, cwd) {
  const dirs = new Set();
  for (const input of Object.keys(metafile?.inputs ?? {})) {
    const p = input.split("/").join(sep);
    const i = p.lastIndexOf(`node_modules${sep}`);
    if (i < 0) continue;
    const rest = p.slice(i + `node_modules${sep}`.length).split(sep);
    const name = rest[0].startsWith("@") ? `${rest[0]}${sep}${rest[1]}` : rest[0];
    dirs.add(join(cwd, p.slice(0, i), "node_modules", name));
  }
  return [...dirs];
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/** 读一个包的许可信息；package.json 读不到的跳过（返回 null）。 */
export function packageNotice(dir) {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return null;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pj, "utf8"));
  } catch {
    return null;
  }
  const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(" OR ") : "UNKNOWN");
  const texts = [];
  for (const f of readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort()) {
    try {
      texts.push(readFileSync(join(dir, f), "utf8").trim());
    } catch {
      /* 读不到的许可文件不阻断构建，声明里只列名称与许可证 */
    }
  }
  return { name: pkg.name ?? dirname(dir), version: pkg.version ?? "", license, texts };
}

/** 多个制品的 metafile → 一份声明文本（按包名排序、同名同版本去重）。 */
export function renderNotices(title, metafiles, cwd) {
  const seen = new Map();
  const missing = new Set();
  for (const m of metafiles) for (const d of packageDirsFromMetafile(m, cwd)) {
    const n = packageNotice(d);
    if (!n) {
      // 构建机上没有该包目录（如 Agent 宿主的嵌入制品在别处构建）：只列名称，许可原文见制品末尾的许可注释
      missing.add(d.split(sep).slice(-2).join("/").replace(/^node_modules\//, ""));
      continue;
    }
    if (!seen.has(`${n.name}@${n.version}`)) seen.set(`${n.name}@${n.version}`, n);
  }
  const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  const out = [`${title}`, `本文件列出随本软件分发、打进单文件制品的第三方开源组件及其许可证（共 ${list.length} 个）。`, ""];
  for (const n of list) {
    out.push("=".repeat(72), `${n.name} ${n.version}`, `许可证：${n.license}`, "");
    if (n.texts.length) out.push(...n.texts.map((t) => `${t}\n`));
  }
  if (missing.size) out.push("=".repeat(72), `另有 ${missing.size} 个组件随制品分发（许可原文见对应制品末尾的“Bundled license information”注释）：`, [...missing].sort().join("、"), "");
  return { text: `${out.join("\n")}\n`, count: list.length + missing.size, unknown: list.filter((n) => !n.license || n.license === "UNKNOWN").map((n) => n.name) };
}
