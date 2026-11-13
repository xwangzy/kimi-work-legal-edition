/**
 * 用例里闸门的本机通道地址。POSIX 是目录下的 Unix 域套接字文件；Windows 上 Node 只能在命名管道（`\\.\pipe\…`）上监听，
 * 给普通文件路径会 `listen EACCES`（Windows CI run 43435998778 里 egress-gate 7 个文件与 kap-host/host-egress 全部因此秒挂）。
 * 产品自己也是这样分的：kernel `config.ts` 的 `defaultGatePath`。
 *
 * 管道名取临时目录名（mkdtemp 已随机）+ 文件名，同一目录同一名字两次调用得到同一地址。
 */
import { connect } from "node:net";
import { basename, join } from "node:path";

export const IPC_IS_PIPE = process.platform === "win32";

export function ipcPath(dir: string, name: string): string {
  if (!IPC_IS_PIPE) return join(dir, name);
  return `\\\\.\\pipe\\kwl-test-${basename(dir)}-${name}`;
}

/** 通道上是否有人在监听（Windows 的命名管道没有文件可查，只能连一下）。 */
export function ipcListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}
