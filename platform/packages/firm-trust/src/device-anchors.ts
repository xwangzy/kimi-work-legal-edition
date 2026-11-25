/**
 * 设备证书的两个信任锚（第 66 批，V40，偏离 D-292）：
 * - 律所根（firm_root）：开通时那台电脑本机生成，签发团队成员与律所设备证书——团队共享、成员日志、批准成员、发布策略只认它；
 * - 账号设备签发钥（account_ca）：控制面签名服务里的一把 Ed25519，只给“个人租户”（1 名成员且为管理员）的新电脑签证书，
 *   让同一账号换电脑直接登录，不再要另一台电脑批准。证书写明 issuer = "account_ca"（在签名范围内）。
 *
 * verifyDeviceCertificateAny 按证书写明的签发者选锚：写了 account_ca 只对账号设备签发钥验、没写只对律所根验——
 * 两把钥不能互相冒充；调用方没给 account_ca 锚（团队功能、或这家律所不是个人租户）时 account_ca 证书一律不通过。
 */
import { canonicalJson, verifyDeviceCertificate, type DeviceCertificate, type DeviceCertificateInput } from "@zr-legal/keys";

export type CertIssuer = "firm_root" | "account_ca";

export function certIssuerOf(cert: Pick<DeviceCertificateInput, "issuer"> | null | undefined): CertIssuer {
  return cert?.issuer === "account_ca" ? "account_ca" : "firm_root";
}

export type AnyVerifyResult = { ok: true; issuer: CertIssuer } | { ok: false; reason: string; issuer: CertIssuer };

export function verifyDeviceCertificateAny(
  cert: DeviceCertificate,
  anchors: { root: string | null | undefined; accountCa?: string | null | undefined },
  now: Date = new Date(),
): AnyVerifyResult {
  const issuer = certIssuerOf(cert);
  const pem = issuer === "account_ca" ? anchors.accountCa : anchors.root;
  if (!pem) return { ok: false, reason: issuer === "account_ca" ? "没有账号设备签发钥（不是个人账号，或团队功能只认律所根签发的证书）" : "律所根公钥未登记", issuer };
  const v = verifyDeviceCertificate(cert, pem, now);
  return v.ok ? { ok: true, issuer } : { ok: false, reason: v.reason, issuer };
}

/**
 * 新电脑自动登记的持有证明（第 66 批）：新设备用自己的签名私钥签这段字节，证明持有私钥。
 * 绑定租户、账号、本次登录会话、设备编号与两把公钥：会话或编号换了，证明就不成立。
 */
export function deviceEnrollProofBytes(o: { tid: string; aid: string; sid: string; deviceId: string; signPublicKeyPem: string; encPublicKeyPem: string }): Buffer {
  return Buffer.from(`kwl-device-enroll/1\n${canonicalJson({ tid: o.tid, aid: o.aid, sid: o.sid, device_id: o.deviceId, sign_pub: o.signPublicKeyPem, enc_pub: o.encPublicKeyPem })}`, "utf8");
}
