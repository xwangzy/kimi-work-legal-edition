/**
 * 本机解析与 OCR（方案 v5.0 第 4 篇 §8.1）：PDF 文本层抽取（pdfjs-dist legacy）、
 * 扫描页 PDFium 渲染、@napi-rs/canvas 图片解码、PaddleOCR ONNX（ppu-paddle-ocr 薄封装，
 * 显式本地模型路径、离线不联网）、页质量判定、隔离解析进程（串行、页级流水）。
 */
export * from "./pdf-text.ts";
export * from "./pdf-render.ts";
export * from "./image-decode.ts";
export * from "./ocr-engine.ts";
export * from "./quality.ts";
export * from "./worker-client.ts";
export * as testingPdf from "./testing-pdf.ts";
