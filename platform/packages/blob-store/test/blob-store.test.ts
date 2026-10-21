/**
 * 云端对象存储接口（v9.3 A-11）：
 * - 签名第 4 版与 AWS 文档的公开示例逐字一致（S3“单块传输”GET Object 示例）；
 * - S3 兼容实现对着一个会核签名、要求加密头的本地假服务跑通写、读、列（分页）、删；服务端没有加密即删掉并报错；
 * - 本地目录实现：原子写、列举不含半成品；键名不能跳出前缀。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkKey, fsBlobStore, s3BlobStore, signV4, type BlobStore } from "../src/index.ts";

const CREDS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("签名第 4 版：与 AWS 文档 GET Object 示例的签名逐字一致", () => {
  const h = signV4({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", query: {}, headers: { range: "bytes=0-9" }, payloadHash: EMPTY, region: "us-east-1", credentials: CREDS, amzDate: "20130524T000000Z" });
  assert.equal(
    h.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

/** 本地假 S3：重算签名核对（密钥不同即 403）、写入须带 SSE-KMS 头、列举按前缀分页。dropSse：模拟不做加密的实现。 */
function fakeS3(o: { dropSse?: boolean } = {}) {
  const objects = new Map<string, { body: Buffer; at: number; sse: string | undefined }>();
  const seen: { method: string; sse: string | undefined; kms: string | undefined }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://x");
      const auth = String(req.headers.authorization ?? "");
      const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(";") ?? [];
      const hdrs: Record<string, string> = {};
      for (const n of signed) if (!["host", "x-amz-date", "x-amz-content-sha256"].includes(n)) hdrs[n] = String(req.headers[n]);
      const query = Object.fromEntries(url.searchParams);
      const path = decodeURIComponent(url.pathname);
      const want = signV4({ method: req.method!, host: String(req.headers.host), path, query, headers: hdrs, payloadHash: createHash("sha256").update(body).digest("hex"), region: "cn-north-4", credentials: CREDS, amzDate: String(req.headers["x-amz-date"]) }).authorization;
      if (want !== auth || req.headers["x-amz-content-sha256"] !== createHash("sha256").update(body).digest("hex")) {
        res.writeHead(403).end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
        return;
      }
      seen.push({ method: req.method!, sse: req.headers["x-amz-server-side-encryption"] as string | undefined, kms: req.headers["x-amz-server-side-encryption-aws-kms-key-id"] as string | undefined });
      const [, bucket, ...rest] = path.split("/");
      if (bucket !== "kwl-test") return void res.writeHead(404).end("<Error><Code>NoSuchBucket</Code></Error>");
      const key = rest.join("/");
      if (req.method === "PUT" && req.headers["if-none-match"] === "*" && objects.has(key)) {
        res.writeHead(412).end("<Error><Code>PreconditionFailed</Code></Error>");
      } else if (req.method === "PUT") {
        const sse = req.headers["x-amz-server-side-encryption"] as string | undefined;
        objects.set(key, { body, at: Date.now(), sse });
        res.writeHead(200, o.dropSse || !sse ? {} : { "x-amz-server-side-encryption": sse }).end();
      } else if (req.method === "GET" && !key && "versioning" in query) {
        res.writeHead(200).end("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>");
      } else if (req.method === "GET" && !key && "object-lock" in query) {
        res.writeHead(404).end("<Error><Code>ObjectLockConfigurationNotFoundError</Code></Error>");
      } else if (req.method === "GET" && !key && "versions" in query) {
        const prefix = query.prefix ?? "";
        res.writeHead(200).end(`<ListVersionsResult><IsTruncated>false</IsTruncated>${[...objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => `<Version><Key>${k}</Key><VersionId>v1</VersionId><IsLatest>true</IsLatest></Version>`).join("")}<DeleteMarker><Key>${prefix}gone.bin</Key><VersionId>v2</VersionId><IsLatest>true</IsLatest></DeleteMarker></ListVersionsResult>`);
      } else if (req.method === "GET" && !key && "lifecycle" in query) {
        res.writeHead(200).end("<LifecycleConfiguration><Rule><ID>support-8d</ID><Status>Enabled</Status><Expiration><Days>8</Days></Expiration></Rule><Rule><Status>Disabled</Status></Rule></LifecycleConfiguration>");
      } else if (req.method === "GET" && key) {
        const ob = objects.get(key);
        if (!ob) return void res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
        res.writeHead(200).end(ob.body);
      } else if (req.method === "GET") {
        const prefix = query.prefix ?? "";
        const max = Number(query["max-keys"] ?? 1000);
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const startAfter = query["continuation-token"] ?? "";
        const page = keys.filter((k) => k > startAfter).slice(0, Math.min(max, 2));
        const truncated = keys.filter((k) => k > startAfter).length > page.length;
        res.writeHead(200).end(
          `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><Size>${objects.get(k)!.body.length}</Size><LastModified>${new Date(objects.get(k)!.at).toISOString()}</LastModified></Contents>`).join("")}${truncated ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : ""}</ListBucketResult>`,
        );
      } else if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
  return { server, objects, seen };
}

async function exercise(store: BlobStore) {
  await store.put("support/SUP-AAAA-0001.bin", Buffer.from("诊断包一"));
  await store.put("support/SUP-AAAA-0002.bin", Buffer.from("诊断包二"));
  await store.put("support/SUP-AAAA-0003.bin", Buffer.from("诊断包三"));
  await store.put("other/x.bin", Buffer.from("别的前缀"));
  assert.equal((await store.get("support/SUP-AAAA-0002.bin"))!.toString(), "诊断包二");
  assert.equal(await store.get("support/none.bin"), null);
  const listed = await store.list("support/");
  assert.deepEqual(listed.map((x) => x.key), ["support/SUP-AAAA-0001.bin", "support/SUP-AAAA-0002.bin", "support/SUP-AAAA-0003.bin"], "按前缀列举（跨页）");
  assert.equal(listed[0]!.size, Buffer.byteLength("诊断包一"));
  assert.ok(listed[0]!.mtime > 0);
  await store.delete("support/SUP-AAAA-0002.bin");
  await store.delete("support/SUP-AAAA-0002.bin"); // 不存在也算成功
  assert.equal(await store.get("support/SUP-AAAA-0002.bin"), null);
  await assert.rejects(store.put("../etc/passwd", Buffer.from("x")), /键名不合规/);
}

test("S3 兼容：写、读、列（分页）、删对着核签名的假服务跑通；每次写都带 SSE-KMS 与密钥编号；键名带前缀", async () => {
  const s3 = fakeS3();
  await new Promise<void>((r) => s3.server.listen(0, "127.0.0.1", () => r()));
  try {
    const store = s3BlobStore({ endpoint: `http://127.0.0.1:${(s3.server.address() as AddressInfo).port}`, bucket: "kwl-test", region: "cn-north-4", credentials: CREDS, sse: { kmsKeyId: "kms-key-support" }, prefix: "prod", allowInsecureForTest: true });
    await exercise(store);
    assert.ok([...s3.objects.keys()].every((k) => k.startsWith("prod/")), "键名都在前缀下");
    assert.deepEqual(await store.lifecycle!(), { rules: 1, expirationDays: [8] }, "只数启用的规则（复核 RB16A-12）");
    // 条件写、版本列举、桶防护（余项续复核 RC-A-01/04）
    assert.equal(await store.putIfAbsent!("ledger/a.jsonl", Buffer.from("一")), "created");
    assert.equal(await store.putIfAbsent!("ledger/a.jsonl", Buffer.from("二")), "exists");
    assert.equal((await store.get("ledger/a.jsonl"))!.toString(), "一", "已存在不覆盖");
    const vers = await store.listVersions!("ledger/");
    assert.deepEqual(vers.map((x) => [x.key, x.deleteMarker]), [["ledger/a.jsonl", false], ["ledger/gone.bin", true]]);
    const g = await store.guards!();
    assert.equal(g.versioning, "Enabled");
    assert.equal(g.objectLock, false);
    assert.equal(g.rules.length, 1);
    assert.equal(store.keyPrefix, "prod/");
    const puts = s3.seen.filter((x) => x.method === "PUT");
    assert.ok(puts.length >= 4 && puts.every((x) => x.sse === "aws:kms" && x.kms === "kms-key-support"));
    // 密钥不对：假服务回 403，写入失败
    const bad = s3BlobStore({ endpoint: `http://127.0.0.1:${(s3.server.address() as AddressInfo).port}`, bucket: "kwl-test", region: "cn-north-4", credentials: { ...CREDS, secretAccessKey: "wrong" }, sse: "AES256", allowInsecureForTest: true });
    await assert.rejects(bad.put("a.bin", Buffer.from("x")), (e: any) => e.code === "s3_SignatureDoesNotMatch");
  } finally {
    s3.server.close();
  }
  assert.throws(() => s3BlobStore({ endpoint: "http://obs.example.com", bucket: "kwl-test", region: "r", credentials: CREDS, sse: "AES256" }), /只能经 HTTPS/);
});

test("S3 兼容：服务端没有加密（回复里没有加密头）→ 删掉刚写的对象并报错，不留未加密的对象", async () => {
  const s3 = fakeS3({ dropSse: true });
  await new Promise<void>((r) => s3.server.listen(0, "127.0.0.1", () => r()));
  try {
    const store = s3BlobStore({ endpoint: `http://127.0.0.1:${(s3.server.address() as AddressInfo).port}`, bucket: "kwl-test", region: "cn-north-4", credentials: CREDS, sse: { kmsKeyId: "k" }, allowInsecureForTest: true });
    await assert.rejects(store.put("a.bin", Buffer.from("x")), (e: any) => e.code === "sse_missing");
    assert.equal(s3.objects.size, 0);
  } finally {
    s3.server.close();
  }
});

test("本地目录：同一套行为；列举不含写到一半的临时文件；键名不能跳出目录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-blob-"));
  const store = fsBlobStore(dir);
  await exercise(store);
  writeFileSync(join(dir, "support", "SUP-AAAA-0009.bin.tmp-0a1b2c3d"), "半成品");
  assert.ok(!(await store.list("support/")).some((x) => x.key.includes(".tmp-")));
  assert.ok(existsSync(join(dir, "support", "SUP-AAAA-0001.bin")));
  assert.ok(!readdirSync(join(dir, "support")).some((n) => /\.tmp-/.test(n) && !n.endsWith("0a1b2c3d")), "正常写入不留临时文件");
  for (const k of ["/abs", "a/../b", "a b", ""]) assert.throws(() => checkKey(k), /键名不合规/);
});

test("门禁：律师电脑上的代码（内核、闸门、客户端等）不引用本包——驻留面与出网面清单把本包列为云端的前提", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const hits: string[] = [];
  const walk = (d: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "vendor" || e.name === "dist" || e.name === "test") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name) && /blob-store/.test(readFileSync(p, "utf8"))) hits.push(p.slice(root.length));
    }
  };
  for (const pkg of readdirSync(join(root, "packages"))) if (pkg !== "blob-store") walk(join(root, "packages", pkg, "src"));
  for (const app of readdirSync(join(root, "apps"))) for (const sub of ["src", "electron"]) walk(join(root, "apps", app, sub));
  assert.deepEqual(hits, []);
});

test("生命周期与外送桶防护的判定（余项续复核 RC-A-01、RC-A-04）", async () => {
  const { parseLifecycle, supportLifecycleOk, archiveGuardProblems } = await import("../src/index.ts");
  const rules = parseLifecycle(
    "<LifecycleConfiguration>" +
      "<Rule><ID>to-ia</ID><Status>Enabled</Status><Filter><Prefix>prod/support/</Prefix></Filter><Transition><Days>30</Days></Transition></Rule>" +
      "<Rule><ID>sup-8</ID><Status>Enabled</Status><Filter><Prefix>prod/support/</Prefix></Filter><Expiration><Days>8</Days></Expiration><NoncurrentVersionExpiration><NoncurrentDays>1</NoncurrentDays></NoncurrentVersionExpiration></Rule>" +
      "<Rule><ID>off</ID><Status>Disabled</Status><Expiration><Days>1</Days></Expiration></Rule>" +
    "</LifecycleConfiguration>",
  );
  assert.deepEqual(rules.map((r) => [r.id, r.prefix, r.expirationDays, r.noncurrentDays]), [["to-ia", "prod/support/", null, null], ["sup-8", "prod/support/", 8, 1]]);
  const g = (over: object = {}) => ({ versioning: "Enabled" as const, objectLock: true, rules, ...over });
  assert.equal(supportLifecycleOk(g(), "prod/support/"), true);
  assert.equal(supportLifecycleOk(g({ rules: [rules[0]!] }), "prod/support/"), false, "只有转低频存储的规则不算兜底删除");
  assert.equal(supportLifecycleOk(g({ rules: [{ ...rules[1]!, prefix: "prod/other/" }] }), "prod/support/"), false, "前缀不覆盖诊断包");
  assert.equal(supportLifecycleOk(g({ rules: [{ ...rules[1]!, expirationDays: 30 }] }), "prod/support/"), false, "天数超过 8 天");
  assert.equal(supportLifecycleOk(g({ rules: [{ ...rules[1]!, noncurrentDays: null }] }), "prod/support/"), false, "版本化桶要删非当前版本");
  assert.equal(supportLifecycleOk(g({ versioning: null, rules: [{ ...rules[1]!, noncurrentDays: null }] }), "prod/support/"), true);
  assert.deepEqual(archiveGuardProblems(g({ rules: [] }), "prod/signer-ledger/"), []);
  assert.deepEqual(archiveGuardProblems(g({ versioning: "Suspended", objectLock: false, rules: [] }), "prod/signer-ledger/"), ["桶没有开版本控制", "桶没有开对象锁"]);
  assert.equal(archiveGuardProblems(g(), "prod/signer-ledger/").length, 0, "只作用于诊断包前缀的规则不影响外送");
  assert.equal(archiveGuardProblems(g({ rules: [{ ...rules[1]!, prefix: "" }] }), "prod/signer-ledger/").length, 1, "整桶到期规则会让外送对象到期");
});

test("本地目录：条件写已存在即 exists，不覆盖", async () => {
  const store = fsBlobStore(mkdtempSync(join(tmpdir(), "kwl-blob-ine-")));
  assert.equal(await store.putIfAbsent!("a/b.jsonl", Buffer.from("一")), "created");
  assert.equal(await store.putIfAbsent!("a/b.jsonl", Buffer.from("二")), "exists");
  assert.equal((await store.get("a/b.jsonl"))!.toString(), "一");
  assert.deepEqual((await store.list("a/")).map((x) => x.key), ["a/b.jsonl"], "不留临时文件");
});
