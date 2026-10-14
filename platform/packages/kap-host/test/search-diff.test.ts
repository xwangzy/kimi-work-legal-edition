/**
 * 宿主内检索与原生 ripgrep 的差分（审计 S3 第 2 步；设计 §6.2“Grep/Glob 差分”行）。
 *
 * 语料：中文、CRLF、超长行、空文件、无行尾换行、二进制（前部 NUL / 64 KiB 之后的 NUL）、UTF-16LE 与 UTF-8 BOM、隐藏文件与目录、
 * .ignore / .rgignore / .gitignore（仓库外不生效、仓库内生效）与 .git/info/exclude、敏感文件（.env、id_rsa*）、带空格的文件名、深目录。
 * 参数：按上游 grepTool.ts / globTool.ts 的 buildRgArgs 逐字构造（三种输出模式 × 大小写 × 行号 × 上下文 × --glob × --type × 多行 × include_ignored；
 * 搜索根为目录、子目录、单个文件、单个二进制文件）。原生 rg 另加 `--sort path`（只让多线程输出顺序确定，不改变格式）。
 * 断言：stdout 逐字节相同、退出码相同；同一语料加密后（KWE1，经文件 broker 解封）宿主检索的输出与明文完全一致（路径前缀替换后）。
 * 金标准（复核 S3B-B15）：每例 ripgrep 输出的摘要（语料根替换为 <ROOT>）与退出码固化在 test/fixtures/rg15-golden.json；
 * 本机有 rg 时逐例与 rg 比对并核对金标准未漂移（KWL_UPDATE_RG_GOLDEN=1 重写），没有 rg 时与金标准比对——证据不会因缺 rg 而空过。
 * rg 退出码为 2（语法错误等）的例只比退出码与“stderr 有错误行”，不比 stdout。
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { deriveZoneKey, ZoneCodec } from "@zr-legal/at-rest";
import { FileBroker } from "@zr-legal/file-broker";
import { runSearch, type SearchFs } from "../src/search/engine.ts";
import { brokerSearchFs } from "../src/search/host-search.ts";

function nativeRg(): string | null {
  for (const c of [process.env.KWL_TRUSTED_RG, join(homedir(), ".kimi-code", "bin", "rg")]) {
    if (!c) continue;
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      // 下一个
    }
  }
  return null;
}

// KWL_SEARCH_DIFF_NO_RG=1：模拟没有 rg 的机器（只与金标准比对）
const RG = process.env.KWL_SEARCH_DIFF_NO_RG === "1" ? null : nativeRg();

// ─── 上游参数构造（与 grepTool.ts / globTool.ts 逐字一致） ───
const VCS = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];
const SUFFIXES = [".bak", ".backup", ".copy", ".disabled", ".key", ".old", ".orig", ".pem", ".save", ".tmp"];
const SENSITIVE = [
  "**/.env",
  ...["id_rsa", "id_ed25519", "id_ecdsa"].flatMap((n) => [`**/${n}`, `**/${n}[-_]*`, ...SUFFIXES.map((s) => `**/${n}${s}`)]),
  "**/.aws/credentials",
  "**/.aws/credentials/**",
  "**/.gcp/credentials",
  "**/.gcp/credentials/**",
];

interface GrepCase {
  pattern: string;
  output_mode?: "content" | "files_with_matches" | "count_matches";
  "-i"?: boolean;
  "-n"?: boolean;
  "-C"?: number;
  "-A"?: number;
  "-B"?: number;
  glob?: string;
  type?: string;
  multiline?: boolean;
  include_ignored?: boolean;
}

function grepArgs(a: GrepCase, path: string): string[] {
  const cmd: string[] = ["--hidden"];
  const mode = a.output_mode ?? "files_with_matches";
  if (mode !== "content") cmd.push("--max-columns", "500");
  cmd.push("--null");
  for (const d of VCS) cmd.push("--glob", `!${d}`);
  if (mode === "files_with_matches") cmd.push("-l");
  else if (mode === "count_matches") cmd.push("--count-matches", "--with-filename");
  if (a["-i"]) cmd.push("-i");
  if (mode === "content") {
    cmd.push("--with-filename");
    if (a["-n"] !== false) cmd.push("-n");
    else cmd.push("--field-context-separator", ":");
    if (a["-C"] !== undefined) cmd.push("-C", String(a["-C"]));
    else {
      if (a["-A"] !== undefined) cmd.push("-A", String(a["-A"]));
      if (a["-B"] !== undefined) cmd.push("-B", String(a["-B"]));
    }
  }
  if (a.glob !== undefined) cmd.push("--glob", a.glob);
  if (a.type !== undefined) cmd.push("--type", a.type);
  if (a.multiline) cmd.push("-U", "--multiline-dotall");
  if (a.include_ignored) cmd.push("--no-ignore");
  for (const g of SENSITIVE) cmd.push("--glob", `!${g}`);
  cmd.push("--", a.pattern, path);
  return cmd;
}

function globArgs(pattern: string, includeIgnored = false): string[] {
  const cmd = ["--files", "--hidden", "--sortr=modified"];
  for (const d of VCS) cmd.push("--glob", `!${d}`);
  cmd.push("--glob", pattern);
  for (const g of SENSITIVE) cmd.push("--glob", `!${g}`);
  if (includeIgnored) cmd.push("--no-ignore");
  cmd.push(".");
  return cmd;
}

// ─── 语料 ───
const FILES: Record<string, string | Buffer> = {
  "合同.txt": "甲方：澜沧科技有限公司\n乙方：张三\n金额：100万元\n\n第二条 违约责任\n乙方应支付违约金。\r\nfoo bar\n第三条 争议解决\n",
  "sub/a.md": "line1\nmatch here\nline3\nline4\nline5\nmatch again\nMATCH upper\n",
  "sub/b.txt": "MATCH upper\n违约金 条款\n",
  "sub/deep/c.txt": "违约金\n违约金违约金\n",
  "sub/deep/更深/d.csv": "编号,金额\n1,违约金 100\n",
  ".hid/h.txt": "hidden match 违约金\n",
  ".ignore": "*.log\nignored-dir/\n",
  ".rgignore": "!x.log\n",
  "x.log": "match in log 违约金\n",
  "y.log": "match in y log\n",
  "ignored-dir/z.txt": "违约金 in ignored dir\n",
  ".gitignore": "*.md\n",
  "repo/.git/HEAD": "ref: refs/heads/main\n",
  "repo/.git/info/exclude": "excluded.txt\n",
  "repo/.gitignore": "secret*.txt\n",
  "repo/secret1.txt": "违约金 secret\n",
  "repo/keep.txt": "违约金 keep\nmatch keep\n",
  "repo/excluded.txt": "违约金 excluded\n",
  "repo/note.md": "违约金 md in repo\n",
  "bin.dat": Buffer.from("bin\0ary match 违约金\n"),
  "late-nul.txt": Buffer.concat([Buffer.from("违约金 行\n".repeat(10_000)), Buffer.from("\0"), Buffer.from("违约金 after nul\n")]),
  "u16.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi match 违约金\n", "utf16le")]),
  "bom.txt": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("违约金 bom\nmatch bom\n")]),
  "crlf.txt": "第一行 违约金\r\n第二行\r\nfoo\r\n",
  ".env": "SECRET=违约金\n",
  id_rsa: "违约金 key\n",
  "id_rsa.bak": "违约金 key bak\n",
  "空 格.txt": "违约金 空格\n",
  "long.txt": `${"x".repeat(10_000)}违约金\n`,
  "empty.txt": "",
  "noeol.txt": "违约金 no eol",
  "ctx.txt": "a\nmatch1\nb\nc\nd\ne\nmatch2\nf\n",
  "multi.txt": "foo\nbar baz\nqux\n",
  "全角.txt": "甲方　乙方\n公司１２３号\n",
  "日期.txt": "签署于二〇二四年三月 第Ⅱ部分\nabc 违约金 match\n",
  "repo/sub/.gitignore": "!secret2.txt\n*.tmp　\n",
  "repo/sub/secret2.txt": "违约金 whitelisted\n",
  "repo/sub/x.tmp": "违约金 tmp\n",
  // 忽略文件里的坏规则（复核 B 处置复核）：未闭合的 [ 按字面量、未闭合的 { 跳过该行（rg 在 stderr 报错、检索照常）
  "ig/.ignore": "a[\n{a,b\nskip*.txt\n",
  "ig/a[": "违约金 bracket\n",
  "ig/{a,b": "违约金 brace\n",
  "ig/skip1.txt": "违约金 skip\n",
  "ig/keep.txt": "违约金 keep\n",
};

let plainRoot = "";
let sealedRoot = "";
let sealedBroker: FileBroker;

function plainFs(zoneRoot: string): SearchFs {
  return {
    async readdir(p) {
      return (await readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink() }));
    },
    async stat(p) {
      const s = await lstat(p);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs, size: s.size };
    },
    async read(p, n, offset) {
      const b = await readFile(p);
      return n === undefined ? b : b.subarray(offset ?? 0, (offset ?? 0) + n);
    },
    parentsWithinZone(p) {
      const rel = relative(zoneRoot, p);
      if (rel === "" || rel.startsWith("..")) return [];
      const parts = rel.split("/");
      const out = [zoneRoot];
      for (const c of parts.slice(0, -1)) out.push(join(out[out.length - 1]!, c));
      return out;
    },
  };
}

async function host(args: string[], cwd: string, fs: SearchFs): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runSearch(args, { cwd, pathClass: "posix", fs, io: { out: (s) => (out += s), err: (s) => (err += s), aborted: () => false } });
  return { code, out, err };
}

function native(args: string[], cwd: string, sortPath: boolean): { code: number; out: string; err: string } {
  const r = spawnSync(RG!, [...(sortPath ? ["--sort", "path"] : []), ...args], { cwd, env: { PATH: "", LANG: "C.UTF-8", RIPGREP_CONFIG_PATH: "" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

before(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "kwl-search-diff-")));
  plainRoot = join(base, "plain", "work");
  sealedRoot = join(base, "sealed", "work");
  const ws = randomBytes(32);
  const codec = new ZoneCodec("work", new Map([[1, deriveZoneKey(ws, "work")]]), 1);
  const names = Object.keys(FILES).sort();
  const t0 = Date.now() / 1000 - 10_000;
  names.forEach((rel, i) => {
    const content = typeof FILES[rel] === "string" ? Buffer.from(FILES[rel] as string) : (FILES[rel] as Buffer);
    for (const [root, bytes] of [
      [plainRoot, content],
      [sealedRoot, codec.seal(content)],
    ] as const) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, bytes);
      utimesSync(p, t0 + i * 7, t0 + i * 7); // 各文件修改时间不同：--sortr=modified 的顺序确定
    }
  });
  sealedBroker = new FileBroker([{ name: "work", root: sealedRoot, access: "rw", codec, strict: true }]);
  assert.equal(readFileSync(join(sealedRoot, "合同.txt")).subarray(0, 4).toString(), "KWE1");
});

const PATTERNS = [
  "违约金", "match", "MATCH", "\\p{Han}+公司", "^第.条", "金额：\\d+", "\\w+公司", "bar$", "", "违约|争议", "[甲乙]方", "\\s+乙方", "公司\\d+号", "after nul", "x(", "(?i)match here",
  // 复核 S3B-B08/B09：〇 与 Ⅱ（Nl）属于 \w；[^\n]、内联 (?i) 与 Unicode 类、嵌套类、\< 词首、含换行的类
  "\\w+", "\\w+年", "[^\\n]+违约", "(?i)\\d+", "(?i)\\w+公司", "(?i)\\p{Han}+金", "[[a-z]]+", "\\<match", "[\\na]",
  // 设计 §6.2 正则方言：命名组可用、反向引用两边都报错
  "(?P<k>违约)金", "(a)\\1",
];

function grepCases(): GrepCase[] {
  const out: GrepCase[] = [];
  for (const pattern of PATTERNS) {
    for (const output_mode of ["files_with_matches", "count_matches", "content"] as const) {
      out.push({ pattern, output_mode });
      out.push({ pattern, output_mode, "-i": true });
    }
    out.push({ pattern, output_mode: "content", "-n": false });
  }
  for (const pattern of ["match", "违约金"]) {
    out.push({ pattern, output_mode: "content", "-C": 1 });
    out.push({ pattern, output_mode: "content", "-A": 2, "-B": 1 });
    out.push({ pattern, output_mode: "content", "-C": 1, "-n": false });
    out.push({ pattern, output_mode: "content", "-A": 1 });
    out.push({ pattern, glob: "*.txt" });
    out.push({ pattern, glob: "sub/**" });
    out.push({ pattern, glob: "!*.txt", output_mode: "count_matches" });
    out.push({ pattern, glob: "*.{md,txt}" });
    out.push({ pattern, glob: "[a-c]*", output_mode: "count_matches" });
    out.push({ pattern, glob: "a[b" });
    out.push({ pattern, glob: "{a,b" });
    out.push({ pattern, output_mode: "content", "-B": 1 });
    out.push({ pattern, output_mode: "content", "-C": 0 });
    out.push({ pattern, output_mode: "content", "-i": true, "-C": 2 });
    out.push({ pattern, type: "nosuchtype" });
    out.push({ pattern, type: "md" });
    out.push({ pattern, type: "txt", output_mode: "content" });
    out.push({ pattern, include_ignored: true });
    out.push({ pattern, include_ignored: true, output_mode: "content" });
  }
  out.push({ pattern: "o.b", output_mode: "content", multiline: true });
  out.push({ pattern: "foo.bar", output_mode: "count_matches", multiline: true });
  out.push({ pattern: "违约.*\\n.*第", output_mode: "content", multiline: true, "-C": 1 });
  out.push({ pattern: "第二条.+违约金", output_mode: "files_with_matches", multiline: true });
  // 多行模式下 64 KiB 之后的 NUL：其前的完整行全部检索、不附警告（复核 B 处置复核 N-03）
  out.push({ pattern: "违约金 行\\n违约金", output_mode: "content", multiline: true });
  out.push({ pattern: "违约金", output_mode: "count_matches", multiline: true });
  out.push({ pattern: "a\\nb", output_mode: "content" });
  out.push({ pattern: "missing-nothing", output_mode: "content" });
  return out;
}

const GOLDEN = fileURLToPath(new URL("./fixtures/rg15-golden.json", import.meta.url));
type Golden = Record<string, { code: number; sha: string }>;
const golden: Golden = existsSync(GOLDEN) ? (JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden) : {};
const fresh: Golden = {};
const digestOut = (out: string) => createHash("sha256").update(out.split(plainRoot).join("<ROOT>")).digest("hex").slice(0, 24);

/** 一例的比对：有 rg 时与 rg 比（并记下金标准）；没有 rg 时与金标准比。返回不一致说明（一致返回 null）。 */
function compare(key: string, h: { code: number; out: string; err: string }, run: () => { code: number; out: string; err: string }): string | null {
  const hd = digestOut(h.out);
  if (RG) {
    const r = run();
    fresh[key] = { code: r.code, sha: r.code === 2 ? "" : digestOut(r.out) };
    if (r.code === 2) {
      if (!/error|unrecognized/.test(h.err)) return `${key}: rg 报错而宿主 stderr 没有错误行`;
      return h.code === 2 ? null : `${key}\n  rg (2) 报错；host (${h.code})`;
    }
    if (h.code !== r.code || h.out !== r.out) return `${key}\n  rg   (${r.code}): ${JSON.stringify(r.out.slice(0, 300))}\n  host (${h.code}): ${JSON.stringify(h.out.slice(0, 300))}`;
    return null;
  }
  const g = golden[key];
  if (!g) return `${key}: 金标准缺失（在有 rg 的机器上以 KWL_UPDATE_RG_GOLDEN=1 生成）`;
  if (h.code !== g.code || (g.code !== 2 && hd !== g.sha)) return `${key}: 与金标准不一致（code ${h.code}/${g.code}）`;
  return null;
}

test("差分：Grep 的上游参数组合 × 搜索根（目录、子目录、单个文件、单个二进制文件、仓库目录）——宿主内检索与原生 ripgrep（或其金标准）逐字节一致", async () => {
  const fs = plainFs(plainRoot);
  const roots = [plainRoot, join(plainRoot, "sub"), join(plainRoot, "合同.txt"), join(plainRoot, "bin.dat"), join(plainRoot, "repo")];
  let n = 0;
  const diffs: string[] = [];
  for (const root of roots) {
    for (const c of grepCases()) {
      const args = grepArgs(c, root);
      const h = await host(args, plainRoot, fs);
      const d = compare(`grep ${JSON.stringify(c)} @ ${relative(plainRoot, root) || "."}`, h, () => native(args, plainRoot, true));
      n += 1;
      if (d) diffs.push(d);
    }
  }
  assert.deepEqual(diffs, [], `${diffs.length}/${n} 例不一致：\n${diffs.slice(0, 8).join("\n")}`);
  assert.ok(n > 900);
});

test("差分：Glob 的上游参数形状（cwd = 搜索根，路径 \".\"，按修改时间倒序）与原生 ripgrep（或其金标准）逐字节一致", async () => {
  const fs = plainFs(plainRoot);
  const diffs: string[] = [];
  for (const cwd of [plainRoot, join(plainRoot, "sub"), join(plainRoot, "repo")]) {
    for (const pattern of ["*.txt", "**/*.md", "sub/**", "*", "**/合同*", "*.{txt,csv}", "deep/**/*.csv", "[a-c]*.txt", "?.md", "/sub/*", "!*.txt", "a[b"]) {
      for (const ii of [false, true]) {
        const args = globArgs(pattern, ii);
        const h = await host(args, cwd, fs);
        const d = compare(`glob ${pattern} ii=${ii} @ ${relative(plainRoot, cwd) || "."}`, h, () => native(args, cwd, false));
        if (d) diffs.push(d);
      }
    }
  }
  assert.deepEqual(diffs, [], diffs.slice(0, 6).join("\n"));
  // 金标准：有 rg 时核对未漂移（或按需重写）
  if (RG) {
    if (process.env.KWL_UPDATE_RG_GOLDEN === "1" || Object.keys(golden).length === 0) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(Object.fromEntries(Object.entries(fresh).sort(([a], [b]) => (a < b ? -1 : 1))), null, 0).replace(/},"/g, '},\n"')}\n`);
    } else {
      const drift = Object.keys(fresh).filter((k) => !golden[k] || golden[k]!.code !== fresh[k]!.code || golden[k]!.sha !== fresh[k]!.sha);
      assert.deepEqual(drift.slice(0, 5), [], `金标准与本机 rg 不一致 ${drift.length} 例（语料或用例变了就以 KWL_UPDATE_RG_GOLDEN=1 重写并评审）`);
    }
  }
});

test("加密语料：经文件 broker 解封的宿主检索输出与明文语料完全一致（Grep 全部组合与 Glob）；盘上没有明文", async () => {
  const pfs = plainFs(plainRoot);
  const sfs = brokerSearchFs(sealedBroker, new Set(["work"]), "posix");
  const swap = (s: string) => s.split(plainRoot).join(sealedRoot);
  let n = 0;
  for (const root of ["", "sub", "合同.txt", "bin.dat", "repo"]) {
    for (const c of grepCases()) {
      const p = await host(grepArgs(c, root ? join(plainRoot, root) : plainRoot), plainRoot, pfs);
      const s = await host(grepArgs(c, root ? join(sealedRoot, root) : sealedRoot), sealedRoot, sfs);
      assert.equal(s.code, p.code, JSON.stringify(c));
      assert.equal(s.out, swap(p.out), `${JSON.stringify(c)} @ ${root}`);
      n += 1;
    }
  }
  for (const pattern of ["*.txt", "**/*.md", "*"]) {
    const p = await host(globArgs(pattern), plainRoot, pfs);
    const s = await host(globArgs(pattern), sealedRoot, sfs);
    assert.equal(s.out, p.out);
  }
  assert.ok(n > 400);
  const leaked = readdirSync(sealedRoot, { recursive: true })
    .map((f) => join(sealedRoot, String(f)))
    .filter((f) => statSync(f).isFile() && readFileSync(f).includes(Buffer.from("违约金")));
  assert.deepEqual(leaked, []);
});

test("病态 glob 与忽略文件不卡住宿主：多个 ** 或 * 的规则走线性时间引擎；超大忽略文件只取前 1 万条", async () => {
  const { parseGitignoreLine, parseGitignore, MAX_RULES_PER_FILE } = await import("../src/search/glob.ts");
  const deep = "a/".repeat(200) + "b";
  for (const g of ["**/".repeat(40) + "zz", "*a*a*a*a*a*a*a*a*a*b", "{a,b}*{c,d}*{e,f}*x"]) {
    const r = parseGitignoreLine(g)!;
    const t = Date.now();
    r.re.test(deep);
    r.re.test("a".repeat(4000));
    assert.ok(Date.now() - t < 500, `${g} 匹配耗时 ${Date.now() - t} ms`);
  }
  // 语义不变：复杂规则与简单规则判定一致
  assert.equal(parseGitignoreLine("**/x/**/y/**/z.txt")!.re.test("a/x/b/y/c/z.txt"), true);
  assert.equal(parseGitignoreLine("**/x/**/y/**/z.txt")!.re.test("a/x/b/c/z.txt"), false);
  assert.equal(parseGitignoreLine("*.{txt,md}")!.re.test("sub/a.md"), true);
  assert.equal(parseGitignore("x\n".repeat(MAX_RULES_PER_FILE + 50)).length, MAX_RULES_PER_FILE);
  // 宿主内检索在带病态 --glob 时仍在时限内完成
  const fs = plainFs(plainRoot);
  const t = Date.now();
  const r = await host(grepArgs({ pattern: "违约金", glob: "**/".repeat(30) + "*.txt" }, plainRoot), plainRoot, fs);
  assert.ok(Date.now() - t < 5_000, `检索耗时 ${Date.now() - t} ms`);
  assert.equal(r.code === 0 || r.code === 1, true);
});

test("超限文件不整读、跳过即报错（上游可见）；遍历到的二进制文件只读首 64 KiB（复核 S3B-B05）", async () => {
  const { MAX_FILE_BYTES } = await import("../src/search/engine.ts");
  const reads: { path: string; n?: number }[] = [];
  const fake: SearchFs = {
    async readdir() {
      return [
        { name: "huge.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
        { name: "bin.dat", isFile: true, isDirectory: false, isSymbolicLink: false },
        { name: "ok.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
      ];
    },
    async stat(p) {
      const size = p.endsWith("huge.txt") ? MAX_FILE_BYTES + 1 : p.endsWith("bin.dat") ? 10 * 1024 * 1024 : 20;
      return { isFile: !p.endsWith("/w"), isDirectory: p.endsWith("/w"), mtimeMs: 0, size };
    },
    async read(p, n) {
      reads.push({ path: p, ...(n !== undefined ? { n } : {}) });
      if (p.endsWith("bin.dat")) return new Uint8Array(n ?? 10 * 1024 * 1024); // 全是 NUL
      return Buffer.from("违约金 ok\n");
    },
    parentsWithinZone: () => [],
  };
  const r = await host(["--null", "-l", "--", "违约金", "/w"], "/w", fake);
  assert.equal(r.code, 2, "超限文件使检索以错误结束（上游会显示说明）");
  assert.match(r.err, /huge\.txt: 文件超过 256 MiB，宿主内检索未读取，结果不完整/);
  assert.equal(r.out, "/w/ok.txt\u0000");
  assert.equal(reads.some((x) => x.path.endsWith("huge.txt")), false, "超限文件一个字节都不读");
  assert.deepEqual(reads.filter((x) => x.path.endsWith("bin.dat")), [{ path: "/w/bin.dat", n: 65536 }], "二进制文件只读首 64 KiB");
});
