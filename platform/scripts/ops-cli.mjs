#!/usr/bin/env node
/**
 * 最小运营命令行（v9.3 A-10“运营按人鉴权”；Y2 §3.12 S12 运营控制台的命令行最小版）。
 *
 * 三种人、三类命令（三权分立的研发侧；部署配置与数据目录须由不在名册里的系统管理员掌握，D-106）：
 * - 运营人员：`keygen` 在本人电脑生成自己的签名密钥（私钥 0600、不覆盖已有文件；可用 --passphrase-env 加密），把公钥与指纹交给安全管理员；
 *   `call` 用自己的私钥签请求，调控制面、支持、中继、通知的运营接口（须从运维网段发出）。
 * - 安全管理员：`roster-keygen` 生成名册签名密钥（私钥离线保管，公钥合并进公钥表，部署到各服务的 ops.roster_keys_file）；
 *   `roster init` 新建名册（只此一次）；`roster add / add-key / perms / revoke / renew` 编辑并签发运营名册（每次版本加一、有效期重算，
 *   至多 31 天），新名册部署到各服务的 ops.roster_file 即生效，不需要重启；`roster show` 核验并列出。
 *   名册签名密钥轮换：先把新公钥合并进公钥表并部署到各服务，再 `roster renew --keys <公钥表> --sign-key <新私钥> --sign-kid <新编号>`，
 *   全部服务换上新名册后立即从公钥表删掉旧编号。
 * - 审计：控制面 <data_dir>/control-plane/ops/access.jsonl；支持、中继、通知 <data_dir>/<角色>/access.jsonl；各服务 ops/rejects.jsonl
 *   （被拒的运营请求）与 ops/roster-history.jsonl（名册换版）；被入口按来源挡下的只在 obs/ 访问日志里；控制面写操作另进律所可见的运营审计流水。
 *
 *   node scripts/ops-cli.mjs keygen --id op_0001 --kid k1 --out ~/.kwl-ops [--passphrase-env KWL_OPS_PASS]
 *   node scripts/ops-cli.mjs roster-keygen --kid sec-1 --out /secure/offline --keys-file ops-roster-keys.json
 *   node scripts/ops-cli.mjs roster init --deployment prod --sign-key /secure/offline/sec-1.key.pem --sign-kid sec-1 --out ops-roster.json
 *   node scripts/ops-cli.mjs roster add --roster ops-roster.json --id op_0001 --perms tenant.read,activation.issue --pub op_0001.k1.pub.pem \
 *        --fingerprint <运营报来的指纹> --sign-key /secure/offline/sec-1.key.pem --sign-kid sec-1 --out ops-roster.json
 *   node scripts/ops-cli.mjs roster revoke --roster ops-roster.json --id op_0001 [--kid k1] --sign-key … --sign-kid sec-1 --out ops-roster.json
 *   node scripts/ops-cli.mjs roster renew --roster ops-roster.json --sign-key … --sign-kid sec-1 --out ops-roster.json [--days 30]
 *   node scripts/ops-cli.mjs roster show --roster ops-roster.json --keys ops-roster-keys.json
 *   node scripts/ops-cli.mjs call --url https://cp.internal:8443 --deployment prod --aud control-plane --id op_0001 --kid k1 --key ~/.kwl-ops/op_0001.k1.key.pem \
 *        --method POST --path /v1/ops/tenants --body '{"tid":"ten_demo","edition":"team","seats":5}' [--ca ca.pem] [--passphrase-env KWL_OPS_PASS]
 *
 * `roster revoke` 不带 --kid：此人整体吊销（保留在名册里、标为 revoked，不能再改）；带 --kid：只删掉那一把密钥（例如丢失的 USBKey）。
 * 写名册：--out 已有文件且不是 --roster 本身时拒绝（--force 才覆盖），新版本号须高于它。输出只有结果、变更与指纹，不打印私钥。
 * 硬件令牌（USBKey）目前用不上：名册格式支持 P-256 公钥，但 call 只认私钥文件（D-106）。
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const oa = await import(join(root, "packages/ops-auth/src/index.ts"));

const fail = (msg, code = 2) => {
  console.error(`[ops-cli] ${msg}`);
  process.exit(code);
};
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);
const need = (name) => flag(name) ?? fail(`缺少 --${name}`);
/** 新建文件：O_EXCL（已存在或是符号链接即失败，不覆盖、不跟随）。 */
const writeNew = (path, text, mode) => {
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = openSync(path, "wx", mode);
  } catch {
    fail(`${path} 已存在：不覆盖`);
  }
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
/** 替换文件：随机临时名 + O_EXCL + fsync + 改名。 */
const writeAtomic = (path, text, mode) => {
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
};
const passphrase = () => {
  const env = flag("passphrase-env");
  if (env === undefined) return undefined;
  const v = process.env[env];
  if (!v || v.length < 12) fail(`环境变量 ${env} 里的口令至少 12 个字符`);
  return v;
};
const pubOf = (privatePem) => createPublicKey(createPrivateKey(privatePem)).export({ format: "pem", type: "spki" }).toString();
const readKeysFile = (file) => {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    for (const [kid, pem] of Object.entries(raw)) if (!oa.isPublicKeyPem(pem)) fail(`${file} 里的 ${kid} 不是公钥`);
    return raw;
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    fail(`${file} 读不出或不是 JSON`);
  }
};

const [cmd, sub] = argv;

if (cmd === "keygen" || cmd === "roster-keygen") {
  const kid = need("kid");
  if (!oa.OPS_KEY_ID_RE.test(kid)) fail("--kid 只用小写字母、数字与连字符（至多 24 位）");
  const id = cmd === "keygen" ? need("id") : null;
  if (id !== null && !oa.OPERATOR_ID_RE.test(id)) fail("--id 须为运营编号：op_ 加数字工号（例如 op_0001；不用姓名）");
  const out = need("out");
  const base = id ? `${id}.${kid}` : kid;
  const keyFile = join(out, `${base}.key.pem`);
  const pubFile = join(out, `${base}.pub.pem`);
  const k = oa.generateOpsKeyPair(passphrase());
  writeNew(keyFile, k.privateKeyPem, 0o600);
  if (cmd === "keygen") writeNew(pubFile, k.publicKeyPem, 0o644);
  let keysFile = null;
  if (cmd === "roster-keygen") {
    // 公钥表合并写入（复核 RA10A-14 / RA10B-04：轮换时旧编号不丢；公钥表与离线私钥分开放）
    keysFile = need("keys-file");
    const cur = readKeysFile(keysFile) ?? {};
    if (cur[kid]) fail(`${keysFile} 里已有 ${kid}`);
    writeAtomic(keysFile, `${JSON.stringify({ ...cur, [kid]: k.publicKeyPem }, null, 2)}\n`, 0o644);
  }
  console.log(JSON.stringify({ ok: true, private_key: keyFile, ...(cmd === "keygen" ? { public_key: pubFile } : { keys_file: keysFile }), fingerprint: oa.opsKeyFingerprint(k.publicKeyPem), encrypted: passphrase() !== undefined }));
} else if (cmd === "roster") {
  const rosterFile = flag("roster");
  const readJson = (file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      fail(`${file} 读不出或不是 JSON`);
    }
  };
  if (sub === "show") {
    const doc = readJson(need("roster"));
    const keys = new Map(Object.entries(readKeysFile(need("keys")) ?? fail("--keys 公钥表不存在")));
    const v = oa.verifyOpsRoster(doc, keys);
    if (!v.ok) fail(`名册核验不通过：${v.reason}`, 1);
    console.log(
      JSON.stringify(
        {
          ok: true,
          deployment: v.body.deployment,
          version: v.body.version,
          issued_at: v.body.issued_at,
          expires_at: v.body.expires_at,
          digest: v.digest,
          operators: v.body.operators.map((op) => ({ id: op.id, status: op.status, perms: op.perms, second_factor: op.second_factor, keys: op.keys.map((k) => ({ kid: k.kid, fingerprint: oa.opsKeyFingerprint(k.public_key_pem), added_at: k.added_at })) })),
        },
        null,
        2,
      ),
    );
  } else if (["init", "add", "add-key", "perms", "revoke", "renew"].includes(sub)) {
    const signPem = readFileSync(need("sign-key"), "utf8");
    const signKid = need("sign-kid");
    let signKey;
    try {
      signKey = createPrivateKey(passphrase() ? { key: signPem, passphrase: passphrase() } : signPem);
    } catch {
      fail("名册签名私钥读不出（加密的私钥须给 --passphrase-env）");
    }
    const out = need("out");
    const days = flag("days") === undefined ? 30 : Number(flag("days"));
    if (!Number.isInteger(days) || days < 1 || days > 31) fail("--days 须为 1–31");
    const now = Date.now();
    const at = new Date(now).toISOString();
    const expires = new Date(now + days * 86400_000).toISOString();
    let body;
    const changes = [];
    if (sub === "init") {
      // 新建只能显式 init，且 --out 不能已有文件（复核 RA10A-06 / RA10B-03：拼错 --roster 不会悄悄从版本 1 重建）
      const deployment = need("deployment");
      if (!oa.OPS_DEPLOYMENT_RE.test(deployment)) fail("--deployment 只用小写字母、数字与连字符（例如 prod）");
      if (existsSync(out)) fail(`${out} 已存在：init 只用于新建名册`);
      body = { format: oa.OPS_ROSTER_FORMAT, deployment, version: 1, issued_at: at, expires_at: expires, operators: [] };
      changes.push("init");
    } else {
      if (!rosterFile || !existsSync(rosterFile)) fail("须用 --roster 指向现有名册（新建用 roster init）");
      const cur = readJson(rosterFile);
      // 只在真名册上改：现有名册须由公钥表（--keys）里的某把或本次的签名密钥签发（轮换时用 --keys 带上旧公钥）
      const keys = new Map(Object.entries(flag("keys") ? (readKeysFile(flag("keys")) ?? fail("--keys 公钥表不存在")) : {}));
      keys.set(signKid, pubOf(signKey.export({ format: "pem", type: "pkcs8" }).toString()));
      const v = oa.verifyOpsRoster(cur, keys);
      if (!v.ok) fail(`现有名册核验不通过（${v.reason}）：不在来历不明的名册上修改`, 1);
      body = structuredClone(cur.body);
      if (sub !== "renew") {
        const id = need("id");
        const op = body.operators.find((x) => x.id === id);
        const perms = () =>
          String(need("perms"))
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
        const newKey = () => {
          const pubFile = need("pub");
          const pem = readFileSync(pubFile, "utf8");
          // 只收公钥；指纹须与运营人员当面或电话报来的一致（复核 RA10A-01 / RA10B-01）
          if (!oa.isPublicKeyPem(pem)) fail(`${pubFile} 不是公钥（看起来是私钥或格式不对）：私钥不得交给安全管理员`);
          const fp = oa.opsKeyFingerprint(pem);
          if (need("fingerprint") !== fp) fail(`指纹不符：文件为 ${fp}，与运营人员报来的不一致`);
          // 密钥编号与公钥文件名一致（复核 RA10B-14）
          const m = /^op_[0-9]+\.([a-z0-9][a-z0-9-]{0,23})\.pub\.pem$/.exec(basename(pubFile));
          const kid = flag("kid") ?? m?.[1] ?? fail("缺少 --kid（公钥文件名里也没有）");
          if (m && m[1] !== kid) fail(`--kid ${kid} 与公钥文件名里的 ${m[1]} 不一致`);
          return { kid, public_key_pem: pem, added_at: at };
        };
        if (sub === "add") {
          if (op) fail(`${id} 已在名册里（加密钥用 add-key，改权限用 perms）`);
          const key = newKey();
          body.operators.push({ id, status: "active", perms: perms(), keys: [key], second_factor: "none" });
          changes.push(`add ${id} ${key.kid}`);
        } else if (!op) {
          fail(`名册里没有 ${id}`);
        } else if (op.status !== "active") {
          // 已吊销的人不再改（复核 RA10B-13：再次吊销会覆盖原吊销时刻）；须重新登记一个新的运营编号
          fail(`${id} 已吊销（${op.revoked_at ?? ""}），不能再改`);
        } else if (sub === "add-key") {
          const key = newKey();
          op.keys.push(key);
          changes.push(`add-key ${id} ${key.kid}`);
        } else if (sub === "perms") {
          op.perms = perms();
          changes.push(`perms ${id} ${op.perms.join(",")}`);
        } else {
          const kid = flag("kid");
          if (kid) {
            if (!op.keys.some((k) => k.kid === kid)) fail(`${id} 没有密钥 ${kid}`);
            op.keys = op.keys.filter((k) => k.kid !== kid);
            changes.push(`revoke-key ${id} ${kid}`);
          } else {
            op.status = "revoked";
            op.revoked_at = at;
            changes.push(`revoke ${id}`);
          }
        }
      } else changes.push("renew");
      body.version += 1;
      body.issued_at = at;
      body.expires_at = expires;
    }
    // --out 已有别的名册：不覆盖（--force 才覆盖），新版本号须高于它
    if (existsSync(out) && resolve(out) !== resolve(rosterFile ?? "")) {
      if (!has("force")) fail(`${out} 已存在且不是 --roster：不覆盖（确需覆盖加 --force）`);
      try {
        const prev = JSON.parse(readFileSync(out, "utf8"));
        if (Number(prev?.body?.version) >= body.version) fail(`${out} 里的名册版本（${prev.body.version}）不低于新版本 ${body.version}`);
      } catch {
        // 不是名册：--force 下照常覆盖
      }
    }
    let signed;
    try {
      signed = oa.signOpsRoster(body, { kid: signKid, privateKey: signKey });
    } catch (e) {
      fail(e instanceof Error ? e.message : "名册签发失败");
    }
    writeAtomic(out, `${JSON.stringify(signed, null, 2)}\n`, 0o644);
    console.log(JSON.stringify({ ok: true, deployment: body.deployment, version: body.version, expires_at: body.expires_at, changes, out }));
  } else fail("roster 子命令：init / add / add-key / perms / revoke / renew / show");
} else if (cmd === "call") {
  let url;
  try {
    url = new URL(need("url"));
  } catch {
    fail("--url 不是网址");
  }
  const aud = need("aud");
  if (!oa.OPS_AUDIENCES.includes(aud)) fail(`--aud 须为 ${oa.OPS_AUDIENCES.join(" / ")}`);
  const method = String(flag("method") ?? "GET").toUpperCase();
  const path = need("path");
  // 路径须已规范、已转义（签名按原样路径；发出时被改写就对不上）
  let norm;
  try {
    const u = new URL(path, "http://x");
    norm = u.pathname + u.search;
  } catch {
    norm = "";
  }
  if (!path.startsWith("/") || norm !== path) fail("--path 须以 / 开头、已转义、不含点段（例如中文要先 encodeURIComponent）");
  const body = flag("body") ?? "";
  if (body && (method === "GET" || method === "DELETE")) fail(`${method} 不带请求体（服务按空请求体核验签名）`);
  let privateKey;
  try {
    const pem = readFileSync(need("key"), "utf8");
    privateKey = createPrivateKey(passphrase() ? { key: pem, passphrase: passphrase() } : pem);
  } catch {
    fail("私钥读不出（加密的私钥须给 --passphrase-env）");
  }
  const headers = oa.signOpsRequest({ deployment: need("deployment"), audience: aud, method, path, body, operator: need("id"), kid: need("kid"), privateKey });
  const ca = flag("ca");
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
    { host, port: url.port || (url.protocol === "https:" ? 443 : 80), method, path, timeout: 30_000, headers: { ...headers, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) }, ...(ca ? { ca: readFileSync(ca) } : {}) },
    (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const t = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = JSON.parse(t);
        } catch {
          parsed = t.slice(0, 2000);
        }
        console.log(JSON.stringify({ status: res.statusCode, body: parsed }));
        process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
      });
    },
  );
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (e) => fail(e?.message === "timeout" ? "30 秒内没有应答" : "连不上服务", 1));
  if (body) req.write(body);
  req.end();
} else {
  fail("用法：keygen | roster-keygen | roster <init|add|add-key|perms|revoke|renew|show> | call（见文件头注释）");
}
