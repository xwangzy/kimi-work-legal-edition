/**
 * 方法模板包（Kimi Code Skills）验签与物化（Kimi Code 集成核查 P0-5；历史 Demo 评估 §3.5；ZP-18）。
 *
 * - 包：content/skills/dist/{trusted/**, skills.manifest.json}（build-skills.mjs 生成，随安装包分发）。
 * - 验签：manifest 的 content_sha256 = 规范化文件清单（"sha256  path" 按路径排序逐行）的 sha256，Ed25519 签名用内容签名公钥核验；
 *   逐文件比对 sha256；清单外的文件、路径越界、任一不符 → 整包拒载（不降级加载部分技能）。
 * - 物化：验签通过的文件复制到 <工作区>/kap-trusted/<content_sha256 前 16 位>/（新目录、只读权限），交给 Agent 宿主作为可信区：
 *   trusted/AGENTS.md 作为可信指令，trusted/skills/ 作为技能目录。工作区与案卷目录里的技能、AGENTS.md 一律不加载（ZP-18 补丁）。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { sha256B64, verifyBytes } from "@zr-legal/keys";

export interface SkillInfo {
  id: string;
  version: string;
  tier: string;
  lines: string[];
  title: string;
  description: string;
  tools_required: string[];
  /** 文书类方法（v9.4 第 19 批 C-04，复核 Q2-03/Q2-17）：起草前须提交论点提纲并经律师确认。 */
  requires_outline?: boolean;
  /** 主交付物（第 28 批，SKILL.md 前言 outputs 的第一项）：以 .docx 结尾的方法，任务结束时内核核对有没有交出 Word 文书。 */
  primary_output?: string;
  /** 全部交付物（第 29 批，前言 outputs）：场景卡指定主交付物时须是其中一项。 */
  outputs?: string[];
}

export interface SkillsManifest {
  kind: "kwl-skills";
  schema: 1;
  files: { path: string; sha256: string }[];
  skills: SkillInfo[];
  content_sha256: string;
  signature: string;
  signer_key_id: string;
}

export type SkillsBundleStatus =
  | { ok: true; dir: string; contentSha256: string; skills: SkillInfo[] }
  | { ok: false; reason: string };

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/** 删除物化目录前恢复写权限（Windows 上只读属性会让删除失败）。 */
function removeTree(dir: string): void {
  if (!existsSync(dir)) return;
  for (const f of listFiles(dir)) {
    try {
      chmodSync(f, 0o644);
    } catch {
      // 忽略
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

export type SkillsSourceCheck =
  | { ok: true; manifest: SkillsManifest; contentSha256: string; srcRoot: string; declared: Map<string, string> }
  | { ok: false; reason: string };

/**
 * 只核验不物化（第 8 批：在线下载的方法模板包落位前先核验）：清单格式、内容摘要、签名、路径越界、清单外文件、逐文件摘要。
 * signerPub 为单把公钥，或内容签名公钥表（按清单的 signer_key_id 选取）。
 */
export function verifySkillsSource(manifestFile: string | null, signerPub: string | ReadonlyMap<string, string>): SkillsSourceCheck {
  if (!manifestFile || !existsSync(manifestFile)) return { ok: false, reason: "未找到方法模板包" };
  let m: SkillsManifest;
  try {
    m = JSON.parse(readFileSync(manifestFile, "utf8")) as SkillsManifest;
  } catch {
    return { ok: false, reason: "方法模板包清单无法解析" };
  }
  if (m.kind !== "kwl-skills" || m.schema !== 1 || !Array.isArray(m.files) || typeof m.signature !== "string") return { ok: false, reason: "方法模板包清单格式不符" };
  const canonical = [...m.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.sha256}  ${f.path}`).join("\n");
  const contentSha = sha256B64(new TextEncoder().encode(canonical));
  if (contentSha !== m.content_sha256) return { ok: false, reason: "方法模板包内容摘要不符" };
  const pub = typeof signerPub === "string" ? signerPub : signerPub.get(String(m.signer_key_id)) ?? "";
  if (!pub || !verifyBytes(pub, new TextEncoder().encode(contentSha), m.signature)) return { ok: false, reason: "方法模板包签名无效" };
  const srcRoot = join(dirname(manifestFile), "trusted");
  if (!existsSync(srcRoot)) return { ok: false, reason: "方法模板包缺少内容目录" };
  const declared = new Map(m.files.map((f) => [f.path, f.sha256]));
  for (const f of m.files) {
    const n = normalize(f.path);
    if (isAbsolute(n) || n.startsWith("..") || n.split(sep).includes("..")) return { ok: false, reason: `方法模板包路径越界：${f.path}` };
  }
  const present = listFiles(srcRoot).map((p) => relative(srcRoot, p).split(sep).join("/"));
  for (const p of present) if (!declared.has(p)) return { ok: false, reason: `方法模板包含清单外的文件：${p}` };
  for (const [p, h] of declared) {
    const abs = join(srcRoot, ...p.split("/"));
    if (!existsSync(abs)) return { ok: false, reason: `方法模板包缺少文件：${p}` };
    if (sha256B64(new Uint8Array(readFileSync(abs))) !== h) return { ok: false, reason: `方法模板文件被改动：${p}` };
  }
  return { ok: true, manifest: m, contentSha256: contentSha, srcRoot, declared };
}

/** 验签并物化；任何问题都返回 ok:false 与原因（调用方据此在方法库与设备页如实显示“技能包校验失败”）。 */
export function materializeSkillsBundle(manifestFile: string | null, signerPub: string | ReadonlyMap<string, string>, workspaceDir: string): SkillsBundleStatus {
  const v = verifySkillsSource(manifestFile, signerPub);
  if (!v.ok) return v;
  const { manifest: m, contentSha256: contentSha, srcRoot, declared } = v;
  // 物化到按内容摘要命名的新目录：先写临时目录（复制后再核对一次摘要，防止复制期间被换），再改名；同摘要已存在则复用
  const base = join(workspaceDir, "kap-trusted");
  const dest = join(base, contentSha.replace(/[^A-Za-z0-9]/g, "").slice(0, 16));
  if (!existsSync(dest)) {
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    try {
      for (const [p, h] of declared) {
        const to = join(tmp, ...p.split("/"));
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(srcRoot, ...p.split("/")), to);
        if (sha256B64(new Uint8Array(readFileSync(to))) !== h) throw new Error(`复制后摘要不符：${p}`);
        chmodSync(to, 0o444);
      }
      renameSync(tmp, dest);
    } catch (e) {
      removeTree(tmp);
      return { ok: false, reason: `方法模板包物化失败：${(e as Error).message}` };
    }
  } else {
    // 复用前再核对一遍（目录在律师电脑上，可能被改动）
    for (const [p, h] of declared) {
      const abs = join(dest, ...p.split("/"));
      if (!existsSync(abs) || sha256B64(new Uint8Array(readFileSync(abs))) !== h) {
        removeTree(dest);
        return materializeSkillsBundle(manifestFile, signerPub, workspaceDir);
      }
    }
    const extra = listFiles(dest).map((p) => relative(dest, p).split(sep).join("/")).filter((p) => !declared.has(p));
    if (extra.length) {
      removeTree(dest);
      return materializeSkillsBundle(manifestFile, signerPub, workspaceDir);
    }
  }
  return { ok: true, dir: dest, contentSha256: contentSha, skills: Array.isArray(m.skills) ? m.skills : [] };
}

/**
 * 方法模板的“质量自检”清单（复核页“你来核对”，v9.2 §4.4 / Y4 §5 D-3）：取签名可信区里该模板 SKILL.md 中标题含“质量自检”的一节的勾选项。
 * 只读验签后物化的可信区；模板编号须为登记的字符集，读不到或没有该节返回空。
 */
/** 自检条目里的工具名与内部取值换成律师话（第 28 批：复核页“你来核对”直接给律师看，工作准则第 10 条不写工具名）。纯函数。 */
const LAWYER_WORDS: readonly [RegExp, string][] = [
  [/ ?`?calc\.deadline`? ?/g, "期限计算工具"],
  [/ ?`?calc\.interest`? ?/g, "利息计算工具"],
  [/ ?`?calc\.court_fee`? ?/g, "诉讼费计算工具"],
  [/ ?`?calc\.labor`? ?/g, "劳动补偿计算工具"],
  [/ ?`?citations\.verify`? ?/g, "引用核验"],
  [/ ?`?materials\.list`? ?/g, "材料目录"],
  [/ ?`?docx\.compare`? ?/g, "两稿比对"],
  [/ ?`?facts\.list`? ?/g, "事实时间线"],
  [/ ?\bintercepted\s*\/\s*unverified_offline\b ?/g, "核对未通过或离线未核实"],
  [/ ?\bstats\b ?/g, "比对统计"],
];
export function lawyerWords(line: string): string {
  return LAWYER_WORDS.reduce((t, [re, w]) => t.replace(re, w), line);
}

export function skillQualityChecklist(dir: string, skillId: string): string[] {
  if (!/^[a-z0-9-]{1,64}$/.test(skillId)) return [];
  let text = "";
  try {
    text = readFileSync(join(dir, "skills", skillId, "SKILL.md"), "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      if (inSection) break;
      inSection = line.includes("质量自检");
      continue;
    }
    const m = inSection ? /^\s*-\s*\[[ xX]\]\s*(.+)$/.exec(line) : null;
    if (m) out.push(lawyerWords(m[1]!.trim()).slice(0, 200));
    if (out.length >= 20) break;
  }
  return out;
}


/** 任务开始时方法模板的标题、版本与模板包摘要（余项续复核 RC-A-09、RC-B-14）：写进任务快照，事后看得到“当时按哪一版做的”。纯函数。 */
export function skillSnapshot(bundle: SkillsBundleStatus | undefined, skill: string, primaryOverride?: string): { skill_title?: string; skill_version?: string; skills_sha256?: string; skill_requires_outline?: true; skill_primary_output?: string } {
  if (!bundle || !bundle.ok) return {};
  const x = bundle.skills.find((s) => s.id === skill);
  // 场景卡指定的主交付物（第 29 批）：须是方法前言 outputs 里的一项（调用方已校验），否则用方法缺省的第一项
  const primary = (primaryOverride && x?.outputs?.includes(primaryOverride) ? primaryOverride : typeof x?.primary_output === "string" ? x.primary_output : "").slice(0, 80);
  return { ...(x ? { skill_title: x.title, skill_version: x.version } : {}), ...(x?.requires_outline ? { skill_requires_outline: true as const } : {}), ...(primary ? { skill_primary_output: primary } : {}), skills_sha256: bundle.contentSha256 };
}
