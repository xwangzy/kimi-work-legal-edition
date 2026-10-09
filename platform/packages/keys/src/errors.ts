/**
 * 包内错误：DomainError 风格的普通 Error（带机器可判的 code），不依赖 @zr-legal/domain，
 * 保持 keys 包零依赖（方案 v5.0 第 4 篇 §5.3：只用 Node 内置 crypto，不引入额外密码库）。
 */
export class KeysError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "KeysError";
    this.code = code;
  }
}
