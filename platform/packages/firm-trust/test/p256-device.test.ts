/**
 * ECDSA P-256 设备（TPM 设计 v1 §4.2：TPM 设备密钥只能是 P-256）在原先写死 Ed25519 的核验点上可用：
 * 管理员签名、设备请求签名、闸门批准凭据。高 S 等价签名在这些点上同样被拒（不可塑，KP-03）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { b64urlDecode, b64urlEncode, generateDeviceKeys, generateFirmRoot, generateP256SigningKeyPair, issueDeviceCertificate, SoftwareSigner } from "@zr-legal/keys";
import { canonicalCredential, verifyApproval, type ApprovalCredential } from "@zr-legal/egress-gate";
import { adminSign, signDeviceRequest, verifyAdminSignatures, verifyDeviceRequest } from "../src/index.ts";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const malleate = (sigB64: string): string => {
  const sig = new Uint8Array(b64urlDecode(sigB64));
  const s = BigInt(`0x${Buffer.from(sig.subarray(32)).toString("hex")}`);
  sig.set(Buffer.from((N - s).toString(16).padStart(64, "0"), "hex"), 32);
  return b64urlEncode(sig);
};

const root = generateFirmRoot();
const ec = generateP256SigningKeyPair();
const signer = new SoftwareSigner(ec.privateKeyPem);
const NOW = Date.parse("2026-10-15T08:00:00Z");
const cert = issueDeviceCertificate(root.privateKeyPem, {
  certId: "cert_p256",
  memberId: "usr_admin",
  deviceId: "dev_p256",
  role: "admin",
  signPublicKeyPem: ec.publicKeyPem,
  encPublicKeyPem: generateDeviceKeys().encPublicKeyPem,
  issuedAt: "2026-10-01T00:00:00Z",
  expiresAt: "2028-10-01T00:00:00Z",
});

test("P-256 管理员签名：经签名者签、按证书公钥核验通过；高 S 等价签名不算", () => {
  const bytes = Buffer.from("kwl 策略待签字节", "utf8");
  const ctx = { rootPublicKeyPem: root.publicKeyPem, threshold: 1, revokedDevices: new Set<string>(), now: new Date(NOW) };
  const good = adminSign(bytes, cert, signer);
  assert.equal(verifyAdminSignatures(bytes, [good], ctx).ok, true);
  assert.equal(verifyAdminSignatures(bytes, [{ ...good, sig: malleate(good.sig) }], ctx).ok, false);
});

test("P-256 设备请求签名：控制面按设备公钥核验通过；高 S 等价签名被拒", () => {
  const req = { method: "POST", path: "/v1/seat-token", body: "{}" };
  const h = signDeviceRequest({ ...req, tid: "ten_x", deviceId: "dev_p256", signer, now: NOW });
  const opts = { now: NOW, publicKeyFor: () => ec.publicKeyPem, seenNonce: () => false };
  assert.equal(verifyDeviceRequest(h, req, opts).ok, true);
  const bad = verifyDeviceRequest({ ...h, "x-kwl-sig": malleate(h["x-kwl-sig"]) }, req, opts);
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.reason, "device_auth_signature_invalid");
});

test("P-256 闸门批准凭据：签名核验通过（走到下一项检查）；高 S 等价签名在签名一步即拒", () => {
  const c = { v: 2, dev: "dev_p256" } as unknown as ApprovalCredential;
  const sig = signer.signSync(Buffer.from(canonicalCredential(c), "utf8"));
  const e = {} as Parameters<typeof verifyApproval>[2];
  const r = verifyApproval({ credential: c, signature: sig }, { dev_p256: ec.publicKeyPem }, e);
  assert.deepEqual(r, { ok: false, reason: "approval_version" }, "签名通过，停在版本检查");
  assert.deepEqual(verifyApproval({ credential: c, signature: malleate(sig) }, { dev_p256: ec.publicKeyPem }, e), { ok: false, reason: "approval_bad_signature" });
});
