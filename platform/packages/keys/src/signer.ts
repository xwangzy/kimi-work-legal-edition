/**
 * 签名者抽象（TPM 与根私钥离线分持设计 v1 §4.2、§4.3；C6 §7.4 第 1、2 项）。
 *
 * - `DeviceSigner`：对外可验证、低频的签名（控制面请求、管理员签名、删除回执、归档清单、诊断包……）——异步，
 *   将来由主进程经 TPM 直签（`IpcDeviceSigner`）；今天是 `SoftwareSigner`（读 device.json，行为不变）。
 * - `SessionSigner`：本机高频、同步路径（账本见证与检查点、出站批准凭据、同步段）——同步；
 *   将来是每次启动生成、只在内存的会话密钥（由设备密钥签发会话证书，§4.2）；今天同样由设备软件密钥承担。
 * 调用方只拿到签名者，不再拿到私钥 PEM（KP-02 静态扫描：内核里除密钥文件读写与恢复外不出现 signPrivateKeyPem）。
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { KeysError } from "./errors.ts";
import { signWithKey, type SignAlg } from "./signing.ts";

export interface DeviceSigner {
  readonly alg: SignAlg;
  readonly publicKeyPem: string;
  /** 对字节签名，返回 base64url 签名（Ed25519 64 字节；ECDSA P-256 为 P1363 r‖s 且低 S）。 */
  sign(bytes: Uint8Array): Promise<string>;
}

export interface SessionSigner {
  readonly alg: SignAlg;
  readonly publicKeyPem: string;
  signSync(bytes: Uint8Array): string;
}

/** 软件签名者：私钥只在本对象内（KeyObject，不再以 PEM 字符串在调用方之间传递）。 */
export class SoftwareSigner implements DeviceSigner, SessionSigner {
  readonly alg: SignAlg;
  readonly publicKeyPem: string;
  readonly #key: KeyObject;

  constructor(privateKey: string | KeyObject) {
    this.#key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
    this.alg = algOfKey(this.#key);
    this.publicKeyPem = createPublicKey(this.#key.export({ format: "pem", type: "pkcs8" })).export({ format: "pem", type: "spki" }).toString();
  }

  signSync(bytes: Uint8Array): string {
    return signWithKey(this.#key, bytes);
  }

  async sign(bytes: Uint8Array): Promise<string> {
    return signWithKey(this.#key, bytes);
  }
}

/**
 * 设备签名者的同步形态（D-71 过渡期）：对外可验证的签名（删除回执、归档清单、签发审批、控制面请求、管理员签名）必须是**设备**签名者，
 * 不能是将来的会话签名者——两个接口都实现才满足此类型；会话签名者只实现 SessionSigner，传到这些点即编译失败（复核 S7A-06）。
 */
export type DeviceSyncSigner = DeviceSigner & SessionSigner;

/** 签名者或（测试与离线工具用的）私钥 PEM：同步签名。内核生产代码只传签名者（KP-02）。 */
export type SyncSignerLike = SessionSigner | string;

export function signSyncWith(s: SyncSignerLike, bytes: Uint8Array): string {
  return typeof s === "string" ? signWithKey(s, bytes) : s.signSync(bytes);
}

/** 由密钥对象判定签名算法：只认 Ed25519 与 ECDSA P-256，其余一律拒绝。 */
export function algOfKey(key: KeyObject): SignAlg {
  if (key.asymmetricKeyType === "ed25519") return "ed25519";
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return "ecdsa-p256-sha256";
  throw new KeysError("validation", `不支持的签名密钥类型：${key.asymmetricKeyType ?? "未知"}${key.asymmetricKeyDetails?.namedCurve ? `/${key.asymmetricKeyDetails.namedCurve}` : ""}`);
}

/** 生成软件 ECDSA P-256 签名密钥对（无 TPM 的新安装；§4.2）。 */
export function generateP256SigningKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const kp = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKeyPem: kp.publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: kp.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}
