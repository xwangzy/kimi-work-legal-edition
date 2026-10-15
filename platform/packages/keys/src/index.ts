/**
 * @zr-legal/keys —— 密钥体系密码学核心（方案 v5.0 第 4 篇 §5.3）。
 * 纯函数 + Node 内置 crypto，零第三方依赖：
 * 律所根密钥（恢复码派生）→ 成员设备证书（Ed25519 + X25519）→ 事项密钥包裹（ECIES）
 * → 事件体与材料块加密（AES-256-GCM 在内核存储层使用本包产物）；恢复托管私钥 Shamir 分持。
 */
export * from "./errors.ts";
export * from "./encoding.ts";
export * from "./root.ts";
export * from "./device.ts";
export * from "./matter-keys.ts";
export * from "./shamir.ts";
export * from "./recovery.ts";
export * from "./signing.ts";
export * from "./share-codec.ts";
export * from "./signer.ts";
export * from "./device-seal.ts";
