/**
 * 算法敏捷与签名者（TPM 与根私钥离线分持设计 v1 §4.2；C6 §7.4 第 1、2 项；验收 KP-01 矩阵、KP-03）：
 * Ed25519 与 ECDSA P-256 按公钥类型分派；P-256 签名为 P1363（64 字节）且低 S，核验拒绝高 S 与 DER；
 * 跨算法、不支持的密钥类型一律不通过；证书 signAlg 缺省 ed25519（存量签名字节不变），写明的须与公钥一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import {
  b64urlDecode,
  b64urlEncode,
  canonicalJson,
  generateDeviceKeys,
  generateFirmRoot,
  generateP256SigningKeyPair,
  issueDeviceCertificate,
  signAlgOfPublicKey,
  signBytes,
  SoftwareSigner,
  verifyBytes,
  verifyDeviceCertificate,
} from "../src/index.ts";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const big = (b: Uint8Array) => BigInt(`0x${Buffer.from(b).toString("hex")}`);
const data = new TextEncoder().encode("kwl 签名对象");

test("KP-01 矩阵：Ed25519 与 P-256 各自往返；跨算法、换钥、篡改都不通过；不支持的密钥类型签名抛错、核验为 false", () => {
  const ed = generateDeviceKeys();
  const ec = generateP256SigningKeyPair();
  const sEd = signBytes(ed.signPrivateKeyPem, data);
  const sEc = signBytes(ec.privateKeyPem, data);
  assert.equal(verifyBytes(ed.signPublicKeyPem, data, sEd), true);
  assert.equal(verifyBytes(ec.publicKeyPem, data, sEc), true);
  assert.equal(verifyBytes(ec.publicKeyPem, data, sEd), false, "Ed25519 签名不能当 P-256 签名");
  assert.equal(verifyBytes(ed.signPublicKeyPem, data, sEc), false);
  assert.equal(verifyBytes(generateP256SigningKeyPair().publicKeyPem, data, sEc), false);
  assert.equal(verifyBytes(ec.publicKeyPem, new TextEncoder().encode("别的对象"), sEc), false);
  assert.equal(b64urlDecode(sEc).length, 64, "P1363：r‖s 共 64 字节");
  assert.equal(signAlgOfPublicKey(ed.signPublicKeyPem), "ed25519");
  assert.equal(signAlgOfPublicKey(ec.publicKeyPem), "ecdsa-p256-sha256");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPriv = rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const rsaPub = rsa.publicKey.export({ format: "pem", type: "spki" }).toString();
  assert.throws(() => signBytes(rsaPriv, data), /不支持的签名密钥类型/);
  assert.equal(verifyBytes(rsaPub, data, b64urlEncode(nodeSign("sha256", Buffer.from(data), rsaPriv))), false, "RSA 一律不认");
  assert.equal(signAlgOfPublicKey(rsaPub), null);
  const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
  assert.equal(signAlgOfPublicKey(p384.publicKey.export({ format: "pem", type: "spki" }).toString()), null, "只认 P-256 曲线");
  assert.equal(verifyBytes("不是公钥", data, sEc), false, "格式异常不抛");
});

test("KP-03 P-256 签名不可塑：签名恒为低 S；高 S 的等价签名 (r, n−s) 与 DER 编码都被拒", () => {
  const ec = generateP256SigningKeyPair();
  for (let i = 0; i < 40; i++) {
    const msg = new TextEncoder().encode(`对象 ${i}`);
    const sig = b64urlDecode(signBytes(ec.privateKeyPem, msg));
    const s = big(sig.subarray(32));
    assert.ok(s <= N >> 1n, "低 S");
    const high = new Uint8Array(sig);
    high.set(Buffer.from((N - s).toString(16).padStart(64, "0"), "hex"), 32);
    assert.equal(verifyBytes(ec.publicKeyPem, msg, b64urlEncode(high)), false, "高 S 等价签名被拒");
  }
  // 签名串也不可塑（复核 S7A-03）：末字符填充位、追加 ==、前后夹杂非法字符都不收（两种算法）
  const ed = generateDeviceKeys();
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (const [priv, pub] of [[ec.privateKeyPem, ec.publicKeyPem], [ed.signPrivateKeyPem, ed.signPublicKeyPem]] as const) {
    const good = signBytes(priv, data);
    assert.equal(verifyBytes(pub, data, good), true);
    const padBit = good.slice(0, -1) + B64[B64.indexOf(good.at(-1)!) ^ 1];
    for (const variant of [padBit, `${good}==`, ` ${good}`, `${good}.`, `*${good}`]) assert.equal(verifyBytes(pub, data, variant), false, variant.slice(-4));
  }
  const der = nodeSign("sha256", Buffer.from(data), createPrivateKey(ec.privateKeyPem));
  assert.equal(verifyBytes(ec.publicKeyPem, data, b64urlEncode(der)), false, "DER 编码不收");
});

test("签名者：SoftwareSigner 按密钥判定算法；同步与异步签名都可核验；公钥由私钥推出", async () => {
  const ed = generateDeviceKeys();
  const ec = generateP256SigningKeyPair();
  const a = new SoftwareSigner(ed.signPrivateKeyPem);
  const b = new SoftwareSigner(ec.privateKeyPem);
  assert.equal(a.alg, "ed25519");
  assert.equal(b.alg, "ecdsa-p256-sha256");
  assert.equal(a.publicKeyPem, ed.signPublicKeyPem);
  assert.equal(b.publicKeyPem, ec.publicKeyPem);
  assert.equal(verifyBytes(a.publicKeyPem, data, a.signSync(data)), true);
  assert.equal(verifyBytes(b.publicKeyPem, data, await b.sign(data)), true);
  assert.equal(a.signSync(data), signBytes(ed.signPrivateKeyPem, data), "Ed25519 确定性：与原有签名逐字节一致（行为不变）");
  assert.throws(() => new SoftwareSigner(generateKeyPairSync("x25519").privateKey), /不支持的签名密钥类型/);
  assert.ok(!JSON.stringify(a).includes("PRIVATE KEY"), "签名者序列化不带私钥");
});

test("证书 signAlg：Ed25519 不写（存量签名字节不变）；P-256 自动写明并可核验；写错或伪称都拒", () => {
  const root = generateFirmRoot();
  const base = { certId: "c1", memberId: "m1", deviceId: "d1", role: "lawyer" as const, issuedAt: "2026-10-01T00:00:00Z", expiresAt: "2028-10-01T00:00:00Z" };
  const ed = generateDeviceKeys();
  const certEd = issueDeviceCertificate(root.privateKeyPem, { ...base, signPublicKeyPem: ed.signPublicKeyPem, encPublicKeyPem: ed.encPublicKeyPem });
  assert.equal("signAlg" in certEd, false);
  assert.deepEqual(verifyDeviceCertificate(certEd, root.publicKeyPem, new Date("2027-01-01")), { ok: true });
  // 存量证书：签名就是对不含 signAlg 的字段签的
  const { signature, ...unsigned } = certEd;
  assert.equal(verifyBytes(root.publicKeyPem, Buffer.from(canonicalJson(unsigned), "utf8"), signature), true);

  const ec = generateP256SigningKeyPair();
  const certEc = issueDeviceCertificate(root.privateKeyPem, { ...base, signPublicKeyPem: ec.publicKeyPem, encPublicKeyPem: ed.encPublicKeyPem });
  assert.equal(certEc.signAlg, "ecdsa-p256-sha256");
  assert.deepEqual(verifyDeviceCertificate(certEc, root.publicKeyPem, new Date("2027-01-01")), { ok: true });
  assert.throws(() => issueDeviceCertificate(root.privateKeyPem, { ...base, signPublicKeyPem: ed.signPublicKeyPem, encPublicKeyPem: ed.encPublicKeyPem, signAlg: "ecdsa-p256-sha256" }), /算法与公钥类型不符/);
  // 去掉 signAlg 的 P-256 证书（即便重新签名）也不通过：未写即视为 ed25519
  const { signAlg: _drop, signature: _s, ...rest } = certEc;
  const forged = { ...rest, signature: signBytes(root.privateKeyPem, Buffer.from(canonicalJson(rest), "utf8")) };
  const r = verifyDeviceCertificate(forged, root.publicKeyPem, new Date("2027-01-01"));
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /算法与公钥类型不符/);
});
