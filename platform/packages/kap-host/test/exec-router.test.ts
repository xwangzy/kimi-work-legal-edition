/**
 * 执行域路由（v9 第 04 篇 §4.1 路由规则）：Bash → 执行域（不可用即拒绝）；Grep/Glob → 宿主内检索（参数受限；审计 S3 第 2 步起不再拉起原生 rg）；
 * 其余一律拒绝。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveZoneKey, ZoneCodec } from "@zr-legal/at-rest";
import { FileBroker } from "@zr-legal/file-broker";
import { ExecRouter, UNAVAILABLE_DOMAIN } from "../src/exec-router.ts";
import { placeholderShellPath } from "../src/seeds.ts";

function fixture(o: { sealed?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "kwl-router-")));
  const materials = join(base, "matter", "materials");
  const work = join(base, "matter", "work");
  const outside = join(base, "outside");
  for (const d of [materials, work, outside]) mkdirSync(d, { recursive: true });
  const ws = randomBytes(32);
  const codecs = {
    materials: new ZoneCodec("materials", new Map([[1, deriveZoneKey(ws, "materials")]]), 1),
    work: new ZoneCodec("work", new Map([[1, deriveZoneKey(ws, "work")]]), 1),
  };
  const put = (zone: "materials" | "work" | null, path: string, text: string) =>
    writeFileSync(path, o.sealed && zone ? codecs[zone].seal(Buffer.from(text)) : text);
  put("materials", join(materials, "合同.txt"), "违约金为合同总价的百分之二十\n");
  put("work", join(work, "notes.md"), "-违约金 备注\n");
  put(null, join(outside, "secret.txt"), "违约金 SECRET\n");
  const broker = new FileBroker([
    { name: "materials", root: materials, access: "ro", ...(o.sealed ? { codec: codecs.materials, strict: true } : {}) },
    { name: "work", root: work, access: "rw", ...(o.sealed ? { codec: codecs.work, strict: true } : {}) },
  ]);
  // 检索入口：已存在的占位文件（宿主从不执行它）
  const rg = join(base, ".kwl-host-search");
  writeFileSync(rg, "entry\n");
  const router = new ExecRouter({ broker, workDir: work, shellPath: placeholderShellPath("posix"), trustedRgPath: rg });
  return { base, materials, work, outside, broker, router, rg, codecs };
}

async function output(p: { stdout: NodeJS.ReadableStream; wait(): Promise<number> }): Promise<{ code: number; out: string }> {
  const chunks: Buffer[] = [];
  p.stdout.on("data", (c: Buffer) => chunks.push(c));
  const ended = new Promise((r) => p.stdout.on("end", r));
  const code = await p.wait();
  await ended;
  return { code, out: Buffer.concat(chunks).toString("utf8") };
}

test("Bash：执行域未就绪时拒绝（不在执行域之外运行代码）；只接受 `shell -c <命令>` 形式", async () => {
  const { router } = fixture();
  assert.equal(router.currentDomain(), UNAVAILABLE_DOMAIN);
  await assert.rejects(router.spawn(placeholderShellPath("posix"), ["-c", "echo hi"]), /执行域未就绪/);
  await assert.rejects(router.spawn(placeholderShellPath("posix"), ["-lc", "echo hi"]), /shell -c/);
  await assert.rejects(router.spawn(placeholderShellPath("posix"), ["-c"]), /shell -c/);
});

test("白名单外的可执行文件一律拒绝并记审计（git、系统 shell、PATH 上的 rg、MCP stdio）", async () => {
  const { router } = fixture();
  for (const cmd of ["git", "/bin/sh", "/bin/bash", "rg", "node", "npx", "C:\\Windows\\System32\\cmd.exe"]) {
    await assert.rejects(router.spawn(cmd, ["--version"]), /进程启动被拒绝/);
  }
  assert.ok(router.audit.filter((a) => a.outcome === "denied").length >= 7);
});

test("检索参数检查：禁止跟随链接、预处理器、压缩包、模式文件；路径参数必须在本事项区域内", async () => {
  const { router, outside, rg, materials } = fixture();
  const deny = async (args: string[], re: RegExp) => assert.rejects(router.spawn(rg, args), re);
  await deny(["-L", "x", materials], /forbidden_flag/);
  await deny(["--follow", "x", materials], /forbidden_flag/);
  await deny(["-iL", "x", materials], /forbidden_flag -L/);
  await deny(["--pre=cat", "x", materials], /forbidden_flag/);
  await deny(["--pre", "cat", "x", materials], /forbidden_flag/);
  await deny(["-z", "x", materials], /forbidden_flag/);
  await deny(["--search-zip", "x", materials], /forbidden_flag/);
  await deny(["-f", "/etc/passwd", materials], /pattern_file_not_allowed/);
  await deny(["--file=/etc/passwd", materials], /pattern_file_not_allowed/);
  await deny(["违约金", outside], /path_outside_matter/);
  await deny(["违约金", `${materials}/../../outside`], /parent_traversal/);
  // 审查发现：`--` 之后以 - 开头的模式曾被当作选项跳过，导致第一个搜索路径被误当成模式而漏检
  await deny(["--hidden", "--", "-违约金", outside], /path_outside_matter/);
  // Grep 工具真实形状：选项 + `-- <模式> <路径…>`
  await deny(["--hidden", "--null", "-l", "--glob", "!.git", "--", "违约金", materials, outside], /path_outside_matter/);
});

for (const sealed of [false, true]) {
test(`宿主内检索真实运行（${sealed ? "加密区" : "明文区"}）：Grep 与 Glob 的上游参数形状可用；Glob 以搜索根为 cwd`, async () => {
  const { router, rg, materials, work } = fixture({ sealed });
  if (sealed) assert.equal(readFileSync(join(materials, "合同.txt")).subarray(0, 4).toString(), "KWE1", "前置：盘上是密文");
  // Grep（files_with_matches，上游 buildRgArgs 的形状）
  const grep = await output(
    await router.spawn(rg, ["--hidden", "--max-columns", "500", "--null", "--glob", "!.git", "-l", "--glob", "!.env", "--", "违约金", materials, work]),
  );
  assert.equal(grep.code, 0);
  const files = grep.out.split("\0").filter(Boolean).sort();
  assert.deepEqual(files, [join(materials, "合同.txt"), join(work, "notes.md")].sort());
  // 以 - 开头的模式（`--` 之后按位置参数处理）
  const dash = await output(await router.spawn(rg, ["--null", "-l", "--", "-违约金", work]));
  assert.equal(dash.code, 0);
  assert.deepEqual(dash.out.split("\0").filter(Boolean), [join(work, "notes.md")]);
  // Glob（上游 globTool 的形状：--files --hidden --sortr=modified --glob <模式>）
  const glob = await output(await router.spawn(rg, ["--files", "--hidden", "--sortr=modified", "--glob", "!.git", "--glob", "*.md", work]));
  assert.equal(glob.code, 0);
  assert.deepEqual(glob.out.trim().split("\n"), [join(work, "notes.md")]);
  // Glob 的真实形状：cwd = 搜索根、路径为 "."（旧实现固定按工作区解析，在材料区列出的是工作区）
  const g2 = await output(await router.spawn(rg, ["--files", "--hidden", "--sortr=modified", "--glob", "!.git", "--glob", "*", "."], { cwd: materials }));
  assert.equal(g2.code, 0);
  assert.deepEqual(g2.out.trim().split("\n"), ["./合同.txt"]);
  // 行内容模式（上游 content 形状）读到解封后的明文
  const content = await output(await router.spawn(rg, ["--hidden", "--null", "--glob", "!.git", "--with-filename", "-n", "--", "百分之", materials]));
  assert.equal(content.code, 0);
  assert.equal(content.out, `${join(materials, "合同.txt")}\u00001:违约金为合同总价的百分之二十\n`);
});
}

test("宿主内检索：cwd 在工具可寻址区外即拒绝；--version 探测可用；kill 后以 143 结束", async () => {
  const { router, rg, outside, work } = fixture();
  await assert.rejects(router.spawn(rg, ["--files", "."], { cwd: outside }), /path_outside_matter/);
  const v = await output(await router.spawn(rg, ["--version"]));
  assert.equal(v.code, 0);
  assert.match(v.out, /^ripgrep /);
  for (let i = 0; i < 300; i++) writeFileSync(join(work, `f${i}.txt`), `${"行内容\n".repeat(2000)}`);
  const p = await router.spawn(rg, ["--hidden", "--null", "--count-matches", "--with-filename", "--", "行", work]);
  await p.kill("SIGTERM");
  assert.equal(await p.wait(), 143);
  utimesSync(join(work, "f1.txt"), new Date(), new Date(Date.now() + 60_000));
  const g = await output(await router.spawn(rg, ["--files", "--hidden", "--sortr=modified", "--glob", "*.txt", "."], { cwd: work }));
  assert.equal(g.out.split("\n")[0], "./f1.txt", "按修改时间倒序");
});

test("宿主内检索健壮性（复核 S3B-B02～B05）：大文件上的正则、-U、计数、大 -C 在 worker 内执行——宿主事件循环保持响应；运行中途 kill 立即 143", { timeout: 180_000 }, async () => {
  const { monitorEventLoopDelay } = await import("node:perf_hooks");
  const { work, router, rg, codecs } = fixture({ sealed: true });
  // 约 40 MB 的单行（压缩 JSON 一类）与 20 万行、只有 1 处命中的文件
  writeFileSync(join(work, "oneline.json"), codecs.work.seal(Buffer.from(`{"k":"${"甲方乙方0123456789".repeat(2_600_000)}"}\n`)));
  const lines = Array.from({ length: 400_000 }, (_, i) => (i === 200_000 ? "唯一命中 KWLONE" : `第${i}行`)).join("\n");
  writeFileSync(join(work, "many.txt"), codecs.work.seal(Buffer.from(`${lines}\n`)));
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const t0 = Date.now();
  const count = await output(await router.spawn(rg, ["--hidden", "--null", "--count-matches", "--with-filename", "--", ".", join(work, "oneline.json")]));
  const multi = await output(await router.spawn(rg, ["--hidden", "--null", "-l", "-U", "--multiline-dotall", "--", "\\d*", work]));
  const tc = Date.now();
  const ctx = await output(await router.spawn(rg, ["--hidden", "--null", "--with-filename", "-n", "-C", "20000", "--", "KWLONE", join(work, "many.txt")]));
  const ctxMs = Date.now() - tc;
  h.disable();
  assert.equal(count.code, 0);
  assert.match(count.out, /oneline\.json\u0000\d{8}\n/, "千万级匹配计数正常结束（不物化区间数组）");
  assert.equal(multi.code, 0);
  assert.equal(ctx.code, 0);
  // 40 万行、1 处命中、-C 20000：输出 40001 行；上下文线性判定（旧实现为 行数 × 2C ≈ 1.6×10¹⁰ 次比较，要数十秒）
  assert.equal(ctx.out.split("\n").filter(Boolean).length, 40_001);
  assert.ok(ctxMs < 5_000, `大 -C 检索耗时 ${ctxMs} ms`);
  const maxMs = h.max / 1e6;
  assert.ok(maxMs < 250, `检索期间宿主事件循环最大延迟 ${maxMs.toFixed(0)} ms（检索在 worker 内，主线程不被阻塞；总耗时 ${Date.now() - t0} ms）`);
  // 运行中途 kill：立即以 143 结束（worker.terminate 硬终止）
  const p = await router.spawn(rg, ["--hidden", "--null", "--count-matches", "--with-filename", "--", "[甲乙]方\\d", join(work, "oneline.json")]);
  await new Promise((r) => setTimeout(r, 150));
  const k0 = Date.now();
  await p.kill("SIGKILL");
  assert.equal(await p.wait(), 143);
  assert.ok(Date.now() - k0 < 1_000, `kill 后 ${Date.now() - k0} ms 才结束`);
});

test("能力账本如实写明（复核 S3B-A07）：加密形态下执行域读层持有工作区与材料两把区密钥；检索行写宿主内检索", async () => {
  const { capabilityLedger } = await import("../src/capabilities.ts");
  const facts = { execDomain: "W-core" as const, execDomainLabel: "W-core", hostSearch: true, egress: "app_level" as const, searchConfigured: false, fetchConfigured: false, legalMcp: false };
  const sealed = capabilityLedger({ ...facts, encryptedStorage: true });
  const bash = sealed.find((r) => r.family === "Shell 与代码执行")!;
  assert.match(bash.note ?? "", /W 进程内存中持有本事项工作区与材料两把区密钥/);
  assert.match(sealed.find((r) => r.family === "文件读取与搜索")!.access, /宿主内检索/);
  const plain = capabilityLedger({ ...facts, encryptedStorage: false });
  assert.doesNotMatch(plain.find((r) => r.family === "Shell 与代码执行")!.note ?? "", /区密钥/);
});

test("区内但不存在的搜索路径按 ripgrep 的形状报错（复核 S3B-B20）；区外路径与不存在的 cwd 仍在路由层拒绝", async () => {
  const { router, rg, work, outside } = fixture({ sealed: true });
  const p = await router.spawn(rg, ["--null", "-l", "--", "违约金", join(work, "不存在.txt")]);
  let err = "";
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (c: string) => (err += c));
  assert.equal(await p.wait(), 2);
  assert.match(err, /不存在\.txt: IO error for operation on .*No such file or directory \(os error 2\)/);
  await assert.rejects(router.spawn(rg, ["--null", "-l", "--", "违约金", join(outside, "secret.txt")]), /path_outside_matter/);
  await assert.rejects(router.spawn(rg, ["--files", "."], { cwd: join(work, "不存在目录") }), /path_unavailable/);
});

test("检索 worker 的出错路径（复核 B 处置复核 N-01/N-07）：堆超限只终止 worker、以“内存超限”退出码 2 结束，宿主不受影响；排队中被 kill 即 143", { timeout: 120_000 }, async () => {
  const { spawnHostSearch, SEARCH_WORKER_SLOTS } = await import("../src/search/host-search.ts");
  const { work, codecs } = fixture({ sealed: true });
  writeFileSync(join(work, "big.txt"), codecs.work.seal(Buffer.from(`${"违约金条款 ".repeat(3_000_000)}\n`)));
  const zones = [{ name: "work", root: work, strict: true, chunkedOnly: true, keys: codecs.work.toWire() }];
  // 400 万个短行：按行切分即需上百 MB 堆，16 MB 堆上限必然超限
  writeFileSync(join(work, "lines.txt"), codecs.work.seal(Buffer.from("违约\n".repeat(4_000_000))));
  const oom = spawnHostSearch(["--null", "-n", "--with-filename", "--", "违约", join(work, "lines.txt")], { cwd: work, pathClass: "posix", zones, heapMb: 16 });
  let err = "";
  oom.stderr.setEncoding("utf8");
  oom.stderr.on("data", (c: string) => (err += c));
  oom.stdout.resume();
  assert.equal(await oom.wait(), 2);
  assert.match(err, /内存超限|宿主内检索出错/);
  // 宿主（本进程）照常：再跑一次正常检索
  const ok = spawnHostSearch(["--null", "-l", "--", "违约金", work], { cwd: work, pathClass: "posix", zones });
  ok.stdout.resume();
  assert.equal(await ok.wait(), 0);
  // 占满槽位后，排队中的检索被 kill 立即以 143 结束（不等前面的检索）
  const busy = Array.from({ length: SEARCH_WORKER_SLOTS }, () => spawnHostSearch(["--null", "--count-matches", "--with-filename", "--", "[违约]金\\p{Han}", join(work, "big.txt")], { cwd: work, pathClass: "posix", zones }));
  for (const b of busy) b.stdout.resume();
  const queued = spawnHostSearch(["--null", "-l", "--", "违约金", work], { cwd: work, pathClass: "posix", zones });
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  await queued.kill("SIGTERM");
  assert.equal(await queued.wait(), 143);
  assert.ok(Date.now() - t0 < 500);
  for (const b of busy) await b.kill("SIGKILL");
  for (const b of busy) assert.equal(await b.wait(), 143);
});
