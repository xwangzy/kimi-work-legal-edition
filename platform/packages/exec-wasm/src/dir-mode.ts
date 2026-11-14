/**
 * Windows：执行域里的 python3 进不了磁盘上已经存在的子目录（Windows CI run 43465749822，w-legal-tasks 06～08：
 * `open('/c/…/materials/文书/起诉状-07.docx')` 报 PermissionError，glob 得空表）。
 *
 * 原因：libuv 在 Windows 上报的目录权限位没有执行位（普通目录 0o666，带只读属性的 0o444）。just-bash 的 OverlayFs 把真实目录的
 * stat 原样交出；python3（CPython-Emscripten）经 HOSTFS 建节点时取这个 mode，进入目录前按 POSIX 规则检查执行位，于是被拒。
 * Bash 解释器不检查权限位，所以 cat、grep 照常；挂载点根目录是 OverlayFs 在内存里造的（0o755），所以根目录下的文件也照常——
 * 只有子目录里的文件读不到。
 *
 * 处理：只在 Windows 上，把挂载层 stat / lstat 报出的目录补上执行位。能不能写由挂载的只读 / 可写决定，不看这几位；
 * POSIX 上真实目录的权限位是实情，不动。
 */
type StatFn = (path: string, ...rest: unknown[]) => Promise<Record<string, unknown>>;

export function makeDirsTraversable(fs: { stat: StatFn; lstat: StatFn }): void {
  for (const m of ["stat", "lstat"] as const) {
    const orig = fs[m].bind(fs);
    fs[m] = async (path, ...rest) => {
      const r = await orig(path, ...rest);
      return r && r.isDirectory === true && typeof r.mode === "number" ? { ...r, mode: r.mode | 0o111 } : r;
    };
  }
}
