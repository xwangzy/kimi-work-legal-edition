/**
 * 拉取本机 OCR 模型（方案 §8.1：RapidOCR 转换的 PaddleOCR ONNX，全链 Apache-2.0；
 * ModelScope 国内 CDN 已验证可达）。逐文件 SHA256 校验（hash 硬编码自 RapidAI 官方清单），
 * 校验失败即删除。产物落 content/ocr-models/（gitignore；随安装包分发，安装包预算 ≤400MB 含模型）。
 * 用法：npm run fetch:ocr-models。
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "content", "ocr-models");

const FILES = [
  {
    name: "ch_PP-OCRv5_det_mobile.onnx",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx",
    sha256: "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae",
    license: "Apache-2.0（RapidAI/PaddleOCR）",
  },
  {
    name: "ch_PP-OCRv5_rec_mobile.onnx",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx",
    sha256: "5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5",
    license: "Apache-2.0（RapidAI/PaddleOCR）",
  },
  {
    name: "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    sha256: "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
    license: "Apache-2.0（RapidAI/PaddleOCR）",
  },
  {
    // PP-OCRv5 rec 模型输出 18385 类，必须配 ppocrv5_dict（18383 字 + blank/space）；
    // ppocr_keys_v1.txt（6623 字）是 v4 及更早字典，与 v5 rec 模型不配（实证：错字典输出乱码）
    name: "ppocrv5_dict.txt",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt",
    sha256: "d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b",
    license: "Apache-2.0（RapidAI/PaddleOCR）",
  },
  {
    name: "ppocr_keys_v1.txt",
    url: "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt",
    sha256: "a1c84d9bdb9ab29043c58896224d32941783eb821629618416dcb08f12886492",
    license: "Apache-2.0（PaddleOCR）",
  },
];

// 字典 hash 若与官方仓当前版本不符，打印实际值供一次性校准（不静默放行：不匹配仍删文件报错）
function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

mkdirSync(outDir, { recursive: true });
let totalBytes = 0;
for (const f of FILES) {
  const dest = join(outDir, f.name);
  if (existsSync(dest) && sha256Of(dest) === f.sha256) {
    console.log(`[fetch:ocr-models] 已存在且校验通过：${f.name}`);
    totalBytes += statSync(dest).size;
    continue;
  }
  console.log(`[fetch:ocr-models] 下载 ${f.name} ← ${f.url}`);
  const res = await fetch(f.url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败 ${f.name}：HTTP ${res.status}`);
  }
  await pipeline(res.body, createWriteStream(dest));
  const actual = sha256Of(dest);
  if (actual !== f.sha256) {
    rmSync(dest, { force: true });
    throw new Error(`SHA256 校验失败 ${f.name}：期望 ${f.sha256}，实际 ${actual}（文件已删除；若为官方更新，请核对后更新脚本内硬编码 hash）`);
  }
  totalBytes += statSync(dest).size;
  console.log(`[fetch:ocr-models] 校验通过 ${f.name}（${(statSync(dest).size / 1048576).toFixed(2)} MB，${f.license}）`);
}
console.log(`[fetch:ocr-models] 完成，共 ${(totalBytes / 1048576).toFixed(2)} MB → ${outDir}`);
