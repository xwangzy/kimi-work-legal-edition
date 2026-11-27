#!/usr/bin/env node
/**
 * 本机全链路栈（第 44 批验收用；不是生产部署）：用**生产入口与正式工具**在回环地址上拉起云端三件套，
 * 再给桌面端开发桥一份环境变量——律师端注册 / 登录 → 控制面账号 → 设备 → 席位令牌 → 网关动态路由 → 中软 MaaS → 用量账本 → 控制台。
 *
 * - 密钥：`cloud-init-secrets.mjs`（与生产同一工具）；
 * - 控制台账号（第 46 批，契约 §2.4，与生产同一流程）：控制面配置 console.bootstrap_admin，首次启动把系统管理员的设置码写进
 *   <data_dir>/control-plane/bootstrap-admin.txt；本脚本读出设置码、经 POST /v1/auth/password-reset/confirm 设好密码，
 *   把登录信息写进 <目录>/console-login.txt（0600）。平台人员登录只要账号密码（D-218 取消两步验证），不再用 ops-cli 名册与密码；
 * - 服务：`cloud-serve.mjs --config`（cp-signer、control-plane、gateway、search、relay；`insecure_loopback_for_test` 只许 127.0.0.1——这是与生产唯一的差别：没有 TLS）；
 * - 共享中继（第 73 批，v1.8.0 起标准服务；D-309）：端口 base+6，与生产同口径——与控制面同一张证书（--tls 时）、只信中继受众的席位公钥、
 *   订阅控制面吊销集与律所策略；client.env 写 ZR_RELAY_BASE（回环开发形态不需要钉住；--tls 时 ZR_RELAY_PINS = 控制面的钉住值）；
 * - 上游密钥：只经文件描述符 3 交给网关进程（`upstream.api_key_file: /dev/fd/3`），不写盘、不进命令行与环境变量；
 *   来源依次为 `--key-file`、环境变量 KWL_MOONSHOT_API_KEY、macOS 钥匙串（KWL_EVAL_KEYCHAIN_ACCOUNT / _SERVICE，缺省 kwl-demo / kwl-demo-maas-key）；
 * - 控制台：同进程静态服务 <目录>/console-dist（`build-console.mjs --control-plane <本栈控制面>` 打包，页内 CSP 只许连本栈控制面），
 *   config.json 指向本栈控制面；控制面 console.origins 放行控制台来源（跨源、不带凭据）；
 * - 状态（账号、路由、账本、审计）都落在 --dir 里，重启保留。
 *
 * 用法：node scripts/stack-local.mjs --dir <目录> [--base-port 18400] [--upstream https://maas.jointpilot.com/v1] [--model kimi-k3.1-pro] [--tls]
 * --tls：与生产同一形态的传输——本机自建 CA（openssl）签各服务证书，签名服务只收控制面的客户端证书（mTLS + URI SAN 调用方核对），
 *        各服务只接受 HTTPS；client.env 另给 NODE_EXTRA_CA_CERTS 与各服务的 SPKI 钉住值（与 release.json 同一口径）。
 * 输出：<目录>/client.env（交给桌面端开发桥的变量）、<目录>/console-login.txt（0600：控制台地址、系统管理员邮箱与密码；
 *       改过密码后这里的就失效了）、日志 <目录>/logs/*.log（遮盖密钥）。最后一行打印 `[stack] 控制台账号：<文件>` 供 demo-launch 读取。
 * --no-account-ca：签名服务不带账号设备签发钥（模拟线上 1.5.0 的配置缺口：个人账号新电脑退化为等批准；第 71 批复现用）。
 * 停：Ctrl-C（或 SIGTERM 本进程；子进程一并停）。
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
const P = { signer: basePort, cp: basePort + 1, gw: basePort + 2, console: basePort + 3, search: basePort + 4, relay: basePort + 6 };
const upstream = arg("upstream", "https://maas.jointpilot.com/v1");
const model = arg("model", "kimi-k3.1-pro");
// 第 72 批（D-299）：K2.6 指真实的 kimi-k2.6（原先与 K3 同指 --model，问答里切 K2.6 实际仍是 K3.1 Pro）
const modelK26 = arg("model-k26", "kimi-k2.6");
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
// 第 66 批（V40，D-292）：第 66 批之前建的本机栈没有账号设备签发钥——补一把（与 cloud-init-secrets 同名同路径），个人账号新电脑即可直接登录
{
  const keysFile = join(init, "public", "signer-keys.json");
  const ks = JSON.parse(readFileSync(keysFile, "utf8"));
  if (!ks.account_device_ca) {
    const { generateKeyPairSync } = await import("node:crypto");
    writeFileSync(sec("account-device-ca.pem"), generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600, flag: "wx" });
    ks.account_device_ca = { kid: "acct-ca-test-e1", private_key_file: sec("account-device-ca.pem") };
    writeFileSync(keysFile, `${JSON.stringify(ks, null, 2)}\n`, { mode: 0o644 });
  }
}
const pub = (f) => join(init, "public", f);
// 第 73 批：共享中继只信中继受众的席位公钥表（cloud-init-secrets 早就生成；缺了按签名服务的 seat_audiences.relay 私钥导出一份，与 relay-config.mjs 同一做法）
if (!existsSync(pub("seat-relay-public-keys.json"))) {
  const { createPublicKey } = await import("node:crypto");
  const rk = JSON.parse(readFileSync(pub("signer-keys.json"), "utf8")).seat_audiences?.relay;
  if (!rk?.kid || !rk?.private_key_file) throw new Error("签名服务密钥里没有中继受众（seat_audiences.relay）：删掉 --dir 下的 init 重新生成");
  const pem = createPublicKey(readFileSync(rk.private_key_file, "utf8")).export({ format: "pem", type: "spki" }).toString();
  writeFileSync(pub("seat-relay-public-keys.json"), `${JSON.stringify({ [rk.kid]: pem }, null, 2)}\n`, { mode: 0o644, flag: "wx" });
}

// ─── 2. 控制台首个系统管理员（契约 §2.4）：控制面启动后经设置码设密码，见第 6 步 ───
const ADMIN = { email: "admin@kwl-local.example", name: "系统管理员（本机栈）" };
const loginFile = join(dir, "console-login.txt");

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
    // 第 71 批：--no-account-ca 模拟线上 1.5.0（签名服务没有账号设备签发钥：个人账号新电脑退化为等批准），复现与回归用
    keys: (({ account_device_ca, ...rest }) => (process.argv.includes("--no-account-ca") ? rest : { ...rest, account_device_ca }))(JSON.parse(readFileSync(pub("signer-keys.json"), "utf8"))),
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
    // 平台运营接口（/v1/ops/*）按平台人员账号会话 + 角色鉴权、不限来源（D-218 取消运维网段），回环与 --tls 两种形态都开；ops 段只给“系统”页的部署标识
    ops: { deployment: "dev" },
    // 第 62 批：本机栈允许短信 dry-run（运营在控制台打开后验证码随应答返回、不发短信）；生产入口缺省不允许
    // 第 69 批：回环形态（无 TLS）另让登录 / 找回 / 绑定的 dry-run 验证码也随应答返回——验证码登录与换账号可在本机端到端走通
    sms: { allow_dry_run: true, ...(useTls ? {} : { dry_run_reveal_all_loopback: true }) },
    console: { origins: [consoleOrigin], bootstrap_admin: ADMIN },
    routing: { bootstrap: { provider: { id: "maas", label: "中软 MaaS", vendor: "csi-maas", base_url: upstream }, models: { "legal/k3": model, "legal/k2.6": modelK26 } }, public_key_file: pub("routing-public.txt") },
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
  // 共享中继（团队共享事项的密文同步；按订阅里的律所策略 share_relay 核对）：与生产同口径——用控制面那张证书、只信中继受众的席位公钥
  relay: {
    role: "relay",
    listen: loop(P.relay),
    ...tlsOf("cp"),
    service_secret_file: sec("service-secret"),
    control_plane: { url: `${scheme}://127.0.0.1:${P.cp}`, keys_file: pub("cp-public-keys.json") },
    seat_keys_file: pub("seat-relay-public-keys.json"),
    data_dir: join(dir, "data", "relay"),
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
      // 子进程没读完就退出时这一端会 ECONNRESET / EPIPE：只记一行，退出原因由下面的 exit 处理给出（此前没有处理器，本进程直接崩溃、看不到子进程的错误）
      k.stdio[3].on("error", (e) => log.write(`[stack] ${name} 密钥管道：${e.code ?? "error"}\n`));
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
await startRole("relay");

// ─── 6. 控制台（静态页 + 严格 CSP；页内 CSP 只许连本栈控制面） ───
const cpOrigin = `${scheme}://127.0.0.1:${P.cp}`;
const dist = join(dir, "console-dist");
run("build-console.mjs", ["--out", dist, "--control-plane", cpOrigin]);
const consoleConfig = JSON.stringify({ control_plane_base: cpOrigin, deployment: "dev", label: "本机全链路栈" });
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const CSP = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${cpOrigin}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const headers = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
  if (u.pathname === "/config.json") {
    res.writeHead(200, { ...headers, "content-type": TYPES[".json"] });
    return res.end(consoleConfig);
  }
  const rel = normalize(u.pathname === "/" ? "/index.html" : u.pathname).replace(/^(\.\.[/\\])+/, "");
  const f = join(dist, rel);
  // 第 72 批：目录路径（如 /before/）与读失败一律 404——原来 readFileSync 读目录抛 EISDIR 未捕获，整个栈父进程随之退出
  let body = null;
  try {
    if (f.startsWith(dist) && existsSync(f) && statSync(f).isFile()) body = readFileSync(f);
  } catch {
    body = null;
  }
  if (!body) {
    res.writeHead(404, headers);
    return res.end("not found");
  }
  res.writeHead(200, { ...headers, "content-type": TYPES[extname(f)] ?? "application/octet-stream" });
  res.end(body);
}).listen(P.console, "127.0.0.1");

// ─── 6b. 首个系统管理员：读 bootstrap-admin.txt 的设置码 → /v1/auth/password-reset/confirm 设密码 → 登录信息写 0600 文件 ───
const bootFile = join(dir, "data", "cp", "control-plane", "bootstrap-admin.txt");
let adminNote = existsSync(loginFile) ? "沿用已有登录信息" : "没有登录信息";
for (let i = 0; i < 40 && !existsSync(bootFile) && !existsSync(loginFile); i++) await new Promise((r) => setTimeout(r, 250));
if (existsSync(bootFile)) {
  const text = readFileSync(bootFile, "utf8");
  const email = /^email:\s*(\S+)/m.exec(text)?.[1];
  const code = /^setup_code:\s*(\S+)/m.exec(text)?.[1];
  if (!email || !code) throw new Error(`读不懂 ${bootFile}（缺 email 或 setup_code）`);
  const password = `Local-${randomBytes(12).toString("base64url")}7`;
  const r = await fetch(`${cpOrigin}/v1/auth/password-reset/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code, password }) });
  if (!r.ok) throw new Error(`用设置码设系统管理员密码失败：HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  writeFileSync(loginFile, `本机栈控制台（改过密码后这里的就失效了；删掉本文件并重启本栈会重新引导）\nurl: http://127.0.0.1:${P.console}/\nemail: ${email}\npassword: ${password}\n`, { mode: 0o600 });
  adminNote = "已用设置码设好系统管理员密码";
}

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
  // 第 73 批：共享中继（--tls 时钉住集与控制面相同：同一张证书）
  `ZR_RELAY_BASE=${scheme}://127.0.0.1:${P.relay}`,
  ...(useTls ? [`ZR_RELAY_PINS=${spki(join(tlsDir, "cp.crt"))}`] : []),
  "ZR_REQUIRE_CONTROL_PLANE=1",
  "ZR_ONBOARDING=1",
  "ZR_MODEL_PROVIDER=upstream",
];
writeFileSync(join(dir, "client.env"), `${envLines.join("\n")}\n`, { mode: 0o600 });
console.log(`[stack] 云端已就绪：签名服务 ${P.signer}、控制面 ${P.cp}、网关 ${P.gw}、检索 ${P.search}、共享中继 ${P.relay}、控制台 http://127.0.0.1:${P.console}/`);
console.log(`[stack] 控制台：系统管理员 ${ADMIN.email}（${adminNote}）`);
console.log(`[stack] 控制台账号：${loginFile}`);
console.log(`[stack] 桌面端环境变量：${join(dir, "client.env")}`);
