/**
 * 律师层的兜底错误文案（Z3 评审 3.5、#13）：只说一句话加“怎么办”，不出现内核、开发桥、端口等研发用语。纯函数。
 */

/** 首页连不上后台：律师层一句话；开发环境另附开发桥地址，方便研发排查。 */
export function backendDownText(dev: boolean): string {
  const base = "Kimi Work 的后台服务没有响应。请关闭后重新打开；仍不行，请在 设置 → 本机与安全 导出诊断信息交给 IT。";
  return dev ? `${base}（开发：确认开发桥已启动）` : base;
}

/** 调用失败但没有具体说明时的通用兜底。 */
export const GENERIC_FAILURE = "操作没有完成，请重试。";
