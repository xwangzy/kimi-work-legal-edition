/**
 * 数据根不进 Windows 搜索的内容索引（调研 Y5 P1-7、W5）：Windows 搜索会把可读文件的文字抽进系统索引库（不在本应用的加密范围内）。
 * 启动时对数据根本身与其下全部文件、目录设“不编制内容索引”属性（attrib +I）；NTFS 上之后新建的文件与目录继承父目录的这一属性。
 * 只调用系统自带的 %SystemRoot%\System32\attrib.exe，固定参数、不经命令行解释器；失败不影响启动，只记事件。Windows 之外不适用。
 * 实机核对（attrib 输出带 I、搜索查询金丝雀 0 结果）待 Windows CI。
 */
import { execFile } from "node:child_process";
import { join } from "node:path";

export type IndexExcludeOutcome = "done" | "failed" | "not_applicable";
export type AttribRunner = (file: string, args: string[]) => Promise<number>;

const defaultRunner: AttribRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024, env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } }, (err) => resolve(err ? 1 : 0));
  });

/** attrib 的两次调用：数据根本身；其下全部文件与目录（/S /D）。 */
export function attribCommands(dataRoot: string, systemRoot = process.env.SystemRoot ?? "C:\\Windows"): { file: string; args: string[] }[] {
  const file = join(systemRoot, "System32", "attrib.exe");
  return [
    { file, args: ["+I", dataRoot] },
    { file, args: ["+I", join(dataRoot, "*"), "/S", "/D"] },
  ];
}

export async function excludeFromContentIndex(dataRoot: string, o: { platform?: string; systemRoot?: string; run?: AttribRunner } = {}): Promise<IndexExcludeOutcome> {
  if ((o.platform ?? process.platform) !== "win32") return "not_applicable";
  const run = o.run ?? defaultRunner;
  try {
    for (const c of attribCommands(dataRoot, o.systemRoot)) if ((await run(c.file, c.args)) !== 0) return "failed";
    return "done";
  } catch {
    return "failed";
  }
}
