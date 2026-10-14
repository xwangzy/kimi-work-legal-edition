/**
 * 本地持久任务队列（方案 v5.0 第 4 篇 §6.1：v4.0 的 DBOS 依赖 PostgreSQL，
 * 本机与所内节点都是单进程内核，改用基于 SQLite 的本地持久任务队列，语义保留）：
 *
 * | 语义 | 本机实现 |
 * |---|---|
 * | 任务 / 尝试 / 步骤检查点 | 每步完成即落 step_checkpoints；客户端重启、断电、崩溃后从最后检查点继续 |
 * | 幂等 | 工具操作以「任务 ID + 步骤 + 输入 hash」为键（executor 内）；成果写入以内容 hash 去重 |
 * | 取消与急停 | 协作式：每步前检查权威状态；取消后不再批准新动作（Agent 急停另经任务令牌撤销） |
 * | 预算 | 入队预留、成功结算、失败/取消释放（executor 内） |
 * | 归属 | 任务由发起它的主机执行；事件同步后其他成员可见（同步在 G0 第 5–6 周） |
 *
 * 崩溃恢复：内核启动时把中断的（running/queued）任务重新排队；被中断的尝试标记
 * interrupted，新尝试从检查点续跑（已完成步骤不重放）。步骤至少执行一次，步骤函数
 * 按幂等设计（事件 ON CONFLICT、成果以内容 hash 去重）。
 */
import { hostname } from "node:os";
import type { KernelDb } from "./db.ts";

export const WORKER_ID = `${hostname()}:${process.pid}`;

export interface WorkflowContext {
  runId: string;
  attemptId: string;
  /** 步骤检查点：同名步骤已完成则直接返回缓存结果，不重放。 */
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
}

export type WorkflowFn = (ctx: WorkflowContext) => Promise<void>;

interface QueuedRun {
  runId: string;
}

// v9 第 04 篇 §8：终态集合（与 @zr-legal/domain TERMINAL_RUN_STATUSES 一致）；reconciling 不是终态但须等人处理，不自动拉起
const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled", "expired", "timed_out"]);

export class TaskQueue {
  private readonly workflows = new Map<string, WorkflowFn>();
  private readonly pending: QueuedRun[] = [];
  private readonly running = new Set<string>();
  /** 退出模式下暂停的任务（启动时与运行中进入退出模式时；复核 S6-B34、S6-C12）。 */
  private parked: string[] = [];
  /** 拉起任务前的放行判断（退出模式下不拉起，任务暂停）。 */
  private startGate: (() => boolean) | null = null;
  private readonly concurrency: number;
  private readonly db: KernelDb;
  private onSettle: ((runId: string) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(db: KernelDb, opts: { concurrency?: number } = {}) {
    this.db = db;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
  }

  register(name: string, fn: WorkflowFn): void {
    this.workflows.set(name, fn);
  }

  setOnSettle(cb: (runId: string) => void): void {
    this.onSettle = cb;
  }

  /** 拉起任务前的放行判断：返回 false 时任务暂停（不拉起），由 resumeParked 恢复（复核 S6-C12：运行中进入退出模式与重启口径一致）。 */
  setStartGate(gate: () => boolean): void {
    this.startGate = gate;
  }

  /** 入队（exactly-once：只有 queued 状态的 run 会被拉起；workflowID = run_id）。 */
  enqueue(runId: string): void {
    if (this.stopped) return;
    if (this.running.has(runId) || this.pending.some((p) => p.runId === runId)) return;
    this.pending.push({ runId });
    this.kick();
  }

  /**
   * 内核启动恢复（v9 第 04 篇 §8；审查 R-05）：执行中的尝试一律中断（其任务令牌随之失效）；
   * running 按状态机迁到 recovering（不再绕过状态机直接改回 queued），由工作流从检查点决定继续、对账或失败；
   * queued/recovering 重新入队；waiting_* 与 budget_paused 是人的决策点，保持原状等人处理。
   * start=false（退出模式下启动；v9 阶段 6 复核 S6-B34）：只做状态迁移、不入队——任务暂停，退出模式解除后由 resumeParked 入队
   * （不再调用 recover：那会把解除之后新起的尝试也标成中断）。
   */
  recover(o: { start?: boolean } = {}): number {
    const interrupted = this.db.all<{ attempt_id: string }>(`SELECT attempt_id FROM attempts WHERE status = 'running'`, []);
    for (const a of interrupted) {
      this.db.run(`UPDATE attempts SET status = 'interrupted', ended_at = ?, error = 'interrupted_by_restart' WHERE attempt_id = ?`, [
        new Date().toISOString(),
        a.attempt_id,
      ]);
    }
    // 「等待输入/等待审批/预算暂停」是人的决策点：重启不得静默拉起（§2.5）
    const stuck = this.db.all<{ run_id: string; status: string }>(
      `SELECT run_id, status FROM runs WHERE status IN ('queued','running','recovering')`,
      [],
    );
    let n = 0;
    for (const r of stuck) {
      if (r.status === "running") {
        this.db.run(`UPDATE runs SET status = 'recovering', status_version = status_version + 1, updated_at = ? WHERE run_id = ? AND status = 'running'`, [
          new Date().toISOString(),
          r.run_id,
        ]);
      }
      if (o.start === false) this.parked.push(r.run_id);
      else this.enqueue(r.run_id);
      n++;
    }
    return n;
  }

  /** 退出模式解除后：启动时暂停的任务入队（取任务前照常复查权威状态，期间被取消的不会拉起）。返回入队条数。 */
  resumeParked(): number {
    const ids = this.parked.splice(0);
    for (const id of ids) this.enqueue(id);
    return ids.length;
  }

  private kick(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, 0);
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.running.size < this.concurrency && this.pending.length > 0) {
      const { runId } = this.pending.shift()!;
      // 取任务前复查权威状态（可能已被取消）
      const run = this.db.get<{ status: string; scenario: string }>(`SELECT status, scenario FROM runs WHERE run_id = ?`, [runId]);
      if (!run || (run.status !== "queued" && run.status !== "recovering")) continue;
      if (this.startGate && !this.startGate()) {
        if (!this.parked.includes(runId)) this.parked.push(runId);
        continue;
      }
      const wf = this.workflows.get("legalRun");
      if (!wf) throw new Error("workflow legalRun 未注册");
      this.running.add(runId);
      void this.execute(runId, wf)
        .catch((err) => {
          console.error(`[queue] run ${runId} workflow error:`, (err as Error)?.message ?? err);
        })
        .finally(() => {
          this.running.delete(runId);
          this.onSettle?.(runId);
          this.kick();
        });
    }
  }

  private async execute(runId: string, wf: WorkflowFn): Promise<void> {
    const attemptId = `att_${crypto.randomUUID()}`;
    const ctx: WorkflowContext = {
      runId,
      attemptId,
      step: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
        const hit = this.db.get<{ result_json: string | null }>(`SELECT result_json FROM step_checkpoints WHERE run_id = ? AND step_name = ?`, [
          runId,
          name,
        ]);
        if (hit) return hit.result_json === null ? (undefined as T) : (JSON.parse(hit.result_json) as T);
        const result = await fn();
        // 步骤完成即落库；崩溃则在下次执行时重放本步骤（幂等设计兜底）
        this.db.run(`INSERT OR REPLACE INTO step_checkpoints (run_id, step_name, attempt_id, result_json, created_at) VALUES (?,?,?,?,?)`, [
          runId,
          name,
          attemptId,
          result === undefined ? null : JSON.stringify(result),
          new Date().toISOString(),
        ]);
        return result;
      },
    };
    await wf(ctx);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    // 等待在途任务到达检查点（急停由取消流程负责）
    const deadline = Date.now() + 10_000;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  stats(): { pending: number; running: number } {
    return { pending: this.pending.length, running: this.running.size };
  }
}

export { TERMINAL as TERMINAL_RUN_STATUSES };
