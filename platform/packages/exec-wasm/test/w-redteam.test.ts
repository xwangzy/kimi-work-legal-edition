/**
 * P2 红队（第 06 篇 P2：逃逸（原型污染、桥接滥用、虚拟文件系统穿越、链接投毒）、联网（含 DNS）、资源耗尽零越界）。
 *
 * 每个用例都检查同一组不变量：
 * - 输出中不出现任何秘密（事项外文件、引擎私有目录、宿主环境变量、系统账户文件、宿主用户名）；
 * - 盘上事项外、材料快照、引擎私有目录不变（内容摘要一致，没有新文件）；工作区内不出现任何链接；
 * - 执行域随后仍可用（每个用例后的健康检查）。
 * 用例自身可再加针对性断言（例如写出的文件不得落盘）。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveZoneKey, ZoneCodec } from "@zr-legal/at-rest";
import { FileBroker } from "@zr-legal/file-broker";
import { WCoreDomain, type WProcess } from "../src/domain.ts";

interface R {
  code: number;
  out: string;
}

let base: string;
let work: string;
let materials: string;
let outside: string;
let engineHome: string;
let broker: FileBroker;
let domain: WCoreDomain;
const SECRETS = ["OUTSIDE-SECRET-7f3a", "ENGINE-SECRET-91bc", "ENV-SECRET-55de"];
/** 加密形态（复核 S3B-A01 / B-07）：KWL_W_SEALED=1（w-redteam-sealed.test.ts）时材料快照与工作区是 KWE1 密文，W 读层解密。 */
const SEALED = process.env.KWL_W_SEALED === "1";
const WS_KEY = randomBytes(32);
const CODECS = {
  work: new ZoneCodec("work", new Map([[1, deriveZoneKey(WS_KEY, "work")]]), 1),
  materials: new ZoneCodec("materials", new Map([[1, deriveZoneKey(WS_KEY, "materials")]]), 1),
};

function digestTree(root: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      h.update(`${p}|${st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f"}|${st.nlink}\n`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(readFileSync(p));
    }
  };
  walk(root);
  return h.digest("hex");
}

let baseline: { outside: string; materials: string; engine: string; top: string[] };

before(async () => {
  process.env.KWL_REDTEAM_SECRET = SECRETS[2]; // 宿主环境变量：W 不得继承
  base = realpathSync(mkdtempSync(join(tmpdir(), "kwl-wred-")));
  work = join(base, "matter", "work");
  materials = join(base, "matter", "materials");
  outside = join(base, "outside");
  engineHome = join(base, "matter", "home");
  for (const d of [work, materials, outside, join(engineHome, "sessions")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), `${SECRETS[0]}\n`);
  writeFileSync(join(engineHome, "sessions", "state.json"), `{"k":"${SECRETS[1]}"}\n`);
  const put = (zone: "materials" | "work", p: string, text: string) => writeFileSync(p, SEALED ? CODECS[zone].seal(Buffer.from(text)) : text);
  put("materials", join(materials, "合同.txt"), "借款金额 100 万元\n");
  put("work", join(work, "a.txt"), "工作区文件\n");
  const sealedZone = (z: "work" | "materials") => (SEALED ? { codec: CODECS[z], strict: true, chunkedOnly: true } : {});
  broker = new FileBroker([
    { name: "materials", root: materials, access: "ro", ...sealedZone("materials") },
    { name: "work", root: work, access: "rw", ...sealedZone("work") },
  ]);
  domain = await WCoreDomain.start({
    broker,
    work: { zone: "work", root: work },
    readOnlyRoots: [materials],
    ...(SEALED ? { sealed: { work: CODECS.work.toWire(), readOnly: { [materials]: CODECS.materials.toWire() }, strict: true } } : {}),
    pathClass: "posix",
    tmpDir: join(base, "w-tmp"),
    limits: { maxExecutionTimeMs: 20_000 },
  });
  baseline = { outside: digestTree(outside), materials: digestTree(materials), engine: digestTree(engineHome), top: readdirSync(base).sort() };
});

after(async () => {
  delete process.env.KWL_REDTEAM_SECRET;
  await domain.close();
});

async function run(script: string): Promise<R> {
  const p: WProcess = await domain.run(`cd '${work}' && ${script}`, { cwd: work });
  let out = "";
  p.stdout.setEncoding("utf8");
  p.stderr.setEncoding("utf8");
  p.stdout.on("data", (c: string) => (out += c));
  p.stderr.on("data", (c: string) => (out += c));
  const ended = Promise.all([new Promise((r) => p.stdout.on("end", r)), new Promise((r) => p.stderr.on("end", r))]);
  const code = await p.wait();
  await ended;
  return { code, out };
}

async function invariants(id: string, r: R): Promise<void> {
  for (const s of SECRETS) assert.ok(!r.out.includes(s), `${id}：输出泄露秘密 ${s}`);
  assert.ok(!/root:[x*]:0:0/.test(r.out), `${id}：输出含系统账户文件内容`);
  const user = userInfo().username;
  if (user.length >= 4) assert.ok(!r.out.includes(user), `${id}：输出含宿主用户名`);
  assert.equal(digestTree(outside), baseline.outside, `${id}：事项外目录被改动`);
  assert.equal(digestTree(materials), baseline.materials, `${id}：材料快照被改动`);
  assert.equal(digestTree(engineHome), baseline.engine, `${id}：引擎私有目录被改动`);
  assert.deepEqual(readdirSync(base).sort().filter((n) => n !== "w-tmp"), baseline.top.filter((n) => n !== "w-tmp"), `${id}：事项外出现新文件`);
  // W 临时目录是 W 进程唯一可写的真实目录：每条命令之后都必须为空（含点文件；复核 S3B-A08）
  const wtmp = join(base, "w-tmp");
  assert.deepEqual(existsSync(wtmp) ? readdirSync(wtmp) : [], [], `${id}：W 临时目录留下了文件`);
  const { links } = await broker.findLinks(work);
  assert.deepEqual(links, [], `${id}：工作区出现链接`);
}

type Case = [id: string, script: string, extra?: (r: R) => void | Promise<void>];

const O = () => outside;
const Wd = () => work;
const notOnDisk = (p: () => string) => () => assert.equal(existsSync(p()), false, `不应落盘：${p()}`);

const VFS: Case[] = [
  ["V01 相对路径穿越", "cat ../../outside/secret.txt"],
  ["V02 绝对路径读事项外", `cat '${"<O>"}/secret.txt'`],
  ["V03 根目录列举", "cd / && ls -la; ls /Users /home /private /var /tmp 2>&1"],
  ["V04 系统账户文件", "cat /etc/passwd /etc/shadow /etc/master.passwd 2>&1"],
  ["V05 /proc 环境", "cat /proc/self/environ /proc/1/environ 2>&1; ls /proc 2>&1"],
  ["V06 /proc 命令行与映射", "cat /proc/self/cmdline /proc/self/maps 2>&1"],
  ["V07 /dev 设备", "ls /dev; cat /dev/fd/3 /dev/stdin /dev/mem 2>&1 </dev/null"],
  ["V08 工作区路径 + ..", `cat '${"<W>"}/../../outside/secret.txt'`],
  ["V09 ./ 与 // 混合", `cat '${"<W>"}/./..//..//outside//secret.txt'`],
  ["V10 十六进制转义的 ..", `cat $'${"<W>"}/\\x2e\\x2e/\\x2e\\x2e/outside/secret.txt'`],
  ["V11 URL 编码的 ..", `cat '${"<W>"}/%2e%2e/%2e%2e/outside/secret.txt' 2>&1`],
  ["V12 全角点", `cat '${"<W>"}/．．/．．/outside/secret.txt' 2>&1`],
  ["V13 经材料目录绕行", `cat '${"<W>"}/../materials/../../outside/secret.txt' 2>&1`],
  ["V14 全盘 find", "find / -name 'secret*' 2>/dev/null | head; find / -name state.json 2>/dev/null | head"],
  ["V15 全盘 grep", "grep -r SECRET / 2>/dev/null | head"],
  ["V16 tar 打包事项外", `tar cf /tmp/x.tar '${"<O>"}' 2>&1; tar tf /tmp/x.tar 2>&1; tar xOf /tmp/x.tar 2>&1 | head`],
  ["V17 cp 到工作区", `cp '${"<O>"}/secret.txt' ./stolen.txt 2>&1; cat stolen.txt 2>&1`],
  ["V18 Python 相对穿越", `python3 -c "print(open('../../outside/secret.txt').read())" 2>&1 | tail -1`],
  ["V19 Python 列举根与上级", `python3 -c "import os; print(os.listdir('/')); print(os.listdir('${"<W>"}/../..'))" 2>&1 | tail -2`],
  ["V20 Python /proc", `python3 -c "print(open('/proc/self/maps').read()[:200])" 2>&1 | tail -1`],
  ["V21 Python chdir 上行", `python3 -c "import os; os.chdir('..'); os.chdir('..'); print(os.listdir('.'))" 2>&1 | tail -1`],
  ["V22 Python rglob", `python3 -c "from pathlib import Path; print([str(p) for p in Path('/').rglob('secret*')][:5])" 2>&1 | tail -1`],
  ["V23 sqlite ATTACH 事项外", `sqlite3 :memory: "ATTACH '${"<O>"}/secret.txt' AS x; select * from x.sqlite_master;" 2>&1`],
  ["V24 引擎私有目录", `cat '${"<E>"}/sessions/state.json' 2>&1; ls '${"<E>"}' 2>&1`],
  ["V25 写事项外（不落盘）", `echo pwn > '${"<O>"}/pwn.txt'; mkdir -p '${"<B>"}/newdir'; echo ok`, notOnDisk(() => join(outside, "pwn.txt"))],
  ["V26 写材料快照（只读）", `echo pwn > '${"<M>"}/pwn.txt' 2>&1; rm -f '${"<M>"}/合同.txt' 2>&1; echo done`],
  ["V27 Python 写事项外（不落盘）", `python3 -c "open('${"<O>"}/pwn2.txt', 'w').write('x'); print('wrote')" 2>&1 | tail -1`, notOnDisk(() => join(outside, "pwn2.txt"))],
  ["V28 嵌套 shell 读事项外", `bash -c "cat '${"<O>"}/secret.txt'" 2>&1; sh -c "cat ../../outside/secret.txt" 2>&1`],
  ["V29 eval/source/命令替换", `eval "cat '${"<O>"}/secret.txt'" 2>&1; source '${"<O>"}/secret.txt' 2>&1; echo "$(cat '${"<O>"}/secret.txt' 2>&1)"`],
  ["V30 xargs 间接读取", `echo '${"<O>"}/secret.txt' | xargs cat 2>&1`],
  ["V31 xan / jq 读事项外", `xan headers '${"<O>"}/secret.txt' 2>&1; jq -R . '${"<O>"}/secret.txt' 2>&1`],
  ["V32 ~ 与 $HOME", "ls ~ 2>&1; cat ~/.ssh/id_rsa ~/.zshrc ~/.bash_history 2>&1"],
];

const LINKS: Case[] = [
  ["L01 ln -s 指向事项外", `ln -s '${"<O>"}/secret.txt' l1 2>&1; cat l1 2>&1`],
  ["L02 ln -s 指向 /etc", "ln -s /etc l2 2>&1; ls l2 2>&1"],
  ["L03 硬链接（内存层，提交为普通文件）", "ln a.txt hl 2>&1; echo x >> hl; cat a.txt"],
  ["L04 Python os.symlink", `python3 -c "import os; os.symlink('${"<O>"}/secret.txt', 'pl')" 2>&1 | tail -1`],
  ["L05 Python os.link", `python3 -c "import os; os.link('a.txt', 'pl2'); print('linked')" 2>&1 | tail -1`],
  [
    "L06 tar 符号链接成员",
    `python3 - <<'PY' 2>&1 | tail -1
import tarfile, io
t = tarfile.open('evil.tar', 'w')
i = tarfile.TarInfo('lnk'); i.type = tarfile.SYMTYPE; i.linkname = '${"<O>"}/secret.txt'; t.addfile(i)
t.close(); print('built')
PY
tar xf evil.tar 2>&1; cat lnk 2>&1`,
  ],
  [
    "L07 tar 硬链接成员指向事项外",
    `python3 - <<'PY' 2>&1 | tail -1
import tarfile
t = tarfile.open('evil2.tar', 'w')
i = tarfile.TarInfo('hard'); i.type = tarfile.LNKTYPE; i.linkname = '${"<O>"}/secret.txt'; t.addfile(i)
t.close(); print('built')
PY
tar xf evil2.tar 2>&1; cat hard 2>&1`,
  ],
  [
    "L08 tar 路径穿越成员（../）",
    `python3 - <<'PY' 2>&1 | tail -1
import tarfile, io
t = tarfile.open('slip.tar', 'w')
data = b'pwn'; i = tarfile.TarInfo('../../outside/slip.txt'); i.size = len(data); t.addfile(i, io.BytesIO(data))
t.close(); print('built')
PY
tar xf slip.tar 2>&1; echo done`,
    notOnDisk(() => join(outside, "slip.txt")),
  ],
  [
    "L09 zip 路径穿越（zip slip）",
    `python3 - <<'PY' 2>&1 | tail -2
import zipfile
z = zipfile.ZipFile('slip.zip', 'w'); z.writestr('../../outside/zipslip.txt', 'pwn'); z.close()
zipfile.ZipFile('slip.zip').extractall('.'); print('extracted')
PY
unzip -o slip.zip 2>&1 | tail -1`,
    notOnDisk(() => join(outside, "zipslip.txt")),
  ],
  ["L10 cp -s / cp -l", "cp -s a.txt cs 2>&1; cp -l a.txt cl 2>&1; ls -la cs cl 2>&1"],
  ["L11 材料区内建链接", `ln -s /etc '${"<M>"}/l' 2>&1; echo done`],
  ["L12 mkfifo / mknod", "mkfifo f1 2>&1; mknod n1 c 1 3 2>&1; echo done"],
];

const BRIDGE: Case[] = [
  ["B01 import js", `python3 -c "import js; print(js.globalThis)" 2>&1 | tail -1`],
  ["B02 import pyodide / pyodide_js / _pyodide", `for m in pyodide pyodide_js _pyodide pyodide.ffi pyodide.code; do python3 -c "import $m; print('IMPORTED', '$m')" 2>&1 | tail -1; done`, (r) => assert.doesNotMatch(r.out, /IMPORTED/)],
  ["B03 ctypes", `python3 -c "import ctypes; print(ctypes.CDLL(None).getpid())" 2>&1 | tail -1`],
  ["B04 os.system / popen", `python3 -c "import os; print(os.system('id')); print(os.popen('id').read())" 2>&1 | tail -2`],
  ["B05 subprocess", `python3 -c "import subprocess; print(subprocess.run(['id'], capture_output=True))" 2>&1 | tail -1`],
  ["B06 fork / spawn", `python3 -c "import os; print(os.fork())" 2>&1 | tail -1; python3 -c "import os; os.posix_spawn('/bin/sh', ['sh'], {})" 2>&1 | tail -1`],
  ["B07 importlib / __import__ 间接导入", `python3 -c "import importlib; importlib.import_module('js')" 2>&1 | tail -1; python3 -c "__import__('builtins').__import__('js')" 2>&1 | tail -1`],
  ["B08 exec/compile 动态导入", `python3 -c "exec(compile('import js', 'x', 'exec'))" 2>&1 | tail -1`],
  ["B09 emscripten 内部模块", `python3 -c "import _emscripten_info" 2>&1 | tail -1; python3 -c "import emscripten" 2>&1 | tail -1`],
  ["B10 sys.modules 注入", `python3 -c "import sys, types; sys.modules['js'] = types.ModuleType('js'); import js; print('fake js only', js.__name__)" 2>&1 | tail -1`],
  ["B11 os.open 设备", `python3 -c "import os; print(os.open('/dev/mem', os.O_RDONLY))" 2>&1 | tail -1`],
  ["B12 node / js-exec / deno", "node -e 'console.log(process.env)' 2>&1 | head -2; js-exec -c '1+1' 2>&1 | head -2; deno eval 1 2>&1 | head -1"],
  ["B13 python -m http.server", "python3 -m http.server 8000 2>&1 | tail -2"],
  ["B14 platform / uname 信息", `python3 -c "import platform, sys; print(platform.uname()); print(sys.platform)" 2>&1 | tail -2`, (r) => assert.match(r.out, /emscripten/i)],
  ["B15 pip install", "pip install requests 2>&1 | tail -1; python3 -m pip install requests 2>&1 | tail -1"],
  ["B16 python -c 读取宿主 Node 进程信息", `python3 -c "import os; print(os.getpid(), os.getppid(), os.getuid())" 2>&1 | tail -1`],
  ["B17 python resource / signal", `python3 -c "import signal, os; os.kill(1, signal.SIGKILL)" 2>&1 | tail -1`],
  ["B18 python mmap", `python3 -c "import mmap; m = mmap.mmap(-1, 4096); print(len(m))" 2>&1 | tail -1`],
];

const PROTO: Case[] = [
  ["P01 变量名 __proto__", "__proto__=1; constructor=2; echo $__proto__ $constructor"],
  ["P02 关联数组键 __proto__/constructor", "declare -A m; m[__proto__]=x; m[constructor]=y; m[prototype]=z; echo ${m[__proto__]} ${m[constructor]} ${!m[@]}"],
  ["P03 文件名 __proto__（提交为普通文件）", "echo x > __proto__; mkdir -p constructor/prototype; echo y > constructor/prototype/polluted; cat __proto__"],
  ["P04 导出 hasOwnProperty/toString", "export hasOwnProperty=1 toString=2 valueOf=3; env | grep -c -E 'hasOwnProperty|toString|valueOf'"],
  ["P05 jq 原型键", `jq -c '.__proto__.polluted = 1 | .constructor.prototype.p2 = 2' <<< '{}'; jq -c '.polluted' <<< '{}'`],
  ["P06 yq 原型键", `printf 'a: 1\\n' | yq '.__proto__.polluted = 1' 2>&1; printf 'a: 1\\n' | yq '.polluted' 2>&1`],
  ["P07 awk 数组 __proto__", `awk 'BEGIN{a["__proto__"]=1; a["constructor"]=2; for (k in a) n++; print n}'`],
  ["P08 别名与函数名 constructor", "alias __proto__=echo; constructor() { echo c; }; constructor; type constructor 2>&1 | head -1"],
  ["P09 CSV 表头 __proto__（xan）", "printf '__proto__,constructor\\n1,2\\n' > p.csv; xan headers p.csv 2>&1"],
  ["P10 污染后新执行不受影响", "echo fresh-$((1+1))", (r) => assert.match(r.out, /fresh-2/)],
];

const NET: Case[] = [
  ["N01 curl", "curl -s -m 3 http://example.com 2>&1 | head -2"],
  ["N02 wget", "wget -q -T 3 -O - http://example.com 2>&1 | head -2"],
  ["N03 nc / telnet", "nc -w 2 example.com 80 2>&1 | head -1; telnet example.com 80 2>&1 | head -1"],
  ["N04 ping / dig / nslookup", "ping -c1 1.1.1.1 2>&1 | head -1; dig example.com 2>&1 | head -1; nslookup example.com 2>&1 | head -1"],
  ["N05 bash /dev/tcp", "exec 3<>/dev/tcp/1.1.1.1/80 2>&1; cat < /dev/tcp/example.com/80 2>&1 | head -1"],
  // Emscripten 的解析器是合成表：任何名字（含不存在的 .invalid）都映射到 172.29.x.x，不发出 DNS 查询；连接该地址同样失败（N08）
  [
    "N06 Python DNS（合成地址，无真实查询）",
    `python3 -c "import socket; print(socket.gethostbyname('example.com')); print(socket.gethostbyname('no-such-host.invalid'))" 2>&1 | tail -2`,
    (r) => {
      const ips = r.out.trim().split("\n");
      for (const ip of ips) if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) assert.match(ip, /^172\.29\./, `出现非合成地址：${ip}`);
    },
  ],
  ["N07 Python getaddrinfo localhost", `python3 -c "import socket; print(socket.getaddrinfo('localhost', 80))" 2>&1 | tail -1`],
  ["N08 Python TCP 外网", `python3 -c "import socket; socket.create_connection(('1.1.1.1', 80), timeout=2); print('CONNECTED')" 2>&1 | tail -1`, (r) => assert.doesNotMatch(r.out, /CONNECTED/)],
  ["N09 Python TCP 本机（调试端口、内核端点）", `python3 -c "import socket; socket.create_connection(('127.0.0.1', 9229), timeout=2); print('CONNECTED')" 2>&1 | tail -1`, (r) => assert.doesNotMatch(r.out, /CONNECTED/)],
  ["N10 Python Unix 套接字", `python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.connect('/tmp/x.sock'); print('CONNECTED')" 2>&1 | tail -1`, (r) => assert.doesNotMatch(r.out, /CONNECTED/)],
  ["N11 Python urllib / http.client", `python3 -c "import urllib.request; print(urllib.request.urlopen('http://example.com', timeout=2).status)" 2>&1 | tail -1; python3 -c "import http.client; c = http.client.HTTPSConnection('example.com', timeout=2); c.request('GET', '/'); print(c.getresponse().status)" 2>&1 | tail -1`, (r) => assert.doesNotMatch(r.out, /^200$/m)],
  ["N12 Python UDP", `python3 -c "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.sendto(b'x', ('1.1.1.1', 53)); print('SENT')" 2>&1 | tail -1`],
  ["N13 sqlite load_extension", `sqlite3 :memory: "select load_extension('/usr/lib/libc.dylib');" 2>&1`],
];

const RES: Case[] = [
  ["R01 无限循环", "while :; do :; done; echo 不应到达", (r) => assert.doesNotMatch(r.out, /不应到达/)],
  ["R02 超大 seq 展开", "for i in $(seq 1 100000000); do :; done; echo end 2>&1 | tail -1"],
  ["R03 大括号展开炸弹", "echo {1..100000000} | wc -c"],
  ["R04 内存文件系统写满", "yes 0123456789 | head -c 800000000 > /tmp/big 2>&1; ls -la /tmp/big 2>&1"],
  ["R05 工作区写入超限（不提交）", "yes 0123456789 | head -c 400000000 > big.bin 2>&1; echo done", () => assert.ok(!existsSync(join(work, "big.bin")) || lstatSync(join(work, "big.bin")).size <= 256 * 1024 * 1024)],
  ["R06 Python 超大分配", `python3 -c "x = 'a' * (2 ** 33)" 2>&1 | tail -1; python3 -c "y = [0] * (10 ** 10)" 2>&1 | tail -1`],
  ["R07 Python 深递归", `python3 -c "import sys; sys.setrecursionlimit(10**9)
def f(n): return f(n + 1)
f(0)" 2>&1 | tail -1`],
  ["R08 fork 炸弹", ":(){ :|:& };: 2>&1 | tail -1"],
  ["R09 函数递归", "f() { f; }; f 2>&1 | tail -1"],
  ["R10 输出洪泛", "yes 洪泛 | head -c 50000000 2>&1 | tail -c 100"],
  ["R11 大量小文件", "for i in $(seq 1 3000); do echo $i > f$i.txt; done; ls | wc -l"],
  ["R12 超长命令行与变量", "x=$(printf 'a%.0s' $(seq 1 200000)); echo ${#x}"],
];

const LEAK: Case[] = [
  ["E01 环境变量", "env; printenv KWL_REDTEAM_SECRET", (r) => assert.doesNotMatch(r.out, /KWL_REDTEAM_SECRET=/)],
  ["E02 Python 环境变量", `python3 -c "import os; print(sorted(os.environ))" 2>&1 | tail -1`],
  ["E03 主机名、用户、内核", "hostname; whoami; id; uname -a"],
  ["E04 进程号与 /proc/self/status", "echo $$ $PPID $BASHPID; cat /proc/self/status 2>&1 | head -5"],
  ["E05 HOME 与 PWD", "echo $HOME $PWD $OLDPWD $SHELL"],
  ["E06 Python 当前目录与用户目录", `python3 -c "import os; print(os.getcwd(), os.path.expanduser('~'))" 2>&1 | tail -1`],
];

const subst = (s: string) =>
  s
    .replaceAll("<O>", outside)
    .replaceAll("<W>", work)
    .replaceAll("<M>", materials)
    .replaceAll("<E>", engineHome)
    .replaceAll("<B>", base);

function suite(name: string, cases: Case[]) {
  describe(name, () => {
    for (const [id, script, extra] of cases) {
      test(id, { timeout: 60_000 }, async () => {
        const r = await run(subst(script));
        await invariants(id, r);
        if (extra) await extra(r);
      });
    }
    test(`${name}：执行域仍可用`, async () => {
      const r = await run("echo 健康");
      assert.equal(r.out, "健康\n");
    });
  });
}

suite("虚拟文件系统穿越", VFS);
suite("链接投毒", LINKS);
suite("桥接滥用", BRIDGE);
suite("原型污染", PROTO);
suite("联网（含 DNS）", NET);
suite("资源耗尽", RES);
suite("信息泄露", LEAK);

describe("预置链接（区外写入者）", () => {
  test("工作区或材料快照里出现符号链接/硬链接即拒绝运行", async () => {
    const { linkSync, symlinkSync, unlinkSync } = await import("node:fs");
    // 拒绝运行：命令一行都不执行，退出码 1，说明里点名链接文件，秘密不出现（审查 S3-07 起执行域返回进程而不在 spawn 时抛出）
    linkSync(join(outside, "secret.txt"), join(materials, "hl.txt"));
    const r1 = await run("cat hl.txt; echo 不应执行");
    assert.equal(r1.code, 1);
    assert.match(r1.out, /链接文件（hl\.txt）/);
    assert.doesNotMatch(r1.out, /不应执行/);
    // （区外目录的元数据被测试自己建的硬链接改变，不用 invariants 的目录摘要；只核对秘密不出现）
    for (const sec of SECRETS) assert.ok(!r1.out.includes(sec), `LINK-PRE-1：输出泄露秘密 ${sec}`);
    unlinkSync(join(materials, "hl.txt"));
    symlinkSync(join(outside, "secret.txt"), join(work, "sl.txt"));
    const r2 = await run("cat sl.txt; echo 不应执行");
    assert.equal(r2.code, 1);
    assert.match(r2.out, /链接文件（sl\.txt）/);
    assert.doesNotMatch(r2.out, /不应执行/);
    unlinkSync(join(work, "sl.txt"));
    const r = await run("echo 恢复");
    assert.equal(r.out, "恢复\n");
  });
});

test("用例总数 ≥ 100", () => {
  assert.ok(VFS.length + LINKS.length + BRIDGE.length + PROTO.length + NET.length + RES.length + LEAK.length >= 100);
});
