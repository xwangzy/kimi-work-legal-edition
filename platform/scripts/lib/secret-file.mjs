/**
 * 读密钥/证书类配置文件（cloud-serve 的 *_file 字段共用）。
 *
 * `/dev/fd/<n>`（n ≥ 3）按文件描述符直接读，不按路径打开：stack-local 把上游密钥经 stdio 第 3 路交给网关/检索进程，
 * Node 在 Unix 上的 stdio "pipe" 是 socketpair——macOS 可以按 /dev/fd/3 路径打开，**Linux 打开 /proc/self/fd/3 指向的套接字报 ENXIO**，
 * 子进程读不到密钥退出，父进程那一端随即 ECONNRESET（第 52 批：云端仓库 CI 在 ubuntu-24.04 上冒烟必挂，本机 macOS 照常通过）。
 * 按描述符读两端都行（libuv 交给子进程的 stdio 描述符是阻塞的，读到对端 end() 即 EOF）。
 * 同一描述符只读一次（读完即到 EOF）：同一进程里第二次要同一个 /dev/fd/<n> 时返回第一次读到的内容。
 */
import { readFileSync } from "node:fs";

const FD_PATH = /^\/(?:dev\/fd|proc\/self\/fd)\/(\d{1,4})$/;
const fdCache = new Map();

/** 不是 /dev/fd/<n> 返回 null；n < 3（标准输入输出）不许当密钥来源。 */
export function fdOf(path) {
  const m = FD_PATH.exec(String(path));
  if (!m) return null;
  const fd = Number(m[1]);
  return fd >= 3 ? fd : -1;
}

/** 读出并去掉首尾空白；读不出抛错（错误信息不含内容）。 */
export function readSecretFile(path) {
  const fd = fdOf(path);
  if (fd === -1) throw new Error("文件描述符 0～2 不能作为密钥来源");
  if (fd !== null) {
    if (!fdCache.has(fd)) fdCache.set(fd, readFileSync(fd, "utf8").trim());
    return fdCache.get(fd);
  }
  return readFileSync(path, "utf8").trim();
}
