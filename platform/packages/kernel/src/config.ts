/**
 * 内核配置（方案 v5.0 第 4 篇 §5.1：每台电脑上每个律所工作区一个目录；
 * Windows 为 %LOCALAPPDATA%\KimiWorkLegal\<律所 ID>\，macOS/Linux 同理）。
 */
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface KernelOptions {
  /** 工作区根目录（默认按平台取应用数据目录；开发可用 ZR_KERNEL_DATA_DIR 覆盖）。 */
  dataDir?: string;
  /** 律所工作区标识（开发默认 demo-firm）。 */
  firmSlug?: string;
  /** 当前成员标识（开发默认 demo-lawyer；生产来自律所 IM 组织扫码认证）。 */
  userSlug?: string;
  /** 数据库主密钥（G0 第 3–4 周启用：safeStorage 解封后一次性传入）。 */
  dbKey?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface KernelConfig {
  workspaceDir: string;
  dbFile: string;
  dbKey?: string | undefined;
  blobDir: string;
  firmSlug: string;
  userSlug: string;
  /** 法规库包文件（§9：签名只读 SQLite 包）。 */
  lawdbFile: string;
  /** 内容签名公钥 PEM（验签法规库包；随客户端内置）。 */
  lawdbSignerPub: string;
  /** OCR 模型目录（§8.1：PP-OCRv5 mobile 三模型 + 字典；缺失时 OCR 路径如实报不可用）。 */
  ocrModelDir: string;
  /** 签名法律 Agent profile 路径（§4.3：A1 任务注入 agentFiles；验签失败任务失败关闭）。 */
  agentProfileFile: string;
  /** 签名工具清单锁文件（v9 第 04 篇 §9 F3；审查 R-08：缺失或验签失败即不暴露任何法律工具）。 */
  toolManifestFile: string | null;
  /** 方法模板包清单（content/skills/dist/skills.manifest.json；随包为 <bundle>/skills/）。 */
  skillsManifestFile: string | null;
  /** 共享文件夹同步目录（ZR_SYNC_SHARE_DIR；配置后内核起同步定时器且 node_enqueue 内联导出）。 */
  syncShareDir?: string | undefined;
  env: NodeJS.ProcessEnv;
}

/**
 * POSIX 套接字路径有长度上限（macOS 104 字节、Linux 108 字节）：工作区路径过长时改用临时目录下按工作区派生的私有目录（0700），
 * 否则监听失败（唯一出口不可用）。
 */
function unixSocketPath(workspaceDir: string, name: string): string {
  const preferred = join(workspaceDir, "run", name);
  if (Buffer.byteLength(preferred, "utf8") <= 100) return preferred;
  const dir = join(tmpdir(), `kwl-${createHash("sha256").update(workspaceDir).digest("hex").slice(0, 16)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, name);
}

/** 内核命名管道（Agent 宿主与界面加载项的本机通道；§3：命名管道为主）。 */
export function defaultPipePath(config: Pick<KernelConfig, "workspaceDir" | "firmSlug" | "env">): string {
  if (config.env.ZR_KERNEL_PIPE) return config.env.ZR_KERNEL_PIPE;
  if (process.platform === "win32") return `\\\\.\\pipe\\kwl-${config.firmSlug}`;
  return unixSocketPath(config.workspaceDir, "kernel.sock");
}

/** 出站闸门的本机套接字/命名管道（v9 第 04 篇 §5.1：闸门只监听本机通道，无 TCP 端口）。 */
export function defaultGatePath(config: Pick<KernelConfig, "workspaceDir" | "firmSlug" | "env">): string {
  if (config.env.ZR_GATE_PIPE) return config.env.ZR_GATE_PIPE;
  if (process.platform === "win32") return `\\\\.\\pipe\\kwl-gate-${config.firmSlug}`;
  return unixSocketPath(config.workspaceDir, "gate.sock");
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  if (env.ZR_KERNEL_DATA_DIR) return env.ZR_KERNEL_DATA_DIR;
  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "KimiWorkLegal");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "KimiWorkLegal");
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "KimiWorkLegal");
}

/** 仓库内 content/ 路径（ESM 开发形态；CJS 制品下返回 undefined——制品以 workspace/bundle 相对路径为准）。 */
function repoContentPath(...parts: string[]): string | undefined {
  try {
    return fileURLToPath(new URL(join("../../../content", ...parts), import.meta.url));
  } catch {
    return undefined;
  }
}

function firstExisting(paths: (string | undefined)[]): string | undefined {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

/**
 * 法规库包与内容签名公钥的解析顺序（§9：包随客户端分发；公钥随包内置）：
 * 1) env（ZR_LAWDB_FILE / ZR_LAWDB_SIGNER_PUB，开发覆盖）；2) 工作区 lawdb/ 目录（生产安装位）；
 * 3) 制品旁 lawdb/ 目录（Electron 打包随包分发）；4) 仓库 content/lawdb/dist 与 content/keys（开发默认）。
 * 全部缺失时返回仓库开发路径（openLawdb 将以中文报错提示先运行 build:lawdb——不静默降级）。
 */
function resolveLawdb(env: NodeJS.ProcessEnv, workspaceDir: string): { lawdbFile: string; lawdbSignerPub: string } {
  const bundleDir = typeof __dirname !== "undefined" ? __dirname : undefined;
  const devFile = repoContentPath("lawdb", "dist", "lawdb.sqlite");
  const lawdbFile =
    env.ZR_LAWDB_FILE ??
    firstExisting([join(workspaceDir, "lawdb", "lawdb.sqlite"), bundleDir ? join(bundleDir, "lawdb", "lawdb.sqlite") : undefined, devFile]) ??
    devFile ??
    join(workspaceDir, "lawdb", "lawdb.sqlite");

  const devPub = repoContentPath("keys", "content-signing-dev.pub.json");
  let lawdbSignerPub = env.ZR_LAWDB_SIGNER_PUB ?? "";
  if (!lawdbSignerPub) {
    const pubFile = firstExisting([join(workspaceDir, "lawdb", "content-signing.pub.json"), bundleDir ? join(bundleDir, "lawdb", "content-signing.pub.json") : undefined, devPub]);
    if (pubFile) {
      try {
        lawdbSignerPub = (JSON.parse(readFileSync(pubFile, "utf8")) as { publicKeyPem?: string }).publicKeyPem ?? "";
      } catch {
        lawdbSignerPub = "";
      }
    }
  }
  return { lawdbFile, lawdbSignerPub };
}

/**
 * 律所与成员标识（复核 S6-A22）：设备编号 dev_<律所>_<成员>、租户与成员编号都由它们拼成，律所标识还是工作区目录名——
 * 只允许字母、数字、下划线与连字符（控制面接口以设备编号为路径段；目录名不得含路径分隔符）。
 */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

function checkSlug(kind: string, slug: string): string {
  if (!SLUG_PATTERN.test(slug)) throw new Error(`${kind}只允许字母、数字、下划线与连字符（1–48 位，以字母或数字开头）：${JSON.stringify(slug).slice(0, 80)}`);
  return slug;
}

export function loadConfig(opts: KernelOptions = {}): KernelConfig {
  const env = opts.env ?? process.env;
  const firmSlug = checkSlug("律所标识", opts.firmSlug ?? env.ZR_FIRM_SLUG ?? "demo-firm");
  const root = opts.dataDir ?? defaultDataDir(env);
  const workspaceDir = join(root, firmSlug);
  const { lawdbFile, lawdbSignerPub } = resolveLawdb(env, workspaceDir);
  const ocrModelDir = env.ZR_OCR_MODEL_DIR ?? firstExisting([repoContentPath("ocr-models")]) ?? join(workspaceDir, "ocr-models");
  const bundleDir = typeof __dirname !== "undefined" ? __dirname : undefined;
  const agentProfileFile =
    env.ZR_AGENT_PROFILE_FILE ??
    firstExisting([
      join(workspaceDir, "agent-profile", "legal-agent.md"),
      bundleDir ? join(bundleDir, "agent-profile", "legal-agent.md") : undefined,
      repoContentPath("agent-profile", "dist", "legal-agent.md"),
    ]) ??
    repoContentPath("agent-profile", "dist", "legal-agent.md") ??
    join(workspaceDir, "agent-profile", "legal-agent.md");
  const skillsManifestFile =
    env.ZR_SKILLS_MANIFEST_FILE ??
    firstExisting([
      bundleDir ? join(bundleDir, "skills", "skills.manifest.json") : undefined,
      repoContentPath("skills", "dist", "skills.manifest.json"),
    ]) ??
    null;
  const toolManifestFile =
    env.ZR_TOOL_MANIFEST_FILE ??
    firstExisting([
      bundleDir ? join(bundleDir, "tool-manifest", "tool-manifest.lock.json") : undefined,
      repoContentPath("tool-manifest", "dist", "tool-manifest.lock.json"),
    ]) ??
    null;
  return {
    toolManifestFile,
    skillsManifestFile,
    workspaceDir,
    dbFile: join(workspaceDir, "ledger.db"),
    // 数据库主密钥：safeStorage 解封后一次性传入（生产形态）；ZR_DB_KEY 仅开发用（README 注明）
    dbKey: opts.dbKey ?? env.ZR_DB_KEY,
    blobDir: join(workspaceDir, "blobs"),
    firmSlug,
    userSlug: checkSlug("成员标识", opts.userSlug ?? env.ZR_USER_SLUG ?? "demo-lawyer"),
    lawdbFile,
    lawdbSignerPub,
    ocrModelDir,
    agentProfileFile,
    syncShareDir: env.ZR_SYNC_SHARE_DIR || undefined,
    env,
  };
}
