/**
 * OCR 模型路径与就绪判定（无原生依赖：内核经 `@zr-legal/parse-ocr/client` 引用，安装包里内核不装载 OCR 原生模块，W6）。
 */
import { readFileSync } from "node:fs";

export interface OcrModelPaths {
  det: string;
  rec: string;
  dict: string;
}

export function ocrModelsAvailable(paths: OcrModelPaths): boolean {
  try {
    readFileSync(paths.det);
    readFileSync(paths.rec);
    readFileSync(paths.dict);
    return true;
  } catch {
    return false;
  }
}
