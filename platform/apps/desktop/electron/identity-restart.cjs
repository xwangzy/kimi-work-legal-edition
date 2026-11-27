"use strict";
/**
 * 按新身份重启内核的编排（第 13 批；复核 B13-K03 抽出可测）：先有序关闭、再拉起。
 * - 应用正在退出或安装更新（exiting() 为真，只增不减）时：关闭之后不再拉起——否则会在退出/安装途中重新拉起内核，
 *   留下占用安装目录的子进程；
 * - 拉起失败（如随包运行时缺件）：广播 stopped 并给出可读说明，不让界面停在“正在完成激活…”；Promise 不再拒绝。
 * - 同一时刻只有一次重启。第 72 批（A1 H4）：重启期间再来的请求**不丢弃**——在本次开始拉起（start，读激活记录与交接）
 *   之前到达的，由本次一并满足；之后才到达的，本次结束后再补跑一次（期间来几次都合并成一次，说明文字取最后一次的）。此前直接返回正在跑的那次：路径 B 的第一次重启（切到待激活）还没结束时又来“按新身份重启”，
 *   新激活记录就永远不生效，界面停在“还没有打开成功，请关闭并重新打开应用”。补跑的 Promise 在补跑结束时兑现。
 * - stats()：已跑完的重启次数与最近一次的结果、耗时（主进程“重拉内核”与计时日志用）。
 */
function createIdentityRestart({ stop, start, exiting, broadcast, onError }) {
  let running = null;
  /** 排在当前这次之后的补跑：{ message, promise, resolve }（至多一个）。 */
  let queued = null;
  let done = 0;
  let last = null;
  /** 请求序号；covered = 最近一次开始拉起时已到达的请求序号（之后到达的才需要补跑）。 */
  let seq = 0;
  let covered = 0;
  const once = async (message) => {
    if (exiting()) return "skipped";
    broadcast({ status: "restarting", message });
    await stop();
    if (exiting()) return "skipped";
    covered = seq;
    try {
      await start();
    } catch (e) {
      onError(e);
      broadcast({ status: "stopped", message: "激活已完成，但后台服务没有启动起来。请关闭并重新打开应用；若仍出现，请联系所内 IT。" });
      return "failed";
    }
    if (exiting()) return "skipped";
    broadcast({ status: "running" });
    return "restarted";
  };
  const restart = (message = "正在完成激活…") => {
    seq += 1;
    if (running) {
      if (queued) queued.message = message;
      else {
        let resolve;
        const promise = new Promise((r) => (resolve = r));
        queued = { message, promise, resolve };
      }
      return queued.promise;
    }
    const t0 = Date.now();
    running = (async () => {
      let result = "failed";
      try {
        result = await once(message);
        return result;
      } finally {
        done += 1;
        last = { result, ms: Date.now() - t0 };
        running = null;
        const q = queued;
        queued = null;
        // 补跑：开始拉起之后才到的请求；应用正在退出时 once() 直接返回 skipped。开始拉起之前到的已由本次满足，同一结果
        if (q && seq > covered) {
          seq -= 1; // restart() 会再记一次
          q.resolve(restart(q.message));
        } else if (q) q.resolve(result);
      }
    })();
    return running;
  };
  return { restart, busy: () => running !== null, queued: () => queued !== null, stats: () => ({ done, last }) };
}

module.exports = { createIdentityRestart };
