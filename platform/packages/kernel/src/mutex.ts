/**
 * 内核级异步互斥（方案 §4.5：8GB 笔记本上解析与 OCR 批次排队——G0 v0 做内核级互斥）。
 * 单例共享一把锁：解析/OCR 批次（import/reparse）取锁、结束释放（Agent 运行另有独立槽位 Semaphore，核查 P0-3）。
 * 简单 promise 队列实现，注释即契约。
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /** 排队获取锁；返回 release 函数（必须调用，建议 try/finally）。 */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const wait = this.tail;
    this.tail = this.tail.then(() => next);
    return wait.then(() => release);
  }

  /** 便捷包装：持锁执行 fn 后释放（异常也释放）。 */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * 计数信号量：kap 引擎的开放任务槽位（Kimi Code 集成核查 P0-3）。kap 运行不再占用 Agent/OCR 共用的 ioMutex——
 * 运行可能在“等待律师”上停留数小时，期间材料导入与 OCR 不应被阻塞；内存由 W 执行域的看门狗与并发上限约束（D-14）。
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly slots: number;
  constructor(slots: number) {
    this.slots = Math.max(1, slots);
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.slots) await new Promise<void>((r) => this.waiters.push(r));
    else this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}
