/**
 * 成员设备证书（方案 v5.0 第 4 篇 §5.3）：根密钥签发与验签、篡改识别、有效期。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, verifyDeviceCertificate, type DeviceCertificate } from "../src/index.ts";

function issueFixture() {
  const root = generateFirmRoot();
  const dev = generateDeviceKeys();
  const cert = issueDeviceCertificate(root.privateKeyPem, {
    certId: "cert_test_1",
    memberId: "mem_lawyer_1",
    deviceId: "dev_macbook_1",
    role: "lawyer",
    signPublicKeyPem: dev.signPublicKeyPem,
    encPublicKeyPem: dev.encPublicKeyPem,
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2027-10-01T00:00:00.000Z",
  });
  return { root, dev, cert };
}

test("签发→验签通过", () => {
  const { root, cert } = issueFixture();
  assert.deepEqual(verifyDeviceCertificate(cert, root.publicKeyPem), { ok: true });
});

test("篡改任一字段（role / expiresAt / encPublicKeyPem / memberId）验签失败", () => {
  const { root, dev, cert } = issueFixture();
  const other = generateDeviceKeys();
  const tampered: DeviceCertificate[] = [
    { ...cert, role: "admin" },
    { ...cert, expiresAt: "2028-01-01T00:00:00.000Z" },
    { ...cert, encPublicKeyPem: other.encPublicKeyPem },
    { ...cert, memberId: "mem_someone_else" },
  ];
  //  sanity：encPublicKeyPem 确被替换
  assert.notEqual(other.encPublicKeyPem, dev.encPublicKeyPem);
  for (const t of tampered) {
    const r = verifyDeviceCertificate(t, root.publicKeyPem);
    assert.equal(r.ok, false, JSON.stringify(t));
  }
});

test("过期证书（传入未来 now）验签失败；非本所根公钥验签失败", () => {
  const { root, cert } = issueFixture();
  const future = new Date("2027-10-01T00:00:01.000Z");
  const r = verifyDeviceCertificate(cert, root.publicKeyPem, future);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /有效期/);
  // 到期前一刻仍有效
  assert.deepEqual(verifyDeviceCertificate(cert, root.publicKeyPem, new Date("2027-09-30T23:59:59.000Z")), { ok: true });
  // 另一家律所的根公钥
  assert.equal(verifyDeviceCertificate(cert, generateFirmRoot().publicKeyPem).ok, false);
});

test("字段完整性：非法角色与缺失字段在验签侧如实报告", () => {
  const { root, cert } = issueFixture();
  const badRole = verifyDeviceCertificate({ ...cert, role: "partner" as "lawyer", signature: cert.signature }, root.publicKeyPem);
  assert.equal(badRole.ok, false); // role 被改后签名不符
  const missing = verifyDeviceCertificate({ ...cert, deviceId: "" }, root.publicKeyPem);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /deviceId/);
});
