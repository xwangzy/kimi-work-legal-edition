/**
 * W-core 执行域（v9 第 04 篇 §4.1；第 06 篇 P2 验收）：Node --permission 监督进程 + just-bash + 零 JS 桥 CPython。
 *
 * 覆盖：权限自检；流式输出；单一路径命名空间；材料只读；SIGTERM / SIGKILL / 超时；并发与排队；工作区快照提交与冲突副本；
 * 链接预检；逃逸、联网（含 DNS）、资源耗尽；律师典型数据任务（标准库）与性能目标。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBroker } from "@zr-legal/file-broker";
import { captureBaseline, commitChanges, LinkPresentError } from "../src/commit.ts";
import { WCoreDomain, type WExecEvent, type WProcess } from "../src/domain.ts";
import { selftestProblems } from "../src/host.ts";

interface Fx {
  base: string;
  work: string;
  materials: string;
  outside: string;
  broker: FileBroker;
  domain: WCoreDomain;
  events: WExecEvent[];
}

async function fixture(
  opts: { maxConcurrent?: number; maxExecutionTimeMs?: number; maxOutputSize?: number; hardTimerGraceMs?: number; maxWaiting?: number; nodePath?: string } = {},
): Promise<Fx> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "kwl-w-")));
  const work = join(base, "matter", "work");
  const materials = join(base, "matter", "materials");
  const outside = join(base, "outside");
  for (const d of [work, materials, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(materials, "001-借款合同.txt"), "借款金额：人民币 100,000 元\n逾期利率：年 24%\n");
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET\n");
  const broker = new FileBroker([
    { name: "materials", root: materials, access: "ro" },
    { name: "work", root: work, access: "rw" },
  ]);
  const events: WExecEvent[] = [];
  const domain = await WCoreDomain.start({
    broker,
    work: { zone: "work", root: work },
    readOnlyRoots: [materials],
    pathClass: "posix",
    tmpDir: join(base, "w-tmp"),
    supervisor: {
      maxConcurrent: opts.maxConcurrent ?? 2,
      ...(opts.hardTimerGraceMs ? { hardTimerGraceMs: opts.hardTimerGraceMs } : {}),
      ...(opts.nodePath ? { nodePath: opts.nodePath } : {}),
    },
    limits: {
      ...(opts.maxExecutionTimeMs ? { maxExecutionTimeMs: opts.maxExecutionTimeMs } : {}),
      ...(opts.maxOutputSize ? { maxOutputSize: opts.maxOutputSize } : {}),
    },
    ...(opts.maxWaiting ? { maxWaiting: opts.maxWaiting } : {}),
    onEvent: (e) => events.push(e),
  });
  return { base, work, materials, outside, broker, domain, events };
}

async function collect(p: WProcess): Promise<{ code: number; out: string; err: string; chunksBeforeExit: number }> {
  let out = "";
  let err = "";
  let chunks = 0;
  let exited = false;
  p.stdout.setEncoding("utf8");
  p.stderr.setEncoding("utf8");
  p.stdout.on("data", (c: string) => {
    out += c;
    if (!exited) chunks += 1;
  });
  p.stderr.on("data", (c: string) => (err += c));
  const ended = Promise.all([new Promise((r) => p.stdout.on("end", r)), new Promise((r) => p.stderr.on("end", r))]);
  const code = await p.wait();
  exited = true;
  await ended;
  return { code, out, err, chunksBeforeExit: chunks };
}

const sh = (fx: Fx, cmd: string, cwd = fx.work) => fx.domain.run(`cd '${cwd}' && ${cmd}`, { cwd });

describe("W-core 执行域", () => {
  let fx: Fx;
  before(async () => {
    fx = await fixture();
  });
  after(async () => {
    await fx.domain.close();
  });

  test("自检：权限模型生效（系统文件不可读、用户主目录不可写、无网络/子进程/扩展/WASI）、DNS 解析失败、Node 26", async () => {
    const s = await fx.domain.supervisor.selftest();
    assert.deepEqual(selftestProblems(s), []);
    assert.equal(s.permission.net, false);
    assert.equal(s.permission.child, false);
    assert.equal(s.permission.fsReadEtc, false);
    assert.equal(s.permission.fsWriteHome, false);
    assert.equal(s.dns, "ERR_ACCESS_DENIED");
    assert.equal(s.readEtc, "ERR_ACCESS_DENIED");
    assert.match(s.node, /^v26\./);
  });

  test("流式输出：顶层语句结束即流出（sleep 前的输出在命令结束前到达）；退出码如实", async () => {
    const p = await sh(fx, "echo 第一段; sleep 1; echo 第二段; exit 3");
    const t0 = Date.now();
    let firstAt = -1;
    p.stdout.once("data", () => (firstAt = Date.now() - t0));
    const r = await collect(p);
    assert.equal(r.code, 3);
    assert.equal(r.out, "第一段\n第二段\n");
    assert.ok(firstAt >= 0 && firstAt < 900, `第一段应在 sleep 结束前到达（${firstAt}ms）`);
  });

  test("单一路径命名空间：Bash 写的文件以同一宿主路径经 broker 可读；宿主写的文件 Bash 以同一路径可读；材料快照同路径只读", async () => {
    await fx.broker.writeText(join(fx.work, "宿主写入.txt"), "来自 Write 工具\n");
    const r = await collect(
      await sh(fx, `cat '${join(fx.work, "宿主写入.txt")}'; mkdir -p 草稿/明细; printf '合计,100000\\n' > 草稿/明细/汇总.csv; cat '${join(fx.materials, "001-借款合同.txt")}' | head -1`),
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "来自 Write 工具\n借款金额：人民币 100,000 元\n");
    assert.equal(await fx.broker.readText(join(fx.work, "草稿", "明细", "汇总.csv")), "合计,100000\n");
    const ro = await collect(await sh(fx, `echo x > '${join(fx.materials, "新文件.txt")}'; echo 继续`));
    assert.notEqual(ro.code, 0);
    assert.equal(existsSync(join(fx.materials, "新文件.txt")), false);
    const rm = await collect(await sh(fx, `rm -f '${join(fx.materials, "001-借款合同.txt")}'; ls '${fx.materials}'`));
    assert.match(rm.out + rm.err, /001-借款合同\.txt|EROFS|read-only/i);
    assert.equal(existsSync(join(fx.materials, "001-借款合同.txt")), true);
  });

  test("python3 = CPython 3.13（零 JS 桥）：标准库可用，import js / pyodide 不存在，subprocess/os.system/socket 不可用", async () => {
    const r = await collect(
      await sh(
        fx,
        `python3 -c "import sys, csv, json, decimal, datetime, statistics, re, zipfile, zlib, xml.etree.ElementTree, unicodedata, difflib; print(sys.version_info[:2])"
python3 -c "import js" 2>&1 | tail -1
python3 -c "import pyodide" 2>&1 | tail -1
python3 -c "import os; print(os.system('ls /'))" 2>&1 | tail -1
python3 -c "import subprocess; subprocess.run(['ls'])" 2>&1 | tail -1
python3 -c "import socket; s=socket.socket(); s.settimeout(2); s.connect(('1.1.1.1', 80)); print('CONNECTED')" 2>&1 | tail -1
python3 -c "import sqlite3" 2>&1 | tail -1
sqlite3 :memory: "select 6*7;"`,
      ),
    );
    const lines = r.out.trim().split("\n");
    assert.equal(lines[0], "(3, 13)");
    assert.match(lines[1]!, /ModuleNotFoundError/);
    assert.match(lines[2]!, /ModuleNotFoundError/);
    assert.doesNotMatch(r.out, /CONNECTED/);
    assert.doesNotMatch(lines[3]!, /^0$/);
    assert.match(lines[4]!, /Error|not supported|No such/i);
    // 这一 CPython 构建不含 _sqlite3：Python 的 sqlite3 模块不可用，shell 的 sqlite3 命令（sql.js）可用——写入模型可见的环境说明
    assert.match(lines[6]!, /No module named '_sqlite3'/);
    assert.equal(lines[7], "42");
  });

  test("逃逸红队：区外路径不可见（含 ../ 穿越、/etc、用户主目录）；链接不可创建；网络命令不存在；js-exec/node 不可用", async () => {
    const r = await collect(
      await sh(
        fx,
        `cat ../../outside/secret.txt 2>&1; cat '${join(fx.outside, "secret.txt")}' 2>&1; cat /etc/passwd 2>&1 | head -1; ls ~ 2>&1 | head -3
ln -s '${join(fx.outside, "secret.txt")}' lnk 2>&1; ln -s /etc/passwd lnk2 2>&1
python3 -c "import os; os.symlink('/etc/passwd', 'pl')" 2>&1 | tail -1
python3 -c "print(open('${join(fx.outside, "secret.txt")}').read())" 2>&1 | tail -1
curl -s https://example.com 2>&1 | head -1; wget -q https://example.com 2>&1 | head -1
node -e "console.log(1)" 2>&1 | head -1; js-exec -c "1" 2>&1 | head -1
echo done`,
      ),
    );
    assert.doesNotMatch(r.out + r.err, /OUTSIDE-SECRET/);
    assert.doesNotMatch(r.out + r.err, /root:/);
    assert.match(r.out, /done\n$/);
    assert.equal(existsSync(join(fx.work, "lnk")), false);
    assert.equal(existsSync(join(fx.work, "lnk2")), false);
    assert.equal(existsSync(join(fx.work, "pl")), false);
  });

  test("资源红队：无限循环、输出洪泛、内存炸弹、递归炸弹都被上限终止，执行域随后仍可用", async () => {
    const loop = await collect(await sh(fx, "while true; do :; done; echo 不应到达"));
    assert.notEqual(loop.code, 0);
    assert.doesNotMatch(loop.out, /不应到达/);
    // 约 31 MB 输出：送回宿主的部分被截断在约 17 MiB（上游任务服务在 16 MiB 处停止任务并提示重定向到文件）
    const flood = await collect(await sh(fx, `awk 'BEGIN{for(i=0;i<999999;i++) print "洪泛洪泛洪泛洪泛洪泛洪泛洪泛洪泛洪泛洪泛"}'`));
    const floodBytes = Buffer.byteLength(flood.out, "utf8");
    assert.ok(floodBytes <= 17 * 1024 * 1024 + 200, `送回宿主的输出应被截断（${floodBytes} 字节）`);
    assert.ok(flood.out.endsWith("其余部分未送回（请把大量输出重定向到文件）\n"), "截断说明缺失");
    const bomb = await collect(await sh(fx, `f() { f; }; f`));
    assert.notEqual(bomb.code, 0);
    assert.match(bomb.err, /depth|recursion|limit|maximum/i);
    const mem = await collect(await sh(fx, `python3 -c "a = bytearray(4 * 1024 ** 3); print('ALLOCATED')" 2>&1 | tail -1`));
    assert.doesNotMatch(mem.out, /ALLOCATED/);
    const ok = await collect(await sh(fx, "echo 仍可用"));
    assert.equal(ok.out, "仍可用\n");
  });

  test("律师典型数据任务（标准库）：300 行流水汇总 < 10 秒；1 万行 CSV 分组聚合 < 30 秒；违约金三情景计算", async () => {
    const rows = ["日期,摘要,收入,支出"];
    for (let i = 0; i < 300; i++) rows.push(`2026-0${(i % 9) + 1}-${String((i % 27) + 1).padStart(2, "0")},项目${i % 7},${i % 3 === 0 ? 1000 + i : 0},${i % 3 === 0 ? 0 : 200 + i}`);
    writeFileSync(join(fx.work, "流水.csv"), `${rows.join("\n")}\n`);
    const big = ["客户,类别,金额"];
    for (let i = 0; i < 10_000; i++) big.push(`客户${i % 50},类别${i % 12},${(i * 37) % 10000}.${i % 100}`);
    writeFileSync(join(fx.work, "台账.csv"), `${big.join("\n")}\n`);
    let t = Date.now();
    const s1 = await collect(
      await sh(
        fx,
        `python3 - <<'PY'
import csv
from collections import defaultdict
from decimal import Decimal
inc = defaultdict(Decimal); out = defaultdict(Decimal)
with open('流水.csv', encoding='utf-8') as f:
    for r in csv.DictReader(f):
        m = r['日期'][:7]; inc[m] += Decimal(r['收入']); out[m] += Decimal(r['支出'])
with open('月度汇总.csv', 'w', encoding='utf-8', newline='') as f:
    w = csv.writer(f); w.writerow(['月份', '收入', '支出', '净额'])
    for m in sorted(inc): w.writerow([m, inc[m], out[m], inc[m] - out[m]])
print(len(inc), sum(inc.values()), sum(out.values()))
PY`,
      ),
    );
    const d1 = Date.now() - t;
    assert.equal(s1.code, 0, s1.err);
    assert.match(s1.out, /^9 /);
    assert.ok(d1 < 10_000, `300 行流水汇总 ${d1}ms`);
    assert.match(await fx.broker.readText(join(fx.work, "月度汇总.csv")), /^月份,收入,支出,净额/);
    t = Date.now();
    const s2 = await collect(
      await sh(
        fx,
        `python3 -c "
import csv
from collections import Counter
from decimal import Decimal
tot = Counter()
for r in csv.DictReader(open('台账.csv', encoding='utf-8')): tot[(r['客户'], r['类别'])] += Decimal(r['金额'])
print(len(tot))
"`,
      ),
    );
    const d2 = Date.now() - t;
    assert.equal(s2.code, 0, s2.err);
    assert.equal(s2.out.trim(), "300"); // (i mod 50, i mod 12) 只出现同奇偶的组合：50 × 12 / 2
    assert.ok(d2 < 30_000, `1 万行分组聚合 ${d2}ms`);
    const s3 = await collect(
      await sh(
        fx,
        `python3 -c "
from decimal import Decimal, ROUND_HALF_UP
from datetime import date
p = Decimal('100000'); days = (date(2026, 10, 11) - date(2025, 6, 30)).days
for name, rate in [('约定日万分之五', Decimal('0.0005') * days), ('LPR 四倍（年 12.4%）', Decimal('0.124') * days / 365), ('合同总价 20% 上限', Decimal('0.2'))]:
    print(name, (p * rate).quantize(Decimal('0.01'), ROUND_HALF_UP))
"`,
      ),
    );
    assert.equal(s3.code, 0, s3.err);
    assert.equal(s3.out.trim().split("\n").length, 3);
  });

  test("SIGTERM：协作式停止（143），不殃及同事项其他命令；SIGKILL：Python 死循环被终止（137）", async () => {
    const slow = await sh(fx, "sleep 30; echo 不应到达");
    const other = await sh(fx, "sleep 1; echo 同事项其他命令");
    setTimeout(() => void slow.kill("SIGTERM"), 300);
    const t0 = Date.now();
    const [a, b] = await Promise.all([collect(slow), collect(other)]);
    assert.equal(a.code, 143);
    assert.ok(Date.now() - t0 < 6_500, "SIGTERM 应在宽限内结束");
    assert.doesNotMatch(a.out, /不应到达/);
    assert.equal(b.code, 0);
    assert.equal(b.out, "同事项其他命令\n");
    const py = await sh(fx, `python3 -c "
while True:
    pass
"`);
    setTimeout(() => void py.kill("SIGKILL"), 500);
    const t1 = Date.now();
    const c = await collect(py);
    assert.equal(c.code, 137);
    assert.ok(Date.now() - t1 < 3_000);
    const ok = await collect(await sh(fx, "echo 之后仍可用"));
    assert.equal(ok.out, "之后仍可用\n");
  });

  test("工作区快照提交：运行期间文件被改 → 不覆盖、另存冲突副本；被改的文件不删除；内容相同不重写", async () => {
    await fx.broker.writeText(join(fx.work, "合同草稿.md"), "v1\n");
    await fx.broker.writeText(join(fx.work, "待删.md"), "keep?\n");
    await fx.broker.writeText(join(fx.work, "不变.md"), "same\n");
    const p = await sh(fx, "sleep 1; echo W版本 > 合同草稿.md; rm 待删.md; cat 不变.md > /tmp/x; touch 不变.md");
    await new Promise((r) => setTimeout(r, 300));
    await fx.broker.writeText(join(fx.work, "合同草稿.md"), "律师在 Word 里改的版本\n");
    await fx.broker.writeText(join(fx.work, "待删.md"), "律师刚改过\n");
    const r = await collect(p);
    assert.equal(r.code, 75, "结果另存为冲突副本：没有完整写回，退出码 75（审查 S3-06）");
    assert.equal(await fx.broker.readText(join(fx.work, "合同草稿.md")), "律师在 Word 里改的版本\n");
    const copies = readdirSync(fx.work).filter((n) => n.startsWith("合同草稿（执行冲突副本"));
    assert.equal(copies.length, 1);
    assert.equal(readFileSync(join(fx.work, copies[0]!), "utf8"), "W版本\n");
    assert.equal(await fx.broker.readText(join(fx.work, "待删.md")), "律师刚改过\n");
    assert.match(r.err, /执行冲突副本/);
    assert.match(r.err, /未删除/);
    assert.equal(p.commitReport?.unchanged, 1);
  });

  test("删除与改名：rm -rf 目录、mv 目录经 broker 提交；运行期间目录里新出现的文件使目录保留", async () => {
    mkdirSync(join(fx.work, "旧目录", "子"), { recursive: true });
    writeFileSync(join(fx.work, "旧目录", "子", "a.txt"), "a\n");
    writeFileSync(join(fx.work, "旧目录", "b.txt"), "b\n");
    mkdirSync(join(fx.work, "改名前"), { recursive: true });
    writeFileSync(join(fx.work, "改名前", "m.txt"), "m\n");
    const r = await collect(await sh(fx, "rm -rf 旧目录; mv 改名前 改名后"));
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(join(fx.work, "旧目录")), false);
    assert.equal(existsSync(join(fx.work, "改名前")), false);
    assert.equal(readFileSync(join(fx.work, "改名后", "m.txt"), "utf8"), "m\n");
    mkdirSync(join(fx.work, "目录2"), { recursive: true });
    writeFileSync(join(fx.work, "目录2", "x.txt"), "x\n");
    const p = await sh(fx, "sleep 1; rm -rf 目录2");
    await new Promise((res) => setTimeout(res, 300));
    writeFileSync(join(fx.work, "目录2", "新来的.txt"), "new\n");
    const r2 = await collect(p);
    assert.equal(r2.code, 75, "目录保留未删：没有完整写回，退出码 75");
    assert.equal(existsSync(join(fx.work, "目录2", "新来的.txt")), true);
    assert.match(r2.err, /有新内容，未删除/);
  });

  test("S3-01 先写后删：目标写不成（路径超过系统上限、父路径被占）时源文件不删——mv 不丢稿；大小写更名不误删", async () => {
    // ① 路径超过操作系统上限：改动集在校验阶段整体拒绝，源文件不动
    await fx.broker.writeText(join(fx.work, "草稿.md"), "律师花了一下午写的草稿\n");
    const deep = Array.from({ length: 28 }, (_, i) => `归档目录${String(i).padStart(2, "0")}`.padEnd(30, "x")).join("/");
    const r1 = await collect(await sh(fx, `mkdir -p '${deep}' && cat 草稿.md > '${deep}/草稿.md' && rm 草稿.md && echo 已归档`));
    assert.equal(await fx.broker.readText(join(fx.work, "草稿.md")), "律师花了一下午写的草稿\n");
    if (process.platform === "darwin") assert.match(r1.err, /未提交/);
    // ② 应用阶段写入失败（运行期间父路径被一个普通文件占用）：一个都不删
    await fx.broker.writeText(join(fx.work, "源.md"), "源文件\n");
    const p2 = await sh(fx, "sleep 1; mkdir -p 归档 && cp 源.md 归档/源.md && rm 源.md");
    await new Promise((res) => setTimeout(res, 300));
    writeFileSync(join(fx.work, "归档"), "运行期间出现的同名文件\n");
    const r2 = await collect(p2);
    assert.equal(await fx.broker.readText(join(fx.work, "源.md")), "源文件\n");
    assert.match(r2.err, /未删除（避免移动或改名时丢失原文件）/);
    assert.equal(r2.code, 75);
    // ③ 大小写更名（macOS/Windows 卷大小写不敏感：两个名字是同一文件）：内容保留，且盘上名字随之更名（审查 S3-13）
    await fx.broker.writeText(join(fx.work, "draft.md"), "case\n");
    const r3 = await collect(await sh(fx, "mv draft.md DRAFT.md"));
    assert.equal(r3.code, 0, r3.err);
    const names = readdirSync(fx.work).filter((n) => n.toLowerCase() === "draft.md");
    assert.equal(names.length, 1);
    assert.equal(readFileSync(join(fx.work, names[0]!), "utf8"), "case\n");
    // 大小写不敏感的卷上，W 的读盘层把两个写法视为同一文件，W 内的“只改大小写”更名不生效（偏离登记 D-13）；
    // 经临时名的两步更名可以生效：提交层识别为同一对象，只改目录项写法
    const r4 = await collect(await sh(fx, `mv ${names[0]} 临时.md && mv 临时.md DRAFT.md`));
    assert.equal(r4.code, 0, r4.err);
    const after = readdirSync(fx.work).filter((n) => n.toLowerCase() === "draft.md");
    assert.deepEqual(after, ["DRAFT.md"]);
    assert.equal(readFileSync(join(fx.work, "DRAFT.md"), "utf8"), "case\n");
  });

  test("S3-02 链接预检覆盖保留名目录：.kwl-* 之下的硬链接同样拒绝运行", async () => {
    mkdirSync(join(fx.work, ".kwl-cache"), { recursive: true });
    linkSync(join(fx.outside, "secret.txt"), join(fx.work, ".kwl-cache", "hl.txt"));
    const refused = await collect(await sh(fx, "cat .kwl-cache/hl.txt"));
    assert.equal(refused.code, 1);
    assert.equal(refused.out, "", "拒绝运行：命令一行都没有执行");
    assert.match(refused.err, /链接文件（\.kwl-cache\/hl\.txt）/);
    unlinkSync(join(fx.work, ".kwl-cache", "hl.txt"));
    const ok = await collect(await sh(fx, "echo 移除后可运行"));
    assert.equal(ok.out, "移除后可运行\n");
  });

  test("链接预检：工作区出现硬链接或符号链接即拒绝运行（硬链接无法按路径识别，经它可读区外文件）", async () => {
    const hard = join(fx.work, "evil-hard");
    linkSync(join(fx.outside, "secret.txt"), hard);
    const r1 = await collect(await sh(fx, "cat evil-hard"));
    assert.ok(r1.code === 1 && r1.out === "" && /evil-hard/.test(r1.err), r1.err);
    unlinkSync(hard);
    const soft = join(fx.work, "evil-link");
    symlinkSync(join(fx.outside, "secret.txt"), soft);
    const r2 = await collect(await sh(fx, "cat evil-link"));
    assert.ok(r2.code === 1 && r2.out === "" && /evil-link/.test(r2.err), r2.err);
    assert.ok(new LinkPresentError(["x"]).message.includes("拒绝运行"));
    unlinkSync(soft);
    const ok = await collect(await sh(fx, "echo 清理后可运行"));
    assert.equal(ok.out, "清理后可运行\n");
  });

  test("提交校验：改动集含链接、保留名、超限文件即整体拒绝（一项都不写）", async () => {
    const baseline = await captureBaseline(fx.work);
    const mk = (path: string, s = "x") => ({ path, content: new Uint8Array(Buffer.from(s)) });
    const r1 = await commitChanges(fx.broker, "work", { mountPoint: fx.work, files: [mk("正常.txt")], dirs: [], deleted: [], links: ["坏链接"] }, baseline, { maxFileBytes: 1e6, maxTotalBytes: 1e6 });
    assert.deepEqual(r1.rejected.map((x) => x.reason), ["link_not_allowed"]);
    assert.equal(existsSync(join(fx.work, "正常.txt")), false);
    const r2 = await commitChanges(fx.broker, "work", { mountPoint: fx.work, files: [mk("正常.txt"), mk(".kwl-trash/x")], dirs: [], deleted: [], links: [] }, baseline, { maxFileBytes: 1e6, maxTotalBytes: 1e6 });
    assert.ok(r2.rejected.some((x) => x.reason === "path_not_allowed"));
    assert.equal(existsSync(join(fx.work, "正常.txt")), false);
    const r3 = await commitChanges(fx.broker, "work", { mountPoint: fx.work, files: [mk("大.txt", "y".repeat(100))], dirs: [], deleted: [], links: [] }, baseline, { maxFileBytes: 10, maxTotalBytes: 1e6 });
    assert.deepEqual(r3.rejected.map((x) => x.reason), ["file_too_large"]);
    const r4 = await commitChanges(fx.broker, "work", { mountPoint: fx.work, files: [mk("../越界.txt")], dirs: [], deleted: [], links: [] }, baseline, { maxFileBytes: 1e6, maxTotalBytes: 1e6 });
    assert.ok(r4.rejected.length > 0);
    assert.equal(existsSync(join(fx.work, "..", "越界.txt")), false);
    const viaW = await collect(await sh(fx, "echo x > .kwl-trash-evil; echo y > 合法.txt"));
    assert.match(viaW.err, /未提交/);
    assert.equal(existsSync(join(fx.work, "合法.txt")), false);
  });
});

describe("W-core 执行域：并发、排队与超时", () => {
  test("同一事项最多 N 个并发 worker，超出排队（报告排队位置）后依次执行", async () => {
    const fx = await fixture({ maxConcurrent: 2 });
    try {
      const t0 = Date.now();
      const ps = await Promise.all([1, 2, 3].map((i) => sh(fx, `sleep 1; echo 任务${i}`)));
      const rs = await Promise.all(ps.map(collect));
      assert.deepEqual(rs.map((r) => r.out), ["任务1\n", "任务2\n", "任务3\n"]);
      assert.ok(Date.now() - t0 >= 1_900, "第三个命令应排队等待");
      assert.ok(fx.events.some((e) => e.type === "exec.queued" && e.position === 1));
    } finally {
      await fx.domain.close();
    }
  });

  test("W 自身的每次调用硬上限：超时返回 124 且执行域随后仍可用", async () => {
    const fx = await fixture({ maxExecutionTimeMs: 1_500 });
    try {
      const r = await collect(await sh(fx, "sleep 5; echo 不应到达"));
      assert.equal(r.code, 124);
      assert.doesNotMatch(r.out, /不应到达/);
      const ok = await collect(await sh(fx, "echo 仍可用"));
      assert.equal(ok.out, "仍可用\n");
    } finally {
      await fx.domain.close();
    }
  });
});
