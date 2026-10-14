/**
 * 文件 broker（v9 第 04 篇 §4.4；06 T02）：符号链接、junction、重解析点、UNC、大小写、长路径、
 * 保留设备名、硬链接投毒全部拒绝；Windows 合法子路径不再被误拒（F2）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBroker, BrokerError, relativeUnder, splitAbsolute, splitRelative, PathRejected } from "../src/index.ts";

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "kwl-broker-"));
  const originals = join(base, "matter", "originals");
  const work = join(base, "matter", "work");
  const deliver = join(base, "matter", "deliver");
  const outside = join(base, "outside");
  for (const d of [originals, work, deliver, outside]) await mkdir(d, { recursive: true });
  await writeFile(join(originals, "合同.txt"), "原件内容");
  await writeFile(join(outside, "secret.txt"), "区域外的秘密");
  const broker = new FileBroker([
    { name: "originals", root: originals, access: "ro" },
    { name: "work", root: work, access: "rw" },
    { name: "deliver", root: deliver, access: "ro" },
  ]);
  return { base, originals, work, deliver, outside, broker, cleanup: () => rm(base, { recursive: true, force: true }) };
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof BrokerError && e.code === code);
}

test("区域内读写；原件区只读（EPERM）；区域外一律 ENOENT", async () => {
  const s = await setup();
  try {
    assert.equal(await s.broker.readText(join(s.originals, "合同.txt")), "原件内容");
    await s.broker.writeText(join(s.work, "草稿.md"), "草稿");
    assert.equal(await readFile(join(s.work, "草稿.md"), "utf8"), "草稿");
    await rejects(s.broker.writeText(join(s.originals, "合同.txt"), "篡改"), "EPERM");
    await rejects(s.broker.writeText(join(s.deliver, "交付.docx"), "Agent 写交付区"), "EPERM");
    await rejects(s.broker.readText(join(s.outside, "secret.txt")), "ENOENT");
    await rejects(s.broker.writeText(join(s.outside, "x.txt"), "越界写"), "ENOENT");
    assert.equal(await readFile(join(s.originals, "合同.txt"), "utf8"), "原件内容", "原件未被修改");
  } finally {
    await s.cleanup();
  }
});

test("符号链接逃逸：终点链接、父级链接、字符串前缀相同的兄弟目录全部拒绝", async () => {
  const s = await setup();
  try {
    await symlink(join(s.outside, "secret.txt"), join(s.work, "link.txt"));
    await rejects(s.broker.readText(join(s.work, "link.txt")), "ELOOP");
    await rejects(s.broker.writeText(join(s.work, "link.txt"), "经链接写出"), "ELOOP");
    await symlink(s.outside, join(s.work, "linkdir"));
    await rejects(s.broker.readText(join(s.work, "linkdir", "secret.txt")), "ELOOP");
    await rejects(s.broker.writeText(join(s.work, "linkdir", "new.txt"), "经父级链接写出"), "ELOOP");
    await rejects(s.broker.mkdir(join(s.work, "linkdir", "sub"), { recursive: true }), "ELOOP");
    // 旧实现的字符串前缀判定：work-evil 以 work 为前缀，但不在区域内
    const evil = `${s.work}-evil`;
    await mkdir(evil);
    await writeFile(join(evil, "x.txt"), "兄弟目录");
    await rejects(s.broker.readText(join(evil, "x.txt")), "ENOENT");
    // lstat 如实报告链接（可见、不可跟随）
    const st = await s.broker.lstat(join(s.work, "link.txt"));
    assert.equal(st.isSymbolicLink, true);
    await rejects(s.broker.stat(join(s.work, "link.txt")), "ELOOP");
    assert.equal(await readFile(join(s.outside, "secret.txt"), "utf8"), "区域外的秘密", "区域外文件未被改写");
  } finally {
    await s.cleanup();
  }
});

test("硬链接投毒：读区域内指向区域外 inode 的硬链接拒绝（EMLINK）；写入只替换目录项、区域外 inode 不受影响", async () => {
  const s = await setup();
  try {
    await link(join(s.outside, "secret.txt"), join(s.work, "hard.txt"));
    await rejects(s.broker.readText(join(s.work, "hard.txt")), "EMLINK");
    await rejects(s.broker.appendText(join(s.work, "hard.txt"), "追加到外部 inode"), "EMLINK");
    await s.broker.writeText(join(s.work, "hard.txt"), "新内容（替换目录项）");
    assert.equal(await readFile(join(s.outside, "secret.txt"), "utf8"), "区域外的秘密", "区域外 inode 未被截断或改写");
    assert.equal(await readFile(join(s.work, "hard.txt"), "utf8"), "新内容（替换目录项）");
  } finally {
    await s.cleanup();
  }
});

test("写入不以 O_TRUNC 打开既有路径：目标处的符号链接被替换为普通文件，链接指向的区域外文件不变", async () => {
  const s = await setup();
  try {
    // 直接寻址链接本身会在逐级 lstat 处被拒（ELOOP）；这里验证即使竞争中终点变成链接，也只会替换目录项
    await symlink(join(s.outside, "secret.txt"), join(s.work, "late-link.txt"));
    await rejects(s.broker.writeText(join(s.work, "late-link.txt"), "x"), "ELOOP");
    assert.equal(await readFile(join(s.outside, "secret.txt"), "utf8"), "区域外的秘密");
  } finally {
    await s.cleanup();
  }
});

test("createExclusive / append / mkdir / remove / readdir / realpath 语义", async () => {
  const s = await setup();
  try {
    const p = join(s.work, "a", "b", "c.txt");
    await s.broker.mkdir(join(s.work, "a", "b"), { recursive: true });
    assert.equal(await s.broker.createExclusive(p, Buffer.from("1")), true);
    assert.equal(await s.broker.createExclusive(p, Buffer.from("2")), false);
    await s.broker.appendText(p, "+");
    assert.equal(await s.broker.readText(p), "1+");
    const names = (await s.broker.readdir(join(s.work, "a", "b"))).map((e) => e.name);
    assert.deepEqual(names, ["c.txt"]);
    assert.equal(await s.broker.realpath(p), p);
    await rejects(s.broker.remove(s.work), "EPERM");
    await s.broker.remove(join(s.work, "a"));
    await rejects(s.broker.stat(p), "ENOENT");
    const bytes = await s.broker.readBytes(join(s.originals, "合同.txt"), 3, 3);
    assert.equal(Buffer.from(bytes).toString("utf8"), "件");
  } finally {
    await s.cleanup();
  }
});

test("只读文件按对象身份保护：直接名、大小写变体、Unicode 折叠别名（ſ）、删除其父目录、独占创建别名，全部拒绝", async () => {
  const s = await setup();
  try {
    const sub = join(s.work, "sub");
    await mkdir(sub);
    const cfg = join(s.work, "mcp.json");
    const nested = join(sub, "cfg.toml");
    await writeFile(cfg, '{"mcpServers":{"legal":{}}}');
    await writeFile(nested, "telemetry = false\n");
    const b = new FileBroker([{ name: "work", root: s.work, access: "rw" }], { readOnlyFiles: [cfg, nested] });
    assert.match(await b.readText(cfg), /legal/);
    await rejects(b.writeText(cfg, "{}"), "EPERM");
    await rejects(b.appendText(cfg, "x"), "EPERM");
    await rejects(b.remove(cfg), "EPERM");
    const caseInsensitive = process.platform !== "linux";
    if (caseInsensitive) {
      await rejects(b.writeText(join(s.work, "MCP.JSON"), "{}"), "EPERM");
      // 审查 R-12 的攻击：ſ (U+017F) 在 APFS / NTFS 上折叠为 s，mcp.jſon 与 mcp.json 是同一个 inode
      const alias = join(s.work, "mcp.j\u017Fon");
      await rejects(b.remove(alias), "EPERM");
      await rejects(b.writeText(alias, '{"mcpServers":{"evil":{"url":"http://attacker"}}}'), "EPERM");
      assert.equal(await b.createExclusive(alias, Buffer.from("{}")), false, "目标已存在（别名）→ 独占创建失败");
    }
    await rejects(b.remove(sub), "EPERM", );
    assert.match(await readFile(cfg, "utf8"), /legal/, "受保护文件内容未变");
    assert.equal(await readFile(nested, "utf8"), "telemetry = false\n");
    await b.writeText(join(s.work, "other.txt"), "其他文件可写");
    await b.remove(join(s.work, "other.txt"));
    assert.throws(() => new FileBroker([{ name: "work", root: s.work, access: "rw" }], { readOnlyFiles: [join(s.outside, "x")] }), /不在任何区域/);
  } finally {
    await s.cleanup();
  }
});

test("保留名 .kwl-*（回收目录、临时文件）对 Agent 不可见、不可寻址；删除经回收目录且不留残余", async () => {
  const s = await setup();
  try {
    await s.broker.writeText(join(s.work, "a.txt"), "1");
    await s.broker.remove(join(s.work, "a.txt"));
    const names = (await s.broker.readdir(s.work)).map((e) => e.name);
    assert.deepEqual(names, [], "回收目录与临时文件不出现在列表中");
    await rejects(s.broker.readdir(join(s.work, ".kwl-trash")), "ENOENT");
    await rejects(s.broker.writeText(join(s.work, ".kwl-tmp-evil"), "x"), "ENOENT");
    const raw = await readdir(join(s.work, ".kwl-trash"));
    assert.deepEqual(raw, [], "回收目录中的对象已被删除");
  } finally {
    await s.cleanup();
  }
});

test("区域不得重叠（同一文件不能有两种权限）", async () => {
  const s = await setup();
  try {
    assert.throws(
      () =>
        new FileBroker([
          { name: "work", root: s.work, access: "rw" },
          { name: "inner", root: join(s.work, "inner"), access: "ro" },
        ]),
      /区域重叠/,
    );
  } finally {
    await s.cleanup();
  }
});

test("Windows 路径语义：合法子路径按分量匹配（不再被固定 / 误拒）；UNC/设备/盘符相对/ADS/保留名/尾点全部拒绝", () => {
  const root = splitAbsolute("C:\\Users\\律师\\事项\\work", "win32");
  assert.deepEqual(relativeUnder(root, splitAbsolute("C:\\Users\\律师\\事项\\work\\草稿\\a.docx", "win32"), "win32"), ["草稿", "a.docx"]);
  assert.deepEqual(relativeUnder(root, splitAbsolute("c:/users/律师/事项/WORK/b.txt", "win32"), "win32"), ["b.txt"], "盘符与大小写变体按分量折叠");
  assert.equal(relativeUnder(root, splitAbsolute("C:\\Users\\律师\\事项\\work-evil\\a.txt", "win32"), "win32"), null);
  assert.equal(relativeUnder(root, splitAbsolute("D:\\Users\\律师\\事项\\work\\a.txt", "win32"), "win32"), null);
  const bad = [
    "\\\\server\\share\\work\\a.txt",
    "\\\\?\\C:\\Users\\a.txt",
    "\\\\.\\PhysicalDrive0",
    "C:relative\\a.txt",
    "C:\\Users\\律师\\事项\\work\\a.txt:secret",
    "C:\\Users\\律师\\事项\\work\\CON",
    "C:\\Users\\律师\\事项\\work\\nul.txt",
    "C:\\Users\\律师\\事项\\work\\com1.log",
    "C:\\Users\\律师\\事项\\work\\a.txt.",
    "C:\\Users\\律师\\事项\\work\\a.txt ",
    "C:\\Users\\律师\\事项\\work\\a<b>.txt",
    `C:\\${"x".repeat(300)}\\a.txt`,
    `C:\\Users\\${"长".repeat(140)}\\${"案".repeat(140)}\\a.txt`,
    "C:\\Users\\律师\\事项\\work\\MCP~1.JSO",
    "C:\\Users\\律师\\事项\\work\\CONFIG~12.TOM",
  ];
  for (const p of bad) assert.throws(() => splitAbsolute(p, "win32"), PathRejected, p);
  assert.throws(() => splitAbsolute("relative/a.txt", "posix"), PathRejected);
  assert.throws(() => splitAbsolute("/a/\u0000/b", "posix"), PathRejected);
});

test("区域相对路径接口拒绝绝对路径与 ..", () => {
  assert.deepEqual(splitRelative("草稿/a.txt", "posix"), ["草稿", "a.txt"]);
  for (const p of ["/etc/passwd", "../x", "a/../../x", "C:\\x", "\\\\server\\x"]) assert.throws(() => splitRelative(p, "posix"), PathRejected, p);
  for (const p of ["a\\..\\..\\x", "CON", "a.txt:ads"]) assert.throws(() => splitRelative(p, "win32"), PathRejected, p);
});

test("asHostFileSystem 形状覆盖引擎 IHostFileSystem 的全部方法", async () => {
  const s = await setup();
  try {
    const fs = s.broker.asHostFileSystem();
    for (const m of ["readText", "writeText", "appendText", "readBytes", "writeBytes", "readLines", "createExclusive", "stat", "lstat", "readdir", "mkdir", "remove", "realpath"]) {
      assert.equal(typeof fs[m], "function", m);
    }
    const lines: string[] = [];
    await (fs.writeText as (p: string, d: string) => Promise<void>)(join(s.work, "l.txt"), "a\nb");
    for await (const l of (fs.readLines as (p: string) => AsyncGenerator<string>)(join(s.work, "l.txt"))) lines.push(l);
    assert.deepEqual(lines, ["a", "b"]);
  } finally {
    await s.cleanup();
  }
});

test("findLinks（审查 S2-14、S3-02）：列出搜索范围内的符号链接、硬链接与非常规文件（保留名之下同样检查）；超出上限报 truncated；终点是链接即 ELOOP", async () => {
  const { base, work, outside } = await setup();
  const broker = new FileBroker([{ name: "work", root: work, access: "rw" }]);
  await mkdir(join(work, "a", "b"), { recursive: true });
  await writeFile(join(work, "a", "b", "ok.txt"), "x");
  assert.deepEqual(await broker.findLinks(work), { links: [], truncated: false });
  await link(join(outside, "secret.txt"), join(work, "a", "b", "hl.txt"));
  await symlink(outside, join(work, "a", "sl"));
  const r = await broker.findLinks(work);
  assert.deepEqual(r.links, [join(work, "a", "b", "hl.txt"), join(work, "a", "sl")]);
  assert.deepEqual((await broker.findLinks(join(work, "a", "b", "hl.txt"))).links, [join(work, "a", "b", "hl.txt")]);
  await assert.rejects(broker.findLinks(join(work, "a", "sl")), /ELOOP/);
  assert.equal((await broker.findLinks(work, { maxEntries: 2 })).truncated, true);
  await rm(join(work, "a", "b", "hl.txt"));
  await rm(join(work, "a", "sl"));
  // 审查 S3-02：保留名之下 Agent 的文件工具看不到，但原生 rg（--hidden）与执行域读盘层看得到——同样检查
  await mkdir(join(work, ".kwl-cache"), { recursive: true });
  await link(join(outside, "secret.txt"), join(work, ".kwl-cache", "hl.txt"));
  assert.deepEqual((await broker.findLinks(work)).links, [join(work, ".kwl-cache", "hl.txt")]);
  await rm(join(work, ".kwl-cache", "hl.txt"));
  assert.deepEqual((await broker.findLinks(work)).links, []);
  await rm(base, { recursive: true, force: true });
});

test("路径长度按操作系统上限（POSIX 按字节）：超限在定位阶段即拒绝（ENAMETOOLONG），不会走到写入或删除", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows 按 MAX_PATH 字符数判定（另有用例）");
    return;
  }
  const { base, work } = await setup();
  const broker = new FileBroker([{ name: "work", root: work, access: "rw" }]);
  const comp = "归档目录".repeat(21); // 84 个汉字 = 252 字节：单个分量合法
  assert.throws(() => broker.locateIn("work", "汉".repeat(86)), /component|分量/); // 258 字节 > NAME_MAX
  const deep = Array.from({ length: 6 }, () => comp).join("/"); // 6 × 253 字节 ≈ 1.5 KB
  if (process.platform === "darwin") {
    assert.throws(() => broker.locateIn("work", `${deep}/a.txt`), /ENAMETOOLONG/);
    assert.equal(broker.locate(join(work, deep, "a.txt")), null);
  }
  assert.ok(broker.locateIn("work", `${comp}/a.txt`));
  await rm(base, { recursive: true, force: true });
});

test("writeBytes durable:false：只对新建文件跳过 fsync，内容与原子替换语义不变；目标已存在时照常替换", async () => {
  const { base, work } = await setup();
  const broker = new FileBroker([{ name: "work", root: work, access: "rw" }]);
  await broker.writeBytes(join(work, "新.txt"), new Uint8Array(Buffer.from("新内容")), { durable: false });
  assert.equal(await readFile(join(work, "新.txt"), "utf8"), "新内容");
  await broker.writeBytes(join(work, "新.txt"), new Uint8Array(Buffer.from("覆盖")), { durable: false });
  assert.equal(await readFile(join(work, "新.txt"), "utf8"), "覆盖");
  assert.deepEqual((await readdir(work)).filter((n) => n.startsWith(".kwl-")), []);
  await rm(base, { recursive: true, force: true });
});

// ─── 加密区（审计 S3 第 2 步：工作区与材料快照透明加密） ───

async function sealedSetup(strict = true) {
  const { deriveZoneKey, ZoneCodec } = await import("@zr-legal/at-rest");
  const { randomBytes } = await import("node:crypto");
  const s = await setup();
  const ws = randomBytes(32);
  const codecOf = (p: "work" | "materials") => new ZoneCodec(p, new Map([[1, deriveZoneKey(ws, p)]]), 1);
  const work = codecOf("work");
  const materials = codecOf("materials");
  const broker = new FileBroker([
    { name: "originals", root: s.originals, access: "ro", codec: materials, strict },
    { name: "work", root: s.work, access: "rw", codec: work, strict },
  ]);
  return { ...s, broker, work: s.work, codecs: { work, materials } };
}

test("加密区：写入即 KWE1（盘上无明文片段）；读出明文；stat.size 为明文长度、diskSize 为盘上长度；追加、独占创建、暂存落位同样加密", async () => {
  const s = await sealedSetup();
  try {
    const p = join(s.work, "草稿.md");
    const text = "甲方澜沧科技有限公司 金丝雀KWLSEALBROKER01 应于三十日内付款。";
    await s.broker.writeText(p, text);
    const disk = await readFile(p);
    assert.equal(disk.subarray(0, 4).toString(), "KWE1");
    assert.equal(disk.includes(Buffer.from("KWLSEALBROKER01")), false);
    assert.equal(await s.broker.readText(p), text);
    const st = await s.broker.stat(p);
    assert.equal(st.size, Buffer.byteLength(text));
    assert.equal(st.diskSize, disk.length);
    assert.equal((await s.broker.lstat(p)).size, Buffer.byteLength(text));
    await s.broker.appendText(p, "\n追加一行KWLSEALBROKER02");
    assert.equal(await s.broker.readText(p), `${text}\n追加一行KWLSEALBROKER02`);
    assert.equal((await readFile(p)).includes(Buffer.from("KWLSEALBROKER02")), false);
    assert.equal(await s.broker.createExclusive(join(s.work, "新.txt"), Buffer.from("独占KWLSEALBROKER03")), true);
    assert.equal((await readFile(join(s.work, "新.txt"))).includes(Buffer.from("KWLSEALBROKER03")), false);
    const h = await s.broker.stageContent(join(s.work, "落位.txt"), Buffer.from("暂存KWLSEALBROKER04"));
    await s.broker.placeStaged(h, join(s.work, "落位.txt"));
    assert.equal(await s.broker.readText(join(s.work, "落位.txt")), "暂存KWLSEALBROKER04");
    assert.equal((await readFile(join(s.work, "落位.txt"))).includes(Buffer.from("KWLSEALBROKER04")), false);
    // 加密区之间互不可解：材料区的密文放进工作区读不出（用途绑定）
    await writeFile(join(s.originals, "m.txt"), s.codecs.materials.seal(Buffer.from("材料")));
    assert.equal(await s.broker.readText(join(s.originals, "m.txt")), "材料");
    await writeFile(join(s.work, "错区.txt"), s.codecs.materials.seal(Buffer.from("材料")));
    await assert.rejects(s.broker.readText(join(s.work, "错区.txt")), /不属于这个用途/);
  } finally {
    await s.cleanup();
  }
});

test("加密区随机读：readBytes(n, offset) 跨分块边界与整文件解封一致；区间不含末块时仍认证末块（截断不被当成“更短”）", async () => {
  const s = await sealedSetup();
  try {
    const { CHUNK_BYTES } = await import("@zr-legal/at-rest");
    const { randomBytes } = await import("node:crypto");
    const p = join(s.work, "大.bin");
    const plain = randomBytes(3 * CHUNK_BYTES + 123);
    await s.broker.writeBytes(p, plain);
    for (const [off, n] of [[0, 10], [CHUNK_BYTES - 5, 10], [CHUNK_BYTES, CHUNK_BYTES], [2 * CHUNK_BYTES + 7, CHUNK_BYTES + 200], [plain.length - 1, 5], [plain.length, 5], [plain.length + 100, 5]] as const) {
      const got = Buffer.from(await s.broker.readBytes(p, n, off));
      assert.ok(got.equals(plain.subarray(off, off + n)), `offset=${off} n=${n}`);
    }
    assert.ok(Buffer.from(await s.broker.readBytes(p)).equals(plain));
    // 截断到分块边界（去掉末块）：头部区间读取也报错（末块认证失败），stat 不当成功
    const disk = await readFile(p);
    await writeFile(p, disk.subarray(0, 64 + 2 * (CHUNK_BYTES + 28)));
    await assert.rejects(s.broker.readBytes(p, 10, 0), /认证失败/);
    await assert.rejects(s.broker.readBytes(p), /认证失败/);
  } finally {
    await s.cleanup();
  }
});

test("加密区比较—替换：期望状态用盘上三元组（diskSize）；用明文长度构造的期望判为冲突", async () => {
  const s = await sealedSetup();
  try {
    const p = join(s.work, "合同.md");
    await s.broker.writeText(p, "第一版");
    const st = await s.broker.lstat(p);
    await assert.rejects(s.broker.writeBytes(p, Buffer.from("x"), { expect: { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } }), (e: any) => e.code === "ECONFLICT");
    await s.broker.writeBytes(p, Buffer.from("第二版"), { expect: { ino: st.ino, size: st.diskSize, mtimeMs: st.mtimeMs } });
    assert.equal(await s.broker.readText(p), "第二版");
    const st2 = await s.broker.lstat(p);
    await s.broker.remove(p, { expect: { ino: st2.ino, size: st2.diskSize, mtimeMs: st2.mtimeMs } });
    await rejects(s.broker.stat(p), "ENOENT");
  } finally {
    await s.cleanup();
  }
});

test("加密区严格形态（复核 B3-A18）：区内出现的非空明文文件拒读（EIO），覆盖写入即加密；兼容形态原样读出；空文件按空读出；链接与硬链接照旧拒绝", async () => {
  const s = await sealedSetup(true);
  try {
    const p = join(s.work, "外部写入.txt");
    await writeFile(p, "不经 broker 写入的明文");
    await rejects(s.broker.readText(p), "EIO");
    await rejects(s.broker.readBytes(p, 4, 0), "EIO");
    await rejects(s.broker.appendText(p, "x"), "EIO");
    assert.equal((await s.broker.stat(p)).size, Buffer.byteLength("不经 broker 写入的明文"), "stat 如实报告盘上长度");
    await s.broker.writeText(p, "覆盖后加密");
    assert.equal((await readFile(p)).subarray(0, 4).toString(), "KWE1");
    await writeFile(join(s.work, "空.txt"), "");
    assert.equal(await s.broker.readText(join(s.work, "空.txt")), "");
    await symlink(join(s.outside, "secret.txt"), join(s.work, "link.txt"));
    await rejects(s.broker.readText(join(s.work, "link.txt")), "ELOOP");
    await link(join(s.outside, "secret.txt"), join(s.work, "hard.txt"));
    await rejects(s.broker.readText(join(s.work, "hard.txt")), "EMLINK");
  } finally {
    await s.cleanup();
  }
  const c = await sealedSetup(false);
  try {
    await writeFile(join(c.work, "旧明文.txt"), "迁移前的明文");
    assert.equal(await c.broker.readText(join(c.work, "旧明文.txt")), "迁移前的明文");
    assert.equal(Buffer.from(await c.broker.readBytes(join(c.work, "旧明文.txt"), 6, 3)).toString(), "移前");
  } finally {
    await c.cleanup();
  }
});

test("加密区截断边界与伪造格式（复核 S3B-A03 / A04）：残片 1/27 字节、只剩文件头、头 + 10 字节——部分读与整读都报错，stat 不报推算出的“更短”；分块专用区拒读伪造的空日志", async () => {
  const s = await sealedSetup();
  try {
    const { CHUNK_BYTES, HEADER_BYTES } = await import("@zr-legal/at-rest");
    const { randomBytes } = await import("node:crypto");
    const step = CHUNK_BYTES + 28;
    const p = join(s.work, "截断.bin");
    const full = s.codecs.work.seal(randomBytes(3 * CHUNK_BYTES + 500));
    for (const len of [HEADER_BYTES + step + 1, HEADER_BYTES + 2 * step + 27, HEADER_BYTES, HEADER_BYTES + 10]) {
      await writeFile(p, full.subarray(0, len));
      await assert.rejects(s.broker.readBytes(p, 10, 0), /残缺|corrupt/, `len=${len} 部分读`);
      await assert.rejects(s.broker.readBytes(p), /残缺|过短|corrupt|认证失败/, `len=${len} 整读`);
      assert.equal((await s.broker.stat(p)).size, len, `len=${len}：结构不合法时 stat 报盘上长度`);
    }
    // 分块专用区：只有头的“空日志”（无需密钥即可构造）拒读，而不是读成空文件
    const sealedChunkedOnly = new FileBroker([{ name: "work", root: s.work, access: "rw", codec: s.codecs.work, strict: true, chunkedOnly: true }]);
    await writeFile(join(s.work, "空日志.txt"), s.codecs.work.newLog());
    await assert.rejects(sealedChunkedOnly.readText(join(s.work, "空日志.txt")), (e: any) => e.code === "EIO");
    await assert.rejects(sealedChunkedOnly.readBytes(join(s.work, "空日志.txt"), 5, 0), (e: any) => e.code === "EIO");
  } finally {
    await s.cleanup();
  }
});
