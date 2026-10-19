"use strict";
/**
 * 按新身份重启内核的编排（第 13 批；复核 B13-K03 抽出可测）：先有序关闭、再拉起。
 * - 应用正在退出或安装更新（exiting() 为真，只增不减）时：关闭之后不再拉起——否则会在退出/安装途中重新拉起内核，
 *   留下占用安装目录的子进程；
 * - 拉起失败（如随包运行时缺件）：广播 stopped 并给出可读说明，不让界面停在“正在完成激活…”；Promise 不再拒绝。
 * - 同一时刻只有一次重启；重启期间再来的请求合并。
 */
function createIdentityRestart({ stop, start, exiting, broadcast, onError }) {
  let running = null;
  const restart = async () => {
    if (running) return running;
    running = (async () => {
      try {
        if (exiting()) return "skipped";
        broadcast({ status: "restarting", message: "正在完成激活…" });
        await stop();
        if (exiting()) return "skipped";
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
      } finally {
        running = null;
      }
    })();
    return running;
  };
  return { restart, busy: () => running !== null };
}

module.exports = { createIdentityRestart };
