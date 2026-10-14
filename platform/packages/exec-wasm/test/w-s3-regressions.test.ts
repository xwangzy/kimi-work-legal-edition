/**
 * 阶段 3 对抗式审查（docs/review/阶段3-对抗式审查.md）S3-03～S3-14 的回归用例：
 * 提交的比较—替换与写入临界区、别名规则、资源上限与退出码、强制终止、取消与排队、硬时限、自检与失败关闭、类型变化。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveZoneKey, isSealed, plainSizeOf, ZoneCodec } from "@zr-legal/at-rest";
import { FileBroker } from "@zr-legal/file-broker";
import { WCoreDomain, WUnavailableError, type WExecEvent, type WProcess } from "../src/domain.ts";
import { selftestProblems } from "../src/host.ts";

/**
 * 加密形态（复核 S3B-A01 / B-07）：KWL_W_SEALED=1（w-s3-regressions-sealed.test.ts）时工作区与材料以 KWE1 密文挂载，W 读层解密、提交经 broker 封装；
 * 用例里模拟律师与外部保存的写入经 wf 以工作区密钥封装，断言经 rf 解封后比对——同一组用例在明文与密文两种挂载下各跑一遍。
 */
const SEALED = process.env.KWL_W_SEALED === "1";
const WS_KEY = randomBytes(32);
const CODECS = {
  work: new ZoneCodec("work", new Map([[1, deriveZoneKey(WS_KEY, "work")]]), 1),
  materials: new ZoneCodec("materials", new Map([[1, deriveZoneKey(WS_KEY, "materials")]]), 1),
};
function wf(p: string, data: string | Uint8Array): void {
  const b = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  writeFileSync(p, SEALED ? CODECS.work.seal(b) : b);
}
function rf(p: string): string {
  const b = readFileSync(p);
  return (SEALED && isSealed(b) ? CODECS.work.open(b) : b).toString("utf8");
}
function sizeOf(p: string): number {
  const n = statSync(p).size;
  return SEALED ? plainSizeOf(n) : n;
}

interface Fx {
  base: string;
  work: string;
  broker: FileBroker;
  domain: WCoreDomain;
  events: WExecEvent[];
}

async function fixture(
  o: {
    maxConcurrent?: number;
    maxExecutionTimeMs?: number;
    maxOutputSize?: number;
    maxMemoryBytes?: number;
    maxFileReadSize?: number;
    hardTimerGraceMs?: number;
    maxWaiting?: number;
    nodePath?: string;
    expectedNodeVersion?: string;
    recoveryRetryMs?: number;
  } = {},
): Promise<Fx> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "kwl-s3-")));
  const work = join(base, "matter", "work");
  const materials = join(base, "matter", "materials");
  for (const d of [work, materials]) mkdirSync(d, { recursive: true });
  const sealedZone = (z: "work" | "materials") => (SEALED ? { codec: CODECS[z], strict: true, chunkedOnly: true } : {});
  const broker = new FileBroker([
    { name: "materials", root: materials, access: "ro", ...sealedZone("materials") },
    { name: "work", root: work, access: "rw", ...sealedZone("work") },
  ]);
  const events: WExecEvent[] = [];
  const domain = await WCoreDomain.start({
    broker,
    work: { zone: "work", root: work },
    readOnlyRoots: [materials],
    ...(SEALED ? { sealed: { work: CODECS.work.toWire(), readOnly: { [materials]: CODECS.materials.toWire() }, strict: true } } : {}),
    pathClass: "posix",
    tmpDir: join(base, "w-tmp"),
    supervisor: {
      maxConcurrent: o.maxConcurrent ?? 2,
      ...(o.hardTimerGraceMs ? { hardTimerGraceMs: o.hardTimerGraceMs } : {}),
      ...(o.nodePath ? { nodePath: o.nodePath } : {}),
      ...(o.expectedNodeVersion ? { expectedNodeVersion: o.expectedNodeVersion } : {}),
    },
    limits: {
      ...(o.maxExecutionTimeMs ? { maxExecutionTimeMs: o.maxExecutionTimeMs } : {}),
      ...(o.maxOutputSize ? { maxOutputSize: o.maxOutputSize } : {}),
      ...(o.maxMemoryBytes ? { maxMemoryBytes: o.maxMemoryBytes } : {}),
      ...(o.maxFileReadSize ? { maxFileReadSize: o.maxFileReadSize } : {}),
    },
    ...(o.maxWaiting ? { maxWaiting: o.maxWaiting } : {}),
    ...(o.recoveryRetryMs ? { recoveryRetryMs: o.recoveryRetryMs } : {}),
    onEvent: (e) => events.push(e),
  });
  return { base, work, broker, domain, events };
}

async function collect(p: WProcess): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  p.stdout.setEncoding("utf8");
  p.stderr.setEncoding("utf8");
  p.stdout.on("data", (c: string) => (out += c));
  p.stderr.on("data", (c: string) => (err += c));
  const ended = Promise.all([new Promise((r) => p.stdout.on("end", r)), new Promise((r) => p.stderr.on("end", r))]);
  const code = await p.wait();
  await ended;
  return { code, out, err };
}

const sh = (fx: Fx, cmd: string) => fx.domain.run(`cd '${fx.work}' && ${cmd}`, { cwd: fx.work });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const copiesOf = (dir: string, stem: string) => readdirSync(dir).filter((n) => n.startsWith(`${stem}（执行冲突副本`));

describe("审查 S3-03 / S3-04：写入临界区、比较—替换与别名", () => {
  let fx: Fx;
  before(async () => {
    fx = await fixture({ maxConcurrent: 2 });
  });
  after(async () => {
    await fx.domain.close();
  });

  test("S3-03 两条命令同时结束并修改同一已有文件：一份落盘 + 一份冲突副本，不静默丢失；后提交者退出码 75", async () => {
    wf(join(fx.work, "same.txt"), "BASE\n");
    const [pa, pb] = await Promise.all([sh(fx, "sleep 0.5; echo A >> same.txt"), sh(fx, "sleep 0.5; echo B >> same.txt")]);
    const [ra, rb] = await Promise.all([collect(pa), collect(pb)]);
    const copies = copiesOf(fx.work, "same");
    assert.equal(copies.length, 1, `应有且只有一份冲突副本（${copies.join("、")}）`);
    const versions = new Set([rf(join(fx.work, "same.txt")), rf(join(fx.work, copies[0]!))]);
    assert.deepEqual(versions, new Set(["BASE\nA\n", "BASE\nB\n"]));
    assert.deepEqual([ra.code, rb.code].sort((x, y) => x - y), [0, 75]);
  });

  test("S3-03 两条命令同时新建同名文件：一份落盘 + 一份冲突副本（新建用独占创建，不覆盖）", async () => {
    const [pa, pb] = await Promise.all([sh(fx, "sleep 0.5; echo A > brand.csv"), sh(fx, "sleep 0.5; echo B > brand.csv")]);
    const [ra, rb] = await Promise.all([collect(pa), collect(pb)]);
    const copies = copiesOf(fx.work, "brand");
    assert.equal(copies.length, 1);
    const versions = new Set([rf(join(fx.work, "brand.csv")), rf(join(fx.work, copies[0]!))]);
    assert.deepEqual(versions, new Set(["A\n", "B\n"]));
    assert.deepEqual([ra.code, rb.code].sort((x, y) => x - y), [0, 75]);
  });

  test("S3-03 判定之后、写入之前被插入一次写入（模拟 Office 写回）：写入点比较—替换转为冲突副本，律师版本原样", async () => {
    wf(join(fx.work, "f.txt"), "BASE\n");
    const orig = fx.broker.writeBytes.bind(fx.broker);
    let injected = false;
    (fx.broker as unknown as { writeBytes: typeof orig }).writeBytes = async (p, d, o) => {
      if (o?.expect && !injected && p.endsWith("/f.txt")) {
        injected = true;
        await orig(p, Buffer.from("LAWYER-EDIT\n")); // 不经比较—替换的外部写入者
      }
      return orig(p, d, o);
    };
    let r;
    try {
      r = await collect(await sh(fx, "echo W >> f.txt"));
    } finally {
      (fx.broker as unknown as { writeBytes: typeof orig }).writeBytes = orig;
    }
    assert.equal(injected, true);
    assert.equal(rf(join(fx.work, "f.txt")), "LAWYER-EDIT\n");
    const copies = copiesOf(fx.work, "f");
    assert.equal(copies.length, 1);
    assert.equal(rf(join(fx.work, copies[0]!)), "BASE\nW\n");
    assert.equal(r.code, 75);
    assert.match(r.err, /写回时刚被其他操作修改/);
  });

  test("S3-03 引擎经 IHostFileSystem 的写入与执行域提交共用写入临界区（临界区被占用时排队）", async () => {
    let release!: () => void;
    const held = fx.broker.exclusive(() => new Promise<void>((r) => (release = r)));
    const hostFs = fx.broker.asHostFileSystem() as { writeText(p: string, d: string): Promise<void> };
    let wrote = false;
    const w = hostFs.writeText(join(fx.work, "q.txt"), "x").then(() => {
      wrote = true;
    });
    await sleep(150);
    assert.equal(wrote, false, "临界区被占用时，引擎写入应等待");
    release();
    await held;
    await w;
    assert.equal(wrote, true);
  });

  test("S3-04 命令运行期间律师把别的文件改名到 W 新建的路径：不覆盖，W 的版本另存冲突副本", async () => {
    wf(join(fx.work, "x.txt"), "LAWYER-VERSION\n");
    const p = await sh(fx, "sleep 1; echo W-VERSION > new.txt");
    await sleep(300);
    renameSync(join(fx.work, "x.txt"), join(fx.work, "new.txt")); // 例如在资源管理器里改名
    const r = await collect(p);
    assert.equal(rf(join(fx.work, "new.txt")), "LAWYER-VERSION\n");
    const copies = copiesOf(fx.work, "new");
    assert.equal(copies.length, 1);
    assert.equal(rf(join(fx.work, copies[0]!)), "W-VERSION\n");
    assert.equal(r.code, 75);
    assert.match(r.err, /已由其他操作建立（或改名到这里）/);
  });

  test("S3-13 类型变化：文件换目录、目录换文件都按命令的意图提交；退出码 0", async () => {
    wf(join(fx.work, "t.txt"), "file\n");
    const r1 = await collect(await sh(fx, "rm t.txt; mkdir t.txt; echo g > t.txt/g"));
    assert.equal(r1.code, 0, r1.err);
    assert.ok(statSync(join(fx.work, "t.txt")).isDirectory());
    assert.equal(rf(join(fx.work, "t.txt", "g")), "g\n");
    mkdirSync(join(fx.work, "d", "sub"), { recursive: true });
    wf(join(fx.work, "d", "sub", "a.txt"), "a\n");
    const r2 = await collect(await sh(fx, "rm -rf d; echo x > d"));
    assert.equal(r2.code, 0, r2.err);
    assert.ok(statSync(join(fx.work, "d")).isFile());
    assert.equal(rf(join(fx.work, "d")), "x\n");
  });
});

describe("审查 S3-05 / S3-06 / S3-10：资源上限、退出码与强制终止", () => {
  let fx: Fx;
  before(async () => {
    fx = await fixture();
  });
  after(async () => {
    await fx.domain.close();
  });

  test("S3-05 重定向写出超过 10 MB 的文件可以成功（与上游一致）；awk 与 python3 能读入十几 MB 的文件（KJ-4）", async () => {
    wf(join(fx.work, "src.txt"), "a,b\n".repeat(1_500_000)); // 6 MB
    const r = await collect(await sh(fx, "cat src.txt src.txt > data.csv && awk 'END{print NR}' data.csv && python3 -c \"print(len(open('data.csv').read()))\""));
    assert.equal(r.code, 0, r.err.slice(0, 300));
    assert.equal(r.out, "3000000\n12000000\n");
    assert.equal(sizeOf(join(fx.work, "data.csv")), 12_000_000);
    const w = await collect(await sh(fx, "python3 -c \"open('p40.bin','wb').write(b'x'*40_000_000); print('ok')\""));
    assert.equal(w.code, 0, w.err.slice(0, 300));
    assert.equal(sizeOf(join(fx.work, "p40.bin")), 40_000_000);
  });

  test("S3-06 改动集被整体拒绝：退出码 75，说明在 stderr，一项都不写", async () => {
    const r = await collect(await sh(fx, "echo x > .kwl-trash-evil; echo y > 合法.txt"));
    assert.equal(r.code, 75);
    assert.match(r.err, /未提交/);
    assert.match(r.err, /退出码 75/);
    assert.equal(existsSync(join(fx.work, "合法.txt")), false);
  });

  test("S3-10 强制终止（SIGKILL）：退出码 137，本次改动一律不写回，并在 stderr 说明", async () => {
    const p = await sh(fx, "echo 1 > killed.txt; sleep 5");
    await sleep(500);
    await p.kill("SIGKILL");
    const r = await collect(p);
    assert.equal(r.code, 137);
    assert.equal(existsSync(join(fx.work, "killed.txt")), false);
    assert.match(r.err, /强制终止，本次命令对工作区的改动一律未写回/);
  });

  test("S3-05 命令触及执行域资源上限：已有文件原样保留，本次改动一律不写回并说明", async () => {
    const small = await fixture({ maxOutputSize: 4 * 1024 * 1024 });
    try {
      wf(join(small.work, "data.csv"), "ORIGINAL\n");
      wf(join(small.work, "src.txt"), "x".repeat(3 * 1024 * 1024));
      const r = await collect(await sh(small, "echo 先写 > other.txt; cat src.txt src.txt > data.csv"));
      assert.notEqual(r.code, 0);
      assert.equal(rf(join(small.work, "data.csv")), "ORIGINAL\n");
      assert.equal(existsSync(join(small.work, "other.txt")), false);
      assert.match(r.err, /资源上限.*未写回/);
    } finally {
      await small.domain.close();
    }
  });
});

describe("审查 S3-07 / S3-12 / S3-14：取消、排队与硬时限", () => {
  test("S3-07 取消落在基线采集窗口：命令不运行、不提交（137）", async () => {
    const fx = await fixture();
    try {
      // 3 万个文件使基线采集持续几百毫秒（S3-21 之后基线不持写入临界区，用规模制造窗口）
      mkdirSync(join(fx.work, "many"), { recursive: true });
      for (let i = 0; i < 30_000; i++) wf(join(fx.work, "many", `f${i}.txt`), "x");
      const p = await sh(fx, "echo ran > ran.txt");
      await sleep(40);
      fx.domain.abortAll("run_cancelled");
      const r = await collect(p);
      assert.equal(r.code, 137);
      assert.equal(existsSync(join(fx.work, "ran.txt")), false);
      assert.match(r.err, /开始执行前已被取消/);
    } finally {
      await fx.domain.close();
    }
  });

  test("S3-07 取消传播到执行中与排队中的命令：都不提交", async () => {
    const fx = await fixture({ maxConcurrent: 1 });
    try {
      const a = await sh(fx, "sleep 2; echo a > a.txt");
      const b = await sh(fx, "echo b > b.txt");
      await sleep(300);
      fx.domain.abortAll("run_cancelled");
      const [ra, rb] = await Promise.all([collect(a), collect(b)]);
      assert.equal(ra.code, 137);
      assert.equal(rb.code, 137);
      assert.equal(existsSync(join(fx.work, "a.txt")), false);
      assert.equal(existsSync(join(fx.work, "b.txt")), false);
    } finally {
      await fx.domain.close();
    }
  });

  test("S3-12 排队命令在真正开始时采集基线：读到前一条命令的结果，改完提交不算冲突；排队事件先于开始事件", async () => {
    const fx = await fixture({ maxConcurrent: 1 });
    try {
      wf(join(fx.work, "f.txt"), "BASE\n");
      const a = await sh(fx, "sleep 0.5; echo A >> f.txt");
      const b = await sh(fx, "cp f.txt seen.txt; echo B >> f.txt");
      const [ra, rb] = await Promise.all([collect(a), collect(b)]);
      assert.equal(ra.code, 0);
      assert.equal(rb.code, 0, rb.err);
      assert.equal(rf(join(fx.work, "f.txt")), "BASE\nA\nB\n");
      assert.equal(rf(join(fx.work, "seen.txt")), "BASE\nA\n");
      assert.equal(copiesOf(fx.work, "f").length, 0);
      const queued = fx.events.find((e) => e.type === "exec.queued");
      assert.ok(queued, "第二条命令应排队");
      const idxQ = fx.events.indexOf(queued!);
      const idxS = fx.events.findIndex((e) => e.type === "exec.started" && e.execId === queued!.execId);
      assert.ok(idxS > idxQ, "排队事件应先于开始事件");
    } finally {
      await fx.domain.close();
    }
  });

  test("S3-14 排队有上限：超出即拒绝并说明（退出码 1）", async () => {
    const fx = await fixture({ maxConcurrent: 1, maxWaiting: 1 });
    try {
      const a = await sh(fx, "sleep 1");
      const b = await sh(fx, "echo b");
      const c = await sh(fx, "echo c");
      const [, rb, rc] = await Promise.all([collect(a), collect(b), collect(c)]);
      assert.equal(rb.out, "b\n");
      assert.equal(rc.code, 1);
      assert.match(rc.err, /已达上限/);
    } finally {
      await fx.domain.close();
    }
  });

  test("S3-14 硬时限：卡在同步代码里、越过协作式时限的命令在宽限后被终止（124），执行域随后仍可用", async () => {
    const fx = await fixture({ maxExecutionTimeMs: 300, hardTimerGraceMs: 300 });
    try {
      wf(join(fx.work, "nums.txt"), `${Array.from({ length: 1_500_000 }, (_, i) => String((i * 7919) % 1_500_000)).join("\n")}\n`);
      const t0 = Date.now();
      const r = await collect(await sh(fx, "sort -n nums.txt | tail -1"));
      assert.equal(r.code, 124);
      assert.ok(Date.now() - t0 < 5_000, `应在时长上限 + 宽限后收尾（${Date.now() - t0} ms）`);
      assert.match(r.err, /硬时限|执行时限/);
      const ok = await collect(await sh(fx, "echo 仍可用"));
      assert.equal(ok.out, "仍可用\n");
    } finally {
      await fx.domain.close();
    }
  });
});

describe("审查 S3-08 / S3-09：自检与失败关闭", () => {
  test("S3-09 随包 Node 路径不存在：start 以 WUnavailableError 失败（失败关闭），宿主进程不崩溃", async () => {
    await assert.rejects(fixture({ nodePath: "/nonexistent/kwl-node26/bin/node" }), (e: unknown) => e instanceof WUnavailableError && /随包 Node 不可用/.test(e.message));
  });

  test("S3-08 Node 版本按锁定值判定：不符即不可用", async () => {
    await assert.rejects(fixture({ expectedNodeVersion: "v0.0.0" }), (e: unknown) => e instanceof WUnavailableError && /Node 版本不符/.test(e.message));
    const fake = { permission: { fsReadEtc: false, fsWriteHome: false, net: false, child: false, addon: false, wasi: false, worker: true }, dns: "ERR_ACCESS_DENIED", readEtc: "ERR_ACCESS_DENIED", rss: 1, node: process.version, t: "selftest" as const, id: 1 };
    assert.deepEqual(selftestProblems(fake), []);
    assert.ok(selftestProblems(fake, "v0.0.0").some((p) => p.includes("Node 版本不符")));
  });

  test("S3-09 W 进程被杀后立即取消与再运行：不崩溃；下一次调用重新拉起并重新自检（含 worker 往返）", async () => {
    const fx = await fixture();
    try {
      const pid = fx.domain.supervisor.pid();
      assert.ok(pid);
      process.kill(pid!, "SIGKILL");
      fx.domain.abortAll("run_cancelled"); // 向已死的进程发消息：不得抛出或产生未监听的 error
      await sleep(200);
      const r = await collect(await sh(fx, "echo again && python3 -c 'print(1+1)'"));
      assert.equal(r.out, "again\n2\n");
      assert.notEqual(fx.domain.supervisor.pid(), pid);
    } finally {
      await fx.domain.close();
    }
  });
});

describe("复核 S3-17～S3-23：删除的比较—替换、上限的结构化识别、类型变化暂存、锁的范围、退出码说明、健康状态", () => {
  let fx: Fx;
  before(async () => {
    fx = await fixture();
  });
  after(async () => {
    await fx.domain.close();
  });

  for (const [i, mode] of (["安全保存（新 inode）", "原地覆盖（同 inode）"] as const).entries()) {
    test(`S3-17 写入阶段里律师保存了新版本（${mode}）：删除按基线身份比较—替换，新版本保留不删，退出码 75`, async () => {
      const src = join(fx.work, `合同-${i}.docx`);
      wf(src, "OLD-VERSION\n");
      const orig = fx.broker.createExclusive.bind(fx.broker);
      let injected = false;
      (fx.broker as unknown as { createExclusive: typeof orig }).createExclusive = async (p, d) => {
        if (!injected && p.includes("归档")) {
          injected = true;
          if (mode.startsWith("安全保存")) {
            wf(`${src}.tmp`, "LAWYER-NEW-VERSION\n");
            renameSync(`${src}.tmp`, src);
          } else wf(src, "LAWYER-NEW-VERSION\n");
        }
        return orig(p, d);
      };
      let r;
      try {
        r = await collect(await sh(fx, `mkdir -p 归档 && mv '${src.split("/").pop()}' 归档/`));
      } finally {
        (fx.broker as unknown as { createExclusive: typeof orig }).createExclusive = orig;
      }
      assert.equal(injected, true);
      assert.equal(rf(src), "LAWYER-NEW-VERSION\n", "律师的新版本必须保留");
      assert.equal(rf(join(fx.work, "归档", src.split("/").pop()!)), "OLD-VERSION\n");
      assert.equal(r.code, 75);
      assert.match(r.err, /写回时刚被其他操作修改，未删除|未删除/);
    });
  }

  test("S3-18 执行域上限按结构化信号识别：`;` 连接的 awk 输入超限也判出（不写回、退出码非 0）；命令自身的“exceeded”错误与 Python RecursionError 不误判", async () => {
    wf(join(fx.work, "big.csv"), "a,b\n".repeat(17_500_000)); // 70 MB
    wf(join(fx.work, "o_awk.csv"), "LAWYER\n");
    const r1 = await collect(await sh(fx, "awk '{print toupper($0)}' big.csv > o_awk.csv; echo rc=$?"));
    assert.notEqual(r1.code, 0);
    assert.equal(rf(join(fx.work, "o_awk.csv")), "LAWYER\n", "截断的输出不得覆盖原文件");
    assert.match(r1.err, /执行域资源上限/);
    const r2 = await collect(await sh(fx, 'echo 结果 > fp.txt; echo "Error: maximum retries exceeded" >&2; exit 3'));
    assert.equal(r2.code, 3);
    assert.equal(rf(join(fx.work, "fp.txt")), "结果\n", "命令自身的错误不是执行域上限，改动照常写回");
    assert.doesNotMatch(r2.err, /执行域资源上限/);
    const r3 = await collect(await sh(fx, `python3 -c "open('part.csv','w').write('ok\\n')\ndef f(): f()\nf()"`));
    assert.equal(r3.code, 1);
    assert.equal(rf(join(fx.work, "part.csv")), "ok\n");
    assert.doesNotMatch(r3.err, /执行域资源上限/);
  });

  test("S3-18/S3-20 python3 超过 64 MiB：读入报 File too large（不再是“文件不存在”）、写出立即报错（不再挂起），都计为执行域上限、已打开的律师文件不被清空", async () => {
    wf(join(fx.work, "big70.csv"), "a,b\n".repeat(17_500_000));
    wf(join(fx.work, "out.csv"), "LAWYER\n");
    const r1 = await collect(await sh(fx, `python3 -c "o=open('out.csv','w'); d=open('big70.csv').read(); o.write(d[:10]); o.close()"`));
    assert.notEqual(r1.code, 0);
    assert.match(r1.err, /File too large/);
    assert.doesNotMatch(r1.err, /FileNotFoundError/);
    assert.equal(rf(join(fx.work, "out.csv")), "LAWYER\n");
    const t0 = Date.now();
    const r2 = await collect(await sh(fx, `python3 -c "f=open('w70.bin','wb'); f.write(b'x'*70_000_000); f.close()"`));
    assert.ok(Date.now() - t0 < 10_000, `应立即报错而不是挂起（${Date.now() - t0} ms）`);
    assert.notEqual(r2.code, 0);
    assert.match(r2.err, /File too large/);
    assert.equal(existsSync(join(fx.work, "w70.bin")), false);
  });

  test("S3-19 类型变化写入失败：旧文件从暂存移回原处，内容不丢；退出码 75", async () => {
    wf(join(fx.work, "rep"), "原稿内容\n");
    const orig = fx.broker.createExclusive.bind(fx.broker);
    (fx.broker as unknown as { createExclusive: typeof orig }).createExclusive = async (p, d) => {
      if (p.endsWith("/rep/v1")) throw Object.assign(new Error("EIO: simulated"), { code: "EIO" });
      return orig(p, d);
    };
    let r;
    try {
      r = await collect(await sh(fx, "mv rep tmpx && mkdir rep && mv tmpx rep/v1"));
    } finally {
      (fx.broker as unknown as { createExclusive: typeof orig }).createExclusive = orig;
    }
    assert.ok(statSync(join(fx.work, "rep")).isFile(), "旧文件应移回原处");
    assert.equal(rf(join(fx.work, "rep")), "原稿内容\n");
    assert.equal(r.code, 75);
  });

  test("S3-21 基线采集不持写入临界区：临界区被占用时，不改动工作区的命令照常完成；改动工作区的命令等到提交时才排队", async () => {
    let release!: () => void;
    const held = fx.broker.exclusive(() => new Promise<void>((r) => (release = r)));
    try {
      const t0 = Date.now();
      const r = await collect(await sh(fx, "echo 只读"));
      assert.equal(r.out, "只读\n");
      assert.ok(Date.now() - t0 < 3_000);
      let done = false;
      const p = sh(fx, "echo 写 > lockwait.txt").then(collect).then((x) => ((done = true), x));
      await sleep(400);
      assert.equal(done, false, "提交须等写入临界区");
      release();
      await held;
      const w = await p;
      assert.equal(w.code, 0);
      assert.equal(rf(join(fx.work, "lockwait.txt")), "写\n");
    } finally {
      release?.();
    }
  });

  test("S3-22 命令自身退出码非 0 时保持原值，说明不再写“退出码 75”", async () => {
    wf(join(fx.work, "k.txt"), "BASE\n");
    const p = await sh(fx, "sleep 0.5; echo W >> k.txt; exit 2");
    await sleep(150);
    wf(join(fx.work, "k.txt"), "LAWYER\n");
    const r = await collect(p);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.err, /退出码 75/);
    assert.match(r.err, /退出码保持命令本身的值 2/);
  });

  test("S3-23 W 进程重启失败时执行域报告不健康（宿主据此拒绝 Bash、账本如实）；恢复后健康", async () => {
    const sup = fx.domain.supervisor as unknown as { opts: { nodePath?: string } };
    const saved = sup.opts.nodePath;
    sup.opts.nodePath = "/nonexistent/kwl-node26/bin/node";
    process.kill(fx.domain.supervisor.pid()!, "SIGKILL");
    await sleep(200);
    const r = await collect(await sh(fx, "echo x"));
    assert.equal(r.code, 1);
    assert.match(fx.domain.health() ?? "", /随包 Node 不可用/);
    (sup.opts as { nodePath?: string | undefined }).nodePath = saved;
    const ok = await collect(await sh(fx, "echo 恢复"));
    assert.equal(ok.out, "恢复\n");
    assert.equal(fx.domain.health(), null);
  });
});

/** 工作区（含保留名 .kwl-*）里内容含 needle 的文件（相对路径）。 */
function filesContaining(root: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && rf(p).includes(needle)) out.push(p.slice(root.length + 1));
    }
  };
  walk(root);
  return out;
}

type BrokerHook = Record<string, (...a: any[]) => Promise<any>>;
/** 临时包装 broker 的一个方法（故障注入只在提交层；不涉及越界读取或联网）。 */
async function withHook<T>(fx: Fx, method: string, hook: (orig: (...a: any[]) => Promise<any>, ...args: any[]) => Promise<any>, run: () => Promise<T>): Promise<T> {
  const b = fx.broker as unknown as BrokerHook;
  const orig = b[method]!.bind(fx.broker);
  b[method] = (...args: any[]) => hook(orig, ...args);
  try {
    return await run();
  } finally {
    b[method] = orig;
  }
}

describe("第二轮复核 S3-24～S3-28：删除分支、类型变化先于删除、文件系统字节上限、时限判定、健康自动恢复", () => {
  let fx: Fx;
  before(async () => {
    fx = await fixture();
  });
  after(async () => {
    await fx.domain.close();
  });

  test("S3-24 W 删除的目录在写回时被换成同名文件：不删（基线不是文件即保留），律师文件原样，退出码 75", async () => {
    mkdirSync(join(fx.work, "olddir"));
    wf(join(fx.work, "olddir", "a.txt"), "A\n");
    let injected = false;
    const r = await withHook(
      fx,
      "createExclusive",
      async (orig, p: string, d: Uint8Array) => {
        if (!injected && p.endsWith("/new24.txt")) {
          injected = true;
          rmSync(join(fx.work, "olddir"), { recursive: true, force: true });
          wf(join(fx.work, "olddir"), "LAWYER-FILE-REPLACING-DIR\n");
        }
        return orig(p, d);
      },
      async () => collect(await sh(fx, "rm -rf olddir && echo x > new24.txt")),
    );
    assert.equal(injected, true);
    assert.equal(rf(join(fx.work, "olddir")), "LAWYER-FILE-REPLACING-DIR\n");
    assert.equal(r.code, 75, r.err);
    assert.match(r.err, /olddir 在写回时刚被其他操作修改，未删除/);
  });

  for (const [i, mode] of (["原地覆盖", "安全保存"] as const).entries()) {
    test(`S3-17/E${i + 1} 删除时在“走查之后、rename 之前”律师保存了新版本（${mode}）：按冲突保留（不报 ELOOP），新版本原样`, async () => {
      const name = `合同-e${i + 1}.docx`;
      const doc = join(fx.work, name);
      wf(doc, "OLD-VERSION\n");
      const b = fx.broker as unknown as { recheckChain: (loc: { display: string }, chain: unknown) => Promise<void>; remove: (p: string, o?: unknown) => Promise<void> };
      const origRecheck = b.recheckChain.bind(fx.broker);
      const origRemove = b.remove.bind(fx.broker);
      let armed = false;
      let injected = false;
      b.remove = async (p, o) => {
        if (p.endsWith(`/${name}`)) armed = true;
        try {
          return await origRemove(p, o);
        } finally {
          armed = false;
        }
      };
      b.recheckChain = async (loc, chain) => {
        if (armed && !injected && String(loc.display).endsWith(`/${name}`)) {
          injected = true;
          if (mode === "原地覆盖") wf(doc, "LAWYER-NEW-SAVE-INPLACE-LONGER\n");
          else {
            wf(join(fx.work, `~$${i}.tmp`), "LAWYER-NEW-SAVE-SAFE\n");
            renameSync(join(fx.work, `~$${i}.tmp`), doc);
          }
        }
        return origRecheck(loc, chain);
      };
      let r;
      try {
        r = await collect(await sh(fx, `mkdir -p 归档e && mv '${name}' 归档e/`));
      } finally {
        b.recheckChain = origRecheck;
        b.remove = origRemove;
      }
      assert.equal(injected, true);
      assert.match(rf(doc), /^LAWYER-NEW-SAVE/);
      assert.equal(r.code, 75, r.err);
      assert.doesNotMatch(r.err, /ELOOP/);
      assert.match(r.err, new RegExp(`${name} 在写回时刚被其他操作修改，未删除`));
    });
  }

  test("S3-25/E5 文件换目录 + 移入新目录，子文件写入失败：被移动的文件不删（类型变化先于删除），rep 恢复，退出码 75", async () => {
    wf(join(fx.work, "rep5"), "REP5-ORIG\n");
    wf(join(fx.work, "合同5.docx"), "CONTRACT5-CONTENT\n");
    let injected = false;
    const r = await withHook(
      fx,
      "createExclusive",
      async (orig, p: string, d: Uint8Array) => {
        if (!injected && p.endsWith("/rep5/合同5.docx")) {
          injected = true;
          throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
        }
        return orig(p, d);
      },
      async () => collect(await sh(fx, "mv rep5 tmp5 && mkdir rep5 && mv tmp5 rep5/v1 && mv 合同5.docx rep5/合同5.docx")),
    );
    assert.equal(injected, true);
    assert.equal(rf(join(fx.work, "合同5.docx")), "CONTRACT5-CONTENT\n", "被移动的文件必须仍在原处");
    assert.equal(rf(join(fx.work, "rep5")), "REP5-ORIG\n");
    assert.equal(r.code, 75, r.err);
    assert.match(r.err, /合同5\.docx 未删除/);
  });

  test("S3-25/E6 暂存时 rep 刚被律师修改：被移动的文件不删，律师的修改原样", async () => {
    wf(join(fx.work, "rep6"), "REP6-ORIG\n");
    wf(join(fx.work, "合同6.docx"), "CONTRACT6-CONTENT\n");
    let injected = false;
    const r = await withHook(
      fx,
      "stageAside",
      async (orig, p: string, o: unknown) => {
        if (!injected && p.endsWith("/rep6")) {
          injected = true;
          wf(join(fx.work, "rep6"), "REP6-LAWYER-EDIT-DURING-COMMIT\n");
        }
        return orig(p, o);
      },
      async () => collect(await sh(fx, "mv rep6 tmp6 && mkdir rep6 && mv tmp6 rep6/v1 && mv 合同6.docx rep6/合同6.docx")),
    );
    assert.equal(injected, true);
    assert.equal(rf(join(fx.work, "合同6.docx")), "CONTRACT6-CONTENT\n");
    assert.equal(rf(join(fx.work, "rep6")), "REP6-LAWYER-EDIT-DURING-COMMIT\n");
    assert.equal(r.code, 75, r.err);
  });

  test("S3-25/E7 回滚时新目录里出现区外文件：原文件另存为可见恢复副本并在说明中给出位置", async () => {
    wf(join(fx.work, "rep7"), "REP7-ORIG\n");
    let injected = false;
    const r = await withHook(
      fx,
      "createExclusive",
      async (orig, p: string, d: Uint8Array) => {
        if (!injected && p.endsWith("/rep7/v2")) {
          injected = true;
          wf(join(fx.work, "rep7", "lawyer.txt"), "LAWYER-IN-NEWDIR\n");
          throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
        }
        return orig(p, d);
      },
      async () => collect(await sh(fx, "mv rep7 tmp7 && mkdir rep7 && mv tmp7 rep7/v1 && echo y > rep7/v2")),
    );
    assert.equal(injected, true);
    const holders = filesContaining(fx.work, "REP7-ORIG").filter((x) => !x.startsWith(".kwl-"));
    assert.ok(holders.some((x) => x.startsWith("rep7（恢复副本")), `原文件应在可见恢复副本中：${holders.join(",")}`);
    assert.equal(rf(join(fx.work, "rep7", "lawyer.txt")), "LAWYER-IN-NEWDIR\n");
    assert.equal(r.code, 75, r.err);
    assert.match(r.err, /原文件已另存为 .*rep7（恢复副本/);
  });

  test("S3-25 目录换文件：新内容在删除之前写进保留区；落位失败时另存为冲突副本，内容不丢", async () => {
    mkdirSync(join(fx.work, "d8"));
    wf(join(fx.work, "d8", "a.txt"), "D8-A-CONTENT\n");
    const ok = await collect(await sh(fx, "mv d8/a.txt t8 && rm -rf d8 && mv t8 d8"));
    assert.equal(ok.code, 0, ok.err);
    assert.equal(rf(join(fx.work, "d8")), "D8-A-CONTENT\n");
    mkdirSync(join(fx.work, "d9"));
    wf(join(fx.work, "d9", "a.txt"), "D9-A-CONTENT\n");
    let injected = false;
    const r = await withHook(
      fx,
      "placeStaged",
      async (orig, h: unknown, p: string) => {
        if (!injected && p.endsWith("/d9")) {
          injected = true;
          throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
        }
        return orig(h, p);
      },
      async () => collect(await sh(fx, "mv d9/a.txt t9 && rm -rf d9 && mv t9 d9")),
    );
    assert.equal(injected, true);
    const holders = filesContaining(fx.work, "D9-A-CONTENT").filter((x) => !x.startsWith(".kwl-"));
    assert.ok(holders.some((x) => x.startsWith("d9（执行冲突副本")), `内容应在冲突副本中：${holders.join(",")}`);
    assert.equal(r.code, 75, r.err);
  });

  test("S3-27 命令自身返回 124（exit 124、timeout 命令）不算执行域时限：改动照常写回，不说“超过执行时限”", async () => {
    const a = await collect(await sh(fx, "echo data > t2.txt; exit 124"));
    assert.equal(a.code, 124);
    assert.equal(rf(join(fx.work, "t2.txt")), "data\n");
    assert.doesNotMatch(a.err, /超过执行时限/);
    const b = await collect(await sh(fx, "echo data > t4.txt; timeout 1 sleep 3"));
    assert.equal(b.code, 124);
    assert.equal(rf(join(fx.work, "t4.txt")), "data\n");
    assert.doesNotMatch(b.err, /超过执行时限/);
    assert.equal(fx.events.filter((e) => e.type === "exec.finished").at(-1)?.reason, "completed");
  });

  test("S3-27 对照：真正超过执行时限仍判超时——退出码 124、改动不写回、说明“超过执行时限”", async () => {
    const fx3 = await fixture({ maxExecutionTimeMs: 2_000 });
    try {
      const r = await collect(await sh(fx3, "echo d > t5.txt; sleep 5; echo after > t6.txt"));
      assert.equal(r.code, 124, r.err);
      assert.equal(existsSync(join(fx3.work, "t5.txt")), false);
      assert.match(r.err, /超过执行时限/);
      assert.equal(fx3.events.filter((e) => e.type === "exec.finished").at(-1)?.reason, "timeout");
    } finally {
      await fx3.domain.close();
    }
  });

  test("S3-28 执行域不可用后按退避自行恢复（只查询健康状态，不直接运行命令）", async () => {
    const fx2 = await fixture({ recoveryRetryMs: 100 });
    try {
      const sup = fx2.domain.supervisor as unknown as { opts: { nodePath?: string } };
      const saved = sup.opts.nodePath;
      sup.opts.nodePath = "/nonexistent/kwl-node26/bin/node";
      process.kill(fx2.domain.supervisor.pid()!, "SIGKILL");
      await sleep(200);
      const r = await collect(await sh(fx2, "echo x"));
      assert.equal(r.code, 1);
      assert.match(fx2.domain.health() ?? "", /随包 Node 不可用/);
      (sup.opts as { nodePath?: string | undefined }).nodePath = saved;
      await sleep(150);
      fx2.domain.health(); // 退避已到：发起恢复探测
      await fx2.domain.settleProbe();
      assert.equal(fx2.domain.health(), null, "探测通过即恢复可用");
    } finally {
      await fx2.domain.close();
    }
  });
});

describe("第二轮复核 S3-26：文件系统字节上限（内存层）纳入结构化信号", () => {
  let fx: Fx;
  before(async () => {
    fx = await fixture({ maxMemoryBytes: 4 * 1024 * 1024 });
    wf(join(fx.work, "f.csv"), `${"2026-01-01,对手方甲,1234.56,".padEnd(96, "x")}\n`.repeat(15_000));
  });
  after(async () => {
    await fx.domain.close();
  });

  test("N3 python3 写出超过内存层上限到律师已有文件（异常在析构时被吞、退出码 0）：整体不写回，退出码 126，说明资源上限", async () => {
    wf(join(fx.work, "out.csv"), "LAWYER-OUT\n");
    const r = await collect(await sh(fx, `python3 -c "d=open('f.csv').read(); open('out.csv','w').write(d*3)"; echo rc=$?`));
    assert.equal(rf(join(fx.work, "out.csv")), "LAWYER-OUT\n", "律师已有文件不得被截断版本覆盖");
    assert.equal(r.code, 126, r.err);
    assert.match(r.err, /执行域资源上限（fs_bytes_overlay）/);
  });

  test("N4 python3 捕获写出异常后正常退出：同样整体不写回（之前写的小文件也不写回）", async () => {
    wf(join(fx.work, "out.csv"), "LAWYER-OUT\n");
    const r = await collect(
      await sh(
        fx,
        `python3 -c "
open('small.txt','w').write('ok')
try:
    open('out.csv','w').write(open('f.csv').read()*3)
except OSError as e:
    print('caught', e.errno)
"`,
      ),
    );
    assert.equal(rf(join(fx.work, "out.csv")), "LAWYER-OUT\n");
    assert.equal(existsSync(join(fx.work, "small.txt")), false);
    assert.equal(r.code, 126, r.err);
  });

  test("bash 重定向撞上内存层上限：整段中止、不写回，按资源上限说明（不说超时）", async () => {
    wf(join(fx.work, "out2.csv"), "LAWYER-OUT2\n");
    const r = await collect(await sh(fx, "cp f.csv c1.csv; cp f.csv c2.csv; sort f.csv > out2.csv; echo rc=$?"));
    assert.equal(rf(join(fx.work, "out2.csv")), "LAWYER-OUT2\n");
    assert.doesNotMatch(r.err, /超过执行时限/);
    assert.match(r.err, /执行域资源上限/);
    assert.notEqual(r.code, 0);
  });
});

describe("抽查 S3-30 / S3-31：单文件读入上限纳入结构化信号；目录换文件落位失败时源文件不删", () => {
  let fx: Fx;
  before(async () => {
    fx = await fixture({ maxFileReadSize: 1024 * 1024 });
    wf(join(fx.work, "f.csv"), `${"2026-01-01,对手方甲,1234.56,".padEnd(96, "x")}\n`.repeat(17_000));
  });
  after(async () => {
    await fx.domain.close();
  });

  for (const [id, cmd] of [
    ["RS1", "sort f.csv > out.csv; echo rc=$?"],
    ["RS2", "cat f.csv > out.csv; echo rc=$?"],
    ["RS3", "awk '{print}' f.csv > out.csv; echo rc=$?"],
  ] as const) {
    test(`S3-30/${id} 读入超过单文件上限（命令报“文件不存在”、整体退出码 0）：整体不写回，律师已有文件原样，退出码 126`, async () => {
      wf(join(fx.work, "out.csv"), "LAWYER-OUT\n");
      const r = await collect(await sh(fx, cmd));
      assert.equal(rf(join(fx.work, "out.csv")), "LAWYER-OUT\n", "律师已有文件不得被 0 字节版本覆盖");
      assert.equal(r.code, 126, r.err);
      assert.match(r.err, /执行域资源上限（fs_file_too_large_overlay）/);
    });
  }

  test("S3-31 目录换文件：落位与冲突副本都失败时，被移成这个名字的源文件不删，说明给出保留区位置", async () => {
    mkdirSync(join(fx.work, "d31"));
    wf(join(fx.work, "d31", "a.txt"), "D31-A\n");
    wf(join(fx.work, "合同31.docx"), "CONTRACT31-CONTENT\n");
    let calls = 0;
    const r = await withHook(
      fx,
      "placeStaged",
      async (_orig, _h: unknown, _p: string) => {
        calls += 1;
        throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
      },
      async () => collect(await sh(fx, "rm -rf d31 && mv 合同31.docx d31")),
    );
    assert.ok(calls >= 2, "落位与另存都尝试过");
    assert.equal(rf(join(fx.work, "合同31.docx")), "CONTRACT31-CONTENT\n", "源文件不得先删");
    assert.equal(r.code, 75, r.err);
    assert.match(r.err, /暂存在工作区保留区 .*\.kwl-stage/);
    assert.match(r.err, /合同31\.docx 未删除/);
  });
});
