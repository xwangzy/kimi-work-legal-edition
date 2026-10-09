/**
 * 内核级异步互斥（方案 §4.5：8GB 笔记本上 Agent 宿主与 OCR 互斥排队——G0 v0 做内核级互斥）。
 * 单例共享一把锁：agent-host-manager 启动宿主前 acquire、宿主退出 release；
 * 解析/OCR 批次（import/reparse）同理。简单 promise 队列实现，注释即契约。
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
