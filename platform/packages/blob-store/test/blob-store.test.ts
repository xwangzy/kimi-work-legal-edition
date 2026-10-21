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
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const seen: { method: string; sse?: string; kms?: string }[] = [];
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
      if (req.method === "PUT") {
        const sse = req.headers["x-amz-server-side-encryption"] as string | undefined;
        objects.set(key, { body, at: Date.now(), sse });
        res.writeHead(200, o.dropSse || !sse ? {} : { "x-amz-server-side-encryption": sse }).end();
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
