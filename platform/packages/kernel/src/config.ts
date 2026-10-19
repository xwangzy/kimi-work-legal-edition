/**
 * 内核配置（方案 v5.0 第 4 篇 §5.1：每台电脑上每个律所工作区一个目录；
 * Windows 为 %LOCALAPPDATA%\KimiWorkLegal\<律所 ID>\，macOS/Linux 同理）。
 */
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  /** 内容签名公钥是不是开发公钥（第 13 批：开发公钥的私钥在开发机上，不能用于对外发布；状态如实报告）。 */
  contentKeyDev: boolean;
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
  /**
   * 模拟第 12 批之前的客户端（不写成员链、不锚定、不认段里的成员事件）：只在 node 测试运行器里生效（ZR_MEMBER_LOG=off），
   * 用来覆盖仍然在用的第 11 批行规则（未锚定的事项、混合版本）。
   */
  legacyMemberRows: boolean;
  /** 数据根（各律所工作区的上一级；activation.json 与 onboarding.json 在这里）。 */
  dataRoot: string;
  /** 本机激活记录（第 13 批开通与入组；安装包形态的律所与成员标识只从这里来）。 */
  activation: ActivationFile | null;
  /**
   * 待激活模式（第 13 批）：要求控制面（安装包形态）或 ZR_ONBOARDING=1，且本机没有激活记录、也没有显式给出律所/成员标识。
   * 内核以占位工作区启动，只开放开通相关方法；不生成本所律所根、不与控制面同步。
   */
  onboarding: boolean;
  env: NodeJS.ProcessEnv;
}

/** 本机激活记录 `<数据根>/activation.json`（只有编号与显示名，不含任何秘密；秘密在工作区 keys/ 里按主密钥封装）。 */
export interface ActivationFile {
  v: 1;
  tid: string;
  firm_slug: string;
  firm_name: string;
  member_slug: string;
  member_name: string | null;
  role: "admin" | "partner" | "lawyer" | "assistant";
  kind: "founder" | "member";
  activated_at: string;
}

/** 待激活模式的占位工作区（激活完成、按真实身份启动后删除）。 */
export const PENDING_WORKSPACE_SLUG = "pending-activation";

export function activationFilePath(dataRoot: string): string {
  return join(dataRoot, "activation.json");
}

/** 读激活记录；不存在 null；内容不合规也按 null（不会以半截身份启动）。 */
export function readActivationFile(dataRoot: string): ActivationFile | null {
  const p = activationFilePath(dataRoot);
  if (!existsSync(p)) return null;
  try {
    const a = JSON.parse(readFileSync(p, "utf8")) as Partial<ActivationFile>;
    const okSlug = (x: unknown) => typeof x === "string" && SLUG_PATTERN.test(x) && x !== PENDING_WORKSPACE_SLUG;
    if (
      a.v !== 1 ||
      !okSlug(a.firm_slug) ||
      !okSlug(a.member_slug) ||
      a.tid !== `ten_${a.firm_slug}` ||
      (a.kind !== "founder" && a.kind !== "member") ||
      !["admin", "partner", "lawyer", "assistant"].includes(String(a.role)) ||
      typeof a.firm_name !== "string"
    )
      return null;
    return a as ActivationFile;
  } catch {
    return null;
  }
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

/**
 * Windows 命名管道名的本机唯一后缀（Kimi Code 增量核查 WR-1）：命名管道在同一台机器的所有登录会话间共享命名空间——
 * 只按律所标识命名时，RDS/云桌面上同一律所的第二位律师的内核绑定失败（Agent 与法律工具全不可用），本机其他进程也能抢先占名。
 * 后缀取“Windows 用户名 + 数据目录 + 本目录随机盐”的摘要：同一用户同一数据目录稳定、不同用户互不冲突、他人不可推算。名字不作凭据（通道另有令牌鉴权）。
 */
export function pipeSuffix(workspaceDir: string, user = safeUserName(), salt = ""): string {
  return createHash("sha256").update(`${user}\u0000${workspaceDir.toLowerCase()}\u0000${salt}`).digest("hex").slice(0, 16);
}

/**
 * 每个数据目录一份随机盐（复核 B4-A14）：用户名与数据目录对同机其他账户都可推算，RDS/云桌面上别的账户可以抢先占用管道名，
 * 让本人的 Agent 与闸门起不来。盐在首次运行时生成、存数据目录内（只有本账户可读），管道名因此不可推算。
 */
export function pipeSalt(workspaceDir: string): string {
  const f = join(workspaceDir, ".pipe-salt");
  const read = (): string | null => {
    try {
      const v = readFileSync(f, "utf8").trim();
      return /^[0-9a-f]{32}$/.test(v) ? v : null;
    } catch {
      return null;
    }
  };
  const have = read();
  if (have) return have;
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  const fresh = randomBytes(16).toString("hex");
  try {
    writeFileSync(f, fresh, { mode: 0o600, flag: "wx" });
    return fresh;
  } catch {
    // 并发首跑：以先写成的为准；文件损坏则覆盖重建
    const again = read();
    if (again) return again;
    writeFileSync(f, fresh, { mode: 0o600 });
    return fresh;
  }
}

function safeUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? "";
  }
}

/** 内核命名管道（Agent 宿主与界面加载项的本机通道；§3：命名管道为主）。 */
export function defaultPipePath(config: Pick<KernelConfig, "workspaceDir" | "firmSlug" | "env">): string {
  if (config.env.ZR_KERNEL_PIPE) return config.env.ZR_KERNEL_PIPE;
  if (process.platform === "win32") return `\\\\.\\pipe\\kwl-${config.firmSlug}-${pipeSuffix(config.workspaceDir, undefined, pipeSalt(config.workspaceDir))}`;
  return unixSocketPath(config.workspaceDir, "kernel.sock");
}

/** 出站闸门的本机套接字/命名管道（v9 第 04 篇 §5.1：闸门只监听本机通道，无 TCP 端口）。 */
export function defaultGatePath(config: Pick<KernelConfig, "workspaceDir" | "firmSlug" | "env">): string {
  if (config.env.ZR_GATE_PIPE) return config.env.ZR_GATE_PIPE;
  if (process.platform === "win32") return `\\\\.\\pipe\\kwl-gate-${config.firmSlug}-${pipeSuffix(config.workspaceDir, undefined, pipeSalt(config.workspaceDir))}`;
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
 * 随包法规库与内容签名公钥的解析顺序（§9：包随客户端分发；公钥随包内置）：
 * 1) env（ZR_LAWDB_FILE / ZR_LAWDB_SIGNER_PUB，开发覆盖；安装包形态内核环境按白名单构造，不含这两项）；
 * 2) 安装包 resources/lawdb/；3) 制品旁 lawdb/；4) 仓库 content/lawdb/dist 与 content/keys（开发默认）。
 * **不从工作区（数据目录）取**（第 8 批更正）：数据目录对本人可写，原先“工作区 lawdb/ 优先”使能写数据目录者同时换掉法规库与
 * 核验它的公钥；在线更新的法规库装在 <工作区>/content/ 下，由账本登记与签名通道清单决定是否选用（services/content-updates.ts）。
 * 全部缺失时返回仓库开发路径（openLawdb 将以中文报错提示先运行 build:lawdb——不静默降级）。
 */
function resolveLawdb(env: NodeJS.ProcessEnv, workspaceDir: string): { lawdbFile: string; lawdbSignerPub: string; contentKeyDev: boolean } {
  const bundleDir = typeof __dirname !== "undefined" ? __dirname : undefined;
  // Electron 安装包形态：法规库经 extraResources 放在 resources/lawdb/（asar 外的真文件）。bundleDir 在 asar 内——
  // 原生 SQLite 走 OS 层打不开 asar 虚拟路径，而 Electron 补丁过的 fs.existsSync 对 asar 路径却返回 true，
  // 所以 resourcesPath 候选必须排在 bundleDir 之前（按真实存在性命中，开发形态无此目录自然跳过）
  const resourcesLawdb = (process as any).resourcesPath ? join((process as any).resourcesPath, "lawdb") : undefined;
  const devFile = repoContentPath("lawdb", "dist", "lawdb.sqlite");
  const lawdbFile =
    env.ZR_LAWDB_FILE ??
    firstExisting([resourcesLawdb ? join(resourcesLawdb, "lawdb.sqlite") : undefined, bundleDir ? join(bundleDir, "lawdb", "lawdb.sqlite") : undefined, devFile]) ??
    // 都找不到：给出开发路径（不存在时 openLawdb 以中文报错——不兜底到可写的工作区，复核 S8A-21）
    devFile ??
    "";

  const devPub = repoContentPath("keys", "content-signing-dev.pub.json");
  let lawdbSignerPub = env.ZR_LAWDB_SIGNER_PUB ?? "";
  let contentKeyDev = !lawdbSignerPub;
  if (!lawdbSignerPub) {
    const pubFile = firstExisting([resourcesLawdb ? join(resourcesLawdb, "content-signing.pub.json") : undefined, bundleDir ? join(bundleDir, "lawdb", "content-signing.pub.json") : undefined, devPub]);
    if (pubFile) {
      try {
        const pub = JSON.parse(readFileSync(pubFile, "utf8")) as { publicKeyPem?: string; dev?: boolean };
        lawdbSignerPub = pub.publicKeyPem ?? "";
        // 开发公钥（第 13 批）：仓库开发路径或随包文件写明 dev:true
        contentKeyDev = pubFile === devPub || pub.dev === true;
      } catch {
        lawdbSignerPub = "";
      }
    }
  }
  return { lawdbFile, lawdbSignerPub, contentKeyDev };
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
  const root = opts.dataDir ?? defaultDataDir(env);
  // 身份来源（第 13 批）：显式给出（开发与测试）> 本机激活记录 > 待激活占位 > 开发缺省
  const explicit = !!(opts.firmSlug ?? env.ZR_FIRM_SLUG);
  const activation = explicit ? null : readActivationFile(root);
  const onboarding = !explicit && !activation && (env.ZR_ONBOARDING === "1" || env.ZR_REQUIRE_CONTROL_PLANE === "1");
  const firmSlug = checkSlug("律所标识", opts.firmSlug ?? env.ZR_FIRM_SLUG ?? (onboarding ? PENDING_WORKSPACE_SLUG : activation?.firm_slug) ?? "demo-firm");
  const workspaceDir = join(root, firmSlug);
  const { lawdbFile, lawdbSignerPub, contentKeyDev } = resolveLawdb(env, workspaceDir);
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
    userSlug: checkSlug("成员标识", opts.userSlug ?? env.ZR_USER_SLUG ?? (onboarding ? "pending" : activation?.member_slug) ?? "demo-lawyer"),
    lawdbFile,
    lawdbSignerPub,
    contentKeyDev,
    ocrModelDir,
    agentProfileFile,
    syncShareDir: env.ZR_SYNC_SHARE_DIR || undefined,
    legacyMemberRows: env.ZR_MEMBER_LOG === "off" && !!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== "production",
    dataRoot: root,
    activation,
    onboarding,
    env,
  };
}
