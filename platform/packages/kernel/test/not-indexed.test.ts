/**
 * 数据根不进 Windows 搜索的内容索引（Y5 P1-7）：只调用 System32\attrib.exe、固定参数（数据根本身 + 其下全部 /S /D）；
 * 失败只返回 failed、不抛错；Windows 之外不适用。实机核对待 Windows CI。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { attribCommands, excludeFromContentIndex } from "../src/services/not-indexed.ts";

test("内容索引排除：Windows 上两次 attrib +I（根与 /S /D），参数不经命令行解释器；失败不抛错；其他平台不适用", async () => {
  const root = "C:\\Users\\律师\\AppData\\Local\\KimiWorkLegal";
  const calls: { file: string; args: string[] }[] = [];
  const ok = await excludeFromContentIndex(root, { platform: "win32", systemRoot: "C:\\Windows", run: async (file, args) => (calls.push({ file, args }), 0) });
  assert.equal(ok, "done");
  assert.deepEqual(calls, attribCommands(root, "C:\\Windows"));
  assert.ok(calls.every((c) => /System32[\\/]attrib\.exe$/.test(c.file)));
  assert.deepEqual(calls[0]!.args, ["+I", root]);
  assert.deepEqual(calls[1]!.args.slice(-2), ["/S", "/D"]);
  assert.equal(await excludeFromContentIndex(root, { platform: "win32", run: async () => 5 }), "failed");
  assert.equal(await excludeFromContentIndex(root, { platform: "win32", run: async () => { throw new Error("x"); } }), "failed");
  assert.equal(await excludeFromContentIndex(root, { platform: "darwin", run: async () => { throw new Error("不应调用"); } }), "not_applicable");
});
