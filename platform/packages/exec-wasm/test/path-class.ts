/**
 * W 用例的路径类跟随平台，与产品一致（kap-host `matter-engine.ts`、`runtime.ts` 按 process.platform 取 win32 / posix）。
 *
 * 以前这些用例把 pathClass 写死为 "posix"，在 Windows 上却把 `C:\…` 宿主路径原样拼进 Bash 命令：`cd 'C:\…'` 失败，
 * `&&` 之后的部分被跳过（Windows CI run 43435998778：“流式输出丢首段”、资源红队退出码 0、`bash: cd: … No such file`），
 * 测到的是一个产品里不存在的组合，而产品在 win32 路径类下的表现一直没测到。
 *
 * 规则：拼进 Bash 命令（含 python3 -c 里的字符串）的宿主路径一律经 `shp()` 转成 shell 形式；交给 broker、fs 或
 * `domain.run` 的 `cwd` 选项的仍是宿主路径。
 */
import { toShellPath, type PathClass } from "../src/domain.ts";

export const PATH_CLASS: PathClass = process.platform === "win32" ? "win32" : "posix";

/** 宿主路径 → Bash 里看到的路径（POSIX 原样；Windows `C:\a\b` → `/c/a/b`）。 */
export const shp = (hostPath: string): string => toShellPath(hostPath, PATH_CLASS);
