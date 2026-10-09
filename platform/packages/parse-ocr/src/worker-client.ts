/**
 * 解析进程父侧客户端（§8.1：单个 OCR 进程串行处理、页级流水）：
 * 每批次 fork 一个 parse-worker，逐页收集结果；每页超时（默认 30s 可配）杀进程报错；
 * 进程崩毁自动重建重试；OCR 页预算触发计划内换进程续跑（§13 峰值内存控制——
 * 实证 ~70MB/页 的 WASM/OpenCV 递增随旧进程退出归还 OS）；汇总峰值 rss 供内存预算核验。
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DomainError } from "@zr-legal/domain";
import type { OcrModelPaths } from "./ocr-engine.ts";
import type { PageQuality } from "./quality.ts";

export interface ParsedPage extends PageQuality {
  text: string;
  meanScore?: number | undefined;
  rss: number;
}

export interface ParseBatchResult {
  pages: ParsedPage[];
  pageCount: number;
  peakRss: number;
  /** 崩毁重建次数。 */
  restarts: number;
  /** OCR 页预算触发的计划内换进程续跑次数（长文档内存闸门，非故障）。 */
  continuations: number;
}

export interface ParseBatchOptions {
  file: Buffer;
  kind: "pdf" | "image";
  modelPaths?: OcrModelPaths | null;
  /** 测试用 mock 引擎（不加载模型）。 */
  mockOcr?: boolean;
  /** 每页超时（默认 30s）。 */
  pageTimeoutMs?: number;
  /** worker 入口（默认包内 parse-worker.ts；CJS 制品为 parse-worker.bundle.cjs）。 */
  workerEntry?: string;
  /** 崩毁最多重建次数（默认 1）。 */
  maxRestarts?: number;
  /** 单进程 OCR 页预算（默认 10；超过即换进程续跑，见 parse-worker 注释）。 */
  ocrPageBudget?: number;
  /**
   * 额外 env 透传白名单（默认空——处理不可信文件的进程不得持有任何令牌/密钥/口令；
   * 仅测试夹具用（如 KWL_CRASH_MARK），生产调用不传。
   */
  extraEnvAllowlist?: string[];
}

/**
 * 子进程 env 白名单（对齐 agent-host-manager 的最小形态）：只含运行必需项——
 * 解析进程处理不可信文件，绝不继承 ZR_MAAS_TOKEN/ZR_DB_KEY/ZR_INTERNAL_SECRET 等机密。
 */
function workerEnv(extraAllowlist: string[] | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const base = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "COMSPEC", "LANG", "LC_ALL", "TZ"];
  for (const k of [...base, ...(extraAllowlist ?? [])]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function defaultWorkerEntry(): string {
  try {
    return fileURLToPath(new URL("./parse-worker.ts", import.meta.url));
  } catch {
    // CJS 制品：构建脚本产物放制品旁
    if (typeof __dirname !== "undefined") return join(__dirname, "parse-worker.bundle.cjs");
    return "parse-worker.bundle.cjs";
  }
}

export async function runParseBatch(opts: ParseBatchOptions): Promise<ParseBatchResult> {
  const maxRestarts = opts.maxRestarts ?? 1;
  const allPages: ParsedPage[] = [];
  let startPage: number | undefined = undefined;
  let peakRss = 0;
  let crashRestarts = 0;
  let continuations = 0;
  for (;;) {
    let attempt = 0;
    for (;;) {
      try {
        const r = await runOnce(opts, startPage);
        allPages.push(...r.pages);
        peakRss = Math.max(peakRss, r.peakRss);
        if (r.continueFrom !== null) {
          startPage = r.continueFrom; // 计划内换进程续跑（页预算封顶长文档内存）
          continuations += 1;
          break;
        }
        return { pages: allPages, pageCount: r.pageCount, peakRss, restarts: crashRestarts, continuations };
      } catch (e) {
        if (e instanceof WorkerCrash && attempt < maxRestarts) {
          attempt += 1;
          crashRestarts += 1;
          continue; // 崩毁重建（当前 incarnation 重跑：页级幂等，无副作用）
        }
        if (e instanceof WorkerCrash) throw new DomainError("internal", `解析进程连续异常（重建 ${attempt} 次仍失败）：${e.message}`, 500);
        throw e;
      }
    }
  }
}

/** 进程级故障标记（超时/崩毁，可重建重试）。 */
class WorkerCrash extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerCrash";
  }
}

interface RunOnceResult {
  pages: ParsedPage[];
  pageCount: number;
  peakRss: number;
  continueFrom: number | null;
}

function runOnce(opts: ParseBatchOptions, startPage: number | undefined): Promise<RunOnceResult> {
  const entry = opts.workerEntry ?? defaultWorkerEntry();
  const pageTimeoutMs = opts.pageTimeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child: ChildProcess = fork(entry, [], { stdio: ["pipe", "pipe", "inherit", "ipc"], execArgv: [], env: workerEnv(opts.extraEnvAllowlist) });
    const pages: ParsedPage[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGKILL");
          reject(new WorkerCrash(`解析进程单页超时（${Math.round(pageTimeoutMs / 1000)}s 无产出），已终止`));
        }
      }, pageTimeoutMs);
    };

    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        arm(); // 每页（或任何进展）重置超时
        if (msg.t === "page") {
          const { id: _id, t: _t, ...page } = msg;
          pages.push(page as ParsedPage);
        } else if (msg.t === "continue") {
          if (!settled) {
            settled = true;
            if (timer) clearTimeout(timer);
            resolve({ pages, pageCount: 0, peakRss: Number(msg.peakRss ?? 0), continueFrom: Number(msg.nextPageNo) });
          }
        } else if (msg.t === "done") {
          if (!settled) {
            settled = true;
            if (timer) clearTimeout(timer);
            child.kill("SIGTERM");
            resolve({ pages, pageCount: Number(msg.pageCount ?? pages.length), peakRss: Number(msg.peakRss ?? 0), continueFrom: null });
          }
        } else if (msg.t === "error") {
          if (!settled) {
            settled = true;
            if (timer) clearTimeout(timer);
            child.kill("SIGTERM");
            reject(new DomainError(msg.code === "parse_unsafe" || msg.code === "unsupported_file" ? msg.code : "internal", String(msg.message ?? "解析失败"), msg.code === "internal" ? 500 : 422));
          }
        }
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(new WorkerCrash(`解析进程启动失败：${err.message}`));
      }
    });
    child.on("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(new WorkerCrash(`解析进程异常退出（code=${code} signal=${signal}）`));
      }
    });

    arm();
    const req = {
      id: `batch-${process.pid}-${Date.now()}`,
      t: opts.kind === "pdf" ? "parse_pdf" : "parse_image",
      file: opts.file.toString("base64"),
      modelPaths: opts.modelPaths ?? null,
      mockOcr: opts.mockOcr === true,
      ...(startPage !== undefined ? { startPage } : {}),
      ...(opts.ocrPageBudget !== undefined ? { ocrPageBudget: opts.ocrPageBudget } : {}),
    };
    child.stdin!.write(JSON.stringify(req));
    child.stdin!.end();
  });
}

export { defaultWorkerEntry };
