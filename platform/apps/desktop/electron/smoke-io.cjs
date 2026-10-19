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
  "internal",
]);

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
  fs.writeFileSync(file, JSON.stringify(safe, null, 2), { flag: "wx" });
}

module.exports = { parseSmokeArg, writeSmokeResult, SmokeFailure, ERROR_CODES };
