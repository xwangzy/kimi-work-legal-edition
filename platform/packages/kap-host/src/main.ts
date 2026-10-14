/**
 * Agent 宿主进程入口（v9 第 04 篇 §1.1：Agent 宿主 utilityProcess；开发与测试时由内核以 child_process.fork 拉起）。
 *
 * - 与内核只经 IPC 通道通信（不监听任何端口；控制通道不经 stdout/stderr——阶段 1 复核 M-01：继承 stdout 的进程无法伪造控制消息）；
 * - 内核断开（disconnect）即退出，不成为孤儿；
 * - 进程级 HTTP 出口：全局调度器只认 gate.kwl / tools.kwl——模型、检索、抓取转到出站闸门进程（唯一出口），法律 MCP 转到内核本机端点；
 * - 每次运行的令牌与事项策略由内核随 startRun 下发（宿主不自行签发、不自行判定数据级别）；
 * - G0：同一事项同时只允许一个活动运行——法律 MCP 的工具令牌因此按运行归属，运行结束即失效（阶段 2 审查 S2-11）。
 *
 * 协议（JSON 消息）：
 *   内核 → 宿主：{t:"init", config} | {t:"call", id, method, params} | {t:"kresult", id, ok, result | error} | {t:"shutdown"}
 *   宿主 → 内核：{t:"ready", capabilities} | {t:"result", id, ok, result | error} | {t:"event", run_id, event} | {t:"kcall", id, method, params}
 *   kcall 只有宿主策略所需的只读查询（W1：检索式预筛 screenSearch），由内核按事项记录作答。
 */
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setGlobalDispatcher } from "undici";
import { ManifestRegistry, type ToolManifest } from "@zr-legal/host-policy";
import { configureTrustedRipgrep } from "../vendor/kap-embed/kap-embed.mjs";
import { MatterKeyRing, type ZonePurpose } from "@zr-legal/at-rest";
import { HostEgressDispatcher } from "./host-egress.ts";
import { KapRuntime, RuntimeError, type MatterPolicy, type RequestOrigin, type StartRunRequest } from "./runtime.ts";
import { wCoreFactory } from "./w-domain.ts";

export interface HostInitConfig {
  /** 宿主数据根（每个事项 <dataRoot>/<matterId>/{home,materials,work}）。 */
  dataRoot: string;
  /** 内核本机端点的套接字/命名管道（法律 MCP /mcp）。 */
  kernelSocket: string;
  /** 出站闸门的套接字/命名管道（模型 /v1、检索 /search、抓取 /fetch；v9 阶段 4）。未给出即模型、检索、抓取一律拒绝（失败关闭）。 */
  gateSocket?: string;
  /** 闸门检索与抓取路由是否可用（未配置即不注册 WebSearch / FetchURL——ZP-11）。 */
  gateRoutes?: { search: boolean; fetch: boolean };
  /**
   * 已废弃（审计 S3 第 2 步）：Grep/Glob 改为宿主内检索，不再使用原生 ripgrep；字段保留只为兼容旧内核，宿主忽略其值。
   */
  trustedRgPath?: string | null;
  /** 法律 MCP 工具清单（内核验签后的锁文件派生）。 */
  manifests: ToolManifest[];
  /** 对 Agent 开放的法律 MCP 工具（服务端原名）。 */
  legalMcpTools: string[];
  /** 执行域：缺省 W-core（第 04 篇 §4.1：默认、所有设备）；"none" = 代码执行关闭。 */
  execDomain?: "w-core" | "none";
  /** 运行 W 的随包 Node 26；缺省：非 Electron 环境用当前 Node。 */
  wNodePath?: string;
  /** 同一事项的并发 worker 数（默认 2）。 */
  wMaxConcurrent?: number;
  /** 内核验签物化的可信区（AGENTS.md 与 skills/）：每个事项只读挂载；缺省无可信区（不加载任何技能）。 */
  trustedDir?: string;
  /** 随包 W 运行时目录与随包 Node 的摘要、锁定版本（安装包形态；scripts/build-runtime.mjs 的清单）。 */
  wRuntimeDir?: string;
  wNodeSha256?: string;
  wNodeVersion?: string;
  /**
   * 落盘加密（审计 S3 第 1 步）：required = 每次运行必须带事项区密钥，否则拒绝运行（安装包形态）；缺省 = 有密钥就加密（开发与测试）。
   */
  atRest?: "required" | "optional";
}

export interface StartRunParams {
  request: StartRunRequest & { run_id: string };
  origin: RequestOrigin;
  matter_policy: MatterPolicy;
  model_token: string;
  tools_token: string | null;
  /** 本次运行授权的材料快照（宿主写入事项材料区，只读暴露给 Agent；有区密钥时以密文落盘、盘上文件名中性化）。 */
  materials: { filename: string; text: string }[];
  /** 本事项的落盘加密区密钥（内核按事项工作区密钥派生；宿主只在内存持有）。 */
  at_rest?: { gen_current: number; keys: Record<string, Partial<Record<ZonePurpose, string>>> };
}

type Msg =
  | { t: "init"; config: HostInitConfig }
  | { t: "call"; id: number; method: string; params: any }
  | { t: "kresult"; id: number; ok: boolean; result?: any; error?: { message?: string } }
  | { t: "shutdown" };

/** 宿主 → 内核的只读查询（检索式预筛）；超时或内核断开即失败（调用方按“交闸门筛查”处理）。 */
let kcallSeq = 0;
const kcallPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
function kernelCall<T>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!process.connected) return reject(new Error("内核未连接"));
    const id = ++kcallSeq;
    const timer = setTimeout(() => {
      kcallPending.delete(id);
      reject(new Error(`内核查询超时：${method}`));
    }, timeoutMs);
    timer.unref();
    kcallPending.set(id, { resolve, reject, timer });
    process.send?.({ t: "kcall", id, method, params });
  });
}

const send = (m: unknown): void => {
  if (process.connected) process.send?.(m);
};

function safeName(s: string): string {
  return s.replace(/[\\\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "material";
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export async function startHost(): Promise<void> {
  if (!process.send) {
    console.error("kap-host 必须由内核经 IPC 拉起");
    process.exit(2);
  }
  // 纵深：这些变量在任何情况下不得影响引擎（升级闸门：rebase 前先 revert #4059）
  delete process.env.KIMI_CODE_TRUST_WORKSPACE;
  let runtime: KapRuntime | null = null;
  let config: HostInitConfig | null = null;
  const perRun = new Map<string, { matterId: string; modelToken: string; toolsToken: string | null }>();
  const activeByMatter = new Map<string, string>();
  const pendingPolicy = new Map<string, MatterPolicy>();
  /** 事项 → 落盘加密密钥环（第一次运行时由内核下发；引擎在打开时使用；宿主退出时清零）。 */
  const keyrings = new Map<string, MatterKeyRing>();
  /** 事项 → 当前密钥环的代集合签名（换代或首次下发时重开引擎）。 */
  const keyringSig = new Map<string, string>();
  const layout = (mid: string) => {
    if (!config) throw new Error("not initialized");
    if (!SAFE_ID.test(mid)) throw new RuntimeError("validation", "非法事项 ID");
    const base = join(config.dataRoot, mid);
    return {
      homeDir: join(base, "home"),
      materialsDir: join(base, "materials"),
      workDir: join(base, "work"),
      legalMcpTools: config.legalMcpTools,
      ...(config.trustedDir ? { trustedDir: config.trustedDir } : {}),
      ...(keyrings.has(mid) ? { keyring: keyrings.get(mid)! } : {}),
    };
  };

  /** 材料快照只在运行期间存在（审计 S3 1-11）：运行结束即删除，宿主启动时清扫上次异常退出留下的。 */
  const clearMaterials = (mid: string) => {
    if (!config || !SAFE_ID.test(mid)) return;
    const dir = join(config.dataRoot, mid, "materials");
    try {
      for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
    } catch {
      // 目录不存在
    }
  };

  const release = (runId: string) => {
    const r = perRun.get(runId);
    if (!r) return;
    perRun.delete(runId);
    if (activeByMatter.get(r.matterId) === runId) {
      activeByMatter.delete(r.matterId);
      clearMaterials(r.matterId);
    }
  };

  const methods: Record<string, (p: any) => Promise<unknown> | unknown> = {
    async startRun(p: StartRunParams) {
      const mid = p.request.matter_id;
      if (activeByMatter.has(mid)) throw new RuntimeError("conflict", "本事项已有运行中的任务（G0：同一事项同时只运行一个任务）");
      // 落盘加密：安装包形态必须有区密钥（失败关闭）；密钥环在本事项引擎打开前就位。
      // 复核 S3B-A10：下发的代集合变了（换代），或本事项此前以无密钥（开发形态）打开过引擎——关闭引擎、换密钥环、下次运行按新密钥重开
      if (p.at_rest) {
        // 签名含代集合与密钥指纹（同一代的密钥值变化也重开；复核 A 处置复核 N2）
        const sig = createHash("sha256").update(JSON.stringify([p.at_rest.gen_current, Object.entries(p.at_rest.keys ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))])).digest("hex");
        if (keyringSig.get(mid) !== sig) {
          await runtime!.closeMatterEngine(mid);
          keyrings.get(mid)?.wipe();
          keyrings.set(mid, MatterKeyRing.fromWire(p.at_rest));
          keyringSig.set(mid, sig);
        }
      }
      if (config?.atRest === "required" && !keyrings.has(mid)) throw new RuntimeError("unavailable", "缺少本事项的落盘加密密钥：拒绝运行（不以明文保存会话）");
      const l = layout(mid);
      // 材料快照：每次运行重写（宿主是可信方；Agent 对材料区只读）。审计 S3 第 2 步：有区密钥即以 KWE1 密文写入（材料区为严格形态）；
      // 盘上文件名中性化（001.txt…），原文件名（令牌形态）只出现在提示词的清单里——文件名本身可能含未登记的机构名
      mkdirSync(l.materialsDir, { recursive: true });
      for (const f of readdirSync(l.materialsDir)) rmSync(join(l.materialsDir, f), { recursive: true, force: true });
      const sealer = l.keyring?.zone("materials") ?? null;
      const names: string[] = [];
      p.materials.forEach((m, i) => {
        const name = `${String(i + 1).padStart(3, "0")}.txt`;
        const plain = Buffer.from(m.text, "utf8");
        writeFileSync(join(l.materialsDir, name), sealer ? sealer.seal(plain) : plain, { mode: 0o600 });
        plain.fill(0);
        names.push(`${name}（${safeName(m.filename)}）`);
      });
      perRun.set(p.request.run_id, { matterId: mid, modelToken: p.model_token, toolsToken: p.tools_token });
      activeByMatter.set(mid, p.request.run_id);
      pendingPolicy.set(mid, p.matter_policy);
      // 工作区位置总要告诉模型（无材料的任务也要写草稿；核查 P0-1 联调发现）
      const goal =
        names.length > 0
          ? `${p.request.goal}\n\n【本事项材料快照（只读）】位于 ${l.materialsDir}（括号内为原文件名）：\n${names.map((n) => `- ${n}`).join("\n")}\n可用 Read / Grep 查阅；草稿写入工作区 ${l.workDir}。`
          : `${p.request.goal}\n\n【本任务未附材料】草稿写入工作区 ${l.workDir}。`;
      try {
        return await runtime!.startRun({ ...p.request, goal }, p.origin);
      } catch (e) {
        release(p.request.run_id);
        throw e;
      } finally {
        pendingPolicy.delete(mid);
      }
    },
    events: (p: { run_id: string; after?: number; origin: RequestOrigin }) => runtime!.events(p.run_id, p.after ?? 0, p.origin),
    answer: (p: { run_id: string; request: any; origin: RequestOrigin }) => runtime!.answer(p.run_id, p.request, p.origin),
    approve: (p: { approval_id: string; request: any; approver: RequestOrigin }) => runtime!.approve(p.approval_id, p.request, p.approver),
    async cancel(p: { run_id: string; request: any; origin: RequestOrigin }) {
      const r = await runtime!.cancel(p.run_id, p.request, p.origin);
      release(p.run_id);
      return r;
    },
    artifacts: (p: { run_id: string; origin: RequestOrigin }) => runtime!.artifacts(p.run_id, p.origin),
    /**
     * 撤权擦除（审计 S3 1-4）：本机律师被移出事项、本设备被吊销或事项删除时，内核要求关闭该事项的引擎、清零密钥环并删除其全部 Agent 数据
     * （会话、事件日志、工作区草稿、材料快照）；内核随后删除工作区密钥。
     */
    async purgeMatter(p: { matter_id: string }) {
      const mid = String(p?.matter_id ?? "");
      if (!SAFE_ID.test(mid) || !config) throw new RuntimeError("validation", "非法事项 ID");
      if (activeByMatter.has(mid)) throw new RuntimeError("conflict", "该事项有进行中的任务，结束后再清理");
      await runtime!.closeMatterEngine(mid);
      keyrings.get(mid)?.wipe();
      keyrings.delete(mid);
      keyringSig.delete(mid);
      rmSync(join(config.dataRoot, mid), { recursive: true, force: true });
      return { ok: true };
    },
    capabilities: () => runtime!.capabilities(),
  };

  process.on("message", (raw: unknown) => {
    const msg = raw as Msg;
    void (async () => {
      if (msg?.t === "init") {
        if (runtime) return send({ t: "ready", already: true });
        // 数据根取规范路径：告诉模型的工作区路径必须与 broker 的规范根一致（macOS /var → /private/var、Windows 短文件名与目录联接），
        // 否则 Agent 按提示词写入会被判为区外而失败（核查 P0-1 联调发现）
        mkdirSync(msg.config.dataRoot, { recursive: true });
        config = { ...msg.config, dataRoot: realpathSync.native(msg.config.dataRoot) };
        // 启动清扫：上次异常退出时留下的材料快照（此时没有任何运行）
        for (const mid of readdirSync(config.dataRoot)) clearMaterials(mid);
        // Grep/Glob 的检索入口（审计 S3 第 2 步）：宿主内检索。上游 rgLocator（ZP-20）只认宿主登记的、已存在的普通文件——登记一个
        // 不可执行的占位文件；执行域路由按字面匹配后交宿主内检索，从不交给操作系统执行
        const searchEntry = join(config.dataRoot, ".kwl-host-search");
        writeFileSync(searchEntry, "Kimi Work Legal host search entry (never executed)\n", { mode: 0o600 });
        configureTrustedRipgrep(searchEntry);
        runtime = new KapRuntime({
          matterLayout: layout,
          atRestActive: () => config?.atRest === "required" || keyrings.size > 0,
          matterPolicy: (mid) => pendingPolicy.get(mid) ?? null,
          modelToken: ({ runId }) => perRun.get(runId)?.modelToken ?? "",
          toolsToken: (mid) => {
            const rid = activeByMatter.get(mid);
            return rid ? (perRun.get(rid)?.toolsToken ?? null) : null;
          },
          manifests: new ManifestRegistry(config.manifests),
          trustedRgPath: searchEntry,
          ...(config.execDomain === "none"
            ? {}
            : {
                execDomainFactory: wCoreFactory({
                  ...(config.wNodePath ? { nodePath: config.wNodePath } : {}),
                  ...(config.wMaxConcurrent ? { maxConcurrent: config.wMaxConcurrent } : {}),
                  ...(config.wRuntimeDir ? { runtimeDir: config.wRuntimeDir } : {}),
                  ...(config.wNodeSha256 ? { nodeSha256: config.wNodeSha256 } : {}),
                  ...(config.wNodeVersion ? { nodeVersion: config.wNodeVersion } : {}),
                }),
              }),
          searchConfigured: config.gateRoutes?.search ?? false,
          fetchConfigured: config.gateRoutes?.fetch ?? false,
          screenSearch: (run, query) => kernelCall<{ needsConfirmation: boolean }>("screenSearch", { run_id: run.runId, matter_id: run.matterId, query }),
          logLevel: "silent",
          onRunText: (runId, text) => send({ t: "text", run_id: runId, text }),
          onRunEvent: (runId, event) => {
            send({ t: "event", run_id: runId, event });
            if (/^run\.(succeeded|partial|failed|cancelled)$/.test(event.type)) release(runId);
          },
        });
        setGlobalDispatcher(new HostEgressDispatcher({ modelSocket: config.gateSocket ?? null, toolsSocket: config.kernelSocket, authority: runtime.authority }));
        send({ t: "ready", capabilities: await runtime.capabilities() });
        return;
      }
      if (msg?.t === "kresult") {
        const p = kcallPending.get(msg.id);
        if (!p) return;
        kcallPending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error?.message ?? "内核查询失败"));
        return;
      }
      if (msg?.t === "call") {
        const fn = methods[msg.method];
        if (!runtime || !fn) return send({ t: "result", id: msg.id, ok: false, error: { code: "not_found", message: `未知方法或未初始化：${msg.method}` } });
        try {
          send({ t: "result", id: msg.id, ok: true, result: await fn(msg.params ?? {}) });
        } catch (e) {
          const code = e instanceof RuntimeError ? e.code : "internal";
          send({ t: "result", id: msg.id, ok: false, error: { code, message: (e as Error)?.message ?? String(e) } });
        }
        return;
      }
      if (msg?.t === "shutdown") {
        await runtime?.close().catch(() => {});
        for (const k of keyrings.values()) k.wipe();
        process.exit(0);
      }
    })();
  });
  // 内核退出或断开即退出（不成为孤儿）
  process.on("disconnect", () => {
    void (async () => {
      await runtime?.close().catch(() => {});
      for (const k of keyrings.values()) k.wipe();
      process.exit(0);
    })();
  });
}

if (process.argv[1] && /main\.(ts|mjs|js)$/.test(process.argv[1])) void startHost();
