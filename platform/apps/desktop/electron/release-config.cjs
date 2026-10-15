/**
 * 安装包内置的上游地址与公钥钉住集（审计 S5；第 04 篇 §5.1“网关、检索与控制面的目的地随客户端构建固定”）。
 *
 * - 文件 `electron/release.json` 打进 asar，安装包形态下**只认它**：内核环境按白名单构造（复核 B3-A02）——进程环境里只保留
 *   操作系统必需的变量，任何 ZR_* 配置项、NODE_OPTIONS 等运行时注入变量都不进入内核（本机其他程序或用户环境不能把推理流量改投他处，
 *   也不能替换入口脚本或数据目录）；
 * - asar 完整性：熔断 EnableEmbeddedAsarIntegrityValidation、OnlyLoadAppFromAsar、RunAsNode 关闭已在 electron-builder.yml 配置（第 4 批），
 *   release.json 随 asar 受其保护；按用户安装时安装目录对本人可写，同一 Windows 账户下的恶意程序不在防护范围内（要防这一层选按机器安装）；
 * - 地址必须 https；钉住集为 `sha256/<base64>`，至少两把（当前 + 备份），否则该上游不配置（闸门侧按 requirePins 拒绝发出）；
 * - 安装包形态模型提供方固定为真实上游（经出站闸门），不会以离线模拟运行；
 * - 同时下发 ZR_UPSTREAM_TLS=strict：回环 http 也不允许、中软上游缺钉住即拒绝（packages/egress-gate/src/tls-check.ts）。
 * 本模块无 Electron 依赖，可单测。
 */
const fs = require("node:fs");
const { createPublicKey } = require("node:crypto");

const PIN_RE = /^sha256\/[A-Za-z0-9+/]{43}=$/;

/** 安装包形态从进程环境中剔除的配置项（上游、钉住、传输策略与开发形态的令牌/密钥）。白名单之外本就不传，此表留作说明与单测。 */
const ROUTING_ENV = /^ZR_(?:GATEWAY_|SEARCH_|CONTROL_PLANE_|DIST_|SUPPORT_|CONTENT_KEYS|UPSTREAM_TLS|SEAT_TOKEN|BYOK_|MOONSHOT_|PRIVATE_|MODEL_PROVIDER|GATE_FETCH|FETCH_ALLOWLIST|FIRM_L3A)/;

/**
 * 安装包形态内核环境的白名单（复核 B3-A02）：只保留操作系统与运行时正常工作所需的变量（大小写不敏感，Windows 环境变量名不区分大小写）。
 * 不含 NODE_OPTIONS、NODE_PATH、ELECTRON_*、任何 ZR_* / KWL_*、代理与 CA 变量（出站一律经闸门，闸门按随包钉住集核对证书）。
 */
const OS_ENV_ALLOW = new Set(
  [
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "OS", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "PUBLIC", "ALLUSERSPROFILE",
    "COMPUTERNAME", "USERNAME", "USERDOMAIN", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
    "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "XDG_RUNTIME_DIR",
  ].map((k) => k.toUpperCase()),
);

function httpsUrl(v) {
  if (typeof v !== "string" || v.length > 300) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return v.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function pinList(v) {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
  if (out.length < 2 || out.length > 8 || !out.every((p) => PIN_RE.test(p))) return null;
  return out;
}

/**
 * 读取 release.json → { env, problems }。缺文件不是错误（安装包未配置云端：只有本机能力，控制面缺失即退出模式）；
 * 每一项不合法都单独列出问题且不进入环境（失败关闭）。
 */
/** { kid: PEM } 公钥表：kid 只许 [A-Za-z0-9_.-]{1,64}、每把必须是 Ed25519 公钥；不合格返回 null。 */
function keyTable(v, min = 1) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (const [kid, pem] of Object.entries(v)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(kid) || typeof pem !== "string") return null;
    // 只收公钥（复核 S6A-10：createPublicKey 也接受私钥 PEM 并导出公钥——误填私钥会随安装包分发）
    if (!/^\s*-----BEGIN PUBLIC KEY-----/.test(pem) || /PRIVATE KEY/.test(pem)) return null;
    try {
      if (createPublicKey(pem).asymmetricKeyType !== "ed25519") return null;
    } catch {
      return null;
    }
    out[kid] = pem;
  }
  const n = Object.keys(out).length;
  return n >= min && n <= 8 ? out : null;
}

function loadReleaseConfig(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { env: {}, problems: e && e.code === "ENOENT" ? [] : ["release.json 无法解析"], update: null };
  }
  const env = {};
  const problems = [];
  const pair = (baseKey, pinsKey, envBase, envPins) => {
    if (raw[baseKey] === undefined) return;
    const base = httpsUrl(raw[baseKey]);
    const pins = pinList(raw[pinsKey]);
    if (!base) problems.push(`${baseKey} 必须是 https 地址`);
    else if (!pins) problems.push(`${pinsKey} 须为至少两把 sha256/<base64> 钉住值（当前 + 备份）`);
    else {
      env[envBase] = base;
      env[envPins] = pins.join(",");
    }
  };
  pair("gateway_base", "gateway_pins", "ZR_GATEWAY_BASE", "ZR_GATEWAY_PINS");
  pair("search_base", "search_pins", "ZR_SEARCH_BASE", "ZR_SEARCH_PINS");
  pair("control_plane_base", "control_plane_pins", "ZR_CONTROL_PLANE_BASE", "ZR_CONTROL_PLANE_PINS");
  // 控制面签名公钥表与席位令牌公钥表（云端持久化与 KMS 设计 v1 §4：安装包曾只带地址与钉住，内核公钥表为空 → 一切控制面文档按未知密钥拒收）。
  // 形如 { "<kid>": "<Ed25519 公钥 SPKI PEM>" }；配置了控制面就必须两表都有、每把都能解析为 Ed25519 公钥，否则整组控制面配置不生效并报告。
  if (env.ZR_CONTROL_PLANE_BASE) {
    // 控制面签名公钥至少两把（当前 + 预置的下一把，轮换不必改格式；云端持久化与 KMS 设计 v1 §4.7），至多 8 把
    const cp = keyTable(raw.control_plane_keys, 2);
    const seat = keyTable(raw.seat_keys);
    if (!cp || !seat) {
      problems.push("control_plane_keys 须为 2–8 把、seat_keys 须为 1–8 把 { kid: Ed25519 公钥 PEM }（只收公钥）");
      delete env.ZR_CONTROL_PLANE_BASE;
      delete env.ZR_CONTROL_PLANE_PINS;
    } else {
      env.ZR_CONTROL_PLANE_KEYS = JSON.stringify(cp);
      env.ZR_SEAT_KEYS = JSON.stringify(seat);
    }
  }
  // 内容分发（第 8 批 S6/S7）：法规库与方法模板的在线更新地址（钉住集同其他中软上游）、通道与内容签名公钥。
  // content_keys 只用于轮换后的新内容签名公钥（随包公钥始终可信）；每把须为 Ed25519 公钥，1–8 把；缺省不检查在线更新
  pair("dist_base", "dist_pins", "ZR_DIST_BASE", "ZR_DIST_PINS");
  if (env.ZR_DIST_BASE) {
    if (raw.dist_channel !== undefined && raw.dist_channel !== "stable" && raw.dist_channel !== "beta") problems.push("dist_channel 只能是 stable 或 beta");
    else if (raw.dist_channel === "beta") env.ZR_DIST_CHANNEL = "beta";
    if (raw.content_keys !== undefined) {
      const ok = Array.isArray(raw.content_keys) && raw.content_keys.length >= 1 && raw.content_keys.length <= 8 && keyTable(Object.fromEntries(raw.content_keys.map((k, i) => [`k${i}`, k])));
      if (!ok) problems.push("content_keys 须为 1–8 把 Ed25519 公钥 PEM（只收公钥）");
      else env.ZR_CONTENT_KEYS = JSON.stringify(raw.content_keys);
    }
    // 停用的内容签名公钥指纹（复核 S8A-18：随包公钥“始终可信”，旧钥泄露后须能停用）
    if (raw.content_keys_revoked !== undefined) {
      const ok = Array.isArray(raw.content_keys_revoked) && raw.content_keys_revoked.length <= 16 && raw.content_keys_revoked.every((k) => typeof k === "string" && /^[A-Za-z0-9_-]{16}$/.test(k));
      if (!ok) problems.push("content_keys_revoked 须为至多 16 个公钥指纹（16 位）");
      else env.ZR_CONTENT_KEYS_REVOKED = JSON.stringify(raw.content_keys_revoked);
    }
  }
  // 支持服务（第 9 批 S13）：律师确认上传的脱敏诊断包；缺省不配置 = 只能导出文件
  pair("support_base", "support_pins", "ZR_SUPPORT_BASE", "ZR_SUPPORT_PINS");
  // 自动更新（W7）：更新源地址、钉住集与发布签名公钥只认这里（主进程使用，不进内核环境）；三项缺一即不检查更新
  let update = null;
  if (raw.update_base !== undefined) {
    const base = httpsUrl(raw.update_base);
    const pins = pinList(raw.update_pins);
    const keys = Array.isArray(raw.update_keys) ? raw.update_keys.map(String).filter((k) => /^[A-Za-z0-9+/]{40,120}={0,2}$/.test(k)) : [];
    if (!base) problems.push("update_base 必须是 https 地址");
    else if (!pins) problems.push("update_pins 须为至少两把 sha256/<base64> 钉住值（当前 + 备份）");
    else if (keys.length === 0 || keys.length !== raw.update_keys.length) problems.push("update_keys 须为 Ed25519 公钥（SPKI DER base64）列表");
    else {
      // 可选：Authenticode 发布者（代码签名证书主体 CN，正式证书到位后填写）——更新安装前另行核对
      const publishers = Array.isArray(raw.update_publishers) ? raw.update_publishers.map(String).filter((x) => x.length > 0 && x.length <= 200) : [];
      update = { base, pins, keys, publishers, channel: raw.update_channel === "beta" ? "beta" : "latest" };
    }
  }
  return { env, problems, update };
}

/** 安装包形态的内核环境：进程环境只取白名单里的系统变量，再叠加 release.json 与严格传输策略（其余由主进程逐项写定）。 */
function packagedKernelEnv(processEnv, release) {
  const base = {};
  for (const [k, v] of Object.entries(processEnv)) if (OS_ENV_ALLOW.has(k.toUpperCase()) && typeof v === "string") base[k] = v;
  return { ...base, ...release.env, ZR_UPSTREAM_TLS: "strict", ZR_MODEL_PROVIDER: "upstream" };
}

/**
 * 内核子进程的完整环境（复核 C-A15：从 main.cjs 抽出，可单测）。安装包形态：白名单系统变量 + release.json + 写定的数据目录与入口；
 * 开发形态：进程环境原样，数据目录与入口允许覆盖。随包运行时（runtimeEnv）最后叠加。
 */
function kernelChildEnv(o) {
  const base = o.packaged ? packagedKernelEnv(o.processEnv, o.release ?? { env: {} }) : o.processEnv;
  const pick = (k, fallback) => (!o.packaged && o.processEnv[k]) || fallback;
  // 安装包形态：子进程入口只来自核验过的随包运行时（runtimeEnv），不下发指向 asar 内并不存在的文件的缺省入口；
  // 缺项即运行时损坏（复核 B4-A20）。v5 SDK 宿主已退役（K9-1），没有它的入口
  if (o.packaged) {
    for (const k of ["ZR_EGRESS_GATE_ENTRY", "ZR_KAP_HOST_ENTRY"]) if (!(o.runtimeEnv && o.runtimeEnv[k])) throw new Error(`随包运行时缺少 ${k}`);
  }
  return {
    ...base,
    ...(o.packaged ? { ZR_REQUIRE_CONTROL_PLANE: "1", ZR_AT_REST: "required" } : {}),
    ...(o.isDev ? {} : { ZR_KERNEL_TCP: "off" }),
    ZR_KERNEL_DATA_DIR: pick("ZR_KERNEL_DATA_DIR", o.paths.dataDir),
    ...(o.packaged
      ? {}
      : {
          ZR_EGRESS_GATE_ENTRY: pick("ZR_EGRESS_GATE_ENTRY", o.paths.gateEntry),
          ZR_KAP_HOST_ENTRY: pick("ZR_KAP_HOST_ENTRY", o.paths.kapEntry),
        }),
    ...(o.runtimeEnv ?? {}),
  };
}

module.exports = { loadReleaseConfig, packagedKernelEnv, kernelChildEnv, ROUTING_ENV, OS_ENV_ALLOW };
