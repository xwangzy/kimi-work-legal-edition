#!/usr/bin/env node
/**
 * 本机全链路栈（第 44 批验收用；不是生产部署）：用**生产入口与正式工具**在回环地址上拉起云端三件套，
 * 再给桌面端开发桥一份环境变量——律师端注册 / 登录 → 控制面账号 → 设备 → 席位令牌 → 网关动态路由 → 中软 MaaS → 用量账本 → 控制台。
 *
 * - 密钥：`cloud-init-secrets.mjs`（与生产同一工具）；运营名册：`ops-cli.mjs`（roster-keygen / keygen / roster init / add，与生产同一流程）；
 * - 服务：`cloud-serve.mjs --config`（cp-signer、control-plane、gateway；`insecure_loopback_for_test` 只许 127.0.0.1——这是与生产唯一的差别：没有 TLS）；
 * - 上游密钥：只经文件描述符 3 交给网关进程（`upstream.api_key_file: /dev/fd/3`），不写盘、不进命令行与环境变量；
 *   来源依次为 `--key-file`、环境变量 KWL_MOONSHOT_API_KEY、macOS 钥匙串（KWL_EVAL_KEYCHAIN_ACCOUNT / _SERVICE，缺省 kwl-demo / kwl-demo-maas-key）；
 * - 运营控制台：同进程静态服务 `apps/ops-console/dist`（先 `node scripts/build-ops-console.mjs`），发严格 CSP，config.json 指向本栈控制面；
 * - 状态（账号、路由、账本、审计）都落在 --dir 里，重启保留。
 *
 * 用法：node scripts/stack-local.mjs --dir <目录> [--base-port 18400] [--upstream https://maas.jointpilot.com/v1] [--model kimi-k3.1-pro] [--tls]
 * --tls：与生产同一形态的传输——本机自建 CA（openssl）签各服务证书，签名服务只收控制面的客户端证书（mTLS + URI SAN 调用方核对），
 *        各服务只接受 HTTPS；client.env 另给 NODE_EXTRA_CA_CERTS 与各服务的 SPKI 钉住值（与 release.json 同一口径）。
 * 输出：<目录>/client.env（交给桌面端开发桥的变量）、控制台账号（op_0001 登录名 admin、op_0002 登录名 issuer；初始密码首次生成时打印一次并存
 *       <目录>/ops/initial-passwords.txt（0600），首次登录须改）、<目录>/ops/op_0001.k1.key.pem（私钥登录仍可用）、日志 <目录>/logs/*.log（遮盖密钥）。
 * 停：Ctrl-C（或 SIGTERM 本进程；子进程一并停）。
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const dir = resolve(arg("dir", ""));
if (!arg("dir")) {
  console.error("用法：node scripts/stack-local.mjs --dir <目录>");
  process.exit(2);
}
const basePort = Number(arg("base-port", "18400"));
const P = { signer: basePort, cp: basePort + 1, gw: basePort + 2, console: basePort + 3, search: basePort + 4 };
const upstream = arg("upstream", "https://maas.jointpilot.com/v1");
const model = arg("model", "kimi-k3.1-pro");
const node = process.execPath;
const useTls = process.argv.includes("--tls");
const run = (script, args) => {
  const r = spawnSync(node, [join(root, "scripts", script), ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${script} 失败：${r.stderr || r.stdout}`);
  return r.stdout;
};
mkdirSync(join(dir, "logs"), { recursive: true, mode: 0o700 });
mkdirSync(join(dir, "cfg"), { recursive: true, mode: 0o700 });

// ─── 1. 密钥（首次） ───
const init = join(dir, "init");
if (!existsSync(init)) run("cloud-init-secrets.mjs", ["--env", "test", "--out", init, "--id", "e1", "--mount", join(init, "secrets")]);
const sec = (f) => join(init, "secrets", f);
const pub = (f) => join(init, "public", f);

// ─── 2. 运营名册（首次；与生产同一流程：安全管理员名册密钥 → 运营本人生成密钥 → 签发名册并加人） ───
const ops = join(dir, "ops");
if (!existsSync(join(ops, "roster.json"))) {
  mkdirSync(ops, { recursive: true, mode: 0o700 });
  run("ops-cli.mjs", ["roster-keygen", "--kid", "sec-1", "--out", join(ops, "offline"), "--keys-file", join(ops, "roster-keys.json")]);
  const kg = JSON.parse(run("ops-cli.mjs", ["keygen", "--id", "op_0001", "--kid", "k1", "--out", ops]).trim().split("\n").at(-1));
  run("ops-cli.mjs", ["roster", "init", "--deployment", "dev", "--sign-key", join(ops, "offline", "sec-1.key.pem"), "--sign-kid", "sec-1", "--out", join(ops, "roster.json")]);
  run("ops-cli.mjs", ["roster", "add", "--roster", join(ops, "roster.json"), "--id", "op_0001", "--perms", "tenant.read,tenant.manage,tenant.terminate,quota.manage,quota.cap,device.revoke,account.manage,route.manage,plan.manage", "--pub", kg.public_key, "--fingerprint", kg.fingerprint, "--sign-key", join(ops, "offline", "sec-1.key.pem"), "--sign-kid", "sec-1", "--out", join(ops, "roster.json")]);
  // 发开通码的人与开通律所的人须分开（D-106 职责分离）：另一位运营只有 activation.issue
  const kg2 = JSON.parse(run("ops-cli.mjs", ["keygen", "--id", "op_0002", "--kid", "k1", "--out", ops]).trim().split("\n").at(-1));
  run("ops-cli.mjs", ["roster", "add", "--roster", join(ops, "roster.json"), "--id", "op_0002", "--perms", "tenant.read,activation.issue", "--pub", kg2.public_key, "--fingerprint", kg2.fingerprint, "--sign-key", join(ops, "offline", "sec-1.key.pem"), "--sign-kid", "sec-1", "--out", join(ops, "roster.json")]);
}

// ─── 2b. 控制台账号密码（与生产同一流程：安全管理员 ops-cli password set 发初始密码，首次登录须改）；凭据库即控制面 ops.credentials_file ───
const credFile = join(ops, "credentials.json");
const pwNote = join(ops, "initial-passwords.txt");
if (!existsSync(credFile)) {
  const issued = [];
  for (const [id, login] of [["op_0001", "admin"], ["op_0002", "issuer"]]) {
    const r = JSON.parse(run("ops-cli.mjs", ["password", "set", "--credentials", credFile, "--id", id, "--login", login, "--roster", join(ops, "roster.json"), "--keys", join(ops, "roster-keys.json")]).trim().split("\n").at(-1));
    issued.push(`${login}（${id}）  ${r.initial_password}`);
  }
  writeFileSync(pwNote, `控制台初始密码（首次登录须改；改过之后这里的就失效了）\n${issued.join("\n")}\n`, { mode: 0o600 });
}

// ─── 2a. TLS（--tls）：本机 CA、服务证书、控制面调用签名服务的客户端证书 ───
const tlsDir = join(dir, "tls");
const ossl = (args) => {
  const r = spawnSync("openssl", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} 失败：${r.stderr}`);
};
if (useTls && !existsSync(join(tlsDir, "ca.crt"))) {
  mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  const t = (f) => join(tlsDir, f);
  ossl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", t("ca.key"), "-out", t("ca.crt"), "-days", "30", "-subj", "/CN=kwl local stack CA"]);
  for (const [name, ext] of [
    ["signer", "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth"],
    ["cp", "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth"],
    ["gw", "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth"],
    ["search", "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth"],
    ["cp-api-client", "subjectAltName=URI:spiffe://kwl/test/cp-api\nextendedKeyUsage=clientAuth"],
  ]) {
    writeFileSync(t(`${name}.ext`), ext.replace(/\\n/g, "\n"));
    ossl(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", t(`${name}.key`), "-out", t(`${name}.csr`), "-subj", `/CN=${name}`]);
    ossl(["x509", "-req", "-in", t(`${name}.csr`), "-CA", t("ca.crt"), "-CAkey", t("ca.key"), "-CAcreateserial", "-days", "30", "-out", t(`${name}.crt`), "-extfile", t(`${name}.ext`)]);
  }
}
const tlsOf = (name) => (useTls ? { tls: { cert_file: join(tlsDir, `${name}.crt`), key_file: join(tlsDir, `${name}.key`) } } : { insecure_loopback_for_test: true });
const scheme = useTls ? "https" : "http";

// ─── 3. 配置（每次按端口重写） ───
const loop = (port) => ({ host: "127.0.0.1", port });
const consoleOrigin = `http://127.0.0.1:${P.console}`;
const cfgs = {
  signer: {
    role: "cp-signer",
    environment: "test",
    init_ledger: !existsSync(join(dir, "data", "signer", "cp-signer", "ledger.jsonl")),
    listen: loop(P.signer),
    ...(useTls ? { tls: { cert_file: join(tlsDir, "signer.crt"), key_file: join(tlsDir, "signer.key"), client_ca_file: join(tlsDir, "ca.crt") }, allowed_callers: ["spiffe://kwl/test/cp-api"] } : { insecure_loopback_for_test: true }),
    data_dir: join(dir, "data", "signer"),
    keys: JSON.parse(readFileSync(pub("signer-keys.json"), "utf8")),
  },
  cp: {
    role: "control-plane",
    listen: loop(P.cp),
    ...tlsOf("cp"),
    service_secret_file: sec("service-secret"),
    data_dir: join(dir, "data", "cp"),
    signer: useTls ? { url: `https://127.0.0.1:${P.signer}`, client_cert_file: join(tlsDir, "cp-api-client.crt"), client_key_file: join(tlsDir, "cp-api-client.key"), ca_file: join(tlsDir, "ca.crt") } : { url: `http://127.0.0.1:${P.signer}` },
    state_key_file: sec("cp-state.key"),
    code_pepper_file: sec("cp-code-pepper.key"),
    // 运营接口只许运维网段：生产入口拒绝把回环地址列进 allow_cidrs（非测试形态），所以 --tls 演练不开运营接口（运营与控制台在回环形态验）
    ...(useTls ? {} : { ops: { deployment: "dev", roster_file: join(ops, "roster.json"), roster_keys_file: join(ops, "roster-keys.json"), allow_cidrs: ["127.0.0.1/32"], console_origins: [consoleOrigin], credentials_file: credFile } }),
    routing: { bootstrap: { provider: { id: "maas", label: "中软 MaaS", vendor: "csi-maas", base_url: upstream }, models: { "legal/k3": model, "legal/k2.6": model } }, public_key_file: pub("routing-public.txt") },
  },
  gw: {
    role: "gateway",
    listen: loop(P.gw),
    ...tlsOf("gw"),
    service_secret_file: sec("service-secret"),
    control_plane: { url: `${scheme}://127.0.0.1:${P.cp}`, keys_file: pub("cp-public-keys.json") },
    seat_keys_file: pub("seat-public-keys.json"),
    data_dir: join(dir, "data", "gw"),
    upstream: { base_url: upstream, api_key_file: "/dev/fd/3" },
    routing: { feed: true, key_file: sec("routing-key.pem"), allow_hosts: [new URL(upstream).hostname] },
    upstream_header_timeout_ms: 180_000,
  },
  // 法律检索（联网检索，经同一上游的 /tools/search；中软 MaaS 是否提供此接口见验收报告）
  search: {
    role: "search",
    listen: loop(P.search),
    ...tlsOf("search"),
    service_secret_file: sec("service-secret"),
    control_plane: { url: `${scheme}://127.0.0.1:${P.cp}`, keys_file: pub("cp-public-keys.json") },
    seat_keys_file: pub("seat-public-keys.json"),
    data_dir: join(dir, "data", "search"),
    upstream: { base_url: upstream, api_key_file: "/dev/fd/3" },
  },
};
for (const [k, c] of Object.entries(cfgs)) writeFileSync(join(dir, "cfg", `${k}.json`), JSON.stringify(c, null, 2), { mode: 0o600 });

// ─── 4. 上游密钥（只给网关；不写盘） ───
let key = null;
if (arg("key-file")) key = readFileSync(arg("key-file"), "utf8").trim();
else if (process.env.KWL_MOONSHOT_API_KEY) key = process.env.KWL_MOONSHOT_API_KEY.trim();
else key = execFileSync("/usr/bin/security", ["find-generic-password", "-a", process.env.KWL_EVAL_KEYCHAIN_ACCOUNT ?? "kwl-demo", "-s", process.env.KWL_EVAL_KEYCHAIN_SERVICE ?? "kwl-demo-maas-key", "-w"], { encoding: "utf8" }).trim();
if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error("上游密钥格式不对（未输出内容）");
const mask = (s) => String(s).split(key).join("[已遮盖]");

// ─── 5. 拉起 ───
const kids = [];
const stop = (code = 0) => {
  for (const k of kids) k.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1500);
};
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
const startRole = (name, withKey = false) =>
  new Promise((ok, no) => {
    const log = createWriteStream(join(dir, "logs", `${name}.log`), { flags: "a" });
    const env = { ...process.env, ...(useTls ? { NODE_EXTRA_CA_CERTS: join(tlsDir, "ca.crt") } : {}) };
    delete env.KWL_MOONSHOT_API_KEY;
    const k = spawn(node, [join(root, "scripts/cloud-serve.mjs"), "--config", join(dir, "cfg", `${name}.json`)], { env, stdio: ["ignore", "pipe", "pipe", withKey ? "pipe" : "ignore"] });
    kids.push(k);
    if (withKey) {
      k.stdio[3].end(`${key}\n`);
    }
    let buf = "";
    const on = (d) => {
      const t = mask(d);
      log.write(t);
      buf += t;
      if (/已就绪/.test(buf)) ok(k);
    };
    k.stdout.on("data", on);
    k.stderr.on("data", on);
    k.on("exit", (c) => {
      log.write(`[stack] ${name} 已退出（${c}）\n`);
      no(new Error(`${name} 退出（${c}）：${buf.slice(-600)}`));
      stop(1);
    });
  });
await startRole("signer");
await startRole("cp");
await startRole("gw", true);
await startRole("search", true);

// ─── 6. 运营控制台（静态页 + 严格 CSP；先构建 dist） ───
run("build-ops-console.mjs", []);
const dist = join(root, "apps/ops-console/dist");
const consoleConfig = JSON.stringify({ control_plane_base: `${scheme}://127.0.0.1:${P.cp}`, deployment: "dev", label: "本机全链路栈", routing_public_key: readFileSync(pub("routing-public.txt"), "utf8").trim(), routing_key_id: readFileSync(pub("routing-key-id.txt"), "utf8").trim() });
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const CSP = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${scheme}://127.0.0.1:${P.cp}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const headers = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
  if (u.pathname === "/config.json") {
    res.writeHead(200, { ...headers, "content-type": TYPES[".json"] });
    return res.end(consoleConfig);
  }
  const rel = normalize(u.pathname === "/" ? "/index.html" : u.pathname).replace(/^(\.\.[/\\])+/, "");
  const f = join(dist, rel);
  if (!f.startsWith(dist) || !existsSync(f)) {
    res.writeHead(404, headers);
    return res.end("not found");
  }
  res.writeHead(200, { ...headers, "content-type": TYPES[extname(f)] ?? "application/octet-stream" });
  res.end(readFileSync(f));
}).listen(P.console, "127.0.0.1");

// ─── 7. 交给桌面端的环境变量 ───
const cpKeys = readFileSync(pub("cp-public-keys.json"), "utf8").trim();
const seatKeys = readFileSync(pub("seat-public-keys.json"), "utf8").trim();
const spki = (crt) => {
  const r = spawnSync("sh", ["-c", `openssl x509 -in "${crt}" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`], { encoding: "utf8" });
  return `sha256/${r.stdout.trim()}`;
};
const envLines = [
  ...(useTls ? [`NODE_EXTRA_CA_CERTS=${join(tlsDir, "ca.crt")}`, `ZR_CONTROL_PLANE_PINS=${spki(join(tlsDir, "cp.crt"))}`, `ZR_GATEWAY_PINS=${spki(join(tlsDir, "gw.crt"))}`, `ZR_SEARCH_PINS=${spki(join(tlsDir, "search.crt"))}`] : []),
  `ZR_CONTROL_PLANE_BASE=${scheme}://127.0.0.1:${P.cp}`,
  `ZR_CONTROL_PLANE_KEYS=${JSON.stringify(JSON.parse(cpKeys))}`,
  `ZR_SEAT_KEYS=${JSON.stringify(JSON.parse(seatKeys))}`,
  `ZR_GATEWAY_BASE=${scheme}://127.0.0.1:${P.gw}/v1`,
  `ZR_SEARCH_BASE=${scheme}://127.0.0.1:${P.search}/v1/search`,
  "ZR_REQUIRE_CONTROL_PLANE=1",
  "ZR_ONBOARDING=1",
  "ZR_MODEL_PROVIDER=upstream",
];
writeFileSync(join(dir, "client.env"), `${envLines.join("\n")}\n`, { mode: 0o600 });
console.log(`[stack] 云端已就绪：签名服务 ${P.signer}、控制面 ${P.cp}、网关 ${P.gw}、检索 ${P.search}、控制台 http://127.0.0.1:${P.console}/`);
if (!useTls) console.log(`[stack] 控制台账号：admin（op_0001）、issuer（op_0002）；初始密码见 ${pwNote}（首次登录须改）。私钥登录仍可用：${join(ops, "op_0001.k1.key.pem")}`);
console.log(`[stack] 桌面端环境变量：${join(dir, "client.env")}`);
