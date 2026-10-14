/**
 * 同一组 S3 提交与上限回归在加密挂载（KWE1 工作区与材料快照）下再跑一遍（复核 S3B-A01 / B-07）。
 */
process.env.KWL_W_SEALED = "1";
await import("./w-s3-regressions.test.ts");
