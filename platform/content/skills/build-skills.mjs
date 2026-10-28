/**
 * 方法模板（Kimi Code Skills）签名构建（Kimi Code 集成核查 P0-5；历史 Demo 评估 §3.4–3.5）。
 *
 * 源：content/skills/AGENTS.md（产品工作准则，作为可信区指令）+ content/skills/<id>/SKILL.md（及同目录 references/）。
 * 产物：content/skills/dist/trusted/{AGENTS.md, skills/<id>/...} + dist/skills.manifest.json
 *   （逐文件 sha256；content_sha256 = 规范化文件清单的 sha256；Ed25519 签名，复用法规库同一把内容签名密钥）。
 * 构建检查：name 与目录名一致且为小写连字符；description 不超过 250 字（Kimi Code 列表截断长度）；
 *   kwl.tools_required 必须是对 Agent 开放的法律工具（LEGAL_MCP_TOOLS）——声明了 Agent 调不到的工具即构建失败。
 * 用法：npm run build:skills
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256B64, signBytes } from "@zr-legal/keys";
import { signerKeyId } from "@zr-legal/lawdb";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const key = JSON.parse(readFileSync(join(root, "content", "keys", "content-signing-dev.json"), "utf8"));
const dist = join(here, "dist");
const trusted = join(dist, "trusted");

/** 读 frontmatter 中需要校验的字段（只认本仓库 SKILL.md 的写法：顶层键、`>-` 折叠块、kwl 下一层的行内数组）。 */
function frontmatter(text, file) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(`${file}：缺少 frontmatter`);
  const lines = m[1].split("\n");
  const out = { kwl: {} };
  for (let i = 0; i < lines.length; i++) {
    const top = /^([a-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (top) {
      const [, k, v] = top;
      if (v === ">-" || v === "|") {
        const buf = [];
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) buf.push(lines[++i].trim());
        out[k] = buf.join(v === ">-" ? "" : "\n");
      } else if (k !== "kwl") out[k] = v;
      continue;
    }
    const sub = /^\s{2}([a-z_]+):\s*(.*)$/.exec(lines[i]);
    if (sub) out.kwl[sub[1]] = sub[2].startsWith("[") ? sub[2].replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean) : sub[2];
  }
  return out;
}

const ids = readdirSync(here).filter((d) => existsSync(join(here, d, "SKILL.md"))).sort();
if (ids.length === 0) throw new Error("没有任何 SKILL.md");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(trusted, "skills"), { recursive: true });
cpSync(join(here, "AGENTS.md"), join(trusted, "AGENTS.md"));
// 第三方许可（v9.4 评审 S1 §3：融合上游 MIT 方法骨架须随分发保留版权与许可声明），一并签名
if (existsSync(join(here, "THIRD_PARTY_LICENSES"))) cpSync(join(here, "THIRD_PARTY_LICENSES"), join(trusted, "THIRD_PARTY_LICENSES"), { recursive: true });
const skills = [];
for (const id of ids) {
  const file = join(here, id, "SKILL.md");
  // 换行归一：Windows 检出可能带 CRLF（autocrlf），frontmatter 与标题解析只按 LF 写
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const fm = frontmatter(text, file);
  if (fm.name !== id || !/^[a-z][a-z0-9-]{1,47}$/.test(id)) throw new Error(`${file}：name 必须与目录名一致且为小写连字符`);
  if (!fm.description || [...fm.description].length > 250) throw new Error(`${file}：description 必填且不超过 250 字（现 ${[...(fm.description ?? "")].length} 字）`);
  const req = fm.kwl.tools_required ?? [];
  const bad = req.filter((t) => !LEGAL_MCP_TOOLS.includes(t));
  if (bad.length) throw new Error(`${file}：tools_required 含 Agent 调不到的工具：${bad.join("、")}`);
  cpSync(join(here, id), join(trusted, "skills", id), { recursive: true, filter: (s) => !/[\\/](evals|examples)([\\/]|$)/.test(s) });
  // 主交付物（第 28 批）：outputs 的第一项。是 Word（.docx）时内核按它核对任务有没有交出文书，没有就不记“完成”——
  // 所以这类方法必须把出 Word 的工具列为必需（第 28 批全量用例查出顾问答复、访谈纪要、研究备忘录三处只列为可选）
  const primary = Array.isArray(fm.kwl.outputs) && fm.kwl.outputs.length > 0 ? String(fm.kwl.outputs[0]) : "";
  if (/\.docx$/i.test(primary) && !req.some((t) => t === "docx.render_report" || t === "docx.revise")) throw new Error(`${file}：主交付物是 Word（${primary}），tools_required 须含 docx.render_report 或 docx.revise`);
  // 全部交付物（第 29 批）：同一方法的不同场景卡可以指定其中一项为主交付物（尽调“清单”与“发现与报告”共用一个方法；卡上指定的 Word 主交付物由桌面端用例核对必需工具）
  const outputs = Array.isArray(fm.kwl.outputs) ? fm.kwl.outputs.map(String).slice(0, 12) : [];
  skills.push({ id, version: fm.kwl.version ?? "0.0.0", tier: fm.kwl.tier ?? "beta", lines: fm.kwl.lines ?? [], tools_required: req, ...(fm.kwl.requires_outline === "true" ? { requires_outline: true } : {}), ...(primary ? { primary_output: primary } : {}), ...(outputs.length > 0 ? { outputs } : {}), title: (/^# (.+)$/m.exec(text) ?? [])[1] ?? id, description: fm.description });
}

function list(dir) {
  const out = [];
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...list(p));
    else out.push(p);
  }
  return out;
}
const files = list(trusted)
  .map((p) => ({ path: relative(trusted, p).split("\\").join("/"), sha256: sha256B64(new Uint8Array(readFileSync(p))) }))
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const canonical = files.map((f) => `${f.sha256}  ${f.path}`).join("\n");
const contentSha256 = sha256B64(new TextEncoder().encode(canonical));
const manifest = {
  kind: "kwl-skills",
  schema: 1,
  built_at: new Date().toISOString(),
  files,
  skills,
  content_sha256: contentSha256,
  signature: signBytes(key.privateKeyPem, new TextEncoder().encode(contentSha256)),
  signer_key_id: signerKeyId(key.publicKeyPem),
};
writeFileSync(join(dist, "skills.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`[build:skills] ${skills.length} 个方法模板、${files.length} 个文件 → ${dist}（签名者 ${manifest.signer_key_id}）`);
