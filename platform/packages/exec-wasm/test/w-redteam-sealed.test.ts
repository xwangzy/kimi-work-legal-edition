/**
 * 同一组 W 红队（逃逸、链接投毒、桥接滥用、资源耗尽、信息泄露）在加密挂载（KWE1 工作区与材料快照）下再跑一遍（复核 S3B-A01 / B-07）。
 */
process.env.KWL_W_SEALED = "1";
await import("./w-redteam.test.ts");
