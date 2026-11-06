/**
 * 试用构建（`package-desktop.mjs --trial`，偏离 D-160）：给律师试用的安装包不接中软云端控制面与网关，而是在本机回环端口
 * 拉起一个法律模型网关（electron/trial-gateway.bundle.cjs，utilityProcess），由它持有中软 MaaS 密钥并转发到 MaaS。
 *
 * 与正式安装包的差别（只在 asar 里有 trial.json 时生效；正式构建不会生成它，两者互斥由打包脚本把关）：
 * - 内核不要求控制面开通（不设 ZR_REQUIRE_CONTROL_PLANE），以固定的试用律所/成员标识直接进入；
 * - 上游是本机回环 http（不设 ZR_UPSTREAM_TLS=strict），模型请求仍经出站闸门；
 * - 不配置联网检索（试用网关没有真实检索上游，不给律师看模拟结果）、不配置自动更新；
 * - 落盘加密（ZR_AT_REST=required、DPAPI 主密钥）与其余安装包形态的约束不变。
 *
 * 密钥：打包时用一次性随机密钥 AES-256-GCM 封装进 trial.json，解封密钥经 esbuild define 写进主进程制品——两者都在 asar 里，
 * **这只是防止明文直接被搜到，不是保密**：拿到安装包的人可以还原出密钥（用户 2026-11-06 知情并确认）。
 * 主进程只在启动网关时解封一次，经进程消息交给网关，不进任何进程的环境变量、命令行参数或日志。
 * 本模块无 Electron 依赖，可单测。
 */
const fs = require("node:fs");
const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");

/** 试用律所与成员标识（工作区目录名 trial-firm；租户 ten_trial-firm 与网关签发的席位令牌一致）。 */
const TRIAL_FIRM_SLUG = "trial-firm";
const TRIAL_USER_SLUG = "trial-lawyer";
const TRIAL_TENANT = `ten_${TRIAL_FIRM_SLUG}`;

// 主进程制品里由 esbuild define 替换为本次构建的解封密钥（base64）；开发形态与未经试用打包的制品里没有
/* global __KWL_TRIAL_SEAL__ */
const BUILT_SEAL = typeof __KWL_TRIAL_SEAL__ === "string" ? __KWL_TRIAL_SEAL__ : null;

function sealTrialKey(apiKey, sealKey) {
  if (typeof apiKey !== "string" || apiKey.length < 8) throw new Error("试用密钥为空或过短");
  if (!Buffer.isBuffer(sealKey) || sealKey.length !== 32) throw new Error("封装密钥须为 32 字节");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sealKey, iv);
  const ct = Buffer.concat([c.update(apiKey, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function unsealTrialKey(sealed, sealKeyB64) {
  const key = Buffer.from(String(sealKeyB64 ?? ""), "base64");
  if (key.length !== 32) throw new Error("trial_seal_missing");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  d.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(sealed.ct, "base64")), d.final()]).toString("utf8");
}

function httpsBase(v) {
  try {
    const u = new URL(String(v));
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * 读取 trial.json → null（不是试用构建）| { config, problems }。config 里不含明文密钥：调用 unseal() 才解封。
 */
function loadTrialConfig(file, sealKeyB64 = BUILT_SEAL) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    return { config: null, problems: ["trial.json 无法解析"] };
  }
  const problems = [];
  if (raw.trial !== true) problems.push("trial.json 缺少 trial: true");
  const upstreamBase = httpsBase(raw.upstream_base);
  if (!upstreamBase) problems.push("upstream_base 必须是 https 地址");
  const model = typeof raw.model === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(raw.model) ? raw.model : null;
  if (!model) problems.push("model 格式不对");
  const s = raw.sealed;
  if (!s || typeof s.iv !== "string" || typeof s.tag !== "string" || typeof s.ct !== "string") problems.push("sealed 缺失");
  if (problems.length) return { config: null, problems };
  return {
    problems,
    config: {
      upstreamBase,
      model,
      label: typeof raw.label === "string" && raw.label.length <= 40 ? raw.label : "试用版",
      expires: typeof raw.expires === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.expires) ? raw.expires : null,
      unseal: () => unsealTrialKey(s, sealKeyB64),
    },
  };
}

/** 试用到期（按本机日期，过了 expires 当天即到期；不设 expires 不限）。 */
function trialExpired(config, now = new Date()) {
  if (!config || !config.expires) return false;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return today > config.expires;
}

/**
 * 试用构建的内核环境附加项（叠加在白名单系统变量之上；见 release-config.cjs kernelChildEnv）。
 * gateway 为 null（本机网关没起来）时不配置模型上游：界面照常可用，任务会提示 AI 服务不可用。
 */
function trialKernelEnv(gateway) {
  return {
    ZR_MODEL_PROVIDER: "upstream",
    ZR_FIRM_SLUG: TRIAL_FIRM_SLUG,
    ZR_USER_SLUG: TRIAL_USER_SLUG,
    ...(gateway ? { ZR_GATEWAY_BASE: `http://127.0.0.1:${gateway.port}/v1`, ZR_SEAT_TOKEN: gateway.seatToken } : {}),
  };
}

module.exports = { sealTrialKey, unsealTrialKey, loadTrialConfig, trialExpired, trialKernelEnv, TRIAL_FIRM_SLUG, TRIAL_USER_SLUG, TRIAL_TENANT };
