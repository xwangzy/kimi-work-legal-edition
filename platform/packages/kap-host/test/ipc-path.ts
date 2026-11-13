/**
 * 用例里本机通道（假模型、工具服务、闸门）的地址。POSIX 是目录下的 Unix 域套接字文件；Windows 上 Node 只能在命名管道
 * （`\\.\pipe\…`）上监听，给普通文件路径会 `listen EACCES`（Windows CI run 43435998778：host-egress 秒挂，p1/p2 的假模型
 * 起不来、第一个端到端用例等满 300 秒）。产品自己也是这样分的：kernel `config.ts` 的 `defaultGatePath`。
 *
 * 管道名取临时目录名（mkdtemp 已随机）+ 文件名，同一目录同一名字两次调用得到同一地址。
 */
import { basename, join } from "node:path";

export function ipcPath(dir: string, name: string): string {
  if (process.platform !== "win32") return join(dir, name);
  return `\\\\.\\pipe\\kwl-test-${basename(dir)}-${name}`;
}
