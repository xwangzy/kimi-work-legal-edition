#!/usr/bin/env node
/**
 * 最小运营命令行（v9.3 A-10“运营按人鉴权”；Y2 §3.12 S12 运营控制台的命令行最小版）。
 *
 * 三种人、三类命令（三权分立的研发侧）：
 * - 运营人员：`keygen` 在本人电脑生成自己的签名密钥（私钥不离开本人电脑，0600），把公钥与指纹交给安全管理员；
 *   `call` 用自己的私钥签请求，调控制面、支持、中继、通知的运营接口（须从运维网段发出）。
 * - 安全管理员：`roster-keygen` 生成名册签名密钥（离线保管，不放到任何服务上）；`roster add / add-key / perms / revoke / show`
 *   编辑并签发运营名册（每次版本加一），新名册部署到各服务的 ops.roster_file 即生效，不需要重启。
 * - 审计：各服务 <data_dir>/<角色>/ops/ 下的访问审计与被拒记录；控制面的写操作另进律所可见的运营审计流水（执行者为运营编号）。
 *
 *   node scripts/ops-cli.mjs keygen --id op_0001 --kid k1 --out ~/.kwl-ops
 *   node scripts/ops-cli.mjs roster-keygen --kid sec-1 --out /secure/offline
 *   node scripts/ops-cli.mjs roster add --roster ops-roster.json --id op_0001 --perms tenant.read,activation.issue --pub op_0001.k1.pub.pem \
 *        --sign-key /secure/offline/sec-1.key.pem --sign-kid sec-1 --out ops-roster.json
 *   node scripts/ops-cli.mjs roster revoke --roster ops-roster.json --id op_0001 [--kid k1] --sign-key ... --sign-kid sec-1 --out ops-roster.json
 *   node scripts/ops-cli.mjs roster show --roster ops-roster.json --keys ops-roster-keys.json
 *   node scripts/ops-cli.mjs call --url https://cp.internal:8443 --aud control-plane --id op_0001 --kid k1 --key ~/.kwl-ops/op_0001.k1.key.pem \
 *        --method POST --path /v1/ops/tenants --body '{"tid":"ten_demo","edition":"team","seats":5}' [--ca ca.pem]
 *
 * `roster revoke` 不带 --kid：此人整体吊销（保留在名册里、标为 revoked）；带 --kid：只删掉那一把密钥（例如丢失的 USBKey）。
 * 输出只有结果与指纹，不打印私钥。
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join, resolve } from "node:path";
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
const need = (name) => flag(name) ?? fail(`缺少 --${name}`);
const writeAtomic = (path, text, mode = 0o600) => {
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
};
const pubOf = (privatePem) => createPublicKey(createPrivateKey(privatePem)).export({ format: "pem", type: "spki" }).toString();

const [cmd, sub] = argv;

if (cmd === "keygen" || cmd === "roster-keygen") {
  const kid = need("kid");
  if (!oa.OPS_KEY_ID_RE.test(kid)) fail("--kid 只用小写字母、数字与连字符（至多 24 位）");
  const id = cmd === "keygen" ? need("id") : null;
  if (id !== null && !oa.OPERATOR_ID_RE.test(id)) fail("--id 须为运营编号（op_ 加工号，例如 op_0001；不用姓名）");
  const out = need("out");
  const base = id ? `${id}.${kid}` : kid;
  const keyFile = join(out, `${base}.key.pem`);
  if (existsSync(keyFile)) fail(`${keyFile} 已存在：不覆盖已有私钥`);
  const k = oa.generateOpsKeyPair();
  writeAtomic(keyFile, k.privateKeyPem, 0o600);
  writeAtomic(join(out, `${base}.pub.pem`), k.publicKeyPem, 0o644);
  if (cmd === "roster-keygen") writeAtomic(join(out, "ops-roster-keys.json"), `${JSON.stringify({ [kid]: k.publicKeyPem }, null, 2)}\n`, 0o644);
  console.log(JSON.stringify({ ok: true, private_key: keyFile, public_key: join(out, `${base}.pub.pem`), fingerprint: oa.opsKeyFingerprint(k.publicKeyPem) }));
} else if (cmd === "roster") {
  const rosterFile = flag("roster");
  const readRoster = () => {
    if (!rosterFile || !existsSync(rosterFile)) return null;
    try {
      return JSON.parse(readFileSync(rosterFile, "utf8"));
    } catch {
      fail("名册文件读不出或不是 JSON");
    }
  };
  if (sub === "show") {
    const doc = readRoster() ?? fail("缺少 --roster");
    const keys = new Map(Object.entries(JSON.parse(readFileSync(need("keys"), "utf8"))));
    const v = oa.verifyOpsRoster(doc, keys);
    if (!v.ok) fail(`名册核验不通过：${v.reason}`, 1);
    console.log(
      JSON.stringify(
        {
          ok: true,
          version: v.body.version,
          issued_at: v.body.issued_at,
          digest: v.digest,
          operators: v.body.operators.map((op) => ({ id: op.id, status: op.status, perms: op.perms, second_factor: op.second_factor, keys: op.keys.map((k) => ({ kid: k.kid, fingerprint: oa.opsKeyFingerprint(k.public_key_pem), added_at: k.added_at })) })),
        },
        null,
        2,
      ),
    );
  } else if (["add", "add-key", "perms", "revoke"].includes(sub)) {
    const signPem = readFileSync(need("sign-key"), "utf8");
    const signKid = need("sign-kid");
    const cur = readRoster();
    // 只在真名册上改：现有名册须由同一把名册签名密钥签发
    if (cur) {
      const v = oa.verifyOpsRoster(cur, new Map([[signKid, pubOf(signPem)]]));
      if (!v.ok) fail(`现有名册核验不通过（${v.reason}）：不在来历不明的名册上修改`, 1);
    }
    const now = new Date().toISOString();
    const body = cur ? structuredClone(cur.body) : { format: oa.OPS_ROSTER_FORMAT, version: 0, issued_at: now, operators: [] };
    const id = need("id");
    const op = body.operators.find((x) => x.id === id);
    const perms = () =>
      String(need("perms"))
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    const newKey = () => ({ kid: flag("kid") ?? "k1", public_key_pem: readFileSync(need("pub"), "utf8"), added_at: now });
    if (sub === "add") {
      if (op) fail(`${id} 已在名册里（加密钥用 add-key，改权限用 perms）`);
      body.operators.push({ id, status: "active", perms: perms(), keys: [newKey()], second_factor: "none" });
    } else if (!op) {
      fail(`名册里没有 ${id}`);
    } else if (sub === "add-key") {
      if (op.status !== "active") fail(`${id} 已吊销：须由安全管理员重新登记一个新的运营编号`);
      op.keys.push(newKey());
    } else if (sub === "perms") {
      op.perms = perms();
    } else {
      const kid = flag("kid");
      if (kid) {
        if (!op.keys.some((k) => k.kid === kid)) fail(`${id} 没有密钥 ${kid}`);
        op.keys = op.keys.filter((k) => k.kid !== kid);
      } else {
        op.status = "revoked";
        op.revoked_at = now;
      }
    }
    body.version += 1;
    body.issued_at = now;
    let signed;
    try {
      signed = oa.signOpsRoster(body, { kid: signKid, privateKey: signPem });
    } catch (e) {
      fail(e instanceof Error ? e.message : "名册签发失败");
    }
    const out = need("out");
    writeAtomic(out, `${JSON.stringify(signed, null, 2)}\n`, 0o644);
    console.log(JSON.stringify({ ok: true, version: body.version, out }));
  } else fail("roster 子命令：add / add-key / perms / revoke / show");
} else if (cmd === "call") {
  const url = new URL(need("url"));
  const method = String(flag("method") ?? "GET").toUpperCase();
  const path = need("path");
  if (!path.startsWith("/")) fail("--path 须以 / 开头");
  const body = flag("body") ?? "";
  const headers = oa.signOpsRequest({ audience: need("aud"), method, path, body, operator: need("id"), kid: need("kid"), privateKey: readFileSync(need("key"), "utf8") });
  const ca = flag("ca");
  const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
    { host: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), method, path, headers: { ...headers, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) }, ...(ca ? { ca: readFileSync(ca) } : {}) },
    (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        console.log(JSON.stringify({ status: res.statusCode, body: (() => { const t = Buffer.concat(chunks).toString("utf8"); try { return JSON.parse(t); } catch { return t.slice(0, 2000); } })() }));
        process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
      });
    },
  );
  req.on("error", () => fail("连不上服务", 1));
  if (body) req.write(body);
  req.end();
} else {
  fail("用法：keygen | roster-keygen | roster <add|add-key|perms|revoke|show> | call（见文件头注释）");
}
