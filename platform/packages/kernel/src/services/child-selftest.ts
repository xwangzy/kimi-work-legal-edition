/**
 * 随包子进程自检（第 52 批；补偏离 D-215 的验证缺口）：安装后冒烟以前只看 kernel.status 里“闸门对象存在”——闸门按需拉起，
 * 进程从未拉起时也报 true（D-215 修复前的 Windows CI 冒烟照样写 egress_gate: true），所以冒烟抓不到“安装包里子进程全部拉不起来”。
 * 这里经产品同一代码路径逐个真拉起：
 *
 * - gate：KernelGate.ensure()（与模型、检索、控制面请求同一入口）→ 闸门进程在运行；
 * - parse：parseWithPipeline 解析一份内存里生成的单页文本 PDF（与材料导入同一入口；文本层不触发 OCR）→ 读回约定文字；
 * - kap：Agent 宿主客户端拉起（或复用）宿主并完成 init/ready 握手（闸门先就绪，与任务同一入口）；
 * - w：宿主按本机执行域配置拉起一次 W 监督进程，跑完它自带的启动自检（权限模型、DNS 不可用、一次真实 worker 往返 echo + python3）后关闭。
 *
 * 不发任何网络请求、不调用模型、不读写事项数据；结果只含结果码（"ok" 或封闭枚举的原因码），不含路径、报错原文与任何内容。
 * 只由主进程的安装冒烟经专用消息调用（electron-entry.ts 的 kernel.child_selftest），不在界面可调的内核方法表里。
 */
import { gateStartFailure } from "../egress/kernel-gate.ts";
import { slog } from "@zr-legal/safe-log";

export interface ChildSelftestResult {
  gate: string;
  parse: string;
  kap: string;
  w: string;
}

export interface ChildSelftestDeps {
  gate: { ensure(): Promise<unknown>; readonly running: boolean };
  /** 解析一份 PDF（产品的材料解析入口），返回逐页文本。 */
  parse: (pdf: Buffer, filename: string) => Promise<{ text: string }>;
  kap: { selftest(timeoutMs?: number): Promise<{ kap: string; w: string }> };
  /** 各项的上限（毫秒）：闸门 30 秒、解析 60 秒、宿主 + 执行域 150 秒。 */
  timeouts?: Partial<Record<"gate" | "parse" | "kap", number>>;
}

/** 解析自检读回的约定文字（ASCII，Type1 Helvetica 文本层）。 */
export const PARSE_SELFTEST_TEXT = "kwl child selftest 42";

/**
 * 单页文本 PDF（与 @zr-legal/parse-ocr 的测试用最小 PDF 生成器同一结构；不从该包根入口引入——根入口会把 OCR 原生依赖打进内核包）。
 * 带正确 xref，pdfjs 可直接解析。
 */
export function selftestPdf(text = PARSE_SELFTEST_TEXT): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((off) => `${String(off).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const CODE = /^[a-z][a-z0-9_]{0,39}$/;
const TIMEOUT = Symbol("timeout");

function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** 只放行形如结果码的字符串（防止将来哪一步把报错原文当结果码带出来）。 */
const safeCode = (v: unknown): string => (typeof v === "string" && CODE.test(v) ? v : "other");

/** 解析进程拉不起来或结果不对的原因码（按 worker-client 的固定报错归类）。 */
export function parseSelftestFailure(e: unknown): "spawn_failed" | "timeout" | "exited_early" | "parse_error" | "other" {
  const msg = String((e as Error)?.message ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  if (msg.includes("启动失败") || code === "ENOENT" || code === "EACCES" || code === "EPERM") return "spawn_failed";
  if (msg.includes("超时")) return "timeout";
  if (msg.includes("异常退出") || msg.includes("连续异常")) return "exited_early";
  if (code === "parse_unsafe" || code === "unsupported_file") return "parse_error";
  return "other";
}

async function checkGate(d: ChildSelftestDeps): Promise<string> {
  try {
    const r = await within(d.gate.ensure(), d.timeouts?.gate ?? 30_000);
    if (r === TIMEOUT) return "timeout";
    return d.gate.running ? "ok" : "not_running";
  } catch (e) {
    return gateStartFailure(e);
  }
}

async function checkParse(d: ChildSelftestDeps, pdf: Buffer): Promise<string> {
  try {
    const r = await within(d.parse(pdf, "kwl-selftest.pdf"), d.timeouts?.parse ?? 60_000);
    if (r === TIMEOUT) return "timeout";
    return r.text.includes(PARSE_SELFTEST_TEXT) ? "ok" : "wrong_output";
  } catch (e) {
    return parseSelftestFailure(e);
  }
}

async function checkKap(d: ChildSelftestDeps): Promise<{ kap: string; w: string }> {
  const limit = d.timeouts?.kap ?? 150_000;
  try {
    const r = await within(d.kap.selftest(limit - 5_000), limit);
    if (r === TIMEOUT) return { kap: "timeout", w: "timeout" };
    return { kap: safeCode(r.kap), w: safeCode(r.w) };
  } catch {
    return { kap: "other", w: "host_unavailable" };
  }
}

/** 逐个真拉起随包子进程。闸门先行（宿主依赖闸门），随后解析进程与宿主（含执行域）并行。 */
export async function runChildSelftest(d: ChildSelftestDeps): Promise<ChildSelftestResult> {
  const gate = await checkGate(d);
  const [parse, kw] = await Promise.all([checkParse(d, selftestPdf()), checkKap(d)]);
  const result = { gate: safeCode(gate), parse: safeCode(parse), kap: kw.kap, w: kw.w };
  slog.event("KERNEL_CHILD_SELFTEST", result);
  return result;
}
