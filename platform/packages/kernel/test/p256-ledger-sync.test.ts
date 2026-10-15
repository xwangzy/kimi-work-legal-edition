/**
 * ECDSA P-256 设备在账本见证与同步段上的端到端（复核 S7A-11；TPM 设计 v1 §4.2）：
 * 见证与检查点由 P-256 签名者签、按设备公钥核验通过；证书链核验与 verifyDeviceCertificate 同一 signAlg 口径（S7A-05）；
 * 同步段由 P-256 签名者封口、接收端核验通过，签名被换成高 S 等价形态即拒。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { b64urlDecode, b64urlEncode, generateDeviceKeys, generateFirmRoot, generateP256SigningKeyPair, issueDeviceCertificate, SoftwareSigner, verifyBytes } from "@zr-legal/keys";
import { checkSealed, parseSegment, sealSegment } from "@zr-legal/sync";
import { createLedgerSigner, verifyCertSignature } from "../src/ledger-signer.ts";
import { makeKernel, type TestKernel } from "./helpers.ts";

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
const cert = issueDeviceCertificate(root.privateKeyPem, {
  certId: "cert_p256_ledger",
  memberId: "usr_p256",
  deviceId: "dev_p256",
  role: "lawyer",
  signPublicKeyPem: ec.publicKeyPem,
  encPublicKeyPem: generateDeviceKeys().encPublicKeyPem,
  issuedAt: "2026-10-01T00:00:00Z",
  expiresAt: "2028-10-01T00:00:00Z",
});
let tk: TestKernel | null = null;

after(async () => {
  await tk?.kernel.close();
});

test("账本：P-256 签名者写见证与检查点，按设备公钥核验通过；证书链核验认 signAlg，写错算法的证书不认", async () => {
  tk = await makeKernel({}, "p256-ledger-firm");
  const ledger = createLedgerSigner({ db: tk.kernel.db, deviceId: "dev_p256", signer, tenantId: tk.kernel.identity.tenantId });
  ledger.append({ kind: "audit_event", refId: "r1", matterId: null, type: "test.p256", payloadHash: "h1" });
  const row = tk.kernel.db.get<{ event_hash: string; signature: string }>(`SELECT event_hash, signature FROM signed_events WHERE signer_device_id = 'dev_p256' ORDER BY seq DESC LIMIT 1`, [])!;
  assert.equal(verifyBytes(ec.publicKeyPem, new TextEncoder().encode(row.event_hash), row.signature), true);
  assert.equal(verifyBytes(ec.publicKeyPem, new TextEncoder().encode(row.event_hash), malleate(row.signature)), false);
  const ck = ledger.checkpoint("manual");
  assert.ok(ck);
  const ckRow = tk.kernel.db.get<{ signature: string; head_hash: string }>(`SELECT signature, head_hash FROM chain_checkpoints WHERE checkpoint_id = ?`, [ck!.checkpointId])!;
  assert.equal(verifyBytes(ec.publicKeyPem, new TextEncoder().encode(ckRow.head_hash), ckRow.signature), true);
  assert.equal(verifyCertSignature(cert, root.publicKeyPem), true);
  const { signAlg: _a, ...noAlg } = cert;
  assert.equal(verifyCertSignature(noAlg as typeof cert, root.publicKeyPem), false, "去掉 signAlg 的 P-256 证书不认（与 verifyDeviceCertificate 同一口径）");
});

test("同步段：P-256 签名者封口，接收端核验通过；高 S 等价签名被拒", () => {
  const raw = sealSegment({
    header: { segment_id: "seg_p256", device_id: "dev_p256", matter_id: "mat_x", from_lamport: 1, to_lamport: 1, key_epoch: 1, event_count: 0, created_at: "2026-10-15T00:00:00Z", device_cert_json: JSON.stringify(cert) },
    keyRows: [],
    rows: [],
    matterKey: new Uint8Array(randomBytes(32)),
    signer,
  });
  const seg = parseSegment(raw)!;
  assert.equal(checkSealed(seg, ec.publicKeyPem).ok, true);
  const tampered = { ...seg, footer: { ...seg.footer, signature: malleate(seg.footer.signature) } };
  assert.equal(checkSealed(tampered, ec.publicKeyPem).ok, false);
});
