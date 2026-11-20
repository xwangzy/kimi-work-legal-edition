/**
 * 安装后冒烟的入口与结果写出（复核 B4-A08）：`KWL_SMOKE=1 KimiWorkLegal.exe --kwl-smoke=<结果文件>`。
 * - 只在同时设置环境变量 KWL_SMOKE=1 时进入（一个快捷方式参数不足以触发；runAsNode 与 NODE_OPTIONS 熔断已关，环境变量不扩大攻击面）；
 * - 结果文件：绝对路径、扩展名 .json、不得是 UNC 或设备路径（Windows 上必须是本地盘符路径），且不得已存在（不覆盖任何文件）；
 * - 结果只写错误代码，不写原始异常消息（将来的内核消息可能带路径或事项名）。
 * 冒烟在本账户的真实数据目录上启动一次内核（IT 部署说明须写明）。纯函数，可在 Node 下单测。
 */
const fs = require("node:fs");
const path = require("node:path");

const ERROR_CODES = new Set([
  "runtime",
  "db_key",
  "already_running",
  "kernel_ready_timeout",
  "kernel_fatal",
  "kernel_exited",
  "kernel_status_failed",
  "ocr_unavailable",
  "renderer_load_timeout",
  "renderer_not_mounted",
  "ui_boot_stuck",
  // 第 52 批：随包子进程逐个真拉起（偏离 D-215 的验证缺口）
  "child_selftest_failed",
  "child_gate_failed",
  "child_kap_failed",
  "child_w_failed",
  "child_parse_failed",
  "internal",
]);

/** 随包子进程自检的各项（顺序即失败时报哪一项：闸门起不来，宿主与执行域必然跟着失败，报闸门）。 */
const CHILD_CHECKS = ["gate", "kap", "w", "parse"];
const CHILD_CODE = /^[a-z][a-z0-9_]{0,39}$/;

/** 内核自检结果 → 冒烟结果里的 checks.children：只留四项，值只认 "ok" 或形如原因码的字符串，缺项记 missing。 */
function sanitizeChildren(raw) {
  const out = {};
  for (const k of CHILD_CHECKS) {
    const v = raw && typeof raw === "object" ? raw[k] : undefined;
    out[k] = typeof v === "string" && CHILD_CODE.test(v) ? v : "missing";
  }
  return out;
}

/** 第一项不是 ok 的子进程对应的失败代码；全部 ok 返回 null。 */
function childrenFailure(children) {
  for (const k of CHILD_CHECKS) if (!children || children[k] !== "ok") return `child_${k}_failed`;
  return null;
}

/**
 * 解析冒烟参数：{ requested: 命令行是否带了冒烟参数, out: 结果文件 | null, problem: 拒绝原因 | null }。
 * 带了参数却被拒绝时，调用方应直接以退出码 3 结束（不进入正常界面，也不写任何文件）。
 */
function parseSmokeArg(argv, env, platform = process.platform, exists = fs.existsSync) {
  const a = (argv ?? []).find((x) => typeof x === "string" && x.startsWith("--kwl-smoke="));
  if (!a) return { requested: false, out: null, problem: null };
  const no = (problem) => ({ requested: true, out: null, problem });
  if ((env ?? {}).KWL_SMOKE !== "1") return no("冒烟须同时设置环境变量 KWL_SMOKE=1");
  const out = a.slice("--kwl-smoke=".length);
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!out || out.includes("\0")) return no("结果文件路径为空");
  if (/^[\\/]{2}/.test(out)) return no("结果文件不得是网络路径或设备路径");
  if (platform === "win32" && !/^[A-Za-z]:\\/.test(out)) return no("结果文件须是本地盘符下的绝对路径");
  if (!p.isAbsolute(out)) return no("结果文件须是绝对路径");
  if (p.extname(out).toLowerCase() !== ".json") return no("结果文件扩展名须为 .json");
  if (exists(out)) return no("结果文件已存在（不覆盖任何文件）");
  return { requested: true, out, problem: null };
}

/** 冒烟里的失败：只带固定代码。 */
class SmokeFailure extends Error {
  constructor(code) {
    super(code);
    this.smokeCode = ERROR_CODES.has(code) ? code : "internal";
  }
}

/** 写结果文件：已存在即失败（flag wx）；error 只保留登记的代码。 */
function writeSmokeResult(file, result) {
  const safe = { ...result };
  if (safe.error !== undefined) safe.error = ERROR_CODES.has(safe.error) ? safe.error : "internal";
  if (safe.checks && safe.checks.children !== undefined) safe.checks = { ...safe.checks, children: sanitizeChildren(safe.checks.children) };
  fs.writeFileSync(file, JSON.stringify(safe, null, 2), { flag: "wx" });
}

module.exports = { parseSmokeArg, writeSmokeResult, SmokeFailure, ERROR_CODES, CHILD_CHECKS, sanitizeChildren, childrenFailure };
