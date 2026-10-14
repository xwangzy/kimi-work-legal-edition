/**
 * W 执行域在加密工作区与加密材料快照上运行（审计 S3 第 2 步；设计 §4.4、§6.2“W”行）：
 * 读层解封（cat、grep -r、wc -c、ls -l、stat、python3、sqlite3、kwl-docx 走同一虚拟文件系统）、写入经 broker 提交即加密、
 * 内容未变不写回、严格形态拒读外部植入的明文、区密钥不对就读不出、提交冲突判定按盘上身份。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveZoneKey, ZoneCodec } from "@zr-legal/at-rest";
import { FileBroker } from "@zr-legal/file-broker";
import { WCoreDomain, type WProcess } from "../src/domain.ts";

const CANARY = "KWLCANARYWSEAL4417";

interface Fx {
  base: string;
  work: string;
  materials: string;
  broker: FileBroker;
  domain: WCoreDomain;
  codecs: { work: ZoneCodec; materials: ZoneCodec };
}

let fx: Fx;

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

const run = async (cmd: string) => collect(await fx.domain.run(cmd, { cwd: fx.work }));

before(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "kwl-wseal-")));
  const work = join(base, "matter", "work");
  const materials = join(base, "matter", "materials");
  for (const d of [work, materials]) mkdirSync(d, { recursive: true });
  const ws = randomBytes(32);
  const codecs = {
    work: new ZoneCodec("work", new Map([[1, deriveZoneKey(ws, "work")]]), 1),
    materials: new ZoneCodec("materials", new Map([[1, deriveZoneKey(ws, "materials")]]), 1),
  };
  // 材料快照由宿主以区密钥封装写入（与 kap-host 相同）
  writeFileSync(join(materials, "001.txt"), codecs.materials.seal(Buffer.from(`借款合同\n出借人：澜沧科技有限公司 ${CANARY}\n借款金额：人民币 100,000 元\n`, "utf8")));
  const broker = new FileBroker([
    { name: "materials", root: materials, access: "ro", codec: codecs.materials, strict: true, chunkedOnly: true },
    { name: "work", root: work, access: "rw", codec: codecs.work, strict: true, chunkedOnly: true },
  ]);
  await broker.writeText(join(work, "台账.csv"), `编号,金额\n1,100\n2,250\n3,${CANARY.length}\n`);
  const domain = await WCoreDomain.start({
    broker,
    work: { zone: "work", root: work },
    readOnlyRoots: [materials],
    sealed: { work: codecs.work.toWire(), readOnly: { [materials]: codecs.materials.toWire() }, strict: true },
    pathClass: "posix",
    tmpDir: join(base, "w-tmp"),
    supervisor: { maxConcurrent: 2 },
  });
  fx = { base, work, materials, broker, domain, codecs };
});

after(async () => {
  await fx?.domain.close();
  if (fx) rmSync(fx.base, { recursive: true, force: true });
});

/** 磁盘上（工作区、材料、W 临时目录）任何文件里出现金丝雀明文的路径。 */
function diskHits(needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (readFileSync(p).includes(Buffer.from(needle))) hits.push(p);
    }
  };
  walk(fx.base);
  return hits;
}

test("读层解封：cat、grep -r、wc -c、head、ls -l、stat 读到明文与明文长度；盘上始终是 KWE1", async () => {
  const r = await run(`cat ${fx.materials}/001.txt && grep -rn "${CANARY}" ${fx.materials} && wc -c < ${fx.work}/台账.csv && head -2 ${fx.work}/台账.csv`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`出借人：澜沧科技有限公司 ${CANARY}`));
  assert.match(r.out, new RegExp(`001.txt:2:出借人`));
  const plainLen = Buffer.byteLength(`编号,金额\n1,100\n2,250\n3,${CANARY.length}\n`);
  assert.match(r.out, new RegExp(`^${plainLen}$`, "m"), "wc -c 报告明文长度");
  assert.match(r.out, /编号,金额\n1,100/);
  const ls = await run(`ls -l ${fx.work}/台账.csv; stat -c %s ${fx.work}/台账.csv`);
  assert.equal(ls.code, 0, ls.err);
  assert.match(ls.out, new RegExp(`\\b${plainLen}\\b`), "ls -l / stat 报告明文长度");
  assert.equal(readFileSync(join(fx.work, "台账.csv")).subarray(0, 4).toString(), "KWE1");
  assert.deepEqual(diskHits(CANARY), []);
});

test("python3 与 sqlite3 经同一读层读加密文件；写出的新文件经 broker 提交为密文；内容未变的文件不写回", async () => {
  const before = statSync(join(fx.work, "台账.csv"));
  const r = await run(
    [
      `python3 -c "import csv; rows=list(csv.reader(open('${fx.work}/台账.csv', encoding='utf-8'))); print(sum(int(r[1]) for r in rows[1:])); open('${fx.work}/汇总.txt','w',encoding='utf-8').write('合计 ' + '${CANARY}')"`,
      `sqlite3 ${fx.work}/t.db "create table t(x text); insert into t values ('${CANARY}');"`,
      `sqlite3 ${fx.work}/t.db "select x from t;"`,
      `cp ${fx.work}/台账.csv ${fx.work}/台账-副本.csv`,
      `cat ${fx.work}/台账.csv > /dev/null`,
    ].join(" && "),
  );
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^${100 + 250 + CANARY.length}$`, "m"));
  assert.match(r.out, new RegExp(`^${CANARY}$`, "m"));
  for (const f of ["汇总.txt", "t.db", "台账-副本.csv"]) assert.equal(readFileSync(join(fx.work, f)).subarray(0, 4).toString(), "KWE1", `${f} 是密文`);
  assert.equal(await fx.broker.readText(join(fx.work, "汇总.txt")), `合计 ${CANARY}`);
  assert.equal(await fx.broker.readText(join(fx.work, "台账-副本.csv")), await fx.broker.readText(join(fx.work, "台账.csv")));
  const afterSt = statSync(join(fx.work, "台账.csv"));
  assert.equal(afterSt.ino, before.ino, "只读过、未改动的文件不被重写");
  assert.equal(afterSt.mtimeMs, before.mtimeMs);
  // 只 touch/chmod 而内容不变：内存层的明文与盘上解封内容相同 → 跳过（不按密文长度误判为改动）
  const t = await run(`chmod 600 ${fx.work}/台账.csv`);
  assert.equal(t.code, 0, t.err);
  assert.equal(statSync(join(fx.work, "台账.csv")).ino, before.ino);
  assert.deepEqual(diskHits(CANARY), []);
});

test("追加与改写已有加密文件：sed -i、>> 追加经提交写回（比较—替换按盘上身份，不误报冲突）", async () => {
  await fx.broker.writeText(join(fx.work, "备忘.md"), "第一行\n");
  const r = await run(`echo "第二行 ${CANARY}" >> ${fx.work}/备忘.md && sed -i 's/第一行/首行/' ${fx.work}/备忘.md && cat ${fx.work}/备忘.md`);
  assert.equal(r.code, 0, `${r.err}`);
  assert.equal(r.err.includes("冲突"), false, r.err);
  assert.equal(await fx.broker.readText(join(fx.work, "备忘.md")), `首行\n第二行 ${CANARY}\n`);
  assert.equal(readdirSync(fx.work).some((n) => n.includes("冲突副本")), false);
  assert.deepEqual(diskHits(CANARY), []);
});

test("严格形态：工作区里被外部植入的明文文件，W 内读取报错、不当作内容；材料区不可写；用别的密钥封装的文件读不出", async () => {
  writeFileSync(join(fx.work, "植入.txt"), "外部写入的明文 不应被当作工作区内容");
  // 拒读：命令失败、内容不出现（just-bash 的 cat 把读错误一律报成“没有这个文件”，python3 报 I/O 错误）
  const r = await run(`cat ${fx.work}/植入.txt`);
  assert.notEqual(r.code, 0);
  assert.equal(r.out.includes("外部写入的明文"), false);
  const py = await run(`python3 -c "print(open('${fx.work}/植入.txt', encoding='utf-8').read())"`);
  assert.notEqual(py.code, 0);
  assert.equal(py.out.includes("外部写入的明文"), false);
  const foreign = new ZoneCodec("work", new Map([[1, deriveZoneKey(randomBytes(32), "work")]]), 1);
  writeFileSync(join(fx.work, "他钥.txt"), foreign.seal(Buffer.from("别的事项")));
  const f = await run(`cat ${fx.work}/他钥.txt`);
  assert.notEqual(f.code, 0);
  assert.equal(f.out.includes("别的事项"), false);
  const w = await run(`echo x > ${fx.materials}/new.txt`);
  assert.notEqual(w.code, 0);
  // 复核 S3B-B01：just-bash 的 >> 与 python3 的 'a' 模式吞掉读错误、把读不出的文件当空文件——解密层报告拒读，整次改动不写回
  const plantedBytes = readFileSync(join(fx.work, "植入.txt"));
  const foreignBytes = readFileSync(join(fx.work, "他钥.txt"));
  // 伪造的“只有头的空日志”（无需密钥即可构造）同样拒读（复核 S3B-A04）
  writeFileSync(join(fx.work, "空日志.txt"), fx.codecs.work.newLog());
  const emptyLog = readFileSync(join(fx.work, "空日志.txt"));
  for (const f of ["植入.txt", "他钥.txt", "空日志.txt"]) {
    for (const cmd of [`echo 追加 >> ${fx.work}/${f}`, `: >> ${fx.work}/${f}`, `echo 追加 | tee -a ${fx.work}/${f}`, `python3 -c "open('${fx.work}/${f}','a').write('追加')"`]) {
      const r = await run(cmd);
      assert.notEqual(r.code, 0, `${cmd}：应以非 0 结束`);
      assert.match(r.err, /无法解密的工作区或材料文件/, `${cmd}：应说明改动未写回`);
    }
  }
  assert.ok(readFileSync(join(fx.work, "植入.txt")).equals(plantedBytes), "外部植入的明文未被改写");
  assert.ok(readFileSync(join(fx.work, "他钥.txt")).equals(foreignBytes), "他钥密文未被改写");
  assert.ok(readFileSync(join(fx.work, "空日志.txt")).equals(emptyLog), "伪造的空日志未被改写");
  await assert.rejects(fx.broker.readText(join(fx.work, "空日志.txt")), /unexpected format/);
  rmSync(join(fx.work, "植入.txt"));
  rmSync(join(fx.work, "他钥.txt"));
  rmSync(join(fx.work, "空日志.txt"));
});

test("W 临时目录运行后为空（含点文件）；挂载给 W 的区密钥只有工作区与材料两个用途", async () => {
  const r = await run(`ls -la /tmp && echo ok`);
  assert.equal(r.code, 0, r.err);
  const tmp = join(fx.base, "w-tmp");
  const left = (() => {
    try {
      return readdirSync(tmp);
    } catch {
      return [];
    }
  })();
  assert.deepEqual(left, [], "W 临时目录不留文件");
  const purposes = (fx.domain as unknown as { mounts: { sealed?: { keys: { purpose: string } } }[] }).mounts.map((m) => m.sealed?.keys.purpose ?? null);
  assert.deepEqual(purposes, ["work", "materials"], "W 只拿到工作区与材料两把区密钥");
});
